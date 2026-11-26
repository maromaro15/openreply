/**
 * Messenger messages, echoes and the inbox on a real PostgreSQL, Graph
 * mocked.
 *
 * What rests on constraints and conditional updates rather than on code
 * paths: a message stored once however many jobs bring it, the window never
 * moving back, one takeover event when several things change hands at once,
 * an echo proving delivery even when it beats the sender, and one brand
 * never touching another's rows.
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
const graph = vi.hoisted(() => ({ getMessengerProfileName: vi.fn(), sendMessage: vi.fn() }));
vi.mock("@/lib/facebook/graph", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/facebook/graph")>()),
  ...graph,
}));
vi.mock("@/lib/facebook/pages", () => ({ pageToken: () => "PAGE_TOKEN" }));
vi.mock("@/lib/facebook/queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/facebook/queue")>()),
  getFacebookQueue: () => ({ add: vi.fn() }),
}));

import { FacebookApiError } from "../../lib/facebook/graph";
import { processMessageJob } from "../../lib/facebook/messages";
import { listConversations, returnConversationToBot, takeOverConversation } from "../../lib/facebook/inbox";
import { sendHumanReply } from "../../lib/facebook/human-reply";
import type { FacebookMessageJob } from "../../lib/facebook/queue";

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIR = path.join(__dirname, "..", "..", "prisma", "migrations");
const schema = `facebook_messages_${randomBytes(4).toString("hex")}`;
const APP_ID = "1517776481860111";
let sql: Client;
let seq = 0;

function job(data: Partial<FacebookMessageJob> & Pick<FacebookMessageJob, "psid">) {
  seq += 1;
  return {
    id: `job_${seq}`,
    name: "fb-message",
    data: {
      facebookPageId: "fp_a",
      pageId: "1001",
      kind: "message",
      mid: `m_${seq}`,
      text: "شحال السعر؟",
      attachments: [],
      sentAt: new Date().toISOString(),
      ...data,
    },
  } as unknown as Job<FacebookMessageJob>;
}

describe.skipIf(!databaseUrl)("Messenger messages on PostgreSQL", () => {
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
    await db.user.create({ data: { id: "owner", email: "owner@agency.test", name: "Yacine" } });
    for (const [workspace, page, pageId] of [
      ["ws_a", "fp_a", "1001"],
      ["ws_b", "fp_b", "2002"],
    ]) {
      await db.workspace.create({ data: { id: workspace, name: workspace, ownerId: "owner" } });
      await db.facebookPage.create({ data: { id: page, workspaceId: workspace, pageId, name: page, accessToken: "enc" } });
    }
    await db.facebookCampaign.create({
      data: {
        id: "camp_a",
        workspaceId: "ws_a",
        facebookPageId: "fp_a",
        name: "Robe",
        matchAnyPost: true,
        keywords: ["سعر"],
        privateReplyMessage: "مرحبا {name}",
        buttonLabel: "التفاصيل",
        landingUrl: "https://shop.example/robe",
        addUtm: false,
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

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("FACEBOOK_APP_ID", APP_ID);
    graph.getMessengerProfileName.mockResolvedValue(null);
  });

  async function conversationOf(psid: string, facebookPageId = "fp_a") {
    return state.db.facebookConversation.findUniqueOrThrow({
      where: { facebookPageId_psid: { facebookPageId, psid } },
      include: { messages: true, events: true },
    });
  }

  it("stores a message once and counts it once, however many jobs bring it", async () => {
    const same = job({ psid: "p_dup", mid: "m_dup" });
    const outcomes = await Promise.all([0, 1, 2, 3].map(() => processMessageJob(same)));
    expect(outcomes.filter((outcome) => outcome === "stored")).toHaveLength(1);
    const conversation = await conversationOf("p_dup");
    expect(conversation.messages).toHaveLength(1);
    expect(conversation.unreadCount).toBe(1);
    expect(conversation.lastInboundAt).not.toBeNull();
  });

  it("a job that died after storing the message brings the conversation up to date on retry, once", async () => {
    await processMessageJob(job({ psid: "p_crash", mid: "m_crash_0", text: "الأولى", sentAt: "2026-11-25T10:00:00.000Z" }));
    const conversation = await conversationOf("p_crash");
    // The crashed job: the row exists, the conversation never heard of it.
    await state.db.facebookMessage.create({
      data: {
        workspaceId: "ws_a",
        conversationId: conversation.id,
        direction: "INBOUND",
        author: "CUSTOMER",
        mid: "m_crash_1",
        text: "الثانية",
        sentAt: new Date("2026-11-25T11:00:00.000Z"),
      },
    });
    const retry = job({ psid: "p_crash", mid: "m_crash_1", text: "الثانية", sentAt: "2026-11-25T11:00:00.000Z" });
    await expect(processMessageJob(retry)).resolves.toBe("duplicate");
    await expect(processMessageJob(retry)).resolves.toBe("duplicate");
    const after = await conversationOf("p_crash");
    expect(after.lastInboundAt?.toISOString()).toBe("2026-11-25T11:00:00.000Z");
    expect(after.lastMessageText).toBe("الثانية");
    expect(after.unreadCount).toBe(2);
  });

  it("never moves the window or the preview back when an older message finishes last", async () => {
    await processMessageJob(job({ psid: "p_order", text: "الثانية", sentAt: "2026-11-25T12:00:00.000Z" }));
    await processMessageJob(job({ psid: "p_order", text: "الأولى", sentAt: "2026-11-25T11:00:00.000Z" }));
    const conversation = await conversationOf("p_order");
    expect(conversation.lastInboundAt?.toISOString()).toBe("2026-11-25T12:00:00.000Z");
    expect(conversation.lastMessageText).toBe("الثانية");
    expect(conversation.unreadCount).toBe(2);
  });

  it("three Business Suite replies at once: HUMAN, with exactly one takeover event", async () => {
    await processMessageJob(job({ psid: "p_meta" }));
    await Promise.all(
      [1, 2, 3].map((n) =>
        processMessageJob(job({ psid: "p_meta", kind: "echo", mid: `m_meta_${n}`, appId: "263902037430900", text: `رد ${n}` }))
      )
    );
    const conversation = await conversationOf("p_meta");
    expect(conversation).toMatchObject({ mode: "HUMAN", modeReason: "META_REPLY", needsHuman: false, unreadCount: 0 });
    expect(conversation.events.filter((event) => event.type === "HUMAN_TAKEOVER")).toHaveLength(1);
    expect(conversation.messages.filter((message) => message.author === "HUMAN" && message.origin === "EXTERNAL")).toHaveLength(3);
  });

  it("the echo of our own message proves delivery and changes nothing else", async () => {
    await processMessageJob(job({ psid: "p_ours" }));
    const conversation = await conversationOf("p_ours");
    const sent = await state.db.facebookMessage.create({
      data: {
        workspaceId: "ws_a",
        conversationId: conversation.id,
        direction: "OUTBOUND",
        author: "HUMAN",
        origin: "OPENREPLY",
        text: "متوفر",
        sendStatus: "UNCONFIRMED",
      },
    });
    await expect(
      processMessageJob(job({ psid: "p_ours", kind: "echo", mid: "m_ours", metadata: `openreply:${sent.id}`, appId: APP_ID }))
    ).resolves.toBe("reconciled");
    const after = await conversationOf("p_ours");
    expect(after.messages.find((message) => message.id === sent.id)).toMatchObject({ sendStatus: "SENT", mid: "m_ours" });
    expect(after).toMatchObject({ mode: "BOT", needsHuman: false });
    expect(after.events).toHaveLength(0);
  });

  it("an UNCONFIRMED private reply becomes SENT from its echo, and opens the conversation once", async () => {
    const log = await state.db.facebookCommentLog.create({
      data: {
        workspaceId: "ws_a",
        facebookPageId: "fp_a",
        campaignId: "camp_a",
        commentId: "1001_c_unconfirmed",
        postId: "1001_p",
        commenterName: "Amina B.",
        commentText: "السعر؟",
        commentCreatedAt: new Date(),
        status: "UNCONFIRMED",
        deliveryUnconfirmed: true,
        attempts: 1,
      },
    });
    const echo = job({ psid: "p_comment", kind: "echo", mid: "m_private", metadata: `openreply:c:${log.id}`, appId: APP_ID });
    await processMessageJob(echo);
    await processMessageJob(echo);
    expect(await state.db.facebookCommentLog.findUniqueOrThrow({ where: { id: log.id } })).toMatchObject({
      status: "SENT",
      deliveryUnconfirmed: false,
      recipientPsid: "p_comment",
      privateReplyMessageId: "m_private",
    });
    const conversation = await conversationOf("p_comment");
    expect(conversation).toMatchObject({ userName: "Amina B.", sourceCampaignId: "camp_a", lastInboundAt: null });
    expect(conversation.messages).toEqual([
      expect.objectContaining({ author: "CAMPAIGN", mid: "m_private", text: "مرحبا Amina\nhttps://shop.example/robe" }),
    ]);
  });

  it("metadata naming another brand's message touches nothing", async () => {
    await processMessageJob(job({ psid: "p_iso" }));
    const own = await conversationOf("p_iso");
    const message = await state.db.facebookMessage.create({
      data: {
        workspaceId: "ws_a",
        conversationId: own.id,
        direction: "OUTBOUND",
        author: "BOT",
        origin: "OPENREPLY",
        text: "x",
        sendStatus: "UNCONFIRMED",
      },
    });
    await expect(
      processMessageJob(
        job({ psid: "p_iso", facebookPageId: "fp_b", pageId: "2002", kind: "echo", mid: "m_iso", metadata: `openreply:${message.id}` })
      )
    ).resolves.toBe("unknown_reference");
    expect(await state.db.facebookMessage.findUniqueOrThrow({ where: { id: message.id } })).toMatchObject({
      sendStatus: "UNCONFIRMED",
      mid: null,
    });
  });

  it("takeovers and returns racing each other leave one event each, inside the brand", async () => {
    await processMessageJob(job({ psid: "p_race" }));
    const conversation = await conversationOf("p_race");
    const takeovers = await Promise.all(
      [1, 2, 3].map(() => takeOverConversation(conversation.id, { reason: "INBOX_TAKEOVER", actorUserId: "owner" }))
    );
    expect(takeovers.filter(Boolean)).toHaveLength(1);
    const returns = await Promise.all([1, 2].map(() => returnConversationToBot(conversation.id, "owner")));
    expect(returns.filter(Boolean)).toHaveLength(1);
    const after = await conversationOf("p_race");
    expect(after.events.map((event) => event.type).sort()).toEqual(["HUMAN_TAKEOVER", "RETURNED_TO_BOT"]);
    expect(after).toMatchObject({ mode: "BOT", modeReason: "INBOX_RELEASE" });

    const otherBrand = await listConversations("ws_b", { filter: "all" });
    expect(otherBrand.conversations.map((item) => item.id)).not.toContain(conversation.id);
    const ownBrand = await listConversations("ws_a", { filter: "all", limit: 100 });
    expect(ownBrand.conversations.map((item) => item.id)).toContain(conversation.id);
  });

  it("a reply whose echo beats Meta's answer stays SENT, even if that answer is lost", async () => {
    await processMessageJob(job({ psid: "p_reply" }));
    const conversation = await conversationOf("p_reply");
    graph.sendMessage.mockImplementation(async (_pageId: string, _token: string, message: { metadata: string }) => {
      // Meta delivered and echoed; then the connection dropped.
      await processMessageJob(
        job({ psid: "p_reply", kind: "echo", mid: "m_lost_answer", metadata: message.metadata, appId: APP_ID })
      );
      throw new FacebookApiError("socket hang up", "ambiguous");
    });
    const result = await sendHumanReply({
      workspaceId: "ws_a",
      userId: "owner",
      conversationId: conversation.id,
      text: "متوفر بالمقاس M",
    });
    expect(result).toMatchObject({ ok: false, code: "unconfirmed" });
    const after = await conversationOf("p_reply");
    expect(after.messages.find((message) => message.author === "HUMAN")).toMatchObject({
      sendStatus: "SENT",
      mid: "m_lost_answer",
      sentByUserId: "owner",
    });
  });

  it("the conversation is the person's before the Graph send starts", async () => {
    await processMessageJob(job({ psid: "p_before_send" }));
    const conversation = await conversationOf("p_before_send");
    let modeDuringSend: string | undefined;
    graph.sendMessage.mockImplementation(async () => {
      modeDuringSend = (await conversationOf("p_before_send")).mode;
      return { recipient_id: "p_before_send", message_id: "m_before_send" };
    });
    await sendHumanReply({ workspaceId: "ws_a", userId: "owner", conversationId: conversation.id, text: "نعم" });
    expect(modeDuringSend).toBe("HUMAN");
  });

  it("a reply from the inbox takes the conversation from the bot", async () => {
    await processMessageJob(job({ psid: "p_inbox" }));
    const conversation = await conversationOf("p_inbox");
    graph.sendMessage.mockResolvedValue({ recipient_id: "p_inbox", message_id: "m_inbox_reply" });
    const result = await sendHumanReply({
      workspaceId: "ws_a",
      userId: "owner",
      conversationId: conversation.id,
      text: "مرحبا، نعم متوفر",
    });
    expect(result).toMatchObject({ ok: true, message: { sendStatus: "SENT", sentBy: null } });
    const after = await conversationOf("p_inbox");
    expect(after).toMatchObject({ mode: "HUMAN", modeReason: "INBOX_TAKEOVER", unreadCount: 0 });
    expect(after.events).toEqual([expect.objectContaining({ type: "HUMAN_TAKEOVER", actorUserId: "owner" })]);

    // The same reply cannot be sent from another brand.
    await expect(
      sendHumanReply({ workspaceId: "ws_b", userId: "owner", conversationId: conversation.id, text: "x" })
    ).resolves.toMatchObject({ ok: false, code: "not_found" });
  });
});
