/**
 * Download a customer's photo (a temporary Messenger CDN link) so the bot
 * can recognise the product. Same safety as downloadAudio: https only (also
 * for every redirect), one deadline, a size cap, and the type read from the
 * bytes, never from the server's header.
 */
import { readIntEnv } from "../facebook/env";

export type CustomerImageMime = "image/jpeg" | "image/png" | "image/webp" | "image/heic" | "image/heif";

export type ImageDownloadErrorKind = "invalid_url" | "too_large" | "timeout" | "http" | "not_an_image" | "network";

export class ImageDownloadError extends Error {
  constructor(
    message: string,
    readonly kind: ImageDownloadErrorKind,
    readonly status?: number
  ) {
    super(message);
    this.name = "ImageDownloadError";
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** The cap on a photo's size, read on every call so a change needs no restart. */
export function getCustomerImageMaxBytes(): number {
  return readIntEnv("CUSTOMER_IMAGE_MAX_BYTES", 8 * 1024 * 1024, {
    min: 256 * 1024,
    max: 20 * 1024 * 1024,
  });
}

// ─── Format ─────────────────────────────────────────────────────────────────

const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "heim", "heis"]);
const HEIF_BRANDS = new Set(["mif1", "msf1"]);
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let text = "";
  for (let i = start; i < Math.min(end, bytes.length); i += 1) text += String.fromCharCode(bytes[i]);
  return text;
}

/** The photo format from the first bytes alone; null for anything else (GIF, SVG, HTML...). */
export function sniffCustomerImageMime(bytes: Uint8Array): CustomerImageMime | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && PNG_SIGNATURE.every((byte, i) => bytes[i] === byte)) return "image/png";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "image/webp";
  if (bytes.length >= 12 && ascii(bytes, 4, 8) === "ftyp") {
    const brand = ascii(bytes, 8, 12);
    if (HEIC_BRANDS.has(brand)) return "image/heic";
    if (HEIF_BRANDS.has(brand)) return "image/heif";
  }
  return null;
}

// ─── Download ───────────────────────────────────────────────────────────────

/** Signed CDN URLs carry secrets in the query: only the host is ever named in an error. */
function httpsUrl(value: string, base?: URL): URL {
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    throw new ImageDownloadError("The image URL is not a valid URL", "invalid_url");
  }
  if (url.protocol !== "https:") {
    throw new ImageDownloadError(`The image URL must use https, not ${url.protocol.slice(0, -1)}`, "invalid_url");
  }
  return url;
}

/** Why a request failed, with any URL the library quoted removed. */
function networkReason(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  const clean = text.replace(/\bhttps?:\/\/\S+/gi, "<url>").slice(0, 200);
  return typeof code === "string" ? `${clean} [${code}]` : clean;
}

async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

/** GET with redirects followed by hand, so every hop is checked for https. */
async function fetchFollowingRedirects(
  first: URL,
  fetchImpl: typeof fetch,
  signal: AbortSignal
): Promise<{ response: Response; host: string }> {
  let url = first;
  for (let redirects = 0; ; redirects += 1) {
    let response: Response;
    try {
      response = await fetchImpl(url.href, { redirect: "manual", signal });
    } catch (error) {
      throw new ImageDownloadError(`The image download failed (${url.hostname}): ${networkReason(error)}`, "network");
    }
    const location = REDIRECT_STATUSES.has(response.status) ? response.headers.get("location") : null;
    if (!location) return { response, host: url.hostname };
    await discard(response);
    if (redirects >= MAX_REDIRECTS) {
      throw new ImageDownloadError(
        `The image download redirected more than ${MAX_REDIRECTS} times (${first.hostname})`,
        "http",
        response.status
      );
    }
    url = httpsUrl(location, url);
  }
}

export async function downloadCustomerImage(
  url: string,
  options: { timeoutMs?: number; maxBytes?: number; fetchImpl?: typeof fetch } = {}
): Promise<{ bytes: Buffer; mimeType: CustomerImageMime; size: number }> {
  const first = httpsUrl(url);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? getCustomerImageMaxBytes();
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  // One deadline for headers and body: a CDN that stalls mid-body must not hold the worker.
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new ImageDownloadError(`The image download took more than ${timeoutMs} ms (${first.hostname})`, "timeout"));
      controller.abort();
      void reader?.cancel().catch(() => undefined);
    }, timeoutMs);
  });
  // The race attaches its own handlers; this keeps a late rejection from being unhandled.
  deadline.catch(() => undefined);

  const download = async () => {
    const { response, host } = await fetchFollowingRedirects(first, fetchImpl, controller.signal);
    if (!response.ok) {
      await discard(response);
      throw new ImageDownloadError(`The image download failed (${host}): HTTP ${response.status}`, "http", response.status);
    }
    const declared = response.headers.get("content-length");
    if (declared !== null && Number(declared) > maxBytes) {
      await discard(response);
      throw new ImageDownloadError(`The image is ${declared} bytes, over the limit of ${maxBytes}`, "too_large");
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    if (response.body) {
      reader = response.body.getReader();
      for (;;) {
        let next: ReadableStreamReadResult<Uint8Array>;
        try {
          next = await reader.read();
        } catch (error) {
          throw new ImageDownloadError(`The image download failed (${host}): ${networkReason(error)}`, "network");
        }
        if (next.done) break;
        total += next.value.byteLength;
        if (total > maxBytes) {
          // No or a lying content-length: stop now, the rest is never downloaded.
          await reader.cancel().catch(() => undefined);
          throw new ImageDownloadError(`The image is over the limit of ${maxBytes} bytes`, "too_large");
        }
        chunks.push(next.value);
      }
    }
    const bytes = Buffer.concat(chunks, total);
    const mimeType = sniffCustomerImageMime(bytes);
    if (!mimeType) throw new ImageDownloadError(`The download is not a supported photo (${host})`, "not_an_image");
    return { bytes, mimeType, size: total };
  };

  try {
    return await Promise.race([download(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
