/**
 * The Telegram voice interview run for real: handling the bot's updates
 * (answers, voice notes, commands), starting and stopping it, its API, the
 * chats route, and the poller (lock, cursor, poison updates). Prisma,
 * Telegram, Gemini and the transcription are mocked.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  context: null as null | { userId: string; workspaceId: string; role: "OWNER" | "ADMIN" | "MEMBER" },
}));
const db = vi.hoisted(() => ({
  knowledgeInterview: { findFirst: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(), create: vi.fn(), count: vi.fn() },
  product: { findMany: vi.fn() },
  knowledgeSuggestion: { createMany: vi.fn(), count: vi.fn(), findMany: vi.fn() },
  telegramCursor: { upsert: vi.fn(), findUnique: vi.fn() },
  telegramChatSeen: { upsert: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
  alertRecipient: { findFirst: vi.fn(), findMany: vi.fn() },
  alertSettings: { findUnique: vi.fn() },
  $transaction: vi.fn(),
}));
const telegram = vi.hoisted(() => ({
  telegramSendMessage: vi.fn(),
  telegramGetUpdates: vi.fn(),
  telegramGetFile: vi.fn(),
  telegramDownloadFile: vi.fn(),
}));
const ai = vi.hoisted(() => ({ generateJson: vi.fn(), transcribeAudio: vi.fn() }));

vi.mock("@/lib/db/client", () => ({ prisma: db }));
vi.mock("@/lib/meta/oauth", () => ({ encryptToken: (value: string) => `enc(${value})`, decryptToken: (value: string) => value.slice(4, -1) }));
vi.mock("@/lib/alerts/telegram", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/alerts/telegram")>()),
  ...telegram,
}));
vi.mock("@/lib/ai/gemini", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/ai/gemini")>()),
  generateJson: ai.generateJson,
}));
vi.mock("@/lib/ai/transcribe", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/ai/transcribe")>()),
  transcribeAudio: ai.transcribeAudio,
}));
vi.mock("@/lib/workspace-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/workspace-access")>()),
  getCurrentWorkspaceContext: async () => state.context,
}));
vi.mock("@/lib/auth", () => ({ getCurrentUserId: async () => state.context?.userId ?? null }));

import { GeminiError } from "../../lib/ai/gemini";
import { TelegramError, type TelegramUpdate } from "../../lib/alerts/telegram";
import { TranscriptionError } from "../../lib/ai/transcribe";
import { INTERVIEW_QUESTIONS, interviewMessages } from "../../lib/knowledge/interview";
import {
  expireIdleInterviews,
  handleInterviewUpdate,
  startInterviewRun,
  stopInterviewRun,
} from "../../lib/knowledge/interview-run";
import { startTelegramPolling, telegramBotId, type PollerRedis } from "../../lib/knowledge/telegram-poller";
import { DELETE as stopRoute, GET as getRoute, POST as startRoute } from "../../app/api/knowledge/interview/route";
import { GET as findChats } from "../../app/api/alerts/telegram/chats/route";

const TOKEN = "123456789:AAH_valid-looking-token-0123456789abcdef";
const OTHER_TOKEN = "987654321:AAH_valid-looking-token-0123456789abcdef";
const CHAT = "555";
const PRODUCTS = [
  { id: "p1", name: "عسل السدر", strengths: [], comparisons: null, suitableFor: null, objections: [], description: null },
  { id: "p2", name: "Crème hydratante", strengths: [], comparisons: null, suitableFor: null, objections: [], description: null },
];
const messages = interviewMessages();

type Row = {
  id: string;
  workspaceId: string;
  chatId: string;
  status: string;
  productIds: string[];
  position: number;
  question: number;
  lastAskedAt: Date | null;
  startedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function interview(overrides: Partial<Row> = {}): Row {
  return {
    id: "iv_1",
    workspaceId: "ws_a",
    chatId: CHAT,
    status: "ACTIVE",
    productIds: ["p1", "p2"],
    position: 0,
    question: 0,
    lastAskedAt: new Date(),
    startedByUserId: "u",
    createdAt: new Date(Date.now() - 60 * 60 * 1000),
    updatedAt: new Date(Date.now() - 60 * 1000),
    ...overrides,
  };
}

function update(
  text: string | null,
  options: { updateId?: number; chatId?: string; date?: number; voice?: boolean } = {}
): TelegramUpdate {
  return {
    updateId: options.updateId ?? 10,
    chat: { id: options.chatId ?? CHAT, title: "Lina", type: "private", username: null },
    message: {
      messageId: 1,
      date: options.date ?? Math.floor(Date.now() / 1000),
      text,
      fromUsername: null,
      voice: options.voice ? { fileId: "f1", durationSeconds: 12, mimeType: "audio/ogg", fileSize: 40_000 } : null,
      audio: null,
    },
  };
}

/** What the bot sent, in order, as plain text. */
const sent = () =>
  telegram.telegramSendMessage.mock.calls.map(([, message]) =>
    String((message as { html: string }).html).replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
  );

