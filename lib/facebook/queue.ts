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

export const FB_MESSAGE_JOB = "fb-message";

/**
 * A Messenger message on a connected Page: one a person sent ("message"),
 * or one the Page sent, delivered back through message_echoes ("echo").
 */
export interface FacebookMessageJob {
  facebookPageId: string;
  pageId: string;
  kind: "message" | "echo";
  /** The person: the sender of a message, the recipient of an echo. */
  psid: string;
  mid: string;
  text?: string;
  attachments: { type: string; url?: string; stickerId?: string }[];
  isSticker?: boolean;
  replyToMid?: string;
  /** Echoes only. */
  appId?: string;
  metadata?: string;
  /** ISO time Meta gives for the message. */
  sentAt: string;
  /** A «نحب هذا» click (messaging_postbacks): its payload, read by lib/facebook/postbacks.ts. */
  postback?: { payload: string };
}

export const FB_BOT_REPLY_JOB = "fb-bot-reply";

/**
 * The bot's turn in a conversation, queued a few seconds after a message
 * (the debounce): only the job of the latest message answers, for all of
 * the messages the person sent in a row.
 */
export interface FacebookBotReplyJob {
  facebookPageId: string;
  conversationId: string;
  /** The message that queued this job; the reply is claimed on it. */
  triggerMid: string;
  /** How many times the job waited for a voice message to be transcribed. */
  waits?: number;
}

export const FB_TRANSCRIBE_JOB = "fb-transcribe";

/** A voice message to transcribe: a FacebookMessage row. */
export interface FacebookTranscribeJob {
  messageId: string;
}

export const FB_RECOGNIZE_JOB = "fb-recognize";

/** A customer's photo to read and recognise: a FacebookMessage row. */
export interface FacebookRecognizeJob {
  messageId: string;
}

export const ALERT_SEND_JOB = "alert-send";

/** One handoff alert to one recipient: an AlertDelivery row. */
export interface AlertSendJob {
  deliveryId: string;
}

// ─── Filling the catalog and the knowledge base (phase 14) ──────────────────

export const KB_POSTS_JOB = "kb-posts";

/** Read a Page's recent posts into DRAFT products (lib/knowledge/posts.ts). */
export interface KnowledgePostsJob {
  workspaceId: string;
  facebookPageId: string;
  /** How many recent posts to read. */
  limit?: number;
  requestedByUserId?: string | null;
}

export const KB_CONVERSATIONS_JOB = "kb-conversations";

/** Read a Page's past Messenger answers into suggestions (lib/knowledge/conversations.ts). */
export interface KnowledgeConversationsJob {
  workspaceId: string;
  facebookPageId: string;
  /** How many recent threads to read. */
  limit?: number;
  requestedByUserId?: string | null;
}

export const KB_LEARN_JOB = "kb-learn";

/** A person answered a handed-off conversation: suggest keeping the answer (lib/knowledge/learning.ts). */
export interface KnowledgeLearnJob {
  /** The person's outbound FacebookMessage row. */
  messageId: string;
}

export type FacebookJob =
  | FacebookCommentJob
  | FacebookMessageJob
  | FacebookBotReplyJob
  | FacebookTranscribeJob
  | FacebookRecognizeJob
  | AlertSendJob
  | KnowledgePostsJob
  | KnowledgeConversationsJob
  | KnowledgeLearnJob;

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

export function transcribeJobId(messageId: string): string {
  return `fbt_${jobIdPart(messageId)}`;
}

export function recognizeJobId(messageId: string): string {
  return `fbi_${jobIdPart(messageId)}`;
}

export function alertJobId(deliveryId: string): string {
  return `alert_${jobIdPart(deliveryId)}`;
}

export function botReplyJobId(conversationId: string, triggerMid: string): string {
  return `fbr_${jobIdPart(conversationId)}_${Buffer.from(triggerMid).toString("base64url")}`;
}

/** Message IDs ("m_…") may hold any character; always encoded. */
export function messageJobId(pageId: string, mid: string, kind: FacebookMessageJob["kind"] = "message"): string {
  return `${kind === "echo" ? "fbe" : "fbm"}_${jobIdPart(pageId)}_${Buffer.from(mid).toString("base64url")}`;
}

/** One run per Page at a time: a second click while one runs joins it. */
export function knowledgeSourceJobId(kind: "posts" | "conversations", facebookPageId: string): string {
  return `${kind === "posts" ? "kbp" : "kbc"}_${jobIdPart(facebookPageId)}`;
}

export function learnJobId(messageId: string): string {
  return `kbl_${jobIdPart(messageId)}`;
}
