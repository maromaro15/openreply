/**
 * The order the bot collects once a customer is ready to buy (PLAN.md 6.16).
 *
 * In every answer the model returns, in its JSON, an `order` object with what
 * the customer has given in the whole conversation so far. mergeOrder merges
 * it into the conversation's draft and checks each value: a wilaya among the
 * 58, an Algerian or international phone number, a quantity, one of the
 * product's colours or types, a name. When every required detail is there
 * (isOrderComplete), the conversation goes to a person as ORDER_READY with
 * orderSummary. Until then the model reads the draft (formatOrderSection) and
 * asks for what is missing.
 *
 * Customers write Algerian Darija in Arabic or Latin letters, French, English
 * or Arabic, with Arabic or Western digits: every check reads them all.
 *
 * Pure functions: no database, no network, no environment.
 */
import { normalizeCode } from "@/lib/catalog/codes";
import { mentionedProductIds, type CatalogProduct, type CatalogVariant } from "@/lib/catalog/prompt";
import { normalizeDigits } from "./guard";

// ─── The fields ─────────────────────────────────────────────────────────────

export const ORDER_FIELDS = ["WILAYA", "COLOUR", "QUANTITY", "NAME", "PHONE", "ADDRESS"] as const;
export type OrderFieldValue = (typeof ORDER_FIELDS)[number];

/** What a shop asks for until it changes the list (PLAN.md 6.16). */
export const DEFAULT_ORDER_FIELDS: OrderFieldValue[] = ["WILAYA", "COLOUR", "QUANTITY", "NAME", "PHONE"];

export const ORDER_FIELD_LABELS: Record<OrderFieldValue, string> = {
  WILAYA: "Wilaya",
  COLOUR: "Colour or type",
  QUANTITY: "Quantity",
  NAME: "Name",
  PHONE: "Phone number",
  ADDRESS: "Address",
};

const PRODUCT_LABEL = "Product";

/** The longest value kept or shown, in characters (code points). */
const LIMITS: Record<OrderFieldValue, number> = {
  WILAYA: 60,
  COLOUR: 60,
  QUANTITY: 40,
  NAME: 60,
  PHONE: 40,
  ADDRESS: 200,
};
const PRODUCT_NAME_LIMIT = 120;
const PROBLEM_LIMIT = 400;
/** No detail needs more: longer model output is not read further. */
const READ_LIMIT = 2000;
const MAX_QUANTITY = 10_000;

function isOrderField(value: unknown): value is OrderFieldValue {
  return typeof value === "string" && (ORDER_FIELDS as readonly string[]).includes(value);
}

/**
 * The fields of a stored list (BotSettings.orderFields is a String[]): the
 * known ones, each once, in the given order. Anything else gives [].
 */
export function parseOrderFields(value: unknown): OrderFieldValue[] {
  if (!Array.isArray(value)) return [];
  const fields: OrderFieldValue[] = [];
  for (const item of value) if (isOrderField(item) && !fields.includes(item)) fields.push(item);
  return fields;
}

// ─── What the model returns ─────────────────────────────────────────────────

const AS_GIVEN = "as the customer gave it anywhere in the conversation; an empty string when not given";

function given(what: string): { type: "STRING"; description: string } {
  return { type: "STRING", description: `${what}, ${AS_GIVEN}` };
}

const MODEL_KEYS = ["product", "colour", "quantity", "wilaya", "name", "phone", "address"] as const;
type ModelKey = (typeof MODEL_KEYS)[number];

/**
 * The `order` property of the model's JSON answer, as a Gemini
 * responseSchema. Every detail is a string in the customer's own words: the
 * code checks it, not the model.
 */
export const ORDER_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "OBJECT",
  description:
    "What the customer has given for an order in the whole conversation so far. When they changed a detail, give the newest one.",
  properties: {
    product: given("The product they want to order, by its name or code"),
    colour: given("The colour or type they chose, by its code or name"),
    quantity: given("How many they want"),
    wilaya: given("The wilaya to deliver to"),
    name: given("The full name for the order"),
    phone: given("The phone number for the order"),
    address: given("The delivery address: commune, street, building"),
  },
  required: [...MODEL_KEYS],
  propertyOrdering: [...MODEL_KEYS],
};

// ─── The draft ──────────────────────────────────────────────────────────────

export interface OrderDraft {
  productId: string | null;
  productName: string | null;
  /** When the colour matched one of the product's colours or types. */
  variantCode: string | null;
  /** Checked values, ready to show: "31 - Oran", "0550123456", "2", "12-04 Gris"... */
  values: Partial<Record<OrderFieldValue, string>>;
  /** Why a value the customer gave was not taken, in English, for the prompt: "«0550» is not a valid phone number". */
  problems: Partial<Record<OrderFieldValue, string>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function fieldTexts(value: unknown): Partial<Record<OrderFieldValue, string>> {
  const texts: Partial<Record<OrderFieldValue, string>> = {};
  if (!isRecord(value)) return texts;
  for (const field of ORDER_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) continue;
    const text = textOrNull(value[field]);
    if (text) texts[field] = text;
  }
  return texts;
}

/**
 * The draft stored on the conversation, read tolerantly: unknown keys are
 * dropped, a value of the wrong type is absent, and null means nothing
 * usable. Always a fresh object: changing it never changes the input.
 */
