import { describe, expect, it } from "vitest";
import { checkReply, GUARD_REASONS, numberRuns, referenceNumbers } from "../../lib/bot/guard";
import {
  buildCatalogSection,
  CATALOG_INDEX_MAX_CHARS,
  catalogReferenceTexts,
  DEFAULT_MAX_FULL_CARDS,
  formatCatalogIndex,
  formatProductCard,
  mentionedProductIds,
  selectCardProducts,
  type CatalogAttribute,
  type CatalogProduct,
} from "../../lib/catalog/prompt";

function product(fields: Partial<CatalogProduct> & Pick<CatalogProduct, "id" | "name">): CatalogProduct {
  return {
    code: null,
    price: null,
    available: true,
    landingUrl: null,
    description: null,
    howToUse: null,
    attributes: {},
    strengths: [],
    comparisons: null,
    suitableFor: null,
    objections: [],
    variants: [],
    related: [],
    ...fields,
  };
}

const attributes: CatalogAttribute[] = [
  { key: "thickness", label: "السمك", type: "NUMBER", unit: "mm" },
  { key: "material", label: "Matière", type: "CHOICE", unit: null },
  { key: "waterproof", label: "مقاوم للماء", type: "BOOLEAN", unit: null },
  { key: "fireproof", label: "Ignifuge", type: "BOOLEAN", unit: null },
];

const parquet = product({
  id: "parquet",
  name: "Parquet Chêne",
  code: "WP-12",
  price: "2500 DA/m²",
  landingUrl: "https://shop.example/p/wp-12",
  description: "Parquet stratifié AC4.\nPose flottante.",
  howToUse: "Poser sur une sous-couche.",
  attributes: { thickness: 8, material: "HDF", waterproof: true, fireproof: false },
  strengths: ["Résiste aux rayures", "Garantie 10 ans"],
  comparisons: "Plus épais que le parquet standard.",
  suitableFor: "Salons et chambres.",
  objections: [{ question: "Est-ce que ça gonfle avec l'eau ?", answer: "Non, il résiste 24h à l'eau." }],
  variants: [
    { code: "12", name: "Chêne clair", available: true, price: null },
    { code: "17", name: "Noyer", available: false, price: "2500 DA/m²" },
    { code: "21", name: "Gris", available: true, price: "2800 DA/m²" },
  ],
  related: [
    { id: "lambris", name: "Lambris PVC", note: "moins cher" },
    { id: "noyer", name: "Parquet Noyer", note: null },
  ],
});
const lambris = product({
  id: "lambris",
  name: "Lambris PVC",
  code: "345",
  price: "1200 DA",
  available: false,
  variants: [{ code: "B-7", name: "Blanc", available: true, price: null }],
});
const sofa = product({ id: "sofa", name: "أريكة زاوية", price: "45000 DA" });
const cream = product({
  id: "cream",
  name: "Crème Hydratante",
  code: "CH-1",
  price: "1500 DA",
  variants: [
    { code: "A", name: "Peau sèche", available: true, price: null },
    { code: "B", name: "Peau grasse", available: true, price: null },
  ],
});
const mirror = product({ id: "mirror", name: "مرآة" });
const sweets = product({ id: "sweets", name: "حلوى" });
const bed = product({ id: "bed", name: "سرير" });
const door = product({ id: "door", name: "باب" });
const lin = product({ id: "lin", name: "Lin" });
const tv = product({ id: "tv", name: "TV", code: "TV-55" });

const catalog = [parquet, lambris, sofa, cream, mirror, sweets, bed, door, lin, tv];

const ids = (texts: string | string[], products: CatalogProduct[] = catalog) =>
  mentionedProductIds(products, Array.isArray(texts) ? texts : [texts]);

/** More products than the index can hold. */
const many = Array.from({ length: 600 }, (_, i) =>
  product({
    id: `m${i}`,
    name: `Produit ${i}`,
    code: `M-${i}`,
    price: `${1000 + i} DA`,
    variants: [{ code: `C${i}`, name: "Rouge", available: true, price: null }],
  })
);

