import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  context: { userId: "u", workspaceId: "ws_a", role: "ADMIN" } as null | {
    userId: string;
    workspaceId: string;
    role: "OWNER" | "ADMIN" | "MEMBER";
  },
}));
const db = vi.hoisted(() => ({
  facebookPage: { findFirst: vi.fn() },
  product: { findFirst: vi.fn() },
  facebookCampaign: {
    create: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
  },
  facebookCommentLog: { groupBy: vi.fn(), findMany: vi.fn() },
}));

vi.mock("@/lib/workspace-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/workspace-access")>()),
  getCurrentWorkspaceContext: async () => state.context,
}));
vi.mock("@/lib/auth", () => ({ getCurrentUserId: async () => "u" }));
vi.mock("@/lib/db/client", () => ({ prisma: db }));

import { GET as list, POST as create } from "../../app/api/facebook/campaigns/route";
import { DELETE as remove, PATCH as patch } from "../../app/api/facebook/campaigns/[id]/route";
import { GET as logs } from "../../app/api/facebook/comment-logs/route";

const BASE = "http://localhost:3000/api/facebook/campaigns";
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const request = (url: string, method: string, body?: unknown) =>
  new NextRequest(url, {
    method,
    headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const valid = {
  name: "Robe Kabyle",
  facebookPageId: "fp_1",
  matchAnyPost: false,
  postId: "1001_555",
  keywords: ["سعر", "prix", " price ", "سعر"],
  privateReplyMessage: "مرحبا {name} 👋",
  buttonLabel: "شوف التفاصيل",
  landingUrl: "https://shop.example/robe",
  publicReplyEnabled: true,
  publicReplyMessages: ["شوف الخاص 📩"],
};

beforeEach(() => {
  vi.clearAllMocks();
  state.context = { userId: "u", workspaceId: "ws_a", role: "ADMIN" };
  db.facebookPage.findFirst.mockResolvedValue({ id: "fp_1" });
  db.product.findFirst.mockResolvedValue({ id: "prod_1" });
  db.facebookCampaign.create.mockImplementation(async ({ data }: { data: unknown }) => ({ id: "camp_1", ...(data as object) }));
  db.facebookCampaign.updateMany.mockResolvedValue({ count: 1 });
  db.facebookCampaign.deleteMany.mockResolvedValue({ count: 1 });
  db.facebookCampaign.findMany.mockResolvedValue([{ id: "camp_1", name: "Robe", page: { id: "fp_1", name: "P", status: "ACTIVE" } }]);
  db.facebookCommentLog.groupBy.mockResolvedValue([
    { campaignId: "camp_1", status: "SENT", _count: { _all: 4 } },
    { campaignId: "camp_1", status: "UNCONFIRMED", _count: { _all: 1 } },
    { campaignId: "camp_1", status: "SKIPPED_EXPIRED", _count: { _all: 2 } },
  ]);
  db.facebookCommentLog.findMany.mockResolvedValue([]);
});

describe("creating a campaign", () => {
  it("stores normalised values in the active brand", async () => {
    const response = await create(request(BASE, "POST", valid));
    expect(response.status).toBe(201);
    expect(db.facebookPage.findFirst).toHaveBeenCalledWith({
      where: { id: "fp_1", workspaceId: "ws_a", status: { not: "DISCONNECTED" } },
      select: { id: true },
    });
    expect(db.facebookCampaign.create.mock.calls[0][0].data).toMatchObject({
      workspaceId: "ws_a",
      keywords: ["سعر", "prix", "price"],
      postId: "1001_555",
      publicReplyMessages: ["شوف الخاص 📩"],
      addUtm: true,
      isActive: true,
    });
  });

  it("refuses a Page of another brand", async () => {
    db.facebookPage.findFirst.mockResolvedValue(null);
    expect((await create(request(BASE, "POST", valid))).status).toBe(400);
    expect(db.facebookCampaign.create).not.toHaveBeenCalled();
  });

  it.each([
    ["no post and not any post", { postId: null }],
    ["a malformed post id", { postId: "abc" }],
    ["no keyword and not every comment", { keywords: [] }],
    ["a button over 20 characters", { buttonLabel: "x".repeat(21) }],
    ["a message over 640 characters", { privateReplyMessage: "x".repeat(641) }],
    ["a javascript: link", { landingUrl: "javascript:alert(1)" }],
    ["a public reply with no text", { publicReplyMessages: [] }],
    ["no name", { name: "  " }],
  ])("rejects %s", async (_label, change) => {
    expect((await create(request(BASE, "POST", { ...valid, ...change }))).status).toBe(400);
    expect(db.facebookCampaign.create).not.toHaveBeenCalled();
  });

  it("drops the post when the campaign answers any post", async () => {
    await create(request(BASE, "POST", { ...valid, matchAnyPost: true }));
    expect(db.facebookCampaign.create.mock.calls[0][0].data).toMatchObject({ matchAnyPost: true, postId: null });
  });

  it("is for owners and admins", async () => {
    state.context = { userId: "u", workspaceId: "ws_a", role: "MEMBER" };
    expect((await create(request(BASE, "POST", valid))).status).toBe(403);
  });

  it("ties the campaign to a product of the brand, or to none", async () => {
    await create(request(BASE, "POST", { ...valid, productId: "prod_1" }));
    expect(db.product.findFirst).toHaveBeenCalledWith({ where: { id: "prod_1", workspaceId: "ws_a" }, select: { id: true } });
    expect(db.facebookCampaign.create.mock.calls[0][0].data).toMatchObject({ productId: "prod_1" });

    // No product (left out, null or "") is no lookup and no link.
    for (const productId of [undefined, null, ""]) {
      db.product.findFirst.mockClear();
      db.facebookCampaign.create.mockClear();
      await create(request(BASE, "POST", { ...valid, productId }));
      expect(db.product.findFirst).not.toHaveBeenCalled();
      expect(db.facebookCampaign.create.mock.calls[0][0].data).toMatchObject({ productId: null });
    }
  });

  it("refuses a product of another brand", async () => {
    db.product.findFirst.mockResolvedValue(null);
    const response = await create(request(BASE, "POST", { ...valid, productId: "prod_other" }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("Choose a product of this brand.");
    expect(db.facebookCampaign.create).not.toHaveBeenCalled();
  });
});

describe("listing and changing campaigns", () => {
  it("lists with counts per outcome", async () => {
    const payload = await (await list(new NextRequest(BASE))).json();
    expect(payload.data.campaigns[0].stats).toEqual({ matched: 7, sent: 4, failed: 1, skipped: 2, pending: 0 });
    expect(db.facebookCampaign.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: "ws_a" } }));
  });

  it("pauses with { isActive } alone, within the active brand", async () => {
    expect((await patch(request(`${BASE}/camp_1`, "PATCH", { isActive: false }), params("camp_1"))).status).toBe(200);
    expect(db.facebookCampaign.updateMany).toHaveBeenCalledWith({ where: { id: "camp_1", workspaceId: "ws_a" }, data: { isActive: false } });

    db.facebookCampaign.updateMany.mockResolvedValue({ count: 0 });
    expect((await patch(request(`${BASE}/camp_x`, "PATCH", { isActive: true }), params("camp_x"))).status).toBe(404);
  });

  it("replaces a campaign with validated values", async () => {
    expect((await patch(request(`${BASE}/camp_1`, "PATCH", valid), params("camp_1"))).status).toBe(200);
    expect(db.facebookCampaign.updateMany.mock.calls[0][0].where).toEqual({ id: "camp_1", workspaceId: "ws_a" });
    expect((await patch(request(`${BASE}/camp_1`, "PATCH", { ...valid, buttonLabel: "" }), params("camp_1"))).status).toBe(400);
  });

  it("keeps or changes the product on a replace, within the brand", async () => {
    await patch(request(`${BASE}/camp_1`, "PATCH", { ...valid, productId: "prod_1" }), params("camp_1"));
    expect(db.facebookCampaign.updateMany.mock.calls[0][0].data).toMatchObject({ productId: "prod_1" });

    db.product.findFirst.mockResolvedValue(null);
    db.facebookCampaign.updateMany.mockClear();
    expect((await patch(request(`${BASE}/camp_1`, "PATCH", { ...valid, productId: "prod_other" }), params("camp_1"))).status).toBe(400);
    expect(db.facebookCampaign.updateMany).not.toHaveBeenCalled();
  });

  it("deletes within the active brand only", async () => {
    expect((await remove(request(`${BASE}/camp_1`, "DELETE"), params("camp_1"))).status).toBe(200);
    expect(db.facebookCampaign.deleteMany).toHaveBeenCalledWith({ where: { id: "camp_1", workspaceId: "ws_a" } });
    db.facebookCampaign.deleteMany.mockResolvedValue({ count: 0 });
    expect((await remove(request(`${BASE}/camp_9`, "DELETE"), params("camp_9"))).status).toBe(404);
  });
});

describe("comment log", () => {
  it("filters by known statuses only, inside the active brand", async () => {
    await logs(new NextRequest("http://localhost:3000/api/facebook/comment-logs?status=SENT"));
    expect(db.facebookCommentLog.findMany.mock.calls[0][0].where).toEqual({ workspaceId: "ws_a", status: "SENT" });
    await logs(new NextRequest("http://localhost:3000/api/facebook/comment-logs?status=DROP%20TABLE"));
    expect(db.facebookCommentLog.findMany.mock.calls[1][0].where).toEqual({ workspaceId: "ws_a" });
  });
});
