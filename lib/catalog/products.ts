/**
 * Product cards: a brand's catalog, which the bot answers from.
 *
 * A card is saved as a whole (the form sends every field). Its colours or
 * types are matched by code across saves, so a colour keeps its id, and
 * whatever points at it, while its relations to other products are replaced.
 * Codes are unique in the brand once normalized (./codes): that is how the bot
 * and the photo recognition find a product.
 *
 * Images are uploaded first (./images) and attached to the card that uses
 * them. Every query is scoped to the brand: an id from another brand is
 * simply not found, and a card can only point at the brand's own images and
 * products.
 */
import { z } from "zod";
import { Prisma, type ProductSource, type ProductStatus } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { cleanAttributeValues, listAttributes, type AttributeValue, type TemplateAttribute } from "./attributes";
import { codeKeyOf, MAX_CODE_LENGTH, normalizeCode } from "./codes";
import { publicImagePath } from "./images";

export const MAX_PRODUCTS = 2000;
export const MAX_VARIANTS = 60;
export const MAX_RELATED = 20;
export const MAX_STRENGTHS = 20;
export const MAX_OBJECTIONS = 30;
export const PRODUCT_STATUSES = ["ACTIVE", "DRAFT", "ARCHIVED"] as const satisfies readonly ProductStatus[];

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const MAX_SEARCH_LENGTH = 200;
const MAX_ID_LENGTH = 100;

// ─── Input ──────────────────────────────────────────────────────────────────

const text = (max: number) => z.string().trim().max(max);
/** Trimmed, and an empty text means none. */
const optionalText = (max: number) =>
  text(max)
    .nullable()
    .default(null)
    .transform((value) => value || null);

/** "---" is not a code: a code needs something left once normalized. */
function hasCodeKey(code: string): boolean {
  return codeKeyOf(code) !== null;
}

/**
 * http and https only, with a host, and nothing that could hide in it
 * (spaces, control characters). A javascript: or data: link would run in
 * the browser of whoever opens it from the card or from the bot's button.
 */
function isWebLink(value: string): boolean {
  if (!/^https?:\/\/[^\s\p{Cc}]+$/iu.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "";
  } catch {
    return false;
  }
}

/** The index of the first variant whose code repeats an earlier one once normalized, or -1. */
function repeatedVariantIndex(variants: readonly { code: string }[]): number {
  const seen = new Set<string>();
  return variants.findIndex(({ code }) => {
    const key = normalizeCode(code);
    if (seen.has(key)) return true;
    seen.add(key);
    return false;
  });
}

const variantSchema = z.object({
  code: text(MAX_CODE_LENGTH)
    .min(1, "Give each colour or type its code.")
    .refine(hasCodeKey, "A code needs a letter or a digit."),
  name: optionalText(80),
  available: z.boolean().default(true),
  price: optionalText(100),
  imageId: optionalText(MAX_ID_LENGTH),
});

export const productInputSchema = z.object({
  name: text(200).min(1, "Give the product a name."),
  code: optionalText(MAX_CODE_LENGTH).refine((code) => code === null || hasCodeKey(code), "A code needs a letter or a digit."),
  price: optionalText(100),
  available: z.boolean().default(true),
  status: z.enum(PRODUCT_STATUSES).default("ACTIVE"),
  landingUrl: optionalText(2000).refine((url) => url === null || isWebLink(url), "Use an http or https link."),
  description: optionalText(4000),
  howToUse: optionalText(4000),
  /** Checked against the brand's template when the card is saved. */
  attributes: z.record(z.string(), z.unknown()).default({}),
  strengths: z.array(text(300).min(1, "A strength can't be empty.")).max(MAX_STRENGTHS).default([]),
  comparisons: optionalText(4000),
  suitableFor: optionalText(2000),
  objections: z
    .array(
      z.object({
        question: text(300).min(1, "Write the question or worry."),
        answer: text(1000).min(1, "Write the answer."),
      })
    )
    .max(MAX_OBJECTIONS)
    .default([]),
  variants: z
    .array(variantSchema)
    .max(MAX_VARIANTS)
    .superRefine((variants, ctx) => {
      const index = repeatedVariantIndex(variants);
      if (index >= 0) {
        ctx.addIssue({ code: "custom", path: [index, "code"], message: `The code ${variants[index].code} is used twice.` });
      }
    })
    .default([]),
  related: z
    .array(z.object({ productId: z.string().trim().min(1).max(MAX_ID_LENGTH), note: optionalText(100) }))
    .max(MAX_RELATED)
    .default([]),
  mainImageId: optionalText(MAX_ID_LENGTH),
});

