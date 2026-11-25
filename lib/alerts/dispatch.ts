/**
 * Sending handoff alerts.
 *
 * A HANDOFF event fans out to one AlertDelivery row per recipient, unique
 * on "handoff:<eventId>:<recipientId>", each sent by its own job: a retried
 * job or a re-queued event never alerts anyone twice, and one failing
 * channel never holds up the others. Telegram's retry_after is honoured
 * (alertBackoff, used by the Facebook worker).
 */
import { randomUUID } from "node:crypto";
import type { Job } from "bullmq";
import type { AlertDelivery, AlertRecipient } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { getBaseUrl } from "@/lib/env";
import { isUniqueViolation } from "@/lib/facebook/conversations";
import { ALERT_SEND_JOB, alertJobId, getFacebookQueue, type AlertSendJob } from "@/lib/facebook/queue";
import { EmailError, sendAlertEmail } from "./email";
import {
  buildEmailAlert,
  buildTelegramAlert,
  buildTestEmailAlert,
  buildTestTelegramAlert,
  inboxLink,
  type AlertContent,
} from "./message";
import { recipientsForCategory } from "./routing";
import { telegramBotToken } from "./settings";
import { TelegramError, telegramSendMessage } from "./telegram";

export const ALERT_ATTEMPTS = 5;
export const ALERT_BACKOFF_TYPE = "alert";
const BASE_DELAY_MS = 30_000;
const MAX_DELAY_MS = 30 * 60_000;

/** Delay before retrying an alert: Telegram's retry_after, else exponential. */
export function alertBackoff(attemptsMade: number, err?: Error): number {
  if (err instanceof TelegramError && err.retryAfterSeconds) {
    return Math.min(err.retryAfterSeconds * 1000 + 1000, MAX_DELAY_MS);
  }
  return Math.min(BASE_DELAY_MS * 2 ** Math.max(0, attemptsMade - 1), MAX_DELAY_MS);
}

type Message =
  | { kind: "handoff"; content: AlertContent }
  | { kind: "test"; brandName: string };

/** Send one alert to one recipient. Throws TelegramError or EmailError. */
async function deliver(workspaceId: string, recipient: AlertRecipient, message: Message): Promise<void> {
  if (recipient.channel === "TELEGRAM") {
    const token = await telegramBotToken(workspaceId);
    if (!token) throw new TelegramError("The Telegram bot is not set up for this brand.", "invalid_token");
    const alert = message.kind === "test" ? buildTestTelegramAlert(message.brandName) : buildTelegramAlert(message.content);
    await telegramSendMessage(token, { chatId: recipient.telegramChatId ?? "", html: alert.html, button: alert.button });
    return;
  }
  const alert = message.kind === "test" ? buildTestEmailAlert(message.brandName) : buildEmailAlert(message.content);
  await sendAlertEmail({ to: recipient.email ?? "", subject: alert.subject, html: alert.html, text: alert.text });
}

