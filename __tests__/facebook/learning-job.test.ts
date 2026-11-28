/**
 * The learning loop's job, its two hooks and the inbox button's route.
 * Prisma, the queue, Gemini and Meta are mocked; nothing touches a network.
 */
import { NextRequest } from "next/server";
import type { Job } from "bullmq";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  context: null as null | { userId: string; workspaceId: string; role: "OWNER" | "ADMIN" | "MEMBER" },
}));
const db = vi.hoisted(() => ({
  facebookMessage: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  facebookConversation: {
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  facebookConversationEvent: { findFirst: vi.fn(), create: vi.fn() },
  facebookPage: { findUnique: vi.fn() },
  product: { findMany: vi.fn() },
  knowledgeEntry: { findFirst: vi.fn(), count: vi.fn(), create: vi.fn() },
  $transaction: vi.fn(),
}));
const queue = vi.hoisted(() => ({ add: vi.fn() }));
const model = vi.hoisted(() => ({ suggestFromReply: vi.fn() }));
const store = vi.hoisted(() => ({ saveSuggestions: vi.fn() }));
const graph = vi.hoisted(() => ({ sendMessage: vi.fn(), getMessengerProfileName: vi.fn() }));

vi.mock("@/lib/db/client", () => ({ prisma: db }));
vi.mock("@/lib/workspace-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/workspace-access")>()),
  getCurrentWorkspaceContext: async () => state.context,
}));
vi.mock("@/lib/facebook/queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/facebook/queue")>()),
  getFacebookQueue: () => queue,
}));
vi.mock("@/lib/knowledge/learning", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/knowledge/learning")>()),
  suggestFromReply: model.suggestFromReply,
}));
vi.mock("@/lib/knowledge/suggestions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/knowledge/suggestions")>()),
  saveSuggestions: store.saveSuggestions,
}));
vi.mock("@/lib/facebook/graph", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/facebook/graph")>()),
  ...graph,
}));
vi.mock("@/lib/facebook/pages", () => ({ pageToken: () => "PAGE_TOKEN" }));
vi.mock("@/lib/auth", () => ({ getCurrentUserId: async () => state.context?.userId ?? null }));

import { POST as fromReplyRoute } from "../../app/api/knowledge/from-reply/route";
import { sendHumanReply } from "../../lib/facebook/human-reply";
import { processMessageJob } from "../../lib/facebook/messages";
import { learnJobId, KB_LEARN_JOB, type FacebookMessageJob, type KnowledgeLearnJob } from "../../lib/facebook/queue";
import { processLearnJob, queueHandoffLearning } from "../../lib/knowledge/jobs/learn";
import { suggestionDedupeKey } from "../../lib/knowledge/suggestions";

const NOW = new Date("2026-11-25T12:00:00Z");
const REPLY = "La livraison à Oran coûte 600 DA et arrive en 2 jours, paiement à la livraison.";

const learnJob = (messageId = "msg_reply") => ({ data: { messageId } }) as unknown as Job<KnowledgeLearnJob>;

function replyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg_reply",
    workspaceId: "ws_a",
    conversationId: "conv_1",
    direction: "OUTBOUND",
    author: "HUMAN",
    text: REPLY,
    sendStatus: "SENT",
    sentAt: new Date("2026-11-25T11:30:00Z"),
    ...overrides,
  };
}