export function parseOrderDraft(json: unknown): OrderDraft | null {
  if (!isRecord(json)) return null;
  const draft: OrderDraft = {
    productId: textOrNull(json.productId),
    productName: textOrNull(json.productName),
    variantCode: textOrNull(json.variantCode),
    values: fieldTexts(json.values),
    problems: fieldTexts(json.problems),
  };
  const usable =
    draft.productId !== null ||
    draft.productName !== null ||
    draft.variantCode !== null ||
    Object.keys(draft.values).length > 0 ||
    Object.keys(draft.problems).length > 0;
  return usable ? draft : null;
}

// ─── Plain text ─────────────────────────────────────────────────────────────

// JavaScript's \s has no U+0085 (NEL), a line break all the same.
const SPACES = /[\s\u0085]+/gu;
/** Controls, zero-width spaces and the marks that reorder text on screen. */
const INVISIBLE = /[\p{Cc}\u{61C}\u{200B}\u{200E}\u{200F}\u{202A}-\u{202E}\u{2060}\u{2066}-\u{2069}]/gu;

/** The value on one line: line breaks and runs of spaces become one space. */
function oneLine(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .slice(0, READ_LIMIT)
    .replace(SPACES, " ")
    .replace(INVISIBLE, "")
    .replace(/ {2,}/g, " ")
    .trim();
}

/** At most `limit` characters, never half of one. */
function cut(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const characters = Array.from(text);
  return characters.length <= limit ? text : characters.slice(0, limit).join("").trimEnd();
}

/**
 * A customer's value as the prompt shows it, inside «»: one line, cut to
 * its limit, its own « and » made plain quotes so it cannot close its quote.
 */
function quoted(value: unknown, limit: number): string {
  return `«${cut(oneLine(value).replace(/[«»]/g, '"'), limit)}»`;
}

/**
 * Text as it is compared: lower case, without accents, Arabic diacritics,
 * tatweel or invisible marks, one spelling for the hamza forms, taa marbuta
 * and alef maqsura, the Maghrebi letters (ڨ ڤ) as in official spellings,
 * ASCII digits.
 */
function fold(text: string): string {
  return normalizeDigits(
    text
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[\p{M}\p{Cf}\u{640}]/gu, "")
      .replace(/ٱ/g, "ا")
      .replace(/ء/g, "")
      .replace(/ة/g, "ه")
      .replace(/[ىی]/g, "ي")
      .replace(/ک/g, "ك")
      .replace(/[ڨگ]/g, "ق")
      .replace(/ڤ/g, "ف")
      .replace(/پ/g, "ب")
  );
}

// Arabic words and everything else are separate tokens: "ولاية16" is a word
// and a number. Latin letters and digits stay together: "wa7ed" is a word.
const TOKEN = /(?:(?=\p{Script=Arabic})\p{L})+|(?:(?!\p{Script=Arabic})[\p{L}\p{N}])+/gu;
const ARABIC = /^\p{Script=Arabic}/u;

function tokensOf(folded: string): string[] {
  return folded.match(TOKEN) ?? [];
}

/** و ف ب ك ل written with "ال": "بالأحمر", "للجزائر", "والأسود". */
const ARTICLE_CLITICS = ["وبال", "وال", "فال", "بال", "كال", "لل"];

/** An Arabic word without its article: "الرمادي" is "رمادي", "بالجزائر" is "جزائر". */
function withoutArticle(word: string): string {
  if (!ARABIC.test(word)) return word;
  for (const prefix of ARTICLE_CLITICS) {
    if (word.startsWith(prefix) && word.length - prefix.length >= 3) return word.slice(prefix.length);
  }
  return word.length >= 5 && word.startsWith("ال") ? word.slice(2) : word;
}

/** Words that mean "nothing": a model sometimes writes them instead of "". */
const PLACEHOLDERS = new Set(
  [
    "null", "none", "na", "n a", "undefined", "unknown", "empty", "not given", "not provided",
    "not specified", "not mentioned", "aucun", "aucune", "inconnu", "non precise", "non renseigne",
    "non fourni", "لا يوجد", "غير محدد", "غير معروف", "لا شيء",
  ].map((word) => fold(word))
);

/** A detail the model gave: one line, or "" when it holds no letter, no digit, or means nothing. */
function detail(value: unknown): string {
  const text = typeof value === "number" && Number.isFinite(value) ? String(value) : oneLine(value);
  if (!/[\p{L}\p{N}]/u.test(text)) return "";
  const key = fold(text)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return PLACEHOLDERS.has(key) ? "" : text;
}

function readModelOrder(value: unknown): Record<ModelKey, string> {
  const order = isRecord(value) ? value : {};
  const details = {} as Record<ModelKey, string>;
  for (const key of MODEL_KEYS) {
    details[key] = Object.prototype.hasOwnProperty.call(order, key) ? detail(order[key]) : "";
  }
  return details;
}

// ─── Wilayas ────────────────────────────────────────────────────────────────

/**
 * The 58 wilayas as numbered since law 19-12 of 11 December 2019: number,
 * official French name, Arabic name, then other spellings customers use.
 * Case, accents, hamza, "El"/"Al"/"ال", hyphens and spaces are handled by
 * the matching and need no spelling of their own.
 */
