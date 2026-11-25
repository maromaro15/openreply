/**
 * From what was read on a customer's photo to a product of the catalogue.
 *
 * Pure: the catalogue lookup is given (findByCodeKey bound to a workspace),
 * so this decides without a database. Only exact matches after normalisation
 * count, and any doubt becomes a question to the customer: a misread digit
 * must never turn into a confident price for the wrong colour.
 */
import type { ImageMatch, ImageReading } from "@/lib/ai/vision";
import { MAX_CODE_LENGTH, normalizeCode } from "./codes";
import type { CodeMatch } from "./products";

/** findByCodeKey bound to a workspace. */
export type CodeLookup = (codeKey: string) => Promise<CodeMatch[]>;

export type Recognition =
  | {
      kind: "match";
      via: "code" | "image";
      productId: string;
      productName: string;
      variant: { id: string; code: string; name: string | null } | null;
      codes: string[];
    }
  | {
      kind: "ambiguous";
      options: { productId: string; productName: string; variantCode: string | null; variantName: string | null }[];
      codes: string[];
    }
  | { kind: "unsure"; via: "image"; productId: string; productName: string; codes: string[] }
  | { kind: "none"; codes: string[]; description: string };

export const MAX_AMBIGUOUS_OPTIONS = 5;
const MAX_LOOKUPS = 20;

// ─── By code ────────────────────────────────────────────────────────────────

/**
 * The product the codes name. Each code is looked up by its normalised key;
 * keys of one character ("1", "A") are skipped, they match too much.
 *
 * - One product, with at most one of its colours: a match.
 * - Several products, or several colours of one: ambiguous (at most 5).
 * - Nothing: null.
 *
 * Colour numbers repeat from product to product, so when a product's own code
 * is also on the photo, a colour key that names that product and others is
 * taken for that product's colour only. A code naming only another product
 * still counts, and makes the answer ambiguous.
 */
export async function recognizeFromCodes(codes: string[], lookup: CodeLookup): Promise<Recognition | null> {
  const read = codes.filter((code): code is string => typeof code === "string");
  const keys: string[] = [];
  for (const code of read) {
    const key = normalizeCode(code);
    if (key.length < 2 || key.length > MAX_CODE_LENGTH || keys.includes(key)) continue;
    keys.push(key);
    if (keys.length >= MAX_LOOKUPS) break;
  }
  if (keys.length === 0) return null;

  const perKey = await Promise.all(keys.map((key) => lookup(key)));
  const byProductCode = new Set(perKey.flat().filter((match) => !match.variant).map((match) => match.productId));
  const matches = perKey.flatMap((found) => {
    if (byProductCode.size === 0) return found;
    const named = found.filter((match) => byProductCode.has(match.productId));
    return named.length > 0 ? named : found;
  });
  if (matches.length === 0) return null;

  // Distinct (product, colour) pairs, in order of first appearance. A product
  // matched by its own code adds nothing once one of its colours matched.
  const products = new Map<string, { name: string; variants: Map<string, NonNullable<CodeMatch["variant"]>> }>();
  for (const match of matches) {
    let entry = products.get(match.productId);
    if (!entry) {
      entry = { name: match.name, variants: new Map() };
      products.set(match.productId, entry);
    }
    if (match.variant && !entry.variants.has(match.variant.id)) entry.variants.set(match.variant.id, match.variant);
  }

  const codesRead = [...read];
  if (products.size === 1) {
    const [[productId, entry]] = [...products];
    if (entry.variants.size <= 1) {
      const [variant] = [...entry.variants.values()];
      return {
        kind: "match",
        via: "code",
        productId,
        productName: entry.name,
        variant: variant ? { id: variant.id, code: variant.code, name: variant.name } : null,
        codes: codesRead,
      };
    }
  }

  const options: Extract<Recognition, { kind: "ambiguous" }>["options"] = [];
  for (const [productId, entry] of products) {
    if (entry.variants.size === 0) {
      options.push({ productId, productName: entry.name, variantCode: null, variantName: null });
    }
    for (const variant of entry.variants.values()) {
      options.push({ productId, productName: entry.name, variantCode: variant.code, variantName: variant.name });
    }
  }
  return { kind: "ambiguous", options: options.slice(0, MAX_AMBIGUOUS_OPTIONS), codes: codesRead };
}

// ─── By image ───────────────────────────────────────────────────────────────

