/**
 * From the model's JSON to one decision: answer, or hand the conversation
 * to a person with a category. The model proposes, the code decides: an
 * answer only goes out when it is well formed and passes the guard.
 */
import { z } from "zod";
import type { HandoffCategory } from "@/app/generated/prisma/client";
import { checkReply, type GuardSources } from "./guard";
import { CUSTOMER_STATES, type CustomerStateValue } from "./persona";

/** What the model may choose. AUDIO_FAILED is set by the code alone. */
export const MODEL_CATEGORIES = ["WHOLESALE_ORDER", "CUSTOM_ORDER", "COMPLAINT", "NOT_IN_KB", "OTHER", "NONE"] as const;

export const SYSTEM_REASONS = {
  invalidAnswer: "The AI answer could not be read.",
  attachment: "The customer sent an image, a video or a file.",
  audio: "The voice message could not be transcribed.",
  aiMissing: "The AI service is not configured (GOOGLE_API_KEY).",
  aiUnavailable: "The AI service did not answer.",
  aiBlocked: "The AI service refused to answer this message.",
  tooManyReplies: "More than 20 automatic replies in an hour.",
  facebookUnreachable: "The bot could not reach Facebook to answer.",
  tokenInvalid: "The Page's access token is no longer valid.",
  noReason: "The bot did not give a reason.",
  orderReady: "The customer gave every detail of the order.",
  readyToBuy: "The customer wants to order.",
} as const;

export type BotDecision =
  | { kind: "reply"; text: string }
  | {
      kind: "handoff";
      category: HandoffCategory;
      reason: string;
      /** Who decided: the model, the guard on its answer, or the code. */
      source: "model" | "guard" | "system";
      detail?: string;
    };

const modelOutput = z.object({
  handoff: z.boolean(),
  category: z.string(),
  reason: z.string().optional().default(""),
  reply: z.string().optional().default(""),
});

function handoffCategory(value: string): HandoffCategory {
  return (MODEL_CATEGORIES as readonly string[]).includes(value) && value !== "NONE"
    ? (value as HandoffCategory)
    : "OTHER";
}

/**
 * What the model read of the customer, whatever it decided: their state and
 * the order details they gave. Lenient: an unknown state is null and a
 * malformed order is ignored, so neither can cost an answer.
 */
export function readCustomer(output: unknown): { customerState: CustomerStateValue | null; order: Record<string, unknown> | null } {
  if (!output || typeof output !== "object" || Array.isArray(output)) return { customerState: null, order: null };
  const { customer_state: state, order } = output as Record<string, unknown>;
  return {
    customerState:
      typeof state === "string" && (CUSTOMER_STATES as readonly string[]).includes(state) ? (state as CustomerStateValue) : null,
    order: order && typeof order === "object" && !Array.isArray(order) ? (order as Record<string, unknown>) : null,
  };
}

/** `sources`: see guardSources in ./prompt.ts; a plain list is the shop's words only. */
export function decide(output: unknown, sources: GuardSources | string[]): BotDecision {
  const parsed = modelOutput.safeParse(output);
  if (!parsed.success) {
    return { kind: "handoff", category: "OTHER", reason: SYSTEM_REASONS.invalidAnswer, source: "system" };
  }
  const { handoff, category, reason, reply } = parsed.data;
  const reasonText = reason.trim().slice(0, 300);

  // A category without "handoff" is a contradiction: the safe reading wins.
  if (handoff || category !== "NONE") {
    return {
      kind: "handoff",
      category: handoffCategory(category),
      reason: reasonText || SYSTEM_REASONS.noReason,
      source: "model",
    };
  }

  const violation = checkReply(reply, sources);
  if (violation) {
    return {
      kind: "handoff",
      category: violation.category,
      reason: violation.reason,
      source: "guard",
      ...(violation.detail ? { detail: violation.detail } : {}),
    };
  }
  return { kind: "reply", text: reply.trim() };
}
