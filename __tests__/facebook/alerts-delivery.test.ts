import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";
import { Prisma } from "../../app/generated/prisma/client";

const db = vi.hoisted(() => ({
  facebookConversationEvent: { findUnique: vi.fn(), findMany: vi.fn() },
  facebookConversation: { findUnique: vi.fn() },
  facebookMessage: { findFirst: vi.fn() },
  workspace: { findUnique: vi.fn() },
  alertRecipient: { findMany: vi.fn(), findFirst: vi.fn() },
  alertDelivery: { create: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  alertSettings: { findUnique: vi.fn() },
}));
const telegram = vi.hoisted(() => ({ telegramSendMessage: vi.fn() }));
const email = vi.hoisted(() => ({ sendAlertEmail: vi.fn() }));
const queue = vi.hoisted(() => ({ add: vi.fn() }));

vi.mock("@/lib/db/client", () => ({ prisma: db }));
vi.mock("@/lib/alerts/telegram", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/alerts/telegram")>()),
  ...telegram,
}));
vi.mock("@/lib/alerts/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/alerts/email")>()),
  ...email,
}));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: (value: string) => `plain:${value}`, encryptToken: (value: string) => value }));
vi.mock("@/lib/facebook/queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/facebook/queue")>()),
  getFacebookQueue: () => queue,
}));

import {
  ALERT_ATTEMPTS,
  alertBackoff,
  enqueueHandoffAlerts,
  processAlertJob,
  sendTestAlerts,
  sweepUnqueuedHandoffs,
} from "../../lib/alerts/dispatch";
import { TelegramError } from "../../lib/alerts/telegram";
import { EmailError } from "../../lib/alerts/email";
import { alertJobId, type AlertSendJob } from "../../lib/facebook/queue";

const TELEGRAM = { id: "rc_tg", workspaceId: "ws_a", channel: "TELEGRAM", label: "Sales group", telegramChatId: "-100123", email: null, isActive: true, isDefault: false };
const EMAIL = { id: "rc_mail", workspaceId: "ws_a", channel: "EMAIL", label: "Owner", telegramChatId: null, email: "owner@shop.dz", isActive: true, isDefault: true };
const EVENT = { id: "evt_1", workspaceId: "ws_a", conversationId: "conv_1", type: "HANDOFF", category: "COMPLAINT", reason: "الكولي وصل مكسور" };

function delivery(overrides: Record<string, unknown> = {}) {
  return {
    id: "dl_1",
    workspaceId: "ws_a",
    conversationId: "conv_1",
    eventId: "evt_1",
    recipientId: "rc_tg",
    channel: "TELEGRAM",
    category: "COMPLAINT",
    dedupeKey: "handoff:evt_1:rc_tg",
    isTest: false,
    status: "PENDING",
    attempts: 0,
    error: null,
    ...overrides,
  };
}