/** Lower case, without accents, Arabic diacritics or tatweel, one spelling for alef, taa marbuta and alef maqsura. */
function fold(text: string): string {
  return text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\p{M}\p{Cf}ـ]/gu, "")
    .replace(/[ٱأإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/[ىی]/g, "ي");
}

// Words of a description that say nothing about the product.
const STOP_WORDS = new Set(["a", "an", "and", "the", "of", "with", "in", "on", "for", "or", "to", "its", "is"]);

/** The distinct words of a text, folded; Latin plurals as their singular ("curtains" → "curtain"). */
function words(text: string): Set<string> {
  const found = new Set<string>();
  for (const [word] of fold(text).matchAll(/[\p{L}\p{N}]+/gu)) {
    if (STOP_WORDS.has(word)) continue;
    found.add(/^[a-z]{4,}s$/.test(word) && !word.endsWith("ss") ? word.slice(0, -1) : word);
  }
  return found;
}

/**
 * The ids of the products whose text shares the most words with the
 * description, best first, at most max. Ties keep the given order, so
 * products sharing no word still fill the list when there is room.
 */
export function pickCandidates(description: string, products: { id: string; text: string }[], max: number): string[] {
  const limit = Math.floor(max);
  if (!(limit > 0)) return [];
  const wanted = words(description);
  const seen = new Set<string>();
  const scored: { id: string; score: number; index: number }[] = [];
  products.forEach((product, index) => {
    if (seen.has(product.id)) return;
    seen.add(product.id);
    const have = words(product.text);
    let score = 0;
    for (const word of wanted) if (have.has(word)) score += 1;
    scored.push({ id: product.id, score, index });
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.slice(0, limit).map((entry) => entry.id);
}

/** The image match as a recognition: sure → match, probable → unsure (ask), else none. */
export function recognitionFromImageMatch(
  match: ImageMatch,
  candidates: { id: string; name: string }[],
  reading: ImageReading
): Recognition {
  const candidate = match.candidateId === null ? undefined : candidates.find((entry) => entry.id === match.candidateId);
  const codes = [...reading.codes];
  if (candidate && match.confidence === "high") {
    return { kind: "match", via: "image", productId: candidate.id, productName: candidate.name, variant: null, codes };
  }
  if (candidate && match.confidence === "medium") {
    return { kind: "unsure", via: "image", productId: candidate.id, productName: candidate.name, codes };
  }
  return { kind: "none", codes, description: reading.description };
}

// ─── For the bot's prompt ───────────────────────────────────────────────────

const MAX_QUOTED = 80;
// Line breaks, control characters, bidi overrides: a value stays on its line.
const NOT_ON_A_LINE = /[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]+/gu;

/** A catalogue value inside «»: one line, bounded, and unable to close its quotes. */
function quoted(value: string): string {
  const line = value.replace(NOT_ON_A_LINE, " ").replace(/[«»]/g, '"').replace(/\s+/g, " ").trim();
  const chars = Array.from(line);
  const text = chars.length > MAX_QUOTED ? `${chars.slice(0, MAX_QUOTED - 1).join("").trimEnd()}…` : line;
  return `«${text || "?"}»`;
}

function colourOf(code: string | null, name: string | null): string {
  return [code, name].filter((part): part is string => !!part && part.trim() !== "").join(" ");
}

function joinOr(items: string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}

/** One English line for the bot's prompt. Every catalogue value is quoted, so no digit stands outside «». */
export function recognitionPromptLine(recognition: Recognition): string {
  switch (recognition.kind) {
    case "match": {
      const colour = recognition.variant ? colourOf(recognition.variant.code, recognition.variant.name) : "";
      return `The customer's photo shows the product ${quoted(recognition.productName)}${colour ? ` (colour ${quoted(colour)})` : ""}.`;
    }
    case "ambiguous": {
      const options = recognition.options.map((option) => {
        const colour = colourOf(option.variantCode, option.variantName);
        return quoted(colour ? `${option.productName}, colour ${colour}` : option.productName);
      });
      return `The customer's photo could be ${joinOr(options)}: ask which one before answering.`;
    }
    case "unsure":
      return `The customer's photo may show ${quoted(recognition.productName)}, but it is not certain: ask the customer to confirm.`;
    case "none":
      return "The product in the customer's photo was not recognised: ask for its name or code, or hand off.";
  }
}
