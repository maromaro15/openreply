/**
 * Why a reply from the inbox did not go out. Shared by the API (English
 * text) and the inbox (translated), so it holds no server code.
 */
import type { FbStaticKey } from "./i18n";

export const HUMAN_REPLY_ERRORS = {
  not_found: "Conversation not found.",
  page_unavailable: "This Page cannot send messages: reconnect it in Facebook Pages.",
  no_inbound: "This person has not written to the Page yet. Messenger only allows a reply once they do.",
  window_closed:
    "The 24-hour window is closed. Messenger only allows a reply within 24 hours of the person's last message.",
  not_eligible: "This person cannot receive messages from the Page.",
  rate_limited: "Facebook is limiting messages from this Page. Try again in a minute.",
  unreachable: "Could not reach Facebook. The message was not sent.",
  unconfirmed: "Facebook did not confirm the message. Check Messenger before sending it again.",
  failed: "Facebook refused the message.",
} as const satisfies Record<string, FbStaticKey>;

export type HumanReplyError = keyof typeof HUMAN_REPLY_ERRORS;

export function isHumanReplyError(value: unknown): value is HumanReplyError {
  return typeof value === "string" && value in HUMAN_REPLY_ERRORS;
}
