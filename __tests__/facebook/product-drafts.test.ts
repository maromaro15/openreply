import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "../../app/generated/prisma/client";

/**
 * Product drafts: approve, merge and reject. Prisma is replaced by rows in
 * memory that honour the `where` the code sends (so a query without the
 * brand's workspaceId really reaches the other brand's rows), the cascades
 * the schema declares, and a transaction that rolls back on error.
 */
const state = vi.hoisted(() => ({
  context: null as null | {
    userId: string;
    workspaceId: string;
    role: "OWNER" | "ADMIN" | "MEMBER";
    workspace: { id: string; name: string };
  },
}));

const fake = vi.hoisted(() => {
  type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  type Where = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  type Table = "product" | "productVariant" | "productImage" | "knowledgeSuggestion";

  let rows: Record<Table, Row[]> = { product: [], productVariant: [], productImage: [], knowledgeSuggestion: [] };
  const faults = { updateProduct: null as null | Error, deleteProduct: null as null | Error };

  function matches(table: Table, row: Row, where: Where): boolean {
    return Object.entries(where).every(([key, cond]) => {
      if (cond === undefined) return true;
      if (key === "OR") return (cond as Where[]).some((branch) => matches(table, row, branch));
      if (key === "variants") {
        return rows.productVariant.some((variant) => variant.productId === row.id && matches("productVariant", variant, cond.some));
      }
      if (cond !== null && typeof cond === "object") {
        if ("not" in cond) return row[key] !== cond.not;
        if ("equals" in cond) return typeof row[key] === "string" && row[key].toLowerCase() === String(cond.equals).toLowerCase();
      }
      return row[key] === cond;
    });
  }

  function product(row: Row, select: Row | undefined): Row {
    if (!select?.variants) return { ...row };
    const variants = rows.productVariant
      .filter((variant) => variant.productId === row.id && matches("productVariant", variant, select.variants.where ?? {}))
      .sort((a, b) => a.sortOrder - b.sortOrder);
    return { ...row, variants: variants.map((variant) => ({ ...variant })) };
  }

  function removeProduct(id: string) {
    rows.product = rows.product.filter((row) => row.id !== id);
    rows.productVariant = rows.productVariant.filter((row) => row.productId !== id);
    rows.productImage = rows.productImage.filter((row) => row.productId !== id);
    rows.knowledgeSuggestion = rows.knowledgeSuggestion.filter((row) => row.productId !== id);
    for (const other of rows.product) if (!rows.productImage.some((image) => image.id === other.mainImageId)) other.mainImageId = null;
  }

  const delegate = (table: Table) => ({
    findFirst: async ({ where, select, orderBy }: { where: Where; select?: Row; orderBy?: unknown }) => {
      let found = rows[table].filter((row) => matches(table, row, where));
      if (table === "product" && orderBy) found = [...found].sort((a, b) => String(a.status).localeCompare(String(b.status)));
      return found[0] ? (table === "product" ? product(found[0], select) : { ...found[0] }) : null;
    },
    count: async ({ where }: { where: Where }) => rows[table].filter((row) => matches(table, row, where)).length,
    updateMany: async ({ where, data }: { where: Where; data: Row }) => {
      if (table === "product" && faults.updateProduct) throw faults.updateProduct;
      const found = rows[table].filter((row) => matches(table, row, where));
      for (const row of found) Object.assign(row, data);
      return { count: found.length };
    },
    deleteMany: async ({ where }: { where: Where }) => {
      if (table === "product" && faults.deleteProduct) throw faults.deleteProduct;
      const found = rows[table].filter((row) => matches(table, row, where));
      for (const row of found) removeProduct(row.id);
      return { count: found.length };
    },
  });

  const prisma = {
    product: delegate("product"),
    productVariant: delegate("productVariant"),
    productImage: delegate("productImage"),
    knowledgeSuggestion: delegate("knowledgeSuggestion"),
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => {
      const snapshot = structuredClone(rows);
      try {
        return await work(prisma);
      } catch (error) {
        rows = snapshot;
        throw error;
      }
    },
  };

  return {
    prisma,
    faults,
    reset(next: Partial<Record<Table, Row[]>>) {
      rows = { product: [], productVariant: [], productImage: [], knowledgeSuggestion: [], ...structuredClone(next) };
      faults.updateProduct = null;
      faults.deleteProduct = null;
    },
    table: (name: Table) => rows[name],
    byId: (name: Table, id: string) => rows[name].find((row) => row.id === id),
  };
});

