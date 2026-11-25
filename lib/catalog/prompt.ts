/**
 * The catalog as the bot reads it (PLAN.md 6.12).
 *
 * A brand's catalog can hold hundreds of products with rich cards: far too
 * much for every prompt. So the model gets a compact index of every product,
 * one line each, and the full cards of the few products the conversation is
 * about (the campaign's product, the ones it focuses on, the ones named by
 * name or code). Everything shown also goes to the guard, so a number or a
 * link from a card passes and an invented one does not.
 *
 * Pure functions: no database, no network, no environment.
 */
import { MAX_CODE_LENGTH, normalizeCode } from "./codes";

export interface CatalogAttribute {
  key: string;
  label: string;
  type: "TEXT" | "NUMBER" | "CHOICE" | "BOOLEAN";
  unit: string | null;
}

export interface CatalogVariant {
  code: string;
  name: string | null;
  available: boolean;
  price: string | null;
}

export interface CatalogProduct {
  id: string;
  name: string;
  code: string | null;
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
  variants: CatalogVariant[];
  related: { id: string; name: string; note: string | null }[];
}

export const DEFAULT_MAX_FULL_CARDS = 8;
export const CATALOG_INDEX_MAX_CHARS = 30_000;

// ─── Plain text ─────────────────────────────────────────────────────────────
// The labels below hold no digit and no amount word: the guard reads the same
// text, and only the brand's own words may bring numbers into it.

const LINE_BREAK = /\r\n|[\n\r\v\f\u0085\u2028\u2029]/;

/** The value's lines, trimmed, without the empty ones. */
function linesOf(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(LINE_BREAK)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** The value on one line: its lines joined with " / ". */
function oneLine(value: unknown): string {
  return linesOf(value).join(" / ");
}

/**
 * A value after its label. Its own lines stay, indented under the first, so
 * no line of a value starts where a label does and none can pass for one.
 */
function block(head: string, value: unknown, indent = "  "): string | null {
  const [first, ...rest] = linesOf(value);
  if (!first) return null;
  return [head + first, ...rest.map((line) => indent + line)].join("\n");
}

function asArray<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function productName(product: CatalogProduct): string {
  return oneLine(product.name) || "(no name)";
}

/** A variant's price when it is not the product's; prices stay as written. */
function ownPrice(variant: CatalogVariant, product: CatalogProduct): string | null {
  const price = oneLine(variant.price);
  return price && price !== oneLine(product.price) ? price : null;
}

// ─── The index ──────────────────────────────────────────────────────────────

const NO_PRICE = "not in the catalog";
const INDEX_CUT_NOTE =
  "(The index was cut here: the catalog has more products. A product that is not listed and has no full card is unknown to you: ask the customer for its name or code, or hand off with NOT_IN_KB.)";

function indexVariant(variant: CatalogVariant, product: CatalogProduct): string | null {
  const code = oneLine(variant?.code);
  if (!code) return null;
  const price = ownPrice(variant, product);
  const notes = [oneLine(variant.name), price ? `price: ${price}` : "", variant.available ? "" : "OUT OF STOCK"].filter(Boolean);
  return notes.length ? `${code} (${notes.join(", ")})` : code;
}

function indexLine(product: CatalogProduct): string {
  const parts = [productName(product)];
  const code = oneLine(product.code);
  if (code) parts.push(`code: ${code}`);
  parts.push(`price: ${oneLine(product.price) || NO_PRICE}`);
  if (!product.available) parts.push("OUT OF STOCK");
  const variants = asArray(product.variants)
    .map((variant) => indexVariant(variant, product))
    .filter(Boolean);
  if (variants.length) parts.push(`colours or types: ${variants.join("; ")}`);
  return `- ${parts.join(" | ")}`;
}

/**
 * One line per product: name | code | price ("price: not in the catalog"
 * when there is none) | OUT OF STOCK when unavailable | colours or types:
 * codes (names, a price of their own, OUT OF STOCK). Past
 * CATALOG_INDEX_MAX_CHARS the index stops at a whole line, never inside one
 * (half a line could show half a price), and a last line says it was cut.
 */
export function formatCatalogIndex(products: CatalogProduct[]): string {
  const lines = products.map(indexLine);
  const full = lines.join("\n");
  if (full.length <= CATALOG_INDEX_MAX_CHARS) return full;
  const kept: string[] = [];
  let length = INDEX_CUT_NOTE.length;
  for (const line of lines) {
    if (length + line.length + 1 > CATALOG_INDEX_MAX_CHARS) break;
    kept.push(line);
    length += line.length + 1;
  }
  return [...kept, INDEX_CUT_NOTE].join("\n");
}

// ─── The full card ──────────────────────────────────────────────────────────

/** An attribute's value as text, with its unit; numbers exactly as stored. */
function attributeValue(attribute: CatalogAttribute, value: unknown): string | null {
  if (typeof value === "boolean") return value ? "yes" : "no";
  const unit = attribute.type === "BOOLEAN" ? "" : oneLine(attribute.unit);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return unit ? `${value} ${unit}` : String(value);
  }
  if (typeof value !== "string" || !value.trim()) return null;
  if (attribute.type === "BOOLEAN" && /^(?:true|false)$/i.test(value.trim())) {
    return value.trim().toLowerCase() === "true" ? "yes" : "no";
  }
  if (!unit) return value;
  const text = oneLine(value);
  return text.toLowerCase().endsWith(unit.toLowerCase()) ? text : `${text} ${unit}`;
}

