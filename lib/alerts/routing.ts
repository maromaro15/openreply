/**
 * Who gets the alert of a handoff: the active recipients routed to its
 * category, or, when the category has none, the active default recipients.
 * No recipient means no alert: the conversation still waits in the inbox.
 */
import type { AlertRecipient, HandoffCategory } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";

export async function recipientsForCategory(
  workspaceId: string,
  category: HandoffCategory
): Promise<AlertRecipient[]> {
  const routed = await prisma.alertRecipient.findMany({
    where: { workspaceId, isActive: true, routes: { some: { category, workspaceId } } },
    orderBy: { createdAt: "asc" },
  });
  if (routed.length > 0) return routed;
  return prisma.alertRecipient.findMany({
    where: { workspaceId, isActive: true, isDefault: true },
    orderBy: { createdAt: "asc" },
  });
}
