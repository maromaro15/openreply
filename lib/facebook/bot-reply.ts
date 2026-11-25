/**
 * The bot's reply to a conversation, in the Facebook worker.
 *
 * Queued a few seconds after each message (BOT_DEBOUNCE_MS); only the job
 * of the latest message goes on, and answers everything the person wrote
 * since the Page last spoke. It answers only when:
 *   - the bot is on for the brand and for the Page, and the Page works;
 *   - the conversation is with the bot (a person never gets talked over);
 *   - the 24-hour window is open, with 5 minutes to spare;
 *   - fewer than 20 automatic replies went out in the last hour.
 *
 * The reply row is written before the send, unique on the message it
 * answers, so a retried or duplicated job can never reply twice. Anything
 * the bot cannot answer safely is handed to a person: the handoff message
 * goes out once and the team is alerted.
 */
import type { Job } from "bullmq";
import type { FacebookConversation, FacebookMessage, FacebookPage } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { getBotHistoryMessages } from "@/lib/ai/env";
import { answerCustomer } from "@/lib/bot/answer";
import { SYSTEM_REASONS, type BotDecision } from "@/lib/bot/classify";
import { getBotSettings, listKnowledge, type BotSettingsView } from "@/lib/bot/knowledge";
import type { PromptMessage } from "@/lib/bot/prompt";
import { landingUrlFor } from "./comments";
import { isUniqueViolation, messagePreview, touchLastMessage } from "./conversations";
import { messageMetadata } from "./echoes";
import { FacebookApiError, sendMessage } from "./graph";
import { handOffConversation } from "./handoff";
import { pageToken } from "./pages";
import type { FacebookBotReplyJob } from "./queue";
import { isBotWindowOpen } from "./window";

export const MAX_BOT_REPLIES_PER_HOUR = 20;
const HOUR_MS = 60 * 60 * 1000;
/** Attachments the bot cannot read: a person looks at them. */
const STICKER = "sticker";
const AUDIO = "audio";

export type BotReplyOutcome =
  | "ignored"
  | "disabled"
  | "not_bot"
  | "superseded"
  | "duplicate"
  | "window_closed"
  | "nothing_to_answer"
  | "sticker_only"
  | "replied"
  | "handed_off"
  | "unconfirmed"
  | "failed";

type Conversation = FacebookConversation & { page: FacebookPage };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

/** The conversation as the model reads it. Failed sends never reached the person. */
export function toPromptMessages(messages: FacebookMessage[]): PromptMessage[] {
  const result: PromptMessage[] = [];
  for (const message of messages) {
    if (message.direction === "INBOUND") {
      if (message.attachmentType === AUDIO) {
        result.push(
          message.transcript
            ? { from: "customer", text: message.transcript, voice: true }
            : { from: "customer", text: "[sent a voice message that could not be transcribed]" }
        );
        if (message.text) result.push({ from: "customer", text: message.text });
        continue;
      }
      if (message.text) result.push({ from: "customer", text: message.text });
      else if (message.attachmentType === STICKER) result.push({ from: "customer", text: "[sent a sticker]" });
      else if (message.attachmentType) result.push({ from: "customer", text: `[sent a ${message.attachmentType}]` });
      continue;
    }
    if (message.sendStatus === "FAILED" || message.sendStatus === "PENDING" || !message.text) continue;
    result.push({
      from: "page",
      by: message.author === "BOT" ? "bot" : message.author === "CAMPAIGN" ? "campaign" : "person",
      text: message.text,
    });
  }
  return result;
}

/** What the person sent since the Page last spoke. */
async function pendingMessages(conversationId: string): Promise<FacebookMessage[]> {
  const lastOutbound = await prisma.facebookMessage.findFirst({
    where: { conversationId, direction: "OUTBOUND", sendStatus: { not: "FAILED" } },
    orderBy: [{ sentAt: "desc" }, { createdAt: "desc" }],
    select: { sentAt: true },
  });
  return prisma.facebookMessage.findMany({
    where: {
      conversationId,
      direction: "INBOUND",
      ...(lastOutbound ? { sentAt: { gt: lastOutbound.sentAt } } : {}),
    },
    orderBy: [{ sentAt: "asc" }, { createdAt: "asc" }],
    take: 50,
  });
}

