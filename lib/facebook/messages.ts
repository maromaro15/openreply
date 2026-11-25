/**
 * Messenger messages and echoes, in the Facebook worker.
 *
 * A message from a person is stored once (its mid is unique), refreshes the
 * 24-hour window and shows in the inbox. What the bot then does with it is
 * lib/facebook/bot-reply.ts.
 *
 * An echo is a message the Page sent. If it is ours (lib/facebook/echoes.ts)
 * it only confirms delivery: an UNCONFIRMED send becomes SENT. Otherwise a
 * person replied from Meta Business Suite or the Pages app: the reply is
 * stored as theirs and the conversation goes to HUMAN, so the bot stays
 * silent.
 */
import type { Job } from "bullmq";
import type { FacebookPage } from "@/app/generated/prisma/client";
import { getBotDebounceMs } from "@/lib/ai/env";
import { prisma } from "@/lib/db/client";
import { privateReplyTranscript } from "./comments";
import {
  findOrCreateConversation,
  isUniqueViolation,
  messagePreview,
  recordPrivateReplyConversation,
  touchLastMessage,
} from "./conversations";
import { classifyEcho, type OpenReplyReference } from "./echoes";
import { getFacebookAppId } from "./env";
import { getMessengerProfileName } from "./graph";
import { takeOverConversation } from "./inbox";
import { pageToken } from "./pages";
import { queueTranscription } from "./transcription";
import {
  botReplyJobId,
  FB_BOT_REPLY_JOB,
  getFacebookQueue,
  type FacebookMessageJob,
} from "./queue";

export type MessageOutcome =
  | "ignored"
  | "duplicate"
  | "stored"
  | "reconciled"
  | "human_reply"
  | "unknown_reference";

/** What a message carries besides text: the first attachment is kept. */
export function primaryAttachment(data: Pick<FacebookMessageJob, "attachments" | "isSticker">): {
  type: string;
  url: string | null;
} | null {
  const first = data.attachments[0];
  if (!first) return null;
  return { type: data.isSticker || first.stickerId ? "sticker" : first.type, url: first.url ?? null };
}

export async function processMessageJob(job: Job<FacebookMessageJob>): Promise<MessageOutcome> {
  const data = job.data;
  const page = await prisma.facebookPage.findUnique({ where: { id: data.facebookPageId } });
  // A disconnected Page keeps its history but takes in nothing new.
  if (!page || page.pageId !== data.pageId || page.status === "DISCONNECTED") return "ignored";
  return data.kind === "echo" ? processEcho(page, data) : processInbound(page, data);
}

// ─── A person wrote to the Page ─────────────────────────────────────────────

async function processInbound(page: FacebookPage, data: FacebookMessageJob): Promise<MessageOutcome> {
  const sentAt = new Date(data.sentAt);
  const conversation = await findOrCreateConversation(page, data.psid);
  const attachment = primaryAttachment(data);

  const isVoice = attachment?.type === "audio";
  let stored: { id: string };
  try {
    stored = await prisma.facebookMessage.create({
      data: {
        workspaceId: page.workspaceId,
        conversationId: conversation.id,
        direction: "INBOUND",
        author: "CUSTOMER",
        mid: data.mid,
        text: data.text ?? null,
        attachmentType: attachment?.type ?? null,
        attachmentUrl: attachment?.url ?? null,
        transcriptStatus: isVoice ? "PENDING" : null,
        sentAt,
      },
      select: { id: true },
    });
  } catch (error) {
    // A webhook retry, or the same event in two deliveries.
    if (!isUniqueViolation(error)) throw error;
    await resumeFollowUps(page, conversation, data.mid);
    return "duplicate";
  }

  await prisma.facebookConversation.update({
    where: { id: conversation.id },
    data: { unreadCount: { increment: 1 } },
  });
  await touchLastMessage(conversation.id, sentAt, messagePreview(data.text, attachment?.type), "INBOUND");

  // Transcribed right away (the audio link expires); the bot waits for it.
  if (isVoice) await queueTranscription(stored.id);
  await scheduleBotReply(page, conversation, data.mid);

  // The person's name, once: the comment gave it when the thread started
  // from a private reply; otherwise the profile API, when Meta allows it.
  if (!conversation.userName && page.status === "ACTIVE") {
    const inbound = await prisma.facebookMessage.count({
      where: { conversationId: conversation.id, direction: "INBOUND" },
    });
    if (inbound === 1) {
      const name = await getMessengerProfileName(data.psid, pageToken(page));
      if (name) {
        await prisma.facebookConversation.updateMany({
          where: { id: conversation.id, userName: null },
          data: { userName: name },
        });
      }
    }
  }
  return "stored";
}

/**
 * A message seen again (a webhook retry) after a crash between storing it
 * and queueing what follows: queue it now. Both jobs have fixed IDs, so this
 * never runs anything twice.
 */
async function resumeFollowUps(
  page: FacebookPage,
  conversation: { id: string; mode: string; needsHuman: boolean },
  mid: string
): Promise<void> {
  const existing = await prisma.facebookMessage.findUnique({
    where: { mid },
    select: { id: true, conversationId: true, attachmentType: true, transcriptStatus: true },
  });
  if (!existing || existing.conversationId !== conversation.id) return;
  if (existing.attachmentType === "audio" && existing.transcriptStatus === "PENDING") {
    await queueTranscription(existing.id);
  }
  await scheduleBotReply(page, conversation, mid);
}

