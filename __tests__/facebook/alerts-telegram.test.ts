import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TELEGRAM_API_BASE,
  TelegramError,
  chatsFromUpdates,
  classifyTelegramError,
  escapeTelegramHtml,
  isTelegramButtonUrl,
  isTelegramToken,
  telegramDownloadFile,
  telegramGetFile,
  telegramGetMe,
  telegramGetUpdates,
  telegramSendMessage,
  type TelegramErrorKind,
  type TelegramUpdate,
} from "../../lib/alerts/telegram";

// Made up, in BotFather's format.
const TOKEN = "7012345678:TEST-token-for-the-telegram-client-x";
const SECRET = TOKEN.slice(TOKEN.indexOf(":") + 1);
const GROUP_ID = "-1001234567890";

const fetchMock = vi.fn();
const options = { fetchImpl: fetchMock as unknown as typeof fetch };

function telegramOk(result: unknown) {
  return new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function telegramFail(status: number, description: string, parameters?: Record<string, unknown>) {
  return new Response(JSON.stringify({ ok: false, error_code: status, description, ...(parameters ? { parameters } : {}) }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A fresh Response for every call: a body can only be read once. */
function answerWith(make: () => Response) {
  fetchMock.mockImplementation(async () => make());
}

/** Answers after delayMs, unless the request's signal fires first. */
function slowAnswer(delayMs: number, make: () => Response) {
  return (_url: string, init: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(make()), delayMs);
      init.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(init.signal?.reason);
      });
    });
}

function lastCall() {
  const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string, RequestInit];
  return { url, init, body: typeof init.body === "string" ? JSON.parse(init.body) : undefined };
}

