import { NextResponse, type NextRequest } from "next/server";
import { jsonError, requireWorkspace } from "@/lib/agency/http";
import {
  deleteProduct,
  getProduct,
  productInputSchema,
  setProductStatus,
  updateProduct,
} from "@/lib/catalog/products";
import { PRODUCT_ERRORS } from "@/lib/catalog/errors";

type RouteProps = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: RouteProps) {
  const context = await requireWorkspace(request, "MEMBER");
  if (context instanceof Response) return context;
  const product = await getProduct(context.workspaceId, (await params).id);
  if (!product) return jsonError(404, "Product not found.");
  return NextResponse.json({ success: true, data: { role: context.role, product } });
}

/** The whole card, as the editor sends it. */
export async function PUT(request: NextRequest, { params }: RouteProps) {
  const context = await requireWorkspace(request, "ADMIN");
  if (context instanceof Response) return context;
  const parsed = productInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? "Invalid product", issues: parsed.error.issues },
      { status: 400 }
    );
  }
  const result = await updateProduct(context.workspaceId, (await params).id, parsed.data);
  if (!result.ok) {
    const failure = PRODUCT_ERRORS[result.error];
    return NextResponse.json(
      { success: false, code: result.error, error: failure.message, detail: result.detail ?? null },
      { status: failure.status }
    );
  }
  return NextResponse.json({ success: true, data: { product: result.product } });
}

const STATUSES = ["ACTIVE", "DRAFT", "ARCHIVED"] as const;

/** `{ status }`: approve a draft, archive, or bring back. */
export async function PATCH(request: NextRequest, { params }: RouteProps) {
  const context = await requireWorkspace(request, "ADMIN");
  if (context instanceof Response) return context;
  const body = (await request.json().catch(() => null)) as { status?: unknown } | null;
  const status = body?.status;
  if (typeof status !== "string" || !(STATUSES as readonly string[]).includes(status)) {
    return jsonError(400, "Send { status: ACTIVE | DRAFT | ARCHIVED }.");
  }
  if (!(await setProductStatus(context.workspaceId, (await params).id, status as (typeof STATUSES)[number]))) {
    return jsonError(404, "Product not found.");
  }
  return NextResponse.json({ success: true });
}

export async function DELETE(request: NextRequest, { params }: RouteProps) {
  const context = await requireWorkspace(request, "ADMIN");
  if (context instanceof Response) return context;
  if (!(await deleteProduct(context.workspaceId, (await params).id))) return jsonError(404, "Product not found.");
  return NextResponse.json({ success: true });
}
