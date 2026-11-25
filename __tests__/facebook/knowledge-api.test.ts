import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  context: null as null | {
    userId: string;
    workspaceId: string;
    role: "OWNER" | "ADMIN" | "MEMBER";
    workspace: { id: string; name: string };
  },
}));
const db = vi.hoisted(() => ({
  botSettings: { findUnique: vi.fn(), upsert: vi.fn() },
  knowledgeEntry: { findMany: vi.fn(), count: vi.fn(), create: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
  facebookPage: { findMany: vi.fn() },
  product: { findMany: vi.fn() },
  productAttribute: { findMany: vi.fn() },
}));
const ai = vi.hoisted(() => ({ generateJson: vi.fn() }));

vi.mock("@/lib/workspace-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/workspace-access")>()),
  getCurrentWorkspaceContext: async () => state.context,
}));
vi.mock("@/lib/db/client", () => ({ prisma: db }));
vi.mock("@/lib/ai/gemini", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/ai/gemini")>()),
  ...ai,
}));
vi.mock("@/lib/auth", () => ({ getCurrentUserId: async () => state.context?.userId ?? null }));

import { GET as getSettings, PUT as putSettings } from "../../app/api/bot/settings/route";
import { GET as listEntries, POST as addEntry } from "../../app/api/bot/knowledge/route";
import { DELETE as deleteEntry, PATCH as patchEntry } from "../../app/api/bot/knowledge/[id]/route";
import { POST as tryBot } from "../../app/api/bot/test/route";
import { GeminiError } from "../../lib/ai/gemini";
import { SYSTEM_REASONS } from "../../lib/bot/classify";

const BASE = "http://localhost:3000/api/bot";
const params = (id: string) => ({ params: Promise.resolve({ id }) });

function request(url: string, method = "GET", body?: unknown, origin = "http://localhost:3000") {
  return new NextRequest(url, {
    method,
    headers: { "Content-Type": "application/json", Origin: origin },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function as(role: "OWNER" | "ADMIN" | "MEMBER") {
  state.context = { userId: "u", workspaceId: "ws_a", role, workspace: { id: "ws_a", name: "Maison Lina" } };
}

const ENTRY = { kind: "PRODUCT", title: "Robe Kabyle", content: "S à XL", price: "4500 DA", isActive: true };

beforeEach(() => {
  vi.clearAllMocks();
  as("ADMIN");
  db.botSettings.findUnique.mockResolvedValue(null);
  // The row as the database returns it, with phase 11's defaults.
  db.botSettings.upsert.mockImplementation(async ({ create }: { create: Record<string, unknown> }) => ({
    personaName: null,
    personaStyle: null,
    dialect: null,
    goal: "SELL",
    goalNotes: null,
    playbook: null,
    orderFields: ["WILAYA", "COLOUR", "QUANTITY", "NAME", "PHONE"],
    ...create,
  }));
  db.knowledgeEntry.findMany.mockResolvedValue([
    { id: "k2", ...ENTRY, kind: "FAQ", title: "Paiement ?", content: "À la livraison", price: null, sortOrder: 0, createdAt: new Date() },
    { id: "k1", ...ENTRY, sortOrder: 0, createdAt: new Date() },
  ]);
  db.knowledgeEntry.count.mockResolvedValue(2);
  db.knowledgeEntry.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "k3", ...data }));
  db.knowledgeEntry.updateMany.mockResolvedValue({ count: 1 });
  db.knowledgeEntry.deleteMany.mockResolvedValue({ count: 1 });
  db.facebookPage.findMany.mockResolvedValue([{ id: "fp_1", name: "Lina Outlet", status: "ACTIVE", botEnabled: true }]);
  db.product.findMany.mockResolvedValue([]);
  db.productAttribute.findMany.mockResolvedValue([]);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/api/bot/settings", () => {
  it("starts off, with «نرجعولك», and says whether the AI is configured, to every member", async () => {
    as("MEMBER");
    vi.stubEnv("GOOGLE_API_KEY", "");
    const body = await (await getSettings(request(`${BASE}/settings`))).json();
    expect(body.data).toMatchObject({
      role: "MEMBER",
      settings: { enabled: false, businessName: null, instructions: null, handoffMessage: "نرجعولك" },
      ai: { configured: false, model: "gemini-flash-latest" },
      pages: [{ id: "fp_1", name: "Lina Outlet", botEnabled: true }],
    });
    expect(db.facebookPage.findMany.mock.calls[0][0].where).toEqual({ workspaceId: "ws_a", status: { not: "DISCONNECTED" } });
    vi.stubEnv("GOOGLE_API_KEY", "AIza-x");
    expect((await (await getSettings(request(`${BASE}/settings`))).json()).data.ai.configured).toBe(true);
    expect(JSON.stringify(await (await getSettings(request(`${BASE}/settings`))).json())).not.toContain("AIza");
  });

  it("saves for this brand only, owners and admins only", async () => {
    const response = await putSettings(
      request(`${BASE}/settings`, "PUT", {
        enabled: true,
        businessName: "Maison Lina",
        instructions: "بالدارجة",
        handoffMessage: "نرجعولك خويا",
      })
    );
    expect(response.status).toBe(200);
    expect(db.botSettings.upsert).toHaveBeenCalledWith({
      where: { workspaceId: "ws_a" },
      create: { workspaceId: "ws_a", enabled: true, businessName: "Maison Lina", instructions: "بالدارجة", handoffMessage: "نرجعولك خويا" },
      update: { enabled: true, businessName: "Maison Lina", instructions: "بالدارجة", handoffMessage: "نرجعولك خويا" },
    });

    as("MEMBER");
    expect((await putSettings(request(`${BASE}/settings`, "PUT", { enabled: true, handoffMessage: "x" }))).status).toBe(403);
  });

  it("refuses an empty handoff message, a cross-site request and an anonymous one", async () => {
    expect((await putSettings(request(`${BASE}/settings`, "PUT", { enabled: true, handoffMessage: "  " }))).status).toBe(400);
    expect(
      (await putSettings(request(`${BASE}/settings`, "PUT", { enabled: true, handoffMessage: "x" }, "https://evil.example"))).status
    ).toBe(403);
    state.context = null;
    expect((await getSettings(request(`${BASE}/settings`))).status).toBe(401);
    expect(db.botSettings.upsert).not.toHaveBeenCalled();
  });
});

