import { describe, expect, it } from "vitest";
import { parsePageWebhook } from "../../lib/facebook/webhook";

const PAGE = "111222333";
const POST = `${PAGE}_444`;

function feed(value: Record<string, unknown>, pageId = PAGE) {
  return {
    object: "page",
    entry: [{ id: pageId, time: 1764000000, changes: [{ field: "feed", value }] }],
  };
}

function comment(overrides: Record<string, unknown> = {}) {
  return {
    item: "comment",
    verb: "add",
    comment_id: "444_555",
    post_id: POST,
    parent_id: POST,
    from: { id: "999", name: "Amina B." },
    message: "شحال السعر؟",
    created_time: 1764000000,
    ...overrides,
  };
}

function messaging(events: Array<Record<string, unknown>>, pageId = PAGE) {
  return { object: "page", entry: [{ id: pageId, time: 1764000000000, messaging: events }] };
}

describe("parsePageWebhook: feed comments", () => {
  it("reads a new comment", () => {
    const parsed = parsePageWebhook(feed(comment()));
    expect(parsed.pageIds).toEqual([PAGE]);
    expect(parsed.comments).toEqual([
      {
        pageId: PAGE,
        commentId: "444_555",
        postId: POST,
        commenterId: "999",
        commenterName: "Amina B.",
        text: "شحال السعر؟",
        createdAt: new Date(1764000000 * 1000),
      },
    ]);
  });

  it("keeps the parent of a reply to another comment", () => {
    const parsed = parsePageWebhook(feed(comment({ comment_id: "444_777", parent_id: "444_555" })));
    expect(parsed.comments[0]).toMatchObject({ commentId: "444_777", parentId: "444_555" });
  });

  it.each([
    ["edited", { verb: "edited" }],
    ["removed", { verb: "remove" }],
    ["hidden", { verb: "hide" }],
    ["a reaction", { item: "reaction" }],
    ["a post", { item: "status" }],
    ["missing its id", { comment_id: undefined }],
    ["missing its post", { post_id: undefined }],
  ])("ignores a comment that is %s", (_label, overrides) => {
    expect(parsePageWebhook(feed(comment(overrides))).comments).toEqual([]);
  });

  it("ignores the Page's own comments, including our public replies", () => {
    const parsed = parsePageWebhook(feed(comment({ from: { id: PAGE, name: "Shop" } })));
    expect(parsed.comments).toEqual([]);
    expect(parsed.pageIds).toEqual([PAGE]);
  });

  it("accepts a comment without a from block", () => {
    const parsed = parsePageWebhook(feed(comment({ from: undefined })));
    expect(parsed.comments).toHaveLength(1);
    expect(parsed.comments[0].commenterId).toBeUndefined();
  });

  it("reads ISO and millisecond timestamps", () => {
    const iso = parsePageWebhook(feed(comment({ created_time: "2026-11-24T10:00:00+0000" })));
    expect(iso.comments[0].createdAt.toISOString()).toBe("2026-11-24T10:00:00.000Z");
    const ms = parsePageWebhook(feed(comment({ created_time: 1764000000000 })));
    expect(ms.comments[0].createdAt.getTime()).toBe(1764000000000);
  });

  it("ignores other webhook objects and other fields", () => {
    expect(parsePageWebhook({ ...feed(comment()), object: "instagram" }).comments).toEqual([]);
    const otherField = {
      object: "page",
      entry: [{ id: PAGE, changes: [{ field: "mention", value: comment() }] }],
    };
    expect(parsePageWebhook(otherField).comments).toEqual([]);
  });
});

