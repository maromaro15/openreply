/**
 * Messenger conversations: one per Page and person (PSID).
 */
import { Prisma, type FacebookConversation } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";

const PREVIEW_LENGTH = 200;

export function preview(text: string | null | undefined): string | null {
  if (!text) return null;
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  return chars.length > PREVIEW_LENGTH ? `${chars.slice(0, PREVIEW_LENGTH - 1).join("")}…` : chars.join("");
}

/** Language-neutral marks for messages without text, in the list preview. */
const ATTACHMENT_MARKS: Record<string, string> = {
  audio: "🎤",
  image: "📷",
  video: "🎬",
  file: "📎",
  sticker: "🙂",
  location: "📍",
};

export function attachmentMark(type: string | null | undefined): string {
  return (type && ATTACHMENT_MARKS[type]) || "📎";
}

/** The list preview of a message: its text, or a mark for what it carries. */
export function messagePreview(text: string | null | undefined, attachmentType?: string | null): string | null {
  if (text?.trim()) return preview(text);
  return attachmentType ? attachmentMark(attachmentType) : null;
}

export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/**
 * The conversation of a person with a Page, created on first contact. Two
 * jobs for the same person can race here; the unique key lets one insert
 * win and the other reads that row.
 */
export async function findOrCreateConversation(
  page: { id: string; workspaceId: string },
  psid: string
): Promise<FacebookConversation> {
  const key = { facebookPageId_psid: { facebookPageId: page.id, psid } };
  const existing = await prisma.facebookConversation.findUnique({ where: key });
  if (existing) return existing;
  try {
    return await prisma.facebookConversation.create({
      data: { workspaceId: page.workspaceId, facebookPageId: page.id, psid },
    });
  } catch (error) {
    if (isUniqueViolation(error)) return prisma.facebookConversation.findUniqueOrThrow({ where: key });
    throw error;
  }
}

/**
 * Move the conversation's "last message" forward, never back: jobs for one
 * conversation can finish out of order.
 */
export async function touchLastMessage(
  conversationId: string,
  at: Date,
  previewText: string | null,
  direction: "INBOUND" | "OUTBOUND"
): Promise<void> {
  await prisma.facebookConversation.updateMany({
    where: { id: conversationId, OR: [{ lastMessageAt: null }, { lastMessageAt: { lte: at } }] },
    data: { lastMessageAt: at, lastMessageText: previewText },
  });
  if (direction === "INBOUND") {
    await prisma.facebookConversation.updateMany({
      where: { id: conversationId, OR: [{ lastInboundAt: null }, { lastInboundAt: { lt: at } }] },
      data: { lastInboundAt: at },
    });
  } else {
    await prisma.facebookConversation.updateMany({
      where: { id: conversationId, OR: [{ lastOutboundAt: null }, { lastOutboundAt: { lt: at } }] },
      data: { lastOutboundAt: at },
    });
  }
}

/**
 * A private reply reached a commenter: open (or refresh) their conversation
 * and record the message, so the inbox shows how the thread started and the
 * bot knows which campaign brought the person in.
 *
 * The private reply does not open the 24-hour window; only the person's own
 * reply does, so lastInboundAt is left alone.
 */
export async function recordPrivateReplyConversation({
  workspaceId,
  facebookPageId,
  psid,
  commenterName,
  campaignId,
  commentId,
  text,
  messageId,
  sentAt = new Date(),
}: {
  workspaceId: string;
  facebookPageId: string;
  psid: string;
  commenterName?: string | null;
  campaignId: string | null;
  commentId: string;
  text: string;
  messageId?: string | null;
  sentAt?: Date;
}) {
  const conversation = await prisma.facebookConversation.upsert({
    where: { facebookPageId_psid: { facebookPageId, psid } },
    create: {
      workspaceId,
      facebookPageId,
      psid,
      userName: commenterName ?? null,
      sourceCampaignId: campaignId,
      sourceCommentId: commentId,
      lastOutboundAt: sentAt,
      lastMessageText: preview(text),
      lastMessageAt: sentAt,
    },
    update: {
      sourceCampaignId: campaignId,
      sourceCommentId: commentId,
      lastOutboundAt: sentAt,
      lastMessageText: preview(text),
      lastMessageAt: sentAt,
    },
  });
  if (!conversation.userName && commenterName) {
    await prisma.facebookConversation.update({
      where: { id: conversation.id },
      data: { userName: commenterName },
    });
  }

  try {
    await prisma.facebookMessage.create({
      data: {
        workspaceId,
        conversationId: conversation.id,
        direction: "OUTBOUND",
        author: "CAMPAIGN",
        origin: "OPENREPLY",
        mid: messageId ?? null,
        text,
        sendStatus: "SENT",
        sentAt,
      },
    });
  } catch (error) {
    // A retry of the job, or the echo of this reply, already stored it.
    if (!isUniqueViolation(error)) throw error;
  }
  return conversation;
}