function good(overrides: Record<string, unknown> = {}) {
  return {
    target: "delivery",
    productId: null,
    payload: { text: "Livraison à Oran: 600 DA, 2 jours." },
    reason: "A general delivery rule.",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("GOOGLE_API_KEY", "test-key");
  vi.stubEnv("FACEBOOK_APP_ID", "1517776481860111");
  state.context = { userId: "u_admin", workspaceId: "ws_a", role: "ADMIN" };
  db.$transaction.mockImplementation(async (fn: (tx: typeof db) => unknown) => fn(db));
  db.facebookMessage.findUnique.mockResolvedValue(replyRow());
  db.facebookMessage.findFirst.mockResolvedValue(null);
  db.facebookMessage.findMany.mockResolvedValue([
    // Newest first, as the job asks for them.
    { text: "bch7al?", transcript: null },
    { text: null, transcript: "wesh livraison l wahran kayen?" },
  ]);
  db.facebookConversation.findFirst.mockResolvedValue({
    id: "conv_1",
    handoffCategory: "NOT_IN_KB",
    handoffAt: new Date("2026-11-25T11:00:00Z"),
    focusProductIds: ["p1"],
  });
  db.facebookConversationEvent.findFirst.mockResolvedValue({
    type: "HANDOFF",
    category: "NOT_IN_KB",
    createdAt: new Date("2026-11-25T11:00:00Z"),
  });
  db.product.findMany.mockResolvedValue([{ id: "p1", name: "Sérum visage", code: "SER-1" }]);
  model.suggestFromReply.mockResolvedValue(good());
  store.saveSuggestions.mockResolvedValue(1);
  queue.add.mockResolvedValue({});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("processLearnJob", () => {
  it("suggests the person's answer to a handoff, with the conversation as its source", async () => {
    await expect(processLearnJob(learnJob())).resolves.toBe("suggested delivery");

    // The customer's words since the handoff, oldest first, and the focus products by name.
    expect(model.suggestFromReply).toHaveBeenCalledWith({
      customerMessages: ["wesh livraison l wahran kayen?", "bch7al?"],
      humanReply: REPLY,
      category: "NOT_IN_KB",
      products: [{ id: "p1", name: "Sérum visage", code: "SER-1" }],
    });
    expect(db.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: "ws_a", id: { in: ["p1"] } } })
    );
    expect(store.saveSuggestions).toHaveBeenCalledWith("ws_a", "HANDOFF_REPLY", [
      {
        target: "delivery",
        productId: null,
        payload: { text: "Livraison à Oran: 600 DA, 2 jours." },
        evidence: `wesh livraison l wahran kayen? / bch7al?\n→ ${REPLY}`,
        sourceRef: "conv_1",
        dedupeKey: suggestionDedupeKey("msg_reply", "delivery", "Livraison à Oran: 600 DA, 2 jours."),
      },
    ]);
  });

  it("is idempotent: a second run offers the same dedupe key, which the store skips", async () => {
    await processLearnJob(learnJob());
    store.saveSuggestions.mockResolvedValue(0);
    await expect(processLearnJob(learnJob())).resolves.toBe("already suggested");
    const keys = store.saveSuggestions.mock.calls.map(([, , items]) => items[0].dedupeKey);
    expect(keys[0]).toBe(keys[1]);
  });

  it("reads a reply typed in Meta Business Suite the same way", async () => {
    db.facebookMessage.findUnique.mockResolvedValue(replyRow({ origin: "EXTERNAL" }));
    await expect(processLearnJob(learnJob())).resolves.toBe("suggested delivery");
  });

  it("looks at the customer's messages only since the person's earlier reply", async () => {
    db.facebookMessage.findFirst.mockResolvedValue({ sentAt: new Date("2026-11-25T11:20:00Z") });
    await processLearnJob(learnJob());
    expect(db.facebookMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          direction: "INBOUND",
          sentAt: { lt: new Date("2026-11-25T11:30:00Z"), gt: new Date("2026-11-25T11:20:00Z") },
        }),
        take: 6,
      })
    );
  });

  it("does nothing when the message was deleted meanwhile", async () => {
    db.facebookMessage.findUnique.mockResolvedValue(null);
    await expect(processLearnJob(learnJob())).resolves.toBe("skipped: message gone");
    expect(model.suggestFromReply).not.toHaveBeenCalled();
  });

  it("does nothing when the conversation was deleted meanwhile", async () => {
    db.facebookConversation.findFirst.mockResolvedValue(null);
    await expect(processLearnJob(learnJob())).resolves.toBe("skipped: conversation gone");
  });

  it.each([
    ["the bot's message", { author: "BOT" }],
    ["a customer's message", { direction: "INBOUND", author: "CUSTOMER" }],
    ["a campaign's private reply", { author: "CAMPAIGN" }],
    ["a failed send", { sendStatus: "FAILED" }],
  ])("ignores %s", async (_label, overrides) => {
    db.facebookMessage.findUnique.mockResolvedValue(replyRow(overrides));
    await expect(processLearnJob(learnJob())).resolves.toMatch(/^skipped/);
    expect(model.suggestFromReply).not.toHaveBeenCalled();
  });

  it("skips a reply that cannot be knowledge before any model call", async () => {
    db.facebookMessage.findUnique.mockResolvedValue(replyRow({ text: "On vous appelle demain" }));
    await expect(processLearnJob(learnJob())).resolves.toBe("skipped: nothing reusable");
    expect(model.suggestFromReply).not.toHaveBeenCalled();
  });

  it("is skipped without GOOGLE_API_KEY", async () => {
    vi.stubEnv("GOOGLE_API_KEY", "");
    await expect(processLearnJob(learnJob())).resolves.toBe("skipped: no AI key");
    expect(model.suggestFromReply).not.toHaveBeenCalled();
  });

  it("ignores a reply in a conversation the bot never handed off", async () => {
    db.facebookConversationEvent.findFirst.mockResolvedValue(null);
    db.facebookConversation.findFirst.mockResolvedValue({ id: "conv_1", handoffCategory: null, handoffAt: null, focusProductIds: [] });
    await expect(processLearnJob(learnJob())).resolves.toBe("skipped: not a handoff reply");
  });

  it("ignores a reply after the conversation went back to the bot", async () => {
    db.facebookConversationEvent.findFirst.mockResolvedValue({ type: "RETURNED_TO_BOT", category: null, createdAt: NOW });
    await expect(processLearnJob(learnJob())).resolves.toBe("skipped: not a handoff reply");
  });

  it("accepts a handoff stored before events existed", async () => {
    db.facebookConversationEvent.findFirst.mockResolvedValue(null);
    await expect(processLearnJob(learnJob())).resolves.toBe("suggested delivery");
    expect(model.suggestFromReply).toHaveBeenCalledWith(expect.objectContaining({ category: "NOT_IN_KB" }));
  });

  it("needs a customer question to learn from", async () => {
    db.facebookMessage.findMany.mockResolvedValue([{ text: null, transcript: null }]);
    await expect(processLearnJob(learnJob())).resolves.toBe("skipped: no customer question");
  });

  it("saves nothing when the model finds nothing reusable", async () => {
    model.suggestFromReply.mockResolvedValue(null);
    await expect(processLearnJob(learnJob())).resolves.toBe("nothing to suggest");
    expect(store.saveSuggestions).not.toHaveBeenCalled();
  });

  it("lets a model outage fail the job, so it is retried", async () => {
    model.suggestFromReply.mockRejectedValue(new Error("503"));
    await expect(processLearnJob(learnJob())).rejects.toThrow("503");
  });
});

