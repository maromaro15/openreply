/**
 * Promises a reply may repeat but never invent: a discount, free delivery,
 * a gift, scarcity or urgency, "the best", a guarantee or a refund.
 *
 * They are read in Arabic (MSA and Darija, with or without the article and
 * the clitics و ب ل ف ك), in Darija written in Latin letters, in French and
 * in English, ignoring case, accents, Arabic diacritics, tatweel and the
 * spellings of hamza, taa marbuta and alef maqsura. Only an affirmative
 * claim counts: "ما عندناش تخفيض", "pas de remise" and "no discount" are
 * none, nor is a gift for someone ("هدية لماماك") or a superlative that
 * only advises ("أحسن لون للصالون"). A false alarm hands a normal
 * conversation to a person, so a word counts only where it promises.
 *
 * A kind of claim passes when the shop wrote one of that kind itself.
 * Nothing a customer writes allows one.
 */
import type { GuardViolation } from "./guard";

export type ClaimKind = "discount" | "free_delivery" | "gift" | "scarcity" | "best" | "guarantee";

export const CLAIM_REASONS = {
  discount: "The reply promised a discount that is not in the knowledge base.",
  free_delivery: "The reply promised free delivery that is not in the knowledge base.",
  gift: "The reply promised a gift that is not in the knowledge base.",
  scarcity: "The reply claimed scarcity or urgency that is not in the knowledge base.",
  best: "The reply claimed the product is the best, which is not in the knowledge base.",
  guarantee: "The reply promised a guarantee or a refund that is not in the knowledge base.",
} as const satisfies Record<ClaimKind, string>;

export interface Claim {
  kind: ClaimKind;
  /** The words as the text wrote them. */
  phrase: string;
}

// ─── Text as it is compared ─────────────────────────────────────────────────

