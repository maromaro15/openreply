import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_TEMPLATE_ELEMENTS,
  TEMPLATE_LIMITS,
  buildGenericTemplates,
  buildImageAttachment,
  sendTemplateMessage,
  type TemplateCard,
} from "../../lib/facebook/templates-send";
import { FacebookApiError } from "../../lib/facebook/graph";

const BASE = "https://graph.facebook.com/v25.0";
const PAGE_TOKEN = "EAAPageTokenSecret123";
const fetchMock = vi.fn();
const fetchImpl = fetchMock as unknown as typeof fetch;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function lastCall() {
  const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string, RequestInit];
  return {
    url: new URL(url),
    method: init.method,
    headers: init.headers as Record<string, string>,
    body: init.body ? JSON.parse(init.body as string) : undefined,
  };
}

function card(overrides: Partial<TemplateCard> = {}): TemplateCard {
  return {
    title: "Couleur 12",
    subtitle: "Bleu nuit",
    imageUrl: "https://cdn.example.com/p/12.jpg",
    buttons: [{ type: "postback", title: "نحب هذا", payload: "like:p1:12" }],
    ...overrides,
  };
}

function elementsOf(message: ReturnType<typeof buildGenericTemplates>[number]) {
  return message.attachment.payload.elements as Record<string, unknown>[];
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubEnv("FACEBOOK_GRAPH_API_VERSION", "");
  vi.stubEnv("META_GRAPH_API_VERSION", "v25.0");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("buildGenericTemplates", () => {
  it("builds the exact Send API payload for a colour card", () => {
    expect(buildGenericTemplates([card()])).toEqual([
      {
        attachment: {
          type: "template",
          payload: {
            template_type: "generic",
            image_aspect_ratio: "square",
            elements: [
              {
                title: "Couleur 12",
                subtitle: "Bleu nuit",
                image_url: "https://cdn.example.com/p/12.jpg",
                buttons: [{ type: "postback", title: "نحب هذا", payload: "like:p1:12" }],
              },
            ],
          },
        },
      },
    ]);
  });

  it("builds a comparison card with a like button and a details link", () => {
    const [message] = buildGenericTemplates([
      card({
        title: "Papier peint Floral",
        subtitle: "2 900 DA · 10 m · lavable",
        buttons: [
          { type: "postback", title: "نحب هذا", payload: "like:p9" },
          { type: "web_url", title: "التفاصيل", url: "https://shop.example/p/9?utm_source=facebook" },
        ],
      }),
    ]);
    expect(elementsOf(message)[0].buttons).toEqual([
      { type: "postback", title: "نحب هذا", payload: "like:p9" },
      { type: "web_url", title: "التفاصيل", url: "https://shop.example/p/9?utm_source=facebook" },
    ]);
  });

  it("returns nothing for no cards", () => {
    expect(buildGenericTemplates([])).toEqual([]);
  });

  it.each([
    [10, [10]],
    [11, [10, 1]],
    [20, [10, 10]],
    [21, [10, 10, 1]],
  ])("splits %i cards into messages of %j", (count, sizes) => {
    const cards = Array.from({ length: count }, (_, i) => card({ title: `Couleur ${i}` }));
    const messages = buildGenericTemplates(cards);
    expect(messages.map((message) => elementsOf(message).length)).toEqual(sizes);
    expect(MAX_TEMPLATE_ELEMENTS).toBe(10);
    // Order is kept across messages.
    expect(messages.flatMap((message) => elementsOf(message).map((element) => element.title))).toEqual(
      cards.map((c) => c.title)
    );
  });

  it("chunks after dropping bad cards, so no message is half empty", () => {
    const cards = Array.from({ length: 12 }, (_, i) =>
      card({ title: `C${i}`, imageUrl: i % 6 === 0 ? "" : "https://cdn.example.com/x.jpg" })
    );
    // Cards 0 and 6 are dropped, 10 remain.
    expect(buildGenericTemplates(cards).map((message) => elementsOf(message).length)).toEqual([10]);
  });

  it("puts a title on one line and cuts it to 80 characters with an ellipsis", () => {
    const [message] = buildGenericTemplates([card({ title: `  Papier\npeint\t\tfloral ${"x".repeat(200)}` })]);
    const title = elementsOf(message)[0].title as string;
    expect(title.startsWith("Papier peint floral xxx")).toBe(true);
    expect(title).not.toMatch(/[\n\t]/);
    expect(Array.from(title)).toHaveLength(TEMPLATE_LIMITS.title);
    expect(title.endsWith("…")).toBe(true);
  });

  it("never cuts an emoji in half", () => {
    const [message] = buildGenericTemplates([card({ title: `${"a".repeat(76)}👨‍👩‍👧tail` })]);
    const title = elementsOf(message)[0].title as string;
    // The family emoji is one grapheme of 5 code points: it does not fit, so it goes whole.
    expect(title).toBe(`${"a".repeat(76)}…`);
    expect(title).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  it("keeps a whole emoji when it fits", () => {
    const [message] = buildGenericTemplates([card({ title: `${"a".repeat(70)}😀${"b".repeat(20)}` })]);
    const title = elementsOf(message)[0].title as string;
    expect(title).toBe(`${"a".repeat(70)}😀${"b".repeat(8)}…`);
    expect(Array.from(title)).toHaveLength(80);
  });

  it("never separates an Arabic letter from its harakat", () => {
    const word = "كَتَبَ"; // three letters with fatha each: 6 code points, 3 graphemes
    const [message] = buildGenericTemplates([card({ title: word.repeat(20) })]);
    const title = elementsOf(message)[0].title as string;
    expect(Array.from(title).length).toBeLessThanOrEqual(80);
    expect(title.endsWith("…")).toBe(true);
    const body = title.slice(0, -1);
    // Only complete letter+fatha pairs remain: no dangling mark, no bare letter at the end.
    expect(body).toMatch(/^(?:\p{L}َ)+$/u);
  });

  it("cuts the subtitle the same way and omits an empty one", () => {
    const [message] = buildGenericTemplates([
      card({ subtitle: `2 900 DA\n${"z".repeat(120)}` }),
      card({ title: "B", subtitle: "   \n\t " }),
      card({ title: "C", subtitle: null }),
      card({ title: "D", subtitle: undefined }),
    ]);
    const [first, second, third, fourth] = elementsOf(message);
    expect(first.subtitle as string).toMatch(/^2 900 DA z+…$/);
    expect(Array.from(first.subtitle as string)).toHaveLength(TEMPLATE_LIMITS.subtitle);
    for (const element of [second, third, fourth]) expect("subtitle" in element).toBe(false);
  });

  it("strips bidi overrides and control characters from texts", () => {
    const [message] = buildGenericTemplates([
      card({ title: "Rose‮evil\u0000\u0007 nude", subtitle: "a⁦b\r\nc" }),
    ]);
    const element = elementsOf(message)[0];
    expect(element.title).toBe("Roseevil nude");
    expect(element.subtitle).toBe("ab c");
  });

  it("drops a card with no title", () => {
    expect(buildGenericTemplates([card({ title: "" }), card({ title: " \n " })])).toEqual([]);
  });

  it.each([
    ["http image", "http://cdn.example.com/a.jpg"],
    ["empty", ""],
    ["not a URL", "a.jpg"],
    ["javascript scheme", "javascript:alert(1)"],
    ["data scheme", "data:image/png;base64,AAAA"],
    ["credentials in the URL", "https://user:pass@cdn.example.com/a.jpg"],
    ["whitespace inside", "https://cdn.example.com/a b.jpg"],
    ["too long", `https://cdn.example.com/${"a".repeat(2000)}.jpg`],
  ])("drops a card whose image is %s", (_label, imageUrl) => {
    expect(buildGenericTemplates([card({ imageUrl })])).toEqual([]);
  });

  it("keeps the other cards when one is dropped", () => {
    const messages = buildGenericTemplates([card({ title: "A" }), card({ imageUrl: "" }), card({ title: "C" })]);
    expect(elementsOf(messages[0]).map((element) => element.title)).toEqual(["A", "C"]);
  });

  it("drops a web_url button for anything but http(s), keeping the card", () => {
    const [message] = buildGenericTemplates([
      card({
        buttons: [
          { type: "web_url", title: "JS", url: "javascript:alert(1)" },
          { type: "web_url", title: "Tel", url: "tel:+213555" },
          { type: "web_url", title: "Rel", url: "/p/12" },
          { type: "web_url", title: "Cred", url: "https://a:b@shop.example/p" },
          { type: "web_url", title: "OK", url: "https://shop.example/p/12" },
        ],
      }),
    ]);
    expect(elementsOf(message)[0].buttons).toEqual([
      { type: "web_url", title: "OK", url: "https://shop.example/p/12" },
    ]);
  });

  it("allows a plain http landing page on a button (documented choice)", () => {
    const [message] = buildGenericTemplates([
      card({ buttons: [{ type: "web_url", title: "التفاصيل", url: "http://shop.example/p/12" }] }),
    ]);
    expect(elementsOf(message)[0].buttons).toEqual([
      { type: "web_url", title: "التفاصيل", url: "http://shop.example/p/12" },
    ]);
  });

  it("omits the buttons field when none survive", () => {
    const [message] = buildGenericTemplates([
      card({ buttons: [{ type: "web_url", title: "x", url: "ftp://shop.example/p" }] }),
      card({ title: "B", buttons: [] }),
    ]);
    for (const element of elementsOf(message)) expect("buttons" in element).toBe(false);
  });

  it("cuts a button title to 20 characters on a grapheme", () => {
    const [message] = buildGenericTemplates([
      card({ buttons: [{ type: "postback", title: `${"a".repeat(18)}🇩🇿🇩🇿`, payload: "p" }] }),
    ]);
    const buttons = elementsOf(message)[0].buttons as { title: string }[];
    // The first flag is 2 code points: 18 + 2 + the ellipsis is 21, so the flags go.
    expect(buttons[0].title).toBe(`${"a".repeat(18)}…`);
    expect(Array.from(buttons[0].title).length).toBeLessThanOrEqual(TEMPLATE_LIMITS.buttonTitle);
  });

  it("drops a button with an empty title", () => {
    const [message] = buildGenericTemplates([
      card({
        buttons: [
          { type: "postback", title: "  ", payload: "p" },
          { type: "postback", title: "نحب هذا", payload: "p2" },
        ],
      }),
    ]);
    expect(elementsOf(message)[0].buttons).toEqual([{ type: "postback", title: "نحب هذا", payload: "p2" }]);
  });

  it("keeps a payload of exactly 1000 characters and drops a longer or empty one", () => {
    const [message] = buildGenericTemplates([
      card({
        buttons: [
          { type: "postback", title: "ok", payload: "p".repeat(1000) },
          { type: "postback", title: "too long", payload: "p".repeat(1001) },
          { type: "postback", title: "empty", payload: "" },
        ],
      }),
    ]);
    const buttons = elementsOf(message)[0].buttons as { title: string; payload: string }[];
    expect(buttons.map((button) => button.title)).toEqual(["ok"]);
    expect(buttons[0].payload).toHaveLength(TEMPLATE_LIMITS.payload);
  });

  it("keeps at most 3 buttons, in order", () => {
    const [message] = buildGenericTemplates([
      card({
        buttons: Array.from({ length: 5 }, (_, i) => ({
          type: "postback" as const,
          title: `B${i}`,
          payload: `p${i}`,
        })),
      }),
    ]);
    expect((elementsOf(message)[0].buttons as { title: string }[]).map((button) => button.title)).toEqual([
      "B0",
      "B1",
      "B2",
    ]);
  });

  it("survives malformed input from an untrusted source", () => {
    const bad = [
      null,
      undefined,
      { title: 5, imageUrl: "https://cdn.example.com/a.jpg", buttons: [] },
      { title: "ok", imageUrl: 7, buttons: [] },
      { title: "fine", imageUrl: "https://cdn.example.com/a.jpg", buttons: "nope" },
      {
        title: "fine2",
        imageUrl: "https://cdn.example.com/a.jpg",
        buttons: [null, { type: "other", title: "x" }, { type: "postback", title: "ok", payload: 9 }],
      },
    ] as unknown as TemplateCard[];
    const messages = buildGenericTemplates(bad);
    expect(elementsOf(messages[0]).map((element) => element.title)).toEqual(["fine", "fine2"]);
    for (const element of elementsOf(messages[0])) expect("buttons" in element).toBe(false);
  });
});

describe("buildImageAttachment", () => {
  it("builds a reusable image attachment", () => {
    expect(buildImageAttachment("https://cdn.example.com/p/12.jpg")).toEqual({
      attachment: { type: "image", payload: { url: "https://cdn.example.com/p/12.jpg", is_reusable: true } },
    });
  });

  it.each(["http://cdn.example.com/a.jpg", "", "javascript:alert(1)", "https://u:p@cdn.example.com/a.jpg"])(
    "refuses %j instead of building a request that cannot work",
    (url) => {
      expect(() => buildImageAttachment(url)).toThrow(TypeError);
    }
  );
});

describe("sendTemplateMessage", () => {
  const [template] = buildGenericTemplates([card()]);

  const send = (extra: Partial<Parameters<typeof sendTemplateMessage>[2]> = {}) =>
    sendTemplateMessage("PAGE_1", PAGE_TOKEN, { psid: "p", message: template, fetchImpl, ...extra });

  it("posts a RESPONSE message to the person with the token in the header", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ recipient_id: "psid_1", message_id: "m_1" }));

    await expect(send({ psid: "psid_1" })).resolves.toEqual({ messageId: "m_1" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = lastCall();
    expect(call.url.toString()).toBe(`${BASE}/PAGE_1/messages`);
    expect(call.method).toBe("POST");
    expect(call.headers).toEqual({ Authorization: `Bearer ${PAGE_TOKEN}`, "Content-Type": "application/json" });
    expect(call.url.search).toBe(""); // the token never goes in the URL
    expect(call.body).toEqual({
      recipient: { id: "psid_1" },
      messaging_type: "RESPONSE",
      message: template,
    });
    expect("tag" in call.body).toBe(false);
  });

  it("sends an image attachment the same way", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ recipient_id: "p", message_id: "m_img" }));
    const image = buildImageAttachment("https://cdn.example.com/p/12.jpg");
    await expect(send({ message: image })).resolves.toEqual({ messageId: "m_img" });
    expect(lastCall().body.message).toEqual(image);
  });

  it("adds the metadata marker inside the message, cut to 1000 characters", async () => {
    // A fresh Response per call: a body can be read once.
    fetchMock.mockImplementation(async () => jsonResponse({ recipient_id: "p", message_id: "m" }));
    await send({ metadata: "openreply:t:msg_1" });
    expect(lastCall().body.message).toEqual({ ...template, metadata: "openreply:t:msg_1" });

    await send({ metadata: `${"m".repeat(999)}😀tail` });
    const sent = lastCall().body.message.metadata as string;
    expect(Array.from(sent)).toHaveLength(1000);
    expect(sent.endsWith("😀")).toBe(true);
  });

  it("does not mutate the message it was given", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ recipient_id: "p", message_id: "m" }));
    const before = JSON.stringify(template);
    await send({ metadata: "x" });
    expect(JSON.stringify(template)).toBe(before);
  });

  it("uses the HUMAN_AGENT tag only when asked", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ recipient_id: "p", message_id: "m" }));
    await send({ humanAgentTag: true });
    expect(lastCall().body).toMatchObject({ messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT" });
  });

  it("uses the Graph version from the environment", async () => {
    vi.stubEnv("FACEBOOK_GRAPH_API_VERSION", "v26.0");
    fetchMock.mockResolvedValue(jsonResponse({ recipient_id: "p", message_id: "m" }));
    await send();
    expect(lastCall().url.pathname).toBe("/v26.0/PAGE_1/messages");
  });

  it("falls back to the global fetch", async () => {
    vi.stubGlobal("fetch", fetchMock);
    try {
      fetchMock.mockResolvedValue(jsonResponse({ recipient_id: "p", message_id: "m_g" }));
      await expect(send({ fetchImpl: undefined })).resolves.toEqual({ messageId: "m_g" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refuses an empty recipient without calling Meta", async () => {
    await expect(send({ psid: "" })).rejects.toMatchObject({ kind: "invalid_request" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe("errors", () => {
    it("classifies an invalid token and keeps the token out of the message", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(
          {
            error: {
              message: "Error validating access token",
              code: 190,
              error_subcode: 460,
              type: "OAuthException",
              fbtrace_id: "T1",
            },
          },
          400
        )
      );
      const error = await send().catch((e) => e);
      expect(error).toBeInstanceOf(FacebookApiError);
      expect(error).toMatchObject({ kind: "token_invalid", code: 190, subcode: 460, httpStatus: 400, fbTraceId: "T1" });
      expect(error.isConfirmedRejection).toBe(true);
      expect(error.message).toContain("/v25.0/PAGE_1/messages");
      expect(error.message).not.toContain(PAGE_TOKEN);
    });

    it("classifies a rate limit", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ error: { message: "Too many messenger calls", code: 80006 } }, 400));
      await expect(send()).rejects.toMatchObject({ kind: "rate_limit", code: 80006 });
    });

    it("classifies a closed 24-hour window", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(
          { error: { message: "This message is sent outside of allowed window", code: 10, error_subcode: 2018278 } },
          400
        )
      );
      await expect(send()).rejects.toMatchObject({ kind: "outside_window" });
    });

    it("classifies a refused template, so the caller can fall back to images", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ error: { message: "Invalid template payload", code: 100 } }, 400));
      await expect(send()).rejects.toMatchObject({ kind: "template_rejected" });
    });

    it("treats a Graph 5xx as ambiguous: it may have been delivered", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ error: { message: "Temporary send message failure", code: 1200 } }, 500)
      );
      const error = await send().catch((e) => e);
      expect(error).toMatchObject({ kind: "ambiguous" });
      expect(error.isConfirmedRejection).toBe(false);
    });

    it("treats a dropped connection as ambiguous", async () => {
      fetchMock.mockRejectedValue(new TypeError("fetch failed"));
      const error = await send().catch((e) => e);
      expect(error).toMatchObject({ kind: "ambiguous" });
      expect(error.isConfirmedRejection).toBe(false);
    });

    it("treats our own timeout as ambiguous", async () => {
      fetchMock.mockRejectedValue(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
      await expect(send()).rejects.toMatchObject({ kind: "ambiguous" });
    });

    it.each(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "UND_ERR_CONNECT_TIMEOUT"])(
      "knows a request that failed with %s never left: unreachable",
      async (code) => {
        fetchMock.mockRejectedValue(Object.assign(new TypeError("fetch failed"), { cause: { code } }));
        const error = await send().catch((e) => e);
        expect(error).toMatchObject({ kind: "unreachable" });
        expect(error.isConfirmedRejection).toBe(true);
        expect(error.message).toContain(code);
        expect(error.message).not.toContain(PAGE_TOKEN);
      }
    );

    it.each(["ECONNRESET", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET"])(
      "keeps a request that failed with %s ambiguous: it may have reached Meta",
      async (code) => {
        fetchMock.mockRejectedValue(Object.assign(new TypeError("fetch failed"), { cause: { code } }));
        await expect(send()).rejects.toMatchObject({ kind: "ambiguous" });
      }
    );

    it("treats a 2xx without JSON as ambiguous", async () => {
      fetchMock.mockResolvedValue(new Response("<html>ok</html>", { status: 200 }));
      await expect(send()).rejects.toMatchObject({ kind: "ambiguous" });
    });

    it("treats a 2xx without a message id as ambiguous", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ recipient_id: "p" }));
      await expect(send()).rejects.toMatchObject({ kind: "ambiguous" });
    });
  });
});
