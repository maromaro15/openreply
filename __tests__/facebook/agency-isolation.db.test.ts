/**
 * Brand isolation on a real PostgreSQL.
 *
 * An agency owner with three brands, a brand team member invited to one of
 * them, and someone who signed up on their own. Every read the agency layer
 * offers is checked to stay inside the reader's memberships, including with
 * a forged switcher cookie.
 *
 * Skipped unless TEST_DATABASE_URL points at a disposable database. Runs in a
 * throwaway Postgres schema that is dropped at the end.
 */
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../../app/generated/prisma/client";

const state = vi.hoisted(() => ({
  db: undefined as unknown as import("../../app/generated/prisma/client").PrismaClient,
  cookie: undefined as string | undefined,
}));

vi.mock("@/lib/db/client", () => ({
  get prisma() {
    return state.db;
  },
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "openreply-workspace" && state.cookie ? { name, value: state.cookie } : undefined,
    set: () => {},
  }),
}));

import { findSelectedMembership } from "../../lib/agency/active-workspace";
import { isInvitedToAWorkspace } from "../../lib/agency/sign-in";
import {
  canCreateBrandWorkspace,
  createBrandWorkspace,
  getWorkspaceSummaries,
  listUserWorkspaces,
} from "../../lib/agency/workspaces";

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIR = path.join(__dirname, "..", "..", "prisma", "migrations");
const schema = `agency_isolation_${randomBytes(4).toString("hex")}`;
let sql: Client;

const ids = { personal: "", brandA: "", brandB: "", selfServe: "" };

