/**
 * Product cards from a spreadsheet, the server side: the template a brand
 * downloads, the preview of a filled file, and the confirmed import that
 * creates or updates cards by code. Pictures of a folder are matched in the
 * preview and then stored one by one (attachImportImage), each matched again
 * against the database: nothing a browser says about a match is trusted.
 *
 * Rows are data a person typed, so a confirmed row is applied directly: a new
 * card is ACTIVE (source IMPORT); an existing card (same code) keeps what the
 * file does not mention. The file replaces only the columns it has; colours
 * are upserted by code, and the pictures, the colours the Colours sheet does
 * not list and the related products stay. An import never archives or
 * restores a card, and a draft it updates becomes ACTIVE.
 */
import { createHash } from "node:crypto";
import { prisma } from "@/lib/db/client";
import type { FbStaticKey } from "@/lib/facebook/i18n";
import { listAttributes } from "../attributes";
import { codeKeyOf, normalizeCode } from "../codes";
import { PRODUCT_ERRORS } from "../errors";
import {
  getProductImageMaxBytes,
  MAX_IMAGES_PER_WORKSPACE,
  publicImagePath,
  storeProductImage,
} from "../images";
import {
  createProduct,
  getProduct,
  MAX_PRODUCTS,
  productInputSchema,
  updateProduct,
  type ProductDetail,
  type ProductInput,
} from "../products";
import {
  buildImportTemplate,
  IMPORT_SHEETS,
  importColumns,
  matchImageFiles,
  parseImport,
  type ImageMatch,
  type ImportAttribute,
  type ImportColumns,
  type ImportProblem,
  type ImportRow,
  type Sheet,
} from "./catalog";
import { readCsv, writeCsv } from "./csv";
import { readXlsx, SpreadsheetError, writeXlsx, type SpreadsheetErrorKind } from "./xlsx";

// ─── Limits and errors ──────────────────────────────────────────────────────

export const IMPORT_MAX_BYTES = 5 * 1024 * 1024;
/** The list of picture names a preview receives: names and sizes only, never the pictures. */
export const IMPORT_MAX_IMAGE_LIST_BYTES = 2 * 1024 * 1024;
export const IMPORT_MAX_IMAGE_NAMES = 10_000;
/** Room for the multipart boundaries and headers around the parts. */
export const MULTIPART_OVERHEAD = 64 * 1024;
/** Cards listed back in the result: the rest is only counted. */
const MAX_RESULT_PRODUCTS = 200;
const MAX_FAILURES = 200;

export const IMPORT_ERRORS = {
  no_file: { status: 400, message: "Choose a spreadsheet file (.xlsx or .csv)." },
  too_large: { status: 413, message: "The file is too large (5 MB at most)." },
  not_xlsx: { status: 400, message: "This is not a valid .xlsx or .csv file." },
  malformed: { status: 400, message: "The spreadsheet could not be read." },
  encrypted: { status: 400, message: "The workbook is protected by a password." },
  too_many_rows: { status: 400, message: "The file has too many rows." },
  invalid_images: { status: 400, message: "The list of pictures is not valid." },
} as const satisfies Record<string, { status: number; message: FbStaticKey }>;

export type ImportErrorCode = keyof typeof IMPORT_ERRORS;

const SPREADSHEET_ERRORS: Record<SpreadsheetErrorKind, ImportErrorCode> = {
  too_large: "too_large",
  not_xlsx: "not_xlsx",
  malformed: "malformed",
  encrypted: "encrypted",
  too_many_rows: "too_many_rows",
};

export const IMAGE_ERRORS = {
  no_file: { status: 400, message: "Send the image as the multipart field \"file\"." },
  empty: { status: 400, message: "The file is empty." },
  too_large: { status: 413, message: "The image is too large." },
  not_an_image: { status: 400, message: "Only JPEG, PNG and WebP images are accepted." },
  unknown_product: { status: 404, message: "Product not found." },
  too_many: { status: 400, message: "This brand has reached the number of images it can hold." },
  unmatched: { status: 422, message: "This picture matches no product or colour code." },
} as const satisfies Record<string, { status: number; message: FbStaticKey }>;

