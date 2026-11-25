/**
 * Messenger conversations: one per Page and person (PSID).
 */
import { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";

const PREVIEW_LENGTH = 200;

export function preview(text: string | null | undefined): string | null {
  if (!text) return null;
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  return chars.length > PREVIEW_LENGTH ? `${chars.slice(0, PREVIEW_LENGTH - 1).join("")}…` : chars.join("");
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
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
  campaignId: string;
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
    // A retry of the job already stored this message: nothing to add.
    if (!isUniqueViolation(error)) throw error;
  }
  return conversation;
}
