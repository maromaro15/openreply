import { NextResponse, type NextRequest } from "next/server";
import { jsonError, requireWorkspace } from "@/lib/agency/http";
import { convertKnowledgeProduct } from "@/lib/catalog/products";
import { PRODUCT_ERRORS } from "@/lib/catalog/errors";

export const dynamic = "force-dynamic";

/** `{ entryId }`: a simple product of the knowledge base becomes a product card. */
export async function POST(request: NextRequest) {
  const context = await requireWorkspace(request, "ADMIN");
  if (context instanceof Response) return context;
  const body = (await request.json().catch(() => null)) as { entryId?: unknown } | null;
  if (typeof body?.entryId !== "string" || !body.entryId) return jsonError(400, "Send { entryId }.");
  const result = await convertKnowledgeProduct(context.workspaceId, body.entryId);
  if (!result.ok) {
    const failure = PRODUCT_ERRORS[result.error];
    return NextResponse.json({ success: false, code: result.error, error: failure.message }, { status: failure.status });
  }
  return NextResponse.json({ success: true, data: { product: result.product } }, { status: 201 });
}
