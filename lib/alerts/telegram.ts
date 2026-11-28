/**
 * Telegram Bot API client, over fetch: handoff alerts, bot token checks, chat
 * discovery for the alerts page, and voice file downloads.
 *
 * Telegram takes the token in the URL path (/bot<token>/<method>), so a URL
 * never goes into an error message, and anything shaped like a token is
 * masked out of messages anyway. Errors are sorted into kinds the callers act
 * on: the alert job retries the retryable ones and records the others.
 */

export const TELEGRAM_API_BASE = "https://api.telegram.org";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_UPDATES = 100;

export type TelegramErrorKind =
  /** 401 (or 404, Telegram's answer to a token it cannot read), or a token that fails isTelegramToken. */
  | "invalid_token"
  /** 403: the bot was blocked by the person, kicked from the group, or never started. */
  | "forbidden"
  /** A 400 whose description mentions "chat not found": a wrong ID, or a chat the bot never joined. */
  | "chat_not_found"
  /** Any other refusal (bad HTML, a wrong button URL, a file too big). Repeating it fails the same way. */
  | "bad_request"
  /** 429. Wait retryAfterSeconds, then try again. */
  | "rate_limited"
  /** 5xx, no answer in time, or an answer cut off or unreadable. */
  | "unavailable"
  /** fetch threw before any answer came back. */
  | "network";

export class TelegramError extends Error {
  constructor(
    message: string,
    readonly kind: TelegramErrorKind,
    readonly httpStatus?: number,
    readonly retryAfterSeconds?: number
  ) {
    // Masked here as well, so no caller can leak a token through a message.
    super(maskTokens(String(message)));
    this.name = "TelegramError";
  }

  get retryable(): boolean {
    return this.kind === "rate_limited" || this.kind === "unavailable" || this.kind === "network";
  }
}

export interface TelegramOptions {
  fetchImpl?: typeof fetch;
  /** Milliseconds per request, 15 000 by default. A long poll gets this much on top of its own wait. */
  timeoutMs?: number;
}

// ─── Tokens and HTML ────────────────────────────────────────────────────────

// BotFather's format: the bot's numeric ID, a colon, then the secret.
const TOKEN_FORMAT = /^\d+:[A-Za-z0-9_-]{30,}$/;
const TOKEN_ANYWHERE = /\d+:[A-Za-z0-9_-]{30,}/g;
const REDACTED = "[redacted]";

/** The exact value, untrimmed: callers trim pasted input first. */
export function isTelegramToken(value: string): boolean {
  return typeof value === "string" && TOKEN_FORMAT.test(value);
}

/** Masks the given token (whole, or its secret alone) and anything shaped like a token. */
function maskTokens(text: string, token?: string): string {
  let masked = text;
  if (token && isTelegramToken(token)) {
    // The secret alone too: a client may print the URL with the colon encoded.
    for (const secret of [token, token.slice(token.indexOf(":") + 1)]) {
      masked = masked.split(secret).join(REDACTED);
    }
  }
  return masked.replace(TOKEN_ANYWHERE, REDACTED);
}

const HTML_ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };

/**
 * Text made safe for parse_mode HTML, in a tag's body or a double-quoted
 * attribute: a customer's message cannot open a tag or forge a link.
 */
