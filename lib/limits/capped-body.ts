/**
 * Reading a request body without trusting its size. `request.arrayBuffer()`
 * buffers whatever arrives; a public route must cut it first.
 */

/** Meta's deliveries are a few KB; 1 MiB leaves ample room for a batch. */
export const FACEBOOK_WEBHOOK_MAX_BYTES = 1024 * 1024;

/**
 * The body, `max` bytes at most: null beyond. A declared content-length
 * above the cap is refused before reading, and a chunked body with none is
 * cut as soon as it crosses the cap, so the rest is never buffered.
 */
export async function readCappedBody(request: Request, max: number): Promise<Uint8Array | null> {
  if (Number(request.headers.get("content-length") ?? 0) > max) return null;
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
