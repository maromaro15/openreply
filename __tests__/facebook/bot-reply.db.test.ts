/**
 * The bot on a real PostgreSQL, Gemini and Graph mocked.
 *
 * What rests on the database: one reply per message however many jobs run,
 * one handoff however many things race, the conversation going silent after
 * a handoff, and each brand's bot reading only its own knowledge base.
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
const graph = vi.hoisted(() => ({ sendMessage: vi.fn(), getMessengerProfileName: vi.fn() }));
vi.mock("@/lib/facebook/graph", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/facebook/graph")>()),
  ...graph,
}));
const ai = vi.hoisted(() => ({ generateJson: vi.fn() }));
vi.mock("@/lib/ai/gemini", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/ai/gemini")>()),
  ...ai,
}));
const queue = vi.hoisted(() => ({ add: vi.fn() }));
vi.mock("@/lib/facebook/pages", () => ({ pageToken: () => "PAGE_TOKEN" }));
vi.mock("@/lib/facebook/queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/facebook/queue")>()),
  getFacebookQueue: () => queue,
}));

import { processBotReplyJob } from "../../lib/facebook/bot-reply";
import { handOffConversation } from "../../lib/facebook/handoff";
import { processMessageJob } from "../../lib/facebook/messages";
import type { FacebookBotReplyJob, FacebookMessageJob } from "../../lib/facebook/queue";

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIR = path.join(__dirname, "..", "..", "prisma", "migrations");
const schema = `facebook_bot_${randomBytes(4).toString("hex")}`;
let sql: Client;
let seq = 0;

function message(data: Partial<FacebookMessageJob> & Pick<FacebookMessageJob, "psid">, page = { id: "fp_a", pageId: "1001" }) {
  seq += 1;
  return {
    id: `msg_job_${seq}`,
    name: "fb-message",
    data: {
      facebookPageId: page.id,
      pageId: page.pageId,
      kind: "message",
      mid: `m_${seq}`,
      text: "شحال الروبة؟",
      attachments: [],
      sentAt: new Date(Date.now() + seq).toISOString(),
      ...data,
    },
  } as unknown as Job<FacebookMessageJob>;
}

/** The bot job the last stored message queued. */
function queuedBotJob(): Job<FacebookBotReplyJob> {
  const [name, data] = queue.add.mock.calls.at(-1)!;
  expect(name).toBe("fb-bot-reply");
  return { id: "fbr", name, data, attemptsMade: 0, opts: { attempts: 3 } } as unknown as Job<FacebookBotReplyJob>;
}

function modelSays(output: Record<string, unknown>) {
  ai.generateJson.mockResolvedValue({ data: output, result: { text: "", finishReason: "STOP", usage: null } });
}

