import { describe, expect, it } from "vitest";
import {
  buildImportTemplate,
  IMPORT_SHEETS,
  matchImageFiles,
  parseImport,
  type ImportAttribute,
  type ImportRow,
  type Sheet,
  type TemplateProduct,
} from "../../lib/catalog/import/catalog";

const attributes: ImportAttribute[] = [
  { key: "thickness", label: "السمك", type: "NUMBER", unit: "mm", options: [] },
  { key: "material", label: "Matière", type: "CHOICE", unit: null, options: ["PVC", "Bois", "Aluminium"] },
  { key: "waterproof", label: "مقاوم للماء", type: "BOOLEAN", unit: null, options: [] },
  { key: "finish", label: "Finition", type: "TEXT", unit: null, options: [] },
];

function product(fields: Partial<TemplateProduct> & Pick<TemplateProduct, "name">): TemplateProduct {
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
    ...fields,
  };
}

const sheet = (name: string, rows: string[][]): Sheet => ({ name, rows });
const products = (rows: string[][]) => sheet(IMPORT_SHEETS.products, rows);
const colours = (rows: string[][]) => sheet(IMPORT_SHEETS.colours, rows);
const COLOUR_HEADERS = ["Code produit", "Code couleur", "Nom", "Disponible", "Prix"];

function parse(sheets: Sheet[], existing: Map<string, string> = new Map(), template = attributes) {
  return parseImport(sheets, template, existing);
}

function only(rows: ImportRow[]): ImportRow {
  expect(rows).toHaveLength(1);
  return rows[0];
}

function errorsOf(header: string[], row: string[], extra: Sheet[] = []): string[] {
  return only(parse([products([header, row]), ...extra]).rows).errors;
}

describe("buildImportTemplate", () => {
  const sheets = buildImportTemplate(attributes);
  const [productSheet, colourSheet, help] = sheets;

  it("has the products, colours and help sheets", () => {
    expect(sheets.map((s) => s.name)).toEqual(["Products", "Colours", "Read me"]);
    expect(productSheet.rows).toHaveLength(1);
    expect(colourSheet.rows).toHaveLength(1);
  });

  it("starts with the code, marks the required name, then one column per attribute with its unit", () => {
    const headers = productSheet.rows[0];
    expect(headers[0]).toMatch(/Code/);
    expect(headers[1]).toMatch(/Nom \*$/);
    expect(headers.filter((h) => h.endsWith("*"))).toEqual([headers[1]]);
    expect(headers.slice(-4)).toEqual(["السمك (mm)", "Matière", "مقاوم للماء", "Finition"]);
    expect(headers).toHaveLength(11 + 4);
  });

  it("gives the colours sheet its five columns, the two codes required", () => {
    const headers = colourSheet.rows[0];
    expect(headers).toHaveLength(5);
    expect(headers.filter((h) => h.endsWith("*"))).toHaveLength(2);
    expect(headers.join(" ")).toMatch(/Code produit.*Code couleur.*Nom de la couleur.*Disponible.*Prix/);
  });

  it("explains in Arabic and French, with the options of each list and the picture names", () => {
    const text = help.rows.map((row) => row.join(" | ")).join("\n");
    expect(help.rows[0]).toEqual(["العربية", "Français"]);
    expect(text).toContain("PVC | Bois | Aluminium");
    expect(text).toContain("WP-12.jpg");
    expect(text).toContain("WP-12_12-04.jpg");
    expect(text).toContain("12-04.jpg");
    expect(text).toMatch(/نعم.*لا/);
    expect(text).toMatch(/oui ou non/);
    expect(text).toContain("=>");
    expect(text).toContain("السمك (mm): رقم (mm)");
    expect(text).toContain("aperçu");
  });

  it("keeps two attributes with the same label apart", () => {
    const twins: ImportAttribute[] = [
      { key: "size", label: "Taille", type: "TEXT", unit: null, options: [] },
      { key: "size_2", label: "Taille", type: "NUMBER", unit: "cm", options: [] },
    ];
    const [template] = buildImportTemplate(twins);
    const headers = template.rows[0].slice(-2);
    expect(headers[0]).toBe("Taille");
    expect(headers[1]).toBe("Taille (cm) [size_2]");
    const filled = products([template.rows[0], [...template.rows[0].slice(0, -2).map(() => ""), "L", "40"]]);
    filled.rows[1][1] = "Rideau";
    const row = only(parseImport([filled], twins, new Map()).rows);
    expect(row.input?.attributes).toEqual({ size: "L", size_2: 40 });
  });

  it("has no attribute columns or attribute help for a brand without attributes", () => {
    const [template, , readMe] = buildImportTemplate([]);
    expect(template.rows[0]).toHaveLength(11);
    expect(readMe.rows.some((row) => row[1].includes("caractéristiques"))).toBe(false);
  });
});

