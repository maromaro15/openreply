/**
 * The content of a handoff alert: HTML for Telegram, and an email (subject,
 * HTML, plain text). Pure: the alert-send job does the sending.
 *
 * Alerts are always written in Arabic. Every value that comes from a
 * customer, the model or the brand is put on one line, cut to a bounded
 * length and escaped, so it can neither inject a link or formatting nor
 * fake another line of the alert.
 */
import type { HandoffCategory } from "@/app/generated/prisma/client";
import { createFbI18n, translateReason } from "@/lib/facebook/i18n";
import { isHandoffCategory } from "@/lib/handoff/categories";

export interface AlertContent {
  brandName: string;
  pageName: string;
  customerName: string | null;
  category: HandoffCategory;
  reason: string | null;
  lastMessage: {
    text: string | null;
    /** A transcribed voice message. */
    transcript: string | null;
    /** "audio" | "image" | "video" | "file" | "sticker" | null */
    attachmentType: string | null;
  } | null;
  /** Absolute inbox link (see inboxLink). */
  link: string;
}

/**
 * The longest values, in code points, and the longest Telegram message, in
 * UTF-16 code units of its HTML: Telegram counts the text after parsing,
 * which is never longer.
 */
export const ALERT_LIMITS: Readonly<{ lastMessage: number; reason: number; name: number; telegram: number }> = {
  lastMessage: 500,
  reason: 300,
  name: 100,
  telegram: 4096,
};

/** Mail clients show far less; this only keeps the header sane. */
const SUBJECT_MAX = 150;

const i18n = createFbI18n("ar");
const { t } = i18n;

/**
 * Copy that lib/facebook/i18n/ar.json does not have. Alerts are Arabic
 * whatever the recipient's interface language, so it lives here.
 */
const COPY = {
  title: "🔔 محادثة تحتاج تدخّلاً بشرياً",
  brand: "البراند",
  page: "الصفحة",
  customer: "الزبون",
  reason: "السبب",
  lastMessage: "آخر رسالة",
  open: "فتح المحادثة",
  attachment: "📎 مرفق",
  testTitle: "🧪 تنبيه تجريبي من OpenReply",
  testNote: "إذا وصلك هذا، فالتنبيهات تعمل.",
} as const;

/** The inbox's marks for a message without text, with their names. A Map: the type is Meta's free text. */
const ATTACHMENT_MARKS = new Map<string, string>([
  ["audio", `🎤 ${t("Voice message")}`],
  ["image", `📷 ${t("Image")}`],
  ["video", `🎬 ${t("Video")}`],
  ["file", `📎 ${t("File")}`],
  ["sticker", `🙂 ${t("Sticker")}`],
  ["location", `📍 ${t("Location")}`],
]);

/** Special-use and private-network names: never a public address. */
const PRIVATE_SUFFIXES = ["localhost", "local", "internal", "lan", "home.arpa", "test", "invalid", "example"];

/** `${base}/facebook/inbox?workspace=<id>&conversation=<id>`, the ids encoded, without a double slash. */
export function inboxLink(baseUrl: string, workspaceId: string, conversationId: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  return `${base}/facebook/inbox?workspace=${encodeURIComponent(workspaceId)}&conversation=${encodeURIComponent(conversationId)}`;
}

/**
 * Telegram refuses the whole message when a button's link is not a public
 * https address, so when in doubt there is no button and the link goes in
 * the text. IP addresses never get one: a public deployment has a domain.
 */
export function isButtonUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.replace(/\.$/, "");
  // Single-label names (localhost), IPv6 ([::1]) and IPv4 (127.0.0.1).
  if (!host.includes(".") || host.startsWith("[") || /^[\d.]+$/.test(host)) return false;
  return !PRIVATE_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

const graphemes = new Intl.Segmenter("ar", { granularity: "grapheme" });

const codePoints = (text: string) => Array.from(text).length;

/**
 * Keep whole graphemes while `size` allows, then add "…" (size 1 in both
 * measures used here), so an emoji, a flag or a letter with its harakat is
 * never split.
 */
