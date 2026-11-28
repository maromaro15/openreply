/**
 * Reads the brands' Telegram bots with getUpdates long polling, for the voice
 * interview (PLAN.md 6.15). No public webhook is needed.
 *
 * - Only the bots of brands with an interview running (or stopped within the
 *   resume window) are read; the others keep phase 8's behaviour, where the
 *   "fetch chats" button reads the unconfirmed updates itself.
 * - One reader per bot across worker processes: a Redis lock with expiry,
 *   renewed while reading (Telegram answers 409 to a second getUpdates).
 * - The offset is stored per brand with the bot's ID (the token's numeric
 *   prefix): a different bot starts again. It moves past an update only once
 *   the update is handled, in the same transaction as the interview's state,
 *   and past a poison update once it failed MAX_ATTEMPTS times.
 * - Every chat seen goes to TelegramChatSeen, for the alerts' chat picker.
 */
import { randomUUID } from "node:crypto";
import { telegramBotToken } from "@/lib/alerts/settings";
import { chatsFromUpdates, TelegramError, telegramGetUpdates, type TelegramUpdate } from "@/lib/alerts/telegram";
import { prisma } from "@/lib/db/client";
import { readBoolEnv } from "@/lib/facebook/env";
import { getRedisConnection } from "@/lib/queue/client";
import {
  expireIdleInterviews,
  handleInterviewUpdate,
  isPollable,
  pollableWorkspaces,
  recordSeenChats,
  telegramCursorWrite,
} from "./interview-run";

/** Telegram holds a quiet poll this long; the HTTP timeout adds HTTP_MARGIN_MS on top. */
export const POLL_TIMEOUT_SECONDS = 25;
const HTTP_MARGIN_MS = 15_000;
/** Longer than one poll plus one voice note (download, ffmpeg, Gemini); renewed before each. */
const LOCK_TTL_MS = 180_000;
const SCAN_INTERVAL_MS = 10_000;
/** The 7-day idle check needs no more than this. */
const EXPIRY_INTERVAL_MS = 60_000;
/** An update that failed this many times is skipped, so it never blocks the ones behind it. */
export const MAX_ATTEMPTS = 3;
const FAILURE_TTL_SECONDS = 24 * 60 * 60;
const BATCH_SIZE = 20;
/** Edits are left out: an edited answer would be taken for the answer to the next question. */
const ALLOWED_UPDATES = ["message", "channel_post", "my_chat_member"];
const WEBHOOK_PAUSE_MS = 5 * 60_000;
const BAD_TOKEN_PAUSE_MS = 10 * 60_000;
const CONFLICT_WAIT_MS = 5_000;
const MAX_BACKOFF_MS = 60_000;