describe("a filled template, read back", () => {
  const arabic = product({
    code: "WP-12",
    name: "ورق جدران ثلاثي الأبعاد",
    price: "1200 دج للمتر",
    available: true,
    landingUrl: "https://example.com/wp-12",
    description: "ورق جدران مقاوم للرطوبة.\nسهل التنظيف.",
    howToUse: "ينزع الغلاف ويلصق مباشرة على الحائط",
    attributes: { thickness: 3.5, material: "PVC", waterproof: true, finish: "لامع" },
    strengths: ["لا يحتاج غراء", "يدوم سنوات"],
    comparisons: "أرخص من الدهان",
    suitableFor: "المطبخ والحمام",
    objections: [
      { question: "واش يطيح مع الرطوبة؟", answer: "لا، مقاوم للماء" },
      { question: "كاين التوصيل؟", answer: "نعم، 58 ولاية" },
    ],
    variants: [
      { code: "12-04", name: "رمادي", available: true, price: null },
      { code: "12-05", name: "أبيض", available: false, price: "1300 دج" },
    ],
  });
  const french = product({
    code: "RD 7",
    name: "Rideau occultant",
    price: "3500 DA",
    available: false,
    attributes: { material: "Bois", waterproof: false },
    strengths: ["Bloque 99 % de la lumière"],
    objections: [{ question: "Ça passe en machine ?", answer: "Oui, à 30 °C => sans essorage" }],
    variants: [{ code: "B", name: "Beige", available: true, price: null }],
  });
  const uncoded = product({ name: "Coussin", price: "800 DA" });

  const sheets = buildImportTemplate(attributes, [arabic, french, uncoded]);

  it("writes one product per row, colours under their product's code", () => {
    expect(sheets[0].rows).toHaveLength(4);
    expect(sheets[0].rows[1][0]).toBe("WP-12");
    expect(sheets[0].rows[2][3]).toBe("non");
    expect(sheets[1].rows.slice(1)).toEqual([
      ["WP-12", "12-04", "رمادي", "oui", ""],
      ["WP-12", "12-05", "أبيض", "non", "1300 دج"],
      ["RD 7", "B", "Beige", "oui", ""],
    ]);
  });

  it("parses back into the same cards, as drafts, updating the codes the brand has", () => {
    const { rows, problems } = parse(sheets, new Map([["WP12", "prod_1"]]));
    expect(problems).toEqual([]);
    expect(rows.map((row) => [row.row, row.code, row.action, row.errors])).toEqual([
      [2, "WP-12", "update", []],
      [3, "RD 7", "create", []],
      [4, null, "create", []],
    ]);
    expect(rows.every((row) => row.input?.status === "ACTIVE")).toBe(true);

    expect(rows[0].input).toEqual({
      name: arabic.name,
      code: "WP-12",
      price: "1200 دج للمتر",
      available: true,
      status: "ACTIVE",
      landingUrl: "https://example.com/wp-12",
      description: arabic.description,
      howToUse: arabic.howToUse,
      attributes: { thickness: 3.5, material: "PVC", waterproof: true, finish: "لامع" },
      strengths: arabic.strengths,
      comparisons: arabic.comparisons,
      suitableFor: arabic.suitableFor,
      objections: arabic.objections,
      variants: [
        { code: "12-04", name: "رمادي", available: true, price: null, imageId: null },
        { code: "12-05", name: "أبيض", available: false, price: "1300 دج", imageId: null },
      ],
      related: [],
      mainImageId: null,
    });
    expect(rows[1].input).toMatchObject({
      name: "Rideau occultant",
      code: "RD 7",
      available: false,
      attributes: { material: "Bois", waterproof: false },
      // Only the first "=>" splits: the answer keeps its own.
      objections: [{ question: "Ça passe en machine ?", answer: "Oui, à 30 °C => sans essorage" }],
      variants: [{ code: "B", name: "Beige", available: true, price: null, imageId: null }],
    });
    expect(rows[2]).toMatchObject({ name: "Coussin", code: null, input: { code: null, price: "800 DA", variants: [] } });
  });

  it("writes a line break inside a strength or an objection as a space, so each stays one item", () => {
    const [template] = buildImportTemplate(attributes, [
      product({ name: "X", strengths: ["un\ndeux"], objections: [{ question: "q\n?", answer: "a\nb" }] }),
    ]);
    expect(template.rows[1][7]).toBe("un deux");
    expect(template.rows[1][10]).toBe("q ? => a b");
  });
});

