import { describe, expect, it } from "vitest";
import { arabicWordForms, matchPageKeywords } from "../../lib/facebook/keywords";
import { matchKeywords } from "../../lib/utils/keyword-matcher";

const PRICE_KEYWORDS = ["سعر", "prix", "price"];

const matched = (text: string, keywords = PRICE_KEYWORDS, wholeWord = true) =>
  matchPageKeywords(text, keywords, wholeWord);

describe("matchPageKeywords: Arabic price questions", () => {
  it.each([
    "سعر",
    "شحال السعر؟",
    "بالسعر",
    "والسعر من فضلك",
    "فالسعر",
    "للسعر",
    "عالسعر",
    "سعرو؟", // Darija: its price
    "سعرها",
    "سعره",
    "قداش سعرو خويا",
  ])("matches %s for the keyword سعر", (text) => {
    expect(matched(text)).toEqual({ matched: true, matchedKeyword: "سعر" });
  });

  it("shows why the wrapper exists: the base matcher misses these", () => {
    for (const text of ["شحال السعر؟", "بالسعر", "سعرو"]) {
      expect(matchKeywords(text, PRICE_KEYWORDS, true).matched).toBe(false);
    }
  });

  it("folds Arabic letter variants on both sides", () => {
    // Arabic yeh (U+064A) in the comment, Persian-normalised internally.
    expect(matched("للبيع؟", ["بيع"]).matched).toBe(true);
    expect(matched("كاين الكمية؟", ["كمية"]).matched).toBe(true);
  });

  it("lets a keyword typed with the article match the bare word", () => {
    expect(matched("سعرو؟", ["السعر"])).toEqual({ matched: true, matchedKeyword: "السعر" });
    expect(matched("شحال السعر", ["السعر"])).toEqual({ matched: true, matchedKeyword: "السعر" });
  });

  it("does not match unrelated words that merely contain the letters", () => {
    expect(matched("مسعور").matched).toBe(false);
    expect(matched("مرحبا، واش كاين التوصيل؟").matched).toBe(false);
    // A one-letter particle is only removed when three letters remain.
    expect(arabicWordForms("لعب")).toEqual(["لعب"]);
  });

  it("keeps partial mode as it was: matching inside a word", () => {
    expect(matched("سعرو", PRICE_KEYWORDS, false).matched).toBe(true);
    // "مسعر" contains سعر, so partial mode matches it and whole-word does not:
    // م is not a particle, so nothing is removed.
    expect(matched("مسعر", PRICE_KEYWORDS, false).matched).toBe(true);
    expect(matched("مسعر", PRICE_KEYWORDS, true).matched).toBe(false);
  });
});

describe("matchPageKeywords: French, English and digits", () => {
  it.each([
    ["le prix ?", "prix"],
    ["PRIX svp", "prix"],
    ["c'est combien le prix", "prix"],
    ["price?", "price"],
    ["What's the PRICE", "price"],
  ])("matches %s", (text, keyword) => {
    expect(matched(text)).toEqual({ matched: true, matchedKeyword: keyword });
  });

  it("respects whole words in Latin script", () => {
    expect(matched("priceless").matched).toBe(false);
    expect(matched("prixfixe").matched).toBe(false);
  });

  it("matches Arabic-Indic digits against an ASCII keyword", () => {
    expect(matched("بغيت ١٠ قطع", ["10"]).matched).toBe(true);
  });

  it("returns no match for empty text or no keywords", () => {
    expect(matched("")).toEqual({ matched: false, matchedKeyword: null });
    expect(matched("سعر", [])).toEqual({ matched: false, matchedKeyword: null });
  });
});

describe("arabicWordForms", () => {
  it("removes one prefix and one suffix", () => {
    expect(arabicWordForms("والسعر")).toContain("سعر");
    expect(arabicWordForms("بسعرو")).toEqual(expect.arrayContaining(["سعرو", "سعر"]));
  });

  it("leaves non-Arabic words alone", () => {
    expect(arabicWordForms("prix")).toEqual(["prix"]);
  });
});
