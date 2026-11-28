/**
 * Product drafts: cards read from the Page's posts (or a file) that wait for
 * a person. The bot only reads ACTIVE products, so a draft does nothing until
 * someone approves it, merges it into a product the brand already has, or
 * rejects it. Every query is scoped to the brand.
 */
import { z } from "zod";
import { Prisma, type ProductSource } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import type { FbStaticKey } from "@/lib/facebook/i18n";
import { codeKeyOf } from "./codes";
import { MAX_STRENGTHS, MAX_VARIANTS } from "./products";

const MAX_ID_LENGTH = 100;

export const draftActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve") }),
  z.object({ action: z.literal("merge"), targetId: z.string().trim().min(1).max(MAX_ID_LENGTH) }),
  z.object({ action: z.literal("reject") }),
]);

export type DraftAction = z.infer<typeof draftActionSchema>;

/** What a refused decision means: the API answers in English, the screen translates it. */
export const DRAFT_ERRORS = {
  not_found: { status: 404, message: "Product not found." },
  not_a_draft: { status: 409, message: "This product is not a draft any more." },
  target_not_found: { status: 404, message: "The product to merge into was not found." },
  invalid_target: { status: 400, message: "Choose a product that is not a draft, and not this one." },
  code_clash: {
    status: 409,
    message: "This code is already used by another product. Merge the draft into that product instead.",
  },
} as const satisfies Record<string, { status: number; message: FbStaticKey }>;

export type DraftError = keyof typeof DRAFT_ERRORS;

type Failure = { ok: false; error: DraftError; target?: { id: string; name: string } };

export type MergeSummary = {
  /** Whether the draft's price filled an empty one. */
  price: boolean;
  colours: number;
  pictures: number;
  strengths: number;
};

export type ApproveResult = { ok: true } | Failure;
export type RejectResult = { ok: true } | Failure;
export type MergeResult = { ok: true; target: { id: string; name: string }; copied: MergeSummary } | Failure;

export interface DraftInfo {
  id: string;
  name: string;
  code: string | null;
  price: string | null;
  source: ProductSource;
  sourceRef: string | null;
  /** sourceRef when it is an https link a person can open, else null. */
  sourceLink: string | null;
  /** The sentence the draft was read from. */
  sourceNote: string | null;
  /** The post's code, which another product of the brand already has: the draft was made without it. */
  codeClash: { code: string; holder: string } | null;
  /** A product of the brand whose code or name matches the draft: the merge target to preselect. */
  suggestedTargetId: string | null;
  suggestedBy: "code" | "name" | null;
}

/** Thrown inside a transaction to roll it back and answer with a failure. */
class Abort extends Error {
  readonly failure: Failure;

  constructor(failure: Failure) {
    super(failure.error);
    this.failure = failure;
  }
}

const fail = (error: DraftError, target?: { id: string; name: string }): Failure =>
  target ? { ok: false, error, target } : { ok: false, error };

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/** The post's address, only when a browser can safely open it: https, with a host, no spaces. */
export function postLinkOf(sourceRef: string | null | undefined): string | null {
  if (!sourceRef || !/^https:\/\/[^\s\p{Cc}]+$/iu.test(sourceRef)) return null;
  try {
    const url = new URL(sourceRef);
    return url.protocol === "https:" && url.hostname !== "" ? sourceRef : null;
  } catch {
    return null;
  }
}

// ─── The note of a post's draft ─────────────────────────────────────────────

/**
 * A line the posts job adds under the sentence when the post's code is
 * already another product's. Data, not prose: each screen words it in its own
 * language. The sentence is one line, so this line can never be part of it.
 */
const CLASH_LINE = "#code-clash ";

export function draftNote(sentence: string, clash: { code: string; holder: string } | null): string {
  return clash ? `${sentence}\n${CLASH_LINE}${JSON.stringify({ code: clash.code, holder: clash.holder })}` : sentence;
}

/** The sentence and the code clash of a draft's note; a note in any other shape is all sentence. */
export function readDraftNote(note: string | null | undefined): {
  sentence: string | null;
  clash: { code: string; holder: string } | null;
} {
  if (!note) return { sentence: null, clash: null };
  const lines = note.split("\n");
  const last = lines.at(-1) ?? "";
  if (lines.length < 2 || !last.startsWith(CLASH_LINE)) return { sentence: note, clash: null };
  try {
    const parsed = JSON.parse(last.slice(CLASH_LINE.length)) as { code?: unknown; holder?: unknown };
    if (typeof parsed.code === "string" && parsed.code && typeof parsed.holder === "string") {
      const sentence = lines.slice(0, -1).join("\n").trim();
      return { sentence: sentence || null, clash: { code: parsed.code, holder: parsed.holder } };
    }
  } catch {
    // Not ours after all: shown as written.
  }
  return { sentence: note, clash: null };
}

