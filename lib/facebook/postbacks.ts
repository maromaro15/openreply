/**
 * Messenger postbacks: the «نحب هذا» button on a product or colour card.
 *
 * The button carries a payload we wrote, but it comes back through a public
 * webhook, so it is untrusted: decoding is strict and parsing never throws.
 * Pure functions only, so the webhook route stays a thin shell.
 */
import { createHash } from "node:crypto";

export type PostbackAction = { kind: "like"; productId: string; variantCode: string | null };

/** Messenger rejects a postback payload longer than this. */
const MAX_PAYLOAD = 1000;
const MAX_TITLE = 80;
// A version prefix lets a later payload format coexist with cards already sent.
const VERSION = "or1";
const SEP = "|";
const ESC = "\\";

function escapePart(value: string): string {
  return value.replace(/[\\|]/g, (char) => ESC + char);
}

/** Split on unescaped separators; null when an escape is invalid or dangling. */
function splitPayload(payload: string): string[] | null {
  const parts: string[] = [];
  let current = "";
  for (let i = 0; i < payload.length; i++) {
    const char = payload[i];
    if (char === ESC) {
      const next = payload[i + 1];
      if (next !== ESC && next !== SEP) return null;
      current += next;
      i++;
    } else if (char === SEP) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

/**
 * Build the payload of a «نحب هذا» button. A null (or empty) variant code
 * means the product itself. Throws when the result cannot fit Messenger's
 * limit: cutting an id or a code would point the click at the wrong thing.
 */
export function encodeLikePayload(productId: string, variantCode: string | null): string {
  if (!productId) throw new Error("productId is required");
  const parts = [VERSION, "like", escapePart(productId)];
  if (variantCode) parts.push(escapePart(variantCode));
  const payload = parts.join(SEP);
  if (payload.length > MAX_PAYLOAD) throw new RangeError("postback payload is too long");
  return payload;
}

/** Strict decode: any unknown version, kind or shape gives null. Never throws. */
export function decodePostbackPayload(payload: unknown): PostbackAction | null {
  if (typeof payload !== "string" || payload.length === 0 || payload.length > MAX_PAYLOAD) {
    return null;
  }
  const parts = splitPayload(payload);
  if (!parts || parts[0] !== VERSION || parts[1] !== "like") return null;
  if (parts.length !== 3 && parts.length !== 4) return null;
  const productId = parts[2];
  if (!productId) return null;
  // A 4th part must carry a code: the encoder never writes an empty one.
  if (parts.length === 4 && !parts[3]) return null;
  return { kind: "like", productId, variantCode: parts.length === 4 ? parts[3] : null };
}

// ─── Webhook parsing ────────────────────────────────────────────────────────

export interface PostbackEvent {
  pageId: string;
  psid: string;
  title: string;
  payload: string;
  mid: string | null;
  timestamp: number;
  referral: unknown | null;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asId(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return undefined;
}

/** Cut to a length without leaving half of a surrogate pair at the end. */
function cut(value: string, max: number): string {
  if (value.length <= max) return value;
  let end = max;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return value.slice(0, end);
}

/**
 * Postback events of a Page webhook body. Only `entry[].messaging[]` is read:
 * `standby` (another app has the thread), echoes, messages, reads and
 * deliveries are not postbacks and are ignored. Malformed parts are skipped.
 */
export function parsePostbackEvents(body: unknown): PostbackEvent[] {
  const events: PostbackEvent[] = [];
  if (!isObject(body) || body.object !== "page" || !Array.isArray(body.entry)) return events;

  for (const entry of body.entry) {
    if (!isObject(entry) || !Array.isArray(entry.messaging)) continue;
    const pageId = asId(entry.id);
    if (!pageId) continue;

    for (const event of entry.messaging) {
      if (!isObject(event) || !isObject(event.postback)) continue;
      const postback = event.postback;
      const psid = asId(isObject(event.sender) ? event.sender.id : undefined);
      if (!psid || psid === pageId) continue;
      if (typeof postback.payload !== "string" || postback.payload.length === 0) continue;

      // One line: the title is shown in the inbox.
      const title = cut(
        (typeof postback.title === "string" ? postback.title : "").replace(/\s+/g, " ").trim(),
        MAX_TITLE
      );
      events.push({
        pageId,
        psid,
        title,
        payload: cut(postback.payload, MAX_PAYLOAD),
        mid: asId(postback.mid) ?? null,
        // 0 when missing, so the fallback dedupe key still repeats on a retry.
        timestamp:
          typeof event.timestamp === "number" && Number.isFinite(event.timestamp)
            ? event.timestamp
            : 0,
        referral: isObject(postback.referral) ? postback.referral : null,
      });
    }
  }
  return events;
}

/**
 * Key that stays the same when Meta redelivers the webhook: the mid when
 * there is one, else a hash of what identifies the click.
 */
export function postbackDedupeKey(event: PostbackEvent): string {
  if (event.mid) return event.mid;
  const digest = createHash("sha256")
    .update(JSON.stringify([event.pageId, event.psid, event.timestamp, event.payload]))
    .digest("hex");
  return `pb_${digest.slice(0, 32)}`;
}
