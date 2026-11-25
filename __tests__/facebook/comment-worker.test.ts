import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";

const db = vi.hoisted(() => ({
  facebookPage: { findUnique: vi.fn(), update: vi.fn() },
  facebookCampaign: { findMany: vi.fn(), findUnique: vi.fn() },
  facebookCommentLog: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
}));
const graph = vi.hoisted(() => ({ sendPrivateReply: vi.fn(), replyToComment: vi.fn() }));
const limiter = vi.hoisted(() => ({
  reserveDMSlot: vi.fn(),
  releaseDMSlot: vi.fn(),
  pauseDMSends: vi.fn(),
  recordDelivery: vi.fn(),
}));
const queue = vi.hoisted(() => ({ add: vi.fn() }));
const conversations = vi.hoisted(() => ({ recordPrivateReplyConversation: vi.fn() }));

vi.mock("@/lib/db/client", () => ({ prisma: db }));
vi.mock("@/lib/facebook/graph", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/facebook/graph")>()),
  ...graph,
}));
vi.mock("@/lib/utils/rate-limiter", () => limiter);
vi.mock("@/lib/facebook/pages", () => ({ pageToken: () => "PAGE_TOKEN" }));
vi.mock("@/lib/facebook/conversations", () => conversations);
vi.mock("@/lib/facebook/queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/facebook/queue")>()),
  getFacebookQueue: () => queue,
}));

import { FacebookApiError } from "../../lib/facebook/graph";
import { pickCampaign, processCommentJob } from "../../lib/facebook/comments";
import { dispatchFacebookJob } from "../../lib/facebook/worker";
import { renderTemplate, utmCampaign, withUtm } from "../../lib/facebook/templates";
import type { FacebookCommentJob } from "../../lib/facebook/queue";

const NOW = new Date("2026-11-25T12:00:00Z");
const PAGE = { id: "fp_1", pageId: "1001", workspaceId: "ws_a", status: "ACTIVE", accessToken: "enc" };

function campaign(overrides: Record<string, unknown> = {}) {
  return {
    id: "camp_any",
    workspaceId: "ws_a",
    facebookPageId: "fp_1",
    name: "Robe Kabyle",
    postId: null,
    matchAnyPost: true,
    keywords: ["سعر", "prix", "price"],
    matchAnyWord: false,
    wholeWordMatch: true,
    privateReplyMessage: "مرحبا {name} 👋 السعر في الرابط",
    buttonLabel: "شوف التفاصيل",
    landingUrl: "https://shop.example/robe",
    addUtm: true,
    publicReplyEnabled: false,
    publicReplyMessages: [] as string[],
    isActive: true,
    createdAt: new Date("2026-11-01T00:00:00Z"),
    ...overrides,
  };
}

function log(overrides: Record<string, unknown> = {}) {
  return {
    id: "log_1",
    campaignId: "camp_any",
    commentId: "1001_c1",
    commenterName: "Amina B.",
    commentCreatedAt: new Date("2026-11-25T11:00:00Z"),
    status: "PENDING",
    deliveryUnconfirmed: false,
    attempts: 0,
    privateReplySentAt: null,
    publicReplySentAt: null,
    publicReplyDeliveryUnconfirmed: false,
    ...overrides,
  };
}

