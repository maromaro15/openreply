/**
 * The catalog as the bot gets it: a brand's active products and attribute
 * template, loaded once per answer, shaped for lib/catalog/prompt.ts, and
 * the conversation's "focus" (the products it is about) kept up to date.
 */
import type { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import type { CatalogAttribute, CatalogProduct } from "./prompt";

/** More than a brand can hold (MAX_PRODUCTS): the index has its own size cap. */
const MAX_LOADED = 2000;
/** The products a conversation remembers being about. */
export const MAX_FOCUS_PRODUCTS = 5;

function attributeValues(value: Prisma.JsonValue): Record<string, string | number | boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const values: Record<string, string | number | boolean> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") values[key] = item;
  }
  return values;
}

function objectionList(value: Prisma.JsonValue): { question: string; answer: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const { question, answer } = item as Record<string, unknown>;
    return typeof question === "string" && typeof answer === "string" ? [{ question, answer }] : [];
  });
}

export async function loadCatalogForBot(
  workspaceId: string
): Promise<{ attributes: CatalogAttribute[]; products: CatalogProduct[] }> {
  const [attributes, products] = await Promise.all([
    prisma.productAttribute.findMany({
      where: { workspaceId },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { key: true, label: true, type: true, unit: true },
    }),
    prisma.product.findMany({
      // Drafts are not approved yet and archived products are gone: the
      // bot knows neither.
      where: { workspaceId, status: "ACTIVE" },
      // A very large index is cut at its end: what can be sold now comes first.
      orderBy: [{ available: "desc" }, { name: "asc" }, { id: "asc" }],
      take: MAX_LOADED,
      include: {
        variants: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
        related: { include: { related: { select: { id: true, name: true, status: true } } } },
      },
    }),
  ]);

  return {
    attributes,
    products: products.map((product) => ({
      id: product.id,
      name: product.name,
      code: product.code,
      price: product.price,
      available: product.available,
      landingUrl: product.landingUrl,
      description: product.description,
      howToUse: product.howToUse,
      attributes: attributeValues(product.attributes),
      strengths: product.strengths,
      comparisons: product.comparisons,
      suitableFor: product.suitableFor,
      objections: objectionList(product.objections),
      variants: product.variants.map((variant) => ({
        code: variant.code,
        name: variant.name,
        available: variant.available,
        price: variant.price,
      })),
      related: product.related
        .filter((relation) => relation.related.status === "ACTIVE")
        .map((relation) => ({ id: relation.related.id, name: relation.related.name, note: relation.note })),
    })),
  };
}

/** The newest first, without repeats, MAX_FOCUS_PRODUCTS at most. */
export function mergeFocus(newest: string[], previous: string[]): string[] {
  return [...new Set([...newest, ...previous])].slice(0, MAX_FOCUS_PRODUCTS);
}

/** Remember what the conversation is about, for the next answers. */
export async function rememberFocus(conversationId: string, newest: string[], previous: string[]): Promise<string[]> {
  const focus = mergeFocus(newest, previous);
  if (focus.join() !== previous.join()) {
    await prisma.facebookConversation.update({ where: { id: conversationId }, data: { focusProductIds: focus } });
  }
  return focus;
}