describe.skipIf(!databaseUrl)("agency brands on PostgreSQL", () => {
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
    const db = state.db;

    for (const [id, email] of [
      ["owner", "owner@agency.test"],
      ["team_a", "Team.A@Brand.test"],
      ["self", "self@example.test"],
    ]) {
      await db.user.create({ data: { id, email } });
    }

    // The owner's first workspace, created at first sign-in, then two brands.
    const personal = await db.workspace.create({
      data: { name: "Agency", ownerId: "owner", members: { create: { userId: "owner", role: "OWNER" } } },
    });
    ids.personal = personal.id;
    ids.brandA = (await createBrandWorkspace("owner", "Brand A")).id;
    ids.brandB = (await createBrandWorkspace("owner", "Brand B")).id;
    await db.workspaceMember.create({ data: { workspaceId: ids.brandA, userId: "team_a", role: "MEMBER" } });
    const selfServe = await db.workspace.create({
      data: { name: "Self", ownerId: "self", members: { create: { userId: "self", role: "OWNER" } } },
    });
    ids.selfServe = selfServe.id;

    // Activity in both brands, to see that counts never mix.
    const pageA = await db.facebookPage.create({
      data: { workspaceId: ids.brandA, pageId: "page_a", name: "A", accessToken: "x" },
    });
    await db.facebookPage.create({
      data: { workspaceId: ids.brandA, pageId: "page_a_old", name: "A old", accessToken: "", status: "DISCONNECTED" },
    });
    const pageB = await db.facebookPage.create({
      data: { workspaceId: ids.brandB, pageId: "page_b", name: "B", accessToken: "x" },
    });
    await db.facebookCampaign.create({
      data: {
        workspaceId: ids.brandA,
        facebookPageId: pageA.id,
        name: "Prix",
        keywords: ["prix"],
        privateReplyMessage: "x",
        buttonLabel: "x",
        landingUrl: "https://a.test",
      },
    });
    const conversation = (workspaceId: string, facebookPageId: string, psid: string, extra = {}) =>
      db.facebookConversation.create({
        data: { workspaceId, facebookPageId, psid, lastMessageAt: new Date("2026-11-20T10:00:00Z"), ...extra },
      });
    await conversation(ids.brandA, pageA.id, "p1", { needsHuman: true, handoffCategory: "COMPLAINT" });
    await conversation(ids.brandA, pageA.id, "p2", { needsHuman: true, handoffCategory: "WHOLESALE_ORDER" });
    await conversation(ids.brandA, pageA.id, "p3", { needsHuman: true, handoffCategory: "COMPLAINT" });
    await conversation(ids.brandB, pageB.id, "p4", {
      needsHuman: true,
      handoffCategory: "NOT_IN_KB",
      lastMessageAt: new Date("2026-11-24T09:00:00Z"),
    });

    await db.workspaceInvitation.create({
      data: {
        workspaceId: ids.brandB,
        email: "invited@brand.test",
        role: "ADMIN",
        token: "tok_pending",
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    await db.workspaceInvitation.create({
      data: {
        workspaceId: ids.brandB,
        email: "expired@brand.test",
        token: "tok_expired",
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    await db.workspaceInvitation.create({
      data: {
        workspaceId: ids.brandB,
        email: "revoked@brand.test",
        token: "tok_revoked",
        status: "REVOKED",
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
  }, 60_000);

  afterAll(async () => {
    await state.db?.$disconnect();
    if (sql) {
      await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await sql.end();
    }
  });

  it("shows the owner every brand they created, in order", async () => {
    const brands = await listUserWorkspaces("owner");
    expect(brands.map((brand) => brand.id)).toEqual([ids.personal, ids.brandA, ids.brandB]);
    expect(brands.every((brand) => brand.role === "OWNER")).toBe(true);
  });

  it("shows a brand team member their brand and nothing else", async () => {
    expect(await listUserWorkspaces("team_a")).toEqual([
      expect.objectContaining({ id: ids.brandA, name: "Brand A", role: "MEMBER" }),
    ]);
    expect((await listUserWorkspaces("self")).map((brand) => brand.id)).toEqual([ids.selfServe]);
  });

  it("selects a brand only for its members", async () => {
    state.cookie = ids.brandA;
    expect((await findSelectedMembership("team_a"))?.workspace.name).toBe("Brand A");

    // A forged cookie naming another brand selects nothing.
    state.cookie = ids.brandB;
    expect(await findSelectedMembership("team_a")).toBeNull();
    state.cookie = ids.selfServe;
    expect(await findSelectedMembership("owner")).toBeNull();
    state.cookie = undefined;
  });

  it("counts each brand's own activity only", async () => {
    const summaries = await getWorkspaceSummaries([ids.brandA, ids.brandB]);
    expect(summaries[ids.brandA]).toEqual({
      facebookPages: 1, // the disconnected Page is not counted
      instagramAccounts: 0,
      activeCampaigns: 1,
      members: 2,
      needsHuman: 3,
      needsHumanByCategory: { WHOLESALE_ORDER: 1, COMPLAINT: 2 },
      lastActivityAt: new Date("2026-11-20T10:00:00Z"),
    });
    expect(summaries[ids.brandB]).toMatchObject({
      facebookPages: 1,
      activeCampaigns: 0,
      members: 1,
      needsHuman: 1,
      needsHumanByCategory: { NOT_IN_KB: 1 },
    });
    expect(Object.keys(summaries).sort()).toEqual([ids.brandA, ids.brandB].sort());
  });

  it("lets owners add brands and keeps invited team members from doing so", async () => {
    await expect(canCreateBrandWorkspace("owner", "owner@agency.test")).resolves.toBe(true);
    await expect(canCreateBrandWorkspace("team_a", "team.a@brand.test")).resolves.toBe(false);
  });

  it("opens sign-in to invitations and team roles, not to self-serve owners", async () => {
    await expect(isInvitedToAWorkspace("invited@brand.test")).resolves.toBe(true);
    await expect(isInvitedToAWorkspace("INVITED@brand.test")).resolves.toBe(true);
    await expect(isInvitedToAWorkspace("expired@brand.test")).resolves.toBe(false);
    await expect(isInvitedToAWorkspace("revoked@brand.test")).resolves.toBe(false);
    // Stored with capitals; matched case-insensitively.
    await expect(isInvitedToAWorkspace("team.a@brand.test")).resolves.toBe(true);
    await expect(isInvitedToAWorkspace("self@example.test")).resolves.toBe(false);
    await expect(isInvitedToAWorkspace("nobody@example.test")).resolves.toBe(false);
  });
});
