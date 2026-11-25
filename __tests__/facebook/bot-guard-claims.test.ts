import { describe, expect, it } from "vitest";
import { checkClaims, CLAIM_REASONS, findClaims, type ClaimKind } from "../../lib/bot/claims";
import { checkReply, GUARD_REASONS } from "../../lib/bot/guard";

const kinds = (text: string) => findClaims(text).map((claim) => claim.kind);

/** A shop that promises nothing: prices, sizes, delivery fees and times. */
const PLAIN_SHOP = [
  "Robe Kabyle",
  "4500 DA",
  "Tailles S à XL, rouge et bleu",
  "Alger",
  "400 DA",
  "24-48h",
  "Paiement à la livraison",
  "Parquet Chêne | price: 2500 DA/m² | colours or types: 12 (Chêne clair); 17 (Noyer, OUT OF STOCK)",
  "Alternatives you may suggest:\n- Lambris PVC: moins cher",
];

function expectKind(kind: ClaimKind, texts: string[]) {
  for (const text of texts) expect(kinds(text), text).toContain(kind);
}

function expectNone(texts: string[]) {
  for (const text of texts) expect(findClaims(text), text).toEqual([]);
}

describe("each kind, in each language", () => {
  it("a discount", () => {
    expectKind("discount", [
      // Arabic and Darija, with the article, the clitics, diacritics, tatweel and a common misspelling
      "كاين تخفيض على هاد الموديل",
      "عندنا تخفيضات هاد السيمانة",
      "بالتخفيض يولي أرخص",
      "والتخفيضات صالحة للكل",
      "فالتخفيضات",
      "للتخفيض",
      "تَخْفِيض",
      "كاين تخــفيض",
      "تخفيظ",
      "عندك خصم 10%",
      "كاين برومو اليوم",
      "بالبرومو",
      "عرض خاص للزبائن",
      "نقصلك شوية",
      "سولد",
      // Darija in Latin letters
      "kayen tkhfid",
      "3andna promo lyoum",
      "n9sslek chwiya",
      // French
      "c'est en promo",
      "Profitez de notre promotion",
      "Je vous fais une remise de 10%",
      "Une petite réduction pour vous",
      "REDUCTION",
      "rabais de 20%",
      "C'est les soldes !",
      "il est en solde",
      "prix promo",
      "-20% sur tout",
      // English
      "We have a discount today",
      "Discounts",
      "It's on sale",
      "20% off this week",
      "special offer",
    ]);
  });

  it("free delivery", () => {
    expectKind("free_delivery", [
      "التوصيل مجاني",
      "توصيل مجاني لكل الولايات",
      "والتوصيل مجاني",
      "التوصيل مجاناً",
      "التوصيل مجانية",
      "التوصيل بالمجان",
      "التّوصيل مجّاني",
      "التوصيل لكل الولايات مجاني",
      "التوصيل بلاش",
      "التوصيل باطل",
      "ليفريزون بلاش",
      "ليڤريزون بلاش",
      "الليفريزون علينا",
      "التوصيل على حسابنا",
      "بدون مصاريف التوصيل",
      "ما تخلصش التوصيل",
      "livraison blech",
      "tawsil batel",
      "livraison gratuite",
      "La livraison est gratuite",
      "LIVRAISON GRATUITE",
      "la livraison vers toutes les wilayas est gratuite",
      "livraison offerte",
      "frais de livraison offerts",
      "sans frais de livraison",
      "On vous offre la livraison",
      "On vous livre gratuitement",
      "livraison incluse",
      "free delivery",
      "free home delivery",
      "Free shipping to all wilayas",
      "Delivery is free",
      "We deliver for free",
    ]);
  });

  it("a gift", () => {
    expectKind("gift", [
      "عندك هدية مع الطلبية",
      "هدية مجانية مع كل طلبية",
      "وهدية ليك",
      "هدية لكل زبون",
      "بالهدية",
      "هديّة مع كل كوموند",
      "نهديولك ساك",
      "نعطيوك كادو",
      "kado m3a la commande",
      "3andek hdiya",
      "Un cadeau offert",
      "Cadeaux offerts",
      "avec un cadeau en plus",
      "le sac est offert",
      "un cadeau pour vous",
      "cadeau pour toute commande",
      "a free gift with your order",
      "a special gift for you",
      "you get a gift with every order",
    ]);
  });

  it("scarcity or urgency", () => {
    expectKind("scarcity", [
      "آخر قطعة",
      "آخِر قطعة",
      "أخر حبة",
      "آخر حبة في الستوك",
      "آخر القطع",
      "الحبة الأخيرة",
      "ما بقاش بزاف",
      "مابقاش بزاف",
      "بقاو غير 3",
      "بقات غير وحدة",
      "كمية محدودة",
      "الكمّية محدودة",
      "العرض محدود",
      "غير اليوم",
      "اليوم برك",
      "قبل ما يخلاص",
      "قبل ما يكمل الستوك",
      "حتى نفاد الكمية",
      "سارع بالطلب",
      "ما تضيعش الفرصة",
      "akher 7aba",
      "b9aw ghir 2",
      "ghir lyoum",
      "lyoum brk",
      "stock limité",
      "STOCK LIMITÉ",
      "Dernières pièces !",
      "quantité limitée",
      "offre limitée",
      "aujourd'hui seulement",
      "Dépêchez-vous",
      "il ne reste que 2 pièces",
      "Il en reste 2",
      "nous n'avons que 2 pièces",
      "dans la limite des stocks disponibles",
      "Ne ratez pas cette offre",
      "last pieces",
      "limited stock",
      "only today",
      "Hurry!",
      "selling fast",
    ]);
  });

  it("the best", () => {
    expectKind("best", [
      "الأحسن في السوق",
      "الاحسن فالسوق",
      "الأحسن بالجزائر",
      "أحسن حاجة في السوق",
      "أحسن سلعة في الجزائر",
      "أحسن جودة في الدزاير",
      "الأفضل في السوق",
      "الأفضل فـ الجزائر",
      "هذا ما يجعل منتوجنا الأحسن في السوق",
      "ما كاينش كيفو",
      "الوحيد في الجزائر",
      "رقم 1 في الجزائر",
      "رقم واحد في السوق",
      "أحسن سعر",
      "الأكثر مبيعا",
      "a7sen 7aja f sou9",
      "makach kifou",
      "le meilleur du marché",
      "LE MEILLEUR DU MARCHÉ",
      "le meilleur en Algérie",
      "c'est le meilleur rapport qualité prix du marché",
      "meilleur prix",
      "la meilleure qualité",
      "moins cher du marché",
      "numéro 1 en Algérie",
      "N°1 en Algérie",
      "unique en Algérie",
      "the best in the market",
      "number one in Algeria",
      "the cheapest in town",
      "best price",
    ]);
  });

  it("a guarantee or a refund", () => {
    expectKind("guarantee", [
      "عندو ضمان عام",
      "بالضمان",
      "والضمان",
      "مضمون 100%",
      "السلعة مضمونة",
      "ڨارونتي عام",
      "نرجعولك دراهمك",
      "madmoun",
      "fiha garantie",
      "garantie 2 ans",
      "GARANTIE",
      "c'est garanti",
      "Je vous garantis la qualité",
      "satisfait ou remboursé",
      "remboursement sous 7 jours",
      "guaranteed quality",
      "1 year warranty",
      "full refund",
    ]);
  });

  it("gives each claim as written, in reading order", () => {
    expect(findClaims("Promo -20% et Livraison Gratuite, dernières pièces !")).toEqual([
      { kind: "discount", phrase: "Promo" },
      { kind: "discount", phrase: "-20%" },
      { kind: "free_delivery", phrase: "Livraison Gratuite" },
      { kind: "scarcity", phrase: "dernières pièces" },
    ]);
    expect(findClaims("التوصيل مجّاني وعندك هدية")).toEqual([
      { kind: "free_delivery", phrase: "التوصيل مجّاني" },
      { kind: "gift", phrase: "هدية" },
    ]);
  });

  it("reads the longer claim where two overlap", () => {
    // "offerte" alone would be a gift; with the delivery it is free delivery.
    expect(kinds("livraison offerte")).toEqual(["free_delivery"]);
    expect(kinds("satisfait ou remboursé")).toEqual(["guarantee"]);
  });

  it("reads free alone as free delivery after the delivery, as a gift otherwise", () => {
    expect(kinds("La livraison ? C'est gratuit")).toEqual(["free_delivery"]);
    expect(kinds("L'installation est gratuite")).toEqual(["gift"]);
    expect(kinds("La livraison 400 DA et le montage gratuit")).toEqual(["gift"]);
  });
});

