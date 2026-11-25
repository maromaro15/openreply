import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";
import { Prisma } from "../../app/generated/prisma/client";

const NOW = new Date("2026-11-25T12:00:00Z");

const s = vi.hoisted(() => ({
  conversation: {} as Record<string, unknown>,
  page: {} as Record<string, unknown>,
  settings: null as null | Record<string, unknown>,
  latestMid: "m_in_2" as string | null,
  claimed: null as null | { id: string },
  lastOutbound: null as null | { sentAt: Date },
  pending: [] as Record<string, unknown>[],
  history: [] as Record<string, unknown>[],
  botRepliesLastHour: 0,
  fresh: null as null | Record<string, unknown>,
}));

const db = vi.hoisted(() => ({
  facebookConversation: { findUnique: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
  facebookMessage: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
  },
  facebookPage: { findUnique: vi.fn(), update: vi.fn() },
  facebookCampaign: { findFirst: vi.fn() },
  facebookConversationEvent: { create: vi.fn() },
  botSettings: { findUnique: vi.fn() },
  knowledgeEntry: { findMany: vi.fn() },
  $transaction: vi.fn(),
}));
const graph = vi.hoisted(() => ({ sendMessage: vi.fn(), getMessengerProfileName: vi.fn() }));
const ai = vi.hoisted(() => ({ generateJson: vi.fn() }));
const queue = vi.hoisted(() => ({ add: vi.fn() }));

vi.mock("@/lib/db/client", () => ({ prisma: db }));
vi.mock("@/lib/facebook/graph", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/facebook/graph")>()),
  ...graph,
}));
vi.mock("@/lib/ai/gemini", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/ai/gemini")>()),
  ...ai,
}));
vi.mock("@/lib/facebook/pages", () => ({ pageToken: () => "PAGE_TOKEN" }));
vi.mock("@/lib/facebook/queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/facebook/queue")>()),
  getFacebookQueue: () => queue,
}));

import { FacebookApiError } from "../../lib/facebook/graph";
import { GeminiError } from "../../lib/ai/gemini";
import {
  MAX_BOT_REPLIES_PER_HOUR,
  MAX_TRANSCRIPT_WAITS,
  processBotReplyJob,
  TRANSCRIPT_WAIT_MS,
} from "../../lib/facebook/bot-reply";
import { processMessageJob } from "../../lib/facebook/messages";
import { dispatchFacebookJob } from "../../lib/facebook/worker";
import { SYSTEM_REASONS } from "../../lib/bot/classify";
import { GUARD_REASONS } from "../../lib/bot/guard";
import { botReplyJobId, type FacebookBotReplyJob, type FacebookMessageJob } from "../../lib/facebook/queue";

const PAGE = { id: "fp_1", pageId: "1001", name: "Lina Outlet", workspaceId: "ws_a", status: "ACTIVE", accessToken: "enc", botEnabled: true };

function inbound(mid: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `msg_${mid}`,
    direction: "INBOUND",
    author: "CUSTOMER",
    origin: null,
    mid,
    text: "شحال الروبة؟",
    attachmentType: null,
    attachmentUrl: null,
    transcript: null,
    transcriptStatus: null,
    sendStatus: null,
    sentAt: new Date("2026-11-25T11:59:50Z"),
    ...overrides,
  };
}

function job(overrides: Partial<FacebookBotReplyJob> = {}, attemptsMade = 0) {
  return {
    id: "fbr_1",
    name: "fb-bot-reply",
    attemptsMade,
    opts: { attempts: 3 },
    data: { facebookPageId: "fp_1", conversationId: "conv_1", triggerMid: "m_in_2", ...overrides },
  } as unknown as Job<FacebookBotReplyJob>;
}

function modelSays(output: Record<string, unknown>) {
  ai.generateJson.mockResolvedValue({ data: output, result: { text: "", finishReason: "STOP", usage: null } });
}

