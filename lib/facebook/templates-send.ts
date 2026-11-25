/**
 * Messenger generic templates (colour cards, product comparison) and image
 * attachments, built from untrusted card data and sent with the Send API.
 *
 * Everything shown to a customer here comes from a catalog a Page owner
 * typed or a model suggested, so texts are cut to Meta's limits on one line
 * and links are checked before they reach a payload. The builders never
 * throw on a bad card: they drop what Meta would refuse, so one bad colour
 * does not cost the other nine.
 */
import { getFacebookGraphBase } from "./env";
import { FacebookApiError, METADATA_LIMIT, classifyGraphError, classifyNetworkError } from "./graph";

export type TemplateButton =
  | { type: "postback"; title: string; payload: string }
  | { type: "web_url"; title: string; url: string };

export interface TemplateCard {
  title: string;
  subtitle?: string | null;
  imageUrl: string;
  buttons: TemplateButton[];
}

/** Meta shows at most 10 elements in one generic template. */
export const MAX_TEMPLATE_ELEMENTS = 10;

/** Messenger limits for a generic template. Texts count characters, payload too. */
export const TEMPLATE_LIMITS = {
  title: 80,
  subtitle: 80,
  buttonTitle: 20,
  buttons: 3,
  payload: 1000,
} as const;

/** Meta documents 2000 characters for a URL in a template. */
const URL_LIMIT = 2000;

export type TemplateMessage = {
  attachment: {
    type: "template";
    payload: {
      template_type: "generic";
      image_aspect_ratio: "square";
      elements: unknown[];
    };
  };
};

export type ImageAttachmentMessage = ReturnType<typeof buildImageAttachment>;

const DEFAULT_TIMEOUT_MS = 15_000;

const graphemes = new Intl.Segmenter("ar", { granularity: "grapheme" });

const codePoints = (text: string) => Array.from(text).length;

/**
 * One line: whitespace and control characters collapse to a single space,
 * and bidi overrides are dropped so a card name cannot reorder the text
 * around it. ZWJ and ZWNJ stay: emoji sequences and Arabic shaping need them.
 */
function oneLine(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[‪-‮⁦-⁩]/g, "")
    .replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, " ")
    .trim();
}

/**
 * At most `max` code points, "…" included, ending on a grapheme boundary so
 * an emoji, a flag or a letter with its harakat is never split. A first
 * grapheme that alone does not fit yields "" rather than a lone "…".
 */
function cut(text: string, max: number): string {
  if (codePoints(text) <= max) return text;
  let kept = "";
  let used = 1; // the ellipsis
  for (const { segment } of graphemes.segment(text)) {
    used += codePoints(segment);
    if (used > max) break;
    kept += segment;
  }
  kept = kept.trimEnd();
  return kept ? `${kept}…` : "";
}

/**
 * A link Meta can fetch as an image: https only (a plain http image is
 * refused or blocked as mixed content), without credentials in it.
 */
function safeImageUrl(value: unknown): string | null {
  const parsed = parseUrl(value);
  return parsed && parsed.protocol === "https:" ? parsed.href : null;
}

/**
 * A link for a «التفاصيل» button. https is expected, but http is allowed
 * too: some brands' landing pages are still on http, and a web_url button
 * to one works in Messenger. Losing the button for that would cost more than
 * the warning browsers show. Other schemes (javascript:, data:, tel:) never.
 */
function safeButtonUrl(value: unknown): string | null {
  const parsed = parseUrl(value);
  return parsed ? parsed.href : null;
}

function parseUrl(value: unknown): URL | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > URL_LIMIT || /[\s\u0000-\u001f\u007f-\u009f]/.test(text)) return null;
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (parsed.username || parsed.password || !parsed.hostname) return null;
  return parsed.href.length <= URL_LIMIT ? parsed : null;
}

function buildButton(button: TemplateButton | null | undefined): Record<string, string> | null {
  if (!button || typeof button !== "object") return null;
  const title = cut(oneLine(button.title), TEMPLATE_LIMITS.buttonTitle);
  if (!title) return null;
  if (button.type === "postback") {
    // A payload is parsed back by us: cutting it would corrupt it, so an
    // overlong or empty one drops the button instead.
    const payload = button.payload;
    if (typeof payload !== "string" || !payload || payload.length > TEMPLATE_LIMITS.payload) return null;
    return { type: "postback", title, payload };
  }
  if (button.type === "web_url") {
    const url = safeButtonUrl(button.url);
    return url ? { type: "web_url", title, url } : null;
  }
  return null;
}

