/**
 * Whether new Messenger messages of a brand reach the bot. When they do not,
 * nothing answers them, nothing hands them to a person and no alert is sent,
 * so the inbox says so.
 */
import { prisma } from "@/lib/db/client";

/** "brand": AI reply is off for the brand; "pages": off on every active Page; null: the bot answers. */
export type AiReplyOff = "brand" | "pages" | null;

export async function aiReplyOff(workspaceId: string): Promise<AiReplyOff> {
  const [settings, pages] = await Promise.all([
    prisma.botSettings.findUnique({ where: { workspaceId }, select: { enabled: true } }),
    prisma.facebookPage.findMany({ where: { workspaceId, status: "ACTIVE" }, select: { botEnabled: true } }),
  ]);
  // No row is a new brand: AI reply starts off (lib/bot/knowledge getBotSettings).
  if (!settings?.enabled) return "brand";
  if (pages.length > 0 && pages.every((page) => !page.botEnabled)) return "pages";
  return null;
}
