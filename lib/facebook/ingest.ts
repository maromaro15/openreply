/**
 * What the Page webhook does with a verified delivery: keep it for 30 days,
 * note that the Page is receiving events, and queue the work. Nothing here
 * calls Meta, so the route can answer within Meta's deadline.
 */
import type { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { parsePageWebhook, type PageEchoEvent, type PageMessageEvent } from "./webhook";
import {
  commentJobId,
  FB_COMMENT_JOB,
  FB_MESSAGE_JOB,
  getFacebookQueue,
  messageJobId,
  type FacebookMessageJob,
} from "./queue";

export interface IngestResult {
  pages: number;
  comments: number;
  messages: number;
  echoes: number;
}

type RawEntry = { id?: unknown };

const NOTHING: IngestResult = { pages: 0, comments: 0, messages: 0, echoes: 0 };

function messageJob(
  page: { id: string; pageId: string },
  event: PageMessageEvent | PageEchoEvent,
  kind: FacebookMessageJob["kind"]
): FacebookMessageJob {
  return {
    facebookPageId: page.id,
    pageId: page.pageId,
    kind,
    psid: event.psid,
    mid: event.mid,
    ...(event.text ? { text: event.text } : {}),
    attachments: event.attachments,
    ...("isSticker" in event && event.isSticker ? { isSticker: true } : {}),
    ...("replyToMid" in event && event.replyToMid ? { replyToMid: event.replyToMid } : {}),
    ...("appId" in event && event.appId ? { appId: event.appId } : {}),
    ...("metadata" in event && event.metadata !== undefined ? { metadata: event.metadata } : {}),
    sentAt: event.sentAt.toISOString(),
  };
}

export async function ingestPageWebhook(payload: unknown): Promise<IngestResult> {
  const parsed = parsePageWebhook(payload);
  if (parsed.pageIds.length === 0) return NOTHING;

  // Only connected Pages: nothing is stored for a Page nobody connected.
  const pages = await prisma.facebookPage.findMany({
    where: { pageId: { in: parsed.pageIds }, status: { not: "DISCONNECTED" } },
    select: { id: true, pageId: true, workspaceId: true, status: true },
  });
  if (pages.length === 0) return NOTHING;
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
  let messages = 0;
  let echoes = 0;
  try {
    const queue = getFacebookQueue();
    // Messages and echoes are kept for any connected Page, so the inbox
    // shows them even while its token waits to be renewed.
    for (const message of parsed.messages) {
      const page = byPageId.get(message.pageId);
      if (!page) continue;
      await queue.add(FB_MESSAGE_JOB, messageJob(page, message, "message"), {
        jobId: messageJobId(page.pageId, message.mid, "message"),
      });
      messages += 1;
    }
    for (const echo of parsed.echoes) {
      const page = byPageId.get(echo.pageId);
      if (!page) continue;
      await queue.add(FB_MESSAGE_JOB, messageJob(page, echo, "echo"), {
        jobId: messageJobId(page.pageId, echo.mid, "echo"),
      });
      echoes += 1;
    }
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
  return { pages: pages.length, comments: queued, messages, echoes };
}