function uniqueViolation() {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "7" });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("GOOGLE_API_KEY", "AIza-test");
  s.page = { ...PAGE };
  s.conversation = {
    id: "conv_1",
    workspaceId: "ws_a",
    facebookPageId: "fp_1",
    psid: "psid_1",
    mode: "BOT",
    needsHuman: false,
    sourceCampaignId: null,
    lastInboundAt: new Date("2026-11-25T11:59:50Z"),
  };
  s.settings = { workspaceId: "ws_a", enabled: true, businessName: "Maison Lina", instructions: null, handoffMessage: "نرجعولك" };
  s.latestMid = "m_in_2";
  s.claimed = null;
  s.lastOutbound = null;
  s.pending = [inbound("m_in_1", { text: "salam" }), inbound("m_in_2")];
  s.history = [...s.pending].reverse();
  s.botRepliesLastHour = 0;
  s.fresh = null;

  db.$transaction.mockImplementation(async (fn: (tx: typeof db) => unknown) => fn(db));
  db.facebookConversation.findUnique.mockImplementation(async (args: { include?: unknown; select?: Record<string, boolean> }) => {
    if (args.include) return { ...s.conversation, page: s.page };
    if (args.select?.lastInboundAt) return s.fresh ?? s.conversation;
    return { workspaceId: "ws_a", mode: (s.fresh ?? s.conversation).mode, needsHuman: (s.fresh ?? s.conversation).needsHuman };
  });
  db.facebookConversation.updateMany.mockResolvedValue({ count: 1 });
  db.facebookConversation.update.mockResolvedValue({});
  db.facebookMessage.findFirst.mockImplementation(async (args: { where: Record<string, unknown> }) => {
    if ("replyToMid" in args.where) return s.claimed;
    if (args.where.direction === "INBOUND") return s.latestMid ? { mid: s.latestMid } : null;
    return s.lastOutbound;
  });
  db.facebookMessage.findMany.mockImplementation(async (args: { where: Record<string, unknown> }) =>
    args.where.direction === "INBOUND" ? s.pending : s.history
  );
  db.facebookMessage.count.mockImplementation(async () => s.botRepliesLastHour);
  db.facebookMessage.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "out_1", ...data }));
  db.facebookMessage.update.mockResolvedValue({});
  db.facebookMessage.updateMany.mockResolvedValue({ count: 1 });
  db.facebookMessage.deleteMany.mockResolvedValue({ count: 1 });
  db.facebookPage.findUnique.mockImplementation(async () => ({ status: s.page.status }));
  db.facebookPage.update.mockResolvedValue({});
  db.facebookConversationEvent.create.mockResolvedValue({ id: "evt_1" });
  db.botSettings.findUnique.mockImplementation(async () => s.settings);
  db.knowledgeEntry.findMany.mockResolvedValue([
    { id: "k1", kind: "PRODUCT", title: "Robe Kabyle", content: "S à XL", price: "4500 DA", isActive: true, sortOrder: 0, createdAt: NOW },
  ]);
  db.facebookCampaign.findFirst.mockResolvedValue(null);
  graph.sendMessage.mockResolvedValue({ recipient_id: "psid_1", message_id: "m_out_1" });
  modelSays({ handoff: false, category: "NONE", reason: "", reply: "السعر 4500 DA" });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("scheduling the bot's turn (the debounce)", () => {
  const message = (overrides: Partial<FacebookMessageJob> = {}) =>
    ({
      id: "fbm_1",
      name: "fb-message",
      data: {
        facebookPageId: "fp_1",
        pageId: "1001",
        kind: "message",
        psid: "psid_1",
        mid: "m_in_9",
        text: "prix?",
        attachments: [],
        sentAt: NOW.toISOString(),
        ...overrides,
      },
    }) as unknown as Job<FacebookMessageJob>;

  beforeEach(() => {
    db.facebookPage.findUnique.mockResolvedValue({ ...PAGE });
    db.facebookConversation.findUnique.mockResolvedValue({ ...s.conversation, userName: "Amina" });
    db.facebookMessage.create.mockResolvedValue({ id: "msg_9" });
  });

  it("queues the bot a few seconds after each message, once per message", async () => {
    await processMessageJob(message());
    expect(queue.add).toHaveBeenCalledWith(
      "fb-bot-reply",
      { facebookPageId: "fp_1", conversationId: "conv_1", triggerMid: "m_in_9" },
      { jobId: botReplyJobId("conv_1", "m_in_9"), delay: 7000 }
    );
    vi.stubEnv("BOT_DEBOUNCE_MS", "3000");
    await processMessageJob(message({ mid: "m_in_10" }));
    expect(queue.add.mock.calls[1][2]).toMatchObject({ delay: 3000 });
  });

  it.each([
    ["the bot is off for the brand", () => (s.settings = { ...s.settings, enabled: false })],
    ["the bot is off on the Page", () => db.facebookPage.findUnique.mockResolvedValue({ ...PAGE, botEnabled: false })],
    ["the Page token died", () => db.facebookPage.findUnique.mockResolvedValue({ ...PAGE, status: "TOKEN_INVALID" })],
    [
      "a person has the conversation",
      () => db.facebookConversation.findUnique.mockResolvedValue({ ...s.conversation, mode: "HUMAN", userName: "A" }),
    ],
  ])("stays silent when %s", async (_case, setup) => {
    setup();
    await processMessageJob(message());
    expect(queue.add).not.toHaveBeenCalled();
  });
});