describe("parseImport headers", () => {
  it("matches headers whatever their case, accents, spaces and language", () => {
    const header = ["REF", "nom du produit", "prix", "DISPONIBILITE", "Lien", "الوصف", "Mode d’emploi", "points  forts", "Comparaison", "Pour qui", "FAQ", "السُّمك", "matiere", "Waterproof", "finish"];
    const template: ImportAttribute[] = [
      ...attributes.slice(0, 3),
      { key: "waterproof_en", label: "Waterproof", type: "BOOLEAN", unit: null, options: [] },
      { key: "finish", label: "Finition", type: "TEXT", unit: null, options: [] },
    ];
    const row = only(
      parse(
        [products([header, ["A1", "Store", "10", "oui", "https://a.dz", "وصف", "Visser", "Solide", "Mieux", "Salon", "Prix ? => 10", "2", "pvc", "yes", "mat"]])],
        new Map(),
        template
      ).rows
    );
    expect(row.errors).toEqual([]);
    expect(row.input).toMatchObject({
      code: "A1",
      name: "Store",
      price: "10",
      available: true,
      landingUrl: "https://a.dz",
      description: "وصف",
      howToUse: "Visser",
      strengths: ["Solide"],
      comparisons: "Mieux",
      suitableFor: "Salon",
      objections: [{ question: "Prix ?", answer: "10" }],
      attributes: { thickness: 2, material: "PVC", waterproof_en: true, finish: "mat" },
    });
  });

  it("reads Arabic and English names, and an attribute by its label with its unit or by its key", () => {
    const { rows, problems } = parse([
      products([
        ["الكود", "الاسم", "السعر", "متوفر", "السمك (mm)", "material"],
        ["١٢", "باب", "5000 دج", "لا", "40", "Aluminium"],
      ]),
    ]);
    expect(problems).toEqual([]);
    expect(only(rows).input).toMatchObject({
      code: "١٢",
      name: "باب",
      price: "5000 دج",
      available: false,
      attributes: { thickness: 40, material: "Aluminium" },
    });
  });

  it("gives a brand's attribute the header it shares with a base field's usual name", () => {
    const template: ImportAttribute[] = [{ key: "usage", label: "Usage", type: "TEXT", unit: null, options: [] }];
    const row = only(parse([products([["Nom", "Usage"], ["Lampe", "Extérieur"]])], new Map(), template).rows);
    expect(row.input).toMatchObject({ howToUse: null, attributes: { usage: "Extérieur" } });
  });

  it("reports an unknown, a repeated and an unnamed column once each, and still reads the rest", () => {
    const { rows, problems } = parse([
      products([
        ["Nom", "Couleur préférée", "Prix", "price", ""],
        ["Lampe", "rouge", "10", "20", "lost"],
        ["Table", "vert", "30", "40", "lost too"],
      ]),
    ]);
    expect(problems).toEqual([
      { sheet: "Products", row: 1, message: 'Unknown column "Couleur préférée"; it was not read.' },
      { sheet: "Products", row: 1, message: 'The column "price" repeats "Prix"; only the first one is read.' },
      { sheet: "Products", row: 1, message: "Column E has no header; it was not read." },
    ]);
    expect(rows.map((row) => row.input?.price)).toEqual(["10", "30"]);
  });

  it("ignores a header without data under it, finds the header below empty rows, and skips empty rows", () => {
    const { rows, problems } = parse([
      products([
        [],
        ["", ""],
        ["Nom", "Prix", ""],
        ["Lampe", "10", ""],
        ["", "  ", ""],
        ["Table", "", ""],
      ]),
    ]);
    expect(problems).toEqual([]);
    expect(rows.map((row) => [row.row, row.name])).toEqual([
      [4, "Lampe"],
      [6, "Table"],
    ]);
  });

  it("reads a single sheet of any name (a CSV) as the products, and colours from a French-named sheet", () => {
    const { rows, problems } = parse([
      sheet("catalogue.csv", [["Code", "Nom"], ["WP-1", "Store"]]),
      sheet("Couleurs", [COLOUR_HEADERS, ["WP-1", "3", "", "", ""]]),
      sheet("Lisez-moi", [["anything"]]),
    ]);
    expect(problems).toEqual([]);
    expect(only(rows).input?.variants).toEqual([{ code: "3", name: null, available: true, price: null, imageId: null }]);
  });
});

