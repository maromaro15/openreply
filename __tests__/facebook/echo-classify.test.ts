import { describe, expect, it } from "vitest";
import {
  classifyEcho,
  messageMetadata,
  parseMetadata,
  privateReplyMetadata,
} from "../../lib/facebook/echoes";

const APP_ID = "1517776481860111";
const META_INBOX_APP_ID = "263902037430900";

describe("echo metadata", () => {
  it("round-trips message and private reply references", () => {
    expect(parseMetadata(messageMetadata("msg_1"))).toEqual({ kind: "message", id: "msg_1" });
    expect(parseMetadata(privateReplyMetadata("log_1"))).toEqual({ kind: "comment", id: "log_1" });
  });

  it.each([undefined, null, "", "other-tool:123", "openreply:", "openreply:c:"])(
    "treats %s as not ours",
    (value) => {
      expect(parseMetadata(value)).toBeNull();
    }
  );
});

describe("classifyEcho", () => {
  const ctx = { ourAppId: APP_ID, midIsKnown: false };

  it("recognises our message by its metadata first", () => {
    expect(classifyEcho({ mid: "m1", metadata: "openreply:msg_1", appId: APP_ID }, ctx)).toEqual({
      origin: "ours",
      via: "metadata",
      reference: { kind: "message", id: "msg_1" },
    });
  });

  it("recognises our private reply by its metadata", () => {
    expect(classifyEcho({ mid: "m1", metadata: "openreply:c:log_9" }, ctx)).toMatchObject({
      origin: "ours",
      reference: { kind: "comment", id: "log_9" },
    });
  });

  it("covers the race where the echo beats the saved message id", () => {
    // The worker has not stored the mid yet, but metadata settles it.
    expect(
      classifyEcho({ mid: "m_new", metadata: "openreply:msg_2", appId: APP_ID }, { ourAppId: APP_ID, midIsKnown: false })
        .origin
    ).toBe("ours");
  });

  it("falls back to our app id, then to a saved message id", () => {
    expect(classifyEcho({ mid: "m2", appId: APP_ID }, ctx)).toEqual({ origin: "ours", via: "app_id" });
    expect(classifyEcho({ mid: "m3" }, { ourAppId: APP_ID, midIsKnown: true })).toEqual({
      origin: "ours",
      via: "mid",
    });
  });

  it("compares app ids as strings", () => {
    expect(classifyEcho({ mid: "m4", appId: "1517776481860111" }, { ourAppId: APP_ID, midIsKnown: false }).origin).toBe(
      "ours"
    );
  });

  it("treats a reply typed in Meta Business Suite as a person", () => {
    expect(classifyEcho({ mid: "m5", appId: META_INBOX_APP_ID }, ctx)).toEqual({
      origin: "external",
    });
    expect(classifyEcho({ mid: "m6" }, ctx)).toEqual({ origin: "external" });
  });

  it("does not claim echoes when our app id is not configured", () => {
    expect(classifyEcho({ mid: "m7", appId: APP_ID }, { ourAppId: null, midIsKnown: false })).toEqual({
      origin: "external",
    });
  });
});
