/**
 * Comment → private reply, for Facebook Pages.
 *
 * Meta's rules: one private reply per comment, ever, within 7 days of the
 * comment, never to the Page itself. The webhook already drops the Page's own
 * comments; this module enforces the rest:
 *
 *   - one campaign per comment: the post's own campaigns first, then the
 *     "any post" ones, oldest first; the first whose keywords match wins;
 *   - one log row per comment (unique in the database), claimed atomically
 *     before the send, so a duplicate job or a retry can never send twice;
 *   - an outcome Meta did not confirm (network failure, 5xx, codes 1 and 2)
 *     is recorded as UNCONFIRMED and never retried automatically: a second
 *     message to a customer is worse than a missing one;
 *   - the rate limiter is the Instagram one, unchanged, keyed "fb:<pageId>".
 *
 * The optional public reply under the comment is independent: either leg
 * failing never blocks or repeats the other.
 */
import type { Job } from "bullmq";
import {
  Prisma,
  type FacebookCampaign,
  type FacebookCommentLog,
  type FacebookPage,
} from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import {
  pauseDMSends,
  recordDelivery,
  releaseDMSlot,
  reserveDMSlot,
} from "@/lib/utils/rate-limiter";
import { privateReplyMetadata } from "./echoes";
import { FacebookApiError, replyToComment, sendPrivateReply, type SendResult } from "./graph";
import { matchPageKeywords } from "./keywords";
import { pageToken } from "./pages";
import { commentJobId, FB_COMMENT_JOB, getFacebookQueue, type FacebookCommentJob } from "./queue";
import { recordPrivateReplyConversation } from "./conversations";
import { firstName, pickOne, renderTemplate, utmCampaign, withUtm } from "./templates";

export const PRIVATE_REPLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Stop short of the deadline: Meta's clock and ours are not the same clock. */
export const PRIVATE_REPLY_SAFETY_MS = 10 * 60 * 1000;
export const MAX_COMMENT_SEND_ATTEMPTS = 3;
/** After Meta throttles a Page, wait before trying the comment again. */
const RATE_LIMITED_RETRY_MS = 60_000;
/** When Facebook cannot be reached at all: every 5 minutes, for 2 hours. */
const UNREACHABLE_RETRY_MS = 5 * 60_000;
const MAX_UNREACHABLE_REQUEUES = 24;

const FINAL_STATUSES = [
  "SENT",
  "UNCONFIRMED",
  "SKIPPED_EXPIRED",
  "SKIPPED_ALREADY_REPLIED",
  "SKIPPED_NOT_ELIGIBLE",
  "SKIPPED_RATE_LIMIT",
] as const;

export function rateLimitKey(pageId: string): string {
  return `fb:${pageId}`;
}

export function isWithinPrivateReplyWindow(createdAt: Date, now = Date.now()): boolean {
  return now - createdAt.getTime() < PRIVATE_REPLY_WINDOW_MS - PRIVATE_REPLY_SAFETY_MS;
}

/** The campaign that answers a comment, and the keyword that matched. */
export function pickCampaign(
  campaigns: Pick<FacebookCampaign, "id" | "postId" | "matchAnyPost" | "keywords" | "matchAnyWord" | "wholeWordMatch" | "createdAt">[],
  postId: string,
  text: string
): { campaignId: string; matchedKeyword: string | null } | null {
  const byAge = [...campaigns].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const ordered = [
    ...byAge.filter((campaign) => campaign.postId === postId),
    ...byAge.filter((campaign) => campaign.postId !== postId && campaign.matchAnyPost),
  ];
  for (const campaign of ordered) {
    if (campaign.matchAnyWord) return { campaignId: campaign.id, matchedKeyword: null };
    const match = matchPageKeywords(text, campaign.keywords, campaign.wholeWordMatch);
    if (match.matched) return { campaignId: campaign.id, matchedKeyword: match.matchedKeyword };
  }
  return null;
}