function buildElement(card: TemplateCard | null | undefined): Record<string, unknown> | null {
  if (!card || typeof card !== "object") return null;
  const title = cut(oneLine(card.title), TEMPLATE_LIMITS.title);
  if (!title) return null;
  const imageUrl = safeImageUrl(card.imageUrl);
  if (!imageUrl) return null;

  const buttons = (Array.isArray(card.buttons) ? card.buttons : [])
    .map(buildButton)
    .filter((button): button is Record<string, string> => button !== null)
    .slice(0, TEMPLATE_LIMITS.buttons);
  const subtitle = cut(oneLine(card.subtitle), TEMPLATE_LIMITS.subtitle);

  return {
    title,
    ...(subtitle ? { subtitle } : {}),
    image_url: imageUrl,
    ...(buttons.length > 0 ? { buttons } : {}),
  };
}

/**
 * Generic templates for the cards that can be sent, 10 per message (11
 * colours make two messages). Cards Meta would refuse are dropped: no title,
 * or no https image. Square images suit colour swatches and product shots.
 */
export function buildGenericTemplates(cards: TemplateCard[]): TemplateMessage[] {
  const elements = (Array.isArray(cards) ? cards : [])
    .map(buildElement)
    .filter((element): element is Record<string, unknown> => element !== null);

  const messages: TemplateMessage[] = [];
  for (let start = 0; start < elements.length; start += MAX_TEMPLATE_ELEMENTS) {
    messages.push({
      attachment: {
        type: "template",
        payload: {
          template_type: "generic",
          image_aspect_ratio: "square",
          elements: elements.slice(start, start + MAX_TEMPLATE_ELEMENTS),
        },
      },
    });
  }
  return messages;
}

/**
 * A single image, the fallback when Meta refuses the template. Reusable so
 * Meta caches it. Throws on a link that is not https: sending it could only
 * fail, and the caller checked the product's image before it got here.
 */
export function buildImageAttachment(url: string): {
  attachment: { type: "image"; payload: { url: string; is_reusable: true } };
} {
  const safe = safeImageUrl(url);
  if (!safe) throw new TypeError("An image attachment needs an https URL");
  return { attachment: { type: "image", payload: { url: safe, is_reusable: true } } };
}

type GraphErrorBody = {
  error?: { message?: string; type?: string; code?: number; error_subcode?: number; fbtrace_id?: string };
};

/**
 * POST /{page-id}/messages with a template or image. Same request, headers
 * and error classes as sendMessage in graph.ts: RESPONSE inside the 24-hour
 * window, MESSAGE_TAG + HUMAN_AGENT when asked, the token in the
 * Authorization header and never in a URL or an error message.
 */
export async function sendTemplateMessage(
  pageId: string,
  token: string,
  options: {
    psid: string;
    message: TemplateMessage | ImageAttachmentMessage;
    metadata?: string;
    humanAgentTag?: boolean;
    fetchImpl?: typeof fetch;
  }
): Promise<{ messageId: string }> {
  const { psid, message, metadata, humanAgentTag = false, fetchImpl = fetch } = options;
  if (!psid) throw new FacebookApiError("Missing recipient for the template message", "invalid_request");

  const url = new URL(`${getFacebookGraphBase()}/${encodeURIComponent(pageId)}/messages`);
  const body = {
    recipient: { id: psid },
    messaging_type: humanAgentTag ? "MESSAGE_TAG" : "RESPONSE",
    ...(humanAgentTag ? { tag: "HUMAN_AGENT" } : {}),
    message: {
      ...message,
      // Code points, not graphemes: the metadata is our own machine marker.
      ...(metadata ? { metadata: Array.from(metadata).slice(0, METADATA_LIMIT).join("") } : {}),
    },
  };

  let response: Response;
  try {
    response = await fetchImpl(url.toString(), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "network error";
    const code = (error as { cause?: { code?: unknown } })?.cause?.code;
    throw new FacebookApiError(
      `Graph request failed (${url.pathname}): ${reason}${typeof code === "string" ? ` [${code}]` : ""}`,
      classifyNetworkError(error)
    );
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
    throw new FacebookApiError(
      `${detail} (${url.pathname}) [code=${code ?? "-"} sub=${subcode ?? "-"} type=${graphError?.type ?? "-"} trace=${graphError?.fbtrace_id ?? "-"}]`,
      classifyGraphError(code, subcode, detail, response.status),
      code,
      subcode,
      response.status,
      graphError?.fbtrace_id
    );
  }

  const messageId = (data as { message_id?: unknown } | null)?.message_id;
  if (typeof messageId !== "string" || !messageId) {
    // A 2xx without a message id: it may have been delivered, so do not resend.
    throw new FacebookApiError(
      `Graph returned no message id (${url.pathname})`,
      "ambiguous",
      undefined,
      undefined,
      response.status
    );
  }
  return { messageId };
}
