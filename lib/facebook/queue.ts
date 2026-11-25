/**
 * The Facebook queue: a sibling of the Instagram "dm-processing" queue on
 * the same Redis and BullMQ (PLAN.md, decision 1). Its own worker process
 * consumes it, so Instagram jobs and Facebook jobs never meet.
 */
import { Queue } from "bullmq";
import { getRedisConnection } from "@/lib/queue/client";

export const FACEBOOK_QUEUE = "facebook-processing";

export const FB_COMMENT_JOB = "fb-comment";

/** A new comment on a connected Page, as received by the webhook. */
export interface FacebookCommentJob {
  /** FacebookPage.id (our row), not the Page ID. */
  facebookPageId: string;
  pageId: string;
  commentId: string;
  postId: string;
  parentId?: string;
  commenterId?: string;
  commenterName?: string;
  text: string;
  /** ISO time the comment was posted: the 7-day private reply window. */
  createdAt: string;
  /** Times this comment was held for the rate limiter, counting this run. */
  requeueAttempt?: number;
  /** Pacing slot the hold reserved (ms since epoch), as in the Instagram worker. */
  slotAt?: number;
}

export type FacebookJob = FacebookCommentJob;

let queue: Queue<FacebookJob> | null = null;

export function getFacebookQueue(): Queue<FacebookJob> {
  if (!queue) {
    queue = new Queue<FacebookJob>(FACEBOOK_QUEUE, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        removeOnComplete: { count: 2000 },
        // Kept a day for inspection. Job IDs are deterministic, so a kept
        // job also stops a late webhook retry from queueing it twice.
        removeOnFail: { age: 24 * 60 * 60, count: 5000 },
        attempts: 3,
        backoff: { type: "exponential", delay: 60_000 },
      },
    });
  }
  return queue;
}

/**
 * A job ID part. BullMQ rejects ":" in custom IDs; Graph IDs are digits and
 * underscores, and anything else is base64url-encoded so two different IDs
 * can never collapse onto one job.
 */
export function jobIdPart(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : `b64_${Buffer.from(value).toString("base64url")}`;
}

export function commentJobId(pageId: string, commentId: string): string {
  return `fbc_${jobIdPart(pageId)}_${jobIdPart(commentId)}`;
}
