import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The product import's routes and the library behind them: who may call
 * what, what a preview says, and above all what a confirmed import writes.
 * The catalog's own writes (createProduct, updateProduct) are mocked, so the
 * tests read exactly what the import hands them; its schema is the real one.
 */
const state = vi.hoisted(() => ({
  context: null as null | {
    userId: string;
    workspaceId: string;
    role: "OWNER" | "ADMIN" | "MEMBER";
    workspace: { id: string; name: string };
  },
  /** Codes the brand has: what the import looks cards up by. */
  codes: [] as { id: string; codeKey: string }[],
  /** The same cards with their colours, for matching pictures. */
  catalog: [] as { code: string | null; variants: { code: string }[] }[],
  /** The cards a picture's name could mean. */
  candidates: [] as unknown[],
  productCount: 0,
  imageCount: 0,
}));
const lib = vi.hoisted(() => ({
  getProduct: vi.fn(),
  createProduct: vi.fn(),
  updateProduct: vi.fn(),
  listAttributes: vi.fn(),
  storeProductImage: vi.fn(),
}));
const db = vi.hoisted(() => ({
  product: { findMany: vi.fn(), count: vi.fn(), updateMany: vi.fn() },
  productVariant: { updateMany: vi.fn() },
  productImage: { count: vi.fn(), findFirst: vi.fn() },
}));

vi.mock("@/lib/workspace-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/workspace-access")>()),
  getCurrentWorkspaceContext: async () => state.context,
}));
vi.mock("@/lib/auth", () => ({ getCurrentUserId: async () => state.context?.userId ?? null }));
vi.mock("@/lib/db/client", () => ({ prisma: db }));
vi.mock("@/lib/catalog/products", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/catalog/products")>()),
  getProduct: lib.getProduct,
  createProduct: lib.createProduct,
  updateProduct: lib.updateProduct,
}));
vi.mock("@/lib/catalog/attributes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/catalog/attributes")>()),
  listAttributes: lib.listAttributes,
}));
vi.mock("@/lib/catalog/images", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/catalog/images")>()),
  storeProductImage: lib.storeProductImage,
}));

import { GET as templateRoute } from "../../app/api/catalog/import/template/route";
import { POST as previewRoute } from "../../app/api/catalog/import/preview/route";
import { POST as confirmRoute } from "../../app/api/catalog/import/route";
import { POST as imageRoute } from "../../app/api/catalog/import/images/route";
import { importColumns } from "../../lib/catalog/import/catalog";
import { buildImportTemplate, type Sheet } from "../../lib/catalog/import/catalog";
import { readCsv } from "../../lib/catalog/import/csv";
import { readXlsx, writeXlsx } from "../../lib/catalog/import/xlsx";
import { MAX_IMAGES_PER_WORKSPACE } from "../../lib/catalog/images";
import { MAX_PRODUCTS } from "../../lib/catalog/products";
import ar from "../../lib/facebook/i18n/ar.json";

const ORIGIN = "http://localhost:3000";
const BASE = `${ORIGIN}/api/catalog/import`;

function as(role: "OWNER" | "ADMIN" | "MEMBER" | null) {
  state.context = role ? { userId: "u", workspaceId: "ws_a", role, workspace: { id: "ws_a", name: "Lina" } } : null;
}

const ATTRIBUTES = [
  { id: "a1", key: "thickness", label: "Thickness", type: "NUMBER", unit: "mm", options: [] },
  { id: "a2", key: "finish", label: "Finish", type: "TEXT", unit: null, options: [] },
];

function xlsxFile(products: string[][], colours?: string[][], name = "products.xlsx"): File {
  const sheets: Sheet[] = [{ name: "Products", rows: products }];
  if (colours) sheets.push({ name: "Colours", rows: colours });
  return new File([new Uint8Array(writeXlsx(sheets))], name);
}

function post(url: string, fields: Record<string, string | File>, origin = ORIGIN) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return new NextRequest(url, { method: "POST", headers: { Origin: origin }, body: form });
}

const ref = (id: string) => ({ id, publicId: "p".repeat(32), path: "/x", mimeType: "image/jpeg", size: 1, fileName: null });

