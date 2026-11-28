import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  context: null as null | {
    userId: string;
    workspaceId: string;
    role: "OWNER" | "ADMIN" | "MEMBER";
    workspace: { id: string; name: string };
  },
}));
const db = vi.hoisted(() => {
  const client = {
    knowledgeSuggestion: { findFirst: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(), groupBy: vi.fn() },
    knowledgeEntry: { findMany: vi.fn(), create: vi.fn() },
    product: { findFirst: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
    facebookConversation: { findMany: vi.fn() },
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
  };
  // The callback runs against the same fake: what matters is the order and the arguments of the calls.
  client.$transaction.mockImplementation(async (work: (tx: typeof client) => unknown) => work(client));
  return client;
});

vi.mock("@/lib/workspace-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/workspace-access")>()),
  getCurrentWorkspaceContext: async () => state.context,
}));
vi.mock("@/lib/db/client", () => ({ prisma: db }));
vi.mock("@/lib/auth", () => ({ getCurrentUserId: async () => state.context?.userId ?? null }));

import { GET as list, POST as bulk } from "../../app/api/knowledge/suggestions/route";
import { PATCH as decide } from "../../app/api/knowledge/suggestions/[id]/route";
import { KNOWLEDGE_MAX_CHARS, MAX_KNOWLEDGE_ENTRIES } from "../../lib/bot/knowledge";
import { MAX_OBJECTIONS, MAX_STRENGTHS } from "../../lib/catalog/products";
import { deliveryTitle, REVIEW_ERRORS } from "../../lib/knowledge/review";

const BASE = "http://localhost:3000/api/knowledge/suggestions";
const params = (id: string) => ({ params: Promise.resolve({ id }) });

function request(url: string, method = "GET", body?: unknown, origin = "http://localhost:3000") {
  return new NextRequest(url, {
    method,
    headers: { "Content-Type": "application/json", Origin: origin },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function as(role: "OWNER" | "ADMIN" | "MEMBER") {
  state.context = { userId: "u_1", workspaceId: "ws_a", role, workspace: { id: "ws_a", name: "Maison Lina" } };
}

const patch = (body: unknown, id = "s1") => decide(request(`${BASE}/${id}`, "PATCH", body), params(id));

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "s1",
    workspaceId: "ws_a",
    source: "CONVERSATION",
    sourceRef: "c1",
    productId: null,
    target: "faq",
    payload: { question: "Livraison à Oran ?", answer: "48 heures." },
    evidence: "Cliente : livraison à Oran ?",
    dedupeKey: null,
    status: "PENDING",
    decidedByUserId: null,
    decidedAt: null,
    createdAt: new Date("2026-05-02T10:00:00Z"),
    ...overrides,
  };
}

function card(overrides: Record<string, unknown> = {}) {
  return {
    id: "p1",
    strengths: ["Lavable"],
    objections: [{ question: "Rétrécit ?", answer: "Non." }],
    comparisons: null,
    suitableFor: null,
    updatedAt: new Date("2026-05-01T10:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  as("ADMIN");
  db.knowledgeSuggestion.findFirst.mockResolvedValue(row());
  db.knowledgeSuggestion.findMany.mockResolvedValue([]);
  db.knowledgeSuggestion.updateMany.mockResolvedValue({ count: 1 });
  db.knowledgeSuggestion.groupBy.mockResolvedValue([]);
  db.knowledgeEntry.findMany.mockResolvedValue([]);
  db.knowledgeEntry.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "k1", ...data }));
  db.product.findFirst.mockResolvedValue(card());
  db.product.findMany.mockResolvedValue([]);
  db.product.updateMany.mockResolvedValue({ count: 1 });
  db.facebookConversation.findMany.mockResolvedValue([]);
});