function job(attemptsMade = 0) {
  return { id: "alert_dl_1", name: "alert-send", attemptsMade, opts: { attempts: ALERT_ATTEMPTS }, data: { deliveryId: "dl_1" } } as unknown as Job<AlertSendJob>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXTAUTH_URL", "https://bot.example.com");
  db.facebookConversationEvent.findUnique.mockResolvedValue(EVENT);
  db.facebookConversation.findUnique.mockResolvedValue({
    id: "conv_1",
    userName: "Amina B.",
    handoffReason: "الكولي وصل مكسور",
    page: { name: "Lina Outlet" },
  });
  db.facebookMessage.findFirst.mockResolvedValue({ text: null, transcript: "الكولي وصلني مكسور", attachmentType: "audio" });
  db.workspace.findUnique.mockResolvedValue({ name: "Maison Lina" });
  db.alertRecipient.findMany.mockResolvedValue([TELEGRAM, EMAIL]);
  db.alertRecipient.findFirst.mockResolvedValue(TELEGRAM);
  db.alertDelivery.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    ...delivery(),
    ...data,
    id: `dl_${String(data.recipientId)}`,
  }));
  db.alertDelivery.findUnique.mockResolvedValue(delivery());
  db.alertDelivery.update.mockResolvedValue({});
  db.alertSettings.findUnique.mockResolvedValue({ telegramBotToken: "enc-token" });
  telegram.telegramSendMessage.mockResolvedValue({ messageId: 7 });
  email.sendAlertEmail.mockResolvedValue({ id: "re_1", transport: "resend" });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("queueing the alerts of a handoff", () => {
  it("one delivery and one job per recipient, keyed so nobody is alerted twice", async () => {
    await expect(enqueueHandoffAlerts("evt_1")).resolves.toBe(2);
    expect(db.alertDelivery.create).toHaveBeenCalledWith({
      data: {
        workspaceId: "ws_a",
        conversationId: "conv_1",
        eventId: "evt_1",
        recipientId: "rc_tg",
        channel: "TELEGRAM",
        category: "COMPLAINT",
        dedupeKey: "handoff:evt_1:rc_tg",
      },
    });
    expect(queue.add).toHaveBeenCalledWith(
      "alert-send",
      { deliveryId: "dl_rc_tg" },
      { jobId: alertJobId("dl_rc_tg"), attempts: ALERT_ATTEMPTS, backoff: { type: "alert" } }
    );
  });

  it("queued again (a retried job), reuses the rows and skips what was sent", async () => {
    db.alertDelivery.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "7" })
    );
    db.alertDelivery.findUniqueOrThrow
      .mockResolvedValueOnce(delivery({ id: "dl_sent", status: "SENT" }))
      .mockResolvedValueOnce(delivery({ id: "dl_pending", recipientId: "rc_mail" }));
    await expect(enqueueHandoffAlerts("evt_1")).resolves.toBe(1);
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add.mock.calls[0][1]).toEqual({ deliveryId: "dl_pending" });
  });

  it("only for HANDOFF events", async () => {
    db.facebookConversationEvent.findUnique.mockResolvedValue({ ...EVENT, type: "HUMAN_TAKEOVER" });
    await expect(enqueueHandoffAlerts("evt_1")).resolves.toBe(0);
    expect(db.alertDelivery.create).not.toHaveBeenCalled();
  });

  it("the hourly sweep queues only handoffs that have no delivery yet", async () => {
    db.facebookConversationEvent.findMany.mockResolvedValue([{ id: "evt_1" }, { id: "evt_2" }]);
    db.alertDelivery.findMany.mockResolvedValue([{ eventId: "evt_2" }]);
    db.alertRecipient.findMany.mockResolvedValue([EMAIL]);
    await expect(sweepUnqueuedHandoffs()).resolves.toBe(1);
    expect(db.facebookConversationEvent.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "evt_1" } }));
  });
});

