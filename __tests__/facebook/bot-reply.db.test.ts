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
const voice = vi.hoisted(() => ({ transcribeAudioUrl: vi.fn() }));
vi.mock("@/lib/ai/transcribe", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/ai/transcribe")>()),
  ...voice,
}));
vi.mock("@/lib/facebook/pages", () => ({ pageToken: () => "PAGE_TOKEN" }));
vi.mock("@/lib/facebook/queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/facebook/queue")>()),
  getFacebookQueue: () => queue,
}));

import { processBotReplyJob } from "../../lib/facebook/bot-reply";
import { FacebookApiError } from "../../lib/facebook/graph";
import { SYSTEM_REASONS } from "../../lib/bot/classify";
import { handOffConversation } from "../../lib/facebook/handoff";
import { processMessageJob } from "../../lib/facebook/messages";
import { processTranscribeJob } from "../../lib/facebook/transcription";
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

  it("a message written while the model thinks is answered once, by its own job", async () => {
    const now = Date.now();
    await processMessageJob(message({ psid: "p_race", mid: "m_race_A", text: "شحال الروبة؟", sentAt: new Date(now - 10_000).toISOString() }));
    const jobA = queuedBotJob();
    let jobB: Job<FacebookBotReplyJob> | null = null;
    ai.generateJson.mockImplementationOnce(async () => {
      // The customer writes again while the model answers the first message.
      await processMessageJob(message({ psid: "p_race", mid: "m_race_B", text: "و كاين لون أحمر؟", sentAt: new Date(now - 5_000).toISOString() }));
      jobB = queuedBotJob();
      return { data: { handoff: false, category: "NONE", reason: "", reply: "السعر 4500 DA" }, result: { text: "", finishReason: "STOP", usage: null } };
    });
    await expect(processBotReplyJob(jobA)).resolves.toBe("superseded");
    expect(graph.sendMessage).not.toHaveBeenCalled();
    await expect(processBotReplyJob(jobB!)).resolves.toBe("replied");
    // The second job read both messages, and one reply went out.
    expect(ai.generateJson.mock.calls[1][0].contents[0].parts[0].text).toContain("Customer: شحال الروبة؟\nCustomer: و كاين لون أحمر؟");
    expect(graph.sendMessage).toHaveBeenCalledTimes(1);
    const conversation = await conversationOf("p_race");
    expect(conversation.messages.filter((row) => row.author === "BOT")).toEqual([expect.objectContaining({ replyToMid: "m_race_B", sendStatus: "SENT" })]);
  });

  it("when the newer message's job runs first, it answers both and the older job steps aside", async () => {
    const now = Date.now();
    await processMessageJob(message({ psid: "p_race2", mid: "m_race2_A", text: "salam", sentAt: new Date(now - 10_000).toISOString() }));
    const jobA = queuedBotJob();
    const outcomes: string[] = [];
    ai.generateJson.mockImplementationOnce(async () => {
      await processMessageJob(message({ psid: "p_race2", mid: "m_race2_B", text: "شحال الروبة؟", sentAt: new Date(now - 5_000).toISOString() }));
      outcomes.push(await processBotReplyJob(queuedBotJob()));
      return { data: { handoff: false, category: "NONE", reason: "", reply: "مرحبا" }, result: { text: "", finishReason: "STOP", usage: null } };
    });
    outcomes.push(await processBotReplyJob(jobA));
    expect(outcomes).toEqual(["replied", "superseded"]);
    expect(graph.sendMessage).toHaveBeenCalledTimes(1);
    expect(ai.generateJson.mock.calls[1][0].contents[0].parts[0].text).toContain("Customer: salam\nCustomer: شحال الروبة؟");
  });

  it("a reply Facebook refuses hands the conversation to a person, without writing again", async () => {
    await processMessageJob(message({ psid: "p_refused" }));
    graph.sendMessage.mockRejectedValueOnce(new FacebookApiError("(#551) This person isn't available right now.", "not_eligible", 551));
    await expect(processBotReplyJob(queuedBotJob())).resolves.toBe("failed");
    expect(graph.sendMessage).toHaveBeenCalledTimes(1);
    const conversation = await conversationOf("p_refused");
    expect(conversation).toMatchObject({ mode: "HUMAN", needsHuman: true, handoffCategory: "OTHER", handoffReason: SYSTEM_REASONS.replyRefused });
    expect(conversation.messages.filter((row) => row.author === "BOT")).toEqual([expect.objectContaining({ sendStatus: "FAILED" })]);
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

  it("a voice message: the bot waits for its transcript, then answers from it", async () => {
    voice.transcribeAudioUrl.mockResolvedValue({ transcript: "شحال الروبة القبايلية؟", mimeType: "audio/mp4", converted: true });
    await processMessageJob(
      message({ psid: "p_voice", text: undefined, attachments: [{ type: "audio", url: "https://cdn.fbsbx.com/voice.mp4" }] })
    );
    const transcribeCall = queue.add.mock.calls.find(([name]) => name === "fb-transcribe")!;
    const botJob = queuedBotJob();

    await expect(processBotReplyJob(botJob)).resolves.toBe("waiting_transcript");
    const waitCall = queue.add.mock.calls.at(-1)!;
    expect(waitCall[1]).toMatchObject({ waits: 1 });

    await expect(
      processTranscribeJob({ id: "t", name: "fb-transcribe", data: transcribeCall[1] } as never)
    ).resolves.toBe("transcribed");
    const conversation = await conversationOf("p_voice");
    expect(conversation.messages[0]).toMatchObject({ transcriptStatus: "DONE", transcript: "شحال الروبة القبايلية؟" });
    expect(conversation.lastMessageText).toBe("🎤 شحال الروبة القبايلية؟");

    await expect(
      processBotReplyJob({ ...botJob, data: waitCall[1] } as unknown as Job<FacebookBotReplyJob>)
    ).resolves.toBe("replied");
    expect(ai.generateJson.mock.calls.at(-1)![0].contents[0].parts[0].text).toContain(
      "Customer (voice message, transcribed): شحال الروبة القبايلية؟"
    );
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
