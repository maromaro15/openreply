/**
 * A brand's alert settings: its Telegram bot, the people or groups alerts
 * go to, and which of them get which handoff category.
 *
 * The bot token is stored encrypted (like Page tokens) and never leaves the
 * server: the browser only sees the bot's @username.
 */
import { z } from "zod";
import type { AlertRecipient, HandoffCategory } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { HANDOFF_CATEGORIES, isHandoffCategory } from "@/lib/handoff/categories";
import { decryptToken, encryptToken } from "@/lib/meta/oauth";
import { isValidEmail } from "./email";

export const MAX_RECIPIENTS = 50;

/** A person or group id (groups are negative), or a public channel's @name. */
const TELEGRAM_CHAT_ID = /^(-?\d{1,20}|@[A-Za-z0-9_]{5,32})$/;

const label = z.string().trim().min(1, "Give the recipient a name.").max(80);

export const recipientSchema = z.discriminatedUnion("channel", [
  z.object({
    channel: z.literal("TELEGRAM"),
    label,
    telegramChatId: z.string().trim().regex(TELEGRAM_CHAT_ID, "Enter a Telegram chat ID."),
    isDefault: z.boolean().default(false),
    isActive: z.boolean().default(true),
  }),
  z.object({
    channel: z.literal("EMAIL"),
    label,
    // Trimmed and checked with the sender's own rule, so a saved address can
    // never fail every alert (no list, no header injection, no quoted parts).
    email: z
      .string()
      .trim()
      .toLowerCase()
      .refine(isValidEmail, "Enter a valid email address."),
    isDefault: z.boolean().default(false),
    isActive: z.boolean().default(true),
  }),
]);

export type RecipientInput = z.infer<typeof recipientSchema>;

/** No defaults: a field left out of a PATCH stays as it is. */
export const recipientPatchSchema = z
  .object({ label, isDefault: z.boolean(), isActive: z.boolean() })
  .partial();

export function serializeRecipient(recipient: AlertRecipient) {
  return {
    id: recipient.id,
    channel: recipient.channel,
    label: recipient.label,
    telegramChatId: recipient.telegramChatId,
    email: recipient.email,
    isDefault: recipient.isDefault,
    isActive: recipient.isActive,
  };
}

export type RecipientView = ReturnType<typeof serializeRecipient>;

// ─── Telegram bot ───────────────────────────────────────────────────────────

export async function getTelegramBot(workspaceId: string): Promise<{ username: string | null } | null> {
  const settings = await prisma.alertSettings.findUnique({
    where: { workspaceId },
    select: { telegramBotToken: true, telegramBotUsername: true },
  });
  return settings?.telegramBotToken ? { username: settings.telegramBotUsername } : null;
}

/** The decrypted token, for sending. Never for the browser. */
export async function telegramBotToken(workspaceId: string): Promise<string | null> {
  const settings = await prisma.alertSettings.findUnique({
    where: { workspaceId },
    select: { telegramBotToken: true },
  });
  return settings?.telegramBotToken ? decryptToken(settings.telegramBotToken) : null;
}

export async function saveTelegramBot(workspaceId: string, token: string, username: string | null): Promise<void> {
  const data = { telegramBotToken: encryptToken(token), telegramBotUsername: username };
  await prisma.alertSettings.upsert({
    where: { workspaceId },
    create: { workspaceId, ...data },
    update: data,
  });
}

export async function removeTelegramBot(workspaceId: string): Promise<void> {
  await prisma.alertSettings.updateMany({
    where: { workspaceId },
    data: { telegramBotToken: null, telegramBotUsername: null },
  });
}

// ─── Recipients ─────────────────────────────────────────────────────────────

export async function listRecipients(workspaceId: string): Promise<AlertRecipient[]> {
  return prisma.alertRecipient.findMany({ where: { workspaceId }, orderBy: { createdAt: "asc" } });
}

export async function createRecipient(workspaceId: string, input: RecipientInput): Promise<AlertRecipient | null> {
  if ((await prisma.alertRecipient.count({ where: { workspaceId } })) >= MAX_RECIPIENTS) return null;
  return prisma.alertRecipient.create({
    data: {
      workspaceId,
      channel: input.channel,
      label: input.label,
      telegramChatId: input.channel === "TELEGRAM" ? input.telegramChatId : null,
      email: input.channel === "EMAIL" ? input.email.trim().toLowerCase() : null,
      isDefault: input.isDefault,
      isActive: input.isActive,
    },
  });
}

/** Only within the brand: another brand's recipient is simply not found. */
export async function updateRecipient(
  workspaceId: string,
  id: string,
  patch: z.infer<typeof recipientPatchSchema>
): Promise<boolean> {
  const updated = await prisma.alertRecipient.updateMany({ where: { id, workspaceId }, data: patch });
  return updated.count === 1;
}

/** Its routes go with it (cascade); its past deliveries stay in the log. */
export async function deleteRecipient(workspaceId: string, id: string): Promise<boolean> {
  const deleted = await prisma.alertRecipient.deleteMany({ where: { id, workspaceId } });
  return deleted.count === 1;
}

// ─── Routing table ──────────────────────────────────────────────────────────

export type RoutingTable = Record<HandoffCategory, string[]>;

export function emptyRoutingTable(): RoutingTable {
  return Object.fromEntries(HANDOFF_CATEGORIES.map((category) => [category, []])) as unknown as RoutingTable;
}

export async function getRoutingTable(workspaceId: string): Promise<RoutingTable> {
  const routes = await prisma.alertRoute.findMany({
    where: { workspaceId },
    select: { category: true, recipientId: true },
    orderBy: { createdAt: "asc" },
  });
  const table = emptyRoutingTable();
  for (const route of routes) table[route.category].push(route.recipientId);
  return table;
}

export const routingTableSchema = z.record(z.string(), z.array(z.string().max(64)).max(MAX_RECIPIENTS));

/**
 * Replace the brand's routing table. Recipient IDs from another brand, and
 * unknown categories, are dropped rather than trusted.
 */
export async function saveRoutingTable(workspaceId: string, input: Record<string, string[]>): Promise<RoutingTable> {
  const own = new Set(
    (await prisma.alertRecipient.findMany({ where: { workspaceId }, select: { id: true } })).map((row) => row.id)
  );
  const rows: { workspaceId: string; category: HandoffCategory; recipientId: string }[] = [];
  for (const [category, recipientIds] of Object.entries(input)) {
    if (!isHandoffCategory(category)) continue;
    for (const recipientId of new Set(recipientIds)) {
      if (own.has(recipientId)) rows.push({ workspaceId, category, recipientId });
    }
  }
  await prisma.$transaction([
    prisma.alertRoute.deleteMany({ where: { workspaceId } }),
    ...(rows.length ? [prisma.alertRoute.createMany({ data: rows })] : []),
  ]);
  return getRoutingTable(workspaceId);
}