/** The card as getProduct returns it: a main picture, two coloured pictures, a relation. */
function card(over: Record<string, unknown> = {}) {
  return {
    id: "prod_1",
    status: "ACTIVE",
    source: "MANUAL",
    sourceRef: null,
    name: "Wallpaper",
    code: "WP-12",
    price: "1000 DA",
    available: true,
    landingUrl: null,
    description: "Old description",
    howToUse: null,
    attributes: { thickness: 3, finish: "matt" },
    strengths: ["Washable"],
    comparisons: null,
    suitableFor: null,
    objections: [],
    mainImage: ref("img_main"),
    images: [ref("img_main"), ref("img_v1"), ref("img_v2")],
    variants: [
      { id: "v1", code: "12-01", name: "Blanc", available: true, price: null, image: ref("img_v1"), sortOrder: 0 },
      { id: "v2", code: "12-02", name: "Gris", available: true, price: null, image: ref("img_v2"), sortOrder: 1 },
    ],
    related: [{ productId: "prod_9", name: "Other", code: "X-1", note: "cheaper" }],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  as("ADMIN");
  state.codes = [];
  state.catalog = [];
  state.candidates = [];
  state.productCount = 0;
  state.imageCount = 0;
  lib.listAttributes.mockResolvedValue(ATTRIBUTES);
  lib.getProduct.mockResolvedValue(null);
  lib.createProduct.mockImplementation(async (_ws: string, input: { name: string; code: string | null }) => ({
    ok: true,
    product: { id: "new_1", code: input.code, name: input.name },
  }));
  lib.updateProduct.mockImplementation(async (_ws: string, id: string) => ({
    ok: true,
    product: { id, code: "WP-12", name: "Wallpaper" },
  }));
  lib.storeProductImage.mockResolvedValue({
    ok: true,
    image: { id: "img_new", publicId: "q".repeat(32), path: "/api/public/media/q", mimeType: "image/jpeg", size: 3, fileName: "WP-12.jpg" },
  });
  db.product.findMany.mockImplementation(async (args: { select: { variants?: unknown }; where: { OR?: unknown } }) => {
    if (args.where.OR) return state.candidates;
    return args.select.variants ? state.catalog : state.codes;
  });
  db.product.count.mockImplementation(async () => state.productCount);
  db.product.updateMany.mockResolvedValue({ count: 1 });
  db.productVariant.updateMany.mockResolvedValue({ count: 1 });
  db.productImage.count.mockImplementation(async () => state.imageCount);
  db.productImage.findFirst.mockResolvedValue(null);
});

describe("who may do what", () => {
  it("lets a member download the template and preview, but not import or upload", async () => {
    as("MEMBER");
    expect((await templateRoute(new NextRequest(`${BASE}/template`))).status).toBe(200);
    const file = xlsxFile([["Code", "Name"], ["A-1", "Alpha"]]);
    expect((await previewRoute(post(`${BASE}/preview`, { file }))).status).toBe(200);
    expect((await confirmRoute(post(BASE, { file }))).status).toBe(403);
    expect((await imageRoute(post(`${BASE}/images`, { file: new File([new Uint8Array(3)], "A-1.jpg") }))).status).toBe(403);
    expect(lib.createProduct).not.toHaveBeenCalled();
  });

  it("answers 401 without a session and 403 from another origin", async () => {
    as(null);
    expect((await templateRoute(new NextRequest(`${BASE}/template`))).status).toBe(401);
    as("ADMIN");
    const file = xlsxFile([["Code", "Name"], ["A-1", "Alpha"]]);
    expect((await confirmRoute(post(BASE, { file }, "https://evil.example"))).status).toBe(403);
    expect(lib.createProduct).not.toHaveBeenCalled();
  });
});

describe("the template", () => {
  it("is an .xlsx made for the brand's attributes, sent as a download", async () => {
    const response = await templateRoute(new NextRequest(`${BASE}/template?format=xlsx`));
    expect(response.headers.get("Content-Type")).toContain("spreadsheetml.sheet");
    expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="openreply-products-template.xlsx"');
    const sheets = readXlsx(new Uint8Array(await response.arrayBuffer()));
    expect(sheets.map((sheet) => sheet.name)).toEqual(["Products", "Colours", "Read me"]);
    expect(sheets[0].rows[0]).toContain("Thickness (mm)");
    expect(sheets[0].rows[0]).toContain("Finish");
    expect(lib.listAttributes).toHaveBeenCalledWith("ws_a");
  });

  it("is a CSV with the Products sheet on request", async () => {
    const response = await templateRoute(new NextRequest(`${BASE}/template?format=csv`));
    expect(response.headers.get("Content-Type")).toContain("text/csv");
    expect(response.headers.get("Content-Disposition")).toContain(".csv");
    const rows = readCsv(new Uint8Array(await response.arrayBuffer()));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("Thickness (mm)");
  });
});

