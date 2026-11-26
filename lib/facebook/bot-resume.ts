/**
 * The bot takes a conversation back from the team when nobody answers the
 * customer: after the brand's delay (resumeAfterMinutes) since a customer
 * message, or once the customer sent resumeAfterMessages messages in a row.
 * Zero turns a rule off. Back with the bot, anything it cannot answer gets
 * the brand's "the team is busy" message and alerts the team again
 * (handoffMessageFor in ./bot-reply.ts).
 */
import type { Job } from "bullmq";
import type { FacebookPage } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { getBotDebounceMs } from "@/lib/ai/env";
import { getBotSettings } from "@/lib/bot/knowledge";
import { returnConversationToBot } from "./inbox";
import {
  botReplyJobId,
  botResumeJobId,
  FB_BOT_REPLY_JOB,
  FB_BOT_RESUME_JOB,
  getFacebookQueue,
  type FacebookBotResumeJob,
} from "./queue";

export type BotResumeOutcome = "resumed" | "not_needed" | "answered" | "disabled" | "ignored";

type Conversation = { id: string; mode: string; needsHuman: boolean; modeChangedAt: Date | null };

/** When the team last spoke or took the conversation: the customer's messages after it are unanswered. */
async function teamLastActedAt(conversation: Conversation): Promise<Date | null> {
  const reply = await prisma.facebookMessage.findFirst({
    where: { conversationId: conversation.id, direction: "OUTBOUND", author: "HUMAN" },
    orderBy: { sentAt: "desc" },
    select: { sentAt: true },
  });
  const times = [reply?.sentAt, conversation.modeChangedAt].filter((t): t is Date => Boolean(t));
  return times.length ? new Date(Math.max(...times.map((t) => t.getTime()))) : null;
}

async function resume(page: Pick<FacebookPage, "id">, conversationId: string): Promise<boolean> {
  if (!(await returnConversationToBot(conversationId, null, "AUTO_RESUME"))) return false;
  const latest = await prisma.facebookMessage.findFirst({
    where: { conversationId, direction: "INBOUND", mid: { not: null } },
    orderBy: [{ sentAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    select: { mid: true },
  });
  if (latest?.mid) {
    await getFacebookQueue().add(
      FB_BOT_REPLY_JOB,
      { facebookPageId: page.id, conversationId, triggerMid: latest.mid },
      { jobId: botReplyJobId(conversationId, latest.mid), delay: getBotDebounceMs() }
    );
  }
  return true;
}

/** A customer wrote while the team has the conversation (called for every such message). */
export async function scheduleBotResume(
  page: Pick<FacebookPage, "id" | "workspaceId">,
  conversation: Conversation,
  mid: string
): Promise<void> {
  const settings = await getBotSettings(page.workspaceId);
  if (!settings.enabled) return;
  if (settings.resumeAfterMessages > 0) {
    const since = await teamLastActedAt(conversation);
    const unanswered = await prisma.facebookMessage.count({
      where: {
        conversationId: conversation.id,
        direction: "INBOUND",
        ...(since ? { sentAt: { gt: since } } : {}),
      },
    });
    if (unanswered >= settings.resumeAfterMessages) {
      await resume(page, conversation.id);
      return;
    }
  }
  if (settings.resumeAfterMinutes > 0) {
    await getFacebookQueue().add(
      FB_BOT_RESUME_JOB,
      { facebookPageId: page.id, conversationId: conversation.id, triggerMid: mid },
      { jobId: botResumeJobId(conversation.id, mid), delay: settings.resumeAfterMinutes * 60_000 }
    );
  }
}

/** The delay since a customer message passed: back to the bot, unless the team answered or acted since. */
export async function processBotResumeJob(job: Job<FacebookBotResumeJob>): Promise<BotResumeOutcome> {
  const { conversationId, triggerMid, facebookPageId } = job.data;
  const conversation = await prisma.facebookConversation.findUnique({
    where: { id: conversationId },
    include: { page: true },
  });
  if (!conversation || conversation.facebookPageId !== facebookPageId) return "ignored";
  const page = conversation.page;
  if (page.status !== "ACTIVE" || !page.botEnabled) return "disabled";
  const settings = await getBotSettings(conversation.workspaceId);
  // The brand may have turned the rule off since the message was queued.
  if (!settings.enabled || settings.resumeAfterMinutes <= 0) return "disabled";
  if (conversation.mode === "BOT" && !conversation.needsHuman) return "not_needed";
  const trigger = await prisma.facebookMessage.findUnique({ where: { mid: triggerMid }, select: { sentAt: true } });
  if (!trigger) return "ignored";
  const since = await teamLastActedAt(conversation);
  // Someone answered, took it, or the bot already came back and handed it off again after this message.
  if (since && since > trigger.sentAt) return "answered";
  return (await resume(page, conversationId)) ? "resumed" : "not_needed";
}