// ─── Reading ────────────────────────────────────────────────────────────────

/** Products other than the draft that are not drafts themselves. */
function candidates(workspaceId: string, draftId: string): Prisma.ProductWhereInput {
  return { workspaceId, id: { not: draftId }, status: { not: "DRAFT" } };
}

/** The draft, with where it came from and the product it most likely duplicates; null when it is not a draft of the brand. */
export async function getDraftInfo(workspaceId: string, id: string): Promise<DraftInfo | null> {
  const draft = await prisma.product.findFirst({
    where: { id, workspaceId, status: "DRAFT" },
    select: {
      id: true,
      name: true,
      code: true,
      codeKey: true,
      price: true,
      source: true,
      sourceRef: true,
      sourceNote: true,
    },
  });
  if (!draft) return null;
  const note = readDraftNote(draft.sourceNote);
  // A draft made without its code still points at the product that has it.
  const codeKey = draft.codeKey ?? (note.clash ? codeKeyOf(note.clash.code) : null);

  let suggestedTargetId: string | null = null;
  let suggestedBy: DraftInfo["suggestedBy"] = null;
  // Active products first, then the most recently edited.
  const order = [{ status: "asc" }, { updatedAt: "desc" }] satisfies Prisma.ProductOrderByWithRelationInput[];
  if (codeKey) {
    const byCode = await prisma.product.findFirst({
      where: {
        ...candidates(workspaceId, draft.id),
        OR: [{ codeKey }, { variants: { some: { workspaceId, codeKey } } }],
      },
      orderBy: order,
      select: { id: true },
    });
    if (byCode) [suggestedTargetId, suggestedBy] = [byCode.id, "code"];
  }
  if (!suggestedTargetId && draft.name.trim()) {
    const byName = await prisma.product.findFirst({
      where: { ...candidates(workspaceId, draft.id), name: { equals: draft.name.trim(), mode: "insensitive" } },
      orderBy: order,
      select: { id: true },
    });
    if (byName) [suggestedTargetId, suggestedBy] = [byName.id, "name"];
  }

  return {
    id: draft.id,
    name: draft.name,
    code: draft.code,
    price: draft.price,
    source: draft.source,
    sourceRef: draft.sourceRef,
    sourceLink: postLinkOf(draft.sourceRef),
    sourceNote: note.sentence,
    codeClash: note.clash,
    suggestedTargetId,
    suggestedBy,
  };
}

/** Why a draft that is not there cannot be decided: gone, or already decided. */
async function missingReason(workspaceId: string, id: string): Promise<Failure> {
  const row = await prisma.product.findFirst({ where: { id, workspaceId }, select: { id: true } });
  return fail(row ? "not_a_draft" : "not_found");
}

// ─── Deciding ───────────────────────────────────────────────────────────────

/**
 * Draft to ACTIVE. The card is not changed here (the person may have edited it
 * first). A code the brand already uses, as a product's or as a colour of one,
 * is refused: the answer names that product so the screen can offer Merge.
 */
export async function approveDraft(workspaceId: string, id: string): Promise<ApproveResult> {
  const draft = await prisma.product.findFirst({
    where: { id, workspaceId, status: "DRAFT" },
    select: { id: true, codeKey: true },
  });
  if (!draft) return missingReason(workspaceId, id);

  if (draft.codeKey) {
    const holder = await prisma.product.findFirst({
      where: {
        workspaceId,
        id: { not: id },
        OR: [{ codeKey: draft.codeKey }, { variants: { some: { workspaceId, codeKey: draft.codeKey } } }],
      },
      select: { id: true, name: true },
    });
    if (holder) return fail("code_clash", holder);
  }

  try {
    const updated = await prisma.product.updateMany({
      where: { id, workspaceId, status: "DRAFT" },
      data: { status: "ACTIVE" },
    });
    // Decided by someone else since the read.
    if (updated.count !== 1) return missingReason(workspaceId, id);
  } catch (error) {
    // The unique index (workspaceId, codeKey) refused a code taken meanwhile.
    if (isUniqueViolation(error)) return fail("code_clash");
    throw error;
  }
  return { ok: true };
}

/** Deletes the draft; its pictures, colours and relations go with it (foreign keys cascade). */
export async function rejectDraft(workspaceId: string, id: string): Promise<RejectResult> {
  const deleted = await prisma.product.deleteMany({ where: { id, workspaceId, status: "DRAFT" } });
  return deleted.count === 1 ? { ok: true } : missingReason(workspaceId, id);
}

