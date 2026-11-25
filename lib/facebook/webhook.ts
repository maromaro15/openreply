/**
 * Page webhooks: signature check and parsing.
 *
 * Everything here is pure, so the route stays a thin shell and the rules
 * (which comments count, what an echo is) are tested without a server.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { getFacebookAppSecret } from "./env";

export type SignatureCheck =
  | { ok: true }
  | { ok: false; reason: "missing_secret" | "missing_header" | "malformed" | "mismatch" };

/**
 * X-Hub-Signature-256 is an HMAC-SHA256 of the request body exactly as sent.
 * It must be computed over the raw bytes: re-serialising the parsed JSON can
 * change the escaping of non-ASCII text (Arabic comments, emoji) and break the
 * match.
 */
export function verifyPageSignature(
  rawBody: Uint8Array | string,
  header: string | null,
  secret: string | null = getFacebookAppSecret()
): SignatureCheck {
  if (!secret) return { ok: false, reason: "missing_secret" };
  if (!header) return { ok: false, reason: "missing_header" };

  const match = /^sha256=([a-f0-9]{64})$/i.exec(header.trim());
  if (!match) return { ok: false, reason: "malformed" };

  const body = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : Buffer.from(rawBody);
  const expected = createHmac("sha256", secret).update(body).digest();
  const received = Buffer.from(match[1].toLowerCase(), "hex");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    return { ok: false, reason: "mismatch" };
  }
  return { ok: true };
}

// ─── Parsed events ──────────────────────────────────────────────────────────

/** A new comment on a Page post, by someone other than the Page. */
export interface PageCommentEvent {
  pageId: string;
  commentId: string;
  postId: string;
  /** The comment this one replies to, when it is a reply. */
  parentId?: string;
  commenterId?: string;
  commenterName?: string;
  text: string;
  createdAt: Date;
}

export interface MessageAttachment {
  type: string;
  url?: string;
  stickerId?: string;
}

/** A message a person sent to the Page. */
export interface PageMessageEvent {
  pageId: string;
  psid: string;
  mid: string;
  text?: string;
  attachments: MessageAttachment[];
  /** A sticker or the "like" thumb: nothing to answer. */
  isSticker: boolean;
  replyToMid?: string;
  sentAt: Date;
}

/** A message the Page sent, delivered back through message_echoes. */
export interface PageEchoEvent {
  pageId: string;
  /** The person the Page wrote to. */
  psid: string;
  mid: string;
  appId?: string;
  metadata?: string;
  text?: string;
  attachments: MessageAttachment[];
  sentAt: Date;
}

export interface ParsedPageWebhook {
  /** Page IDs present in the payload, in order, without duplicates. */
  pageIds: string[];
  comments: PageCommentEvent[];
  messages: PageMessageEvent[];
  echoes: PageEchoEvent[];
}

// ─── Parsing helpers ────────────────────────────────────────────────────────

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  // IDs sometimes arrive as numbers (app_id in echoes). Large IDs are only
  // safe as strings, so a number is kept only when it is exact.
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Feed timestamps are Unix seconds; Messenger timestamps are milliseconds. */
function feedTime(value: unknown): Date {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value < 1e12 ? value * 1000 : value);
  }
  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && value.trim() !== "") {
      return new Date(numeric < 1e12 ? numeric * 1000 : numeric);
    }
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return new Date(parsed);
  }
  return new Date();
}

function messengerTime(value: unknown): Date {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value) : new Date();
}

function parseAttachments(message: Json): MessageAttachment[] {
  return asArray(message.attachments)
    .filter(isObject)
    .map((attachment) => {
      const payload = isObject(attachment.payload) ? attachment.payload : {};
      return {
        type: asString(attachment.type) ?? "unknown",
        url: asString(payload.url),
        stickerId: asString(payload.sticker_id),
      };
    });
}

function parseComment(pageId: string, value: Json): PageCommentEvent | null {
  if (value.item !== "comment" || value.verb !== "add") return null;

  const commentId = asString(value.comment_id);
  const postId = asString(value.post_id);
  if (!commentId || !postId) return null;

  const from = isObject(value.from) ? value.from : {};
  const commenterId = asString(from.id);
  // The Page's own comments, including our public replies, never trigger.
  if (commenterId === pageId) return null;

  const parentId = asString(value.parent_id);
  return {
    pageId,
    commentId,
    postId,
    // A top-level comment's parent is the post itself.
    ...(parentId && parentId !== postId ? { parentId } : {}),
    ...(commenterId ? { commenterId } : {}),
    ...(asString(from.name) ? { commenterName: asString(from.name) } : {}),
    text: typeof value.message === "string" ? value.message : "",
    createdAt: feedTime(value.created_time),
  };
}

/**
 * Parse a Page webhook body. Anything malformed or irrelevant is skipped
 * rather than thrown: one bad entry must not cost the others.
 */
export function parsePageWebhook(payload: unknown): ParsedPageWebhook {
  const result: ParsedPageWebhook = { pageIds: [], comments: [], messages: [], echoes: [] };
  if (!isObject(payload) || payload.object !== "page") return result;

  const seenPages = new Set<string>();
  for (const entry of asArray(payload.entry).filter(isObject)) {
    const pageId = asString(entry.id);
    if (!pageId) continue;
    if (!seenPages.has(pageId)) {
      seenPages.add(pageId);
      result.pageIds.push(pageId);
    }

    for (const change of asArray(entry.changes).filter(isObject)) {
      if (change.field !== "feed" || !isObject(change.value)) continue;
      const comment = parseComment(pageId, change.value);
      if (comment) result.comments.push(comment);
    }

    for (const event of asArray(entry.messaging).filter(isObject)) {
      const message = isObject(event.message) ? event.message : null;
      if (!message) continue; // reads, deliveries, postbacks, reactions
      const mid = asString(message.mid);
      if (!mid) continue;

      const senderId = asString(isObject(event.sender) ? event.sender.id : undefined);
      const recipientId = asString(isObject(event.recipient) ? event.recipient.id : undefined);
      const text = typeof message.text === "string" && message.text.trim() ? message.text : undefined;
      const attachments = parseAttachments(message);
      const sentAt = messengerTime(event.timestamp);

      if (message.is_echo === true) {
        // An echo is a message the Page sent: the recipient is the person.
        if (!recipientId || recipientId === pageId) continue;
        result.echoes.push({
          pageId,
          psid: recipientId,
          mid,
          ...(asString(message.app_id) ? { appId: asString(message.app_id) } : {}),
          ...(typeof message.metadata === "string" ? { metadata: message.metadata } : {}),
          ...(text ? { text } : {}),
          attachments,
          sentAt,
        });
        continue;
      }

      if (message.is_deleted === true || message.is_unsupported === true) continue;
      if (!senderId || senderId === pageId) continue;

      const replyTo = isObject(message.reply_to) ? asString(message.reply_to.mid) : undefined;
      result.messages.push({
        pageId,
        psid: senderId,
        mid,
        ...(text ? { text } : {}),
        attachments,
        isSticker:
          asString(message.sticker_id) !== undefined ||
          attachments.some((attachment) => attachment.stickerId !== undefined),
        ...(replyTo ? { replyToMid: replyTo } : {}),
        sentAt,
      });
    }
  }
  return result;
}