describe("parseImport values", () => {
  const header = ["Code", "Nom", "Disponible"];

  it.each([
    ["نعم", true],
    ["لا", false],
    ["Oui", true],
    ["NON", false],
    ["yes", true],
    ["no", false],
    ["1", true],
    ["0", false],
    ["x", true],
    ["X", true],
    ["✓", true],
    ["", true],
  ])("reads available %j as %s", (word, value) => {
    expect(only(parse([products([header, ["A", "Lampe", word]])]).rows).input?.available).toBe(value);
  });

  it("takes the import's yes/no words, options in any case or accent, and numbers with their unit", () => {
    const row = only(
      parse([
        products([
          ["Nom", "السمك (mm)", "Matière", "مقاوم للماء"],
          ["Lampe", "3,5 mm", "aluminium", "x"],
        ]),
      ]).rows
    );
    expect(row.input?.attributes).toEqual({ thickness: 3.5, material: "Aluminium", waterproof: true });
  });

  it("reads strengths one per line without their bullets, and leaves empty attributes out", () => {
    const row = only(parse([products([["Nom", "Points forts", "Finition"], ["Lampe", "• Solide\r\n\n- Léger \n", ""]])]).rows);
    expect(row.input).toMatchObject({ strengths: ["Solide", "Léger"], attributes: {} });
  });
});