const DIGIT_BLOCKS = [0x0660, 0x06f0, 0x07c0, 0x0966, 0x09e6, 0xff10];
/** Replaced before decomposition, which would turn "´" into a space. */
const APOSTROPHES = /[’‘`´ʼʻ′]/g;
/** Accents, Arabic diacritics, invisible marks and tatweel. */
const MARKS = /[\p{M}\p{Cf}ـ]/gu;
const LETTERS: Record<string, string> = { ٱ: "ا", ة: "ه", ى: "ي", ی: "ي", ک: "ك", گ: "ك", ڨ: "ق", ڤ: "ف" };
const OTHER_LETTERS = new RegExp(`[${Object.keys(LETTERS).join("")}]`, "g");

/** Arabic-Indic, Persian and the other digits of those blocks; 0-9 are left alone. */
const OTHER_DIGITS = new RegExp(
  `[${DIGIT_BLOCKS.map((base) => `${String.fromCharCode(base)}-${String.fromCharCode(base + 9)}`).join("")}]`,
  "g"
);

function asciiDigit(digit: string): string {
  const code = digit.charCodeAt(0);
  const base = DIGIT_BLOCKS.find((block) => code >= block && code <= block + 9)!;
  return String(code - base);
}

/**
 * Text as it is compared: lower case, without accents, diacritics, tatweel
 * or invisible marks; أ إ آ ٱ are ا, ؤ is و, ئ ى ی are ي, ة is ه; digits are
 * 0-9; every apostrophe is '.
 */
function foldText(text: string): string {
  return text
    .replace(OTHER_DIGITS, asciiDigit)
    .replace(APOSTROPHES, "'")
    .normalize("NFKD")
    .toLowerCase()
    .replace(MARKS, "")
    .replace(OTHER_LETTERS, (letter) => LETTERS[letter]);
}

const folds = new Map<string, string>();

function foldChar(char: string): string {
  let folded = folds.get(char);
  if (folded === undefined) folds.set(char, (folded = foldText(char)));
  return folded;
}

interface Folded {
  text: string;
  /** For each character of text, where it came from in the source, and one more for the end; empty when not needed. */
  from: number[];
}

/** Folded one character at a time when positions are needed, to give the claim as written. */
function fold(source: string, positions: boolean): Folded {
  if (!positions) return { text: foldText(source), from: [] };
  const parts: string[] = [];
  const from: number[] = [];
  let index = 0;
  for (const char of source) {
    const folded = foldChar(char);
    parts.push(folded);
    for (let k = 0; k < folded.length; k++) from.push(index);
    index += char.length;
  }
  from.push(index);
  return { text: parts.join(""), from };
}

// A link or an address is no promise, even ".../promo-50".
const LINK = /\b(?:https?:\/\/|www\.)[^\s<>"'()]+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gi;
// "Feel free to ask" and "taille free size" promise nothing.
const NOT_FREE = /\bfeel free\b|\bfree (?:size|time|style)\b|\b[a-z]+-free\b/g;

const blank = (match: string) => " ".repeat(match.length);

// ─── Words ──────────────────────────────────────────────────────────────────

interface Token {
  text: string;
  start: number;
  end: number;
  /** A sentence or a clause ends just before it. */
  opens: boolean;
}

const TOKEN = /[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu;
const CLAUSE_BREAK = /[.!?؟;؛,،:\n]/;

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let last = 0;
  for (const match of text.matchAll(TOKEN)) {
    const start = match.index;
    tokens.push({
      text: match[0],
      start,
      end: start + match[0].length,
      opens: tokens.length === 0 || CLAUSE_BREAK.test(text.slice(last, start)),
    });
    last = start + match[0].length;
  }
  return tokens;
}

// ─── Patterns ───────────────────────────────────────────────────────────────

// Arabic words take clitics and have no \b in JavaScript: a word counts when
// no letter or digit touches it, after و or ف, then ب ك ل ع with or without
// ال, or ال alone, or لل ("والتخفيض", "بالبرومو", "للتوصيل", "عالتوصيل").
const EDGE_BEFORE = "(?<![\\p{L}\\p{N}])";
const EDGE_AFTER = "(?![\\p{L}\\p{N}])";
const CLITICS = "(?:[وف]?(?:لل|[بكلع]?ال|[بكل])?)";

/** Arabic letters of a pattern, spelled as the compared text spells them. */
const foldArabic = (source: string) =>
  source.replace(/[أإآٱ]/g, "ا").replace(/[ىی]/g, "ي").replace(/ة/g, "ه").replace(/ؤ/g, "و").replace(/ئ/g, "ي");

/** A pattern, with a cheap test that passes wherever it matches. */
interface Pattern {
  re: RegExp;
  /** The bare terms: a match of re always holds one. Without the edges, a long text is read fast. */
  quick: RegExp;
}

/** Whole words, a clitic allowed in front. In a term, " " stands for spaces and " ?" for optional ones. */
function words(terms: string[]): Pattern {
  const body = foldArabic(terms.join("|")).replace(/ \?/g, "\\s*").replace(/ /g, "\\s+");
  return { re: new RegExp(`${EDGE_BEFORE}${CLITICS}(?:${body})${EDGE_AFTER}`, "gu"), quick: new RegExp(body, "u") };
}

interface Context {
  /** The compared text just before the words, the words, and just after them. */
  before: string;
  match: string;
  after: string;
}

interface WordRule {
  kind: ClaimKind;
  re: Pattern;
  /** Not a claim here: a gift for someone, "contre remboursement"... */
  unless?: (context: Context) => boolean;
  /** "Free" alone: a gift or free delivery, whichever the shop wrote. */
  loose?: boolean;
}

interface PairRule {
  kind: ClaimKind;
  /** Two parts in this order, "التوصيل" then "مجاني", "le meilleur" then "du marché". */
  first: Pattern;
  second: Pattern;
  /** How many words may stand between them. */
  gap: number;
}

// ── Discount ──

const DISCOUNT_WORDS = words([
  "خصم(?:ات|ه)?", "خصومات", "برومو(?:سيون|شن|ات|هات)?", "[سص]ولد(?:ات)?", "ريميز", "اوفر(?:ات)?",
  "(?:عرض|عروض) (?:ال)?(?:خاص(?:ه)?|ترويجي(?:ه)?|حصري(?:ه)?)",
  "(?:اسعار|سعر|ثمن|سومه) (?:ال)?(?:خاص(?:ه)?|مخف[ضظ](?:ه)?|ترويجي(?:ه)?)",
  "نص (?:ال)?(?:ثمن|سعر|سومه|تمن|سوم)", "ن?نقص(?:لك|ولك|ليك|وليك|لكم|ولكم)", "نخف[ضظ](?:لك|ولك|ليك|وليك|لكم|ولكم)",
  "promos?", "promotions?", "promotionnel(?:le)?s?", "rabais", "ristournes?", "discounts?", "discounted",
  "soldes", "en solde", "soldees?", "destockage", "liquidation", "black friday",
  "prix (?:special|speciaux|promo|promotionnels?|reduits?|casses?|barres?|sacrifies?|exceptionnels?)",
  "offres? (?:speciales?|promotionnelles?|du moment|exceptionnelles?)", "bons? plans?", "moitie prix",
  "special (?:offers?|prices?|deals?)", "reduced prices?", "price (?:cuts?|drops?)", "half (?:price|off)", "on sale",
  "(?:flash|big|mega|summer|winter|clearance) sales?", "sale prices?", "markdowns?", "clearance",
  "ta?kh?fi(?:d|dh)(?:at)?", "t5fi(?:d|dh)(?:at)?", "nn?(?:a|e)?9(?:a|e)?ss?(?:ou|o)?l(?:e|a)?k(?:om)?",
]);
/** "-20%", "20% off", "20% moins cher". */
const PERCENT_OFF: Pattern = {
  // Joined from an array, never with "+" between template literals: the
  // production minifier dropped parts of such joins (a broken RegExp).
  re: new RegExp(
    [
      `${EDGE_BEFORE}[-−–‐]\\s?\\d{1,2}(?:[.,]\\d)?\\s?%`,
      `${EDGE_BEFORE}\\d{1,2}(?:[.,]\\d)?\\s?%\\s?(?:off|moins chere?s?|de moins|اقل|ارخص)${EDGE_AFTER}`,
    ].join("|"),
    "gu"
  ),
  quick: /%/,
};
// "Remise en main propre" hands a parcel over; "réduction des rides" is what a cream does.
const NOT_A_REBATE =
  /^\s+(?:en|a)\s|^\s+(?:du|des|de la|de l')\s*(?:colis|commandes?|produits?|cles?|marchandises?|paquets?|articles?|documents?)/;
const BODY_WORDS = [
  "rides?", "poids", "ventre", "graisses?", "cellulite", "taches?", "bruits?", "cernes?", "pores?", "douleurs?", "stress",
  "chute", "tension", "cholesterol", "sucre", "consommation", "inflammations?", "volume",
  "wrinkles?", "weight", "fat", "noise", "pain",
].join("|");
const NOT_A_PRICE_CUT = new RegExp(`^\\s+(?:des|du|de la|de l'|de|d'|of|in)\\s*(?:${BODY_WORDS})(?![\\p{L}])`, "u");
const NOT_A_PRICE_CUT_BEFORE = /(?:wrinkle|weight|noise|fat|pain|stress)\s+$/;
const NOT_A_PRICE_CUT_AR = /^\s+(?:(?:في|من)\s+)?(?:ال)?(?:وزن|كرش|دهون|شحوم|سكر|ضغط|كولسترول|كوليسترول|ضوضاء|صوت|تجاعيد)/;

// ── Free delivery ──

const DELIVERY = words([
  "توصيل(?:ه|ها)?", "ليفر(?:ي|ا)?[زس]ون", "لفريزون", "شحن",
  "نوصلو(?:لك|لكم|ك|كم|هالك|هولك|هالكم|هولكم|ها|ه)?", "نوصل(?:لك|ك|هالك|هولك)", "نبعثو(?:لك|لكم|هالك|هولك)",
  "livraisons?", "livr(?:e|ee|es|ees|ons|er|ez|ent)", "envois?", "expeditions?",
  "deliver(?:y|ies|ed|s|ing)?", "shipping", "ship(?:ped|s)?", "tawsil", "taw9il", "livr(?:i|e)?[sz]on", "lfriz(?:on)?",
]);
/** After the delivery: "التوصيل مجاني", "livraison offerte", "delivery is free". */
const FREE_AFTER = words([
  "مجاني(?:ه)?", "مجانا", "بالمجان", "فابور", "على حساب(?:نا|ي)", "(?:بدون|بلا|دون) مقابل",
  "gratuite?s?", "gratuitement", "gratis", "gratos", "offerte?s?", "a (?:notre|nos) (?:charge|frais)",
  "free", "for free", "free of charge",
  "majan(?:i|ia|iya|ya)?", "mjan(?:i|ia|iya|ya)", "majanan", "mjanan", "fabor", "f(?:a|e)bour", "batel",
  "blech", "belech", "blach", "bla (?:flous|drahem|soum)",
]);
/** Words that mean "free" only right after the delivery: "التوصيل بلاش", "livraison incluse". */
const FREE_NEAR = words([
  "بلاش", "ببلاش", "باطل", "inclus(?:e|es)?", "compris(?:e|es)?", "included", "on us",
  "0 ?(?:دج|دينار|da|dzd|dinars?)", "3lina",
]);
/** "التوصيل علينا", but "علينا نأكدو" is a duty. */
const ON_US = words(["علينا"]);
/** Before the delivery: "free delivery", "sans frais de livraison", "on vous offre la livraison". */
const FREE_BEFORE = words([
  "free", "complimentary", "gratuite?s?", "sans frais(?: de)?", "(?:بدون|بلا) (?:مصاريف|تكاليف|رسوم|مصروف)",
  "(?:vous|te|on|nous|je) offr(?:e|ons|ent|ir|ira|irons)", "t'offr(?:e|ir)",
]);
const FREE_DELIVERY_WORDS = words([
  "port (?:offert|gratuit|inclus|compris)", "franco de port",
  "frais de (?:port|transport|envoi|expedition) (?:offerts?|gratuits?|inclus|compris|a (?:notre|nos) (?:charge|frais))",
  "sans frais de (?:port|transport|envoi|expedition)",
  "(?:no|without|zero) (?:delivery|shipping) (?:fees?|charges?|costs?)", "ships? free",
  "(?:ما ?)?[تن]?خلص(?:ش|يش|وش) (?:حتى )?(?:ال)?(?:توصيل|ليفريزون|ليفرازون|شحن)",
]);
/** Free alone: delivery or a gift, whichever the shop wrote. */
const FREE_ALONE = words([
  "مجاني(?:ه)?", "مجانا", "بالمجان", "فابور", "بالفابور",
  "gratuite?s?", "gratuitement", "gratis", "gratos", "for free", "free of charge",
  "majan(?:i|ia|iya|ya)", "mjan(?:i|ia|iya|ya)", "majanan", "mjanan", "fabor", "f(?:a|e)bour",
]);

// ── Gift ──

const GIFT_WORDS = words([
  "هدي(?:ه|ات|تك|تكم|تها|تو)", "هدايا", "كادو(?:ات|هات)?",
  "cadeaux?", "kdo", "kado", "kadou", "cado", "gifts?", "hdiy?a", "hadiy?a", "hdaya",
]);
const GIFT_GIVING = words([
  "نهديو(?:لك|لكم|ك|كم|ليك)", "نهدي(?:لك|ليك|ولك)", "نهدوك",
  "(?:on|je) vous l'offre", "nous vous l'offrons", "offerte?s?", "en cadeau", "free gifts?", "on the house",
]);
// A promise, whatever else: "هدية مع كل طلبية", "cadeau offert", "gift with every order".
const WORD_END = "(?![\\p{L}])";
const GIFT_PROMISED = new RegExp(
  [
    `(?:مجاني(?:ه)?|مجانا|بلاش|فابور|gratuite?s?|offerte?s?|free)${WORD_END}`,
    "مع\\s+(?:كل|ال)",
    `avec\\s+(?:l'|(?:chaque|toute|tout|votre|vos|ta|tes|la|le)${WORD_END})`,
    `with\\s+(?:every|each|your|any|the)${WORD_END}`,
    [
      `pour\\s+(?:(?:vous|toi|tous|toutes|tout|toute|chaque|chacun|chacune)${WORD_END}|nos\\s+clients|les\\s+\\d`,
      "|(?:votre|vos|ta|tes|la|le|l')\\s*(?:commandes?|achats?|fidelite|premiere|premier))",
    ].join(""),
    `for\\s+(?:(?:you|every|each|all|any)${WORD_END}|the first|your\\s+(?:orders?|purchases?|first))`,
  ]
    .map((promise) => `^\\s+${promise}`)
    .join("|"),
  "u"
);
// For someone, or a kind of product: "idéal comme cadeau", "emballage cadeau", "تصلح هدية", "perfect gift".
const GIFT_IDEA_AR = [
  "تصلح", "يصلح", "تصلحي", "تنفع", "ينفع", "مليحه", "مليح", "ممتازه", "ممتاز", "رايعه", "رايع", "زينه", "فكره", "افكار",
  "تغليف", "باكيت", "باكو", "علبه", "علب", "كارطه", "بطاقه", "بطاقات", "نغلفو(?:ها|هالك|هولك)?", "تغلفو",
];
const GIFT_IDEA_FR = [
  "emballages?", "papiers?", "paquets?", "cartes?", "coffrets?", "boites?", "bons?", "idees?", "listes?", "sacs?",
  "sachets?", "pochettes?", "ideale?", "parfaite?", "super", "bonne?", "top", "excellente?", "belle", "beau", "jolie?",
  "geniale?", "magnifique",
];
const GIFT_IDEA_EN = [
  "perfect", "great", "ideal", "lovely", "nice", "good", "beautiful", "wonderful", "thoughtful", "amazing", "special",
  "birthday", "wedding", "christmas", "eid",
];
const GIFT_IDEA_PARTS = [
  `(?:${GIFT_IDEA_AR.join("|")})\\s+(?:\\p{L}+\\s+)?`,
  `(?:${GIFT_IDEA_FR.join("|")})\\s+(?:(?:comme|en|pour|un|une|de|d')\\s*)*`,
  `(?:${GIFT_IDEA_EN.join("|")})\\s+`,
];
const GIFT_IDEA_BEFORE = new RegExp(`(?:${GIFT_IDEA_PARTS.join("|")})$`, "u");
const GIFT_IDEA_AFTER = new RegExp(
  "^\\s+(?:مليحه|ممتازه|رايعه|زينه|مثاليه|حلوه|رمزيه|ideale?s?|parfaite?s?|originale?s?|de reve|personnalisee?s?" +
    "|cards?|wrap(?:ping|ped)?|box(?:es)?|sets?|bags?|ideas?|vouchers?|certificates?|shop|baskets?)(?![\\p{L}])" +
    "|^\\s+(?:pour|for)\\s+\\p{L}|^\\s+l\\s+\\p{L}",
  "u"
);
/** After ل: "ليك", "لكل زبون" is the customer; "لماماك" is someone else. */
const THE_CUSTOMER = /^(?:ك|يك|كم|يكم|كل|اول|ول|زبون|زبونه|زباين|زبايننا|كليان|عملاء|عميل|جميع|كامل)$/;

