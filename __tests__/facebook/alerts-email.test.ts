import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// No test may reach a real SMTP server: nodemailer is replaced for the whole file.
const { createTransport } = vi.hoisted(() => ({ createTransport: vi.fn() }));
vi.mock("nodemailer", () => ({ createTransport, default: { createTransport } }));

import {
  alertEmailTransport,
  EmailError,
  getAlertsEmailFrom,
  isAlertEmailConfigured,
  isValidEmail,
  sendAlertEmail,
  type AlertEmail,
  type EmailErrorKind,
} from "../../lib/alerts/email";

const API_KEY = "re_Live_Secret_123";
// Characters that must be URL-encoded, so the encoded and plain forms differ.
const SMTP_PASSWORD = "s3cr3t/p@ss";
const SMTP_URL = `smtps://alerts%40example.com:${encodeURIComponent(SMTP_PASSWORD)}@mail.example.com:465`;
const FROM = "Amitec Reply <alerts@example.com>";

const email: AlertEmail = {
  to: "owner@example.com",
  subject: "طلبية جملة: Amina needs a person",
  html: "<p>Amina asked for a wholesale price.</p>",
  text: "Amina asked for a wholesale price.",
};

beforeEach(() => {
  // A clean slate whatever the machine's environment holds; empty means unset.
  for (const name of ["EMAIL_SERVER", "RESEND_API_KEY", "ALERTS_EMAIL_FROM", "EMAIL_FROM"]) {
    vi.stubEnv(name, "");
  }
  createTransport.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function useResend() {
  vi.stubEnv("RESEND_API_KEY", API_KEY);
  vi.stubEnv("EMAIL_FROM", FROM);
}

function useSmtp() {
  vi.stubEnv("EMAIL_SERVER", SMTP_URL);
  vi.stubEnv("EMAIL_FROM", FROM);
}

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** A stand-in for nodemailer's transport, whose sendMail does what `outcome` says. */
function fakeSmtp(outcome: () => Promise<{ messageId?: string; rejected?: string[] }>) {
  const sendMail = vi.fn(outcome);
  const close = vi.fn();
  return { sendMail, close, createTransport: vi.fn(() => ({ sendMail, close })) };
}

/** An error shaped like nodemailer's: its message plus code, responseCode, command... */
function smtpFailure(message: string, fields: Record<string, unknown> = {}) {
  return Object.assign(new Error(message), fields);
}

/** The EmailError a send fails with. */
async function failure(send: Promise<unknown>): Promise<EmailError> {
  const error = await send.then(
    () => {
      throw new Error("the send was expected to fail");
    },
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(EmailError);
  return error as EmailError;
}

describe("configuration", () => {
  it("sends over SMTP when EMAIL_SERVER is set, as login emails do, else over Resend", () => {
    vi.stubEnv("RESEND_API_KEY", API_KEY);
    expect(alertEmailTransport()).toBe("resend");
    vi.stubEnv("EMAIL_SERVER", SMTP_URL);
    expect(alertEmailTransport()).toBe("smtp");
    vi.stubEnv("EMAIL_SERVER", "   ");
    expect(alertEmailTransport()).toBe("resend");
    vi.stubEnv("RESEND_API_KEY", "");
    expect(alertEmailTransport()).toBeNull();
  });

  it("takes the sender from ALERTS_EMAIL_FROM, then EMAIL_FROM", () => {
    expect(getAlertsEmailFrom()).toBeNull();
    vi.stubEnv("EMAIL_FROM", "  Amitec Reply <login@example.com> ");
    expect(getAlertsEmailFrom()).toBe("Amitec Reply <login@example.com>");
    vi.stubEnv("ALERTS_EMAIL_FROM", "Amitec Reply Alerts <alerts@example.com>");
    expect(getAlertsEmailFrom()).toBe("Amitec Reply Alerts <alerts@example.com>");
    vi.stubEnv("ALERTS_EMAIL_FROM", " ");
    expect(getAlertsEmailFrom()).toBe("Amitec Reply <login@example.com>");
  });

  it("is configured only with both a transport and a sender", () => {
    expect(isAlertEmailConfigured()).toBe(false);
    vi.stubEnv("RESEND_API_KEY", API_KEY);
    expect(isAlertEmailConfigured()).toBe(false);
    vi.stubEnv("ALERTS_EMAIL_FROM", FROM);
    expect(isAlertEmailConfigured()).toBe(true);
    vi.stubEnv("RESEND_API_KEY", "");
    expect(isAlertEmailConfigured()).toBe(false);
    vi.stubEnv("EMAIL_SERVER", SMTP_URL);
    expect(isAlertEmailConfigured()).toBe(true);
  });

  it("sends nothing without a transport or a sender", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const smtp = fakeSmtp(async () => ({ messageId: "<m@example.com>" }));
    const deps = { fetchImpl, createTransport: smtp.createTransport };

    vi.stubEnv("EMAIL_FROM", FROM);
    const noTransport = await failure(sendAlertEmail(email, deps));
    expect(noTransport.kind).toBe("not_configured");
    expect(noTransport.message).toContain("EMAIL_SERVER");
    expect(noTransport.message).toContain("RESEND_API_KEY");

    vi.stubEnv("EMAIL_FROM", "");
    vi.stubEnv("RESEND_API_KEY", API_KEY);
    const noSender = await failure(sendAlertEmail(email, deps));
    expect(noSender.kind).toBe("not_configured");
    expect(noSender.message).toContain("ALERTS_EMAIL_FROM");
    vi.stubEnv("EMAIL_SERVER", SMTP_URL);
    expect((await failure(sendAlertEmail(email, deps))).kind).toBe("not_configured");

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(smtp.createTransport).not.toHaveBeenCalled();
    expect(createTransport).not.toHaveBeenCalled();
  });

  it("reads the environment again on every send", async () => {
    useResend();
    const fetchImpl = vi.fn<typeof fetch>(async () => reply({ id: "re_1" }));
    const smtp = fakeSmtp(async () => ({ messageId: "<m1@example.com>" }));
    const deps = { fetchImpl, createTransport: smtp.createTransport };
    await expect(sendAlertEmail(email, deps)).resolves.toEqual({ id: "re_1", transport: "resend" });
    vi.stubEnv("EMAIL_SERVER", SMTP_URL);
    await expect(sendAlertEmail(email, deps)).resolves.toEqual({ id: "<m1@example.com>", transport: "smtp" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(smtp.sendMail).toHaveBeenCalledTimes(1);
  });
});

describe("isValidEmail", () => {
  it.each([
    "owner@example.com",
    "first.last+alerts@mail.example.co.uk",
    "o'brien@example.ie",
    "ventes_dz-2@xn--ngbrx.example",
  ])("accepts %s", (value) => {
    expect(isValidEmail(value)).toBe(true);
  });

  it.each([
    "",
    "owner",
    "owner@",
    "@example.com",
    "owner@example",
    "owner@@example.com",
    "owner@sales@example.com",
    "owner @example.com",
    "owner@example.com ",
    ".owner@example.com",
    "owner..sales@example.com",
    "owner@example..com",
    "owner@example.com,spy@example.com",
    "owner@example.com;spy@example.com",
    "Owner <owner@example.com>",
    "<owner@example.com>",
    "owner@example.com\r\nBcc: spy@example.com",
    "owner@example.com\nBcc: spy@example.com",
    "owner\u0000@example.com",
    '"owner"@example.com',
    "owner@[192.0.2.1]",
    `${"a".repeat(243)}@example.com`,
  ])("refuses %j", (value) => {
    expect(isValidEmail(value)).toBe(false);
  });

  it("refuses a missing address, as a null email column would give", () => {
    expect(isValidEmail(null as unknown as string)).toBe(false);
    expect(isValidEmail(undefined as unknown as string)).toBe(false);
  });
});

describe("Resend", () => {
  it("posts the alert to Resend's API with the key in a header, and returns the email id", async () => {
    useResend();
    const fetchImpl = vi.fn<typeof fetch>(async () => reply({ id: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c" }));
    await expect(sendAlertEmail(email, { fetchImpl })).resolves.toEqual({
      id: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c",
      transport: "resend",
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual({
      from: FROM,
      to: ["owner@example.com"],
      subject: email.subject,
      html: email.html,
      text: email.text,
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(createTransport).not.toHaveBeenCalled();
  });

  it("sends from ALERTS_EMAIL_FROM rather than the login sender", async () => {
    useResend();
    vi.stubEnv("ALERTS_EMAIL_FROM", "Amitec Reply Alerts <alerts@example.com>");
    const fetchImpl = vi.fn<typeof fetch>(async () => reply({ id: "re_2" }));
    await sendAlertEmail(email, { fetchImpl });
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(init.body as string).from).toBe("Amitec Reply Alerts <alerts@example.com>");
  });

  it("counts a 2xx without an id as sent", async () => {
    useResend();
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
    await expect(sendAlertEmail(email, { fetchImpl })).resolves.toEqual({ id: null, transport: "resend" });
  });

  it.each<{ status: number; body: unknown; kind: EmailErrorKind; retryable: boolean }>([
    {
      status: 401,
      body: { statusCode: 401, name: "missing_api_key", message: "Missing API key in the authorization header." },
      kind: "auth",
      retryable: false,
    },
    {
      status: 403,
      body: { statusCode: 403, name: "invalid_api_key", message: "API key is invalid" },
      kind: "auth",
      retryable: false,
    },
    {
      status: 422,
      body: {
        statusCode: 422,
        name: "validation_error",
        message:
          "Invalid `to` field. The email address needs to follow the `email@example.com` or `Name <email@example.com>` format.",
      },
      kind: "invalid_recipient",
      retryable: false,
    },
    {
      status: 422,
      body: {
        statusCode: 422,
        name: "invalid_from_address",
        message:
          "Invalid `from` field. The email address needs to follow the `email@example.com` or `Name <email@example.com>` format.",
      },
      kind: "rejected",
      retryable: false,
    },
    {
      status: 404,
      body: { statusCode: 404, name: "not_found", message: "The requested endpoint does not exist." },
      kind: "rejected",
      retryable: false,
    },
    {
      status: 429,
      body: { statusCode: 429, name: "rate_limit_exceeded", message: "Too many requests." },
      kind: "rate_limited",
      retryable: true,
    },
    {
      status: 500,
      body: { statusCode: 500, name: "internal_server_error", message: "An unexpected error occurred." },
      kind: "unavailable",
      retryable: true,
    },
    { status: 503, body: "<html>503 Service Unavailable</html>", kind: "unavailable", retryable: true },
  ])("HTTP $status is $kind", async ({ status, body, kind, retryable }) => {
    useResend();
    const response = typeof body === "string" ? new Response(body, { status }) : reply(body, status);
    const error = await failure(sendAlertEmail(email, { fetchImpl: vi.fn<typeof fetch>(async () => response) }));
    expect(error.kind).toBe(kind);
    expect(error.retryable).toBe(retryable);
    expect(error.httpStatus).toBe(status);
    expect(error.message).toContain(`HTTP ${status}`);
    if (typeof body !== "string") expect(error.message).toContain((body as { message: string }).message);
  });

  it("treats a fetch that throws as a network error", async () => {
    useResend();
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.resend.com"), { code: "ENOTFOUND" }),
      });
    });
    const error = await failure(sendAlertEmail(email, { fetchImpl }));
    expect(error.kind).toBe("network");
    expect(error.retryable).toBe(true);
    expect(error.httpStatus).toBeUndefined();
    expect(error.message).toContain("ENOTFOUND");
  });

  it("gives up after timeoutMs without an answer, as unavailable", async () => {
    useResend();
    // Honors the abort signal like the real fetch: rejects with its TimeoutError.
    const fetchImpl = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        })
    );
    const error = await failure(sendAlertEmail(email, { fetchImpl, timeoutMs: 20 }));
    expect(error.kind).toBe("unavailable");
    expect(error.retryable).toBe(true);
  });
});

describe("SMTP", () => {
  it("hands EMAIL_SERVER to nodemailer.createTransport, even with a Resend key set", async () => {
    useSmtp();
    vi.stubEnv("RESEND_API_KEY", API_KEY);
    const sendMail = vi.fn(async () => ({
      messageId: "<b3e1983a-64cb-2d16-30f2-dd7cbad601fc@example.com>",
      accepted: ["owner@example.com"],
      rejected: [],
    }));
    createTransport.mockReturnValue({ sendMail, close: vi.fn() });
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(sendAlertEmail(email, { fetchImpl })).resolves.toEqual({
      id: "<b3e1983a-64cb-2d16-30f2-dd7cbad601fc@example.com>",
      transport: "smtp",
    });
    expect(createTransport).toHaveBeenCalledWith(SMTP_URL);
    expect(sendMail).toHaveBeenCalledWith({
      from: FROM,
      to: "owner@example.com",
      subject: email.subject,
      html: email.html,
      text: email.text,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses an injected createTransport and closes it after the send", async () => {
    useSmtp();
    const smtp = fakeSmtp(async () => ({}));
    await expect(sendAlertEmail(email, { createTransport: smtp.createTransport })).resolves.toEqual({
      id: null,
      transport: "smtp",
    });
    expect(smtp.createTransport).toHaveBeenCalledWith(SMTP_URL);
    expect(smtp.close).toHaveBeenCalledTimes(1);
    expect(createTransport).not.toHaveBeenCalled();
  });

  // Shapes recorded from nodemailer 7 against a test SMTP server.
  it.each<{ name: string; error: Error; kind: EmailErrorKind }>([
    {
      name: "wrong password (EAUTH 535)",
      error: smtpFailure("Invalid login: 535 5.7.8 Authentication credentials invalid", {
        code: "EAUTH",
        responseCode: 535,
        command: "AUTH PLAIN",
        response: "535 5.7.8 Authentication credentials invalid",
      }),
      kind: "auth",
    },
    {
      name: "login refused for now (EAUTH 454)",
      error: smtpFailure("Invalid login: 454 4.7.0 Too many login attempts, try later", {
        code: "EAUTH",
        responseCode: 454,
        command: "AUTH PLAIN",
        response: "454 4.7.0 Too many login attempts, try later",
      }),
      kind: "unavailable",
    },
    {
      name: "login required (530 at MAIL FROM)",
      error: smtpFailure("Mail command failed: 530 5.7.0 Authentication required", {
        code: "EENVELOPE",
        responseCode: 530,
        command: "MAIL FROM",
        response: "530 5.7.0 Authentication required",
      }),
      kind: "auth",
    },
    {
      name: "unknown recipient (EENVELOPE 550 5.1.1)",
      error: smtpFailure(
        "Can't send mail - all recipients were rejected: 550 5.1.1 <owner@example.com>: Recipient address rejected: User unknown",
        {
          code: "EENVELOPE",
          responseCode: 550,
          command: "RCPT TO",
          response: "550 5.1.1 <owner@example.com>: Recipient address rejected: User unknown",
          rejected: ["owner@example.com"],
        }
      ),
      kind: "invalid_recipient",
    },
    {
      name: "greylisted recipient (EENVELOPE 451)",
      error: smtpFailure("Can't send mail - all recipients were rejected: 451 4.7.1 Greylisted, try again later", {
        code: "EENVELOPE",
        responseCode: 451,
        command: "RCPT TO",
        response: "451 4.7.1 Greylisted, try again later",
        rejected: ["owner@example.com"],
      }),
      kind: "unavailable",
    },
    {
      name: "relaying denied (554 at RCPT TO)",
      error: smtpFailure(
        "Can't send mail - all recipients were rejected: 554 5.7.1 <owner@example.com>: Relay access denied",
        {
          code: "EENVELOPE",
          responseCode: 554,
          command: "RCPT TO",
          response: "554 5.7.1 <owner@example.com>: Relay access denied",
        }
      ),
      kind: "rejected",
    },
    {
      name: "sender refused at RCPT TO, as Postfix does (553 5.7.1)",
      error: smtpFailure(
        "Can't send mail - all recipients were rejected: 553 5.7.1 <alerts@example.com>: Sender address rejected: not owned by user",
        {
          code: "EENVELOPE",
          responseCode: 553,
          command: "RCPT TO",
          response: "553 5.7.1 <alerts@example.com>: Sender address rejected: not owned by user",
        }
      ),
      kind: "rejected",
    },
    {
      name: "sender refused (553 at MAIL FROM)",
      error: smtpFailure("Mail command failed: 553 5.7.1 <alerts@example.com>: Sender address rejected", {
        code: "EENVELOPE",
        responseCode: 553,
        command: "MAIL FROM",
        response: "553 5.7.1 <alerts@example.com>: Sender address rejected",
      }),
      kind: "rejected",
    },
    {
      name: "content refused (EMESSAGE 550)",
      error: smtpFailure("Message failed: 550 5.7.1 Message rejected as spam", {
        code: "EMESSAGE",
        responseCode: 550,
        command: "DATA",
        response: "550 5.7.1 Message rejected as spam",
      }),
      kind: "rejected",
    },
    {
      name: "no recipient, refused by nodemailer itself (EENVELOPE)",
      error: smtpFailure("No recipients defined", { code: "EENVELOPE", command: "API" }),
      kind: "invalid_recipient",
    },
    {
      name: "greeting never received (ETIMEDOUT)",
      error: smtpFailure("Greeting never received", { code: "ETIMEDOUT", command: "CONN" }),
      kind: "unavailable",
    },
    {
      name: "connection dropped (ECONNECTION)",
      error: smtpFailure("Connection closed unexpectedly", { code: "ECONNECTION", command: "CONN" }),
      kind: "unavailable",
    },
    {
      name: "server down for maintenance (421 greeting)",
      error: smtpFailure("Invalid greeting. response=421 4.3.2 Service not available", {
        code: "EPROTOCOL",
        responseCode: 421,
        command: "CONN",
        response: "421 4.3.2 Service not available",
      }),
      kind: "unavailable",
    },
    {
      name: "connection refused (ESOCKET at connect)",
      error: smtpFailure("connect ECONNREFUSED 192.0.2.10:465", {
        code: "ESOCKET",
        command: "CONN",
        syscall: "connect",
        errno: -111,
      }),
      kind: "network",
    },
    {
      name: "unknown host (EDNS)",
      error: smtpFailure("getaddrinfo ENOTFOUND mail.example.com", {
        code: "EDNS",
        command: "CONN",
        syscall: "getaddrinfo",
      }),
      kind: "network",
    },
    { name: "socket closed mid-send (no code)", error: smtpFailure("Unexpected socket close"), kind: "unavailable" },
  ])("$name is $kind", async ({ error, kind }) => {
    useSmtp();
    const smtp = fakeSmtp(async () => {
      throw error;
    });
    const failed = await failure(sendAlertEmail(email, { createTransport: smtp.createTransport }));
    expect(failed.kind).toBe(kind);
    // The server's own explanation is kept for the alerts page.
    expect(failed.message).toContain(error.message);
    expect(smtp.close).toHaveBeenCalledTimes(1);
  });

  it("keeps a multi-line server reply on one line", async () => {
    useSmtp();
    const response =
      "550-5.1.1 The email account that you tried to reach does not exist.\n550 5.1.1 Please check the address.";
    const smtp = fakeSmtp(async () => {
      throw smtpFailure(`Can't send mail - all recipients were rejected: ${response}`, {
        code: "EENVELOPE",
        responseCode: 550,
        command: "RCPT TO",
        response,
      });
    });
    const failed = await failure(sendAlertEmail(email, { createTransport: smtp.createTransport }));
    expect(failed.kind).toBe("invalid_recipient");
    expect(failed.message).not.toMatch(/[\r\n]/);
    expect(failed.message).toContain("does not exist. 550 5.1.1 Please check the address.");
  });

  it("fails when the server lists the recipient as rejected without an error (LMTP)", async () => {
    useSmtp();
    const smtp = fakeSmtp(async () => ({ messageId: "<m@example.com>", rejected: ["owner@example.com"] }));
    const failed = await failure(sendAlertEmail(email, { createTransport: smtp.createTransport }));
    expect(failed.kind).toBe("invalid_recipient");
  });

  it("gives up on a server that never answers after timeoutMs, as unavailable", async () => {
    useSmtp();
    const smtp = fakeSmtp(() => new Promise(() => {}));
    const failed = await failure(sendAlertEmail(email, { createTransport: smtp.createTransport, timeoutMs: 20 }));
    expect(failed.kind).toBe("unavailable");
    expect(failed.retryable).toBe(true);
    expect(smtp.close).toHaveBeenCalledTimes(1);
  });

  it("reports an EMAIL_SERVER nodemailer cannot read as not_configured, without quoting it", async () => {
    const malformed = `smtp//alerts:${SMTP_PASSWORD}@mail.example.com:587`;
    vi.stubEnv("EMAIL_SERVER", malformed);
    vi.stubEnv("EMAIL_FROM", FROM);
    // What nodemailer 7 throws for a value that is not an smtp:// URL.
    createTransport.mockImplementation((server: string) => {
      throw new TypeError(`Cannot create property 'mailer' on string '${server}'`);
    });
    const failed = await failure(sendAlertEmail(email));
    expect(failed.kind).toBe("not_configured");
    expect(failed.retryable).toBe(false);
    expect(failed.message).toContain("EMAIL_SERVER");
    expect(failed.message).not.toContain(SMTP_PASSWORD);
  });
});

describe("refused before any transport", () => {
  it.each([
    "owner@example.com, spy@example.com",
    "owner@example.com\r\nBcc: spy@example.com",
    "Owner <owner@example.com>",
    "not-an-address",
    "",
  ])("the recipient %j", async (to) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => reply({ id: "re_x" }));
    const smtp = fakeSmtp(async () => ({ messageId: "<x@example.com>" }));
    const deps = { fetchImpl, createTransport: smtp.createTransport };

    useResend();
    const viaResend = await failure(sendAlertEmail({ ...email, to }, deps));
    expect(viaResend.kind).toBe("invalid_recipient");
    expect(viaResend.retryable).toBe(false);
    vi.stubEnv("EMAIL_SERVER", SMTP_URL);
    expect((await failure(sendAlertEmail({ ...email, to }, deps))).kind).toBe("invalid_recipient");

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(smtp.createTransport).not.toHaveBeenCalled();
  });

  it.each(["Handoff\r\nBcc: spy@example.com", "Handoff\nX-Priority: 1", "Handoff\r"])(
    "the subject %j",
    async (subject) => {
      const fetchImpl = vi.fn<typeof fetch>(async () => reply({ id: "re_x" }));
      const smtp = fakeSmtp(async () => ({ messageId: "<x@example.com>" }));
      const deps = { fetchImpl, createTransport: smtp.createTransport };

      useResend();
      expect((await failure(sendAlertEmail({ ...email, subject }, deps))).kind).toBe("rejected");
      vi.stubEnv("EMAIL_SERVER", SMTP_URL);
      expect((await failure(sendAlertEmail({ ...email, subject }, deps))).kind).toBe("rejected");

      expect(fetchImpl).not.toHaveBeenCalled();
      expect(smtp.createTransport).not.toHaveBeenCalled();
    }
  );
});

describe("secrets", () => {
  it("never shows the Resend key, even when an error quotes it", async () => {
    useResend();
    const echoed = await failure(
      sendAlertEmail(email, {
        fetchImpl: vi.fn<typeof fetch>(async () =>
          reply({ statusCode: 403, name: "invalid_api_key", message: `API key ${API_KEY} is invalid` }, 403)
        ),
      })
    );
    expect(echoed.kind).toBe("auth");
    expect(echoed.message).not.toContain(API_KEY);
    expect(echoed.message).toContain("is invalid");

    const thrown = await failure(
      sendAlertEmail(email, {
        fetchImpl: vi.fn<typeof fetch>(async () => {
          throw new TypeError(`request with Bearer ${API_KEY} failed`);
        }),
      })
    );
    expect(thrown.kind).toBe("network");
    expect(thrown.message).not.toContain(API_KEY);
  });

  it("never shows the SMTP password, plain or URL-encoded, nor EMAIL_SERVER", async () => {
    useSmtp();
    vi.stubEnv("RESEND_API_KEY", API_KEY);
    const leaky = smtpFailure(
      `Invalid login to ${SMTP_URL}: 535 password ${SMTP_PASSWORD} (${encodeURIComponent(SMTP_PASSWORD)}) refused, key ${API_KEY}`,
      { code: "EAUTH", responseCode: 535, command: "AUTH PLAIN" }
    );
    const smtp = fakeSmtp(async () => {
      throw leaky;
    });
    const failed = await failure(sendAlertEmail(email, { createTransport: smtp.createTransport }));
    expect(failed.kind).toBe("auth");
    for (const secret of [SMTP_URL, SMTP_PASSWORD, encodeURIComponent(SMTP_PASSWORD), API_KEY]) {
      expect(failed.message).not.toContain(secret);
    }
    expect(failed.message).toContain("535");
    // The original error still holds them, so it is not attached as the cause.
    expect(failed.cause).toBeUndefined();
  });
});

describe("EmailError", () => {
  it.each<[EmailErrorKind, boolean]>([
    ["not_configured", false],
    ["auth", false],
    ["invalid_recipient", false],
    ["rejected", false],
    ["rate_limited", true],
    ["unavailable", true],
    ["network", true],
  ])("%s retryable: %s", (kind, retryable) => {
    const error = new EmailError("Resend answered HTTP 500", kind, 500);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("EmailError");
    expect(error.kind).toBe(kind);
    expect(error.httpStatus).toBe(500);
    expect(error.retryable).toBe(retryable);
  });
});
