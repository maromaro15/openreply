import { NextResponse, type NextRequest } from "next/server";
import { jsonError, requireWorkspace } from "@/lib/agency/http";
import {
  countSuggestions,
  isSuggestionSource,
  isSuggestionStatus,
  listSuggestions,
  REVIEW_MAX_BULK,
  rejectSuggestions,
} from "@/lib/knowledge/review";

export const dynamic = "force-dynamic";

/**
 * `?status=PENDING|APPROVED|REJECTED|ALL&source=&cursor=&take=` (PENDING by
 * default; take: 1 to 100). `?countOnly=true` skips the list: for the badge.
 */
export async function GET(request: NextRequest) {
  const context = await requireWorkspace(request, "MEMBER");
  if (context instanceof Response) return context;
  const params = request.nextUrl.searchParams;
  const counts = await countSuggestions(context.workspaceId);
  if (params.get("countOnly") === "true") {
    return NextResponse.json({ success: true, data: { role: context.role, counts } });
  }
  const status = params.get("status");
  const source = params.get("source");
  const take = Number.parseInt(params.get("take") ?? "", 10);
  const result = await listSuggestions(context.workspaceId, {
    status: status === "ALL" ? null : isSuggestionStatus(status) ? status : "PENDING",
    source: isSuggestionSource(source) ? source : null,
    cursor: params.get("cursor"),
    take: Number.isFinite(take) ? take : undefined,
  });
  return NextResponse.json({ success: true, data: { role: context.role, counts, ...result } });
}

/** `{ action: "reject", ids: [...] }`: reject several at once (at most REVIEW_MAX_BULK). */
export async function POST(request: NextRequest) {
  const context = await requireWorkspace(request, "ADMIN");
  if (context instanceof Response) return context;
  const body = (await request.json().catch(() => null)) as { action?: unknown; ids?: unknown } | null;
  const ids = Array.isArray(body?.ids) ? body.ids : null;
  if (
    body?.action !== "reject" ||
    !ids ||
    ids.length === 0 ||
    ids.length > REVIEW_MAX_BULK ||
    !ids.every((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 100)
  ) {
    return jsonError(400, `Send { action: "reject", ids: [1 to ${REVIEW_MAX_BULK} ids] }.`);
  }
  const rejected = await rejectSuggestions(context.workspaceId, context.userId, ids);
  return NextResponse.json({ success: true, data: { rejected } });
}
