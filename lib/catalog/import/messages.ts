/**
 * The sentences of the spreadsheet import, one template each.
 *
 * The codec builds its messages in English from these templates
 * (`fillMessage`); the screen shows them in the person's language
 * (`translateImportMessage`): a message is matched back to the template that
 * made it, and the template, being a key of the Facebook Arabic catalog, is
 * translated with the values the message carried. Because both sides use the
 * same templates, the English text and the translation cannot drift apart.
 *
 * Pure (no React, no server code): the browser uses it too. Every value comes
 * from the file (a header, a code, a name) and is untrusted: it is inserted
 * as text in one pass and never read as a template or as markup.
 */
import type { FbI18n, FbMessageKey } from "../../facebook/i18n";

type Names<S extends string> = S extends `${string}{${infer Name}}${infer Rest}` ? Name | Names<Rest> : never;
type FillArgs<S extends string> = [Names<S>] extends [never] ? [] : [values: Record<Names<S>, string | number>];

/**
 * The templates. English is the key of the Arabic catalog; the placeholders
 * are the same in both. Several are existing keys of that catalog (the
 * schema's own messages, the picture reasons).
 */
export const IMPORT_TEMPLATES = {
  // The file and its sheets.
  fileUnreadable: "The file could not be read.",
  sheetNotRead: 'The sheet "{sheet}" was not read.',
  noSheet: 'No "{sheet}" sheet in the file.',
  noProducts: "No products in the sheet.",
  rowLimit: "Only the first {max} rows are read.",
  // Columns.
  noHeader: "Column {letter} has no header; it was not read.",
  unknownColumn: 'Unknown column "{header}"; it was not read.',
  repeatedColumn: 'The column "{header}" repeats "{first}"; only the first one is read.',
  noNameColumn: 'No column for the name ("{header}").',
  // Cells.
  giveProductCode: "{column}: give the product's code.",
  noProductWithCode: "No product with the code {code} in the {sheet} sheet.",
  answerYesNo: '{column}: answer yes or no (not "{value}").',
  codeRepeated: "{column}: {code} is already on row {row}.",
  objectionFormat: '{column} (line {line}): write it as "question => answer".',
  // A message inside another: the sheet's row, a field, a line of a field.
  colourRowIssue: "{sheet} row {row}: {error}",
  fieldIssue: "{column}: {error}",
  lineIssue: "{column} (line {line}): {error}",
  // What a field is not (the wording of zod's own messages, shortened).
  tooLong: "at most {max} characters.",
  tooManyColours: "at most {max} colours per product.",
  tooManyLines: "at most {max} lines.",
  empty: "can't be empty.",
  invalid: "isn't valid.",
  more: "And {count} more.",
  // The brand's attributes (lib/catalog/attributes.ts words them; the label comes first).
  attributeText: "{label}: write it as text.",
  attributeTooLong: "{label}: {max} characters at most.",
  attributeNumber: "{label}: write a number, like 12 or 1.5.",
  attributeChoice: "{label}: pick one of its options.",
  attributeBoolean: "{label}: answer yes or no.",
  // The product schema's own messages (lib/catalog/products.ts).
  giveColourCode: "Give each colour or type its code.",
  codeNeedsCharacter: "A code needs a letter or a digit.",
  giveName: "Give the product a name.",
  webLink: "Use an http or https link.",
  strengthEmpty: "A strength can't be empty.",
  writeQuestion: "Write the question or worry.",
  writeAnswer: "Write the answer.",
  codeUsedTwice: "The code {code} is used twice.",
  cardInvalid: "The card is not valid.",
  // Why a picture is left out.
  tooManyFiles: "too many files ({max} at most)",
  notPicture: "not a picture (jpg, jpeg, png or webp)",
  noCodeInName: "no code in the name",
  codeMatchesNothing: "no product or colour has this code",
  ambiguous: "ambiguous: could be {meanings}",
  duplicate: "duplicate: {earlier} is already this picture",
  pictureTooLarge: "too large",
  noRoom: "no room left for more pictures",
} as const satisfies Record<string, FbMessageKey>;

type TemplateName = keyof typeof IMPORT_TEMPLATES;
export type ImportTemplate = (typeof IMPORT_TEMPLATES)[TemplateName];

