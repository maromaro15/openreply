import { NextResponse, type NextRequest } from "next/server";
import { requireWorkspace } from "@/lib/agency/http";
import { attachImportImage, IMAGE_ERRORS, MULTIPART_OVERHEAD, readMultipart, type ImageErrorCode } from "@/lib/catalog/import/apply";
import { getProductImageMaxBytes } from "@/lib/catalog/images";

export const dynamic = "force-dynamic";

function refuse(code: ImageErrorCode) {
  const failure = IMAGE_ERRORS[code];
  return NextResponse.json({ success: false, code, error: failure.message }, { status: failure.status });
}

/**
 * One picture of the folder (multipart `file`, named by its code). The
 * existing upload route only attaches to a product; this one finds the card
 * or the colour by the name and makes the picture its own.
 */
export async function POST(request: NextRequest) {
  const context = await requireWorkspace(request, "ADMIN");
  if (context instanceof Response) return context;
  const max = getProductImageMaxBytes();
  const form = await readMultipart(request, max + MULTIPART_OVERHEAD);
  if (form === "too_large") return refuse("too_large");
  if (form === "invalid") return refuse("no_file");
  const file = form.get("file");
  if (!(file instanceof File)) return refuse("no_file");
  if (file.size > max) return refuse("too_large");
  const result = await attachImportImage(context.workspaceId, {
    bytes: Buffer.from(await file.arrayBuffer()),
    fileName: file.name,
  });
  if (!result.ok) return refuse(result.error);
  return NextResponse.json({ success: true, data: result.attached }, { status: result.attached.reused ? 200 : 201 });
}
