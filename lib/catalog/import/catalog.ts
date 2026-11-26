/**
 * Product cards from a spreadsheet: the template a brand downloads (made for
 * its own attributes), the preview of a filled file (what would be created,
 * updated, or refused, row by row), and the pictures of a folder matched to
 * products and colours by their file names.
 *
 * Pure: no database, no files. The codec (./xlsx, or CSV) turns a file into
 * sheets of text cells, row 0 holding the headers; the caller looks up which
 * codes the brand already has, and writes the cards once a person confirms.
 * Every cell is untrusted: cut to a bounded length, checked by the same schema
 * as the product form, and echoed back only as a short single line.
 */
import { cleanAttributeValues, type AttributeValue } from "../attributes";
import { codeKeyOf, MAX_CODE_LENGTH, normalizeCode } from "../codes";
import { MAX_PRODUCTS, productInputSchema, type ProductInput } from "../products";

/** A sheet as the codec reads or writes it: row 0 holds the headers. */
export interface Sheet {
  name: string;
  rows: string[][];
}

export interface ImportAttribute {
  key: string;
  label: string;
  type: "TEXT" | "NUMBER" | "CHOICE" | "BOOLEAN";
  unit: string | null;
  options: string[];
}

export const IMPORT_SHEETS = { products: "Products", colours: "Colours", help: "Read me" } as const;

/** A card as the template exports it (round trip). */
export interface TemplateProduct {
  code: string | null;
  name: string;
  price: string | null;
  available: boolean;
  landingUrl: string | null;
  description: string | null;
  howToUse: string | null;
  attributes: Record<string, string | number | boolean>;
  strengths: string[];
  comparisons: string | null;
  suitableFor: string | null;
  objections: { question: string; answer: string }[];
  variants: { code: string; name: string | null; available: boolean; price: string | null }[];
}

export interface ImportRow {
  sheet: string;
  /** As the spreadsheet numbers it: the header is row 1. */
  row: number;
  code: string | null;
  name: string | null;
  action: "create" | "update" | "error";
  errors: string[];
  /** Ready for createProduct (ACTIVE: a person typed it and confirms the preview); null when action is "error". */
  input: ProductInput | null;
}

export interface ImportProblem {
  sheet: string;
  /** The spreadsheet's row number, or 0 for the sheet or the file as a whole. */
  row: number;
  message: string;
}

export interface ImageMatch {
  fileName: string;
  productCode: string;
  variantCode: string | null;
}

// ─── Limits ─────────────────────────────────────────────────────────────────

/** Longer than any field allows (4000), so a cut cell still fails its check. */
const MAX_CELL_CHARS = 10_000;
const MAX_COLUMNS = 200;
const MAX_COLOUR_ROWS = 20_000;
const MAX_ROW_ERRORS = 10;
const MAX_FILES = 10_000;
const MAX_FILE_NAME = 255;
/** How much of a header or a value a message echoes. */
const SHOWN_CHARS = 60;

// ─── Text ───────────────────────────────────────────────────────────────────

/** Whatever the codec gave, as bounded text with plain line breaks. */
function cellText(value: unknown): string {
  let text = "";
  if (typeof value === "string") text = value;
  else if (typeof value === "number" || typeof value === "boolean") text = String(value);
  return text.slice(0, MAX_CELL_CHARS).replace(/\r\n?/g, "\n");
}

/** By code points, so a letter outside the BMP is never cut in half. */
function cut(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : value;
}

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** For messages and the preview: one short line. */
function shown(value: string, max = SHOWN_CHARS): string {
  return cut(collapse(value), max);
}

/**
 * Headers and words compared the way people type them: no case, no accents
 * or harakat, the Arabic letter forms folded (أ إ آ → ا, ة → ه, ى → ي), and
 * nothing but letters and digits.
 */
function fold(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/ٱ/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/[^\p{L}\p{Nd}]+/gu, "");
}

function lines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

// ─── Yes and no ─────────────────────────────────────────────────────────────

const YES_WORDS = ["yes", "y", "true", "oui", "o", "vrai", "1", "x", "نعم", "ايه", "واه", "disponible", "dispo", "en stock", "متوفر", "متوفره"];
const NO_WORDS = ["no", "n", "false", "non", "faux", "0", "لا", "indisponible", "non disponible", "rupture", "غير متوفر", "غير متوفره"];
const YES = new Set(YES_WORDS.map(fold));
const NO = new Set(NO_WORDS.map(fold));
const YES_MARKS = new Set(["✓", "✔", "☑", "✅"]);
const NO_MARKS = new Set(["✗", "✘", "×", "❌"]);

/** null for an empty cell, undefined for a word that is neither. */
function yesNo(raw: string): boolean | null | undefined {
  const text = raw.trim();
  if (!text) return null;
  if (YES_MARKS.has(text)) return true;
  if (NO_MARKS.has(text)) return false;
  const word = fold(text);
  if (YES.has(word)) return true;
  if (NO.has(word)) return false;
  return undefined;
}

