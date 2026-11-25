/**
 * Comment → private reply on a real PostgreSQL, Graph mocked.
 *
 * The promises that rest on database constraints, not on code paths:
 * one private reply per comment even with duplicate and concurrent jobs,
 * the conversation opened with the commenter's PSID, and one brand's
 * campaigns never answering another brand's Page.
 *
 * Skipped unless TEST_DATABASE_URL points at a disposable database.
 */
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import type { Job } from "bullmq";
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
const graph = vi.hoisted(() => ({ sendPrivateReply: vi.fn(), replyToComment: vi.fn() }));
vi.mock("@/lib/facebook/graph", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/facebook/graph")>()),
  ...graph,
}));
vi.mock("@/lib/utils/rate-limiter", () => ({
  reserveDMSlot: async () => ({ allowed: true, reserved: true }),
  releaseDMSlot: async () => 0,
  pauseDMSends: async () => undefined,
  recordDelivery: async () => undefined,
}));
vi.mock("@/lib/facebook/pages", () => ({ pageToken: () => "PAGE_TOKEN" }));
vi.mock("@/lib/facebook/queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/facebook/queue")>()),
  getFacebookQueue: () => ({ add: vi.fn() }),
}));

import { processCommentJob } from "../../lib/facebook/comments";
import type { FacebookCommentJob } from "../../lib/facebook/queue";

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIR = path.join(__dirname, "..", "..", "prisma", "migrations");
const schema = `facebook_comments_${randomBytes(4).toString("hex")}`;
let sql: Client;

function job(data: Partial<FacebookCommentJob> & Pick<FacebookCommentJob, "facebookPageId" | "pageId" | "commentId">) {
  return {
    id: `job_${data.commentId}`,
    name: "fb-comment",
    data: {
      postId: `${data.pageId}_post`,
      commenterId: "999",
      commenterName: "Amina B.",
      text: "شحال السعر؟",
      createdAt: new Date().toISOString(),
      ...data,
    },
  } as unknown as Job<FacebookCommentJob>;
}

describe.skipIf(!databaseUrl)("Facebook comments on PostgreSQL", () => {
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
    const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }, { schema }) });
    state.db = db;
    await db.user.create({ data: { id: "owner", email: "owner@agency.test" } });
    for (const [workspace, page, pageId] of [
      ["ws_a", "fp_a", "1001"],
      ["ws_b", "fp_b", "2002"],
    ]) {
      await db.workspace.create({ data: { id: workspace, name: workspace, ownerId: "owner" } });
      await db.facebookPage.create({
        data: { id: page, workspaceId: workspace, pageId, name: page, accessToken: "enc" },
      });
      await db.facebookCampaign.create({
        data: {
          id: `camp_${workspace}`,
          workspaceId: workspace,
          facebookPageId: page,
          name: `Campaign ${workspace}`,
          matchAnyPost: true,
          keywords: ["سعر"],
          privateReplyMessage: "مرحبا {name}",
          buttonLabel: "التفاصيل",
          landingUrl: "https://shop.example",
          addUtm: false,
        },
      });
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
    vi.clearAllMocks();
    let n = 0;
    graph.sendPrivateReply.mockImplementation(async () => {
      n += 1;
      return { recipient_id: `psid_${n}`, message_id: `mid_${n}_${randomBytes(3).toString("hex")}` };
    });
  });

  it("sends once, logs it, and opens the conversation with the commenter's PSID", async () => {
    await expect(processCommentJob(job({ facebookPageId: "fp_a", pageId: "1001", commentId: "1001_c1" }))).resolves.toBe("sent");

    const log = await state.db.facebookCommentLog.findUniqueOrThrow({
      where: { facebookPageId_commentId: { facebookPageId: "fp_a", commentId: "1001_c1" } },
    });
    expect(log).toMatchObject({ workspaceId: "ws_a", campaignId: "camp_ws_a", status: "SENT", attempts: 1, recipientPsid: "psid_1" });

    const conversation = await state.db.facebookConversation.findUniqueOrThrow({
      where: { facebookPageId_psid: { facebookPageId: "fp_a", psid: "psid_1" } },
      include: { messages: true },
    });
    expect(conversation).toMatchObject({ workspaceId: "ws_a", userName: "Amina B.", sourceCampaignId: "camp_ws_a", sourceCommentId: "1001_c1", mode: "BOT" });
    expect(conversation.lastInboundAt).toBeNull();
    expect(conversation.messages).toHaveLength(1);
    expect(conversation.messages[0]).toMatchObject({ direction: "OUTBOUND", author: "CAMPAIGN", origin: "OPENREPLY", sendStatus: "SENT" });

    // The same job again, as after a webhook retry: nothing more is sent.
    await expect(processCommentJob(job({ facebookPageId: "fp_a", pageId: "1001", commentId: "1001_c1" }))).resolves.toBe("nothing_to_do");
    expect(graph.sendPrivateReply).toHaveBeenCalledTimes(1);
  });

  it("sends once when two jobs for one comment run at the same time", async () => {
    const outcomes = await Promise.all(
      Array.from({ length: 4 }, () => processCommentJob(job({ facebookPageId: "fp_a", pageId: "1001", commentId: "1001_race" })))
    );
    expect(outcomes.filter((outcome) => outcome === "sent")).toHaveLength(1);
    expect(graph.sendPrivateReply).toHaveBeenCalledTimes(1);
    expect(
      await state.db.facebookCommentLog.count({ where: { facebookPageId: "fp_a", commentId: "1001_race" } })
    ).toBe(1);
  });

  it("answers each brand's comments with that brand's campaign only", async () => {
    await processCommentJob(job({ facebookPageId: "fp_b", pageId: "2002", commentId: "2002_c1" }));
    const log = await state.db.facebookCommentLog.findUniqueOrThrow({
      where: { facebookPageId_commentId: { facebookPageId: "fp_b", commentId: "2002_c1" } },
    });
    expect(log).toMatchObject({ workspaceId: "ws_b", campaignId: "camp_ws_b" });
    expect(graph.sendPrivateReply).toHaveBeenCalledWith("2002", "PAGE_TOKEN", expect.anything());

    // A job claiming brand A's Page with brand B's Page ID is ignored.
    await expect(processCommentJob(job({ facebookPageId: "fp_a", pageId: "2002", commentId: "2002_c2" }))).resolves.toBe("ignored");
  });

  it("records a comment past 7 days as expired without sending", async () => {
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    await expect(processCommentJob(job({ facebookPageId: "fp_a", pageId: "1001", commentId: "1001_old", createdAt: old }))).resolves.toBe("expired");
    expect(graph.sendPrivateReply).not.toHaveBeenCalled();
    const log = await state.db.facebookCommentLog.findUniqueOrThrow({
      where: { facebookPageId_commentId: { facebookPageId: "fp_a", commentId: "1001_old" } },
    });
    expect(log.status).toBe("SKIPPED_EXPIRED");
  });
});
