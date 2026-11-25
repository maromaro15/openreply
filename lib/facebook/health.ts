/**
 * Facebook worker heartbeat and recent failures, in Redis keys of its own so
 * the Instagram worker's health stays exactly as it was.
 */
import { getRedisConnection } from "@/lib/queue/client";

const HEARTBEAT_KEY = "health:worker:facebook";
const ALERTS_KEY = "alerts:worker:facebook";
const HEARTBEAT_TTL_SECONDS = 120;

export interface FacebookHeartbeat {
  pid: number;
  hostname?: string;
  startedAt?: string;
  checkedAt: string;
}

export async function recordFacebookHeartbeat(heartbeat: Omit<FacebookHeartbeat, "checkedAt">) {
  await getRedisConnection().set(
    HEARTBEAT_KEY,
    JSON.stringify({ ...heartbeat, checkedAt: new Date().toISOString() }),
    "EX",
    HEARTBEAT_TTL_SECONDS
  );
}

export async function getFacebookWorkerHealth(): Promise<{
  healthy: boolean;
  heartbeat: FacebookHeartbeat | null;
  ageMs: number | null;
}> {
  const raw = await getRedisConnection().get(HEARTBEAT_KEY);
  if (!raw) return { healthy: false, heartbeat: null, ageMs: null };
  try {
    const heartbeat = JSON.parse(raw) as FacebookHeartbeat;
    const ageMs = Date.now() - new Date(heartbeat.checkedAt).getTime();
    return { healthy: ageMs <= HEARTBEAT_TTL_SECONDS * 1000, heartbeat, ageMs };
  } catch {
    return { healthy: false, heartbeat: null, ageMs: null };
  }
}

export interface FacebookWorkerAlert {
  message: string;
  jobId?: string;
  jobName?: string;
  createdAt: string;
}

export async function recordFacebookWorkerAlert(alert: Omit<FacebookWorkerAlert, "createdAt">) {
  const redis = getRedisConnection();
  await redis.lpush(ALERTS_KEY, JSON.stringify({ ...alert, createdAt: new Date().toISOString() }));
  await redis.ltrim(ALERTS_KEY, 0, 49);
}

export async function getFacebookWorkerAlerts(limit = 10): Promise<FacebookWorkerAlert[]> {
  const rows = await getRedisConnection().lrange(ALERTS_KEY, 0, Math.max(0, limit - 1));
  return rows.flatMap((row) => {
    try {
      return [JSON.parse(row) as FacebookWorkerAlert];
    } catch {
      return [];
    }
  });
}
