/**
 * The bot hands a conversation to a person.
 *
 * One conditional update, in a transaction with its HANDOFF event: only a
 * conversation still with the bot is handed off, so two jobs, or a job and
 * a person clicking "take over", never produce two handoffs or two alerts.
 * The HANDOFF event is what the alerts are sent for (lib/alerts).
 */
import type { HandoffCategory } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";

export async function handOffConversation(
  conversationId: string,
  { category, reason }: { category: HandoffCategory; reason: string }
): Promise<{ eventId: string; workspaceId: string } | null> {
  return prisma.$transaction(async (tx) => {
    const current = await tx.facebookConversation.findUnique({
      where: { id: conversationId },
      select: { workspaceId: true, mode: true },
    });
    // A person already has it: nobody needs to be called.
    if (!current || current.mode !== "BOT") return null;
    const now = new Date();
    const updated = await tx.facebookConversation.updateMany({
      where: { id: conversationId, mode: "BOT" },
      data: {
        mode: "HUMAN",
        modeReason: "BOT_HANDOFF",
        modeChangedAt: now,
        needsHuman: true,
        handoffCategory: category,
        handoffReason: reason,
        handoffAt: now,
      },
    });
    if (updated.count !== 1) return null;
    const event = await tx.facebookConversationEvent.create({
      data: { workspaceId: current.workspaceId, conversationId, type: "HANDOFF", category, reason },
      select: { id: true },
    });
    return { eventId: event.id, workspaceId: current.workspaceId };
  });
}
