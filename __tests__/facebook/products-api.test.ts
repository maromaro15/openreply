import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The catalog's routes: who may call what, how requests are read, and how
 * refusals reach the screens. The library behind them is mocked here (it
 * has its own tests, and products.db.test.ts runs it on Postgres); its
 * validation schemas are the real ones.
 */
const state = vi.hoisted(() => ({
  context: null as null | {
    userId: string;
    workspaceId: string;
    role: "OWNER" | "ADMIN" | "MEMBER";
    workspace: { id: string; name: string };
  },
}));
const lib = vi.hoisted(() => ({
  listProducts: vi.fn(),
  getProduct: vi.fn(),
  createProduct: vi.fn(),
  updateProduct: vi.fn(),
  setProductStatus: vi.fn(),
  deleteProduct: vi.fn(),
  convertKnowledgeProduct: vi.fn(),
  listAttributes: vi.fn(),
  createAttribute: vi.fn(),
  updateAttribute: vi.fn(),
  deleteAttribute: vi.fn(),
  storeProductImage: vi.fn(),
  deleteProductImage: vi.fn(),
}));
const db = vi.hoisted(() => ({ productImage: { findUnique: vi.fn() } }));

vi.mock("@/lib/workspace-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/workspace-access")>()),
  getCurrentWorkspaceContext: async () => state.context,
}));
vi.mock("@/lib/auth", () => ({ getCurrentUserId: async () => state.context?.userId ?? null }));
vi.mock("@/lib/db/client", () => ({ prisma: db }));
vi.mock("@/lib/catalog/products", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/catalog/products")>();
  return {
    ...actual,
    listProducts: lib.listProducts,
    getProduct: lib.getProduct,
    createProduct: lib.createProduct,
    updateProduct: lib.updateProduct,
    setProductStatus: lib.setProductStatus,
    deleteProduct: lib.deleteProduct,
    convertKnowledgeProduct: lib.convertKnowledgeProduct,
  };
});
vi.mock("@/lib/catalog/attributes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/catalog/attributes")>();
  return {
    ...actual,
    listAttributes: lib.listAttributes,
    createAttribute: lib.createAttribute,
    updateAttribute: lib.updateAttribute,
    deleteAttribute: lib.deleteAttribute,
  };
});
vi.mock("@/lib/catalog/images", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/catalog/images")>();
  return { ...actual, storeProductImage: lib.storeProductImage, deleteProductImage: lib.deleteProductImage };
});

import { GET as listRoute, POST as createRoute } from "../../app/api/catalog/products/route";
import {
  DELETE as deleteRoute,
  GET as getRoute,
  PATCH as statusRoute,
  PUT as updateRoute,
} from "../../app/api/catalog/products/[id]/route";
import { GET as listAttributesRoute, POST as createAttributeRoute } from "../../app/api/catalog/attributes/route";
import { DELETE as deleteAttributeRoute, PATCH as patchAttributeRoute } from "../../app/api/catalog/attributes/[id]/route";
import { POST as uploadRoute } from "../../app/api/catalog/images/route";
import { DELETE as deleteImageRoute } from "../../app/api/catalog/images/[id]/route";
import { POST as convertRoute } from "../../app/api/catalog/convert/route";
import { GET as mediaRoute } from "../../app/api/public/media/[publicId]/route";
import { PRODUCT_ERRORS } from "../../lib/catalog/errors";
import { MAX_ATTRIBUTES } from "../../lib/catalog/attributes";
import ar from "../../lib/facebook/i18n/ar.json";

const ORIGIN = "http://localhost:3000";
const BASE = `${ORIGIN}/api/catalog`;
const params = (id: string) => ({ params: Promise.resolve({ id }) });