const WILAYA_TABLE: readonly (readonly [number, string, string, readonly string[]])[] = [
  [1, "Adrar", "أدرار", []],
  [2, "Chlef", "الشلف", ["Chelf", "Chleff", "Cheliff", "Ech Chlef", "Ech Cheliff", "El Asnam", "الأصنام"]],
  [3, "Laghouat", "الأغواط", ["Lagouat", "Laghwat", "Lghouat", "Lghwat", "لغواط"]],
  [4, "Oum El Bouaghi", "أم البواقي", ["Oum El Bouagui", "Oum El Bouaki", "Oum Lbouaghi", "OEB"]],
  [5, "Batna", "باتنة", []],
  [6, "Béjaïa", "بجاية", ["Bejaya", "Bedjaia", "Bgayet", "Bgayeth", "Vgayet", "Bougie", "بقايت"]],
  [7, "Biskra", "بسكرة", ["Beskra", "Bskra"]],
  [8, "Béchar", "بشار", ["Bchar"]],
  [9, "Blida", "البليدة", ["Leblida", "Lblida"]],
  [10, "Bouira", "البويرة", ["Bouirah"]],
  [11, "Tamanrasset", "تمنراست", ["Tamanghasset", "Tamenrasset", "Tam", "تمنغست", "تامنغست"]],
  [12, "Tébessa", "تبسة", ["Tbessa", "Tbassa"]],
  [13, "Tlemcen", "تلمسان", ["Tlemsen", "Tlemsan", "Tilimsan"]],
  [14, "Tiaret", "تيارت", ["Tihert", "Tiharet", "Tyaret"]],
  [15, "Tizi Ouzou", "تيزي وزو", ["Tizi", "Tizi Wezzu", "Tizi Ouzzou", "تيزي"]],
  [
    16,
    "Alger",
    "الجزائر",
    [
      "Algiers", "Algier", "Dzayer", "Dzair", "Djazair", "Djazayer", "Jazair", "Assima", "L3assima",
      "La capitale", "الجزائر العاصمة", "العاصمة", "دزاير", "دزاير العاصمة",
    ],
  ],
  [17, "Djelfa", "الجلفة", ["Jelfa", "Djalfa", "Jalfa"]],
  [18, "Jijel", "جيجل", ["Djidjel", "Djidjelli", "Jijelli"]],
  [19, "Sétif", "سطيف", ["Stif", "Sitif"]],
  [20, "Saïda", "سعيدة", []],
  [21, "Skikda", "سكيكدة", []],
  [22, "Sidi Bel Abbès", "سيدي بلعباس", ["Sidi Belabbes", "Sidi Bel Abes", "Sidi Belabes", "Bel Abbes", "Belabbes", "SBA", "بلعباس"]],
  [23, "Annaba", "عنابة", ["Anaba", "Ennaba", "3annaba", "Bône"]],
  [24, "Guelma", "قالمة", ["Galma", "Qalma"]],
  [25, "Constantine", "قسنطينة", ["Qsentina", "Qacentina", "Ksentina", "Ksantina", "Qsantina", "Qasantina", "Constantina", "قسمطينة"]],
  [26, "Médéa", "المدية", ["Lemdiya", "Lemdia", "Midya"]],
  [27, "Mostaganem", "مستغانم", ["Mosta", "Mestghanem", "Mostghanem"]],
  [28, "M'Sila", "المسيلة", ["Msilla", "Lemsila"]],
  [29, "Mascara", "معسكر", ["Mouaskar", "Mouasker", "Maaskar", "Mo3askar", "Mo3asker"]],
  [30, "Ouargla", "ورقلة", ["Wargla", "Ouergla", "Warqla"]],
  [31, "Oran", "وهران", ["Wahran", "Wehran", "Ouahran", "Wihran"]],
  [32, "El Bayadh", "البيض", ["El Bayad"]],
  [33, "Illizi", "إليزي", ["Ilizi", "ايليزي"]],
  [34, "Bordj Bou Arréridj", "برج بوعريريج", ["Bordj Bouarreridj", "Bordj Bou Areridj", "Bordj Bou Arerridj", "BBA"]],
  [35, "Boumerdès", "بومرداس", ["Boumerdas"]],
  [36, "El Tarf", "الطارف", ["Et Tarf"]],
  [37, "Tindouf", "تندوف", ["Tinduf"]],
  [38, "Tissemsilt", "تيسمسيلت", ["Tissemsilet", "Tisemsilt"]],
  [39, "El Oued", "الوادي", ["Oued Souf", "Souf", "El Wad", "وادي سوف", "الواد", "سوف"]],
  [40, "Khenchela", "خنشلة", ["Khenchla", "Khanchla", "Khenshela"]],
  [41, "Souk Ahras", "سوق أهراس", ["Souq Ahras"]],
  [42, "Tipaza", "تيبازة", ["Tipasa", "Tibaza"]],
  [43, "Mila", "ميلة", []],
  [44, "Aïn Defla", "عين الدفلى", ["Ain Difla", "عين الدفلة"]],
  [45, "Naâma", "النعامة", []],
  [46, "Aïn Témouchent", "عين تموشنت", ["Temouchent", "Ain Timouchent", "تموشنت"]],
  [47, "Ghardaïa", "غرداية", ["Ghardaya"]],
  [48, "Relizane", "غليزان", ["Ghilizane", "Ghelizane", "Ighil Izane", "Relizan"]],
  [49, "Timimoun", "تيميمون", ["Timimoune"]],
  [50, "Bordj Badji Mokhtar", "برج باجي مختار", ["Bordj Baji Mokhtar", "BBM"]],
  [51, "Ouled Djellal", "أولاد جلال", ["Oulad Djellal", "Ouled Jellal"]],
  [52, "Béni Abbès", "بني عباس", ["Beni Abbas", "Beni Abes"]],
  [53, "In Salah", "عين صالح", ["Ain Salah", "Insalah"]],
  [54, "In Guezzam", "عين قزام", ["Ain Guezzam", "In Gezzam"]],
  [55, "Touggourt", "تقرت", ["Tougourt", "Tuggurt", "Tuggourt", "Teggourt"]],
  [56, "Djanet", "جانت", ["Janet"]],
  [57, "El M'Ghair", "المغير", ["El Mghaier", "El Meghaier", "Meghaier"]],
  [58, "El Meniaa", "المنيعة", ["El Menia", "El Menea", "El Ménéa", "El Goléa"]],
];