describe("queueHandoffLearning", () => {
  it("queues one job per message when the conversation was handed off", async () => {
    await queueHandoffLearning({ id: "msg_reply", text: REPLY }, { handoffCategory: "NOT_IN_KB" });
    expect(queue.add).toHaveBeenCalledWith(KB_LEARN_JOB, { messageId: "msg_reply" }, { jobId: learnJobId("msg_reply") });
  });

  it.each([
    ["no handoff", REPLY, null],
    ["a reply that cannot be knowledge", "ok merci", "NOT_IN_KB"],
    ["no text", null, "NOT_IN_KB"],
  ])("queues nothing for %s", async (_label, text, handoffCategory) => {
    await queueHandoffLearning({ id: "msg_reply", text }, { handoffCategory });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("never throws when the queue is down", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    queue.add.mockRejectedValue(new Error("redis down"));
    await expect(queueHandoffLearning({ id: "msg_reply", text: REPLY }, { handoffCategory: "NOT_IN_KB" })).resolves.toBeUndefined();
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});

describe("the reply from the inbox", () => {
  const PAGE = { id: "fp_1", pageId: "1001", status: "ACTIVE", accessToken: "enc" };
  const conversation = (handoffCategory: string | null) => ({
    id: "conv_1",
    workspaceId: "ws_a",
    psid: "psid_1",
    lastInboundAt: new Date("2026-11-25T11:00:00Z"),
    handoffCategory,
    page: PAGE,
  });

  beforeEach(() => {
    db.facebookMessage.create.mockResolvedValue({ id: "msg_new" });
    db.facebookMessage.update.mockResolvedValue({
      id: "msg_new",
      direction: "OUTBOUND",
      author: "HUMAN",
      origin: "OPENREPLY",
      text: REPLY,
      sentAt: NOW,
    });
    db.facebookConversation.update.mockResolvedValue({});
    db.facebookConversation.updateMany.mockResolvedValue({ count: 1 });
    db.facebookConversation.findUnique.mockResolvedValue({ workspaceId: "ws_a", mode: "HUMAN", needsHuman: true });
    db.facebookConversationEvent.create.mockResolvedValue({});
    graph.sendMessage.mockResolvedValue({ recipient_id: "psid_1", message_id: "m_sent" });
  });

  const send = () => sendHumanReply({ workspaceId: "ws_a", userId: "u_admin", conversationId: "conv_1", text: REPLY });

  it("queues the learning job after answering a handoff", async () => {
    db.facebookConversation.findFirst.mockResolvedValue(conversation("NOT_IN_KB"));
    await expect(send()).resolves.toMatchObject({ ok: true });
    expect(queue.add).toHaveBeenCalledWith(KB_LEARN_JOB, { messageId: "msg_new" }, { jobId: learnJobId("msg_new") });
  });

  it("queues nothing when the bot had not handed the conversation over", async () => {
    db.facebookConversation.findFirst.mockResolvedValue(conversation(null));
    await expect(send()).resolves.toMatchObject({ ok: true });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("is still sent when the queue is down", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    db.facebookConversation.findFirst.mockResolvedValue(conversation("NOT_IN_KB"));
    queue.add.mockRejectedValue(new Error("redis down"));
    await expect(send()).resolves.toMatchObject({ ok: true });
    log.mockRestore();
  });
});

describe("the reply typed in Meta Business Suite", () => {
  const echo = (text: string | null = REPLY) =>
    ({
      id: "fbm_1",
      name: "fb-message",
      data: {
        facebookPageId: "fp_1",
        pageId: "1001",
        kind: "echo",
        psid: "psid_1",
        mid: "m_out_1",
        text,
        attachments: [],
        appId: "263902037430900",
        sentAt: "2026-11-25T11:59:00.000Z",
      },
    }) as unknown as Job<FacebookMessageJob>;
  const conversation = (handoffCategory: string | null) => ({
    id: "conv_1",
    workspaceId: "ws_a",
    facebookPageId: "fp_1",
    psid: "psid_1",
    mode: "HUMAN",
    needsHuman: true,
    handoffCategory,
  });

  beforeEach(() => {
    db.facebookMessage.findUnique.mockResolvedValue(null);
    db.facebookMessage.create.mockResolvedValue({ id: "msg_ext" });
    db.facebookConversation.update.mockResolvedValue({});
    db.facebookConversation.updateMany.mockResolvedValue({ count: 1 });
    db.facebookConversationEvent.create.mockResolvedValue({});
  });

  function conversationIs(handoffCategory: string | null) {
    db.facebookConversation.findUnique
      .mockResolvedValueOnce(conversation(handoffCategory))
      .mockResolvedValueOnce({ workspaceId: "ws_a", mode: "HUMAN", needsHuman: true });
  }

  // The worker looks the Page up first.
  beforeEach(() => {
    db.facebookPage.findUnique.mockResolvedValue({
      id: "fp_1",
      pageId: "1001",
      workspaceId: "ws_a",
      status: "ACTIVE",
      accessToken: "enc",
    });
  });

  it("queues the learning job after a reply to a handed-off conversation", async () => {
    conversationIs("NOT_IN_KB");
    await expect(processMessageJob(echo())).resolves.toBe("human_reply");
    expect(queue.add).toHaveBeenCalledWith(KB_LEARN_JOB, { messageId: "msg_ext" }, { jobId: learnJobId("msg_ext") });
  });

  it("queues nothing without a handoff", async () => {
    conversationIs(null);
    await expect(processMessageJob(echo())).resolves.toBe("human_reply");
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("still stores the reply when the queue is down", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    conversationIs("NOT_IN_KB");
    queue.add.mockRejectedValue(new Error("redis down"));
    await expect(processMessageJob(echo())).resolves.toBe("human_reply");
    log.mockRestore();
  });
});

describe("POST /api/knowledge/from-reply", () => {
  const post = (body: unknown, origin = "http://localhost:3000") =>
    fromReplyRoute(
      new NextRequest("http://localhost:3000/api/knowledge/from-reply", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify(body),
      })
    );
  const body = { messageId: "msg_reply", question: "Livraison à Oran ?", answer: REPLY };

  beforeEach(() => {
    db.facebookMessage.findFirst.mockResolvedValue({
      id: "msg_reply",
      conversationId: "conv_1",
      direction: "OUTBOUND",
      author: "HUMAN",
    });
    db.knowledgeEntry.findFirst.mockResolvedValue(null);
    db.knowledgeEntry.count.mockResolvedValue(3);
    db.knowledgeEntry.create.mockResolvedValue({ id: "kb_1" });
  });

  it("lets an admin create a FAQ entry directly", async () => {
    const response = await post(body);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ success: true, data: { mode: "entry", created: true } });
    expect(db.facebookMessage.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "msg_reply", workspaceId: "ws_a" } }));
    expect(db.knowledgeEntry.create).toHaveBeenCalledWith({
      data: { workspaceId: "ws_a", kind: "FAQ", title: "Livraison à Oran ?", content: REPLY, price: null, isActive: true },
    });
    expect(store.saveSuggestions).not.toHaveBeenCalled();
  });

  it("does not add the same entry twice", async () => {
    db.knowledgeEntry.findFirst.mockResolvedValue({ id: "kb_1" });
    const response = await post(body);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { mode: "entry", created: false } });
    expect(db.knowledgeEntry.create).not.toHaveBeenCalled();
  });

  it("respects the knowledge base size limit", async () => {
    db.knowledgeEntry.count.mockResolvedValue(500);
    const response = await post(body);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ success: false, code: "full" });
  });

  it("makes a member's text a pending suggestion for an admin", async () => {
    state.context = { userId: "u_member", workspaceId: "ws_a", role: "MEMBER" };
    const response = await post(body);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ success: true, data: { mode: "suggestion", created: true } });
    expect(db.knowledgeEntry.create).not.toHaveBeenCalled();
    expect(store.saveSuggestions).toHaveBeenCalledWith("ws_a", "HANDOFF_REPLY", [
      {
        target: "faq",
        payload: { question: "Livraison à Oran ?", answer: REPLY },
        evidence: `Livraison à Oran ?\n→ ${REPLY}`,
        sourceRef: "conv_1",
        dedupeKey: suggestionDedupeKey("msg_reply", "faq", REPLY),
      },
    ]);
  });

  it("says so when the suggestion was already waiting", async () => {
    state.context = { userId: "u_member", workspaceId: "ws_a", role: "MEMBER" };
    store.saveSuggestions.mockResolvedValue(0);
    const response = await post(body);
    expect(await response.json()).toMatchObject({ data: { mode: "suggestion", created: false } });
  });

  it("finds a message of another brand as not found", async () => {
    db.facebookMessage.findFirst.mockResolvedValue(null);
    const response = await post(body);
    expect(response.status).toBe(404);
    expect(db.knowledgeEntry.create).not.toHaveBeenCalled();
  });

  it("only takes a reply written by a person", async () => {
    db.facebookMessage.findFirst.mockResolvedValue({ id: "msg_reply", conversationId: "conv_1", direction: "OUTBOUND", author: "BOT" });
    const response = await post(body);
    expect(response.status).toBe(400);
  });

  it.each([
    ["no question", { ...body, question: "  " }],
    ["a question over 200 characters", { ...body, question: "q".repeat(201) }],
    ["no answer", { ...body, answer: "" }],
    ["an answer over 1000 characters", { ...body, answer: "a".repeat(1001) }],
    ["no message", { question: "q", answer: "a" }],
  ])("refuses %s", async (_label, invalid) => {
    const response = await post(invalid);
    expect(response.status).toBe(400);
    expect(db.facebookMessage.findFirst).not.toHaveBeenCalled();
  });

  it("refuses a signed-out request and a cross-site one", async () => {
    state.context = null;
    expect((await post(body)).status).toBe(401);
    state.context = { userId: "u_admin", workspaceId: "ws_a", role: "ADMIN" };
    expect((await post(body, "https://evil.example")).status).toBe(403);
  });
});
