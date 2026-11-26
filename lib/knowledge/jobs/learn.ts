/**
 * The learning loop (PLAN.md 6.15): after the bot hands a conversation to a
 * person and the person answers, suggest keeping that answer in the
 * knowledge base.
 *
 * - queueHandoffLearning: called after a person's reply was stored, from the
 *   inbox or from Meta Business Suite. It never throws and never waits long,
 *   so the reply itself is not slowed or failed by it.
 * - processLearnJob: the kb-learn job. Reads the exchange, asks the model,
 *   and stores PENDING suggestions. A person approves every one.
 * - saveReplyAsKnowledge: the inbox button («Add to the knowledge base»).
 */
import type { Job } from "bullmq";
import { getGoogleApiKey } from "@/lib/ai/env";
import { createKnowledgeEntry } from "@/lib/bot/knowledge";
import { prisma } from "@/lib/db/client";
import { getFacebookQueue, KB_LEARN_JOB, learnJobId, type KnowledgeLearnJob } from "@/lib/facebook/queue";
import { isWorthSuggesting, suggestFromReply, type HandoffExchange } from "@/lib/knowledge/learning";
import { saveSuggestions, suggestionDedupeKey } from "@/lib/knowledge/suggestions";

/** Never let the queue slow a reply down for longer than this. */
const QUEUE_TIMEOUT_MS = 2_000;
const MAX_CUSTOMER_MESSAGES = 6;
/** Without an earlier person's reply, customer messages up to this far before the handoff count. */
const BEFORE_HANDOFF_MS = 24 * 60 * 60 * 1000;
const MAX_PRODUCTS = 50;
const EVIDENCE_QUESTION_CHARS = 300;
const EVIDENCE_REPLY_CHARS = 600;

/** What the inbox form accepts: the entry's title is the question. */
export const FROM_REPLY_LIMITS = { question: 200, answer: 1000 } as const;

function clip(text: string, limit: number): string {
  const chars = Array.from(text);
  return chars.length <= limit ? text : `${chars.slice(0, limit - 1).join("").trimEnd()}…`;
}

function flat(text: string, limit: number): string {
  return clip(text.replace(/\s+/g, " ").trim(), limit);
}

/** The quote a reviewer sees: the customer's words, then the person's answer. */
export function replyEvidence(question: string, reply: string): string {
  return `${flat(question, EVIDENCE_QUESTION_CHARS)}\n→ ${flat(reply, EVIDENCE_REPLY_CHARS)}`;
}

// ─── Queueing ───────────────────────────────────────────────────────────────

/**
 * Queue the learning job for a person's reply, only when the conversation had
 * been handed off by the bot and the reply may hold something reusable.
 * Catches everything: a queue outage must never fail the reply.
 */
