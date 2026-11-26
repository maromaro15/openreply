/**
 * Per-workspace counters in Redis for the routes that spend money or send
 * messages on every call (a Gemini request, an email or a Telegram message).
 * Fixed windows: the key carries the window number, so it expires by itself
 * and a crash between the two commands cannot leave a counter that never ends.
 */
import { NextResponse } from "next/server";
import { getRedisConnection } from "@/lib/queue/client";

export const BOT_TEST_LIMIT_PER_HOUR = 60;
export const ALERT_TEST_LIMIT_PER_HOUR = 10;
export const HOUR_SECONDS = 3600;

// The shared connection queues commands forever while Redis is down, so the
// wait is bounded here.
const REDIS_TIMEOUT_MS = 1500;

export type Quota = { allowed: boolean; retryAfter: number };

/**
 * Count one use of `scope` by the workspace. Redis being down allows the
 * call (the feature must keep working), and says so in the log.
 */
export async function takeWorkspaceQuota(
  scope: string,
  workspaceId: string,
  max: number,
  windowSeconds: number = HOUR_SECONDS
): Promise<Quota> {
  const now = Date.now();
  const window = Math.floor(now / (windowSeconds * 1000));
  const key = `limit:${scope}:${workspaceId}:${window}`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const redis = getRedisConnection();
    const reply = await Promise.race([
      redis.multi().incr(key).expire(key, windowSeconds).exec(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Redis did not answer")), REDIS_TIMEOUT_MS);
      }),
    ]);
    const [error, count] = reply?.[0] ?? [new Error("Empty reply"), null];
    if (error || typeof count !== "number") throw error ?? new Error("Unexpected reply");
    const retryAfter = Math.max(1, Math.ceil(((window + 1) * windowSeconds * 1000 - now) / 1000));
    return { allowed: count <= max, retryAfter };
  } catch (error) {
    console.error(`[limits] ${scope} counter unavailable, allowing:`, error instanceof Error ? error.message : error);
    return { allowed: true, retryAfter: 0 };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The 429 to answer with: `message` is a key of the Facebook catalog. */
export function rateLimitedResponse(message: string, retryAfter: number) {
  return NextResponse.json(
    { success: false, code: "rate_limited", error: message },
    { status: 429, headers: { "Retry-After": String(retryAfter) } }
  );
}
