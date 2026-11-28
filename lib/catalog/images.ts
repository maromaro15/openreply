/**
 * Product images, kept in Postgres (so the daily backup holds them) and
 * served without a session at /api/public/media/<publicId>, because
 * Messenger fetches the images the bot sends from their URL itself.
 *
 * The public id is all that URL reveals: random, not the row id, the brand
 * or the file name. The type is read from the bytes, never from the name or
 * the browser's claim, so the public route can only ever serve a JPEG, a
 * PNG or a WebP, and never HTML or SVG that would run on our origin.
 */
import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/db/client";
import { readIntEnv } from "@/lib/facebook/env";

export const PRODUCT_IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp"] as const;
export type ProductImageMime = (typeof PRODUCT_IMAGE_MIMES)[number];

/** Bounds what one brand can put in the database, and so in every backup. */
export const MAX_IMAGES_PER_WORKSPACE = 3000;

export const MAX_FILE_NAME_LENGTH = 120;

/**
 * PRODUCT_IMAGE_MAX_BYTES, 5 MiB by default, kept within [64 KiB, 15 MiB]:
 * each image is read whole into memory when it is uploaded and every time
 * it is served, and the daily backup grows with it.
 */
export function getProductImageMaxBytes(): number {
  return readIntEnv("PRODUCT_IMAGE_MAX_BYTES", 5 * 1024 * 1024, {
    min: 64 * 1024,
    max: 15 * 1024 * 1024,
  });
}

// ─── Type from the bytes ────────────────────────────────────────────────────

const JPEG = [0xff, 0xd8, 0xff];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const RIFF = [0x52, 0x49, 0x46, 0x46]; // "RIFF", then the 4-byte chunk size
const WEBP = [0x57, 0x45, 0x42, 0x50]; // "WEBP", at offset 8

