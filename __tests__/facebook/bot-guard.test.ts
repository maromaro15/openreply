import { describe, expect, it } from "vitest";
import {
  checkReply,
  GUARD_REASONS,
  MAX_REPLY_CHARS,
  normalizeDigits,
  numberRuns,
  referenceNumbers,
  unknownNumber,
} from "../../lib/bot/guard";

const KB = [
  "Robe Kabyle",
  "4500 DA",
  "Tailles S à XL, rouge et bleu",
  "Alger",
  "400 DA",
  "24-48h",
  "Paiement à la livraison. Tél 0555 12 34 56",
  "https://shop.example/robe-kabyle",
];

describe("numbers", () => {
  it("reads Arabic-Indic and Persian digits as 0-9", () => {
    expect(normalizeDigits("٤٥٠٠ دج و ۴۰۰")).toBe("4500 دج و 400");
  });

  it("joins thousands groups and splits other groups", () => {
    expect(numberRuns("4 500").map((run) => run.tokens)).toEqual([["4500"]]);
    expect(numberRuns("1.500,00")).toEqual([{ full: "150000", tokens: ["1500", "00"] }]);
    expect(numberRuns("38,40")).toEqual([{ full: "3840", tokens: ["38", "40"] }]);
    expect(numberRuns("0555 12 34 56")).toEqual([{ full: "0555123456", tokens: ["0555", "12", "34", "56"] }]);
  });

  it.each(["السعر 4500 دج", "Le prix est 4 500 DA", "4.500 DA", "السعر ٤٥٠٠ دج", "4500,00 DA", "4 500 دج للمقاس XL"])(
    "accepts the knowledge base's price written as %s",
    (reply) => {
      expect(checkReply(reply, KB)).toBeNull();
    }
  );

  it("refuses an invented price, even one hidden inside a known one", () => {
    expect(checkReply("السعر 3900 دج", KB)).toEqual({
      category: "NOT_IN_KB",
      reason: GUARD_REASONS.number,
      detail: "3900",
    });
    // "500" is part of "4 500" but was never a price of its own.
    expect(unknownNumber("ب 500 دج برك", referenceNumbers(KB))).toBe("500");
  });

  it("accepts numbers the customer wrote", () => {
    expect(checkReply("واش تحب 3 حبات من المقاس 42؟", [...KB, "نحب 3 حبات مقاس 42"])).toBeNull();
    expect(checkReply("واش تحب 3 حبات؟", KB)?.reason).toBe(GUARD_REASONS.number);
  });

  it("accepts a phone number however it is spaced, and delivery times from a range", () => {
    expect(checkReply("Appelez le 0555123456", KB)).toBeNull();
    expect(checkReply("اتصل بـ 0555 12 34 56", KB)).toBeNull();
    expect(checkReply("التوصيل في 48h", KB)).toBeNull();
    expect(checkReply("التوصيل في 72 ساعة", KB)?.detail).toBe("72");
  });
});

describe("amounts without digits", () => {
  it("a currency with no number at all", () => {
    expect(checkReply("السعر بالدينار، مليح بزاف", KB)?.reason).toBe(GUARD_REASONS.amount);
    expect(checkReply("Le prix est en DA", KB)?.reason).toBe(GUARD_REASONS.amount);
  });

  it("amounts in words, Darija, French or English", () => {
    expect(checkReply("الثمن ألفين", KB)?.reason).toBe(GUARD_REASONS.amount);
    expect(checkReply("45 ألف برك", [...KB, "45"])?.reason).toBe(GUARD_REASONS.amount);
    expect(checkReply("C'est deux mille", KB)?.reason).toBe(GUARD_REASONS.amount);
    expect(checkReply("Only two thousand", KB)?.reason).toBe(GUARD_REASONS.amount);
  });

  it("does not trip on words that merely contain one", () => {
    expect(checkReply("الفستان متوفر بالأحمر", KB)).toBeNull();
    expect(checkReply("عندنا دجاج؟ لا، عندنا لبسة برك", KB)).toBeNull();
    expect(checkReply("الموديل مختلف شوية", KB)).toBeNull();
  });

  it("allows an amount word the customer or the knowledge base used", () => {
    expect(checkReply("نعم، ألف مرحبا", [...KB, "بألف دينار؟"])).toBeNull();
    expect(checkReply("نعم، الف مرحبا", [...KB, "بألف دينار؟"])).toBeNull();
  });
});

describe("links", () => {
  it("only links from the knowledge base or the conversation", () => {
    expect(checkReply("شوف هنا: https://shop.example/robe-kabyle", KB)).toBeNull();
    expect(checkReply("Visitez www.shop.example", KB)).toBeNull();
    expect(checkReply("شوف هنا: https://shop.example/promo-50", KB)).toMatchObject({ reason: GUARD_REASONS.link });
    expect(checkReply("https://evil.example/pay", KB)).toMatchObject({ reason: GUARD_REASONS.link });
  });
});

describe("shape", () => {
  it("an empty or overlong reply goes to a person", () => {
    expect(checkReply("   ", KB)).toEqual({ category: "OTHER", reason: GUARD_REASONS.emptyOrLong });
    expect(checkReply("مرحبا ".repeat(MAX_REPLY_CHARS), KB)?.category).toBe("OTHER");
  });

  it("a plain answer passes", () => {
    expect(checkReply("إيه متوفرة بالأحمر والأزرق 😊", KB)).toBeNull();
  });
});