/** Case and spacing do not make a strength new. */
const strengthKey = (strength: string) => strength.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Folds the draft into a product of the brand, then deletes the draft, all in
 * one transaction. Only what the target lacks is copied: its price when empty,
 * the draft's colours whose code it does not have, the draft's pictures (as
 * extra pictures; the draft's main one becomes the main picture only when the
 * target has none), and the strengths it does not list. Nothing a person wrote
 * in the target is overwritten. Suggestions waiting on the draft follow it to
 * the target.
 */
export async function mergeDraft(workspaceId: string, draftId: string, targetId: string): Promise<MergeResult> {
  if (draftId === targetId) return fail("invalid_target");
  try {
    return await prisma.$transaction(
      async (tx) => {
        const draft = await tx.product.findFirst({
          where: { id: draftId, workspaceId },
          select: {
            id: true,
            status: true,
            price: true,
            strengths: true,
            mainImageId: true,
            variants: { where: { workspaceId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], select: { id: true, codeKey: true } },
          },
        });
        if (!draft) throw new Abort(fail("not_found"));
        if (draft.status !== "DRAFT") throw new Abort(fail("not_a_draft"));

        const target = await tx.product.findFirst({
          where: { id: targetId, workspaceId },
          select: {
            id: true,
            name: true,
            status: true,
            price: true,
            strengths: true,
            mainImageId: true,
            variants: { where: { workspaceId }, select: { codeKey: true, sortOrder: true } },
          },
        });
        if (!target) throw new Abort(fail("target_not_found"));
        if (target.status === "DRAFT") throw new Abort(fail("invalid_target"));

        const data: Prisma.ProductUncheckedUpdateManyInput = {};
        const copied: MergeSummary = { price: false, colours: 0, pictures: 0, strengths: 0 };

        if (!target.price?.trim() && draft.price?.trim()) {
          data.price = draft.price;
          copied.price = true;
        }

        const known = new Set(target.strengths.map(strengthKey));
        const strengths = [...target.strengths];
        for (const strength of draft.strengths) {
          const key = strengthKey(strength);
          if (!key || known.has(key) || strengths.length >= MAX_STRENGTHS) continue;
          known.add(key);
          strengths.push(strength);
          copied.strengths += 1;
        }
        if (copied.strengths) data.strengths = strengths;

        // Colours the target has no code for keep their ids (and their pictures) and move over.
        const haveCodes = new Set(target.variants.map((variant) => variant.codeKey));
        let sortOrder = Math.max(-1, ...target.variants.map((variant) => variant.sortOrder));
        for (const variant of draft.variants) {
          if (haveCodes.has(variant.codeKey) || target.variants.length + copied.colours >= MAX_VARIANTS) continue;
          haveCodes.add(variant.codeKey);
          sortOrder += 1;
          const moved = await tx.productVariant.updateMany({
            where: { id: variant.id, workspaceId, productId: draftId },
            data: { productId: targetId, sortOrder },
          });
          copied.colours += moved.count;
        }

        // Pictures move before the draft is deleted, or the cascade would take them.
        const targetHadPictures = await tx.productImage.count({ where: { workspaceId, productId: targetId } });
        const moved = await tx.productImage.updateMany({
          where: {
            workspaceId,
            OR: [{ productId: draftId }, ...(draft.mainImageId ? [{ id: draft.mainImageId, productId: null }] : [])],
          },
          data: { productId: targetId },
        });
        copied.pictures = moved.count;
        if (draft.mainImageId && moved.count > 0 && !target.mainImageId && targetHadPictures === 0) {
          data.mainImageId = draft.mainImageId;
        }

        if (Object.keys(data).length) {
          const updated = await tx.product.updateMany({ where: { id: targetId, workspaceId }, data });
          if (updated.count !== 1) throw new Abort(fail("target_not_found"));
        }

        await tx.knowledgeSuggestion.updateMany({
          where: { workspaceId, productId: draftId },
          data: { productId: targetId },
        });

        const removed = await tx.product.deleteMany({ where: { id: draftId, workspaceId, status: "DRAFT" } });
        // Decided by someone else meanwhile: roll everything back.
        if (removed.count !== 1) throw new Abort(fail("not_a_draft"));

        return { ok: true as const, target: { id: target.id, name: target.name }, copied };
      },
      // Moving colours is one query each.
      { maxWait: 5_000, timeout: 20_000 }
    );
  } catch (error) {
    if (error instanceof Abort) return error.failure;
    throw error;
  }
}