describe("the bot's reply", () => {
  it("answers everything since the Page last spoke, claimed on the latest message", async () => {
    await expect(processBotReplyJob(job())).resolves.toBe("replied");
    expect(ai.generateJson.mock.calls[0][0].contents[0].parts[0].text).toContain("Customer: salam\nCustomer: شحال الروبة؟");
    expect(db.facebookMessage.create).toHaveBeenCalledWith({
      data: {
        workspaceId: "ws_a",
        conversationId: "conv_1",
        direction: "OUTBOUND",
        author: "BOT",
        origin: "OPENREPLY",
        replyToMid: "m_in_2",
        text: "السعر 4500 DA",
        sendStatus: "PENDING",
      },
    });
    expect(graph.sendMessage).toHaveBeenCalledWith("1001", "PAGE_TOKEN", {
      psid: "psid_1",
      text: "السعر 4500 DA",
      metadata: "openreply:out_1",
    });
    expect(db.facebookMessage.update).toHaveBeenCalledWith({
      where: { id: "out_1" },
      data: expect.objectContaining({ sendStatus: "SENT", mid: "m_out_1" }),
    });
  });

  it("an earlier message's job steps aside for the latest one", async () => {
    await expect(processBotReplyJob(job({ triggerMid: "m_in_1" }))).resolves.toBe("superseded");
    expect(ai.generateJson).not.toHaveBeenCalled();
  });

  it("never replies twice to one message: an existing claim, or a lost race on it", async () => {
    s.claimed = { id: "out_0" };
    await expect(processBotReplyJob(job())).resolves.toBe("duplicate");
    expect(ai.generateJson).not.toHaveBeenCalled();

    s.claimed = null;
    db.facebookMessage.create.mockRejectedValueOnce(uniqueViolation());
    await expect(processBotReplyJob(job())).resolves.toBe("duplicate");
    expect(graph.sendMessage).not.toHaveBeenCalled();
  });

  it("stays silent with a person, with the bot off, or with the window closed", async () => {
    s.conversation.mode = "HUMAN";
    await expect(processBotReplyJob(job())).resolves.toBe("not_bot");
    s.conversation.mode = "BOT";
    s.settings = { ...s.settings, enabled: false };
    await expect(processBotReplyJob(job())).resolves.toBe("disabled");
    s.settings = { ...s.settings, enabled: true };
    s.page.botEnabled = false;
    await expect(processBotReplyJob(job())).resolves.toBe("disabled");
    s.page.botEnabled = true;
    s.conversation.lastInboundAt = new Date(NOW.getTime() - 24 * 3_600_000 + 4 * 60_000);
    await expect(processBotReplyJob(job())).resolves.toBe("window_closed");
    expect(ai.generateJson).not.toHaveBeenCalled();
    expect(graph.sendMessage).not.toHaveBeenCalled();
  });

  it("does not talk over a person who took the conversation while the model was thinking", async () => {
    s.fresh = { mode: "HUMAN", needsHuman: false, lastInboundAt: s.conversation.lastInboundAt };
    await expect(processBotReplyJob(job())).resolves.toBe("not_bot");
    expect(graph.sendMessage).not.toHaveBeenCalled();
    expect(db.facebookMessage.create).not.toHaveBeenCalled();
  });

  it("ignores a sticker or a like, without asking the model", async () => {
    s.pending = [inbound("m_in_2", { text: null, attachmentType: "sticker" })];
    await expect(processBotReplyJob(job())).resolves.toBe("sticker_only");
    expect(ai.generateJson).not.toHaveBeenCalled();
  });

  it("keeps the campaign's context for a conversation that started from a comment", async () => {
    s.conversation.sourceCampaignId = "camp_1";
    db.facebookCampaign.findFirst.mockResolvedValue({
      id: "camp_1",
      name: "Robe Kabyle",
      botContext: "Robe pour les fêtes",
      landingUrl: "https://shop.example/robe",
      addUtm: false,
    });
    await processBotReplyJob(job());
    expect(db.facebookCampaign.findFirst).toHaveBeenCalledWith({ where: { id: "camp_1", workspaceId: "ws_a" } });
    expect(ai.generateJson.mock.calls[0][0].systemInstruction).toContain("Robe pour les fêtes");
  });
});