/** The interview's last stored state. */
const stored = () => db.knowledgeInterview.updateMany.mock.calls.at(-1)?.[0]?.data;

function gemini(data: unknown) {
  ai.generateJson.mockResolvedValue({ data, result: { text: JSON.stringify(data), finishReason: "STOP", usage: null } });
}

function request(url: string, method = "GET", body?: unknown, origin = "http://localhost:3000") {
  return new NextRequest(url, {
    method,
    headers: { "Content-Type": "application/json", Origin: origin },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  state.context = { userId: "u", workspaceId: "ws_a", role: "ADMIN" };
  db.$transaction.mockImplementation(async (operations: unknown[]) => Promise.all(operations));
  db.alertSettings.findUnique.mockResolvedValue({ telegramBotToken: `enc(${TOKEN})`, telegramBotUsername: "lina_bot" });
  db.knowledgeInterview.findFirst.mockResolvedValue(interview());
  db.knowledgeInterview.findMany.mockResolvedValue([]);
  db.knowledgeInterview.updateMany.mockResolvedValue({ count: 1 });
  db.knowledgeInterview.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "iv_new", ...data }));
  db.knowledgeInterview.count.mockResolvedValue(1);
  db.product.findMany.mockResolvedValue(PRODUCTS);
  db.knowledgeSuggestion.createMany.mockImplementation(async ({ data }: { data: unknown[] }) => ({ count: data.length }));
  db.knowledgeSuggestion.count.mockResolvedValue(0);
  db.knowledgeSuggestion.findMany.mockResolvedValue([]);
  db.telegramCursor.upsert.mockResolvedValue({});
  db.telegramCursor.findUnique.mockResolvedValue(null);
  db.telegramChatSeen.upsert.mockResolvedValue({});
  db.telegramChatSeen.findMany.mockResolvedValue([]);
  db.telegramChatSeen.findUnique.mockResolvedValue(null);
  db.alertRecipient.findFirst.mockResolvedValue({ id: "rc_1" });
  db.alertRecipient.findMany.mockResolvedValue([]);
  telegram.telegramSendMessage.mockResolvedValue({ messageId: 1 });
  telegram.telegramGetFile.mockResolvedValue({ filePath: "voice/file_1.oga", fileSize: 40_000 });
  telegram.telegramDownloadFile.mockResolvedValue(Buffer.from("OggS-audio"));
  ai.transcribeAudio.mockResolvedValue({ transcript: "العسل طبيعي ومن الجبل", mimeType: "audio/ogg", converted: true });
  gemini({ items: ["عسل طبيعي", "من الجبل"] });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── Answers ────────────────────────────────────────────────────────────────

