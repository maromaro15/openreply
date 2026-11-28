import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "../../app/generated/prisma/client";

/**
 * A small stand-in for the Prisma delegates the catalog uses: rows in memory,
 * filtered by the `where` the code sends (so a query without the brand's
 * workspaceId really does reach another brand's rows), with the relations,
 * the unique indexes, and a $transaction that rolls back on error.
 */
const fake = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  type Where = Record<string, unknown>;
  interface Args {
    where?: Where;
    orderBy?: unknown;
    take?: number;
    select?: Row;
    include?: Row;
  }
  interface Relation {
    table: string;
    kind: "one" | "many";
    local: string;
    foreign: string;
  }

  const TABLES = ["product", "productVariant", "productImage", "productRelation", "productAttribute", "knowledgeEntry"];
  const DEFAULTS: Record<string, Row> = {
    product: {
      status: "ACTIVE",
      source: "MANUAL",
      sourceRef: null,
      code: null,
      codeKey: null,
      price: null,
      available: true,
      landingUrl: null,
      description: null,
      howToUse: null,
      attributes: {},
      strengths: [],
      comparisons: null,
      suitableFor: null,
      objections: [],
      mainImageId: null,
    },
    productVariant: { name: null, available: true, price: null, imageId: null, sortOrder: 0 },
    productImage: { productId: null, mimeType: "image/jpeg", size: 1000, sha256: "0", fileName: null },
    productRelation: { note: null },
    productAttribute: { type: "TEXT", unit: null, options: [], sortOrder: 0 },
    knowledgeEntry: { content: "", price: null, isActive: true, sortOrder: 0 },
  };
  const UNIQUE: Record<string, string[][]> = {
    product: [["workspaceId", "codeKey"]],
    productVariant: [["productId", "codeKey"]],
    productImage: [["publicId"]],
    productRelation: [["productId", "relatedId"]],
    productAttribute: [["workspaceId", "key"]],
  };
  const RELATIONS: Record<string, Record<string, Relation>> = {
    product: {
      mainImage: { table: "productImage", kind: "one", local: "mainImageId", foreign: "id" },
      images: { table: "productImage", kind: "many", local: "id", foreign: "productId" },
      variants: { table: "productVariant", kind: "many", local: "id", foreign: "productId" },
      related: { table: "productRelation", kind: "many", local: "id", foreign: "productId" },
    },
    productVariant: {
      product: { table: "product", kind: "one", local: "productId", foreign: "id" },
      image: { table: "productImage", kind: "one", local: "imageId", foreign: "id" },
    },
    productRelation: {
      related: { table: "product", kind: "one", local: "relatedId", foreign: "id" },
    },
  };

  const tables: Record<string, Row[]> = {};
  const settings = { uniqueError: (): Error => new Error("Unique constraint failed") };
  let sequence = 0;
  let clock = 0;

  /** Each write a second after the previous one, so updatedAt orders rows. */
  function tick(): Date {
    clock += 1000;
    return new Date(Date.UTC(2026, 10, 25, 12) + clock);
  }

  function same(a: unknown, b: unknown): boolean {
    return a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b;
  }

  function compare(a: unknown, b: unknown): number {
    const x = a instanceof Date ? a.getTime() : a;
    const y = b instanceof Date ? b.getTime() : b;
    if (typeof x === "number" && typeof y === "number") return x - y;
    const left = String(x);
    const right = String(y);
    return left < right ? -1 : left > right ? 1 : 0;
  }

  function linked(row: Row, relation: Relation): Row[] {
    const value = row[relation.local];
    if (value === null || value === undefined) return [];
    return tables[relation.table].filter((other) => other[relation.foreign] === value);
  }

  function matches(table: string, row: Row, where: Where | undefined): boolean {
    if (!where) return true;
    return Object.entries(where).every(([field, condition]) => {
      if (field === "AND") return (condition as Where[]).every((part) => matches(table, row, part));
      if (field === "OR") return (condition as Where[]).some((part) => matches(table, row, part));
      if (field === "NOT") return !matches(table, row, condition as Where);
      const relation = RELATIONS[table]?.[field];
      if (relation) return linked(row, relation).some((other) => matches(relation.table, other, condition as Where));
      const value = row[field];
      if (condition === null || typeof condition !== "object" || condition instanceof Date) return same(value, condition);
      const filter = condition as Record<string, unknown>;
      return Object.entries(filter).every(([operator, operand]) => {
        switch (operator) {
          case "in":
            return (operand as unknown[]).some((item) => same(value, item));
          case "not":
            return !same(value, operand);
          case "lt":
            return compare(value, operand) < 0;
          case "contains":
            if (typeof value !== "string") return false;
            return filter.mode === "insensitive"
              ? value.toLowerCase().includes(String(operand).toLowerCase())
              : value.includes(String(operand));
          case "mode":
            return true;
          default:
            throw new Error(`fake db: no operator ${operator}`);
        }
      });
    });
  }

  function sorted(table: string, rows: Row[], orderBy: unknown): Row[] {
    const rules = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []) as Row[];
    const sortKey = (row: Row, rule: Row): [unknown, unknown] => {
      const [field, direction] = Object.entries(rule)[0];
      const relation = RELATIONS[table]?.[field];
      if (!relation) return [row[field], direction];
      const [nested, nestedDirection] = Object.entries(direction as Row)[0];
      return [linked(row, relation)[0]?.[nested], nestedDirection];
    };
    return [...rows].sort((a, b) => {
      for (const rule of rules) {
        const [x, direction] = sortKey(a, rule);
        const order = compare(x, sortKey(b, rule)[0]);
        if (order) return direction === "desc" ? -order : order;
      }
      return 0;
    });
  }

  function shape(table: string, row: Row, args: Args = {}): Row {
    const spec = args.select ?? args.include ?? {};
    const out: Row = args.select ? {} : { ...row };
    for (const [field, value] of Object.entries(spec)) {
      if (!value) continue;
      if (field === "_count") {
        const counts: Row = {};
        for (const [name, countArgs] of Object.entries((value as { select: Row }).select)) {
          const relation = RELATIONS[table][name];
          const where = countArgs === true ? undefined : (countArgs as Args).where;
          counts[name] = linked(row, relation).filter((other) => matches(relation.table, other, where)).length;
        }
        out._count = counts;
        continue;
      }
      const relation = RELATIONS[table]?.[field];
      if (!relation) {
        out[field] = row[field];
        continue;
      }
      const found = query(relation.table, linked(row, relation), value === true ? {} : (value as Args));
      out[field] = relation.kind === "one" ? (found[0] ?? null) : found;
    }
    return out;
  }

  function query(table: string, rows: Row[], args: Args = {}): Row[] {
    const found = sorted(
      table,
      rows.filter((row) => matches(table, row, args.where)),
      args.orderBy
    );
    return (args.take === undefined ? found : found.slice(0, args.take)).map((row) => shape(table, row, args));
  }

  function checkUnique(table: string, candidate: Row, self?: Row) {
    for (const fields of UNIQUE[table] ?? []) {
      if (fields.some((field) => candidate[field] === null || candidate[field] === undefined)) continue;
      const clash = tables[table].some(
        (other) => other !== self && fields.every((field) => same(other[field], candidate[field]))
      );
      if (clash) throw settings.uniqueError();
    }
  }

  function insert(table: string, data: Row): Row {
    const at = tick();
    const row: Row = { id: `${table}_${++sequence}`, createdAt: at, updatedAt: at, ...structuredClone(DEFAULTS[table]), ...data };
    checkUnique(table, row);
    tables[table].push(row);
    return row;
  }

  function model(table: string) {
    return {
      findMany: vi.fn(async (args: Args = {}) => query(table, tables[table], args)),
      findFirst: vi.fn(async (args: Args = {}): Promise<Row | null> => query(table, tables[table], args)[0] ?? null),
      count: vi.fn(async (args: Args = {}) => tables[table].filter((row) => matches(table, row, args.where)).length),
      create: vi.fn(async (args: Args & { data: Row }) => shape(table, insert(table, args.data), args)),
      createMany: vi.fn(async ({ data }: { data: Row[] }) => ({ count: data.map((row) => insert(table, row)).length })),
      updateMany: vi.fn(async ({ where, data }: { where?: Where; data: Row }) => {
        const hit = tables[table].filter((row) => matches(table, row, where));
        const at = tick();
        for (const row of hit) {
          checkUnique(table, { ...row, ...data }, row);
          Object.assign(row, data, { updatedAt: at });
        }
        return { count: hit.length };
      }),
      deleteMany: vi.fn(async ({ where }: { where?: Where } = {}) => {
        const before = tables[table].length;
        tables[table] = tables[table].filter((row) => !matches(table, row, where));
        return { count: before - tables[table].length };
      }),
    };
  }

  const models = {
    product: model("product"),
    productVariant: model("productVariant"),
    productImage: model("productImage"),
    productRelation: model("productRelation"),
    productAttribute: model("productAttribute"),
    knowledgeEntry: model("knowledgeEntry"),
  };
  const db = {
    ...models,
    // The callback gets the same delegates; an error restores every table.
    $transaction: vi.fn(async (work: (tx: typeof models) => Promise<unknown>) => {
      const before = structuredClone(tables);
      try {
        return await work(models);
      } catch (error) {
        for (const name of TABLES) tables[name] = before[name];
        throw error;
      }
    }),
  };

  return {
    db,
    tables,
    settings,
    reset() {
      for (const name of TABLES) tables[name] = [];
      sequence = 0;
      clock = 0;
    },
    seed(table: string, data: Row): Row {
      return insert(table, data);
    },
  };
});