/** The brand's attributes in the template's order, with their own labels. */
function characteristics(product: CatalogProduct, attributes: CatalogAttribute[]): (string | null)[] {
  const values: Record<string, unknown> = product.attributes ?? {};
  const seen = new Set<string>();
  return attributes.map((attribute) => {
    if (seen.has(attribute.key)) return null;
    seen.add(attribute.key);
    const value = attributeValue(attribute, values[attribute.key]);
    return value === null ? null : block(`- ${oneLine(attribute.label) || attribute.key}: `, value);
  });
}

/** A known question or worry; without the shop's answer it gives the model nothing to say. */
function objection(item: { question: string; answer: string }): string | null {
  const question = block("- Q: ", item?.question, "     ");
  const answer = block(question ? "  A: " : "- A: ", item?.answer, "     ");
  if (!answer) return null;
  return question ? `${question}\n${answer}` : answer;
}

function cardVariant(variant: CatalogVariant, product: CatalogProduct): string | null {
  const code = oneLine(variant?.code);
  if (!code) return null;
  const name = oneLine(variant.name);
  const price = ownPrice(variant, product);
  return [`- ${code}${name ? `: ${name}` : ""}`, price ? `price: ${price}` : "", variant.available ? "" : "OUT OF STOCK"]
    .filter(Boolean)
    .join(" | ");
}

function alternatives(product: CatalogProduct): (string | null)[] {
  const seen = new Set([product.id]);
  return asArray(product.related).map((related) => {
    const name = oneLine(related?.name);
    if (!name || seen.has(related.id)) return null;
    seen.add(related.id);
    return block(`- ${name}: `, related.note) ?? `- ${name}`;
  });
}

function listSection(title: string, items: (string | null)[]): string | null {
  const kept = items.filter((item): item is string => Boolean(item));
  return kept.length ? [`${title}:`, ...kept].join("\n") : null;
}

/**
 * The full card as labelled plain text: name, code, price, availability,
 * description, the brand's attributes with their labels and units (BOOLEAN
 * as yes/no), how to use, strengths, comparisons, suitable for, known
 * questions and worries (Q:/A:), colours or types (code, name, price if
 * different, OUT OF STOCK), alternatives (name and why), product page link.
 * Empty sections are left out. A value keeps its lines, indented under its
 * label, so it cannot fake a new label or a new card.
 */