describe("/api/bot/knowledge", () => {
  it("lists the brand's entries by kind, with the size the bot reads", async () => {
    as("MEMBER");
    const body = await (await listEntries(request(`${BASE}/knowledge`))).json();
    expect(db.knowledgeEntry.findMany.mock.calls[0][0].where).toEqual({ workspaceId: "ws_a" });
    expect(body.data.entries.map((entry: { kind: string }) => entry.kind)).toEqual(["PRODUCT", "FAQ"]);
    expect(body.data.size).toEqual({ chars: expect.any(Number), warnAt: 60_000 });
  });

  it("adds an entry to the active brand", async () => {
    const response = await addEntry(request(`${BASE}/knowledge`, "POST", { ...ENTRY, price: " 4500 DA " }));
    expect(response.status).toBe(201);
    expect(db.knowledgeEntry.create).toHaveBeenCalledWith({
      data: { workspaceId: "ws_a", ...ENTRY },
    });
  });

  it.each([
    [{ ...ENTRY, title: "  " }],
    [{ ...ENTRY, kind: "PROMO" }],
    [{ ...ENTRY, content: "x".repeat(4001) }],
  ])("validates the entry (%#)", async (body) => {
    expect((await addEntry(request(`${BASE}/knowledge`, "POST", body))).status).toBe(400);
    expect(db.knowledgeEntry.create).not.toHaveBeenCalled();
  });

  it("caps the size of a knowledge base", async () => {
    db.knowledgeEntry.count.mockResolvedValue(500);
    expect((await addEntry(request(`${BASE}/knowledge`, "POST", ENTRY))).status).toBe(400);
  });

  it("changes only the fields sent", async () => {
    await patchEntry(request(`${BASE}/knowledge/k1`, "PATCH", { isActive: false }), params("k1"));
    expect(db.knowledgeEntry.updateMany).toHaveBeenCalledWith({ where: { id: "k1", workspaceId: "ws_a" }, data: { isActive: false } });
    await patchEntry(request(`${BASE}/knowledge/k1`, "PATCH", { price: "" }), params("k1"));
    expect(db.knowledgeEntry.updateMany).toHaveBeenLastCalledWith({ where: { id: "k1", workspaceId: "ws_a" }, data: { price: null } });
    expect((await patchEntry(request(`${BASE}/knowledge/k1`, "PATCH", {}), params("k1"))).status).toBe(400);
  });

  it("never reaches another brand's entry", async () => {
    db.knowledgeEntry.updateMany.mockResolvedValue({ count: 0 });
    db.knowledgeEntry.deleteMany.mockResolvedValue({ count: 0 });
    expect((await patchEntry(request(`${BASE}/knowledge/k_b`, "PATCH", { title: "x" }), params("k_b"))).status).toBe(404);
    expect((await deleteEntry(request(`${BASE}/knowledge/k_b`, "DELETE"), params("k_b"))).status).toBe(404);
    expect(db.knowledgeEntry.deleteMany).toHaveBeenCalledWith({ where: { id: "k_b", workspaceId: "ws_a" } });
  });

  it("is read-only for members", async () => {
    as("MEMBER");
    expect((await addEntry(request(`${BASE}/knowledge`, "POST", ENTRY))).status).toBe(403);
    expect((await patchEntry(request(`${BASE}/knowledge/k1`, "PATCH", { title: "x" }), params("k1"))).status).toBe(403);
    expect((await deleteEntry(request(`${BASE}/knowledge/k1`, "DELETE"), params("k1"))).status).toBe(403);
  });
});

