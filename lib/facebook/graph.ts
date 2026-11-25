/**
 * Graph API client for Facebook Pages and the Messenger Send API.
 *
 * Kept apart from lib/meta/client.ts, which serves Instagram: the two
 * channels have different endpoints, error codes and retry rules, and the
 * Instagram worker's error handling must never see a Facebook error class.
 *
 * Tokens travel in the Authorization header, never in a URL, so they cannot
 * end up in logs. Error messages carry the request path without its query.
 */
import { getFacebookAppId, getFacebookAppSecret, getFacebookGraphBase } from "./env";

const DEFAULT_TIMEOUT_MS = 15_000;

/** Messenger limits, in characters. */
export const MESSENGER_TEXT_LIMIT = 2000;
export const BUTTON_TEMPLATE_TEXT_LIMIT = 640;
export const BUTTON_TITLE_LIMIT = 20;
export const METADATA_LIMIT = 1000;

/**
 * What a Graph error means for whoever sent the request.
 *
 * - rate_limit:      Meta throttled the app or Page. Pause, then retry.
 * - token_invalid:   the token no longer works (190). The Page needs reconnecting.
 * - permission:      a permission or feature is missing.
 * - already_replied: the comment already got its one private reply (10900).
 * - not_eligible:    this person cannot be messaged (10903, 551, no user).
 * - outside_window:  the 24-hour messaging window is closed.
 * - template_rejected: the button template was refused; plain text may pass.
 * - invalid_request: any other refusal of the request itself.
 * - ambiguous:       no proof either way (network failure, 5xx, codes 1 and 2).
 *                    A send may have gone through, so it must not be repeated.
 */
export type FacebookErrorKind =
  | "rate_limit"
  | "token_invalid"
  | "permission"
  | "already_replied"
  | "not_eligible"
  | "outside_window"
  | "template_rejected"
  | "invalid_request"
  | "ambiguous";

export class FacebookApiError extends Error {
  constructor(
    message: string,
    public readonly kind: FacebookErrorKind,
    public readonly code?: number,
    public readonly subcode?: number,
    public readonly httpStatus?: number,
    public readonly fbTraceId?: string
  ) {
    super(message);
    this.name = "FacebookApiError";
  }

  /** True when Meta explicitly refused, so nothing was delivered. */
  get isConfirmedRejection(): boolean {
    return this.kind !== "ambiguous";
  }
}

const RATE_LIMIT_CODES = new Set([4, 17, 32, 368, 613, 80001, 80006]);
// Graph permission errors are 10 and the whole 200-299 range.
const isPermissionCode = (code: number) => code === 10 || (code >= 200 && code <= 299);

/** Classify a Graph error body. Exported for tests and for callers that log. */
export function classifyGraphError(
  code: number | undefined,
  subcode: number | undefined,
  message: string,
  httpStatus: number
): FacebookErrorKind {
  if (code === undefined) {
    return httpStatus >= 500 ? "ambiguous" : "invalid_request";
  }
  if (code === 1 || code === 2 || code === 1200) return "ambiguous";
  if (RATE_LIMIT_CODES.has(code)) return "rate_limit";
  if (code === 190 || code === 102) return "token_invalid";
  if (code === 10900) return "already_replied";
  // 10901-10999: other private reply refusals (too old, not allowed). Final.
  if (code === 551 || (code > 10900 && code < 11000)) return "not_eligible";
  if (subcode === 2018278 || /outside (of )?(the )?allowed window/i.test(message)) {
    return "outside_window";
  }
  if (code === 100 && (subcode === 2018001 || /no matching user/i.test(message))) {
    return "not_eligible";
  }
  if (isPermissionCode(code)) return "permission";
  if (code === 100 && /template|button|payload|attachment/i.test(message)) {
    return "template_rejected";
  }
  if (httpStatus >= 500) return "ambiguous";
  return "invalid_request";
}

type GraphErrorBody = {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    fbtrace_id?: string;
  };
};

type Query = Record<string, string | number | boolean | undefined>;

interface GraphRequest {
  method?: "GET" | "POST" | "DELETE";
  path: string;
  token?: string;
  query?: Query;
  body?: unknown;
  timeoutMs?: number;
}