vi.mock("@/lib/db/client", () => ({ prisma: fake.db }));

import {
  convertKnowledgeProduct,
  createProduct,
  deleteProduct,
  findByCodeKey,
  getProduct,
  listProducts,
  MAX_PRODUCTS,
  productInputSchema,
  setProductStatus,
  updateProduct,
  type ProductDetail,
  type ProductResult,
} from "../../lib/catalog/products";

fake.settings.uniqueError = () =>
  new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "7" });

const { db, tables } = fake;

type Row = Record<string, unknown>;

const card = (fields: Row = {}) => productInputSchema.parse({ name: "Lambris Bois", ...fields });
const rows = (table: string, workspaceId = "ws_a") => tables[table].filter((row) => row.workspaceId === workspaceId);
const row = (table: string, id: string) => tables[table].find((candidate) => candidate.id === id);
const snapshot = () => structuredClone(tables);

function saved(result: ProductResult): ProductDetail {
  if (!result.ok) throw new Error(`Expected a card, got ${result.error} (${result.detail ?? "no detail"})`);
  return result.product;
}

const imageRef = (id: string, publicId: string, fileName: string | null = null) => ({
  id,
  publicId,
  path: `/api/public/media/${publicId}`,
  mimeType: "image/jpeg",
  size: 1000,
  fileName,
});

