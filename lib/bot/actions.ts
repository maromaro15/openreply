/**
 * The optional actions next to the bot's text reply (PLAN.md 6.14): send the
 * pictures of some colours of a product, or compare a few products in a
 * carousel.
 *
 * The model only names things; this module checks every name against the
 * brand's catalog and keeps only what it can verify. Nothing is sent that the
 * catalog does not have, and everything dropped is listed with a reason for
 * the logs.
 *
 * Pure functions: no database, no network, no environment.
 */
import { normalizeCode } from "@/lib/catalog/codes";

// ─── What the model may ask for ─────────────────────────────────────────────

/** The `actions` property of the model's answer (Gemini's OpenAPI subset). */
export const ACTIONS_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "ARRAY",
  description:
    "optional pictures to send after your reply; an empty list when none is needed or when handoff is true",
  items: {
    type: "OBJECT",
    properties: {
      type: {
        type: "STRING",
        enum: ["send_colours", "compare"],
        description:
          "send_colours: pictures of colours of one product; compare: one carousel card per product, for a customer hesitating between products",
      },
      product: {
        type: "STRING",
        description: "send_colours: the product's name or code exactly as in the PRODUCT CATALOG; empty for compare",
      },
      colours: {
        type: "ARRAY",
        items: { type: "STRING" },
        description:
          "send_colours: the colour codes as in the PRODUCT CATALOG, or an empty list for all its colours; empty for compare",
      },
      products: {
        type: "ARRAY",
        items: { type: "STRING" },
        description: "compare: two or more product names or codes exactly as in the PRODUCT CATALOG; empty for send_colours",
      },
    },
    required: ["type"],
    propertyOrdering: ["type", "product", "colours", "products"],
  },
};

// ─── What the catalog offers ────────────────────────────────────────────────

export interface ActionProduct {
  id: string;
  name: string;
  code: string | null;
  price: string | null;
  available: boolean;
  /** The product page, for the carousel's details button. */
  landingUrl: string | null;
  /** The main picture's public path, or null. */
  imagePath: string | null;
  /** "Label: value" of its first attributes, already formatted, in template order. */
  highlights: string[];
  variants: { code: string; name: string | null; available: boolean; imagePath: string | null }[];
}

export type ActionCard = {
  title: string;
  subtitle: string | null;
  imagePath: string;
  productId: string;
  variantCode: string | null;
  landingUrl: string | null;
};

export type ActionPlan = { type: "colours"; productId: string; cards: ActionCard[] } | { type: "compare"; cards: ActionCard[] };

export type DroppedAction = { reason: string; detail: string };

export const ACTION_LIMITS = {
  imagesPerReply: 20,
  comparePerReply: 1,
  compareMin: 2,
  compareMax: 10,
  coloursMax: 20,
} as const;

/** Messenger's generic template cuts titles and subtitles past this. */
const CARD_TEXT_MAX = 80;
/** More actions than this is junk: the rest is not even read. */
const MAX_ACTIONS_READ = 10;
/** Names and codes are short: past this a value is a sentence, not a name. */
const MAX_NAME_LENGTH = 200;
/** How much of an untrusted value a drop's detail repeats. */
const DETAIL_MAX = 60;

// ─── Plain text ─────────────────────────────────────────────────────────────

const LINE_BREAK = /\r\n|[\n\r\v\f\u0085\u2028\u2029]/;

/** One line, trimmed, without control or invisible characters. */
function oneLine(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .split(LINE_BREAK)
    .map((line) => line.replace(/[\p{Cc}\p{Cf}]/gu, "").trim())
    .filter(Boolean)
    .join(" / ");
}

