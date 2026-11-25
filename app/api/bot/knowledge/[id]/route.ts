import { NextResponse, type NextRequest } from "next/server";
import { jsonError, requireWorkspace } from "@/lib/agency/http";
import { deleteKnowledgeEntry, knowledgePatchSchema, updateKnowledgeEntry } from "@/lib/bot/knowledge";

type RouteProps = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

export async function PATCH(request: NextRequest, { params }: RouteProps) {
  const context = await requireWorkspace(request, "ADMIN");
  if (context instanceof Response) return context;
  const parsed = knowledgePatchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError(400, parsed.error.issues[0]?.message ?? "Invalid entry");
  if (Object.keys(parsed.data).length === 0) return jsonError(400, "Nothing to change.");
  if (!(await updateKnowledgeEntry(context.workspaceId, (await params).id, parsed.data))) {
    return jsonError(404, "Entry not found.");
  }
  return NextResponse.json({ success: true });
}

export async function DELETE(request: NextRequest, { params }: RouteProps) {
  const context = await requireWorkspace(request, "ADMIN");
  if (context instanceof Response) return context;
  if (!(await deleteKnowledgeEntry(context.workspaceId, (await params).id))) {
    return jsonError(404, "Entry not found.");
  }
  return NextResponse.json({ success: true });
}
