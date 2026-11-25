/**
 * From the model's JSON to one decision: answer, or hand the conversation
 * to a person with a category. The model proposes, the code decides: an
 * answer only goes out when it is well formed and passes the guard.
 */
import { z } from "zod";
import type { HandoffCategory } from "@/app/generated/prisma/client";
import { checkReply } from "./guard";

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

export function decide(output: unknown, referenceTexts: string[]): BotDecision {
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

  const violation = checkReply(reply, referenceTexts);
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
