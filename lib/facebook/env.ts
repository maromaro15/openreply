/**
 * Environment for the Facebook Pages / Messenger channel.
 *
 * Every variable falls back to the one the Instagram setup already uses for
 * the same thing, so a single Meta app serves both channels without new
 * configuration. A separate Meta app for Pages only needs the FACEBOOK_*
 * overrides.
 */
import { getMetaGraphApiVersion } from "@/lib/env";

/** Permissions a Page token needs for everything this channel does. */
export const REQUIRED_PAGE_PERMISSIONS = [
  "pages_messaging",
  "pages_read_engagement",
  "pages_manage_metadata",
  "pages_show_list",
  "pages_manage_engagement",
] as const;

/** Page webhook fields the app subscribes to on every connected Page. */
export const PAGE_WEBHOOK_FIELDS = ["feed", "messages", "message_echoes"] as const;

function read(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

export function getFacebookGraphApiVersion(): string {
  return read("FACEBOOK_GRAPH_API_VERSION") ?? getMetaGraphApiVersion();
}

export function getFacebookGraphBase(): string {
  return `https://graph.facebook.com/${getFacebookGraphApiVersion()}`;
}

/** The Meta app ID: checks token ownership and tells our echoes apart. */
export function getFacebookAppId(): string | null {
  return read("FACEBOOK_APP_ID") ?? read("META_APP_ID");
}

/** Signs webhooks and, with the app ID, builds the app access token. */
export function getFacebookAppSecret(): string | null {
  return read("FACEBOOK_APP_SECRET");
}

export function getFacebookWebhookVerifyToken(): string | null {
  return read("FACEBOOK_WEBHOOK_VERIFY_TOKEN") ?? read("WEBHOOK_VERIFY_TOKEN");
}

/**
 * Variables missing before a Page can be connected and its webhooks trusted.
 * Shown in the UI so a half-filled .env names what is missing instead of
 * failing later inside a Graph call.
 */
export function getMissingFacebookEnv(): string[] {
  const missing: string[] = [];
  if (!getFacebookAppId()) missing.push("FACEBOOK_APP_ID");
  if (!getFacebookAppSecret()) missing.push("FACEBOOK_APP_SECRET");
  if (!getFacebookWebhookVerifyToken()) missing.push("FACEBOOK_WEBHOOK_VERIFY_TOKEN");
  if (!/^[a-f0-9]{64}$/i.test(read("ENCRYPTION_KEY") ?? "")) missing.push("ENCRYPTION_KEY");
  return missing;
}

/** An integer setting, clamped to [min, max]; the fallback when unset or invalid. */
export function readIntEnv(
  name: string,
  fallback: number,
  { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}
): number {
  const raw = read(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export function readBoolEnv(name: string, fallback = false): boolean {
  const raw = read(name)?.toLowerCase();
  if (raw === undefined || raw === null) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

export function getFacebookWorkerConcurrency(): number {
  return readIntEnv("FACEBOOK_WORKER_CONCURRENCY", 5, { min: 1, max: 50 });
}

export function getFacebookAudioMaxBytes(): number {
  return readIntEnv("FACEBOOK_AUDIO_MAX_BYTES", 15 * 1024 * 1024, {
    min: 64 * 1024,
    max: 19 * 1024 * 1024, // Gemini caps an inline request at 20 MB.
  });
}

export function getFacebookWebhookRetentionDays(): number {
  return readIntEnv("FACEBOOK_WEBHOOK_RETENTION_DAYS", 30, { min: 1, max: 365 });
}

/** HUMAN_AGENT tag: human replies up to 7 days. Needs Meta's approval. */
export function isHumanAgentTagEnabled(): boolean {
  return readBoolEnv("FACEBOOK_HUMAN_AGENT_TAG", false);
}
