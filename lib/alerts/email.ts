/**
 * Handoff alert emails, sent the way login emails already go out (see
 * lib/auth.ts): through the SMTP server in EMAIL_SERVER when it is set,
 * otherwise through Resend's REST API with RESEND_API_KEY. An alert works
 * wherever a magic link does, with no new dependency or SDK.
 *
 * Failures are sorted into kinds the alert job acts on: it retries the
 * temporary ones and records the final ones. Their messages are stored in
 * AlertDelivery.error and shown on the alerts page, so they never carry the
 * API key or the SMTP password.
 */
import { createTransport as createSmtpTransport } from "nodemailer";

const RESEND_API_URL = "https://api.resend.com/emails";
const DEFAULT_TIMEOUT_MS = 15_000;
/** Room for a server's explanation, short enough for a log line. */
const MAX_MESSAGE_LENGTH = 500;

export interface AlertEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/**
 * What a failed send means for the alert job.
 *
 * - not_configured:    no transport (neither EMAIL_SERVER nor RESEND_API_KEY),
 *                      no sender address, or an EMAIL_SERVER nodemailer cannot read.
 * - auth:              the API key or the SMTP login was refused.
 * - invalid_recipient: the address is malformed, or the server does not know it.
 * - rejected:          any other final refusal: the sender, the content, a policy.
 * - rate_limited:      Resend's rate limit or sending quota (429).
 * - unavailable:       temporary: a 5xx, an SMTP 4xx, a timeout, a dropped
 *                      connection. After a timeout the email may still arrive,
 *                      so a retry can deliver it twice.
 * - network:           the server was never reached (DNS, connection refused).
 */
export type EmailErrorKind =
  | "not_configured"
  | "auth"
  | "invalid_recipient"
  | "rejected"
  | "rate_limited"
  | "unavailable"
  | "network";

export class EmailError extends Error {
  constructor(
    message: string,
    readonly kind: EmailErrorKind,
    readonly httpStatus?: number
  ) {
    super(message);
    this.name = "EmailError";
  }

  /** The same email may go through later, so the job should try again. */
  get retryable(): boolean {
    return this.kind === "rate_limited" || this.kind === "unavailable" || this.kind === "network";
  }
}

// ─── Settings ───────────────────────────────────────────────────────────────

function read(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

type Transport = { kind: "smtp"; server: string } | { kind: "resend"; apiKey: string };

function configuredTransport(): Transport | null {
  // Same precedence as login emails: EMAIL_SERVER takes over from Resend.
  const server = read("EMAIL_SERVER");
  if (server) return { kind: "smtp", server };
  const apiKey = read("RESEND_API_KEY");
  if (apiKey) return { kind: "resend", apiKey };
  return null;
}

/** ALERTS_EMAIL_FROM, else EMAIL_FROM, else null. Trimmed; empty means unset. */
export function getAlertsEmailFrom(): string | null {
  return read("ALERTS_EMAIL_FROM") ?? read("EMAIL_FROM");
}

/** "smtp" when EMAIL_SERVER is set, "resend" when RESEND_API_KEY is set, else null. */
export function alertEmailTransport(): "smtp" | "resend" | null {
  return configuredTransport()?.kind ?? null;
}

/** Whether alerts can be emailed at all: a transport and a sender. */
export function isAlertEmailConfigured(): boolean {
  return alertEmailTransport() !== null && getAlertsEmailFrom() !== null;
}

// ─── Addresses ──────────────────────────────────────────────────────────────

// One character an address may hold. Dots only separate the parts around
// them; whitespace, a second @ and the separators and brackets of an address
// list or a header (, ; < > : " ( ) [ ] \) never appear. Quoted local parts
// and IP literals are valid RFC 5322 but no alert recipient needs them.
const ADDRESS_CHAR = String.raw`[^\s@,;<>:"()[\]\\.]`;
const EMAIL_PATTERN = new RegExp(
  String.raw`^${ADDRESS_CHAR}+(?:\.${ADDRESS_CHAR}+)*@(?:${ADDRESS_CHAR}+\.)+${ADDRESS_CHAR}{2,}$`
);

/** NUL, DEL and the other control characters \s does not cover. */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** A plausible single address: one @, no spaces, no commas or angle brackets (prevents header injection). */
export function isValidEmail(value: string): boolean {
  return (
    typeof value === "string" &&
    value.length <= 254 && // RFC 5321's limit for a whole address
    !hasControlCharacter(value) &&
    EMAIL_PATTERN.test(value)
  );
}

// ─── Sending ────────────────────────────────────────────────────────────────

export interface EmailDependencies {
  fetchImpl?: typeof fetch;
  /**
   * For tests: replaces nodemailer.createTransport(EMAIL_SERVER). close, when
   * present, runs after the send, so a pooled EMAIL_SERVER (?pool=true)
   * leaves no connection open.
   */
  createTransport?: (server: string) => {
    sendMail(mail: Record<string, unknown>): Promise<{ messageId?: string }>;
    close?(): void;
  };
  /**
   * How long one send may take, over Resend or SMTP (default 15000). Without
   * it a stalled SMTP server would hold a worker slot for nodemailer's own
   * timeouts, up to ten minutes.
   */
  timeoutMs?: number;
}

type SmtpTransportFactory = NonNullable<EmailDependencies["createTransport"]>;
type OutgoingMail = { from: string; to: string; subject: string; html: string; text: string };

export async function sendAlertEmail(
  email: AlertEmail,
  deps: EmailDependencies = {}
): Promise<{ id: string | null; transport: "smtp" | "resend" }> {
  const transport = configuredTransport();
  if (!transport) {
    throw new EmailError(
      "Email is not set up: set EMAIL_SERVER (SMTP) or RESEND_API_KEY (Resend)",
      "not_configured"
    );
  }
  const from = getAlertsEmailFrom();
  if (!from) {
    throw new EmailError("Alert emails need a sender: set ALERTS_EMAIL_FROM or EMAIL_FROM", "not_configured");
  }
  // Checked before any transport sees them: a comma or a line break would
  // add a recipient or a header.
  if (!isValidEmail(email.to)) {
    throw new EmailError("The recipient is not a valid email address", "invalid_recipient");
  }
  if (/[\r\n]/.test(email.subject)) {
    throw new EmailError("The subject must be a single line", "rejected");
  }

  const mail: OutgoingMail = { from, to: email.to, subject: email.subject, html: email.html, text: email.text };
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const id =
      transport.kind === "smtp"
        ? await sendWithSmtp(transport.server, mail, deps.createTransport ?? createSmtpTransport, timeoutMs)
        : await sendWithResend(transport.apiKey, mail, deps.fetchImpl ?? fetch, timeoutMs);
    return { id, transport: transport.kind };
  } catch (error) {
    throw withoutSecrets(error);
  }
}