function job(overrides: Partial<FacebookCommentJob> = {}) {
  return {
    id: "fbc_1001_1001_c1",
    name: "fb-comment",
    data: {
      facebookPageId: "fp_1",
      pageId: "1001",
      commentId: "1001_c1",
      postId: "1001_p1",
      commenterId: "999",
      commenterName: "Amina B.",
      text: "شحال السعر؟",
      createdAt: "2026-11-25T11:00:00.000Z",
      ...overrides,
    },
  } as unknown as Job<FacebookCommentJob>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  db.facebookPage.findUnique.mockResolvedValue(PAGE);
  db.facebookCampaign.findMany.mockResolvedValue([campaign()]);
  db.facebookCommentLog.findUnique.mockResolvedValue(null);
  db.facebookCommentLog.create.mockResolvedValue(log());
  db.facebookCommentLog.updateMany.mockResolvedValue({ count: 1 });
  db.facebookCommentLog.update.mockResolvedValue({});
  limiter.reserveDMSlot.mockResolvedValue({ allowed: true, reserved: true });
  limiter.releaseDMSlot.mockResolvedValue(0);
  limiter.pauseDMSends.mockResolvedValue(undefined);
  limiter.recordDelivery.mockResolvedValue(undefined);
  graph.sendPrivateReply.mockResolvedValue({ recipient_id: "psid_1", message_id: "m_1" });
  graph.replyToComment.mockResolvedValue({ id: "1001_reply" });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("sending the private reply", () => {
  it("answers a matching comment once, with the link button, UTM and metadata", async () => {
    await expect(processCommentJob(job())).resolves.toBe("sent");

    expect(db.facebookCommentLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        facebookPageId: "fp_1",
        commentId: "1001_c1",
        campaignId: "camp_any",
        matchedKeyword: "سعر",
        commentText: "شحال السعر؟",
      }),
    });
    expect(limiter.reserveDMSlot).toHaveBeenCalledWith("fb:1001", 0, 0, "1001_c1");
    // The claim comes before the send.
    expect(db.facebookCommentLog.updateMany).toHaveBeenCalledWith({
      where: {
        id: "log_1",
        status: { notIn: expect.arrayContaining(["SENT", "UNCONFIRMED"]) },
        deliveryUnconfirmed: false,
        attempts: { lt: 3 },
      },
      data: { deliveryUnconfirmed: true, attempts: { increment: 1 }, status: "PENDING", errorMessage: null },
    });
    expect(graph.sendPrivateReply).toHaveBeenCalledWith("1001", "PAGE_TOKEN", {
      commentId: "1001_c1",
      text: "مرحبا Amina 👋 السعر في الرابط",
      buttons: [
        {
          title: "شوف التفاصيل",
          url: "https://shop.example/robe?utm_source=facebook&utm_medium=comment&utm_campaign=robe-kabyle",
        },
      ],
      metadata: "openreply:c:log_1",
    });
    expect(db.facebookCommentLog.update).toHaveBeenLastCalledWith({
      where: { id: "log_1" },
      data: {
        status: "SENT",
        deliveryUnconfirmed: false,
        privateReplySentAt: NOW,
        recipientPsid: "psid_1",
        privateReplyMessageId: "m_1",
        errorMessage: null,
      },
    });
    expect(limiter.recordDelivery).toHaveBeenCalledWith("fb:1001");
    expect(conversations.recordPrivateReplyConversation).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws_a", facebookPageId: "fp_1", psid: "psid_1", campaignId: "camp_any", messageId: "m_1" })
    );
  });

  it("does nothing for a comment no campaign matches", async () => {
    await expect(processCommentJob(job({ text: "روعة 😍" }))).resolves.toBe("no_match");
    expect(db.facebookCommentLog.create).not.toHaveBeenCalled();
    expect(graph.sendPrivateReply).not.toHaveBeenCalled();
  });

  it("ignores a Page that is gone, disconnected or another Page than the job's", async () => {
    db.facebookPage.findUnique.mockResolvedValue({ ...PAGE, status: "DISCONNECTED" });
    await expect(processCommentJob(job())).resolves.toBe("ignored");
    db.facebookPage.findUnique.mockResolvedValue({ ...PAGE, pageId: "9999" });
    await expect(processCommentJob(job())).resolves.toBe("ignored");
    db.facebookPage.findUnique.mockResolvedValue(null);
    await expect(processCommentJob(job())).resolves.toBe("ignored");
    expect(graph.sendPrivateReply).not.toHaveBeenCalled();
  });

  it("never sends twice: an existing SENT or unconfirmed log stops a duplicate job", async () => {
    for (const existing of [log({ status: "SENT" }), log({ status: "UNCONFIRMED", deliveryUnconfirmed: true }), log({ attempts: 3, status: "FAILED" })]) {
      db.facebookCommentLog.findUnique.mockResolvedValue(existing);
      await expect(processCommentJob(job())).resolves.toBe("nothing_to_do");
    }
    expect(graph.sendPrivateReply).not.toHaveBeenCalled();
    expect(limiter.reserveDMSlot).not.toHaveBeenCalled();
  });

  it("hands back the slot when another job won the claim", async () => {
    db.facebookCommentLog.updateMany.mockResolvedValue({ count: 0 });
    await expect(processCommentJob(job())).resolves.toBe("nothing_to_do");
    expect(limiter.releaseDMSlot).toHaveBeenCalledWith("fb:1001");
    expect(graph.sendPrivateReply).not.toHaveBeenCalled();
  });

  it("skips comments older than 7 days without calling Meta", async () => {
    db.facebookCommentLog.create.mockResolvedValue(log({ commentCreatedAt: new Date("2026-11-18T11:00:00Z") }));
    await expect(processCommentJob(job({ createdAt: "2026-11-18T11:00:00.000Z" }))).resolves.toBe("expired");
    expect(db.facebookCommentLog.updateMany).toHaveBeenCalledWith({
      where: { id: "log_1", status: { in: ["PENDING", "FAILED"] }, deliveryUnconfirmed: false },
      data: { status: "SKIPPED_EXPIRED", errorMessage: expect.any(String) },
    });
    expect(graph.sendPrivateReply).not.toHaveBeenCalled();
    expect(graph.replyToComment).not.toHaveBeenCalled();
  });

  it("stops 10 minutes before the 7-day limit", async () => {
    const almost = new Date(NOW.getTime() - (7 * 24 * 60 - 5) * 60_000);
    db.facebookCommentLog.create.mockResolvedValue(log({ commentCreatedAt: almost }));
    await expect(processCommentJob(job({ createdAt: almost.toISOString() }))).resolves.toBe("expired");
  });

  it("falls back to text with the link when Meta refuses the button template", async () => {
    graph.sendPrivateReply
      .mockRejectedValueOnce(new FacebookApiError("Invalid button template", "template_rejected", 100))
      .mockResolvedValueOnce({ recipient_id: "psid_1", message_id: "m_2" });
    await expect(processCommentJob(job())).resolves.toBe("sent");
    expect(graph.sendPrivateReply).toHaveBeenLastCalledWith("1001", "PAGE_TOKEN", {
      commentId: "1001_c1",
      text: expect.stringContaining("https://shop.example/robe?utm_source=facebook"),
      metadata: "openreply:c:log_1",
    });
  });

  it("records an ambiguous outcome as UNCONFIRMED, keeps the slot and never retries", async () => {
    graph.sendPrivateReply.mockRejectedValue(new FacebookApiError("fetch failed", "ambiguous"));
    await expect(processCommentJob(job())).resolves.toBe("unconfirmed");
    expect(db.facebookCommentLog.update).toHaveBeenLastCalledWith({
      where: { id: "log_1" },
      data: { status: "UNCONFIRMED", errorMessage: "fetch failed" },
    });
    expect(limiter.releaseDMSlot).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it.each([
    ["already_replied", 10900, "SKIPPED_ALREADY_REPLIED", "already_replied"],
    ["not_eligible", 10903, "SKIPPED_NOT_ELIGIBLE", "not_eligible"],
    ["permission", 200, "FAILED", "failed"],
  ] as const)("records a %s refusal as %s and frees the slot", async (kind, code, status, outcome) => {
    graph.sendPrivateReply.mockRejectedValue(new FacebookApiError("refused", kind, code));
    await expect(processCommentJob(job())).resolves.toBe(outcome);
    expect(db.facebookCommentLog.update).toHaveBeenLastCalledWith({
      where: { id: "log_1" },
      data: { status, deliveryUnconfirmed: false, errorMessage: "refused" },
    });
    expect(limiter.releaseDMSlot).toHaveBeenCalledWith("fb:1001");
  });

  it("marks the Page's token invalid when Meta says so", async () => {
    graph.sendPrivateReply.mockRejectedValue(new FacebookApiError("Session expired", "token_invalid", 190));
    await expect(processCommentJob(job())).resolves.toBe("failed");
    expect(db.facebookPage.update).toHaveBeenCalledWith({
      where: { id: "fp_1" },
      data: { status: "TOKEN_INVALID", lastError: "Session expired" },
    });
  });

  it("tries again in 5 minutes when Facebook could not be reached, giving the try back", async () => {
    graph.sendPrivateReply.mockRejectedValue(new FacebookApiError("getaddrinfo ENOTFOUND [ENOTFOUND]", "unreachable"));
    await expect(processCommentJob(job())).resolves.toBe("held");
    expect(limiter.releaseDMSlot).toHaveBeenCalledWith("fb:1001");
    expect(db.facebookCommentLog.update).toHaveBeenLastCalledWith({
      where: { id: "log_1" },
      data: { deliveryUnconfirmed: false, attempts: { decrement: 1 }, errorMessage: "getaddrinfo ENOTFOUND [ENOTFOUND]" },
    });
    expect(queue.add).toHaveBeenCalledWith(
      "fb-comment",
      expect.objectContaining({ requeueAttempt: 1 }),
      { delay: 5 * 60_000, jobId: "fbc_1001_1001_c1_hold_1" }
    );
  });

  it("gives up after two hours of Facebook being unreachable", async () => {
    graph.sendPrivateReply.mockRejectedValue(new FacebookApiError("unreachable", "unreachable"));
    await expect(processCommentJob(job({ requeueAttempt: 24 }))).resolves.toBe("failed");
    expect(db.facebookCommentLog.update).toHaveBeenLastCalledWith({
      where: { id: "log_1" },
      data: { status: "FAILED", deliveryUnconfirmed: false, errorMessage: "unreachable" },
    });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("pauses the Page and tries again later when Meta throttles it", async () => {
    graph.sendPrivateReply.mockRejectedValue(new FacebookApiError("Too many calls", "rate_limit", 613));
    await expect(processCommentJob(job())).resolves.toBe("held");
    expect(limiter.pauseDMSends).toHaveBeenCalledWith("fb:1001");
    expect(db.facebookCommentLog.update).toHaveBeenLastCalledWith({
      where: { id: "log_1" },
      data: { deliveryUnconfirmed: false, attempts: { decrement: 1 }, errorMessage: "Too many calls" },
    });
    expect(queue.add).toHaveBeenCalledWith(
      "fb-comment",
      expect.objectContaining({ commentId: "1001_c1", requeueAttempt: 1 }),
      { delay: 60_000, jobId: "fbc_1001_1001_c1_hold_1" }
    );
  });
});

describe("the rate limiter (shared with Instagram, keyed fb:<pageId>)", () => {
  it("holds the comment for its slot without sending", async () => {
    limiter.reserveDMSlot.mockResolvedValue({ allowed: false, shouldRequeue: true, requeueDelayMs: 40_000, slotAt: 1764072040000 });
    await expect(processCommentJob(job())).resolves.toBe("held");
    expect(graph.sendPrivateReply).not.toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalledWith(
      "fb-comment",
      expect.objectContaining({ requeueAttempt: 1, slotAt: 1764072040000 }),
      { delay: 40_000, jobId: "fbc_1001_1001_c1_hold_1_1764072040000" }
    );
  });

  it("leaves the comment to the job that holds its slot", async () => {
    limiter.reserveDMSlot.mockResolvedValue({ allowed: false, duplicate: true });
    await expect(processCommentJob(job())).resolves.toBe("duplicate");
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("gives up after waiting too long", async () => {
    limiter.reserveDMSlot.mockResolvedValue({ allowed: false, shouldSkip: true });
    await expect(processCommentJob(job())).resolves.toBe("rate_limited");
    expect(db.facebookCommentLog.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "SKIPPED_RATE_LIMIT" }) })
    );
  });
});