function forSomeoneArabic(after: string): boolean {
  const next = /^\s+(?:(لل|ل)\s+)?(\p{L}+)/u.exec(after);
  if (!next) return false;
  if (next[1]) return !THE_CUSTOMER.test(next[2]);
  const word = next[2];
  if (!word.startsWith("ل") || word.length < 3) return false;
  return ![word.slice(1), word.startsWith("لل") ? word.slice(2) : ""].some((rest) => THE_CUSTOMER.test(rest));
}

function giftForSomeone({ before, after }: Context): boolean {
  if (GIFT_PROMISED.test(after)) return false;
  return GIFT_IDEA_BEFORE.test(before) || GIFT_IDEA_AFTER.test(after) || forSomeoneArabic(after);
}

// ── Scarcity and urgency ──

const QUANTITY_AR = "\\d+|واحد|وحده|واحده|جوج|زوج|زوز|ثلاثه|تلاته|ربعه|خمسه|شويه|شوي|قليل|حبه|حبات|حبتين|قطعه|قطع|بياسه|بياسات";
const PIECE_AR = "قطعه|قطع|حبه|حبات|حبتين|وحده|واحده|طرف|كميه|كميات|فرصه|نسخه|نسخ|بياسه|بياسات|يوم|ايام";
const SCARCITY_WORDS = words([
  `اخر (?:ال)?(?:${PIECE_AR}|ما ?بق(?:ا|ى|ات|او))`,
  "(?:ال)?(?:قطعه|قطع|حبه|حبات|وحده|كميه|كميات|فرصه|نسخه|نسخ|بياسه|بياسات|ايام|يوم) (?:ال)?اخير(?:ه)?",
  `(?:ما ?)?بق(?:ا|ى|او|ات)(?:لنا|ولنا|تلنا|لي|تلي|لك|تلك)? غير (?:${QUANTITY_AR})`,
  "(?:ما ?)?بق(?:ا|ى|او|ات)(?:ش|تش|وش|اش)(?:لنا|ولنا)? (?:بزاف|ياسر|بالزاف|كثير|برشا)",
  "(?:فتره|مده|وقت) (?:ال)?(?:محدوده|محدود|قصيره)", "عدد محدود",
  "غير (?:(?:هاد|هذا|هاذ|هاذا|هادا) ?)?(?:ال)?يوم", "(?:ال)?يوم (?:برك|بركا|فقط|و ?برك)", "فقط (?:ال)?يوم",
  "قبل ما (?:ي|ت)(?:خلاص|كمل|كملو|تكمل|سالي|ساليو|تسالا|تباع|تباعو|فرغ|طير|روح|نفذ|نفد|خلصو)",
  "قبل (?:ال)?(?:نفاد|نفاذ|انتهاء|نهايه) (?:ال)?(?:كميه|كميات|مخزون|ستوك|عرض|سلعه)",
  "(?:حتى|الى غايه) (?:ال)?(?:نفاد|نفاذ) (?:ال)?(?:كميه|كميات|مخزون|ستوك|سلعه)",
  "في حدود (?:ال)?(?:كميه|كميات) (?:ال)?(?:متوفره|متاحه)", "على وشك (?:ال)?(?:نفاد|نفاذ|انتهاء)",
  "قريب (?:ي|ت)(?:كمل|خلاص|سالي|فرغ|نفذ|نفد|كملو)", "(?:ي|ت)(?:تباع|نباع)(?:و)? (?:بالخف|بسرعه|كالخبز|كي الخبز)",
  "سارع(?:وا|ي|و)?", "بادر(?:وا|ي|و)?", "(?:اغتنم|استغل)(?:وا|ي|و)? (?:ال)?فرصه",
  "(?:لا|ما) ?ت(?:فوت|ضيع)(?:وا|ي|و)?(?:ش)? (?:ال)?فرصه", "الحق(?:و|ي)? روح(?:ك|كم)",
  "(?:عرض|برومو|تخفي[ضظ](?:ات)?|اوفر|خصم|سعر|ثمن)(?: (?:هذا|هاذا|هادا|هاد))?" +
    " (?:ينتهي|يكمل|يخلاص|يوفا|صالح|ساري|تنتهي|تكمل|تخلاص|توفا) (?:غير )?(?:ال)?(?:يوم|غدوه|غدا|ليله|عشيه)",
  "duree limitee", "temps limite", "series? limitees?", "editions? limitees?", "nombre limite", "places limitees",
  "dernieres? pieces?", "derniers? articles?", "dernieres? unites?", "derniers? exemplaires?", "derniere chance",
  "derniers? jours?", "derniers? stocks?", "dernieres? tailles?", "derniers? modeles?",
  "(?:il )?(?:ne )?(?:nous )?(?:en )?reste(?:nt)? (?:plus )?(?:que|qu'une?|seulement|juste|uniquement)" +
    " (?:\\d+|quelques|peu|une?|deux|trois|quatre|cinq)",
  "plus que (?:\\d+|quelques|une?|deux|trois|quatre|cinq)" +
    " (?:pieces?|articles?|unites?|exemplaires?|en stock|disponibles?|tailles?|modeles?)",
  "n'(?:avons|a|ont|y a) (?:plus )?que (?:\\d+|quelques|peu|une?|deux|trois|quatre|cinq)",
  "aujourd'hui (?:seulement|uniquement)", "(?:seulement|uniquement) aujourd'hui", "jusqu'a ce soir",
  "valable (?:que |seulement |uniquement )?(?:aujourd'hui|ce soir|24 ?h)",
  "jusqu'a epuisement(?: (?:du|des) stocks?)?", "dans la limite des stocks(?: disponibles)?",
  "avant (?:la )?(?:rupture|epuisement)(?: (?:du|des) stocks?)?", "bientot (?:epuisee?s?|en rupture|finie?s?)",
  "presque (?:epuisee?s?|finie?s?)", "rupture imminente", "(?:ca part|partent|se vendent|se vend) (?:tres |trop )?vite",
  "depechez[- ]vous", "depeche[- ]toi", "depechez", "faites vite", "ne tardez pas", "ne (?:ratez|manquez|loupez) pas",
  "profitez[- ]en vite", "plus que quelques (?:heures|jours)",
  "(?:offre|promo|promotion) (?:se termine|expire|finit|prend fin) (?:aujourd'hui|ce soir|demain|bientot)",
  "last (?:pieces?|ones?|few|units?|items?|chance|days?|stocks?|call|sizes?)",
  "limited (?:stocks?|quantit(?:y|ies)|time|offers?|editions?|supply|availability|units|pieces|deal)",
  "(?:only|just) (?:\\d+|a few|few|one|two|three|four|five) (?:left|remaining|pieces? left|items? left|units? left|in stock)",
  "(?:\\d+|a few|few) (?:left|remaining) in stock", "(?:only|just) today", "today only", "ends (?:today|tonight|tomorrow|soon)",
  "while (?:stocks?|supplies) lasts?", "until stocks? (?:runs? out|lasts?)",
  "before (?:it's|it is|they're|they are) (?:gone|sold out)", "before (?:it|they|stocks?) runs? out",
  "almost (?:gone|sold out|out of stock)", "(?:selling|going) (?:fast|quickly|out)", "sells? out (?:fast|quickly)",
  "act (?:fast|now|quickly)", "(?:don't|do not|never) miss (?:out|this|it|the chance)",
  "akh?er (?:7aba|habba|7abba|piece|wa7da|wahda|9at3a|kat3a|forsa)",
  "b9(?:aw|at|a) ghir (?:\\d+|wa7da|wahda|zouj|jouj|zoudj|chwiya|chwia|chouia)",
  "ma ?b9(?:a|at|aw)(?:ch|tch|wch|sh) (?:bzf|bzaf|bezzaf|bezaf)",
  "ghir (?:l|el|al)?(?:youm|yom)", "(?:l|el|al)?(?:youm|yom) (?:brk|barka|berk|bark|fa9at|faqat)",
  "9bel ma (?:y|t)(?:kmel|khlas|sali|tba3|kemlo)", "kmiya m7?douda", "sar3(?:o|i|ou)?",
]);
const HURRY = words(["hurry(?: up)?"]);
/** "Il en reste 2", but "il reste 2000 DA à payer" is a balance. */
const FEW_LEFT = words(["il (?:en |nous )?reste(?:nt)? (?:\\d+|quelques|peu de|une?|deux|trois|quatre|cinq)"]);
const STOCK_OR_OFFER = words([
  "كميه", "كميات", "عدد", "مخزون", "ستوك", "سلعه", "عرض", "عروض", "برومو", "تخفي[ضظ](?:ات)?", "اوفر", "خصم",
  "stocks?", "quantites?", "offres?", "promos?", "promotions?", "quantit(?:y|ies)", "offers?", "kmiya",
]);
const LIMITED = words(["محدود(?:ه)?", "محدودين", "قليل(?:ه)?", "limitee?s?", "limited", "m7?douda"]);