describe("handing the conversation to a person", () => {
  function expectHandoff(category: string, reason: string) {
    expect(db.facebookConversation.updateMany).toHaveBeenCalledWith({
      where: { id: "conv_1", mode: "BOT" },
      data: expect.objectContaining({
        mode: "HUMAN",
        modeReason: "BOT_HANDOFF",
        needsHuman: true,
        handoffCategory: category,
        handoffReason: reason,
      }),
    });
    expect(db.facebookConversationEvent.create).toHaveBeenCalledWith({
      data: { workspaceId: "ws_a", conversationId: "conv_1", type: "HANDOFF", category, reason },
      select: { id: true },
    });
  }

  it("when the model asks for it: the category, the reason, and «نرجعولك» once", async () => {
    modelSays({ handoff: true, category: "WHOLESALE_ORDER", reason: "يحب 50 حبة", reply: "" });
    await expect(processBotReplyJob(job())).resolves.toBe("handed_off");
    expectHandoff("WHOLESALE_ORDER", "يحب 50 حبة");
    expect(db.facebookMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ author: "BOT", replyToMid: "m_in_2", text: "نرجعولك" }),
    });
    expect(graph.sendMessage).toHaveBeenCalledTimes(1);
    expect(graph.sendMessage.mock.calls[0][2]).toMatchObject({ text: "نرجعولك" });
  });

  it("when the guard stops an invented price: NOT_IN_KB, and the price never goes out", async () => {
    modelSays({ handoff: false, category: "NONE", reason: "", reply: "السعر 3900 DA" });
    await expect(processBotReplyJob(job())).resolves.toBe("handed_off");
    expectHandoff("NOT_IN_KB", GUARD_REASONS.number);
    expect(graph.sendMessage.mock.calls.map((call) => call[2].text)).toEqual(["نرجعولك"]);
  });

  it("when Gemini fails after its retry: OTHER", async () => {
    ai.generateJson.mockRejectedValue(new GeminiError("overloaded", "unavailable", 503));
    await expect(processBotReplyJob(job())).resolves.toBe("handed_off");
    expectHandoff("OTHER", SYSTEM_REASONS.aiUnavailable);
  });

  it("for an image or a video, without asking the model", async () => {
    s.pending = [inbound("m_in_2", { text: null, attachmentType: "image", attachmentUrl: "https://cdn/x.jpg" })];
    await expect(processBotReplyJob(job())).resolves.toBe("handed_off");
    expectHandoff("OTHER", SYSTEM_REASONS.attachment);
    expect(ai.generateJson).not.toHaveBeenCalled();
  });

  it("for a voice message that was not transcribed: AUDIO_FAILED", async () => {
    s.pending = [inbound("m_in_2", { text: null, attachmentType: "audio", transcriptStatus: "FAILED" })];
    await expect(processBotReplyJob(job())).resolves.toBe("handed_off");
    expectHandoff("AUDIO_FAILED", SYSTEM_REASONS.audio);
  });

  it("waits while a voice message is being transcribed, then answers it", async () => {
    s.pending = [inbound("m_in_2", { text: null, attachmentType: "audio", transcriptStatus: "PENDING" })];
    await expect(processBotReplyJob(job())).resolves.toBe("waiting_transcript");
    expect(queue.add).toHaveBeenCalledWith(
      "fb-bot-reply",
      { facebookPageId: "fp_1", conversationId: "conv_1", triggerMid: "m_in_2", waits: 1 },
      { jobId: `${botReplyJobId("conv_1", "m_in_2")}_w1`, delay: TRANSCRIPT_WAIT_MS }
    );
    expect(ai.generateJson).not.toHaveBeenCalled();
    expect(db.facebookConversationEvent.create).not.toHaveBeenCalled();
  });

  it("stops waiting after 3 minutes: the voice message then counts as not transcribed", async () => {
    s.pending = [inbound("m_in_2", { text: null, attachmentType: "audio", transcriptStatus: "PENDING" })];
    await expect(processBotReplyJob(job({ waits: MAX_TRANSCRIPT_WAITS }))).resolves.toBe("handed_off");
    expectHandoff("AUDIO_FAILED", SYSTEM_REASONS.audio);
    expect(queue.add).not.toHaveBeenCalledWith("fb-bot-reply", expect.anything(), expect.anything());
  });

  it("answers a transcribed voice message like a typed one", async () => {
    s.pending = [inbound("m_in_2", { text: null, attachmentType: "audio", transcript: "شحال الروبة", transcriptStatus: "DONE" })];
    s.history = [...s.pending];
    await expect(processBotReplyJob(job())).resolves.toBe("replied");
    expect(ai.generateJson.mock.calls[0][0].contents[0].parts[0].text).toContain(
      "Customer (voice message, transcribed): شحال الروبة"
    );
  });

  it(`after ${MAX_BOT_REPLIES_PER_HOUR} automatic replies in an hour`, async () => {
    s.botRepliesLastHour = MAX_BOT_REPLIES_PER_HOUR;
    await expect(processBotReplyJob(job())).resolves.toBe("handed_off");
    expectHandoff("OTHER", SYSTEM_REASONS.tooManyReplies);
  });

  it("not when a person took it first: no event, no message", async () => {
    modelSays({ handoff: true, category: "COMPLAINT", reason: "غاضب", reply: "" });
    db.facebookConversation.findUnique.mockImplementation(async (args: { include?: unknown }) =>
      args.include ? { ...s.conversation, page: s.page } : { workspaceId: "ws_a", mode: "HUMAN", needsHuman: false }
    );
    await expect(processBotReplyJob(job())).resolves.toBe("not_bot");
    expect(db.facebookConversationEvent.create).not.toHaveBeenCalled();
    expect(graph.sendMessage).not.toHaveBeenCalled();
  });
});