function cut(text: string, max: number, size: (part: string) => number): string {
  if (size(text) <= max) return text;
  if (!(max >= 1)) return "";
  let kept = "";
  let used = 1;
  for (const { segment } of graphemes.segment(text)) {
    used += size(segment);
    if (used > max) break;
    kept += segment;
  }
  return `${kept.trimEnd()}…`;
}

/** At most `max` code points, "…" included. */
export function truncate(text: string, max: number): string {
  return cut(text, max, codePoints);
}

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Valid for Telegram too: it decodes numeric entities. */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

/** One line: runs of whitespace and control characters become a single space. */
function oneLine(text: string | null | undefined): string {
  return (text ?? "").replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
}

type LineKey = "brand" | "page" | "customer" | "category" | "reason" | "lastMessage" | "link";

interface Line {
  key: LineKey;
  label: string;
  value: string;
}

interface AlertView {
  title: string;
  lines: Line[];
  /** A closing sentence without a label. */
  note?: string;
}

function nameValue(name: string | null): string {
  return truncate(oneLine(name), ALERT_LIMITS.name);
}

function reasonValue(reason: string | null): string {
  const raw = oneLine(reason);
  return raw ? truncate(translateReason(t, raw), ALERT_LIMITS.reason) : "";
}

function lastMessageValue(message: AlertContent["lastMessage"]): string {
  if (!message) return "";
  const transcript = oneLine(message.transcript);
  if (transcript) return truncate(`🎤 ${transcript}`, ALERT_LIMITS.lastMessage);
  const text = oneLine(message.text);
  if (text) return truncate(text, ALERT_LIMITS.lastMessage);
  if (!message.attachmentType) return "";
  return ATTACHMENT_MARKS.get(message.attachmentType) ?? COPY.attachment;
}

function handoffView(content: AlertContent): AlertView {
  // A stale category in a queued job still alerts, as "Other".
  const category = isHandoffCategory(content.category) ? content.category : "OTHER";
  const lines: Line[] = [
    { key: "brand", label: COPY.brand, value: nameValue(content.brandName) },
    { key: "page", label: COPY.page, value: nameValue(content.pageName) },
    { key: "customer", label: COPY.customer, value: nameValue(content.customerName) || t("Customer") },
    { key: "category", label: t("Category"), value: i18n.category(category) },
  ];
  const reason = reasonValue(content.reason);
  if (reason) lines.push({ key: "reason", label: COPY.reason, value: reason });
  const lastMessage = lastMessageValue(content.lastMessage);
  if (lastMessage) lines.push({ key: "lastMessage", label: COPY.lastMessage, value: lastMessage });
  return { title: COPY.title, lines };
}

function testView(brandName: string): AlertView {
  return {
    title: COPY.testTitle,
    lines: [{ key: "brand", label: COPY.brand, value: nameValue(brandName) }],
    note: COPY.testNote,
  };
}

function valueOf(view: AlertView, key: LineKey): string {
  return view.lines.find((line) => line.key === key)?.value ?? "";
}

function renderTelegram({ title, lines, note }: AlertView): string {
  return [
    `<b>${escapeHtml(title)}</b>`,
    ...lines.map(({ label, value }) => `<b>${escapeHtml(label)}:</b> ${escapeHtml(value)}`),
    ...(note ? [escapeHtml(note)] : []),
  ].join("\n");
}

const escapedLength = (text: string) => escapeHtml(text).length;

/**
 * Cut first when a message is over Telegram's limit. A link only gets this
 * long by misconfiguration, and is useless once cut, so it goes before the
 * names. The title and the category always stay.
 */
const CUT_ORDER: LineKey[] = ["lastMessage", "reason", "link", "customer", "page", "brand"];

/**
 * Escaping can make a value six times longer, so values within their limits
 * can still add up to more than Telegram accepts. Cut them in CUT_ORDER,
 * each by what is still over, until the message fits; a line cut to nothing
 * goes.
 */
