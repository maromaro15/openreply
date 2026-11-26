import { NextResponse, type NextRequest } from "next/server";
import { requireWorkspace } from "@/lib/agency/http";
import { applyImport, IMPORT_ERRORS, readImportRequest } from "@/lib/catalog/import/apply";

export const dynamic = "force-dynamic";

/**
 * Confirm: multipart `file`. The file is read and checked again here; the
 * preview the browser holds is never sent back. Creates or updates the cards
 * by code; the pictures are uploaded afterwards, one by one (./images).
 */
export async function POST(request: NextRequest) {
  const context = await requireWorkspace(request, "ADMIN");
  if (context instanceof Response) return context;
  const read = await readImportRequest(request, false);
  if ("error" in read) {
    const failure = IMPORT_ERRORS[read.error];
    return NextResponse.json({ success: false, code: read.error, error: failure.message }, { status: failure.status });
  }
  const outcome = await applyImport(context.workspaceId, read.sheets);
  return NextResponse.json({ success: true, data: outcome });
}