vi.mock("@/lib/workspace-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/workspace-access")>()),
  getCurrentWorkspaceContext: async () => state.context,
}));
vi.mock("@/lib/auth", () => ({ getCurrentUserId: async () => state.context?.userId ?? null }));
vi.mock("@/lib/db/client", () => ({ prisma: fake.prisma }));

import { GET as infoRoute, POST as decideRoute } from "../../app/api/catalog/products/[id]/draft/route";
import { DRAFT_ERRORS, draftNote, postLinkOf, readDraftNote } from "../../lib/catalog/drafts";
import ar from "../../lib/facebook/i18n/ar.json";

const ORIGIN = "http://localhost:3000";
const params = (id: string) => ({ params: Promise.resolve({ id }) });

function post(id: string, body: unknown, origin = ORIGIN) {
  return decideRoute(
    new NextRequest(`${ORIGIN}/api/catalog/products/${id}/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify(body),
    }),
    params(id)
  );
}

const info = (id: string) => infoRoute(new NextRequest(`${ORIGIN}/api/catalog/products/${id}/draft`), params(id));

function as(role: "OWNER" | "ADMIN" | "MEMBER" | null, workspaceId = "ws_a") {
  state.context = role ? { userId: "u", workspaceId, role, workspace: { id: workspaceId, name: "Lina" } } : null;
}

const product = (over: Record<string, unknown>) => ({
  workspaceId: "ws_a",
  status: "ACTIVE",
  source: "MANUAL",
  sourceRef: null,
  sourceNote: null,
  code: null,
  codeKey: null,
  price: null,
  strengths: [],
  mainImageId: null,
  ...over,
});

const DRAFT = product({
  id: "draft_1",
  status: "DRAFT",
  source: "POST",
  sourceRef: "https://www.facebook.com/lina/posts/1",
  sourceNote: "Papier peint 3D WP-12, 1200 DA, blanc et gris",
  name: "Papier peint 3D",
  code: "WP-12",
  codeKey: "WP12",
  price: "1200 DA",
  strengths: ["Lavable", "Autocollant"],
  mainImageId: "img_d1",
});

/** A draft with a colour and two pictures, and an active product it could be merged into. */
function seed(extra: Partial<Record<"product" | "productVariant" | "productImage" | "knowledgeSuggestion", object[]>> = {}) {
  fake.reset({
    product: [
      DRAFT,
      product({ id: "prod_1", name: "Papier peint", code: "WP-99", codeKey: "WP99", strengths: ["lavable "] }),
      ...(extra.product ?? []),
    ],
    productVariant: [
      { id: "dv_1", workspaceId: "ws_a", productId: "draft_1", code: "12-1", codeKey: "121", sortOrder: 0, price: null },
      { id: "dv_2", workspaceId: "ws_a", productId: "draft_1", code: "12-2", codeKey: "122", sortOrder: 1, price: null },
      { id: "pv_1", workspaceId: "ws_a", productId: "prod_1", code: "12-2", codeKey: "122", sortOrder: 4, price: null },
      ...(extra.productVariant ?? []),
    ],
    productImage: [
      { id: "img_d1", workspaceId: "ws_a", productId: "draft_1" },
      { id: "img_d2", workspaceId: "ws_a", productId: "draft_1" },
      ...(extra.productImage ?? []),
    ],
    knowledgeSuggestion: [{ id: "sg_1", workspaceId: "ws_a", productId: "draft_1" }, ...(extra.knowledgeSuggestion ?? [])],
  });
}

beforeEach(() => {
  as("ADMIN");
  seed();
});

describe("who may decide", () => {
  it("lets a member read the draft's source but not decide", async () => {
    as("MEMBER");
    const read = await info("draft_1");
    expect(read.status).toBe(200);
    expect((await read.json()).data.draft).toMatchObject({
      sourceLink: "https://www.facebook.com/lina/posts/1",
      sourceNote: "Papier peint 3D WP-12, 1200 DA, blanc et gris",
    });
    expect((await post("draft_1", { action: "approve" })).status).toBe(403);
    expect((await post("draft_1", { action: "reject" })).status).toBe(403);
    expect(fake.byId("product", "draft_1")?.status).toBe("DRAFT");
  });

  it("refuses a signed-out caller and another origin", async () => {
    as(null);
    expect((await post("draft_1", { action: "approve" })).status).toBe(401);
    expect((await info("draft_1")).status).toBe(401);
    as("ADMIN");
    expect((await post("draft_1", { action: "approve" }, "https://evil.example")).status).toBe(403);
    expect(fake.byId("product", "draft_1")?.status).toBe("DRAFT");
  });

  it("rejects a body that is not one of the three actions", async () => {
    expect((await post("draft_1", { action: "delete" })).status).toBe(400);
    expect((await post("draft_1", { action: "merge" })).status).toBe(400);
    expect((await post("draft_1", { action: "merge", targetId: "" })).status).toBe(400);
    expect((await post("draft_1", null)).status).toBe(400);
  });

  it("does not show a product that is not a draft, or another brand's", async () => {
    expect((await info("prod_1")).status).toBe(404);
    as("ADMIN", "ws_b");
    expect((await info("draft_1")).status).toBe(404);
  });
});

describe("approve", () => {
  it("makes the draft active and changes nothing else", async () => {
    const response = await post("draft_1", { action: "approve" });
    expect(response.status).toBe(200);
    expect(fake.byId("product", "draft_1")).toMatchObject({ status: "ACTIVE", name: "Papier peint 3D", price: "1200 DA" });
    expect(fake.table("productImage")).toHaveLength(2);
  });

  it("approves a draft without a code", async () => {
    seed();
    Object.assign(fake.byId("product", "draft_1")!, { code: null, codeKey: null });
    expect((await post("draft_1", { action: "approve" })).status).toBe(200);
  });

  it("refuses a code that is a colour code of another product, and points to Merge", async () => {
    seed({ productVariant: [{ id: "pv_2", workspaceId: "ws_a", productId: "prod_1", code: "wp 12", codeKey: "WP12", sortOrder: 0 }] });
    const response = await post("draft_1", { action: "approve" });
    const body = await response.json();
    expect(response.status).toBe(409);
    expect(body).toMatchObject({ code: "code_clash", target: { id: "prod_1", name: "Papier peint" } });
    expect(body.error).toMatch(/Merge/);
    expect(fake.byId("product", "draft_1")?.status).toBe("DRAFT");
  });

  it("turns the unique index refusal into the same answer", async () => {
    fake.faults.updateProduct = new Prisma.PrismaClientKnownRequestError("duplicate", { code: "P2002", clientVersion: "test" });
    const response = await post("draft_1", { action: "approve" });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("code_clash");
  });

  it("is a 404 for another brand's draft and a 409 for a product that is no draft", async () => {
    as("ADMIN", "ws_b");
    expect((await post("draft_1", { action: "approve" })).status).toBe(404);
    expect(fake.byId("product", "draft_1")?.status).toBe("DRAFT");
    as("ADMIN");
    const response = await post("prod_1", { action: "approve" });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("not_a_draft");
  });
});

describe("reject", () => {
  it("deletes the draft with its colours, pictures and waiting suggestions, and nothing of other products", async () => {
    expect((await post("draft_1", { action: "reject" })).status).toBe(200);
    expect(fake.byId("product", "draft_1")).toBeUndefined();
    expect(fake.table("productVariant").map((row) => row.id)).toEqual(["pv_1"]);
    expect(fake.table("productImage")).toHaveLength(0);
    expect(fake.table("knowledgeSuggestion")).toHaveLength(0);
    expect(fake.byId("product", "prod_1")).toBeDefined();
  });

  it("never deletes an active product, nor another brand's draft", async () => {
    const active = await post("prod_1", { action: "reject" });
    expect(active.status).toBe(409);
    expect(fake.byId("product", "prod_1")).toBeDefined();
    as("ADMIN", "ws_b");
    expect((await post("draft_1", { action: "reject" })).status).toBe(404);
    expect(fake.byId("product", "draft_1")).toBeDefined();
  });
});

describe("merge", () => {
  it("copies only what the target lacks, moves the pictures, deletes the draft, and keeps what a person wrote", async () => {
    const response = await post("draft_1", { action: "merge", targetId: "prod_1" });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      target: { id: "prod_1", name: "Papier peint" },
      copied: { price: true, colours: 1, pictures: 2, strengths: 1 },
    });

    expect(fake.byId("product", "draft_1")).toBeUndefined();
    expect(fake.byId("product", "prod_1")).toMatchObject({
      name: "Papier peint",
      code: "WP-99",
      price: "1200 DA",
      // "Lavable" is "lavable " once case and spaces are ignored: not added twice.
      strengths: ["lavable ", "Autocollant"],
      mainImageId: "img_d1",
    });
    // The colour the target already had stays its own; the new one follows the existing order.
    expect(fake.table("productVariant").map((row) => [row.id, row.productId, row.sortOrder])).toEqual([
      ["dv_1", "prod_1", 5],
      ["pv_1", "prod_1", 4],
    ]);
    expect(fake.table("productImage").map((row) => row.productId)).toEqual(["prod_1", "prod_1"]);
    expect(fake.byId("knowledgeSuggestion", "sg_1")?.productId).toBe("prod_1");
  });

  it("never overwrites a price, nor a main picture, nor a colour the target has", async () => {
    seed({
      productImage: [{ id: "img_t1", workspaceId: "ws_a", productId: "prod_1" }],
    });
    Object.assign(fake.byId("product", "prod_1")!, { price: "900 DA", mainImageId: "img_t1" });
    const body = await (await post("draft_1", { action: "merge", targetId: "prod_1" })).json();
    expect(body.data.copied).toMatchObject({ price: false, pictures: 2 });
    expect(fake.byId("product", "prod_1")).toMatchObject({ price: "900 DA", mainImageId: "img_t1" });
    expect(fake.table("productImage").every((row) => row.productId === "prod_1")).toBe(true);
  });

  it("keeps the target's existing pictures as they are when it has no main one but does have pictures", async () => {
    seed({ productImage: [{ id: "img_t1", workspaceId: "ws_a", productId: "prod_1" }] });
    await post("draft_1", { action: "merge", targetId: "prod_1" });
    expect(fake.byId("product", "prod_1")?.mainImageId).toBeNull();
  });

  it("can merge into an archived product", async () => {
    Object.assign(fake.byId("product", "prod_1")!, { status: "ARCHIVED" });
    expect((await post("draft_1", { action: "merge", targetId: "prod_1" })).status).toBe(200);
    expect(fake.byId("product", "prod_1")?.status).toBe("ARCHIVED");
  });

  it("refuses itself, another draft and another brand's product, and writes nothing", async () => {
    seed({ product: [product({ id: "other_draft", status: "DRAFT", name: "x" }), product({ id: "prod_b", workspaceId: "ws_b", name: "y" })] });
    const before = JSON.stringify([fake.table("product"), fake.table("productVariant"), fake.table("productImage")]);
    for (const [targetId, code, status] of [
      ["draft_1", "invalid_target", 400],
      ["other_draft", "invalid_target", 400],
      ["prod_b", "target_not_found", 404],
      ["nope", "target_not_found", 404],
    ] as const) {
      const response = await post("draft_1", { action: "merge", targetId });
      expect(response.status, targetId).toBe(status);
      expect((await response.json()).code, targetId).toBe(code);
    }
    expect(JSON.stringify([fake.table("product"), fake.table("productVariant"), fake.table("productImage")])).toBe(before);
  });

  it("is a 404 for another brand's draft, and a 409 for a product that is no draft", async () => {
    as("ADMIN", "ws_b");
    expect((await post("draft_1", { action: "merge", targetId: "prod_1" })).status).toBe(404);
    as("ADMIN");
    const response = await post("prod_1", { action: "merge", targetId: "draft_1" });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("not_a_draft");
  });

  it("is one transaction: a failure at the end puts everything back", async () => {
    const before = JSON.stringify([fake.table("product"), fake.table("productVariant"), fake.table("productImage"), fake.table("knowledgeSuggestion")]);
    fake.faults.deleteProduct = new Error("connection lost");
    await expect(post("draft_1", { action: "merge", targetId: "prod_1" })).rejects.toThrow("connection lost");
    expect(JSON.stringify([fake.table("product"), fake.table("productVariant"), fake.table("productImage"), fake.table("knowledgeSuggestion")])).toBe(before);
  });
});

describe("the merge target to preselect", () => {
  it("is the product whose code the draft has, even as one of its colours", async () => {
    seed({ productVariant: [{ id: "pv_2", workspaceId: "ws_a", productId: "prod_1", code: "WP 12", codeKey: "WP12", sortOrder: 0 }] });
    expect((await (await info("draft_1")).json()).data.draft).toMatchObject({ suggestedTargetId: "prod_1", suggestedBy: "code" });
  });

  it("is the product that has the post's code, when the draft was made without it", async () => {
    Object.assign(fake.byId("product", "draft_1")!, {
      code: null,
      codeKey: null,
      sourceNote: draftNote("Papier peint 3D WP-99, 1200 DA", { code: "WP-99", holder: "Papier peint" }),
    });
    expect((await (await info("draft_1")).json()).data.draft).toMatchObject({
      suggestedTargetId: "prod_1",
      suggestedBy: "code",
      // The screen shows the sentence alone, and words the clash itself.
      sourceNote: "Papier peint 3D WP-99, 1200 DA",
      codeClash: { code: "WP-99", holder: "Papier peint" },
    });
  });

  it("reads a note the posts job did not write as a sentence, whatever it holds", () => {
    expect(readDraftNote(null)).toEqual({ sentence: null, clash: null });
    expect(readDraftNote("Robe kabyle 4500 DA")).toEqual({ sentence: "Robe kabyle 4500 DA", clash: null });
    expect(readDraftNote("Robe\n#code-clash {not json")).toEqual({ sentence: "Robe\n#code-clash {not json", clash: null });
    expect(readDraftNote("#code-clash {\"code\":\"A\",\"holder\":\"B\"}")).toEqual({ sentence: "#code-clash {\"code\":\"A\",\"holder\":\"B\"}", clash: null });
    const note = draftNote("Robe «A-1»", { code: "A-1", holder: "Robe \"kabyle\"" });
    expect(readDraftNote(note)).toEqual({ sentence: "Robe «A-1»", clash: { code: "A-1", holder: "Robe \"kabyle\"" } });
  });

  it("falls back to the same name in any case, and is none when nothing matches", async () => {
    seed({ product: [product({ id: "prod_2", name: "PAPIER PEINT 3d", code: "X1", codeKey: "X1" })] });
    expect((await (await info("draft_1")).json()).data.draft).toMatchObject({ suggestedTargetId: "prod_2", suggestedBy: "name" });
    Object.assign(fake.byId("product", "draft_1")!, { name: "Something else" });
    expect((await (await info("draft_1")).json()).data.draft).toMatchObject({ suggestedTargetId: null, suggestedBy: null });
  });

  it("is never another brand's product, nor a draft", async () => {
    seed({
      product: [
        product({ id: "prod_b", workspaceId: "ws_b", name: "Papier peint 3D", code: "WP-12", codeKey: "WP12" }),
        product({ id: "other_draft", status: "DRAFT", name: "Papier peint 3D" }),
      ],
    });
    expect((await (await info("draft_1")).json()).data.draft.suggestedTargetId).toBeNull();
  });
});

describe("the post link", () => {
  it("is offered only for an https address a browser can open", () => {
    expect(postLinkOf("https://www.facebook.com/lina/posts/1")).toBe("https://www.facebook.com/lina/posts/1");
    for (const bad of ["http://facebook.com/x", "javascript:alert(1)", "data:text/html,x", "123_456", "https://a b", "https://", "", null, undefined]) {
      expect(postLinkOf(bad), String(bad)).toBeNull();
    }
  });
});

describe("copy", () => {
  const catalog = ar as Record<string, string>;
  const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

  it("translates every message of the decisions, with the same placeholders", () => {
    for (const { message } of Object.values(DRAFT_ERRORS)) expect(catalog[message], message).toBeTruthy();
    for (const { message } of Object.values(DRAFT_ERRORS)) {
      expect(catalog[message].trim(), message).not.toBe("");
      expect(placeholders(catalog[message]), message).toEqual(placeholders(message));
    }
  });

  it("has every literal the draft screens show", () => {
    const files = [
      "components/facebook/draft-actions.tsx",
      "app/(dashboard)/facebook/products/page.tsx",
      "app/(dashboard)/facebook/products/[id]/page.tsx",
    ];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const [, key] of source.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g)) {
        expect(catalog[key.replace(/\\"/g, '"')], `${file}: ${key}`).toBeTruthy();
      }
    }
  });
});