describe("handleInterviewUpdate: answers", () => {
  it("turns a typed answer into PENDING suggestions, moves on with the cursor, and asks the next question", async () => {
    const result = await handleInterviewUpdate("ws_a", TOKEN, update("العسل طبيعي ومن الجبل"), {
      cursor: { botId: "123456789", offset: BigInt(11) },
    });
    expect(result).toEqual({ outcome: "answered", committed: true });

    const [{ data }] = db.knowledgeSuggestion.createMany.mock.calls[0];
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({
      workspaceId: "ws_a",
      source: "INTERVIEW",
      target: "product.strengths",
      productId: "p1",
      payload: { items: ["عسل طبيعي", "من الجبل"] },
      evidence: "العسل طبيعي ومن الجبل",
      sourceRef: "iv_1",
    });
    expect(data[0].dedupeKey).toMatch(/^[a-f0-9]{40}$/);

    // State and offset in one transaction.
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(stored()).toMatchObject({ status: "ACTIVE", position: 0, question: 1 });
    expect(db.telegramCursor.upsert).toHaveBeenCalledWith({
      where: { workspaceId: "ws_a" },
      create: { workspaceId: "ws_a", botId: "123456789", offset: BigInt(11) },
      update: { botId: "123456789", offset: BigInt(11) },
    });
    expect(sent()).toEqual([messages.heard, INTERVIEW_QUESTIONS[1].ask("عسل السدر")]);
  });

  it("gives the same dedupe keys when the same update is handled again", async () => {
    await handleInterviewUpdate("ws_a", TOKEN, update("العسل طبيعي ومن الجبل", { updateId: 42 }));
    await handleInterviewUpdate("ws_a", TOKEN, update("العسل طبيعي ومن الجبل", { updateId: 42 }));
    await handleInterviewUpdate("ws_a", TOKEN, update("العسل طبيعي ومن الجبل", { updateId: 43 }));
    const keys = db.knowledgeSuggestion.createMany.mock.calls.map(([{ data }]) => data[0].dedupeKey);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("files customers' usual questions under the product's questions and worries", async () => {
    db.knowledgeInterview.findFirst.mockResolvedValue(interview({ question: 2 }));
    expect(INTERVIEW_QUESTIONS[2].target).toBe("faq");
    gemini({ pairs: [{ question: "واش هو طبيعي؟", answer: "ايه طبيعي" }, { question: "منين جاي؟", answer: "من الجبل" }] });
    await handleInterviewUpdate("ws_a", TOKEN, update("يسقسيو واش هو طبيعي، نقولهم ايه طبيعي. ومنين جاي، من الجبل"));
    const [{ data }] = db.knowledgeSuggestion.createMany.mock.calls[0];
    expect(data.map((row: { target: string; productId: string }) => [row.target, row.productId])).toEqual([
      ["product.objections", "p1"],
      ["product.objections", "p1"],
    ]);
    expect(data[0].payload).toEqual({ question: "واش هو طبيعي؟", answer: "ايه طبيعي" });
  });

  it("transcribes a voice note and keeps the transcript as the evidence", async () => {
    await handleInterviewUpdate("ws_a", TOKEN, update(null, { voice: true }));
    expect(telegram.telegramGetFile).toHaveBeenCalledWith(TOKEN, "f1");
    expect(telegram.telegramDownloadFile).toHaveBeenCalledWith(TOKEN, "voice/file_1.oga", {
      maxBytes: expect.any(Number),
    });
    expect(telegram.telegramDownloadFile.mock.calls[0][2].maxBytes).toBeLessThanOrEqual(20 * 1024 * 1024);
    expect(ai.transcribeAudio).toHaveBeenCalledWith(expect.any(Buffer), "audio/ogg");
    expect(db.knowledgeSuggestion.createMany.mock.calls[0][0].data[0].evidence).toBe("العسل طبيعي ومن الجبل");
    expect(stored()).toMatchObject({ question: 1 });
  });

  it("asks for a shorter voice note when the file is too big, and stays on the question", async () => {
    const big = update(null, { voice: true });
    big.message!.voice!.fileSize = 25 * 1024 * 1024;
    const result = await handleInterviewUpdate("ws_a", TOKEN, big);
    expect(result).toEqual({ outcome: "voice_failed", committed: false });
    expect(telegram.telegramGetFile).not.toHaveBeenCalled();
    expect(db.knowledgeInterview.updateMany).not.toHaveBeenCalled();
    expect(sent()[0]).toMatch(/طويل/);
  });

  it("says so when the voice cannot be heard, without moving on", async () => {
    ai.transcribeAudio.mockRejectedValue(new TranscriptionError("Gemini heard no speech", "empty"));
    const result = await handleInterviewUpdate("ws_a", TOKEN, update(null, { voice: true }));
    expect(result.outcome).toBe("voice_failed");
    expect(db.knowledgeSuggestion.createMany).not.toHaveBeenCalled();
    expect(db.knowledgeInterview.updateMany).not.toHaveBeenCalled();
  });

  it("throws a passing Telegram or Gemini failure so the poller tries again, until the last attempt", async () => {
    telegram.telegramGetFile.mockRejectedValue(new TelegramError("Telegram getFile did not answer in time", "unavailable"));
    await expect(handleInterviewUpdate("ws_a", TOKEN, update(null, { voice: true }))).rejects.toBeInstanceOf(TelegramError);

    ai.generateJson.mockRejectedValue(new GeminiError("overloaded", "unavailable", 503));
    await expect(handleInterviewUpdate("ws_a", TOKEN, update("جواب"))).rejects.toBeInstanceOf(GeminiError);
    const last = await handleInterviewUpdate("ws_a", TOKEN, update("جواب"), { lastAttempt: true });
    expect(last).toEqual({ outcome: "failed", committed: false });
    expect(sent().at(-1)).toMatch(/عاود ابعثو/);
    expect(db.knowledgeInterview.updateMany).not.toHaveBeenCalled();
  });

  it("moves on with a word to the owner when the answer gives nothing for the card", async () => {
    gemini({ items: [] });
    await handleInterviewUpdate("ws_a", TOKEN, update("ما نعرفش"));
    expect(db.knowledgeSuggestion.createMany).not.toHaveBeenCalled();
    expect(stored()).toMatchObject({ question: 1 });
    expect(sent()[0]).toMatch(/ما لقيتش/);
  });

  it("goes to the next product after its last question, with the product's place", async () => {
    db.knowledgeInterview.findFirst.mockResolvedValue(interview({ question: INTERVIEW_QUESTIONS.length - 1 }));
    gemini({ text: "يصلح للصغار والكبار" });
    await handleInterviewUpdate("ws_a", TOKEN, update("يصلح للصغار والكبار"));
    expect(stored()).toMatchObject({ position: 1, question: 0 });
    expect(sent().at(-1)).toBe(`المنتوج 2 من 2\n${INTERVIEW_QUESTIONS[0].ask("Crème hydratante")}`);
  });

  it("finishes with the thank-you after the last answer", async () => {
    db.knowledgeInterview.findFirst.mockResolvedValue(interview({ position: 1, question: INTERVIEW_QUESTIONS.length - 1 }));
    gemini({ text: "يصلح للوجه" });
    const result = await handleInterviewUpdate("ws_a", TOKEN, update("يصلح للوجه"));
    expect(result.outcome).toBe("done");
    expect(stored()).toMatchObject({ status: "DONE" });
    expect(sent().at(-1)).toBe(messages.done);
    expect(messages.done).toMatch(/للمراجعة/);
  });

  it("skips products deleted meanwhile", async () => {
    db.product.findMany.mockResolvedValue([PRODUCTS[1]]);
    await handleInterviewUpdate("ws_a", TOKEN, update("كريمة خفيفة"));
    expect(ai.generateJson.mock.calls[0][0].contents[0].parts[0].text).toContain("Crème hydratante");
    expect(db.knowledgeSuggestion.createMany.mock.calls[0][0].data[0].productId).toBe("p2");
    expect(stored()).toMatchObject({ position: 1, question: 1 });
  });
});

// ─── Commands and filters ───────────────────────────────────────────────────

describe("handleInterviewUpdate: commands and filters", () => {
  it("ignores other chats, messages from before the interview, and messages without text or voice", async () => {
    expect((await handleInterviewUpdate("ws_a", TOKEN, update("hello", { chatId: "999" }))).outcome).toBe("ignored");
    const old = Math.floor((Date.now() - 3 * 60 * 60 * 1000) / 1000);
    expect((await handleInterviewUpdate("ws_a", TOKEN, update("hello", { date: old }))).outcome).toBe("ignored");
    expect((await handleInterviewUpdate("ws_a", TOKEN, update(null))).outcome).toBe("ignored");
    expect(telegram.telegramSendMessage).not.toHaveBeenCalled();
    expect(db.knowledgeInterview.updateMany).not.toHaveBeenCalled();
  });

  it("skips a question with /skip or its Darija word, and a product with /next", async () => {
    await handleInterviewUpdate("ws_a", TOKEN, update("/skip"));
    expect(stored()).toMatchObject({ position: 0, question: 1 });
    await handleInterviewUpdate("ws_a", TOKEN, update("فوت"));
    expect(stored()).toMatchObject({ position: 0, question: 1 });
    await handleInterviewUpdate("ws_a", TOKEN, update("/next@lina_bot"));
    expect(stored()).toMatchObject({ position: 1, question: 0 });
    expect(ai.generateJson).not.toHaveBeenCalled();
  });

  it("stops with /stop and says how to go on", async () => {
    const result = await handleInterviewUpdate("ws_a", TOKEN, update("baraka"));
    expect(result.outcome).toBe("stopped");
    expect(stored()).toMatchObject({ status: "STOPPED" });
    expect(sent()).toEqual([messages.stopped]);
  });

  it("tells the progress with /status and asks the question again", async () => {
    db.knowledgeInterview.findFirst.mockResolvedValue(interview({ position: 1, question: 2 }));
    await handleInterviewUpdate("ws_a", TOKEN, update("/status"));
    expect(sent()).toEqual([messages.status(1, 2), INTERVIEW_QUESTIONS[2].ask("Crème hydratante")]);
    expect(stored()).toMatchObject({ status: "ACTIVE", position: 1, question: 2 });
  });

  it("resumes a stopped interview with /interview where it stopped, over the same products", async () => {
    db.knowledgeInterview.findFirst.mockResolvedValue(interview({ status: "STOPPED", position: 1, question: 3 }));
    const result = await handleInterviewUpdate("ws_a", TOKEN, update("/interview"));
    expect(result.outcome).toBe("resumed");
    expect(stored()).toMatchObject({ status: "ACTIVE", position: 1, question: 3 });
    expect(db.product.findMany.mock.calls[0][0].where.id).toEqual({ in: ["p1", "p2"] });
    expect(sent().at(-1)).toBe(INTERVIEW_QUESTIONS[3].ask("Crème hydratante"));
  });

  it("has nothing to resume when the interview is done or stopped long ago, and ignores other messages then", async () => {
    db.knowledgeInterview.findFirst.mockResolvedValue(interview({ status: "DONE" }));
    expect((await handleInterviewUpdate("ws_a", TOKEN, update("/interview"))).outcome).toBe("nothing_to_resume");
    expect(sent()[0]).toMatch(/قاعدة المعرفة/);
    db.knowledgeInterview.findFirst.mockResolvedValue(
      interview({ status: "STOPPED", updatedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000), createdAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000) })
    );
    expect((await handleInterviewUpdate("ws_a", TOKEN, update("ebda"))).outcome).toBe("nothing_to_resume");
    expect((await handleInterviewUpdate("ws_a", TOKEN, update("an answer"))).outcome).toBe("ignored");
    expect(db.knowledgeInterview.updateMany).not.toHaveBeenCalled();
  });
});

