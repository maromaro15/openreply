import { describe, expect, it } from "vitest";
import {
  decodePostbackPayload,
  encodeLikePayload,
  parsePostbackEvents,
  postbackDedupeKey,
  type PostbackEvent,
} from "../../lib/facebook/postbacks";

const PAGE = "111222333";
const PSID = "7001";
const PRODUCT = "cm9x1abc0000xyz";

function messaging(events: unknown[], pageId = PAGE) {
  return { object: "page", entry: [{ id: pageId, time: 1764000000000, messaging: events }] };
}

function postback(payload: unknown = "or1|like|p1", extra: Record<string, unknown> = {}) {
  return {
    sender: { id: PSID },
    recipient: { id: PAGE },
    timestamp: 1764000000123,
    postback: { title: "نحب هذا", payload, mid: "m_abc", ...extra },
  };
}

describe("like payload", () => {
  it.each([
    ["no variant", PRODUCT, null],
    ["plain code", PRODUCT, "WP-12"],
    ["pipes", PRODUCT, "a|b||c|"],
    ["backslashes", PRODUCT, "a\\b\\|c\\"],
    ["arabic and spaces", PRODUCT, "أحمر  قاني 12"],
    ["percent, quotes, newline", PRODUCT, "50% \"x\"\n'y'"],
    ["emoji", PRODUCT, "💚-01"],
  ])("round-trips %s", (_label, id, code) => {
    const payload = encodeLikePayload(id, code);
    expect(payload.startsWith("or1|like|")).toBe(true);
    expect(payload.length).toBeLessThanOrEqual(1000);
    expect(decodePostbackPayload(payload)).toEqual({
      kind: "like",
      productId: id,
      variantCode: code,
    });
  });

  it("treats an empty code as no variant", () => {
    expect(decodePostbackPayload(encodeLikePayload(PRODUCT, ""))).toEqual({
      kind: "like",
      productId: PRODUCT,
      variantCode: null,
    });
  });

  it("refuses to encode what cannot fit or has no product", () => {
    expect(() => encodeLikePayload(PRODUCT, "x".repeat(1000))).toThrow(RangeError);
    expect(() => encodeLikePayload("", null)).toThrow();
  });

  it("accepts the longest payload that fits", () => {
    const room = 1000 - `or1|like|${PRODUCT}|`.length;
    // Each pipe costs two characters; one plain letter takes the odd one.
    const code = "|".repeat(Math.floor(room / 2)) + (room % 2 ? "a" : "");
    const payload = encodeLikePayload(PRODUCT, code);
    expect(payload.length).toBe(1000);
    expect(decodePostbackPayload(payload)?.variantCode).toBe(code);
  });

  it.each([
    ["unknown version", "or2|like|p1"],
    ["unknown kind", "or1|buy|p1"],
    ["no version", "like|p1"],
    ["empty product", "or1|like|"],
    ["empty code part", "or1|like|p1|"],
    ["extra part", "or1|like|p1|c|d"],
    ["too few parts", "or1|like"],
    ["bad escape", "or1|like|p\\x"],
    ["dangling escape", "or1|like|p1\\"],
    ["empty string", ""],
    ["prefix case", "OR1|like|p1"],
    ["too long", `or1|like|${"a".repeat(1000)}`],
  ])("decodes %s to null", (_label, payload) => {
    expect(decodePostbackPayload(payload)).toBeNull();
  });

  it.each([null, undefined, 5, {}, [], ["or1|like|p1"], true])("never throws on %j", (value) => {
    expect(decodePostbackPayload(value)).toBeNull();
  });
});

