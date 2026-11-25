/**
 * Why a conversation was handed to a person. One list, in display order,
 * shared by the bot's classifier, the inbox badges and filters, alert
 * routing and the agency overview.
 */
import type { HandoffCategory } from "@/app/generated/prisma/client";

export const HANDOFF_CATEGORIES = [
  "WHOLESALE_ORDER",
  "CUSTOM_ORDER",
  "COMPLAINT",
  "NOT_IN_KB",
  "AUDIO_FAILED",
  "OTHER",
] as const satisfies readonly HandoffCategory[];

export function isHandoffCategory(value: unknown): value is HandoffCategory {
  return typeof value === "string" && (HANDOFF_CATEGORIES as readonly string[]).includes(value);
}

/** English source labels; lib/facebook/i18n translates them. */
export const HANDOFF_CATEGORY_LABELS = {
  WHOLESALE_ORDER: "Wholesale order",
  CUSTOM_ORDER: "Custom order",
  COMPLAINT: "Complaint",
  NOT_IN_KB: "Not in the knowledge base",
  AUDIO_FAILED: "Voice message not transcribed",
  OTHER: "Other",
} as const satisfies Record<HandoffCategory, string>;

/** Badge colours, as Tailwind classes on the existing palette. */
export const HANDOFF_CATEGORY_BADGE: Record<HandoffCategory, string> = {
  WHOLESALE_ORDER: "bg-success/10 text-success",
  CUSTOM_ORDER: "bg-accent/10 text-accent",
  COMPLAINT: "bg-error/10 text-error",
  NOT_IN_KB: "bg-warning/10 text-warning",
  AUDIO_FAILED: "bg-surface-hover text-muted",
  OTHER: "bg-surface-hover text-foreground",
};