// ─── Start, stop, expiry ────────────────────────────────────────────────────

describe("startInterviewRun / stopInterviewRun / expireIdleInterviews", () => {
  it("refuses a chat that is neither a recipient nor seen, and a brand without a bot", async () => {
    db.alertRecipient.findFirst.mockResolvedValue(null);
    expect(await startInterviewRun({ workspaceId: "ws_a", chatId: "777" })).toMatchObject({ ok: false, error: "unknown_chat" });
    db.telegramChatSeen.findUnique.mockResolvedValue({ chatId: "777" });
    expect(await startInterviewRun({ workspaceId: "ws_a", chatId: "777" })).toMatchObject({ ok: true });
    db.alertSettings.findUnique.mockResolvedValue(null);
    expect(await startInterviewRun({ workspaceId: "ws_a", chatId: "777" })).toMatchObject({ ok: false, error: "no_bot" });
  });

  it("defaults to the ACTIVE products with the least information first, stops the old one, and asks right away", async () => {
    db.product.findMany.mockResolvedValue([
      { id: "full", name: "Full", strengths: ["a"], comparisons: "x", suitableFor: "y", objections: [{ question: "q", answer: "a" }], description: "d" },
      { id: "empty", name: "Empty", strengths: [], comparisons: null, suitableFor: null, objections: [], description: null },
      { id: "half", name: "Half", strengths: ["a"], comparisons: null, suitableFor: "y", objections: [], description: null },
    ]);
    const result = await startInterviewRun({ workspaceId: "ws_a", chatId: CHAT, userId: "u" });
    expect(result).toEqual({ ok: true, interviewId: "iv_new", asked: true });
    expect(db.product.findMany.mock.calls[0][0].where).toEqual({ workspaceId: "ws_a", status: "ACTIVE" });
    expect(db.knowledgeInterview.updateMany).toHaveBeenCalledWith({
      where: { workspaceId: "ws_a", status: "ACTIVE" },
      data: { status: "STOPPED" },
    });
    expect(db.knowledgeInterview.create.mock.calls[0][0].data).toMatchObject({
      workspaceId: "ws_a",
      chatId: CHAT,
      status: "ACTIVE",
      productIds: ["empty", "half", "full"],
      startedByUserId: "u",
    });
    expect(sent()).toEqual([messages.intro(3), `المنتوج 1 من 3\n${INTERVIEW_QUESTIONS[0].ask("Empty")}`]);
  });

  it("keeps the chosen products of the brand only, in the chosen order", async () => {
    db.product.findMany.mockResolvedValue([PRODUCTS[0], PRODUCTS[1]]);
    await startInterviewRun({ workspaceId: "ws_a", chatId: CHAT, productIds: ["p2", "other_brand", "p1", "p2"] });
    expect(db.product.findMany.mock.calls[0][0].where).toMatchObject({ workspaceId: "ws_a", status: { not: "ARCHIVED" } });
    expect(db.knowledgeInterview.create.mock.calls[0][0].data.productIds).toEqual(["p2", "p1"]);
    db.product.findMany.mockResolvedValue([]);
    expect(await startInterviewRun({ workspaceId: "ws_a", chatId: CHAT, productIds: ["x"] })).toMatchObject({ error: "no_products" });
  });

  it("changes nothing when Telegram refuses the chat", async () => {
    telegram.telegramSendMessage.mockRejectedValue(new TelegramError("chat not found", "chat_not_found", 400));
    expect(await startInterviewRun({ workspaceId: "ws_a", chatId: CHAT })).toMatchObject({
      ok: false,
      error: "telegram",
      kind: "chat_not_found",
    });
    expect(db.knowledgeInterview.updateMany).not.toHaveBeenCalled();
    expect(db.knowledgeInterview.create).not.toHaveBeenCalled();
  });

  it("stops the running interview and tells the chat", async () => {
    expect(await stopInterviewRun("ws_a")).toBe(true);
    expect(db.knowledgeInterview.updateMany).toHaveBeenCalledWith({ where: { workspaceId: "ws_a", status: "ACTIVE" }, data: { status: "STOPPED" } });
    expect(sent()).toEqual([messages.stopped]);
    db.knowledgeInterview.updateMany.mockResolvedValue({ count: 0 });
    db.knowledgeInterview.findFirst.mockResolvedValue(null);
    expect(await stopInterviewRun("ws_a")).toBe(false);
  });

  it("stops interviews nobody answered for 7 days", async () => {
    db.knowledgeInterview.findMany.mockResolvedValue([{ id: "iv_old", workspaceId: "ws_a", chatId: CHAT }]);
    const now = new Date("2026-11-25T12:00:00Z");
    expect(await expireIdleInterviews(now)).toBe(1);
    const cutoff = new Date("2026-11-18T12:00:00Z");
    expect(db.knowledgeInterview.findMany.mock.calls[0][0].where).toEqual({
      status: "ACTIVE",
      OR: [{ lastAskedAt: { lt: cutoff } }, { lastAskedAt: null, createdAt: { lt: cutoff } }],
    });
    expect(db.knowledgeInterview.updateMany).toHaveBeenCalledWith({ where: { id: "iv_old", status: "ACTIVE" }, data: { status: "STOPPED" } });
    expect(sent()[0]).toMatch(/سمانة/);
  });
});

