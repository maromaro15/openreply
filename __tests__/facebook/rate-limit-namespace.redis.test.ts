/**
 * The Facebook channel reuses the Instagram rate limiter unchanged, with
 * "fb:<pageId>" as the account key. On a real Redis, a Page and an Instagram
 * account must never share a counter or a pause, even with the same digits.
 *
 * Skipped unless TEST_REDIS_URL points at a disposable Redis.
 */
import { randomBytes } from "node:crypto";
import Redis from "ioredis";
import { afterAll, afterEach, describe, expect, it } from "vitest";

const redisUrl = process.env.TEST_REDIS_URL;
if (redisUrl) process.env.REDIS_URL = redisUrl;

const limiter = await import("../../lib/utils/rate-limiter");
const { rateLimitKey } = await import("../../lib/facebook/comments");

describe.skipIf(!redisUrl)("Facebook keys in the shared rate limiter", () => {
  const redis = redisUrl ? new Redis(redisUrl) : (null as unknown as Redis);
  const digits = String(Date.now()) + randomBytes(2).toString("hex");
  const instagram = digits;
  const facebook = rateLimitKey(digits);

  afterEach(async () => {
    await redis.del(
      `rate:dm:${instagram}`,
      `rate:dm:${facebook}`,
      `rate:dm:pause:${instagram}`,
      `rate:dm:pause:${facebook}`
    );
  });

  afterAll(async () => {
    await redis?.quit();
  });

  it("counts a Page apart from an Instagram account with the same digits", async () => {
    expect(facebook).toBe(`fb:${digits}`);
    await limiter.reserveDMSlot(facebook);
    await limiter.reserveDMSlot(facebook);
    await limiter.reserveDMSlot(instagram);
    expect(await limiter.getCurrentDMCount(facebook)).toBe(2);
    expect(await limiter.getCurrentDMCount(instagram)).toBe(1);
  });

  it("pauses a throttled Page without pausing Instagram", async () => {
    await limiter.pauseDMSends(facebook, 60_000);
    const page = await limiter.reserveDMSlot(facebook);
    const account = await limiter.reserveDMSlot(instagram);
    expect(page.allowed).toBe(false);
    expect(page.shouldRequeue).toBe(true);
    expect(account.allowed).toBe(true);
  });

  it("hands a slot back on the Page's own counter", async () => {
    await limiter.reserveDMSlot(facebook);
    await limiter.reserveDMSlot(instagram);
    await limiter.releaseDMSlot(facebook);
    expect(await limiter.getCurrentDMCount(facebook)).toBe(0);
    expect(await limiter.getCurrentDMCount(instagram)).toBe(1);
  });
});