/** The word the template writes: understood back by yesNo. */
function yesNoWord(value: boolean): string {
  return value ? "oui" : "non";
}

// ─── Columns ────────────────────────────────────────────────────────────────

type ProductField =
  | "code"
  | "name"
  | "price"
  | "available"
  | "landingUrl"
  | "description"
  | "howToUse"
  | "strengths"
  | "comparisons"
  | "suitableFor"
  | "objections";

type ColourField = "productCode" | "code" | "name" | "available" | "price";

interface FieldDef<F extends string> {
  field: F;
  /** The template's header: Arabic / French, * when required. */
  header: string;
  /** Used in messages when the file has no such column. */
  label: string;
  /** Other ways people name the column, in Arabic, French and English. */
  names: string[];
}

const PRODUCT_FIELDS: FieldDef<ProductField>[] = [
  {
    field: "code",
    header: "الكود / Code",
    label: "Code",
    names: ["code", "كود", "الكود", "رمز", "الرمز", "رقم", "الرقم", "référence", "ref", "réf", "sku", "product code", "code produit"],
  },
  {
    field: "name",
    header: "الاسم / Nom *",
    label: "Name",
    names: ["name", "nom", "اسم", "الاسم", "اسم المنتج", "product", "product name", "produit", "nom du produit", "désignation", "المنتج"],
  },
  { field: "price", header: "السعر / Prix", label: "Price", names: ["price", "prix", "سعر", "السعر", "tarif", "الثمن", "ثمن"] },
  {
    field: "available",
    header: "متوفر / Disponible",
    label: "Available",
    names: ["available", "availability", "in stock", "stock", "disponible", "disponibilité", "en stock", "متوفر", "التوفر", "متوفره"],
  },
  {
    field: "landingUrl",
    header: "رابط صفحة الهبوط / Lien de la page",
    label: "Landing page",
    names: ["landing url", "landing page", "url", "link", "lien", "page", "lien de la page", "رابط", "الرابط", "صفحة الهبوط", "رابط الصفحة"],
  },
  { field: "description", header: "الوصف / Description", label: "Description", names: ["description", "وصف", "الوصف"] },
  {
    field: "howToUse",
    header: "طريقة الاستعمال / Utilisation",
    label: "How to use",
    names: ["how to use", "usage", "use", "utilisation", "mode d'emploi", "installation", "pose", "طريقة الاستعمال", "طريقة التركيب", "الاستعمال", "التركيب"],
  },
  {
    field: "strengths",
    header: "نقاط القوة / Points forts",
    label: "Strengths",
    names: ["strengths", "points forts", "avantages", "atouts", "نقاط القوة", "المميزات", "مميزات"],
  },
  {
    field: "comparisons",
    header: "المقارنة / Comparaison",
    label: "Comparisons",
    names: ["comparisons", "comparison", "comparaison", "comparaisons", "مقارنة", "المقارنة"],
  },
  {
    field: "suitableFor",
    header: "لمن يصلح / Pour qui",
    label: "Suitable for",
    names: ["suitable for", "for who", "pour qui", "convient à", "usages", "لمن يصلح", "الاستعمالات", "يصلح ل"],
  },
  {
    field: "objections",
    header: "الأسئلة والتخوفات / Questions et objections",
    label: "Objections",
    names: ["objections", "questions", "faq", "questions et objections", "الأسئلة", "التخوفات", "الأسئلة والتخوفات", "أسئلة"],
  },
];

const COLOUR_FIELDS: FieldDef<ColourField>[] = [
  {
    field: "productCode",
    header: "كود المنتج / Code produit *",
    label: "Product code",
    names: ["product code", "product", "code produit", "produit", "réf produit", "كود المنتج", "المنتج", "رمز المنتج"],
  },
  {
    field: "code",
    header: "كود اللون / Code couleur *",
    label: "Colour code",
    names: ["colour code", "color code", "code", "code couleur", "code de la couleur", "code type", "كود اللون", "رقم اللون", "كود", "رقم"],
  },
  {
    field: "name",
    header: "اسم اللون / Nom de la couleur",
    label: "Colour name",
    names: ["colour name", "color name", "name", "colour", "color", "nom", "nom de la couleur", "couleur", "اسم اللون", "الاسم", "اللون"],
  },
  { field: "available", header: "متوفر / Disponible", label: "Available", names: PRODUCT_FIELDS[3].names },
  { field: "price", header: "السعر / Prix", label: "Price", names: PRODUCT_FIELDS[2].names },
];

/** The label with its unit; a label used twice gets its key, so each column stays its own. */
function attributeHeaders(attributes: ImportAttribute[]): string[] {
  const seen = new Set<string>();
  return attributes.map((attribute) => {
    const label = collapse(attribute.label);
    const header = attribute.unit ? `${label} (${collapse(attribute.unit)})` : label;
    const folded = fold(label);
    const repeated = seen.has(folded);
    seen.add(folded);
    return repeated ? `${header} [${attribute.key}]` : header;
  });
}

type Target<F extends string> = { kind: "field"; def: FieldDef<F> } | { kind: "attribute"; attribute: ImportAttribute };

