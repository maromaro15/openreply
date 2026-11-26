/**
 * The brand's basic Messenger statistics over the last days: how many
 * customers wrote, how the bot and the team answered, and the handoffs.
 */
import { prisma } from "@/lib/db/client";
import type { HandoffCategory } from "@/app/generated/prisma/client";

export const STATS_PERIODS = [7, 30] as const;
export type StatsPeriod = (typeof STATS_PERIODS)[number];

export interface MessengerStats {
  days: StatsPeriod;
  conversations: number;
  customerMessages: number;
  botReplies: number;
  teamReplies: number;
  handoffs: number;
  handoffsByCategory: Partial<Record<HandoffCategory, number>>;
  /** Now, whatever the period: the conversations waiting for a person. */
  waitingNow: number;
}

export async function messengerStats(workspaceId: string, days: StatsPeriod, now = new Date()): Promise<MessengerStats> {
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const messages = (where: object) =>
    prisma.facebookMessage.count({ where: { workspaceId, sentAt: { gte: since }, ...where } });
  const [conversations, customerMessages, botReplies, teamReplies, handoffs, waitingNow] = await Promise.all([
    prisma.facebookConversation.count({ where: { workspaceId, lastInboundAt: { gte: since } } }),
    messages({ direction: "INBOUND" }),
    messages({ direction: "OUTBOUND", author: "BOT" }),
    messages({ direction: "OUTBOUND", author: "HUMAN" }),
    prisma.facebookConversationEvent.groupBy({
      by: ["category"],
      where: { workspaceId, type: "HANDOFF", createdAt: { gte: since } },
      _count: { _all: true },
    }),
    prisma.facebookConversation.count({ where: { workspaceId, needsHuman: true } }),
  ]);
  const handoffsByCategory: MessengerStats["handoffsByCategory"] = {};
  for (const row of handoffs) {
    const category = row.category ?? "OTHER";
    handoffsByCategory[category] = (handoffsByCategory[category] ?? 0) + row._count._all;
  }
  return {
    days,
    conversations,
    customerMessages,
    botReplies,
    teamReplies,
    handoffs: handoffs.reduce((sum, row) => sum + row._count._all, 0),
    handoffsByCategory,
    waitingNow,
  };
}