// ── The best ──

const SUPERLATIVE = words([
  "احسن", "افضل", "اجود", "ارخص", "اقوى", "الاول", "وحيد(?:ه|ين)?", "اقل (?:ال)?(?:سعر|ثمن|سومه|اسعار)",
  "رقم (?:1|واحد|وان)", "نمبر وان", "نومرو (?:1|ان|واحد)",
  "meilleure?s?", "moins chere?s?", "plus (?:bas|basse)s?", "numero (?:1|un)", "n°\\s?1", "no\\.?\\s?1", "top\\s?1", "#\\s?1",
  "seule?s?", "uniques?", "leaders?", "(?:le|la) premiere?",
  "best", "cheapest", "lowest", "number (?:1|one)", "leading",
  "a7(?:s|ss)en", "ahsen", "a7san", "ahsan", "afdal", "lafdel", "ra9m (?:1|wa7ed|wahed)", "lwa7id", "lwahid", "arkhas",
]);
const SCOPE = words([
  "(?:في|ف|ب) ?(?:(?:كامل|كل|قاع|جميع) )?(?:ال)?(?:سوق|جزاير|دزاير|بلاد|بلادنا|عالم|دنيا|مارشي|وطن|بلد)",
  "على مستوى (?:ال)?(?:سوق|وطن|جزاير|دزاير|عالم)",
  "(?:du|sur le|dans le|de tout le|de la|en|au|dans toute l'|de toute l'|d')" +
    " ?(?:marche|algerie|monde|pays|ville|maghreb|afrique|region|wilaya)",
  "qui existent?",
  "(?:in|on|of|around) (?:the )?(?:market|algeria|world|country|town|city|region|industry|business)",
  "(?:f|fi|fel|fl|b) ?(?:sou9|souk|souq|dzayer|dzair|dzayar|ldzayer|dzayr|l'algerie|lalgerie|bled|blad|l3alam|el3alam|lmarchi|marchi)",
]);
const BEST_WORDS = words([
  "(?:احسن|افضل|ارخص|اقل) (?:ال)?(?:سعر|ثمن|سومه|تمن|اسعار|جوده|نوعيه|كواليتي|كاليتي)",
  "(?:ما ?|م)(?:كاين(?:ش)?|كانش|كاش|كان|تلقا(?:ش|و|وش)?|يكون(?:ش)?)(?: حتى (?:واحد|حاجه|منتوج|سلعه))?" +
    " (?:كيف(?:و|ه|ها|هم)|بحال(?:و|ه|ها|هم)|مثل(?:ه|ها|و|هم))",
  "لا (?:يوجد|توجد) (?:مثله|مثلها|مثيل)", "لا مثيل (?:له|لها|لهم)", "(?:ليس|ليست) (?:له|لها) (?:مثيل|منافس)",
  "(?:بلا|بدون|ما ?عندو(?:ش)?|ما ?عندهاش|ما ?عندهمش) (?:منافس|منافسين|مثيل)", "لا يعلى عليه(?:ا)?",
  "(?:ال)?اكثر (?:مبيعا|طلبا|بيعا)",
  "meilleurs? prix", "meilleur rapport qualite[- ]prix", "imbattables?", "defiant toute concurrence",
  "sans (?:concurrence|egal|pareil)", "inegale?e?s?", "hors concurrence",
  "moins chere?s? que (?:partout|ailleurs|les autres|tout le monde|la concurrence|nos concurrents)",
  "(?:les )?prix les plus bas", "le plus bas prix", "(?:le|la|les) plus (?:vendue?s?|demandee?s?)", "meilleures? ventes?",
  "top ventes?", "best[- ]?sellers?", "best[- ]selling", "top[- ]sellers?", "most popular", "most (?:sold|requested|ordered)",
  "best (?:prices?|quality|deals?|value)", "lowest prices?", "cheapest prices?", "unbeatable", "second to none",
  "nothing (?:else )?(?:like it|compares|beats it)", "no one beats",
  "(?:a7(?:s|ss)en|ahsen|a7san) (?:prix|soum|souma|qualite|taman)",
  "(?:ma ?|m)(?:kach|kanch|kaynch|tal9ach|tal9awch) (?:kifou|kifo|kifah|kifha|kifhom|b7alo|b7alha)",
]);
const BEST_QUALITY = words(["meilleure qualite"]);
// "ماكانش كيفو عندنا" is "we have none like it", not "there is none like it".
const IN_STOCK_AFTER = /^\s+(?:عندنا|عندي|دركا|درك|ضرك|ضركا|حاليا|في\s+(?:ال)?(?:ستوك|محل|مخزن)|متوفر)/;