export type ImageErrorCode = keyof typeof IMAGE_ERRORS;

// ─── Reading a request ──────────────────────────────────────────────────────

/** The body, `max` bytes at most: null beyond, without reading the rest. */
export async function readCappedBody(request: Request, max: number): Promise<Uint8Array | null> {
  if (Number(request.headers.get("content-length") ?? 0) > max) return null;
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** A multipart body within `max` bytes: "too_large" beyond, "invalid" when it is not multipart. */
export async function readMultipart(request: Request, max: number): Promise<FormData | "too_large" | "invalid"> {
  const body = await readCappedBody(request, max);
  if (!body) return "too_large";
  const form = await new Response(body as Uint8Array<ArrayBuffer>, {
    headers: { "Content-Type": request.headers.get("content-type") ?? "" },
  })
    .formData()
    .catch(() => null);
  return form ?? "invalid";
}

/** The spreadsheet as sheets: an .xlsx by its bytes, anything else as CSV. */
export function readImportFile(bytes: Uint8Array, fileName: string): Sheet[] {
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  const isOle = bytes[0] === 0xd0 && bytes[1] === 0xcf;
  if (isZip || isOle || /\.xlsx?$/i.test(fileName)) return readXlsx(bytes, { maxBytes: IMPORT_MAX_BYTES });
  return [{ name: IMPORT_SHEETS.products, rows: readCsv(bytes, { maxBytes: IMPORT_MAX_BYTES }) }];
}

/** The code of the error to answer with, or null when the failure is not a spreadsheet one. */
export function importErrorCode(error: unknown): ImportErrorCode | null {
  return error instanceof SpreadsheetError ? SPREADSHEET_ERRORS[error.kind] : null;
}

/**
 * The spreadsheet (and, for a preview, the list of picture names) of a
 * multipart request, or the error to answer with.
 */
export async function readImportRequest(
  request: Request,
  withPictures: boolean
): Promise<{ sheets: Sheet[]; pictures: PictureFile[] } | { error: ImportErrorCode }> {
  const form = await readMultipart(
    request,
    IMPORT_MAX_BYTES + MULTIPART_OVERHEAD + (withPictures ? IMPORT_MAX_IMAGE_LIST_BYTES : 0)
  );
  if (form === "too_large") return { error: "too_large" };
  if (form === "invalid") return { error: "no_file" };
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "no_file" };
  if (file.size > IMPORT_MAX_BYTES) return { error: "too_large" };
  const pictures = withPictures ? readPictureList(form.get("images")) : [];
  if (!pictures) return { error: "invalid_images" };
  try {
    return { sheets: readImportFile(new Uint8Array(await file.arrayBuffer()), file.name), pictures };
  } catch (error) {
    const code = importErrorCode(error);
    if (code) return { error: code };
    throw error;
  }
}

// ─── The template ───────────────────────────────────────────────────────────

function toImportAttribute(attribute: {
  key: string;
  label: string;
  type: ImportAttribute["type"];
  unit: string | null;
  options: string[];
}): ImportAttribute {
  return { key: attribute.key, label: attribute.label, type: attribute.type, unit: attribute.unit, options: attribute.options };
}

async function importAttributes(workspaceId: string): Promise<ImportAttribute[]> {
  return (await listAttributes(workspaceId)).map(toImportAttribute);
}

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * The file a brand downloads, made for its own attributes. CSV has one sheet
 * only, so it carries the Products sheet: colours need the .xlsx.
 */
export async function buildBrandTemplate(
  workspaceId: string,
  format: "xlsx" | "csv"
): Promise<{ bytes: Buffer; fileName: string; contentType: string }> {
  const sheets = buildImportTemplate(await importAttributes(workspaceId));
  if (format === "csv") {
    return {
      bytes: writeCsv(sheets[0].rows),
      fileName: "openreply-products-template.csv",
      contentType: "text/csv; charset=utf-8",
    };
  }
  return { bytes: writeXlsx(sheets), fileName: "openreply-products-template.xlsx", contentType: XLSX_MIME };
}