describe("a negated claim is no claim", () => {
  it.each([
    "ما عندناش تخفيض",
    "ماعندناش تخفيضات",
    "معندناش برومو هاد الشهر",
    "ماكانش promo",
    "ما كاين حتى تخفيض",
    "ما كاين لا برومو لا والو",
    "لا يوجد أي تخفيض",
    "التخفيض ماكانش دركا",
    "مكاش هدية",
    "مكانش هدية",
    "ما عندناش تخفيض ولا هدية",
    "التوصيل ماشي مجاني",
    "التوصيل مش مجاني",
    "التوصيل ماهوش مجاني",
    "التوصيل غير مجاني",
    "ماشي مضمون",
    "ماشي آخر حبة",
    "كمية غير محدودة",
    "ماشي الأحسن في السوق",
    "makach promo",
    "ma kanch tkhfid",
    "promo makach",
    "makach livraison gratuite",
    "la livraison mahich gratuite",
    "ma3andnach garantie",
    "pas de remise",
    "Le prix est fixe, pas de réduction",
    "nous ne faisons pas de remise",
    "On n'a pas de promo pour le moment",
    "aucune réduction",
    "pas de remise ni de cadeau",
    "Non, pas de cadeau",
    "la livraison n'est pas gratuite",
    "La livraison n'est plus gratuite",
    "il n'y a pas de livraison gratuite",
    "le produit n'est pas garanti",
    "sans garantie",
    "Non remboursable",
    "la quantité n'est pas limitée",
    "no discount",
    "We cannot offer a discount",
    "We don't have any discount right now",
    "Delivery is not free",
    "There is no free delivery",
    "Free delivery is no longer available",
    "No, it's not free",
    "No refunds",
    "Sorry, we don't do refunds",
    "I can't guarantee that",
    "No hurry, take your time",
  ])("%s", (text) => {
    expectNone([text]);
  });

  it("asked and answered no is no claim either", () => {
    expectNone(["Garantie ? Non, désolé.", "عندنا ضمان؟ لا"]);
  });

  it("keeps a claim that only stands near a negation", () => {
    // "Sans frais de livraison" promises; "sans" negates nothing there.
    expect(kinds("sans frais de livraison")).toEqual(["free_delivery"]);
    // A new clause after "mais" or "بصح".
    expect(kinds("pas de remise mais la livraison est gratuite")).toEqual(["free_delivery"]);
    expect(kinds("معندناش تخفيض بصح التوصيل مجاني")).toEqual(["free_delivery"]);
    // Only, not none.
    expect(kinds("Il n'y a que la livraison qui est gratuite")).toEqual(["free_delivery"]);
    expect(kinds("ما عندنا غير التوصيل المجاني")).toEqual(["free_delivery"]);
    expect(kinds("ما كاين غير تخفيض صغير")).toEqual(["discount"]);
    // "Don't worry", "don't miss": a reassurance or an urge, not a negation.
    expect(kinds("ما تقلقش المنتوج مضمون")).toEqual(["guarantee"]);
    expect(kinds("ما تضيعش فرصة التخفيض")).toEqual(["scarcity", "discount"]);
    // The negation belongs to a condition.
    expect(kinds("إذا ما عجبكش نرجعولك دراهمك")).toEqual(["guarantee"]);
    expect(kinds("Si vous n'êtes pas satisfait, on vous rembourse")).toEqual(["guarantee"]);
    expect(kinds("si vous n'êtes pas satisfait on vous rembourse")).toEqual(["guarantee"]);
    // A limit on a claim is still the claim.
    expect(kinds("التوصيل مجاني ماشي لكل الولايات")).toEqual(["free_delivery"]);
    expect(kinds("livraison gratuite, pas de frais cachés")).toEqual(["free_delivery"]);
  });
});