interface Wilaya {
  number: number;
  /** "16 - Alger": the number on two digits, as Algerian lists write it. */
  name: string;
  arabic: string;
}

const WILAYAS: Wilaya[] = WILAYA_TABLE.map(([number, french, arabic]) => ({
  number,
  name: `${String(number).padStart(2, "0")} - ${french}`,
  arabic,
}));

/** Words around a place name that are not part of it: "wilaya de", "ولاية", "f wahran", "من وهران". */
const PLACE_FILLERS = new Set(
  [
    "wilaya", "wilayat", "wilayet", "willaya", "wlaya", "wlayat", "w", "province", "ville", "city", "centre",
    "center", "commune", "de", "d", "du", "des", "a", "la", "le", "of", "the", "f", "fi", "men", "mn", "min",
    "ولاية", "بولاية", "لولاية", "فولاية", "ولايت", "مدينة", "بلدية", "من", "في", "ف",
  ].map((word) => fold(word))
);
const LATIN_ARTICLES = new Set(["el", "al", "l", "ech"]);
/** "w16", "wilaya16": the word and the number written as one. */
const GLUED_NUMBER = /^(?:w|wilaya|wilayat|willaya|wlaya)(\d+)$/;

interface PlaceWords {
  /** Every word, without its Arabic article. */
  all: string[];
  /** The same without articles and fillers. */
  clean: string[];
  numbers: string[];
}

function placeWords(text: string): PlaceWords {
  const words: PlaceWords = { all: [], clean: [], numbers: [] };
  for (const token of tokensOf(fold(text))) {
    const glued = GLUED_NUMBER.exec(token);
    if (glued || /^\d+$/.test(token)) {
      words.numbers.push(glued ? glued[1] : token);
      continue;
    }
    const word = withoutArticle(token);
    words.all.push(word);
    if (!LATIN_ARTICLES.has(word) && !PLACE_FILLERS.has(word) && !PLACE_FILLERS.has(token)) words.clean.push(word);
  }
  return words;
}

/** Every spelling, by its words joined: null when two wilayas share it. */
const WILAYA_BY_KEY = new Map<string, Wilaya | null>();
for (const [number, french, arabic, others] of WILAYA_TABLE) {
  const wilaya = WILAYAS[number - 1];
  for (const spelling of [french, arabic, ...others]) {
    const words = placeWords(spelling);
    for (const key of [words.clean.join(""), words.all.join("")]) {
      if (!key) continue;
      const known = WILAYA_BY_KEY.get(key);
      WILAYA_BY_KEY.set(key, known === undefined || known === wilaya ? wilaya : null);
    }
  }
}

const SHORT_CLITICS = ["ب", "ل", "ف", "و"];

function wilayaOfWords(words: PlaceWords): Wilaya | null {
  const keys = [words.clean.join(""), words.all.join("")];
  // "بوهران", "لوهران": a clitic on the first word, only when the word itself is no wilaya.
  const [first, ...rest] = words.clean;
  if (first && ARABIC.test(first)) {
    for (const clitic of SHORT_CLITICS) {
      if (first.startsWith(clitic) && first.length > 3) keys.push([withoutArticle(first.slice(1)), ...rest].join(""));
    }
  }
  for (const key of keys) {
    const found = WILAYA_BY_KEY.get(key);
    if (found !== undefined) return found;
  }
  return null;
}

/**
 * One place: a name, a number, or both when they agree ("16 الجزائر",
 * "31 - Oran"). A number of three digits or more (a postal code, a phone
 * number) is no wilaya number: it only passes next to a name.
 */
function readPlace(text: string): Wilaya | null {
  const words = placeWords(text);
  const numbers = words.numbers.map((digits) => digits.replace(/^0+(?=\d)/, ""));
  const small = numbers.filter((digits) => digits.length <= 2).map(Number);
  if (words.clean.length > 0) {
    const wilaya = wilayaOfWords(words);
    return wilaya && small.every((number) => number === wilaya.number) ? wilaya : null;
  }
  if (numbers.some((digits) => digits.length > 2) || new Set(small).size !== 1) return null;
  return WILAYAS[small[0] - 1] ?? null;
}

/** Between a wilaya and what comes with it: "Bab El Oued, Alger", "Oran (Bir El Djir)". */
const PLACE_SEPARATORS = /[,،؛;/|()[\]{}\n\r]+|\s[-\u{2013}\u{2014}]\s/u;

/**
 * One of the 58 wilayas, by its number ("16", "wilaya 16", "W16", "ولاية
 * ١٦"), its name in French, Arabic or a common spelling (Alger, Algiers,
 * Dzayer, الجزائر العاصمة, العاصمة, Wahran, Qsentina, Stif, Bgayet...), or
 * both ("16 الجزائر"). A name and a number that disagree, two wilayas, or
 * an unknown place give null.
 */