// ─── Updating a card ────────────────────────────────────────────────────────

/** A card as the form would send it back, unchanged. */
function inputOf(card: ProductDetail): ProductInput {
  return {
    name: card.name,
    code: card.code,
    price: card.price,
    available: card.available,
    status: card.status,
    landingUrl: card.landingUrl,
    description: card.description,
    howToUse: card.howToUse,
    attributes: { ...card.attributes },
    strengths: [...card.strengths],
    comparisons: card.comparisons,
    suitableFor: card.suitableFor,
    objections: card.objections.map(({ question, answer }) => ({ question, answer })),
    variants: card.variants.map((variant) => ({
      code: variant.code,
      name: variant.name,
      available: variant.available,
      price: variant.price,
      imageId: variant.image?.id ?? null,
    })),
    related: card.related.map(({ productId, note }) => ({ productId, note })),
    mainImageId: card.mainImage?.id ?? null,
  };
}

/**
 * The card an update leaves: the existing one with the file laid over it.
 * An existing column replaces its field, an empty cell included (the person
 * cleared it); a column the file lacks leaves the field alone. Colours are
 * matched by code and keep their picture and place; colours the file does not
 * list stay, new ones come last; an empty name or price cell keeps the
 * colour's. The main picture and the related products are never touched.
 */
