/**
 * The kb-posts job: a Page's recent posts read into DRAFT products
 * (PLAN.md 6.15). Nothing here reaches the bot by itself: a person approves,
 * edits, merges or rejects every draft.
 *
 * Also holds what the conversations job shares with it: the checks before a
 * run (Page, token, AI key), the messages a run can fail with, and the
 * retry rule (only network trouble and rate limits are worth another try).
 */
import { UnrecoverableError, type Job } from "bullmq";
import { prisma } from "@/lib/db/client";
import { getGoogleApiKey } from "@/lib/ai/env";
import { GeminiError } from "@/lib/ai/gemini";
import { downloadCustomerImage } from "@/lib/ai/image-download";
import { codeKeyOf, normalizeCode } from "@/lib/catalog/codes";
import { draftNote } from "@/lib/catalog/drafts";
import { deleteProductImage, getProductImageMaxBytes, storeProductImage } from "@/lib/catalog/images";
import { MAX_PRODUCTS, createProduct, productInputSchema } from "@/lib/catalog/products";
import { FacebookApiError } from "@/lib/facebook/graph";
import { pageToken } from "@/lib/facebook/pages";
import type { KnowledgePostsJob } from "@/lib/facebook/queue";
import { DEFAULT_POSTS_LIMIT, MAX_POSTS_LIMIT, extractDraftsFromPosts, fetchRecentPosts, type PagePost } from "@/lib/knowledge/posts";

// ─── Shared by the two jobs ─────────────────────────────────────────────────

/** Every message a run can fail with: English keys of the Arabic catalog, and the only job errors the status API shows. */
export const SOURCE_MESSAGES = {
  noKey: "The AI service is not configured (GOOGLE_API_KEY).",
  noPage: "This Page is not connected to this brand.",
  pageOff: "This Page is not connected right now. Reconnect it and try again.",
  tokenInvalid: "Facebook no longer accepts this Page's access token. Reconnect the Page and try again.",
  tokenUnreadable: "The Page's access token could not be read. Reconnect the Page and try again.",
  noPermission: "Facebook did not allow reading this Page. Reconnect it and grant every permission.",
  facebookBusy: "Facebook is limiting requests or cannot be reached right now. Try again in a few minutes.",
  facebookRefused: "Facebook refused the request. Check the Page's connection and try again.",
  aiKey: "The AI service key is not working. Check GOOGLE_API_KEY.",
  aiBusy: "The AI service is busy or cannot be reached. Try again in a few minutes.",
  aiRefused: "The AI service could not read this content. Try again later.",
} as const;

const KNOWN_MESSAGES: ReadonlySet<string> = new Set(Object.values(SOURCE_MESSAGES));

/** A stored failure reason is shown only when it is one of ours: anything else may carry technical detail. */
export function isSourceMessage(value: string): boolean {
  return KNOWN_MESSAGES.has(value);
}

export interface SourcePage {
  /** The Page ID on Facebook. */
  pageId: string;
  token: string;
}

type JobLike = Pick<Job, "attemptsMade" | "opts">;

function isLastAttempt(job: JobLike): boolean {
  return job.attemptsMade + 1 >= (job.opts?.attempts ?? 1);
}

/** The run is over, nothing to retry. */
function finalFailure(message: string): never {
  throw new UnrecoverableError(message);
}

/** The Page of this brand, connected, with its token; or a final failure with a clear message. */
export async function loadSourcePage(workspaceId: string, facebookPageId: string): Promise<SourcePage> {
  const page = await prisma.facebookPage.findFirst({
    where: { id: facebookPageId, workspaceId },
    select: { id: true, pageId: true, accessToken: true, status: true },
  });
  if (!page) return finalFailure(SOURCE_MESSAGES.noPage);
  if (page.status === "TOKEN_INVALID") return finalFailure(SOURCE_MESSAGES.tokenInvalid);
  if (page.status !== "ACTIVE") return finalFailure(SOURCE_MESSAGES.pageOff);
  try {
    return { pageId: page.pageId, token: pageToken(page) };
  } catch {
    return finalFailure(SOURCE_MESSAGES.tokenUnreadable);
  }
}

/** No key, no run: the model would fail on the first call anyway. */
export function requireAiKey(): void {
  if (!getGoogleApiKey()) finalFailure(SOURCE_MESSAGES.noKey);
}

/**
 * What to throw for a failed run. Network trouble and rate limits (Facebook's
 * or Gemini's) are rethrown as they are so BullMQ tries again; on the last
 * attempt, and for everything else we understand, the failure is final with
 * a clear message. An error we do not know is rethrown untouched.
 */
