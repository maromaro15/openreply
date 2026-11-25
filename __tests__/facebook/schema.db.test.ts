/**
 * The Facebook / bot / alerts schema on a real PostgreSQL.
 *
 * Two promises are checked here:
 *   1. The migration leaves everything that existed before it exactly as it
 *      was: every old table's columns, indexes and constraints, and every old
 *      enum's values, are snapshotted before it runs and compared after.
 *   2. The new constraints enforce what the code relies on: one private reply
 *      per comment, one Page per workspace, one bot reply per inbound message,
 *      and cascades that remove a workspace's data with it.
 *
 * Skipped unless TEST_DATABASE_URL points at a disposable database:
 *
 *   TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/postgres \
 *     npx vitest run __tests__/facebook/schema.db.test.ts
 *
 * Everything runs inside a throwaway Postgres schema that is dropped at the end.
 */
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../../app/generated/prisma/client";

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIR = path.join(__dirname, "..", "..", "prisma", "migrations");
const FACEBOOK_MIGRATION = "20261125120000_facebook_messenger";
const schema = `facebook_schema_${randomBytes(4).toString("hex")}`;

const NEW_TABLES = [
  "AlertDelivery",
  "AlertRecipient",
  "AlertRoute",
  "AlertSettings",
  "BotSettings",
  "FacebookCampaign",
  "FacebookCommentLog",
  "FacebookConversation",
  "FacebookConversationEvent",
  "FacebookMessage",
  "FacebookPage",
  "FacebookWebhookEvent",
  "KnowledgeEntry",
];

function readMigration(name: string): string {
  return readFileSync(path.join(MIGRATIONS_DIR, name, "migration.sql"), "utf8");
}

const migrations = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

type Snapshot = {
  tables: string[];
  columns: unknown[];
  indexes: unknown[];
  constraints: unknown[];
  enums: unknown[];
};

async function snapshot(sql: Client, tables?: string[], types?: string[]): Promise<Snapshot> {
  const tableFilter = tables ? "AND c.relname = ANY($2)" : "";
  const args = tables ? [schema, tables] : [schema];
  const tableRows = await sql.query(
    `SELECT c.relname AS name FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind = 'r' ${tableFilter}
      ORDER BY 1`,
    args
  );
  const columns = await sql.query(
    `SELECT table_name, column_name, ordinal_position, data_type, udt_name,
            is_nullable, column_default, character_maximum_length
       FROM information_schema.columns
      WHERE table_schema = $1 ${tables ? "AND table_name = ANY($2)" : ""}
      ORDER BY table_name, ordinal_position`,
    args
  );
  const indexes = await sql.query(
    `SELECT tablename, indexname, indexdef FROM pg_indexes
      WHERE schemaname = $1 ${tables ? "AND tablename = ANY($2)" : ""}
      ORDER BY tablename, indexname`,
    args
  );
  const constraints = await sql.query(
    `SELECT c.relname AS table_name, con.conname, con.contype,
            pg_get_constraintdef(con.oid) AS definition
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 ${tableFilter}
      ORDER BY 1, 2`,
    args
  );
  const enums = await sql.query(
    `SELECT t.typname, e.enumlabel, e.enumsortorder
       FROM pg_type t
       JOIN pg_enum e ON e.enumtypid = t.oid
       JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = $1 ${types ? "AND t.typname = ANY($2)" : ""}
      ORDER BY t.typname, e.enumsortorder`,
    types ? [schema, types] : [schema]
  );
  return {
    tables: tableRows.rows.map((row) => row.name as string),
    columns: columns.rows,
    indexes: indexes.rows,
    constraints: constraints.rows,
    enums: enums.rows,
  };
}

async function expectUniqueViolation(operation: Promise<unknown>) {
  await expect(operation).rejects.toMatchObject({ code: "P2002" });
}

let sql: Client;
let db: PrismaClient;
let before: Snapshot;
let after: Snapshot;

