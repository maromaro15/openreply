/**
 * Meta's messaging windows.
 *
 * A Page may write to a person within 24 hours of that person's last message
 * (the standard messaging window). The HUMAN_AGENT tag stretches this to 7
 * days for replies typed by a person, but only for apps Meta approved for it,
 * so it stays off unless FACEBOOK_HUMAN_AGENT_TAG is set.
 *
 * A private reply to a comment does not open the window: only the person
 * writing to the Page does.
 */
import { isHumanAgentTagEnabled } from "./env";

export const STANDARD_WINDOW_MS = 24 * 60 * 60 * 1000;
export const HUMAN_AGENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** The bot stops short of the deadline: a reply prepared at 23:59 lands after it. */
export const BOT_WINDOW_MARGIN_MS = 5 * 60 * 1000;
/** A person pressing "send" needs less room than the bot. */
export const HUMAN_WINDOW_MARGIN_MS = 60 * 1000;

export function standardWindowEndsAt(lastInboundAt: Date | null): Date | null {
  return lastInboundAt ? new Date(lastInboundAt.getTime() + STANDARD_WINDOW_MS) : null;
}

/** Whether the bot may still answer: the window is open, with its margin. */
export function isBotWindowOpen(lastInboundAt: Date | null, now = Date.now()): boolean {
  return Boolean(lastInboundAt) && now < lastInboundAt!.getTime() + STANDARD_WINDOW_MS - BOT_WINDOW_MARGIN_MS;
}

export type HumanReplyPolicy =
  | { canReply: true; humanAgentTag: boolean; endsAt: Date }
  | { canReply: false; reason: "no_inbound" | "closed"; endsAt: Date | null };

/** Whether a person can reply from the inbox now, and how. */
export function humanReplyPolicy(
  lastInboundAt: Date | null,
  { now = Date.now(), humanAgentTag = isHumanAgentTagEnabled() }: { now?: number; humanAgentTag?: boolean } = {}
): HumanReplyPolicy {
  if (!lastInboundAt) return { canReply: false, reason: "no_inbound", endsAt: null };
  const standardEnd = lastInboundAt.getTime() + STANDARD_WINDOW_MS;
  if (now < standardEnd - HUMAN_WINDOW_MARGIN_MS) {
    return { canReply: true, humanAgentTag: false, endsAt: new Date(standardEnd) };
  }
  const tagEnd = lastInboundAt.getTime() + HUMAN_AGENT_WINDOW_MS;
  if (humanAgentTag && now < tagEnd - HUMAN_WINDOW_MARGIN_MS) {
    return { canReply: true, humanAgentTag: true, endsAt: new Date(tagEnd) };
  }
  return { canReply: false, reason: "closed", endsAt: new Date(humanAgentTag ? tagEnd : standardEnd) };
}