/** At most `max` characters (code points), with "…" when cut. */
function cut(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

function detail(value: unknown): string {
  return cut(oneLine(value), DETAIL_MAX);
}

/**
 * Text as names are compared: lower case, without accents, Arabic
 * diacritics, tatweel or invisible marks, one spelling for hamza, taa
 * marbuta and alef maqsura, ASCII digits, and punctuation as one space
 * ("Lambris PVC-3D" is "lambris pvc 3d"). The same folding as the catalog's
 * prompt, so a name the model copied from it matches.
 */
function foldName(text: string): string {
  return text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\p{M}\p{Cf}ـ]/gu, "")
    .replace(/ٱ/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/[ىی]/g, "ي")
    .replace(/ک/g, "ك")
    .replace(/(?![0-9])\p{Nd}/gu, (digit) => normalizeCode(digit))
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function codeKey(text: string): string {
  return normalizeCode(foldName(text));
}

function stringList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// ─── Finding things in the catalog ──────────────────────────────────────────

type Variant = ActionProduct["variants"][number];

interface Catalog {
  byName: Map<string, ActionProduct[]>;
  byCode: Map<string, ActionProduct>;
}

function indexCatalog(products: ActionProduct[]): Catalog {
  const byName = new Map<string, ActionProduct[]>();
  const byCode = new Map<string, ActionProduct>();
  for (const product of Array.isArray(products) ? products : []) {
    if (!product || typeof product.id !== "string") continue;
    const name = foldName(oneLine(product.name));
    if (name) byName.set(name, [...(byName.get(name) ?? []), product]);
    const code = codeKey(oneLine(product.code));
    if (code && !byCode.has(code)) byCode.set(code, product);
  }
  return { byName, byCode };
}

type Found<T> = { item: T } | { reason: string };

/** By its exact name (folded), then by its code in any spelling. */
function findProduct(catalog: Catalog, raw: unknown): Found<ActionProduct> {
  const text = oneLine(raw);
  if (!text || text.length > MAX_NAME_LENGTH) return { reason: "unknown_product" };
  const named = catalog.byName.get(foldName(text)) ?? [];
  if (named.length === 1) return { item: named[0] };
  const coded = catalog.byCode.get(codeKey(text));
  if (coded) return { item: coded };
  // Two products with one name and no code to tell them apart: guessing could show the wrong one.
  return { reason: named.length > 1 ? "ambiguous_product" : "unknown_product" };
}

/** Among the product's colours: by code in any spelling, then by exact name, then "code name". */
function findVariant(product: ActionProduct, raw: unknown): Found<Variant> {
  const text = oneLine(raw);
  if (!text || text.length > MAX_NAME_LENGTH) return { reason: "unknown_colour" };
  const variants = stringList(product.variants).filter(
    (variant): variant is Variant => Boolean(variant) && typeof (variant as Variant).code === "string"
  );
  const key = codeKey(text);
  const coded = variants.find((variant) => key && codeKey(oneLine(variant.code)) === key);
  if (coded) return { item: coded };
  const folded = foldName(text);
  const named = variants.filter((variant) => folded && foldName(oneLine(variant.name)) === folded);
  if (named.length === 1) return { item: named[0] };
  if (named.length > 1) return { reason: "ambiguous_colour" };
  // The index writes "12 (Beige)": the model may copy both.
  const both = variants.find(
    (variant) => oneLine(variant.name) && foldName(`${oneLine(variant.code)} ${oneLine(variant.name)}`) === folded
  );
  return both ? { item: both } : { reason: "unknown_colour" };
}

function imageOf(path: unknown): string | null {
  const text = oneLine(path);
  return text ? text : null;
}

// ─── Cards ──────────────────────────────────────────────────────────────────

function colourCard(product: ActionProduct, variant: Variant, imagePath: string): ActionCard {
  const code = oneLine(variant.code);
  const name = oneLine(variant.name);
  return {
    title: cut(name ? `${code} ${name}` : code, CARD_TEXT_MAX),
    subtitle: cut(oneLine(product.name), CARD_TEXT_MAX) || null,
    imagePath,
    productId: product.id,
    variantCode: variant.code,
    landingUrl: oneLine(product.landingUrl) || null,
  };
}

