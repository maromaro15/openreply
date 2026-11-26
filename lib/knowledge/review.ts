/**
 * The review of suggestions (PLAN.md 6.15): list them, and let a person
 * approve (which writes into a product card or the knowledge base) or reject.
 *
 * Nothing is applied before a person approves it. Approving is one
 * transaction: the PENDING row is claimed with a conditional update (so a
 * second click, or a second reviewer, finds it already decided), then the
 * write happens, and any failure rolls the claim back. Every query is scoped
 * to the brand. The texts are untrusted (a model wrote them from what customers
 * said), so the reviewer's edit goes through cleanSuggestionPayload again and
 * the result is checked against the same limits as a hand-written entry.
 */
import { Prisma, type SuggestionSource, type SuggestionStatus } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import {
  formatKnowledgeBase,
  KNOWLEDGE_MAX_CHARS,
  knowledgeEntrySchema,
  MAX_KNOWLEDGE_ENTRIES,
} from "@/lib/bot/knowledge";
import { MAX_OBJECTIONS, MAX_STRENGTHS, productInputSchema } from "@/lib/catalog/products";
import type { FbStaticKey } from "@/lib/facebook/i18n";
import {
  cleanSuggestionPayload,
  isSuggestionTarget,
  type SuggestionPayload,
  type SuggestionTarget,
} from "./suggestions";

export const SUGGESTION_SOURCES = ["POST", "CONVERSATION", "INTERVIEW", "HANDOFF_REPLY"] as const satisfies readonly SuggestionSource[];
export const SUGGESTION_STATUSES = ["PENDING", "APPROVED", "REJECTED"] as const satisfies readonly SuggestionStatus[];

export const REVIEW_PAGE_SIZE = 50;
export const REVIEW_MAX_PAGE_SIZE = 100;
export const REVIEW_MAX_BULK = 200;
/** A delivery entry's title is the text's first line, cut to this. */
export const DELIVERY_TITLE_MAX = 80;

/** Messages are keys of the Arabic catalog: the screen translates them. */
export const REVIEW_ERRORS = {
  not_found: { status: 404, message: "Suggestion not found." },
  already_decided: { status: 409, message: "This suggestion was already decided." },
  invalid_payload: { status: 400, message: "This suggestion is missing what it needs. Fill in its fields." },
  product_missing: { status: 404, message: "The product of this suggestion is gone." },
  too_many_entries: { status: 400, message: "The knowledge base has reached the number of entries it can hold." },
  knowledge_too_big: { status: 400, message: "The knowledge base would become too big. Remove some entries first." },
  entry_invalid: { status: 400, message: "The entry does not fit the knowledge base's limits." },
  too_many_strengths: { status: 400, message: "The product card has reached the number of strengths it can hold." },
  too_many_objections: { status: 400, message: "The product card has reached the number of questions and worries it can hold." },
  field_too_long: { status: 400, message: "The text would be too long for this field of the product card." },
  conflict: { status: 409, message: "The product was changed at the same time. Try again." },
} as const satisfies Record<string, { status: number; message: FbStaticKey }>;

export type ReviewErrorCode = keyof typeof REVIEW_ERRORS;

// ─── Listing ────────────────────────────────────────────────────────────────

export interface SuggestionView {
  id: string;
  source: SuggestionSource;
  target: SuggestionTarget;
  productId: string | null;
  productName: string | null;
  payload: SuggestionPayload;
  evidence: string | null;
  sourceRef: string | null;
  /** Set only when sourceRef is one of this brand's conversations: the screen links to it. */
  conversationId: string | null;
  status: SuggestionStatus;
  decidedAt: string | null;
  createdAt: string;
}

export interface SuggestionCounts {
  pending: number;
  bySource: Record<SuggestionSource, number>;
}

export interface SuggestionQuery {
  /** PENDING when omitted; null means every status. */
  status?: SuggestionStatus | null;
  source?: SuggestionSource | null;
  cursor?: string | null;
  take?: number;
}

export function isSuggestionSource(value: unknown): value is SuggestionSource {
  return typeof value === "string" && (SUGGESTION_SOURCES as readonly string[]).includes(value);
}

export function isSuggestionStatus(value: unknown): value is SuggestionStatus {
  return typeof value === "string" && (SUGGESTION_STATUSES as readonly string[]).includes(value);
}