export function sourceFailure(error: unknown, job: JobLike): never {
  let retry: string | null = null;
  let final: string | null = null;

  if (error instanceof FacebookApiError) {
    if (error.kind === "token_invalid") final = SOURCE_MESSAGES.tokenInvalid;
    else if (error.kind === "permission") final = SOURCE_MESSAGES.noPermission;
    else if (error.kind === "rate_limit" || error.kind === "unreachable" || error.kind === "ambiguous") {
      retry = SOURCE_MESSAGES.facebookBusy;
    } else final = SOURCE_MESSAGES.facebookRefused;
  } else if (error instanceof GeminiError) {
    if (error.kind === "missing_key" || error.kind === "auth") final = SOURCE_MESSAGES.aiKey;
    else if (error.retryable) retry = SOURCE_MESSAGES.aiBusy;
    else final = SOURCE_MESSAGES.aiRefused;
  }

  if (final) return finalFailure(final);
  if (retry) {
    if (!isLastAttempt(job)) throw error;
    return finalFailure(retry);
  }
  throw error;
}

// ─── Summary ────────────────────────────────────────────────────────────────

/** What the status API reads from the job's progress. Numbers only. */
export interface PostsSummary {
  kind: "posts";
  postsRead: number;
  /** Posts an earlier run already read: skipped, so a decided draft never comes back. */
  postsSkipped: number;
  draftsCreated: number;
  /** Drafts whose product was already made from the same post (a re-run). */
  alreadyThere: number;
  /** Created, but the picture could not be downloaded or stored. */
  withoutPicture: number;
  /** Created without their code because the brand already has it. */
  codeClashes: number;
  /** Not saved: the card was refused. */
  failed: number;
  /** The brand's product limit stopped the run. */
  stoppedAtLimit: boolean;
}

// ─── The job ────────────────────────────────────────────────────────────────

/** A post is known by its link when it has one, else its ID; a run can see both. */
function postRefs(post: PagePost): string[] {
  return [...new Set([post.permalink, post.id].filter((ref): ref is string => Boolean(ref)))];
}

const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();