describe("what the shop allows", () => {
  it("a kind the shop wrote passes, in any language and words", () => {
    const shop = [...PLAIN_SHOP, "التوصيل مجاني لـ 10 ولايات"];
    expect(checkClaims("livraison gratuite", shop)).toBeNull();
    expect(checkClaims("Free delivery to Oran", shop)).toBeNull();
    expect(checkClaims("ليفريزون بلاش", shop)).toBeNull();
    // Only that kind: free delivery allows no discount.
    expect(checkClaims("livraison gratuite et -10%", shop)).toEqual({
      category: "NOT_IN_KB",
      reason: CLAIM_REASONS.discount,
      detail: "-10%",
    });
  });

  it("lets a card's own guarantee through", () => {
    expect(checkClaims("وفيه garantie 10 ans", [...PLAIN_SHOP, "Strengths:\n- Résiste aux rayures\n- Garantie 10 ans"])).toBeNull();
  });

  it("allows nothing the shop negated, forbade or answered no", () => {
    expect(checkClaims("كاين تخفيض", [...PLAIN_SHOP, "ما عندناش تخفيض"])?.reason).toBe(CLAIM_REASONS.discount);
    expect(checkClaims("remise de 10%", [...PLAIN_SHOP, "Ne promets jamais de remise"])?.reason).toBe(CLAIM_REASONS.discount);
    expect(checkClaims("التوصيل مجاني", [...PLAIN_SHOP, "ما تقولش للزبون بلي التوصيل مجاني"])?.reason).toBe(
      CLAIM_REASONS.free_delivery
    );
    // An FAQ entry: its title asks, its content answers.
    expect(checkClaims("garantie 1 an", [...PLAIN_SHOP, "Il y a une garantie ?", "Non."])?.reason).toBe(CLAIM_REASONS.guarantee);
    expect(checkClaims("garantie 1 an", [...PLAIN_SHOP, "Il y a une garantie ?", "Oui, 1 an."])).toBeNull();
    expect(checkClaims("ضمان عام", [...PLAIN_SHOP, "- Q: Garantie ?\n  A: Non, aucune."])?.reason).toBe(CLAIM_REASONS.guarantee);
  });

  it("lets free alone through when the shop offers free delivery or a gift", () => {
    expect(checkClaims("C'est gratuit dès 5000 DA", [...PLAIN_SHOP, "Livraison gratuite dès 5000 DA"])).toBeNull();
    expect(checkClaims("مجانا", [...PLAIN_SHOP, "هدية مع كل طلبية"])).toBeNull();
    // An FAQ answer that says "free" alone allows both.
    expect(checkClaims("La livraison est gratuite", [...PLAIN_SHOP, "La livraison est payante ?", "Non, c'est gratuit."])).toBeNull();
    expect(checkClaims("C'est gratuit", PLAIN_SHOP)).toEqual({
      category: "NOT_IN_KB",
      reason: CLAIM_REASONS.gift,
      detail: "gratuit",
    });
    expect(checkClaims("La livraison ? C'est gratuit", PLAIN_SHOP)?.reason).toBe(CLAIM_REASONS.free_delivery);
  });

  it("never takes a claim from the conversation", () => {
    const sources = { brand: PLAIN_SHOP, conversation: ["livraison gratuite ?", "كاين تخفيض؟", "c'est garanti ?", "آخر حبة؟"] };
    expect(checkReply("Oui, livraison gratuite", sources)).toEqual({
      category: "NOT_IN_KB",
      reason: GUARD_REASONS.freeDelivery,
      detail: "livraison gratuite",
    });
    expect(checkReply("إيه كاين تخفيض", sources)?.reason).toBe(GUARD_REASONS.discount);
    expect(checkReply("Oui, c'est garanti", sources)?.reason).toBe(GUARD_REASONS.guarantee);
    expect(checkReply("إيه آخر حبة", sources)?.reason).toBe(GUARD_REASONS.scarcity);
    // The same words from the shop pass.
    expect(checkReply("Oui, livraison gratuite", { brand: [...PLAIN_SHOP, "Livraison gratuite"], conversation: [] })).toBeNull();
  });

  it("stops at the first claim the shop did not make, and reads the shop only then", () => {
    const shop = [...PLAIN_SHOP, "Livraison gratuite"];
    expect(checkClaims("Livraison gratuite, et c'est le meilleur du marché", shop)).toEqual({
      category: "NOT_IN_KB",
      reason: CLAIM_REASONS.best,
      detail: "meilleur du marché",
    });
    expect(checkClaims("السعر 4500 دج", [])).toBeNull();
  });
});