describe("when the send fails", () => {
  it("an unconfirmed send is kept UNCONFIRMED and never retried", async () => {
    graph.sendMessage.mockRejectedValue(new FacebookApiError("socket hang up", "ambiguous"));
    await expect(processBotReplyJob(job())).resolves.toBe("unconfirmed");
    expect(db.facebookMessage.updateMany).toHaveBeenCalledWith({
      where: { id: "out_1", sendStatus: "PENDING" },
      data: { sendStatus: "UNCONFIRMED", error: "socket hang up" },
    });
  });

  it("Facebook out of reach: the claim is freed and the job retried; on the last try, a person is called", async () => {
    graph.sendMessage.mockRejectedValue(new FacebookApiError("getaddrinfo ENOTFOUND", "unreachable"));
    await expect(processBotReplyJob(job({}, 0))).rejects.toMatchObject({ kind: "unreachable" });
    expect(db.facebookMessage.deleteMany).toHaveBeenCalledWith({ where: { id: "out_1", sendStatus: "PENDING" } });
    expect(db.facebookConversationEvent.create).not.toHaveBeenCalled();

    vi.clearAllMocks();
    db.facebookConversation.updateMany.mockResolvedValue({ count: 1 });
    db.facebookMessage.deleteMany.mockResolvedValue({ count: 1 });
    db.facebookConversationEvent.create.mockResolvedValue({ id: "evt_1" });
    await expect(processBotReplyJob(job({}, 2))).resolves.toBe("handed_off");
    expect(db.facebookConversationEvent.create.mock.calls[0][0].data).toMatchObject({
      category: "OTHER",
      reason: SYSTEM_REASONS.facebookUnreachable,
    });
    // Facebook cannot be reached: the handoff message is not tried.
    expect(graph.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("a dead token marks the Page and calls a person", async () => {
    graph.sendMessage.mockRejectedValue(new FacebookApiError("Session expired", "token_invalid", 190));
    await expect(processBotReplyJob(job())).resolves.toBe("failed");
    expect(db.facebookPage.update).toHaveBeenCalledWith({
      where: { id: "fp_1" },
      data: { status: "TOKEN_INVALID", lastError: "Session expired" },
    });
    expect(db.facebookConversationEvent.create.mock.calls[0][0].data).toMatchObject({ reason: SYSTEM_REASONS.tokenInvalid });
  });

  it("runs in the Facebook worker", async () => {
    s.conversation.mode = "HUMAN";
    await expect(dispatchFacebookJob(job() as never)).resolves.toBe("not_bot");
  });
});
