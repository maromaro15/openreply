import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FacebookApiError,
  classifyGraphError,
  debugToken,
  exchangeForLongLivedUserToken,
  getMessengerProfileName,
  getPagePosts,
  getUserPages,
  replyToComment,
  sendMessage,
  sendPrivateReply,
  splitMessageText,
  subscribePageWebhooks,
  unsubscribePageWebhooks,
} from "../../lib/facebook/graph";

const BASE = "https://graph.facebook.com/v25.0";
const PAGE_TOKEN = "EAAPageTokenSecret123";
const fetchMock = vi.fn();

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

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("FACEBOOK_GRAPH_API_VERSION", "");
  vi.stubEnv("META_GRAPH_API_VERSION", "v25.0");
  vi.stubEnv("FACEBOOK_APP_ID", "1517776481860111");
  vi.stubEnv("FACEBOOK_APP_SECRET", "app_secret_value");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("private replies", () => {
  it("sends a button template to the comment, with metadata and no messaging_type", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ recipient_id: "psid_1", message_id: "m_1" }));

    const result = await sendPrivateReply("PAGE_1", PAGE_TOKEN, {
      commentId: "444_555",
      text: "السعر والتفاصيل في الرابط 👇",
      buttons: [{ title: "اطلب الآن من الموقع الرسمي", url: "https://shop.example/p?utm_source=facebook" }],
      metadata: "openreply:c:log_1",
    });

    expect(result).toEqual({ recipient_id: "psid_1", message_id: "m_1" });
    const call = lastCall();
    expect(call.url.toString()).toBe(`${BASE}/PAGE_1/messages`);
    expect(call.method).toBe("POST");
    expect(call.headers.Authorization).toBe(`Bearer ${PAGE_TOKEN}`);
    expect(call.url.search).toBe(""); // the token never goes in the URL
    expect(call.body).toEqual({
      recipient: { comment_id: "444_555" },
      message: {
        attachment: {
          type: "template",
          payload: {
            template_type: "button",
            text: "السعر والتفاصيل في الرابط 👇",
            buttons: [
              {
                type: "web_url",
                url: "https://shop.example/p?utm_source=facebook",
                title: "اطلب الآن من الموقع الرسمي".slice(0, 20),
              },
            ],
          },
        },
        metadata: "openreply:c:log_1",
      },
    });
  });

  it("caps button template text at 640 characters without splitting an emoji", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ recipient_id: "p", message_id: "m" }));
    const text = `${"a".repeat(639)}😀tail`;
    await sendPrivateReply("PAGE_1", PAGE_TOKEN, {
      commentId: "c",
      text,
      buttons: [{ title: "Go", url: "https://x.test" }],
    });
    const sent = lastCall().body.message.attachment.payload.text as string;
    expect(Array.from(sent)).toHaveLength(640);
    expect(sent.endsWith("😀")).toBe(true);
  });

  it("sends plain text when there is no button", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ recipient_id: "p", message_id: "m" }));
    await sendPrivateReply("PAGE_1", PAGE_TOKEN, { commentId: "c", text: "Bonjour" });
    expect(lastCall().body.message).toEqual({ text: "Bonjour" });
  });
});

describe("Messenger messages", () => {
  it("sends a RESPONSE message to the person with metadata", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ recipient_id: "psid_1", message_id: "m_2" }));
    await sendMessage("PAGE_1", PAGE_TOKEN, { psid: "psid_1", text: "مرحبا", metadata: "openreply:msg_1" });
    expect(lastCall().body).toEqual({
      recipient: { id: "psid_1" },
      messaging_type: "RESPONSE",
      message: { text: "مرحبا", metadata: "openreply:msg_1" },
    });
  });

  it("uses the HUMAN_AGENT tag only when asked", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ recipient_id: "p", message_id: "m" }));
    await sendMessage("PAGE_1", PAGE_TOKEN, { psid: "p", text: "late reply", humanAgentTag: true });
    expect(lastCall().body).toMatchObject({ messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT" });
  });

  it("posts a public reply under a comment as the Page", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: "444_999" }));
    await expect(replyToComment("444_555", PAGE_TOKEN, "شوف الخاص 📩")).resolves.toEqual({ id: "444_999" });
    const call = lastCall();
    expect(call.url.toString()).toBe(`${BASE}/444_555/comments`);
    expect(call.body).toEqual({ message: "شوف الخاص 📩" });
  });
});

