/**
 * What the two source routes (posts, conversations) have in common: start a
 * run for a Page, or read the state of its last one. Not a route file.
 *
 * One fixed job ID per kind and Page, so a click while a run is active joins
 * it, and a click after it finished replaces the finished job with a new run.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import type { Job } from "bullmq";
import { jsonError, requireWorkspace } from "@/lib/agency/http";
import { prisma } from "@/lib/db/client";
import {
  KB_CONVERSATIONS_JOB,
  KB_POSTS_JOB,
  getFacebookQueue,
  knowledgeSourceJobId,
  type FacebookJob,
  type KnowledgeConversationsJob,
  type KnowledgePostsJob,
} from "@/lib/facebook/queue";
import { DEFAULT_THREAD_LIMIT, MAX_THREAD_LIMIT } from "@/lib/knowledge/conversations";
import { isSourceMessage, type PostsSummary } from "@/lib/knowledge/jobs/posts";
import type { ConversationsSummary } from "@/lib/knowledge/jobs/conversations";
import { DEFAULT_POSTS_LIMIT, MAX_POSTS_LIMIT } from "@/lib/knowledge/posts";

export type SourceKind = "posts" | "conversations";
export type SourceRunState = "idle" | "running" | "done" | "failed";

export interface SourceRun {
  kind: SourceKind;
  facebookPageId: string;
  state: SourceRunState;
  /** ISO times; null until they happen. */
  requestedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  summary: PostsSummary | ConversationsSummary | null;
  /** A failed run's reason: one of our own messages, or a generic one. */
  error: string | null;
  /** True when a click joined a run that was already active. */
  joined?: boolean;
}

/** Stored for a week, so "last run" is still there after a quiet few days. */
const KEEP_FINISHED_SECONDS = 7 * 24 * 60 * 60;

const CONFIG = {
  posts: { jobName: KB_POSTS_JOB, defaultLimit: DEFAULT_POSTS_LIMIT, maxLimit: MAX_POSTS_LIMIT },
  conversations: { jobName: KB_CONVERSATIONS_JOB, defaultLimit: DEFAULT_THREAD_LIMIT, maxLimit: MAX_THREAD_LIMIT },
} as const;

const bodySchema = z.object({
  facebookPageId: z.string().trim().min(1).max(100),
  limit: z.number().finite().optional(),
});

const GENERIC_FAILURE = "The run failed. Try again in a few minutes.";

const iso = (ms: number | undefined | null) => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null);

/** Only counts: the progress is whatever the worker wrote, read defensively. */
function readSummary(kind: SourceKind, progress: unknown): SourceRun["summary"] {
  if (!progress || typeof progress !== "object" || (progress as { kind?: unknown }).kind !== kind) return null;
  const raw = progress as Record<string, unknown>;
  const count = (key: string) => (typeof raw[key] === "number" && Number.isFinite(raw[key]) ? (raw[key] as number) : 0);
  if (kind === "posts") {
    return {
      kind,
      postsRead: count("postsRead"),
      postsSkipped: count("postsSkipped"),
      draftsCreated: count("draftsCreated"),
      alreadyThere: count("alreadyThere"),
      withoutPicture: count("withoutPicture"),
      codeClashes: count("codeClashes"),
      failed: count("failed"),
      stoppedAtLimit: raw.stoppedAtLimit === true,
    };
  }
  return {
    kind,
    threadsRead: count("threadsRead"),
    suggestionsFound: count("suggestionsFound"),
    suggestionsAdded: count("suggestionsAdded"),
  };
}