describe("the preview", () => {
  const FILE = () =>
    xlsxFile(
      [
        ["Code", "Name", "Price"],
        ["WP-12", "Wallpaper 3D", "1200 DA"], // exists: update
        ["WP-13", "Wallpaper 4D", "1500 DA"], // new
        ["WP-14", "", "1 DA"], // refused: no name
      ],
      [["Product code", "Colour code", "Colour name"], ["WP-13", "13-01", "Bleu"]]
    );

  it("counts what would be created, updated and refused, and never echoes a card", async () => {
    state.codes = [{ id: "prod_1", codeKey: "WP12" }];
    const response = await previewRoute(post(`${BASE}/preview`, { file: FILE() }));
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.data.summary).toMatchObject({ total: 3, create: 1, update: 1, error: 1, withoutCode: 0, overLimit: false });
    expect(body.data.rows.map((row: { action: string }) => row.action)).toEqual(["update", "create", "error"]);
    expect(body.data.rows[2].errors.length).toBeGreaterThan(0);
    expect(JSON.stringify(body)).not.toContain('"input"');
    expect(lib.createProduct).not.toHaveBeenCalled();
    expect(lib.updateProduct).not.toHaveBeenCalled();
  });

  it("warns when the new cards do not fit and counts rows without a code", async () => {
    state.productCount = MAX_PRODUCTS;
    const file = xlsxFile([["Code", "Name"], ["", "No code"], ["B-1", "Beta"]]);
    const { data } = await (await previewRoute(post(`${BASE}/preview`, { file }))).json();
    expect(data.summary).toMatchObject({ create: 2, withoutCode: 1, overLimit: true, productLimit: MAX_PRODUCTS });
  });

  it("matches the folder's pictures to the brand's codes and the file's, and lists what matches nothing", async () => {
    state.codes = [{ id: "prod_1", codeKey: "WP12" }];
    state.catalog = [{ code: "WP-12", variants: [{ code: "12-01" }] }];
    const images = [
      { name: "WP-12.jpg", size: 100 }, // an existing product
      { name: "WP_13.PNG", size: 100 }, // a product of the file
      { name: "13-01.jpg", size: 100 }, // a colour of the file
      { name: "WP-12_12-01.webp", size: 100 }, // a colour of the brand
      { name: "nothing.jpg", size: 100 },
      { name: "notes.txt", size: 10 },
      { name: "WP-14.jpg", size: 100 }, // its row is refused: not a code the brand will have
    ];
    const { data } = await (await previewRoute(post(`${BASE}/preview`, { file: FILE(), images: JSON.stringify(images) }))).json();
    expect(data.pictures.matched).toEqual([
      { fileName: "WP-12.jpg", productCode: "WP-12", variantCode: null },
      { fileName: "WP_13.PNG", productCode: "WP-13", variantCode: null },
      { fileName: "13-01.jpg", productCode: "WP-13", variantCode: "13-01" },
      { fileName: "WP-12_12-01.webp", productCode: "WP-12", variantCode: "12-01" },
    ]);
    expect(data.pictures.unmatched.map((item: { fileName: string }) => item.fileName).sort()).toEqual(
      ["WP-14.jpg", "nothing.jpg", "notes.txt"].sort()
    );
    // The pictures themselves never travel in a preview.
    expect(lib.storeProductImage).not.toHaveBeenCalled();
  });

  it("bounds the pictures: too large ones and those beyond the brand's room are not matched", async () => {
    vi.stubEnv("PRODUCT_IMAGE_MAX_BYTES", String(64 * 1024));
    state.imageCount = MAX_IMAGES_PER_WORKSPACE - 1;
    const file = xlsxFile([["Code", "Name"], ["A-1", "Alpha"], ["B-1", "Beta"]]);
    const images = [
      { name: "A-1.jpg", size: 64 * 1024 + 1 },
      { name: "B-1.jpg", size: 10 },
      { name: "A-1.png", size: 10 },
    ];
    const { data } = await (await previewRoute(post(`${BASE}/preview`, { file, images: JSON.stringify(images) }))).json();
    expect(data.pictures.room).toBe(1);
    expect(data.pictures.matched).toEqual([{ fileName: "B-1.jpg", productCode: "B-1", variantCode: null }]);
    expect(data.pictures.unmatched).toEqual(
      expect.arrayContaining([
        { fileName: "A-1.jpg", reason: "too large" },
        { fileName: "A-1.png", reason: "no room left for more pictures" },
      ])
    );
  });

  it("refuses a missing file, a file that is too large, a broken workbook and a bad picture list", async () => {
    expect((await previewRoute(post(`${BASE}/preview`, {}))).status).toBe(400);
    const big = new File([new Uint8Array(5 * 1024 * 1024 + 1)], "big.csv");
    const tooLarge = await previewRoute(post(`${BASE}/preview`, { file: big }));
    expect(tooLarge.status).toBe(413);
    expect((await tooLarge.json()).code).toBe("too_large");
    const broken = await previewRoute(post(`${BASE}/preview`, { file: new File([new Uint8Array([1, 2, 3, 4])], "x.xlsx") }));
    expect(broken.status).toBe(400);
    expect((await broken.json()).code).toBe("not_xlsx");
    const file = xlsxFile([["Code", "Name"], ["A-1", "Alpha"]]);
    expect((await previewRoute(post(`${BASE}/preview`, { file, images: "{not json" }))).status).toBe(400);
    expect((await previewRoute(post(`${BASE}/preview`, { file, images: JSON.stringify([1]) }))).status).toBe(400);
  });

  it("reads a CSV as the Products sheet", async () => {
    const file = new File(["Code,Name\r\nA-1,Alpha\r\n"], "products.csv");
    const { data } = await (await previewRoute(post(`${BASE}/preview`, { file }))).json();
    expect(data.summary).toMatchObject({ total: 1, create: 1 });
  });
});

