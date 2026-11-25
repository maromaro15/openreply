import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  context: { userId: "u", workspaceId: "ws_a", role: "ADMIN" } as null | {
    userId: string;
    workspaceId: string;
    role: "OWNER" | "ADMIN" | "MEMBER";
  },
  connect: vi.fn(),
  list: vi.fn(),
  setBot: vi.fn(),
  disconnect: vi.fn(),
  purge: vi.fn(),
  resubscribe: vi.fn(),
  findFirst: vi.fn(),
  posts: vi.fn(),
}));

vi.mock("@/lib/workspace-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/workspace-access")>()),
  getCurrentWorkspaceContext: async () => state.context,
}));
vi.mock("@/lib/facebook/pages", () => ({
  connectWithToken: state.connect,
  listWorkspacePages: state.list,
  webhookSetup: () => ({ callbackUrl: "https://bot.example.com/api/facebook/webhook" }),
  setPageBotEnabled: state.setBot,
  disconnectPage: state.disconnect,
  deleteDisconnectedPage: state.purge,
  resubscribePage: state.resubscribe,
  pageToken: () => "decrypted",
}));
vi.mock("@/lib/db/client", () => ({ prisma: { facebookPage: { findFirst: state.findFirst } } }));
vi.mock("@/lib/facebook/graph", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/facebook/graph")>()),
  getPagePosts: state.posts,
}));
vi.mock("@/lib/auth", () => ({ getCurrentUserId: async () => "u" }));

import { GET as listPages, POST as connectPages } from "../../app/api/facebook/pages/route";
import { DELETE as removePage, PATCH as patchPage } from "../../app/api/facebook/pages/[id]/route";
import { POST as subscribe } from "../../app/api/facebook/pages/[id]/subscribe/route";
import { GET as listPosts } from "../../app/api/facebook/pages/[id]/posts/route";

const BASE = "http://localhost:3000/api/facebook/pages";
const params = (id: string) => ({ params: Promise.resolve({ id }) });

function request(url: string, method: string, body?: unknown, origin = "http://localhost:3000") {
  return new NextRequest(url, {
    method,
    headers: { "Content-Type": "application/json", Origin: origin },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  state.context = { userId: "u", workspaceId: "ws_a", role: "ADMIN" };
  state.list.mockResolvedValue([{ id: "fp_1", name: "Maison Lina DZ" }]);
  state.connect.mockResolvedValue({ kind: "connected", pages: [], failures: [] });
  state.setBot.mockResolvedValue(true);
  state.disconnect.mockResolvedValue(true);
  state.purge.mockResolvedValue(true);
});

describe("GET /api/facebook/pages", () => {
  it("lets every member of the brand see its Pages", async () => {
    state.context = { userId: "u", workspaceId: "ws_a", role: "MEMBER" };
    const response = await listPages(new NextRequest(BASE));
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.data.role).toBe("MEMBER");
    expect(state.list).toHaveBeenCalledWith("ws_a");
  });

  it("requires a session", async () => {
    state.context = null;
    expect((await listPages(new NextRequest(BASE))).status).toBe(401);
  });
});

