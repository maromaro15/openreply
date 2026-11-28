import { NextResponse, type NextRequest } from "next/server";
import { jsonError, requireWorkspace } from "@/lib/agency/http";
import {
  approveDraft,
  DRAFT_ERRORS,
  draftActionSchema,
  getDraftInfo,
  mergeDraft,
  rejectDraft,
  type DraftError,
} from "@/lib/catalog/drafts";

type RouteProps = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

/** Where a draft came from, and the product it most likely duplicates. */
export async function GET(request: NextRequest, { params }: RouteProps) {
  const context = await requireWorkspace(request, "MEMBER");
  if (context instanceof Response) return context;
  const draft = await getDraftInfo(context.workspaceId, (await params).id);
  if (!draft) return jsonError(404, DRAFT_ERRORS.not_a_draft.message);
  return NextResponse.json({ success: true, data: { role: context.role, draft } });
}

/** `{ action: "approve" }`, `{ action: "merge", targetId }` or `{ action: "reject" }`. */
export async function POST(request: NextRequest, { params }: RouteProps) {
  const context = await requireWorkspace(request, "ADMIN");
  if (context instanceof Response) return context;
  const parsed = draftActionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError(400, 'Send { action: "approve" | "merge" | "reject" } (merge also needs targetId).');
  }

  const { workspaceId } = context;
  const id = (await params).id;
  const action = parsed.data;

  if (action.action === "merge") {
    const merged = await mergeDraft(workspaceId, id, action.targetId);
    if (!merged.ok) return refusal(merged);
    return NextResponse.json({ success: true, data: { action: "merge", target: merged.target, copied: merged.copied } });
  }
  const result = action.action === "approve" ? await approveDraft(workspaceId, id) : await rejectDraft(workspaceId, id);
  if (!result.ok) return refusal(result);
  return NextResponse.json({ success: true, data: { action: action.action } });
}

/** A refused decision: the reason in English (the screen translates it), and the product in the way, if any. */
function refusal(result: { error: DraftError; target?: { id: string; name: string } }) {
  const failure = DRAFT_ERRORS[result.error];
  return NextResponse.json(
    { success: false, code: result.error, error: failure.message, target: result.target ?? null },
    { status: failure.status }
  );
}
