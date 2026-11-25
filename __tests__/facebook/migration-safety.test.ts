/**
 * The Facebook migration may only add: new types, new tables, indexes on the
 * new tables, and foreign keys from the new tables. Anything that touches what
 * existed before it (an ALTER on an old table, a DROP, a renamed type, a data
 * change) fails here, before it can reach a database.
 *
 * schema.db.test.ts checks the same promise on a real PostgreSQL by comparing
 * every old table's columns before and after the migration.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATIONS_DIR = path.join(__dirname, "..", "..", "prisma", "migrations");
const FACEBOOK_MIGRATION = "20261125120000_facebook_messenger";

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

const previous = directories.filter((name) => name < FACEBOOK_MIGRATION);
const previousSql = previous.map(readMigration).join("\n");
const existingTables = new Set(names(previousSql, /CREATE TABLE "(\w+)"/g));
const existingTypes = new Set(names(previousSql, /CREATE TYPE "(\w+)"/g));

const sql = withoutComments(readMigration(FACEBOOK_MIGRATION));
const createdTables = new Set(names(sql, /CREATE TABLE "(\w+)"/g));

describe("Facebook migration is additive only", () => {
  it("exists and is the newest migration", () => {
    expect(directories).toContain(FACEBOOK_MIGRATION);
    expect(directories[directories.length - 1]).toBe(FACEBOOK_MIGRATION);
    // Sanity: the old migrations were actually read.
    expect(existingTables.has("Workspace")).toBe(true);
    expect(existingTables.has("InstagramAccount")).toBe(true);
    expect(existingTypes.has("DmStatus")).toBe(true);
  });

  it("never drops, renames, truncates or changes existing data", () => {
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/\bRENAME\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
    expect(sql).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+"|DELETE\s+FROM)\b/i);
  });

  it("does not alter any existing type", () => {
    expect(sql).not.toMatch(/\bALTER\s+TYPE\b/i);
    for (const type of names(sql, /CREATE TYPE "(\w+)"/g)) {
      expect(existingTypes.has(type), `type ${type} already exists`).toBe(false);
    }
  });

  it("only creates tables that did not exist", () => {
    expect(createdTables.size).toBeGreaterThan(0);
    for (const table of createdTables) {
      expect(existingTables.has(table), `table ${table} already exists`).toBe(false);
    }
  });

  it("only alters and indexes the tables it creates", () => {
    const altered = names(sql, /ALTER TABLE "(\w+)"/g);
    expect(altered.length).toBeGreaterThan(0);
    for (const table of altered) {
      expect(createdTables.has(table), `ALTER TABLE "${table}" is an existing table`).toBe(true);
    }
    for (const table of names(sql, /CREATE (?:UNIQUE )?INDEX "\w+" ON "(\w+)"/g)) {
      expect(createdTables.has(table), `index on existing table ${table}`).toBe(true);
    }
  });

  it("references Workspace as the only existing table", () => {
    const referenced = names(sql, /REFERENCES "(\w+)"/g).filter((table) =>
      existingTables.has(table)
    );
    expect(new Set(referenced)).toEqual(new Set(["Workspace"]));
  });

  it("names no schema, so the isolated test schemas can apply it", () => {
    expect(sql).not.toMatch(/"public"\./i);
    expect(sql).not.toMatch(/\bSET\s+search_path\b/i);
  });
});