// ─── API ────────────────────────────────────────────────────────────────────

describe("/api/knowledge/interview", () => {
  const URL = "http://localhost:3000/api/knowledge/interview";

  it("is for admins only", async () => {
    state.context = { userId: "u", workspaceId: "ws_a", role: "MEMBER" };
    expect((await getRoute(request(URL))).status).toBe(403);
    expect((await startRoute(request(URL, "POST", { chatId: CHAT }))).status).toBe(403);
    expect((await stopRoute(request(URL, "DELETE"))).status).toBe(403);
    state.context = { userId: "u", workspaceId: "ws_a", role: "ADMIN" };
    expect((await startRoute(request(URL, "POST", { chatId: CHAT }, "https://evil.example")))).toHaveProperty("status", 403);
  });

  it("shows the latest interview with its progress, chat label and pending suggestions", async () => {
    db.knowledgeInterview.findFirst.mockResolvedValue(interview({ position: 1, question: 2 }));
    db.alertRecipient.findMany.mockResolvedValue([{ label: "Lina (owner)", telegramChatId: CHAT }]);
    db.telegramChatSeen.findMany.mockResolvedValue([{ chatId: "-100", title: "Equipe", type: "group", lastSeenAt: new Date() }]);
    db.knowledgeSuggestion.count.mockResolvedValue(3);
    db.knowledgeSuggestion.findMany.mockResolvedValue([
      { id: "s1", target: "product.strengths", productId: "p1", payload: { items: ["a"] }, createdAt: new Date() },
    ]);
    const body = await (await getRoute(request(URL))).json();
    expect(body.data.bot).toEqual({ username: "lina_bot" });
    expect(body.data.chats).toEqual([
      { id: CHAT, label: "Lina (owner)", source: "recipient" },
      { id: "-100", label: "Equipe", source: "seen" },
    ]);
    expect(body.data.interview).toMatchObject({
      status: "ACTIVE",
      chatLabel: "Lina (owner)",
      total: 2,
      position: 1,
      question: 2,
      current: { productId: "p2", productName: "Crème hydratante", target: INTERVIEW_QUESTIONS[2].target },
      pending: 3,
    });
    expect(body.data.interview.suggestions[0]).toMatchObject({ id: "s1", productName: "عسل السدر" });
    expect(db.knowledgeSuggestion.count.mock.calls[0][0].where).toEqual({
      workspaceId: "ws_a",
      source: "INTERVIEW",
      sourceRef: "iv_1",
      status: "PENDING",
    });
  });

  it("starts with a valid chat ID, and maps failures to codes", async () => {
    expect((await startRoute(request(URL, "POST", { chatId: "not a chat" }))).status).toBe(400);
    expect((await startRoute(request(URL, "POST", { chatId: CHAT, productIds: Array(51).fill("p") }))).status).toBe(400);

    const created = await startRoute(request(URL, "POST", { chatId: CHAT, productIds: ["p1"] }));
    expect(created.status).toBe(201);
    expect((await created.json()).data.asked).toBe(true);
    expect(db.knowledgeInterview.create.mock.calls[0][0].data).toMatchObject({ productIds: ["p1"], startedByUserId: "u" });

    telegram.telegramSendMessage.mockRejectedValue(new TelegramError("Forbidden", "forbidden", 403));
    const refused = await startRoute(request(URL, "POST", { chatId: CHAT }));
    expect(refused.status).toBe(502);
    expect((await refused.json()).code).toBe("forbidden");

    db.alertRecipient.findFirst.mockResolvedValue(null);
    const unknown = await startRoute(request(URL, "POST", { chatId: "777" }));
    expect((await unknown.json()).code).toBe("unknown_chat");
  });

  it("stops", async () => {
    const body = await (await stopRoute(request(URL, "DELETE"))).json();
    expect(body.data).toEqual({ stopped: true });
  });
});

