/**
 * Brand switching (PLAN.md items 13-15), against mocks.
 *
 * The rule under test everywhere: the switcher's cookie only ever selects a
 * workspace the user is a member of, and without it every function answers
 * exactly as before switching existed (the user's first workspace).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  cookie: undefined as string | undefined,
  cookiesThrow: false,
  set: vi.fn(),
  session: { user: { id: "user_1", email: "owner@agency.test" } } as
    | { user: { id: string; email?: string | null } }
    | null,
  config: null as null | { callbacks: { signIn: (args: { user: { email?: string | null } }) => Promise<boolean> } },
}));

const prisma = vi.hoisted(() => ({
  workspaceMember: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
  },
  workspaceInvitation: { findFirst: vi.fn(), findMany: vi.fn() },
  workspace: { create: vi.fn() },
  user: { findUnique: vi.fn() },
}));

vi.mock("next/headers", () => ({
  cookies: async () => {
    if (state.cookiesThrow) throw new Error("cookies was called outside a request scope");
    return {
      get: (name: string) =>
        name === "openreply-workspace" && state.cookie !== undefined ? { name, value: state.cookie } : undefined,
      set: state.set,
    };
  },
}));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("next-auth", () => ({
  default: (config: typeof state.config) => {
    state.config = config;
    return { handlers: {}, auth: async () => state.session, signIn: vi.fn(), signOut: vi.fn() };
  },
}));
vi.mock("next-auth/providers/nodemailer", () => ({ default: () => ({ id: "nodemailer" }) }));
vi.mock("next-auth/providers/resend", () => ({ default: () => ({ id: "resend" }) }));
vi.mock("@auth/prisma-adapter", () => ({ PrismaAdapter: () => ({}) }));

import { getCurrentWorkspaceId } from "../../lib/auth";
import { getCurrentWorkspaceContext } from "../../lib/workspace-access";
import { selectWorkspace } from "../../lib/agency/actions";
import {
  canCreateBrandWorkspace,
  createBrandWorkspace,
  normalizeBrandName,
} from "../../lib/agency/workspaces";

const FIRST = { id: "m_first", workspaceId: "ws_first", userId: "user_1", role: "OWNER", workspace: { id: "ws_first", name: "First" } };
const BRAND = { id: "m_brand", workspaceId: "ws_brand", userId: "user_1", role: "ADMIN", workspace: { id: "ws_brand", name: "Brand" } };

beforeEach(() => {
  vi.clearAllMocks();
  state.cookie = undefined;
  state.cookiesThrow = false;
  state.session = { user: { id: "user_1", email: "owner@agency.test" } };
  prisma.workspaceMember.findFirst.mockResolvedValue(FIRST);
  prisma.workspaceMember.findUnique.mockImplementation(
    async ({ where }: { where: { workspaceId_userId: { workspaceId: string; userId: string } } }) =>
      where.workspaceId_userId.workspaceId === "ws_brand" && where.workspaceId_userId.userId === "user_1"
        ? BRAND
        : null
  );
  prisma.workspaceInvitation.findMany.mockResolvedValue([]);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getCurrentWorkspaceContext (item 13)", () => {
  it("answers as before without a selection, with no extra query", async () => {
    await expect(getCurrentWorkspaceContext()).resolves.toMatchObject({
      workspaceId: "ws_first",
      role: "OWNER",
    });
    expect(prisma.workspaceMember.findUnique).not.toHaveBeenCalled();
    expect(prisma.workspaceMember.findFirst).toHaveBeenCalledWith({
      where: { userId: "user_1" },
      include: { workspace: true },
      orderBy: { createdAt: "asc" },
    });
  });

  it("uses the selected brand when the user is a member of it", async () => {
    state.cookie = "ws_brand";
    await expect(getCurrentWorkspaceContext()).resolves.toMatchObject({
      workspaceId: "ws_brand",
      role: "ADMIN",
      workspace: { name: "Brand" },
    });
    expect(prisma.workspaceMember.findFirst).not.toHaveBeenCalled();
  });

  it("ignores a forged selection and falls back to the first workspace", async () => {
    state.cookie = "ws_someone_else";
    await expect(getCurrentWorkspaceContext()).resolves.toMatchObject({ workspaceId: "ws_first" });
    expect(prisma.workspaceMember.findUnique).toHaveBeenCalledWith({
      where: { workspaceId_userId: { workspaceId: "ws_someone_else", userId: "user_1" } },
      include: { workspace: true },
    });
  });

  it.each(["../ws", "a".repeat(65), "ws brand", ""])("ignores a malformed cookie %j unread", async (value) => {
    state.cookie = value;
    await expect(getCurrentWorkspaceContext()).resolves.toMatchObject({ workspaceId: "ws_first" });
    expect(prisma.workspaceMember.findUnique).not.toHaveBeenCalled();
  });

  it("treats cookies outside a request as no selection", async () => {
    state.cookiesThrow = true;
    await expect(getCurrentWorkspaceContext()).resolves.toMatchObject({ workspaceId: "ws_first" });
  });

  it("returns null when signed out", async () => {
    state.session = null;
    await expect(getCurrentWorkspaceContext()).resolves.toBeNull();
  });
});

describe("getCurrentWorkspaceId (item 13)", () => {
  it("returns the first workspace without a selection", async () => {
    prisma.workspaceMember.findFirst.mockResolvedValue({ ...FIRST, workspace: FIRST.workspace });
    await expect(getCurrentWorkspaceId()).resolves.toBe("ws_first");
    expect(prisma.workspaceMember.findUnique).not.toHaveBeenCalled();
  });

  it("returns the selected brand for a member, and ignores it otherwise", async () => {
    state.cookie = "ws_brand";
    await expect(getCurrentWorkspaceId()).resolves.toBe("ws_brand");
    state.cookie = "ws_someone_else";
    await expect(getCurrentWorkspaceId()).resolves.toBe("ws_first");
  });
});

describe("sign-in with ALLOWED_EMAILS (item 15)", () => {
  const signIn = (email: string | null) => state.config!.callbacks.signIn({ user: { email } });

  it("lets everyone in without ALLOWED_EMAILS, with no database lookup", async () => {
    vi.stubEnv("ALLOWED_EMAILS", "");
    await expect(signIn("anyone@example.test")).resolves.toBe(true);
    expect(prisma.workspaceInvitation.findFirst).not.toHaveBeenCalled();
  });

  it("lets listed addresses in", async () => {
    vi.stubEnv("ALLOWED_EMAILS", "owner@agency.test");
    await expect(signIn("Owner@Agency.test")).resolves.toBe(true);
    expect(prisma.workspaceInvitation.findFirst).not.toHaveBeenCalled();
  });

  it("lets in an address with a pending invitation", async () => {
    vi.stubEnv("ALLOWED_EMAILS", "owner@agency.test");
    prisma.workspaceInvitation.findFirst.mockResolvedValue({ id: "inv_1" });
    await expect(signIn(" Team@Brand.test ")).resolves.toBe(true);
    expect(prisma.workspaceInvitation.findFirst).toHaveBeenCalledWith({
      where: { email: "team@brand.test", status: "PENDING", expiresAt: { gt: expect.any(Date) } },
      select: { id: true },
    });
  });

  it("lets in an invited team member, by ADMIN or MEMBER role only", async () => {
    vi.stubEnv("ALLOWED_EMAILS", "owner@agency.test");
    prisma.workspaceInvitation.findFirst.mockResolvedValue(null);
    prisma.workspaceMember.findFirst.mockResolvedValue({ id: "m_team" });
    await expect(signIn("team@brand.test")).resolves.toBe(true);
    expect(prisma.workspaceMember.findFirst).toHaveBeenCalledWith({
      where: {
        role: { in: ["ADMIN", "MEMBER"] },
        user: { email: { equals: "team@brand.test", mode: "insensitive" } },
      },
      select: { id: true },
    });
  });

  it("keeps out an address that only owns its own workspace", async () => {
    vi.stubEnv("ALLOWED_EMAILS", "owner@agency.test");
    prisma.workspaceInvitation.findFirst.mockResolvedValue(null);
    prisma.workspaceMember.findFirst.mockResolvedValue(null);
    await expect(signIn("stranger@example.test")).resolves.toBe(false);
    await expect(signIn(null)).resolves.toBe(false);
  });
});

describe("selectWorkspace", () => {
  it("stores a workspace the user belongs to", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(selectWorkspace("ws_brand")).resolves.toEqual({ ok: true });
    expect(state.set).toHaveBeenCalledWith("openreply-workspace", "ws_brand", {
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
      sameSite: "lax",
      httpOnly: true,
      secure: true,
    });
  });

  it("refuses a workspace the user is not a member of, and stores nothing", async () => {
    await expect(selectWorkspace("ws_someone_else")).resolves.toEqual({ ok: false, error: "not_a_member" });
    expect(state.set).not.toHaveBeenCalled();
  });

  it("refuses malformed IDs and signed-out users", async () => {
    await expect(selectWorkspace("../etc")).resolves.toEqual({ ok: false, error: "invalid" });
    state.session = null;
    await expect(selectWorkspace("ws_brand")).resolves.toEqual({ ok: false, error: "unauthorized" });
    expect(state.set).not.toHaveBeenCalled();
  });
});

describe("adding brands", () => {
  it("allows owners of a workspace, not invited team members", async () => {
    prisma.workspaceMember.count.mockResolvedValueOnce(2);
    await expect(canCreateBrandWorkspace("user_1", "owner@agency.test")).resolves.toBe(true);
    prisma.workspaceMember.count.mockResolvedValueOnce(0);
    await expect(canCreateBrandWorkspace("user_2", "team@brand.test")).resolves.toBe(false);
    expect(prisma.workspaceMember.count).toHaveBeenLastCalledWith({ where: { userId: "user_2", role: "OWNER" } });
  });

  it("narrows to AGENCY_OWNER_EMAILS when set", async () => {
    vi.stubEnv("AGENCY_OWNER_EMAILS", "Owner@Agency.test, partner@agency.test");
    prisma.workspaceMember.count.mockResolvedValue(1);
    await expect(canCreateBrandWorkspace("user_1", "owner@agency.test")).resolves.toBe(true);
    prisma.workspaceMember.count.mockClear();
    await expect(canCreateBrandWorkspace("user_3", "other@agency.test")).resolves.toBe(false);
    expect(prisma.workspaceMember.count).not.toHaveBeenCalled();
  });

  it("normalises brand names", () => {
    expect(normalizeBrandName("  Maison   Lina  ")).toBe("Maison Lina");
    expect(normalizeBrandName("متجر الياسمين")).toBe("متجر الياسمين");
    expect(normalizeBrandName("")).toBeNull();
    expect(normalizeBrandName("   ")).toBeNull();
    expect(normalizeBrandName("x".repeat(81))).toBeNull();
    expect(normalizeBrandName(42)).toBeNull();
  });

  it("creates the brand with its creator as OWNER", async () => {
    prisma.workspace.create.mockResolvedValue({ id: "ws_new", name: "Maison Lina" });
    await createBrandWorkspace("user_1", " Maison Lina ");
    expect(prisma.workspace.create).toHaveBeenCalledWith({
      data: { name: "Maison Lina", ownerId: "user_1", members: { create: { userId: "user_1", role: "OWNER" } } },
      select: { id: true, name: true, createdAt: true },
    });
    await expect(createBrandWorkspace("user_1", "")).rejects.toThrow("Invalid brand name");
  });
});