describe("the public reply", () => {
  beforeEach(() => {
    db.facebookCampaign.findMany.mockResolvedValue([
      campaign({ publicReplyEnabled: true, publicReplyMessages: ["شوف الخاص {name} 📩"] }),
    ]);
  });

  it("posts it once, claimed, alongside the private reply", async () => {
    await processCommentJob(job());
    expect(db.facebookCommentLog.updateMany).toHaveBeenCalledWith({
      where: { id: "log_1", publicReplySentAt: null, publicReplyDeliveryUnconfirmed: false },
      data: { publicReplyDeliveryUnconfirmed: true },
    });
    expect(graph.replyToComment).toHaveBeenCalledWith("1001_c1", "PAGE_TOKEN", "شوف الخاص Amina 📩");
    expect(db.facebookCommentLog.update).toHaveBeenCalledWith({
      where: { id: "log_1" },
      data: { publicReplySentAt: NOW, publicReplyCommentId: "1001_reply", publicReplyDeliveryUnconfirmed: false, publicReplyError: null },
    });
    expect(graph.sendPrivateReply).toHaveBeenCalled();
  });

  it("is not posted again once posted, and does not block the private reply when it fails", async () => {
    db.facebookCommentLog.create.mockResolvedValue(log({ publicReplySentAt: new Date() }));
    await processCommentJob(job());
    expect(graph.replyToComment).not.toHaveBeenCalled();

    db.facebookCommentLog.create.mockResolvedValue(log());
    graph.replyToComment.mockRejectedValue(new FacebookApiError("(#200) permission", "permission", 200));
    await expect(processCommentJob(job())).resolves.toBe("sent");
    expect(db.facebookCommentLog.update).toHaveBeenCalledWith({
      where: { id: "log_1" },
      data: { publicReplyError: "(#200) permission", publicReplyDeliveryUnconfirmed: false },
    });
  });
});

