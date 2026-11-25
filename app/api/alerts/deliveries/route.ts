import { NextResponse, type NextRequest } from "next/server";
import { requireWorkspace } from "@/lib/agency/http";
import { prisma } from "@/lib/db/client";

export const dynamic = "force-dynamic";

/** The brand's last 50 alerts, with what happened to each. */
export async function GET(request: NextRequest) {
  const context = await requireWorkspace(request, "MEMBER");
  if (context instanceof Response) return context;
  const deliveries = await prisma.alertDelivery.findMany({
    where: { workspaceId: context.workspaceId },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  const recipientIds = [...new Set(deliveries.map((row) => row.recipientId).filter((id): id is string => Boolean(id)))];
  const recipients = recipientIds.length
    ? await prisma.alertRecipient.findMany({
        where: { id: { in: recipientIds }, workspaceId: context.workspaceId },
        select: { id: true, label: true },
      })
    : [];
  const labels = new Map(recipients.map((recipient) => [recipient.id, recipient.label]));
  return NextResponse.json({
    success: true,
    data: {
      deliveries: deliveries.map((row) => ({
        id: row.id,
        channel: row.channel,
        category: row.category,
        isTest: row.isTest,
        status: row.status,
        attempts: row.attempts,
        error: row.error,
        conversationId: row.conversationId,
        recipient: row.recipientId ? (labels.get(row.recipientId) ?? null) : null,
        createdAt: row.createdAt.toISOString(),
        sentAt: row.sentAt?.toISOString() ?? null,
      })),
    },
  });
}
