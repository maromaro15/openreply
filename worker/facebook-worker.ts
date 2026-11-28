/**
 * Facebook Pages / Messenger worker. Runs next to the Instagram worker
 * (worker/dm-worker.ts) as its own process, so either can stop or crash
 * without touching the other.
 *
 *   npm run worker:facebook
 */
import os from "node:os";
import { createFacebookWorker } from "@/lib/facebook/worker";
import { recordFacebookHeartbeat } from "@/lib/facebook/health";
import { runDailyMaintenance } from "@/lib/facebook/maintenance";
import { sweepUnqueuedHandoffs } from "@/lib/alerts/dispatch";
import { startTelegramPolling } from "@/lib/knowledge/telegram-poller";

const HEARTBEAT_INTERVAL_MS = 30_000;
const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;

const worker = createFacebookWorker();
// The brands' Telegram bots: the voice interview's answers (PLAN.md 6.15).
const telegram = startTelegramPolling();
const startedAt = new Date().toISOString();

console.log("[Facebook worker] Started");

async function heartbeat() {
  try {
    await recordFacebookHeartbeat({ pid: process.pid, hostname: os.hostname(), startedAt });
  } catch (error) {
    console.error("[Facebook worker] Heartbeat failed:", error instanceof Error ? error.message : error);
  }
}

async function maintenance() {
  try {
    const result = await runDailyMaintenance();
    if (result) console.log("[Facebook worker] Daily maintenance:", result);
  } catch (error) {
    console.error("[Facebook worker] Maintenance failed:", error instanceof Error ? error.message : error);
  }
  try {
    // Handoffs of the last hour whose alerts never got queued.
    const queued = await sweepUnqueuedHandoffs();
    if (queued) console.log(`[Facebook worker] Queued ${queued} missed alert(s)`);
  } catch (error) {
    console.error("[Facebook worker] Alert sweep failed:", error instanceof Error ? error.message : error);
  }
}

void heartbeat();
const heartbeatTimer = setInterval(() => void heartbeat(), HEARTBEAT_INTERVAL_MS);
// Hourly attempts; the Redis lock makes it run once a day.
const maintenanceStart = setTimeout(() => void maintenance(), 60_000);
const maintenanceTimer = setInterval(() => void maintenance(), MAINTENANCE_INTERVAL_MS);

async function shutdown(signal: string) {
  console.log(`[Facebook worker] ${signal} received, closing`);
  clearInterval(heartbeatTimer);
  clearInterval(maintenanceTimer);
  clearTimeout(maintenanceStart);
  await telegram.stop();
  // Lets running jobs finish; their claims make a restart safe either way.
  await worker.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