async function sendWithResend(
  apiKey: string,
  mail: OutgoingMail,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<string | null> {
  let response: Response;
  try {
    response = await fetchImpl(RESEND_API_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: mail.from,
        to: [mail.to],
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const name = (error as { name?: unknown } | null)?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      throw new EmailError("Resend did not answer in time", "unavailable");
    }
    throw new EmailError(`Could not reach Resend: ${describe(error)}`, "network");
  }

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw resendError(response.status, body);
  // A 2xx means Resend took the email, even if its id did not come back.
  const id = (body as { id?: unknown } | null)?.id;
  return typeof id === "string" && id ? id : null;
}

// A validation error that names the "to" field: the address itself is wrong.
const ABOUT_RECIPIENT = /["'`]to["'`]|\bto (?:field|address)|recipient/i;

/** Resend error bodies look like { statusCode, name: "validation_error", message }. */
function resendError(status: number, body: unknown): EmailError {
  const { name, message } = (body ?? {}) as { name?: unknown; message?: unknown };
  const label = typeof name === "string" && name ? ` ${name}` : "";
  const detail = typeof message === "string" ? message.trim() : "";
  return new EmailError(
    `Resend answered HTTP ${status}${label}${detail ? `: ${detail}` : ""}`,
    resendKind(status, detail),
    status
  );
}

function resendKind(status: number, detail: string): EmailErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limited";
  if (status === 408 || status >= 500) return "unavailable";
  if ((status === 400 || status === 422) && ABOUT_RECIPIENT.test(detail)) return "invalid_recipient";
  return "rejected";
}

async function sendWithSmtp(
  server: string,
  mail: OutgoingMail,
  createTransport: SmtpTransportFactory,
  timeoutMs: number
): Promise<string | null> {
  let transport: ReturnType<SmtpTransportFactory>;
  try {
    transport = createTransport(server);
  } catch {
    // nodemailer throws for anything but an smtp:// or smtps:// URL, and its
    // message quotes the whole value, password included: none of it is kept.
    throw new EmailError(
      "EMAIL_SERVER is not an SMTP URL like smtps://user:password@host:465",
      "not_configured"
    );
  }

  try {
    const info = await withDeadline(transport.sendMail(mail), timeoutMs);
    // Over LMTP a refused recipient comes back in the result instead of an
    // error. Auth.js checks the same list for login emails.
    const rejected = (info as { rejected?: unknown } | null | undefined)?.rejected;
    if (Array.isArray(rejected) && rejected.length > 0) {
      throw new EmailError("The SMTP server refused the recipient", "invalid_recipient");
    }
    return typeof info?.messageId === "string" && info.messageId ? info.messageId : null;
  } catch (error) {
    throw error instanceof EmailError ? error : smtpError(error);
  } finally {
    try {
      transport.close?.();
    } catch {
      // Closing only frees pooled connections; the outcome is already known.
    }
  }
}

/**
 * The send, or "unavailable" once timeoutMs has passed. nodemailer cannot
 * cancel a send, so a slow server may still deliver after this gives up.
 */
async function withDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new EmailError("The SMTP server did not answer in time", "unavailable")),
      timeoutMs
    );
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Fields nodemailer sets on its errors. Its code replaces the system one (ECONNREFUSED becomes ESOCKET). */
interface SmtpFailure {
  code?: unknown;
  responseCode?: unknown;
  command?: unknown;
  response?: unknown;
  syscall?: unknown;
}