export function normalizeWilaya(text: string): { number: number; name: string; arabic: string } | null {
  if (typeof text !== "string") return null;
  const value = text.slice(0, 300);
  let wilaya = readPlace(value);
  if (!wilaya) {
    const found = new Set<Wilaya>();
    for (const part of value.split(PLACE_SEPARATORS)) {
      const place = readPlace(part);
      if (place) found.add(place);
    }
    wilaya = found.size === 1 ? [...found][0] : null;
  }
  return wilaya ? { number: wilaya.number, name: wilaya.name, arabic: wilaya.arabic } : null;
}

// ─── Phone numbers ──────────────────────────────────────────────────────────

/** Mobiles: 05 (Ooredoo), 06 (Mobilis), 07 (Djezzy), then 8 digits. */
const ALGERIAN_MOBILE = /^0[567]\d{8}$/;
/** Landlines: 0, a two-digit area code (021 Alger, 031 Constantine, 041 Oran... all start with 2, 3 or 4), 6 digits. */
const ALGERIAN_LANDLINE = /^0[234]\d{7}$/;

function algerian(national: string): string | null {
  return ALGERIAN_MOBILE.test(national) || ALGERIAN_LANDLINE.test(national) ? national : null;
}

/**
 * A phone number in its national form ("0550123456", "021234567"), or an
 * international one ("+33612345678").
 *
 * Algerian numbers: mobiles 05, 06 or 07 followed by 8 digits (10 digits);
 * landlines 0, an area code starting with 2, 3 or 4, then 7 digits (9
 * digits). Spaces, dots, dashes, slashes and brackets are dropped, Arabic
 * digits read, and +213, 00213 or 213 become the national 0 (with or
 * without the 0 after them, as in "+213 (0) 550…"). Any other country: "+"
 * or 00, then 8 to 15 digits. Letters, two numbers, or any other length:
 * null.
 */
export function normalizePhone(text: string): string | null {
  if (typeof text !== "string" || text.length > 64) return null;
  const compact = normalizeDigits(text.normalize("NFKC"))
    .replace(/\(\s*0\s*\)/g, "")
    .replace(/[\s.\-()/\u{2010}-\u{2015}]+/gu, "");
  if (!/^\+?\d+$/.test(compact)) return null;
  let international = compact.startsWith("+");
  let digits = international ? compact.slice(1) : compact;
  if (!international && digits.startsWith("00")) {
    international = true;
    digits = digits.slice(2);
  }
  // A national number starts with 0: one that starts with 213 has Algeria's code.
  if (digits.startsWith("213")) return algerian(`0${digits.slice(3).replace(/^0/, "")}`);
  if (international) return /^[1-9]\d{7,14}$/.test(digits) ? `+${digits}` : null;
  return algerian(digits);
}

// ─── Quantities ─────────────────────────────────────────────────────────────

const NUMBER_WORDS: Record<number, string[]> = {
  1: ["un", "une", "one", "wahed", "wahd", "wa7ed", "wa7d", "wahda", "wa7da", "wehda", "واحد", "واحدة", "وحدة"],
  2: ["deux", "two", "zouj", "zoudj", "zoj", "zouz", "jouj", "jooj", "زوج", "جوج", "زوز", "اثنين", "اثنان", "ثنين", "حبتين", "قطعتين", "علبتين"],
  3: ["trois", "three", "tlata", "tleta", "tlatha", "thlatha", "ثلاثة", "ثلاث", "تلاتة", "تلاثة"],
  4: ["quatre", "four", "arba", "arb3a", "rab3a", "reb3a", "arbaa", "أربعة", "أربع", "ربعة"],
  5: ["cinq", "five", "khamsa", "5amsa", "khemsa", "خمسة", "خمس"],
  6: ["six", "setta", "sitta", "seta", "ستة", "ست"],
  7: ["sept", "seven", "sab3a", "seb3a", "sba3a", "سبعة", "سبع"],
  8: ["huit", "eight", "tmanya", "tmenya", "thmanya", "tmania", "ثمانية", "ثمنية", "تمنية", "ثمان"],
  9: ["neuf", "nine", "tes3a", "tis3a", "tsa3a", "تسعة", "تسع"],
  10: ["dix", "ten", "3achra", "3ashra", "achra", "ashra", "عشرة", "عشر"],
};
const QUANTITY_WORDS = new Map<string, number>(
  Object.entries(NUMBER_WORDS).flatMap(([value, words]) => words.map((word): [string, number] => [fold(word), Number(value)]))
);
/** "حبة" alone is one piece; with a number, it is only the unit ("3 حبة"). */
const ONE_PIECE = new Set(["حبة", "حباية", "قطعة", "علبة", "habba", "hba", "7aba", "7abba", "piece", "unite"].map((word) => fold(word)));
const FRACTION_WORDS = new Set(["demi", "demie", "moitie", "half", "quart", "quarts", "quarter", "tiers", "نص", "نصف", "ربع"].map((word) => fold(word)));
/** "x3", "3x", "3pcs", "3pieces". */
const GLUED_QUANTITY = /^(?:x(\d+)|(\d+)(?:x|pcs?|pieces?|pz|u|unites?|units?))$/;

