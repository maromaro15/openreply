/**
 * Brand voice: the portable data format.
 *
 * A VoicePack is plain JSON, the same shape whether it is exported from a
 * brand, imported into another, or synced with another tool (Creative OS):
 * examples of real sales exchanges, and a dictionary of known mistakes.
 * Nothing in it refers to this app's database (no workspace or message IDs),
 * so a pack moves anywhere as it is.
 *
 * {
 *   "format": "amitec.voice", "version": 1, "scope": "brand",
 *   "examples":    [{ "customer": "…", "reply": "…", "source": "manual", "active": true }],
 *   "corrections": [{ "wrong": "انهي لون", "right": ["واش من لون"], "source": "seed", "active": true }]
 * }
 */
import { z } from "zod";

export const VOICE_PACK_FORMAT = "amitec.voice";
export const VOICE_PACK_VERSION = 1;

export const VOICE_LIMITS = {
  customer: 500,
  reply: 1000,
  phrase: 120,
  rights: 5,
  /** Per brand, and for the global set. */
  examples: 300,
  corrections: 300,
} as const;

export const VOICE_SOURCES = ["seed", "manual", "human_reply", "inbox_correction", "import"] as const;
export type VoiceSourceValue = (typeof VOICE_SOURCES)[number];

const text = (max: number, empty: string, long: string) => z.string().trim().min(1, empty).max(max, long);

export const voiceExampleSchema = z.object({
  customer: text(VOICE_LIMITS.customer, "Write what the customer said.", "The customer's message is too long."),
  reply: text(VOICE_LIMITS.reply, "Write the reply.", "The reply is too long."),
  source: z.enum(VOICE_SOURCES).default("manual"),
  active: z.boolean().default(true),
});

export const voiceCorrectionSchema = z.object({
  wrong: text(VOICE_LIMITS.phrase, "Write the wrong phrase.", "The phrase is too long."),
  right: z
    .array(text(VOICE_LIMITS.phrase, "Write the right phrase.", "The phrase is too long."))
    .min(1, "Write at least one right phrase.")
    .max(VOICE_LIMITS.rights, "At most 5 right phrases."),
  source: z.enum(VOICE_SOURCES).default("manual"),
  active: z.boolean().default(true),
});

export type VoiceExampleData = z.infer<typeof voiceExampleSchema>;
export type VoiceCorrectionData = z.infer<typeof voiceCorrectionSchema>;

export const voicePackSchema = z.object({
  format: z.literal(VOICE_PACK_FORMAT),
  version: z.literal(VOICE_PACK_VERSION),
  scope: z.enum(["global", "brand"]).default("brand"),
  examples: z.array(voiceExampleSchema).max(VOICE_LIMITS.examples).default([]),
  corrections: z.array(voiceCorrectionSchema).max(VOICE_LIMITS.corrections).default([]),
});

export type VoicePack = z.infer<typeof voicePackSchema>;

export function voicePack(
  scope: VoicePack["scope"],
  examples: VoiceExampleData[],
  corrections: VoiceCorrectionData[]
): VoicePack {
  return { format: VOICE_PACK_FORMAT, version: VOICE_PACK_VERSION, scope, examples, corrections };
}

/** One phrase per line (or "|"-separated) → the phrases, trimmed, without repeats. */
export function splitPhrases(value: string): string[] {
  return [...new Set(value.split(/[\n|]+/).map((part) => part.trim()).filter(Boolean))];
}

/** What the bot gets: the examples picked for this conversation, and the whole dictionary. */
export interface VoiceForPrompt {
  examples: { customer: string; reply: string }[];
  corrections: { wrong: string; right: string[] }[];
}