export async function processPostsJob(job: Job<KnowledgePostsJob>): Promise<string> {
  const { workspaceId, facebookPageId } = job.data;
  const limit = Math.min(Math.max(Math.trunc(job.data.limit ?? DEFAULT_POSTS_LIMIT) || DEFAULT_POSTS_LIMIT, 1), MAX_POSTS_LIMIT);

  const page = await loadSourcePage(workspaceId, facebookPageId);
  requireAiKey();

  const summary: PostsSummary = {
    kind: "posts",
    postsRead: 0,
    postsSkipped: 0,
    draftsCreated: 0,
    alreadyThere: 0,
    withoutPicture: 0,
    codeClashes: 0,
    failed: 0,
    stoppedAtLimit: false,
  };

  let posts: PagePost[];
  let fresh: PagePost[];
  let drafts: Awaited<ReturnType<typeof extractDraftsFromPosts>>;
  try {
    posts = await fetchRecentPosts(page.pageId, page.token, { limit });
    summary.postsRead = posts.length;
    // A post an earlier run read is not read again: what a person rejected or
    // merged stays decided, and the model is not asked twice.
    const read = posts.length
      ? await prisma.postRead.findMany({
          where: { workspaceId, postId: { in: posts.map((post) => post.id) } },
          select: { postId: true },
        })
      : [];
    const done = new Set(read.map((row) => row.postId));
    fresh = posts.filter((post) => !done.has(post.id));
    summary.postsSkipped = posts.length - fresh.length;
    drafts = fresh.length ? await extractDraftsFromPosts(fresh) : [];
  } catch (error) {
    return sourceFailure(error, job);
  }

  const postById = new Map(posts.map((post) => [post.id, post]));

  // What an earlier run already made from these posts: a re-run adds nothing twice.
  const refs = [...new Set(posts.flatMap(postRefs))];
  const known = new Map<string, { nameKey: string; codeKey: string | null }[]>();
  const remember = (ref: string, name: string, codeKey: string | null) => {
    known.set(ref, [...(known.get(ref) ?? []), { nameKey: normalizeCode(name), codeKey }]);
  };
  if (refs.length > 0 && drafts.length > 0) {
    const rows = await prisma.product.findMany({
      where: { workspaceId, source: "POST", sourceRef: { in: refs } },
      select: { sourceRef: true, name: true, codeKey: true },
    });
    for (const row of rows) if (row.sourceRef) remember(row.sourceRef, row.name, row.codeKey);
  }

  let room = MAX_PRODUCTS - (drafts.length > 0 ? await prisma.product.count({ where: { workspaceId } }) : 0);
  let imagesAllowed = true;
  // Drafts of one post come one after the other and share its picture: download it once.
  let lastDownload: { url: string; bytes: Buffer | null } | null = null;

  async function pictureFor(url: string | null): Promise<string | null> {
    if (!url || !imagesAllowed) return null;
    if (lastDownload?.url !== url) {
      try {
        const downloaded = await downloadCustomerImage(url, { maxBytes: getProductImageMaxBytes() });
        lastDownload = { url, bytes: downloaded.bytes };
      } catch {
        lastDownload = { url, bytes: null };
      }
    }
    if (!lastDownload.bytes) return null;
    const stored = await storeProductImage(workspaceId, { bytes: lastDownload.bytes });
    if (stored.ok) return stored.image.id;
    if (stored.error === "too_many") imagesAllowed = false;
    return null;
  }

  async function holderOf(codeKey: string): Promise<string | null> {
    const holder = await prisma.product.findFirst({ where: { workspaceId, codeKey }, select: { name: true } });
    return holder ? oneLine(holder.name) : null;
  }

  /** One draft: created, skipped, failed for good, or the run must stop (the product limit). */
  async function handleDraft(draft: (typeof drafts)[number]): Promise<"created" | "skipped" | "failed" | "stop"> {
    const post = postById.get(draft.postId);
    if (!post) return "skipped";
    const refList = postRefs(post);
    const ref = refList[0] ?? post.id;
    const nameKey = normalizeCode(draft.name);
    const draftCodeKey = codeKeyOf(draft.code);

    const seen = refList.flatMap((item) => known.get(item) ?? []);
    if (seen.some((row) => row.nameKey === nameKey || (draftCodeKey !== null && row.codeKey === draftCodeKey))) {
      summary.alreadyThere += 1;
      return "skipped";
    }
    if (room <= 0) {
      summary.stoppedAtLimit = true;
      return "stop";
    }

    // A code the brand already uses is written in the note, not on the card: codes are unique.
    let code = draft.code;
    let clashHolder: string | null = null;
    if (code && draftCodeKey) {
      clashHolder = await holderOf(draftCodeKey);
      if (clashHolder) code = null;
    }

    const imageId = await pictureFor(draft.imageUrl);
    const variants = draft.colours
      .filter((colour) => codeKeyOf(colour.code) !== null)
      .map((colour) => ({ code: colour.code, name: colour.name }));

    let created = false;
    for (let attempt = 0; attempt < 2 && !created; attempt += 1) {
      const note = draftNote(draft.evidence, clashHolder && draft.code ? { code: draft.code, holder: clashHolder } : null);
      const input = productInputSchema.safeParse({
        name: draft.name,
        code,
        price: draft.price,
        status: "DRAFT",
        variants,
        mainImageId: imageId,
      });
      if (!input.success) break;
      const result = await createProduct(workspaceId, input.data, { source: "POST", sourceRef: ref, sourceNote: note });
      if (result.ok) {
        created = true;
      } else if (result.error === "duplicate_code" && code && draftCodeKey && attempt === 0) {
        // Another card took the code since the check: write the clash and try once more without it.
        clashHolder = (await holderOf(draftCodeKey)) ?? "another product";
        code = null;
      } else {
        if (result.error === "too_many") summary.stoppedAtLimit = true;
        break;
      }
    }

    if (!created) {
      if (imageId) await deleteProductImage(workspaceId, imageId).catch(() => false);
      if (summary.stoppedAtLimit) return "stop";
      summary.failed += 1;
      return "failed";
    }

    room -= 1;
    summary.draftsCreated += 1;
    if (clashHolder) summary.codeClashes += 1;
    if (draft.imageUrl && !imageId) summary.withoutPicture += 1;
    for (const item of refList) remember(item, draft.name, code ? draftCodeKey : null);
    return "created";
  }

  // How many drafts each post still has to go; a post is read for good once none is left.
  const left = new Map<string, number>();
  for (const item of drafts) left.set(item.postId, (left.get(item.postId) ?? 0) + 1);
  const madeFrom = new Map<string, number>();
  for (const draft of drafts) {
    const outcome = await handleDraft(draft);
    if (outcome === "stop") break;
    left.set(draft.postId, (left.get(draft.postId) ?? 1) - 1);
    if (outcome === "created") madeFrom.set(draft.postId, (madeFrom.get(draft.postId) ?? 0) + 1);
  }
  // A post that gave no draft is read too. One the limit stopped before is read again next time.
  const finished = fresh.filter((post) => (left.get(post.id) ?? 0) === 0);
  if (finished.length > 0) {
    await prisma.postRead.createMany({
      data: finished.map((post) => ({ workspaceId, postId: post.id, drafts: madeFrom.get(post.id) ?? 0 })),
      skipDuplicates: true,
    });
  }

  await job.updateProgress({ ...summary });
  return (
    `Read ${summary.postsRead} posts (${summary.postsSkipped} read before): ${summary.draftsCreated} drafts created, ` +
    `${summary.alreadyThere} already there${summary.stoppedAtLimit ? ", stopped at the product limit" : ""}.`
  );
}