// ─── Chats route ────────────────────────────────────────────────────────────

describe("/api/alerts/telegram/chats with the chats seen", () => {
  const URL = "http://localhost:3000/api/alerts/telegram/chats";
  const seenRow = { chatId: "-100", title: "Equipe", type: "group", lastSeenAt: new Date() };

  it("merges the live chats with the ones the worker saw, and records the live ones", async () => {
    telegram.telegramGetUpdates.mockResolvedValue([
      { updateId: 1, chat: { id: CHAT, title: "Lina", type: "private", username: "lina" }, message: null },
    ]);
    db.telegramChatSeen.findMany.mockResolvedValue([{ ...seenRow, chatId: CHAT, title: "Lina" }, seenRow]);
    const body = await (await findChats(request(URL))).json();
    expect(body.data.chats).toEqual([
      { id: CHAT, title: "Lina", type: "private", username: "lina" },
      { id: "-100", title: "Equipe", type: "group", username: null },
    ]);
    expect(db.telegramChatSeen.upsert.mock.calls[0][0]).toMatchObject({
      where: { workspaceId_chatId: { workspaceId: "ws_a", chatId: CHAT } },
      create: { workspaceId: "ws_a", chatId: CHAT, title: "Lina", type: "private" },
    });
  });

  it("uses the chats seen alone while our worker reads the bot, and keeps the webhook error", async () => {
    db.telegramChatSeen.findMany.mockResolvedValue([seenRow]);
    telegram.telegramGetUpdates.mockRejectedValue(
      new TelegramError("Telegram getUpdates failed (409): Conflict: terminated by other getUpdates request", "bad_request", 409)
    );
    const busy = await (await findChats(request(URL))).json();
    expect(busy).toEqual({ success: true, data: { chats: [{ id: "-100", title: "Equipe", type: "group", username: null }] } });

    telegram.telegramGetUpdates.mockRejectedValue(
      new TelegramError("Telegram getUpdates failed (409): Conflict: can't use getUpdates method while webhook is active", "bad_request", 409)
    );
    const hooked = await findChats(request(URL));
    expect(hooked.status).toBe(502);
    expect((await hooked.json()).code).toBe("webhook_active");
  });
});