/**
 * Header → column. Later layers win: the brand's own attribute names over the
 * usual names of the base fields, and the template's exact headers over both.
 */
function columnLookup<F extends string>(defs: FieldDef<F>[], attributes: ImportAttribute[]): Map<string, Target<F>> {
  const lookup = new Map<string, Target<F>>();
  const put = (name: string, target: Target<F>) => {
    const key = fold(name);
    if (key) lookup.set(key, target);
  };
  for (const def of defs) for (const name of def.names) put(name, { kind: "field", def });
  const headers = attributeHeaders(attributes);
  const labels = new Set<string>();
  attributes.forEach((attribute, index) => {
    const target: Target<F> = { kind: "attribute", attribute };
    // A label used twice stays the first attribute's; the second is found by its header or key.
    if (!labels.has(fold(attribute.label))) {
      labels.add(fold(attribute.label));
      put(attribute.label, target);
      if (attribute.unit) put(`${attribute.label} ${attribute.unit}`, target);
    }
    put(attribute.key, target);
    put(headers[index], target);
  });
  for (const def of defs) put(def.header, { kind: "field", def });
  return lookup;
}

/** The whole header first, then without its unit, then each of its "/" parts. */
function headerCandidates(header: string): string[] {
  const plain = header.replace(/\*/g, " ");
  const noUnit = (value: string) => value.replace(/[([][^)\]]*[)\]]/g, " ");
  const parts = plain.split("/");
  const all = [plain, noUnit(plain), ...(parts.length > 1 ? parts.flatMap((part) => [part, noUnit(part)]) : [])];
  return [...new Set(all.map(fold).filter(Boolean))];
}

function columnLetter(index: number): string {
  let letters = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  }
  return letters;
}

interface Column<F extends string> {
  index: number;
  /** As written in the file, for messages. */
  header: string;
  target: Target<F>;
}

interface Table<F extends string> {
  sheet: string;
  columns: Column<F>[];
  /** Data rows: their spreadsheet number and cells. */
  rows: { row: number; cells: string[] }[];
}

function isEmptyRow(cells: string[]): boolean {
  return cells.every((value) => value.trim() === "");
}

/**
 * Reads a sheet's header (its first row that holds anything) and its data
 * rows, empty ones skipped. Unknown, blank and repeated headers are reported
 * once each.
 */
function readTable<F extends string>(
  sheet: { name: string; rows: unknown[] },
  defs: FieldDef<F>[],
  attributes: ImportAttribute[],
  maxRows: number,
  problems: ImportProblem[]
): Table<F> | null {
  const rows = sheet.rows.map((row) => (Array.isArray(row) ? row.slice(0, MAX_COLUMNS).map(cellText) : []));
  const headerIndex = rows.findIndex((cells) => !isEmptyRow(cells));
  if (headerIndex < 0) return null;

  const data: Table<F>["rows"] = [];
  for (let index = headerIndex + 1; index < rows.length; index++) {
    if (isEmptyRow(rows[index])) continue;
    if (data.length >= maxRows) {
      problems.push({ sheet: sheet.name, row: index + 1, message: `Only the first ${maxRows} rows are read.` });
      break;
    }
    data.push({ row: index + 1, cells: rows[index] });
  }

  const lookup = columnLookup(defs, attributes);
  const columns: Column<F>[] = [];
  const taken = new Map<string, string>();
  const headerRow = headerIndex + 1;
  rows[headerIndex].forEach((raw, index) => {
    const header = shown(raw);
    if (!header) {
      if (data.some(({ cells }) => (cells[index] ?? "").trim() !== "")) {
        problems.push({ sheet: sheet.name, row: headerRow, message: `Column ${columnLetter(index)} has no header; it was not read.` });
      }
      return;
    }
    const target = headerCandidates(raw)
      .map((candidate) => lookup.get(candidate))
      .find((found) => found !== undefined);
    if (!target) {
      problems.push({ sheet: sheet.name, row: headerRow, message: `Unknown column "${header}"; it was not read.` });
      return;
    }
    const id = target.kind === "field" ? `field:${target.def.field}` : `attribute:${target.attribute.key}`;
    const first = taken.get(id);
    if (first !== undefined) {
      problems.push({
        sheet: sheet.name,
        row: headerRow,
        message: `The column "${header}" repeats "${first}"; only the first one is read.`,
      });
      return;
    }
    taken.set(id, header);
    columns.push({ index, header: header.replace(/\s*\*$/, ""), target });
  });
  return { sheet: sheet.name, columns, rows: data };
}

/** The file's header for a field, or its English label when the file has no such column. */
function columnName<F extends string>(table: Table<F> | null, defs: FieldDef<F>[], field: F): string {
  const column = table?.columns.find((col) => col.target.kind === "field" && col.target.def.field === field);
  return column?.header ?? defs.find((def) => def.field === field)?.label ?? field;
}

function fieldValues<F extends string>(table: Table<F>, cells: string[]): Map<F, string> {
  const values = new Map<F, string>();
  for (const column of table.columns) {
    if (column.target.kind === "field") values.set(column.target.def.field, cells[column.index] ?? "");
  }
  return values;
}