function hasSignature(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

/** The type from the first bytes, or null for anything else (GIF, SVG, HTML, HEIC...). */
export function sniffImageMime(bytes: Uint8Array): ProductImageMime | null {
  if (hasSignature(bytes, JPEG)) return "image/jpeg";
  if (hasSignature(bytes, PNG)) return "image/png";
  if (hasSignature(bytes, RIFF) && hasSignature(bytes, WEBP, 8)) return "image/webp";
  return null;
}

// ─── Public id and URL ──────────────────────────────────────────────────────

// 24 random bytes are exactly 32 base64url characters (192 bits, no padding).
const PUBLIC_ID = /^[A-Za-z0-9_-]{32}$/;

export function isPublicId(value: string): boolean {
  return typeof value === "string" && PUBLIC_ID.test(value);
}

export function newPublicId(): string {
  return randomBytes(24).toString("base64url");
}

export function publicImagePath(publicId: string): string {
  return `/api/public/media/${publicId}`;
}

/** Absolute, for Messenger. A base URL with or without a trailing slash gives the same URL. */
export function publicImageUrl(baseUrl: string, publicId: string): string {
  return `${baseUrl.trim().replace(/\/+$/, "")}${publicImagePath(publicId)}`;
}

// ─── File name ──────────────────────────────────────────────────────────────

// C0 and C1 controls and DEL, plus the bidi embeddings, overrides and
// isolates, which can make a name read in a different order than it is.
const CONTROL_CHARS = /[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu;
// A short extension, kept when a long name is cut.
const EXTENSION = /\.[A-Za-z0-9]{1,10}$/;

/** At most `max` UTF-16 units, never half of a surrogate pair. */
function cut(text: string, max: number): string {
  let out = "";
  for (const char of text) {
    if (out.length + char.length > max) break;
    out += char;
  }
  return out;
}

/**
 * The name as the brand will see it. Only the base name: a folder upload or
 * an old browser can send "photos/WP-12.jpg" or "C:\photos\WP-12.jpg". It is
 * a label only: the type comes from the bytes and the URL from the public id.
 */
export function cleanFileName(name: string | null | undefined): string | null {
  if (typeof name !== "string") return null;
  const base = (name.split(/[/\\]/).pop() ?? "").replace(CONTROL_CHARS, "").trim();
  if (!base || base === "." || base === "..") return null;
  if (base.length <= MAX_FILE_NAME_LENGTH) return base;
  const extension = EXTENSION.exec(base)?.[0] ?? "";
  const stem = cut(base.slice(0, base.length - extension.length), MAX_FILE_NAME_LENGTH - extension.length);
  return stem.trimEnd() + extension;
}

// ─── Storage ────────────────────────────────────────────────────────────────

export type StoreImageError = "empty" | "too_large" | "not_an_image" | "unknown_product" | "too_many";

export type StoredImage = {
  id: string;
  publicId: string;
  path: string;
  mimeType: ProductImageMime;
  size: number;
  fileName: string | null;
};

/**
 * Store an uploaded image for the brand, optionally on one of its products.
 * Checked in this order, the ones without a query first: empty, too large,
 * not an image, a product that is not the brand's, the brand's limit.
 */
export async function storeProductImage(
  workspaceId: string,
  file: { bytes: Buffer; fileName?: string | null; productId?: string | null }
): Promise<{ ok: true; image: StoredImage } | { ok: false; error: StoreImageError }> {
  const { bytes } = file;
  if (bytes.length === 0) return { ok: false, error: "empty" };
  if (bytes.length > getProductImageMaxBytes()) return { ok: false, error: "too_large" };
  const mimeType = sniffImageMime(bytes);
  if (!mimeType) return { ok: false, error: "not_an_image" };

  // An empty id (a form's "no product") is no product. Another brand's
  // product is simply not found, so its id cannot be used to attach.
  const productId = file.productId || null;
  if (productId) {
    const product = await prisma.product.findFirst({ where: { id: productId, workspaceId }, select: { id: true } });
    if (!product) return { ok: false, error: "unknown_product" };
  }
  // Counted before the insert, like the other limits: two uploads at the
  // same moment can both pass it, which is fine for a cap this size.
  if ((await prisma.productImage.count({ where: { workspaceId } })) >= MAX_IMAGES_PER_WORKSPACE) {
    return { ok: false, error: "too_many" };
  }

  const image = await prisma.productImage.create({
    data: {
      workspaceId,
      productId,
      publicId: newPublicId(),
      mimeType,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      // Prisma types Bytes as a Uint8Array over an ArrayBuffer, which an
      // uploaded file's Buffer is; casting it spares copying the image.
      data: bytes as Uint8Array<ArrayBuffer>,
      fileName: cleanFileName(file.fileName),
    },
    // Without the bytes, which would otherwise come straight back.
    select: { id: true, publicId: true, size: true, fileName: true },
  });
  return {
    ok: true,
    image: {
      id: image.id,
      publicId: image.publicId,
      path: publicImagePath(image.publicId),
      mimeType,
      size: image.size,
      fileName: image.fileName,
    },
  };
}

/**
 * Only within the brand: another brand's image is simply not found. The
 * foreign keys set a product's main image and a variant's image back to
 * null, and the public URL stops working with the row.
 */
export async function deleteProductImage(workspaceId: string, imageId: string): Promise<boolean> {
  const deleted = await prisma.productImage.deleteMany({ where: { id: imageId, workspaceId } });
  return deleted.count === 1;
}

export type PublicImage = { data: Buffer; mimeType: ProductImageMime; sha256: string; size: number };

export type PublicImageMeta = { mimeType: ProductImageMime; sha256: string; size: number };

/**
 * The same lookup without the bytes, so a revalidation by ETag does not load
 * an image of up to 15 MiB just to answer 304. The type is the one stored
 * from the bytes at upload, checked against the three allowed ones.
 */
export async function readPublicImageMeta(publicId: string): Promise<PublicImageMeta | null> {
  if (!isPublicId(publicId)) return null;
  const image = await prisma.productImage.findUnique({
    where: { publicId },
    select: { mimeType: true, sha256: true, size: true },
  });
  if (!image) return null;
  const mimeType = PRODUCT_IMAGE_MIMES.find((mime) => mime === image.mimeType);
  return mimeType ? { mimeType, sha256: image.sha256, size: image.size } : null;
}

/**
 * The lookup behind the public route. It has no session, so it goes by the
 * public id alone, not by brand, and a malformed id costs no query. The type
 * is read again from the bytes, so whatever a row holds, the route can only
 * serve one of the three image types.
 */
export async function readPublicImage(publicId: string): Promise<PublicImage | null> {
  if (!isPublicId(publicId)) return null;
  const image = await prisma.productImage.findUnique({ where: { publicId }, select: { data: true, sha256: true } });
  if (!image) return null;
  // Prisma 7 returns Bytes as a Uint8Array: a Buffer over the same memory, not a copy.
  const data = Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength);
  const mimeType = sniffImageMime(data);
  return mimeType ? { data, mimeType, sha256: image.sha256, size: data.length } : null;
}