/** Every query and write the catalog sent, with its arguments. */
function calls() {
  const all: { table: string; method: string; args: Row }[] = [];
  for (const [table, delegate] of Object.entries(db)) {
    if (table === "$transaction") continue;
    for (const [method, mock] of Object.entries(delegate as unknown as Record<string, { mock: { calls: unknown[][] } }>)) {
      for (const call of mock.mock.calls) all.push({ table, method, args: (call[0] ?? {}) as Row });
    }
  }
  return all;
}

const WRITES = ["create", "createMany", "updateMany", "deleteMany"];
const writes = () => calls().filter((call) => WRITES.includes(call.method));

/** Each query names the brand, and so does each row it writes. */
function expectScopedTo(workspaceId: string) {
  const sent = calls();
  expect(sent.length).toBeGreaterThan(0);
  for (const { table, method, args } of sent) {
    const label = `${table}.${method}`;
    if (method === "create") expect([label, (args.data as Row).workspaceId]).toEqual([label, workspaceId]);
    else if (method === "createMany") {
      for (const data of args.data as Row[]) expect([label, data.workspaceId]).toEqual([label, workspaceId]);
    } else expect([label, (args.where as Row | undefined)?.workspaceId]).toEqual([label, workspaceId]);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  fake.reset();
  // Brand A's template.
  fake.seed("productAttribute", { id: "attr_thick", workspaceId: "ws_a", key: "thickness", label: "Épaisseur", type: "NUMBER", unit: "mm" });
  fake.seed("productAttribute", { id: "attr_mat", workspaceId: "ws_a", key: "material", label: "Matière", type: "CHOICE", options: ["PVC", "Bois"], sortOrder: 1 });
  fake.seed("productAttribute", { id: "attr_water", workspaceId: "ws_a", key: "waterproof", label: "Étanche", type: "BOOLEAN", sortOrder: 2 });
  fake.seed("productAttribute", { id: "attr_b", workspaceId: "ws_b", key: "colour", label: "Couleur", type: "TEXT" });
  // Brand A's catalog.
  fake.seed("product", { id: "p_wall", workspaceId: "ws_a", name: "Lambris PVC", code: "WP-12", codeKey: "WP12", price: "1200 DA", attributes: { thickness: 8 } });
  fake.seed("product", { id: "p_skirt", workspaceId: "ws_a", name: "Plinthe", code: "PL-3", codeKey: "PL3" });
  fake.seed("productVariant", { id: "v_12", workspaceId: "ws_a", productId: "p_wall", code: "12", codeKey: "12", name: "Blanc", sortOrder: 0 });
  fake.seed("productVariant", { id: "v_17", workspaceId: "ws_a", productId: "p_wall", code: "17", codeKey: "17", name: "Gris", sortOrder: 1 });
  fake.seed("productImage", { id: "img_free", workspaceId: "ws_a", publicId: "pub_free", fileName: "WB-7.jpg", data: new Uint8Array([1]) });
  fake.seed("productImage", { id: "img_wall", workspaceId: "ws_a", productId: "p_wall", publicId: "pub_wall", data: new Uint8Array([2]) });
  fake.seed("productImage", { id: "img_skirt", workspaceId: "ws_a", productId: "p_skirt", publicId: "pub_skirt", data: new Uint8Array([3]) });
  // Brand B, with the same code as brand A.
  fake.seed("product", { id: "p_rival", workspaceId: "ws_b", name: "Lambris rival", code: "WP-12", codeKey: "WP12" });
  fake.seed("productImage", { id: "img_b", workspaceId: "ws_b", publicId: "pub_b", data: new Uint8Array([4]) });
  // Knowledge bases (phase 7).
  fake.seed("knowledgeEntry", { id: "k_robe", workspaceId: "ws_a", kind: "PRODUCT", title: "Robe Kabyle", content: "S à XL", price: "4500 DA", isActive: false });
  fake.seed("knowledgeEntry", { id: "k_faq", workspaceId: "ws_a", kind: "FAQ", title: "Paiement ?", content: "À la livraison" });
  fake.seed("knowledgeEntry", { id: "k_b", workspaceId: "ws_b", kind: "PRODUCT", title: "Robe rivale" });
  vi.clearAllMocks();
});

