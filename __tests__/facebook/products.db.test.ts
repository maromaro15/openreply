/**
 * The product catalog on a real PostgreSQL: a whole card saved and read
 * back, codes unique in a brand once normalized (also under a race), colours
 * kept across saves, images and alternatives limited to the brand, what goes
 * with a deleted product, what the bot loads, and the daily clean-up of
 * pictures never attached. Skipped unless TEST_DATABASE_URL points at a
 * disposable database.
 */
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../../app/generated/prisma/client";

const state = vi.hoisted(() => ({
  db: undefined as unknown as import("../../app/generated/prisma/client").PrismaClient,
}));
vi.mock("@/lib/db/client", () => ({
  get prisma() {
    return state.db;
  },
}));

import { createAttribute } from "../../lib/catalog/attributes";
import {
  convertKnowledgeProduct,
  createProduct,
  deleteProduct,
  findByCodeKey,
  getProduct,
  listProducts,
  productInputSchema,
  updateProduct,
} from "../../lib/catalog/products";
import { readPublicImage, storeProductImage } from "../../lib/catalog/images";
import { loadCatalogForBot, rememberFocus } from "../../lib/catalog/bot";
import { pruneOrphanImages } from "../../lib/facebook/maintenance";

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIR = path.join(__dirname, "..", "..", "prisma", "migrations");
const schema = `facebook_products_${randomBytes(4).toString("hex")}`;
let sql: Client;

// A real 1×1 PNG and the start of a JPEG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01]);

/** A card as the editor sends it, through the real schema. */
const card = (fields: Record<string, unknown>) => productInputSchema.parse(fields);

async function image(workspaceId: string, bytes = PNG, productId: string | null = null) {
  const stored = await storeProductImage(workspaceId, { bytes, fileName: "photo.png", productId });
  if (!stored.ok) throw new Error(stored.error);
  return stored.image;
}

async function product(workspaceId: string, fields: Record<string, unknown>) {
  const result = await createProduct(workspaceId, card(fields));
  if (!result.ok) throw new Error(`${result.error} ${result.detail ?? ""}`);
  return result.product;
}