/** A token's number, null when it is none, NaN when it is a number of something else ("2kg", "12ml"). */
function quantityOf(token: string): number | null {
  if (/^\d+$/.test(token)) return Number(token.replace(/^0+(?=\d)/, "").slice(0, 6));
  const word = QUANTITY_WORDS.get(token) ?? (ARABIC.test(token) ? QUANTITY_WORDS.get(token.replace(/^[وبف]/, "")) : undefined);
  if (word !== undefined) return word;
  const glued = GLUED_QUANTITY.exec(token);
  if (glued) return Number((glued[1] ?? glued[2]).replace(/^0+(?=\d)/, "").slice(0, 6));
  return /^\d+\p{L}+$/u.test(token) ? Number.NaN : null;
}

/**
 * A whole number from 1 to 10000: digits in any script ("2", "٢"), "x3",
 * "3 pièces", "2 حبات", or a word from one to ten in Darija, Arabic, French
 * or English (وحدة, حبة, زوج, جوج, تلاتة, wahda, zouj, deux, three...).
 * Zero, a negative number, a fraction, more than 10000, or more than one
 * number ("1 rouge et 1 noir") give null.
 */
export function normalizeQuantity(text: string): number | null {
  if (typeof text !== "string" || text.length > 100) return null;
  const folded = fold(text);
  // 1.5, 1,5, 1/2 and ½ (1⁄2 once decomposed); -2.
  if (/\d\s*[.,٫/⁄]\s*\d/u.test(folded) || /(?:^|[^\p{L}\p{N}])[-\u{2212}\u{2012}-\u{2014}]\s*\d/u.test(folded)) return null;
  const numbers: number[] = [];
  let onePiece = false;
  for (const token of tokensOf(folded)) {
    if (FRACTION_WORDS.has(token)) return null;
    const number = quantityOf(token);
    if (number === null) onePiece ||= ONE_PIECE.has(token);
    else numbers.push(number);
  }
  if (numbers.length === 0) return onePiece ? 1 : null;
  const [number] = numbers;
  return numbers.length === 1 && Number.isInteger(number) && number >= 1 && number <= MAX_QUANTITY ? number : null;
}

// ─── Colours and types ──────────────────────────────────────────────────────

/** Words around a colour that are not part of it: "couleur 12", "le gris svp", "نحب اللون الرمادي عافاك". */
const COLOUR_FILLERS = new Set(
  [
    "couleur", "couleurs", "coloris", "color", "colors", "colour", "colours", "loun", "lon", "type", "types",
    "modele", "model", "ref", "reference", "code", "numero", "num", "number", "no", "n", "taille", "size",
    "pointure", "le", "la", "les", "l", "the", "de", "du", "des", "d", "en", "un", "une", "je", "veux",
    "voudrais", "prends", "want", "nheb", "n7eb", "bghit", "svp", "stp", "please", "pls", "plz", "merci",
    "juste", "seulement", "just", "only", "لون", "الوان", "رقم", "كود", "نوع", "موديل", "مقاس", "قياس", "تاع",
    "نتاع", "ديال", "من", "نحب", "بغيت", "حاب", "حابة", "عافاك", "فضلك", "شكرا", "برك", "فقط",
  ].map((word) => fold(word))
);

function colourWords(text: string): string[] {
  return tokensOf(fold(text))
    .filter((token) => !COLOUR_FILLERS.has(token))
    .map(withoutArticle)
    .filter((word) => !COLOUR_FILLERS.has(word));
}

interface ColourOption {
  code: string;
  name: string;
  codeKey: string;
  nameWords: string[];
  nameKey: string;
}

function asArray<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

/** The product's colours or types that have a code: the catalog shows no other. */
function colourOptions(product: CatalogProduct | null): ColourOption[] {
  if (!product) return [];
  return asArray<CatalogVariant | null>(product.variants).flatMap((variant) => {
    const code = oneLine(variant?.code);
    if (!variant || !code) return [];
    const name = oneLine(variant.name);
    const nameWords = colourWords(name);
    return [{ code, name, codeKey: normalizeCode(fold(code)), nameWords, nameKey: normalizeCode(nameWords.join("")) }];
  });
}

type ColourMatch = ColourOption | "many" | null;

function single(options: ColourOption[]): ColourMatch {
  const distinct = [...new Set(options)];
  return distinct.length === 1 ? distinct[0] : distinct.length > 1 ? "many" : null;
}

/** The option whose code, name, or code and name the keys are. */
function exactly(keys: string[], options: ColourOption[]): ColourMatch {
  const known = new Set(keys.filter(Boolean));
  if (known.size === 0) return null;
  const byCode = single(options.filter((option) => known.has(option.codeKey)));
  if (byCode) return byCode;
  return single(
    options.filter(
      (option) =>
        option.nameKey !== "" &&
        [option.nameKey, option.codeKey + option.nameKey, option.nameKey + option.codeKey].some((key) => known.has(key))
    )
  );
}

/** The words of `part`, one after the other, somewhere in `words`. */
function holds(words: string[], part: string[]): boolean {
  return part.length > 0 && words.some((_, start) => part.every((word, k) => words[start + k] === word));
}

/** The options whose names stand in the words, except a name inside a longer one ("Gris" in "gris clair"). */
function namedIn(words: string[], options: ColourOption[]): ColourOption[] {
  const spans: { option: ColourOption; start: number; end: number }[] = [];
  for (const option of options) {
    if (option.nameKey.length < 2) continue;
    words.forEach((_, start) => {
      if (option.nameWords.every((word, k) => words[start + k] === word)) {
        spans.push({ option, start, end: start + option.nameWords.length });
      }
    });
  }
  return spans
    .filter(
      (span) =>
        !spans.some(
          (other) => other.start <= span.start && other.end >= span.end && other.end - other.start > span.end - span.start
        )
    )
    .map((span) => span.option);
}

