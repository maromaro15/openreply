/**
 * Review fixes that rest on the database: two approvals racing for the last
 * place in a brand's knowledge base never both fit.
 *
 * Skipped unless TEST_DATABASE_URL points at a disposable database.
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
}));
vi.mock("@/lib/db/client", () => ({
  get prisma() {
    return state.db;
  },
}));

import { MAX_KNOWLEDGE_ENTRIES } from "../../lib/bot/knowledge";
import { approveSuggestion } from "../../lib/knowledge/review";

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIR = path.join(__dirname, "..", "..", "prisma", "migrations");
const schema = `facebook_reliability_${randomBytes(4).toString("hex")}`;
let sql: Client;

describe.skipIf(!databaseUrl)("Reviewing knowledge suggestions on PostgreSQL", () => {
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
    await state.db.workspace.create({ data: { id: "ws_a", name: "ws_a", ownerId: "owner" } });
  }, 60_000);

  afterAll(async () => {
    await state.db?.$disconnect();
    if (sql) {
      await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await sql.end();
    }
  });

  it("two approvals racing for the last place: one fits, the other is refused", async () => {
    await state.db.knowledgeEntry.createMany({
      data: Array.from({ length: MAX_KNOWLEDGE_ENTRIES - 1 }, (_, index) => ({
        workspaceId: "ws_a",
        kind: "FAQ" as const,
        title: `Question ${index}`,
        content: "Réponse",
      })),
    });
    for (const id of ["s1", "s2", "s3", "s4"]) {
      await state.db.knowledgeSuggestion.create({
        data: { id, workspaceId: "ws_a", source: "CONVERSATION", target: "faq", payload: { question: `Nouvelle ${id} ?`, answer: "Oui" } },
      });
    }
    const results = await Promise.all(["s1", "s2", "s3", "s4"].map((id) => approveSuggestion("ws_a", "owner", id)));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.error === "too_many_entries")).toHaveLength(3);
    await expect(state.db.knowledgeEntry.count({ where: { workspaceId: "ws_a" } })).resolves.toBe(MAX_KNOWLEDGE_ENTRIES);
  }, 60_000);
});