describe("confirming", () => {
  it("creates new cards ACTIVE with the source IMPORT, whatever the parser's draft status", async () => {
    const file = xlsxFile(
      [["Code", "Name", "Price", "Thickness"], ["WP-13", "Wallpaper 4D", "1500 DA", "3 mm"]],
      [["Product code", "Colour code", "Colour name"], ["WP-13", "13-01", "Bleu"]]
    );
    const { data } = await (await confirmRoute(post(BASE, { file }))).json();
    expect(data).toMatchObject({ created: 1, updated: 0, unchanged: 0, refused: 0, failed: [] });
    expect(data.products).toEqual([{ id: "new_1", code: "WP-13", name: "Wallpaper 4D", action: "created" }]);
    expect(lib.createProduct).toHaveBeenCalledTimes(1);
    const [workspaceId, input, options] = lib.createProduct.mock.calls[0];
    expect(workspaceId).toBe("ws_a");
    expect(input).toMatchObject({
      status: "ACTIVE",
      name: "Wallpaper 4D",
      code: "WP-13",
      price: "1500 DA",
      attributes: { thickness: 3 },
      variants: [{ code: "13-01", name: "Bleu", available: true, imageId: null }],
    });
    expect(options).toEqual({ source: "IMPORT" });
  });

  it("reads the file again and never trusts a preview sent with it", async () => {
    const file = xlsxFile([["Code", "Name"], ["", ""], ["A-1", "Alpha"]]);
    const forged = JSON.stringify({ rows: [{ action: "create", input: { name: "Forged", status: "ARCHIVED" } }] });
    const { data } = await (await confirmRoute(post(BASE, { file, preview: forged, rows: forged }))).json();
    expect(data).toMatchObject({ created: 1, refused: 0 });
    expect(lib.createProduct).toHaveBeenCalledTimes(1);
    expect(lib.createProduct.mock.calls[0][1].name).toBe("Alpha");
  });

  it("never writes a refused row, and lists the rows the catalog refuses, going on with the rest", async () => {
    lib.createProduct.mockImplementation(async (_ws: string, input: { code: string }) =>
      input.code === "B-1" ? { ok: false, error: "duplicate_code", detail: "B-1" } : { ok: true, product: { id: `id_${input.code}`, code: input.code, name: input.code } }
    );
    const file = xlsxFile([["Code", "Name"], ["A-1", "Alpha"], ["B-1", "Beta"], ["C-1", ""], ["D-1", "Delta"]]);
    const { data } = await (await confirmRoute(post(BASE, { file }))).json();
    expect(data).toMatchObject({ created: 2, refused: 1 });
    expect(data.failed).toEqual([
      { sheet: "Products", row: 3, code: "B-1", name: "Beta", message: "Another product of this brand already has this code." },
    ]);
    expect(lib.createProduct.mock.calls.map((call) => call[1].code)).toEqual(["A-1", "B-1", "D-1"]);
  });

  it("stops asking once the brand is full", async () => {
    lib.createProduct.mockResolvedValue({ ok: false, error: "too_many" });
    const file = xlsxFile([["Code", "Name"], ["A-1", "Alpha"], ["B-1", "Beta"], ["C-1", "Gamma"]]);
    const { data } = await (await confirmRoute(post(BASE, { file }))).json();
    expect(data.created).toBe(0);
    expect(data.failed).toHaveLength(3);
    expect(lib.createProduct).toHaveBeenCalledTimes(1);
  });

  it("rejects a file that is not a spreadsheet and one that is too large, writing nothing", async () => {
    expect((await confirmRoute(post(BASE, {}))).status).toBe(400);
    const big = new File([new Uint8Array(5 * 1024 * 1024 + 1)], "big.csv");
    expect((await confirmRoute(post(BASE, { file: big }))).status).toBe(413);
    expect(lib.createProduct).not.toHaveBeenCalled();
  });

  describe("updating a card", () => {
    beforeEach(() => {
      state.codes = [{ id: "prod_1", codeKey: "WP12" }];
    });
    const COLOURS = [
      ["Product code", "Colour code", "Colour name", "Available"],
      ["WP-12", "12-02", "Gris foncé", "oui"],
      ["WP-12", "12-03", "Vert", "oui"],
    ];

    it("keeps what the file does not mention: pictures, colours not listed, related products, missing columns", async () => {
      lib.getProduct.mockResolvedValue(card({ status: "DRAFT" }));
      const file = xlsxFile([["Code", "Name", "Price"], ["wp 12", "Wallpaper 3D", "1200 DA"]], COLOURS);
      const { data } = await (await confirmRoute(post(BASE, { file }))).json();
      expect(data).toMatchObject({ created: 0, updated: 1 });
      expect(lib.createProduct).not.toHaveBeenCalled();
      const [workspaceId, id, input] = lib.updateProduct.mock.calls[0];
      expect([workspaceId, id]).toEqual(["ws_a", "prod_1"]);
      expect(input).toMatchObject({
        name: "Wallpaper 3D",
        price: "1200 DA",
        // No such columns in the file: the card's values stay.
        description: "Old description",
        available: true,
        strengths: ["Washable"],
        attributes: { thickness: 3, finish: "matt" },
        // The main picture and the related products are not the file's business.
        mainImageId: "img_main",
        related: [{ productId: "prod_9", note: "cheaper" }],
      });
      expect(input.variants).toEqual([
        { code: "12-01", name: "Blanc", available: true, price: null, imageId: "img_v1" }, // not listed: stays
        { code: "12-02", name: "Gris foncé", available: true, price: null, imageId: "img_v2" }, // updated, picture kept
        { code: "12-03", name: "Vert", available: true, price: null, imageId: null }, // new, last
      ]);
    });

    it("replaces the columns the file has, an empty cell included, and only those attributes", async () => {
      lib.getProduct.mockResolvedValue(card());
      const file = xlsxFile([["Code", "Name", "Description", "Available", "Finish"], ["WP-12", "Wallpaper", "", "non", "gloss"]]);
      await confirmRoute(post(BASE, { file }));
      expect(lib.updateProduct.mock.calls[0][2]).toMatchObject({
        description: null,
        available: false,
        // "Finish" has a column and is replaced; "Thickness" has none and stays.
        attributes: { thickness: 3, finish: "gloss" },
        price: "1000 DA",
      });
    });

    it("clears an attribute whose column is there but whose cell is empty", async () => {
      lib.getProduct.mockResolvedValue(card());
      const file = xlsxFile([["Code", "Name", "Thickness", "Finish"], ["WP-12", "Wallpaper", "", "matt"]]);
      await confirmRoute(post(BASE, { file }));
      expect(lib.updateProduct.mock.calls[0][2].attributes).toEqual({ finish: "matt" });
    });

    it("never archives or restores: a draft becomes ACTIVE, an archived card stays archived", async () => {
      const file = xlsxFile([["Code", "Name"], ["WP-12", "Renamed"]]);
      for (const [from, to] of [["DRAFT", "ACTIVE"], ["ARCHIVED", "ARCHIVED"], ["ACTIVE", "ACTIVE"]] as const) {
        lib.updateProduct.mockClear();
        lib.getProduct.mockResolvedValue(card({ status: from }));
        await confirmRoute(post(BASE, { file }));
        expect(lib.updateProduct.mock.calls[0][2].status).toBe(to);
      }
    });

    it("fails a row whose merged card is not valid (too many colours) without touching the card", async () => {
      const many = Array.from({ length: 60 }, (_, i) => ({
        id: `v${i}`, code: `C-${i}`, name: null, available: true, price: null, image: null, sortOrder: i,
      }));
      lib.getProduct.mockResolvedValue(card({ variants: many }));
      const file = xlsxFile([["Code", "Name"], ["WP-12", "Wallpaper"]], [["Product code", "Colour code"], ["WP-12", "NEW-1"]]);
      const { data } = await (await confirmRoute(post(BASE, { file }))).json();
      expect(data).toMatchObject({ updated: 0 });
      expect(data.failed).toHaveLength(1);
      expect(lib.updateProduct).not.toHaveBeenCalled();
    });

    it("changes nothing when the card already is what the file says (a second import)", async () => {
      lib.getProduct.mockResolvedValue(card());
      const file = xlsxFile(
        [["Code", "Name", "Price", "Description"], ["WP-12", "Wallpaper", "1000 DA", "Old description"]],
        [["Product code", "Colour code", "Colour name"], ["WP-12", "12-01", "Blanc"]]
      );
      const { data } = await (await confirmRoute(post(BASE, { file }))).json();
      expect(data).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
      expect(lib.updateProduct).not.toHaveBeenCalled();
      expect(lib.createProduct).not.toHaveBeenCalled();
    });

    it("answers a card deleted since the preview by creating it", async () => {
      lib.getProduct.mockResolvedValue(null);
      const file = xlsxFile([["Code", "Name"], ["WP-12", "Wallpaper"]]);
      const { data } = await (await confirmRoute(post(BASE, { file }))).json();
      expect(data.created).toBe(1);
    });
  });
});