/**
 * The colour or type the text names, by code ("12 04" is 12-04) or by name
 * (case, accents and Arabic letter variants ignored): the whole text, then
 * the text without the product's own name ("Parquet Chêne gris"), then part
 * of one name only ("clair" for "Chêne clair"). A name inside a longer text
 * is no match ("gris foncé" is not "Gris"), but two names in it ("gris ou
 * noyer") mean it could be more than one: "many".
 */
function matchColour(text: string, product: CatalogProduct, options: ColourOption[]): ColourMatch {
  const words = colourWords(text);
  const whole = exactly([normalizeCode(fold(text)), normalizeCode(words.join(""))], options);
  if (whole) return whole;

  const productWords = new Set(colourWords(oneLine(product.name)));
  const rest = words.filter((word) => !productWords.has(word));
  if (rest.length > 0 && rest.length < words.length) {
    const withoutProduct = exactly([normalizeCode(rest.join(""))], options);
    if (withoutProduct) return withoutProduct;
  }

  if (single(namedIn(words, options)) === "many") return "many";

  const part = rest.length > 0 ? rest : words;
  if (normalizeCode(part.join("")).length < 3) return null;
  return single(options.filter((option) => holds(option.nameWords, part)));
}

function productName(product: CatalogProduct): string {
  return cut(oneLine(product.name) || oneLine(product.code) || "(no name)", PRODUCT_NAME_LIMIT);
}

type Checked = { value: string; variantCode: string | null } | { problem: string };

/** The colour as the draft keeps it: one of the product's options, or free text when it has none. */
function checkColour(text: string, product: CatalogProduct | null, options: ColourOption[]): Checked {
  if (!product || options.length === 0) return { value: cut(text, LIMITS.COLOUR), variantCode: null };
  const match = matchColour(text, product, options);
  if (match && match !== "many") {
    return { value: cut(match.name ? `${match.code} ${match.name}` : match.code, LIMITS.COLOUR), variantCode: match.code };
  }
  const reason = match === "many" ? "could be more than one" : "is not one";
  return { problem: `${quoted(text, LIMITS.COLOUR)} ${reason} of the colours of ${productName(product)}` };
}

// ─── Merging ────────────────────────────────────────────────────────────────

function catalogOf(context: unknown): { products: CatalogProduct[]; focusIds: unknown[] } {
  const record = isRecord(context) ? context : {};
  const products = (Array.isArray(record.products) ? record.products : []).filter(
    (product): product is CatalogProduct => isRecord(product) && typeof product.id === "string" && product.id !== ""
  );
  return { products, focusIds: Array.isArray(record.focusIds) ? record.focusIds : [] };
}

/** The model's product when the catalog has it, else the previous one, else the first focus product. */
function chooseProduct(
  products: CatalogProduct[],
  focusIds: unknown[],
  previousId: string | null,
  text: string
): CatalogProduct | null {
  const byId = new Map<string, CatalogProduct>();
  for (const product of products) if (!byId.has(product.id)) byId.set(product.id, product);
  if (text) {
    const [first] = mentionedProductIds(products, [text.slice(0, 300)]);
    const named = first === undefined ? undefined : byId.get(first);
    if (named) return named;
  }
  const kept = previousId === null ? undefined : byId.get(previousId);
  if (kept) return kept;
  for (const id of focusIds) {
    const focus = typeof id === "string" ? byId.get(id) : undefined;
    if (focus) return focus;
  }
  return null;
}

/**
 * The draft after one answer of the model, whose `order` holds what the
 * customer gave in the whole conversation:
 * - an empty or missing value keeps the previous value (and its problem);
 * - a valid value replaces the previous one and clears its problem;
 * - an invalid value keeps the previous valid one and records the problem.
 *
 * The product is the model's when the catalog has it, else the previous one,
 * else the first focus product: never one outside `products`. A colour is
 * one of the product's colours or types when it has some ("12-04 Gris"),
 * free text otherwise; when the product changes, the colour is checked
 * again against the new one. The wilaya is normalized, or kept as written
 * for the team to confirm. Never throws: bad input counts as nothing given.
 */