describe("parsePostbackEvents", () => {
  it("reads a postback with a mid", () => {
    expect(parsePostbackEvents(messaging([postback("or1|like|p1")]))).toEqual([
      {
        pageId: PAGE,
        psid: PSID,
        title: "نحب هذا",
        payload: "or1|like|p1",
        mid: "m_abc",
        timestamp: 1764000000123,
        referral: null,
      },
    ]);
  });

  it("reads a postback without a mid and keeps a referral object", () => {
    const body = messaging([
      postback("or1|like|p1", { mid: undefined, referral: { ref: "ad1", source: "ADS" } }),
    ]);
    const [event] = parsePostbackEvents(body);
    expect(event.mid).toBeNull();
    expect(event.referral).toEqual({ ref: "ad1", source: "ADS" });
  });

  it("reads several entries and ignores messages, echoes, standby and reads", () => {
    const body = {
      object: "page",
      entry: [
        {
          id: PAGE,
          messaging: [
            { sender: { id: PSID }, recipient: { id: PAGE }, timestamp: 1, message: { mid: "m1", text: "salam" } },
            { sender: { id: PAGE }, recipient: { id: PSID }, timestamp: 2, message: { mid: "m2", is_echo: true, text: "hi" } },
            postback("or1|like|p1"),
            { sender: { id: PSID }, recipient: { id: PAGE }, timestamp: 3, read: { watermark: 3 } },
            { sender: { id: PSID }, recipient: { id: PAGE }, timestamp: 4, delivery: { mids: ["m2"] } },
          ],
          standby: [postback("or1|like|standby")],
        },
        { id: "999", messaging: [postback("or1|like|p2", { mid: "m_b" })] },
      ],
    };
    const events = parsePostbackEvents(body);
    expect(events.map((e) => [e.pageId, e.payload])).toEqual([
      [PAGE, "or1|like|p1"],
      ["999", "or1|like|p2"],
    ]);
  });

  it("cuts title and payload, and puts the title on one line", () => {
    const [event] = parsePostbackEvents(
      messaging([postback("x".repeat(1500), { title: `a\n\n  b ${"c".repeat(200)}` })])
    );
    expect(event.payload).toHaveLength(1000);
    expect(event.title.length).toBeLessThanOrEqual(80);
    expect(event.title.startsWith("a b c")).toBe(true);
    expect(event.title).not.toMatch(/\n/);
  });

  it("does not leave half an emoji after cutting", () => {
    const [event] = parsePostbackEvents(messaging([postback("p", { title: `${"a".repeat(79)}😀` })]));
    expect(event.title).toBe("a".repeat(79));
  });

  it("types every value and skips malformed events without losing the others", () => {
    const body = messaging([
      postback("or1|like|ok1"),
      { sender: { id: PSID }, postback: { title: "x" } },
      { sender: { id: PSID }, postback: { payload: 42 } },
      { sender: { id: PSID }, postback: { payload: "" } },
      { sender: {}, postback: { payload: "or1|like|nosender" } },
      { postback: { payload: "or1|like|nosender2" } },
      { sender: { id: PAGE }, postback: { payload: "or1|like|self" } },
      { sender: { id: PSID }, postback: "oops" },
      "junk",
      null,
      postback("or1|like|ok2", { mid: { not: "a string" }, title: 7, referral: "x" }),
      { sender: { id: 8002 }, timestamp: "late", postback: { payload: "or1|like|numeric" } },
    ]);
    const events = parsePostbackEvents(body);
    expect(events.map((e) => e.payload)).toEqual(["or1|like|ok1", "or1|like|ok2", "or1|like|numeric"]);
    expect(events[1]).toMatchObject({ mid: null, title: "", referral: null });
    expect(events[2]).toMatchObject({ psid: "8002", timestamp: 0, title: "" });
  });

  it("skips an entry without an id or messaging", () => {
    const body = {
      object: "page",
      entry: [{ messaging: [postback()] }, { id: PAGE }, { id: PAGE, messaging: "x" }, 5],
    };
    expect(parsePostbackEvents(body)).toEqual([]);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "page"],
    ["a number", 4],
    ["an array", []],
    ["another object", { object: "instagram", entry: [{ id: PAGE, messaging: [postback()] }] }],
    ["no entry", { object: "page" }],
    ["entry not an array", { object: "page", entry: {} }],
  ])("returns nothing for %s", (_label, body) => {
    expect(parsePostbackEvents(body)).toEqual([]);
  });
});

describe("postbackDedupeKey", () => {
  const base: PostbackEvent = {
    pageId: PAGE,
    psid: PSID,
    title: "نحب هذا",
    payload: "or1|like|p1",
    mid: null,
    timestamp: 1764000000123,
    referral: null,
  };

  it("uses the mid when present", () => {
    expect(postbackDedupeKey({ ...base, mid: "m_abc" })).toBe("m_abc");
  });

  it("is stable across a webhook retry without a mid", () => {
    const first = parsePostbackEvents(messaging([postback("or1|like|p1", { mid: undefined })]))[0];
    const again = parsePostbackEvents(messaging([postback("or1|like|p1", { mid: undefined })]))[0];
    expect(postbackDedupeKey(first)).toBe(postbackDedupeKey(again));
    expect(postbackDedupeKey(first)).toMatch(/^pb_[a-f0-9]{32}$/);
  });

  it("differs when the click differs", () => {
    const key = postbackDedupeKey(base);
    expect(postbackDedupeKey({ ...base, psid: "7002" })).not.toBe(key);
    expect(postbackDedupeKey({ ...base, pageId: "1" })).not.toBe(key);
    expect(postbackDedupeKey({ ...base, timestamp: base.timestamp + 1 })).not.toBe(key);
    expect(postbackDedupeKey({ ...base, payload: "or1|like|p2" })).not.toBe(key);
  });

  it("does not confuse fields that run into each other", () => {
    const a = postbackDedupeKey({ ...base, pageId: "1", psid: "23" });
    const b = postbackDedupeKey({ ...base, pageId: "12", psid: "3" });
    expect(a).not.toBe(b);
  });

  it("ignores title and referral, which can change on a retry", () => {
    expect(postbackDedupeKey({ ...base, title: "other", referral: { a: 1 } })).toBe(postbackDedupeKey(base));
  });
});