/** Keyset pagination on (createdAt, id): it survives rows being decided meanwhile. */
function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(`${row.createdAt.toISOString()} ${row.id}`).toString("base64url");
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  const [iso = "", id, ...rest] = Buffer.from(cursor, "base64url").toString("utf8").split(" ");
  const createdAt = new Date(iso);
  return id && rest.length === 0 && !Number.isNaN(createdAt.getTime()) ? { createdAt, id } : null;
}

function pageSize(take: number | undefined): number {
  if (take === undefined || !Number.isFinite(take)) return REVIEW_PAGE_SIZE;
  return Math.min(Math.max(Math.trunc(take), 1), REVIEW_MAX_PAGE_SIZE);
}

/** What is stored is whatever a producer wrote: keep only the known, well-typed fields. */
function payloadOf(value: unknown): SuggestionPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const payload: SuggestionPayload = {};
  if (typeof raw.question === "string") payload.question = raw.question;
  if (typeof raw.answer === "string") payload.answer = raw.answer;
  if (typeof raw.text === "string") payload.text = raw.text;
  if (Array.isArray(raw.items)) payload.items = raw.items.filter((item): item is string => typeof item === "string");
  return payload;
}

export async function countSuggestions(workspaceId: string): Promise<SuggestionCounts> {
  const groups = await prisma.knowledgeSuggestion.groupBy({
    by: ["source"],
    where: { workspaceId, status: "PENDING" },
    _count: { _all: true },
  });
  const bySource = { POST: 0, CONVERSATION: 0, INTERVIEW: 0, HANDOFF_REPLY: 0 } satisfies Record<SuggestionSource, number>;
  for (const group of groups) bySource[group.source] = group._count._all;
  return { pending: Object.values(bySource).reduce((sum, count) => sum + count, 0), bySource };
}

