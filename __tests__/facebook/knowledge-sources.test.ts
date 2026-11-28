import { NextRequest } from "next/server";
import { UnrecoverableError } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  context: null as null | {
    userId: string;
    workspaceId: string;
    role: "OWNER" | "ADMIN" | "MEMBER";
    workspace: { id: string; name: string };
  },
}));
const db = vi.hoisted(() => ({
  facebookPage: { findFirst: vi.fn() },
  product: { findMany: vi.fn(), findFirst: vi.fn(), count: vi.fn() },
  postRead: { findMany: vi.fn(), createMany: vi.fn() },
}));
const fb = vi.hoisted(() => ({ pageToken: vi.fn(() => "page-token") }));
const posts = vi.hoisted(() => ({ fetchRecentPosts: vi.fn(), extractDraftsFromPosts: vi.fn() }));
const convo = vi.hoisted(() => ({ fetchPageConversations: vi.fn(), mineSuggestions: vi.fn() }));
const download = vi.hoisted(() => ({ downloadCustomerImage: vi.fn() }));
const images = vi.hoisted(() => ({ storeProductImage: vi.fn(), deleteProductImage: vi.fn() }));
const catalog = vi.hoisted(() => ({ createProduct: vi.fn() }));
const suggestions = vi.hoisted(() => ({ saveSuggestions: vi.fn() }));
const queue = vi.hoisted(() => ({ getJob: vi.fn(), add: vi.fn() }));

vi.mock("@/lib/workspace-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/workspace-access")>()),
  getCurrentWorkspaceContext: async () => state.context,
}));
vi.mock("@/lib/db/client", () => ({ prisma: db }));
vi.mock("@/lib/auth", () => ({ getCurrentUserId: async () => state.context?.userId ?? null }));
vi.mock("@/lib/facebook/pages", () => fb);
vi.mock("@/lib/knowledge/posts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/knowledge/posts")>()),
  ...posts,
}));
vi.mock("@/lib/knowledge/conversations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/knowledge/conversations")>()),
  ...convo,
}));
vi.mock("@/lib/ai/image-download", () => download);
vi.mock("@/lib/catalog/images", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/catalog/images")>()),
  ...images,
}));
vi.mock("@/lib/catalog/products", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/catalog/products")>()),
  ...catalog,
}));
vi.mock("@/lib/knowledge/suggestions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/knowledge/suggestions")>()),
  ...suggestions,
}));
vi.mock("@/lib/facebook/queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/facebook/queue")>()),
  getFacebookQueue: () => queue,
}));

import { GET as getPosts, POST as postPosts } from "../../app/api/knowledge/sources/posts/route";
import { GET as getConversations, POST as postConversations } from "../../app/api/knowledge/sources/conversations/route";
import { GeminiError } from "../../lib/ai/gemini";
import { FacebookApiError } from "../../lib/facebook/graph";
import { processConversationsJob, resolveProductHint, toNewSuggestion } from "../../lib/knowledge/jobs/conversations";
import { SOURCE_MESSAGES, processPostsJob } from "../../lib/knowledge/jobs/posts";
import { suggestionDedupeKey } from "../../lib/knowledge/suggestions";
import { readDraftNote } from "../../lib/catalog/drafts";

// ─── Jobs ───────────────────────────────────────────────────────────────────

function fakeJob(data: Record<string, unknown> = {}, attemptsMade = 0) {
  return {
    data: { workspaceId: "ws_a", facebookPageId: "fp_1", ...data },
    attemptsMade,
    opts: { attempts: 3 },
    updateProgress: vi.fn(async () => undefined),
  };
}
type PostsJob = Parameters<typeof processPostsJob>[0];
type ConversationsJob = Parameters<typeof processConversationsJob>[0];

const POST = {
  id: "10_1",
  message: "Papier peint 3D WP-12 2500 DA",
  createdTime: null,
  permalink: "https://www.facebook.com/page/posts/1",
  imageUrls: ["https://cdn.example/1.jpg"],
};

