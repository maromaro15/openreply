import { NextResponse, type NextRequest } from "next/server";
import { jsonError, requireWorkspace } from "@/lib/agency/http";
import { attributeInputSchema, createAttribute, listAttributes, MAX_ATTRIBUTES } from "@/lib/catalog/attributes";

export const dynamic = "force-dynamic";

/** The brand's own product attributes (its template). */
export async function GET(request: NextRequest) {
  const context = await requireWorkspace(request, "MEMBER");
  if (context instanceof Response) return context;
  return NextResponse.json({
    success: true,
    data: { role: context.role, limit: MAX_ATTRIBUTES, attributes: await listAttributes(context.workspaceId) },
  });
}

export async function POST(request: NextRequest) {
  const context = await requireWorkspace(request, "ADMIN");
  if (context instanceof Response) return context;
  const parsed = attributeInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError(400, parsed.error.issues[0]?.message ?? "Invalid attribute");
  const attribute = await createAttribute(context.workspaceId, parsed.data);
  if (!attribute) return jsonError(400, "This brand has reached the number of attributes it can hold.");
  return NextResponse.json({ success: true, data: { attribute } }, { status: 201 });
}
