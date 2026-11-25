import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PAGE_WEBHOOK_FIELDS,
  REQUIRED_PAGE_PERMISSIONS,
  getFacebookAppId,
  getFacebookAudioMaxBytes,
  getFacebookGraphApiVersion,
  getFacebookWebhookVerifyToken,
  getMissingFacebookEnv,
  isHumanAgentTagEnabled,
  readIntEnv,
} from "../../lib/facebook/env";

const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Facebook environment", () => {
  it("asks for the five Page permissions and three webhook fields", () => {
    expect([...REQUIRED_PAGE_PERMISSIONS].sort()).toEqual([
      "pages_manage_engagement",
      "pages_manage_metadata",
      "pages_messaging",
      "pages_read_engagement",
      "pages_show_list",
    ]);
    expect(PAGE_WEBHOOK_FIELDS).toEqual(["feed", "messages", "message_echoes"]);
  });

  it("falls back to the Instagram setup's variables", () => {
    vi.stubEnv("FACEBOOK_APP_ID", "");
    vi.stubEnv("META_APP_ID", "meta_app");
    vi.stubEnv("FACEBOOK_WEBHOOK_VERIFY_TOKEN", "");
    vi.stubEnv("WEBHOOK_VERIFY_TOKEN", "shared_token");
    vi.stubEnv("FACEBOOK_GRAPH_API_VERSION", "");
    vi.stubEnv("META_GRAPH_API_VERSION", "v24.0");
    expect(getFacebookAppId()).toBe("meta_app");
    expect(getFacebookWebhookVerifyToken()).toBe("shared_token");
    expect(getFacebookGraphApiVersion()).toBe("v24.0");
  });

  it("prefers the FACEBOOK_* overrides", () => {
    vi.stubEnv("FACEBOOK_APP_ID", "fb_app");
    vi.stubEnv("META_APP_ID", "meta_app");
    vi.stubEnv("FACEBOOK_WEBHOOK_VERIFY_TOKEN", "fb_token");
    vi.stubEnv("WEBHOOK_VERIFY_TOKEN", "shared_token");
    expect(getFacebookAppId()).toBe("fb_app");
    expect(getFacebookWebhookVerifyToken()).toBe("fb_token");
  });

  it("names every missing variable", () => {
    for (const name of [
      "FACEBOOK_APP_ID",
      "META_APP_ID",
      "FACEBOOK_APP_SECRET",
      "FACEBOOK_WEBHOOK_VERIFY_TOKEN",
      "WEBHOOK_VERIFY_TOKEN",
    ]) {
      vi.stubEnv(name, "");
    }
    vi.stubEnv("ENCRYPTION_KEY", "short");
    expect(getMissingFacebookEnv()).toEqual([
      "FACEBOOK_APP_ID",
      "FACEBOOK_APP_SECRET",
      "FACEBOOK_WEBHOOK_VERIFY_TOKEN",
      "ENCRYPTION_KEY",
    ]);

    vi.stubEnv("FACEBOOK_APP_ID", "a");
    vi.stubEnv("FACEBOOK_APP_SECRET", "b");
    vi.stubEnv("FACEBOOK_WEBHOOK_VERIFY_TOKEN", "c");
    vi.stubEnv("ENCRYPTION_KEY", KEY);
    expect(getMissingFacebookEnv()).toEqual([]);
  });

  it("reads integers with clamping and a fallback", () => {
    vi.stubEnv("X_INT", "12");
    expect(readIntEnv("X_INT", 5, { min: 1, max: 10 })).toBe(10);
    vi.stubEnv("X_INT", "abc");
    expect(readIntEnv("X_INT", 5)).toBe(5);
    vi.stubEnv("X_INT", "2.5");
    expect(readIntEnv("X_INT", 5)).toBe(5);
    vi.stubEnv("FACEBOOK_AUDIO_MAX_BYTES", String(50 * 1024 * 1024));
    expect(getFacebookAudioMaxBytes()).toBe(19 * 1024 * 1024);
  });

  it("keeps the HUMAN_AGENT tag off unless switched on", () => {
    vi.stubEnv("FACEBOOK_HUMAN_AGENT_TAG", "");
    expect(isHumanAgentTagEnabled()).toBe(false);
    vi.stubEnv("FACEBOOK_HUMAN_AGENT_TAG", "true");
    expect(isHumanAgentTagEnabled()).toBe(true);
  });
});