function draft(overrides: Record<string, unknown> = {}) {
  return {
    postId: "10_1",
    name: "Papier peint 3D",
    code: "WP-12",
    price: "2500 DA",
    imageUrl: "https://cdn.example/1.jpg",
    colours: [{ code: "01", name: "Blanc" }],
    evidence: "Papier peint 3D WP-12 2500 DA",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GOOGLE_API_KEY = "test-key";
  db.facebookPage.findFirst.mockResolvedValue({ id: "fp_1", pageId: "10", accessToken: "enc", status: "ACTIVE" });
  db.product.findMany.mockResolvedValue([]);
  db.product.findFirst.mockResolvedValue(null);
  db.product.count.mockResolvedValue(3);
  db.postRead.findMany.mockResolvedValue([]);
  db.postRead.createMany.mockImplementation(async ({ data }: { data: unknown[] }) => ({ count: data.length }));
  posts.fetchRecentPosts.mockResolvedValue([POST]);
  posts.extractDraftsFromPosts.mockResolvedValue([draft()]);
  download.downloadCustomerImage.mockResolvedValue({ bytes: Buffer.from("img"), mimeType: "image/jpeg", size: 3 });
  images.storeProductImage.mockResolvedValue({ ok: true, image: { id: "img_1" } });
  images.deleteProductImage.mockResolvedValue(true);
  catalog.createProduct.mockResolvedValue({ ok: true, product: { id: "p_new" } });
  convo.fetchPageConversations.mockResolvedValue([{ id: "t_1", messages: [] }]);
  convo.mineSuggestions.mockResolvedValue([]);
  suggestions.saveSuggestions.mockResolvedValue(0);
});