/** Price, then highlights, " · " between them; whole parts only, so no price is cut in half. */
function compareSubtitle(product: ActionProduct): string | null {
  const parts = [oneLine(product.price), ...stringList(product.highlights).map(oneLine)].filter(Boolean);
  let subtitle = "";
  for (const part of parts) {
    const next = subtitle ? `${subtitle} · ${part}` : part;
    if (Array.from(next).length > CARD_TEXT_MAX) {
      // Only a first part longer than the whole line is cut, so the card still says something.
      if (!subtitle) subtitle = cut(part, CARD_TEXT_MAX);
      break;
    }
    subtitle = next;
  }
  return subtitle || null;
}

function compareCard(product: ActionProduct, imagePath: string): ActionCard {
  return {
    title: cut(oneLine(product.name), CARD_TEXT_MAX) || cut(oneLine(product.code), CARD_TEXT_MAX),
    subtitle: compareSubtitle(product),
    imagePath,
    productId: product.id,
    variantCode: null,
    landingUrl: oneLine(product.landingUrl) || null,
  };
}

// ─── The plan ───────────────────────────────────────────────────────────────

interface Action {
  type: unknown;
  product: unknown;
  colours: unknown;
  products: unknown;
}

function asAction(value: unknown): Action | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return { type: record.type, product: record.product, colours: record.colours, products: record.products };
}

/**
 * The model's actions, checked against the brand's active products.
 *
 * - send_colours: the product by its exact name (folded: case, accents,
 *   Arabic letter variants) or its code in any spelling; each colour by its
 *   code in any spelling, or its exact name, among that product's colours.
 *   An empty list means all its colours. One card per colour with a picture:
 *   title "<code> <name>", subtitle the product's name. At most coloursMax.
 * - compare: the same lookup for each product; one card per product with a
 *   picture: title its name, subtitle its price and highlights (" · ", cut
 *   to 80). Kept only with at least compareMin products, at most compareMax;
 *   only the first compare of a reply.
 * - At most imagesPerReply cards in all: the later ones are dropped.
 * - Duplicates (in an action or already in an earlier one) are removed.
 *
 * Everything dropped is listed with a reason. Never throws on junk.
 */
