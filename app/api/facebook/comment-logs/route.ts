import { NextResponse, type NextRequest } from "next/server";
import { requireWorkspace } from "@/lib/agency/http";
import { COMMENT_STATUSES, listCommentLogs } from "@/lib/facebook/campaigns";

export const dynamic = "force-dynamic";

/** Matched comments of the active brand, newest first, 50 at a time. */
export async function GET(request: NextRequest) {
  const context = await requireWorkspace(request, "MEMBER");
  if (context instanceof Response) return context;

  const params = request.nextUrl.searchParams;
  const status = params.get("status");
  const result = await listCommentLogs(context.workspaceId, {
    campaignId: params.get("campaignId"),
    status: status && (COMMENT_STATUSES as string[]).includes(status) ? status : null,
    cursor: params.get("cursor"),
  });
  return NextResponse.json({ success: true, data: result });
}