// 530 authentication required, 534 mechanism too weak, 535 bad credentials,
// 538 encryption required: the login is at fault, whichever command got it.
const AUTH_REPLIES = new Set([530, 534, 535, 538]);

function smtpError(error: unknown): EmailError {
  const failure = (typeof error === "object" && error !== null ? error : {}) as SmtpFailure;
  const code = typeof failure.code === "string" ? failure.code : undefined;
  const command = typeof failure.command === "string" ? failure.command : undefined;
  const reply = typeof failure.responseCode === "number" ? failure.responseCode : undefined;
  const response = typeof failure.response === "string" ? failure.response : "";
  const detail = error instanceof Error ? error.message : String(error);
  const where = [code, command && `at ${command}`].filter(Boolean).join(" ");
  return new EmailError(
    `SMTP send failed${where ? ` (${where})` : ""}: ${detail}`,
    smtpKind(code, command, reply, response, failure.syscall, detail)
  );
}

function smtpKind(
  code: string | undefined,
  command: string | undefined,
  reply: number | undefined,
  response: string,
  syscall: unknown,
  detail: string
): EmailErrorKind {
  // The reply code speaks first: 4xx is SMTP's "try again later", even for a
  // login (454) or a recipient (450-452, greylisting).
  if (reply !== undefined && reply >= 400 && reply < 500) return "unavailable";
  if (code === "EAUTH" || code === "NoAuth" || (reply !== undefined && AUTH_REPLIES.has(reply))) return "auth";
  if (code === "EENVELOPE" && isAboutRecipient(command, detail)) {
    // 5.7.x is a policy refusal (no relaying, sender not allowed), not a
    // wrong address. Postfix reports a refused sender at RCPT TO this way.
    const policy = /^5\d\d[ -]5\.7\./.test(response);
    return reply === undefined || (reply >= 550 && reply <= 553 && !policy) ? "invalid_recipient" : "rejected";
  }
  if ((reply !== undefined && reply >= 500) || code === "EENVELOPE" || code === "EMESSAGE") return "rejected";
  // Never reached the server: the name did not resolve, or nothing listened.
  if (code === "EDNS" || (code === "ESOCKET" && syscall === "connect")) return "network";
  // ETIMEDOUT, ECONNECTION, ETLS, EPROTOCOL, a socket closed mid-send...
  return "unavailable";
}

/** RCPT TO, or nodemailer's own checks of the recipient before it sends. */
function isAboutRecipient(command: string | undefined, detail: string): boolean {
  if (command === "MAIL FROM" || command === "DATA") return false;
  return !(command === "API" && /sender/i.test(detail));
}

// ─── Messages ───────────────────────────────────────────────────────────────

/** An error's message, with the system code fetch keeps in its cause (ENOTFOUND...). */
function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof code === "string" ? `${message} [${code}]` : message;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Values no message may show: the Resend key, EMAIL_SERVER and the password inside it. */
function secrets(): string[] {
  const server = read("EMAIL_SERVER");
  const found = [read("RESEND_API_KEY"), server];
  if (server) {
    try {
      const { password } = new URL(server);
      found.push(password, safeDecode(password));
    } catch {
      // Not a URL: the whole value is hidden already.
    }
  }
  // Longest first, so a secret that contains another one is hidden whole.
  return [...new Set(found)]
    .filter((value): value is string => Boolean(value))
    .sort((a, b) => b.length - a.length);
}

/**
 * The error as it leaves this module: secrets hidden, on one line, clipped.
 * A new error on purpose, without the original as its cause: loggers print
 * causes, and nodemailer's own messages can quote EMAIL_SERVER.
 */
function withoutSecrets(error: unknown): EmailError {
  const source = error instanceof EmailError ? error : new EmailError(describe(error), "unavailable");
  let message = source.message;
  for (const secret of secrets()) message = message.split(secret).join("[hidden]");
  message = message.replace(/\s+/g, " ").trim();
  if (message.length > MAX_MESSAGE_LENGTH) message = `${message.slice(0, MAX_MESSAGE_LENGTH - 1)}…`;
  return new EmailError(message, source.kind, source.httpStatus);
}