describe("which columns a file has", () => {
  const present = (header: string[]) => {
    const found = importColumns([{ name: "Products", rows: [header, ["x"]] }], ATTRIBUTES as never);
    return { fields: [...found.fields].sort(), attributes: [...found.attributes].sort() };
  };

  it("finds a column however it is named, in Arabic, French or English", () => {
    expect(present(["Code", "Nom", "Prix", "الوصف"])).toEqual({ fields: ["code", "description", "name", "price"], attributes: [] });
    expect(present(["Name", "Thickness", "Surface"]).attributes).toEqual(["thickness"]);
  });

  it("knows every column of the brand's own template, and skips unknown or empty headers", () => {
    const header = buildImportTemplate(ATTRIBUTES as never)[0].rows[0];
    const found = present(header);
    expect(found.fields).toHaveLength(11);
    expect(found.attributes).toEqual(["finish", "thickness"]);
    expect(present(["Whatever", "", "Name"]).fields).toEqual(["name"]);
  });

  it("reports nothing for a sheet without a header", () => {
    expect(importColumns([], [])).toEqual({ fields: new Set(), attributes: new Set() });
    expect(importColumns([{ name: "Products", rows: [] }], [])).toEqual({ fields: new Set(), attributes: new Set() });
  });
});

describe("one picture of the folder", () => {
  const upload = (name: string, bytes = [1, 2, 3], extra: Record<string, string> = {}) =>
    imageRoute(post(`${BASE}/images`, { file: new File([new Uint8Array(bytes)], name), ...extra }));
  const product = (over: Record<string, unknown> = {}) => ({
    id: "prod_1",
    code: "WP-12",
    codeKey: "WP12",
    mainImageId: null,
    variants: [{ id: "v1", code: "12-01", codeKey: "1201", imageId: null }],
    ...over,
  });

  it("stores the picture on the card found by its name and makes it the main picture", async () => {
    state.candidates = [product()];
    const response = await upload("WP_12.JPG");
    expect(response.status).toBe(201);
    const { data } = await response.json();
    expect(data.target).toEqual({ productId: "prod_1", productCode: "WP-12", variantCode: null });
    expect(data.reused).toBe(false);
    expect(lib.storeProductImage).toHaveBeenCalledWith("ws_a", expect.objectContaining({ productId: "prod_1", fileName: "WP_12.JPG" }));
    expect(db.product.updateMany).toHaveBeenCalledWith({ where: { id: "prod_1", workspaceId: "ws_a" }, data: { mainImageId: "img_new" } });
    expect(db.productVariant.updateMany).not.toHaveBeenCalled();
  });

  it("makes it the colour's picture when the name is a colour's", async () => {
    state.candidates = [product()];
    for (const name of ["WP-12_12-01.jpg", "12-01.jpg"]) {
      db.productVariant.updateMany.mockClear();
      const { data } = await (await upload(name)).json();
      expect(data.target.variantCode).toBe("12-01");
      expect(db.productVariant.updateMany).toHaveBeenCalledWith({
        where: { id: "v1", productId: "prod_1", workspaceId: "ws_a" },
        data: { imageId: "img_new" },
      });
    }
    expect(db.product.updateMany).not.toHaveBeenCalled();
  });

  it("looks the cards up by the keys the name could mean, inside the brand", async () => {
    state.candidates = [product()];
    await upload("WP-12_12-01.jpg");
    const where = db.product.findMany.mock.calls.at(-1)![0].where;
    expect(where.workspaceId).toBe("ws_a");
    expect(where.OR[0].codeKey.in).toEqual(expect.arrayContaining(["WP12", "1201"]));
  });

  it("stores the same picture once: it is reused, and nothing is linked twice", async () => {
    state.candidates = [product({ mainImageId: "img_old" })];
    db.productImage.findFirst.mockResolvedValue({ id: "img_old", publicId: "o".repeat(32), mimeType: "image/jpeg", size: 3, fileName: "WP-12.jpg" });
    const response = await upload("WP-12.jpg");
    expect(response.status).toBe(200);
    expect((await response.json()).data.reused).toBe(true);
    expect(lib.storeProductImage).not.toHaveBeenCalled();
    expect(db.product.updateMany).not.toHaveBeenCalled();
    const where = db.productImage.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({ workspaceId: "ws_a", productId: "prod_1" });
    expect(where.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("stores nothing for a name that matches nothing or could mean two things", async () => {
    state.candidates = [];
    const none = await upload("zzz.jpg");
    expect(none.status).toBe(422);
    expect((await none.json()).code).toBe("unmatched");
    // "12" is one card's code and another's colour.
    state.candidates = [
      product({ code: "12", codeKey: "12", variants: [] }),
      product({ id: "prod_2", code: "WP-99", codeKey: "WP99", variants: [{ id: "v9", code: "12", codeKey: "12", imageId: null }] }),
    ];
    expect((await upload("12.jpg")).status).toBe(422);
    expect(lib.storeProductImage).not.toHaveBeenCalled();
  });

  it("passes the storage limits on: not an image, too large, no room", async () => {
    state.candidates = [product()];
    for (const [error, status] of [["not_an_image", 400], ["too_large", 413], ["too_many", 400], ["empty", 400]] as const) {
      lib.storeProductImage.mockResolvedValueOnce({ ok: false, error });
      const response = await upload("WP-12.jpg");
      expect(response.status).toBe(status);
      expect((await response.json()).code).toBe(error);
    }
    expect(db.product.updateMany).not.toHaveBeenCalled();
  });

  it("refuses a body or a file larger than a picture may be, and a request without a file", async () => {
    vi.stubEnv("PRODUCT_IMAGE_MAX_BYTES", String(64 * 1024));
    expect((await upload("WP-12.jpg", new Array(64 * 1024 + 1).fill(1))).status).toBe(413);
    expect((await imageRoute(post(`${BASE}/images`, {}))).status).toBe(400);
    expect(lib.storeProductImage).not.toHaveBeenCalled();
  });
});

describe("the screen's copy", () => {
  it("has an Arabic text for every sentence the routes answer with", async () => {
    const { IMPORT_ERRORS, IMAGE_ERRORS } = await import("../../lib/catalog/import/apply");
    const catalog = ar as Record<string, string>;
    for (const { message } of [...Object.values(IMPORT_ERRORS), ...Object.values(IMAGE_ERRORS)]) {
      expect(catalog[message], message).toBeTruthy();
    }
  });
});
