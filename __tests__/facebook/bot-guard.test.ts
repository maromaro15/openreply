import { describe, expect, it } from "vitest";
import {
  checkReply,
  GUARD_REASONS,
  MAX_REPLY_CHARS,
  normalizeDigits,
  numberRuns,
  referenceNumbers,
  unknownNumber,
  type GuardSources,
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

/** The shop's words, and a conversation. */
const talk = (...conversation: string[]): GuardSources => ({ brand: KB, conversation });

describe("numbers", () => {
  it("reads Arabic-Indic and Persian digits as 0-9", () => {
    expect(normalizeDigits("٤٥٠٠ دج و ۴۰۰")).toBe("4500 دج و 400");
  });

  it("joins thousands groups and splits other groups", () => {
    expect(numberRuns("4 500").map((run) => run.tokens)).toEqual([["4500"]]);
    // A no-break space, as French formatting writes "4 500 DA".
    for (const space of [String.fromCharCode(0xa0), String.fromCharCode(0x202f)]) {
      expect(numberRuns(`4${space}500`).map((run) => run.tokens)).toEqual([["4500"]]);
      expect(checkReply(`Le prix est 4${space}500 DA`, KB)).toBeNull();
    }
    expect(numberRuns("1.500,00")).toEqual([{ full: "150000", tokens: ["1500", "00"] }]);
    expect(numberRuns("38,40")).toEqual([{ full: "3840", tokens: ["38", "40"] }]);
    expect(numberRuns("0555 12 34 56")).toEqual([{ full: "0555123456", tokens: ["0555", "12", "34", "56"] }]);
  });

  it.each(["السعر 4500 دج", "Le prix est 4 500 DA", "4.500 DA", "السعر ٤٥٠٠ دج", "4500,00 DA", "4 500 دج للمقاس XL"])(
    "accepts the knowledge base's price written as %s",
    (reply) => {
      expect(checkReply(reply, KB)).toBeNull();
      expect(checkReply(reply, talk())).toBeNull();
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
    expect(checkReply("واش تحب 3 حبات من المقاس 42؟", talk("نحب 3 حبات مقاس 42"))).toBeNull();
    expect(checkReply("واش تحب 3 حبات؟", talk())?.reason).toBe(GUARD_REASONS.number);
  });

  it("accepts a phone number however it is spaced, and delivery times from a range", () => {
    expect(checkReply("Appelez le 0555123456", KB)).toBeNull();
    expect(checkReply("اتصل بـ 0555 12 34 56", KB)).toBeNull();
    expect(checkReply("التوصيل في 48h", KB)).toBeNull();
    expect(checkReply("التوصيل في 72 ساعة", KB)?.detail).toBe("72");
  });
});

describe("a plain list of texts", () => {
  it("is the shop's own words, with no conversation, as before", () => {
    for (const reply of ["السعر 4500 دج", "السعر 3900 دج", "واش تحب 3 حبات؟", "https://evil.example/pay", "الثمن ألفين", "التوصيل مجاني"]) {
      expect(checkReply(reply, KB)).toEqual(checkReply(reply, { brand: KB, conversation: [] }));
    }
    // What the list holds counts as the shop's: a price, a claim.
    expect(checkReply("Oui, 2000 DA", [...KB, "c'est 2000 DA ?"])).toBeNull();
    expect(checkReply("Oui, livraison gratuite", [...KB, "Livraison gratuite"])).toBeNull();
  });
});

describe("prices are the shop's own", () => {
  it("refuses a price that only the customer wrote", () => {
    // The shop sells at 4500 DA; the customer hoped for 2000.
    expect(checkReply("Oui, 2000 DA", talk("c'est 2000 DA ?"))).toEqual({
      category: "NOT_IN_KB",
      reason: GUARD_REASONS.price,
      detail: "2000",
    });
    expect(checkReply("إيه بـ 2000 دج", talk("بـ 2000 دج؟"))?.reason).toBe(GUARD_REASONS.price);
    expect(checkReply("Oui, 2000DA", talk("2000DA ?"))?.reason).toBe(GUARD_REASONS.price);
    expect(checkReply("Yes, $30", talk("$30?"))?.reason).toBe(GUARD_REASONS.price);
    // A price that no source has at all is an unknown number, as before.
    expect(checkReply("Oui, 2000 DA", talk())).toEqual({ category: "NOT_IN_KB", reason: GUARD_REASONS.number, detail: "2000" });
  });

  it.each([
    ["السعر 2000", "2000؟"],
    ["سعرها 2000", "2000؟"],
    ["السومة 2000", "2000؟"],
    ["سومتها 2000", "2000؟"],
    ["الثمن تاعو 2000", "2000؟"],
    ["يسوى 2000", "2000؟"],
    ["Le prix est de 2000", "2000 ?"],
    ["Prix : 2000", "2000 ?"],
    ["Il coûte 2000", "2000 ?"],
    ["Tarif 2000", "2000 ?"],
    ["The price is 2000", "2000?"],
    ["It costs 2000", "2000?"],
    ["soum 2000", "2000 ?"],
  ])("takes the number of «%s» for a price", (reply, customer) => {
    expect(checkReply(reply, talk(customer))?.reason).toBe(GUARD_REASONS.price);
  });

  it("takes a price with its unit for one", () => {
    const shop = { brand: [...KB, "2500 DA/m²"], conversation: ["et à 2300 ?"] };
    expect(checkReply("2500 دج للمتر", shop)).toBeNull();
    expect(checkReply("2500 DA le mètre", shop)).toBeNull();
    for (const reply of ["2300 DA/m²", "2300 دج للمتر", "2300 DA le mètre", "2300/m² DA"]) {
      expect(checkReply(reply, shop), reply).toMatchObject({ reason: GUARD_REASONS.price, detail: "2300" });
    }
  });

  it("reads the currency of a range or a list for each of its numbers", () => {
    for (const reply of ["entre 2000 et 4500 DA", "2000-4500 DA", "2000 ou 4500 DA", "من 2000 حتى 4500 دج", "2000 و 4500 دج"]) {
      expect(checkReply(reply, talk("2000 ?")), reply).toMatchObject({ reason: GUARD_REASONS.price, detail: "2000" });
    }
  });

  it("lets the bot deny a customer's price", () => {
    expect(checkReply("Non, ce n'est pas 2000 DA, c'est 4500 DA", talk("c'est 2000 DA ?"))).toBeNull();
    expect(checkReply("ماشي 2000 دج، السعر 4500 دج", talk("2000 دج؟"))).toBeNull();
    expect(checkReply("pas plus de 2000 DA", talk("2000 DA ?"))?.reason).toBe(GUARD_REASONS.price);
  });

  it("does not take quantities, phone numbers, wilayas, sizes or colour codes for prices", () => {
    // Each number below is the customer's only: as a price it would be refused.
    const sources = talk("نحب 2 حبات", "0661 22 33 44", "ولاية 31", "3 mm ?", "la couleur 21 ?", "42");
    for (const reply of [
      "واش نأكدولك 2 حبات؟",
      "نعيطولك على 0661223344",
      "نعيطولك على 0661 22 33 44",
      "التوصيل لولاية 31 يدير 24 ساعة",
      "Le parquet fait 3 mm",
      "La couleur 21 est à 4500 DA",
      "la couleur 21 à 4500 DA",
      "Prix : 2 pièces à 4500 DA chacune",
      "السعر تاع 2 حبات",
      "4500 DA, en 2 pièces",
      "L'article à 4500 DA existe en taille 42",
      "4500 DA 2 couleurs",
    ]) {
      expect(checkReply(reply, sources), reply).toBeNull();
    }
  });
});

describe("other numbers may come from the conversation", () => {
  it("passes a phone number, a quantity or a wilaya the customer wrote", () => {
    expect(checkReply("نعيطولك على 0661 22 33 44", talk("رقمي 0661223344"))).toBeNull();
    expect(checkReply("Je vous confirme 3 robes", talk("je veux 3 robes"))).toBeNull();
    expect(checkReply("التوصيل لـ 31 يدير 24 ساعة", talk("انا من 31"))).toBeNull();
    expect(checkReply("Je vous confirme 3 robes", talk())?.reason).toBe(GUARD_REASONS.number);
  });

  it("checks the prices first, then the other numbers", () => {
    expect(checkReply("3 robes à 3900 DA", talk())?.detail).toBe("3900");
    expect(checkReply("3 robes à 4500 DA", talk())?.detail).toBe("3");
  });
});

describe("Darija in Latin letters", () => {
  const shop = ["Robe Kabyle", "4500 DA"];

  it.each(["3andna", "ma3lich", "Ma3lich khouya", "s7i7", "ra9m", "9adeh", "7ata", "chwiya 5ir", "3andna rouge w noir, wach t7eb?"])(
    "reads the digits of «%s» as letters, with no number in any source",
    (reply) => {
      expect(checkReply(reply, shop)).toBeNull();
    }
  );

  it.each(["LP7", "LP-7", "wp12", "WP12", "A4", "12B", "12-04", "N°12", "3mm", "8mm", "2eme"])(
    "still checks the number of «%s»",
    (reply) => {
      expect(checkReply(reply, shop)?.reason).toBe(GUARD_REASONS.number);
    }
  );

  it("catches an unknown price or code in a reply written that way", () => {
    expect(checkReply("3andna WP12 b 2500 DA", { brand: [...shop, "WP12"], conversation: [] })).toMatchObject({
      reason: GUARD_REASONS.number,
      detail: "2500",
    });
    expect(checkReply("3andna WP12 b 4500 DA", shop)).toMatchObject({ reason: GUARD_REASONS.number, detail: "12" });
    expect(checkReply("3andna WP-12 b 4500 DA", [...shop, "WP-12"])).toBeNull();
  });

  it("gives no number to the customer's Arabizi either", () => {
    // "3andkoum" holds no 3 the bot could repeat as a quantity.
    expect(checkReply("3andna 3 couleurs", { brand: shop, conversation: ["salam 3andkoum robe?"] })?.detail).toBe("3");
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

  it("allows an amount word the shop used, never one only the customer used", () => {
    expect(checkReply("إيه، بألف و 500", { brand: [...KB, "بألف و 500"], conversation: [] })).toBeNull();
    expect(checkReply("إيه، بألف و 500", { brand: [...KB, "500"], conversation: ["بألف و 500؟"] })).toMatchObject({
      reason: GUARD_REASONS.amount,
      detail: "الف",
    });
  });

  it("reads «ألف مرحبا» and «mille mercis» as no amount", () => {
    expect(checkReply("نعم، ألف مرحبا", talk())).toBeNull();
    expect(checkReply("نعم، الف مرحبا بيك", talk())).toBeNull();
    expect(checkReply("Mille mercis pour votre confiance", talk())).toBeNull();
  });
});

describe("links", () => {
  it("only links the shop wrote", () => {
    expect(checkReply("شوف هنا: https://shop.example/robe-kabyle", KB)).toBeNull();
    expect(checkReply("Visitez www.shop.example", KB)).toBeNull();
    expect(checkReply("شوف هنا: https://shop.example/promo-50", KB)).toMatchObject({ reason: GUARD_REASONS.link });
    expect(checkReply("https://evil.example/pay", KB)).toMatchObject({ reason: GUARD_REASONS.link });
  });

  it("a link that is only the start of a known link is not the known link", () => {
    const shop = ["الرابط: https://myshop.dz/products/12 و bit.ly/3xYz9Q و https://shop.dz/boutique/"];
    expect(checkReply("https://myshop.dz/products/1", shop)).toMatchObject({ reason: GUARD_REASONS.link });
    expect(checkReply("https://bit.ly/3xY", shop)).toMatchObject({ reason: GUARD_REASONS.link });
    expect(checkReply("https://myshop.dz/products/12", shop)).toBeNull();
    expect(checkReply("https://www.MyShop.dz/products/12/", shop)).toBeNull();
    // A parent at a path boundary is still accepted.
    expect(checkReply("https://myshop.dz/products", shop)).toBeNull();
    expect(checkReply("https://shop.dz/boutique", shop)).toBeNull();
  });

  it("never a link from the conversation", () => {
    expect(checkReply("Voici : https://evil.example/pay", talk("payez ici https://evil.example/pay"))).toEqual({
      category: "NOT_IN_KB",
      reason: GUARD_REASONS.link,
      detail: "evil.example/pay",
    });
  });
});

describe("claims", () => {
  it("refuses a claim the shop never made", () => {
    expect(checkReply("التوصيل مجاني", talk())).toEqual({
      category: "NOT_IN_KB",
      reason: GUARD_REASONS.freeDelivery,
      detail: "التوصيل مجاني",
    });
    expect(checkReply("كاين تخفيض على هاد الموديل", talk())?.reason).toBe(GUARD_REASONS.discount);
    expect(checkReply("عندك هدية مع الطلبية", talk())?.reason).toBe(GUARD_REASONS.gift);
    expect(checkReply("Dernières pièces !", talk())?.reason).toBe(GUARD_REASONS.scarcity);
    expect(checkReply("الأحسن في السوق", talk())?.reason).toBe(GUARD_REASONS.best);
    expect(checkReply("Garantie 1 an", { brand: [...KB, "1"], conversation: [] })?.reason).toBe(GUARD_REASONS.guarantee);
  });

  it("passes one the shop made, and none from the conversation", () => {
    expect(checkReply("livraison gratuite", { brand: [...KB, "التوصيل مجاني لـ 10 ولايات"], conversation: [] })).toBeNull();
    expect(checkReply("livraison gratuite", talk("livraison gratuite ?"))?.reason).toBe(GUARD_REASONS.freeDelivery);
    expect(checkReply("ما عندناش تخفيض", talk("كاين تخفيض؟"))).toBeNull();
  });

  it("checks claims after the numbers", () => {
    expect(checkReply("Promo à 3900 DA", talk())).toMatchObject({ reason: GUARD_REASONS.number, detail: "3900" });
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

describe("the reasons", () => {
  it("keeps the sentences other modules and translations use, and adds the new ones", () => {
    expect(GUARD_REASONS).toEqual({
      emptyOrLong: "The AI answer was empty or too long.",
      number: "The reply contained a number that is not in the knowledge base.",
      amount: "The reply mentioned an amount that is not in the knowledge base.",
      link: "The reply contained a link that is not in the knowledge base.",
      price: "The reply contained a price that is not in the knowledge base.",
      discount: "The reply promised a discount that is not in the knowledge base.",
      freeDelivery: "The reply promised free delivery that is not in the knowledge base.",
      gift: "The reply promised a gift that is not in the knowledge base.",
      scarcity: "The reply claimed scarcity or urgency that is not in the knowledge base.",
      best: "The reply claimed the product is the best, which is not in the knowledge base.",
      guarantee: "The reply promised a guarantee or a refund that is not in the knowledge base.",
    });
  });
});