describe("GET /api/knowledge/suggestions", () => {
  it("needs a session", async () => {
    state.context = null;
    expect((await list(request(BASE))).status).toBe(401);
  });

  it("lists the brand's pending suggestions with product names, counts and only real conversation links", async () => {
    as("MEMBER");
    db.knowledgeSuggestion.findMany.mockResolvedValue([
      row({ id: "s2", productId: "p1", target: "product.strengths", payload: { items: ["Lavable"], junk: 1 }, sourceRef: "c9" }),
      row({ id: "s1", sourceRef: "c1" }),
      row({ id: "s3", source: "INTERVIEW", sourceRef: "c1", target: "delivery", payload: { text: "Oran 600 DA" } }),
    ]);
    db.product.findMany.mockResolvedValue([{ id: "p1", name: "Robe Kabyle" }]);
    db.facebookConversation.findMany.mockResolvedValue([{ id: "c1" }]);
    db.knowledgeSuggestion.groupBy.mockResolvedValue([
      { source: "CONVERSATION", _count: { _all: 4 } },
      { source: "INTERVIEW", _count: { _all: 1 } },
    ]);

    const response = await list(request(BASE));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.role).toBe("MEMBER");
    expect(body.data.counts).toEqual({ pending: 5, bySource: { POST: 0, CONVERSATION: 4, INTERVIEW: 1, HANDOFF_REPLY: 0 } });
    const [strengths, faq, interview] = body.data.suggestions;
    expect(strengths).toMatchObject({ productName: "Robe Kabyle", payload: { items: ["Lavable"] }, conversationId: null });
    expect(faq.conversationId).toBe("c1");
    // An interview's sourceRef is not a conversation, even when it looks like one.
    expect(interview.conversationId).toBeNull();

    expect(db.knowledgeSuggestion.findMany.mock.calls[0][0].where).toMatchObject({ workspaceId: "ws_a", status: "PENDING" });
    expect(db.product.findMany.mock.calls[0][0].where).toMatchObject({ workspaceId: "ws_a" });
    expect(db.facebookConversation.findMany.mock.calls[0][0].where).toMatchObject({ workspaceId: "ws_a" });
  });

  it("filters by status and source, and pages with a keyset cursor", async () => {
    const rows = Array.from({ length: 3 }, (_, index) => row({ id: `s${index}`, createdAt: new Date(2026, 4, 3 - index) }));
    db.knowledgeSuggestion.findMany.mockResolvedValue(rows);

    const first = await (await list(request(`${BASE}?status=ALL&source=INTERVIEW&take=2`))).json();
    const where = db.knowledgeSuggestion.findMany.mock.calls[0][0].where;
    expect(where.status).toBeUndefined();
    expect(where.source).toBe("INTERVIEW");
    expect(first.data.suggestions).toHaveLength(2);
    expect(first.data.nextCursor).toEqual(expect.any(String));

    await list(request(`${BASE}?cursor=${first.data.nextCursor}&status=REJECTED`));
    const next = db.knowledgeSuggestion.findMany.mock.calls[1][0].where;
    expect(next.status).toBe("REJECTED");
    expect(next.AND[0].OR).toHaveLength(2);
  });

  it("ignores a bad cursor and an unknown status", async () => {
    const body = await (await list(request(`${BASE}?cursor=garbage&status=WHATEVER`))).json();
    expect(body.data.suggestions).toEqual([]);
    expect(db.knowledgeSuggestion.findMany).not.toHaveBeenCalled();
    await list(request(`${BASE}?status=WHATEVER`));
    expect(db.knowledgeSuggestion.findMany.mock.calls[0][0].where.status).toBe("PENDING");
  });

  it("countOnly skips the list", async () => {
    db.knowledgeSuggestion.groupBy.mockResolvedValue([{ source: "HANDOFF_REPLY", _count: { _all: 2 } }]);
    const body = await (await list(request(`${BASE}?countOnly=true`))).json();
    expect(body.data.counts.pending).toBe(2);
    expect(body.data.suggestions).toBeUndefined();
    expect(db.knowledgeSuggestion.findMany).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/knowledge/suggestions/[id]: access", () => {
  it("is for admins, from this app, with a known action", async () => {
    as("MEMBER");
    expect((await patch({ action: "approve" })).status).toBe(403);
    as("ADMIN");
    expect((await decide(request(`${BASE}/s1`, "PATCH", { action: "approve" }, "https://evil.example"), params("s1"))).status).toBe(403);
    expect((await patch({ action: "delete" })).status).toBe(400);
    expect((await patch("nope")).status).toBe(400);
    expect(db.knowledgeSuggestion.updateMany).not.toHaveBeenCalled();
  });
});

describe("approve: the knowledge base", () => {
  it("writes a FAQ entry and decides the row in the same transaction, recording who and when", async () => {
    const response = await patch({ action: "approve" });
    expect(response.status).toBe(200);
    expect((await response.json()).data.applied).toEqual({ kind: "knowledge", entryId: "k1", entryKind: "FAQ" });

    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.knowledgeEntry.create).toHaveBeenCalledWith({
      data: { workspaceId: "ws_a", kind: "FAQ", title: "Livraison à Oran ?", content: "48 heures.", price: null },
    });
    const claim = db.knowledgeSuggestion.updateMany.mock.calls[0][0];
    expect(claim.where).toEqual({ id: "s1", workspaceId: "ws_a", status: "PENDING" });
    expect(claim.data).toMatchObject({ status: "APPROVED", decidedByUserId: "u_1", decidedAt: expect.any(Date) });
    // The claim comes before the write, so a concurrent approval stops there.
    expect(db.knowledgeSuggestion.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      db.knowledgeEntry.create.mock.invocationCallOrder[0]
    );
  });

  it("takes the brand's advisory lock, as a bound parameter, before counting the entries", async () => {
    await patch({ action: "approve" });
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = db.$executeRaw.mock.calls[0];
    expect(strings.join("?")).toContain("pg_advisory_xact_lock(hashtext(?))");
    expect(values).toEqual(["knowledge-entries:ws_a"]);
    expect(db.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(db.knowledgeEntry.findMany.mock.invocationCallOrder[0]);
  });

  it("looks the suggestion up inside the brand only", async () => {
    db.knowledgeSuggestion.findFirst.mockResolvedValue(null);
    const response = await patch({ action: "approve" }, "other_brand");
    expect(response.status).toBe(404);
    expect(db.knowledgeSuggestion.findFirst).toHaveBeenCalledWith({ where: { id: "other_brand", workspaceId: "ws_a" } });
    expect(db.knowledgeEntry.create).not.toHaveBeenCalled();
  });

  it("applies the reviewer's edit, cleaned, and stores what was applied", async () => {
    await patch({ action: "approve", payload: { question: "  Livraison   à Alger ? ", answer: "24 h", extra: "x" } });
    expect(db.knowledgeEntry.create.mock.calls[0][0].data).toMatchObject({ title: "Livraison à Alger ?", content: "24 h" });
    expect(db.knowledgeSuggestion.updateMany.mock.calls[0][0].data.payload).toEqual({
      question: "Livraison à Alger ?",
      answer: "24 h",
    });
  });

  it("refuses an edit that leaves out what the target needs, writing nothing", async () => {
    const response = await patch({ action: "approve", payload: { question: "Q ?", answer: "   " } });
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("invalid_payload");
    expect(db.knowledgeSuggestion.updateMany).not.toHaveBeenCalled();
    expect(db.knowledgeEntry.create).not.toHaveBeenCalled();
  });

  it("writes a delivery entry titled by the text's first line", async () => {
    db.knowledgeSuggestion.findFirst.mockResolvedValue(
      row({ target: "delivery", payload: { text: "Oran : 600 DA, 48 h\nPaiement à la livraison" } })
    );
    await patch({ action: "approve" });
    expect(db.knowledgeEntry.create.mock.calls[0][0].data).toMatchObject({
      kind: "DELIVERY",
      title: "Oran : 600 DA, 48 h",
      content: "Oran : 600 DA, 48 h\nPaiement à la livraison",
    });
  });

  it("does not repeat a one-line delivery text as title and content", async () => {
    db.knowledgeSuggestion.findFirst.mockResolvedValue(row({ target: "delivery", payload: { text: "Alger : 400 DA" } }));
    await patch({ action: "approve" });
    expect(db.knowledgeEntry.create.mock.calls[0][0].data).toMatchObject({ title: "Alger : 400 DA", content: "" });
  });

  it("cuts a long first line for the title, never in the middle of a character", () => {
    const title = deliveryTitle(`${"é".repeat(120)}\nsuite`);
    expect(Array.from(title)).toHaveLength(80);
    expect(title.endsWith("…")).toBe(true);
    expect(deliveryTitle("\n\n  Oran   600 DA ")).toBe("Oran 600 DA");
  });

  it("refuses a question that does not fit a title, writing nothing", async () => {
    const response = await patch({ action: "approve", payload: { question: "q".repeat(250), answer: "a" } });
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("entry_invalid");
    expect(db.knowledgeEntry.create).not.toHaveBeenCalled();
  });

  it("refuses when the knowledge base is full or would grow too big", async () => {
    const entry = { kind: "FAQ", title: "Q", content: "A", price: null, isActive: true };
    db.knowledgeEntry.findMany.mockResolvedValue(Array.from({ length: MAX_KNOWLEDGE_ENTRIES }, () => entry));
    const full = await patch({ action: "approve" });
    expect(full.status).toBe(400);
    expect((await full.json()).code).toBe("too_many_entries");

    db.knowledgeEntry.findMany.mockResolvedValue([{ ...entry, content: "x".repeat(KNOWLEDGE_MAX_CHARS) }]);
    const big = await patch({ action: "approve" });
    expect((await big.json()).code).toBe("knowledge_too_big");
    expect(db.knowledgeEntry.create).not.toHaveBeenCalled();
  });
});

describe("approve: the product card", () => {
  const onCard = (target: string, payload: unknown) =>
    db.knowledgeSuggestion.findFirst.mockResolvedValue(row({ productId: "p1", target, payload }));

  it("appends strengths without duplicates, scoped by brand and guarded by the card's version", async () => {
    onCard("product.strengths", { items: ["lavable", "Séchage rapide", "Séchage rapide"] });
    const response = await patch({ action: "approve" });
    expect(response.status).toBe(200);
    expect(db.product.findFirst.mock.calls[0][0].where).toEqual({ id: "p1", workspaceId: "ws_a" });
    expect(db.product.updateMany).toHaveBeenCalledWith({
      where: { id: "p1", workspaceId: "ws_a", updatedAt: new Date("2026-05-01T10:00:00Z") },
      data: { strengths: ["Lavable", "Séchage rapide"] },
    });
  });

  it("approves a suggestion that is already on the card without touching it", async () => {
    onCard("product.strengths", { items: ["LAVABLE"] });
    const body = await (await patch({ action: "approve" })).json();
    expect(body.data.applied).toMatchObject({ kind: "product", changed: false });
    expect(db.product.updateMany).not.toHaveBeenCalled();
    expect(db.knowledgeSuggestion.updateMany).toHaveBeenCalled();
  });

  it("refuses strengths past the card's limit", async () => {
    onCard("product.strengths", { items: ["new one"] });
    db.product.findFirst.mockResolvedValue(card({ strengths: Array.from({ length: MAX_STRENGTHS }, (_, index) => `s${index}`) }));
    const response = await patch({ action: "approve" });
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("too_many_strengths");
    expect(db.product.updateMany).not.toHaveBeenCalled();
  });

  it("appends a question and its answer", async () => {
    onCard("product.objections", { question: "Ça déteint ?", answer: "Non, couleurs fixées." });
    await patch({ action: "approve" });
    expect(db.product.updateMany.mock.calls[0][0].data).toEqual({
      objections: [
        { question: "Rétrécit ?", answer: "Non." },
        { question: "Ça déteint ?", answer: "Non, couleurs fixées." },
      ],
    });
  });

  it("refuses an objection past the card's limit", async () => {
    onCard("product.objections", { question: "Nouvelle ?", answer: "Oui." });
    db.product.findFirst.mockResolvedValue(
      card({ objections: Array.from({ length: MAX_OBJECTIONS }, (_, index) => ({ question: `q${index}`, answer: "a" })) })
    );
    expect((await (await patch({ action: "approve" })).json()).code).toBe("too_many_objections");
    expect(db.product.updateMany).not.toHaveBeenCalled();
  });

  it("adds a comparison as a new paragraph, or starts the field", async () => {
    onCard("product.comparisons", { text: "Moins chère que la robe Chic." });
    await patch({ action: "approve" });
    expect(db.product.updateMany.mock.calls[0][0].data).toEqual({ comparisons: "Moins chère que la robe Chic." });

    db.product.findFirst.mockResolvedValue(card({ comparisons: "Plus légère que la robe Chic." }));
    await patch({ action: "approve" });
    expect(db.product.updateMany.mock.calls[1][0].data).toEqual({
      comparisons: "Plus légère que la robe Chic.\n\nMoins chère que la robe Chic.",
    });
  });

  it("refuses text that would not fit the field", async () => {
    onCard("product.suitableFor", { text: "x".repeat(500) });
    db.product.findFirst.mockResolvedValue(card({ suitableFor: "y".repeat(1800) }));
    const response = await patch({ action: "approve" });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "field_too_long", detail: "suitableFor" });
    expect(db.product.updateMany).not.toHaveBeenCalled();
  });

  it("is gone with its product: not the brand's, or deleted", async () => {
    onCard("product.suitableFor", { text: "Mariages" });
    db.product.findFirst.mockResolvedValue(null);
    const response = await patch({ action: "approve" });
    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe("product_missing");
    expect(db.product.updateMany).not.toHaveBeenCalled();
  });

  it("reports a card changed by someone else meanwhile, so the transaction rolls back", async () => {
    onCard("product.suitableFor", { text: "Mariages" });
    db.product.updateMany.mockResolvedValue({ count: 0 });
    const response = await patch({ action: "approve" });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("conflict");
  });
});

