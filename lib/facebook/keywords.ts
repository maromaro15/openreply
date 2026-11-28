/**
 * Keyword matching for Facebook comments, aware of Arabic word affixes.
 *
 * lib/utils/keyword-matcher.ts is reused as is. Its whole-word mode is
 * Unicode-correct, but Arabic writes the article and several particles as
 * part of the word, and Algerian Darija adds possessive endings, so a "سعر"
 * keyword never matches "السعر", "بالسعر", "والسعر" or "سعرو" there. Those are
 * exactly how people ask for a price in a comment.
 *
 * In whole-word mode this module also tries each Arabic word with one prefix
 * and one suffix removed. Removal only happens when a real stem is left (two
 * letters after an article form, three after a one-letter particle or
 * ending), so short words are never cut down into false matches. Partial
 * mode needs none of this: it already matches inside words.
 */
import {
  matchKeywords,
  normalizeArabicScript,
  type KeywordMatchResult,
} from "@/lib/utils/keyword-matcher";

const ARABIC = /\p{Script=Arabic}/u;
const TOKEN_SPLIT = /[^\p{L}\p{N}\p{M}]+/u;

// In normalised form: normalizeArabicScript turns ك into ک and ي/ى into ی.
// Longest first, so "وال" wins over "و".
const ARTICLE_PREFIXES = [
  "وبال",
  "فبال",
  "وال",
  "فال",
  "بال",
  "کال",
  "عال", // Darija: على + ال ("عالسعر")
  "ولل",
  "فلل",
  "لل",
  "ال",
];
const LETTER_PREFIXES = ["و", "ف", "ب", "ل", "ک"];
const SUFFIXES = ["ها", "هم", "کم", "نا", "ات", "ه", "و", "ک", "ی"];

const length = (text: string) => Array.from(text).length;

function stripArticle(word: string): string | null {
  for (const prefix of ARTICLE_PREFIXES) {
    if (word.startsWith(prefix) && length(word) - length(prefix) >= 2) {
      return word.slice(prefix.length);
    }
  }
  return null;
}

function stripPrefix(word: string): string | null {
  const bare = stripArticle(word);
  if (bare) return bare;
  for (const prefix of LETTER_PREFIXES) {
    if (word.startsWith(prefix) && length(word) - length(prefix) >= 3) {
      return word.slice(prefix.length);
    }
  }
  return null;
}

function stripSuffix(word: string): string | null {
  for (const suffix of SUFFIXES) {
    if (word.endsWith(suffix) && length(word) - length(suffix) >= 3) {
      return word.slice(0, -suffix.length);
    }
  }
  return null;
}

/**
 * The forms an Arabic word is tried in: itself, without its prefix, without
 * its suffix, and without both. Non-Arabic words come back unchanged.
 */
export function arabicWordForms(word: string): string[] {
  const normalized = normalizeArabicScript(word);
  if (!ARABIC.test(normalized)) return [normalized];
  const forms = new Set([normalized]);
  const noPrefix = stripPrefix(normalized);
  if (noPrefix) forms.add(noPrefix);
  for (const form of [...forms]) {
    const noSuffix = stripSuffix(form);
    if (noSuffix) forms.add(noSuffix);
  }
  return [...forms];
}

/** A keyword typed with the article ("السعر") also matches its bare form. */
function keywordForms(keyword: string): string[] {
  const normalized = normalizeArabicScript(keyword.trim());
  if (!ARABIC.test(normalized) || /\s/.test(normalized)) return [keyword];
  const bare = stripArticle(normalized);
  return bare ? [keyword, bare] : [keyword];
}

/**
 * Same contract as matchKeywords: `matchedKeyword` is always one of the
 * keywords passed in, as the campaign stores it.
 */
export function matchPageKeywords(
  text: string,
  keywords: string[],
  wholeWordMatch = true
): KeywordMatchResult {
  const direct = matchKeywords(text, keywords, wholeWordMatch);
  if (direct.matched || !wholeWordMatch || !text) return direct;

  const normalized = normalizeArabicScript(text);
  const extra = new Set<string>();
  for (const token of normalized.split(TOKEN_SPLIT)) {
    if (!token || !ARABIC.test(token)) continue;
    for (const form of arabicWordForms(token)) {
      if (form !== token) extra.add(form);
    }
  }

  const owner = new Map<string, string>();
  for (const keyword of keywords) {
    for (const form of keywordForms(keyword)) {
      if (!owner.has(form)) owner.set(form, keyword);
    }
  }
  if (extra.size === 0 && owner.size === keywords.length) return direct;

  const expanded = [normalized, ...extra].join(" ");
  const result = matchKeywords(expanded, [...owner.keys()], true);
  if (!result.matched || result.matchedKeyword === null) return direct;
  return { matched: true, matchedKeyword: owner.get(result.matchedKeyword) ?? result.matchedKeyword };
}