describe("/api/bot/test", () => {
  const ask = (body: unknown) => tryBot(request(`${BASE}/test`, "POST", body));

  it("answers from the saved knowledge base, without sending or storing anything", async () => {
    as("MEMBER");
    vi.stubEnv("GOOGLE_API_KEY", "AIza-x");
    ai.generateJson.mockResolvedValue({
      data: { handoff: false, category: "NONE", reason: "", reply: "السعر 4500 DA" },
      result: { text: "", finishReason: "STOP", usage: null },
    });
    const body = await (await ask({ message: "شحال الروبة؟", history: [{ from: "customer", text: "salam" }] })).json();
    expect(body.data).toEqual({
      decision: { kind: "reply", text: "السعر 4500 DA" },
      handoffMessage: "نرجعولك",
      error: null,
      // The model said nothing of the customer's state or order here.
      customerState: null,
      order: null,
      orderLines: [],
      orderReady: null,
      pictures: null,
      attempts: 1,
    });
    const prompt = ai.generateJson.mock.calls[0][0];
    expect(prompt.systemInstruction).toContain("Robe Kabyle | Price: 4500 DA");
    expect(prompt.contents[0].parts[0].text).toContain("Customer: salam\nCustomer: شحال الروبة؟");
    expect(db.botSettings.upsert).not.toHaveBeenCalled();
    expect(db.knowledgeEntry.create).not.toHaveBeenCalled();
  });

  it("shows the handoff the bot would make, with the guard's reason", async () => {
    vi.stubEnv("GOOGLE_API_KEY", "AIza-x");
    ai.generateJson.mockResolvedValue({
      data: { handoff: false, category: "NONE", reason: "", reply: "السعر 3900 DA" },
      result: { text: "", finishReason: "STOP", usage: null },
    });
    const body = await (await ask({ message: "شحال؟" })).json();
    expect(body.data.decision).toMatchObject({ kind: "handoff", category: "NOT_IN_KB", source: "guard" });
  });

  it("hands everything to a person when the AI is not configured or fails", async () => {
    vi.stubEnv("GOOGLE_API_KEY", "");
    expect((await (await ask({ message: "salam" })).json()).data).toMatchObject({
      decision: { kind: "handoff", category: "OTHER", reason: SYSTEM_REASONS.aiMissing },
      error: "missing_key",
    });
    expect(ai.generateJson).not.toHaveBeenCalled();

    vi.stubEnv("GOOGLE_API_KEY", "AIza-x");
    ai.generateJson.mockRejectedValue(new GeminiError("Quota exceeded", "rate_limited", 429));
    expect((await (await ask({ message: "salam" })).json()).data).toMatchObject({
      decision: { kind: "handoff", category: "OTHER", reason: SYSTEM_REASONS.aiUnavailable },
      error: "rate_limited: Quota exceeded",
    });
  });

  it("shows the pictures it would send, and says when Messenger could not fetch them", async () => {
    vi.stubEnv("GOOGLE_API_KEY", "AIza-x");
    vi.stubEnv("NEXTAUTH_URL", "http://localhost:3000");
    db.product.findMany.mockResolvedValue([
      {
        id: "prod_wp", name: "Papier peint 3D", code: "WP-12", price: "1200 DA", available: true, landingUrl: null,
        description: null, howToUse: null, attributes: {}, strengths: [], comparisons: null, suitableFor: null,
        objections: [], related: [], mainImage: null,
        variants: [{ code: "12-04", name: "Gris", available: true, image: { publicId: "G".repeat(32) } }],
      },
    ]);
    ai.generateJson.mockResolvedValue({
      data: {
        customer_state: "INTERESTED", handoff: false, category: "NONE", reason: "", order: {}, reply: "هاهم الألوان",
        actions: [{ type: "send_colours", product: "WP-12", colours: [] }],
      },
      result: { text: "", finishReason: "STOP", usage: null },
    });
    const { data } = await (await ask({ message: "وريني الألوان" })).json();
    expect(data.pictures).toMatchObject({
      onMessenger: false,
      button: "نحب هذا",
      sets: [{ type: "colours", cards: [{ title: "12-04 Gris", imagePath: `/api/public/media/${"G".repeat(32)}` }] }],
    });

    // Nothing to show with a handoff, even when the model asked for pictures.
    ai.generateJson.mockResolvedValue({
      data: { handoff: true, category: "COMPLAINT", reason: "colis cassé", reply: "", actions: [{ type: "send_colours", product: "WP-12", colours: [] }] },
      result: { text: "", finishReason: "STOP", usage: null },
    });
    expect((await (await ask({ message: "الكولي وصل مكسور" })).json()).data.pictures).toBeNull();
  });

  it("validates the question", async () => {
    expect((await ask({ message: "" })).status).toBe(400);
    expect((await ask({ message: "x".repeat(1001) })).status).toBe(400);
    expect((await ask({ message: "ok", history: Array(21).fill({ from: "customer", text: "x" }) })).status).toBe(400);
  });
});