/** Newest first. Product names and conversation links are read in one query each, within the brand. */
export async function listSuggestions(
  workspaceId: string,
  query: SuggestionQuery = {}
): Promise<{ suggestions: SuggestionView[]; nextCursor: string | null }> {
  const take = pageSize(query.take);
  const status = query.status === undefined ? "PENDING" : query.status;
  const and: Prisma.KnowledgeSuggestionWhereInput[] = [];
  if (query.cursor) {
    const after = decodeCursor(query.cursor);
    if (!after) return { suggestions: [], nextCursor: null };
    and.push({ OR: [{ createdAt: { lt: after.createdAt } }, { createdAt: after.createdAt, id: { lt: after.id } }] });
  }
  const rows = await prisma.knowledgeSuggestion.findMany({
    where: {
      workspaceId,
      ...(status ? { status } : {}),
      ...(query.source ? { source: query.source } : {}),
      ...(and.length ? { AND: and } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: take + 1,
  });
  const page = rows.slice(0, take);
  const last = page.at(-1);

  const productIds = [...new Set(page.map((row) => row.productId).filter((id): id is string => !!id))];
  const refs = [...new Set(page.filter((row) => row.source !== "INTERVIEW" && row.sourceRef).map((row) => row.sourceRef as string))];
  const [products, conversations] = await Promise.all([
    productIds.length
      ? prisma.product.findMany({ where: { workspaceId, id: { in: productIds } }, select: { id: true, name: true } })
      : [],
    refs.length
      ? prisma.facebookConversation.findMany({ where: { workspaceId, id: { in: refs } }, select: { id: true } })
      : [],
  ]);
  const names = new Map(products.map((product) => [product.id, product.name]));
  const known = new Set(conversations.map((conversation) => conversation.id));

  const suggestions: SuggestionView[] = [];
  for (const row of page) {
    if (!isSuggestionTarget(row.target)) continue;
    suggestions.push({
      id: row.id,
      source: row.source,
      target: row.target,
      productId: row.productId,
      productName: row.productId ? (names.get(row.productId) ?? null) : null,
      payload: payloadOf(row.payload),
      evidence: row.evidence,
      sourceRef: row.sourceRef,
      conversationId: row.source !== "INTERVIEW" && row.sourceRef && known.has(row.sourceRef) ? row.sourceRef : null,
      status: row.status,
      decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
    });
  }
  return { suggestions, nextCursor: rows.length > take && last ? encodeCursor(last) : null };
}

// ─── Deciding ───────────────────────────────────────────────────────────────

export type Applied =
  | { kind: "knowledge"; entryId: string; entryKind: "FAQ" | "DELIVERY" }
  | { kind: "product"; productId: string; target: SuggestionTarget; changed: boolean };

export type ReviewResult =
  | { ok: true; applied: Applied | null }
  | { ok: false; error: ReviewErrorCode; detail?: string };

/** Thrown inside the transaction to roll the claim back with the reason. */
class Abort extends Error {
  constructor(
    readonly code: ReviewErrorCode,
    readonly detail?: string
  ) {
    super(code);
  }
}

function paragraph(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** The first line as the title of a delivery entry, cut at DELIVERY_TITLE_MAX characters. */
export function deliveryTitle(text: string): string {
  const first = text.split("\n").find((line) => line.trim() !== "") ?? "";
  const chars = Array.from(first.replace(/\s+/g, " ").trim());
  return chars.length <= DELIVERY_TITLE_MAX ? chars.join("") : `${chars.slice(0, DELIVERY_TITLE_MAX - 1).join("").trimEnd()}…`;
}

async function writeKnowledge(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  target: "faq" | "delivery",
  payload: SuggestionPayload
): Promise<Applied> {
  let kind: "FAQ" | "DELIVERY";
  let title: string;
  let content: string;
  if (target === "faq") {
    kind = "FAQ";
    title = payload.question ?? "";
    content = payload.answer ?? "";
  } else {
    kind = "DELIVERY";
    const text = payload.text ?? "";
    title = deliveryTitle(text);
    // A one-line text is its own title: repeating it would only lengthen the prompt.
    content = text === title ? "" : text;
  }
  const parsed = knowledgeEntrySchema.safeParse({ kind, title, content });
  if (!parsed.success) throw new Abort("entry_invalid", parsed.error.issues[0]?.message);

  // READ COMMITTED: two approvals could both count the same entries and both
  // fit. The brand's lock (held to the end of the transaction) serialises
  // them, so the second counts the first's entry.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`knowledge-entries:${workspaceId}`}))`;
  const existing = await tx.knowledgeEntry.findMany({
    where: { workspaceId },
    select: { kind: true, title: true, content: true, price: true, isActive: true },
  });
  if (existing.length >= MAX_KNOWLEDGE_ENTRIES) throw new Abort("too_many_entries");
  if (formatKnowledgeBase([...existing, { ...parsed.data, price: null }]).length > KNOWLEDGE_MAX_CHARS) {
    throw new Abort("knowledge_too_big");
  }
  const entry = await tx.knowledgeEntry.create({
    data: { workspaceId, kind, title: parsed.data.title, content: parsed.data.content, price: null },
  });
  return { kind: "knowledge", entryId: entry.id, entryKind: kind };
}

/** The card's objections as stored: a Json column, so only well-formed pairs count. */
function storedObjections(value: unknown): { question: string; answer: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const { question, answer } = item as Record<string, unknown>;
    return typeof question === "string" && typeof answer === "string" ? [{ question, answer }] : [];
  });
}

async function writeProduct(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  productId: string | null,
  target: Exclude<SuggestionTarget, "faq" | "delivery">,
  payload: SuggestionPayload
): Promise<Applied> {
  const product = productId
    ? await tx.product.findFirst({
        where: { id: productId, workspaceId },
        select: { id: true, strengths: true, objections: true, comparisons: true, suitableFor: true, updatedAt: true },
      })
    : null;
  if (!product) throw new Abort("product_missing");

  const data: Prisma.ProductUpdateManyMutationInput = {};
  if (target === "product.strengths") {
    const have = new Set(product.strengths.map((item) => item.toLowerCase()));
    const added: string[] = [];
    for (const item of payload.items ?? []) {
      if (have.has(item.toLowerCase())) continue;
      have.add(item.toLowerCase());
      added.push(item);
    }
    if (added.length > 0) {
      if (product.strengths.length + added.length > MAX_STRENGTHS) throw new Abort("too_many_strengths");
      data.strengths = [...product.strengths, ...added];
    }
  } else if (target === "product.objections") {
    const objections = storedObjections(product.objections);
    const entry = { question: payload.question ?? "", answer: payload.answer ?? "" };
    const same = (a: { question: string; answer: string }) =>
      paragraph(a.question).toLowerCase() === paragraph(entry.question).toLowerCase() &&
      paragraph(a.answer).toLowerCase() === paragraph(entry.answer).toLowerCase();
    if (!objections.some(same)) {
      if (objections.length + 1 > MAX_OBJECTIONS) throw new Abort("too_many_objections");
      data.objections = [...objections, entry];
    }
  } else {
    // comparisons and suitableFor: a new paragraph after what is written.
    const field = target === "product.comparisons" ? "comparisons" : "suitableFor";
    const current = (product[field] ?? "").trim();
    const text = payload.text ?? "";
    if (!current.includes(text)) data[field] = current ? `${current}\n\n${text}` : text;
  }

  const changed = Object.keys(data).length > 0;
  if (changed) {
    // The limits of the card itself, so a suggestion can never make a card the editor would refuse.
    const checked = productInputSchema.pick({ strengths: true, objections: true, comparisons: true, suitableFor: true }).safeParse({
      strengths: data.strengths ?? product.strengths,
      objections: data.objections ?? storedObjections(product.objections),
      comparisons: data.comparisons ?? product.comparisons,
      suitableFor: data.suitableFor ?? product.suitableFor,
    });
    if (!checked.success) throw new Abort("field_too_long", String(checked.error.issues[0]?.path[0] ?? ""));
    // Only if nobody changed the card since it was read (two approvals on one card at once).
    const updated = await tx.product.updateMany({
      where: { id: product.id, workspaceId, updatedAt: product.updatedAt },
      data,
    });
    if (updated.count !== 1) throw new Abort("conflict");
  }
  return { kind: "product", productId: product.id, target, changed };
}

/**
 * Approve one suggestion, optionally with the reviewer's edit of its payload.
 * Safe to repeat and to race: only a PENDING row is claimed.
 */
export async function approveSuggestion(
  workspaceId: string,
  userId: string,
  id: string,
  edited?: unknown
): Promise<ReviewResult> {
  try {
    const applied = await prisma.$transaction(
      async (tx) => {
        const row = await tx.knowledgeSuggestion.findFirst({ where: { id, workspaceId } });
        if (!row || !isSuggestionTarget(row.target)) throw new Abort("not_found");
        if (row.status !== "PENDING") throw new Abort("already_decided");
        const target = row.target;
        const payload = cleanSuggestionPayload(target, edited === undefined ? row.payload : edited);
        if (!payload) throw new Abort("invalid_payload");

        // The claim comes first: it takes the row's lock, so a concurrent approval waits and then finds it decided.
        const claim = await tx.knowledgeSuggestion.updateMany({
          where: { id, workspaceId, status: "PENDING" },
          data: {
            status: "APPROVED",
            decidedByUserId: userId,
            decidedAt: new Date(),
            // What was applied, as edited.
            payload: payload as Prisma.InputJsonValue,
          },
        });
        if (claim.count !== 1) throw new Abort("already_decided");

        if (target === "faq" || target === "delivery") return writeKnowledge(tx, workspaceId, target, payload);
        return writeProduct(tx, workspaceId, row.productId, target, payload);
      },
      { maxWait: 5_000, timeout: 15_000 }
    );
    return { ok: true, applied };
  } catch (error) {
    if (error instanceof Abort) return { ok: false, error: error.code, ...(error.detail ? { detail: error.detail } : {}) };
    throw error;
  }
}

/** Reject keeps the row for history; it is never offered again. */
export async function rejectSuggestion(workspaceId: string, userId: string, id: string): Promise<ReviewResult> {
  const rejected = await prisma.knowledgeSuggestion.updateMany({
    where: { id, workspaceId, status: "PENDING" },
    data: { status: "REJECTED", decidedByUserId: userId, decidedAt: new Date() },
  });
  if (rejected.count === 1) return { ok: true, applied: null };
  const exists = await prisma.knowledgeSuggestion.findFirst({ where: { id, workspaceId }, select: { id: true } });
  return { ok: false, error: exists ? "already_decided" : "not_found" };
}

/** Reject several at once; only the brand's PENDING ones count. Returns how many were rejected. */
export async function rejectSuggestions(workspaceId: string, userId: string, ids: string[]): Promise<number> {
  const unique = [...new Set(ids)].slice(0, REVIEW_MAX_BULK);
  if (unique.length === 0) return 0;
  const { count } = await prisma.knowledgeSuggestion.updateMany({
    where: { id: { in: unique }, workspaceId, status: "PENDING" },
    data: { status: "REJECTED", decidedByUserId: userId, decidedAt: new Date() },
  });
  return count;
}