describe("parseImport errors", () => {
  it("needs a name, even without a code", () => {
    const { rows } = parse([products([["Code", "Nom", "Prix"], ["", "", "10"], ["WP-1", "", ""]])]);
    expect(rows.map((row) => [row.action, row.errors, row.input])).toEqual([
      ["error", ["Nom: Give the product a name."], null],
      ["error", ["Nom: Give the product a name."], null],
    ]);
  });

  it("refuses a code without a letter or a digit", () => {
    expect(errorsOf(["Code", "Nom"], ["---", "Lampe"])).toEqual(["Code: A code needs a letter or a digit."]);
  });

  it("refuses a link that is not http or https", () => {
    expect(errorsOf(["Nom", "Lien"], ["Lampe", "javascript:alert(1)"])).toEqual(["Lien: Use an http or https link."]);
  });

  it("refuses a word that is neither yes nor no", () => {
    expect(errorsOf(["Nom", "Disponible"], ["Lampe", "peut-être"])).toEqual(['Disponible: answer yes or no (not "peut-être").']);
  });

  it("refuses attribute values that don't fit their type, naming the attribute", () => {
    expect(errorsOf(["Nom", "السمك", "Matière", "مقاوم للماء"], ["Lampe", "épais", "Verre", "bof"])).toEqual([
      "السمك: write a number, like 12 or 1.5.",
      "Matière: pick one of its options.",
      "مقاوم للماء: answer yes or no.",
    ]);
  });

  it("refuses an objection without its answer", () => {
    expect(errorsOf(["Nom", "Objections"], ["Lampe", "Prix ? => 10\nLivraison ?"])).toEqual([
      'Objections (line 2): write it as "question => answer".',
    ]);
    expect(errorsOf(["Nom", "Objections"], ["Lampe", "Prix ? =>"])).toEqual(["Objections (line 1): Write the answer."]);
  });

  it("says what is too long or too many, shortly", () => {
    expect(errorsOf(["Nom"], ["x".repeat(201)])).toEqual(["Nom: at most 200 characters."]);
    const strengths = Array.from({ length: 21 }, (_, i) => `point ${i}`).join("\n");
    expect(errorsOf(["Nom", "Points forts"], ["Lampe", strengths])).toEqual(["Points forts: at most 20 lines."]);
    expect(errorsOf(["Nom", "Points forts"], ["Lampe", `ok\n${"y".repeat(301)}`])).toEqual([
      "Points forts (line 2): at most 300 characters.",
    ]);
  });

  it("cuts a huge cell and echoes nothing long", () => {
    const errors = errorsOf(["Nom", "Disponible"], ["Lampe", "z".repeat(1_000_000)]);
    expect(errors).toHaveLength(1);
    expect(errors[0].length).toBeLessThan(80);
  });

  it("refuses a code repeated in the file on its second row, however it is written", () => {
    const { rows } = parse([products([["Code", "Nom"], ["WP-12", "A"], ["B", "B"], ["wp 12", "C"]])]);
    expect(rows.map((row) => [row.code, row.action, row.errors])).toEqual([
      ["WP-12", "create", []],
      ["B", "create", []],
      ["wp 12", "error", ["Code: wp 12 is already on row 2."]],
    ]);
  });

  it("reports a file without products, an empty products sheet, a missing name column and an unread sheet", () => {
    expect(parse([]).problems).toEqual([{ sheet: "", row: 0, message: 'No "Products" sheet in the file.' }]);
    expect(parse([colours([COLOUR_HEADERS])]).problems).toEqual([{ sheet: "", row: 0, message: 'No "Products" sheet in the file.' }]);
    expect(parse([products([["Nom"]])]).problems).toEqual([{ sheet: "Products", row: 0, message: "No products in the sheet." }]);
    expect(parse([products([])]).problems).toEqual([{ sheet: "Products", row: 0, message: "No products in the sheet." }]);

    const noName = parse([products([["Code", "Prix"], ["A", "1"]])]);
    expect(noName.problems).toEqual([{ sheet: "Products", row: 0, message: 'No column for the name ("الاسم / Nom *").' }]);
    expect(only(noName.rows).errors).toEqual(["Name: Give the product a name."]);

    expect(parse([products([["Nom"], ["A"]]), sheet("Feuil3", [["x"]])]).problems).toEqual([
      { sheet: "Feuil3", row: 0, message: 'The sheet "Feuil3" was not read.' },
    ]);
  });

  it("never throws, whatever it is given", () => {
    const garbage: unknown[] = [
      null,
      "text",
      [null, 3, { name: 1 }],
      [{ name: "Products", rows: [null, ["Nom", 4], [7, { a: 1 }], "row"] }],
      [{ name: "Products", rows: [["Nom"], ["A"]] }],
    ];
    for (const sheets of garbage) {
      expect(() => parseImport(sheets as Sheet[], null as unknown as ImportAttribute[], null as unknown as Map<string, string>)).not.toThrow();
    }
    const numbers = parseImport([{ name: "Products", rows: [["Nom", "Prix"], [7, 12]] }] as unknown as Sheet[], [], new Map());
    expect(only(numbers.rows).input).toMatchObject({ name: "7", price: "12" });
  });

  it("stops at the products limit", () => {
    const rows = [["Nom"], ...Array.from({ length: 2001 }, (_, i) => [`P${i}`])];
    const result = parse([products(rows)]);
    expect(result.rows).toHaveLength(2000);
    expect(result.problems).toEqual([{ sheet: "Products", row: 2002, message: "Only the first 2000 rows are read." }]);
  });
});