async function failureOf(promise: Promise<unknown>): Promise<TelegramError> {
  const error = await promise.then(
    () => {
      throw new Error("expected a TelegramError");
    },
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(TelegramError);
  return error as TelegramError;
}

const sendTo = (chatId = GROUP_ID) => telegramSendMessage(TOKEN, { chatId, html: "<b>Amina</b> needs a human" }, options);

beforeEach(() => {
  fetchMock.mockReset();
  // No test may reach the real Telegram.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("the real fetch was called");
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("tokens", () => {
  it.each([
    TOKEN,
    "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11", // the example in Telegram's docs
    "1:abcdefghijklmnopqrstuvwxyz_-0123",
  ])("accepts %s", (value) => {
    expect(isTelegramToken(value)).toBe(true);
  });

  it.each([
    "",
    "123456",
    "123456:",
    "123456:too-short",
    ":ABC-DEF1234ghIkl-zyx57W2v1u123ew11",
    "12a456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11",
    "bot123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11",
    " 123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11",
    "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11\n",
    "123456:ABC DEF1234ghIkl zyx57W2v1u123ew11xx",
    "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew1!",
    "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11/getMe",
  ])("refuses %j", (value) => {
    expect(isTelegramToken(value)).toBe(false);
  });

  it("never sends a malformed token, nor echoes it", async () => {
    const error = await failureOf(telegramGetMe(`${TOKEN} `, options));
    expect(error.kind).toBe("invalid_token");
    expect(error.message).not.toContain(SECRET);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("escapeTelegramHtml", () => {
  it("escapes what HTML mode reads as markup", () => {
    expect(escapeTelegramHtml('<a href="https://evil.example">Tom & Jerry</a>')).toBe(
      "&lt;a href=&quot;https://evil.example&quot;&gt;Tom &amp; Jerry&lt;/a&gt;"
    );
  });

  it("escapes & first, so a typed entity stays text", () => {
    expect(escapeTelegramHtml("&lt;b&gt;")).toBe("&amp;lt;b&amp;gt;");
  });

  it("leaves everything else as it is", () => {
    const text = "شحال السعر؟ 2500 دج 👍 l'été";
    expect(escapeTelegramHtml(text)).toBe(text);
  });
});

describe("telegramSendMessage", () => {
  it("posts HTML without link previews, the button as an inline keyboard, and the token only in the path", async () => {
    answerWith(() => telegramOk({ message_id: 42, chat: { id: Number(GROUP_ID), type: "supergroup" }, date: 1 }));
    const url = "https://app.example.com/facebook/inbox?workspace=w1&conversation=c1";

    const result = await telegramSendMessage(
      TOKEN,
      { chatId: GROUP_ID, html: "<b>Amina</b> needs a human", button: { text: "فتح المحادثة", url } },
      options
    );

    expect(result).toEqual({ messageId: 42 });
    const call = lastCall();
    expect(call.url).toBe(`${TELEGRAM_API_BASE}/bot${TOKEN}/sendMessage`);
    expect(call.init.method).toBe("POST");
    expect(call.init.headers).toEqual({ "Content-Type": "application/json" });
    expect(call.init.cache).toBe("no-store");
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
    expect(call.init.body).not.toContain(SECRET);
    expect(call.body).toEqual({
      chat_id: GROUP_ID,
      text: "<b>Amina</b> needs a human",
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: [[{ text: "فتح المحادثة", url }]] },
    });
  });

  it.each([
    { case: "an http link", button: { text: "Open", url: "http://app.example.com/facebook/inbox" } },
    { case: "localhost", button: { text: "Open", url: "https://localhost:3000/facebook/inbox" } },
    { case: "127.0.0.1", button: { text: "Open", url: "https://127.0.0.1:3000/facebook/inbox" } },
    { case: "::1", button: { text: "Open", url: "https://[::1]:3000/facebook/inbox" } },
    { case: "a .local host", button: { text: "Open", url: "https://openreply.local/facebook/inbox" } },
    { case: "a relative link", button: { text: "Open", url: "/facebook/inbox?conversation=c1" } },
    { case: "a blank label", button: { text: "  ", url: "https://app.example.com/facebook/inbox" } },
    { case: "no button", button: null },
  ])("leaves the button out for $case", async ({ button }) => {
    answerWith(() => telegramOk({ message_id: 7 }));
    await telegramSendMessage(TOKEN, { chatId: GROUP_ID, html: "alert", button }, options);
    expect(lastCall().body).toEqual({
      chat_id: GROUP_ID,
      text: "alert",
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  });

  it("trims a pasted chat ID", async () => {
    answerWith(() => telegramOk({ message_id: 7 }));
    await sendTo(` ${GROUP_ID} `);
    expect(lastCall().body.chat_id).toBe(GROUP_ID);
  });

  it("uses the global fetch when none is given", async () => {
    const globalFetch = vi.fn(async () => telegramOk({ message_id: 8 }));
    vi.stubGlobal("fetch", globalFetch);
    await expect(telegramSendMessage(TOKEN, { chatId: GROUP_ID, html: "alert" })).resolves.toEqual({ messageId: 8 });
    expect(globalFetch).toHaveBeenCalledTimes(1);
  });
});

describe("isTelegramButtonUrl", () => {
  it.each([
    ["https://app.example.com/facebook/inbox?conversation=c1", true],
    ["https://127.example.com/inbox", true],
    ["http://app.example.com/inbox", false],
    ["https://localhost:3000/inbox", false],
    ["https://localhost./inbox", false],
    ["https://app.localhost/inbox", false],
    ["https://127.0.0.1:3000/inbox", false],
    ["https://127.1/inbox", false],
    ["https://[::1]:3000/inbox", false],
    ["https://0.0.0.0/inbox", false],
    ["https://openreply.local/inbox", false],
    ["https://openreply/inbox", false],
    ["javascript:alert(1)", false],
    ["/facebook/inbox", false],
  ])("%s → %s", (url, expected) => {
    expect(isTelegramButtonUrl(url)).toBe(expected);
  });
});

describe("telegramGetMe", () => {
  it("returns the bot's ID, username and name", async () => {
    answerWith(() =>
      telegramOk({ id: 7012345678, is_bot: true, first_name: "OpenReply Alerts", username: "openreply_alerts_bot" })
    );
    await expect(telegramGetMe(TOKEN, options)).resolves.toEqual({
      id: 7012345678,
      username: "openreply_alerts_bot",
      firstName: "OpenReply Alerts",
    });
    const call = lastCall();
    expect(call.url).toBe(`${TELEGRAM_API_BASE}/bot${TOKEN}/getMe`);
    expect(call.init.method).toBe("POST");
    expect(call.body).toEqual({});
  });

  it("calls a revoked or unknown token invalid_token", async () => {
    answerWith(() => telegramFail(401, "Unauthorized"));
    const error = await failureOf(telegramGetMe(TOKEN, options));
    expect(error).toMatchObject({ kind: "invalid_token", httpStatus: 401 });
    expect(error.retryable).toBe(false);
  });
});

describe("errors", () => {
  it.each([
    {
      case: "a person who blocked the bot",
      answer: () => telegramFail(403, "Forbidden: bot was blocked by the user"),
      kind: "forbidden",
      httpStatus: 403,
    },
    {
      case: "a group that removed the bot",
      answer: () => telegramFail(403, "Forbidden: bot was kicked from the group chat"),
      kind: "forbidden",
      httpStatus: 403,
    },
    {
      case: "a wrong chat ID",
      answer: () => telegramFail(400, "Bad Request: chat not found"),
      kind: "chat_not_found",
      httpStatus: 400,
    },
    {
      case: "broken HTML",
      answer: () => telegramFail(400, 'Bad Request: can\'t parse entities: Unsupported start tag "x" at byte offset 4'),
      kind: "bad_request",
      httpStatus: 400,
    },
    {
      case: "a refused button",
      answer: () => telegramFail(400, "Bad Request: BUTTON_URL_INVALID"),
      kind: "bad_request",
      httpStatus: 400,
    },
    {
      case: "a 500",
      answer: () => telegramFail(500, "Internal Server Error"),
      kind: "unavailable",
      httpStatus: 500,
    },
    {
      case: "a proxy's 502 page",
      answer: () => new Response("<html>502 Bad Gateway</html>", { status: 502 }),
      kind: "unavailable",
      httpStatus: 502,
    },
    {
      case: "a 200 that is not Telegram's JSON",
      answer: () => new Response("<html>Wi-Fi login</html>", { status: 200 }),
      kind: "unavailable",
      httpStatus: 200,
    },
    {
      case: "a 200 with ok:false",
      answer: () =>
        new Response(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: chat not found" }), {
          status: 200,
        }),
      kind: "chat_not_found",
      httpStatus: 400,
    },
  ])("sorts $case as $kind", async ({ answer, kind, httpStatus }) => {
    answerWith(answer);
    const error = await failureOf(sendTo());
    expect(error).toMatchObject({ kind, httpStatus, retryAfterSeconds: undefined });
  });

  it("keeps Telegram's description in the message", async () => {
    answerWith(() => telegramFail(400, "Bad Request: chat not found"));
    expect((await failureOf(sendTo())).message).toBe("Telegram sendMessage failed (400): Bad Request: chat not found");
  });

  it("names the new ID of a group that became a supergroup", async () => {
    answerWith(() =>
      telegramFail(400, "Bad Request: group chat was upgraded to a supergroup chat", {
        migrate_to_chat_id: -1001987654321,
      })
    );
    const error = await failureOf(sendTo("-4012345678"));
    expect(error.kind).toBe("bad_request");
    expect(error.message).toContain("the group is now chat -1001987654321");
  });

  it("reads retry_after from a 429", async () => {
    answerWith(() => telegramFail(429, "Too Many Requests: retry after 35", { retry_after: 35 }));
    const error = await failureOf(sendTo());
    expect(error).toMatchObject({ kind: "rate_limited", httpStatus: 429, retryAfterSeconds: 35 });
    expect(error.retryable).toBe(true);
  });

  it("falls back on the description when a 429 has no parameters", async () => {
    answerWith(() => telegramFail(429, "Too Many Requests: retry after 12"));
    expect((await failureOf(sendTo())).retryAfterSeconds).toBe(12);
  });

  it("calls a fetch that threw before any answer a network error", async () => {
    fetchMock.mockRejectedValue(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }));
    const error = await failureOf(sendTo());
    expect(error).toMatchObject({ kind: "network", httpStatus: undefined });
    expect(error.retryable).toBe(true);
    expect(error.message).toContain("ECONNREFUSED");
  });

  it.each(["TimeoutError", "AbortError"])("calls a fetch that gave up with %s unavailable", async (name) => {
    fetchMock.mockRejectedValue(new DOMException("The operation was aborted", name));
    const error = await failureOf(sendTo());
    expect(error.kind).toBe("unavailable");
    expect(error.retryable).toBe(true);
  });

  it("gives up after timeoutMs", async () => {
    fetchMock.mockImplementation(slowAnswer(1_000, () => telegramOk({ message_id: 1 })));
    const error = await failureOf(
      telegramSendMessage(TOKEN, { chatId: GROUP_ID, html: "x" }, { ...options, timeoutMs: 20 })
    );
    expect(error.kind).toBe("unavailable");
  });

  it("calls an answer cut off midway unavailable", async () => {
    answerWith(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new TypeError("terminated"));
            },
          }),
          { status: 200 }
        )
    );
    expect(await failureOf(sendTo())).toMatchObject({ kind: "unavailable", httpStatus: 200 });
  });

  it("never puts the token in an error message", async () => {
    const url = `${TELEGRAM_API_BASE}/bot${TOKEN}/sendMessage`;
    const answers: Array<() => Promise<Response>> = [
      async () => telegramFail(401, "Unauthorized"),
      async () => telegramFail(400, `Bad Request: unexpected ${TOKEN}`),
      async () => {
        // node-fetch style: the whole URL in the message.
        throw new TypeError(`request to ${url} failed, reason: getaddrinfo ENOTFOUND api.telegram.org`);
      },
      async () => {
        throw new TypeError(`request to ${url.replace(TOKEN, TOKEN.replace(":", "%3A"))} failed`);
      },
      async () => new Response("<html>502</html>", { status: 502 }),
    ];
    for (const answer of answers) {
      fetchMock.mockImplementationOnce(answer);
      const error = await failureOf(sendTo());
      expect(error.message).not.toContain(SECRET);
      expect(String(error.stack)).not.toContain(SECRET);
    }

    fetchMock.mockImplementationOnce(async () => {
      throw new TypeError(`request to ${TELEGRAM_API_BASE}/file/bot${TOKEN}/voice/file_7.oga failed`);
    });
    const download = await failureOf(telegramDownloadFile(TOKEN, "voice/file_7.oga", { maxBytes: 10 }, options));
    expect(download.message).not.toContain(SECRET);
  });

  it("masks anything shaped like a token, whoever builds the error", () => {
    const error = new TelegramError(`failed: ${TELEGRAM_API_BASE}/bot${TOKEN}/getMe`, "network");
    expect(error.message).toBe(`failed: ${TELEGRAM_API_BASE}/bot[redacted]/getMe`);
  });

  it.each([
    ["invalid_token", false],
    ["forbidden", false],
    ["chat_not_found", false],
    ["bad_request", false],
    ["rate_limited", true],
    ["unavailable", true],
    ["network", true],
  ] as [TelegramErrorKind, boolean][])("%s is retryable: %s", (kind, retryable) => {
    expect(new TelegramError("x", kind).retryable).toBe(retryable);
  });

  it.each([
    [401, "Unauthorized", "invalid_token"],
    [404, "Not Found", "invalid_token"],
    [403, "Forbidden: bot can't initiate conversation with a user", "forbidden"],
    [400, "Bad Request: chat not found", "chat_not_found"],
    [400, "Bad Request: message is too long", "bad_request"],
    [409, "Conflict: terminated by other getUpdates request", "bad_request"],
    [429, "Too Many Requests: retry after 5", "rate_limited"],
    [502, "Bad Gateway", "unavailable"],
    [200, "", "unavailable"],
  ] as [number, string, TelegramErrorKind][])("classifies %i %j as %s", (code, description, kind) => {
    expect(classifyTelegramError(code, description)).toBe(kind);
  });
});

