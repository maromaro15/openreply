/**
 * The bot's settings and knowledge base, one per brand (workspace).
 *
 * The whole knowledge base goes into every prompt, so the bot never answers
 * from a partial view. Inactive entries stay out, except products: an
 * unavailable product is still known, so the bot can say it is out of stock
 * instead of guessing.
 */
import { z } from "zod";
import type { KnowledgeEntry, KnowledgeEntryKind } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";

export const KNOWLEDGE_KINDS = ["PRODUCT", "DELIVERY", "FAQ", "RULE", "INFO"] as const satisfies readonly KnowledgeEntryKind[];

export const DEFAULT_HANDOFF_MESSAGE = "نرجعولك";
/** Past this size the interface warns: long prompts are slower and costlier. */
export const KNOWLEDGE_WARN_CHARS = 60_000;
/** Hard stop, far above what a shop needs. */
export const KNOWLEDGE_MAX_CHARS = 200_000;
export const MAX_KNOWLEDGE_ENTRIES = 500;

const text = (max: number) => z.string().trim().max(max);

export const botSettingsSchema = z.object({
  enabled: z.boolean(),
  businessName: text(120).nullable().default(null),
  instructions: text(4000).nullable().default(null),
  handoffMessage: text(640).min(1, "Write the message sent when the bot hands over."),
});

export type BotSettingsInput = z.infer<typeof botSettingsSchema>;

export const knowledgeEntrySchema = z.object({
  kind: z.enum(KNOWLEDGE_KINDS),
  title: text(200).min(1, "Give the entry a title."),
  content: text(4000).default(""),
  price: text(100).nullable().default(null),
  isActive: z.boolean().default(true),
});

export type KnowledgeEntryInput = z.infer<typeof knowledgeEntrySchema>;

/** No defaults here: a field left out of a PATCH must stay as it is. */
export const knowledgePatchSchema = z
  .object({
    title: text(200).min(1, "Give the entry a title."),
    content: text(4000),
    price: text(100).nullable(),
    isActive: z.boolean(),
  })
  .partial();

export interface BotSettingsView {
  enabled: boolean;
  businessName: string | null;
  instructions: string | null;
  handoffMessage: string;
}

export async function getBotSettings(workspaceId: string): Promise<BotSettingsView> {
  const row = await prisma.botSettings.findUnique({ where: { workspaceId } });
  return {
    enabled: row?.enabled ?? false,
    businessName: row?.businessName ?? null,
    instructions: row?.instructions ?? null,
    handoffMessage: row?.handoffMessage ?? DEFAULT_HANDOFF_MESSAGE,
  };
}

export async function saveBotSettings(workspaceId: string, input: BotSettingsInput): Promise<BotSettingsView> {
  const data = {
    enabled: input.enabled,
    businessName: input.businessName || null,
    instructions: input.instructions || null,
    handoffMessage: input.handoffMessage,
  };
  const row = await prisma.botSettings.upsert({
    where: { workspaceId },
    create: { workspaceId, ...data },
    update: data,
  });
  return {
    enabled: row.enabled,
    businessName: row.businessName,
    instructions: row.instructions,
    handoffMessage: row.handoffMessage,
  };
}

const KIND_ORDER = Object.fromEntries(KNOWLEDGE_KINDS.map((kind, index) => [kind, index])) as Record<
  KnowledgeEntryKind,
  number
>;

export async function listKnowledge(workspaceId: string): Promise<KnowledgeEntry[]> {
  const entries = await prisma.knowledgeEntry.findMany({
    where: { workspaceId },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  return entries.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
}

export async function createKnowledgeEntry(workspaceId: string, input: KnowledgeEntryInput) {
  if ((await prisma.knowledgeEntry.count({ where: { workspaceId } })) >= MAX_KNOWLEDGE_ENTRIES) return null;
  return prisma.knowledgeEntry.create({
    data: { workspaceId, ...input, price: input.price || null },
  });
}

/** Only within the brand: another brand's entry is simply not found. */
export async function updateKnowledgeEntry(
  workspaceId: string,
  id: string,
  patch: z.infer<typeof knowledgePatchSchema>
): Promise<boolean> {
  const data = { ...patch, ...(patch.price !== undefined ? { price: patch.price || null } : {}) };
  const updated = await prisma.knowledgeEntry.updateMany({ where: { id, workspaceId }, data });
  return updated.count === 1;
}

export async function deleteKnowledgeEntry(workspaceId: string, id: string): Promise<boolean> {
  const deleted = await prisma.knowledgeEntry.deleteMany({ where: { id, workspaceId } });
  return deleted.count === 1;
}

// ─── As the bot reads it ────────────────────────────────────────────────────

type EntryText = Pick<KnowledgeEntry, "kind" | "title" | "content" | "price" | "isActive">;

const SECTIONS: Record<KnowledgeEntryKind, string> = {
  PRODUCT: "Products",
  DELIVERY: "Delivery (zone | fee | time and notes)",
  FAQ: "Frequently asked questions",
  RULE: "Shop rules",
  INFO: "General information",
};

function oneLine(value: string): string {
  return value.replace(/\s*\n\s*/g, " / ").trim();
}

function entryLine(entry: EntryText): string {
  switch (entry.kind) {
    case "PRODUCT": {
      const parts = [oneLine(entry.title)];
      parts.push(entry.price ? `Price: ${oneLine(entry.price)}` : "Price: not in the knowledge base");
      if (entry.content) parts.push(oneLine(entry.content));
      if (!entry.isActive) parts.push("OUT OF STOCK");
      return `- ${parts.join(" | ")}`;
    }
    case "DELIVERY":
      return `- ${[oneLine(entry.title), entry.price ? `Fee: ${oneLine(entry.price)}` : null, entry.content ? oneLine(entry.content) : null]
        .filter(Boolean)
        .join(" | ")}`;
    case "FAQ":
      return `- Q: ${oneLine(entry.title)}\n  A: ${oneLine(entry.content)}`;
    case "RULE":
      return `- ${oneLine(entry.title)}${entry.content ? `: ${oneLine(entry.content)}` : ""}`;
    case "INFO":
      return `- ${oneLine(entry.title)}${entry.content ? `: ${oneLine(entry.content)}` : ""}${entry.price ? ` (${oneLine(entry.price)})` : ""}`;
  }
}

/** The entries the bot may use: active ones, plus unavailable products. */
export function usableEntries<T extends EntryText>(entries: T[]): T[] {
  return entries.filter((entry) => entry.isActive || entry.kind === "PRODUCT");
}

export function formatKnowledgeBase(entries: EntryText[]): string {
  const usable = usableEntries(entries);
  if (usable.length === 0) return "(The knowledge base is empty.)";
  const blocks: string[] = [];
  for (const kind of KNOWLEDGE_KINDS) {
    const lines = usable.filter((entry) => entry.kind === kind).map(entryLine);
    if (lines.length) blocks.push(`### ${SECTIONS[kind]}\n${lines.join("\n")}`);
  }
  return blocks.join("\n\n");
}

/** Every text of the knowledge base, for the guard's list of known facts. */
export function knowledgeTexts(entries: EntryText[]): string[] {
  return usableEntries(entries).flatMap((entry) => [entry.title, entry.content, entry.price ?? ""]).filter(Boolean);
}
