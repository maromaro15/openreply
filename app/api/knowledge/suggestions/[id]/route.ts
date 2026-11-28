import { NextResponse, type NextRequest } from "next/server";
import { jsonError, requireWorkspace } from "@/lib/agency/http";
import { approveSuggestion, rejectSuggestion, REVIEW_ERRORS } from "@/lib/knowledge/review";

type RouteProps = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

/** `{ action: "approve", payload? }` (payload: the reviewer's edit) or `{ action: "reject" }`. */
export async function PATCH(request: NextRequest, { params }: RouteProps) {
  const context = await requireWorkspace(request, "ADMIN");
  if (context instanceof Response) return context;
  const body = (await request.json().catch(() => null)) as { action?: unknown; payload?: unknown } | null;
  if (body?.action !== "approve" && body?.action !== "reject") {
    return jsonError(400, 'Send { action: "approve" | "reject" }.');
  }
  const { id } = await params;
  const result =
    body.action === "approve"
      ? await approveSuggestion(context.workspaceId, context.userId, id, body.payload)
      : await rejectSuggestion(context.workspaceId, context.userId, id);
  if (!result.ok) {
    const failure = REVIEW_ERRORS[result.error];
    return NextResponse.json(
      { success: false, code: result.error, error: failure.message, detail: result.detail ?? null },
      { status: failure.status }
    );
  }
  return NextResponse.json({ success: true, data: { applied: result.applied } });
}