/** A card as productInputSchema outputs it. */
export type ProductInput = z.infer<typeof productInputSchema>;

// ─── Views ──────────────────────────────────────────────────────────────────

export interface ImageRef {
  id: string;
  publicId: string;
  /** The public URL path: Messenger fetches the images it sends. */
  path: string;
  mimeType: string;
  size: number;
  fileName: string | null;
}

export interface ProductSummary {
  id: string;
  name: string;
  code: string | null;
  price: string | null;
  available: boolean;
  status: ProductStatus;
  source: ProductSource;
  /** The main image, or else the first one of the card. */
  image: ImageRef | null;
  variantCount: number;
  updatedAt: string;
}

export interface ProductVariantView {
  id: string;
  code: string;
  name: string | null;
  available: boolean;
  price: string | null;
  image: ImageRef | null;
  sortOrder: number;
}

export interface ProductRelationView {
  productId: string;
  name: string;
  code: string | null;
  note: string | null;
}

export interface ProductDetail {
  id: string;
  status: ProductStatus;
  source: ProductSource;
  sourceRef: string | null;
  name: string;
  code: string | null;
  price: string | null;
  available: boolean;
  landingUrl: string | null;
  description: string | null;
  howToUse: string | null;
  /** Only the values the current template allows. */
  attributes: Record<string, AttributeValue>;
  strengths: string[];
  comparisons: string | null;
  suitableFor: string | null;
  objections: { question: string; answer: string }[];
  mainImage: ImageRef | null;
  /** Every image attached to the card, the main one and the colours' included. */
  images: ImageRef[];
  variants: ProductVariantView[];
  related: ProductRelationView[];
  createdAt: string;
  updatedAt: string;
}

export type ProductError =
  | "not_found"
  | "too_many"
  | "duplicate_code"
  | "invalid_attributes"
  | "unknown_image"
  | "unknown_related";

export type ProductResult = { ok: true; product: ProductDetail } | { ok: false; error: ProductError; detail?: string };

type Failure = Extract<ProductResult, { ok: false }>;

export interface ProductQuery {
  /** The name (any case), or the code however it is written. */
  search?: string | null;
  status?: ProductStatus | null;
  /** In stock or not; null or left out for both. */
  available?: boolean | null;
  take?: number;
  /** nextCursor of the previous page. */
  cursor?: string | null;
}

export interface CodeMatch {
  productId: string;
  name: string;
  variant: { id: string; code: string; name: string | null } | null;
}

// ─── Reading ────────────────────────────────────────────────────────────────

// Never the bytes: they are only read by the public media route.
const IMAGE_SELECT = {
  id: true,
  publicId: true,
  mimeType: true,
  size: true,
  fileName: true,
} satisfies Prisma.ProductImageSelect;

type ImageRow = Prisma.ProductImageGetPayload<{ select: typeof IMAGE_SELECT }>;

function imageRef(image: ImageRow): ImageRef {
  return {
    id: image.id,
    publicId: image.publicId,
    path: publicImagePath(image.publicId),
    mimeType: image.mimeType,
    size: image.size,
    fileName: image.fileName,
  };
}

function optionalImageRef(image: ImageRow | null | undefined): ImageRef | null {
  return image ? imageRef(image) : null;
}

function summarySelect(workspaceId: string) {
  return {
    id: true,
    name: true,
    code: true,
    price: true,
    available: true,
    status: true,
    source: true,
    updatedAt: true,
    mainImage: { select: IMAGE_SELECT },
    images: { where: { workspaceId }, select: IMAGE_SELECT, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 1 },
    _count: { select: { variants: { where: { workspaceId } } } },
  } satisfies Prisma.ProductSelect;
}

type SummaryRow = Prisma.ProductGetPayload<{ select: ReturnType<typeof summarySelect> }>;