describe("parseImport colours", () => {
  const productRows = [
    ["Code", "Nom"],
    ["WP-12", "Papier peint"],
    ["RD-7", "Rideau"],
    ["wp_12", "Doublon"],
  ];

  it("groups colours by product code, in the file's order, onto the first row with that code", () => {
    const { rows, problems } = parse([
      products(productRows),
      colours([
        COLOUR_HEADERS,
        ["wp 12", "12-04", "Gris", "oui", ""],
        ["RD-7", "B", "Beige", "non", "4000 DA"],
        ["WP-12", "12-05", "Blanc", "", "1300 DA"],
      ]),
    ]);
    expect(problems).toEqual([]);
    expect(rows[0].input?.variants).toEqual([
      { code: "12-04", name: "Gris", available: true, price: null, imageId: null },
      { code: "12-05", name: "Blanc", available: true, price: "1300 DA", imageId: null },
    ]);
    expect(rows[1].input?.variants).toEqual([{ code: "B", name: "Beige", available: false, price: "4000 DA", imageId: null }]);
    expect(rows[2].action).toBe("error");
  });

  it("reports colours of an unknown product, or without a product code", () => {
    const { rows, problems } = parse([
      products(productRows.slice(0, 2)),
      colours([COLOUR_HEADERS, ["ZZ-9", "1", "", "", ""], ["", "2", "", "", ""]]),
    ]);
    expect(problems).toEqual([
      { sheet: "Colours", row: 2, message: "No product with the code ZZ-9 in the Products sheet." },
      { sheet: "Colours", row: 3, message: "Code produit: give the product's code." },
    ]);
    expect(only(rows).action).toBe("create");
  });

  it("puts a colour's errors on its product's row", () => {
    const { rows } = parse([
      products(productRows.slice(0, 2)),
      colours([
        COLOUR_HEADERS,
        ["WP-12", "1", "", "bof", ""],
        ["WP-12", "", "Sans code", "", ""],
        ["WP-12", " 1 ", "", "", ""],
      ]),
    ]);
    expect(only(rows)).toMatchObject({
      action: "error",
      input: null,
      errors: [
        'Colours row 2: Disponible: answer yes or no (not "bof").',
        "Colours row 3: Code couleur: Give each colour or type its code.",
        "Colours row 4: Code couleur: The code 1 is used twice.",
      ],
    });
  });

  it("refuses more than 60 colours for one product", () => {
    const many = Array.from({ length: 61 }, (_, i) => ["WP-12", `C${i}`, "", "", ""]);
    const { rows } = parse([products(productRows.slice(0, 2)), colours([COLOUR_HEADERS, ...many])]);
    expect(only(rows).errors).toEqual(["Colours: at most 60 colours per product."]);
  });
});

describe("parseImport create or update", () => {
  it("updates when the brand has the code (however either is written), creates otherwise", () => {
    const existing = new Map([
      ["WP12", "p1"],
      ["rd-7", "p2"],
    ]);
    const { rows } = parse(
      [products([["Code", "Nom"], ["wp-12", "A"], ["RD 7", "B"], ["NEW-1", "C"], ["", "D"]])],
      existing
    );
    expect(rows.map((row) => row.action)).toEqual(["update", "update", "create", "create"]);
  });

  it("makes every imported card active, whatever a status column says: the file has no say", () => {
    const { rows, problems } = parse([products([["Nom", "Status"], ["A", "ARCHIVED"]])]);
    expect(only(rows).input?.status).toBe("ACTIVE");
    expect(problems).toEqual([{ sheet: "Products", row: 1, message: 'Unknown column "Status"; it was not read.' }]);
  });
});

