import { NextResponse, type NextRequest } from "next/server";
import { requireWorkspace } from "@/lib/agency/http";
import { PRODUCT_ERRORS } from "@/lib/catalog/errors";
import { createProduct, listProducts, productInputSchema } from "@/lib/catalog/products";

export const dynamic = "force-dynamic";

const STATUSES = ["ACTIVE", "DRAFT", "ARCHIVED"] as const;

/** `?search=&status=&available=true|false&cursor=&take=` (take: 1 to 200, 50 by default). */
export async function GET(request: NextRequest) {
  const context = await requireWorkspace(request, "MEMBER");
  if (context instanceof Response) return context;
  const params = request.nextUrl.searchParams;
  const status = params.get("status");
  const available = params.get("available");
  const take = Number.parseInt(params.get("take") ?? "", 10);
  const result = await listProducts(context.workspaceId, {
    search: params.get("search"),
    status: (STATUSES as readonly string[]).includes(status ?? "") ? (status as (typeof STATUSES)[number]) : null,
    available: available === "true" ? true : available === "false" ? false : null,
    cursor: params.get("cursor"),
    take: Number.isFinite(take) ? Math.min(Math.max(take, 1), 200) : undefined,
  });
  return NextResponse.json({ success: true, data: { role: context.role, ...result } });
}

export async function POST(request: NextRequest) {
  const context = await requireWorkspace(request, "ADMIN");
  if (context instanceof Response) return context;
  const parsed = productInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? "Invalid product", issues: parsed.error.issues },
      { status: 400 }
    );
  }
  const result = await createProduct(context.workspaceId, parsed.data);
  if (!result.ok) {
    const failure = PRODUCT_ERRORS[result.error];
    return NextResponse.json(
      { success: false, code: result.error, error: failure.message, detail: result.detail ?? null },
      { status: failure.status }
    );
  }
  return NextResponse.json({ success: true, data: { product: result.product } }, { status: 201 });
}
