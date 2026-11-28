import { beforeEach, describe, expect, it, vi } from "vitest";

/** VIEWER: a brand owner who sees their inbox and statistics, and changes nothing. */
const state = vi.hoisted(() => ({ role: "VIEWER" as "OWNER" | "ADMIN" | "MEMBER" | "VIEWER" }));
// The real role lookup, on the membership of the brand picked in the switcher.
vi.mock("@/lib/agency/active-workspace", () => ({
  findSelectedMembership: async () => ({ workspaceId: "ws_a", workspace: { id: "ws_a" }, role: state.role }),
}));
vi.mock("@/lib/auth", () => ({ getCurrentUserId: async () => "u" }));
vi.mock("@/lib/db/client", () => ({ prisma: {} }));

import { requireWorkspace } from "../lib/agency/http";
import { hasWorkspaceRole } from "../lib/workspace-access";
import { POST as createAutomation, DELETE as deleteAutomation } from "../app/api/automations/route";
import { POST as disconnectInstagram } from "../app/api/instagram/disconnect/route";
import { GET as listMembers } from "../app/api/workspace/members/route";
import { isClientPagePath } from "../lib/agency/client-paths";
import { NextRequest } from "next/server";

const request = (method: string, path = "/api/facebook/conversations") =>
  new NextRequest(`http://localhost:3000${path}`, { method, headers: { Origin: "http://localhost:3000" } });

beforeEach(() => {
  state.role = "VIEWER";
});

describe("the viewer role", () => {
  it("ranks below a member", () => {
    expect(hasWorkspaceRole("VIEWER", "MEMBER")).toBe(false);
    expect(hasWorkspaceRole("MEMBER", "VIEWER")).toBe(true);
  });

  it("reads their inbox and statistics", async () => {
    for (const path of ["/api/facebook/conversations", "/api/facebook/conversations/c1", "/api/facebook/stats"]) {
      await expect(requireWorkspace(request("GET", path))).resolves.toMatchObject({ role: "VIEWER" });
    }
  });

  it("is refused everything else a member reads: settings, integrations, Meta, campaigns, the bot", async () => {
    for (const path of [
      "/api/bot/settings",
      "/api/facebook/pages",
      "/api/facebook/campaigns",
      "/api/catalog/products",
      "/api/alerts/settings",
      "/api/voice",
      "/api/facebook/conversationsX",
    ]) {
      const response = (await requireWorkspace(request("GET", path))) as Response;
      expect(response.status, path).toBe(403);
      expect((await response.json()).error).toMatch(/inbox and its statistics/);
    }
    expect(((await listMembers()) as Response).status).toBe(403);
  });

  it("opens only the inbox and statistics pages", () => {
    expect(isClientPagePath("/facebook/inbox")).toBe(true);
    expect(isClientPagePath("/facebook/stats")).toBe(true);
    for (const path of ["/settings", "/integrations", "/agency", "/facebook/pages", "/facebook/knowledge", "/dashboard", "/facebook/inboxes", ""]) {
      expect(isClientPagePath(path), path).toBe(false);
    }
  });

  it("changes nothing, and never sees an admin's pages", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = (await requireWorkspace(request(method))) as Response;
      expect(response.status).toBe(403);
      expect((await response.json()).error).toMatch(/View only/);
    }
    expect(((await requireWorkspace(request("GET"), "ADMIN")) as Response).status).toBe(403);
  });

  it("is refused on the routes outside the shared guard too", async () => {
    for (const handler of [createAutomation, deleteAutomation, disconnectInstagram]) {
      expect((await handler(request("POST"))).status).toBe(403);
    }
  });

  it("leaves members as they were", async () => {
    state.role = "MEMBER";
    await expect(requireWorkspace(request("POST"))).resolves.toMatchObject({ role: "MEMBER" });
    expect(((await requireWorkspace(request("POST"), "ADMIN")) as Response).status).toBe(403);
  });
});