/** Send one bot message, claimed on the trigger. Outcome of the send only. */
async function sendClaimed(
  conversation: Conversation,
  triggerMid: string,
  text: string
): Promise<{ status: "sent" } | { status: "duplicate" } | { status: "error"; error: FacebookApiError; rowId: string }> {
  let row: FacebookMessage;
  try {
    row = await prisma.facebookMessage.create({
      data: {
        workspaceId: conversation.workspaceId,
        conversationId: conversation.id,
        direction: "OUTBOUND",
        author: "BOT",
        origin: "OPENREPLY",
        replyToMid: triggerMid,
        text,
        sendStatus: "PENDING",
      },
    });
  } catch (error) {
    if (isUniqueViolation(error)) return { status: "duplicate" };
    throw error;
  }

  try {
    const result = await sendMessage(conversation.page.pageId, pageToken(conversation.page), {
      psid: conversation.psid,
      text,
      metadata: messageMetadata(row.id),
    });
    const sentAt = new Date();
    try {
      await prisma.facebookMessage.update({
        where: { id: row.id },
        data: { sendStatus: "SENT", mid: result.message_id ?? undefined, sentAt, error: null },
      });
    } catch (error) {
      // Its echo got there first with the same mid.
      if (!isUniqueViolation(error)) throw error;
      await prisma.facebookMessage.update({ where: { id: row.id }, data: { sendStatus: "SENT", sentAt, error: null } });
    }
    await touchLastMessage(conversation.id, sentAt, messagePreview(text), "OUTBOUND");
    return { status: "sent" };
  } catch (error) {
    const fbError =
      error instanceof FacebookApiError ? error : new FacebookApiError(errorText(error), "ambiguous");
    return { status: "error", error: fbError, rowId: row.id };
  }
}

/** Record a send that did not go through. SENT, set by an echo, stays. */
async function settle(rowId: string, error: FacebookApiError) {
  await prisma.facebookMessage.updateMany({
    where: { id: rowId, sendStatus: "PENDING" },
    data: { sendStatus: error.kind === "ambiguous" ? "UNCONFIRMED" : "FAILED", error: error.message },
  });
}

async function markTokenInvalid(page: FacebookPage, error: FacebookApiError) {
  await prisma.facebookPage.update({
    where: { id: page.id },
    data: { status: "TOKEN_INVALID", lastError: error.message },
  });
}

/** Hand the conversation to a person, then tell the customer once. */
async function handOff(
  conversation: Conversation,
  triggerMid: string,
  decision: Extract<BotDecision, { kind: "handoff" }>,
  settings: BotSettingsView,
  { tellCustomer = true }: { tellCustomer?: boolean } = {}
): Promise<BotReplyOutcome> {
  const handoff = await handOffConversation(conversation.id, {
    category: decision.category,
    reason: decision.reason,
  });
  if (!handoff) return "not_bot";
  if (decision.detail) {
    console.log(`[Facebook bot] ${conversation.id} handed off (${decision.source}): ${decision.detail}`);
  }

  const fresh = await prisma.facebookPage.findUnique({ where: { id: conversation.page.id }, select: { status: true } });
  if (!tellCustomer || fresh?.status !== "ACTIVE" || !isBotWindowOpen(conversation.lastInboundAt)) {
    return "handed_off";
  }
  const sent = await sendClaimed(conversation, triggerMid, settings.handoffMessage);
  if (sent.status === "error") {
    // The conversation is with a person and they are alerted: no retry.
    await settle(sent.rowId, sent.error);
    if (sent.error.kind === "token_invalid") await markTokenInvalid(conversation.page, sent.error);
  }
  return "handed_off";
}