// ─── Sheets ─────────────────────────────────────────────────────────────────

const SHEET_NAMES = {
  products: ["products", "product", "produits", "produit", "المنتجات", "منتجات", "cards"],
  colours: ["colours", "colors", "colour", "color", "couleurs", "couleur", "variants", "variantes", "types", "الألوان", "ألوان", "الأنواع"],
  help: ["read me", "readme", "lisez moi", "lisez-moi", "aide", "help", "instructions", "notice", "تعليمات", "اقرأني", "مساعدة"],
} as const;

type SheetKind = keyof typeof SHEET_NAMES | "other";

const SHEET_KINDS = new Map<string, SheetKind>(
  (Object.keys(SHEET_NAMES) as (keyof typeof SHEET_NAMES)[]).flatMap((kind) =>
    [...SHEET_NAMES[kind], IMPORT_SHEETS[kind]].map((name) => [fold(name), kind] as const)
  )
);

function sheetKind(name: string): SheetKind {
  return SHEET_KINDS.get(fold(name)) ?? "other";
}

// ─── Parsing ────────────────────────────────────────────────────────────────

interface ColourRow {
  row: number;
  code: string;
  name: string | null;
  available: boolean;
  price: string | null;
  errors: string[];
}

interface ProductRow {
  row: number;
  cells: string[];
  codeKey: string | null;
  colours: ColourRow[];
}

/** "question => answer", one per line. */
function readObjections(value: string, column: string, errors: string[]): { question: string; answer: string }[] {
  const objections: { question: string; answer: string }[] = [];
  lines(value).forEach((line, index) => {
    const match = /^(.*?)\s*(?:=>|⇒|→)\s*(.*)$/.exec(line);
    if (!match) {
      errors.push(`${column} (line ${index + 1}): write it as "question => answer".`);
      return;
    }
    objections.push({ question: match[1].trim(), answer: match[2].trim() });
  });
  return objections;
}

/** Bullets people type in front of a point. */
function withoutBullet(line: string): string {
  return line.replace(/^[•·▪●◦*\-–—]\s+/, "");
}

/** A value with the attribute's unit written after it ("3 mm") is the number alone. */
function withoutUnit(value: string, unit: string | null): string {
  if (!unit) return value;
  const text = value.trim();
  const u = unit.trim();
  return u && text.toLowerCase().endsWith(u.toLowerCase()) ? text.slice(0, text.length - u.length).trim() : text;
}

/** Raw values for cleanAttributeValues, with the import's wider yes/no words and option spellings. */
function attributeValue(attribute: ImportAttribute, raw: string): unknown {
  const text = raw.trim();
  if (!text) return undefined;
  switch (attribute.type) {
    case "BOOLEAN": {
      const answer = yesNo(text);
      return typeof answer === "boolean" ? answer : text;
    }
    case "NUMBER":
      return withoutUnit(text, attribute.unit);
    case "CHOICE": {
      const wanted = fold(text);
      return attribute.options.find((option) => fold(option) === wanted) ?? text;
    }
    default:
      return text;
  }
}

/** zod's own messages are long; the schema's custom ones are kept. */
function issueText(issue: { code: string; message: string; maximum?: unknown; origin?: unknown }, items: string): string {
  if (!/^(Too (big|small)|Invalid)/.test(issue.message)) return issue.message;
  if (issue.code === "too_big") {
    return issue.origin === "array" ? `at most ${String(issue.maximum)} ${items}.` : `at most ${String(issue.maximum)} characters.`;
  }
  if (issue.code === "too_small") return "can't be empty.";
  return "isn't valid.";
}

/** The codec's sheets, named as shown, with the Products sheet (else the first other one) and the Colours sheet found. */
function locateSheets(sheets: unknown) {
  const list = (Array.isArray(sheets) ? sheets : [])
    .filter((sheet): sheet is { name: unknown; rows: unknown[] } => !!sheet && typeof sheet === "object" && Array.isArray(sheet.rows))
    .map((sheet) => ({ name: shown(cellText(sheet.name), 100), rows: sheet.rows }));
  const kinds = list.map((sheet) => sheetKind(sheet.name));
  const productsIndex = kinds.includes("products") ? kinds.indexOf("products") : kinds.indexOf("other");
  return { list, kinds, productsIndex, coloursIndex: kinds.indexOf("colours") };
}

