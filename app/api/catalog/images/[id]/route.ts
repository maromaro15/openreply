import { NextResponse, type NextRequest } from "next/server";
import { jsonError, requireWorkspace } from "@/lib/agency/http";
import { deleteProductImage } from "@/lib/catalog/images";

type RouteProps = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

/** The colours and cards that used it lose their picture; its public link stops working. */
export async function DELETE(request: NextRequest, { params }: RouteProps) {
  const context = await requireWorkspace(request, "ADMIN");
  if (context instanceof Response) return context;
  if (!(await deleteProductImage(context.workspaceId, (await params).id))) return jsonError(404, "Image not found.");
  return NextResponse.json({ success: true });
}
