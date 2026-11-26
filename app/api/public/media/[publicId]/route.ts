import type { NextRequest } from "next/server";
import { readPublicImage, readPublicImageMeta } from "@/lib/catalog/images";

type RouteProps = { params: Promise<{ publicId: string }> };

export const dynamic = "force-dynamic";

/**
 * A product image, for Messenger: it fetches the pictures of the colour
 * cards and carousels itself, so this route takes no session. The random
 * 32-character id is all it answers to; an image cannot be listed or
 * guessed, and nothing else of the brand is reachable from here.
 */
export async function GET(request: NextRequest, { params }: RouteProps) {
  const { publicId } = await params;
  // The metadata first: a revalidation never loads the bytes.
  const meta = await readPublicImageMeta(publicId);
  if (!meta) return notFound();

  const etag = `"${meta.sha256}"`;
  const headers = {
    "Content-Type": meta.mimeType,
    // The bytes behind an id never change, but a deleted image must stop
    // being served: a day, then a cheap revalidation by the ETag.
    "Cache-Control": "public, max-age=86400",
    ETag: etag,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cross-Origin-Resource-Policy": "cross-origin",
  };
  if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });

  const image = await readPublicImage(publicId);
  if (!image) return notFound();
  // A view over the same memory, not a copy of an image of up to 15 MiB.
  const body = new Uint8Array(image.data.buffer as ArrayBuffer, image.data.byteOffset, image.data.byteLength);
  return new Response(body, {
    status: 200,
    // The type and tag of the bytes just read, which the bytes decide.
    headers: { ...headers, "Content-Type": image.mimeType, ETag: `"${image.sha256}"`, "Content-Length": String(image.size) },
  });
}

function notFound() {
  return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
}