describe("kb-posts job", () => {
  it("makes a DRAFT product from each draft, with its source, evidence, colours and main picture", async () => {
    const job = fakeJob({ limit: 10 });
    const result = await processPostsJob(job as unknown as PostsJob);

    expect(posts.fetchRecentPosts).toHaveBeenCalledWith("10", "page-token", { limit: 10 });
    expect(catalog.createProduct).toHaveBeenCalledTimes(1);
    const [workspaceId, input, options] = catalog.createProduct.mock.calls[0];
    expect(workspaceId).toBe("ws_a");
    expect(input).toMatchObject({
      name: "Papier peint 3D",
      code: "WP-12",
      price: "2500 DA",
      status: "DRAFT",
      mainImageId: "img_1",
      variants: [{ code: "01", name: "Blanc" }],
    });
    expect(options).toEqual({
      source: "POST",
      sourceRef: "https://www.facebook.com/page/posts/1",
      sourceNote: "Papier peint 3D WP-12 2500 DA",
    });
    // Only the post's own https picture is downloaded, within the product image cap.
    expect(download.downloadCustomerImage).toHaveBeenCalledWith("https://cdn.example/1.jpg", expect.objectContaining({ maxBytes: expect.any(Number) }));
    expect(job.updateProgress).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "posts", postsRead: 1, draftsCreated: 1, alreadyThere: 0 })
    );
    expect(result).toContain("1 drafts created");
  });

  it("writes a code clash in the note and creates the draft without the code", async () => {
    db.product.findFirst.mockResolvedValue({ name: "Papier peint  3D\n(ancien)" });
    const job = fakeJob();
    await processPostsJob(job as unknown as PostsJob);

    const [, input, options] = catalog.createProduct.mock.calls[0];
    expect(input.code).toBeNull();
    // The clash is data under the sentence: each screen words it in its own language.
    expect(readDraftNote(options.sourceNote)).toEqual({
      sentence: "Papier peint 3D WP-12 2500 DA",
      clash: { code: "WP-12", holder: "Papier peint 3D (ancien)" },
    });
    expect(job.updateProgress).toHaveBeenCalledWith(expect.objectContaining({ codeClashes: 1 }));
    expect(db.product.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: "ws_a", codeKey: "WP12" } }));
  });

  it("retries once without the code when another card takes it between the check and the write", async () => {
    catalog.createProduct
      .mockResolvedValueOnce({ ok: false, error: "duplicate_code", detail: "WP-12" })
      .mockResolvedValueOnce({ ok: true, product: { id: "p_new" } });
    db.product.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ name: "Other" });
    await processPostsJob(fakeJob() as unknown as PostsJob);

    expect(catalog.createProduct).toHaveBeenCalledTimes(2);
    expect(catalog.createProduct.mock.calls[1][1].code).toBeNull();
    expect(readDraftNote(catalog.createProduct.mock.calls[1][2].sourceNote).clash).toEqual({ code: "WP-12", holder: "Other" });
  });

  it("never reads a post twice, so a draft a person rejected or merged does not come back", async () => {
    const second = { ...POST, id: "10_2", permalink: "https://www.facebook.com/page/posts/2" };
    const third = { ...POST, id: "10_3", permalink: null, message: "Bonne fête à tous !" };
    posts.fetchRecentPosts.mockResolvedValue([POST, second, third]);
    db.postRead.findMany.mockResolvedValue([{ postId: "10_1" }]);
    posts.extractDraftsFromPosts.mockResolvedValue([draft({ postId: "10_2", name: "Lambris PVC", code: "LP-7", evidence: "Lambris PVC LP-7" })]);
    const job = fakeJob();
    await processPostsJob(job as unknown as PostsJob);

    // The model only sees the posts no run has read yet.
    expect(posts.extractDraftsFromPosts.mock.calls[0][0].map((post: { id: string }) => post.id)).toEqual(["10_2", "10_3"]);
    expect(db.postRead.findMany).toHaveBeenCalledWith({ where: { workspaceId: "ws_a", postId: { in: ["10_1", "10_2", "10_3"] } }, select: { postId: true } });
    // Both are read now, the one without a product too.
    expect(db.postRead.createMany).toHaveBeenCalledWith({
      data: [
        { workspaceId: "ws_a", postId: "10_2", drafts: 1 },
        { workspaceId: "ws_a", postId: "10_3", drafts: 0 },
      ],
      skipDuplicates: true,
    });
    expect(job.updateProgress).toHaveBeenCalledWith(expect.objectContaining({ postsRead: 3, postsSkipped: 1, draftsCreated: 1 }));

    // Nothing new: the model is not asked at all.
    vi.clearAllMocks();
    db.postRead.findMany.mockResolvedValue([{ postId: "10_1" }]);
    posts.fetchRecentPosts.mockResolvedValue([POST]);
    await processPostsJob(fakeJob() as unknown as PostsJob);
    expect(posts.extractDraftsFromPosts).not.toHaveBeenCalled();
    expect(db.postRead.createMany).not.toHaveBeenCalled();
  });

  it("reads again next time a post the product limit stopped before", async () => {
    const second = { ...POST, id: "10_2", permalink: null };
    posts.fetchRecentPosts.mockResolvedValue([POST, second]);
    posts.extractDraftsFromPosts.mockResolvedValue([draft(), draft({ postId: "10_2", name: "Autre", code: null })]);
    catalog.createProduct
      .mockResolvedValueOnce({ ok: true, product: { id: "p_new" } })
      .mockResolvedValueOnce({ ok: false, error: "too_many" });
    await processPostsJob(fakeJob() as unknown as PostsJob);
    expect(db.postRead.createMany).toHaveBeenCalledWith({ data: [{ workspaceId: "ws_a", postId: "10_1", drafts: 1 }], skipDuplicates: true });
  });

  it("never makes the same draft twice: same post and same name or code is skipped", async () => {
    db.product.findMany.mockResolvedValue([
      { sourceRef: "https://www.facebook.com/page/posts/1", name: "papier PEINT 3d", codeKey: null },
    ]);
    const job = fakeJob();
    await processPostsJob(job as unknown as PostsJob);

    expect(catalog.createProduct).not.toHaveBeenCalled();
    expect(download.downloadCustomerImage).not.toHaveBeenCalled();
    expect(job.updateProgress).toHaveBeenCalledWith(expect.objectContaining({ draftsCreated: 0, alreadyThere: 1 }));
    expect(db.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ workspaceId: "ws_a", source: "POST" }) })
    );

    // A draft a person renamed is still the same one when its code matches.
    db.product.findMany.mockResolvedValue([{ sourceRef: "10_1", name: "Renamed", codeKey: "WP12" }]);
    await processPostsJob(fakeJob() as unknown as PostsJob);
    expect(catalog.createProduct).not.toHaveBeenCalled();
  });

  it("leaves the draft without a picture when the picture fails", async () => {
    download.downloadCustomerImage.mockRejectedValue(new Error("boom"));
    const job = fakeJob();
    await processPostsJob(job as unknown as PostsJob);

    expect(catalog.createProduct.mock.calls[0][1].mainImageId).toBeNull();
    expect(job.updateProgress).toHaveBeenCalledWith(expect.objectContaining({ draftsCreated: 1, withoutPicture: 1 }));

    // Bytes that are not a product image count the same.
    images.storeProductImage.mockResolvedValue({ ok: false, error: "not_an_image" });
    download.downloadCustomerImage.mockResolvedValue({ bytes: Buffer.from("x"), mimeType: "image/heic", size: 1 });
    const second = fakeJob();
    await processPostsJob(second as unknown as PostsJob);
    expect(second.updateProgress).toHaveBeenCalledWith(expect.objectContaining({ withoutPicture: 1 }));
  });

  it("downloads a post's picture once for several drafts, and stops storing when the image limit is reached", async () => {
    posts.extractDraftsFromPosts.mockResolvedValue([draft(), draft({ name: "Rideau", code: null }), draft({ name: "Tapis", code: null })]);
    images.storeProductImage
      .mockResolvedValueOnce({ ok: true, image: { id: "img_1" } })
      .mockResolvedValueOnce({ ok: false, error: "too_many" });
    await processPostsJob(fakeJob() as unknown as PostsJob);

    expect(download.downloadCustomerImage).toHaveBeenCalledTimes(1);
    // After too_many, no more image is stored (the third draft does not even ask).
    expect(images.storeProductImage).toHaveBeenCalledTimes(2);
    expect(catalog.createProduct).toHaveBeenCalledTimes(3);
    expect(catalog.createProduct.mock.calls[2][1].mainImageId).toBeNull();
  });

  it("stops at the product limit and removes the picture it stored for the refused card", async () => {
    posts.extractDraftsFromPosts.mockResolvedValue([draft(), draft({ name: "Rideau", code: null })]);
    catalog.createProduct.mockResolvedValue({ ok: false, error: "too_many" });
    const job = fakeJob();
    await processPostsJob(job as unknown as PostsJob);

    expect(catalog.createProduct).toHaveBeenCalledTimes(1);
    expect(images.deleteProductImage).toHaveBeenCalledWith("ws_a", "img_1");
    expect(job.updateProgress).toHaveBeenCalledWith(expect.objectContaining({ draftsCreated: 0, stoppedAtLimit: true }));

    // Already full before the first draft: nothing is downloaded.
    db.product.count.mockResolvedValue(2000);
    download.downloadCustomerImage.mockClear();
    catalog.createProduct.mockClear();
    await processPostsJob(fakeJob() as unknown as PostsJob);
    expect(download.downloadCustomerImage).not.toHaveBeenCalled();
    expect(catalog.createProduct).not.toHaveBeenCalled();
  });

  it("fails fast without GOOGLE_API_KEY, before reading the Page", async () => {
    delete process.env.GOOGLE_API_KEY;
    const failure = await processPostsJob(fakeJob() as unknown as PostsJob).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(UnrecoverableError);
    expect((failure as Error).message).toBe(SOURCE_MESSAGES.noKey);
    expect(posts.fetchRecentPosts).not.toHaveBeenCalled();
  });

  it("only reads a connected Page of the brand", async () => {
    db.facebookPage.findFirst.mockResolvedValue(null);
    const missing = await processPostsJob(fakeJob() as unknown as PostsJob).catch((error: unknown) => error);
    expect((missing as Error).message).toBe(SOURCE_MESSAGES.noPage);
    expect(db.facebookPage.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "fp_1", workspaceId: "ws_a" } })
    );

    db.facebookPage.findFirst.mockResolvedValue({ id: "fp_1", pageId: "10", accessToken: "enc", status: "TOKEN_INVALID" });
    const dead = await processPostsJob(fakeJob() as unknown as PostsJob).catch((error: unknown) => error);
    expect(dead).toBeInstanceOf(UnrecoverableError);
    expect((dead as Error).message).toBe(SOURCE_MESSAGES.tokenInvalid);
    expect(posts.fetchRecentPosts).not.toHaveBeenCalled();
  });

  it("is final for a dead token and a missing permission, and retries only rate limits and network trouble", async () => {
    const graph = (kind: ConstructorParameters<typeof FacebookApiError>[1]) => new FacebookApiError("Graph said no", kind);

    posts.fetchRecentPosts.mockRejectedValue(graph("token_invalid"));
    const dead = await processPostsJob(fakeJob() as unknown as PostsJob).catch((error: unknown) => error);
    expect(dead).toBeInstanceOf(UnrecoverableError);
    expect((dead as Error).message).toBe(SOURCE_MESSAGES.tokenInvalid);

    posts.fetchRecentPosts.mockRejectedValue(graph("permission"));
    const denied = await processPostsJob(fakeJob() as unknown as PostsJob).catch((error: unknown) => error);
    expect(denied).toBeInstanceOf(UnrecoverableError);
    expect((denied as Error).message).toBe(SOURCE_MESSAGES.noPermission);

    // A rate limit with attempts left is rethrown as it is, for BullMQ to retry.
    const limited = graph("rate_limit");
    posts.fetchRecentPosts.mockRejectedValue(limited);
    const retry = await processPostsJob(fakeJob({}, 0) as unknown as PostsJob).catch((error: unknown) => error);
    expect(retry).toBe(limited);
    expect(retry).not.toBeInstanceOf(UnrecoverableError);

    // On the last attempt it ends with a clear message.
    const last = await processPostsJob(fakeJob({}, 2) as unknown as PostsJob).catch((error: unknown) => error);
    expect((last as Error).message).toBe(SOURCE_MESSAGES.facebookBusy);
  });

  it("treats Gemini failures the same way: a bad key is final, a busy service is retried", async () => {
    posts.extractDraftsFromPosts.mockRejectedValue(new GeminiError("bad key", "auth", 403));
    const bad = await processPostsJob(fakeJob() as unknown as PostsJob).catch((error: unknown) => error);
    expect(bad).toBeInstanceOf(UnrecoverableError);
    expect((bad as Error).message).toBe(SOURCE_MESSAGES.aiKey);

    const busy = new GeminiError("slow down", "rate_limited", 429);
    posts.extractDraftsFromPosts.mockRejectedValue(busy);
    const retry = await processPostsJob(fakeJob({}, 1) as unknown as PostsJob).catch((error: unknown) => error);
    expect(retry).toBe(busy);
    expect(catalog.createProduct).not.toHaveBeenCalled();
  });
});

