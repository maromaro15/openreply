/**
 * The Telegram voice interview, run for real (PLAN.md 6.15): starting and
 * stopping it, handling each update the poller reads from the brand's bot,
 * asking the questions, and turning each answer into PENDING suggestions.
 *
 * The pure logic (state machine, commands, extraction) is lib/knowledge/interview.ts.
 * Here is the storage and the Telegram side. What the owner says is
 * untrusted: it only ever becomes suggestions a person reviews.
 *
 * Crash safety: an update's effect on the interview (the next question) and
 * the poller's offset past that update are written in one transaction, and
 * messages go out only after it. A replayed update finds its suggestions
 * already stored (same dedupeKey) and the state not yet moved, so it moves
 * the state once.
 */
import { z } from "zod";
import type { KnowledgeInterview, Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { getTelegramBot, telegramBotToken } from "@/lib/alerts/settings";
import {
  escapeTelegramHtml,
  telegramDownloadFile,
  telegramGetFile,
  telegramSendMessage,
  TelegramError,
  type TelegramAudioFile,
  type TelegramChat,
  type TelegramErrorKind,
  type TelegramUpdate,
} from "@/lib/alerts/telegram";
import { GeminiError } from "@/lib/ai/gemini";
import { transcribeAudio, TranscriptionError } from "@/lib/ai/transcribe";
import { getFacebookAudioMaxBytes } from "@/lib/facebook/env";
import {
  advance,
  currentQuestion,
  extractAnswer,
  INTERVIEW_QUESTIONS,
  interviewMessages,
  MAX_INTERVIEW_PRODUCTS,
  parseCommand,
  skipProduct,
  startInterview,
  stopInterview,
  syncInterview,
  type InterviewState,
  type InterviewTarget,
} from "./interview";
import { saveSuggestions, suggestionDedupeKey, type NewSuggestion, type SuggestionTarget } from "./suggestions";

/** An interview nobody answered for this long stops itself. */
export const INTERVIEW_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
/** A stopped interview can be resumed from Telegram (/interview) for this long; the bot is read meanwhile. */
export const INTERVIEW_RESUME_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Telegram serves bots files up to 20 MB. */
const TELEGRAM_FILE_LIMIT = 20 * 1024 * 1024;
/** The worker's clock and Telegram's can differ a little. */
const CLOCK_SLACK_MS = 60_000;
const MAX_CANDIDATES = 200;
const MAX_CHAT_OPTIONS = 50;
const MAX_LABEL_LENGTH = 80;

/**
 * The card field each question fills. Customers' usual questions go to the
 * product's own list of questions and worries (objections), which the bot
 * reads with the product: a general FAQ entry would lose the product.
 */
const TARGETS: Record<InterviewTarget, SuggestionTarget> = {
  strengths: "product.strengths",
  comparisons: "product.comparisons",
  objections: "product.objections",
  faq: "product.objections",
  suitableFor: "product.suitableFor",
};

/** The bot's own lines beyond interviewMessages(), in the same Darija. */
const LINES = {
  unusable: "ما لقيتش في جوابك حاجة نزيدها للبطاقة. نفوتو للسؤال الجاي.",
  voiceFailed: "ما قدرتش نسمع الفويس مليح. عاودو ولا اكتبلي الجواب.",
  voiceTooLong: "الفويس طويل بزاف. ابعثلي فويس أقصر ولا اكتب الجواب.",
  retry: "صرا مشكل وأنا نقرا في جوابك. عاود ابعثو من فضلك.",
  nothingToResume: "ما كاين حتى مقابلة نكمّلوها. ابدا وحدة جديدة من «قاعدة المعرفة» في لوحة التحكم.",
  resumed: "نكمّلو من وين حبسنا.",
  expired: "حبست المقابلة خاطر ما جاوبتنيش من سمانة. تقدر تكمّلها بـ /interview اليوم، ولا تبدا وحدة جديدة من «قاعدة المعرفة».",
  product: (index: number, total: number) => `المنتوج ${index} من ${total}`,
};

// ─── Small helpers ──────────────────────────────────────────────────────────

type KnownProduct = { id: string; name: string };

/** One line, bounded: chat titles and labels come from Telegram users. */
function oneLine(value: string | null | undefined, max: number): string {
  const text = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩﻿]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function stateOf(row: Pick<KnowledgeInterview, "status" | "productIds" | "position" | "question">): InterviewState {
  return {
    status: row.status === "DONE" || row.status === "STOPPED" ? row.status : "ACTIVE",
    productIds: row.productIds,
    position: row.position,
    question: row.question,
  };
}

/** The interview's products still in the catalogue (deleted or archived ones are skipped). */
async function loadProducts(workspaceId: string, ids: string[]): Promise<KnownProduct[]> {
  if (ids.length === 0) return [];
  return prisma.product.findMany({
    where: { workspaceId, id: { in: ids }, status: { not: "ARCHIVED" } },
    select: { id: true, name: true },
  });
}

/** Never throws: a message that could not go out must not undo what was stored. */
async function sendSafe(token: string, chatId: string, text: string): Promise<boolean> {
  try {
    await telegramSendMessage(token, { chatId, html: escapeTelegramHtml(text) });
    return true;
  } catch (error) {
    console.error("[Interview] Telegram message failed:", error instanceof Error ? error.message : error);
    return false;
  }
}

/** The current question, with the product's place in the interview when it is the product's first. */
async function askQuestion(token: string, chatId: string, state: InterviewState, products: KnownProduct[]): Promise<boolean> {
  const synced = syncInterview(state, products);
  const asked = currentQuestion(synced, products);
  if (!asked) return false;
  const heading = synced.question === 0 ? `${LINES.product(synced.position + 1, synced.productIds.length)}\n` : "";
  return sendSafe(token, chatId, `${heading}${asked.text}`);
}

/** The offset past an update, as the poller stores it. */
export function telegramCursorWrite(workspaceId: string, botId: string, offset: bigint) {
  return prisma.telegramCursor.upsert({
    where: { workspaceId },
    create: { workspaceId, botId, offset },
    update: { botId, offset },
  });
}

// ─── Chats seen by the bot ──────────────────────────────────────────────────

/** Best effort: the chat list is a convenience, never a reason for a read to fail. */
export async function recordSeenChats(workspaceId: string, chats: TelegramChat[], now = new Date()): Promise<void> {
  for (const chat of chats.slice(0, MAX_CHAT_OPTIONS)) {
    const chatId = oneLine(chat.id, 40);
    if (!chatId) continue;
    const data = { title: oneLine(chat.title, 200) || null, type: oneLine(chat.type, 30) || "unknown", lastSeenAt: now };
    try {
      await prisma.telegramChatSeen.upsert({
        where: { workspaceId_chatId: { workspaceId, chatId } },
        create: { workspaceId, chatId, ...data },
        update: data,
      });
    } catch (error) {
      console.error("[Interview] Could not record a Telegram chat:", error instanceof Error ? error.message : error);
    }
  }
}

/** The chats the worker saw, most recent first, in the shape of the live ones. */
export async function listSeenChats(workspaceId: string): Promise<TelegramChat[]> {
  try {
    const rows = await prisma.telegramChatSeen.findMany({
      where: { workspaceId },
      orderBy: { lastSeenAt: "desc" },
      take: MAX_CHAT_OPTIONS,
    });
    return rows.map((row) => ({ id: row.chatId, title: row.title, type: row.type, username: null }));
  } catch (error) {
    console.error("[Interview] Could not read the Telegram chats:", error instanceof Error ? error.message : error);
    return [];
  }
}

/** The chats an interview may go to: the brand's Telegram alert recipients first, then the chats seen. */
export async function interviewChatOptions(
  workspaceId: string
): Promise<{ id: string; label: string; source: "recipient" | "seen" }[]> {
  const [recipients, seen] = await Promise.all([
    prisma.alertRecipient.findMany({
      where: { workspaceId, channel: "TELEGRAM", telegramChatId: { not: null } },
      select: { label: true, telegramChatId: true },
      orderBy: { createdAt: "asc" },
    }),
    listSeenChats(workspaceId),
  ]);
  const options = new Map<string, { id: string; label: string; source: "recipient" | "seen" }>();
  for (const recipient of recipients) {
    const id = recipient.telegramChatId as string;
    if (!options.has(id)) options.set(id, { id, label: oneLine(recipient.label, MAX_LABEL_LENGTH) || id, source: "recipient" });
  }
  for (const chat of seen) {
    if (!options.has(chat.id)) {
      options.set(chat.id, { id: chat.id, label: oneLine(chat.title, MAX_LABEL_LENGTH) || chat.id, source: "seen" });
    }
  }
  return [...options.values()].slice(0, MAX_CHAT_OPTIONS * 2);
}

// ─── Starting and stopping ──────────────────────────────────────────────────

const TELEGRAM_CHAT_ID = /^(-?\d{1,20}|@[A-Za-z0-9_]{5,32})$/;

export const interviewStartSchema = z.object({
  chatId: z.string().trim().regex(TELEGRAM_CHAT_ID, "Pick a Telegram chat."),
  productIds: z.array(z.string().trim().min(1).max(100)).max(MAX_INTERVIEW_PRODUCTS).nullish(),
});

/** How much of what the interview asks is already on the card: 0 to 4. */
function filledFields(product: { strengths: string[]; comparisons: string | null; suitableFor: string | null; objections: unknown }) {
  return (
    (product.strengths.length > 0 ? 1 : 0) +
    (product.comparisons?.trim() ? 1 : 0) +
    (product.suitableFor?.trim() ? 1 : 0) +
    (Array.isArray(product.objections) && product.objections.length > 0 ? 1 : 0)
  );
}

/** The brand's ACTIVE products, the ones with the least information first. */
export async function interviewCandidates(
  workspaceId: string,
  take = MAX_CANDIDATES
): Promise<{ id: string; name: string; filled: number }[]> {
  const rows = await prisma.product.findMany({
    where: { workspaceId, status: "ACTIVE" },
    select: { id: true, name: true, strengths: true, comparisons: true, suitableFor: true, objections: true, description: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 1000,
  });
  return rows
    .map((row, index) => ({ row, index, filled: filledFields(row), described: row.description?.trim() ? 1 : 0 }))
    .sort((a, b) => a.filled - b.filled || a.described - b.described || a.index - b.index)
    .slice(0, take)
    .map(({ row, filled }) => ({ id: row.id, name: oneLine(row.name, 120), filled }));
}

/** The chat is one the brand chose for alerts, or one that wrote to its bot. */
async function isKnownChat(workspaceId: string, chatId: string): Promise<boolean> {
  const recipient = await prisma.alertRecipient.findFirst({
    where: { workspaceId, channel: "TELEGRAM", telegramChatId: chatId },
    select: { id: true },
  });
  if (recipient) return true;
  const seen = await prisma.telegramChatSeen.findUnique({
    where: { workspaceId_chatId: { workspaceId, chatId } },
    select: { chatId: true },
  });
  return seen !== null;
}

export type StartFailure = "no_bot" | "unknown_chat" | "no_products" | "telegram";

export type StartResult =
  | { ok: true; interviewId: string; asked: boolean }
  | { ok: false; error: StartFailure; kind?: TelegramErrorKind; message: string };

/**
 * A new interview in this chat, over these products (the brand's, in this
 * order) or by default its ACTIVE products with the least information first.
 * The brand's ACTIVE interview, if any, stops. The introduction goes out
 * before anything is stored, so a chat Telegram refuses changes nothing.
 */
export async function startInterviewRun(input: {
  workspaceId: string;
  chatId: string;
  productIds?: string[] | null;
  userId?: string | null;
}): Promise<StartResult> {
  const { workspaceId } = input;
  const chatId = input.chatId.trim();
  const token = await telegramBotToken(workspaceId);
  if (!token) return { ok: false, error: "no_bot", message: "Save the Telegram bot first." };
  if (!(await isKnownChat(workspaceId, chatId))) {
    return { ok: false, error: "unknown_chat", message: "Pick a chat that wrote to the bot, or an alert recipient." };
  }

  let products: KnownProduct[];
  if (input.productIds && input.productIds.length > 0) {
    const wanted = startInterview(input.productIds).productIds;
    const found = new Map((await loadProducts(workspaceId, wanted)).map((product) => [product.id, product]));
    products = wanted.map((id) => found.get(id)).filter((product): product is KnownProduct => product !== undefined);
  } else {
    products = await interviewCandidates(workspaceId, MAX_INTERVIEW_PRODUCTS);
  }
  const state = startInterview(products.map((product) => product.id));
  if (state.status !== "ACTIVE") {
    return { ok: false, error: "no_products", message: "There is no product to ask about." };
  }

  try {
    await telegramSendMessage(token, {
      chatId,
      html: escapeTelegramHtml(interviewMessages().intro(state.productIds.length)),
    });
  } catch (error) {
    if (!(error instanceof TelegramError)) throw error;
    return { ok: false, error: "telegram", kind: error.kind, message: error.message };
  }

  const [, created] = await prisma.$transaction([
    prisma.knowledgeInterview.updateMany({ where: { workspaceId, status: "ACTIVE" }, data: { status: "STOPPED" } }),
    prisma.knowledgeInterview.create({
      data: {
        workspaceId,
        chatId,
        status: "ACTIVE",
        productIds: state.productIds,
        position: 0,
        question: 0,
        lastAskedAt: new Date(),
        startedByUserId: input.userId ?? null,
      },
    }),
  ]);
  const asked = await askQuestion(token, chatId, state, products);
  return { ok: true, interviewId: created.id, asked };
}

/** Stops the brand's ACTIVE interview, and tells the chat. False when none was running. */
export async function stopInterviewRun(workspaceId: string): Promise<boolean> {
  const running = await prisma.knowledgeInterview.findFirst({
    where: { workspaceId, status: "ACTIVE" },
    orderBy: { createdAt: "desc" },
    select: { chatId: true },
  });
  const { count } = await prisma.knowledgeInterview.updateMany({
    where: { workspaceId, status: "ACTIVE" },
    data: { status: "STOPPED" },
  });
  if (count === 0 || !running) return false;
  const token = await telegramBotToken(workspaceId);
  if (token) await sendSafe(token, running.chatId, interviewMessages().stopped);
  return true;
}

/** ACTIVE interviews nobody answered for INTERVIEW_IDLE_MS stop, and say so. Returns how many. */
export async function expireIdleInterviews(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - INTERVIEW_IDLE_MS);
  const idle = await prisma.knowledgeInterview.findMany({
    where: {
      status: "ACTIVE",
      OR: [{ lastAskedAt: { lt: cutoff } }, { lastAskedAt: null, createdAt: { lt: cutoff } }],
    },
    select: { id: true, workspaceId: true, chatId: true },
    take: 50,
  });
  let stopped = 0;
  for (const interview of idle) {
    const { count } = await prisma.knowledgeInterview.updateMany({
      where: { id: interview.id, status: "ACTIVE" },
      data: { status: "STOPPED" },
    });
    if (count === 0) continue;
    stopped += 1;
    const token = await telegramBotToken(interview.workspaceId);
    if (token) await sendSafe(token, interview.chatId, LINES.expired);
  }
  return stopped;
}

function pollableWhere(now: Date): Prisma.KnowledgeInterviewWhereInput {
  return {
    OR: [
      { status: "ACTIVE" },
      // Stopped a moment ago: the owner may send /interview to resume it.
      { status: "STOPPED", updatedAt: { gte: new Date(now.getTime() - INTERVIEW_RESUME_WINDOW_MS) } },
    ],
  };
}

/** The brands whose bot the worker reads: an interview running, or stopped within the resume window. */
export async function pollableWorkspaces(now = new Date()): Promise<string[]> {
  const rows = await prisma.knowledgeInterview.findMany({
    where: pollableWhere(now),
    select: { workspaceId: true },
    distinct: ["workspaceId"],
    take: 500,
  });
  return rows.map((row) => row.workspaceId);
}

export async function isPollable(workspaceId: string, now = new Date()): Promise<boolean> {
  return (await prisma.knowledgeInterview.count({ where: { workspaceId, ...pollableWhere(now) } })) > 0;
}

// ─── Handling an update ─────────────────────────────────────────────────────

export type HandleOutcome =
  | "ignored"
  | "answered"
  | "skipped"
  | "next_product"
  | "stopped"
  | "status"
  | "resumed"
  | "nothing_to_resume"
  | "done"
  | "voice_failed"
  | "failed";

export interface HandleOptions {
  /** The poller's offset past this update: written with the interview's new state, in one transaction. */
  cursor?: { botId: string; offset: bigint };
  /** The poller gives up on this update after this try: say so to the owner instead of throwing. */
  lastAttempt?: boolean;
}

export interface HandleResult {
  outcome: HandleOutcome;
  /** True when the cursor was written here; otherwise the poller writes it. */
  committed: boolean;
}

/** The interview's new state, and the cursor with it. */
async function commit(
  interview: KnowledgeInterview,
  state: InterviewState,
  options: HandleOptions
): Promise<boolean> {
  const write = prisma.knowledgeInterview.updateMany({
    where: { id: interview.id, workspaceId: interview.workspaceId },
    data: {
      status: state.status,
      position: state.position,
      question: state.question,
      // Asked again now: the idle clock starts over.
      ...(state.status === "ACTIVE" ? { lastAskedAt: new Date() } : {}),
    },
  });
  if (options.cursor) {
    await prisma.$transaction([
      write,
      telegramCursorWrite(interview.workspaceId, options.cursor.botId, options.cursor.offset),
    ]);
    return true;
  }
  await write;
  return false;
}

type Heard = { transcript: string } | { reply: string };

/** The voice note as text. Retryable failures throw (the poller tries again) until the last attempt. */
async function transcribeVoice(token: string, audio: TelegramAudioFile, lastAttempt: boolean): Promise<Heard> {
  const limit = Math.min(getFacebookAudioMaxBytes(), TELEGRAM_FILE_LIMIT);
  if (audio.fileSize !== null && audio.fileSize > limit) return { reply: LINES.voiceTooLong };
  try {
    const file = await telegramGetFile(token, audio.fileId);
    if (file.fileSize !== null && file.fileSize > limit) return { reply: LINES.voiceTooLong };
    const bytes = await telegramDownloadFile(token, file.filePath, { maxBytes: limit });
    // Telegram voice notes are OGG/Opus; transcribeAudio re-encodes them for Gemini.
    const { transcript } = await transcribeAudio(bytes, audio.mimeType ?? "audio/ogg");
    return { transcript };
  } catch (error) {
    if (error instanceof TelegramError) {
      if (error.retryable && !lastAttempt) throw error;
      return { reply: /too big|larger than/i.test(error.message) ? LINES.voiceTooLong : LINES.voiceFailed };
    }
    if (error instanceof TranscriptionError) {
      const cause = error.cause;
      if (error.kind === "ai_failed" && cause instanceof GeminiError && cause.retryable && !lastAttempt) throw error;
      return { reply: error.kind === "too_large" ? LINES.voiceTooLong : LINES.voiceFailed };
    }
    throw error;
  }
}

/**
 * One update from the brand's bot. Only the chat of the brand's latest
 * interview counts, and only messages written after it began. Commands
 * (/skip /next /stop /status /interview, and their Darija words) steer it;
 * any other text, or a voice note, answers the current question.
 */
export async function handleInterviewUpdate(
  workspaceId: string,
  token: string,
  update: TelegramUpdate,
  options: HandleOptions = {}
): Promise<HandleResult> {
  const ignored: HandleResult = { outcome: "ignored", committed: false };
  const chatId = update.chat?.id;
  const message = update.message;
  if (!chatId || !message) return ignored;

  const interview = await prisma.knowledgeInterview.findFirst({
    where: { workspaceId },
    orderBy: { createdAt: "desc" },
  });
  if (!interview || interview.chatId !== chatId) return ignored;
  // Written before this interview began (a new bot's backlog, an old chat): it answers nothing here.
  if (message.date > 0 && message.date * 1000 < interview.createdAt.getTime() - CLOCK_SLACK_MS) return ignored;

  const messages = interviewMessages();
  const text = (message.text ?? "").trim();
  const command = text ? parseCommand(text) : null;
  const say = (line: string) => sendSafe(token, chatId, line);

  if (interview.status !== "ACTIVE") {
    if (command !== "start") return ignored;
    const resumable =
      interview.status === "STOPPED" && Date.now() - interview.updatedAt.getTime() <= INTERVIEW_RESUME_WINDOW_MS;
    if (!resumable) {
      await say(LINES.nothingToResume);
      return { outcome: "nothing_to_resume", committed: false };
    }
    // Only the products the owner chose in the dashboard, where it stopped.
    const products = await loadProducts(workspaceId, interview.productIds);
    const resumed = syncInterview({ ...stateOf(interview), status: "ACTIVE" }, products);
    const committed = await commit(interview, resumed, options);
    if (resumed.status !== "ACTIVE") {
      await say(messages.done);
      return { outcome: "done", committed };
    }
    await say(LINES.resumed);
    await askQuestion(token, chatId, resumed, products);
    return { outcome: "resumed", committed };
  }

  const products = await loadProducts(workspaceId, interview.productIds);
  const state = syncInterview(stateOf(interview), products);

  /** Store the new state, then ask what comes next, or finish. */
  const moveTo = async (next: InterviewState, outcome: HandleOutcome, before?: string): Promise<HandleResult> => {
    const committed = await commit(interview, next, options);
    if (before) await say(before);
    if (next.status === "ACTIVE") {
      await askQuestion(token, chatId, next, products);
      return { outcome, committed };
    }
    await say(next.status === "DONE" ? messages.done : messages.stopped);
    return { outcome: next.status === "DONE" ? "done" : outcome, committed };
  };

  if (state.status !== "ACTIVE") return moveTo(state, "done");

  switch (command) {
    case "skip":
      return moveTo(advance(state, products), "skipped");
    case "next_product":
      return moveTo(skipProduct(state, products), "next_product");
    case "stop":
      return moveTo(stopInterview(state), "stopped");
    case "status":
    case "start":
      // Where we are, and the question again: also how an owner gets back a question that never arrived.
      return moveTo(state, "status", messages.status(state.position, state.productIds.length));
    default:
      break;
  }

  const audio = message.voice ?? message.audio;
  let answer: string;
  if (audio) {
    const heard = await transcribeVoice(token, audio, options.lastAttempt === true);
    if ("reply" in heard) {
      await say(heard.reply);
      return { outcome: "voice_failed", committed: false };
    }
    answer = heard.transcript;
  } else if (text) {
    answer = text;
  } else {
    // A sticker, a photo: nothing to read.
    return ignored;
  }

  const asked = currentQuestion(state, products);
  const product = asked && products.find((candidate) => candidate.id === asked.productId);
  if (!asked || !product) return moveTo(state, "done");

  let extracted: Awaited<ReturnType<typeof extractAnswer>>;
  try {
    extracted = await extractAnswer(answer, { productId: product.id, productName: product.name, target: asked.target });
  } catch (error) {
    if (!(error instanceof GeminiError)) throw error;
    if (error.retryable && !options.lastAttempt) throw error;
    // The question stays: the owner sends the answer again.
    await say(LINES.retry);
    return { outcome: "failed", committed: false };
  }

  const suggestions: NewSuggestion[] = extracted.map((item, index) => ({
    target: TARGETS[item.target as InterviewTarget] ?? TARGETS[asked.target],
    productId: product.id,
    payload: item.payload,
    evidence: answer,
    sourceRef: interview.id,
    // The same update handled again adds nothing twice.
    dedupeKey: suggestionDedupeKey("interview", interview.id, String(update.updateId), String(index)),
  }));
  if (suggestions.length > 0) await saveSuggestions(workspaceId, "INTERVIEW", suggestions);
  return moveTo(advance(state, products), "answered", suggestions.length > 0 ? messages.heard : LINES.unusable);
}

// ─── The dashboard's view ───────────────────────────────────────────────────

export interface InterviewView {
  id: string;
  status: "ACTIVE" | "DONE" | "STOPPED";
  chatId: string;
  chatLabel: string;
  createdAt: string;
  lastAskedAt: string | null;
  total: number;
  /** Products passed so far. */
  position: number;
  question: number;
  questionCount: number;
  current: { productId: string; productName: string; target: InterviewTarget } | null;
  pending: number;
  suggestions: {
    id: string;
    target: string;
    productId: string | null;
    productName: string | null;
    payload: unknown;
    createdAt: string;
  }[];
}

/** Everything the interview panel shows: the bot, the chats, the products to choose from, the latest interview. */
export async function getInterviewPanel(workspaceId: string) {
  const [bot, chats, candidates, latest] = await Promise.all([
    getTelegramBot(workspaceId),
    interviewChatOptions(workspaceId),
    interviewCandidates(workspaceId),
    prisma.knowledgeInterview.findFirst({ where: { workspaceId }, orderBy: { createdAt: "desc" } }),
  ]);
  return {
    bot: bot ? { username: bot.username } : null,
    chats,
    candidates,
    maxProducts: MAX_INTERVIEW_PRODUCTS,
    interview: latest ? await interviewView(latest, chats) : null,
  };
}

async function interviewView(
  interview: KnowledgeInterview,
  chats: { id: string; label: string }[]
): Promise<InterviewView> {
  const [products, pending, suggestions] = await Promise.all([
    loadProducts(interview.workspaceId, interview.productIds),
    prisma.knowledgeSuggestion.count({
      where: { workspaceId: interview.workspaceId, source: "INTERVIEW", sourceRef: interview.id, status: "PENDING" },
    }),
    prisma.knowledgeSuggestion.findMany({
      where: { workspaceId: interview.workspaceId, source: "INTERVIEW", sourceRef: interview.id, status: "PENDING" },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { id: true, target: true, productId: true, payload: true, createdAt: true },
    }),
  ]);
  const names = new Map(products.map((product) => [product.id, product.name]));
  const state = syncInterview(stateOf(interview), products);
  const asked = currentQuestion(state, products);
  return {
    id: interview.id,
    status: state.status,
    chatId: interview.chatId,
    chatLabel: chats.find((chat) => chat.id === interview.chatId)?.label ?? interview.chatId,
    createdAt: interview.createdAt.toISOString(),
    lastAskedAt: interview.lastAskedAt?.toISOString() ?? null,
    total: state.productIds.length,
    position: state.position,
    question: state.status === "ACTIVE" ? state.question : 0,
    questionCount: INTERVIEW_QUESTIONS.length,
    current: asked
      ? { productId: asked.productId, productName: oneLine(names.get(asked.productId), 120), target: asked.target }
      : null,
    pending,
    suggestions: suggestions.map((suggestion) => ({
      id: suggestion.id,
      target: suggestion.target,
      productId: suggestion.productId,
      productName: suggestion.productId ? oneLine(names.get(suggestion.productId), 120) || null : null,
      payload: suggestion.payload,
      createdAt: suggestion.createdAt.toISOString(),
    })),
  };
}