export function mergeUpdate(existing: ProductDetail, fromFile: ProductInput, present: ImportColumns): ProductInput {
  const merged = inputOf(existing);
  merged.name = fromFile.name;
  merged.code = fromFile.code ?? merged.code;
  if (present.fields.has("price")) merged.price = fromFile.price;
  if (present.fields.has("available")) merged.available = fromFile.available;
  if (present.fields.has("landingUrl")) merged.landingUrl = fromFile.landingUrl;
  if (present.fields.has("description")) merged.description = fromFile.description;
  if (present.fields.has("howToUse")) merged.howToUse = fromFile.howToUse;
  if (present.fields.has("strengths")) merged.strengths = fromFile.strengths;
  if (present.fields.has("comparisons")) merged.comparisons = fromFile.comparisons;
  if (present.fields.has("suitableFor")) merged.suitableFor = fromFile.suitableFor;
  if (present.fields.has("objections")) merged.objections = fromFile.objections;

  for (const key of present.attributes) {
    delete merged.attributes[key];
    if (Object.hasOwn(fromFile.attributes, key)) merged.attributes[key] = fromFile.attributes[key];
  }

  const places = new Map(merged.variants.map((variant, index) => [normalizeCode(variant.code), index]));
  for (const colour of fromFile.variants) {
    const index = places.get(normalizeCode(colour.code));
    if (index === undefined) {
      places.set(normalizeCode(colour.code), merged.variants.length);
      merged.variants.push({ ...colour, imageId: null });
      continue;
    }
    const current = merged.variants[index];
    merged.variants[index] = {
      code: colour.code,
      name: colour.name ?? current.name,
      available: colour.available,
      price: colour.price ?? current.price,
      imageId: current.imageId,
    };
  }

  // An import is a person's decision: a draft becomes live, nothing else changes state.
  merged.status = existing.status === "DRAFT" ? "ACTIVE" : existing.status;
  return merged;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

// ─── Reading the file against the brand ─────────────────────────────────────

interface Analysis {
  attributes: ImportAttribute[];
  rows: ImportRow[];
  problems: ImportProblem[];
  /** The brand's codes (normalized) and their products. */
  existing: Map<string, string>;
}

async function analyse(workspaceId: string, sheets: Sheet[]): Promise<Analysis> {
  const [attributes, products] = await Promise.all([
    importAttributes(workspaceId),
    prisma.product.findMany({
      where: { workspaceId, codeKey: { not: null } },
      select: { id: true, codeKey: true },
      take: MAX_PRODUCTS + 100,
    }),
  ]);
  const existing = new Map<string, string>();
  for (const product of products) if (product.codeKey) existing.set(product.codeKey, product.id);
  return { attributes, existing, ...parseImport(sheets, attributes, existing) };
}

// ─── Preview ────────────────────────────────────────────────────────────────

export interface PictureFile {
  name: string;
  size: number;
}

export type PreviewRow = Omit<ImportRow, "input">;

export interface ImportPreview {
  summary: {
    total: number;
    create: number;
    update: number;
    error: number;
    /** Rows without a code: each import adds them again. */
    withoutCode: number;
    /** Products the brand holds now, and the most it can hold. */
    products: number;
    productLimit: number;
    /** The new cards do not all fit. */
    overLimit: boolean;
  };
  rows: PreviewRow[];
  problems: ImportProblem[];
  pictures: {
    matched: ImageMatch[];
    unmatched: { fileName: string; reason: string }[];
    /** How many more pictures the brand can store. */
    room: number;
  };
}

/** Names and sizes from the browser: whatever else it sent is dropped. */
export function readPictureList(raw: unknown): PictureFile[] | null {
  if (raw === null || raw === undefined || raw === "") return [];
  if (typeof raw !== "string" || raw.length > IMPORT_MAX_IMAGE_LIST_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length > IMPORT_MAX_IMAGE_NAMES) return null;
  const files: PictureFile[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") return null;
    const { name, size } = item as { name?: unknown; size?: unknown };
    if (typeof name !== "string") return null;
    files.push({ name: name.slice(0, 300), size: typeof size === "number" && Number.isFinite(size) ? size : 0 });
  }
  return files;
}

/**
 * What a confirmed import would do, row by row, and where each picture of the
 * folder would go. Pictures are matched with the codes the brand will have
 * after the import: its products and colours, and the file's valid rows.
 */
export async function previewImport(workspaceId: string, sheets: Sheet[], pictures: PictureFile[]): Promise<ImportPreview> {
  const analysis = await analyse(workspaceId, sheets);
  const { rows, problems } = analysis;
  const creates = rows.filter((row) => row.action === "create").length;
  const [count, imageCount] = await Promise.all([
    prisma.product.count({ where: { workspaceId } }),
    prisma.productImage.count({ where: { workspaceId } }),
  ]);

  const catalog = new Map<string, { code: string; variantCodes: Map<string, string> }>();
  const owner = (code: string) => {
    const key = codeKeyOf(code);
    if (!key) return null;
    let entry = catalog.get(key);
    if (!entry) {
      entry = { code, variantCodes: new Map() };
      catalog.set(key, entry);
    }
    return entry;
  };
  if (pictures.length) {
    const products = await prisma.product.findMany({
      where: { workspaceId, codeKey: { not: null } },
      select: { code: true, variants: { where: { workspaceId }, select: { code: true } } },
      take: MAX_PRODUCTS + 100,
    });
    for (const product of products) {
      const entry = product.code ? owner(product.code) : null;
      for (const variant of product.variants) entry?.variantCodes.set(normalizeCode(variant.code), variant.code);
    }
    for (const row of rows) {
      if (!row.input?.code) continue;
      const entry = owner(row.input.code);
      for (const variant of row.input.variants) entry?.variantCodes.set(normalizeCode(variant.code), variant.code);
    }
  }

  const maxBytes = getProductImageMaxBytes();
  const unmatched: { fileName: string; reason: string }[] = [];
  const candidates: string[] = [];
  for (const file of pictures) {
    if (file.size > maxBytes) unmatched.push({ fileName: file.name, reason: "too large" });
    else candidates.push(file.name);
  }
  const found = matchImageFiles(
    candidates,
    [...catalog.values()].map((entry) => ({ code: entry.code, variantCodes: [...entry.variantCodes.values()] }))
  );
  const room = Math.max(0, MAX_IMAGES_PER_WORKSPACE - imageCount);
  unmatched.push(...found.unmatched);
  for (const match of found.matched.slice(room)) unmatched.push({ fileName: match.fileName, reason: "no room left for more pictures" });

  return {
    summary: {
      total: rows.length,
      create: creates,
      update: rows.filter((row) => row.action === "update").length,
      error: rows.filter((row) => row.action === "error").length,
      withoutCode: rows.filter((row) => row.action !== "error" && !row.code).length,
      products: count,
      productLimit: MAX_PRODUCTS,
      overLimit: count + creates > MAX_PRODUCTS,
    },
    rows: rows.map((row) => ({ sheet: row.sheet, row: row.row, code: row.code, name: row.name, action: row.action, errors: row.errors })),
    problems: problems.slice(0, 200),
    pictures: { matched: found.matched.slice(0, room), unmatched, room },
  };
}

// ─── Confirm ────────────────────────────────────────────────────────────────

export interface AppliedProduct {
  id: string;
  code: string | null;
  name: string;
  action: "created" | "updated";
}

export interface FailedRow {
  sheet: string;
  row: number;
  code: string | null;
  name: string | null;
  /** An English sentence of the catalog: the screen translates it. */
  message: string;
}

export interface ImportOutcome {
  created: number;
  updated: number;
  /** Rows whose card already was what the file says. */
  unchanged: number;
  /** Rows the preview showed as errors: never written. */
  refused: number;
  failed: FailedRow[];
  products: AppliedProduct[];
  moreProducts: number;
}

/**
 * The confirmed import. The file is read and checked again here, so the
 * result never depends on what the browser showed. Rows go one after the
 * other; a row that fails is listed and the rest go on.
 */
export async function applyImport(workspaceId: string, sheets: Sheet[]): Promise<ImportOutcome> {
  const { attributes, rows, existing } = await analyse(workspaceId, sheets);
  const outcome: ImportOutcome = { created: 0, updated: 0, unchanged: 0, refused: 0, failed: [], products: [], moreProducts: 0 };
  const present = importColumns(sheets, attributes);
  let full = false;

  const fail = (row: ImportRow, message: string) => {
    if (outcome.failed.length < MAX_FAILURES) {
      outcome.failed.push({ sheet: row.sheet, row: row.row, code: row.code, name: row.name, message });
    }
  };
  const done = (product: AppliedProduct) => {
    if (outcome.products.length < MAX_RESULT_PRODUCTS) outcome.products.push(product);
    else outcome.moreProducts++;
  };

  for (const row of rows) {
    if (row.action === "error" || !row.input) {
      outcome.refused++;
      continue;
    }
    const key = codeKeyOf(row.input.code);
    const id = key ? existing.get(key) : undefined;
    const card = id ? await getProduct(workspaceId, id) : null;

    if (id && card) {
      const merged = productInputSchema.safeParse(mergeUpdate(card, row.input, present));
      if (!merged.success) {
        fail(row, merged.error.issues[0]?.message ?? "The card is not valid.");
        continue;
      }
      const before = productInputSchema.safeParse(inputOf(card));
      // Nothing to write: a second import of the same file leaves the card as it is.
      if (before.success && stable(before.data) === stable(merged.data)) {
        outcome.unchanged++;
        continue;
      }
      const result = await updateProduct(workspaceId, id, merged.data);
      if (!result.ok) {
        fail(row, PRODUCT_ERRORS[result.error].message);
        continue;
      }
      outcome.updated++;
      done({ id, code: result.product.code, name: result.product.name, action: "updated" });
      continue;
    }

    if (full) {
      fail(row, PRODUCT_ERRORS.too_many.message);
      continue;
    }
    // The file's cards are a person's words: live at once, unlike the drafts other sources make.
    const result = await createProduct(workspaceId, { ...row.input, status: "ACTIVE" }, { source: "IMPORT" });
    if (!result.ok) {
      if (result.error === "too_many") full = true;
      fail(row, PRODUCT_ERRORS[result.error].message);
      continue;
    }
    outcome.created++;
    done({ id: result.product.id, code: result.product.code, name: result.product.name, action: "created" });
  }
  return outcome;
}

// ─── Pictures ───────────────────────────────────────────────────────────────

/** "WP-12_12-04.jpg" → the keys a product or a colour of that name could have. */
function candidateKeys(fileName: string): string[] {
  const base = fileName.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  const stem = (dot > 0 ? base.slice(0, dot) : base).trim().slice(0, 255);
  const keys = new Set([normalizeCode(stem)]);
  for (let i = 1; i < stem.length - 1; i++) {
    if (!/[_\s\-.+]/.test(stem[i])) continue;
    keys.add(normalizeCode(stem.slice(0, i)));
    keys.add(normalizeCode(stem.slice(i + 1)));
  }
  keys.delete("");
  return [...keys];
}

export interface AttachedImage {
  image: { id: string; publicId: string; path: string; mimeType: string; size: number; fileName: string | null };
  target: { productId: string; productCode: string; variantCode: string | null };
  /** The same picture was already on the card: nothing was stored. */
  reused: boolean;
}

/**
 * One picture of the folder: matched again by its name against the brand's
 * cards, stored on the card, and made its main picture, or its colour's. The
 * same file twice is stored once.
 */
export async function attachImportImage(
  workspaceId: string,
  file: { bytes: Buffer; fileName: string }
): Promise<{ ok: true; attached: AttachedImage } | { ok: false; error: ImageErrorCode }> {
  const keys = candidateKeys(file.fileName);
  if (keys.length === 0) return { ok: false, error: "unmatched" };
  const products = await prisma.product.findMany({
    where: {
      workspaceId,
      OR: [{ codeKey: { in: keys } }, { variants: { some: { workspaceId, codeKey: { in: keys } } } }],
    },
    select: {
      id: true,
      code: true,
      codeKey: true,
      mainImageId: true,
      variants: { where: { workspaceId }, select: { id: true, code: true, codeKey: true, imageId: true } },
    },
    take: 50,
  });
  const { matched } = matchImageFiles(
    [file.fileName],
    products.map((product) => ({ code: product.code ?? "", variantCodes: product.variants.map((variant) => variant.code) }))
  );
  const match = matched[0];
  const product = match ? products.find((candidate) => candidate.codeKey === normalizeCode(match.productCode)) : undefined;
  if (!match || !product) return { ok: false, error: "unmatched" };
  const variant = match.variantCode
    ? product.variants.find((candidate) => candidate.codeKey === normalizeCode(match.variantCode ?? ""))
    : null;
  if (match.variantCode && !variant) return { ok: false, error: "unmatched" };

  const sha256 = createHash("sha256").update(file.bytes).digest("hex");
  const known = await prisma.productImage.findFirst({
    where: { workspaceId, productId: product.id, sha256 },
    select: { id: true, publicId: true, mimeType: true, size: true, fileName: true },
  });
  let image: AttachedImage["image"];
  if (known) {
    image = { ...known, path: publicImagePath(known.publicId) };
  } else {
    const stored = await storeProductImage(workspaceId, { bytes: file.bytes, fileName: file.fileName, productId: product.id });
    if (!stored.ok) return { ok: false, error: stored.error };
    image = stored.image;
  }

  if (variant) {
    if (variant.imageId !== image.id) {
      await prisma.productVariant.updateMany({
        where: { id: variant.id, productId: product.id, workspaceId },
        data: { imageId: image.id },
      });
    }
  } else if (product.mainImageId !== image.id) {
    await prisma.product.updateMany({ where: { id: product.id, workspaceId }, data: { mainImageId: image.id } });
  }
  return {
    ok: true,
    attached: {
      image,
      target: { productId: product.id, productCode: match.productCode, variantCode: match.variantCode },
      reused: known !== null,
    },
  };
}
