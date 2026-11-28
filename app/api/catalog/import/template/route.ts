import { NextResponse, type NextRequest } from "next/server";
import { requireWorkspace } from "@/lib/agency/http";
import { buildBrandTemplate } from "@/lib/catalog/import/apply";

export const dynamic = "force-dynamic";

/** The import file made for this brand's attributes: `?format=xlsx` (default) or `csv`. */
export async function GET(request: NextRequest) {
  const context = await requireWorkspace(request, "MEMBER");
  if (context instanceof Response) return context;
  const format = request.nextUrl.searchParams.get("format") === "csv" ? "csv" : "xlsx";
  const file = await buildBrandTemplate(context.workspaceId, format);
  return new NextResponse(new Uint8Array(file.bytes), {
    headers: {
      "Content-Type": file.contentType,
      "Content-Disposition": `attachment; filename="${file.fileName}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
