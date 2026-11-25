import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  product: { findFirst: vi.fn() },
  productImage: { count: vi.fn(), create: vi.fn(), deleteMany: vi.fn(), findUnique: vi.fn() },
}));

vi.mock("@/lib/db/client", () => ({ prisma: db }));

import {
  MAX_FILE_NAME_LENGTH,
  MAX_IMAGES_PER_WORKSPACE,
  PRODUCT_IMAGE_MIMES,
  cleanFileName,
  deleteProductImage,
  getProductImageMaxBytes,
  isPublicId,
  newPublicId,
  publicImagePath,
  publicImageUrl,
  readPublicImage,
  sniffImageMime,
  storeProductImage,
} from "../../lib/catalog/images";

const KiB = 1024;
const MiB = 1024 * KiB;

// A JFIF header, a real 1×1 PNG and a real 1×1 lossless WebP.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01]);
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);
const WEBP = Buffer.from("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==", "base64");
const HTML = Buffer.from("<!doctype html><script>alert(document.cookie)</script>");

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** A JPEG header followed by zeros, `size` bytes in all. */
function jpegOfSize(size: number): Buffer {
  const bytes = Buffer.alloc(size);
  JPEG.copy(bytes);
  return bytes;
}

/** The arguments of the n-th productImage.create call. */
function created(n = 0) {
  return db.productImage.create.mock.calls[n][0];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("PRODUCT_IMAGE_MAX_BYTES", "");
  db.product.findFirst.mockResolvedValue(null);
  db.productImage.count.mockResolvedValue(0);
  db.productImage.create.mockImplementation(async ({ data }) => ({
    id: "img_1",
    publicId: data.publicId,
    size: data.size,
    fileName: data.fileName,
  }));
  db.productImage.deleteMany.mockResolvedValue({ count: 0 });
  db.productImage.findUnique.mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the type, read from the bytes", () => {
  it.each([
    ["a JPEG", JPEG, "image/jpeg"],
    ["a PNG", PNG, "image/png"],
    ["a WebP", WEBP, "image/webp"],
  ])("knows %s by its magic number", (_name, bytes, mime) => {
    expect(sniffImageMime(bytes)).toBe(mime);
    expect(sniffImageMime(new Uint8Array(bytes))).toBe(mime);
    expect(PRODUCT_IMAGE_MIMES).toContain(mime);
  });

  it.each([
    ["nothing", Buffer.alloc(0)],
    ["a RIFF file that is not a WebP (WAV)", Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x24, 0, 0, 0]), Buffer.from("WAVEfmt ")])],
    ["a WebP cut inside its WEBP tag", WEBP.subarray(0, 11)],
    ["WEBP without RIFF", Buffer.from("WEBPVP8L\0\0\0\0")],
    ["a truncated PNG signature", PNG.subarray(0, 7)],
    ["a PNG signature with one wrong byte", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x00, 0, 0, 0, 0x0d])],
    ["the first two bytes of a JPEG", JPEG.subarray(0, 2)],
    ["a GIF", Buffer.from("GIF89a\x01\x00\x01\x00\x80\x00\x00", "latin1")],
    ["an SVG", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')],
    ["an SVG with an XML declaration", Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>')],
    ["HTML", HTML],
    ["a HEIC photo", Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic"), Buffer.alloc(12)])],
    ["a PNG after a leading space", Buffer.concat([Buffer.from(" "), PNG])],
  ])("refuses %s", (_name, bytes) => {
    expect(sniffImageMime(bytes)).toBeNull();
  });
});

