/**
 * Alert routing on a real PostgreSQL: who gets the alert of each handoff
 * category, the fall back to default recipients, and no leak between
 * brands. Skipped unless TEST_DATABASE_URL points at a disposable database.
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

import { recipientsForCategory } from "../../lib/alerts/routing";
import {
  createRecipient,
  deleteRecipient,
  getRoutingTable,
  saveRoutingTable,
  updateRecipient,
} from "../../lib/alerts/settings";

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIR = path.join(__dirname, "..", "..", "prisma", "migrations");
const schema = `facebook_alerts_${randomBytes(4).toString("hex")}`;
let sql: Client;

describe.skipIf(!databaseUrl)("Alert routing on PostgreSQL", () => {
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

  beforeEach(async () => {
    await state.db.alertRoute.deleteMany({});
    await state.db.alertRecipient.deleteMany({});
  });

  async function telegram(workspaceId: string, label: string, extra: { isDefault?: boolean; isActive?: boolean } = {}) {
    const recipient = await createRecipient(workspaceId, {
      channel: "TELEGRAM",
      label,
      telegramChatId: `-100${Math.floor(Math.random() * 1e9)}`,
      isDefault: extra.isDefault ?? false,
      isActive: extra.isActive ?? true,
    });
    return recipient!;
  }

  it("a routed category goes to its recipients only", async () => {
    const sales = await telegram("ws_a", "Sales");
    const support = await telegram("ws_a", "Support");
    await telegram("ws_a", "Owner", { isDefault: true });
    await saveRoutingTable("ws_a", { WHOLESALE_ORDER: [sales.id], COMPLAINT: [support.id] });

    expect((await recipientsForCategory("ws_a", "WHOLESALE_ORDER")).map((r) => r.label)).toEqual(["Sales"]);
    expect((await recipientsForCategory("ws_a", "COMPLAINT")).map((r) => r.label)).toEqual(["Support"]);
  });

  it("a category nobody is assigned to goes to the default recipients", async () => {
    const sales = await telegram("ws_a", "Sales");
    await telegram("ws_a", "Owner", { isDefault: true });
    await createRecipient("ws_a", { channel: "EMAIL", label: "Owner mail", email: "Owner@Shop.DZ", isDefault: true, isActive: true });
    await saveRoutingTable("ws_a", { WHOLESALE_ORDER: [sales.id] });

    const recipients = await recipientsForCategory("ws_a", "NOT_IN_KB");
    expect(recipients.map((r) => r.label)).toEqual(["Owner", "Owner mail"]);
    expect(recipients[1].email).toBe("owner@shop.dz");
  });

  it("skips inactive recipients, falling back to the defaults", async () => {
    const sales = await telegram("ws_a", "Sales");
    await telegram("ws_a", "Owner", { isDefault: true });
    await saveRoutingTable("ws_a", { CUSTOM_ORDER: [sales.id] });
    await updateRecipient("ws_a", sales.id, { isActive: false });
    expect((await recipientsForCategory("ws_a", "CUSTOM_ORDER")).map((r) => r.label)).toEqual(["Owner"]);
  });

  it("no recipient at all means no alert", async () => {
    await telegram("ws_a", "Off", { isDefault: true, isActive: false });
    expect(await recipientsForCategory("ws_a", "OTHER")).toEqual([]);
  });

  it("never mixes brands: foreign recipients are dropped from a table, and routes stay in their brand", async () => {
    const own = await telegram("ws_a", "Mine");
    const foreign = await telegram("ws_b", "Theirs", { isDefault: true });
    const table = await saveRoutingTable("ws_a", { COMPLAINT: [own.id, foreign.id], BOGUS: [own.id] });
    expect(table.COMPLAINT).toEqual([own.id]);
    expect(Object.keys(table)).not.toContain("BOGUS");

    expect(await recipientsForCategory("ws_a", "OTHER")).toEqual([]);
    expect((await recipientsForCategory("ws_b", "COMPLAINT")).map((r) => r.label)).toEqual(["Theirs"]);
    expect(await updateRecipient("ws_a", foreign.id, { isActive: false })).toBe(false);
    expect(await deleteRecipient("ws_a", foreign.id)).toBe(false);
  });

  it("deleting a recipient removes its routes", async () => {
    const sales = await telegram("ws_a", "Sales");
    await saveRoutingTable("ws_a", { WHOLESALE_ORDER: [sales.id], CUSTOM_ORDER: [sales.id] });
    expect(await deleteRecipient("ws_a", sales.id)).toBe(true);
    expect((await getRoutingTable("ws_a")).WHOLESALE_ORDER).toEqual([]);
  });
});
