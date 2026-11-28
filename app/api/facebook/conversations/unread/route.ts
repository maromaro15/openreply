import { NextResponse, type NextRequest } from "next/server";
import { requireWorkspace } from "@/lib/agency/http";
import { countUnreadConversations } from "@/lib/facebook/inbox";

export const dynamic = "force-dynamic";

/**
 * How many conversations of the active brand have messages nobody opened:
 * the badge on the menu's inbox and the count in the browser tab. Under
 * /api/facebook/conversations, so a brand owner (VIEWER) reads it too.
 */
export async function GET(request: NextRequest) {
  const context = await requireWorkspace(request, "MEMBER");
  if (context instanceof Response) return context;
  return NextResponse.json({ success: true, data: { count: await countUnreadConversations(context.workspaceId) } });
}