function parseSheets(sheets: unknown, attributes: ImportAttribute[], existing: Map<string, string>) {
  const rows: ImportRow[] = [];
  const problems: ImportProblem[] = [];
  const template = Array.isArray(attributes) ? attributes : [];

  const { list, kinds, productsIndex, coloursIndex } = locateSheets(sheets);
  list.forEach((sheet, index) => {
    if (index !== productsIndex && index !== coloursIndex && kinds[index] !== "help") {
      problems.push({ sheet: sheet.name, row: 0, message: `The sheet "${sheet.name}" was not read.` });
    }
  });
  if (productsIndex < 0) {
    problems.push({ sheet: "", row: 0, message: `No "${IMPORT_SHEETS.products}" sheet in the file.` });
    return { rows, problems };
  }

  const productSheet = list[productsIndex];
  const products = readTable(productSheet, PRODUCT_FIELDS, template, MAX_PRODUCTS, problems);
  if (!products || products.rows.length === 0) {
    problems.push({ sheet: productSheet.name, row: 0, message: "No products in the sheet." });
    return { rows, problems };
  }
  if (!products.columns.some((col) => col.target.kind === "field" && col.target.def.field === "name")) {
    problems.push({ sheet: productSheet.name, row: 0, message: `No column for the name ("${PRODUCT_FIELDS[1].header}").` });
  }
  const column = (field: ProductField) => columnName(products, PRODUCT_FIELDS, field);

  // First pass: codes, so colours find their product and repeated codes are known.
  const productRows: ProductRow[] = products.rows.map(({ row, cells }) => {
    const code = collapse(fieldValues(products, cells).get("code") ?? "");
    return { row, cells, codeKey: codeKeyOf(code), colours: [] };
  });
  const firstByKey = new Map<string, ProductRow>();
  for (const product of productRows) {
    if (product.codeKey && !firstByKey.has(product.codeKey)) firstByKey.set(product.codeKey, product);
  }

  const colourSheet = coloursIndex >= 0 ? list[coloursIndex] : null;
  const colours = colourSheet ? readTable(colourSheet, COLOUR_FIELDS, [], MAX_COLOUR_ROWS, problems) : null;
  const colourColumn = (field: ColourField) => columnName(colours, COLOUR_FIELDS, field);
  const colourSheetName = colours?.sheet ?? IMPORT_SHEETS.colours;
  if (colours) {
    for (const { row, cells } of colours.rows) {
      const values = fieldValues(colours, cells);
      const productCode = collapse(values.get("productCode") ?? "");
      const key = codeKeyOf(productCode);
      if (!key) {
        problems.push({ sheet: colours.sheet, row, message: `${colourColumn("productCode")}: give the product's code.` });
        continue;
      }
      const product = firstByKey.get(key);
      if (!product) {
        problems.push({
          sheet: colours.sheet,
          row,
          message: `No product with the code ${shown(productCode)} in the ${productSheet.name} sheet.`,
        });
        continue;
      }
      const errors: string[] = [];
      const availableRaw = values.get("available") ?? "";
      const available = yesNo(availableRaw);
      if (available === undefined) {
        errors.push(`${colourColumn("available")}: answer yes or no (not "${shown(availableRaw, 20)}").`);
      }
      product.colours.push({
        row,
        code: collapse(values.get("code") ?? ""),
        name: collapse(values.get("name") ?? "") || null,
        available: available ?? true,
        price: collapse(values.get("price") ?? "") || null,
        errors,
      });
    }
  }

  const known = new Map<string, string>();
  for (const [key, id] of existing instanceof Map ? existing : []) {
    const normalized = typeof key === "string" ? normalizeCode(key) : "";
    if (normalized) known.set(normalized, id);
  }

  for (const product of productRows) {
    const values = fieldValues(products, product.cells);
    const get = (field: ProductField) => values.get(field) ?? "";
    const errors: string[] = [];
    const code = collapse(get("code"));
    const name = collapse(get("name"));

    const first = product.codeKey ? firstByKey.get(product.codeKey) : undefined;
    if (first && first !== product) errors.push(`${column("code")}: ${shown(code)} is already on row ${first.row}.`);

    const availableRaw = get("available");
    const available = yesNo(availableRaw);
    if (available === undefined) errors.push(`${column("available")}: answer yes or no (not "${shown(availableRaw, 20)}").`);

    const objections = readObjections(get("objections"), column("objections"), errors);

    const rawAttributes: Record<string, unknown> = {};
    for (const col of products.columns) {
      if (col.target.kind !== "attribute") continue;
      const value = attributeValue(col.target.attribute, product.cells[col.index] ?? "");
      if (value !== undefined) rawAttributes[col.target.attribute.key] = value;
    }
    const cleaned = cleanAttributeValues(template, rawAttributes);
    errors.push(...cleaned.errors.map((error) => error.message));

    for (const colour of product.colours) {
      errors.push(...colour.errors.map((error) => `${colourSheetName} row ${colour.row}: ${error}`));
    }

    const parsed = productInputSchema.safeParse({
      name,
      code: code || null,
      price: collapse(get("price")) || null,
      available: available ?? true,
      // A person typed these cards and confirms the preview: they are approved (PLAN.md 6.15).
      status: "ACTIVE",
      landingUrl: collapse(get("landingUrl")) || null,
      description: get("description").trim() || null,
      howToUse: get("howToUse").trim() || null,
      attributes: cleaned.values,
      strengths: lines(get("strengths")).map(withoutBullet),
      comparisons: get("comparisons").trim() || null,
      suitableFor: get("suitableFor").trim() || null,
      objections,
      variants: product.colours.map((colour) => ({
        code: colour.code,
        name: colour.name,
        available: colour.available,
        price: colour.price,
        imageId: null,
      })),
      related: [],
      mainImageId: null,
    });
    if (!parsed.success) {
      // One message per cell: an empty code fails both "give it" and "a letter or a digit".
      const seenPaths = new Set<string>();
      for (const issue of parsed.error.issues) {
        const path = issue.path.map(String).join(".");
        if (seenPaths.has(path)) continue;
        seenPaths.add(path);
        const [head, index, sub] = issue.path;
        if (head === "variants") {
          const colour = typeof index === "number" ? product.colours[index] : undefined;
          const text = issueText(issue, "colours per product");
          if (!colour) errors.push(`${colourSheetName}: ${text}`);
          else {
            const field: ColourField = sub === "name" || sub === "price" || sub === "available" ? sub : "code";
            errors.push(`${colourSheetName} row ${colour.row}: ${colourColumn(field)}: ${text}`);
          }
        } else if ((head === "strengths" || head === "objections") && typeof index === "number") {
          errors.push(`${column(head)} (line ${index + 1}): ${issueText(issue, "lines")}`);
        } else {
          const field = PRODUCT_FIELDS.find((def) => def.field === head)?.field;
          errors.push(`${field ? column(field) : String(head ?? "Card")}: ${issueText(issue, "lines")}`);
        }
      }
    }

    const unique = [...new Set(errors)];
    const shownErrors = unique.length > MAX_ROW_ERRORS ? [...unique.slice(0, MAX_ROW_ERRORS - 1), `And ${unique.length - MAX_ROW_ERRORS + 1} more.`] : unique;
    const ok = parsed.success && unique.length === 0;
    rows.push({
      sheet: products.sheet,
      row: product.row,
      code: code ? shown(code, MAX_CODE_LENGTH) : null,
      name: name ? shown(name, 200) : null,
      action: !ok ? "error" : product.codeKey && known.has(product.codeKey) ? "update" : "create",
      errors: shownErrors,
      input: ok ? { ...parsed.data, attributes: cleaned.values } : null,
    });
  }
  return { rows, problems };
}