export function mergeOrder(
  previous: OrderDraft | null,
  modelOrder: unknown,
  context: { products: CatalogProduct[]; focusIds: string[] }
): OrderDraft {
  const { products, focusIds } = catalogOf(context);
  const base = parseOrderDraft(previous);
  const order = readModelOrder(modelOrder);
  const values = { ...base?.values };
  const problems = { ...base?.problems };

  const product = chooseProduct(products, focusIds, base?.productId ?? null, order.product);
  const options = colourOptions(product);
  let variantCode = base?.variantCode ?? null;

  const setColour = (checked: Checked) => {
    if ("problem" in checked) {
      problems.COLOUR = checked.problem;
    } else {
      values.COLOUR = checked.value;
      variantCode = checked.variantCode;
      delete problems.COLOUR;
    }
  };

  // A colour was checked against one product: another product, a colour gone
  // from the catalog or a product that now has colours means checking again.
  const recheck =
    (product?.id ?? null) !== (base?.productId ?? null) ||
    (variantCode !== null && !options.some((option) => option.code === variantCode)) ||
    (variantCode === null && options.length > 0 && values.COLOUR !== undefined);
  if (recheck) {
    const carried = values.COLOUR;
    const wasOption = variantCode !== null;
    delete values.COLOUR;
    delete problems.COLOUR;
    variantCode = null;
    // A colour of another product means nothing for one without colours.
    if (carried && !order.colour && (options.length > 0 || !wasOption)) setColour(checkColour(carried, product, options));
  }
  if (order.colour) setColour(checkColour(order.colour, product, options));

  if (order.wilaya) {
    // An unknown place stays as written: the team confirms it.
    values.WILAYA = normalizeWilaya(order.wilaya)?.name ?? cut(order.wilaya, LIMITS.WILAYA);
    delete problems.WILAYA;
  }

  const check = (field: OrderFieldValue, text: string, value: string | null, problem: string) => {
    if (!text) return;
    if (value === null) {
      problems[field] = `${quoted(text, LIMITS[field])} ${problem}`;
    } else {
      values[field] = value;
      delete problems[field];
    }
  };

  check("PHONE", order.phone, normalizePhone(order.phone), "is not a valid phone number");
  const quantity = normalizeQuantity(order.quantity);
  check("QUANTITY", order.quantity, quantity === null ? null : String(quantity), "is not a valid quantity");
  const nameLength = Array.from(order.name).length;
  const validName = nameLength >= 2 && nameLength <= LIMITS.NAME && /\p{L}/u.test(order.name);
  check("NAME", order.name, validName ? order.name : null, "is not a valid name");

  if (order.address) {
    values.ADDRESS = cut(order.address, LIMITS.ADDRESS);
    delete problems.ADDRESS;
  }

  // A shop without a catalog, or a product the catalog does not have: its
  // name as the customer gave it, so the bot stops asking (never an id).
  const freeName = order.product
    ? cut(order.product, PRODUCT_NAME_LIMIT)
    : base && base.productId === null
      ? base.productName
      : null;

  return {
    productId: product?.id ?? null,
    productName: product ? productName(product) : freeName,
    variantCode,
    values,
    problems,
  };
}

// ─── Completeness ───────────────────────────────────────────────────────────

/** The required fields without a value, in the order of `required`. */
export function missingOrderFields(draft: OrderDraft | null, required: OrderFieldValue[]): OrderFieldValue[] {
  const values = parseOrderDraft(draft)?.values ?? {};
  return parseOrderFields(required).filter((field) => !values[field]);
}

/**
 * Every required field has a value. A field whose newer value was refused
 * keeps its older one and counts as given. With no required field there is
 * no order to collect: never complete.
 */
export function isOrderComplete(draft: OrderDraft | null, required: OrderFieldValue[]): boolean {
  const fields = parseOrderFields(required);
  return fields.length > 0 && missingOrderFields(draft, fields).length === 0;
}

// ─── The prompt section ─────────────────────────────────────────────────────

// No digit and no amount word below: the guard may read this section.
const NOTHING_MISSING =
  "Everything is there: thank the customer and say a person from the shop will confirm the order.";
const ASK_MISSING = "Ask for what is missing, two or three details in one question when it is natural.";

function problemText(problem: string): string {
  return cut(oneLine(problem), PROBLEM_LIMIT);
}

function fieldLine(field: OrderFieldValue, draft: OrderDraft | null): string {
  const value = draft?.values[field];
  const problem = draft?.problems[field];
  if (value && problem) return `${quoted(value, LIMITS[field])}, but ${problemText(problem)}: ask which one is right`;
  if (value) return quoted(value, LIMITS[field]);
  if (problem) return `${problemText(problem)}: ask again`;
  return "missing";
}

/**
 * The ORDER DETAILS section of the system instruction: the product, one line
 * per required field ("- Wilaya: «31 - Oran»", "- Phone number: missing",
 * "- Phone number: «0550» is not a valid phone number: ask again"), then
 * what to do. Every value is the customer's: on one line, inside «», cut to
 * its limit, so none can fake an instruction or a section. "" when no field
 * is required.
 */
export function formatOrderSection(required: OrderFieldValue[], draft: OrderDraft | null): string {
  const fields = parseOrderFields(required);
  if (fields.length === 0) return "";
  const read = parseOrderDraft(draft);
  const product = read?.productName ? quoted(read.productName, PRODUCT_NAME_LIMIT) : "not chosen yet";
  return [
    "## ORDER DETAILS",
    `- ${PRODUCT_LABEL}: ${product}`,
    ...fields.map((field) => `- ${ORDER_FIELD_LABELS[field]}: ${fieldLine(field, read)}`),
    missingOrderFields(read, fields).length === 0 ? NOTHING_MISSING : ASK_MISSING,
  ].join("\n");
}

// ─── The summary ────────────────────────────────────────────────────────────

/**
 * The order for the team, as rows to show: the product first, then the
 * required fields that have a value, in the order of `required`. Labels are
 * English: translate them by `field`.
 */
export function orderSummary(
  draft: OrderDraft,
  required: OrderFieldValue[]
): { field: OrderFieldValue | "PRODUCT"; label: string; value: string }[] {
  const read = parseOrderDraft(draft);
  const rows: { field: OrderFieldValue | "PRODUCT"; label: string; value: string }[] = [];
  if (read?.productName) {
    rows.push({ field: "PRODUCT", label: PRODUCT_LABEL, value: cut(oneLine(read.productName), PRODUCT_NAME_LIMIT) });
  }
  for (const field of parseOrderFields(required)) {
    const value = cut(oneLine(read?.values[field]), LIMITS[field]);
    if (value) rows.push({ field, label: ORDER_FIELD_LABELS[field], value });
  }
  return rows;
}