describe("approve twice, or at the same time", () => {
  it("a decided suggestion is not applied again", async () => {
    db.knowledgeSuggestion.findFirst.mockResolvedValue(row({ status: "APPROVED" }));
    const response = await patch({ action: "approve" });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("already_decided");
    expect(db.knowledgeSuggestion.updateMany).not.toHaveBeenCalled();
    expect(db.knowledgeEntry.create).not.toHaveBeenCalled();
  });

  it("loses the race: the row was pending when read, decided when claimed", async () => {
    db.knowledgeSuggestion.updateMany.mockResolvedValue({ count: 0 });
    const response = await patch({ action: "approve" });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("already_decided");
    expect(db.knowledgeEntry.create).not.toHaveBeenCalled();
  });

  it("a failed write surfaces as an error after the claim, which the transaction rolls back", async () => {
    db.knowledgeEntry.create.mockRejectedValue(new Error("db down"));
    await expect(patch({ action: "approve" })).rejects.toThrow("db down");
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });
});

describe("reject", () => {
  it("decides only a pending row of the brand and keeps it", async () => {
    const response = await patch({ action: "reject" });
    expect(response.status).toBe(200);
    expect(db.knowledgeSuggestion.updateMany).toHaveBeenCalledWith({
      where: { id: "s1", workspaceId: "ws_a", status: "PENDING" },
      data: { status: "REJECTED", decidedByUserId: "u_1", decidedAt: expect.any(Date) },
    });
    expect(db.knowledgeEntry.create).not.toHaveBeenCalled();
    expect(db.product.updateMany).not.toHaveBeenCalled();
  });

  it("tells a decided row from a missing one", async () => {
    db.knowledgeSuggestion.updateMany.mockResolvedValue({ count: 0 });
    db.knowledgeSuggestion.findFirst.mockResolvedValue({ id: "s1" });
    expect((await patch({ action: "reject" })).status).toBe(409);
    db.knowledgeSuggestion.findFirst.mockResolvedValue(null);
    expect((await patch({ action: "reject" })).status).toBe(404);
  });
});