function request(url: string, method = "GET", body?: unknown, origin = ORIGIN) {
  return new NextRequest(url, {
    method,
    headers: { "Content-Type": "application/json", Origin: origin },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function as(role: "OWNER" | "ADMIN" | "MEMBER" | null) {
  state.context = role ? { userId: "u", workspaceId: "ws_a", role, workspace: { id: "ws_a", name: "Lina" } } : null;
}

const PRODUCT = { id: "prod_1", name: "Wallpaper", code: "WP-12", status: "ACTIVE" };
const CARD = {
  name: "Wallpaper 3D",
  code: "WP-12",
  price: "1200 DA",
  attributes: { thickness: "3" },
  variants: [{ code: "12-1", name: "Blanc" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  as("ADMIN");
  lib.listProducts.mockResolvedValue({ products: [PRODUCT], nextCursor: null });
  lib.getProduct.mockResolvedValue(PRODUCT);
  lib.createProduct.mockResolvedValue({ ok: true, product: PRODUCT });
  lib.updateProduct.mockResolvedValue({ ok: true, product: PRODUCT });
  lib.setProductStatus.mockResolvedValue(true);
  lib.deleteProduct.mockResolvedValue(true);
  lib.convertKnowledgeProduct.mockResolvedValue({ ok: true, product: PRODUCT });
  lib.listAttributes.mockResolvedValue([]);
  lib.createAttribute.mockImplementation(async (_workspaceId: string, input: object) => ({ id: "attr_1", ...input }));
  lib.updateAttribute.mockResolvedValue({ id: "attr_1" });
  lib.deleteAttribute.mockResolvedValue(true);
  lib.storeProductImage.mockResolvedValue({
    ok: true,
    image: { id: "img_1", publicId: "p".repeat(32), path: `/api/public/media/${"p".repeat(32)}`, mimeType: "image/png", size: 68, fileName: "a.png" },
  });
  lib.deleteProductImage.mockResolvedValue(true);
});

describe("the product list", () => {
  it("is for every member of the brand, with their role", async () => {
    as("MEMBER");
    const body = await (await listRoute(request(`${BASE}/products`))).json();
    expect(body).toEqual({ success: true, data: { role: "MEMBER", products: [PRODUCT], nextCursor: null } });
    expect(lib.listProducts).toHaveBeenCalledWith("ws_a", expect.anything());
  });

  it("needs a session", async () => {
    as(null);
    expect((await listRoute(request(`${BASE}/products`))).status).toBe(401);
    expect(lib.listProducts).not.toHaveBeenCalled();
  });

  it("passes the search, a known status, the cursor and a bounded page size", async () => {
    await listRoute(request(`${BASE}/products?search=wp%2012&status=DRAFT&cursor=prod_9&take=500`));
    expect(lib.listProducts).toHaveBeenLastCalledWith("ws_a", {
      search: "wp 12",
      status: "DRAFT",
      available: null,
      cursor: "prod_9",
      take: 200,
    });
    await listRoute(request(`${BASE}/products?status=DROP&take=abc&available=true`));
    expect(lib.listProducts).toHaveBeenLastCalledWith("ws_a", {
      search: null,
      status: null,
      available: true,
      cursor: null,
      take: undefined,
    });
    await listRoute(request(`${BASE}/products?take=0&available=false`));
    expect(lib.listProducts.mock.lastCall?.[1]).toMatchObject({ take: 1, available: false });
  });
});

describe("creating and changing a product", () => {
  it("is for owners and admins only", async () => {
    as("MEMBER");
    expect((await createRoute(request(`${BASE}/products`, "POST", CARD))).status).toBe(403);
    expect((await updateRoute(request(`${BASE}/products/prod_1`, "PUT", CARD), params("prod_1"))).status).toBe(403);
    expect((await statusRoute(request(`${BASE}/products/prod_1`, "PATCH", { status: "ARCHIVED" }), params("prod_1"))).status).toBe(403);
    expect((await deleteRoute(request(`${BASE}/products/prod_1`, "DELETE"), params("prod_1"))).status).toBe(403);
    expect(lib.createProduct).not.toHaveBeenCalled();
    expect(lib.updateProduct).not.toHaveBeenCalled();
    expect(lib.setProductStatus).not.toHaveBeenCalled();
    expect(lib.deleteProduct).not.toHaveBeenCalled();
  });

  it("refuses a request from another site", async () => {
    const response = await createRoute(request(`${BASE}/products`, "POST", CARD, "https://evil.example"));
    expect(response.status).toBe(403);
    expect(lib.createProduct).not.toHaveBeenCalled();
  });

  it("creates a validated card in the active brand", async () => {
    const response = await createRoute(request(`${BASE}/products`, "POST", CARD));
    expect(response.status).toBe(201);
    expect((await response.json()).data.product).toEqual(PRODUCT);
    const [workspaceId, input] = lib.createProduct.mock.calls[0];
    expect(workspaceId).toBe("ws_a");
    expect(input).toMatchObject({ name: "Wallpaper 3D", code: "WP-12", status: "ACTIVE", available: true });
  });

  it("refuses an invalid card before the library sees it", async () => {
    for (const card of [{ ...CARD, name: "" }, { ...CARD, landingUrl: "javascript:alert(1)" }, null]) {
      expect((await createRoute(request(`${BASE}/products`, "POST", card))).status).toBe(400);
    }
    expect(lib.createProduct).not.toHaveBeenCalled();
  });

  it.each(Object.entries(PRODUCT_ERRORS))("answers %s with its status, code and translatable message", async (code, failure) => {
    lib.createProduct.mockResolvedValue({ ok: false, error: code, detail: "Thickness" });
    const response = await createRoute(request(`${BASE}/products`, "POST", CARD));
    expect(response.status).toBe(failure.status);
    expect(await response.json()).toEqual({ success: false, code, error: failure.message, detail: "Thickness" });
    expect(Object.keys(ar)).toContain(failure.message);
  });

  it("replaces a card, and answers an unknown one with 404", async () => {
    expect((await updateRoute(request(`${BASE}/products/prod_1`, "PUT", CARD), params("prod_1"))).status).toBe(200);
    expect(lib.updateProduct.mock.calls[0].slice(0, 2)).toEqual(["ws_a", "prod_1"]);
    lib.updateProduct.mockResolvedValue({ ok: false, error: "not_found" });
    expect((await updateRoute(request(`${BASE}/products/prod_x`, "PUT", CARD), params("prod_x"))).status).toBe(404);
  });

  it("changes the status to a known one only", async () => {
    expect((await statusRoute(request(`${BASE}/products/prod_1`, "PATCH", { status: "ACTIVE" }), params("prod_1"))).status).toBe(200);
    expect(lib.setProductStatus).toHaveBeenCalledWith("ws_a", "prod_1", "ACTIVE");
    for (const body of [{ status: "DELETED" }, { status: 1 }, {}]) {
      expect((await statusRoute(request(`${BASE}/products/prod_1`, "PATCH", body), params("prod_1"))).status).toBe(400);
    }
    lib.setProductStatus.mockResolvedValue(false);
    expect((await statusRoute(request(`${BASE}/products/prod_x`, "PATCH", { status: "DRAFT" }), params("prod_x"))).status).toBe(404);
  });

  it("reads and deletes within the brand", async () => {
    as("MEMBER");
    const body = await (await getRoute(request(`${BASE}/products/prod_1`), params("prod_1"))).json();
    expect(body.data).toEqual({ role: "MEMBER", product: PRODUCT });
    expect(lib.getProduct).toHaveBeenCalledWith("ws_a", "prod_1");
    lib.getProduct.mockResolvedValue(null);
    expect((await getRoute(request(`${BASE}/products/prod_x`), params("prod_x"))).status).toBe(404);

    as("ADMIN");
    expect((await deleteRoute(request(`${BASE}/products/prod_1`, "DELETE"), params("prod_1"))).status).toBe(200);
    expect(lib.deleteProduct).toHaveBeenCalledWith("ws_a", "prod_1");
    lib.deleteProduct.mockResolvedValue(false);
    expect((await deleteRoute(request(`${BASE}/products/prod_x`, "DELETE"), params("prod_x"))).status).toBe(404);
  });
});

describe("turning a knowledge-base product into a card", () => {
  it("needs an entry id and an admin", async () => {
    expect((await convertRoute(request(`${BASE}/convert`, "POST", {}))).status).toBe(400);
    as("MEMBER");
    expect((await convertRoute(request(`${BASE}/convert`, "POST", { entryId: "k1" }))).status).toBe(403);
    expect(lib.convertKnowledgeProduct).not.toHaveBeenCalled();
  });

  it("converts within the brand, and maps a missing entry to 404", async () => {
    const response = await convertRoute(request(`${BASE}/convert`, "POST", { entryId: "k1" }));
    expect(response.status).toBe(201);
    expect(lib.convertKnowledgeProduct).toHaveBeenCalledWith("ws_a", "k1");
    lib.convertKnowledgeProduct.mockResolvedValue({ ok: false, error: "not_found" });
    expect((await convertRoute(request(`${BASE}/convert`, "POST", { entryId: "k9" }))).status).toBe(404);
  });
});

describe("the attribute template", () => {
  it("is readable by members, with the limit", async () => {
    as("MEMBER");
    const body = await (await listAttributesRoute(request(`${BASE}/attributes`))).json();
    expect(body.data).toEqual({ role: "MEMBER", limit: MAX_ATTRIBUTES, attributes: [] });
    expect(lib.listAttributes).toHaveBeenCalledWith("ws_a");
    expect((await createAttributeRoute(request(`${BASE}/attributes`, "POST", { label: "السمك", type: "NUMBER" }))).status).toBe(403);
  });

  it("adds a valid attribute, and says when the brand has as many as it can hold", async () => {
    const response = await createAttributeRoute(request(`${BASE}/attributes`, "POST", { label: " السمك ", type: "NUMBER", unit: "mm" }));
    expect(response.status).toBe(201);
    expect(lib.createAttribute.mock.calls[0][1]).toMatchObject({ label: "السمك", type: "NUMBER", unit: "mm" });

    expect((await createAttributeRoute(request(`${BASE}/attributes`, "POST", { label: "", type: "TEXT" }))).status).toBe(400);
    expect((await createAttributeRoute(request(`${BASE}/attributes`, "POST", { label: "Couleur", type: "CHOICE", options: ["Blanc"] }))).status).toBe(400);

    lib.createAttribute.mockResolvedValue(null);
    const full = await createAttributeRoute(request(`${BASE}/attributes`, "POST", { label: "Matière", type: "TEXT" }));
    expect(full.status).toBe(400);
    const message = (await full.json()).error;
    expect(Object.keys(ar)).toContain(message);
  });

  it("changes an attribute without its type, and needs something to change", async () => {
    expect((await patchAttributeRoute(request(`${BASE}/attributes/attr_1`, "PATCH", {}), params("attr_1"))).status).toBe(400);
    expect((await patchAttributeRoute(request(`${BASE}/attributes/attr_1`, "PATCH", { sortOrder: 2 }), params("attr_1"))).status).toBe(200);
    expect(lib.updateAttribute).toHaveBeenCalledWith("ws_a", "attr_1", { sortOrder: 2 });
    lib.updateAttribute.mockResolvedValue(null);
    expect((await patchAttributeRoute(request(`${BASE}/attributes/attr_x`, "PATCH", { label: "X" }), params("attr_x"))).status).toBe(404);
  });

  it("deletes within the brand", async () => {
    expect((await deleteAttributeRoute(request(`${BASE}/attributes/attr_1`, "DELETE"), params("attr_1"))).status).toBe(200);
    expect(lib.deleteAttribute).toHaveBeenCalledWith("ws_a", "attr_1");
    lib.deleteAttribute.mockResolvedValue(false);
    expect((await deleteAttributeRoute(request(`${BASE}/attributes/attr_x`, "DELETE"), params("attr_x"))).status).toBe(404);
  });
});

// A real 1×1 PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

function upload(fields: Record<string, Blob | string>, headers: Record<string, string> = {}) {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  return new NextRequest(`${BASE}/images`, { method: "POST", body: form, headers: { Origin: ORIGIN, ...headers } });
}

describe("uploading an image", () => {
  it("stores the file for the brand, on a product when one is given", async () => {
    const response = await uploadRoute(upload({ file: new File([PNG], "wp-12.png"), productId: "prod_1" }));
    expect(response.status).toBe(201);
    const [workspaceId, file] = lib.storeProductImage.mock.calls[0];
    expect(workspaceId).toBe("ws_a");
    expect(file.fileName).toBe("wp-12.png");
    expect(file.productId).toBe("prod_1");
    expect(Buffer.compare(file.bytes, PNG)).toBe(0);

    await uploadRoute(upload({ file: new File([PNG], "a.png"), productId: "" }));
    expect(lib.storeProductImage.mock.calls[1][1].productId).toBeNull();
  });

  it("is for owners and admins", async () => {
    as("MEMBER");
    expect((await uploadRoute(upload({ file: new File([PNG], "a.png") }))).status).toBe(403);
    expect(lib.storeProductImage).not.toHaveBeenCalled();
  });

  it("needs the file field", async () => {
    expect((await uploadRoute(upload({ image: new File([PNG], "a.png") }))).status).toBe(400);
    expect(lib.storeProductImage).not.toHaveBeenCalled();
  });

  it("refuses a body over the limit from its declared size, without reading it", async () => {
    vi.stubEnv("PRODUCT_IMAGE_MAX_BYTES", String(64 * 1024));
    const request = new NextRequest(`${BASE}/images`, {
      method: "POST",
      body: "x",
      headers: { Origin: ORIGIN, "Content-Type": "multipart/form-data; boundary=b", "Content-Length": String(10 * 1024 * 1024) },
    });
    const response = await uploadRoute(request);
    expect(response.status).toBe(413);
    expect((await response.json()).code).toBe("too_large");
    expect(lib.storeProductImage).not.toHaveBeenCalled();
  });

  it("stops reading a body that grows past the limit without declaring its size", async () => {
    vi.stubEnv("PRODUCT_IMAGE_MAX_BYTES", String(64 * 1024));
    let pulled = 0;
    const chunk = new Uint8Array(32 * 1024);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 1000) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const request = new NextRequest(`${BASE}/images`, {
      method: "POST",
      body: stream,
      headers: { Origin: ORIGIN, "Content-Type": "multipart/form-data; boundary=b" },
      duplex: "half",
    } as ConstructorParameters<typeof NextRequest>[1]);
    const response = await uploadRoute(request);
    expect(response.status).toBe(413);
    // 64 KiB of image and 64 KiB of room for the form: a few chunks, not 1000.
    expect(pulled).toBeLessThan(10);
    expect(lib.storeProductImage).not.toHaveBeenCalled();
  });

  it("refuses a file over the limit inside a body that fits", async () => {
    vi.stubEnv("PRODUCT_IMAGE_MAX_BYTES", String(64 * 1024));
    const response = await uploadRoute(upload({ file: new File([new Uint8Array(64 * 1024 + 1)], "big.png") }));
    expect(response.status).toBe(413);
    expect(lib.storeProductImage).not.toHaveBeenCalled();
  });

  it.each([
    ["empty", 400],
    ["not_an_image", 400],
    ["too_many", 400],
    ["unknown_product", 404],
    ["too_large", 413],
  ])("answers %s with %i and a translatable message", async (code, status) => {
    lib.storeProductImage.mockResolvedValue({ ok: false, error: code });
    const response = await uploadRoute(upload({ file: new File([PNG], "a.png") }));
    expect(response.status).toBe(status);
    const body = await response.json();
    expect(body.code).toBe(code);
    expect(Object.keys(ar)).toContain(body.error);
  });

  it("deletes an image of the brand only", async () => {
    expect((await deleteImageRoute(request(`${BASE}/images/img_1`, "DELETE"), params("img_1"))).status).toBe(200);
    expect(lib.deleteProductImage).toHaveBeenCalledWith("ws_a", "img_1");
    lib.deleteProductImage.mockResolvedValue(false);
    expect((await deleteImageRoute(request(`${BASE}/images/img_x`, "DELETE"), params("img_x"))).status).toBe(404);
    as("MEMBER");
    expect((await deleteImageRoute(request(`${BASE}/images/img_1`, "DELETE"), params("img_1"))).status).toBe(403);
  });
});

describe("the public image link", () => {
  const publicId = "A".repeat(31) + "_";
  const mediaParams = (id: string) => ({ params: Promise.resolve({ publicId: id }) });
  const media = (id: string, headers: Record<string, string> = {}) =>
    mediaRoute(new NextRequest(`${ORIGIN}/api/public/media/${id}`, { headers }), mediaParams(id));

  it("serves the bytes without a session, with headers that keep them an image", async () => {
    as(null);
    // A real row: the type and size are stored from the bytes at upload.
    db.productImage.findUnique.mockResolvedValue({ data: new Uint8Array(PNG), sha256: "abc123", mimeType: "image/png", size: PNG.length });
    const response = await media(publicId);
    expect(response.status).toBe(200);
    expect(db.productImage.findUnique).toHaveBeenCalledWith({ where: { publicId }, select: { data: true, sha256: true } });
    expect(Object.fromEntries(response.headers)).toMatchObject({
      "content-type": "image/png",
      "content-length": String(PNG.length),
      etag: '"abc123"',
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cross-origin-resource-policy": "cross-origin",
      "cache-control": "public, max-age=86400",
    });
    expect(Buffer.compare(Buffer.from(await response.arrayBuffer()), PNG)).toBe(0);
  });

  it("answers a known version with 304 and no body", async () => {
    // A real row: the type and size are stored from the bytes at upload.
    db.productImage.findUnique.mockResolvedValue({ data: new Uint8Array(PNG), sha256: "abc123", mimeType: "image/png", size: PNG.length });
    const response = await media(publicId, { "If-None-Match": '"abc123"' });
    expect(response.status).toBe(304);
    expect(await response.text()).toBe("");
  });

  it("answers 404, never cached, for a malformed id (no query) or an unknown one", async () => {
    for (const id of ["short", `${publicId}x`, "../../etc/passwd", "A".repeat(31) + "="]) {
      const response = await media(id);
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(db.productImage.findUnique).not.toHaveBeenCalled();
    db.productImage.findUnique.mockResolvedValue(null);
    expect((await media(publicId)).status).toBe(404);
  });

  it("never serves a row whose bytes are not an image", async () => {
    db.productImage.findUnique.mockResolvedValue({ data: new Uint8Array(Buffer.from("<svg onload=alert(1)>")), sha256: "x" });
    expect((await media(publicId)).status).toBe(404);
  });
});