const amina = { id: "111", title: "Amina B.", type: "private", username: "amina_b" };
const salesTeam = { id: GROUP_ID, title: "فريق المبيعات", type: "supergroup", username: null };
const brandNews = { id: "-1009876543210", title: "Brand news", type: "channel", username: "brandnews" };

const aminaChat = { id: 111, first_name: "Amina", last_name: "B.", username: "amina_b", type: "private" };
const aminaUser = { id: 111, is_bot: false, first_name: "Amina", username: "amina_b" };

const RAW_UPDATES = [
  { update_id: 500, message: { message_id: 1, from: aminaUser, chat: aminaChat, date: 1764000000, text: "/start" } },
  {
    update_id: 501,
    my_chat_member: {
      chat: { id: Number(GROUP_ID), title: "فريق المبيعات", type: "supergroup" },
      from: aminaUser,
      date: 1764000100,
      old_chat_member: { status: "left", user: { id: 7012345678, is_bot: true } },
      new_chat_member: { status: "member", user: { id: 7012345678, is_bot: true } },
    },
  },
  {
    update_id: 502,
    message: {
      message_id: 2,
      from: aminaUser,
      chat: aminaChat,
      date: 1764000200,
      voice: { file_id: "AwACAgQAAxkBAAIBe2", file_unique_id: "AgADxx", duration: 7, mime_type: "audio/ogg", file_size: 12345 },
    },
  },
  {
    update_id: 503,
    channel_post: {
      message_id: 9,
      sender_chat: { id: -1009876543210, title: "Brand news", username: "brandnews", type: "channel" },
      chat: { id: -1009876543210, title: "Brand news", username: "brandnews", type: "channel" },
      date: 1764000300,
      text: "New collection",
    },
  },
  {
    update_id: 504,
    edited_message: {
      message_id: 1,
      from: aminaUser,
      chat: aminaChat,
      date: 1764000000,
      edit_date: 1764000400,
      text: "/start again",
    },
  },
  { update_id: 505, callback_query: { id: "q1", from: aminaUser, data: "x" } },
  {
    update_id: 506,
    message: {
      message_id: 3,
      from: aminaUser,
      chat: aminaChat,
      date: 1764000500,
      audio: { file_id: "CQACAgQAAxkBAAIBf3", file_unique_id: "AgADyy", duration: 95, mime_type: "audio/mpeg" },
    },
  },
  { not_an_update: true },
];

