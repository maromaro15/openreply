/**
 * Facebook Pages on a real PostgreSQL: one brand can never take, read,
 * toggle or delete another brand's Page. Graph calls are mocked; the
 * database rules are real.
 *
 * Skipped unless TEST_DATABASE_URL points at a disposable database.
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

const graph = vi.hoisted(() => ({
  debugToken: vi.fn(),
  getPage: vi.fn(),
  subscribePageWebhooks: vi.fn(),
  getPageSubscribedApps: vi.fn(),
  unsubscribePageWebhooks: vi.fn(),
}));
vi.mock("@/lib/facebook/graph", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/facebook/graph")>()),
  ...graph,
}));

import {
  connectWithToken,
  deleteDisconnectedPage,
  disconnectPage,
  listWorkspacePages,
  setPageBotEnabled,
} from "../../lib/facebook/pages";

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIR = path.join(__dirname, "..", "..", "prisma", "migrations");
const schema = `facebook_pages_${randomBytes(4).toString("hex")}`;
const APP_ID = "1517776481860111";
const TOKEN = "EAAGpageTokenLongLived0123456789abcd";
let sql: Client;

describe.skipIf(!databaseUrl)("Facebook Pages on PostgreSQL", () => {
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
  }, 60_000);

  afterAll(async () => {
    await state.db?.$disconnect();
    if (sql) {
      await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await sql.end();
    }
  });

  beforeEach(() => {
    vi.stubEnv("FACEBOOK_APP_ID", APP_ID);
    vi.stubEnv("FACEBOOK_APP_SECRET", "secret");
    vi.stubEnv("ENCRYPTION_KEY", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
    graph.debugToken.mockResolvedValue({
      is_valid: true,
      type: "PAGE",
      app_id: APP_ID,
      profile_id: "1001",
      expires_at: 0,
      scopes: [
        "pages_messaging",
        "pages_read_engagement",
        "pages_manage_metadata",
        "pages_show_list",
        "pages_manage_engagement",
      ],
    });
    graph.getPage.mockResolvedValue({ id: "1001", name: "Maison Lina DZ" });
    graph.subscribePageWebhooks.mockResolvedValue(true);
    graph.getPageSubscribedApps.mockResolvedValue([
      { id: APP_ID, subscribed_fields: ["feed", "messages", "message_echoes"] },
    ]);
    graph.unsubscribePageWebhooks.mockResolvedValue(true);
  });

  it("connects a Page to one brand and refuses it to another", async () => {
    const first = await connectWithToken({ workspaceId: "ws_a", token: TOKEN });
    expect(first).toMatchObject({ kind: "connected", pages: [{ pageId: "1001", webhookSubscribed: true }] });

    const second = await connectWithToken({ workspaceId: "ws_b", token: TOKEN });
    expect(second).toMatchObject({ kind: "error", error: { code: "page_in_other_workspace" } });
    expect(await state.db.facebookPage.count()).toBe(1);
    expect((await state.db.facebookPage.findUniqueOrThrow({ where: { pageId: "1001" } })).workspaceId).toBe("ws_a");
  });

  it("lists a brand's Pages without their tokens, and nothing to other brands", async () => {
    const pages = await listWorkspacePages("ws_a");
    expect(pages).toHaveLength(1);
    expect(pages[0]).not.toHaveProperty("accessToken");
    expect(JSON.stringify(pages)).not.toContain(TOKEN);
    expect(await listWorkspacePages("ws_b")).toEqual([]);
  });

  it("stores the token encrypted", async () => {
    const row = await state.db.facebookPage.findUniqueOrThrow({ where: { pageId: "1001" } });
    expect(row.accessToken).not.toContain(TOKEN);
    expect(row.tokenLast4).toBe(TOKEN.slice(-4));
  });

  it("lets only the owning brand toggle, disconnect or delete it", async () => {
    const { id } = await state.db.facebookPage.findUniqueOrThrow({ where: { pageId: "1001" } });

    expect(await setPageBotEnabled("ws_b", id, false)).toBe(false);
    expect(await disconnectPage("ws_b", id)).toBe(false);
    expect(await deleteDisconnectedPage("ws_b", id)).toBe(false);
    expect((await state.db.facebookPage.findUniqueOrThrow({ where: { id } })).status).toBe("ACTIVE");

    expect(await setPageBotEnabled("ws_a", id, false)).toBe(true);
    // Deleting needs a disconnected Page.
    expect(await deleteDisconnectedPage("ws_a", id)).toBe(false);
    expect(await disconnectPage("ws_a", id)).toBe(true);
    const disconnected = await state.db.facebookPage.findUniqueOrThrow({ where: { id } });
    expect(disconnected).toMatchObject({ status: "DISCONNECTED", accessToken: "", webhookSubscribed: false });
  });

  it("frees a deleted Page for another brand, removing what was recorded for it", async () => {
    const { id } = await state.db.facebookPage.findUniqueOrThrow({ where: { pageId: "1001" } });
    await state.db.facebookConversation.create({
      data: { workspaceId: "ws_a", facebookPageId: id, psid: "psid_1" },
    });
    expect(await deleteDisconnectedPage("ws_a", id)).toBe(true);
    expect(await state.db.facebookConversation.count({ where: { facebookPageId: id } })).toBe(0);

    const moved = await connectWithToken({ workspaceId: "ws_b", token: TOKEN });
    expect(moved).toMatchObject({ kind: "connected" });
    expect((await state.db.facebookPage.findUniqueOrThrow({ where: { pageId: "1001" } })).workspaceId).toBe("ws_b");
  });
});