/** One Graph API call. Throws FacebookApiError on any failure. */
export async function graphRequest<T>({
  method = "GET",
  path,
  token,
  query,
  body,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: GraphRequest): Promise<T> {
  const url = new URL(`${getFacebookGraphBase()}/${path.replace(/^\//, "")}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "network error";
    throw new FacebookApiError(`Graph request failed (${url.pathname}): ${reason}`, "ambiguous");
  }

  let data: unknown = null;
  const text = await response.text().catch(() => "");
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  const graphError = (data as GraphErrorBody | null)?.error;
  if (!response.ok || graphError) {
    const code = graphError?.code;
    const subcode = graphError?.error_subcode;
    const detail = graphError?.message ?? `HTTP ${response.status}`;
    const message = `${detail} (${url.pathname}) [code=${code ?? "-"} sub=${subcode ?? "-"} type=${graphError?.type ?? "-"} trace=${graphError?.fbtrace_id ?? "-"}]`;
    throw new FacebookApiError(
      message,
      classifyGraphError(code, subcode, detail, response.status),
      code,
      subcode,
      response.status,
      graphError?.fbtrace_id
    );
  }

  if (data === null) {
    // A 2xx without a JSON body: the call may have worked, so it is unknown.
    throw new FacebookApiError(
      `Graph returned no JSON body (${url.pathname})`,
      "ambiguous",
      undefined,
      undefined,
      response.status
    );
  }
  return data as T;
}

// ─── Tokens ─────────────────────────────────────────────────────────────────

export interface DebugTokenData {
  app_id?: string;
  type?: string;
  application?: string;
  is_valid?: boolean;
  /** 0 means the token does not expire. */
  expires_at?: number;
  data_access_expires_at?: number;
  scopes?: string[];
  profile_id?: string;
  user_id?: string;
  error?: { message?: string; code?: number };
}

function appAccessToken(): string {
  const appId = getFacebookAppId();
  const secret = getFacebookAppSecret();
  if (!appId || !secret) {
    throw new FacebookApiError(
      "FACEBOOK_APP_ID and FACEBOOK_APP_SECRET are required to inspect tokens",
      "permission"
    );
  }
  return `${appId}|${secret}`;
}

/** Inspect any token the app issued, using the app's own token. */
export async function debugToken(inputToken: string): Promise<DebugTokenData> {
  const result = await graphRequest<{ data?: DebugTokenData }>({
    path: "debug_token",
    token: appAccessToken(),
    query: { input_token: inputToken },
  });
  return result.data ?? {};
}

/** Swap a user token (even a short-lived one) for a long-lived one. */
export async function exchangeForLongLivedUserToken(
  userToken: string
): Promise<{ accessToken: string; expiresIn?: number }> {
  const appId = getFacebookAppId();
  const secret = getFacebookAppSecret();
  if (!appId || !secret) {
    throw new FacebookApiError(
      "FACEBOOK_APP_ID and FACEBOOK_APP_SECRET are required to exchange tokens",
      "permission"
    );
  }
  // The secret has to be a query parameter for this endpoint. It is never
  // logged: error messages only carry the path.
  const result = await graphRequest<{ access_token?: string; expires_in?: number }>({
    path: "oauth/access_token",
    query: {
      grant_type: "fb_exchange_token",
      client_id: appId,
      client_secret: secret,
      fb_exchange_token: userToken,
    },
  });
  if (!result.access_token) {
    throw new FacebookApiError("Token exchange returned no token", "invalid_request");
  }
  return { accessToken: result.access_token, expiresIn: result.expires_in };
}

// ─── Pages ──────────────────────────────────────────────────────────────────

export interface ManagedPage {
  id: string;
  name: string;
  access_token?: string;
  tasks?: string[];
  picture?: { data?: { url?: string } };
}

/** Pages the user manages, each with its own Page token. Follows paging. */
export async function getUserPages(userToken: string, max = 200): Promise<ManagedPage[]> {
  const pages: ManagedPage[] = [];
  let after: string | undefined;
  for (let round = 0; round < 20 && pages.length < max; round++) {
    const result = await graphRequest<{
      data?: ManagedPage[];
      paging?: { cursors?: { after?: string }; next?: string };
    }>({
      path: "me/accounts",
      token: userToken,
      query: { fields: "id,name,access_token,tasks,picture{url}", limit: 100, after },
    });
    pages.push(...(result.data ?? []));
    const next = result.paging?.next ? result.paging.cursors?.after : undefined;
    if (!next || next === after) break;
    after = next;
  }
  return pages.slice(0, max);
}

export async function getPage(
  pageId: string,
  token: string
): Promise<{ id: string; name: string; pictureUrl?: string }> {
  const page = await graphRequest<{ id: string; name: string; picture?: { data?: { url?: string } } }>({
    path: encodeURIComponent(pageId),
    token,
    query: { fields: "id,name,picture{url}" },
  });
  return { id: page.id, name: page.name, pictureUrl: page.picture?.data?.url };
}

export async function subscribePageWebhooks(
  pageId: string,
  token: string,
  fields: readonly string[]
): Promise<boolean> {
  const result = await graphRequest<{ success?: boolean }>({
    method: "POST",
    path: `${encodeURIComponent(pageId)}/subscribed_apps`,
    token,
    query: { subscribed_fields: fields.join(",") },
  });
  return result.success === true;
}

export interface SubscribedApp {
  id: string;
  name?: string;
  subscribed_fields?: string[];
}

export async function getPageSubscribedApps(
  pageId: string,
  token: string
): Promise<SubscribedApp[]> {
  const result = await graphRequest<{ data?: SubscribedApp[] }>({
    path: `${encodeURIComponent(pageId)}/subscribed_apps`,
    token,
  });
  return result.data ?? [];
}

export async function unsubscribePageWebhooks(pageId: string, token: string): Promise<boolean> {
  const result = await graphRequest<{ success?: boolean }>({
    method: "DELETE",
    path: `${encodeURIComponent(pageId)}/subscribed_apps`,
    token,
  });
  return result.success === true;
}

export interface PagePost {
  id: string;
  message?: string;
  created_time?: string;
  permalink_url?: string;
  full_picture?: string;
}

export async function getPagePosts(pageId: string, token: string, limit = 25): Promise<PagePost[]> {
  const result = await graphRequest<{ data?: PagePost[] }>({
    path: `${encodeURIComponent(pageId)}/posts`,
    token,
    query: {
      fields: "id,message,created_time,permalink_url,full_picture",
      limit: Math.min(Math.max(limit, 1), 100),
    },
  });
  return result.data ?? [];
}

// ─── Messaging ──────────────────────────────────────────────────────────────

export interface LinkButton {
  title: string;
  url: string;
}

export interface SendResult {
  recipient_id?: string;
  message_id?: string;
}

function clip(text: string, limit: number): string {
  // Array.from counts code points, so an emoji is never cut in half.
  const chars = Array.from(text);
  return chars.length <= limit ? text : chars.slice(0, limit).join("");
}

function messageBody(
  text: string,
  buttons: LinkButton[] | undefined,
  metadata: string | undefined
): Record<string, unknown> {
  const message: Record<string, unknown> =
    buttons && buttons.length > 0
      ? {
          attachment: {
            type: "template",
            payload: {
              template_type: "button",
              text: clip(text, BUTTON_TEMPLATE_TEXT_LIMIT),
              buttons: buttons.slice(0, 3).map((button) => ({
                type: "web_url",
                url: button.url,
                title: clip(button.title, BUTTON_TITLE_LIMIT),
              })),
            },
          },
        }
      : { text: clip(text, MESSENGER_TEXT_LIMIT) };
  if (metadata) message.metadata = clip(metadata, METADATA_LIMIT);
  return message;
}

function sendPath(pageId: string): string {
  return `${encodeURIComponent(pageId)}/messages`;
}

/**
 * The private reply to a comment: one message, once per comment, within 7
 * days of it. The recipient is the comment, not a person. The response's
 * recipient_id is the commenter's page-scoped ID (PSID).
 */
export async function sendPrivateReply(
  pageId: string,
  token: string,
  {
    commentId,
    text,
    buttons,
    metadata,
  }: { commentId: string; text: string; buttons?: LinkButton[]; metadata?: string }
): Promise<SendResult> {
  return graphRequest<SendResult>({
    method: "POST",
    path: sendPath(pageId),
    token,
    body: {
      recipient: { comment_id: commentId },
      message: messageBody(text, buttons, metadata),
    },
  });
}

/**
 * A Messenger message to a person. RESPONSE is the standard 24-hour window;
 * HUMAN_AGENT extends it to 7 days and needs Meta's approval of the feature.
 */
export async function sendMessage(
  pageId: string,
  token: string,
  {
    psid,
    text,
    buttons,
    metadata,
    humanAgentTag = false,
  }: {
    psid: string;
    text: string;
    buttons?: LinkButton[];
    metadata?: string;
    humanAgentTag?: boolean;
  }
): Promise<SendResult> {
  return graphRequest<SendResult>({
    method: "POST",
    path: sendPath(pageId),
    token,
    body: {
      recipient: { id: psid },
      messaging_type: humanAgentTag ? "MESSAGE_TAG" : "RESPONSE",
      ...(humanAgentTag ? { tag: "HUMAN_AGENT" } : {}),
      message: messageBody(text, buttons, metadata),
    },
  });
}

/** A public reply under a comment, posted as the Page. */
export async function replyToComment(
  commentId: string,
  token: string,
  message: string
): Promise<{ id?: string }> {
  return graphRequest<{ id?: string }>({
    method: "POST",
    path: `${encodeURIComponent(commentId)}/comments`,
    token,
    body: { message },
  });
}

/**
 * A person's name from the Messenger profile API. Meta may withhold it for
 * people without a role on the app until the app is approved for it, so a
 * failure is not an error: the caller falls back to a generic label.
 */
export async function getMessengerProfileName(psid: string, token: string): Promise<string | null> {
  try {
    const profile = await graphRequest<{ name?: string; first_name?: string; last_name?: string }>({
      path: encodeURIComponent(psid),
      token,
      query: { fields: "name,first_name,last_name" },
      timeoutMs: 8_000,
    });
    const name =
      profile.name?.trim() ||
      [profile.first_name, profile.last_name].filter(Boolean).join(" ").trim();
    return name || null;
  } catch {
    return null;
  }
}

/** Split long text into Messenger-sized parts, preferring line and word breaks. */
export function splitMessageText(text: string, limit = MESSENGER_TEXT_LIMIT): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (Array.from(rest).length > limit) {
    const window = Array.from(rest).slice(0, limit).join("");
    let cut = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" "));
    if (cut < limit * 0.5) cut = window.length;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}
