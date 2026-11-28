/**
 * Telling our own messages apart from a person replying on the Page.
 *
 * With message_echoes, Meta sends back every message the Page sends: the
 * bot's replies, campaign private replies, replies from the OpenReply inbox,
 * and replies a person types in Meta Business Suite or the Pages app. Only
 * the last kind means a human has taken the conversation over.
 *
 * Every message this app sends carries `message.metadata`, which Meta returns
 * in the echo. That is checked first because it works even when the echo
 * arrives before the worker has saved the message ID. The app ID and the
 * saved message ID back it up for messages sent without metadata.
 */

export const METADATA_PREFIX = "openreply:";
const COMMENT_PREFIX = `${METADATA_PREFIX}c:`;

/** Metadata for a Messenger message stored as FacebookMessage `id`. */
export function messageMetadata(messageId: string): string {
  return `${METADATA_PREFIX}${messageId}`;
}

/** Metadata for the private reply of FacebookCommentLog `id`. */
export function privateReplyMetadata(commentLogId: string): string {
  return `${COMMENT_PREFIX}${commentLogId}`;
}

export type OpenReplyReference =
  | { kind: "message"; id: string }
  | { kind: "comment"; id: string };

export function parseMetadata(metadata: string | undefined | null): OpenReplyReference | null {
  if (!metadata?.startsWith(METADATA_PREFIX)) return null;
  if (metadata.startsWith(COMMENT_PREFIX)) {
    const id = metadata.slice(COMMENT_PREFIX.length);
    return id ? { kind: "comment", id } : null;
  }
  const id = metadata.slice(METADATA_PREFIX.length);
  return id ? { kind: "message", id } : null;
}

export type EchoOrigin =
  | { origin: "ours"; via: "metadata"; reference: OpenReplyReference }
  | { origin: "ours"; via: "app_id" | "mid" }
  | { origin: "external" };

/**
 * Classify an echo. `midIsKnown` is whether the message ID is already saved
 * as one of our outbound messages.
 */
export function classifyEcho(
  echo: { appId?: string; metadata?: string; mid: string },
  { ourAppId, midIsKnown }: { ourAppId: string | null; midIsKnown: boolean }
): EchoOrigin {
  const reference = parseMetadata(echo.metadata);
  if (reference) return { origin: "ours", via: "metadata", reference };
  if (ourAppId && echo.appId && String(echo.appId) === String(ourAppId)) {
    return { origin: "ours", via: "app_id" };
  }
  if (midIsKnown) return { origin: "ours", via: "mid" };
  return { origin: "external" };
}