export function formatProductCard(product: CatalogProduct, attributes: CatalogAttribute[]): string {
  const code = oneLine(product.code);
  const landingUrl = oneLine(product.landingUrl);
  return [
    `#### ${productName(product)}`,
    code ? `Code: ${code}` : null,
    `Price: ${oneLine(product.price) || NO_PRICE}`,
    `Availability: ${product.available ? "in stock" : "OUT OF STOCK"}`,
    block("Description: ", product.description),
    listSection("Characteristics", characteristics(product, attributes)),
    block("How to use: ", product.howToUse),
    listSection(
      "Strengths",
      asArray(product.strengths).map((strength) => block("- ", strength))
    ),
    block("Comparisons: ", product.comparisons),
    block("Suitable for: ", product.suitableFor),
    listSection("Known questions and worries", asArray(product.objections).map(objection)),
    listSection(
      "Colours or types",
      asArray(product.variants).map((variant) => cardVariant(variant, product))
    ),
    listSection("Alternatives you may suggest", alternatives(product)),
    landingUrl ? `Product page: ${landingUrl}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

// ─── What the conversation mentions ─────────────────────────────────────────

/**
 * Text as it is compared: lower case, without accents, Arabic diacritics,
 * tatweel or invisible marks, one spelling for hamza (أ إ آ ؤ ئ), taa
 * marbuta and alef maqsura, ASCII digits. "nº" and "№" keep meaning "number".
 */
function fold(text: string): string {
  // Plain ASCII has nothing below to change but its case.
  if (/^[\x00-\x7f]*$/.test(text)) return text.toLowerCase();
  return text
    .replace(/º/g, "°")
    .replace(/№/g, "#")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\p{M}\p{Cf}\u0640]/gu, "")
    .replace(/ٱ/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/[ىی]/g, "ي")
    .replace(/ک/g, "ك")
    .replace(/(?![0-9])\p{Nd}/gu, (digit) => normalizeCode(digit));
}

interface Token {
  text: string;
  /** The token as a piece of code: normalizeCode(text). */
  code: string;
  start: number;
  end: number;
  arabic: boolean;
}

// Arabic words and everything else are separate tokens: "اللون12" is a word
// and a number. Latin letters and digits stay together: "wp12" is one code.
const TOKEN = /(?:(?=\p{Script=Arabic})\p{L})+|(?:(?!\p{Script=Arabic})[\p{L}\p{N}])+/gu;
const ARABIC_START = /^\p{Script=Arabic}/u;

function tokenize(folded: string): Token[] {
  return [...folded.matchAll(TOKEN)].map((match) => ({
    text: match[0],
    code: normalizeCode(match[0]),
    start: match.index,
    end: match.index + match[0].length,
    arabic: ARABIC_START.test(match[0]),
  }));
}

interface Mention {
  ids: string[];
  start: number;
  end: number;
}

// ── Codes ──

interface CodeIndex {
  ids: Map<string, string[]>;
  longest: number;
}

function indexCodes(products: CatalogProduct[]): CodeIndex {
  const ids = new Map<string, string[]>();
  // Colour codes repeat from product to product ("1" to "30"): each is read once.
  const keys = new Map<string, string>();
  let longest = 0;
  const add = (code: unknown, id: string) => {
    if (typeof code !== "string") return;
    let key = keys.get(code);
    if (key === undefined) {
      key = normalizeCode(fold(code));
      keys.set(code, key);
    }
    if (!key || key.length > MAX_CODE_LENGTH) return;
    const list = ids.get(key);
    // A product's codes come one after the other: a repeat is the last id.
    if (!list) ids.set(key, [id]);
    else if (list[list.length - 1] !== id) list.push(id);
    longest = Math.max(longest, key.length);
  };
  for (const product of products) {
    add(product.code, product.id);
    for (const variant of asArray(product.variants)) add(variant?.code, product.id);
  }
  return { ids, longest };
}

/** What may stand inside a code, as normalizeCode drops it: "WP-12", "WP 12", "WP#12". */
const CODE_GAP = /^[\s\-_./#:‐-―]*$/;

/**
 * "12" alone is a quantity or a size as often as a colour ("نحب 12 حبة"), and
 * a single letter is a word ("l'eau", "il a"): such a code counts only after
 * a word meaning colour, number or code, or written like "#12".
 */
function needsContext(key: string): boolean {
  return /^\d{1,2}$/.test(key) || key.length === 1;
}

const CONTEXT_WORD =
  /^(?:couleurs?|coloris|colou?rs?|numeros?|num|number|refs?|references?|codes?|loun|ra9m|[وف]?(?:بال|كال|ال|لل|ب|ك|ل)?(?:لون|الوان|رقم|ارقام|كود|اكواد|نمره|نومرو))$/u;
/** The word and the number written as one: "ref12", "code12", "couleur12". */
const CONTEXT_PREFIX = /^(?:couleur|coloris|colou?r|numero|num|number|ref|reference|code|no|loun|ra9m)(\d+)$/;

function hasContext(tokens: Token[], i: number, folded: string): boolean {
  const before = folded.slice(i > 0 ? tokens[i - 1].end : 0, tokens[i].start);
  if (/#\s*$/.test(before)) return true;
  if (i === 0) return false;
  const word = tokens[i - 1].text;
  if (word === "n") return /^°[\s:.-]*$/.test(before);
  if (word === "no") return /^\.[\s:.-]*$/.test(before);
  return CONTEXT_WORD.test(word) && /^[\s:.-]*$/.test(before);
}

/** Codes from left to right, the longest one at each place: "WP 12" is WP-12, not colour 12. */
function codeMentions(tokens: Token[], folded: string, codes: CodeIndex): Mention[] {
  const found: Mention[] = [];
  let i = 0;
  while (i < tokens.length) {
    let key = "";
    let match: { ids: string[]; last: number } | null = null;
    for (let j = i; j < tokens.length; j++) {
      if (j > i && !CODE_GAP.test(folded.slice(tokens[j - 1].end, tokens[j].start))) break;
      key += tokens[j].code;
      if (key.length > codes.longest) break;
      const ids = codes.ids.get(key);
      if (ids && (!needsContext(key) || hasContext(tokens, i, folded))) match = { ids, last: j };
    }
    if (!match) {
      const glued = CONTEXT_PREFIX.exec(tokens[i].text);
      const ids = glued ? codes.ids.get(normalizeCode(glued[1])) : undefined;
      if (ids) match = { ids, last: i };
    }
    if (match) {
      found.push({ ids: match.ids, start: tokens[i].start, end: tokens[match.last].end });
      i = match.last + 1;
    } else {
      i += 1;
    }
  }
  return found;
}

// ── Names ──

interface NameEntry {
  id: string;
  words: Token[];
}

/** "ال" is often added or left out: "الباب" and "باب" are one word. */
function withoutArticle(word: string): string {
  return word.length >= 5 && word.startsWith("ال") ? word.slice(2) : word;
}

function wordKey(token: Token): string {
  return token.arabic ? withoutArticle(token.text) : token.text;
}

/** و ف, then ب ك ل or ال, written onto the first word: "بالأريكة", "للباب", "والمرآة". */
const CLITICS = ["", "و", "ف"]
  .flatMap((conjunction) => ["", "بال", "كال", "ال", "لل", "ب", "ك", "ل"].map((prefix) => conjunction + prefix))
  .filter(Boolean);

function firstWordKeys(token: Token): string[] {
  if (!token.arabic) return [token.text];
  const keys = new Set([withoutArticle(token.text)]);
  for (const clitic of CLITICS) {
    if (token.text.length - clitic.length >= 3 && token.text.startsWith(clitic)) {
      keys.add(withoutArticle(token.text.slice(clitic.length)));
    }
  }
  return [...keys];
}

function indexNames(products: CatalogProduct[]): Map<string, NameEntry[]> {
  const names = new Map<string, NameEntry[]>();
  for (const product of products) {
    const folded = fold(typeof product.name === "string" ? product.name : "");
    // "TV", "A4": too short to tell a name from a word.
    if ((folded.match(/\p{L}/gu) ?? []).length < 3) continue;
    const words = tokenize(folded);
    if (!words.length) continue;
    const key = wordKey(words[0]);
    const entry = { id: product.id, words };
    const list = names.get(key);
    if (list) list.push(entry);
    else names.set(key, [entry]);
  }
  return names;
}

/** Between the words of a name: a space, a dash, an apostrophe... never a new line. */
const NAME_GAP = /^[^\p{L}\p{N}\r\n]{0,3}$/u;

/** Whole words only: "Lin" is not in "linge", "باب" is not in "بابور". */
function nameMentions(tokens: Token[], folded: string, names: Map<string, NameEntry[]>): Mention[] {
  const found: Mention[] = [];
  tokens.forEach((token, i) => {
    const entries = new Set(firstWordKeys(token).flatMap((key) => names.get(key) ?? []));
    for (const entry of entries) {
      const last = i + entry.words.length - 1;
      if (last >= tokens.length) continue;
      const whole = entry.words.every((word, k) => {
        if (k === 0) return true;
        const next = tokens[i + k];
        return (
          NAME_GAP.test(folded.slice(tokens[i + k - 1].end, next.start)) &&
          next.arabic === word.arabic &&
          wordKey(next) === wordKey(word)
        );
      });
      if (whole) found.push({ ids: [entry.id], start: token.start, end: tokens[last].end });
    }
  });
  return found;
}

/**
 * One mention per place: the same span names all its products, and a span
 * inside a longer one is dropped ("Lambris PVC" inside "Lambris PVC 3D").
 */
function outermost(mentions: Mention[]): Mention[] {
  const bySpan = new Map<string, Mention>();
  for (const mention of mentions) {
    const span = `${mention.start}:${mention.end}`;
    const same = bySpan.get(span);
    bySpan.set(span, same ? { ...same, ids: [...new Set([...same.ids, ...mention.ids])] } : mention);
  }
  const merged = [...bySpan.values()];
  return merged.filter(
    (mention) =>
      !merged.some(
        (other) =>
          other.start <= mention.start && other.end >= mention.end && other.end - other.start > mention.end - mention.start
      )
  );
}

/**
 * Products the conversation mentions: by product code, by colour/type code,
 * or by name.
 *
 * Codes compare with normalizeCode, after the same folding as names
 * ("wp-12", "WP 12", "ＷＰ１２" and "WP-١٢" are one code), on whole tokens
 * ("WP-120" is not WP-12). A code made only of 1-2 digits ("12"), or of one
 * character, matches only after a word meaning colour/number/code (لون،
 * اللون، رقم، كود، نمرة، couleur, coloris, numéro, n°, ref, code, color,
 * colour...) or when written like "#12". Names match as whole words,
 * ignoring case, accents, diacritics and the Arabic hamza/taa marbuta/alef
 * maqsura variations, with the Arabic article and clitics allowed on the
 * first word ("بالأريكة"); names of fewer than 3 letters never match.
 *
 * A code several products share means only the ones the conversation also
 * names or codes on their own, when there are some.
 *
 * Returns product ids, most recently mentioned first (texts are given oldest
 * first; within a text, a later mention is more recent).
 */
export function mentionedProductIds(products: CatalogProduct[], texts: string[]): string[] {
  const codes = indexCodes(products);
  const names = indexNames(products);
  const perText = texts.map((text) => {
    const folded = fold(typeof text === "string" ? text : "");
    const tokens = tokenize(folded);
    return outermost([...codeMentions(tokens, folded, codes), ...nameMentions(tokens, folded, names)]);
  });

  const named = new Set(perText.flat().flatMap((mention) => (mention.ids.length === 1 ? mention.ids : [])));
  const latest = new Map<string, { text: number; at: number }>();
  perText.forEach((mentions, text) => {
    for (const mention of mentions) {
      const sure = mention.ids.filter((id) => named.has(id));
      for (const id of sure.length ? sure : mention.ids) {
        const seen = latest.get(id);
        if (!seen || text > seen.text || (text === seen.text && mention.start > seen.at)) {
          latest.set(id, { text, at: mention.start });
        }
      }
    }
  });

  const order = new Map<string, number>();
  products.forEach((product, index) => {
    if (!order.has(product.id)) order.set(product.id, index);
  });
  return [...latest.entries()]
    .sort(([a, x], [b, y]) => y.text - x.text || y.at - x.at || (order.get(a) ?? 0) - (order.get(b) ?? 0))
    .map(([id]) => id);
}

// ─── The cards and the section ──────────────────────────────────────────────

/**
 * The products to show as full cards: the campaign's product, then the focus
 * ids (in the given order), then the mentioned ids; no duplicates, unknown
 * ids skipped, at most `max`.
 */
export function selectCardProducts(
  products: CatalogProduct[],
  ids: { campaignProductId?: string | null; focusIds?: string[]; mentionedIds?: string[] },
  max: number = DEFAULT_MAX_FULL_CARDS
): CatalogProduct[] {
  const limit = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : DEFAULT_MAX_FULL_CARDS;
  const byId = new Map<string, CatalogProduct>();
  for (const product of products) if (!byId.has(product.id)) byId.set(product.id, product);
  const cards: CatalogProduct[] = [];
  const chosen = new Set<string>();
  for (const id of [ids.campaignProductId, ...asArray(ids.focusIds), ...asArray(ids.mentionedIds)]) {
    if (cards.length >= limit) break;
    const product = id ? byId.get(id) : undefined;
    if (!product || chosen.has(product.id)) continue;
    chosen.add(product.id);
    cards.push(product);
  }
  return cards;
}

const GUIDE_INDEX =
  "The index lists the products, one line each: name, code, price, availability and colours or types. It is only a list.";
const GUIDE_CARDS = "The full cards below give the details of the products this conversation is about.";
const GUIDE_NO_CARDS = "No full card is shown in this conversation.";
const GUIDE_RULES = [
  "When the customer asks about a detail that is not written in a full card (a characteristic, a measurement, how to use it, a comparison...), never guess it and never take it from another product: ask which product they mean (its name or code), or hand off with NOT_IN_KB.",
  "Customers write codes their own way: in lower case, with spaces or dashes, or with Arabic digits.",
  "OUT OF STOCK means the shop sells it but does not have it now.",
].join(" ");

/**
 * The catalog section of the system instruction: the index, then the full
 * cards, after a few sentences telling the model the index only lists the
 * products and that it must ask or hand off for any detail that is not in a
 * full card. "" when there is nothing to show.
 */
export function buildCatalogSection(
  products: CatalogProduct[],
  cards: CatalogProduct[],
  attributes: CatalogAttribute[]
): string {
  const index = formatCatalogIndex(products);
  const cardTexts = cards.map((card) => formatProductCard(card, attributes));
  if (!index && cardTexts.length === 0) return "";
  const guide = [index ? GUIDE_INDEX : "", cardTexts.length ? GUIDE_CARDS : GUIDE_NO_CARDS, GUIDE_RULES]
    .filter(Boolean)
    .join(" ");
  const parts = [`## PRODUCT CATALOG\n${guide}`];
  if (index) parts.push(`### INDEX (every product, one line each)\n${index}`);
  if (cardTexts.length) parts.push(`### FULL CARDS (the products this conversation is about)\n\n${cardTexts.join("\n\n")}`);
  return parts.join("\n\n");
}

/**
 * Every text the model was shown about the catalog (the index and the
 * cards), for the guard: a number or a link of the reply may come from here.
 */
export function catalogReferenceTexts(
  products: CatalogProduct[],
  cards: CatalogProduct[],
  attributes: CatalogAttribute[]
): string[] {
  return [formatCatalogIndex(products), ...cards.map((card) => formatProductCard(card, attributes))].filter(Boolean);
}