describe.skipIf(!databaseUrl)("The product catalog on PostgreSQL", () => {
  beforeAll(async () => {
    sql = new Client({ connectionString: databaseUrl });
    await sql.connect();
    await sql.query(`CREATE SCHEMA "${schema}"`);
    await sql.query(`SET search_path TO "${schema}"`);
    for (const dir of readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()) {
      await sql.query(readFileSync(path.join(MIGRATIONS_DIR, dir, "migration.sql"), "utf8"));
    }
    state.db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }, { schema }) });
    await state.db.user.create({ data: { id: "owner", email: "owner@agency.test" } });
    for (const id of ["ws_a", "ws_b"]) {
      await state.db.workspace.create({ data: { id, name: id, ownerId: "owner" } });
    }
    await state.db.facebookPage.create({
      data: { id: "fp_a", workspaceId: "ws_a", pageId: "1001", name: "Lina", accessToken: "enc" },
    });
  }, 60_000);

  afterAll(async () => {
    await state.db?.$disconnect();
    if (sql) {
      await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await sql.end();
    }
  });

  beforeEach(async () => {
    await state.db.facebookConversation.deleteMany({});
    await state.db.facebookCampaign.deleteMany({});
    await state.db.productRelation.deleteMany({});
    await state.db.productVariant.deleteMany({});
    await state.db.product.updateMany({ data: { mainImageId: null } });
    await state.db.productImage.deleteMany({});
    await state.db.product.deleteMany({});
    await state.db.productAttribute.deleteMany({});
    await state.db.knowledgeEntry.deleteMany({});
  });

  it("saves a whole card and reads it back, its pictures attached to it", async () => {
    await createAttribute("ws_a", { label: "السمك", type: "NUMBER", unit: "mm", options: [] });
    await createAttribute("ws_a", { label: "Matière", type: "CHOICE", unit: null, options: ["PVC", "Bois"] });
    await createAttribute("ws_a", { label: "مقاوم للماء", type: "BOOLEAN", unit: null, options: [] });
    const lambris = await product("ws_a", { name: "Lambris PVC", code: "LP-7", price: "900 DA" });
    const main = await image("ws_a");
    const grey = await image("ws_a", JPEG);

    const saved = await product("ws_a", {
      name: "Papier peint 3D",
      code: "WP-12",
      price: "1200 DA",
      landingUrl: "https://shop.example/wp-12",
      howToUse: "يتلصق مباشرة على الحيط",
      attributes: { السمك: "٣", matière: "pvc", مقاوم_للماء: "نعم", unknown: "dropped" },
      strengths: ["يتغسل بالماء"],
      objections: [{ question: "يدوم؟", answer: "ضمان 5 سنين" }],
      variants: [
        { code: "12-04", name: "Gris", imageId: grey.id },
        { code: "12-01", name: "Blanc", available: false },
      ],
      related: [{ productId: lambris.id, note: "أرخص" }],
      mainImageId: main.id,
    });

    const read = await getProduct("ws_a", saved.id);
    expect(read).toMatchObject({
      name: "Papier peint 3D",
      code: "WP-12",
      status: "ACTIVE",
      source: "MANUAL",
      attributes: { السمك: 3, matière: "PVC", مقاوم_للماء: true },
      strengths: ["يتغسل بالماء"],
      objections: [{ question: "يدوم؟", answer: "ضمان 5 سنين" }],
      mainImage: { id: main.id, mimeType: "image/png" },
      related: [{ productId: lambris.id, name: "Lambris PVC", code: "LP-7", note: "أرخص" }],
    });
    expect(read?.variants.map((variant) => [variant.code, variant.available, variant.image?.id ?? null])).toEqual([
      ["12-04", true, grey.id],
      ["12-01", false, null],
    ]);
    expect(read?.images.map((stored) => stored.id).sort()).toEqual([main.id, grey.id].sort());
    const rows = await state.db.productImage.findMany({ where: { id: { in: [main.id, grey.id] } } });
    expect(rows.every((row) => row.productId === saved.id)).toBe(true);
  });

  it("keeps a code unique in the brand however it is written, also when two saves race", async () => {
    await product("ws_a", { name: "Papier peint", code: "WP-12" });
    const again = await createProduct("ws_a", card({ name: "Autre", code: "wp 12" }));
    expect(again).toMatchObject({ ok: false, error: "duplicate_code" });
    // Another brand has its own codes.
    expect((await createProduct("ws_b", card({ name: "Papier", code: "WP-12" }))).ok).toBe(true);

    const raced = await Promise.all([
      createProduct("ws_a", card({ name: "Un", code: "RX-1" })),
      createProduct("ws_a", card({ name: "Deux", code: "rx1" })),
    ]);
    expect(raced.filter((result) => result.ok)).toHaveLength(1);
    expect(raced.find((result) => !result.ok)).toMatchObject({ error: "duplicate_code" });
    expect(await state.db.product.count({ where: { workspaceId: "ws_a", codeKey: "RX1" } })).toBe(1);
  });

  it("keeps each colour's id across saves, drops the ones removed, and follows the card's order", async () => {
    const saved = await product("ws_a", {
      name: "Papier peint",
      variants: [{ code: "12-01" }, { code: "12-02" }, { code: "12-03" }],
    });
    const ids = Object.fromEntries(saved.variants.map((variant) => [variant.code, variant.id]));

    const updated = await updateProduct(
      "ws_a",
      saved.id,
      card({ name: "Papier peint", variants: [{ code: "12 03", name: "Beige" }, { code: "12-01" }, { code: "12-09" }] })
    );
    expect(updated.ok).toBe(true);
    const variants = updated.ok ? updated.product.variants : [];
    expect(variants.map((variant) => [variant.code, variant.sortOrder])).toEqual([
      ["12 03", 0],
      ["12-01", 1],
      ["12-09", 2],
    ]);
    expect(variants[0].id).toBe(ids["12-03"]);
    expect(variants[1].id).toBe(ids["12-01"]);
    expect(await state.db.productVariant.count({ where: { id: ids["12-02"] } })).toBe(0);
  });

  it("refuses another brand's picture, one of another product, and another brand's alternative", async () => {
    const theirs = await image("ws_b");
    expect(await createProduct("ws_a", card({ name: "A", mainImageId: theirs.id }))).toMatchObject({
      ok: false,
      error: "unknown_image",
    });

    const first = await product("ws_a", { name: "Premier", mainImageId: (await image("ws_a")).id });
    const usedElsewhere = first.mainImage!.id;
    expect(
      await createProduct("ws_a", card({ name: "B", variants: [{ code: "1", imageId: usedElsewhere }] }))
    ).toMatchObject({ ok: false, error: "unknown_image" });

    const foreign = await product("ws_b", { name: "Chez B" });
    expect(await createProduct("ws_a", card({ name: "C", related: [{ productId: foreign.id }] }))).toMatchObject({
      ok: false,
      error: "unknown_related",
    });
    // Nothing of the refused cards was written.
    expect(await state.db.product.count({ where: { workspaceId: "ws_a" } })).toBe(1);
    expect(await getProduct("ws_b", first.id)).toBeNull();
  });

  it("deletes a product with its colours, pictures and relations; its campaign keeps running without it", async () => {
    const other = await product("ws_a", { name: "Lambris" });
    const doomed = await product("ws_a", {
      name: "Papier",
      mainImageId: (await image("ws_a")).id,
      variants: [{ code: "1" }],
      related: [{ productId: other.id }],
    });
    await product("ws_a", { name: "Plinthe", related: [{ productId: doomed.id }] });
    await state.db.facebookCampaign.create({
      data: {
        id: "camp_a",
        workspaceId: "ws_a",
        facebookPageId: "fp_a",
        name: "Promo",
        matchAnyPost: true,
        keywords: ["سعر"],
        privateReplyMessage: "مرحبا {name}",
        buttonLabel: "التفاصيل",
        landingUrl: "https://shop.example",
        productId: doomed.id,
      },
    });

    expect(await deleteProduct("ws_b", doomed.id)).toBe(false);
    expect(await deleteProduct("ws_a", doomed.id)).toBe(true);
    expect(await state.db.productVariant.count({ where: { productId: doomed.id } })).toBe(0);
    expect(await state.db.productImage.count({ where: { productId: doomed.id } })).toBe(0);
    expect(await state.db.productRelation.count({ where: { OR: [{ productId: doomed.id }, { relatedId: doomed.id }] } })).toBe(0);
    expect(await state.db.facebookCampaign.findUnique({ where: { id: "camp_a" }, select: { productId: true } })).toEqual({
      productId: null,
    });
  });

  it("finds products by their code or a colour's, active ones of the brand only", async () => {
    const wallpaper = await product("ws_a", { name: "Papier", code: "WP-12", variants: [{ code: "C-4", name: "Gris" }] });
    await product("ws_a", { name: "Brouillon", code: "DR-1", status: "DRAFT", variants: [{ code: "C-4" }] });
    await product("ws_b", { name: "Chez B", code: "WP-12" });

    expect(await findByCodeKey("ws_a", "wp 12")).toEqual([{ productId: wallpaper.id, name: "Papier", variant: null }]);
    expect(await findByCodeKey("ws_a", "c4")).toEqual([
      { productId: wallpaper.id, name: "Papier", variant: { id: wallpaper.variants[0].id, code: "C-4", name: "Gris" } },
    ]);
    expect(await findByCodeKey("ws_a", "DR-1")).toEqual([]);
  });

  it("lists by name or code, status and availability, page after page", async () => {
    for (let n = 1; n <= 5; n++) {
      await product("ws_a", { name: `Lambris ${n}`, code: `LB-${n}`, available: n % 2 === 1 });
    }
    await product("ws_a", { name: "Papier", code: "WP-12", status: "DRAFT" });
    await product("ws_b", { name: "Lambris de B" });

    expect((await listProducts("ws_a", { search: "lambris" })).products).toHaveLength(5);
    expect((await listProducts("ws_a", { search: "wp12" })).products.map((item) => item.name)).toEqual(["Papier"]);
    expect((await listProducts("ws_a", { status: "DRAFT" })).products.map((item) => item.name)).toEqual(["Papier"]);
    expect((await listProducts("ws_a", { available: false })).products.map((item) => item.name).sort()).toEqual([
      "Lambris 2",
      "Lambris 4",
    ]);

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: Awaited<ReturnType<typeof listProducts>> = await listProducts("ws_a", { take: 2, cursor });
      seen.push(...page.products.map((item) => item.name));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);
  });

  it("gives the bot the active products, available ones first, with their active alternatives", async () => {
    const draft = await product("ws_a", { name: "Brouillon", status: "DRAFT" });
    const archived = await product("ws_a", { name: "Ancien", status: "ARCHIVED" });
    const lambris = await product("ws_a", { name: "Lambris", price: "900 DA" });
    await product("ws_a", { name: "Absent", available: false });
    await product("ws_a", {
      name: "Papier",
      variants: [{ code: "12-02" }, { code: "12-01" }],
      related: [{ productId: lambris.id, note: "أرخص" }, { productId: draft.id }, { productId: archived.id }],
    });

    const catalog = await loadCatalogForBot("ws_a");
    expect(catalog.products.map((item) => item.name)).toEqual(["Lambris", "Papier", "Absent"]);
    const paper = catalog.products.find((item) => item.name === "Papier")!;
    expect(paper.variants.map((variant) => variant.code)).toEqual(["12-02", "12-01"]);
    expect(paper.related).toEqual([{ id: lambris.id, name: "Lambris", note: "أرخص" }]);
    expect((await loadCatalogForBot("ws_b")).products).toEqual([]);
  });

  it("remembers what a conversation is about", async () => {
    const conversation = await state.db.facebookConversation.create({
      data: { workspaceId: "ws_a", facebookPageId: "fp_a", psid: "psid_1" },
    });
    expect(conversation.focusProductIds).toEqual([]);
    expect(await rememberFocus(conversation.id, ["p2", "p1"], [])).toEqual(["p2", "p1"]);
    expect(await rememberFocus(conversation.id, ["p3"], ["p2", "p1"])).toEqual(["p3", "p2", "p1"]);
    const stored = await state.db.facebookConversation.findUnique({ where: { id: conversation.id } });
    expect(stored?.focusProductIds).toEqual(["p3", "p2", "p1"]);
  });

  it("turns a knowledge-base product into a card once", async () => {
    const entry = await state.db.knowledgeEntry.create({
      data: { workspaceId: "ws_a", kind: "PRODUCT", title: " Robe Kabyle ", content: "S à XL", price: "4500 DA", isActive: false },
    });
    expect(await convertKnowledgeProduct("ws_b", entry.id)).toMatchObject({ ok: false, error: "not_found" });

    const converted = await convertKnowledgeProduct("ws_a", entry.id);
    expect(converted).toMatchObject({
      ok: true,
      product: { name: "Robe Kabyle", price: "4500 DA", description: "S à XL", available: false },
    });
    expect(await state.db.knowledgeEntry.count({ where: { id: entry.id } })).toBe(0);
    expect(await convertKnowledgeProduct("ws_a", entry.id)).toMatchObject({ ok: false, error: "not_found" });
  });

  it("serves the stored bytes by their public id", async () => {
    const stored = await image("ws_a", PNG);
    const served = await readPublicImage(stored.publicId);
    expect(served?.mimeType).toBe("image/png");
    expect(Buffer.compare(served!.data, PNG)).toBe(0);
    expect(await readPublicImage("A".repeat(32))).toBeNull();
  });

  it("deletes, after a day, the pictures no card ever used", async () => {
    const now = new Date();
    const fresh = await image("ws_a");
    const stale = await image("ws_a");
    const used = await product("ws_a", { name: "Papier", mainImageId: (await image("ws_a")).id });
    const old = new Date(now.getTime() - 25 * 60 * 60 * 1000);
    await state.db.productImage.updateMany({ data: { createdAt: old }, where: { id: { not: fresh.id } } });

    expect(await pruneOrphanImages(now)).toBe(1);
    const left = await state.db.productImage.findMany({ select: { id: true } });
    expect(left.map((row) => row.id).sort()).toEqual([fresh.id, used.mainImage!.id].sort());
    expect(stale.id).not.toBe(fresh.id);
  });
});
