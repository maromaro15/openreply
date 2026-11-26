/**
 * Suggestions waiting for a person (PLAN.md 6.15): what the past
 * conversations, the Telegram interview and the people's answers after a
 * handoff propose for the product cards and the knowledge base.
 *
 * Nothing here applies a suggestion: that happens only when a person
 * approves it. Every text is untrusted (a model wrote it from what customers
 * and the Page said), so it is bounded here again, whoever produced it.
 */
import { createHash } from "node:crypto";
import type { Prisma, SuggestionSource } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";

export const SUGGESTION_TARGETS = [
  "faq",
  "delivery",
  "product.strengths",
  "product.objections",
  "product.comparisons",
  "product.suitableFor",
] as const;
export type SuggestionTarget = (typeof SUGGESTION_TARGETS)[number];

/** What a suggestion carries: a question and its answer, one statement, or a list. */
export interface SuggestionPayload {
  question?: string;
  answer?: string;
  text?: string;
  items?: string[];
}

export interface NewSuggestion {
  target: SuggestionTarget;
  /** Required by the product targets: one of the brand's products. */
  productId?: string | null;
  payload: SuggestionPayload;
  /** The words it came from (a quote, a transcript), shown to the reviewer. */
  evidence?: string | null;
  /** The thread, message or interview it came from. */
  sourceRef?: string | null;
  /** Same key, same brand: stored once, so a re-run adds nothing twice. */
  dedupeKey?: string | null;
}

/** At least what each producer allows, so nothing valid is cut twice. */
export const SUGGESTION_LIMITS = {
  question: 300,
  answer: 1000,
  text: 2000,
  item: 300,
  items: 10,
  evidence: 1000,
  sourceRef: 500,
  dedupeKey: 200,
  perSave: 200,
} as const;

/** These carry a question and its answer; strengths carry a list; the others one statement. */
const QA_TARGETS = new Set<SuggestionTarget>(["faq", "product.objections"]);

export function isSuggestionTarget(value: unknown): value is SuggestionTarget {
  return typeof value === "string" && (SUGGESTION_TARGETS as readonly string[]).includes(value);
}

export function isProductTarget(target: SuggestionTarget): boolean {
  return target.startsWith("product.");
}

/** At most `limit` code points, never half of a character. */
function clip(text: string, limit: number): string {
  const chars = Array.from(text);
  return chars.length <= limit ? text : chars.slice(0, limit).join("").trimEnd();
}

/** Spaces collapsed, paragraphs kept (an answer may have several), bounded. */
function cleanText(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text ? clip(text, limit) : undefined;
}

/** One line: for list items, references and keys. */
function cleanLine(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  return text ? clip(text, limit) : undefined;
}

/**
 * The payload as stored for its target: only the fields that target uses,
 * bounded. Null when what the target needs is missing.
 */
export function cleanSuggestionPayload(target: SuggestionTarget, payload: unknown): SuggestionPayload | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const raw = payload as Record<string, unknown>;
  if (QA_TARGETS.has(target)) {
    const question = cleanText(raw.question, SUGGESTION_LIMITS.question);
    const answer = cleanText(raw.answer, SUGGESTION_LIMITS.answer);
    return question && answer ? { question, answer } : null;
  }
  if (target === "product.strengths") {
    const listed = Array.isArray(raw.items) ? raw.items : [];
    // A producer that writes one statement gives a one-item list.
    const items = [...new Set([...listed, raw.text].map((item) => cleanLine(item, SUGGESTION_LIMITS.item)).filter(Boolean))]
      .slice(0, SUGGESTION_LIMITS.items) as string[];
    return items.length ? { items } : null;
  }
  const text = cleanText(raw.text, SUGGESTION_LIMITS.text);
  return text ? { text } : null;
}

/** A stable key from what identifies a suggestion at its source. */
export function suggestionDedupeKey(...parts: (string | null | undefined)[]): string {
  return createHash("sha256")
    .update(JSON.stringify(parts.map((part) => part ?? "")))
    .digest("hex")
    .slice(0, 40);
}

/**
 * Store new PENDING suggestions for one brand. A product suggestion whose
 * product is not the brand's is dropped, as is one whose payload lacks what
 * its target needs; a dedupeKey stored before is skipped. Returns how many
 * were added.
 */
export async function saveSuggestions(
  workspaceId: string,
  source: SuggestionSource,
  items: NewSuggestion[]
): Promise<number> {
  const batch = items.slice(0, SUGGESTION_LIMITS.perSave);
  const wanted = [
    ...new Set(batch.map((item) => item.productId).filter((id): id is string => typeof id === "string" && id !== "")),
  ];
  const owned = new Set(
    wanted.length > 0
      ? (await prisma.product.findMany({ where: { workspaceId, id: { in: wanted } }, select: { id: true } })).map(
          (product) => product.id
        )
      : []
  );

  const data: Prisma.KnowledgeSuggestionCreateManyInput[] = [];
  for (const item of batch) {
    if (!isSuggestionTarget(item.target)) continue;
    const productId = isProductTarget(item.target) && item.productId && owned.has(item.productId) ? item.productId : null;
    if (isProductTarget(item.target) && !productId) continue;
    const payload = cleanSuggestionPayload(item.target, item.payload);
    if (!payload) continue;
    data.push({
      workspaceId,
      source,
      target: item.target,
      productId,
      payload: payload as Prisma.InputJsonValue,
      evidence: cleanText(item.evidence, SUGGESTION_LIMITS.evidence) ?? null,
      sourceRef: cleanLine(item.sourceRef, SUGGESTION_LIMITS.sourceRef) ?? null,
      dedupeKey: cleanLine(item.dedupeKey, SUGGESTION_LIMITS.dedupeKey) ?? null,
    });
  }
  if (data.length === 0) return 0;
  const { count } = await prisma.knowledgeSuggestion.createMany({ data, skipDuplicates: true });
  return count;
}

export async function countPendingSuggestions(workspaceId: string): Promise<number> {
  return prisma.knowledgeSuggestion.count({ where: { workspaceId, status: "PENDING" } });
}
