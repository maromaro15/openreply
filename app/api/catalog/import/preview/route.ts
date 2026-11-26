import { NextResponse, type NextRequest } from "next/server";
import { requireWorkspace } from "@/lib/agency/http";
import { IMPORT_ERRORS, previewImport, readImportRequest } from "@/lib/catalog/import/apply";

export const dynamic = "force-dynamic";

/**
 * What a file would do, without writing anything. Multipart: `file` (the
 * spreadsheet) and, optionally, `images` (a JSON list of { name, size } of the
 * pictures the person picked: only their names travel here).
 */
export async function POST(request: NextRequest) {
  const context = await requireWorkspace(request, "MEMBER");
  if (context instanceof Response) return context;
  const read = await readImportRequest(request, true);
  if ("error" in read) {
    const failure = IMPORT_ERRORS[read.error];
    return NextResponse.json({ success: false, code: read.error, error: failure.message }, { status: failure.status });
  }
  const preview = await previewImport(context.workspaceId, read.sheets, read.pictures);
  return NextResponse.json({ success: true, data: { role: context.role, ...preview } });
}