describe("public ids and links", () => {
  it("makes a 32-character base64url id, different every time", () => {
    const ids = Array.from({ length: 200 }, () => newPublicId());
    for (const id of ids) {
      expect(id).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect(isPublicId(id)).toBe(true);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each([
    ["empty", ""],
    ["31 characters", "a".repeat(31)],
    ["33 characters", "a".repeat(33)],
    ["base64 with + and /", "ab+/".repeat(8)],
    ["padding", `${"a".repeat(31)}=`],
    ["a path of the right length", `${"../".repeat(10)}ab`],
    ["an encoded path of the right length", `${"%2e%2e%2f".repeat(3)}aaaaa`],
    ["a trailing newline", `${"a".repeat(32)}\n`],
    ["spaces", " ".repeat(32)],
    ["Arabic letters", "ب".repeat(32)],
  ])("refuses %s as a public id", (_name, value) => {
    expect(isPublicId(value)).toBe(false);
  });

  it("serves an image at /api/public/media/<publicId>", () => {
    expect(publicImagePath("AbC_-9")).toBe("/api/public/media/AbC_-9");
  });

  it.each(["https://bot.example.com", "https://bot.example.com/", "https://bot.example.com//", " https://bot.example.com/ "])(
    "builds the absolute URL from %j without a double slash",
    (base) => {
      const id = newPublicId();
      expect(publicImageUrl(base, id)).toBe(`https://bot.example.com/api/public/media/${id}`);
    }
  );
});

describe("file names", () => {
  it.each([
    ["../../etc/passwd", "passwd"],
    ["C:\\photos\\a.jpg", "a.jpg"],
    ["catalogue/ورق جدران/WP-12.jpg", "WP-12.jpg"],
    ["photos\\2026/WP_12.jpg", "WP_12.jpg"],
    ["  WP-12.jpg \n", "WP-12.jpg"],
    ["WP\u0000-12\t.jpg\u007f", "WP-12.jpg"],
    ["WP\u0085-12\u009b.jpg", "WP-12.jpg"],
    ["photo\u202egpj.exe", "photogpj.exe"],
    ["\u2067WP-12.png\u2069", "WP-12.png"],
    ["ورق جدران بيج 12.webp", "ورق جدران بيج 12.webp"],
  ])("cleans %j to %j", (name, expected) => {
    expect(cleanFileName(name)).toBe(expected);
  });

  it.each([null, undefined, "", "   ", "\u0000\u0001\u001f", "photos/", "C:\\photos\\", ".", "..", "photos/.."])(
    "keeps no name for %j",
    (name) => {
      expect(cleanFileName(name)).toBeNull();
    }
  );

  it("cuts a long name to 120 characters, keeping a short extension", () => {
    const name = cleanFileName(`${"a".repeat(300)}.jpeg`);
    expect(name).toBe(`${"a".repeat(115)}.jpeg`);
    expect(name).toHaveLength(MAX_FILE_NAME_LENGTH);
    expect(cleanFileName("b".repeat(300))).toBe("b".repeat(120));
    expect(cleanFileName("c".repeat(120))).toBe("c".repeat(120));
    expect(cleanFileName(`${"d".repeat(200)}.not an extension`)).toBe("d".repeat(120));
  });

  it("never cuts a character in half", () => {
    // 1 + 100 × 2 UTF-16 units: the 60th picture would not fit in 120.
    const name = cleanFileName(`a${"\u{1f5bc}".repeat(100)}`)!;
    expect(name).toBe(`a${"\u{1f5bc}".repeat(59)}`);
    expect(name.length).toBeLessThanOrEqual(MAX_FILE_NAME_LENGTH);
    expect(name.isWellFormed()).toBe(true);
  });
});

describe("the size limit", () => {
  it("is 5 MiB unless PRODUCT_IMAGE_MAX_BYTES says otherwise, read on every call", () => {
    expect(getProductImageMaxBytes()).toBe(5 * MiB);
    vi.stubEnv("PRODUCT_IMAGE_MAX_BYTES", String(2 * MiB));
    expect(getProductImageMaxBytes()).toBe(2 * MiB);
  });

  it.each([
    ["1000", 64 * KiB],
    ["-5", 64 * KiB],
    [String(100 * MiB), 15 * MiB],
    ["abc", 5 * MiB],
    ["2.5", 5 * MiB],
  ])("reads PRODUCT_IMAGE_MAX_BYTES=%s as %i bytes", (value, expected) => {
    vi.stubEnv("PRODUCT_IMAGE_MAX_BYTES", value);
    expect(getProductImageMaxBytes()).toBe(expected);
  });
});

describe("storing an image", () => {
  it("stores the bytes with their hash, the type read from them and a new public id", async () => {
    const result = await storeProductImage("ws_a", { bytes: JPEG, fileName: "photos/WP-12.jpg" });

    const { data, select } = created();
    expect(data).toEqual({
      workspaceId: "ws_a",
      productId: null,
      publicId: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/),
      mimeType: "image/jpeg",
      size: JPEG.length,
      sha256: sha256(JPEG),
      data: JPEG,
      fileName: "WP-12.jpg",
    });
    expect(data.sha256).toMatch(/^[0-9a-f]{64}$/);
    // The bytes are not read back from the database.
    expect(select).not.toHaveProperty("data");
    expect(result).toEqual({
      ok: true,
      image: {
        id: "img_1",
        publicId: data.publicId,
        path: `/api/public/media/${data.publicId}`,
        mimeType: "image/jpeg",
        size: JPEG.length,
        fileName: "WP-12.jpg",
      },
    });
    expect(db.product.findFirst).not.toHaveBeenCalled();
  });

  it("trusts the bytes, not the name: a PNG named .jpg is a PNG", async () => {
    const result = await storeProductImage("ws_a", { bytes: PNG, fileName: "WP-12.jpg" });
    expect(result).toMatchObject({ ok: true, image: { mimeType: "image/png", fileName: "WP-12.jpg" } });
    expect(created().data.mimeType).toBe("image/png");
  });

  it("refuses HTML named .jpg", async () => {
    await expect(storeProductImage("ws_a", { bytes: HTML, fileName: "WP-12.jpg" })).resolves.toEqual({
      ok: false,
      error: "not_an_image",
    });
    expect(db.productImage.create).not.toHaveBeenCalled();
  });

  it("refuses an empty file without a query", async () => {
    await expect(storeProductImage("ws_a", { bytes: Buffer.alloc(0), fileName: "WP-12.jpg" })).resolves.toEqual({
      ok: false,
      error: "empty",
    });
    expect(db.productImage.count).not.toHaveBeenCalled();
    expect(db.productImage.create).not.toHaveBeenCalled();
  });

  it("takes up to 5 MiB and refuses one byte more", async () => {
    await expect(storeProductImage("ws_a", { bytes: jpegOfSize(5 * MiB + 1) })).resolves.toEqual({
      ok: false,
      error: "too_large",
    });
    expect(db.productImage.create).not.toHaveBeenCalled();
    await expect(storeProductImage("ws_a", { bytes: jpegOfSize(5 * MiB) })).resolves.toMatchObject({
      ok: true,
      image: { size: 5 * MiB },
    });
  });

  it("follows PRODUCT_IMAGE_MAX_BYTES, within 64 KiB and 15 MiB", async () => {
    vi.stubEnv("PRODUCT_IMAGE_MAX_BYTES", String(64 * KiB));
    await expect(storeProductImage("ws_a", { bytes: jpegOfSize(64 * KiB + 1) })).resolves.toEqual({
      ok: false,
      error: "too_large",
    });
    vi.stubEnv("PRODUCT_IMAGE_MAX_BYTES", "1");
    await expect(storeProductImage("ws_a", { bytes: jpegOfSize(64 * KiB) })).resolves.toMatchObject({ ok: true });
    vi.stubEnv("PRODUCT_IMAGE_MAX_BYTES", String(1024 * MiB));
    await expect(storeProductImage("ws_a", { bytes: jpegOfSize(15 * MiB + 1) })).resolves.toEqual({
      ok: false,
      error: "too_large",
    });
  });

  it("attaches to the brand's own product", async () => {
    db.product.findFirst.mockResolvedValue({ id: "prod_a" });
    const result = await storeProductImage("ws_a", { bytes: WEBP, productId: "prod_a" });
    expect(db.product.findFirst).toHaveBeenCalledWith({ where: { id: "prod_a", workspaceId: "ws_a" }, select: { id: true } });
    expect(created().data).toMatchObject({ workspaceId: "ws_a", productId: "prod_a", mimeType: "image/webp" });
    expect(result.ok).toBe(true);
  });

  it("will not attach to another brand's product", async () => {
    // prod_b is ws_b's: looked up within ws_a, it is not there.
    db.product.findFirst.mockImplementation(async ({ where }) =>
      where.id === "prod_b" && where.workspaceId === "ws_b" ? { id: "prod_b" } : null
    );
    await expect(storeProductImage("ws_a", { bytes: PNG, productId: "prod_b" })).resolves.toEqual({
      ok: false,
      error: "unknown_product",
    });
    expect(db.productImage.create).not.toHaveBeenCalled();
    await expect(storeProductImage("ws_b", { bytes: PNG, productId: "prod_b" })).resolves.toMatchObject({ ok: true });
    expect(created().data).toMatchObject({ workspaceId: "ws_b", productId: "prod_b" });
  });

  it("treats an empty product id as no product", async () => {
    await expect(storeProductImage("ws_a", { bytes: PNG, productId: "" })).resolves.toMatchObject({ ok: true });
    expect(db.product.findFirst).not.toHaveBeenCalled();
    expect(created().data.productId).toBeNull();
  });

  it("stops at 3000 images, counted within the brand", async () => {
    expect(MAX_IMAGES_PER_WORKSPACE).toBe(3000);
    db.productImage.count.mockResolvedValue(MAX_IMAGES_PER_WORKSPACE);
    await expect(storeProductImage("ws_a", { bytes: PNG })).resolves.toEqual({ ok: false, error: "too_many" });
    expect(db.productImage.count).toHaveBeenCalledWith({ where: { workspaceId: "ws_a" } });
    expect(db.productImage.create).not.toHaveBeenCalled();

    db.productImage.count.mockResolvedValue(MAX_IMAGES_PER_WORKSPACE - 1);
    await expect(storeProductImage("ws_a", { bytes: PNG })).resolves.toMatchObject({ ok: true });
  });

  it("checks in order: empty, too large, not an image, unknown product, too many", async () => {
    vi.stubEnv("PRODUCT_IMAGE_MAX_BYTES", String(64 * KiB));
    db.productImage.count.mockResolvedValue(MAX_IMAGES_PER_WORKSPACE);
    const store = (bytes: Buffer, productId?: string) => storeProductImage("ws_a", { bytes, productId });

    await expect(store(Buffer.alloc(0), "prod_b")).resolves.toEqual({ ok: false, error: "empty" });
    await expect(store(Buffer.concat([HTML, Buffer.alloc(64 * KiB)]), "prod_b")).resolves.toEqual({
      ok: false,
      error: "too_large",
    });
    await expect(store(HTML, "prod_b")).resolves.toEqual({ ok: false, error: "not_an_image" });
    expect(db.product.findFirst).not.toHaveBeenCalled();
    await expect(store(PNG, "prod_b")).resolves.toEqual({ ok: false, error: "unknown_product" });
    expect(db.productImage.count).not.toHaveBeenCalled();
    await expect(store(PNG)).resolves.toEqual({ ok: false, error: "too_many" });
    expect(db.productImage.create).not.toHaveBeenCalled();
  });

  it("gives every image its own public id", async () => {
    await storeProductImage("ws_a", { bytes: PNG });
    await storeProductImage("ws_a", { bytes: PNG });
    expect(created(0).data.publicId).not.toBe(created(1).data.publicId);
    expect(created(0).data.sha256).toBe(sha256(PNG));
    expect(created(1).data.sha256).toBe(sha256(PNG));
  });
});

describe("deleting an image", () => {
  it("deletes only within the brand", async () => {
    db.productImage.deleteMany.mockImplementation(async ({ where }) => ({
      count: where.id === "img_a" && where.workspaceId === "ws_a" ? 1 : 0,
    }));
    await expect(deleteProductImage("ws_b", "img_a")).resolves.toBe(false);
    await expect(deleteProductImage("ws_a", "img_a")).resolves.toBe(true);
    await expect(deleteProductImage("ws_a", "img_missing")).resolves.toBe(false);
    expect(db.productImage.deleteMany).toHaveBeenNthCalledWith(1, { where: { id: "img_a", workspaceId: "ws_b" } });
    expect(db.productImage.deleteMany).toHaveBeenNthCalledWith(2, { where: { id: "img_a", workspaceId: "ws_a" } });
  });
});

describe("the public link", () => {
  it.each(["", "abc", "a".repeat(33), `${"../".repeat(10)}ab`, `${"%2e%2e%2f".repeat(3)}aaaaa`, `${"a".repeat(31)}=`])(
    "answers %j without a query",
    async (publicId) => {
      await expect(readPublicImage(publicId)).resolves.toBeNull();
      expect(db.productImage.findUnique).not.toHaveBeenCalled();
    }
  );

  it("reads a stored image by its public id alone, as a Buffer", async () => {
    const publicId = newPublicId();
    // Prisma 7 returns Bytes as a Uint8Array.
    db.productImage.findUnique.mockResolvedValue({ data: new Uint8Array(PNG), sha256: sha256(PNG) });

    const image = await readPublicImage(publicId);
    expect(db.productImage.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { publicId } }));
    expect(image).toMatchObject({ mimeType: "image/png", sha256: sha256(PNG), size: PNG.length });
    expect(Buffer.isBuffer(image!.data)).toBe(true);
    expect(image!.data.equals(PNG)).toBe(true);
  });

  it("keeps the right bytes of a view into a larger buffer", async () => {
    const backing = new Uint8Array(PNG.length + 16);
    backing.set(PNG, 8);
    db.productImage.findUnique.mockResolvedValue({ data: backing.subarray(8, 8 + PNG.length), sha256: sha256(PNG) });

    const image = await readPublicImage(newPublicId());
    expect(image!.data.equals(PNG)).toBe(true);
    expect(image!.size).toBe(PNG.length);
  });

  it("finds nothing for an unknown public id", async () => {
    await expect(readPublicImage(newPublicId())).resolves.toBeNull();
    expect(db.productImage.findUnique).toHaveBeenCalledTimes(1);
  });

  it("serves only what the bytes are, whatever the row says", async () => {
    db.productImage.findUnique.mockResolvedValue({ data: new Uint8Array(WEBP), mimeType: "text/html", sha256: sha256(WEBP) });
    await expect(readPublicImage(newPublicId())).resolves.toMatchObject({ mimeType: "image/webp" });

    db.productImage.findUnique.mockResolvedValue({ data: new Uint8Array(HTML), mimeType: "image/png", sha256: sha256(HTML) });
    await expect(readPublicImage(newPublicId())).resolves.toBeNull();
  });
});