describe("productInputSchema", () => {
  const long = (length: number) => "x".repeat(length);

  it("fills the defaults, and an empty text is none", () => {
    expect(
      productInputSchema.parse({
        name: " Lambris ",
        code: "",
        price: "  ",
        landingUrl: "",
        description: "",
        howToUse: " ",
        comparisons: "",
        suitableFor: "",
        mainImageId: "",
      })
    ).toEqual({
      name: "Lambris",
      code: null,
      price: null,
      available: true,
      status: "ACTIVE",
      landingUrl: null,
      description: null,
      howToUse: null,
      attributes: {},
      strengths: [],
      comparisons: null,
      suitableFor: null,
      objections: [],
      variants: [],
      related: [],
      mainImageId: null,
    });
  });

  it("trims every text, in the colours, the objections and the relations too", () => {
    expect(
      productInputSchema.parse({
        name: "Lambris",
        code: " WP-12 ",
        price: " 1200 DA ",
        landingUrl: " https://shop.example/wp-12 ",
        strengths: [" Étanche "],
        objections: [{ question: " Ça tient ? ", answer: " Oui, 10 ans. " }],
        variants: [{ code: " 12 ", name: " Blanc ", price: "", imageId: "" }],
        related: [{ productId: " p_skirt ", note: " " }],
      })
    ).toMatchObject({
      code: "WP-12",
      price: "1200 DA",
      landingUrl: "https://shop.example/wp-12",
      strengths: ["Étanche"],
      objections: [{ question: "Ça tient ?", answer: "Oui, 10 ans." }],
      variants: [{ code: "12", name: "Blanc", available: true, price: null, imageId: null }],
      related: [{ productId: "p_skirt", note: null }],
    });
  });

  it.each([
    ["name", { name: "" }],
    ["name", { name: "   " }],
    ["name", { name: long(201) }],
    ["code", { code: long(61) }],
    ["code", { code: " -- " }],
    ["price", { price: long(101) }],
    ["status", { status: "DELETED" }],
    ["landingUrl", { landingUrl: `https://shop.example/${long(1980)}` }],
    ["description", { description: long(4001) }],
    ["howToUse", { howToUse: long(4001) }],
    ["attributes", { attributes: ["thickness"] }],
    ["strengths", { strengths: Array(21).fill("Solide") }],
    ["strengths", { strengths: [long(301)] }],
    ["strengths", { strengths: [" "] }],
    ["comparisons", { comparisons: long(4001) }],
    ["suitableFor", { suitableFor: long(2001) }],
    ["objections", { objections: Array(31).fill({ question: "?", answer: "!" }) }],
    ["objections", { objections: [{ question: long(301), answer: "!" }] }],
    ["objections", { objections: [{ question: "?", answer: long(1001) }] }],
    ["objections", { objections: [{ question: "?", answer: " " }] }],
    ["variants", { variants: Array.from({ length: 61 }, (_, index) => ({ code: `C${index}` })) }],
    ["variants", { variants: [{ code: "" }] }],
    ["variants", { variants: [{ code: "/" }] }],
    ["variants", { variants: [{ code: long(61) }] }],
    ["variants", { variants: [{ code: "12", name: long(81) }] }],
    ["variants", { variants: [{ code: "12", price: long(101) }] }],
    ["related", { related: Array.from({ length: 21 }, (_, index) => ({ productId: `p_${index}` })) }],
    ["related", { related: [{ productId: "" }] }],
    ["related", { related: [{ productId: "p_skirt", note: long(101) }] }],
  ])("refuses %s out of bounds (%#)", (field, fields) => {
    const result = productInputSchema.safeParse({ name: "Lambris", ...fields });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].path[0]).toBe(field);
  });

  it("accepts every field at its limit", () => {
    const result = productInputSchema.safeParse({
      name: long(200),
      code: long(60),
      price: long(100),
      landingUrl: `https://shop.example/${long(1979)}`,
      description: long(4000),
      howToUse: long(4000),
      strengths: Array(20).fill(long(300)),
      comparisons: long(4000),
      suitableFor: long(2000),
      objections: Array(30).fill({ question: long(300), answer: long(1000) }),
      variants: Array.from({ length: 60 }, (_, index) => ({ code: `C${index}`, name: long(80), price: long(100) })),
      related: Array.from({ length: 20 }, (_, index) => ({ productId: `p_${index}`, note: long(100) })),
    });
    expect(result.success).toBe(true);
  });

  it.each([
    "javascript:alert(1)",
    "JavaScript:alert(document.cookie)",
    "  javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "ftp://shop.example/catalog.pdf",
    "mailto:shop@example.com",
    "//shop.example/lambris",
    "/lambris",
    "shop.example/lambris",
    "https://",
    "https://shop example.com",
    "https://shop.example/\u0000",
  ])("refuses the landing link %j", (landingUrl) => {
    const result = productInputSchema.safeParse({ name: "Lambris", landingUrl });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ path: ["landingUrl"] });
  });

  it.each(["https://shop.example/lambris?utm_source=fb", "http://shop.example", "HTTPS://SHOP.EXAMPLE/WP-12"])(
    "accepts the landing link %j",
    (landingUrl) => {
      expect(productInputSchema.parse({ name: "Lambris", landingUrl }).landingUrl).toBe(landingUrl);
    }
  );

  it("refuses two colours with one code, however it is written", () => {
    const result = productInputSchema.safeParse({ name: "Lambris", variants: [{ code: "WP-12" }, { code: "13" }, { code: "wp 12" }] });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ path: ["variants", 2, "code"], message: "The code wp 12 is used twice." });
    expect(productInputSchema.safeParse({ name: "Lambris", variants: [{ code: "١٢" }, { code: "12" }] }).success).toBe(false);
  });
});