function toSummary(row: SummaryRow): ProductSummary {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    price: row.price,
    available: row.available,
    status: row.status,
    source: row.source,
    image: optionalImageRef(row.mainImage ?? row.images[0]),
    variantCount: row._count.variants,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function detailInclude(workspaceId: string) {
  return {
    mainImage: { select: IMAGE_SELECT },
    images: { where: { workspaceId }, select: IMAGE_SELECT, orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
    variants: {
      where: { workspaceId },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      include: { image: { select: IMAGE_SELECT } },
    },
    related: {
      where: { workspaceId, related: { workspaceId } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { note: true, related: { select: { id: true, name: true, code: true } } },
    },
  } satisfies Prisma.ProductInclude;
}

type DetailRow = Prisma.ProductGetPayload<{ include: ReturnType<typeof detailInclude> }>;

function readObjections(value: Prisma.JsonValue): { question: string; answer: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const { question, answer } = item;
    return typeof question === "string" && typeof answer === "string" ? [{ question, answer }] : [];
  });
}

function toDetail(row: DetailRow, template: TemplateAttribute[]): ProductDetail {
  return {
    id: row.id,
    status: row.status,
    source: row.source,
    sourceRef: row.sourceRef,
    name: row.name,
    code: row.code,
    price: row.price,
    available: row.available,
    landingUrl: row.landingUrl,
    description: row.description,
    howToUse: row.howToUse,
    // A deleted attribute's values, or values that no longer fit its type,
    // are left in the JSON but never shown.
    attributes: cleanAttributeValues(template, row.attributes).values,
    strengths: row.strengths,
    comparisons: row.comparisons,
    suitableFor: row.suitableFor,
    objections: readObjections(row.objections),
    mainImage: optionalImageRef(row.mainImage),
    images: row.images.map(imageRef),
    variants: row.variants.map((variant) => ({
      id: variant.id,
      code: variant.code,
      name: variant.name,
      available: variant.available,
      price: variant.price,
      image: optionalImageRef(variant.image),
      sortOrder: variant.sortOrder,
    })),
    related: row.related.map((relation) => ({
      productId: relation.related.id,
      name: relation.related.name,
      code: relation.related.code,
      note: relation.note,
    })),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Keyset pagination: the cursor is the position after a page's last row
 * (updatedAt, id), not an id to look up, so it never touches another brand's
 * rows and survives the row being edited or deleted meanwhile.
 */
function encodeCursor(row: { updatedAt: Date; id: string }): string {
  return Buffer.from(`${row.updatedAt.toISOString()} ${row.id}`).toString("base64url");
}

function decodeCursor(cursor: string): { updatedAt: Date; id: string } | null {
  const [iso = "", id, ...rest] = Buffer.from(cursor, "base64url").toString("utf8").split(" ");
  const updatedAt = new Date(iso);
  return id && rest.length === 0 && !Number.isNaN(updatedAt.getTime()) ? { updatedAt, id } : null;
}

function pageSize(take: number | undefined): number {
  if (take === undefined || !Number.isFinite(take)) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.max(Math.trunc(take), 1), MAX_PAGE_SIZE);
}

/** Newest first. A search matches the name, or the code however it is written ("wp 12" finds "WP-12"). */
export async function listProducts(
  workspaceId: string,
  query: ProductQuery = {}
): Promise<{ products: ProductSummary[]; nextCursor: string | null }> {
  const take = pageSize(query.take);
  const and: Prisma.ProductWhereInput[] = [];
  const search = query.search?.trim().slice(0, MAX_SEARCH_LENGTH);
  if (search) {
    const key = normalizeCode(search);
    and.push({
      OR: [{ name: { contains: search, mode: "insensitive" } }, ...(key ? [{ codeKey: { contains: key } }] : [])],
    });
  }
  if (query.cursor) {
    const after = decodeCursor(query.cursor);
    if (!after) return { products: [], nextCursor: null };
    and.push({ OR: [{ updatedAt: { lt: after.updatedAt } }, { updatedAt: after.updatedAt, id: { lt: after.id } }] });
  }
  const rows = await prisma.product.findMany({
    where: {
      workspaceId,
      ...(query.status ? { status: query.status } : {}),
      ...(typeof query.available === "boolean" ? { available: query.available } : {}),
      ...(and.length ? { AND: and } : {}),
    },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: take + 1,
    select: summarySelect(workspaceId),
  });
  const page = rows.slice(0, take);
  const last = page.at(-1);
  return { products: page.map(toSummary), nextCursor: rows.length > take && last ? encodeCursor(last) : null };
}

export async function getProduct(workspaceId: string, id: string): Promise<ProductDetail | null> {
  const [template, detail] = await Promise.all([
    listAttributes(workspaceId),
    prisma.product.findFirst({ where: { id, workspaceId }, include: detailInclude(workspaceId) }),
  ]);
  return detail ? toDetail(detail, template) : null;
}

/**
 * The ACTIVE products a code points at: by the product's own code, or by one
 * of its colours' (then with that colour). Each product appears once, with the
 * colour when a colour matched. The code may be given as written or as a key.
 */
export async function findByCodeKey(workspaceId: string, codeKey: string): Promise<CodeMatch[]> {
  const key = normalizeCode(codeKey);
  if (!key) return [];
  const [products, variants] = await Promise.all([
    prisma.product.findMany({
      where: { workspaceId, status: "ACTIVE", codeKey: key },
      select: { id: true, name: true },
    }),
    prisma.productVariant.findMany({
      where: { workspaceId, codeKey: key, product: { workspaceId, status: "ACTIVE" } },
      orderBy: [{ product: { name: "asc" } }, { sortOrder: "asc" }],
      select: { id: true, code: true, name: true, product: { select: { id: true, name: true } } },
    }),
  ]);
  const byVariant = new Set(variants.map((variant) => variant.product.id));
  return [
    ...products
      .filter((product) => !byVariant.has(product.id))
      .map((product) => ({ productId: product.id, name: product.name, variant: null })),
    ...variants.map((variant) => ({
      productId: variant.product.id,
      name: variant.product.name,
      variant: { id: variant.id, code: variant.code, name: variant.name },
    })),
  ];
}

// ─── Writing ────────────────────────────────────────────────────────────────

function fail(error: ProductError, detail?: string | null): Failure {
  return detail ? { ok: false, error, detail } : { ok: false, error };
}

/** Thrown inside a transaction to roll it back and answer with a failure. */
class Abort extends Error {
  readonly failure: Failure;

  constructor(failure: Failure) {
    super(failure.error);
    this.failure = failure;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/** The card as saved, read in the same transaction. */
async function readDetail(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  id: string,
  template: TemplateAttribute[]
): Promise<ProductDetail> {
  const row = await tx.product.findFirst({ where: { id, workspaceId }, include: detailInclude(workspaceId) });
  if (!row) throw new Abort(fail("not_found"));
  return toDetail(row, template);
}

/**
 * Runs a card's checks and writes in one transaction. The checks come first,
 * so a failure usually writes nothing; one found after a write (a race)
 * throws Abort, and the transaction rolls the write back.
 */
async function inTransaction(
  code: string | null,
  work: (tx: Prisma.TransactionClient) => Promise<ProductDetail>
): Promise<ProductResult> {
  try {
    // Up to MAX_VARIANTS colour updates: more than the default 5 seconds may be needed.
    return { ok: true, product: await prisma.$transaction(work, { maxWait: 5_000, timeout: 20_000 }) };
  } catch (error) {
    if (error instanceof Abort) return error.failure;
    // Another save took the code between the check and the write: the
    // unique index (workspaceId, codeKey) refused this one.
    if (isUniqueViolation(error)) return fail("duplicate_code", code);
    throw error;
  }
}

/** The columns and rows a card becomes, and what is wrong with it before any lookup. */
function prepare(input: ProductInput, template: TemplateAttribute[]) {
  const attributes = cleanAttributeValues(template, input.attributes);
  const repeated = repeatedVariantIndex(input.variants);
  const codeKey = codeKeyOf(input.code);
  const variants = input.variants.map((variant, index) => ({
    code: variant.code,
    codeKey: normalizeCode(variant.code),
    name: variant.name || null,
    available: variant.available,
    price: variant.price || null,
    imageId: variant.imageId || null,
    sortOrder: index,
  }));
  // One relation per product: the first note wins.
  const related = new Map<string, string | null>();
  for (const { productId, note } of input.related) {
    if (!related.has(productId)) related.set(productId, note || null);
  }
  const imageIds = new Set<string>();
  for (const id of [input.mainImageId, ...variants.map((variant) => variant.imageId)]) {
    if (id) imageIds.add(id);
  }
  let failure: Failure | null = null;
  if (attributes.errors.length) failure = fail("invalid_attributes", attributes.errors[0].message);
  else if (repeated >= 0) failure = fail("duplicate_code", input.variants[repeated].code);
  return {
    failure,
    columns: {
      name: input.name,
      code: codeKey ? input.code : null,
      codeKey,
      price: input.price || null,
      available: input.available,
      status: input.status,
      landingUrl: input.landingUrl || null,
      description: input.description || null,
      howToUse: input.howToUse || null,
      attributes: attributes.values,
      strengths: input.strengths,
      comparisons: input.comparisons || null,
      suitableFor: input.suitableFor || null,
      objections: input.objections.map(({ question, answer }) => ({ question, answer })),
      mainImageId: input.mainImageId || null,
    },
    variants,
    related: [...related].map(([relatedId, note]) => ({ relatedId, note })),
    imageIds: [...imageIds],
  };
}

type Card = ReturnType<typeof prepare>;

/**
 * Everything a card points at must be the brand's: its code free in the brand,
 * its images either unattached or already this product's, its related
 * products other products of the brand. Returns the images to attach.
 */
async function checkCard(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  productId: string | null,
  card: Card
): Promise<string[]> {
  if (card.failure) throw new Abort(card.failure);

  const { code, codeKey } = card.columns;
  if (codeKey) {
    const holder = await tx.product.findFirst({
      where: { workspaceId, codeKey, ...(productId ? { id: { not: productId } } : {}) },
      select: { id: true },
    });
    if (holder) throw new Abort(fail("duplicate_code", code));
  }

  let toAttach: string[] = [];
  if (card.imageIds.length) {
    const images = await tx.productImage.findMany({
      where: {
        workspaceId,
        id: { in: card.imageIds },
        OR: [{ productId: null }, ...(productId ? [{ productId }] : [])],
      },
      select: { id: true, productId: true },
    });
    const usable = new Map(images.map((image) => [image.id, image.productId]));
    const unknown = card.imageIds.find((id) => !usable.has(id));
    if (unknown) throw new Abort(fail("unknown_image", unknown));
    toAttach = card.imageIds.filter((id) => usable.get(id) === null);
  }

  if (card.related.length) {
    const self = card.related.find((relation) => relation.relatedId === productId);
    if (self) throw new Abort(fail("unknown_related", self.relatedId));
    const products = await tx.product.findMany({
      where: { workspaceId, id: { in: card.related.map((relation) => relation.relatedId) } },
      select: { id: true },
    });
    const known = new Set(products.map((product) => product.id));
    const unknown = card.related.find((relation) => !known.has(relation.relatedId));
    if (unknown) throw new Abort(fail("unknown_related", unknown.relatedId));
  }

  return toAttach;
}

async function attachImages(tx: Prisma.TransactionClient, workspaceId: string, productId: string, ids: string[]) {
  if (ids.length === 0) return;
  const attached = await tx.productImage.updateMany({
    where: { workspaceId, id: { in: ids }, productId: null },
    data: { productId },
  });
  // Another card took one of them since the check.
  if (attached.count !== ids.length) throw new Abort(fail("unknown_image"));
}

const VARIANT_STATE = {
  id: true,
  code: true,
  codeKey: true,
  name: true,
  available: true,
  price: true,
  imageId: true,
  sortOrder: true,
} satisfies Prisma.ProductVariantSelect;

type VariantState = Prisma.ProductVariantGetPayload<{ select: typeof VARIANT_STATE }>;
type VariantRow = Card["variants"][number];

function variantChanged(current: VariantState, next: VariantRow): boolean {
  return (
    current.code !== next.code ||
    current.name !== next.name ||
    current.available !== next.available ||
    current.price !== next.price ||
    current.imageId !== next.imageId ||
    current.sortOrder !== next.sortOrder
  );
}

/**
 * Colours are matched by code: one still on the card is updated and keeps its
 * id, a new one is created, one no longer listed is deleted. The order is the
 * card's.
 */
async function writeVariants(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  productId: string,
  variants: VariantRow[],
  existing: VariantState[]
) {
  const wanted = new Set(variants.map((variant) => variant.codeKey));
  const gone = existing.filter((variant) => !wanted.has(variant.codeKey)).map((variant) => variant.id);
  if (gone.length) {
    await tx.productVariant.deleteMany({ where: { id: { in: gone }, productId, workspaceId } });
  }
  const byKey = new Map(existing.map((variant) => [variant.codeKey, variant]));
  const created: VariantRow[] = [];
  for (const variant of variants) {
    const current = byKey.get(variant.codeKey);
    if (!current) {
      created.push(variant);
    } else if (variantChanged(current, variant)) {
      const { code, name, available, price, imageId, sortOrder } = variant;
      await tx.productVariant.updateMany({
        where: { id: current.id, productId, workspaceId },
        data: { code, name, available, price, imageId, sortOrder },
      });
    }
  }
  if (created.length) {
    await tx.productVariant.createMany({ data: created.map((variant) => ({ workspaceId, productId, ...variant })) });
  }
}

async function createRelations(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  productId: string,
  related: Card["related"]
) {
  if (related.length === 0) return;
  await tx.productRelation.createMany({
    data: related.map(({ relatedId, note }) => ({ workspaceId, productId, relatedId, note })),
  });
}

/** `input` comes from productInputSchema. MANUAL unless the caller says where the card came from. */
export async function createProduct(
  workspaceId: string,
  input: ProductInput,
  options: { source?: ProductSource; sourceRef?: string | null } = {}
): Promise<ProductResult> {
  const template = await listAttributes(workspaceId);
  const card = prepare(input, template);
  return inTransaction(card.columns.code, async (tx) => {
    if ((await tx.product.count({ where: { workspaceId } })) >= MAX_PRODUCTS) throw new Abort(fail("too_many"));
    const toAttach = await checkCard(tx, workspaceId, null, card);
    const { id } = await tx.product.create({
      data: { workspaceId, source: options.source ?? "MANUAL", sourceRef: options.sourceRef || null, ...card.columns },
      select: { id: true },
    });
    await attachImages(tx, workspaceId, id, toAttach);
    await writeVariants(tx, workspaceId, id, card.variants, []);
    await createRelations(tx, workspaceId, id, card.related);
    return readDetail(tx, workspaceId, id, template);
  });
}

/** Replaces the card (status included); its source stays. */
export async function updateProduct(workspaceId: string, id: string, input: ProductInput): Promise<ProductResult> {
  const template = await listAttributes(workspaceId);
  const card = prepare(input, template);
  return inTransaction(card.columns.code, async (tx) => {
    const current = await tx.product.findFirst({
      where: { id, workspaceId },
      select: { id: true, variants: { where: { workspaceId }, select: VARIANT_STATE } },
    });
    if (!current) throw new Abort(fail("not_found"));
    const toAttach = await checkCard(tx, workspaceId, id, card);
    const updated = await tx.product.updateMany({ where: { id, workspaceId }, data: card.columns });
    if (updated.count !== 1) throw new Abort(fail("not_found"));
    await attachImages(tx, workspaceId, id, toAttach);
    await writeVariants(tx, workspaceId, id, card.variants, current.variants);
    await tx.productRelation.deleteMany({ where: { productId: id, workspaceId } });
    await createRelations(tx, workspaceId, id, card.related);
    return readDetail(tx, workspaceId, id, template);
  });
}

export async function setProductStatus(workspaceId: string, id: string, status: ProductStatus): Promise<boolean> {
  const updated = await prisma.product.updateMany({ where: { id, workspaceId }, data: { status } });
  return updated.count === 1;
}

/** Its colours, images and relations go with it (foreign keys cascade); campaigns keep running without it. */
export async function deleteProduct(workspaceId: string, id: string): Promise<boolean> {
  const deleted = await prisma.product.deleteMany({ where: { id, workspaceId } });
  return deleted.count === 1;
}

/**
 * A simple product of the knowledge base (phase 7) becomes a card: its title,
 * price and text, available as long as the entry was active. The entry goes
 * in the same transaction, so the bot never sees the product twice.
 */
export async function convertKnowledgeProduct(workspaceId: string, entryId: string): Promise<ProductResult> {
  return inTransaction(null, async (tx) => {
    const entry = await tx.knowledgeEntry.findFirst({ where: { id: entryId, workspaceId, kind: "PRODUCT" } });
    if (!entry) throw new Abort(fail("not_found"));
    if ((await tx.product.count({ where: { workspaceId } })) >= MAX_PRODUCTS) throw new Abort(fail("too_many"));
    const { id } = await tx.product.create({
      data: {
        workspaceId,
        name: entry.title.trim(),
        price: entry.price?.trim() || null,
        description: entry.content.trim() || null,
        available: entry.isActive,
      },
      select: { id: true },
    });
    const removed = await tx.knowledgeEntry.deleteMany({ where: { id: entry.id, workspaceId } });
    // Converted twice at the same moment: only the first card is kept.
    if (removed.count !== 1) throw new Abort(fail("not_found"));
    // A new card has no attribute values, so no template is needed to read it.
    return readDetail(tx, workspaceId, id, []);
  });
}
