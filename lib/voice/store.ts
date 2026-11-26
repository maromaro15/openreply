/**
 * Brand voice in the database: the brand's examples and corrections, the
 * global set (workspaceId null), and learning from a person's replies.
 */
import { prisma } from "@/lib/db/client";
import type { VoiceSource } from "@/app/generated/prisma/client";
import { GLOBAL_VOICE_SEED } from "./defaults";
import {
  VOICE_LIMITS,
  voicePack,
  type VoiceCorrectionData,
  type VoiceExampleData,
  type VoiceForPrompt,
  type VoicePack,
  type VoiceSourceValue,
} from "./format";
import { foldText, pickExamples } from "./select";

const TO_DB: Record<VoiceSourceValue, VoiceSource> = {
  seed: "SEED",
  manual: "MANUAL",
  human_reply: "HUMAN_REPLY",
  inbox_correction: "INBOX_CORRECTION",
  import: "IMPORT",
};
const FROM_DB = Object.fromEntries(Object.entries(TO_DB).map(([key, value]) => [value, key])) as Record<
  VoiceSource,
  VoiceSourceValue
>;

/** The global set is edited only by the people named in PLATFORM_ADMIN_EMAILS (comma-separated). */
export function isPlatformAdmin(email: string | null | undefined): boolean {
  if (!email) return false;
  const admins = (process.env.PLATFORM_ADMIN_EMAILS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return admins.includes(email.trim().toLowerCase());
}

let globalSeeded: Promise<void> | null = null;

/**
 * Puts the default global set in the database the first time it is needed.
 * shortcut: it seeds whenever the global set is empty, so deleting every
 * global row brings the defaults back; switch them off instead.
 */
export function ensureGlobalVoice(): Promise<void> {
  globalSeeded ??= (async () => {
    const [examples, corrections] = await Promise.all([
      prisma.voiceExample.count({ where: { workspaceId: null } }),
      prisma.voiceCorrection.count({ where: { workspaceId: null } }),
    ]);
    if (examples === 0) {
      await prisma.voiceExample.createMany({
        data: GLOBAL_VOICE_SEED.examples.map((example) => ({
          workspaceId: null,
          customerText: example.customer,
          replyText: example.reply,
          source: "SEED" as const,
        })),
      });
    }
    if (corrections === 0) {
      await prisma.voiceCorrection.createMany({
        data: GLOBAL_VOICE_SEED.corrections.map((correction) => ({
          workspaceId: null,
          wrong: correction.wrong,
          right: correction.right,
          source: "SEED" as const,
        })),
      });
    }
  })().catch((error) => {
    globalSeeded = null;
    throw error;
  });
  return globalSeeded;
}

/** The dictionary for a brand: its own entries, then the global ones it did not override. */
function mergeCorrections(rows: { workspaceId: string | null; wrong: string; right: string[] }[]) {
  const byPhrase = new Map<string, { wrong: string; right: string[] }>();
  // The brand's rows come last, so they win over the global one for the same phrase.
  for (const row of [...rows].sort((a, b) => Number(a.workspaceId !== null) - Number(b.workspaceId !== null))) {
    if (row.right.length === 0) continue;
    byPhrase.set(foldText(row.wrong).trim(), { wrong: row.wrong, right: row.right });
  }
  return [...byPhrase.values()];
}

/**
 * What the bot gets for this conversation: the most relevant examples and
 * the whole dictionary. A failure costs the voice, never the answer.
 */
export async function loadVoiceForBot(workspaceId: string, customerTexts: string[]): Promise<VoiceForPrompt | undefined> {
  try {
    await ensureGlobalVoice();
    const scope = { OR: [{ workspaceId }, { workspaceId: null }], isActive: true };
    const [examples, corrections] = await Promise.all([
      prisma.voiceExample.findMany({
        where: scope,
        orderBy: { createdAt: "desc" },
        take: VOICE_LIMITS.examples * 2,
        select: { workspaceId: true, customerText: true, replyText: true },
      }),
      prisma.voiceCorrection.findMany({ where: scope, select: { workspaceId: true, wrong: true, right: true } }),
    ]);
    return {
      examples: pickExamples(
        examples.map((row) => ({ customer: row.customerText, reply: row.replyText, brand: row.workspaceId !== null })),
        customerTexts
      ),
      corrections: mergeCorrections(corrections),
    };
  } catch (error) {
    console.warn("[Voice] not loaded:", error instanceof Error ? error.message : error);
    return undefined;
  }
}

// ─── The voice screen ───────────────────────────────────────────────────────

export interface VoiceExampleView {
  id: string;
  global: boolean;
  customer: string;
  reply: string;
  source: VoiceSourceValue;
  active: boolean;
  createdAt: string;
}

export interface VoiceCorrectionView {
  id: string;
  global: boolean;
  wrong: string;
  right: string[];
  source: VoiceSourceValue;
  active: boolean;
  createdAt: string;
}

export async function listVoice(workspaceId: string) {
  await ensureGlobalVoice();
  const scope = { OR: [{ workspaceId }, { workspaceId: null }] };
  const [examples, corrections, settings] = await Promise.all([
    prisma.voiceExample.findMany({ where: scope, orderBy: { createdAt: "desc" } }),
    prisma.voiceCorrection.findMany({ where: scope, orderBy: { createdAt: "desc" } }),
    prisma.botSettings.findUnique({ where: { workspaceId }, select: { voiceAutoSave: true } }),
  ]);
  return {
    autoSave: settings?.voiceAutoSave ?? false,
    examples: examples.map(
      (row): VoiceExampleView => ({
        id: row.id,
        global: row.workspaceId === null,
        customer: row.customerText,
        reply: row.replyText,
        source: FROM_DB[row.source],
        active: row.isActive,
        createdAt: row.createdAt.toISOString(),
      })
    ),
    corrections: corrections.map(
      (row): VoiceCorrectionView => ({
        id: row.id,
        global: row.workspaceId === null,
        wrong: row.wrong,
        right: row.right,
        source: FROM_DB[row.source],
        active: row.isActive,
        createdAt: row.createdAt.toISOString(),
      })
    ),
  };
}

export async function setVoiceAutoSave(workspaceId: string, autoSave: boolean): Promise<void> {
  await prisma.botSettings.upsert({
    where: { workspaceId },
    create: { workspaceId, voiceAutoSave: autoSave },
    update: { voiceAutoSave: autoSave },
  });
}

export type VoiceWriteResult = { ok: true; id: string; created: boolean } | { ok: false; code: "full" | "not_found" };

/** `workspaceId` null: the global set. */
export async function addVoiceExample(
  workspaceId: string | null,
  data: VoiceExampleData,
  extra: { userId?: string | null; sourceMessageId?: string | null } = {}
): Promise<VoiceWriteResult> {
  const existing = await prisma.voiceExample.findFirst({
    where: { workspaceId, customerText: data.customer, replyText: data.reply },
    select: { id: true },
  });
  if (existing) return { ok: true, id: existing.id, created: false };
  if ((await prisma.voiceExample.count({ where: { workspaceId } })) >= VOICE_LIMITS.examples) {
    return { ok: false, code: "full" };
  }
  try {
    const row = await prisma.voiceExample.create({
      data: {
        workspaceId,
        customerText: data.customer,
        replyText: data.reply,
        source: TO_DB[data.source],
        isActive: data.active,
        sourceMessageId: extra.sourceMessageId ?? null,
        createdByUserId: extra.userId ?? null,
      },
    });
    return { ok: true, id: row.id, created: true };
  } catch (error) {
    // Saved from this message already (the auto-save, or a second click).
    if ((error as { code?: string }).code === "P2002" && extra.sourceMessageId) {
      const row = await prisma.voiceExample.findUnique({ where: { sourceMessageId: extra.sourceMessageId } });
      if (row) return { ok: true, id: row.id, created: false };
    }
    throw error;
  }
}

/** A phrase already in the dictionary gets the new right phrases added to it. */
export async function addVoiceCorrection(
  workspaceId: string | null,
  data: VoiceCorrectionData,
  extra: { userId?: string | null } = {}
): Promise<VoiceWriteResult> {
  const folded = foldText(data.wrong).trim();
  const rows = await prisma.voiceCorrection.findMany({ where: { workspaceId }, select: { id: true, wrong: true, right: true } });
  const existing = rows.find((row) => foldText(row.wrong).trim() === folded);
  if (existing) {
    const right = [...new Set([...data.right, ...existing.right])].slice(0, VOICE_LIMITS.rights);
    await prisma.voiceCorrection.update({ where: { id: existing.id }, data: { right, isActive: true } });
    return { ok: true, id: existing.id, created: false };
  }
  if (rows.length >= VOICE_LIMITS.corrections) return { ok: false, code: "full" };
  const row = await prisma.voiceCorrection.create({
    data: {
      workspaceId,
      wrong: data.wrong,
      right: data.right,
      source: TO_DB[data.source],
      isActive: data.active,
      createdByUserId: extra.userId ?? null,
    },
  });
  return { ok: true, id: row.id, created: true };
}

/** The row, when it belongs to this brand, or to the global set and `global` is allowed. */
async function ownedRow(kind: "example" | "correction", id: string, workspaceId: string, global: boolean) {
  const where = { id, OR: global ? [{ workspaceId }, { workspaceId: null }] : [{ workspaceId }] };
  return kind === "example"
    ? prisma.voiceExample.findFirst({ where, select: { id: true } })
    : prisma.voiceCorrection.findFirst({ where, select: { id: true } });
}

export async function updateVoiceExample(
  id: string,
  workspaceId: string,
  global: boolean,
  data: Partial<Pick<VoiceExampleData, "customer" | "reply" | "active">>
): Promise<boolean> {
  if (!(await ownedRow("example", id, workspaceId, global))) return false;
  await prisma.voiceExample.update({
    where: { id },
    data: { customerText: data.customer, replyText: data.reply, isActive: data.active },
  });
  return true;
}

export async function updateVoiceCorrection(
  id: string,
  workspaceId: string,
  global: boolean,
  data: Partial<Pick<VoiceCorrectionData, "wrong" | "right" | "active">>
): Promise<boolean> {
  if (!(await ownedRow("correction", id, workspaceId, global))) return false;
  await prisma.voiceCorrection.update({ where: { id }, data: { wrong: data.wrong, right: data.right, isActive: data.active } });
  return true;
}

export async function deleteVoiceRow(kind: "example" | "correction", id: string, workspaceId: string, global: boolean) {
  if (!(await ownedRow(kind, id, workspaceId, global))) return false;
  if (kind === "example") await prisma.voiceExample.delete({ where: { id } });
  else await prisma.voiceCorrection.delete({ where: { id } });
  return true;
}

// ─── Export and import ──────────────────────────────────────────────────────

export async function exportVoicePack(workspaceId: string | null): Promise<VoicePack> {
  if (workspaceId === null) await ensureGlobalVoice();
  const [examples, corrections] = await Promise.all([
    prisma.voiceExample.findMany({ where: { workspaceId }, orderBy: { createdAt: "asc" } }),
    prisma.voiceCorrection.findMany({ where: { workspaceId }, orderBy: { createdAt: "asc" } }),
  ]);
  return voicePack(
    workspaceId === null ? "global" : "brand",
    examples.map((row) => ({ customer: row.customerText, reply: row.replyText, source: FROM_DB[row.source], active: row.isActive })),
    corrections.map((row) => ({ wrong: row.wrong, right: row.right, source: FROM_DB[row.source], active: row.isActive }))
  );
}

/** Adds what is not there yet; nothing is replaced or deleted. */
export async function importVoicePack(workspaceId: string | null, pack: VoicePack, userId: string | null) {
  let examples = 0;
  let corrections = 0;
  let full = false;
  for (const example of pack.examples) {
    const result = await addVoiceExample(workspaceId, { ...example, source: "import" }, { userId });
    if (!result.ok) {
      full = true;
      break;
    }
    if (result.created) examples += 1;
  }
  for (const correction of pack.corrections) {
    const result = await addVoiceCorrection(workspaceId, { ...correction, source: "import" }, { userId });
    if (!result.ok) {
      full = true;
      break;
    }
    if (result.created) corrections += 1;
  }
  return { examples, corrections, full };
}

// ─── Learning from a person's reply ─────────────────────────────────────────

/**
 * What the customer wrote just before a message: their messages since the
 * Page last wrote, oldest first, at most three.
 */
export async function customerTextBefore(conversationId: string, before: Date): Promise<string> {
  const earlier = await prisma.facebookMessage.findMany({
    where: { conversationId, sentAt: { lte: before } },
    orderBy: [{ sentAt: "desc" }, { createdAt: "desc" }],
    take: 12,
    select: { direction: true, text: true, transcript: true, sentAt: true },
  });
  const texts: string[] = [];
  let seenCustomer = false;
  for (const message of earlier) {
    if (message.direction === "OUTBOUND") {
      if (seenCustomer) break;
      continue;
    }
    seenCustomer = true;
    const text = (message.text ?? message.transcript ?? "").trim();
    if (text) texts.unshift(text);
    if (texts.length >= 3) break;
  }
  return texts.join(" / ").slice(0, VOICE_LIMITS.customer);
}

/**
 * Called after a person's reply was stored (inbox or Meta Business Suite).
 * With auto-save on for the brand, the exchange becomes a voice example.
 * Never throws: learning must not cost the reply.
 */
export async function learnVoiceFromReply(messageId: string): Promise<void> {
  try {
    const message = await prisma.facebookMessage.findUnique({
      where: { id: messageId },
      select: { id: true, workspaceId: true, conversationId: true, direction: true, author: true, text: true, sentAt: true, sentByUserId: true },
    });
    if (!message || message.direction !== "OUTBOUND" || message.author !== "HUMAN") return;
    const reply = message.text?.trim();
    if (!reply || reply.length > VOICE_LIMITS.reply) return;
    const settings = await prisma.botSettings.findUnique({
      where: { workspaceId: message.workspaceId },
      select: { voiceAutoSave: true },
    });
    if (!settings?.voiceAutoSave) return;
    const customer = await customerTextBefore(message.conversationId, message.sentAt);
    if (!customer) return;
    await addVoiceExample(
      message.workspaceId,
      { customer, reply, source: "human_reply", active: true },
      { sourceMessageId: message.id, userId: message.sentByUserId }
    );
  } catch (error) {
    console.error("[Voice] reply not learned:", error instanceof Error ? error.message : error);
  }
}
