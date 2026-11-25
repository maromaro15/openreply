/**
 * Facebook campaigns: a keyword on a Page's comments, answered with a
 * private reply that carries a link button to the campaign's landing page.
 */
import { z } from "zod";
import type { FacebookCommentStatus, Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { BUTTON_TEMPLATE_TEXT_LIMIT, BUTTON_TITLE_LIMIT } from "./graph";

const httpUrl = z
  .string()
  .trim()
  .max(2000)
  .url()
  .refine((value) => /^https?:\/\//i.test(value), "Use an http or https link.");

export const campaignInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    facebookPageId: z.string().min(1).max(64),
    matchAnyPost: z.boolean().default(false),
    postId: z
      .string()
      .trim()
      .regex(/^\d+_\d+$/, "A post ID looks like 1234567890_9876543210.")
      .nullable()
      .optional(),
    postPermalink: httpUrl.nullable().optional(),
    postPreview: z.string().trim().max(300).nullable().optional(),
    keywords: z.array(z.string().trim().min(1).max(50)).max(20).default([]),
    matchAnyWord: z.boolean().default(false),
    wholeWordMatch: z.boolean().default(true),
    privateReplyMessage: z.string().trim().min(1).max(BUTTON_TEMPLATE_TEXT_LIMIT),
    buttonLabel: z.string().trim().min(1).max(BUTTON_TITLE_LIMIT),
    landingUrl: httpUrl,
    addUtm: z.boolean().default(true),
    publicReplyEnabled: z.boolean().default(false),
    publicReplyMessages: z.array(z.string().trim().min(1).max(1000)).max(10).default([]),
    botContext: z.string().trim().max(2000).nullable().optional(),
    isActive: z.boolean().default(true),
  })
  .superRefine((value, ctx) => {
    if (!value.matchAnyPost && !value.postId) {
      ctx.addIssue({ code: "custom", path: ["postId"], message: "Pick a post, or answer comments on any post." });
    }
    if (!value.matchAnyWord && value.keywords.length === 0) {
      ctx.addIssue({ code: "custom", path: ["keywords"], message: "Add a keyword, or answer every comment." });
    }
    if (value.publicReplyEnabled && value.publicReplyMessages.length === 0) {
      ctx.addIssue({ code: "custom", path: ["publicReplyMessages"], message: "Add at least one public reply." });
    }
  });

export type CampaignInput = z.output<typeof campaignInputSchema>;

/** Normalise validated input into the columns. */
export function campaignData(input: CampaignInput) {
  const keywords = [...new Set(input.keywords.map((keyword) => keyword.trim()).filter(Boolean))];
  return {
    name: input.name,
    facebookPageId: input.facebookPageId,
    matchAnyPost: input.matchAnyPost,
    postId: input.matchAnyPost ? null : (input.postId ?? null),
    postPermalink: input.matchAnyPost ? null : (input.postPermalink ?? null),
    postPreview: input.matchAnyPost ? null : (input.postPreview ?? null),
    keywords,
    matchAnyWord: input.matchAnyWord,
    wholeWordMatch: input.wholeWordMatch,
    privateReplyMessage: input.privateReplyMessage,
    buttonLabel: input.buttonLabel,
    landingUrl: input.landingUrl,
    addUtm: input.addUtm,
    publicReplyEnabled: input.publicReplyEnabled,
    publicReplyMessages: input.publicReplyEnabled ? input.publicReplyMessages : [],
    botContext: input.botContext?.trim() || null,
    isActive: input.isActive,
  };
}

/** The Page must be this brand's and still connected. */
export async function workspaceOwnsPage(workspaceId: string, facebookPageId: string): Promise<boolean> {
  const page = await prisma.facebookPage.findFirst({
    where: { id: facebookPageId, workspaceId, status: { not: "DISCONNECTED" } },
    select: { id: true },
  });
  return Boolean(page);
}

export interface CampaignStats {
  matched: number;
  sent: number;
  failed: number;
  skipped: number;
  pending: number;
}

function emptyStats(): CampaignStats {
  return { matched: 0, sent: 0, failed: 0, skipped: 0, pending: 0 };
}

function bucket(status: FacebookCommentStatus): keyof Omit<CampaignStats, "matched"> {
  if (status === "SENT") return "sent";
  if (status === "FAILED" || status === "UNCONFIRMED") return "failed";
  if (status === "PENDING") return "pending";
  return "skipped";
}

export async function listCampaigns(workspaceId: string) {
  const campaigns = await prisma.facebookCampaign.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "desc" },
    include: { page: { select: { id: true, name: true, status: true } } },
  });
  const counts = await prisma.facebookCommentLog.groupBy({
    by: ["campaignId", "status"],
    where: { workspaceId, campaignId: { in: campaigns.map((campaign) => campaign.id) } },
    _count: { _all: true },
  });
  const stats = new Map<string, CampaignStats>();
  for (const row of counts) {
    if (!row.campaignId) continue;
    const entry = stats.get(row.campaignId) ?? emptyStats();
    entry.matched += row._count._all;
    entry[bucket(row.status)] += row._count._all;
    stats.set(row.campaignId, entry);
  }
  return campaigns.map((campaign) => ({ ...campaign, stats: stats.get(campaign.id) ?? emptyStats() }));
}

export async function getCampaign(workspaceId: string, id: string) {
  return prisma.facebookCampaign.findFirst({ where: { id, workspaceId } });
}

export async function createCampaign(workspaceId: string, input: CampaignInput) {
  return prisma.facebookCampaign.create({ data: { workspaceId, ...campaignData(input) } });
}

export async function updateCampaign(workspaceId: string, id: string, input: CampaignInput) {
  const result = await prisma.facebookCampaign.updateMany({
    where: { id, workspaceId },
    data: campaignData(input),
  });
  return result.count === 1;
}

export async function setCampaignActive(workspaceId: string, id: string, isActive: boolean) {
  const result = await prisma.facebookCampaign.updateMany({ where: { id, workspaceId }, data: { isActive } });
  return result.count === 1;
}

export async function deleteCampaign(workspaceId: string, id: string) {
  const result = await prisma.facebookCampaign.deleteMany({ where: { id, workspaceId } });
  return result.count === 1;
}

export const COMMENT_LOG_PAGE_SIZE = 50;

export async function listCommentLogs(
  workspaceId: string,
  { campaignId, status, cursor }: { campaignId?: string | null; status?: string | null; cursor?: string | null }
) {
  const where: Prisma.FacebookCommentLogWhereInput = { workspaceId };
  if (campaignId) where.campaignId = campaignId;
  if (status) where.status = status as FacebookCommentStatus;
  const rows = await prisma.facebookCommentLog.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: COMMENT_LOG_PAGE_SIZE + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: {
      campaign: { select: { id: true, name: true } },
      page: { select: { id: true, name: true } },
    },
  });
  const hasMore = rows.length > COMMENT_LOG_PAGE_SIZE;
  const logs = rows.slice(0, COMMENT_LOG_PAGE_SIZE);
  return { logs, nextCursor: hasMore ? logs[logs.length - 1].id : null };
}

export const COMMENT_STATUSES: FacebookCommentStatus[] = [
  "PENDING",
  "SENT",
  "FAILED",
  "UNCONFIRMED",
  "SKIPPED_EXPIRED",
  "SKIPPED_ALREADY_REPLIED",
  "SKIPPED_NOT_ELIGIBLE",
  "SKIPPED_RATE_LIMIT",
];