describe("Pages and tokens", () => {
  it("subscribes the app to feed, messages and message_echoes", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true }));
    await expect(
      subscribePageWebhooks("PAGE_1", PAGE_TOKEN, ["feed", "messages", "message_echoes"])
    ).resolves.toBe(true);
    const call = lastCall();
    expect(call.method).toBe("POST");
    expect(call.url.pathname).toBe("/v25.0/PAGE_1/subscribed_apps");
    expect(call.url.searchParams.get("subscribed_fields")).toBe("feed,messages,message_echoes");
  });

  it("unsubscribes with DELETE", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true }));
    await unsubscribePageWebhooks("PAGE_1", PAGE_TOKEN);
    expect(lastCall().method).toBe("DELETE");
  });

  it("inspects a token with the app token, never the token itself in a header", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ data: { is_valid: true, type: "PAGE", app_id: "1517776481860111", expires_at: 0 } })
    );
    await expect(debugToken(PAGE_TOKEN)).resolves.toMatchObject({ is_valid: true, type: "PAGE" });
    const call = lastCall();
    expect(call.url.pathname).toBe("/v25.0/debug_token");
    expect(call.url.searchParams.get("input_token")).toBe(PAGE_TOKEN);
    expect(call.headers.Authorization).toBe("Bearer 1517776481860111|app_secret_value");
  });

  it("exchanges a user token for a long-lived one", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ access_token: "long_lived", expires_in: 5183944 }));
    await expect(exchangeForLongLivedUserToken("short")).resolves.toEqual({
      accessToken: "long_lived",
      expiresIn: 5183944,
    });
    const params = lastCall().url.searchParams;
    expect(params.get("grant_type")).toBe("fb_exchange_token");
    expect(params.get("client_id")).toBe("1517776481860111");
    expect(params.get("fb_exchange_token")).toBe("short");
  });

  it("refuses to build an app token without the app id and secret", async () => {
    vi.stubEnv("FACEBOOK_APP_ID", "");
    vi.stubEnv("META_APP_ID", "");
    await expect(debugToken("x")).rejects.toBeInstanceOf(FacebookApiError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("follows paging when listing the user's Pages", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          data: [{ id: "p1", name: "One", access_token: "t1" }],
          paging: { cursors: { after: "c1" }, next: "https://graph.facebook.com/next" },
        })
      )
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "p2", name: "Two", access_token: "t2" }] }));
    const pages = await getUserPages("user_token");
    expect(pages.map((page) => page.id)).toEqual(["p1", "p2"]);
    expect(lastCall().url.searchParams.get("after")).toBe("c1");
  });

  it("lists recent posts with the fields the post picker needs", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: "PAGE_1_1", message: "Robe" }] }));
    await getPagePosts("PAGE_1", PAGE_TOKEN, 500);
    const params = lastCall().url.searchParams;
    expect(params.get("fields")).toContain("permalink_url");
    expect(params.get("limit")).toBe("100");
  });

  it("reads a profile name, and returns null when Meta withholds it", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ first_name: "Amina", last_name: "B." }));
    await expect(getMessengerProfileName("psid", PAGE_TOKEN)).resolves.toBe("Amina B.");
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { code: 230, message: "needs permission" } }, 400));
    await expect(getMessengerProfileName("psid", PAGE_TOKEN)).resolves.toBeNull();
  });
});