/** The landing URL as sent: with UTM parameters unless the campaign opted out. */
export function landingUrlFor(campaign: Pick<FacebookCampaign, "id" | "name" | "landingUrl" | "addUtm">): string {
  if (!campaign.addUtm) return campaign.landingUrl;
  return withUtm(campaign.landingUrl, {
    source: "facebook",
    medium: "comment",
    campaign: utmCampaign(campaign.name, campaign.id),
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

async function sendPublicReply(
  log: FacebookCommentLog,
  campaign: FacebookCampaign,
  token: string,
  commenterName: string | undefined
) {
  const template = pickOne(campaign.publicReplyMessages.filter((message) => message.trim()));
  if (!template) return;
  // Claim first: a crash after Meta accepted the reply must not post it twice.
  const claim = await prisma.facebookCommentLog.updateMany({
    where: { id: log.id, publicReplySentAt: null, publicReplyDeliveryUnconfirmed: false },
    data: { publicReplyDeliveryUnconfirmed: true },
  });
  if (claim.count !== 1) return;
  try {
    const result = await replyToComment(
      log.commentId,
      token,
      renderTemplate(template, { name: firstName(commenterName) })
    );
    await prisma.facebookCommentLog.update({
      where: { id: log.id },
      data: {
        publicReplySentAt: new Date(),
        publicReplyCommentId: result.id ?? null,
        publicReplyDeliveryUnconfirmed: false,
        publicReplyError: null,
      },
    });
  } catch (error) {
    const confirmed = error instanceof FacebookApiError && error.isConfirmedRejection;
    await prisma.facebookCommentLog.update({
      where: { id: log.id },
      data: { publicReplyError: errorText(error), publicReplyDeliveryUnconfirmed: !confirmed },
    });
  }
}

/** Queue the comment again for later, keeping the log PENDING. */
async function requeue(
  job: Job<FacebookCommentJob>,
  delayMs: number,
  slotAt: number | undefined
): Promise<void> {
  const attempt = (job.data.requeueAttempt ?? 0) + 1;
  await getFacebookQueue().add(
    FB_COMMENT_JOB,
    { ...job.data, requeueAttempt: attempt, slotAt },
    {
      delay: delayMs,
      jobId: `${commentJobId(job.data.pageId, job.data.commentId)}_hold_${attempt}${slotAt ? `_${slotAt}` : ""}`,
    }
  );
}

async function sendWithFallback(
  page: FacebookPage,
  token: string,
  log: FacebookCommentLog,
  text: string,
  campaign: FacebookCampaign
): Promise<SendResult> {
  const url = landingUrlFor(campaign);
  const metadata = privateReplyMetadata(log.id);
  try {
    return await sendPrivateReply(page.pageId, token, {
      commentId: log.commentId,
      text,
      buttons: [{ title: campaign.buttonLabel, url }],
      metadata,
    });
  } catch (error) {
    // Only a refused template is worth a second try, as text with the link.
    if (!(error instanceof FacebookApiError && error.kind === "template_rejected")) throw error;
    return sendPrivateReply(page.pageId, token, {
      commentId: log.commentId,
      text: `${text}\n${url}`,
      metadata,
    });
  }
}

/**
 * Create the comment's log row. Two jobs for one comment can race here; the
 * unique key lets exactly one insert win, and the other reads that row.
 */
async function createLog(
  key: { facebookPageId_commentId: { facebookPageId: string; commentId: string } },
  page: FacebookPage,
  data: FacebookCommentJob,
  pick: { campaignId: string; matchedKeyword: string | null }
): Promise<FacebookCommentLog> {
  try {
    return await prisma.facebookCommentLog.create({
      data: {
        workspaceId: page.workspaceId,
        facebookPageId: page.id,
        campaignId: pick.campaignId,
        commentId: data.commentId,
        postId: data.postId,
        parentId: data.parentId ?? null,
        commenterId: data.commenterId ?? null,
        commenterName: data.commenterName ?? null,
        commentText: data.text,
        commentCreatedAt: new Date(data.createdAt),
        matchedKeyword: pick.matchedKeyword,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return prisma.facebookCommentLog.findUniqueOrThrow({ where: key });
    }
    throw error;
  }
}

export type CommentOutcome =
  | "ignored"
  | "no_match"
  | "expired"
  | "held"
  | "duplicate"
  | "rate_limited"
  | "sent"
  | "unconfirmed"
  | "already_replied"
  | "not_eligible"
  | "failed"
  | "nothing_to_do";

export async function processCommentJob(job: Job<FacebookCommentJob>): Promise<CommentOutcome> {
  const data = job.data;
  const page = await prisma.facebookPage.findUnique({ where: { id: data.facebookPageId } });
  if (!page || page.pageId !== data.pageId || page.status !== "ACTIVE" || !page.accessToken) {
    return "ignored";
  }

  const campaigns = await prisma.facebookCampaign.findMany({
    where: {
      facebookPageId: page.id,
      isActive: true,
      OR: [{ postId: data.postId }, { matchAnyPost: true }],
    },
  });
  const pick = pickCampaign(campaigns, data.postId, data.text);

  // The log row is the claim on the comment. A retry or a hold finds it
  // even if the campaign was edited or paused in the meantime.
  const key = { facebookPageId_commentId: { facebookPageId: page.id, commentId: data.commentId } };
  const existing = await prisma.facebookCommentLog.findUnique({ where: key });
  if (!existing && !pick) return "no_match";
  const log = existing ?? (await createLog(key, page, data, pick!));

  const campaign =
    campaigns.find((candidate) => candidate.id === log.campaignId) ??
    (log.campaignId
      ? await prisma.facebookCampaign.findUnique({ where: { id: log.campaignId } })
      : null);
  if (!campaign) return "ignored";

  if (!isWithinPrivateReplyWindow(log.commentCreatedAt)) {
    if (!log.privateReplySentAt) {
      await prisma.facebookCommentLog.updateMany({
        where: { id: log.id, status: { in: ["PENDING", "FAILED"] }, deliveryUnconfirmed: false },
        data: {
          status: "SKIPPED_EXPIRED",
          errorMessage: "The comment is older than the 7 days Meta allows for a private reply",
        },
      });
    }
    return "expired";
  }

  const token = pageToken(page);

  if (campaign.publicReplyEnabled && !log.publicReplySentAt && !log.publicReplyDeliveryUnconfirmed) {
    await sendPublicReply(log, campaign, token, data.commenterName);
  }

  if (
    (FINAL_STATUSES as readonly string[]).includes(log.status) ||
    log.deliveryUnconfirmed ||
    log.attempts >= MAX_COMMENT_SEND_ATTEMPTS
  ) {
    return "nothing_to_do";
  }

  const limiterKey = rateLimitKey(page.pageId);
  const rate = await reserveDMSlot(limiterKey, data.requeueAttempt ?? 0, data.slotAt ?? 0, data.commentId);
  if (!rate.allowed) {
    if (rate.duplicate) return "duplicate";
    if (rate.shouldSkip) {
      await prisma.facebookCommentLog.updateMany({
        where: { id: log.id, status: { in: ["PENDING", "FAILED"] }, deliveryUnconfirmed: false },
        data: {
          status: "SKIPPED_RATE_LIMIT",
          errorMessage: "Rate limit reached for this Page; the comment waited too long",
        },
      });
      return "rate_limited";
    }
    await prisma.facebookCommentLog.update({
      where: { id: log.id },
      data: {
        errorMessage: rate.slotAt
          ? "Waiting for its send slot (comment DMs are paced); retry scheduled"
          : "Rate limited for this Page; retry scheduled",
      },
    });
    await requeue(job, rate.requeueDelayMs, rate.slotAt);
    return "held";
  }

  const claim = await prisma.facebookCommentLog.updateMany({
    where: {
      id: log.id,
      status: { notIn: [...FINAL_STATUSES] },
      deliveryUnconfirmed: false,
      attempts: { lt: MAX_COMMENT_SEND_ATTEMPTS },
    },
    data: { deliveryUnconfirmed: true, attempts: { increment: 1 }, status: "PENDING", errorMessage: null },
  });
  if (claim.count !== 1) {
    if (rate.reserved) await releaseDMSlot(limiterKey);
    return "nothing_to_do";
  }

  const text = renderTemplate(campaign.privateReplyMessage, { name: firstName(data.commenterName) });
  try {
    const result = await sendWithFallback(page, token, log, text, campaign);
    const sentAt = new Date();
    await prisma.facebookCommentLog.update({
      where: { id: log.id },
      data: {
        status: "SENT",
        deliveryUnconfirmed: false,
        privateReplySentAt: sentAt,
        recipientPsid: result.recipient_id ?? null,
        privateReplyMessageId: result.message_id ?? null,
        errorMessage: null,
      },
    });
    await recordDelivery(limiterKey).catch(() => {});
    if (result.recipient_id) {
      await recordPrivateReplyConversation({
        workspaceId: page.workspaceId,
        facebookPageId: page.id,
        psid: result.recipient_id,
        commenterName: data.commenterName ?? log.commenterName,
        campaignId: campaign.id,
        commentId: log.commentId,
        text: `${text}\n${landingUrlFor(campaign)}`,
        messageId: result.message_id,
        sentAt,
      });
    }
    return "sent";
  } catch (error) {
    const fbError =
      error instanceof FacebookApiError ? error : new FacebookApiError(errorText(error), "ambiguous");

    if (fbError.kind === "ambiguous") {
      // Meta may have delivered it. The slot stays used and nothing retries.
      await prisma.facebookCommentLog.update({
        where: { id: log.id },
        data: { status: "UNCONFIRMED", errorMessage: fbError.message },
      });
      return "unconfirmed";
    }

    // A confirmed refusal: nothing was delivered.
    if (rate.reserved) await releaseDMSlot(limiterKey).catch(() => {});

    if (fbError.kind === "unreachable") {
      // The request never left: a network blip on the server must not cost
      // the reply. Try again in a few minutes, for a couple of hours at most.
      if ((data.requeueAttempt ?? 0) >= MAX_UNREACHABLE_REQUEUES) {
        await prisma.facebookCommentLog.update({
          where: { id: log.id },
          data: { status: "FAILED", deliveryUnconfirmed: false, errorMessage: fbError.message },
        });
        return "failed";
      }
      await prisma.facebookCommentLog.update({
        where: { id: log.id },
        data: { deliveryUnconfirmed: false, attempts: { decrement: 1 }, errorMessage: fbError.message },
      });
      await requeue(job, UNREACHABLE_RETRY_MS, undefined);
      return "held";
    }

    if (fbError.kind === "rate_limit") {
      await pauseDMSends(limiterKey).catch(() => {});
      await prisma.facebookCommentLog.update({
        where: { id: log.id },
        data: {
          deliveryUnconfirmed: false,
          // Being throttled is not the comment's fault: give the try back.
          attempts: { decrement: 1 },
          errorMessage: fbError.message,
        },
      });
      await requeue(job, RATE_LIMITED_RETRY_MS, undefined);
      return "held";
    }

    const status =
      fbError.kind === "already_replied"
        ? ("SKIPPED_ALREADY_REPLIED" as const)
        : fbError.kind === "not_eligible"
          ? ("SKIPPED_NOT_ELIGIBLE" as const)
          : ("FAILED" as const);
    await prisma.facebookCommentLog.update({
      where: { id: log.id },
      data: { status, deliveryUnconfirmed: false, errorMessage: fbError.message },
    });
    if (fbError.kind === "token_invalid") {
      await prisma.facebookPage.update({
        where: { id: page.id },
        data: { status: "TOKEN_INVALID", lastError: fbError.message },
      });
    }
    return status === "SKIPPED_ALREADY_REPLIED"
      ? "already_replied"
      : status === "SKIPPED_NOT_ELIGIBLE"
        ? "not_eligible"
        : "failed";
  }
}