/**
 * Give the bot its turn, a few seconds from now, when the conversation is
 * its to answer. The job checks everything again when it runs.
 */
async function scheduleBotReply(
  page: FacebookPage,
  conversation: { id: string; mode: string; needsHuman: boolean },
  mid: string
): Promise<void> {
  if (page.status !== "ACTIVE" || !page.botEnabled) return;
  if (conversation.mode !== "BOT" || conversation.needsHuman) return;
  const settings = await prisma.botSettings.findUnique({
    where: { workspaceId: page.workspaceId },
    select: { enabled: true },
  });
  if (!settings?.enabled) return;
  await getFacebookQueue().add(
    FB_BOT_REPLY_JOB,
    { facebookPageId: page.id, conversationId: conversation.id, triggerMid: mid },
    { jobId: botReplyJobId(conversation.id, mid), delay: getBotDebounceMs() }
  );
}

// ─── The Page sent a message ────────────────────────────────────────────────

async function processEcho(page: FacebookPage, data: FacebookMessageJob): Promise<MessageOutcome> {
  const known = await prisma.facebookMessage.findUnique({ where: { mid: data.mid }, select: { id: true } });
  const origin = classifyEcho(
    { appId: data.appId, metadata: data.metadata, mid: data.mid },
    { ourAppId: getFacebookAppId(), midIsKnown: Boolean(known) }
  );
  if (origin.origin === "ours") {
    // Without metadata there is nothing to look up: the app ID or the saved
    // mid already say it is ours, and it was recorded when it was sent.
    return origin.via === "metadata" ? reconcile(page, data, origin.reference) : "reconciled";
  }
  return recordExternalReply(page, data);
}

/** The echo of one of our messages proves Meta delivered it. */
async function reconcile(
  page: FacebookPage,
  data: FacebookMessageJob,
  reference: OpenReplyReference
): Promise<MessageOutcome> {
  if (reference.kind === "message") {
    const message = await prisma.facebookMessage.findFirst({
      where: { id: reference.id, conversation: { facebookPageId: page.id } },
      select: { id: true, mid: true },
    });
    if (!message) return "unknown_reference";
    if (!message.mid) {
      try {
        await prisma.facebookMessage.update({ where: { id: message.id }, data: { mid: data.mid } });
      } catch (error) {
        // A long reply goes out in parts that share one row: the first
        // part's mid is kept.
        if (!isUniqueViolation(error)) throw error;
      }
    }
    await prisma.facebookMessage.updateMany({
      where: { id: message.id, sendStatus: { in: ["PENDING", "UNCONFIRMED", "FAILED"] } },
      data: { sendStatus: "SENT", error: null },
    });
    return "reconciled";
  }

  const log = await prisma.facebookCommentLog.findFirst({
    where: { id: reference.id, facebookPageId: page.id },
  });
  if (!log) return "unknown_reference";
  const sentAt = new Date(data.sentAt);
  const confirmed = await prisma.facebookCommentLog.updateMany({
    where: { id: log.id, status: { not: "SENT" } },
    data: {
      status: "SENT",
      deliveryUnconfirmed: false,
      privateReplySentAt: sentAt,
      privateReplyMessageId: data.mid,
      recipientPsid: data.psid,
      errorMessage: null,
    },
  });
  if (confirmed.count === 1) {
    // The send itself never learned the PSID: open the conversation now.
    const campaign = log.campaignId
      ? await prisma.facebookCampaign.findUnique({ where: { id: log.campaignId } })
      : null;
    await recordPrivateReplyConversation({
      workspaceId: page.workspaceId,
      facebookPageId: page.id,
      psid: data.psid,
      commenterName: log.commenterName,
      campaignId: campaign?.id ?? null,
      commentId: log.commentId,
      text: campaign ? privateReplyTranscript(campaign, log.commenterName) : (data.text ?? ""),
      messageId: data.mid,
      sentAt,
    });
  } else if (!log.privateReplyMessageId) {
    await prisma.facebookCommentLog.updateMany({
      where: { id: log.id, privateReplyMessageId: null },
      data: { privateReplyMessageId: data.mid },
    });
  }
  return "reconciled";
}

/** Someone answered on the Page itself: they have the conversation now. */
async function recordExternalReply(page: FacebookPage, data: FacebookMessageJob): Promise<MessageOutcome> {
  const sentAt = new Date(data.sentAt);
  const conversation = await findOrCreateConversation(page, data.psid);
  const attachment = primaryAttachment(data);
  try {
    await prisma.facebookMessage.create({
      data: {
        workspaceId: page.workspaceId,
        conversationId: conversation.id,
        direction: "OUTBOUND",
        author: "HUMAN",
        origin: "EXTERNAL",
        echoAppId: data.appId ?? null,
        mid: data.mid,
        text: data.text ?? null,
        attachmentType: attachment?.type ?? null,
        attachmentUrl: attachment?.url ?? null,
        sendStatus: "SENT",
        sentAt,
      },
    });
  } catch (error) {
    if (isUniqueViolation(error)) return "duplicate";
    throw error;
  }

  await touchLastMessage(conversation.id, sentAt, messagePreview(data.text, attachment?.type), "OUTBOUND");
  // They read the conversation where they answered it.
  await prisma.facebookConversation.update({ where: { id: conversation.id }, data: { unreadCount: 0 } });
  await takeOverConversation(conversation.id, { reason: "META_REPLY" });
  return "human_reply";
}