describe("errors", () => {
  it.each([
    [1, undefined, "An unknown error occurred", 500, "ambiguous"],
    [2, undefined, "Service temporarily unavailable", 503, "ambiguous"],
    [1200, undefined, "Temporary send message failure", 500, "ambiguous"],
    [4, undefined, "Application request limit reached", 400, "rate_limit"],
    [17, undefined, "User request limit reached", 400, "rate_limit"],
    [32, undefined, "Page request limit reached", 400, "rate_limit"],
    [368, undefined, "Temporarily blocked", 400, "rate_limit"],
    [613, undefined, "Calls to this api have exceeded the rate limit", 400, "rate_limit"],
    [80001, undefined, "Too many calls to this Page", 400, "rate_limit"],
    [80006, undefined, "Too many messenger calls", 400, "rate_limit"],
    [190, 460, "Error validating access token", 400, "token_invalid"],
    [10900, undefined, "Activity already replied to", 400, "already_replied"],
    [10903, undefined, "This user cant reply to this activity", 400, "not_eligible"],
    [551, 1545041, "This person isn't available right now", 400, "not_eligible"],
    [100, 2018001, "No matching user found", 400, "not_eligible"],
    [10, 2018278, "This message is sent outside of allowed window", 400, "outside_window"],
    [10, undefined, "Application does not have permission", 400, "permission"],
    [200, undefined, "Requires pages_messaging permission", 403, "permission"],
    [100, undefined, "Invalid button template payload", 400, "template_rejected"],
    [100, undefined, "Invalid parameter", 400, "invalid_request"],
    [undefined, undefined, "Bad Gateway", 502, "ambiguous"],
    [undefined, undefined, "Not Found", 404, "invalid_request"],
  ])("code %s / sub %s → %s", (code, subcode, message, status, kind) => {
    expect(classifyGraphError(code, subcode, message, status)).toBe(kind);
  });

  it("throws a classified error that carries the path but not the token", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { error: { message: "Activity already replied to", code: 10900, type: "OAuthException", fbtrace_id: "T1" } },
        400
      )
    );
    const error = await sendPrivateReply("PAGE_1", PAGE_TOKEN, { commentId: "c", text: "x" }).catch((e) => e);
    expect(error).toBeInstanceOf(FacebookApiError);
    expect(error).toMatchObject({ kind: "already_replied", code: 10900, httpStatus: 400, fbTraceId: "T1" });
    expect(error.isConfirmedRejection).toBe(true);
    expect(error.message).toContain("/v25.0/PAGE_1/messages");
    expect(error.message).not.toContain(PAGE_TOKEN);
  });

  it("keeps the input token out of the message of a failed debug_token call", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: "Invalid OAuth", code: 190 } }, 400));
    const error = await debugToken(PAGE_TOKEN).catch((e) => e);
    expect(error.kind).toBe("token_invalid");
    expect(error.message).not.toContain(PAGE_TOKEN);
    expect(error.message).not.toContain("app_secret_value");
  });

  it("treats a network failure as ambiguous: a send may have gone through", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const error = await sendMessage("PAGE_1", PAGE_TOKEN, { psid: "p", text: "x" }).catch((e) => e);
    expect(error).toMatchObject({ kind: "ambiguous" });
    expect(error.isConfirmedRejection).toBe(false);
  });

  it.each(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "UND_ERR_CONNECT_TIMEOUT"])(
    "knows a request that failed with %s never left: safe to retry",
    async (code) => {
      fetchMock.mockRejectedValue(Object.assign(new TypeError("fetch failed"), { cause: { code } }));
      const error = await sendMessage("PAGE_1", PAGE_TOKEN, { psid: "p", text: "x" }).catch((e) => e);
      expect(error).toMatchObject({ kind: "unreachable" });
      expect(error.isConfirmedRejection).toBe(true);
      expect(error.message).toContain(code);
    }
  );

  it.each(["ECONNRESET", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET"])(
    "keeps a request that failed with %s ambiguous: it may have reached Meta",
    async (code) => {
      fetchMock.mockRejectedValue(Object.assign(new TypeError("fetch failed"), { cause: { code } }));
      await expect(sendMessage("PAGE_1", PAGE_TOKEN, { psid: "p", text: "x" })).rejects.toMatchObject({
        kind: "ambiguous",
      });
    }
  );

  it("keeps our own timeout ambiguous", async () => {
    fetchMock.mockRejectedValue(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    await expect(sendMessage("PAGE_1", PAGE_TOKEN, { psid: "p", text: "x" })).rejects.toMatchObject({
      kind: "ambiguous",
    });
  });

  it("treats a 2xx without JSON as ambiguous", async () => {
    fetchMock.mockResolvedValue(new Response("<html>ok</html>", { status: 200 }));
    await expect(sendMessage("PAGE_1", PAGE_TOKEN, { psid: "p", text: "x" })).rejects.toMatchObject({
      kind: "ambiguous",
    });
  });

  it("uses FACEBOOK_GRAPH_API_VERSION over META_GRAPH_API_VERSION", async () => {
    vi.stubEnv("FACEBOOK_GRAPH_API_VERSION", "v26.0");
    fetchMock.mockResolvedValue(jsonResponse({ id: "1" }));
    await replyToComment("c", PAGE_TOKEN, "x");
    expect(lastCall().url.pathname.startsWith("/v26.0/")).toBe(true);
  });
});

describe("splitMessageText", () => {
  it("keeps short text whole", () => {
    expect(splitMessageText("  مرحبا  ")).toEqual(["مرحبا"]);
  });

  it("splits long text on word boundaries under the limit", () => {
    const words = Array.from({ length: 300 }, (_, i) => `كلمة${i}`);
    const parts = splitMessageText(words.join(" "), 200);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(Array.from(part).length).toBeLessThanOrEqual(200);
    expect(parts.join(" ").split(" ")).toEqual(words);
  });

  it("cuts a single overlong word rather than looping", () => {
    const parts = splitMessageText("x".repeat(450), 200);
    expect(parts.map((part) => part.length)).toEqual([200, 200, 50]);
  });
});