describe("parsePageWebhook: messages", () => {
  const base = { sender: { id: "psid_1" }, recipient: { id: PAGE }, timestamp: 1764000000123 };

  it("reads a text message", () => {
    const parsed = parsePageWebhook(messaging([{ ...base, message: { mid: "m_1", text: "salam" } }]));
    expect(parsed.messages).toEqual([
      {
        pageId: PAGE,
        psid: "psid_1",
        mid: "m_1",
        text: "salam",
        attachments: [],
        isSticker: false,
        sentAt: new Date(1764000000123),
      },
    ]);
  });

  it("reads an audio attachment with its URL", () => {
    const parsed = parsePageWebhook(
      messaging([
        {
          ...base,
          message: {
            mid: "m_2",
            attachments: [{ type: "audio", payload: { url: "https://cdn.fbsbx.com/v/audioclip.mp4" } }],
          },
        },
      ])
    );
    expect(parsed.messages[0]).toMatchObject({
      mid: "m_2",
      attachments: [{ type: "audio", url: "https://cdn.fbsbx.com/v/audioclip.mp4" }],
      isSticker: false,
    });
    expect(parsed.messages[0].text).toBeUndefined();
  });

  it("flags stickers and the like thumb", () => {
    const parsed = parsePageWebhook(
      messaging([
        {
          ...base,
          message: {
            mid: "m_3",
            sticker_id: 369239263222822,
            attachments: [{ type: "image", payload: { url: "https://x", sticker_id: 369239263222822 } }],
          },
        },
      ])
    );
    expect(parsed.messages[0].isSticker).toBe(true);
  });

  it("keeps reply_to", () => {
    const parsed = parsePageWebhook(
      messaging([{ ...base, message: { mid: "m_4", text: "oui", reply_to: { mid: "m_1" } } }])
    );
    expect(parsed.messages[0].replyToMid).toBe("m_1");
  });

  it("ignores reads, deliveries, postbacks and deleted or unsupported messages", () => {
    const parsed = parsePageWebhook(
      messaging([
        { ...base, read: { watermark: 1 } },
        { ...base, delivery: { mids: ["m_1"] } },
        { ...base, postback: { payload: "x" } },
        { ...base, message: { mid: "m_5", text: "x", is_deleted: true } },
        { ...base, message: { mid: "m_6", is_unsupported: true } },
        { ...base, message: { text: "no mid" } },
      ])
    );
    expect(parsed.messages).toEqual([]);
    expect(parsed.echoes).toEqual([]);
  });

  it("ignores a non-echo message sent by the Page itself", () => {
    const parsed = parsePageWebhook(
      messaging([{ sender: { id: PAGE }, recipient: { id: "psid_1" }, message: { mid: "m_7", text: "x" } }])
    );
    expect(parsed.messages).toEqual([]);
  });
});

describe("parsePageWebhook: echoes", () => {
  it("reads an echo with the person as recipient and the app id as a string", () => {
    const parsed = parsePageWebhook(
      messaging([
        {
          sender: { id: PAGE },
          recipient: { id: "psid_1" },
          timestamp: 1764000000999,
          message: {
            is_echo: true,
            app_id: 1517776481860111,
            metadata: "openreply:msg_1",
            mid: "m_echo",
            text: "مرحبا",
          },
        },
      ])
    );
    expect(parsed.messages).toEqual([]);
    expect(parsed.echoes).toEqual([
      {
        pageId: PAGE,
        psid: "psid_1",
        mid: "m_echo",
        appId: "1517776481860111",
        metadata: "openreply:msg_1",
        text: "مرحبا",
        attachments: [],
        sentAt: new Date(1764000000999),
      },
    ]);
  });

  it("reads an echo typed in Meta Business Suite, without metadata", () => {
    const parsed = parsePageWebhook(
      messaging([
        {
          sender: { id: PAGE },
          recipient: { id: "psid_2" },
          timestamp: 1,
          message: { is_echo: true, app_id: 263902037430900, mid: "m_human", text: "نرجعولك دابا" },
        },
      ])
    );
    expect(parsed.echoes[0]).toMatchObject({ psid: "psid_2", appId: "263902037430900", text: "نرجعولك دابا" });
    expect(parsed.echoes[0].metadata).toBeUndefined();
  });
});

describe("parsePageWebhook: robustness", () => {
  it("lists each Page once across entries", () => {
    const parsed = parsePageWebhook({
      object: "page",
      entry: [
        { id: "p1", changes: [{ field: "feed", value: comment({ post_id: "p1_1" }) }] },
        { id: "p2", messaging: [] },
        { id: "p1", messaging: [] },
      ],
    });
    expect(parsed.pageIds).toEqual(["p1", "p2"]);
    expect(parsed.comments).toHaveLength(1);
  });

  it.each([null, undefined, 42, "page", [], { object: "page" }, { object: "page", entry: "x" }])(
    "never throws on %s",
    (payload) => {
      expect(parsePageWebhook(payload)).toEqual({ pageIds: [], comments: [], messages: [], echoes: [] });
    }
  );

  it("skips malformed entries and keeps the good ones", () => {
    const parsed = parsePageWebhook({
      object: "page",
      entry: [
        "junk",
        { changes: [{ field: "feed", value: comment() }] },
        { id: PAGE, changes: [null, { field: "feed" }, { field: "feed", value: comment() }], messaging: [7] },
      ],
    });
    expect(parsed.comments).toHaveLength(1);
  });
});