// ── Guarantee and refund ──

const GUARANTEE_AR = words(["ضمان(?:ه|ها|و)?"]);
const GUARANTEED_AR = words(["مضمون(?:ه|ين|يه)?"]);
const GUARANTEE_WORDS = words([
  "نضمن(?:لك|ولك|لكم|ولكم|و|ليك|وليك)?", "نضمنو(?:لك|لكم)", "(?:ق|غ|ك|ج)ار(?:و|ا)?نتي",
  // "نرجعولك دراهمك"; "نرجعولك" alone is "we will get back to you".
  "(?:ن|ي|ت)?(?:رجعو|رجع|ردو|رد)(?:لك|ولك|ليك|وليك|لكم|ولكم)" +
    " (?:ال)?(?:دراهم(?:ك|كم)?|فلوس(?:ك|كم)?|صوارد(?:ك|كم)?|مال(?:ك|كم)?|مبلغ|ثمن|سومه|حق(?:ك|كم))",
  "(?:استرجاع|استرداد|ارجاع|ترجيع) (?:ال)?(?:مال|اموال|دراهم|فلوس|مبلغ|ثمن|نقود|صوارد)",
  "garantie?s?", "garantir", "garantissons", "garantit", "garantira", "satisfaite?s? ou rembourse(?:e|s|es)?",
  "remboursables?", "guarantee(?:d|s)?", "guaranteeing", "warrant(?:y|ies)", "money[- ]back", "refund(?:s|ed|able)?",
  "mdh?m(?:o|ou)n(?:a)?", "madh?m(?:o|ou)n(?:a)?", "dh?mane?", "nr(?:a|e)?j3(?:ou|o)lek (?:drahmek|drahmk|drahem|flousek|flous)",
]);
// "Paiement contre remboursement" is cash on delivery.
const REFUND_FR = words(["rembourse(?:e|s|es|ment|ments|r|rons|z)?", "remboursons"]);