describe("the index", () => {
  it("lists every product on one line: name, code, price, stock, and colours with their codes", () => {
    expect(formatCatalogIndex([parquet, lambris, sofa])).toBe(
      [
        "- Parquet Chêne | code: WP-12 | price: 2500 DA/m² | colours or types: 12 (Chêne clair); 17 (Noyer, OUT OF STOCK); 21 (Gris, price: 2800 DA/m²)",
        "- Lambris PVC | code: 345 | price: 1200 DA | OUT OF STOCK | colours or types: B-7 (Blanc)",
        "- أريكة زاوية | price: 45000 DA",
      ].join("\n")
    );
  });

  it("says when a product has no price, keeps every product on one line, and is empty without products", () => {
    expect(formatCatalogIndex([product({ id: "s", name: "Sac\ncabas", price: "  " })])).toBe(
      "- Sac / cabas | price: not in the catalog"
    );
    expect(formatCatalogIndex([])).toBe("");
  });

  it("stops at a whole line past its limit and says it was cut", () => {
    const index = formatCatalogIndex(many);
    const lines = index.split("\n");
    const note = lines.at(-1)!;
    expect(index.length).toBeLessThanOrEqual(CATALOG_INDEX_MAX_CHARS);
    expect(note).toMatch(/^\(The index was cut here/);
    expect(note).toContain("NOT_IN_KB");
    // Never half a line: half a line could show half a price.
    const kept = lines.slice(0, -1);
    expect(kept.length).toBeGreaterThan(100);
    expect(kept.length).toBeLessThan(many.length);
    kept.forEach((line, i) => expect(line).toBe(formatCatalogIndex([many[i]])));
    expect(index).not.toContain(`Produit ${many.length - 1}`);
    // The note brings no number the model could quote.
    expect(numberRuns(note)).toEqual([]);
  });
});

describe("the full card", () => {
  it("shows every section of a rich card, in order", () => {
    expect(formatProductCard(parquet, attributes)).toBe(
      [
        "#### Parquet Chêne",
        "Code: WP-12",
        "Price: 2500 DA/m²",
        "Availability: in stock",
        "Description: Parquet stratifié AC4.",
        "  Pose flottante.",
        "Characteristics:",
        "- السمك: 8 mm",
        "- Matière: HDF",
        "- مقاوم للماء: yes",
        "- Ignifuge: no",
        "How to use: Poser sur une sous-couche.",
        "Strengths:",
        "- Résiste aux rayures",
        "- Garantie 10 ans",
        "Comparisons: Plus épais que le parquet standard.",
        "Suitable for: Salons et chambres.",
        "Known questions and worries:",
        "- Q: Est-ce que ça gonfle avec l'eau ?",
        "  A: Non, il résiste 24h à l'eau.",
        "Colours or types:",
        "- 12: Chêne clair",
        "- 17: Noyer | OUT OF STOCK",
        "- 21: Gris | price: 2800 DA/m²",
        "Alternatives you may suggest:",
        "- Lambris PVC: moins cher",
        "- Parquet Noyer",
        "Product page: https://shop.example/p/wp-12",
      ].join("\n")
    );
  });

  it("leaves out every empty section, even one holding only blanks", () => {
    expect(formatProductCard(product({ id: "s", name: "Sac" }), attributes)).toBe(
      "#### Sac\nPrice: not in the catalog\nAvailability: in stock"
    );
    const blank = product({
      id: "b",
      name: "Sac",
      code: " ",
      available: false,
      description: "  \n ",
      attributes: { material: " " },
      strengths: ["", "  "],
      objections: [{ question: "Lavable ?", answer: " " }],
      variants: [{ code: " ", name: "Rouge", available: true, price: null }],
      related: [{ id: "x", name: " ", note: "moins cher" }],
      landingUrl: "",
    });
    expect(formatProductCard(blank, attributes)).toBe("#### Sac\nPrice: not in the catalog\nAvailability: OUT OF STOCK");
  });

  it("keeps the shop's answer to a worry even when the question was left empty", () => {
    const bag = product({ id: "b", name: "Sac", objections: [{ question: " ", answer: "Livraison en 48h" }] });
    expect(formatProductCard(bag, [])).toContain("Known questions and worries:\n- A: Livraison en 48h");
  });

  it("shows the brand's attributes with their own labels and units, in the template's order, booleans as yes or no", () => {
    const template: CatalogAttribute[] = [
      { key: "length", label: "الطول", type: "NUMBER", unit: "m" },
      { key: "width", label: "Largeur", type: "NUMBER", unit: "cm" },
      { key: "size", label: "Size", type: "TEXT", unit: "cm" },
      { key: "fabric", label: "القماش", type: "CHOICE", unit: null },
      { key: "washable", label: "Lavable", type: "BOOLEAN", unit: "x" },
      { key: "lined", label: "Doublée", type: "BOOLEAN", unit: null },
      { key: "imported", label: "Importée", type: "BOOLEAN", unit: null },
      { key: "notes", label: "Notes", type: "TEXT", unit: null },
      { key: "missing", label: "Absent", type: "TEXT", unit: null },
      { key: "blank", label: "Vide", type: "TEXT", unit: null },
    ];
    const curtain = product({
      id: "c",
      name: "Rideau",
      attributes: {
        notes: "Ligne 1\nLigne 2",
        length: 2.5,
        width: "140,5",
        size: "90 cm",
        fabric: "قطن",
        washable: true,
        lined: false,
        imported: "true",
        blank: "  ",
        stale: "ancienne valeur",
      },
    });
    const card = formatProductCard(curtain, template);
    expect(card).toContain(
      [
        "Characteristics:",
        "- الطول: 2.5 m",
        "- Largeur: 140,5 cm",
        "- Size: 90 cm",
        "- القماش: قطن",
        "- Lavable: yes",
        "- Doublée: no",
        "- Importée: yes",
        "- Notes: Ligne 1",
        "  Ligne 2",
      ].join("\n")
    );
    for (const absent of ["Absent", "Vide", "stale", "ancienne valeur"]) expect(card).not.toContain(absent);
  });

  it("keeps the lines of a value under its label, so they can never pass for a label or a new card", () => {
    const tricky = product({
      id: "t",
      name: "Robe\nKabyle",
      price: "4500 DA\r\n3900 DA en gros",
      description: "Belle robe.\r\nPrice: 10 DA\n\n#### Autre produit Availability: in stock",
      strengths: ["Légère\nCode: X-1"],
      objections: [{ question: "Taille ?\nA: aucune", answer: "S à XL\nselon le modèle" }],
      variants: [{ code: "R1", name: "Rouge\nvif", available: true, price: null }],
    });
    const card = formatProductCard(tricky, []);
    expect(card).toBe(
      [
        "#### Robe / Kabyle",
        "Price: 4500 DA / 3900 DA en gros",
        "Availability: in stock",
        "Description: Belle robe.",
        "  Price: 10 DA",
        "  #### Autre produit",
        "  Availability: in stock",
        "Strengths:",
        "- Légère",
        "  Code: X-1",
        "Known questions and worries:",
        "- Q: Taille ?",
        "     A: aucune",
        "  A: S à XL",
        "     selon le modèle",
        "Colours or types:",
        "- R1: Rouge / vif",
      ].join("\n")
    );
    const labels = card
      .split("\n")
      .filter((line) => !/^(?:\s|- )/.test(line))
      .map((line) => line.split(":")[0]);
    expect(labels).toEqual([
      "#### Robe / Kabyle",
      "Price",
      "Availability",
      "Description",
      "Strengths",
      "Known questions and worries",
      "Colours or types",
    ]);
    expect(formatCatalogIndex([tricky]).split("\n")).toHaveLength(1);
  });
});

describe("the products a conversation mentions", () => {
  describe("by code", () => {
    it.each(["wp-12", "WP 12", "ＷＰ１２", "wp_12", "WP–12", "Wp.12", "wp12", "WP-١٢", "شحال WP 12؟"])(
      "finds WP-12 written %s",
      (text) => {
        expect(ids(text)).toEqual(["parquet"]);
      }
    );

    it("reads Arabic-Indic and Persian digits", () => {
      expect(ids("٣٤٥")).toEqual(["lambris"]);
      expect(ids("بشحال ۳۴۵؟")).toEqual(["lambris"]);
      expect(ids("le 345 svp")).toEqual(["lambris"]);
      expect(ids("Blanc b7 ?")).toEqual(["lambris"]);
    });

    it("matches whole codes only", () => {
      for (const text of ["WP-120", "XWP-12", "wp12b", "3456", "1345", "TV-550"]) expect(ids(text)).toEqual([]);
    });

    it.each([
      "اللون 12",
      "لون ١٢",
      "باللون 12",
      "اللون12",
      "رقم 12",
      "الرقم: 12",
      "نمرة 12",
      "كود 12",
      "couleur 12",
      "la couleur n°12",
      "Nº 12",
      "numéro 12",
      "réf. 12",
      "code: 12",
      "color #12",
      "#12",
      "ref12",
      "les couleurs 12 et 17",
    ])("finds the short colour code in %s", (text) => {
      expect(ids(text)).toEqual(["parquet"]);
    });

    it.each(["نحب 12 حبة", "12", "j'en veux 12", "taille 12", "12 cm", "عندكم 12 لون؟", "Quelle couleur ? 12 pièces", "decode 12"])(
      "does not take the 12 of %s for a colour",
      (text) => {
        expect(ids(text)).toEqual([]);
      }
    );

    it("needs the same context for a one-letter code", () => {
      expect(ids("il a la peau sèche, c'est bon ?")).toEqual([]);
      expect(ids("le code A")).toEqual(["cream"]);
      expect(ids("#B")).toEqual(["cream"]);
    });
  });

  describe("by name", () => {
    it("ignores case and French accents", () => {
      for (const text of ["crème hydratante", "CREME HYDRATANTE", "Creme-Hydratante", "votre crème  hydratante ?"]) {
        expect(ids(text)).toEqual(["cream"]);
      }
      expect(ids("crèmes hydratantes")).toEqual([]);
      expect(ids("crème\nhydratante")).toEqual([]);
    });

    it("ignores hamza, taa marbuta and alef maqsura variations, diacritics and tatweel", () => {
      expect(ids("اريكه زاويه")).toEqual(["sofa"]);
      expect(ids("أَرِيكَة زاوِيَة")).toEqual(["sofa"]);
      expect(ids("شحال المراه؟")).toEqual(["mirror"]);
      expect(ids("حلوي")).toEqual(["sweets"]);
      expect(ids("ســرير")).toEqual(["bed"]);
    });

    it("allows the Arabic article and clitics on the name", () => {
      expect(ids("بالأريكة الزاوية")).toEqual(["sofa"]);
      expect(ids("والمرآة")).toEqual(["mirror"]);
      expect(ids("للباب")).toEqual(["door"]);
      expect(ids("الباب")).toEqual(["door"]);
    });

    it("matches whole words only: a name inside a longer word is not a mention", () => {
      expect(ids("le linge")).toEqual([]);
      expect(ids("du lin")).toEqual(["lin"]);
      expect(ids("بابور")).toEqual([]);
      expect(ids("ابواب")).toEqual([]);
      expect(ids("سريري")).toEqual([]);
    });

    it("never matches a name of fewer than three letters", () => {
      expect(ids("la tv")).toEqual([]);
      expect(ids("la TV-55")).toEqual(["tv"]);
    });

    it("takes a name inside a longer one as the longer one", () => {
      const lambris3d = product({ id: "lambris3d", name: "Lambris PVC 3D" });
      expect(ids("lambris pvc 3d", [lambris, lambris3d])).toEqual(["lambris3d"]);
      expect(ids("lambris pvc", [lambris, lambris3d])).toEqual(["lambris"]);
    });
  });

  it("lists the most recently mentioned first", () => {
    expect(ids(["Parquet Chêne ?", "et la crème hydratante", "WP-12 ou le 345 ?"])).toEqual(["lambris", "parquet", "cream"]);
    expect(ids(["أريكة زاوية؟", "و المرآة"])).toEqual(["mirror", "sofa"]);
    expect(ids(["مرآة و أريكة زاوية"])).toEqual(["sofa", "mirror"]);
    expect(ids([])).toEqual([]);
  });

  it("reads a colour code that several products share as the one the conversation named", () => {
    const wood = product({
      id: "wood",
      name: "Lambris Bois",
      variants: [{ code: "12", name: "Chêne", available: true, price: null }],
    });
    expect(ids("اللون 12", [parquet, wood])).toEqual(["parquet", "wood"]);
    expect(ids(["Lambris Bois", "اللون 12"], [parquet, wood])).toEqual(["wood"]);
  });
});

describe("choosing the full cards", () => {
  it("takes the campaign's product, then the focus in its order, then the mentions", () => {
    const cards = selectCardProducts(catalog, {
      campaignProductId: "sofa",
      focusIds: ["cream", "parquet"],
      mentionedIds: ["lambris", "parquet", "sofa"],
    });
    expect(cards.map((card) => card.id)).toEqual(["sofa", "cream", "parquet", "lambris"]);
  });

  it("skips duplicates and unknown ids, and stops at the limit", () => {
    const products = many.slice(0, 12);
    const all = products.map((item) => item.id);
    expect(selectCardProducts(products, { campaignProductId: "gone", mentionedIds: all }).map((card) => card.id)).toEqual(
      all.slice(0, DEFAULT_MAX_FULL_CARDS)
    );
    expect(
      selectCardProducts(products, { campaignProductId: null, focusIds: ["m3", "m3", "nope", "m1"], mentionedIds: ["m5"] }, 2).map(
        (card) => card.id
      )
    ).toEqual(["m3", "m1"]);
    expect(selectCardProducts(products, { mentionedIds: ["m1"] }, 0)).toEqual([]);
    expect(selectCardProducts(products, {})).toEqual([]);
  });
});

describe("the catalog section", () => {
  it("is empty when there are no products", () => {
    expect(buildCatalogSection([], [], attributes)).toBe("");
    expect(catalogReferenceTexts([], [], attributes)).toEqual([]);
  });

  it("gives the guide, then the index, then the full cards", () => {
    const section = buildCatalogSection(catalog, [parquet, sofa], attributes);
    const order = [
      "## PRODUCT CATALOG",
      "It is only a list.",
      "hand off with NOT_IN_KB",
      "### INDEX",
      formatCatalogIndex(catalog),
      "### FULL CARDS",
      formatProductCard(parquet, attributes),
      formatProductCard(sofa, attributes),
    ].map((marker) => section.indexOf(marker));
    expect(order.every((position) => position >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(section).not.toContain("No full card");
  });

  it("says so when no product has a full card", () => {
    const section = buildCatalogSection(catalog, [], attributes);
    expect(section).toContain("No full card is shown");
    expect(section).not.toContain("### FULL CARDS");
  });
});

describe("what the guard may accept", () => {
  const references = catalogReferenceTexts(catalog, [parquet], attributes);

  it("holds every price and code shown, and every number of the section", () => {
    const shown = references.join("\n");
    for (const text of ["2500 DA/m²", "2800 DA/m²", "1200 DA", "45000 DA", "1500 DA", "WP-12", "345", "B-7", "CH-1", "TV-55"]) {
      expect(shown).toContain(text);
    }
    const known = referenceNumbers(references);
    const section = buildCatalogSection(catalog, [parquet], attributes);
    expect(numberRuns(section).filter((run) => !known.has(run.full))).toEqual([]);
  });

  it("lets a reply quoting a card through and stops an invented price or link", () => {
    expect(checkReply("Le Parquet Chêne est à 2500 DA/m², la couleur 21 à 2800 DA/m².", references)).toBeNull();
    expect(checkReply("السمك 8 mm، وفيه garantie 10 ans", references)).toBeNull();
    expect(checkReply("Il résiste 24h à l'eau : https://shop.example/p/wp-12", references)).toBeNull();
    expect(checkReply("Le Lambris PVC est à 1200 DA, mais il n'est pas disponible.", references)).toBeNull();
    expect(checkReply("Le Parquet Chêne est à 2300 DA/m²", references)).toEqual({
      category: "NOT_IN_KB",
      reason: GUARD_REASONS.number,
      detail: "2300",
    });
    expect(checkReply("Promo ici : https://shop.example/promo", references)).toMatchObject({ reason: GUARD_REASONS.link });
  });

  it("knows nothing that was not shown", () => {
    // Without its card, the parquet's warranty is not known; its price is, from the index.
    const indexOnly = catalogReferenceTexts(catalog, [], attributes);
    expect(checkReply("Garantie 10 ans", indexOnly)?.detail).toBe("10");
    expect(checkReply("Le parquet est à 2500 DA/m²", indexOnly)).toBeNull();
    // A product past the cut of the index is unknown, until its card is shown.
    const last = many[many.length - 1];
    const reply = `Le ${last.name} est à ${last.price}`;
    expect(checkReply(reply, catalogReferenceTexts(many, [], []))?.reason).toBe(GUARD_REASONS.number);
    expect(checkReply(reply, catalogReferenceTexts(many, [last], []))).toBeNull();
  });
});