function errorKind(error: unknown): string | null {
  return error instanceof TelegramError || error instanceof EmailError ? error.kind : null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

/** Queue the alerts of a HANDOFF event. Safe to call again: nobody is alerted twice. */
export async function enqueueHandoffAlerts(eventId: string): Promise<number> {
  const event = await prisma.facebookConversationEvent.findUnique({
    where: { id: eventId },
    select: { id: true, workspaceId: true, conversationId: true, type: true, category: true },
  });
  if (!event || event.type !== "HANDOFF") return 0;

  const recipients = await recipientsForCategory(event.workspaceId, event.category ?? "OTHER");
  let queued = 0;
  for (const recipient of recipients) {
    const dedupeKey = `handoff:${event.id}:${recipient.id}`;
    let delivery: AlertDelivery;
    try {
      delivery = await prisma.alertDelivery.create({
        data: {
          workspaceId: event.workspaceId,
          conversationId: event.conversationId,
          eventId: event.id,
          recipientId: recipient.id,
          channel: recipient.channel,
          category: event.category,
          dedupeKey,
        },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      delivery = await prisma.alertDelivery.findUniqueOrThrow({ where: { dedupeKey } });
    }
    if (delivery.status === "SENT") continue;
    await getFacebookQueue().add(
      ALERT_SEND_JOB,
      { deliveryId: delivery.id },
      { jobId: alertJobId(delivery.id), attempts: ALERT_ATTEMPTS, backoff: { type: ALERT_BACKOFF_TYPE } }
    );
    queued += 1;
  }
  return queued;
}

/** What the alert says: built when it is sent, from the conversation as it is then. */
async function handoffContent(delivery: AlertDelivery): Promise<AlertContent> {
  const [event, conversation, workspace] = await Promise.all([
    delivery.eventId ? prisma.facebookConversationEvent.findUnique({ where: { id: delivery.eventId } }) : null,
    delivery.conversationId
      ? prisma.facebookConversation.findUnique({
          where: { id: delivery.conversationId },
          include: { page: { select: { name: true } } },
        })
      : null,
    prisma.workspace.findUnique({ where: { id: delivery.workspaceId }, select: { name: true } }),
  ]);
  const last = conversation
    ? await prisma.facebookMessage.findFirst({
        where: { conversationId: conversation.id, direction: "INBOUND" },
        orderBy: [{ sentAt: "desc" }, { createdAt: "desc" }],
      })
    : null;
  return {
    brandName: workspace?.name ?? "",
    pageName: conversation?.page.name ?? "",
    customerName: conversation?.userName ?? null,
    category: event?.category ?? delivery.category ?? "OTHER",
    reason: event?.reason ?? conversation?.handoffReason ?? null,
    lastMessage: last
      ? { text: last.text, transcript: last.transcript, attachmentType: last.attachmentType }
      : null,
    link: inboxLink(getBaseUrl(), delivery.workspaceId, delivery.conversationId ?? ""),
  };
}

export type AlertOutcome = "sent" | "skipped" | "failed";

export async function processAlertJob(job: Job<AlertSendJob>): Promise<AlertOutcome> {
  const delivery = await prisma.alertDelivery.findUnique({ where: { id: job.data.deliveryId } });
  if (!delivery || delivery.status === "SENT") return "skipped";
  const recipient = delivery.recipientId
    ? await prisma.alertRecipient.findFirst({ where: { id: delivery.recipientId, workspaceId: delivery.workspaceId } })
    : null;
  if (!recipient || !recipient.isActive) {
    await prisma.alertDelivery.update({
      where: { id: delivery.id },
      data: { status: "FAILED", error: "The recipient was removed or turned off." },
    });
    return "skipped";
  }

  await prisma.alertDelivery.update({ where: { id: delivery.id }, data: { attempts: { increment: 1 } } });
  try {
    await deliver(delivery.workspaceId, recipient, { kind: "handoff", content: await handoffContent(delivery) });
    await prisma.alertDelivery.update({
      where: { id: delivery.id },
      data: { status: "SENT", sentAt: new Date(), error: null },
    });
    return "sent";
  } catch (error) {
    const retryable = (error instanceof TelegramError || error instanceof EmailError) && error.retryable;
    const willRetry = retryable && job.attemptsMade + 1 < (job.opts.attempts ?? 1);
    await prisma.alertDelivery.update({
      where: { id: delivery.id },
      data: { status: willRetry ? "PENDING" : "FAILED", error: errorText(error) },
    });
    if (willRetry) throw error;
    return "failed";
  }
}

export interface TestResult {
  recipientId: string;
  label: string;
  ok: boolean;
  error: string | null;
  errorKind: string | null;
}

/**
 * The "send a test alert" button: sent right away, so the screen shows what
 * happened on each channel. Logged, never tied to a conversation.
 */
export async function sendTestAlerts(workspaceId: string, recipientId: string | null): Promise<TestResult[] | null> {
  const recipients = recipientId
    ? await prisma.alertRecipient.findMany({ where: { id: recipientId, workspaceId } })
    : await prisma.alertRecipient.findMany({ where: { workspaceId, isActive: true }, orderBy: { createdAt: "asc" } });
  if (recipientId && recipients.length === 0) return null;
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { name: true } });

  const results: TestResult[] = [];
  for (const recipient of recipients) {
    const delivery = await prisma.alertDelivery.create({
      data: {
        workspaceId,
        recipientId: recipient.id,
        channel: recipient.channel,
        dedupeKey: `test:${randomUUID()}`,
        isTest: true,
        attempts: 1,
      },
    });
    try {
      await deliver(workspaceId, recipient, { kind: "test", brandName: workspace?.name ?? "" });
      await prisma.alertDelivery.update({ where: { id: delivery.id }, data: { status: "SENT", sentAt: new Date() } });
      results.push({ recipientId: recipient.id, label: recipient.label, ok: true, error: null, errorKind: null });
    } catch (error) {
      await prisma.alertDelivery.update({
        where: { id: delivery.id },
        data: { status: "FAILED", error: errorText(error) },
      });
      results.push({
        recipientId: recipient.id,
        label: recipient.label,
        ok: false,
        error: errorText(error),
        errorKind: errorKind(error),
      });
    }
  }
  return results;
}

/**
 * Alerts of recent handoffs that never got queued (Redis was down at that
 * moment, say). Run by the worker every hour; enqueueHandoffAlerts makes it
 * harmless to run twice.
 */
export async function sweepUnqueuedHandoffs(sinceMs = 60 * 60_000): Promise<number> {
  const events = await prisma.facebookConversationEvent.findMany({
    where: { type: "HANDOFF", createdAt: { gte: new Date(Date.now() - sinceMs) } },
    select: { id: true },
  });
  if (events.length === 0) return 0;
  const withDeliveries = new Set(
    (
      await prisma.alertDelivery.findMany({
        where: { eventId: { in: events.map((event) => event.id) } },
        select: { eventId: true },
      })
    ).map((row) => row.eventId)
  );
  let queued = 0;
  for (const event of events) {
    if (!withDeliveries.has(event.id)) queued += await enqueueHandoffAlerts(event.id);
  }
  return queued;
}