// ─── Poller ─────────────────────────────────────────────────────────────────

function fakeRedis(): PollerRedis & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async set(key, value) {
      if (store.has(key)) return null;
      store.set(key, value);
      return "OK";
    },
    async get(key) {
      return store.get(key) ?? null;
    },
    async incr(key) {
      const next = Number(store.get(key) ?? 0) + 1;
      store.set(key, String(next));
      return next;
    },
    async expire() {
      return 1;
    },
    async del(key) {
      return store.delete(key) ? 1 : 0;
    },
    async eval(script, _keys, key, owner) {
      if (store.get(String(key)) !== owner) return 0;
      if (script.includes("del")) store.delete(String(key));
      return 1;
    },
  };
}

/** One store per poller: the lock taken is the lock renewed. */
const lockStore = () => {
  const redis = fakeRedis();
  return () => redis;
};

const quiet = () => new Promise<never[]>((resolve) => setTimeout(() => resolve([]), 2));

describe("startTelegramPolling", () => {
  beforeEach(() => {
    // pollableWorkspaces asks with distinct; expireIdleInterviews without.
    db.knowledgeInterview.findMany.mockImplementation(async (args: { distinct?: unknown }) =>
      args.distinct ? [{ workspaceId: "ws_a" }] : []
    );
  });

  const base = { enabled: true, scanIntervalMs: 2, pollTimeoutSeconds: 0, backoffMs: () => 1 };

  it("handles the updates in order, records the chats, and moves the offset past each", async () => {
    const redis = fakeRedis();
    const getUpdates = vi.fn().mockResolvedValueOnce([update("b", { updateId: 8 }), update("a", { updateId: 7 })]).mockImplementation(quiet);
    const handle = vi.fn(async () => ({ outcome: "answered" as const, committed: false }));
    const poller = startTelegramPolling({ ...base, redis: () => redis, getUpdates, handle });
    await vi.waitFor(() => expect(getUpdates.mock.calls.length).toBeGreaterThanOrEqual(2));
    await poller.stop();

    expect(handle.mock.calls.map((call) => (call as unknown[])[2] as TelegramUpdate).map((u) => u.updateId)).toEqual([7, 8]);
    expect((handle.mock.calls[0] as unknown[])[3]).toEqual({ cursor: { botId: "123456789", offset: BigInt(8) }, lastAttempt: false });
    expect(db.telegramCursor.upsert.mock.calls.map(([args]) => args.update.offset)).toEqual([BigInt(8), BigInt(9)]);
    expect(getUpdates.mock.calls[0][1]).toMatchObject({ offset: undefined, timeoutSeconds: 0, allowedUpdates: ["message", "channel_post", "my_chat_member"] });
    expect(getUpdates.mock.calls[1][1].offset).toBe(9);
    expect(db.telegramChatSeen.upsert).toHaveBeenCalled();
    // The lock is released on stop.
    expect(redis.store.has("fb:telegram:poll:123456789")).toBe(false);
  });

  it("starts from the stored offset of the same bot, and from scratch for another bot", async () => {
    db.telegramCursor.findUnique.mockResolvedValue({ workspaceId: "ws_a", botId: "123456789", offset: BigInt(500) });
    const getUpdates = vi.fn().mockImplementation(quiet);
    let poller = startTelegramPolling({ ...base, redis: lockStore(), getUpdates, handle: vi.fn() });
    await vi.waitFor(() => expect(getUpdates).toHaveBeenCalled());
    await poller.stop();
    expect(getUpdates.mock.calls[0][1].offset).toBe(500);

    getUpdates.mockClear();
    db.alertSettings.findUnique.mockResolvedValue({ telegramBotToken: `enc(${OTHER_TOKEN})`, telegramBotUsername: "x" });
    poller = startTelegramPolling({ ...base, redis: lockStore(), getUpdates, handle: vi.fn() });
    await vi.waitFor(() => expect(getUpdates).toHaveBeenCalled());
    await poller.stop();
    expect(getUpdates.mock.calls[0][1].offset).toBeUndefined();
    expect(telegramBotId(OTHER_TOKEN)).toBe("987654321");
  });

  it("leaves a bot another worker holds the lock on", async () => {
    const redis = fakeRedis();
    redis.store.set("fb:telegram:poll:123456789", "someone-else");
    const getUpdates = vi.fn().mockImplementation(quiet);
    const poller = startTelegramPolling({ ...base, redis: () => redis, getUpdates, handle: vi.fn() });
    await vi.waitFor(() => expect(db.knowledgeInterview.findMany.mock.calls.length).toBeGreaterThanOrEqual(4));
    await poller.stop();
    expect(getUpdates).not.toHaveBeenCalled();
    expect(redis.store.get("fb:telegram:poll:123456789")).toBe("someone-else");
  });

  it("retries a failing update, then skips it after a few tries without blocking the next one", async () => {
    const redis = fakeRedis();
    const poison = update("x", { updateId: 20 });
    const next = update("y", { updateId: 21 });
    const getUpdates = vi.fn().mockImplementation(async (_token: string, query: { offset?: number }) =>
      (query.offset ?? 0) <= 20 ? [poison, next] : quiet()
    );
    const handle = vi.fn(async (_ws: string, _token: string, item: TelegramUpdate) => {
      if (item.updateId === 20) throw new Error("boom");
      return { outcome: "answered" as const, committed: true };
    });
    const poller = startTelegramPolling({ ...base, redis: () => redis, getUpdates, handle });
    await vi.waitFor(() => expect(handle.mock.calls.some((call) => (call as unknown[])[2] === next)).toBe(true));
    await poller.stop();

    const tries = handle.mock.calls.filter((call) => (call as unknown[])[2] === poison);
    expect(tries).toHaveLength(3);
    expect((tries[2] as unknown[])[3]).toMatchObject({ lastAttempt: true });
    // Skipped: the offset moved past it by the poller itself; the next one committed its own.
    expect(db.telegramCursor.upsert.mock.calls.map(([args]) => args.update.offset)).toEqual([BigInt(21)]);
    expect(redis.store.has("fb:telegram:fail:123456789:20")).toBe(false);
  });

  it("pauses a bot whose webhook is at another service", async () => {
    const getUpdates = vi
      .fn()
      .mockRejectedValue(new TelegramError("Conflict: can't use getUpdates method while webhook is active", "bad_request", 409));
    const poller = startTelegramPolling({ ...base, redis: lockStore(), getUpdates, handle: vi.fn() });
    await vi.waitFor(() => expect(db.knowledgeInterview.findMany.mock.calls.length).toBeGreaterThanOrEqual(6));
    await poller.stop();
    expect(getUpdates).toHaveBeenCalledTimes(1);
  });

  it("does nothing when TELEGRAM_POLLING is off, and stops when the interview is over", async () => {
    vi.stubEnv("TELEGRAM_POLLING", "false");
    const getUpdates = vi.fn().mockImplementation(quiet);
    await startTelegramPolling({ getUpdates }).stop();
    expect(db.knowledgeInterview.findMany).not.toHaveBeenCalled();

    db.knowledgeInterview.count.mockResolvedValue(0);
    const poller = startTelegramPolling({ ...base, redis: lockStore(), getUpdates, handle: vi.fn() });
    await vi.waitFor(() => expect(db.knowledgeInterview.count.mock.calls.length).toBeGreaterThanOrEqual(2));
    await poller.stop();
    expect(getUpdates).not.toHaveBeenCalled();
  });
});
