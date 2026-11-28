import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyPageSignature } from "../../lib/facebook/webhook";

const SECRET = "test_app_secret";

function sign(body: string | Buffer, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("verifyPageSignature", () => {
  it("accepts a signature over the exact body", () => {
    const body = '{"object":"page","entry":[]}';
    expect(verifyPageSignature(body, sign(body), SECRET)).toEqual({ ok: true });
  });

  it("checks raw bytes, so Arabic text in a comment verifies", () => {
    const body = Buffer.from('{"message":"شحال السعر؟ 💬"}', "utf8");
    expect(verifyPageSignature(body, sign(body), SECRET)).toEqual({ ok: true });
    expect(verifyPageSignature(new Uint8Array(body), sign(body), SECRET)).toEqual({ ok: true });
  });

  it("fails when the body is re-serialised instead of read raw", () => {
    // Meta escapes non-ASCII text. Parsing and stringifying turns the escapes
    // into characters, which changes the bytes and so the HMAC.
    const raw = '{"message":"\\u0633\\u0639\\u0631"}';
    const signature = sign(raw);
    expect(verifyPageSignature(raw, signature, SECRET)).toEqual({ ok: true });
    const reserialised = JSON.stringify(JSON.parse(raw));
    expect(reserialised).not.toBe(raw);
    expect(verifyPageSignature(reserialised, signature, SECRET)).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  it("accepts an upper-case hex digest", () => {
    const body = "{}";
    const signature = `sha256=${sign(body).slice("sha256=".length).toUpperCase()}`;
    expect(verifyPageSignature(body, signature, SECRET)).toEqual({ ok: true });
  });

  it("rejects a tampered body and a wrong secret", () => {
    const body = '{"object":"page"}';
    expect(verifyPageSignature('{"object":"page!"}', sign(body), SECRET)).toEqual({
      ok: false,
      reason: "mismatch",
    });
    expect(verifyPageSignature(body, sign(body, "other_secret"), SECRET)).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  it("says why it rejected a request", () => {
    expect(verifyPageSignature("{}", null, SECRET)).toEqual({ ok: false, reason: "missing_header" });
    expect(verifyPageSignature("{}", "", SECRET)).toEqual({ ok: false, reason: "missing_header" });
    expect(verifyPageSignature("{}", "sha1=abc", SECRET)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyPageSignature("{}", "sha256=1234", SECRET)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyPageSignature("{}", sign("{}"), null)).toEqual({ ok: false, reason: "missing_secret" });
  });

  it("reads FACEBOOK_APP_SECRET by default", () => {
    vi.stubEnv("FACEBOOK_APP_SECRET", SECRET);
    expect(verifyPageSignature("{}", sign("{}"))).toEqual({ ok: true });
    vi.stubEnv("FACEBOOK_APP_SECRET", "");
    expect(verifyPageSignature("{}", sign("{}"))).toEqual({ ok: false, reason: "missing_secret" });
  });
});
