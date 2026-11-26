/**
 * The kb-conversations job: a Page's past Messenger answers read into
 * suggestions (PLAN.md 6.15). Every suggestion waits PENDING for a person.
 */
import type { Job } from "bullmq";
import { prisma } from "@/lib/db/client";
import { normalizeCode } from "@/lib/catalog/codes";
import type { KnowledgeConversationsJob } from "@/lib/facebook/queue";
import {
  DEFAULT_THREAD_LIMIT,
  MAX_THREAD_LIMIT,
  fetchPageConversations,
  mineSuggestions,
  type MinedSuggestion,
} from "@/lib/knowledge/conversations";
import {
  isProductTarget,
  saveSuggestions,
  suggestionDedupeKey,
  type NewSuggestion,
} from "@/lib/knowledge/suggestions";
import { loadSourcePage, requireAiKey, sourceFailure } from "./posts";

/** What the status API reads from the job's progress. Numbers only. */
export interface ConversationsSummary {
  kind: "conversations";
  threadsRead: number;
  /** What the model found and the checks kept. */
  suggestionsFound: number;
  /** New ones: the rest were already waiting, or were refused as incomplete. */
  suggestionsAdded: number;
}

/** The most products given to the model, newest first: the model itself reads no more than this. */
const KNOWN_PRODUCTS = 200;

interface KnownProduct {
  id: string;
  name: string;
  code: string | null;
  codeKey: string | null;
}

const nameKey = (value: string) => value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * The brand's product a hint (a code or a name) points at. A code wins; a
 * name must match exactly, once. Two products with the same name, or no
 * match, give none.
 */
export function resolveProductHint(hint: string | null, products: KnownProduct[]): string | null {
  if (!hint) return null;
  const codeKey = normalizeCode(hint);
  if (codeKey) {
    const byCode = products.filter((product) => product.codeKey === codeKey);
    if (byCode.length === 1) return byCode[0].id;
  }
  const wanted = nameKey(hint);
  if (!wanted) return null;
  const byName = products.filter((product) => nameKey(product.name) === wanted);
  return byName.length === 1 ? byName[0].id : null;
}

/** The suggestions to store, or null when this one must be dropped. */
export function toNewSuggestion(mined: MinedSuggestion, products: KnownProduct[]): NewSuggestion | null {
  let target: NewSuggestion["target"] = mined.target;
  let productId: string | null = null;

  if (isProductTarget(target)) {
    productId = resolveProductHint(mined.productHint, products);
    if (!productId) {
      // A worry the customers voiced stays useful to the whole brand as a question and its answer.
      if (target !== "product.objections") return null;
      target = "faq";
    }
  }

  const { question, answer, text } = mined.payload;
  const subject = question ?? text;
  if (!subject) return null;
  return {
    target,
    productId,
    payload: { question, answer, text },
    evidence: mined.evidence.quote,
    sourceRef: mined.evidence.threadId,
    dedupeKey: suggestionDedupeKey(mined.evidence.threadId, target, subject),
  };
}

export async function processConversationsJob(job: Job<KnowledgeConversationsJob>): Promise<string> {
  const { workspaceId, facebookPageId } = job.data;
  const limit = Math.min(
    Math.max(Math.trunc(job.data.limit ?? DEFAULT_THREAD_LIMIT) || DEFAULT_THREAD_LIMIT, 1),
    MAX_THREAD_LIMIT
  );

  const page = await loadSourcePage(workspaceId, facebookPageId);
  requireAiKey();

  const summary: ConversationsSummary = { kind: "conversations", threadsRead: 0, suggestionsFound: 0, suggestionsAdded: 0 };

  let mined: MinedSuggestion[] = [];
  let products: KnownProduct[] = [];
  try {
    const threads = await fetchPageConversations(page.pageId, page.token, { limit });
    summary.threadsRead = threads.length;
    if (threads.length > 0) {
      // Archived products are no longer sold: nothing is suggested for them.
      products = await prisma.product.findMany({
        where: { workspaceId, status: { in: ["ACTIVE", "DRAFT"] } },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: KNOWN_PRODUCTS,
        select: { id: true, name: true, code: true, codeKey: true },
      });
      mined = await mineSuggestions(threads, {
        knownProducts: products.map((product) => ({ name: product.name, code: product.code })),
      });
    }
  } catch (error) {
    return sourceFailure(error, job);
  }

  const items = mined.flatMap((item) => toNewSuggestion(item, products) ?? []);
  summary.suggestionsFound = items.length;
  if (items.length > 0) summary.suggestionsAdded = await saveSuggestions(workspaceId, "CONVERSATION", items);

  await job.updateProgress({ ...summary });
  return `Read ${summary.threadsRead} conversations: ${summary.suggestionsAdded} suggestions added (${summary.suggestionsFound} found).`;
}
