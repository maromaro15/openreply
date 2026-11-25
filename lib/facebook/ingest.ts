/**
 * What the Page webhook does with a verified delivery: keep it for 30 days,
 * note that the Page is receiving events, and queue the work. Nothing here
 * calls Meta, so the route can answer within Meta's deadline.
 */
import type { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { parsePageWebhook } from "./webhook";
import { commentJobId, FB_COMMENT_JOB, getFacebookQueue } from "./queue";

export interface IngestResult {
  pages: number;
  comments: number;
}

type RawEntry = { id?: unknown };

export async function ingestPageWebhook(payload: unknown): Promise<IngestResult> {
  const parsed = parsePageWebhook(payload);
  if (parsed.pageIds.length === 0) return { pages: 0, comments: 0 };

  // Only connected Pages: nothing is stored for a Page nobody connected.
  const pages = await prisma.facebookPage.findMany({
    where: { pageId: { in: parsed.pageIds }, status: { not: "DISCONNECTED" } },
    select: { id: true, pageId: true, workspaceId: true, status: true },
  });
  if (pages.length === 0) return { pages: 0, comments: 0 };
  const byPageId = new Map(pages.map((page) => [page.pageId, page]));

  const now = new Date();
  await prisma.facebookPage.updateMany({
    where: { id: { in: pages.map((page) => page.id) } },
    data: { lastWebhookAt: now },
  });

  // One stored event per Page, holding only that Page's entries.
  const entries = (payload as { entry?: RawEntry[] }).entry ?? [];
  const events = new Map<string, string>();
  for (const page of pages) {
    const own = entries.filter((entry) => String(entry?.id) === page.pageId);
    const event = await prisma.facebookWebhookEvent.create({
      data: {
        workspaceId: page.workspaceId,
        pageId: page.pageId,
        payload: { object: "page", entry: own } as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    events.set(page.pageId, event.id);
  }

  let queued = 0;
  try {
    const queue = getFacebookQueue();
    for (const comment of parsed.comments) {
      const page = byPageId.get(comment.pageId);
      // A Page whose token died cannot answer; its status says so in the UI.
      if (!page || page.status !== "ACTIVE") continue;
      await queue.add(
        FB_COMMENT_JOB,
        {
          facebookPageId: page.id,
          pageId: page.pageId,
          commentId: comment.commentId,
          postId: comment.postId,
          ...(comment.parentId ? { parentId: comment.parentId } : {}),
          ...(comment.commenterId ? { commenterId: comment.commenterId } : {}),
          ...(comment.commenterName ? { commenterName: comment.commenterName } : {}),
          text: comment.text,
          createdAt: comment.createdAt.toISOString(),
        },
        { jobId: commentJobId(page.pageId, comment.commentId) }
      );
      queued += 1;
    }
  } catch (error) {
    await prisma.facebookWebhookEvent.updateMany({
      where: { id: { in: [...events.values()] } },
      data: {
        status: "FAILED",
        errorMessage: error instanceof Error ? error.message : "Queueing failed",
        processedAt: new Date(),
      },
    });
    throw error;
  }

  await prisma.facebookWebhookEvent.updateMany({
    where: { id: { in: [...events.values()] } },
    data: { status: "PROCESSED", processedAt: new Date() },
  });
  return { pages: pages.length, comments: queued };
}
