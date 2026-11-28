import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  session: { user: { id: "user_1", email: "owner@agency.test" } } as
    | { user: { id: string; email?: string | null } }
    | null,
  selected: null as null | { workspaceId: string },
  set: vi.fn(),
  list: vi.fn(),
  canCreate: vi.fn(),
  create: vi.fn(),
  summaries: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: async () => state.session }));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: state.set, get: () => undefined }) }));
vi.mock("@/lib/agency/active-workspace", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/agency/active-workspace")>()),
  findSelectedMembership: async () => state.selected,
}));
vi.mock("@/lib/agency/workspaces", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/agency/workspaces")>()),
  listUserWorkspaces: state.list,
  canCreateBrandWorkspace: state.canCreate,
  createBrandWorkspace: state.create,
  getWorkspaceSummaries: state.summaries,
}));
vi.mock("@/lib/db/client", () => ({ prisma: {} }));

import { GET, POST } from "../../app/api/agency/workspaces/route";

const URL_BASE = "http://localhost:3000/api/agency/workspaces";
const WORKSPACES = [
  { id: "ws_first", name: "Agency", role: "OWNER", createdAt: new Date("2026-01-01") },
  { id: "ws_brand", name: "Maison Lina", role: "OWNER", createdAt: new Date("2026-02-01") },
];

function post(body: unknown, origin = "http://localhost:3000") {
  return new NextRequest(URL_BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  state.session = { user: { id: "user_1", email: "owner@agency.test" } };
  state.selected = null;
  state.list.mockResolvedValue(WORKSPACES);
  state.canCreate.mockResolvedValue(true);
  state.summaries.mockResolvedValue({ ws_first: { needsHuman: 0 }, ws_brand: { needsHuman: 2 } });
  state.create.mockResolvedValue({ id: "ws_new", name: "Nouveau", createdAt: new Date() });
});

describe("GET /api/agency/workspaces", () => {
  it("requires a session", async () => {
    state.session = null;
    const response = await GET(new NextRequest(URL_BASE));
    expect(response.status).toBe(401);
  });

  it("lists the user's brands and marks the first one active by default", async () => {
    const response = await GET(new NextRequest(URL_BASE));
    const payload = await response.json();
    expect(payload.data.activeWorkspaceId).toBe("ws_first");
    expect(payload.data.canCreate).toBe(true);
    expect(payload.data.workspaces.map((w: { id: string }) => w.id)).toEqual(["ws_first", "ws_brand"]);
    expect(payload.data.workspaces[0].summary).toBeNull();
    expect(state.summaries).not.toHaveBeenCalled();
    expect(state.list).toHaveBeenCalledWith("user_1");
  });

  it("reports the selected brand, and adds counts only for ?view=stats", async () => {
    state.selected = { workspaceId: "ws_brand" };
    const response = await GET(new NextRequest(`${URL_BASE}?view=stats`));
    const payload = await response.json();
    expect(payload.data.activeWorkspaceId).toBe("ws_brand");
    expect(state.summaries).toHaveBeenCalledWith(["ws_first", "ws_brand"]);
    expect(payload.data.workspaces[1].summary).toEqual({ needsHuman: 2 });
  });
});

describe("POST /api/agency/workspaces", () => {
  it("creates the brand and switches to it", async () => {
    const response = await POST(post({ name: "Nouveau" }));
    expect(response.status).toBe(201);
    expect(state.create).toHaveBeenCalledWith("user_1", "Nouveau");
    expect(state.set).toHaveBeenCalledWith(
      "openreply-workspace",
      "ws_new",
      expect.objectContaining({ httpOnly: true, sameSite: "lax", path: "/" })
    );
  });

  it("refuses a request from another site before doing anything", async () => {
    const response = await POST(post({ name: "Nouveau" }, "https://evil.example"));
    expect(response.status).toBe(403);
    expect(state.create).not.toHaveBeenCalled();
  });

  it("accepts the public origin behind a proxy", async () => {
    vi.stubEnv("NEXTAUTH_URL", "https://bot.example.com");
    const response = await POST(post({ name: "Nouveau" }, "https://bot.example.com"));
    expect(response.status).toBe(201);
    vi.unstubAllEnvs();
  });

  it("requires a session and the right to add brands", async () => {
    state.session = null;
    expect((await POST(post({ name: "x" }))).status).toBe(401);
    state.session = { user: { id: "user_2", email: "team@brand.test" } };
    state.canCreate.mockResolvedValue(false);
    expect((await POST(post({ name: "x" }))).status).toBe(403);
    expect(state.create).not.toHaveBeenCalled();
  });

  it.each([{}, { name: "" }, { name: "   " }, { name: "x".repeat(81) }, { name: 7 }])(
    "rejects an invalid name %j",
    async (body) => {
      expect((await POST(post(body))).status).toBe(400);
      expect(state.create).not.toHaveBeenCalled();
    }
  );
});