export function planActions(
  raw: unknown,
  products: ActionProduct[]
): { plans: ActionPlan[]; dropped: DroppedAction[] } {
  const plans: ActionPlan[] = [];
  const dropped: DroppedAction[] = [];
  if (raw === null || raw === undefined) return { plans, dropped };
  if (!Array.isArray(raw)) {
    dropped.push({ reason: "not_a_list", detail: typeof raw });
    return { plans, dropped };
  }
  if (raw.length > MAX_ACTIONS_READ) {
    dropped.push({ reason: "too_many_actions", detail: `${raw.length - MAX_ACTIONS_READ} not read` });
  }

  const catalog = indexCatalog(products);
  const sentColours = new Set<string>();
  let images = 0;
  let compares = 0;

  /** The cards that still fit under the reply's image limit; the rest is dropped. */
  const fit = (cards: ActionCard[], what: string): ActionCard[] => {
    const room = Math.max(0, ACTION_LIMITS.imagesPerReply - images);
    if (cards.length > room) {
      dropped.push({ reason: "image_limit", detail: `${cards.length - room} of ${what}` });
    }
    return cards.slice(0, room);
  };

  for (const value of raw.slice(0, MAX_ACTIONS_READ)) {
    const action = asAction(value);
    if (!action) {
      dropped.push({ reason: "not_an_action", detail: Array.isArray(value) ? "a list" : detail(String(value)) });
      continue;
    }

    if (action.type === "send_colours") {
      const found = findProduct(catalog, action.product);
      if ("reason" in found) {
        dropped.push({ reason: found.reason, detail: detail(action.product) });
        continue;
      }
      const product = found.item;
      const asked = stringList(action.colours);
      const variants: Variant[] = [];
      if (asked.length === 0) {
        for (const variant of stringList(product.variants) as Variant[]) {
          if (variant && typeof variant.code === "string" && imageOf(variant.imagePath)) variants.push(variant);
        }
      } else {
        for (const colour of asked) {
          const variant = findVariant(product, colour);
          if ("reason" in variant) dropped.push({ reason: variant.reason, detail: `${detail(product.name)}: ${detail(colour)}` });
          else variants.push(variant.item);
        }
      }

      let cards: ActionCard[] = [];
      for (const variant of variants) {
        const key = `${product.id}\u0000${codeKey(oneLine(variant.code))}`;
        const label = `${detail(product.name)}: ${detail(variant.code)}`;
        const imagePath = imageOf(variant.imagePath);
        if (sentColours.has(key)) dropped.push({ reason: "duplicate", detail: label });
        else if (!imagePath) dropped.push({ reason: "no_image", detail: label });
        else {
          sentColours.add(key);
          cards.push(colourCard(product, variant, imagePath));
        }
      }
      if (cards.length > ACTION_LIMITS.coloursMax) {
        dropped.push({ reason: "too_many_colours", detail: `${cards.length - ACTION_LIMITS.coloursMax} of ${detail(product.name)}` });
        cards = cards.slice(0, ACTION_LIMITS.coloursMax);
      }
      cards = fit(cards, detail(product.name));
      if (cards.length) {
        images += cards.length;
        plans.push({ type: "colours", productId: product.id, cards });
      } else if (asked.length === 0 && variants.length === 0) {
        // "All its colours" of a product whose colours have no picture; any other empty plan already says why.
        dropped.push({ reason: "no_image", detail: detail(product.name) });
      }
      continue;
    }

    if (action.type === "compare") {
      if (compares >= ACTION_LIMITS.comparePerReply) {
        dropped.push({ reason: "extra_compare", detail: stringList(action.products).map(detail).join(", ") });
        continue;
      }
      compares += 1;
      const seen = new Set<string>();
      let cards: ActionCard[] = [];
      for (const name of stringList(action.products)) {
        const found = findProduct(catalog, name);
        if ("reason" in found) {
          dropped.push({ reason: found.reason, detail: detail(name) });
          continue;
        }
        const product = found.item;
        const imagePath = imageOf(product.imagePath);
        if (seen.has(product.id)) dropped.push({ reason: "duplicate", detail: detail(name) });
        else if (!imagePath) dropped.push({ reason: "no_image", detail: detail(product.name) });
        else {
          seen.add(product.id);
          cards.push(compareCard(product, imagePath));
        }
      }
      if (cards.length > ACTION_LIMITS.compareMax) {
        dropped.push({ reason: "too_many_products", detail: `${cards.length - ACTION_LIMITS.compareMax} not compared` });
        cards = cards.slice(0, ACTION_LIMITS.compareMax);
      }
      cards = fit(cards, "the comparison");
      // One card is not a comparison.
      if (cards.length < ACTION_LIMITS.compareMin) {
        dropped.push({ reason: "too_few_products", detail: cards.map((card) => card.title).join(", ") });
        continue;
      }
      images += cards.length;
      plans.push({ type: "compare", cards });
      continue;
    }

    dropped.push({ reason: "unknown_type", detail: detail(typeof action.type === "string" ? action.type : typeof action.type) });
  }

  return { plans, dropped };
}

// ─── The prompt ─────────────────────────────────────────────────────────────

const ACTIONS_GUIDE = [
  "Next to your reply you may ask the system to send pictures, in the actions list. Leave it empty when no picture is needed, and always when handoff is true.",
  '- send_colours: when the customer asks to see the colours of a product, or one colour. Put the product\'s name or code in "product", and the colour codes in "colours", or leave "colours" empty to send all its colours.',
  '- compare: when the customer hesitates between a few products. Put their names or codes in "products": at least two, at most ten.',
  "Use only products and colour codes written in the PRODUCT CATALOG, copied as they are written there. Anything else is not sent.",
  "At most one compare per answer, and at most twenty pictures in all. Do not send again pictures the conversation already sent, unless the customer asks.",
  "Your reply must still answer on its own, as if no picture were sent: the pictures may fail to send. Do not write that they are on their way.",
].join("\n");

/** The "## ACTIONS" section of the system instruction. It holds no digit, for the guard. */
export function actionsPromptSection(): string {
  return `## ACTIONS\n${ACTIONS_GUIDE}`;
}