describe("POST /api/knowledge/suggestions (bulk reject)", () => {
  it("rejects the brand's pending ones among the ids", async () => {
    db.knowledgeSuggestion.updateMany.mockResolvedValue({ count: 2 });
    const response = await bulk(request(BASE, "POST", { action: "reject", ids: ["a", "b", "a", "c"] }));
    expect((await response.json()).data.rejected).toBe(2);
    expect(db.knowledgeSuggestion.updateMany.mock.calls[0][0]).toEqual({
      where: { id: { in: ["a", "b", "c"] }, workspaceId: "ws_a", status: "PENDING" },
      data: { status: "REJECTED", decidedByUserId: "u_1", decidedAt: expect.any(Date) },
    });
  });

  it("is for admins and takes a bounded list of ids", async () => {
    as("MEMBER");
    expect((await bulk(request(BASE, "POST", { action: "reject", ids: ["a"] }))).status).toBe(403);
    as("ADMIN");
    for (const body of [{ action: "approve", ids: ["a"] }, { action: "reject", ids: [] }, { action: "reject", ids: [1] }, { action: "reject" }]) {
      expect((await bulk(request(BASE, "POST", body))).status).toBe(400);
    }
    expect((await bulk(request(BASE, "POST", { action: "reject", ids: Array.from({ length: 201 }, (_, i) => `i${i}`) }))).status).toBe(400);
    expect(db.knowledgeSuggestion.updateMany).not.toHaveBeenCalled();
  });
});

describe("error catalog", () => {
  it("has a status and a message for every code", () => {
    for (const failure of Object.values(REVIEW_ERRORS)) {
      expect(failure.status).toBeGreaterThanOrEqual(400);
      expect(failure.message.length).toBeGreaterThan(0);
    }
  });
});
