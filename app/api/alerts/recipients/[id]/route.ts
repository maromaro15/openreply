import { NextResponse, type NextRequest } from "next/server";
import { jsonError, requireWorkspace } from "@/lib/agency/http";
import { deleteRecipient, recipientPatchSchema, updateRecipient } from "@/lib/alerts/settings";

type RouteProps = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

/** `{ label?, isDefault?, isActive? }`; the channel and address are fixed: add a new recipient instead. */
export async function PATCH(request: NextRequest, { params }: RouteProps) {
  const context = await requireWorkspace(request, "ADMIN");
  if (context instanceof Response) return context;
  const parsed = recipientPatchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError(400, parsed.error.issues[0]?.message ?? "Invalid recipient");
  if (Object.keys(parsed.data).length === 0) return jsonError(400, "Nothing to change.");
  if (!(await updateRecipient(context.workspaceId, (await params).id, parsed.data))) {
    return jsonError(404, "Recipient not found.");
  }
  return NextResponse.json({ success: true });
}

export async function DELETE(request: NextRequest, { params }: RouteProps) {
  const context = await requireWorkspace(request, "ADMIN");
  if (context instanceof Response) return context;
  if (!(await deleteRecipient(context.workspaceId, (await params).id))) {
    return jsonError(404, "Recipient not found.");
  }
  return NextResponse.json({ success: true });
}
