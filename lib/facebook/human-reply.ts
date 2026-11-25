/**
 * A reply typed by a person in the OpenReply inbox.
 *
 * The message row is written before the send, so its ID can travel as
 * metadata and its echo is recognised as ours (lib/facebook/echoes.ts). An
 * outcome Meta did not confirm is kept as UNCONFIRMED and never resent: the
 * person sees it and decides.
 */
import { prisma } from "@/lib/db/client";
import { messageMetadata } from "./echoes";
import { FacebookApiError, MESSENGER_TEXT_LIMIT, sendMessage, type SendResult } from "./graph";
import { isUniqueViolation, messagePreview, touchLastMessage } from "./conversations";
import { serializeMessage, takeOverConversation, type ThreadMessage } from "./inbox";
import { pageToken } from "./pages";
import type { HumanReplyError } from "./reply-errors";
import { humanReplyPolicy } from "./window";

export const HUMAN_REPLY_MAX_LENGTH = MESSENGER_TEXT_LIMIT;

export type HumanReplyResult =
  | { ok: true; message: ThreadMessage }
  | { ok: false; status: number; code: HumanReplyError; detail?: string };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

export async function sendHumanReply({
  workspaceId,
  userId,
  conversationId,
  text,
}: {
  workspaceId: string;
  userId: string;
  conversationId: string;
  text: string;
}): Promise<HumanReplyResult> {
  const conversation = await prisma.facebookConversation.findFirst({
    where: { id: conversationId, workspaceId },
    include: { page: true },
  });
  if (!conversation) return { ok: false, status: 404, code: "not_found" };
  const page = conversation.page;
  if (page.status !== "ACTIVE" || !page.accessToken) {
    return { ok: false, status: 409, code: "page_unavailable" };
  }

  const policy = humanReplyPolicy(conversation.lastInboundAt);
  if (!policy.canReply) {
    return { ok: false, status: 409, code: policy.reason === "no_inbound" ? "no_inbound" : "window_closed" };
  }

  const row = await prisma.facebookMessage.create({
    data: {
      workspaceId,
      conversationId: conversation.id,
      direction: "OUTBOUND",
      author: "HUMAN",
      origin: "OPENREPLY",
      text,
      sendStatus: "PENDING",
      sentByUserId: userId,
    },
  });

  let result: SendResult;
  try {
    result = await sendMessage(page.pageId, pageToken(page), {
      psid: conversation.psid,
      text,
      metadata: messageMetadata(row.id),
      humanAgentTag: policy.humanAgentTag,
    });
  } catch (error) {
    return settleFailure(row.id, page.id, error);
  }

  const sentAt = new Date();
  let saved;
  try {
    saved = await prisma.facebookMessage.update({
      where: { id: row.id },
      data: { sendStatus: "SENT", mid: result.message_id ?? undefined, sentAt, error: null },
    });
  } catch (error) {
    // The echo got there first and saved the same message ID.
    if (!isUniqueViolation(error)) throw error;
    saved = await prisma.facebookMessage.update({
      where: { id: row.id },
      data: { sendStatus: "SENT", sentAt, error: null },
    });
  }
  await touchLastMessage(conversation.id, sentAt, messagePreview(text), "OUTBOUND");
  await prisma.facebookConversation.update({ where: { id: conversation.id }, data: { unreadCount: 0 } });
  // Whoever answers by hand takes the conversation: the bot must not talk
  // over them.
  await takeOverConversation(conversation.id, { reason: "INBOX_TAKEOVER", actorUserId: userId });
  return { ok: true, message: serializeMessage(saved) };
}

async function settleFailure(messageId: string, facebookPageId: string, error: unknown): Promise<HumanReplyResult> {
  const fbError =
    error instanceof FacebookApiError ? error : new FacebookApiError(errorText(error), "ambiguous");

  // The echo may have arrived first and proven delivery: never downgrade it.
  const settle = (sendStatus: "UNCONFIRMED" | "FAILED") =>
    prisma.facebookMessage.updateMany({
      where: { id: messageId, sendStatus: "PENDING" },
      data: { sendStatus, error: fbError.message },
    });

  if (fbError.kind === "ambiguous") {
    await settle("UNCONFIRMED");
    return { ok: false, status: 502, code: "unconfirmed", detail: fbError.message };
  }
  await settle("FAILED");
  switch (fbError.kind) {
    case "token_invalid":
      await prisma.facebookPage.update({
        where: { id: facebookPageId },
        data: { status: "TOKEN_INVALID", lastError: fbError.message },
      });
      return { ok: false, status: 409, code: "page_unavailable", detail: fbError.message };
    case "outside_window":
      return { ok: false, status: 409, code: "window_closed", detail: fbError.message };
    case "not_eligible":
      return { ok: false, status: 409, code: "not_eligible", detail: fbError.message };
    case "rate_limit":
      return { ok: false, status: 429, code: "rate_limited", detail: fbError.message };
    case "unreachable":
      return { ok: false, status: 502, code: "unreachable", detail: fbError.message };
    default:
      return { ok: false, status: 502, code: "failed", detail: fbError.message };
  }
}