describe("createProduct", () => {
  it("saves a whole card in the brand, with its colours, images and relations", async () => {
    const product = saved(
      await createProduct(
        "ws_a",
        card({
          code: "WB-7",
          price: "1500 DA",
          landingUrl: "https://shop.example/wb-7",
          description: "Lambris en bois traité.",
          howToUse: "Clipser sur les tasseaux.",
          attributes: { thickness: "1,5", material: "bois", waterproof: "oui", colour: "rouge", unknown: 1 },
          strengths: ["Naturel"],
          comparisons: "Plus chaud que le PVC.",
          suitableFor: "Salon, chambre",
          objections: [{ question: "Ça gonfle ?", answer: "Non, il est traité." }],
          variants: [
            { code: "W-1", name: "Chêne", imageId: "img_free" },
            { code: "W-2", name: "Noyer", available: false, price: "1700 DA" },
          ],
          related: [
            { productId: "p_wall", note: "moins cher" },
            { productId: "p_wall", note: "doublon" },
          ],
          mainImageId: "img_free",
        })
      )
    );

    const free = imageRef("img_free", "pub_free", "WB-7.jpg");
    expect(product).toEqual({
      id: expect.any(String),
      status: "ACTIVE",
      source: "MANUAL",
      sourceRef: null,
      name: "Lambris Bois",
      code: "WB-7",
      price: "1500 DA",
      available: true,
      landingUrl: "https://shop.example/wb-7",
      description: "Lambris en bois traité.",
      howToUse: "Clipser sur les tasseaux.",
      // Brand B's attribute and an unknown key are dropped; the rest coerced.
      attributes: { thickness: 1.5, material: "Bois", waterproof: true },
      strengths: ["Naturel"],
      comparisons: "Plus chaud que le PVC.",
      suitableFor: "Salon, chambre",
      objections: [{ question: "Ça gonfle ?", answer: "Non, il est traité." }],
      mainImage: free,
      images: [free],
      variants: [
        { id: expect.any(String), code: "W-1", name: "Chêne", available: true, price: null, image: free, sortOrder: 0 },
        { id: expect.any(String), code: "W-2", name: "Noyer", available: false, price: "1700 DA", image: null, sortOrder: 1 },
      ],
      // One relation per product: the first note wins.
      related: [{ productId: "p_wall", name: "Lambris PVC", code: "WP-12", note: "moins cher" }],
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect(row("product", product.id)).toMatchObject({ workspaceId: "ws_a", codeKey: "WB7" });
    expect(row("productImage", "img_free")?.productId).toBe(product.id);
    expect(rows("productVariant").filter((variant) => variant.productId === product.id).map((variant) => variant.codeKey)).toEqual([
      "W1",
      "W2",
    ]);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expectScopedTo("ws_a");
  });

  it("keeps where an extracted card came from", async () => {
    const product = saved(
      await createProduct("ws_a", card({ status: "DRAFT" }), { source: "POST", sourceRef: "1234567890_987" })
    );
    expect(product).toMatchObject({ status: "DRAFT", source: "POST", sourceRef: "1234567890_987" });
  });

  it("refuses a code the brand already uses, however it is written, and writes nothing", async () => {
    const before = snapshot();
    expect(await createProduct("ws_a", card({ code: "wp 12" }))).toEqual({ ok: false, error: "duplicate_code", detail: "wp 12" });
    expect(tables).toEqual(before);
    expect(writes()).toEqual([]);
  });

  it("lets another brand use the same code", async () => {
    expect(saved(await createProduct("ws_b", card({ code: "PL 3" }))).code).toBe("PL 3");
    expectScopedTo("ws_b");
  });

  it("answers duplicate_code when another save takes the code at the same moment", async () => {
    // The check ran before the other save's commit: the unique index refuses this one.
    db.product.findFirst.mockResolvedValueOnce(null);
    expect(await createProduct("ws_a", card({ code: "WP_12" }))).toEqual({
      ok: false,
      error: "duplicate_code",
      detail: "WP_12",
    });
    expect(rows("product")).toHaveLength(2);
  });

  it("refuses attribute values that don't fit the template, with the first message", async () => {
    const before = snapshot();
    expect(await createProduct("ws_a", card({ attributes: { thickness: "épais", material: "Métal" } }))).toEqual({
      ok: false,
      error: "invalid_attributes",
      detail: "Épaisseur: write a number, like 12 or 1.5.",
    });
    expect(tables).toEqual(before);
    expect(writes()).toEqual([]);
  });

  it.each([
    ["img_b", "of another brand"],
    ["img_skirt", "of another product"],
    ["img_gone", "that doesn't exist"],
  ])("refuses an image %s (%s)", async (imageId) => {
    const before = snapshot();
    expect(await createProduct("ws_a", card({ mainImageId: imageId }))).toEqual({
      ok: false,
      error: "unknown_image",
      detail: imageId,
    });
    expect(await createProduct("ws_a", card({ variants: [{ code: "1", imageId }] }))).toEqual({
      ok: false,
      error: "unknown_image",
      detail: imageId,
    });
    expect(tables).toEqual(before);
    expect(writes()).toEqual([]);
  });

  it.each([["p_rival"], ["p_gone"]])("refuses to relate %s, not a product of the brand", async (productId) => {
    const before = snapshot();
    expect(await createProduct("ws_a", card({ related: [{ productId: "p_skirt" }, { productId }] }))).toEqual({
      ok: false,
      error: "unknown_related",
      detail: productId,
    });
    expect(tables).toEqual(before);
  });

  it("stops at MAX_PRODUCTS", async () => {
    db.product.count.mockResolvedValueOnce(MAX_PRODUCTS);
    expect(await createProduct("ws_a", card())).toEqual({ ok: false, error: "too_many" });
    expect(db.product.count).toHaveBeenCalledWith({ where: { workspaceId: "ws_a" } });
    expect(writes()).toEqual([]);
  });

  it("rolls the card back when another card takes its image between the check and the write", async () => {
    const before = snapshot();
    db.productImage.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await createProduct("ws_a", card({ mainImageId: "img_free" }))).toEqual({ ok: false, error: "unknown_image" });
    expect(db.product.create).toHaveBeenCalledTimes(1);
    expect(tables).toEqual(before);
  });
});

describe("updateProduct", () => {
  const wall = (fields: Row = {}) =>
    card({
      name: "Lambris PVC",
      code: "WP-12",
      price: "1200 DA",
      variants: [
        { code: "12", name: "Blanc" },
        { code: "17", name: "Gris" },
      ],
      ...fields,
    });

  it("replaces the card; a colour whose code stays keeps its id", async () => {
    const product = saved(
      await updateProduct(
        "ws_a",
        "p_wall",
        wall({
          name: "Lambris PVC 8 mm",
          status: "DRAFT",
          attributes: { thickness: 10 },
          variants: [
            { code: "21", name: "Beige" },
            { code: "١٢", name: "Blanc cassé", imageId: "img_wall" },
          ],
          related: [{ productId: "p_skirt", note: "pour finir" }],
        })
      )
    );
    const added = rows("productVariant").find((variant) => variant.codeKey === "21");
    expect(product).toMatchObject({
      id: "p_wall",
      name: "Lambris PVC 8 mm",
      status: "DRAFT",
      code: "WP-12",
      attributes: { thickness: 10 },
      variants: [
        { id: added?.id, code: "21", name: "Beige", image: null, sortOrder: 0 },
        { id: "v_12", code: "١٢", name: "Blanc cassé", image: imageRef("img_wall", "pub_wall"), sortOrder: 1 },
      ],
      related: [{ productId: "p_skirt", name: "Plinthe", code: "PL-3", note: "pour finir" }],
    });
    expect(row("productVariant", "v_17")).toBeUndefined();
    expect(row("productVariant", "v_12")).toMatchObject({ codeKey: "12", workspaceId: "ws_a" });
    expect(added).toMatchObject({ workspaceId: "ws_a", productId: "p_wall" });
    expectScopedTo("ws_a");

    // Relations are replaced as a whole.
    expect(saved(await updateProduct("ws_a", "p_wall", wall())).related).toEqual([]);
    expect(rows("productRelation")).toEqual([]);
  });

  it("rewrites only the colours that changed", async () => {
    saved(await updateProduct("ws_a", "p_wall", wall()));
    expect(db.productVariant.updateMany).not.toHaveBeenCalled();
    expect(db.productVariant.createMany).not.toHaveBeenCalled();
    expect(db.productVariant.deleteMany).not.toHaveBeenCalled();

    const product = saved(
      await updateProduct("ws_a", "p_wall", wall({ variants: [{ code: "17", name: "Gris" }, { code: "12", name: "Blanc" }] }))
    );
    expect(product.variants.map((variant) => [variant.id, variant.sortOrder])).toEqual([
      ["v_17", 0],
      ["v_12", 1],
    ]);
    expect(db.productVariant.updateMany).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["ws_b", "p_wall"],
    ["ws_a", "p_rival"],
    ["ws_a", "p_gone"],
  ])("in %s, %s is not found and nothing is written", async (workspaceId, id) => {
    const before = snapshot();
    expect(await updateProduct(workspaceId, id, wall({ name: "Pirate", code: "XX-1" }))).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(tables).toEqual(before);
    expect(writes()).toEqual([]);
  });

  it("keeps its own code, however rewritten, but can't take another product's", async () => {
    expect(saved(await updateProduct("ws_a", "p_wall", wall({ code: "WP 12" }))).code).toBe("WP 12");
    expect(row("product", "p_wall")?.codeKey).toBe("WP12");
    expect(await updateProduct("ws_a", "p_skirt", card({ name: "Plinthe", code: "wp-12" }))).toEqual({
      ok: false,
      error: "duplicate_code",
      detail: "wp-12",
    });
    expect(row("product", "p_skirt")).toMatchObject({ code: "PL-3", codeKey: "PL3" });
  });

  it("may use its own images, or a free one, but not another product's", async () => {
    expect(saved(await updateProduct("ws_a", "p_wall", wall({ mainImageId: "img_wall" }))).mainImage).toEqual(
      imageRef("img_wall", "pub_wall")
    );
    const product = saved(await updateProduct("ws_a", "p_wall", wall({ mainImageId: "img_free" })));
    expect(product.mainImage?.id).toBe("img_free");
    expect(product.images.map((image) => image.id)).toEqual(["img_free", "img_wall"]);
    expect(row("productImage", "img_free")?.productId).toBe("p_wall");
    expect(await updateProduct("ws_a", "p_wall", wall({ mainImageId: "img_skirt" }))).toEqual({
      ok: false,
      error: "unknown_image",
      detail: "img_skirt",
    });
    expect(await updateProduct("ws_a", "p_wall", wall({ variants: [{ code: "12", imageId: "img_b" }] }))).toEqual({
      ok: false,
      error: "unknown_image",
      detail: "img_b",
    });
  });

  it("can't be related to itself", async () => {
    expect(await updateProduct("ws_a", "p_wall", wall({ related: [{ productId: "p_wall" }] }))).toEqual({
      ok: false,
      error: "unknown_related",
      detail: "p_wall",
    });
  });

  it("refuses attribute values that don't fit, and keeps the card as it was", async () => {
    const before = snapshot();
    expect(await updateProduct("ws_a", "p_wall", wall({ attributes: { waterproof: "peut-être" } }))).toEqual({
      ok: false,
      error: "invalid_attributes",
      detail: "Étanche: answer yes or no.",
    });
    expect(tables).toEqual(before);
  });
});

describe("getProduct", () => {
  it("reads a card of the brand only", async () => {
    expect(await getProduct("ws_b", "p_wall")).toBeNull();
    expectScopedTo("ws_b");
    vi.clearAllMocks();
    expect(await getProduct("ws_a", "p_rival")).toBeNull();
    const product = await getProduct("ws_a", "p_wall");
    expect(product).toMatchObject({
      id: "p_wall",
      name: "Lambris PVC",
      code: "WP-12",
      mainImage: null,
      images: [imageRef("img_wall", "pub_wall")],
      variants: [
        { id: "v_12", code: "12", name: "Blanc", sortOrder: 0 },
        { id: "v_17", code: "17", name: "Gris", sortOrder: 1 },
      ],
    });
    expectScopedTo("ws_a");
  });

  it("never reads the image bytes, only what the public link needs", async () => {
    await getProduct("ws_a", "p_wall");
    await listProducts("ws_a");
    saved(await updateProduct("ws_a", "p_skirt", card({ name: "Plinthe", mainImageId: "img_free" })));
    const queries = calls().map((call) => JSON.stringify([call.args.select, call.args.include]));
    expect(queries.filter((query) => query.includes('"data":true'))).toEqual([]);
  });

  it("leaves out a deleted attribute's values, and values that no longer fit", async () => {
    Object.assign(row("product", "p_wall")!, {
      attributes: { thickness: 8, material: "Métal", gone: "x", waterproof: "oui" },
      objections: [{ question: "Ça tient ?", answer: "Oui." }, { question: 1 }, "x"],
    });
    expect(await getProduct("ws_a", "p_wall")).toMatchObject({
      attributes: { thickness: 8, waterproof: true },
      objections: [{ question: "Ça tient ?", answer: "Oui." }],
    });
  });
});

describe("listProducts", () => {
  it("lists the brand's products, newest first, with an image and the number of colours", async () => {
    const { products, nextCursor } = await listProducts("ws_a");
    expect(products).toEqual([
      {
        id: "p_skirt",
        name: "Plinthe",
        code: "PL-3",
        price: null,
        available: true,
        status: "ACTIVE",
        source: "MANUAL",
        image: imageRef("img_skirt", "pub_skirt"),
        variantCount: 0,
        updatedAt: expect.any(String),
      },
      {
        id: "p_wall",
        name: "Lambris PVC",
        code: "WP-12",
        price: "1200 DA",
        available: true,
        status: "ACTIVE",
        source: "MANUAL",
        image: imageRef("img_wall", "pub_wall"),
        variantCount: 2,
        updatedAt: expect.any(String),
      },
    ]);
    expect(nextCursor).toBeNull();
    expectScopedTo("ws_a");
  });

  it.each([
    ["lambris", ["p_wall"]],
    ["PLINTHE", ["p_skirt"]],
    ["wp 12", ["p_wall"]],
    ["WP_12", ["p_wall"]],
    ["wp-١٢", ["p_wall"]],
    ["pl3", ["p_skirt"]],
    ["rival", []],
    ["  ", ["p_skirt", "p_wall"]],
  ])("finds %j by its name or its code", async (search, ids) => {
    const { products } = await listProducts("ws_a", { search });
    expect(products.map((product) => product.id)).toEqual(ids);
  });

  it("filters by status", async () => {
    await setProductStatus("ws_a", "p_skirt", "DRAFT");
    expect((await listProducts("ws_a", { status: "DRAFT" })).products.map((product) => product.id)).toEqual(["p_skirt"]);
    expect((await listProducts("ws_a", { status: "ACTIVE" })).products.map((product) => product.id)).toEqual(["p_wall"]);
    expect((await listProducts("ws_a", { status: null })).products).toHaveLength(2);
  });

  it("pages with a cursor, every product once", async () => {
    for (const name of ["Corniche", "Rosace", "Moulure"]) fake.seed("product", { workspaceId: "ws_a", name });
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: Awaited<ReturnType<typeof listProducts>> = await listProducts("ws_a", { take: 2, cursor });
      expect(page.products.length).toBeLessThanOrEqual(2);
      seen.push(...page.products.map((product) => product.name));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toEqual(["Moulure", "Rosace", "Corniche", "Plinthe", "Lambris PVC"]);
  });

  it("keeps the page size between 1 and 200", async () => {
    await listProducts("ws_a", { take: 1000 });
    await listProducts("ws_a", { take: 0 });
    await listProducts("ws_a");
    expect(db.product.findMany.mock.calls.map((call) => (call[0] as Row).take)).toEqual([201, 2, 51]);
  });

  it("answers an empty page to a cursor it didn't make", async () => {
    expect(await listProducts("ws_a", { cursor: "not-a-cursor" })).toEqual({ products: [], nextCursor: null });
  });
});

describe("setProductStatus and deleteProduct", () => {
  it("change the brand's own products only", async () => {
    expect(await setProductStatus("ws_b", "p_wall", "ARCHIVED")).toBe(false);
    expect(await deleteProduct("ws_b", "p_wall")).toBe(false);
    expect(row("product", "p_wall")).toMatchObject({ status: "ACTIVE" });
    expectScopedTo("ws_b");

    expect(await setProductStatus("ws_a", "p_wall", "ARCHIVED")).toBe(true);
    expect(row("product", "p_wall")).toMatchObject({ status: "ARCHIVED" });
    expect(await deleteProduct("ws_a", "p_wall")).toBe(true);
    expect(db.product.deleteMany).toHaveBeenLastCalledWith({ where: { id: "p_wall", workspaceId: "ws_a" } });
    expect(row("product", "p_wall")).toBeUndefined();
  });
});

describe("convertKnowledgeProduct", () => {
  it("turns a simple product into a card and removes the entry, in one transaction", async () => {
    const product = saved(await convertKnowledgeProduct("ws_a", "k_robe"));
    expect(product).toMatchObject({
      name: "Robe Kabyle",
      price: "4500 DA",
      description: "S à XL",
      // An inactive product entry was out of stock.
      available: false,
      status: "ACTIVE",
      source: "MANUAL",
      code: null,
      attributes: {},
      variants: [],
    });
    expect(row("product", product.id)).toMatchObject({ workspaceId: "ws_a" });
    expect(row("knowledgeEntry", "k_robe")).toBeUndefined();
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expectScopedTo("ws_a");
  });

  it.each([
    ["ws_a", "k_faq"],
    ["ws_a", "k_b"],
    ["ws_b", "k_robe"],
    ["ws_a", "k_gone"],
  ])("in %s, %s is no product entry of the brand", async (workspaceId, entryId) => {
    const before = snapshot();
    expect(await convertKnowledgeProduct(workspaceId, entryId)).toEqual({ ok: false, error: "not_found" });
    expect(tables).toEqual(before);
    expect(writes()).toEqual([]);
  });

  it("stops at MAX_PRODUCTS, and keeps the entry", async () => {
    db.product.count.mockResolvedValueOnce(MAX_PRODUCTS);
    expect(await convertKnowledgeProduct("ws_a", "k_robe")).toEqual({ ok: false, error: "too_many" });
    expect(row("knowledgeEntry", "k_robe")).toBeDefined();
  });

  it("keeps one card when the entry is converted twice at the same moment", async () => {
    const before = snapshot();
    // The other conversion deleted the entry first.
    db.knowledgeEntry.deleteMany.mockResolvedValueOnce({ count: 0 });
    expect(await convertKnowledgeProduct("ws_a", "k_robe")).toEqual({ ok: false, error: "not_found" });
    expect(db.product.create).toHaveBeenCalledTimes(1);
    expect(tables).toEqual(before);
  });
});

describe("findByCodeKey", () => {
  it("finds the brand's active products by their code, or by a colour's", async () => {
    expect(await findByCodeKey("ws_a", "WP12")).toEqual([{ productId: "p_wall", name: "Lambris PVC", variant: null }]);
    expect(await findByCodeKey("ws_a", "wp-12")).toEqual([{ productId: "p_wall", name: "Lambris PVC", variant: null }]);
    expect(await findByCodeKey("ws_a", "17")).toEqual([
      { productId: "p_wall", name: "Lambris PVC", variant: { id: "v_17", code: "17", name: "Gris" } },
    ]);
    expectScopedTo("ws_a");
    vi.clearAllMocks();
    expect(await findByCodeKey("ws_b", "WP12")).toEqual([{ productId: "p_rival", name: "Lambris rival", variant: null }]);
    expectScopedTo("ws_b");
  });

  it("lists every product a colour code points at", async () => {
    fake.seed("productVariant", { id: "v_skirt_12", workspaceId: "ws_a", productId: "p_skirt", code: "12", codeKey: "12" });
    fake.seed("productVariant", { id: "v_rival_12", workspaceId: "ws_b", productId: "p_rival", code: "12", codeKey: "12" });
    expect(await findByCodeKey("ws_a", "١٢")).toEqual([
      { productId: "p_wall", name: "Lambris PVC", variant: { id: "v_12", code: "12", name: "Blanc" } },
      { productId: "p_skirt", name: "Plinthe", variant: { id: "v_skirt_12", code: "12", name: null } },
    ]);
  });

  it("names a product once, with the colour when a colour matched", async () => {
    fake.seed("productVariant", { id: "v_pl3", workspaceId: "ws_a", productId: "p_skirt", code: "PL3", codeKey: "PL3" });
    expect(await findByCodeKey("ws_a", "PL3")).toEqual([
      { productId: "p_skirt", name: "Plinthe", variant: { id: "v_pl3", code: "PL3", name: null } },
    ]);
  });

  it("ignores drafts and archived products", async () => {
    await setProductStatus("ws_a", "p_wall", "DRAFT");
    expect(await findByCodeKey("ws_a", "WP12")).toEqual([]);
    expect(await findByCodeKey("ws_a", "17")).toEqual([]);
    await setProductStatus("ws_a", "p_wall", "ARCHIVED");
    expect(await findByCodeKey("ws_a", "12")).toEqual([]);
  });

  it("matches nothing for an empty code, without a query", async () => {
    expect(await findByCodeKey("ws_a", " - ")).toEqual([]);
    expect(calls()).toEqual([]);
  });
});