export async function queueHandoffLearning(
  message: { id: string; text: string | null | undefined },
  conversation: { handoffCategory: string | null | undefined }
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!conversation.handoffCategory) return;
    if (!message.text || !isWorthSuggesting(message.text)) return;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("queue timeout")), QUEUE_TIMEOUT_MS);
      timer.unref?.();
    });
    await Promise.race([
      getFacebookQueue().add(KB_LEARN_JOB, { messageId: message.id }, { jobId: learnJobId(message.id) }),
      timeout,
    ]);
  } catch (error) {
    console.error("[Facebook] Learning job not queued:", error instanceof Error ? error.message : error);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ─── The job ────────────────────────────────────────────────────────────────

function spokenText(message: { text: string | null; transcript: string | null }): string {
  return (message.text ?? message.transcript ?? "").trim();
}

export async function processLearnJob(job: Job<KnowledgeLearnJob>): Promise<string> {
  const messageId = job.data?.messageId;
  if (typeof messageId !== "string" || !messageId) return "skipped: no message";

  const reply = await prisma.facebookMessage.findUnique({
    where: { id: messageId },
    select: {
      id: true,
      workspaceId: true,
      conversationId: true,
      direction: true,
      author: true,
      text: true,
      sendStatus: true,
      sentAt: true,
    },
  });
  // Deleted meanwhile, or not a person's reply: nothing to learn.
  if (!reply) return "skipped: message gone";
  if (reply.direction !== "OUTBOUND" || reply.author !== "HUMAN") return "skipped: not a person's reply";
  if (reply.sendStatus === "FAILED" || reply.sendStatus === "PENDING") return "skipped: not sent";
  const replyText = reply.text?.trim() ?? "";
  if (!replyText || !isWorthSuggesting(replyText)) return "skipped: nothing reusable";
  if (!getGoogleApiKey()) return "skipped: no AI key";

  const conversation = await prisma.facebookConversation.findFirst({
    where: { id: reply.conversationId, workspaceId: reply.workspaceId },
    select: { id: true, handoffCategory: true, handoffAt: true, focusProductIds: true },
  });
  if (!conversation) return "skipped: conversation gone";

  // The latest hand-off or hand-back before the reply decides: a reply to a
  // conversation the bot was handed back is not an answer to a handoff.
  const turning = await prisma.facebookConversationEvent.findFirst({
    where: {
      conversationId: conversation.id,
      type: { in: ["HANDOFF", "RETURNED_TO_BOT"] },
      createdAt: { lte: reply.sentAt },
    },
    orderBy: { createdAt: "desc" },
    select: { type: true, category: true, createdAt: true },
  });
  let category: string | null = null;
  let handoffAt: Date | null = null;
  if (turning) {
    if (turning.type !== "HANDOFF") return "skipped: not a handoff reply";
    category = turning.category;
    handoffAt = turning.createdAt;
  } else if (conversation.handoffCategory) {
    // A handoff stored before events existed.
    category = conversation.handoffCategory;
    handoffAt = conversation.handoffAt;
  } else {
    return "skipped: not a handoff reply";
  }

  // The customer's words since the person last spoke (or just before the handoff).
  const earlier = await prisma.facebookMessage.findFirst({
    where: {
      conversationId: conversation.id,
      direction: "OUTBOUND",
      author: "HUMAN",
      id: { not: reply.id },
      sentAt: { lt: reply.sentAt },
    },
    orderBy: { sentAt: "desc" },
    select: { sentAt: true },
  });
  const since = earlier?.sentAt ?? (handoffAt ? new Date(handoffAt.getTime() - BEFORE_HANDOFF_MS) : null);
  const inbound = await prisma.facebookMessage.findMany({
    where: {
      conversationId: conversation.id,
      direction: "INBOUND",
      author: "CUSTOMER",
      sentAt: { lt: reply.sentAt, ...(since ? { gt: since } : {}) },
    },
    orderBy: { sentAt: "desc" },
    take: MAX_CUSTOMER_MESSAGES,
    select: { text: true, transcript: true },
  });
  const customerMessages = inbound.map(spokenText).filter(Boolean).reverse();
  if (customerMessages.length === 0) return "skipped: no customer question";

  const focusIds = conversation.focusProductIds.slice(0, MAX_PRODUCTS);
  const products = focusIds.length
    ? await prisma.product.findMany({
        where: { workspaceId: reply.workspaceId, id: { in: focusIds } },
        select: { id: true, name: true, code: true },
        take: MAX_PRODUCTS,
      })
    : [];

  const exchange: HandoffExchange = { customerMessages, humanReply: replyText, category, products };
  const suggestion = await suggestFromReply(exchange);
  if (!suggestion) return "nothing to suggest";

  const wording = suggestion.payload.answer ?? suggestion.payload.text ?? "";
  const added = await saveSuggestions(reply.workspaceId, "HANDOFF_REPLY", [
    {
      target: suggestion.target,
      productId: suggestion.productId,
      payload: suggestion.payload,
      evidence: replyEvidence(customerMessages.slice(-2).join(" / "), replyText),
      // The review screen links this to the inbox.
      sourceRef: conversation.id,
      dedupeKey: suggestionDedupeKey(reply.id, suggestion.target, wording),
    },
  ]);
  return added > 0 ? `suggested ${suggestion.target}` : "already suggested";
}

// ─── The inbox button ───────────────────────────────────────────────────────

export type SaveReplyResult =
  | { ok: true; mode: "entry"; created: boolean }
  | { ok: true; mode: "suggestion"; created: boolean }
  | { ok: false; status: number; code: "not_found" | "not_a_reply" | "full"; error: string };

/**
 * «Add to the knowledge base» under a person's reply. An owner or admin has
 * reviewed the text by writing it, so it becomes a FAQ entry at once; a member
 * cannot edit the knowledge base, so it waits as a suggestion for an admin.
 */
export async function saveReplyAsKnowledge(input: {
  workspaceId: string;
  canEditKnowledge: boolean;
  messageId: string;
  question: string;
  answer: string;
}): Promise<SaveReplyResult> {
  const message = await prisma.facebookMessage.findFirst({
    where: { id: input.messageId, workspaceId: input.workspaceId },
    select: { id: true, conversationId: true, direction: true, author: true },
  });
  if (!message) return { ok: false, status: 404, code: "not_found", error: "Message not found." };
  if (message.direction !== "OUTBOUND" || message.author !== "HUMAN") {
    return { ok: false, status: 400, code: "not_a_reply", error: "Only a reply written by a person can be added." };
  }

  if (!input.canEditKnowledge) {
    const added = await saveSuggestions(input.workspaceId, "HANDOFF_REPLY", [
      {
        target: "faq",
        payload: { question: input.question, answer: input.answer },
        evidence: replyEvidence(input.question, input.answer),
        sourceRef: message.conversationId,
        dedupeKey: suggestionDedupeKey(message.id, "faq", input.answer),
      },
    ]);
    return { ok: true, mode: "suggestion", created: added > 0 };
  }

  // The same question and answer twice is one entry.
  const same = await prisma.knowledgeEntry.findFirst({
    where: { workspaceId: input.workspaceId, kind: "FAQ", title: input.question, content: input.answer },
    select: { id: true },
  });
  if (same) return { ok: true, mode: "entry", created: false };
  const entry = await createKnowledgeEntry(input.workspaceId, {
    kind: "FAQ",
    title: input.question,
    content: input.answer,
    price: null,
    isActive: true,
  });
  if (!entry) return { ok: false, status: 400, code: "full", error: "The knowledge base is full." };
  return { ok: true, mode: "entry", created: true };
}