const WORD_RULES: WordRule[] = [
  { kind: "discount", re: DISCOUNT_WORDS },
  { kind: "discount", re: PERCENT_OFF },
  { kind: "discount", re: words(["تخفي[ضظ](?:ات|ه)?"]), unless: ({ after }) => NOT_A_PRICE_CUT_AR.test(after) },
  { kind: "discount", re: words(["remises?"]), unless: ({ after }) => NOT_A_REBATE.test(after) },
  {
    kind: "discount",
    re: words(["reductions?"]),
    unless: ({ before, after }) => NOT_A_PRICE_CUT.test(after) || NOT_A_PRICE_CUT_BEFORE.test(before),
  },
  { kind: "free_delivery", re: FREE_DELIVERY_WORDS },
  { kind: "gift", re: FREE_ALONE, loose: true },
  { kind: "gift", re: GIFT_WORDS, unless: giftForSomeone },
  { kind: "gift", re: GIFT_GIVING, unless: ({ after }) => /^\s+par(?![\p{L}])/u.test(after) },
  { kind: "scarcity", re: SCARCITY_WORDS },
  { kind: "scarcity", re: HURRY, unless: ({ before }) => /in a\s+$/.test(before) },
  { kind: "scarcity", re: FEW_LEFT, unless: ({ after }) => /^\s*(?:da|dzd|dinars?|€|دج|دينار)/.test(after) },
  { kind: "best", re: BEST_WORDS, unless: ({ after }) => IN_STOCK_AFTER.test(after) },
  // "De meilleure qualité que l'autre" compares two products.
  { kind: "best", re: BEST_QUALITY, unless: ({ before }) => /(?<!\p{L})(?:de|une|un|plus|en)\s+$|d'$/u.test(before) },
  {
    kind: "guarantee",
    re: GUARANTEE_AR,
    // "لضمان الجودة" is "to ensure"; "الضمان الاجتماعي" is social security.
    unless: ({ before, match, after }) =>
      /^[وف]?لضمان/.test(match) || /(?:علي|اجل|بهدف)\s+$/.test(before) || /^\s+(?:ال)?اجتماعي/.test(after),
  },
  {
    kind: "guarantee",
    re: GUARANTEED_AR,
    // "مضمون الرسالة" is what the message says.
    unless: ({ after }) => /^\s+(?:ال)?(?:رساله|رسايل|طلب|كلام|نص|اعلان|منشور|فيديو|محادثه|موضوع|مقال|صفحه)/.test(after),
  },
  { kind: "guarantee", re: GUARANTEE_WORDS },
  { kind: "guarantee", re: REFUND_FR, unless: ({ before }) => /contre[-\s]*$/.test(before) },
];

const PAIR_RULES: PairRule[] = [
  { kind: "free_delivery", first: DELIVERY, second: FREE_AFTER, gap: 5 },
  { kind: "free_delivery", first: DELIVERY, second: FREE_NEAR, gap: 2 },
  { kind: "free_delivery", first: DELIVERY, second: ON_US, gap: 0 },
  { kind: "free_delivery", first: FREE_BEFORE, second: DELIVERY, gap: 1 },
  { kind: "scarcity", first: STOCK_OR_OFFER, second: LIMITED, gap: 2 },
  { kind: "best", first: SUPERLATIVE, second: SCOPE, gap: 3 },
];

/** "Is it the best?" asks; it claims nothing. */
const ASKED_NOT_CLAIMED: ReadonlySet<ClaimKind> = new Set(["best"]);

// ─── Negation ───────────────────────────────────────────────────────────────

const NEGATIONS = new Set([
  "لا", "مش", "ماشي", "مشي", "موش", "ليس", "ليست", "لست", "لسنا", "ليسوا", "لم", "لن", "بلا", "بدون", "دون",
  "لايوجد", "لاتوجد", "والو", "مافيش", "مفيش",
  "pas", "aucun", "aucune", "aucuns", "aucunes", "jamais", "ni", "sans", "non", "nul", "nulle", "rien", "ne",
  "no", "not", "never", "without", "none", "nor", "neither", "cannot",
  "mach", "machi", "mashi", "mich", "mech", "mouch", "mouchi", "mch", "makach", "makech", "makanch", "makench",
  "makaynch", "makayench", "mkach", "mkech", "mkanch", "walou", "walo", "bla", "bela", "bdoun", "bidoun",
]);
/** ما...ش written as one word: "ماكانش", "ماعندناش", "وماكاش". */
const DARIJA_NEGATED = /^[وف]?ما\p{L}{2,}ش$/u;
/** The same without its alif: "مكاش", "معندناش", "مفيهاش". */
const DARIJA_NEGATED_SHORT = new RegExp(
  `^[وف]?م(?:${[
    "كا", "كان", "كاين", "عند", "فيه", "في", "را", "هو", "هي", "نا", "ني", "بقا", "بقات",
    "يكون", "تكون", "نقدر", "تقدر", "يقدر", "درنا", "نجم", "تجم", "يجم",
  ].join("|")})\\p{L}*ش$`,
  "u"
);
/** "n'est", "don't", "makanch", "m3andnach". */
const LATIN_NEGATED = new RegExp(
  "^(?:n'(?!importe)\\p{L}+|\\p{L}+n't|ma[a-z0-9]{2,}(?:ch|sh)" +
    "|m(?:ka|kan|3and|3nd|fih|ra|ahou|ahi|ana|ani)[a-z0-9]*(?:ch|sh))$",
  "u"
);
/** What MSA negates with غير: "غير مجاني", "غير مضمون", "غير محدودة". */
const NOT_ADJECTIVE = /^(?:مجان|مضمون|محدود|متوفر|موجود|متاح|صالح|مشمول|قابل|ممكن|مخف)/;
/** "ماشي غير", "pas seulement", "not only": the claim stands. */
const ONLY = new Set(["seulement", "uniquement", "only", "just", "juste", "غير", "برك", "فقط", "que", "ghir"]);
/** "هذا ما يجعلنا الأحسن": this ما is "what", not "not". */
const MA_IS_WHAT = new Set([
  "قبل", "بعد", "كل", "مثل", "حسب", "عند", "مع", "كيف", "هذا", "هذه", "هذي", "هادا", "هادي", "هاذا", "هاذي", "اللي", "حتي",
]);
/** "Pas de souci", "ما تقلقش", "ne tardez pas": a reassurance or an urge, which negates nothing after it. */
const NOT_NEGATING = words([
  "pas de (?:soucis?|problemes?|stress|panique|inquietudes?)", "pas d'inquietudes?", "sans (?:soucis?|problemes?|stress)",
  "(?:ne )?(?:vous |t')?inquiete[sz]?(?:-vous)? pas", "n'hesite[sz]? pas", "ne (?:tardez|ratez|manquez|loupez|hesitez) pas",
  "(?:don't|do not|dont|never) (?:worry|hesitate|miss)", "no (?:worries|worry|problems?|stress|hesitation)", "not a problem",
  "(?:ما ?|م)?ت(?:قلق|خاف|خمم|تردد|حير|ضيع|فوت|نسا|بطا|عطل)(?:ي|و)?ش", "لا ?ت(?:قلق|خف|خاف|تردد|حزن|فوت|ضيع|نس)(?:ي|وا|و)?",
  "لا داعي (?:ل|لل)(?:قلق|خوف)", "(?:ما ?|م)?(?:كاش|كانش|كاينش|عندناش) (?:حتى )?(?:مشكل|مشكله|مشاكل)",
  "(?:ماشي|مشي|مش|لا|بلا|بدون) (?:مشكل|مشكله|مشاكل)",
  "(?:ma ?)?t(?:9ala9|9le9|khaf|khmem|khamem)(?:i|o)?ch", "(?:ma ?|m)?(?:kach|kanch|kaynch) (?:mochkil|mouchkil|mochkila|probleme?)",
  "(?:machi|mchi|mch) (?:mochkil|mouchkil|probleme?)",
]);
/** A new clause: "pas de remise, mais...", "معندناش تخفيض بصح...". */
const CONTRASTS = new Set([
  "mais", "cependant", "pourtant", "toutefois", "sinon", "sauf", "but", "however", "though", "although", "except",
  "بصح", "بصاح", "لكن", "ولكن", "لاكن", "بالصح", "اما", "bessah", "bsah", "bsa7", "bessa7", "walakin", "walakine",
]);
const ANDS = new Set(["et", "and", "و"]);
const ARTICLES = new Set(["la", "le", "les", "un", "une", "the", "des", "du"]);
/** "Si vous n'êtes pas satisfait, ...", "إذا ما عجبكش": the negation is the condition's. */
const CONDITIONS = new Set([
  "si", "s'il", "s'ils", "if", "اذا", "لو", "لوكان", "ايلا", "كان", "ila", "ida", "ken", "lukan", "lokan",
]);
/** "Il n'y a que la livraison qui est gratuite", "ما عندنا غير التوصيل المجاني": only, not none. */
const EXCEPTIVES = new Set(["que", "الا", "غير", "ghir"]);
/** Said after the claim: "promo makach", "التخفيض ماكانش", "free delivery is unavailable". */
const NONE_AFTER = new Set([
  "ماكانش", "مكانش", "ماكاش", "مكاش", "ماكانتش", "مكانتش", "ماكاينش", "مكاينش", "والو", "لايوجد", "لاتوجد", "مافيش", "مفيش",
  "ماعندناش", "معندناش", "makach", "makanch", "mkach", "mkanch", "makaynch", "makayench", "walou", "walo",
  "indisponible", "indisponibles", "unavailable",
]);
/** "ماشي موجود", "n'est pas disponible", "not available": these deny when followed by such a word. */
const NOT_AFTER = new Set([
  "ماهوش", "مهوش", "ماهيش", "مهيش", "ماراهش", "مراهش", "ماشي", "مشي", "مش", "موش", "ليس", "ليست",
  "machi", "mach", "mich", "mech", "mouch", "ne", "not", "no", "pas", "non",
]);
const AVAILABLE = new Set([
  "متوفر", "متوفره", "متوفرين", "موجود", "موجوده", "متاح", "متاحه", "ممكن", "مشمول", "مشموله", "صالح", "صالحه",
  "ساري", "متواجد", "كاين", "كاينه",
  "disponible", "disponibles", "possible", "inclus", "incluse", "valable", "valables", "valide", "valides",
  "applicable", "applicables", "s'applique", "offert", "offerte", "prevu", "prevue",
  "available", "valid", "included", "offered", "existe", "existent", "exist",
]);

const WINDOW_BEFORE = 5;
const WINDOW_AFTER = 3;

interface Analysis {
  folded: Folded;
  tokens: Token[];
  /** Tokens of "pas de souci", "ما تقلقش"...: no negation. */
  neutral: boolean[];
}

/** The text as it is compared, without its links and its "feel free". */
function prepare(source: string, positions: boolean): Folded {
  const folded = fold(source.replace(LINK, blank), positions);
  folded.text = folded.text.replace(NOT_FREE, blank);
  return folded;
}

/** The words of a text, read only when something in it may be a claim. */
function analyse(folded: Folded): Analysis {
  const tokens = tokenize(folded.text);
  const neutral = tokens.map(() => false);
  for (const match of matches(folded.text, NOT_NEGATING)) {
    for (let i = tokenAfter(tokens, match.start); i < tokens.length && tokens[i].end <= match.end; i++) neutral[i] = true;
  }
  return { folded, tokens, neutral };
}

const startsWithArticle = (word: string) => word.startsWith("ال") || word.startsWith("l'") || ARTICLES.has(word);

/** A clause starts at this word: "mais", "بصح", "et la livraison...", "par contre". */
function opensClause(a: Analysis, i: number): boolean {
  const word = a.tokens[i].text;
  const prev = a.tokens[i - 1]?.text;
  const next = a.tokens[i + 1]?.text ?? "";
  return (
    CONTRASTS.has(word) ||
    (word === "contre" && prev === "par") ||
    (word === "revanche" && prev === "en") ||
    (ANDS.has(word) && startsWithArticle(next))
  );
}

/** Whether the word at i negates what follows it; "adjacent" when that is the claim itself. */
function negates(a: Analysis, i: number, adjacent: boolean): boolean {
  if (a.neutral[i]) return false;
  const word = a.tokens[i].text;
  const next = a.tokens[i + 1]?.text ?? "";
  if (ONLY.has(next)) return false;
  switch (word) {
    case "غير":
      // MSA "غير مجاني" is "not free"; Darija "غير تخفيض صغير" is "only a small discount".
      return adjacent && NOT_ADJECTIVE.test(next);
    case "ولا":
      // Darija "or", unless it carries on a negation: "ما عندناش تخفيض ولا هدية".
      return negationEarlier(a, i);
    case "ما":
      return !MA_IS_WHAT.has(a.tokens[i - 1]?.text ?? "");
    case "ma":
      return /(?:ch|sh)$/.test(next);
    case "لا":
    case "non":
    case "no":
      // "لا، ..." or "Non la livraison est gratuite": an answer, not a negation of the claim.
      if (startsWithArticle(next)) return false;
  }
  return NEGATIONS.has(word) || DARIJA_NEGATED.test(word) || DARIJA_NEGATED_SHORT.test(word) || LATIN_NEGATED.test(word);
}

function negationEarlier(a: Analysis, i: number): boolean {
  for (let j = i - 1; j >= 0; j--) {
    if (a.tokens[j + 1].opens || opensClause(a, j + 1)) return false;
    if (a.tokens[j].text !== "ولا" && negates(a, j, false)) return true;
  }
  return false;
}

/** A condition before the negation, in the same clause: "إذا ما عجبكش نرجعولك دراهمك". */
function conditional(a: Analysis, i: number): boolean {
  for (let j = i - 1; j >= 0; j--) {
    if (a.tokens[j + 1].opens || opensClause(a, j + 1)) return false;
    if (CONDITIONS.has(a.tokens[j].text)) return true;
  }
  return false;
}

/** A negation in the few words before the claim, in the same clause. */
function negatedBefore(a: Analysis, first: number): boolean {
  const token = a.tokens[first];
  // "والتوصيل مجاني" starts a new clause of its own.
  if (!token || first === 0 || token.opens || /^وال/.test(token.text) || opensClause(a, first)) return false;
  for (let i = first - 1, seen = 0; i >= 0 && seen < WINDOW_BEFORE; i--, seen++) {
    if (opensClause(a, i)) return false;
    if (negates(a, i, i === first - 1)) return !conditional(a, i);
    if (EXCEPTIVES.has(a.tokens[i].text) || a.tokens[i].text.startsWith("qu'")) return false;
    if (a.tokens[i].opens) return false;
  }
  return false;
}

/** A negation between the two parts: "التوصيل ماشي مجاني", "la livraison n'est pas gratuite". */
function negatedBetween(a: Analysis, from: number, to: number): boolean {
  for (let i = from; i < to; i++) {
    if (negates(a, i, i === to - 1) && !conditional(a, i)) return true;
  }
  return false;
}

/** A denial right after the claim: "promo makach", "التخفيض ماشي موجود", "is not available". */
function negatedAfter(a: Analysis, last: number): boolean {
  for (let i = last + 1; i < a.tokens.length && i <= last + WINDOW_AFTER; i++) {
    if (a.tokens[i].opens || opensClause(a, i)) return false;
    if (a.neutral[i]) continue;
    const word = a.tokens[i].text;
    const next = a.tokens[i + 1];
    if (next && ONLY.has(next.text)) continue;
    if (NONE_AFTER.has(word) || word.startsWith("n'exist")) return true;
    if (word === "لا" && /^(?:يوجد|توجد|يتوفر|تتوفر|يمكن)$/.test(next?.text ?? "")) return true;
    if ((word === "ما" || word === "ma") && /(?:ش|ch|sh)$|^(?:كاين|عندنا|كان)$/.test(next?.text ?? "")) return true;
    if (word === "غير" && next && AVAILABLE.has(next.text)) return true;
    const copula = NOT_AFTER.has(word) || /^n'/.test(word) || /n't$/.test(word);
    if (copula) {
      // "...ماشي موجود", "...n'est pas disponible", or nothing more in the clause.
      for (let k = i + 1; k <= i + 2 && k < a.tokens.length; k++) {
        if (a.tokens[k].opens) break;
        if (AVAILABLE.has(a.tokens[k].text)) return true;
      }
      if (!next || next.opens) return true;
    }
  }
  return false;
}

/** Where the sentence after a position ends with a question mark, or -1. */
function questionMark(text: string, end: number): number {
  const stop = text.slice(end).search(/[.!?؟\n]/);
  return stop >= 0 && (text[end + stop] === "?" || text[end + stop] === "؟") ? end + stop : -1;
}

/** The sentence asks: it ends with a question mark or starts with "واش", "est-ce". */
function asked(text: string, start: number, end: number): boolean {
  if (questionMark(text, end) >= 0) return true;
  const opening = Math.max(...[".", "!", "?", "؟", "\n"].map((mark) => text.lastIndexOf(mark, start - 1))) + 1;
  return /^\s*(?:واش|wach|wech|est-ce|est ce)(?![\p{L}])/u.test(text.slice(opening, start));
}

// The shop's FAQ asks the customer's questions: "Il y a une garantie ?" with
// the answer "Non." makes no claim. The answer follows the question mark, or
// is the next text (an entry's content after its title).
const ANSWER_LABEL = /^\s*(?:-\s*)?(?:a|r|ج|reponse|answer|الجواب|جواب)\s*:\s*/u;
const ANSWER_NO = new Set([
  "non", "no", "nope", "nan", "لا", "لالا", "pas", "aucun", "aucune", "jamais", "never", "not",
  "makach", "makanch", "mkach", "machi", "ماشي", "مشي", "مش", "والو",
]);

const FIRST_WORD = new RegExp(TOKEN.source, "u");

/** "nextText" is the next text, already compared as text is. */
function answeredNo(text: string, claim: Found, nextText: string | undefined): boolean {
  const mark = questionMark(text, claim.end);
  if (mark < 0) return false;
  let answer = text.slice(mark + 1);
  if (!/[\p{L}\p{N}]/u.test(answer) && nextText !== undefined) answer = nextText;
  const first = FIRST_WORD.exec(answer.replace(ANSWER_LABEL, ""))?.[0] ?? "";
  return ANSWER_NO.has(first) || DARIJA_NEGATED.test(first) || DARIJA_NEGATED_SHORT.test(first);
}

// ─── Finding claims ─────────────────────────────────────────────────────────

/** Words or two parts that may make a claim, before negations are read. */
interface Hit {
  kind: ClaimKind;
  start: number;
  end: number;
  loose: boolean;
  /** For two parts: where the first ends and the second starts. */
  between?: [number, number];
}

interface Found extends Hit {
  negated: boolean;
}

/** The first word that ends after a position. */
function tokenAfter(tokens: Token[], position: number): number {
  let low = 0;
  let high = tokens.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (tokens[mid].end > position) high = mid;
    else low = mid + 1;
  }
  return low;
}