/**
 * The preview of a filled file. `existing` maps the brand's code keys to its
 * product ids: a row whose code is there updates that product, any other row
 * creates one. Never throws: whatever the file holds ends up in rows or
 * problems.
 */
export function parseImport(
  sheets: Sheet[],
  attributes: ImportAttribute[],
  existing: Map<string, string>
): { rows: ImportRow[]; problems: ImportProblem[] } {
  try {
    return parseSheets(sheets, attributes, existing);
  } catch {
    return { rows: [], problems: [{ sheet: "", row: 0, message: "The file could not be read." }] };
  }
}

export type ImportField = ProductField;

/** The base fields and the attributes the Products sheet has a column for. */
export interface ImportColumns {
  fields: Set<ImportField>;
  /** Keys of the attributes. */
  attributes: Set<string>;
}

/**
 * Which columns the file's Products sheet has, read the way parseImport reads
 * them. An update replaces only these: a column the file lacks leaves its
 * field as it is. A file that cannot be read has none.
 */
export function importColumns(sheets: Sheet[], attributes: ImportAttribute[]): ImportColumns {
  const found: ImportColumns = { fields: new Set(), attributes: new Set() };
  try {
    const { list, productsIndex } = locateSheets(sheets);
    if (productsIndex < 0) return found;
    const table = readTable(list[productsIndex], PRODUCT_FIELDS, Array.isArray(attributes) ? attributes : [], MAX_PRODUCTS, []);
    for (const column of table?.columns ?? []) {
      if (column.target.kind === "field") found.fields.add(column.target.def.field);
      else found.attributes.add(column.target.attribute.key);
    }
  } catch {
    // Nothing is known to be there: an update then changes only the name and the code.
  }
  return found;
}

// ─── The template ───────────────────────────────────────────────────────────

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** One item per line in a cell: a line break inside an item would split it in two. */
function oneLine(value: unknown): string {
  return collapse(textOf(value));
}

function attributeCell(value: AttributeValue | undefined): string {
  if (typeof value === "boolean") return yesNoWord(value);
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  return textOf(value);
}

function typeHelp(attribute: ImportAttribute): [string, string] {
  const unit = attribute.unit ? ` (${attribute.unit})` : "";
  switch (attribute.type) {
    case "NUMBER":
      return [`رقم${unit}`, `nombre${unit}`];
    case "BOOLEAN":
      return ["نعم أو لا", "oui ou non"];
    case "CHOICE":
      return [`واحد من: ${attribute.options.join(" | ")}`, `une option parmi : ${attribute.options.join(" | ")}`];
    default:
      return ["نص", "texte"];
  }
}

