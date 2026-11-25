import { NextResponse, type NextRequest } from "next/server";
import { jsonError, requireWorkspace } from "@/lib/agency/http";
import { getProductImageMaxBytes, storeProductImage, type StoreImageError } from "@/lib/catalog/images";
import type { FbStaticKey } from "@/lib/facebook/i18n";

export const dynamic = "force-dynamic";

const ERRORS: Record<StoreImageError, FbStaticKey> = {
  empty: "The file is empty.",
  too_large: "The image is too large.",
  not_an_image: "Only JPEG, PNG and WebP images are accepted.",
  unknown_product: "Product not found.",
  too_many: "This brand has reached the number of images it can hold.",
};

/** Room for the multipart boundaries, headers and the productId field. */
const MULTIPART_OVERHEAD = 64 * 1024;

/** The body, `max` bytes at most: null beyond, without reading the rest. */
async function readCapped(request: NextRequest, max: number): Promise<Uint8Array | null> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function tooLarge() {
  return NextResponse.json({ success: false, code: "too_large", error: ERRORS.too_large }, { status: 413 });
}

/**
 * Upload one image (multipart: `file`, optional `productId`). The type is
 * read from the bytes, not from the name or the browser's word for it.
 */
export async function POST(request: NextRequest) {
  const context = await requireWorkspace(request, "ADMIN");
  if (context instanceof Response) return context;
  const max = getProductImageMaxBytes();
  // Refused before reading when the declared size is already too much, and
  // never read past the limit when it is not declared (a chunked body).
  if (Number(request.headers.get("content-length") ?? 0) > max + MULTIPART_OVERHEAD) return tooLarge();
  const body = await readCapped(request, max + MULTIPART_OVERHEAD);
  if (!body) return tooLarge();
  const form = await new Response(body as Uint8Array<ArrayBuffer>, {
    headers: { "Content-Type": request.headers.get("content-type") ?? "" },
  })
    .formData()
    .catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return jsonError(400, "Send the image as the multipart field \"file\".");
  if (file.size > max) return tooLarge();
  const productId = form?.get("productId");
  const result = await storeProductImage(context.workspaceId, {
    bytes: Buffer.from(await file.arrayBuffer()),
    fileName: file.name,
    productId: typeof productId === "string" && productId ? productId : null,
  });
  if (!result.ok) {
    const status = result.error === "too_large" ? 413 : result.error === "unknown_product" ? 404 : 400;
    return NextResponse.json({ success: false, code: result.error, error: ERRORS[result.error] }, { status });
  }
  return NextResponse.json({ success: true, data: { image: result.image } }, { status: 201 });
}