describe("choosing the campaign", () => {
  const at = (iso: string) => new Date(iso);
  it("prefers the post's own campaign over an older any-post one", () => {
    const picked = pickCampaign(
      [
        campaign({ id: "any", matchAnyPost: true, createdAt: at("2026-01-01") }),
        campaign({ id: "post", postId: "1001_p1", matchAnyPost: false, createdAt: at("2026-06-01") }),
      ] as never,
      "1001_p1",
      "le prix ?"
    );
    expect(picked).toEqual({ campaignId: "post", matchedKeyword: "prix" });
  });

  it("falls through to the next campaign when the first does not match", () => {
    const picked = pickCampaign(
      [
        campaign({ id: "first", keywords: ["livraison"], createdAt: at("2026-01-01") }),
        campaign({ id: "second", keywords: ["سعر"], createdAt: at("2026-02-01") }),
      ] as never,
      "1001_p9",
      "بالسعر"
    );
    expect(picked?.campaignId).toBe("second");
  });

  it("ignores a campaign bound to another post", () => {
    expect(
      pickCampaign([campaign({ postId: "1001_other", matchAnyPost: false })] as never, "1001_p1", "prix")
    ).toBeNull();
  });
});

describe("worker dispatch", () => {
  it("never runs an unknown job as a comment", async () => {
    const unknown = { id: "x", name: "something-new", data: job().data } as unknown as Job;
    await expect(dispatchFacebookJob(unknown as never)).resolves.toBe("unknown_job");
    expect(db.facebookPage.findUnique).not.toHaveBeenCalled();
  });
});

describe("templates", () => {
  it("fills {name}, or removes it cleanly", () => {
    expect(renderTemplate("Salam {name}, voici le prix", { name: "Amina" })).toBe("Salam Amina, voici le prix");
    expect(renderTemplate("Salam {name}, voici le prix", { name: null })).toBe("Salam, voici le prix");
    expect(renderTemplate("مرحبا {name} 👋", { name: "" })).toBe("مرحبا 👋");
  });

  it("adds UTM parameters without overriding the page's own", () => {
    expect(withUtm("https://shop.example/p?utm_source=insta&x=1", { source: "facebook", medium: "comment", campaign: "c" })).toBe(
      "https://shop.example/p?utm_source=insta&x=1&utm_medium=comment&utm_campaign=c"
    );
    expect(withUtm("not a url", { source: "a", medium: "b", campaign: "c" })).toBe("not a url");
    expect(utmCampaign("Robe Kabylé 2026!", "id")).toBe("robe-kabyle-2026");
    expect(utmCampaign("حملة الصيف", "camp_1")).toBe("camp_1");
  });
});