function helpRows(attributes: ImportAttribute[]): string[][] {
  const rows: string[][] = [
    ["العربية", "Français"],
    ["كيف تملأ هذا الملف", "Comment remplir ce fichier"],
    [
      `منتج في كل سطر من ورقة «${IMPORT_SHEETS.products}». الأعمدة التي عليها * إجبارية.`,
      `Un produit par ligne dans la feuille « ${IMPORT_SHEETS.products} ». Les colonnes marquées * sont obligatoires.`,
    ],
    [
      "الكود يربط المنتج بألوانه وصوره، وبه يُحدَّث المنتج الموجود. منتج بلا كود يُضاف كمنتج جديد في كل استيراد.",
      "Le code relie le produit à ses couleurs et à ses photos, et sert à mettre à jour un produit existant. Un produit sans code est ajouté comme nouveau à chaque import.",
    ],
    [
      "نعم أو لا: اكتب نعم أو لا (أو oui/non، yes/no، 1/0، و x تعني نعم). خانة «متوفر» الفارغة تعني متوفر.",
      "Oui ou non : écrivez oui ou non (ou نعم/لا, yes/no, 1/0, et x veut dire oui). Une case « Disponible » vide veut dire disponible.",
    ],
    [
      "نقاط القوة: نقطة في كل سطر من الخانة (Alt+Enter لسطر جديد في Excel).",
      "Points forts : un point par ligne dans la case (Alt+Entrée pour aller à la ligne dans Excel).",
    ],
    ["الأسئلة والتخوفات: واحد في كل سطر، هكذا: السؤال => الجواب", "Questions et objections : une par ligne, ainsi : question => réponse"],
    ["الأرقام: 12 أو 1.5 أو 1,5، بدون الوحدة.", "Nombres : 12, 1.5 ou 1,5, sans l'unité."],
    [
      `الألوان أو الأنواع في ورقة «${IMPORT_SHEETS.colours}»: لون في كل سطر، مع كود المنتج كما هو في ورقة ${IMPORT_SHEETS.products}.`,
      `Couleurs ou types dans la feuille « ${IMPORT_SHEETS.colours} » : une couleur par ligne, avec le code du produit tel qu'il est dans la feuille ${IMPORT_SHEETS.products}.`,
    ],
    [
      "الصور: في مجلد واحد، واسم كل صورة هو الكود: WP-12.jpg لصورة المنتج، و WP-12_12-04.jpg أو 12-04.jpg لصورة اللون. الأنواع: jpg و png و webp.",
      "Photos : dans un seul dossier, chaque photo nommée par son code : WP-12.jpg pour le produit, WP-12_12-04.jpg ou 12-04.jpg pour une couleur. Formats : jpg, png, webp.",
    ],
    [
      "قبل الاستيراد تظهر معاينة بكل سطر: ما سيُضاف وما سيُحدَّث وما فيه خطأ. ما تؤكّده يصبح نشطاً ويقرؤه البوت.",
      "Avant l'import, un aperçu montre chaque ligne : ce qui sera ajouté, mis à jour ou refusé. Ce que vous confirmez devient actif et le bot le lit.",
    ],
  ];
  if (attributes.length) {
    rows.push(["خصائص منتجاتك", "Les caractéristiques de vos produits"]);
    const headers = attributeHeaders(attributes);
    attributes.forEach((attribute, index) => {
      const [ar, fr] = typeHelp(attribute);
      rows.push([`${headers[index]}: ${ar}`, `${headers[index]} : ${fr}`]);
    });
  }
  return rows;
}

/**
 * The file a brand downloads: a Products sheet with the base fields and one
 * column per attribute of its template, a Colours sheet, and short
 * instructions. With products, it is an export that parseImport reads back.
 */
export function buildImportTemplate(attributes: ImportAttribute[], products: TemplateProduct[] = []): Sheet[] {
  const headers = attributeHeaders(attributes);
  const productRows: string[][] = [[...PRODUCT_FIELDS.map((def) => def.header), ...headers]];
  const colourRows: string[][] = [COLOUR_FIELDS.map((def) => def.header)];
  for (const product of products) {
    const base: Record<ProductField, string> = {
      code: textOf(product.code),
      name: textOf(product.name),
      price: textOf(product.price),
      available: yesNoWord(product.available !== false),
      landingUrl: textOf(product.landingUrl),
      description: textOf(product.description),
      howToUse: textOf(product.howToUse),
      strengths: (product.strengths ?? []).map(oneLine).filter(Boolean).join("\n"),
      comparisons: textOf(product.comparisons),
      suitableFor: textOf(product.suitableFor),
      objections: (product.objections ?? [])
        .map(({ question, answer }) => `${oneLine(question)} => ${oneLine(answer)}`)
        .join("\n"),
    };
    const values = product.attributes ?? {};
    productRows.push([
      ...PRODUCT_FIELDS.map((def) => base[def.field]),
      ...attributes.map((attribute) => attributeCell(Object.hasOwn(values, attribute.key) ? values[attribute.key] : undefined)),
    ]);
    // A colour is tied to its product by the product's code: without one it can't be written.
    if (!product.code) continue;
    for (const variant of product.variants ?? []) {
      colourRows.push([product.code, textOf(variant.code), textOf(variant.name), yesNoWord(variant.available !== false), textOf(variant.price)]);
    }
  }
  return [
    { name: IMPORT_SHEETS.products, rows: productRows },
    { name: IMPORT_SHEETS.colours, rows: colourRows },
    { name: IMPORT_SHEETS.help, rows: helpRows(attributes) },
  ];
}

