/**
 * The code check on every reply the model writes, before anything is sent.
 *
 * The model is told to quote prices exactly; this makes sure it did. Every
 * number in the reply must already be known, however it is written: "4500",
 * "4 500", "4.500" and "٤٥٠٠" are the same number. The shop's words and the
 * conversation's are told apart: a price, an amount in words ("ألفين",
 * "deux mille"), a link and a claim (a discount, free delivery, "the best",
 * a guarantee...) must come from what the shop wrote, while any other number
 * may also come from the conversation (the customer's phone number, a
 * quantity, a wilaya). A customer asking "c'est 2000 DA ?" gives the bot no
 * price to confirm. Anything new means a person must answer.
 */
import { checkClaims, CLAIM_REASONS } from "./claims";

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
  price: "The reply contained a price that is not in the knowledge base.",
  discount: CLAIM_REASONS.discount,
  freeDelivery: CLAIM_REASONS.free_delivery,
  gift: CLAIM_REASONS.gift,
  scarcity: CLAIM_REASONS.scarcity,
  best: CLAIM_REASONS.best,
  guarantee: CLAIM_REASONS.guarantee,
} as const;

export type GuardReason = (typeof GUARD_REASONS)[keyof typeof GUARD_REASONS];

/** What the bot was allowed to know, by who wrote it. */
export interface GuardSources {
  /** What the shop wrote: knowledge base, catalog, business name, its instructions, the campaign, and its team's own messages. */
  brand: string[];
  /** The rest of the conversation: the customer's messages and the bot's earlier replies. */
  conversation: string[];
}

/** Messenger takes 2000 characters; a shop's answer needs far fewer. */
export const MAX_REPLY_CHARS = 1200;

const DIGIT_BLOCKS = [0x0660, 0x06f0, 0x07c0, 0x0966, 0x09e6, 0xff10];