/** The first and the last word of a span. */
function spanTokens(a: Analysis, start: number, end: number): [number, number] {
  const first = tokenAfter(a.tokens, start);
  let last = tokenAfter(a.tokens, end) - 1;
  if (a.tokens[last + 1] && a.tokens[last + 1].start < end) last += 1;
  return [first, Math.max(first, last)];
}

/** Whether a hit is negated; null when its two parts lie in different clauses. */
function found(a: Analysis, hit: Hit): Found | null {
  const [first, last] = spanTokens(a, hit.start, hit.end);
  let between: [number, number] | undefined;
  if (hit.between) {
    between = [tokenAfter(a.tokens, hit.between[0]), tokenAfter(a.tokens, hit.between[1])];
    for (let i = between[0]; i < between[1]; i++) if (opensClause(a, i)) return null;
  }
  const negated =
    negatedBefore(a, first) || (between !== undefined && negatedBetween(a, between[0], between[1])) || negatedAfter(a, last);
  return { ...hit, negated };
}

function* matches(text: string, pattern: Pattern) {
  if (!pattern.quick.test(text)) return;
  for (const match of text.matchAll(pattern.re)) {
    if (match[0].trim()) yield { start: match.index, end: match.index + match[0].length, text: match[0] };
  }
}

/** Between two parts of one claim: no end of clause, and no price ("Livraison 400 DA et montage gratuit"). */
const GAP_BREAK = /[.!?؟;؛,،\n]/;
const MONEY = /(?<![\p{L}\p{N}])(?:da|dzd|dinars?|دج|دينار|دنانير|euros?)(?![\p{L}\p{N}])|[€$]/u;

