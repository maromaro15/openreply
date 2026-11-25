/**
 * The code check on every reply the model writes, before anything is sent.
 *
 * The model is told to quote prices exactly; this makes sure it did. Every
 * number in the reply must already be in the knowledge base or the
 * conversation, however it is written: "4500", "4 500", "4.500" and
 * "٤٥٠٠" are the same number. Amounts in words ("ألفين", "deux mille") and
 * links get the same treatment. Anything new means a person must answer.
 */

export type GuardCategory = "NOT_IN_KB" | "OTHER";

export interface GuardViolation {
  category: GuardCategory;
  /** A fixed English sentence: lib/facebook/i18n translates it. */
  reason: GuardReason;
  /** What tripped the check, for logs only. */
  detail?: string;
}

export const GUARD_REASONS = {
  emptyOrLong: "The AI answer was empty or too long.",
  number: "The reply contained a number that is not in the knowledge base.",
  amount: "The reply mentioned an amount that is not in the knowledge base.",
  link: "The reply contained a link that is not in the knowledge base.",
} as const;

export type GuardReason = (typeof GUARD_REASONS)[keyof typeof GUARD_REASONS];

/** Messenger takes 2000 characters; a shop's answer needs far fewer. */
export const MAX_REPLY_CHARS = 1200;

const DIGIT_BLOCKS = [0x0660, 0x06f0, 0x07c0, 0x0966, 0x09e6, 0xff10];

/** Arabic-Indic, Persian and other decimal digits become 0-9. */
export function normalizeDigits(text: string): string {
  return text.replace(/\p{Nd}/gu, (digit) => {
    const code = digit.codePointAt(0)!;
    for (const base of DIGIT_BLOCKS) {
      if (code >= base && code <= base + 9) return String(code - base);
    }
    return digit;
  });
}

// A run is digits joined by single separators: "4 500", "0555 12 34 56",
// "1.500,00". Inside a run, a group of exactly three digits continues the
// number before it (a thousands separator); any other group starts a new
// number. Both the reply and the reference are read this way, so they agree.
const RUN = /\d+(?:[   .,'’]\d+)*/g;
const SEPARATOR = /[   .,'’]/;

interface NumberRun {
  /** All the digits of the run, as written: "0555123456". */
  full: string;
  /** The numbers inside it: "4 500" is one, "38,40" is two. */
  tokens: string[];
}

export function numberRuns(text: string): NumberRun[] {
  const runs: NumberRun[] = [];
  for (const match of normalizeDigits(text).matchAll(RUN)) {
    const groups = match[0].split(SEPARATOR);
    const tokens: string[] = [];
    for (const group of groups) {
      if (tokens.length > 0 && group.length === 3) tokens[tokens.length - 1] += group;
      else tokens.push(group);
    }
    runs.push({ full: groups.join(""), tokens });
  }
  return runs;
}

const isZeros = (value: string) => /^0+$/.test(value);

/** Every number the reply may use: tokens and whole runs of the reference. */
export function referenceNumbers(texts: string[]): Set<string> {
  const known = new Set<string>();
  for (const text of texts) {
    for (const run of numberRuns(text)) {
      known.add(run.full);
      for (const token of run.tokens) known.add(token);
    }
  }
  return known;
}

/** The first number of the reply that the reference does not have. */
export function unknownNumber(reply: string, known: Set<string>): string | null {
  for (const run of numberRuns(reply)) {
    if (known.has(run.full)) continue;
    const missing = run.tokens.find((token) => !isZeros(token) && !known.has(token));
    if (missing) return missing;
  }
  return null;
}

// Arabic words take clitics (و، ب، ل، ف، ال) and have no \b in JavaScript:
// a word counts when no letter touches it on either side.
const ARABIC_EDGE_BEFORE = "(?<!\\p{L})(?:[وبلفك]?(?:ال)?)";
const ARABIC_EDGE_AFTER = "(?!\\p{L})";

function arabicWords(words: string[]): RegExp {
  return new RegExp(`${ARABIC_EDGE_BEFORE}(${words.join("|")})${ARABIC_EDGE_AFTER}`, "u");
}

const CURRENCY_PATTERNS = [
  arabicWords(["دج", "د\\.ج", "دينار", "دنانير", "سنتيم", "دورو", "يورو", "دولار"]),
  /\b(?:da|dzd|dinars?|eur|euros?|usd|dollars?|centimes?|douros?)\b/i,
  /[€$]/,
];

const AMOUNT_WORD_PATTERNS = [
  arabicWords(["ألف", "الف", "آلاف", "الاف", "ألفين", "الفين", "مليون", "ملايين", "مليار", "مئة", "مائة", "مئتين", "ميتين"]),
  /\b(?:mille|milles|million|millions|milliard|milliards|thousand|thousands|hundred|hundreds|alf|alaf|melyoun|malyoun)\b/i,
];

function firstMatch(patterns: RegExp[], text: string): string | null {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return (match[1] ?? match[0]).toLowerCase();
  }
  return null;
}

/** ألف and الف are one word: hamza forms are compared without the hamza. */
function wordKey(word: string): string {
  return word.toLowerCase().replace(/[أإآ]/g, "ا");
}

function allMatches(patterns: RegExp[], text: string): string[] {
  const found: string[] = [];
  for (const pattern of patterns) {
    const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    for (const match of text.matchAll(global)) found.push(wordKey(match[1] ?? match[0]));
  }
  return found;
}

const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>"'()]+/gi;

function links(text: string): string[] {
  return [...text.matchAll(URL_PATTERN)].map((match) =>
    match[0].replace(/[.,;:!?)\]]+$/, "").replace(/^https?:\/\//i, "").replace(/^www\./i, "").toLowerCase()
  );
}

/**
 * Check a reply against what the bot was allowed to know: the knowledge
 * base, the shop's instructions and the conversation.
 */
export function checkReply(reply: string, referenceTexts: string[]): GuardViolation | null {
  const trimmed = reply.trim();
  if (!trimmed || trimmed.length > MAX_REPLY_CHARS) {
    return { category: "OTHER", reason: GUARD_REASONS.emptyOrLong };
  }

  const reference = referenceTexts.join("\n");

  // Links first: the digits inside a link belong to the link.
  const knownLinks = links(reference);
  const link = links(trimmed).find((url) => !knownLinks.some((known) => known === url || known.startsWith(url)));
  if (link) return { category: "NOT_IN_KB", reason: GUARD_REASONS.link, detail: link };
  const withoutLinks = trimmed.replace(URL_PATTERN, " ");

  const number = unknownNumber(withoutLinks, referenceNumbers(referenceTexts));
  if (number) return { category: "NOT_IN_KB", reason: GUARD_REASONS.number, detail: number };

  // A currency with no number at all: an amount in words, or a vague price.
  const currency = firstMatch(CURRENCY_PATTERNS, withoutLinks);
  if (currency && numberRuns(withoutLinks).length === 0) {
    return { category: "NOT_IN_KB", reason: GUARD_REASONS.amount, detail: currency };
  }
  const knownWords = new Set(allMatches(AMOUNT_WORD_PATTERNS, normalizeDigits(reference)));
  const amountWord = allMatches(AMOUNT_WORD_PATTERNS, withoutLinks).find((word) => !knownWords.has(word));
  if (amountWord) return { category: "NOT_IN_KB", reason: GUARD_REASONS.amount, detail: amountWord };

  return null;
}