describe("POST /api/facebook/pages", () => {
  it("connects into the active brand", async () => {
    const response = await connectPages(request(BASE, "POST", { token: "EAAGtoken", pageIds: ["1001", "x;drop", 5, "1002"] }));
    expect(response.status).toBe(200);
    // Only numeric Page IDs pass through.
    expect(state.connect).toHaveBeenCalledWith({ workspaceId: "ws_a", token: "EAAGtoken", pageIds: ["1001", "1002"] });
  });

  it("is for owners and admins only", async () => {
    state.context = { userId: "u", workspaceId: "ws_a", role: "MEMBER" };
    expect((await connectPages(request(BASE, "POST", { token: "EAAGtoken" }))).status).toBe(403);
    expect(state.connect).not.toHaveBeenCalled();
  });

  it("refuses a cross-site request", async () => {
    const response = await connectPages(request(BASE, "POST", { token: "EAAGtoken" }, "https://evil.example"));
    expect(response.status).toBe(403);
    expect(state.connect).not.toHaveBeenCalled();
  });

  it("needs a token", async () => {
    expect((await connectPages(request(BASE, "POST", {}))).status).toBe(400);
    expect((await connectPages(request(BASE, "POST", { token: "   " }))).status).toBe(400);
  });

  it("returns a connect error with its code for the UI", async () => {
    state.connect.mockResolvedValue({
      kind: "error",
      error: { code: "missing_permissions", message: "Missing permissions", missing: ["pages_messaging"] },
    });
    const response = await connectPages(request(BASE, "POST", { token: "EAAGtoken" }));
    expect(response.status).toBe(422);
    expect((await response.json()).details).toEqual({
      code: "missing_permissions",
      message: "Missing permissions",
      missing: ["pages_messaging"],
    });
  });
});

describe("one Page", () => {
  it("toggles the bot within the active brand only", async () => {
    const response = await patchPage(request(`${BASE}/fp_1`, "PATCH", { botEnabled: false }), params("fp_1"));
    expect(response.status).toBe(200);
    expect(state.setBot).toHaveBeenCalledWith("ws_a", "fp_1", false);

    state.setBot.mockResolvedValue(false);
    expect((await patchPage(request(`${BASE}/fp_x`, "PATCH", { botEnabled: true }), params("fp_x"))).status).toBe(404);
    expect((await patchPage(request(`${BASE}/fp_1`, "PATCH", { botEnabled: "yes" }), params("fp_1"))).status).toBe(400);
  });

  it("disconnects for admins, and deletes for owners only", async () => {
    expect((await removePage(request(`${BASE}/fp_1`, "DELETE", {}), params("fp_1"))).status).toBe(200);
    expect(state.disconnect).toHaveBeenCalledWith("ws_a", "fp_1");

    expect((await removePage(request(`${BASE}/fp_1`, "DELETE", { purge: true }), params("fp_1"))).status).toBe(403);
    expect(state.purge).not.toHaveBeenCalled();

    state.context = { userId: "u", workspaceId: "ws_a", role: "OWNER" };
    expect((await removePage(request(`${BASE}/fp_1`, "DELETE", { purge: true }), params("fp_1"))).status).toBe(200);
    expect(state.purge).toHaveBeenCalledWith("ws_a", "fp_1");
  });

  it("subscribes again and reports the outcome", async () => {
    state.resubscribe.mockResolvedValue({ ok: false, fields: ["feed"], error: "Not subscribed to: messages" });
    const payload = await (await subscribe(request(`${BASE}/fp_1/subscribe`, "POST"), params("fp_1"))).json();
    expect(payload).toMatchObject({ success: false, error: "Not subscribed to: messages" });
    state.resubscribe.mockResolvedValue(null);
    expect((await subscribe(request(`${BASE}/fp_1/subscribe`, "POST"), params("fp_1"))).status).toBe(404);
  });

  it("lists posts of the brand's own Page only", async () => {
    state.findFirst.mockResolvedValue({ pageId: "1001", accessToken: "enc" });
    state.posts.mockResolvedValue([{ id: "1001_1", message: "Robe kabyle", permalink_url: "https://fb/1" }]);
    const payload = await (await listPosts(new NextRequest(`${BASE}/fp_1/posts`), params("fp_1"))).json();
    expect(state.findFirst).toHaveBeenCalledWith({
      where: { id: "fp_1", workspaceId: "ws_a", status: { not: "DISCONNECTED" } },
      select: { pageId: true, accessToken: true },
    });
    expect(payload.data.posts).toEqual([
      { id: "1001_1", message: "Robe kabyle", createdTime: null, permalink: "https://fb/1", picture: null },
    ]);

    state.findFirst.mockResolvedValue(null);
    expect((await listPosts(new NextRequest(`${BASE}/fp_9/posts`), params("fp_9"))).status).toBe(404);
  });
});