function telegramHtml(view: AlertView): string {
  let html = renderTelegram(view);
  let lines = view.lines;
  for (const key of CUT_ORDER) {
    const over = html.length - ALERT_LIMITS.telegram;
    if (over <= 0) break;
    lines = lines.flatMap((line) => {
      if (line.key !== key) return [line];
      const value = cut(line.value, escapedLength(line.value) - over, escapedLength);
      return value ? [{ ...line, value }] : [];
    });
    html = renderTelegram({ ...view, lines });
  }
  return html;
}

/**
 * The text for sendMessage with parse_mode "HTML", and the button for its
 * inline keyboard. Send it with link previews off, or Telegram previews a
 * link the customer wrote.
 */
export function buildTelegramAlert(content: AlertContent): { html: string; button: { text: string; url: string } | null } {
  const view = handoffView(content);
  const button = isButtonUrl(content.link) ? { text: COPY.open, url: content.link } : null;
  // Without a button the link has to be in the text.
  if (!button) view.lines.push({ key: "link", label: COPY.open, value: content.link });
  return { html: telegramHtml(view), button };
}

function emailSubject(...parts: string[]): string {
  // The parts are single lines already: no CR/LF can reach the header.
  return truncate(parts.join(" — "), SUBJECT_MAX);
}

const BUTTON_STYLE =
  "display:inline-block;padding:10px 20px;background-color:#18181b;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:bold;";

function linkHtml(link: string): string[] {
  // Only a web address becomes a button; anything else is shown, not followed.
  const button = /^https?:\/\//i.test(link)
    ? [`<p style="margin:24px 0 0;"><a href="${escapeHtml(link)}" style="${BUTTON_STYLE}">${escapeHtml(COPY.open)}</a></p>`]
    : [];
  return [
    ...button,
    `<p dir="ltr" style="margin:12px 0 0;font-size:12px;color:#71717a;text-align:right;word-break:break-all;">${escapeHtml(link)}</p>`,
  ];
}

function emailHtml(view: AlertView, subject: string, link: string | null): string {
  return [
    "<!DOCTYPE html>",
    '<html dir="rtl" lang="ar">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(subject)}</title>`,
    "</head>",
    '<body style="margin:0;padding:24px 12px;background-color:#f4f4f5;">',
    // dir again on the content: Gmail drops the attributes of <html>.
    '<div dir="rtl" lang="ar" style="max-width:560px;margin:0 auto;padding:24px;background-color:#ffffff;border-radius:8px;font-family:Tahoma,Arial,sans-serif;font-size:15px;line-height:1.6;color:#18181b;text-align:right;">',
    `<h1 style="margin:0 0 16px;font-size:18px;line-height:1.4;">${escapeHtml(view.title)}</h1>`,
    ...view.lines.map(
      ({ label, value }) => `<p style="margin:0 0 8px;"><b>${escapeHtml(label)}:</b> ${escapeHtml(value)}</p>`
    ),
    ...(view.note ? [`<p style="margin:16px 0 0;">${escapeHtml(view.note)}</p>`] : []),
    ...(link ? linkHtml(link) : []),
    "</div>",
    "</body>",
    "</html>",
  ].join("\n");
}

function emailText(view: AlertView, link: string | null): string {
  return [
    view.title,
    ...view.lines.map(({ label, value }) => `${label}: ${value}`),
    ...(view.note ? [view.note] : []),
    ...(link ? [`${COPY.open}: ${link}`] : []),
  ].join("\n");
}

export function buildEmailAlert(content: AlertContent): { subject: string; html: string; text: string } {
  const view = handoffView(content);
  const subject = emailSubject(`🔔 ${valueOf(view, "category")}`, valueOf(view, "brand"), valueOf(view, "customer"));
  return { subject, html: emailHtml(view, subject, content.link), text: emailText(view, content.link) };
}

/** The test alerts of the settings page: they only prove that a channel works. */
export function buildTestTelegramAlert(brandName: string): { html: string; button: null } {
  return { html: telegramHtml(testView(brandName)), button: null };
}

export function buildTestEmailAlert(brandName: string): { subject: string; html: string; text: string } {
  const view = testView(brandName);
  const subject = emailSubject(COPY.testTitle, valueOf(view, "brand"));
  return { subject, html: emailHtml(view, subject, null), text: emailText(view, null) };
}