async function describe(
  kind: SourceKind,
  facebookPageId: string,
  workspaceId: string,
  job: Job<FacebookJob> | undefined
): Promise<SourceRun> {
  const idle: SourceRun = {
    kind,
    facebookPageId,
    state: "idle",
    requestedAt: null,
    startedAt: null,
    finishedAt: null,
    summary: null,
    error: null,
  };
  // The ID is derived from the Page, which the caller already proved is theirs; the data is checked too.
  if (!job || (job.data as { workspaceId?: string }).workspaceId !== workspaceId) return idle;

  const raw = await job.getState();
  const state: SourceRunState = raw === "completed" ? "done" : raw === "failed" ? "failed" : raw === "unknown" ? "idle" : "running";
  if (state === "idle") return idle;
  const reason = job.failedReason?.trim() ?? "";
  return {
    ...idle,
    state,
    requestedAt: iso(job.timestamp),
    startedAt: iso(job.processedOn),
    finishedAt: state === "running" ? null : iso(job.finishedOn),
    summary: readSummary(kind, job.progress),
    // A retry waiting its turn also has a failed reason: only a finished run shows one.
    error: state === "failed" ? (isSourceMessage(reason) ? reason : GENERIC_FAILURE) : null,
  };
}

/** The Page must be one of the active brand's. */
async function ownPage(workspaceId: string, facebookPageId: string) {
  return prisma.facebookPage.findFirst({ where: { id: facebookPageId, workspaceId }, select: { id: true, status: true } });
}

export async function readSource(request: Request, kind: SourceKind) {
  const context = await requireWorkspace(request, "ADMIN");
  if (context instanceof Response) return context;

  const facebookPageId = new URL(request.url).searchParams.get("facebookPageId")?.trim() ?? "";
  if (!facebookPageId || facebookPageId.length > 100) return jsonError(400, "Choose a Page.");
  if (!(await ownPage(context.workspaceId, facebookPageId))) return jsonError(404, "This Page is not connected to this brand.");

  try {
    const job = await getFacebookQueue().getJob(knowledgeSourceJobId(kind, facebookPageId));
    return NextResponse.json({ success: true, data: await describe(kind, facebookPageId, context.workspaceId, job) });
  } catch (error) {
    console.error(`[knowledge ${kind}] state read failed:`, error instanceof Error ? error.message : error);
    return jsonError(503, "The job queue cannot be reached. Try again in a moment.");
  }
}

export async function startSource(request: Request, kind: SourceKind) {
  const context = await requireWorkspace(request, "ADMIN");
  if (context instanceof Response) return context;

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError(400, "Choose a Page.");
  const { facebookPageId } = parsed.data;
  const config = CONFIG[kind];
  const limit = Math.min(Math.max(Math.trunc(parsed.data.limit ?? config.defaultLimit), 1), config.maxLimit);

  const page = await ownPage(context.workspaceId, facebookPageId);
  if (!page) return jsonError(404, "This Page is not connected to this brand.");
  if (page.status !== "ACTIVE") return jsonError(409, "This Page is not connected right now. Reconnect it and try again.");

  try {
    const queue = getFacebookQueue();
    const jobId = knowledgeSourceJobId(kind, facebookPageId);

    const existing = await queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === "completed" || state === "failed") {
        // The fixed ID would turn the add into a no-op while the old job is kept.
        await existing.remove();
      } else if (state !== "unknown") {
        return NextResponse.json({
          success: true,
          data: { ...(await describe(kind, facebookPageId, context.workspaceId, existing)), joined: true },
        });
      }
    }

    const data: KnowledgePostsJob | KnowledgeConversationsJob = {
      workspaceId: context.workspaceId,
      facebookPageId,
      limit,
      requestedByUserId: context.userId,
    };
    const job = await queue.add(config.jobName, data, {
      jobId,
      removeOnComplete: { age: KEEP_FINISHED_SECONDS },
      removeOnFail: { age: KEEP_FINISHED_SECONDS },
    });
    // A second click at the same moment got the job the first one added.
    return NextResponse.json(
      { success: true, data: await describe(kind, facebookPageId, context.workspaceId, job) },
      { status: 202 }
    );
  } catch (error) {
    console.error(`[knowledge ${kind}] start failed:`, error instanceof Error ? error.message : error);
    return jsonError(503, "The job queue cannot be reached. Try again in a moment.");
  }
}