describe("sending one alert", () => {
  it("Telegram: the bot sends the Arabic alert with the voice transcript and a button to the conversation", async () => {
    await expect(processAlertJob(job())).resolves.toBe("sent");
    const [token, message] = telegram.telegramSendMessage.mock.calls[0];
    expect(token).toBe("plain:enc-token");
    expect(message.chatId).toBe("-100123");
    expect(message.html).toContain("Maison Lina");
    expect(message.html).toContain("Lina Outlet");
    expect(message.html).toContain("Amina B.");
    expect(message.html).toContain("شكوى");
    expect(message.html).toContain("الكولي وصلني مكسور");
    expect(message.button?.url).toBe("https://bot.example.com/facebook/inbox?workspace=ws_a&conversation=conv_1");
    expect(db.alertDelivery.update).toHaveBeenLastCalledWith({
      where: { id: "dl_1" },
      data: { status: "SENT", sentAt: expect.any(Date), error: null },
    });
  });

  it("email: subject, HTML and text to the recipient's address", async () => {
    db.alertDelivery.findUnique.mockResolvedValue(delivery({ recipientId: "rc_mail", channel: "EMAIL" }));
    db.alertRecipient.findFirst.mockResolvedValue(EMAIL);
    await expect(processAlertJob(job())).resolves.toBe("sent");
    const [mail] = email.sendAlertEmail.mock.calls[0];
    expect(mail.to).toBe("owner@shop.dz");
    expect(mail.subject).toContain("Maison Lina");
    expect(mail.html).toContain("https://bot.example.com/facebook/inbox?workspace=ws_a&amp;conversation=conv_1");
    expect(mail.text).toContain("https://bot.example.com/facebook/inbox?workspace=ws_a&conversation=conv_1");
  });

  it("a passing failure is retried by BullMQ, honouring Telegram's retry_after", async () => {
    const throttled = new TelegramError("Too Many Requests: retry after 35", "rate_limited", 429, 35);
    telegram.telegramSendMessage.mockRejectedValue(throttled);
    await expect(processAlertJob(job(0))).rejects.toBe(throttled);
    expect(db.alertDelivery.update).toHaveBeenLastCalledWith({
      where: { id: "dl_1" },
      data: { status: "PENDING", error: "Too Many Requests: retry after 35" },
    });
    expect(alertBackoff(1, throttled)).toBe(36_000);
    expect(alertBackoff(1)).toBe(30_000);
    expect(alertBackoff(3)).toBe(120_000);
    expect(alertBackoff(20)).toBe(30 * 60_000);
  });

  it("gives up on the last attempt, and at once on a lasting failure", async () => {
    telegram.telegramSendMessage.mockRejectedValue(new TelegramError("Service Unavailable", "unavailable", 503));
    await expect(processAlertJob(job(ALERT_ATTEMPTS - 1))).resolves.toBe("failed");
    expect(db.alertDelivery.update).toHaveBeenLastCalledWith({
      where: { id: "dl_1" },
      data: { status: "FAILED", error: "Service Unavailable" },
    });

    telegram.telegramSendMessage.mockRejectedValue(new TelegramError("Bad Request: chat not found", "chat_not_found", 400));
    await expect(processAlertJob(job(0))).resolves.toBe("failed");

    db.alertDelivery.findUnique.mockResolvedValue(delivery({ recipientId: "rc_mail", channel: "EMAIL" }));
    db.alertRecipient.findFirst.mockResolvedValue(EMAIL);
    email.sendAlertEmail.mockRejectedValue(new EmailError("Invalid `to` field", "invalid_recipient", 422));
    await expect(processAlertJob(job(0))).resolves.toBe("failed");
  });

  it("does nothing for a delivery already sent, and fails one whose recipient is gone", async () => {
    db.alertDelivery.findUnique.mockResolvedValue(delivery({ status: "SENT" }));
    await expect(processAlertJob(job())).resolves.toBe("skipped");
    expect(telegram.telegramSendMessage).not.toHaveBeenCalled();

    db.alertDelivery.findUnique.mockResolvedValue(delivery());
    db.alertRecipient.findFirst.mockResolvedValue(null);
    await expect(processAlertJob(job())).resolves.toBe("skipped");
    expect(db.alertDelivery.update).toHaveBeenCalledWith({
      where: { id: "dl_1" },
      data: { status: "FAILED", error: "The recipient was removed or turned off." },
    });
  });

  it("without a saved bot, a Telegram alert fails cleanly", async () => {
    db.alertSettings.findUnique.mockResolvedValue({ telegramBotToken: null });
    await expect(processAlertJob(job())).resolves.toBe("failed");
    expect(telegram.telegramSendMessage).not.toHaveBeenCalled();
  });
});

describe("the test button", () => {
  it("sends to every active recipient now, logs each send, and tells which one failed", async () => {
    email.sendAlertEmail.mockRejectedValue(new EmailError("not configured", "not_configured"));
    const results = await sendTestAlerts("ws_a", null);
    expect(results).toEqual([
      { recipientId: "rc_tg", label: "Sales group", ok: true, error: null, errorKind: null },
      { recipientId: "rc_mail", label: "Owner", ok: false, error: "not configured", errorKind: "not_configured" },
    ]);
    expect(db.alertDelivery.create.mock.calls[0][0].data).toMatchObject({
      workspaceId: "ws_a",
      isTest: true,
      dedupeKey: expect.stringMatching(/^test:/),
    });
    expect(db.alertDelivery.create.mock.calls[0][0].data).not.toHaveProperty("conversationId");
    expect(telegram.telegramSendMessage.mock.calls[0][1].html).toContain("Maison Lina");
  });

  it("one recipient of the brand only", async () => {
    db.alertRecipient.findMany.mockResolvedValue([]);
    await expect(sendTestAlerts("ws_a", "rc_other_brand")).resolves.toBeNull();
    expect(db.alertRecipient.findMany).toHaveBeenCalledWith({ where: { id: "rc_other_brand", workspaceId: "ws_a" } });
  });
});
