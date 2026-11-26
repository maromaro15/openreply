/**
 * Daily upkeep run by the Facebook worker:
 *   - check every active Page token, so a revoked one shows up in the UI
 *     instead of silently failing every reply;
 *   - delete raw webhook events past their retention;
 *   - delete product pictures uploaded for a card that was never saved.
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

/** A picture is attached to its product when the card is saved; a day is plenty. */
export const ORPHAN_IMAGE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Pictures still attached to no product a day after their upload: the card
 * they were uploaded for was never saved, so nothing uses them and their
 * link was never sent.
 */
export async function pruneOrphanImages(now = new Date()): Promise<number> {
  const result = await prisma.productImage.deleteMany({
    where: { productId: null, createdAt: { lt: new Date(now.getTime() - ORPHAN_IMAGE_TTL_MS) } },
  });
  return result.count;
}

/**
 * Run the daily upkeep at most once a day, however often the worker
 * restarts or however many replicas run. Each step stands alone: the lock
 * holds for a day, so one failing step (Meta down for the token check, say)
 * must not cost the others their day. A failed step is null in the result
 * and named in `failed`.
 */
export async function runDailyMaintenance(): Promise<null | {
  tokens: { checked: number; invalid: number } | null;
  pruned: number | null;
  orphanImages: number | null;
  failed: string[];
}> {
  const acquired = await getRedisConnection().set(DAILY_LOCK_KEY, new Date().toISOString(), "EX", 23 * 60 * 60, "NX");
  if (acquired !== "OK") return null;
  const failed: string[] = [];
  const step = async <T>(name: string, run: () => Promise<T>): Promise<T | null> => {
    try {
      return await run();
    } catch (error) {
      failed.push(name);
      console.error(`[Facebook worker] Daily maintenance step "${name}" failed:`, error instanceof Error ? error.message : error);
      return null;
    }
  };
  const tokens = await step("tokens", checkPageTokens);
  const pruned = await step("pruned", pruneWebhookEvents);
  const orphanImages = await step("orphanImages", pruneOrphanImages);
  return { tokens, pruned, orphanImages, failed };
}