/** Arabic-Indic, Persian and other decimal digits become 0-9. */
export function normalizeDigits(text: string): string {
  return text.replace(/(?![0-9])\p{Nd}/gu, (digit) => {
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

function readRun(written: string): NumberRun {
  const groups = written.split(SEPARATOR);
  const tokens: string[] = [];
  for (const group of groups) {
    if (tokens.length > 0 && group.length === 3) tokens[tokens.length - 1] += group;
    else tokens.push(group);
  }
  return { full: groups.join(""), tokens };
}

export function numberRuns(text: string): NumberRun[] {
  return [...normalizeDigits(text).matchAll(RUN)].map((match) => readRun(match[0]));
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

/** The first number of a run that the reference does not have. */
function missingToken(run: NumberRun, known: Set<string>): string | null {
  if (known.has(run.full)) return null;
  return run.tokens.find((token) => !isZeros(token) && !known.has(token)) ?? null;
}

/** The first number of the reply that the reference does not have. */
export function unknownNumber(reply: string, known: Set<string>): string | null {
  for (const run of numberRuns(reply)) {
    const missing = missingToken(run, known);
    if (missing) return missing;
  }
  return null;
}

// ─── Darija in Latin letters ────────────────────────────────────────────────

// "3andna", "ma3lich", "s7i7", "ra9m", "9adeh", "5ir": digits written for ع ح
// ق خ ط غ ء are letters. A word is read so when it is in lower case (a capital
// may open a sentence), has two letters or more, and each of its digits
// stands alone among 2 3 5 6 7 8 9. Codes stay numbers: "WP12" and "LP7" have
// capitals, "wp12" a two-digit run, "A4" one letter, "LP-7" a digit alone.
// So do measures written as one word: "3mm", "2cm", "5ans", "2eme".
const LATIN_WORD = /[A-Za-z0-9]+/g;
const UNITS = [
  "mm", "cm", "dm", "m", "km", "m2", "m3", "ml", "cl", "dl", "l", "mg", "g", "kg", "t",
  "h", "min", "mn", "s", "ms", "j", "jours?", "ans?", "mois",
  "go", "gb", "mo", "mb", "to", "tb", "ko", "kb", "w", "kw", "v", "mah", "hz", "khz", "mhz", "ghz", "px", "dpi", "pcs?", "x",
  "eme", "e", "er", "ere", "nd", "rd", "th", "st",
];
const MEASURE = new RegExp(`^\\d+(?:${UNITS.join("|")})$`);

function isArabiziWord(word: string): boolean {
  if (!/^[A-Z]?[a-z0-9]+$/.test(word) || MEASURE.test(word.toLowerCase())) return false;
  const digits = word.match(/\d+/g) ?? [];
  const letters = word.match(/[A-Za-z]/g) ?? [];
  return digits.length > 0 && letters.length >= 2 && digits.every((digit) => /^[2356789]$/.test(digit));
}

/** The text with the digits of Arabizi words turned into letters; its length is kept. */
function withoutArabiziDigits(text: string): string {
  return text.replace(LATIN_WORD, (word) => (isArabiziWord(word) ? word.replace(/\d/g, "x") : word));
}

/** The numbers of texts, read as the reply's are: referenceNumbers, without Arabizi digits. */
function knownNumbers(texts: string[]): Set<string> {
  const known = new Set<string>();
  for (const text of texts) {
    for (const match of withoutArabiziDigits(normalizeDigits(text)).matchAll(RUN)) {
      const run = readRun(match[0]);
      known.add(run.full);
      for (const token of run.tokens) known.add(token);
    }
  }
  return known;
}

// ─── Currencies, amounts and prices ─────────────────────────────────────────

// Arabic words take clitics (و، ب، ل، ف، ال) and have no \b in JavaScript:
// a word counts when no letter touches it on either side.
const ARABIC_EDGE_BEFORE = "(?<!\\p{L})(?:[وبلفك]?(?:ال)?)";
const ARABIC_EDGE_AFTER = "(?!\\p{L})";

function arabicWords(words: string[]): RegExp {
  return new RegExp(`${ARABIC_EDGE_BEFORE}(${words.join("|")})${ARABIC_EDGE_AFTER}`, "u");
}

const ARABIC_CURRENCIES = ["دج", "د\\.ج", "دينار", "دنانير", "سنتيم", "دورو", "يورو", "دولار"];
const LATIN_CURRENCIES = "da|dzd|dinars?|eur|euros?|usd|dollars?|centimes?|douros?";
const ARABIC_AMOUNTS = ["ألف", "الف", "آلاف", "الاف", "ألفين", "الفين", "مليون", "ملايين", "مليار", "مئة", "مائة", "مئتين", "ميتين"];
const LATIN_AMOUNTS = "mille|milles|million|millions|milliard|milliards|thousand|thousands|hundred|hundreds|alf|alaf|melyoun|malyoun";

const CURRENCY_PATTERNS = [arabicWords(ARABIC_CURRENCIES), new RegExp(`\\b(?:${LATIN_CURRENCIES})\\b`, "i"), /[€$]/];
const AMOUNT_WORD_PATTERNS = [arabicWords(ARABIC_AMOUNTS), new RegExp(`\\b(?:${LATIN_AMOUNTS})\\b`, "i")];

// "ألف مرحبا", "mille mercis": a thousand of nothing to pay.
const AMOUNT_IDIOMS = new RegExp(
  [
    "(?<!\\p{L})[وبلفك]?(?:ألف|الف|مليون)\\s+(?:مرحبا|مرحبى|مرحبه|مرحبة|شكر|سلامه|سلامة|بركه|بركة|تحيه|تحية|مبروك)(?!\\p{L})",
    "\\bmille\\s+(?:mercis?|fois|excuses|pardons?|bisous)\\b",
    "\\b(?:a\\s+)?(?:thousand|million)\\s+(?:thanks|times)\\b",
    "\\b(?:alf|alaf)\\s+(?:merhba|mar7ba|marhba|mer7ba|mar7aba|marhaba|choukr|shokr)\\b",
  ].join("|"),
  "giu"
);

const SPACE = "[\\s\\u00a0\\u202f]";
const CURRENCY = `(?:(?<!\\p{L})[وبلفك]?(?:ال)?(?:${ARABIC_CURRENCIES.join("|")})(?!\\p{L})|(?<!\\p{L})(?:${LATIN_CURRENCIES})(?![\\p{L}\\p{N}])|[€$])`;
const AMOUNT = `(?:(?<!\\p{L})[وبلفك]?(?:ال)?(?:${ARABIC_AMOUNTS.join("|")})(?!\\p{L})|(?<!\\p{L})(?:${LATIN_AMOUNTS})(?![\\p{L}\\p{N}]))`;

/** "4500 DA", "4500دج", "45 ألف", "2500 DA/m²", "2500/m² DA". */
const MONEY_AFTER = new RegExp(`^${SPACE}*(?:\\/${SPACE}*[^\\s\\d]{1,3}${SPACE}*)?(?:${CURRENCY}|${AMOUNT})`, "iu");
/** "$30", "€ 30", "DZD 4500"; not the DA of "4500 DA 3 couleurs", which is the 4500's. */
const MONEY_BEFORE = new RegExp(`${CURRENCY}${SPACE}*:?${SPACE}*$`, "iu");
const MONEY_OF_ANOTHER = new RegExp(`\\d${SPACE}*${CURRENCY}${SPACE}*:?${SPACE}*$`, "iu");

// "السعر 4500", "سومتها 4500", "le prix est de 4500", "coûte 4500", "price: 4500".
const PRICE_WORDS_AR = [
  "سعر(?:ه|ها|هم|و|كم)?", "اسعار(?:ها|نا|هم)?", "أسعار(?:ها|نا|هم)?", "ثمن(?:ه|ها|و)?", "تمن(?:ه|ها|و)?",
  "سوم(?:ه|ة|تو|ته|تها|تهم)?", "مبلغ", "يسوى", "تسوى", "يسوا", "تسوا", "يسواو", "تسواو", "يكلف", "تكلف",
].join("|");
const PRICE_WORDS_LATIN = [
  "prix", "tarifs?", "co[uû]tent", "co[uû]te", "co[uû]ts?", "montant", "prices?", "priced", "costs?",
  "soum", "souma", "essoum", "sa3r", "s3r", "taman", "thaman",
].join("|");
// Only words that say "is" or "its": "le prix de 2 pièces" and "السعر تاع 2 حبات" count pieces.
const PRICE_FILLERS = [
  "est\\s+de", "est", "sont", "sera", "serait", "unitaire", "total", "final", "actuel",
  "is", "are", "was", "at", "only", "just", "seulement", "juste",
  "هو", "هي", "راه", "راهو", "راهي", "راهم", "تاعو", "تاعها", "تاعهم", "نتاعو", "نتاعها", "ديالو", "ديالها",
  "غير", "فقط", "يبدا\\s+من", "يبدأ\\s+من", "من", "ta3o", "ta3ha", "raho", "rahi", "ghir",
].join("|");
const PRICE_GAP = `(?:${SPACE}*[:=]${SPACE}*|${SPACE}+)`;
const PRICE_WORD_BEFORE = new RegExp(
  `(?:(?<!\\p{L})[وبلفك]?(?:ال)?(?:${PRICE_WORDS_AR})|(?<![\\p{L}\\p{N}])(?:${PRICE_WORDS_LATIN}))(?![\\p{L}])${PRICE_GAP}(?:(?:${PRICE_FILLERS})${PRICE_GAP}){0,2}$`,
  "iu"
);
/** A count or a measure: "2 حبات", "3 mm", "48 h", "58 wilayas". */
const COUNTS_AR = [
  "حب(?:ه|ة|ات|تين)", "قطع(?:ه|ة)?", "بياس(?:ه|ة|ات)", "ساع(?:ه|ة|ات)", "يوم", "ايام", "أيام", "ولاي(?:ه|ة|ات)",
  "لون", "الوان", "ألوان", "مقاس(?:ات)?", "موديل(?:ات)?", "متر", "كيلو", "غرام",
];
const COUNTS_LATIN = [
  "pi[eè]ces?", "articles?", "unit[eé]s?", "pcs?", "mm", "cm", "m", "ml", "kg", "g", "l", "h",
  "heures?", "hours?", "jours?", "days?", "ans?", "years?", "mois", "months?", "semaines?", "weeks?",
  "wilayas?", "couleurs?", "colou?rs?", "tailles?", "sizes?", "mod[eè]les?", "models?", "personnes?", "people",
];
const COUNTED_AFTER = new RegExp(
  `^${SPACE}*(?:%|×|x(?![\\p{L}])|(?<!\\p{L})[وبلفك]?(?:ال)?(?:${COUNTS_AR.join("|")})(?!\\p{L})|(?:${COUNTS_LATIN.join("|")})(?![\\p{L}\\p{N}]))`,
  "iu"
);
/** "Ce n'est pas 2000 DA", "ماشي ب 2000": the reply denies the customer's price. */
const DENIED_BEFORE = new RegExp(
  `(?<!\\p{L})(?:pas|non|not|no|ماشي|مشي|مش|موش|ليس|ليست|machi|mashi|mch|mech|mouch)${SPACE}*(?:(?:de|à|a|بـ|ب)${SPACE}*)?$`,
  "iu"
);
// A currency written once for a range or a list: "2500-2800 DA", "2500 ou 2800 DA", "من 2500 حتى 2800 دج".
const LIST_JOIN = new RegExp(`^${SPACE}*(?:[-–—/]|ou|or|et|and|و|ولا|او|أو)${SPACE}*$`, "iu");
const RANGE_JOIN = new RegExp(`^${SPACE}*(?:à|a|au|to|حتى|الى|إلى|لـ|ل)${SPACE}*$`, "iu");
const RANGE_OPENS = new RegExp(
  `(?:(?<![\\p{L}\\p{N}])(?:de|entre|from|between|du)|(?<!\\p{L})(?:من|بين|مابين|ما${SPACE}*بين))${SPACE}*$`,
  "iu"
);

interface ReplyNumber {
  run: NumberRun;
  start: number;
  end: number;
  /** Written as a price: a currency or an amount word touches it, or a price word comes right before it. */
  price: boolean;
  /** Written after a negation: "ce n'est pas 2000 DA". */
  denied: boolean;
}

/** A plain amount, not a phone number or a code: "4500", "1.500,00". */
function amountLike(run: NumberRun): boolean {
  const [first, ...rest] = run.tokens;
  return first.length <= 7 && !/^0\d/.test(first) && rest.every(isZeros);
}

/**
 * The reply's numbers, read in "masked" (where Arabizi digits are letters)
 * with their context read in "text"; both have the same length.
 */
function replyNumbers(masked: string, text: string): ReplyNumber[] {
  const numbers: ReplyNumber[] = [];
  for (const match of masked.matchAll(RUN)) {
    const start = match.index;
    const end = start + match[0].length;
    const before = text.slice(Math.max(0, start - 48), start);
    const after = text.slice(end, end + 48);
    const currencyBefore = MONEY_BEFORE.test(before) && !MONEY_OF_ANOTHER.test(before);
    const priceWord = PRICE_WORD_BEFORE.test(before) && !COUNTED_AFTER.test(after);
    numbers.push({
      run: readRun(match[0]),
      start,
      end,
      price: MONEY_AFTER.test(after) || currencyBefore || priceWord,
      denied: DENIED_BEFORE.test(before),
    });
  }
  // The numbers of a range or a list share its one currency: "2000-2500 DA" holds two prices.
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i + 1 < numbers.length; i++) {
      const [left, right] = [numbers[i], numbers[i + 1]];
      if (left.price === right.price || !amountLike(left.run) || !amountLike(right.run)) continue;
      const join = text.slice(left.end, right.start);
      const ranged = RANGE_JOIN.test(join) && RANGE_OPENS.test(text.slice(Math.max(0, left.start - 24), left.start));
      const other = left.price ? right : left;
      if ((LIST_JOIN.test(join) || ranged) && !COUNTED_AFTER.test(text.slice(other.end, other.end + 32))) {
        other.price = true;
        changed = true;
      }
    }
  }
  return numbers;
}

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
 * Check a reply against what the bot was allowed to know. A plain list of
 * texts is the shop's own words, with no conversation: what callers passed
 * before the two were told apart.
 *
 * In order: the reply's shape; links (the shop's only); prices (the shop's
 * only); every other number (the shop's or the conversation's); a currency
 * with no number and amounts in words (the shop's only); claims (the shop's
 * only). A price that no source has at all is reported as an unknown number,
 * as before; one that only the conversation has, as a price.
 */
export function checkReply(reply: string, sources: GuardSources | string[]): GuardViolation | null {
  const { brand, conversation } = Array.isArray(sources) ? { brand: sources, conversation: [] } : sources;
  const trimmed = reply.trim();
  if (!trimmed || trimmed.length > MAX_REPLY_CHARS) {
    return { category: "OTHER", reason: GUARD_REASONS.emptyOrLong };
  }

  const shop = brand.join("\n");

  // Links first: the digits inside a link belong to the link. A customer can paste any link.
  const knownLinks = links(shop);
  const link = links(trimmed).find((url) => !knownLinks.some((known) => known === url || known.startsWith(url)));
  if (link) return { category: "NOT_IN_KB", reason: GUARD_REASONS.link, detail: link };
  const withoutLinks = trimmed.replace(URL_PATTERN, " ");

  const text = normalizeDigits(withoutLinks);
  const numbers = replyNumbers(withoutArabiziDigits(text), text);
  const shopNumbers = knownNumbers(brand);
  const anyNumbers = new Set([...shopNumbers, ...knownNumbers(conversation)]);
  for (const number of numbers.filter((candidate) => candidate.price)) {
    const unknown = missingToken(number.run, anyNumbers);
    if (unknown) return { category: "NOT_IN_KB", reason: GUARD_REASONS.number, detail: unknown };
    const notTheShops = missingToken(number.run, shopNumbers);
    if (notTheShops && !number.denied) return { category: "NOT_IN_KB", reason: GUARD_REASONS.price, detail: notTheShops };
  }
  for (const number of numbers.filter((candidate) => !candidate.price)) {
    const unknown = missingToken(number.run, anyNumbers);
    if (unknown) return { category: "NOT_IN_KB", reason: GUARD_REASONS.number, detail: unknown };
  }

  // A currency with no number at all: an amount in words, or a vague price.
  const currency = firstMatch(CURRENCY_PATTERNS, withoutLinks);
  if (currency && numbers.length === 0) {
    return { category: "NOT_IN_KB", reason: GUARD_REASONS.amount, detail: currency };
  }
  const knownWords = new Set(allMatches(AMOUNT_WORD_PATTERNS, normalizeDigits(shop)));
  const amountWord = allMatches(AMOUNT_WORD_PATTERNS, withoutLinks.replace(AMOUNT_IDIOMS, " ")).find(
    (word) => !knownWords.has(word)
  );
  if (amountWord) return { category: "NOT_IN_KB", reason: GUARD_REASONS.amount, detail: amountWord };

  return checkClaims(trimmed, brand);
}