describe("kb-conversations job", () => {
  const products = [
    { id: "p_wp", name: "Papier peint 3D", code: "WP-12", codeKey: "WP12" },
    { id: "p_a", name: "Rideau", code: null, codeKey: null },
    { id: "p_b", name: "Rideau", code: null, codeKey: null },
    { id: "p_t", name: "Tapis berbère", code: "T1", codeKey: "T1" },
  ];

  it("resolves a hint by code first, then by exact name, and drops an ambiguous one", () => {
    expect(resolveProductHint("wp 12", products)).toBe("p_wp");
    expect(resolveProductHint("WP_12", products)).toBe("p_wp");
    expect(resolveProductHint("tapis  Berbère", products)).toBe("p_t");
    expect(resolveProductHint("Rideau", products)).toBeNull();
    expect(resolveProductHint("Tapis", products)).toBeNull();
    expect(resolveProductHint(null, products)).toBeNull();
  });

  it("drops a product suggestion whose product is unknown, except objections which become a faq", () => {
    const base = { evidence: { threadId: "t_1", quote: "ça tient 10 ans" } };
    expect(
      toNewSuggestion({ ...base, target: "product.strengths", productHint: "Nope", payload: { text: "Dure 10 ans" } }, products)
    ).toBeNull();

    const objection = toNewSuggestion(
      { ...base, target: "product.objections", productHint: null, payload: { question: "Ça se décolle ?", answer: "Non, colle fournie." } },
      products
    );
    expect(objection).toMatchObject({ target: "faq", productId: null, sourceRef: "t_1", evidence: "ça tient 10 ans" });
    expect(objection?.dedupeKey).toBe(suggestionDedupeKey("t_1", "faq", "Ça se décolle ?"));

    const known = toNewSuggestion(
      { ...base, target: "product.objections", productHint: "WP-12", payload: { question: "Ça se décolle ?", answer: "Non." } },
      products
    );
    expect(known).toMatchObject({ target: "product.objections", productId: "p_wp" });

    // A brand-wide fact needs no product.
    expect(toNewSuggestion({ ...base, target: "delivery", productHint: null, payload: { text: "48h" } }, products)).toMatchObject({
      target: "delivery",
      productId: null,
      dedupeKey: suggestionDedupeKey("t_1", "delivery", "48h"),
    });
  });

  it("saves the suggestions as CONVERSATION with their keys, and reports what was added", async () => {
    db.product.findMany.mockResolvedValue(products);
    convo.mineSuggestions.mockResolvedValue([
      {
        target: "product.comparisons",
        productHint: "WP-12",
        payload: { text: "Moins cher que le 5D" },
        evidence: { threadId: "t_9", quote: "Moins cher que le 5D" },
      },
      {
        target: "product.strengths",
        productHint: "Unknown",
        payload: { text: "Dropped" },
        evidence: { threadId: "t_9", quote: "Dropped quote" },
      },
    ]);
    suggestions.saveSuggestions.mockResolvedValue(1);
    const job = fakeJob({ limit: 30 });
    const result = await processConversationsJob(job as unknown as ConversationsJob);

    expect(convo.fetchPageConversations).toHaveBeenCalledWith("10", "page-token", { limit: 30 });
    expect(convo.mineSuggestions).toHaveBeenCalledWith(expect.anything(), {
      knownProducts: products.map((product) => ({ name: product.name, code: product.code })),
    });
    expect(db.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: "ws_a", status: { in: ["ACTIVE", "DRAFT"] } } })
    );
    expect(suggestions.saveSuggestions).toHaveBeenCalledWith("ws_a", "CONVERSATION", [
      {
        target: "product.comparisons",
        productId: "p_wp",
        payload: { question: undefined, answer: undefined, text: "Moins cher que le 5D" },
        evidence: "Moins cher que le 5D",
        sourceRef: "t_9",
        dedupeKey: suggestionDedupeKey("t_9", "product.comparisons", "Moins cher que le 5D"),
      },
    ]);
    expect(job.updateProgress).toHaveBeenCalledWith({
      kind: "conversations",
      threadsRead: 1,
      suggestionsFound: 1,
      suggestionsAdded: 1,
    });
    expect(result).toContain("1 suggestions added");
  });

  it("asks nothing of the model when the Page has no conversations", async () => {
    convo.fetchPageConversations.mockResolvedValue([]);
    const job = fakeJob();
    await processConversationsJob(job as unknown as ConversationsJob);
    expect(convo.mineSuggestions).not.toHaveBeenCalled();
    expect(suggestions.saveSuggestions).not.toHaveBeenCalled();
    expect(job.updateProgress).toHaveBeenCalledWith(expect.objectContaining({ threadsRead: 0, suggestionsAdded: 0 }));
  });

  it("fails fast without the key, and ends for good on a missing permission", async () => {
    delete process.env.GOOGLE_API_KEY;
    const noKey = await processConversationsJob(fakeJob() as unknown as ConversationsJob).catch((error: unknown) => error);
    expect((noKey as Error).message).toBe(SOURCE_MESSAGES.noKey);
    expect(convo.fetchPageConversations).not.toHaveBeenCalled();

    process.env.GOOGLE_API_KEY = "test-key";
    convo.fetchPageConversations.mockRejectedValue(new FacebookApiError("(#200) permission", "permission", 200));
    const denied = await processConversationsJob(fakeJob() as unknown as ConversationsJob).catch((error: unknown) => error);
    expect(denied).toBeInstanceOf(UnrecoverableError);
    expect((denied as Error).message).toBe(SOURCE_MESSAGES.noPermission);
  });
});