describe.skipIf(!databaseUrl)("The bot on PostgreSQL", () => {
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
    for (const [workspace, page, pageId, product, price] of [
      ["ws_a", "fp_a", "1001", "Robe Kabyle", "4500 DA"],
      ["ws_b", "fp_b", "2002", "Burnous", "9000 DA"],
    ]) {
      await db.workspace.create({ data: { id: workspace, name: workspace, ownerId: "owner" } });
      await db.facebookPage.create({ data: { id: page, workspaceId: workspace, pageId, name: page, accessToken: "enc" } });
      await db.botSettings.create({ data: { workspaceId: workspace, enabled: true } });
      await db.knowledgeEntry.create({ data: { workspaceId: workspace, kind: "PRODUCT", title: product, price } });
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
    vi.stubEnv("GOOGLE_API_KEY", "AIza-test");
    graph.getMessengerProfileName.mockResolvedValue(null);
    let n = 0;
    graph.sendMessage.mockImplementation(async () => {
      n += 1;
      return { recipient_id: "x", message_id: `m_out_${seq}_${n}` };
    });
    modelSays({ handoff: false, category: "NONE", reason: "", reply: "السعر 4500 DA" });
  });

  async function conversationOf(psid: string, facebookPageId = "fp_a") {
    return state.db.facebookConversation.findUniqueOrThrow({
      where: { facebookPageId_psid: { facebookPageId, psid } },
      include: { messages: { orderBy: { sentAt: "asc" } }, events: true },
    });
  }

  it("four copies of the same bot job send one reply", async () => {
    await processMessageJob(message({ psid: "p_dup" }));
    const botJob = queuedBotJob();
    const outcomes = await Promise.all([0, 1, 2, 3].map(() => processBotReplyJob(botJob)));
    expect(outcomes.filter((outcome) => outcome === "replied")).toHaveLength(1);
    expect(graph.sendMessage).toHaveBeenCalledTimes(1);
    const conversation = await conversationOf("p_dup");
    expect(conversation.messages.filter((row) => row.author === "BOT")).toEqual([
      expect.objectContaining({ sendStatus: "SENT", text: "السعر 4500 DA" }),
    ]);
  });

  it("answers, recognises its own echo, hands off, then stays silent", async () => {
    await processMessageJob(message({ psid: "p_flow" }));
    await expect(processBotReplyJob(queuedBotJob())).resolves.toBe("replied");
    const reply = (await conversationOf("p_flow")).messages.find((row) => row.author === "BOT")!;

    // The echo of the bot's own reply: nothing changes hands.
    await processMessageJob(
      message({ psid: "p_flow", kind: "echo", mid: reply.mid!, metadata: `openreply:${reply.id}`, appId: "1517776481860111" })
    );
    expect(await conversationOf("p_flow")).toMatchObject({ mode: "BOT", needsHuman: false });

    modelSays({ handoff: true, category: "WHOLESALE_ORDER", reason: "يحب 50 حبة", reply: "" });
    await processMessageJob(message({ psid: "p_flow", text: "نحب 50 حبة بسعر الجملة" }));
    await expect(processBotReplyJob(queuedBotJob())).resolves.toBe("handed_off");
    const handedOff = await conversationOf("p_flow");
    expect(handedOff).toMatchObject({
      mode: "HUMAN",
      modeReason: "BOT_HANDOFF",
      needsHuman: true,
      handoffCategory: "WHOLESALE_ORDER",
      handoffReason: "يحب 50 حبة",
    });
    expect(handedOff.events).toEqual([expect.objectContaining({ type: "HANDOFF", category: "WHOLESALE_ORDER" })]);
    expect(handedOff.messages.at(-1)).toMatchObject({ author: "BOT", text: "نرجعولك", sendStatus: "SENT" });

    // With a person now: the next message queues nothing.
    queue.add.mockClear();
    await processMessageJob(message({ psid: "p_flow", text: "واش؟" }));
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("racing handoffs leave one HANDOFF event", async () => {
    await processMessageJob(message({ psid: "p_race" }));
    const conversation = await conversationOf("p_race");
    const results = await Promise.all(
      [1, 2, 3].map(() => handOffConversation(conversation.id, { category: "COMPLAINT", reason: "غاضب" }))
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await conversationOf("p_race")).events).toHaveLength(1);
  });

  it("each brand's bot reads only its own knowledge base", async () => {
    modelSays({ handoff: false, category: "NONE", reason: "", reply: "Le prix est 9000 DA" });
    await processMessageJob(message({ psid: "p_b" }, { id: "fp_b", pageId: "2002" }));
    await expect(processBotReplyJob(queuedBotJob())).resolves.toBe("replied");
    const system = ai.generateJson.mock.calls[0][0].systemInstruction as string;
    expect(system).toContain("Burnous | Price: 9000 DA");
    expect(system).not.toContain("Robe Kabyle");

    // Brand A's price is not a fact in brand B: the guard stops it.
    ai.generateJson.mockClear();
    modelSays({ handoff: false, category: "NONE", reason: "", reply: "السعر 4500 DA" });
    await processMessageJob(message({ psid: "p_b2" }, { id: "fp_b", pageId: "2002" }));
    await expect(processBotReplyJob(queuedBotJob())).resolves.toBe("handed_off");
    expect(await conversationOf("p_b2", "fp_b")).toMatchObject({ handoffCategory: "NOT_IN_KB" });
  });
});