export async function processBotReplyJob(job: Job<FacebookBotReplyJob>): Promise<BotReplyOutcome> {
  const { conversationId, triggerMid, facebookPageId } = job.data;
  const conversation = await prisma.facebookConversation.findUnique({
    where: { id: conversationId },
    include: { page: true },
  });
  if (!conversation || conversation.facebookPageId !== facebookPageId) return "ignored";
  const page = conversation.page;
  if (page.status !== "ACTIVE" || !page.accessToken || !page.botEnabled) return "disabled";
  const settings = await getBotSettings(conversation.workspaceId);
  if (!settings.enabled) return "disabled";
  if (conversation.mode !== "BOT" || conversation.needsHuman) return "not_bot";

  // The debounce: a newer message has its own job, which answers both.
  const latest = await prisma.facebookMessage.findFirst({
    where: { conversationId, direction: "INBOUND" },
    orderBy: [{ sentAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    select: { mid: true },
  });
  if (!latest || latest.mid !== triggerMid) return "superseded";

  // A retry, or a stalled job run again, after the reply was claimed.
  const claimed = await prisma.facebookMessage.findFirst({
    where: { conversationId, replyToMid: triggerMid },
    select: { id: true },
  });
  if (claimed) return "duplicate";

  if (!isBotWindowOpen(conversation.lastInboundAt)) return "window_closed";

  const pending = await pendingMessages(conversationId);
  if (pending.length === 0) return "nothing_to_answer";
  if (pending.every((message) => !message.text && message.attachmentType === STICKER)) return "sticker_only";

  const handoffBy = (category: "OTHER" | "AUDIO_FAILED", reason: string) =>
    handOff(conversation, triggerMid, { kind: "handoff", category, reason, source: "system" }, settings);

  if (pending.some((message) => message.attachmentType && ![STICKER, AUDIO].includes(message.attachmentType))) {
    return handoffBy("OTHER", SYSTEM_REASONS.attachment);
  }
  if (pending.some((message) => message.attachmentType === AUDIO && message.transcriptStatus !== "DONE")) {
    return handoffBy("AUDIO_FAILED", SYSTEM_REASONS.audio);
  }
  const lastHour = await prisma.facebookMessage.count({
    where: { conversationId, author: "BOT", direction: "OUTBOUND", sentAt: { gte: new Date(Date.now() - HOUR_MS) } },
  });
  if (lastHour >= MAX_BOT_REPLIES_PER_HOUR) return handoffBy("OTHER", SYSTEM_REASONS.tooManyReplies);

  const [knowledge, history, campaign] = await Promise.all([
    listKnowledge(conversation.workspaceId),
    prisma.facebookMessage.findMany({
      where: { conversationId },
      orderBy: [{ sentAt: "desc" }, { createdAt: "desc" }],
      take: getBotHistoryMessages(),
    }),
    conversation.sourceCampaignId
      ? prisma.facebookCampaign.findFirst({
          where: { id: conversation.sourceCampaignId, workspaceId: conversation.workspaceId },
        })
      : Promise.resolve(null),
  ]);

  const answer = await answerCustomer({
    businessName: settings.businessName,
    pageName: page.name,
    instructions: settings.instructions,
    knowledge,
    campaign: campaign
      ? { name: campaign.name, botContext: campaign.botContext, landingUrl: landingUrlFor(campaign) }
      : null,
    history: toPromptMessages(history.reverse()),
  });
  if (answer.error) console.warn(`[Facebook bot] ${conversationId}: ${answer.error}`);
  if (answer.decision.kind === "handoff") return handOff(conversation, triggerMid, answer.decision, settings);

  // The model took a few seconds: is the conversation still the bot's?
  const fresh = await prisma.facebookConversation.findUnique({
    where: { id: conversationId },
    select: { mode: true, needsHuman: true, lastInboundAt: true },
  });
  if (!fresh || fresh.mode !== "BOT" || fresh.needsHuman) return "not_bot";
  if (!isBotWindowOpen(fresh.lastInboundAt)) return "window_closed";

  const sent = await sendClaimed(conversation, triggerMid, answer.decision.text);
  if (sent.status === "sent") return "replied";
  if (sent.status === "duplicate") return "duplicate";

  const error = sent.error;
  if (error.kind === "ambiguous") {
    // It may have been delivered: never sent a second time.
    await settle(sent.rowId, error);
    return "unconfirmed";
  }
  if (error.kind === "unreachable" || error.kind === "rate_limit") {
    // Nothing went out: free the claim and let BullMQ try again later.
    await prisma.facebookMessage.deleteMany({ where: { id: sent.rowId, sendStatus: "PENDING" } });
    if (job.attemptsMade + 1 < (job.opts.attempts ?? 1)) throw error;
    return handOff(
      conversation,
      triggerMid,
      { kind: "handoff", category: "OTHER", reason: SYSTEM_REASONS.facebookUnreachable, source: "system" },
      settings,
      { tellCustomer: false }
    );
  }
  await settle(sent.rowId, error);
  if (error.kind === "token_invalid") {
    await markTokenInvalid(page, error);
    await handOff(
      conversation,
      triggerMid,
      { kind: "handoff", category: "OTHER", reason: SYSTEM_REASONS.tokenInvalid, source: "system" },
      settings,
      { tellCustomer: false }
    );
  }
  return "failed";
}