// ─── Pictures ───────────────────────────────────────────────────────────────

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp"]);
/** Between a product's code and its colour's: "WP-12_12-04", "WP-12 12-04". */
const CODE_SEPARATOR = /[_\s\-.+]/;

interface PictureOwner {
  code: string;
  variants: Map<string, string>;
}

/**
 * Pictures of a folder, by their names: "WP-12.jpg" is product WP-12's,
 * "WP-12_12-04.jpg" its colour 12-04's, and "12-04.jpg" the colour 12-04 of
 * the only product that has it. A name that could mean two pictures is left
 * out rather than guessed, and so is a second file for the same picture.
 */
export function matchImageFiles(
  fileNames: string[],
  products: { code: string; variantCodes: string[] }[]
): { matched: ImageMatch[]; unmatched: { fileName: string; reason: string }[] } {
  const matched: ImageMatch[] = [];
  const unmatched: { fileName: string; reason: string }[] = [];

  const byCode = new Map<string, PictureOwner[]>();
  const byColour = new Map<string, { owner: PictureOwner; code: string }[]>();
  for (const product of Array.isArray(products) ? products : []) {
    const code = textOf(product?.code);
    const key = normalizeCode(code);
    if (!key) continue;
    const owner: PictureOwner = { code, variants: new Map() };
    for (const variantCode of Array.isArray(product.variantCodes) ? product.variantCodes : []) {
      const variantKey = normalizeCode(textOf(variantCode));
      if (variantKey && !owner.variants.has(variantKey)) owner.variants.set(variantKey, textOf(variantCode));
    }
    byCode.set(key, [...(byCode.get(key) ?? []), owner]);
    for (const [variantKey, variantCode] of owner.variants) {
      byColour.set(variantKey, [...(byColour.get(variantKey) ?? []), { owner, code: variantCode }]);
    }
  }

  const used = new Map<string, string>();
  const names = Array.isArray(fileNames) ? fileNames : [];
  names.forEach((raw, index) => {
    const fileName = cut(textOf(raw).replace(/[\p{Cc}]/gu, ""), MAX_FILE_NAME);
    if (index >= MAX_FILES) {
      unmatched.push({ fileName, reason: `too many files (${MAX_FILES} at most)` });
      return;
    }
    const base = fileName.split(/[\\/]/).pop() ?? "";
    const dot = base.lastIndexOf(".");
    const extension = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
    // ".DS_Store", and the "._WP-12.jpg" copies macOS leaves in zips and folders.
    if (base.startsWith(".") || !IMAGE_EXTENSIONS.has(extension)) {
      unmatched.push({ fileName, reason: "not a picture (jpg, jpeg, png or webp)" });
      return;
    }
    const stem = base.slice(0, dot).trim();
    const key = normalizeCode(stem);
    if (!key) {
      unmatched.push({ fileName, reason: "no code in the name" });
      return;
    }

    // Every reading of the name; more than one means it is ambiguous.
    const candidates = new Map<string, { owner: PictureOwner; variantCode: string | null }>();
    const add = (owner: PictureOwner, variantKey: string | null, variantCode: string | null) =>
      candidates.set(`${normalizeCode(owner.code)}|${variantKey ?? ""}|${owner.code}`, { owner, variantCode });
    for (const owner of byCode.get(key) ?? []) add(owner, null, null);
    for (let i = 1; i < stem.length - 1; i++) {
      if (!CODE_SEPARATOR.test(stem[i])) continue;
      const productKey = normalizeCode(stem.slice(0, i));
      const colourKey = normalizeCode(stem.slice(i + 1));
      if (!productKey || !colourKey) continue;
      for (const owner of byCode.get(productKey) ?? []) {
        const variantCode = owner.variants.get(colourKey);
        if (variantCode !== undefined) add(owner, colourKey, variantCode);
      }
    }
    for (const { owner, code } of byColour.get(key) ?? []) add(owner, key, code);

    const found = [...candidates.values()];
    if (found.length === 0) {
      unmatched.push({ fileName, reason: "no product or colour has this code" });
      return;
    }
    if (found.length > 1) {
      const meanings = found
        .slice(0, 3)
        .map(({ owner, variantCode }) => shown(variantCode ? `${owner.code} ${variantCode}` : owner.code, 40));
      unmatched.push({ fileName, reason: `ambiguous: could be ${meanings.join(", ")}` });
      return;
    }
    const [{ owner, variantCode }] = found;
    const target = `${normalizeCode(owner.code)}|${variantCode === null ? "" : normalizeCode(variantCode)}`;
    const earlier = used.get(target);
    if (earlier !== undefined) {
      unmatched.push({ fileName, reason: `duplicate: ${shown(earlier, 80)} is already this picture` });
      return;
    }
    used.set(target, fileName);
    matched.push({ fileName, productCode: owner.code, variantCode });
  });
  return { matched, unmatched };
}