/** What a column is called in a message when the file has no such column. */
export const FIELD_LABELS = {
  code: "Code",
  name: "Name",
  price: "Price",
  available: "Available",
  landingUrl: "Landing page",
  description: "Description",
  howToUse: "How to use",
  strengths: "Strengths",
  comparisons: "Comparisons",
  suitableFor: "Suitable for",
  objections: "Objections",
  productCode: "Product code",
  colourCode: "Colour code",
  colourName: "Colour name",
  card: "Card",
} as const satisfies Record<string, FbMessageKey>;

/** The sheets of the template the app writes. */
export const IMPORT_SHEET_NAMES = { products: "Products", colours: "Colours", help: "Read me" } as const satisfies Record<
  string,
  FbMessageKey
>;

/** Builds a message from its template; each placeholder is replaced once, in one pass. */
export function fillMessage<S extends string>(template: S, ...args: FillArgs<S>): string {
  const values = (args[0] ?? {}) as Record<string, string | number>;
  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : placeholder
  );
}

// ─── Reading a message back ─────────────────────────────────────────────────

/** Loose view of the catalog's `t`: the keys are checked where the templates are declared. */
type Say = (key: string, values?: Record<string, string | number>) => string;

const NUMBER_PLACEHOLDERS = new Set(["max", "line", "row", "count"]);
/** Placeholders that hold a column or a sheet: translated when they name a known label. */
const LABEL_PLACEHOLDERS = new Set(["column", "sheet"]);
/** The placeholder that holds another message. */
const NESTED_PLACEHOLDER = "error";
const MAX_DEPTH = 4;

interface Matcher {
  template: string;
  names: string[];
  regex: RegExp;
  /** The words of the template: the more there are, the more specific it is. */
  specificity: number;
  /** It holds another message: tried first, and it counts only when that message is one of ours. */
  wrapper: boolean;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matcherOf(template: string): Matcher {
  const names: string[] = [];
  let source = "";
  let last = 0;
  for (const match of template.matchAll(/\{(\w+)\}/g)) {
    source += escapeRegex(template.slice(last, match.index));
    last = match.index + match[0].length;
    const name = match[1];
    names.push(name);
    if (NUMBER_PLACEHOLDERS.has(name)) source += "(\\d+)";
    else if (name === "letter") source += "([A-Z]+)";
    else if (name === NESTED_PLACEHOLDER) source += "([\\s\\S]+?)";
    else source += "([\\s\\S]*?)";
  }
  source += escapeRegex(template.slice(last));
  return {
    template,
    names,
    regex: new RegExp(`^${source}$`),
    specificity: template.replace(/\{\w+\}/g, "").length,
    wrapper: names.includes(NESTED_PLACEHOLDER),
  };
}

/**
 * Wrappers first, most specific first: "Colours row 2: Disponible: answer yes
 * or no." must be read as a row of the Colours sheet, not as the answer of a
 * column named "Colours row 2: Disponible".
 */
const MATCHERS: Matcher[] = [...new Set<string>(Object.values(IMPORT_TEMPLATES))]
  .map(matcherOf)
  .sort((a, b) => Number(b.wrapper) - Number(a.wrapper) || b.specificity - a.specificity);

const LABELS = new Set<string>([...Object.values(FIELD_LABELS), ...Object.values(IMPORT_SHEET_NAMES)]);

/** A column or sheet name, translated when it is one of the app's own. */
export function translateImportLabel(t: FbI18n["t"], text: string): string {
  return LABELS.has(text) ? (t as unknown as Say)(text) : text;
}

function translateKnown(t: FbI18n["t"], message: string, depth: number): string | null {
  if (depth > MAX_DEPTH) return null;
  const say = t as unknown as Say;
  for (const matcher of MATCHERS) {
    const found = matcher.regex.exec(message);
    if (!found) continue;
    const values: Record<string, string> = {};
    let known = true;
    matcher.names.forEach((name, index) => {
      const raw = found[index + 1];
      if (name === NESTED_PLACEHOLDER) {
        // A wrapper counts only when what it wraps is ours: any "x: y" must not be taken for one.
        const inner = translateKnown(t, raw, depth + 1);
        if (inner === null) known = false;
        else values[name] = inner;
      } else values[name] = LABEL_PLACEHOLDERS.has(name) ? translateImportLabel(t, raw) : raw;
    });
    if (known) return say(matcher.template, values);
  }
  return null;
}

/**
 * The message in the person's language. Messages the templates do not make
 * (the model's, the server's, anything else) are returned as they are.
 */
export function translateImportMessage(t: FbI18n["t"], message: string): string {
  return typeof message === "string" ? (translateKnown(t, message, 0) ?? message) : message;
}