function pairHits(text: string, rule: PairRule): Hit[] {
  const hits: Hit[] = [];
  const seconds = [...matches(text, rule.second)];
  if (seconds.length === 0) return hits;
  for (const first of matches(text, rule.first)) {
    // The nearest second part after the first, if it is close enough.
    const second = seconds.find((candidate) => candidate.start >= first.end);
    if (!second) continue;
    const between = text.slice(first.end, second.start);
    if ((between.match(TOKEN) ?? []).length > rule.gap || GAP_BREAK.test(between) || MONEY.test(between)) continue;
    hits.push({ kind: rule.kind, start: first.start, end: second.end, loose: false, between: [first.end, second.start] });
  }
  return hits;
}

function wordHits(text: string, rule: WordRule): Hit[] {
  const hits: Hit[] = [];
  for (const match of matches(text, rule.re)) {
    const context = {
      before: text.slice(Math.max(0, match.start - 60), match.start),
      match: match.text,
      after: text.slice(match.end, match.end + 60),
    };
    if (rule.unless?.(context)) continue;
    hits.push({ kind: rule.kind, start: match.start, end: match.end, loose: rule.loose ?? false });
  }
  return hits;
}

interface Rules {
  words: WordRule[];
  pairs: PairRule[];
}

const ALL_RULES: Rules = { words: WORD_RULES, pairs: PAIR_RULES };

/** The rules that may match somewhere in a text: a rule whose bare terms are absent matches nowhere. */
function rulesFor(folded: string): Rules {
  return {
    words: WORD_RULES.filter((rule) => rule.re.quick.test(folded)),
    pairs: PAIR_RULES.filter((rule) => rule.first.quick.test(folded) && rule.second.quick.test(folded)),
  };
}

/**
 * The affirmative claims of a prepared text. Where two overlap, the longer
 * one decides, negated or not: "livraison offerte" is free delivery, not a
 * gift, and "pas de livraison gratuite" leaves no "gratuite" behind. A
 * question answered "no" claims nothing ("Garantie ? Non."); its answer may
 * be the next text, as an FAQ entry's content follows its title.
 */
function detect(folded: Folded, options: { nextText?: string; rules?: Rules } = {}): Found[] {
  const { nextText, rules = ALL_RULES } = options;
  const hits = [
    ...rules.words.flatMap((rule) => wordHits(folded.text, rule)),
    ...rules.pairs.flatMap((rule) => pairHits(folded.text, rule)),
  ];
  // Most texts hold no claim word: their words are never read.
  if (hits.length === 0) return [];
  const analysis = analyse(folded);
  const all = hits.map((hit) => found(analysis, hit)).filter((claim): claim is Found => claim !== null);
  all.sort((x, y) => x.start - y.start || y.end - x.end);
  const kept: Found[] = [];
  for (const claim of all) {
    if (kept.some((other) => other.start <= claim.start && other.end >= claim.end)) continue;
    kept.push(claim);
  }
  return kept.filter(
    (claim) =>
      !claim.negated &&
      !(ASKED_NOT_CLAIMED.has(claim.kind) && asked(folded.text, claim.start, claim.end)) &&
      !answeredNo(folded.text, claim, nextText)
  );
}

interface ShopClaims {
  kinds: ReadonlySet<ClaimKind>;
  /** The shop wrote "free" alone somewhere. */
  free: boolean;
}

const shopCache = new Map<string, ShopClaims>();
const SHOP_CACHE_SIZE = 16;
const TEXTS_APART = String.fromCharCode(0);

/**
 * What the shop's own texts claim. Every reply of a brand comes with the
 * same texts, so the answer is kept for the last few brands.
 */
function shopClaims(brandTexts: string[]): ShopClaims {
  const key = brandTexts.join(TEXTS_APART);
  const cached = shopCache.get(key);
  if (cached) {
    shopCache.delete(key);
    shopCache.set(key, cached);
    return cached;
  }
  const texts = brandTexts.map((text) => prepare(text, false));
  // Hundreds of texts: the rules that none of them can match are left out at once.
  const rules = rulesFor(texts.map((folded) => folded.text).join("\n"));
  const kinds = new Set<ClaimKind>();
  let free = false;
  if (rules.words.length > 0 || rules.pairs.length > 0) {
    texts.forEach((folded, i) => {
      for (const claim of detect(folded, { nextText: texts[i + 1]?.text, rules })) {
        if (claim.loose) free = true;
        else kinds.add(claim.kind);
      }
    });
  }
  const claims = { kinds, free };
  shopCache.set(key, claims);
  const oldest = shopCache.keys().next().value;
  if (shopCache.size > SHOP_CACHE_SIZE && oldest !== undefined) shopCache.delete(oldest);
  return claims;
}

function phrase(source: string, folded: Folded, claim: Found): string {
  const start = folded.from[claim.start];
  const lastChar = folded.from[claim.end - 1];
  const end = lastChar + ((source.codePointAt(lastChar) ?? 0) > 0xffff ? 2 : 1);
  return source.slice(start, end).trim();
}

/**
 * Free alone is free delivery when the delivery was spoken of before it,
 * with no price in between ("La livraison ? C'est gratuit"), a gift
 * otherwise ("Livraison 400 DA, et le montage gratuit").
 */
function kindOf(claim: Found, folded: Folded): ClaimKind {
  if (!claim.loose) return claim.kind;
  const delivery = [...matches(folded.text, DELIVERY)].filter((match) => match.end <= claim.start).at(-1);
  return delivery && !MONEY.test(folded.text.slice(delivery.end, claim.start)) ? "free_delivery" : "gift";
}

/** The affirmative claims of a text, in reading order. */
export function findClaims(text: string): Claim[] {
  const folded = prepare(text, true);
  return detect(folded).map((claim) => ({ kind: kindOf(claim, folded), phrase: phrase(text, folded, claim) }));
}

/**
 * The first claim of the reply that the shop never made: a kind passes only
 * when the brand's own texts make a claim of that kind, and a question of
 * the shop's FAQ answered "no" makes none. "Free" alone ("c'est gratuit")
 * passes when the shop promised free delivery or a gift, and a shop's own
 * "free" alone allows both: it may be either.
 */
export function checkClaims(reply: string, brandTexts: string[]): GuardViolation | null {
  const folded = prepare(reply, true);
  const claims = detect(folded);
  // Most replies claim nothing: the shop's texts are only read when one does.
  if (claims.length === 0) return null;
  const shop = shopClaims(brandTexts);
  const freeOffered = shop.free || shop.kinds.has("gift") || shop.kinds.has("free_delivery");
  for (const claim of claims) {
    const allowed = claim.loose
      ? freeOffered
      : shop.kinds.has(claim.kind) || (shop.free && (claim.kind === "gift" || claim.kind === "free_delivery"));
    if (allowed) continue;
    const kind = kindOf(claim, folded);
    return { category: "NOT_IN_KB", reason: CLAIM_REASONS[kind], detail: phrase(reply, folded, claim) };
  }
  return null;
}