export function escapeTelegramHtml(text: string): string {
  return text.replace(/[&<>"]/g, (char) => HTML_ENTITIES[char]);
}

/**
 * Whether Telegram takes this URL on a link button: https, on a public host
 * name. Telegram refuses the whole message over a button it rejects, so when
 * in doubt the button is left out (the link can still go in the text).
 */
export function isTelegramButtonUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
  if (host === "[::1]" || host === "[::]" || host === "0.0.0.0" || /^127\.\d+\.\d+\.\d+$/.test(host)) {
    return false;
  }
  // A name without a dot (an intranet host, a Docker service) is not public either.
  return host.startsWith("[") || host.includes(".");
}

// ─── Requests and errors ────────────────────────────────────────────────────

type Payload = {
  ok?: unknown;
  result?: unknown;
  error_code?: unknown;
  description?: unknown;
  parameters?: unknown;
};

/** Sort a Telegram error code and description. Exported for tests and for callers that log. */
export function classifyTelegramError(code: number, description = ""): TelegramErrorKind {
  // The method names are fixed, so a 404 from the Bot API means the token in the path.
  if (code === 401 || code === 404) return "invalid_token";
  if (code === 403) return "forbidden";
  if (code === 429) return "rate_limited";
  if (code >= 500) return "unavailable";
  if (code === 400 && /chat not found/i.test(description)) return "chat_not_found";
  if (code >= 400) return "bad_request";
  // ok:false without a usable code, or a 2xx that is not the API's JSON.
  return "unavailable";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parsePayload(text: string): Payload | null {
  if (!text) return null;
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

function assertToken(token: string): void {
  if (!isTelegramToken(token)) {
    // Never echo the value: it may be a real token with a typo.
    throw new TelegramError("The Telegram bot token is malformed", "invalid_token");
  }
}

function timeoutSignal(options: TelegramOptions, extraMs = 0): AbortSignal {
  const ms = finite(options.timeoutMs);
  // AbortSignal.timeout throws on anything but whole, non-negative milliseconds.
  return AbortSignal.timeout(Math.ceil((ms !== undefined && ms > 0 ? ms : DEFAULT_TIMEOUT_MS) + extraMs));
}

function requestFailure(error: unknown, what: string, token: string): TelegramError {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "TimeoutError" || name === "AbortError") {
    return new TelegramError(`Telegram ${what} did not answer in time`, "unavailable");
  }
  const reason = error instanceof Error ? error.message : "network error";
  const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  // Some fetch clients put the request URL, token included, in their message.
  // The original error is not kept as a cause for the same reason.
  return new TelegramError(
    maskTokens(`Telegram ${what} request failed: ${reason}${typeof code === "string" ? ` [${code}]` : ""}`, token),
    "network"
  );
}

function retryAfter(parameters: Record<string, unknown> | null, description: string): number | undefined {
  const given = finite(parameters?.retry_after);
  if (given !== undefined && given >= 0) return Math.ceil(given);
  // Without parameters, the description still says it: "Too Many Requests: retry after 35".
  const said = /retry after (\d+)/i.exec(description);
  return said ? Number(said[1]) : undefined;
}

function failure(
  what: string,
  status: number,
  payload: Payload | null,
  token: string,
  kindFor: (code: number, description: string) => TelegramErrorKind = classifyTelegramError
): TelegramError {
  // Telegram's error_code mirrors the HTTP status, and a 200 with ok:false only has this one.
  const code = finite(payload?.error_code) ?? status;
  const description = typeof payload?.description === "string" ? payload.description.trim() : "";
  const kind = kindFor(code, description);
  const parameters = asRecord(payload?.parameters);
  let message = payload
    ? `Telegram ${what} failed (${code})${description ? `: ${description}` : ""}`
    : `Telegram ${what} gave an unreadable answer (HTTP ${status})`;
  // A group that became a supergroup has a new ID: say which, so the recipient can be fixed.
  const newChat = parameters?.migrate_to_chat_id;
  if (typeof newChat === "number" || typeof newChat === "string") message += `; the group is now chat ${newChat}`;
  return new TelegramError(
    maskTokens(message, token),
    kind,
    code,
    kind === "rate_limited" ? retryAfter(parameters, description) : undefined
  );
}

/** One Bot API call, POST with a JSON body. Returns `result`, or throws TelegramError. */
async function callApi(
  token: string,
  method: string,
  body: Record<string, unknown>,
  options: TelegramOptions = {},
  extraWaitMs = 0
): Promise<unknown> {
  assertToken(token);
  const fetchImpl = options.fetchImpl ?? fetch;
  // Built before the try: a body that cannot be serialized is a bug, not a network error.
  const init: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    // Next.js can cache and log server fetches by URL, and this URL holds the token.
    cache: "no-store",
    signal: timeoutSignal(options, extraWaitMs),
  };
  let response: Response;
  try {
    response = await fetchImpl(`${TELEGRAM_API_BASE}/bot${token}/${method}`, init);
  } catch (error) {
    throw requestFailure(error, method, token);
  }

  let payload: Payload | null;
  try {
    payload = parsePayload(await response.text());
  } catch {
    throw new TelegramError(`Telegram ${method} answer was cut off`, "unavailable", response.status);
  }
  if (response.ok && payload?.ok === true) return payload.result;
  throw failure(method, response.status, payload, token);
}

// ─── Bot and messages ───────────────────────────────────────────────────────

/** Who the token belongs to: proves the token works, and names the bot on the settings page. */
export async function telegramGetMe(
  token: string,
  options?: TelegramOptions
): Promise<{ id: number; username: string | null; firstName: string }> {
  const bot = asRecord(await callApi(token, "getMe", {}, options));
  if (typeof bot?.id !== "number") throw new TelegramError("Telegram getMe returned no bot", "unavailable");
  return { id: bot.id, username: nonEmpty(bot.username), firstName: nonEmpty(bot.first_name) ?? "" };
}

/**
 * One alert. parse_mode is HTML, so the caller escapes all customer text with
 * escapeTelegramHtml. Link previews stay off: the link opens the dashboard,
 * behind a login, and a preview card would only add noise.
 */
export async function telegramSendMessage(
  token: string,
  message: { chatId: string; html: string; button?: { text: string; url: string } | null },
  options?: TelegramOptions
): Promise<{ messageId: number }> {
  const body: Record<string, unknown> = {
    chat_id: String(message.chatId ?? "").trim(),
    text: message.html,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  };
  const button = message.button;
  if (button && nonEmpty(button.text) && isTelegramButtonUrl(button.url)) {
    body.reply_markup = { inline_keyboard: [[{ text: button.text, url: button.url }]] };
  }
  const sent = asRecord(await callApi(token, "sendMessage", body, options));
  // ok:true means the message went out: a missing ID must not turn into a resend.
  return { messageId: typeof sent?.message_id === "number" ? sent.message_id : 0 };
}

// ─── Updates and chat discovery ─────────────────────────────────────────────

export interface TelegramChat {
  /** As a string: group IDs are negative, e.g. "-1001234567890". */
  id: string;
  /** The group or channel title, or the person's name for a private chat. */
  title: string | null;
  type: "private" | "group" | "supergroup" | "channel" | string;
  username: string | null;
}

export interface TelegramAudioFile {
  fileId: string;
  durationSeconds: number;
  mimeType: string | null;
  fileSize: number | null;
}

export interface TelegramIncomingMessage {
  messageId: number;
  /** Unix time, in seconds. */
  date: number;
  text: string | null;
  fromUsername: string | null;
  voice: TelegramAudioFile | null;
  audio: TelegramAudioFile | null;
}

export interface TelegramUpdate {
  updateId: number;
  chat: TelegramChat | null;
  message: TelegramIncomingMessage | null;
}

const MESSAGE_FIELDS = ["message", "edited_message", "channel_post", "edited_channel_post"] as const;

function parseChat(raw: unknown): TelegramChat | null {
  const chat = asRecord(raw);
  if (!chat || (typeof chat.id !== "number" && typeof chat.id !== "string")) return null;
  // A private chat has no title: the person's name stands in for it.
  const name = [chat.first_name, chat.last_name].map(nonEmpty).filter(Boolean).join(" ");
  return {
    id: String(chat.id),
    title: nonEmpty(chat.title) ?? (name || null),
    type: typeof chat.type === "string" ? chat.type : "unknown",
    username: nonEmpty(chat.username),
  };
}

function parseAudio(raw: unknown): TelegramAudioFile | null {
  const file = asRecord(raw);
  const fileId = nonEmpty(file?.file_id);
  if (!file || !fileId) return null;
  return {
    fileId,
    durationSeconds: typeof file.duration === "number" ? file.duration : 0,
    mimeType: nonEmpty(file.mime_type),
    fileSize: typeof file.file_size === "number" ? file.file_size : null,
  };
}

function parseMessage(message: Record<string, unknown>): TelegramIncomingMessage {
  return {
    messageId: typeof message.message_id === "number" ? message.message_id : 0,
    date: typeof message.date === "number" ? message.date : 0,
    text: typeof message.text === "string" ? message.text : null,
    fromUsername: nonEmpty(asRecord(message.from)?.username),
    voice: parseAudio(message.voice),
    audio: parseAudio(message.audio),
  };
}

function parseUpdate(raw: unknown): TelegramUpdate | null {
  const update = asRecord(raw);
  if (!update || typeof update.update_id !== "number") return null;
  const message = MESSAGE_FIELDS.map((field) => asRecord(update[field])).find((found) => found !== null) ?? null;
  // The bot added to a group: the only trace of a group where nobody wrote yet.
  const member = asRecord(update.my_chat_member);
  // Other kinds keep their ID with no chat, so the caller's offset still moves past them.
  return {
    updateId: update.update_id,
    chat: parseChat(message?.chat ?? member?.chat),
    message: message ? parseMessage(message) : null,
  };
}

/**
 * Updates the bot received, oldest first. Pass offset = last updateId + 1 to
 * confirm the ones already handled: Telegram then forgets them. With
 * timeoutSeconds > 0, Telegram holds the request until an update arrives or
 * that time runs out (long polling).
 */
export async function telegramGetUpdates(
  token: string,
  query: { offset?: number; timeoutSeconds?: number; limit?: number; allowedUpdates?: string[] } = {},
  options?: TelegramOptions
): Promise<TelegramUpdate[]> {
  const wait = Math.max(0, Math.floor(finite(query.timeoutSeconds) ?? 0));
  const body: Record<string, unknown> = { timeout: wait };
  if (query.offset !== undefined) {
    // Dropped, it would bring the same updates back on every poll.
    if (finite(query.offset) === undefined) throw new TypeError("offset must be a number");
    body.offset = query.offset;
  }
  const limit = finite(query.limit);
  if (limit !== undefined) body.limit = Math.min(Math.max(Math.floor(limit), 1), MAX_UPDATES);
  if (query.allowedUpdates) body.allowed_updates = query.allowedUpdates;
  // The HTTP timeout has to outlast the long poll, or every quiet poll would end in an error.
  const result = await callApi(token, "getUpdates", body, options, wait * 1000);
  if (!Array.isArray(result)) throw new TelegramError("Telegram getUpdates returned no list", "unavailable");
  return result.map(parseUpdate).filter((update): update is TelegramUpdate => update !== null);
}

/** The chats seen in these updates, once each, the most recent first. */
export function chatsFromUpdates(updates: TelegramUpdate[]): TelegramChat[] {
  const chats = new Map<string, TelegramChat>();
  // Newest first, so a renamed group shows its current title.
  for (const update of [...updates].sort((a, b) => b.updateId - a.updateId)) {
    if (update.chat && !chats.has(update.chat.id)) chats.set(update.chat.id, update.chat);
  }
  return [...chats.values()];
}

// ─── Files ──────────────────────────────────────────────────────────────────

/**
 * Where to download a file the bot received (a voice note). The path stays
 * valid for at least an hour. Telegram serves bots files up to 20 MB, and
 * answers bad_request ("file is too big") above that.
 */
export async function telegramGetFile(
  token: string,
  fileId: string,
  options?: TelegramOptions
): Promise<{ filePath: string; fileSize: number | null }> {
  const file = asRecord(await callApi(token, "getFile", { file_id: fileId }, options));
  const filePath = nonEmpty(file?.file_path);
  if (!filePath) throw new TelegramError("Telegram gave no download path for this file", "bad_request");
  return { filePath, fileSize: typeof file?.file_size === "number" ? file.file_size : null };
}

function tooBig(maxBytes: number): TelegramError {
  return new TelegramError(`The Telegram file is larger than ${maxBytes} bytes`, "bad_request");
}

/**
 * The bytes of a file, from the path telegramGetFile gave. Refused above
 * maxBytes, by content-length before the download and by the bytes that
 * actually arrive during it, since content-length can be missing or wrong.
 */
export async function telegramDownloadFile(
  token: string,
  filePath: string,
  limits: { maxBytes: number },
  options: TelegramOptions = {}
): Promise<Buffer> {
  assertToken(token);
  const maxBytes = limits.maxBytes;
  // NaN (a misread setting) would otherwise switch the limit off.
  if (!(maxBytes >= 0)) throw new TypeError("maxBytes must be a number of bytes");
  const segments = String(filePath ?? "").split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new TelegramError("Invalid Telegram file path", "bad_request");
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${TELEGRAM_API_BASE}/file/bot${token}/${segments.map(encodeURIComponent).join("/")}`;
  const init: RequestInit = { method: "GET", cache: "no-store", signal: timeoutSignal(options) };
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    throw requestFailure(error, "file download", token);
  }

  if (!response.ok) {
    const payload = parsePayload(await response.text().catch(() => ""));
    // Here a 404 is a wrong or expired file path, not a bad token.
    throw failure("file download", response.status, payload, token, (code, description) =>
      code === 404 ? "bad_request" : classifyTelegramError(code, description)
    );
  }

  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw tooBig(maxBytes);
  }

  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw tooBig(maxBytes);
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof TelegramError) throw error;
      throw new TelegramError("The Telegram file download was cut off", "unavailable", response.status);
    }
  }
  return Buffer.concat(chunks, size);
}