describe.skipIf(!databaseUrl)("Facebook schema on PostgreSQL", () => {
  beforeAll(async () => {
    sql = new Client({ connectionString: databaseUrl });
    await sql.connect();
    await sql.query(`CREATE SCHEMA "${schema}"`);
    await sql.query(`SET search_path TO "${schema}"`);

    for (const name of migrations.filter((name) => name < FACEBOOK_MIGRATION)) {
      await sql.query(readMigration(name));
    }
    before = await snapshot(sql);

    await sql.query(readMigration(FACEBOOK_MIGRATION));
    const oldTypes = [...new Set(before.enums.map((row) => (row as { typname: string }).typname))];
    after = await snapshot(sql, before.tables, oldTypes);

    // Any migration added after this one is applied too, as in production.
    for (const name of migrations.filter((name) => name > FACEBOOK_MIGRATION)) {
      await sql.query(readMigration(name));
    }

    db = new PrismaClient({
      adapter: new PrismaPg({ connectionString: databaseUrl }, { schema }),
    });
    await db.user.create({ data: { id: "owner", email: "owner@example.test" } });
    for (const id of ["ws_a", "ws_b"]) {
      await db.workspace.create({ data: { id, name: id, ownerId: "owner" } });
    }
  }, 60_000);

  afterAll(async () => {
    await db?.$disconnect();
    if (sql) {
      await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await sql.end();
    }
  });

  it("leaves every existing table, column, index, constraint and enum as it was", () => {
    expect(before.tables.length).toBeGreaterThan(10);
    expect(after).toEqual(before);
  });

  it("adds exactly the new tables", async () => {
    const all = await snapshot(sql);
    const added = all.tables.filter((table) => !before.tables.includes(table));
    expect(added.sort()).toEqual(NEW_TABLES);
  });

  async function createPage(id: string, workspaceId: string, pageId = `page_${id}`) {
    return db.facebookPage.create({
      data: { id, workspaceId, pageId, name: `Page ${id}`, accessToken: "encrypted" },
    });
  }

  it("applies the defaults the code relies on", async () => {
    const page = await createPage("defaults", "ws_a");
    expect(page).toMatchObject({
      status: "ACTIVE",
      botEnabled: true,
      webhookSubscribed: false,
      grantedScopes: [],
      subscribedFields: [],
      tokenExpiresAt: null,
    });

    const settings = await db.botSettings.create({ data: { workspaceId: "ws_a" } });
    expect(settings.enabled).toBe(false);
    expect(settings.handoffMessage).toBe("نرجعولك");

    const conversation = await db.facebookConversation.create({
      data: { workspaceId: "ws_a", facebookPageId: page.id, psid: "psid_defaults" },
    });
    expect(conversation).toMatchObject({
      mode: "BOT",
      needsHuman: false,
      handoffCategory: null,
      unreadCount: 0,
    });
  });

  it("lets a Page belong to one workspace only", async () => {
    await createPage("shared_a", "ws_a", "page_shared");
    await expectUniqueViolation(createPage("shared_b", "ws_b", "page_shared"));
  });

  it("keeps one comment log per Page and comment", async () => {
    const page = await createPage("comments", "ws_a");
    const other = await createPage("comments_other", "ws_a");
    const row = (facebookPageId: string) => ({
      workspaceId: "ws_a",
      facebookPageId,
      commentId: "post_1_comment_1",
      postId: "page_comments_post_1",
      commentText: "شحال السعر؟",
      commentCreatedAt: new Date(),
    });

    const log = await db.facebookCommentLog.create({ data: row(page.id) });
    expect(log).toMatchObject({ status: "PENDING", attempts: 0, deliveryUnconfirmed: false });
    await expectUniqueViolation(db.facebookCommentLog.create({ data: row(page.id) }));
    // The same comment id on another Page is a different comment.
    await expect(db.facebookCommentLog.create({ data: row(other.id) })).resolves.toBeTruthy();
  });

  it("keeps one conversation per Page and person", async () => {
    const page = await createPage("conversations", "ws_a");
    const data = { workspaceId: "ws_a", facebookPageId: page.id, psid: "psid_1" };
    await db.facebookConversation.create({ data });
    await expectUniqueViolation(db.facebookConversation.create({ data }));
  });

  it("stores a Messenger message once and one bot reply per trigger", async () => {
    const page = await createPage("messages", "ws_a");
    const conversation = await db.facebookConversation.create({
      data: { workspaceId: "ws_a", facebookPageId: page.id, psid: "psid_messages" },
    });
    const inbound = {
      workspaceId: "ws_a",
      conversationId: conversation.id,
      direction: "INBOUND" as const,
      author: "CUSTOMER" as const,
      mid: "m_inbound_1",
      text: "salam",
    };
    await db.facebookMessage.create({ data: inbound });
    await expectUniqueViolation(db.facebookMessage.create({ data: inbound }));

    const botReply = {
      workspaceId: "ws_a",
      conversationId: conversation.id,
      direction: "OUTBOUND" as const,
      author: "BOT" as const,
      origin: "OPENREPLY" as const,
      replyToMid: "m_inbound_1",
      text: "مرحبا",
    };
    await db.facebookMessage.create({ data: botReply });
    await expectUniqueViolation(db.facebookMessage.create({ data: botReply }));

    // Human replies answer no trigger, and many of them may share a NULL.
    for (const text of ["first", "second"]) {
      await db.facebookMessage.create({
        data: {
          workspaceId: "ws_a",
          conversationId: conversation.id,
          direction: "OUTBOUND",
          author: "HUMAN",
          origin: "EXTERNAL",
          text,
        },
      });
    }
    expect(
      await db.facebookMessage.count({ where: { conversationId: conversation.id } })
    ).toBe(4);
  });

  it("keeps comment logs when their campaign is deleted", async () => {
    const page = await createPage("campaign_delete", "ws_a");
    const campaign = await db.facebookCampaign.create({
      data: {
        workspaceId: "ws_a",
        facebookPageId: page.id,
        name: "Price",
        keywords: ["سعر", "prix", "price"],
        privateReplyMessage: "السعر في الرابط",
        buttonLabel: "اطلب الآن",
        landingUrl: "https://example.test/product",
      },
    });
    const log = await db.facebookCommentLog.create({
      data: {
        workspaceId: "ws_a",
        facebookPageId: page.id,
        campaignId: campaign.id,
        commentId: "comment_campaign_delete",
        postId: "post",
        commentText: "prix",
        commentCreatedAt: new Date(),
      },
    });
    await db.facebookCampaign.delete({ where: { id: campaign.id } });
    const kept = await db.facebookCommentLog.findUniqueOrThrow({ where: { id: log.id } });
    expect(kept.campaignId).toBeNull();
  });

  it("routes a category to a recipient once, and drops routes with their recipient", async () => {
    const recipient = await db.alertRecipient.create({
      data: { workspaceId: "ws_b", channel: "TELEGRAM", label: "Sales", telegramChatId: "-1001" },
    });
    const route = { workspaceId: "ws_b", category: "WHOLESALE_ORDER" as const, recipientId: recipient.id };
    await db.alertRoute.create({ data: route });
    await expectUniqueViolation(db.alertRoute.create({ data: route }));
    await db.alertRoute.create({ data: { ...route, category: "COMPLAINT" } });

    await db.alertRecipient.delete({ where: { id: recipient.id } });
    expect(await db.alertRoute.count({ where: { recipientId: recipient.id } })).toBe(0);
  });

  it("sends each alert delivery once per dedupe key", async () => {
    const data = {
      workspaceId: "ws_b",
      channel: "EMAIL" as const,
      dedupeKey: "handoff:event_1:recipient_1",
    };
    await db.alertDelivery.create({ data });
    await expectUniqueViolation(db.alertDelivery.create({ data }));
  });

  it("removes a workspace's Facebook, bot and alert data with the workspace", async () => {
    await db.workspace.create({ data: { id: "ws_gone", name: "gone", ownerId: "owner" } });
    const page = await createPage("gone", "ws_gone");
    const campaign = await db.facebookCampaign.create({
      data: {
        workspaceId: "ws_gone",
        facebookPageId: page.id,
        name: "Gone",
        keywords: ["price"],
        privateReplyMessage: "x",
        buttonLabel: "x",
        landingUrl: "https://example.test",
      },
    });
    await db.facebookCommentLog.create({
      data: {
        workspaceId: "ws_gone",
        facebookPageId: page.id,
        campaignId: campaign.id,
        commentId: "gone_comment",
        postId: "post",
        commentText: "price",
        commentCreatedAt: new Date(),
      },
    });
    const conversation = await db.facebookConversation.create({
      data: { workspaceId: "ws_gone", facebookPageId: page.id, psid: "psid_gone" },
    });
    await db.facebookMessage.create({
      data: {
        workspaceId: "ws_gone",
        conversationId: conversation.id,
        direction: "INBOUND",
        author: "CUSTOMER",
        mid: "m_gone",
      },
    });
    await db.facebookConversationEvent.create({
      data: { workspaceId: "ws_gone", conversationId: conversation.id, type: "HANDOFF", category: "COMPLAINT" },
    });
    await db.botSettings.create({ data: { workspaceId: "ws_gone" } });
    await db.knowledgeEntry.create({
      data: { workspaceId: "ws_gone", kind: "PRODUCT", title: "Robe", price: "3500 دج" },
    });
    await db.alertSettings.create({ data: { workspaceId: "ws_gone", telegramBotToken: "encrypted" } });
    const recipient = await db.alertRecipient.create({
      data: { workspaceId: "ws_gone", channel: "EMAIL", label: "Owner", email: "owner@example.test" },
    });
    await db.alertRoute.create({
      data: { workspaceId: "ws_gone", category: "COMPLAINT", recipientId: recipient.id },
    });

    await db.workspace.delete({ where: { id: "ws_gone" } });

    const where = { workspaceId: "ws_gone" };
    expect(await db.facebookPage.count({ where })).toBe(0);
    expect(await db.facebookCampaign.count({ where })).toBe(0);
    expect(await db.facebookCommentLog.count({ where })).toBe(0);
    expect(await db.facebookConversation.count({ where })).toBe(0);
    expect(await db.facebookMessage.count({ where })).toBe(0);
    expect(await db.facebookConversationEvent.count({ where })).toBe(0);
    expect(await db.botSettings.count({ where })).toBe(0);
    expect(await db.knowledgeEntry.count({ where })).toBe(0);
    expect(await db.alertSettings.count({ where })).toBe(0);
    expect(await db.alertRecipient.count({ where })).toBe(0);
    expect(await db.alertRoute.count({ where })).toBe(0);
    // Other workspaces are untouched.
    expect(await db.workspace.count({ where: { id: { in: ["ws_a", "ws_b"] } } })).toBe(2);
  });
});
