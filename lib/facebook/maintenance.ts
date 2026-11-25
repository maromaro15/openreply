/**
 * Daily upkeep run by the Facebook worker:
 *   - check every active Page token, so a revoked one shows up in the UI
 *     instead of silently failing every reply;
 *   - delete raw webhook events past their retention.
 */
import { prisma } from "@/lib/db/client";
import { getRedisConnection } from "@/lib/queue/client";
import { getFacebookWebhookRetentionDays } from "./env";
import { FacebookApiError, debugToken } from "./graph";
import { pageToken } from "./pages";

const DAILY_LOCK_KEY = "fb:maintenance:daily";

export async function checkPageTokens(): Promise<{ checked: number; invalid: number }> {
  const pages = await prisma.facebookPage.findMany({
    where: { status: "ACTIVE", accessToken: { not: "" } },
    select: { id: true, accessToken: true },
  });
  let invalid = 0;
  for (const page of pages) {
    try {
      const info = await debugToken(pageToken(page));
      if (info.is_valid === false) {
        invalid += 1;
        await prisma.facebookPage.update({
          where: { id: page.id },
          data: {
            status: "TOKEN_INVALID",
            lastError: info.error?.message ?? "The Page token is no longer valid. Connect the Page again.",
            tokenCheckedAt: new Date(),
          },
        });
        continue;
      }
      await prisma.facebookPage.update({
        where: { id: page.id },
        data: {
          tokenCheckedAt: new Date(),
          tokenExpiresAt: info.expires_at ? new Date(info.expires_at * 1000) : null,
        },
      });
    } catch (error) {
      // Only a definite "invalid token" changes the Page; a network failure
      // is tried again tomorrow.
      if (error instanceof FacebookApiError && error.kind === "token_invalid") {
        invalid += 1;
        await prisma.facebookPage.update({
          where: { id: page.id },
          data: { status: "TOKEN_INVALID", lastError: error.message, tokenCheckedAt: new Date() },
        });
      }
    }
  }
  return { checked: pages.length, invalid };
}

export async function pruneWebhookEvents(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - getFacebookWebhookRetentionDays() * 24 * 60 * 60 * 1000);
  const result = await prisma.facebookWebhookEvent.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return result.count;
}

/**
 * Run the daily upkeep at most once a day, however often the worker
 * restarts or however many replicas run.
 */
export async function runDailyMaintenance(): Promise<null | { tokens: { checked: number; invalid: number }; pruned: number }> {
  const acquired = await getRedisConnection().set(DAILY_LOCK_KEY, new Date().toISOString(), "EX", 23 * 60 * 60, "NX");
  if (acquired !== "OK") return null;
  const tokens = await checkPageTokens();
  const pruned = await pruneWebhookEvents();
  return { tokens, pruned };
}
