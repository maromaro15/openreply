/**
 * Brand voice: which examples the bot sees for this conversation, and the
 * dictionary applied to what it wrote. Pure functions, no database.
 */
import type { VoiceForPrompt } from "./format";

export interface VoiceExampleRow {
  customer: string;
  reply: string;
  /** The brand's own, as opposed to the global set: preferred when as relevant. */
  brand: boolean;
}

export const VOICE_PROMPT_EXAMPLES = 6;
const VOICE_PROMPT_CHARS = 3000;

/** Arabic and Latin text, folded so that spelling variants meet: أ/إ/آ → ا, ة → ه, ى → ي, no tashkeel. */
export function foldText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي");
}

function tokens(value: string): Set<string> {
  const words = foldText(value)
    .split(/[^\p{L}\p{N}]+/u)
    .map((word) => (word.length > 4 && word.startsWith("وال") ? word.slice(3) : word))
    .map((word) => (word.length > 3 && word.startsWith("ال") ? word.slice(2) : word))
    .filter((word) => word.length >= 2);
  return new Set(words);
}

function relevance(query: Set<string>, example: Set<string>): number {
  if (query.size === 0 || example.size === 0) return 0;
  let shared = 0;
  for (const word of example) if (query.has(word)) shared += 1;
  return shared / Math.sqrt(example.size);
}

/**
 * The examples most like what the customer just wrote, the brand's first on
 * a tie; then, to show the voice anyway, the brand's and the global ones in
 * order, up to the count and a size bound.
 */
export function pickExamples(
  examples: VoiceExampleRow[],
  customerTexts: string[],
  count = VOICE_PROMPT_EXAMPLES
): VoiceForPrompt["examples"] {
  const query = tokens(customerTexts.slice(-3).join(" "));
  const scored = examples
    .map((example, index) => ({
      example,
      index,
      score: relevance(query, tokens(example.customer)) + (example.brand ? 0.01 : 0),
    }))
    .sort((a, b) => b.score - a.score || Number(b.example.brand) - Number(a.example.brand) || a.index - b.index);
  const picked: VoiceForPrompt["examples"] = [];
  let size = 0;
  for (const { example } of scored) {
    if (picked.length >= count) break;
    const length = example.customer.length + example.reply.length;
    if (size + length > VOICE_PROMPT_CHARS) continue;
    size += length;
    picked.push({ customer: example.customer, reply: example.reply });
  }
  return picked;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The wrong phrase as a pattern: any alef, ة/ه and ى/ي spelling, any spacing, a whole phrase only. */
function phrasePattern(wrong: string): RegExp | null {
  const folded = foldText(wrong).trim();
  if (!folded) return null;
  const body = [...folded]
    .map((char) => {
      if (char === "ا") return "[اأإآٱ]";
      if (char === "ه") return "[هة]";
      if (char === "ي") return "[يى]";
      if (/\s/.test(char)) return "\\s+";
      return escapeRegExp(char);
    })
    .join("")
    .replace(/(\\s\+)+/g, "\\s+");
  // A leading «و» ("and") stays glued to the replacement, as it was written.
  return new RegExp(`(?<![\\p{L}\\p{N}])(و?)${body}(?![\\p{L}\\p{N}])`, "giu");
}

/** The reply with every known mistake replaced by its first right phrase. */
export function applyCorrections(reply: string, corrections: VoiceForPrompt["corrections"]): string {
  let result = reply;
  // Longest first, so "انهي لون تحب" wins over "انهي لون".
  const ordered = [...corrections].sort((a, b) => b.wrong.length - a.wrong.length);
  for (const correction of ordered) {
    const right = correction.right[0];
    const pattern = phrasePattern(correction.wrong);
    if (!right || !pattern) continue;
    result = result.replace(pattern, (_match, and: string) => `${and}${right}`);
  }
  return result;
}

/**
 * Digits in an example are some customer's facts (a price, a phone): never
 * shown to the bot. A lone digit inside a Latin word is a letter of
 * Arabizi ("mar7ba", "3andek") and stays.
 */
export function maskFacts(value: string): string {
  return value.replace(/[\d\u0660-\u0669\u06F0-\u06F9]+(?:[.,\s]?[\d\u0660-\u0669\u06F0-\u06F9]+)*/g, (digits, offset: number) => {
    const glued = /\p{L}/u.test(value[offset - 1] ?? "") || /\p{L}/u.test(value[offset + digits.length] ?? "");
    return glued && /^\d$/.test(digits) ? digits : "…";
  });
}

/** One line per value, as every brand value in the prompt: it can never open a section. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** The "HOW THIS SHOP TALKS" section, or "" when there is nothing to show. */
export function voicePromptSection(voice: VoiceForPrompt | undefined): string {
  if (!voice || (voice.examples.length === 0 && voice.corrections.length === 0)) return "";
  const lines = ["## HOW THIS SHOP TALKS"];
  if (voice.examples.length > 0) {
    lines.push(
      "Real exchanges from this shop. Copy their wording, tone and length; never take a fact from them (prices, colours, sizes, places, delays and policies come only from the knowledge base and the catalog; «…» marks where such a fact was):"
    );
    for (const example of voice.examples) {
      lines.push(`- Customer: «${oneLine(maskFacts(example.customer))}» → Shop: «${oneLine(maskFacts(example.reply))}»`);
    }
  }
  if (voice.corrections.length > 0) {
    lines.push("Words this shop never uses, and what it says instead:");
    for (const correction of voice.corrections) {
      lines.push(`- Never «${oneLine(correction.wrong)}»; say ${correction.right.map((right) => `«${oneLine(right)}»`).join(" or ")}.`);
    }
  }
  return lines.join("\n");
}