// ─── APIs ───────────────────────────────────────────────────────────────────

const URLS = {
  posts: "http://localhost:3000/api/knowledge/sources/posts",
  conversations: "http://localhost:3000/api/knowledge/sources/conversations",
};

function request(url: string, method = "GET", body?: unknown, origin = "http://localhost:3000") {
  return new NextRequest(url, {
    method,
    headers: { "Content-Type": "application/json", Origin: origin },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function as(role: "OWNER" | "ADMIN" | "MEMBER") {
  state.context = { userId: "u_1", workspaceId: "ws_a", role, workspace: { id: "ws_a", name: "Maison Lina" } };
}

function fakeQueueJob(overrides: Record<string, unknown> = {}) {
  return {
    data: { workspaceId: "ws_a", facebookPageId: "fp_1" },
    timestamp: Date.parse("2026-01-01T10:00:00Z"),
    processedOn: Date.parse("2026-01-01T10:00:05Z"),
    finishedOn: undefined as number | undefined,
    progress: 0 as unknown,
    failedReason: undefined as string | undefined,
    getState: vi.fn(async () => "active"),
    remove: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("source APIs", () => {
  beforeEach(() => {
    as("ADMIN");
    db.facebookPage.findFirst.mockResolvedValue({ id: "fp_1", status: "ACTIVE" });
    queue.getJob.mockResolvedValue(undefined);
    queue.add.mockImplementation(async (_name: string, data: Record<string, unknown>) =>
      fakeQueueJob({ data, getState: vi.fn(async () => "waiting") })
    );
  });

  it("starts a posts run with the fixed job ID, the brand and a clamped limit", async () => {
    const response = await postPosts(request(URLS.posts, "POST", { facebookPageId: "fp_1", limit: 9999 }));
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body.data).toMatchObject({ kind: "posts", state: "running", facebookPageId: "fp_1" });

    expect(queue.add).toHaveBeenCalledWith(
      "kb-posts",
      { workspaceId: "ws_a", facebookPageId: "fp_1", limit: 100, requestedByUserId: "u_1" },
      expect.objectContaining({ jobId: "kbp_fp_1" })
    );
    expect(db.facebookPage.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "fp_1", workspaceId: "ws_a" } }));
  });

  it("starts a conversations run with its own job name and ID", async () => {
    await postConversations(request(URLS.conversations, "POST", { facebookPageId: "fp_1" }));
    expect(queue.add).toHaveBeenCalledWith(
      "kb-conversations",
      expect.objectContaining({ limit: 50 }),
      expect.objectContaining({ jobId: "kbc_fp_1" })
    );
  });

  it("joins a run that is active instead of starting another", async () => {
    const running = fakeQueueJob({ getState: vi.fn(async () => "active") });
    queue.getJob.mockResolvedValue(running);
    const response = await postPosts(request(URLS.posts, "POST", { facebookPageId: "fp_1" }));
    const body = await response.json();

    expect(body.data).toMatchObject({ state: "running", joined: true });
    expect(queue.add).not.toHaveBeenCalled();
    expect(running.remove).not.toHaveBeenCalled();

    // A run waiting for its retry is still active.
    running.getState.mockResolvedValue("delayed");
    await postPosts(request(URLS.posts, "POST", { facebookPageId: "fp_1" }));
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("removes a finished job, then adds the new run with the same ID", async () => {
    for (const finished of ["completed", "failed"]) {
      queue.add.mockClear();
      const old = fakeQueueJob({ getState: vi.fn(async () => finished) });
      queue.getJob.mockResolvedValue(old);
      const response = await postConversations(request(URLS.conversations, "POST", { facebookPageId: "fp_1" }));
      expect(response.status).toBe(202);
      expect(old.remove).toHaveBeenCalledTimes(1);
      expect(queue.add).toHaveBeenCalledWith("kb-conversations", expect.anything(), expect.objectContaining({ jobId: "kbc_fp_1" }));
      expect(old.remove.mock.invocationCallOrder[0]).toBeLessThan(queue.add.mock.invocationCallOrder[0]);
    }
  });

  it("is for owners and admins on the active brand, same origin, and its own Pages", async () => {
    as("MEMBER");
    expect((await postPosts(request(URLS.posts, "POST", { facebookPageId: "fp_1" }))).status).toBe(403);
    expect((await getPosts(request(`${URLS.posts}?facebookPageId=fp_1`))).status).toBe(403);

    as("OWNER");
    expect((await postPosts(request(URLS.posts, "POST", { facebookPageId: "fp_1" }, "https://evil.example"))).status).toBe(403);
    state.context = null;
    expect((await postPosts(request(URLS.posts, "POST", { facebookPageId: "fp_1" }))).status).toBe(401);

    as("ADMIN");
    expect((await postPosts(request(URLS.posts, "POST", {}))).status).toBe(400);
    db.facebookPage.findFirst.mockResolvedValue(null);
    expect((await postPosts(request(URLS.posts, "POST", { facebookPageId: "fp_other" }))).status).toBe(404);
    expect((await getPosts(request(`${URLS.posts}?facebookPageId=fp_other`))).status).toBe(404);
    db.facebookPage.findFirst.mockResolvedValue({ id: "fp_1", status: "TOKEN_INVALID" });
    expect((await postPosts(request(URLS.posts, "POST", { facebookPageId: "fp_1" }))).status).toBe(409);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("answers 503 with a clear message when the queue cannot be reached", async () => {
    queue.getJob.mockRejectedValue(new Error("ECONNREFUSED redis"));
    const response = await postPosts(request(URLS.posts, "POST", { facebookPageId: "fp_1" }));
    expect(response.status).toBe(503);
    expect((await response.json()).error).toBe("The job queue cannot be reached. Try again in a moment.");
  });

  it("reports idle when there is no run, and idle for another brand's job", async () => {
    const empty = await (await getPosts(request(`${URLS.posts}?facebookPageId=fp_1`))).json();
    expect(empty.data).toMatchObject({ state: "idle", summary: null, error: null });
    expect(queue.getJob).toHaveBeenCalledWith("kbp_fp_1");

    queue.getJob.mockResolvedValue(fakeQueueJob({ data: { workspaceId: "ws_other", facebookPageId: "fp_1" } }));
    const foreign = await (await getPosts(request(`${URLS.posts}?facebookPageId=fp_1`))).json();
    expect(foreign.data.state).toBe("idle");
  });

  it("reports a finished run with its summary read from the job's progress", async () => {
    queue.getJob.mockResolvedValue(
      fakeQueueJob({
        getState: vi.fn(async () => "completed"),
        finishedOn: Date.parse("2026-01-01T10:01:00Z"),
        progress: { kind: "posts", postsRead: 25, draftsCreated: 4, alreadyThere: 2, withoutPicture: 1, codeClashes: 1, failed: 0, stoppedAtLimit: false },
      })
    );
    const body = await (await getPosts(request(`${URLS.posts}?facebookPageId=fp_1`))).json();
    expect(body.data).toMatchObject({
      state: "done",
      finishedAt: "2026-01-01T10:01:00.000Z",
      startedAt: "2026-01-01T10:00:05.000Z",
      summary: { kind: "posts", postsRead: 25, draftsCreated: 4, alreadyThere: 2, withoutPicture: 1, codeClashes: 1 },
    });

    // Progress of the other kind, or a plain number, is no summary.
    queue.getJob.mockResolvedValue(
      fakeQueueJob({ getState: vi.fn(async () => "completed"), progress: { kind: "conversations", threadsRead: 3 } })
    );
    const wrong = await (await getPosts(request(`${URLS.posts}?facebookPageId=fp_1`))).json();
    expect(wrong.data.summary).toBeNull();

    queue.getJob.mockResolvedValue(
      fakeQueueJob({
        getState: vi.fn(async () => "completed"),
        progress: { kind: "conversations", threadsRead: 12, suggestionsFound: 5, suggestionsAdded: 3 },
      })
    );
    const done = await (await getConversations(request(`${URLS.conversations}?facebookPageId=fp_1`))).json();
    expect(done.data.summary).toEqual({ kind: "conversations", threadsRead: 12, suggestionsFound: 5, suggestionsAdded: 3 });
  });

  it("shows our own failure messages and hides any other reason", async () => {
    queue.getJob.mockResolvedValue(
      fakeQueueJob({ getState: vi.fn(async () => "failed"), failedReason: SOURCE_MESSAGES.tokenInvalid, finishedOn: Date.now() })
    );
    const known = await (await getPosts(request(`${URLS.posts}?facebookPageId=fp_1`))).json();
    expect(known.data).toMatchObject({ state: "failed", error: SOURCE_MESSAGES.tokenInvalid });

    queue.getJob.mockResolvedValue(
      fakeQueueJob({ getState: vi.fn(async () => "failed"), failedReason: "PrismaClientKnownRequestError: connection string postgres://u:p@db" })
    );
    const unknown = await (await getPosts(request(`${URLS.posts}?facebookPageId=fp_1`))).json();
    expect(unknown.data.error).toBe("The run failed. Try again in a few minutes.");

    // A job waiting for its retry is still running, whatever it failed with before.
    queue.getJob.mockResolvedValue(fakeQueueJob({ getState: vi.fn(async () => "delayed"), failedReason: "network" }));
    const retrying = await (await getPosts(request(`${URLS.posts}?facebookPageId=fp_1`))).json();
    expect(retrying.data).toMatchObject({ state: "running", error: null, finishedAt: null });
  });
});
