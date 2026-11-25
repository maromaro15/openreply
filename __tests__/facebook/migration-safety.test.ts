/**
 * This branch's migrations may only add. Each may create new types, tables
 * and indexes; add columns (nullable or with a default) and foreign keys to
 * tables this branch created; and add values to enums this branch created.
 * Anything that touches what existed before the branch (an ALTER on an old
 * table or type, a DROP, a rename, a data change) fails here, before it can
 * reach a database.
 *
 * schema.db.test.ts checks the same promise on a real PostgreSQL by comparing
 * every old table's columns before and after all the migrations.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATIONS_DIR = path.join(__dirname, "..", "..", "prisma", "migrations");
/** The branch's first migration: everything before it existed already. */
const FIRST_BRANCH_MIGRATION = "20261125120000_facebook_messenger";
const KNOWN_BRANCH_MIGRATIONS = [FIRST_BRANCH_MIGRATION, "20261126120000_product_catalog"];

const directories = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

function readMigration(name: string): string {
  return readFileSync(path.join(MIGRATIONS_DIR, name, "migration.sql"), "utf8");
}

// Comments are prose and may mention anything, including "DROP".
function withoutComments(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

function names(sql: string, pattern: RegExp): string[] {
  return [...sql.matchAll(pattern)].map((match) => match[1]);
}

const original = directories.filter((name) => name < FIRST_BRANCH_MIGRATION);
const originalSql = original.map(readMigration).join("\n");
const originalTables = new Set(names(originalSql, /CREATE TABLE "(\w+)"/g));
const originalTypes = new Set(names(originalSql, /CREATE TYPE "(\w+)"/g));
const branch = directories.filter((name) => name >= FIRST_BRANCH_MIGRATION);

describe("this branch's migrations are additive only", () => {
  it("are the newest migrations, in order", () => {
    expect(branch).toEqual(expect.arrayContaining(KNOWN_BRANCH_MIGRATIONS));
    expect(directories.slice(-branch.length)).toEqual(branch);
    // Sanity: the old migrations were actually read.
    expect(originalTables.has("Workspace")).toBe(true);
    expect(originalTables.has("InstagramAccount")).toBe(true);
    expect(originalTypes.has("DmStatus")).toBe(true);
  });

  // Tables and types the branch created, growing migration by migration.
  const branchTables = new Set<string>();
  const branchTypes = new Set<string>();

  for (const migration of branch) {
    const sql = withoutComments(readMigration(migration));
    const createdTables = names(sql, /CREATE TABLE "(\w+)"/g);
    const createdTypes = names(sql, /CREATE TYPE "(\w+)"/g);
    // Vitest runs the describe callbacks after this loop: take the state this
    // migration starts from now.
    const tablesBefore = new Set(branchTables);
    const typesBefore = new Set(branchTypes);
    const ownTables = new Set([...tablesBefore, ...createdTables]);
    const ownTypes = new Set([...typesBefore, ...createdTypes]);

    describe(migration, () => {

      it("never drops, renames, truncates or changes existing data", () => {
        expect(sql).not.toMatch(/\bDROP\b/i);
        expect(sql).not.toMatch(/\bRENAME\b/i);
        expect(sql).not.toMatch(/\bTRUNCATE\b/i);
        expect(sql).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+"|DELETE\s+FROM)\b/i);
      });

      it("creates only new types and tables", () => {
        for (const type of createdTypes) {
          expect(originalTypes.has(type) || typesBefore.has(type), `type ${type} already exists`).toBe(false);
        }
        for (const table of createdTables) {
          expect(originalTables.has(table) || tablesBefore.has(table), `table ${table} already exists`).toBe(false);
        }
      });

      it("alters only the branch's own types, and only to add a value", () => {
        for (const statement of sql.match(/ALTER\s+TYPE[^;]*;/gi) ?? []) {
          const type = /ALTER\s+TYPE\s+"(\w+)"/i.exec(statement)?.[1] ?? "";
          expect(ownTypes.has(type), `ALTER TYPE on ${type}, which is not the branch's`).toBe(true);
          expect(statement).toMatch(/\bADD\s+VALUE\b/i);
        }
      });

      it("alters and indexes only the branch's own tables, adding columns that existing rows can take", () => {
        for (const statement of sql.match(/ALTER\s+TABLE[^;]*;/gi) ?? []) {
          const table = /ALTER\s+TABLE\s+"(\w+)"/i.exec(statement)?.[1] ?? "";
          expect(ownTables.has(table), `ALTER TABLE "${table}" is not one of the branch's tables`).toBe(true);
          expect(statement).toMatch(/\bADD\s+(COLUMN|CONSTRAINT)\b/i);
          for (const column of statement.match(/ADD\s+COLUMN[^,;]*/gi) ?? []) {
            if (/\bNOT\s+NULL\b/i.test(column)) expect(column, "a NOT NULL column needs a default").toMatch(/\bDEFAULT\b/i);
          }
        }
        for (const table of names(sql, /CREATE (?:UNIQUE )?INDEX "\w+" ON "(\w+)"/g)) {
          expect(ownTables.has(table), `index on ${table}, which is not the branch's`).toBe(true);
        }
      });

      it("references no existing table but Workspace", () => {
        for (const table of names(sql, /REFERENCES "(\w+)"/g)) {
          if (originalTables.has(table)) expect(table).toBe("Workspace");
          else expect(ownTables.has(table), `reference to unknown table ${table}`).toBe(true);
        }
      });

      it("names no schema, so the isolated test schemas can apply it", () => {
        expect(sql).not.toMatch(/"public"\./i);
        expect(sql).not.toMatch(/\bSET\s+search_path\b/i);
      });
    });

    for (const table of createdTables) branchTables.add(table);
    for (const type of createdTypes) branchTypes.add(type);
  }

  it("the first branch migration created the Facebook, bot and alert tables", () => {
    expect([...branchTables]).toEqual(
      expect.arrayContaining(["FacebookPage", "FacebookConversation", "BotSettings", "AlertDelivery", "Product"])
    );
  });
});
