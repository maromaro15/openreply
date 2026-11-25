import { NextResponse, type NextRequest } from "next/server";
import { jsonError, requireWorkspace } from "@/lib/agency/http";
import {
  attributePatchSchema,
  deleteAttribute,
  listAttributes,
  MIN_CHOICE_OPTIONS,
  updateAttribute,
} from "@/lib/catalog/attributes";

type RouteProps = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

/** `{ label?, unit?, options?, sortOrder? }`: an attribute's type never changes. */
export async function PATCH(request: NextRequest, { params }: RouteProps) {
  const context = await requireWorkspace(request, "ADMIN");
  if (context instanceof Response) return context;
  const parsed = attributePatchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError(400, parsed.error.issues[0]?.message ?? "Invalid attribute");
  if (Object.keys(parsed.data).length === 0) return jsonError(400, "Nothing to change.");
  const { id } = await params;
  const attribute = await updateAttribute(context.workspaceId, id, parsed.data);
  if (!attribute) {
    // updateAttribute also refuses a list left with too few options: say so
    // when the attribute does exist.
    const fewOptions = parsed.data.options !== undefined && parsed.data.options.length < MIN_CHOICE_OPTIONS;
    if (fewOptions && (await listAttributes(context.workspaceId)).some((candidate) => candidate.id === id)) {
      return jsonError(400, "A list needs at least two options.");
    }
    return jsonError(404, "Attribute not found.");
  }
  return NextResponse.json({ success: true, data: { attribute } });
}

/** The values already on product cards stay, unused, until the cards are saved again. */
export async function DELETE(request: NextRequest, { params }: RouteProps) {
  const context = await requireWorkspace(request, "ADMIN");
  if (context instanceof Response) return context;
  if (!(await deleteAttribute(context.workspaceId, (await params).id))) return jsonError(404, "Attribute not found.");
  return NextResponse.json({ success: true });
}