describe("matchImageFiles", () => {
  const catalog = [
    { code: "WP-12", variantCodes: ["12-04", "12-05", "01"] },
    { code: "WP-13", variantCodes: ["13-01", "01"] },
    { code: "RD 7", variantCodes: [] },
  ];

  it("matches a product's picture however its code is written", () => {
    const { matched, unmatched } = matchImageFiles(["WP-12.jpg", "wp_13.png", "RD 7.webp"], catalog);
    expect(unmatched).toEqual([]);
    expect(matched).toEqual([
      { fileName: "WP-12.jpg", productCode: "WP-12", variantCode: null },
      { fileName: "wp_13.png", productCode: "WP-13", variantCode: null },
      { fileName: "RD 7.webp", productCode: "RD 7", variantCode: null },
    ]);
  });

  it("matches a colour by product and colour code, or by a colour code only one product has", () => {
    const { matched, unmatched } = matchImageFiles(
      ["photos/WP-12_12-04.jpg", "C:\\photos\\WP-12 12-05.JPEG", "13-01.png", "WP-13_01.jpg", "wp 12 01.webp"],
      catalog
    );
    expect(unmatched).toEqual([]);
    expect(matched.map(({ productCode, variantCode }) => [productCode, variantCode])).toEqual([
      ["WP-12", "12-04"],
      ["WP-12", "12-05"],
      ["WP-13", "13-01"],
      ["WP-13", "01"],
      ["WP-12", "01"],
    ]);
    expect(matched[1].fileName).toBe("C:\\photos\\WP-12 12-05.JPEG");
  });

  it("leaves out a colour code several products have", () => {
    const { matched, unmatched } = matchImageFiles(["01.jpg"], catalog);
    expect(matched).toEqual([]);
    expect(unmatched).toEqual([{ fileName: "01.jpg", reason: "ambiguous: could be WP-12 01, WP-13 01" }]);
  });

  it("leaves out a name that is both a product's code and another's colour", () => {
    const { unmatched } = matchImageFiles(["7.jpg"], [
      { code: "7", variantCodes: [] },
      { code: "RD", variantCodes: ["7"] },
    ]);
    expect(unmatched[0].reason).toMatch(/^ambiguous/);
  });

  it("leaves out non-pictures, hidden files, unknown codes and a second file for the same picture", () => {
    const { matched, unmatched } = matchImageFiles(
      ["WP-12.gif", "notes.txt", "WP-12", ".DS_Store", "__MACOSX/._WP-12.jpg", "ZZ-1.jpg", "WP-12_99.jpg", "WP-12.jpg", "wp12.png", "---.jpg"],
      catalog
    );
    expect(matched).toEqual([{ fileName: "WP-12.jpg", productCode: "WP-12", variantCode: null }]);
    expect(unmatched).toEqual([
      { fileName: "WP-12.gif", reason: "not a picture (jpg, jpeg, png or webp)" },
      { fileName: "notes.txt", reason: "not a picture (jpg, jpeg, png or webp)" },
      { fileName: "WP-12", reason: "not a picture (jpg, jpeg, png or webp)" },
      { fileName: ".DS_Store", reason: "not a picture (jpg, jpeg, png or webp)" },
      { fileName: "__MACOSX/._WP-12.jpg", reason: "not a picture (jpg, jpeg, png or webp)" },
      { fileName: "ZZ-1.jpg", reason: "no product or colour has this code" },
      { fileName: "WP-12_99.jpg", reason: "no product or colour has this code" },
      { fileName: "wp12.png", reason: "duplicate: WP-12.jpg is already this picture" },
      { fileName: "---.jpg", reason: "no code in the name" },
    ]);
  });

  it("never throws on odd input, and bounds the names it echoes", () => {
    expect(() => matchImageFiles(null as unknown as string[], null as unknown as [])).not.toThrow();
    const { unmatched } = matchImageFiles([`${"a".repeat(1000)}.jpg`, 5 as unknown as string], catalog);
    expect(unmatched[0].fileName.length).toBeLessThanOrEqual(255);
    expect(unmatched).toHaveLength(2);
  });
});
