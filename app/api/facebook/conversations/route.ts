import { NextResponse, type NextRequest } from "next/server";
import { requireWorkspace } from "@/lib/agency/http";
import { isHandoffCategory } from "@/lib/handoff/categories";
import { CONVERSATION_PAGE_SIZE, isConversationFilter, listConversations } from "@/lib/facebook/inbox";

export const dynamic = "force-dynamic";

/**
 * Messenger conversations of the active brand. Every team member works the
 * inbox, so MEMBER is enough.
 *
 * ?filter=needs_human|all|bot|human  &category=<HandoffCategory>
 * &page=<FacebookPage.id>  &limit=<n>
 */
export async function GET(request: NextRequest) {
  const context = await requireWorkspace(request, "MEMBER");
  if (context instanceof Response) return context;

  const params = request.nextUrl.searchParams;
  const filter = params.get("filter");
  const category = params.get("category");
  const limit = Number(params.get("limit"));
  const result = await listConversations(context.workspaceId, {
    filter: isConversationFilter(filter) ? filter : "needs_human",
    category: isHandoffCategory(category) ? category : null,
    facebookPageId: params.get("page") || null,
    limit: Number.isFinite(limit) && limit > 0 ? limit : CONVERSATION_PAGE_SIZE,
  });
  return NextResponse.json({
    success: true,
    data: { ...result, workspaceId: context.workspaceId },
  });
}