/** The Redis commands used here (ioredis signatures). */
export interface PollerRedis {
  set(key: string, value: string, px: "PX", ms: number, nx: "NX"): Promise<string | null>;
  get(key: string): Promise<string | null>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  del(key: string): Promise<number>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

export interface PollerDeps {
  enabled: boolean;
  redis: () => PollerRedis;
  getUpdates: typeof telegramGetUpdates;
  handle: typeof handleInterviewUpdate;
  scanIntervalMs: number;
  pollTimeoutSeconds: number;
  /** The wait after the n-th failure in a row. */
  backoffMs: (failures: number) => number;
}

function defaults(): PollerDeps {
  return {
    enabled: readBoolEnv("TELEGRAM_POLLING", true),
    redis: () => getRedisConnection() as unknown as PollerRedis,
    getUpdates: telegramGetUpdates,
    handle: handleInterviewUpdate,
    scanIntervalMs: SCAN_INTERVAL_MS,
    pollTimeoutSeconds: POLL_TIMEOUT_SECONDS,
    backoffMs: (failures) => Math.min(MAX_BACKOFF_MS, 2_000 * 2 ** Math.max(0, failures - 1)),
  };
}

/** The bot's numeric ID, the part of the token before the colon: not secret. */
export function telegramBotId(token: string): string {
  return token.slice(0, Math.max(0, token.indexOf(":")));
}

const RENEW = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end`;
const RELEASE = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

const lockKey = (botId: string) => `fb:telegram:poll:${botId}`;
const failureKey = (botId: string, updateId: number) => `fb:telegram:fail:${botId}:${updateId}`;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Where the brand's bot was read up to; another bot's offset does not apply. */
async function readOffset(workspaceId: string, botId: string): Promise<bigint> {
  const cursor = await prisma.telegramCursor.findUnique({ where: { workspaceId } });
  return cursor && cursor.botId === botId ? cursor.offset : BigInt(0);
}

export function startTelegramPolling(overrides: Partial<PollerDeps> = {}): { stop(): Promise<void> } {
  const deps: PollerDeps = { ...defaults(), ...overrides };
  if (!deps.enabled) return { stop: async () => {} };

  const instance = randomUUID();
  const controller = new AbortController();
  const loops = new Map<string, Promise<void>>();
  const pausedUntil = new Map<string, number>();
  let stopped = false;
  let expiredAt = 0;

  /** Resolves early on stop(). */
  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (stopped) return resolve();
      const done = () => {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      controller.signal.addEventListener("abort", done, { once: true });
    });
  }

  // stop() aborts a long poll in flight instead of waiting out its timeout.
  const fetchImpl: typeof fetch = (input, init) =>
    fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal });

  async function renew(key: string): Promise<boolean> {
    return Number(await deps.redis().eval(RENEW, 1, key, instance, LOCK_TTL_MS)) === 1;
  }

  async function release(key: string): Promise<void> {
    try {
      await deps.redis().eval(RELEASE, 1, key, instance);
    } catch (error) {
      console.error("[Telegram poller] Could not release a lock:", describe(error));
    }
  }

  /** How long to wait after a failed getUpdates, or null to leave this bot alone for a while. */
  function afterPollFailure(workspaceId: string, error: unknown, failures: number): number | null {
    if (error instanceof TelegramError) {
      if (error.httpStatus === 409) {
        if (/webhook/i.test(error.message)) {
          // A webhook at another service gets the updates: the alerts page says so.
          pausedUntil.set(workspaceId, Date.now() + WEBHOOK_PAUSE_MS);
          return null;
        }
        // Another getUpdates (the alerts page's button) took this one's place.
        return CONFLICT_WAIT_MS;
      }
      if (error.kind === "invalid_token") {
        pausedUntil.set(workspaceId, Date.now() + BAD_TOKEN_PAUSE_MS);
        return null;
      }
      if (error.kind === "rate_limited" && error.retryAfterSeconds !== undefined) {
        return Math.min(MAX_BACKOFF_MS * 5, error.retryAfterSeconds * 1000);
      }
    }
    return deps.backoffMs(failures);
  }

  /** True when the offset may move past the update: handled, or given up on. */
  async function handleOne(workspaceId: string, token: string, botId: string, update: TelegramUpdate): Promise<boolean> {
    const redis = deps.redis();
    const key = failureKey(botId, update.updateId);
    const offset = BigInt(update.updateId) + BigInt(1);
    const failedBefore = Number(await redis.get(key)) || 0;
    try {
      const result = await deps.handle(workspaceId, token, update, {
        cursor: { botId, offset },
        lastAttempt: failedBefore + 1 >= MAX_ATTEMPTS,
      });
      if (!result.committed) await telegramCursorWrite(workspaceId, botId, offset);
      if (failedBefore > 0) await redis.del(key);
      return true;
    } catch (error) {
      const failures = await redis.incr(key);
      await redis.expire(key, FAILURE_TTL_SECONDS);
      if (failures < MAX_ATTEMPTS) {
        console.error(`[Telegram poller] Update ${update.updateId} failed (${failures}/${MAX_ATTEMPTS}):`, describe(error));
        return false;
      }
      console.error(`[Telegram poller] Skipping update ${update.updateId} after ${failures} failures:`, describe(error));
      try {
        await telegramCursorWrite(workspaceId, botId, offset);
      } catch (writeError) {
        console.error("[Telegram poller] Could not move the offset:", describe(writeError));
        return false;
      }
      await redis.del(key);
      return true;
    }
  }

  async function pollBrand(workspaceId: string): Promise<void> {
    const token = await telegramBotToken(workspaceId);
    if (!token) {
      pausedUntil.set(workspaceId, Date.now() + BAD_TOKEN_PAUSE_MS);
      return;
    }
    const botId = telegramBotId(token);
    const key = lockKey(botId);
    // Another worker process reads this bot already.
    if ((await deps.redis().set(key, instance, "PX", LOCK_TTL_MS, "NX")) !== "OK") return;
    try {
      let offset = await readOffset(workspaceId, botId);
      let failures = 0;
      while (!stopped) {
        if (!(await renew(key))) return;
        // The interview ended or the bot changed: leave the bot to phase 8, or start over with the new one.
        if (!(await isPollable(workspaceId)) || (await telegramBotToken(workspaceId)) !== token) return;

        let updates: TelegramUpdate[];
        try {
          updates = await deps.getUpdates(
            token,
            {
              offset: offset > BigInt(0) ? Number(offset) : undefined,
              timeoutSeconds: deps.pollTimeoutSeconds,
              limit: BATCH_SIZE,
              allowedUpdates: ALLOWED_UPDATES,
            },
            { timeoutMs: HTTP_MARGIN_MS, fetchImpl }
          );
        } catch (error) {
          if (stopped) return;
          failures += 1;
          const wait = afterPollFailure(workspaceId, error, failures);
          console.error("[Telegram poller] getUpdates failed:", describe(error));
          if (wait === null) return;
          await sleep(wait);
          continue;
        }

        await recordSeenChats(workspaceId, chatsFromUpdates(updates));
        let blocked = false;
        for (const update of [...updates].sort((a, b) => a.updateId - b.updateId)) {
          if (stopped) return;
          const next = BigInt(update.updateId) + BigInt(1);
          if (next <= offset) continue;
          if (!(await renew(key))) return;
          if (!(await handleOne(workspaceId, token, botId, update))) {
            blocked = true;
            break;
          }
          offset = next;
        }
        if (blocked) {
          // The same update comes back on the next poll, after a pause.
          failures += 1;
          await sleep(deps.backoffMs(failures));
        } else {
          failures = 0;
        }
      }
    } finally {
      await release(key);
    }
  }

  async function scan(): Promise<void> {
    if (Date.now() - expiredAt >= EXPIRY_INTERVAL_MS) {
      expiredAt = Date.now();
      await expireIdleInterviews();
    }
    for (const workspaceId of await pollableWorkspaces()) {
      if (stopped) return;
      if (loops.has(workspaceId) || (pausedUntil.get(workspaceId) ?? 0) > Date.now()) continue;
      const loop = pollBrand(workspaceId)
        .catch((error) => console.error("[Telegram poller] Reading a bot failed:", describe(error)))
        .finally(() => loops.delete(workspaceId));
      loops.set(workspaceId, loop);
    }
  }

  const supervisor = (async () => {
    while (!stopped) {
      try {
        await scan();
      } catch (error) {
        console.error("[Telegram poller] Scan failed:", describe(error));
      }
      await sleep(deps.scanIntervalMs);
    }
  })();

  return {
    async stop() {
      stopped = true;
      controller.abort();
      await supervisor;
      // An update being handled finishes; its locks are released.
      await Promise.allSettled([...loops.values()]);
    },
  };
}