const message = (fields: Partial<NonNullable<TelegramUpdate["message"]>>) => ({
  messageId: 1,
  date: 1764000000,
  text: null,
  fromUsername: "amina_b",
  voice: null,
  audio: null,
  ...fields,
});

describe("telegramGetUpdates", () => {
  it("reads private messages, voice notes, channel posts, edits and the bot joining a group", async () => {
    answerWith(() => telegramOk(RAW_UPDATES));
    await expect(telegramGetUpdates(TOKEN, {}, options)).resolves.toEqual([
      { updateId: 500, chat: amina, message: message({ text: "/start" }) },
      { updateId: 501, chat: salesTeam, message: null },
      {
        updateId: 502,
        chat: amina,
        message: message({
          messageId: 2,
          date: 1764000200,
          voice: { fileId: "AwACAgQAAxkBAAIBe2", durationSeconds: 7, mimeType: "audio/ogg", fileSize: 12345 },
        }),
      },
      {
        updateId: 503,
        chat: brandNews,
        message: message({ messageId: 9, date: 1764000300, text: "New collection", fromUsername: null }),
      },
      { updateId: 504, chat: amina, message: message({ text: "/start again" }) },
      // Kept with no chat, so the caller's offset moves past it.
      { updateId: 505, chat: null, message: null },
      {
        updateId: 506,
        chat: amina,
        message: message({
          messageId: 3,
          date: 1764000500,
          audio: { fileId: "CQACAgQAAxkBAAIBf3", durationSeconds: 95, mimeType: "audio/mpeg", fileSize: null },
        }),
      },
    ]);
  });

  it("sends offset, timeout, limit and allowed_updates", async () => {
    answerWith(() => telegramOk([]));
    await telegramGetUpdates(
      TOKEN,
      { offset: 507, timeoutSeconds: 25, limit: 50, allowedUpdates: ["message", "my_chat_member"] },
      options
    );
    const call = lastCall();
    expect(call.url).toBe(`${TELEGRAM_API_BASE}/bot${TOKEN}/getUpdates`);
    expect(call.body).toEqual({ offset: 507, timeout: 25, limit: 50, allowed_updates: ["message", "my_chat_member"] });
  });

  it("asks for a short poll by default and caps limit at 100", async () => {
    answerWith(() => telegramOk([]));
    await telegramGetUpdates(TOKEN, {}, options);
    expect(lastCall().body).toEqual({ timeout: 0 });
    await telegramGetUpdates(TOKEN, { limit: 500 }, options);
    expect(lastCall().body).toEqual({ timeout: 0, limit: 100 });
  });

  it.each([Number.NaN, BigInt(5) as unknown as number])("refuses the offset %s rather than drop it", async (offset) => {
    await expect(telegramGetUpdates(TOKEN, { offset }, options)).rejects.toBeInstanceOf(TypeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the HTTP request open longer than the long poll", async () => {
    fetchMock.mockImplementation(slowAnswer(150, () => telegramOk([])));
    // 20 ms alone would end the request first: the 1 s poll comes on top of it.
    await expect(telegramGetUpdates(TOKEN, { timeoutSeconds: 1 }, { ...options, timeoutMs: 20 })).resolves.toEqual([]);
    // Without long polling the same answer comes too late.
    const error = await failureOf(telegramGetUpdates(TOKEN, {}, { ...options, timeoutMs: 20 }));
    expect(error.kind).toBe("unavailable");
  });

  it("reports a webhook set elsewhere as a refusal, not something to retry", async () => {
    answerWith(() =>
      telegramFail(
        409,
        "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first"
      )
    );
    const error = await failureOf(telegramGetUpdates(TOKEN, {}, options));
    expect(error).toMatchObject({ kind: "bad_request", httpStatus: 409 });
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("webhook is active");
  });
});

describe("chatsFromUpdates", () => {
  it("lists each chat once, the most recent first", async () => {
    answerWith(() => telegramOk(RAW_UPDATES));
    expect(chatsFromUpdates(await telegramGetUpdates(TOKEN, {}, options))).toEqual([amina, brandNews, salesTeam]);
  });

  it("shows a renamed group under its newest title, whatever the input order", () => {
    const group = (updateId: number, title: string): TelegramUpdate => ({
      updateId,
      chat: { id: "-100555", title, type: "supergroup", username: null },
      message: null,
    });
    const person: TelegramUpdate = {
      updateId: 2,
      chat: { id: "42", title: "Karim", type: "private", username: null },
      message: null,
    };
    expect(chatsFromUpdates([group(3, "Ventes Alger"), group(1, "Ventes"), person])).toEqual([
      { id: "-100555", title: "Ventes Alger", type: "supergroup", username: null },
      person.chat,
    ]);
  });
});

describe("files", () => {
  const VOICE_PATH = "voice/file_7.oga";

  it("asks Telegram where a file is", async () => {
    answerWith(() =>
      telegramOk({ file_id: "AwACAgQAAxkBAAIBe2", file_unique_id: "AgADxx", file_size: 12345, file_path: VOICE_PATH })
    );
    await expect(telegramGetFile(TOKEN, "AwACAgQAAxkBAAIBe2", options)).resolves.toEqual({
      filePath: VOICE_PATH,
      fileSize: 12345,
    });
    const call = lastCall();
    expect(call.url).toBe(`${TELEGRAM_API_BASE}/bot${TOKEN}/getFile`);
    expect(call.body).toEqual({ file_id: "AwACAgQAAxkBAAIBe2" });
  });

  it.each([
    { case: "too big for bots", answer: () => telegramFail(400, "Bad Request: file is too big") },
    { case: "with no path", answer: () => telegramOk({ file_id: "x", file_unique_id: "y" }) },
  ])("refuses a file $case", async ({ answer }) => {
    answerWith(answer);
    expect((await failureOf(telegramGetFile(TOKEN, "x", options))).kind).toBe("bad_request");
  });

  it("downloads the bytes with a GET on the file URL", async () => {
    const bytes = new Uint8Array([79, 103, 103, 83, 0, 2]);
    answerWith(() => new Response(bytes, { headers: { "content-length": String(bytes.length) } }));
    const file = await telegramDownloadFile(TOKEN, VOICE_PATH, { maxBytes: bytes.length }, options);
    expect(Buffer.isBuffer(file)).toBe(true);
    expect([...file]).toEqual([...bytes]);
    const call = lastCall();
    expect(call.url).toBe(`${TELEGRAM_API_BASE}/file/bot${TOKEN}/${VOICE_PATH}`);
    expect(call.init.method).toBe("GET");
    expect(call.init.body).toBeUndefined();
    expect(call.init.cache).toBe("no-store");
  });

  it("refuses a file whose content-length is over the limit, without reading it", async () => {
    let pulled = false;
    answerWith(
      () =>
        new Response(
          new ReadableStream(
            {
              pull(controller) {
                pulled = true;
                controller.enqueue(new Uint8Array(64));
                controller.close();
              },
            },
            { highWaterMark: 0 }
          ),
          { headers: { "content-length": "5000000" } }
        )
    );
    const error = await failureOf(telegramDownloadFile(TOKEN, VOICE_PATH, { maxBytes: 1_000_000 }, options));
    expect(error.kind).toBe("bad_request");
    expect(error.retryable).toBe(false);
    expect(pulled).toBe(false);
  });

  it.each<{ case: string; headers: Record<string, string> }>([
    { case: "announces less than it sends", headers: { "content-length": "10" } },
    { case: "announces nothing", headers: {} },
  ])("stops a body over the limit that $case", async ({ headers }) => {
    answerWith(() => new Response(new Uint8Array(100), { headers }));
    const error = await failureOf(telegramDownloadFile(TOKEN, VOICE_PATH, { maxBytes: 50 }, options));
    expect(error.kind).toBe("bad_request");
  });

  it("reads a 404 as a wrong or expired path, not a bad token", async () => {
    answerWith(() => telegramFail(404, "Not Found"));
    const error = await failureOf(telegramDownloadFile(TOKEN, VOICE_PATH, { maxBytes: 10 }, options));
    expect(error).toMatchObject({ kind: "bad_request", httpStatus: 404 });
    expect(error.message).not.toContain(SECRET);
  });

  it("calls a download cut off midway unavailable", async () => {
    answerWith(
      () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.error(new TypeError("terminated"));
            },
          })
        )
    );
    const error = await failureOf(telegramDownloadFile(TOKEN, VOICE_PATH, { maxBytes: 10 }, options));
    expect(error.kind).toBe("unavailable");
  });

  it.each(["", "../secrets", "voice//file_7.oga", "/voice/file_7.oga"])(
    "refuses the file path %j without a request",
    async (path) => {
      const error = await failureOf(telegramDownloadFile(TOKEN, path, { maxBytes: 10 }, options));
      expect(error.kind).toBe("bad_request");
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it("refuses to download without a real limit", async () => {
    await expect(telegramDownloadFile(TOKEN, VOICE_PATH, { maxBytes: Number("abc") }, options)).rejects.toBeInstanceOf(
      TypeError
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