describe("no false alarm", () => {
  it.each([
    // Prices, stock and delivery as the shop wrote them, in Darija
    "مرحبا بيك خويا، السعر 4500 دج والتوصيل 400 دج للعاصمة",
    "إيه متوفرة بالأحمر والأزرق، واش من مقاس تحب؟",
    "متوفر",
    "ماكانش دركا",
    "للأسف الأحمر ماكانش دركا، كاين غير الأزرق والأسود",
    "معليش خويا، هذا الموديل ماكانش عندنا",
    "ماكانش كيفو عندنا دركا",
    "الموديل هذا ماكانش دركا، يرجع قريب إن شاء الله",
    "التوصيل في 24 ساعة",
    "التوصيل لـ 58 ولاية",
    "التوصيل يدير 24 حتى 48 ساعة",
    "نوصلولك لباب الدار والخلاص كي توصلك",
    "الخلاص عند الاستلام",
    "عطيني اسمك ورقم الهاتف والولاية باش نأكدو الطلبية",
    "بقا غير نأكدو العنوان تاعك",
    "آخر موديل وصلنا",
    "آخر طلبية تاعك وصلت؟",
    "موديل آخر",
    "التركيب ساهل ونبعثولك الشرح",
    "نرجعولك",
    "نرجعولك في أقرب وقت",
    "ما تقلقش، نعيطولك قبل التوصيل",
    "إيه نقدرو نبدلولك المقاس إذا ما جاكش",
    "التوصيل لازم علينا نأكدوه",
    // Questions to the customer, recommendations and comparisons
    "واش تحب اللون الأحمر ولا الأزرق؟",
    "تحب التوصيل ولا تجي تديها؟",
    "شحال من حبة تحب؟",
    "واش أحسن ليك؟",
    "أحسن لون للصالون هو الرمادي",
    "هذا أرخص من الآخر",
    "اللون رقم 1 متوفر",
    "تصلح هدية لماماك",
    // Darija in Latin letters
    "salam khouya, soum 4500 DA w livraison 400 DA",
    "ma3lich, had lmodel makanch dorka",
    "ma kanch dorka",
    "livraison f 48h l ga3 les wilayas",
    "chwiya 5ir men lokhra",
    // French
    "Bonjour, le prix est de 4500 DA et la livraison coûte 400 DA",
    "Le prix est de 2500 DA/m²",
    "Livraison 400 DA à Alger",
    "Livraison en 48h partout en Algérie",
    "La livraison est payante : 400 DA",
    "Le paiement se fait à la livraison",
    "Paiement contre remboursement",
    "Désolé, ce modèle n'est plus disponible pour le moment",
    "Le rouge est en rupture de stock",
    "Il est disponible en stock",
    "Disponible en taille unique",
    "Le Lambris PVC est moins cher, mais il n'est pas disponible",
    "C'est le meilleur choix pour une salle de bain humide",
    "lequel est le mieux pour vous ?",
    "Vous cherchez le meilleur prix ?",
    "Est-ce le meilleur du marché ?",
    "C'est de meilleure qualité que l'autre",
    "Le modèle numéro 1 est en stock",
    "La couleur n°1 est disponible",
    "C'est un cadeau idéal pour la fête des mères",
    "On peut faire un emballage cadeau ?",
    "c'est pour offrir ?",
    "Remise en main propre possible à Alger",
    "Cette crème aide à la réduction des rides",
    "Il reste 2000 DA à payer à la livraison",
    "notre offre de livraison express est à 800 DA",
    "La livraison de votre commande est prise en charge par Yalidine",
    "N'hésitez pas si vous avez d'autres questions",
    "Pas de souci, on vous rappelle",
    "On peut échanger la taille si elle ne convient pas",
    // English
    "Hello! The price is 4500 DA and delivery is 400 DA",
    "Sorry, this model is out of stock right now",
    "Feel free to ask if you need anything else",
    "It makes a perfect gift for your mother",
    "The grey one is darker than the light oak",
    // Modern Standard Arabic
    "مرحباً، سعر المنتج 4500 دينار جزائري",
    "نعتذر، هذا المنتج غير متوفر حالياً",
    "يمكنك الدفع عند الاستلام",
    "مدة التوصيل من يومين إلى ثلاثة أيام",
  ])("%s", (reply) => {
    expect(checkClaims(reply, PLAIN_SHOP)).toBeNull();
  });
});

describe("the reasons", () => {
  it("are fixed English sentences, the same as the guard's", () => {
    expect(CLAIM_REASONS).toEqual({
      discount: "The reply promised a discount that is not in the knowledge base.",
      free_delivery: "The reply promised free delivery that is not in the knowledge base.",
      gift: "The reply promised a gift that is not in the knowledge base.",
      scarcity: "The reply claimed scarcity or urgency that is not in the knowledge base.",
      best: "The reply claimed the product is the best, which is not in the knowledge base.",
      guarantee: "The reply promised a guarantee or a refund that is not in the knowledge base.",
    });
    expect([GUARD_REASONS.discount, GUARD_REASONS.freeDelivery, GUARD_REASONS.gift]).toEqual([
      CLAIM_REASONS.discount,
      CLAIM_REASONS.free_delivery,
      CLAIM_REASONS.gift,
    ]);
    expect([GUARD_REASONS.scarcity, GUARD_REASONS.best, GUARD_REASONS.guarantee]).toEqual([
      CLAIM_REASONS.scarcity,
      CLAIM_REASONS.best,
      CLAIM_REASONS.guarantee,
    ]);
  });
});
