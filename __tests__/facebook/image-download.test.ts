/** Downloading a customer's photo: the format from the bytes, redirects, caps, deadline. fetch is mocked. */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  downloadCustomerImage,
  getCustomerImageMaxBytes,
  ImageDownloadError,
  sniffCustomerImageMime,
} from "../../lib/ai/image-download";

const KIB = 1024;
const URL_SIGNED = "https://scontent.xx.fbcdn.net/v/t1/photo.jpg?_nc_sig=SECRET123&oh=TOKEN456";

function sample(head: number[] | string, size = 64): Buffer {
  const start = typeof head === "string" ? Buffer.from(head, "latin1") : Buffer.from(head);
  return Buffer.concat([start, Buffer.alloc(Math.max(0, size - start.length), 0x11)]);
}

/** ISO BMFF: a size, "ftyp", then the major brand. */
function ftyp(brand: string): Buffer {
  return Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftyp" + brand, "latin1"), Buffer.alloc(32, 0)]);
}

const JPEG = sample([0xff, 0xd8, 0xff, 0xe0]);
const PNG = sample([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x40, 0, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.alloc(40)]);

function bodyOf(parts: Uint8Array[], onCancel?: () => void): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < parts.length) controller.enqueue(parts[i++]);
      else controller.close();
    },
    cancel() {
      onCancel?.();
    },
  });
}

function ok(bytes: Uint8Array, headers: Record<string, string> = {}): Response {
  return new Response(bytes as BodyInit, { status: 200, headers });
}

function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

function fetchOf(...responses: Array<Response | Error>) {
  return vi.fn<typeof fetch>(async () => {
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra fetch");
    if (next instanceof Error) throw next;
    return next;
  });
}

async function failure(promise: Promise<unknown>): Promise<ImageDownloadError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ImageDownloadError);
    return error as ImageDownloadError;
  }
  throw new Error("expected the download to fail");
}

describe("sniffCustomerImageMime", () => {
  it.each([
    ["jpeg", JPEG, "image/jpeg"],
    ["png", PNG, "image/png"],
    ["webp", WEBP, "image/webp"],
    ["heic", ftyp("heic"), "image/heic"],
    ["heix", ftyp("heix"), "image/heic"],
    ["hevc", ftyp("hevc"), "image/heic"],
    ["heim", ftyp("heim"), "image/heic"],
    ["heis", ftyp("heis"), "image/heic"],
    ["mif1", ftyp("mif1"), "image/heif"],
    ["msf1", ftyp("msf1"), "image/heif"],
  ])("recognises %s", (_name, bytes, mime) => {
    expect(sniffCustomerImageMime(bytes)).toBe(mime);
  });

  it("reads a plain Uint8Array too", () => {
    expect(sniffCustomerImageMime(new Uint8Array(JPEG))).toBe("image/jpeg");
  });

  it.each([
    ["gif89", sample("GIF89a")],
    ["gif87", sample("GIF87a")],
    ["svg", sample('<svg xmlns="http://www.w3.org/2000/svg"></svg>')],
    ["xml prolog svg", sample('<?xml version="1.0"?><svg/>')],
    ["html", sample("<!doctype html><html>")],
    ["pdf", sample("%PDF-1.7")],
    ["avif brand", ftyp("avif")],
    ["mp4 brand", ftyp("isom")],
    ["empty", Buffer.alloc(0)],
    ["jpeg too short", Buffer.from([0xff, 0xd8])],
    ["jpeg near miss", sample([0xff, 0xd8, 0x00])],
    ["png near miss (last byte)", sample([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0b])],
    ["png truncated", Buffer.from([0x89, 0x50, 0x4e, 0x47])],
    ["riff wave", Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVEfmt "), Buffer.alloc(16)])],
    ["riff webp truncated", Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEB")])],
    ["ftyp truncated brand", Buffer.concat([Buffer.alloc(4), Buffer.from("ftypmi")])],
  ])("refuses %s", (_name, bytes) => {
    expect(sniffCustomerImageMime(bytes)).toBeNull();
  });
});

describe("getCustomerImageMaxBytes", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("defaults to 8 MiB", () => {
    vi.stubEnv("CUSTOMER_IMAGE_MAX_BYTES", "");
    expect(getCustomerImageMaxBytes()).toBe(8 * 1024 * KIB);
  });

  it("reads the env on every call", () => {
    vi.stubEnv("CUSTOMER_IMAGE_MAX_BYTES", String(1024 * KIB));
    expect(getCustomerImageMaxBytes()).toBe(1024 * KIB);
    vi.stubEnv("CUSTOMER_IMAGE_MAX_BYTES", String(2048 * KIB));
    expect(getCustomerImageMaxBytes()).toBe(2048 * KIB);
  });

  it("clamps to [256 KiB, 20 MiB]", () => {
    vi.stubEnv("CUSTOMER_IMAGE_MAX_BYTES", "10");
    expect(getCustomerImageMaxBytes()).toBe(256 * KIB);
    vi.stubEnv("CUSTOMER_IMAGE_MAX_BYTES", String(500 * 1024 * KIB));
    expect(getCustomerImageMaxBytes()).toBe(20 * 1024 * KIB);
  });

  it("falls back on garbage", () => {
    vi.stubEnv("CUSTOMER_IMAGE_MAX_BYTES", "lots");
    expect(getCustomerImageMaxBytes()).toBe(8 * 1024 * KIB);
  });
});

describe("downloadCustomerImage", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("returns the bytes, the sniffed type and the size", async () => {
    const fetchImpl = fetchOf(ok(PNG));
    const result = await downloadCustomerImage(URL_SIGNED, { fetchImpl });
    expect(result.mimeType).toBe("image/png");
    expect(result.size).toBe(PNG.length);
    expect(result.bytes.equals(PNG)).toBe(true);
    expect(fetchImpl.mock.calls[0][0]).toBe(URL_SIGNED);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
  });

  it("trusts the bytes, not the header", async () => {
    const result = await downloadCustomerImage(URL_SIGNED, {
      fetchImpl: fetchOf(ok(JPEG, { "content-type": "image/gif" })),
    });
    expect(result.mimeType).toBe("image/jpeg");
    const html = await failure(
      downloadCustomerImage(URL_SIGNED, {
        fetchImpl: fetchOf(ok(sample("<html>"), { "content-type": "image/jpeg" })),
      })
    );
    expect(html.kind).toBe("not_an_image");
  });

  it("refuses a GIF and an empty body as not_an_image", async () => {
    expect((await failure(downloadCustomerImage(URL_SIGNED, { fetchImpl: fetchOf(ok(sample("GIF89a"))) }))).kind).toBe(
      "not_an_image"
    );
    expect(
      (await failure(downloadCustomerImage(URL_SIGNED, { fetchImpl: fetchOf(new Response(null, { status: 200 })) }))).kind
    ).toBe("not_an_image");
  });

  it.each(["http://cdn.example.com/a.jpg", "ftp://cdn.example.com/a.jpg", "not a url", ""])(
    "refuses %j before any request",
    async (bad) => {
      const fetchImpl = fetchOf();
      expect((await failure(downloadCustomerImage(bad, { fetchImpl }))).kind).toBe("invalid_url");
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  );

  describe("redirects", () => {
    it("follows https to https, resolving a relative Location", async () => {
      const fetchImpl = fetchOf(redirect("https://cdn2.example.com/p.jpg?sig=X"), redirect("/other.jpg", 301), ok(JPEG));
      const result = await downloadCustomerImage(URL_SIGNED, { fetchImpl });
      expect(result.mimeType).toBe("image/jpeg");
      expect(fetchImpl.mock.calls.map((c) => c[0])).toEqual([
        URL_SIGNED,
        "https://cdn2.example.com/p.jpg?sig=X",
        "https://cdn2.example.com/other.jpg",
      ]);
    });

    it("refuses a redirect to http without requesting it", async () => {
      const fetchImpl = fetchOf(redirect("http://evil.example.com/a.jpg?sig=Z"), ok(JPEG));
      const error = await failure(downloadCustomerImage(URL_SIGNED, { fetchImpl }));
      expect(error.kind).toBe("invalid_url");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("cuts a loop after 3 redirects", async () => {
      const fetchImpl = fetchOf(
        redirect("https://a.example.com/1"),
        redirect("https://a.example.com/2"),
        redirect("https://a.example.com/3"),
        redirect("https://a.example.com/4"),
        ok(JPEG)
      );
      const error = await failure(downloadCustomerImage(URL_SIGNED, { fetchImpl }));
      expect(error.kind).toBe("http");
      expect(error.status).toBe(302);
      expect(fetchImpl).toHaveBeenCalledTimes(4);
    });

    it("allows exactly 3 redirects", async () => {
      const fetchImpl = fetchOf(
        redirect("https://a.example.com/1"),
        redirect("https://a.example.com/2"),
        redirect("https://a.example.com/3"),
        ok(JPEG)
      );
      expect((await downloadCustomerImage(URL_SIGNED, { fetchImpl })).mimeType).toBe("image/jpeg");
    });

    it("treats a redirect without Location as an HTTP error", async () => {
      const error = await failure(
        downloadCustomerImage(URL_SIGNED, { fetchImpl: fetchOf(new Response(null, { status: 302 })) })
      );
      expect(error).toMatchObject({ kind: "http", status: 302 });
    });
  });

  describe("size cap", () => {
    it("refuses a declared Content-Length over the cap without reading the body", async () => {
      const onCancel = vi.fn();
      const response = new Response(bodyOf([JPEG], onCancel), {
        status: 200,
        headers: { "content-length": String(300 * KIB) },
      });
      const error = await failure(downloadCustomerImage(URL_SIGNED, { fetchImpl: fetchOf(response), maxBytes: 256 * KIB }));
      expect(error.kind).toBe("too_large");
      expect(onCancel).toHaveBeenCalled();
    });

    it("accepts a body exactly at the cap", async () => {
      const bytes = sample([0xff, 0xd8, 0xff], 1000);
      const result = await downloadCustomerImage(URL_SIGNED, { fetchImpl: fetchOf(ok(bytes)), maxBytes: 1000 });
      expect(result.size).toBe(1000);
    });

    it("stops a stream past the cap when the header is missing or lies", async () => {
      const pulled = vi.fn();
      const onCancel = vi.fn();
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled();
          sent += 1;
          controller.enqueue(sent === 1 ? sample([0xff, 0xd8, 0xff], 600) : new Uint8Array(600));
        },
        cancel: onCancel,
      });
      const response = new Response(body, { status: 200, headers: { "content-length": "10" } });
      const error = await failure(downloadCustomerImage(URL_SIGNED, { fetchImpl: fetchOf(response), maxBytes: 1000 }));
      expect(error.kind).toBe("too_large");
      expect(onCancel).toHaveBeenCalled();
      expect(pulled.mock.calls.length).toBeLessThan(5);
    });

    it("uses the env cap by default", async () => {
      vi.stubEnv("CUSTOMER_IMAGE_MAX_BYTES", String(256 * KIB));
      const big = sample([0xff, 0xd8, 0xff], 257 * KIB);
      expect((await failure(downloadCustomerImage(URL_SIGNED, { fetchImpl: fetchOf(ok(big)) }))).kind).toBe("too_large");
    });
  });

  describe("HTTP and network errors", () => {
    it.each([403, 404, 410, 500])("reports HTTP %i with its status", async (status) => {
      const error = await failure(
        downloadCustomerImage(URL_SIGNED, { fetchImpl: fetchOf(new Response("no", { status })) })
      );
      expect(error).toMatchObject({ kind: "http", status });
    });

    it("maps a rejected fetch to network", async () => {
      const cause = Object.assign(new Error("connect"), { code: "ECONNRESET" });
      const error = await failure(
        downloadCustomerImage(URL_SIGNED, { fetchImpl: fetchOf(new TypeError("fetch failed", { cause })) })
      );
      expect(error.kind).toBe("network");
      expect(error.message).toContain("ECONNRESET");
    });

    it("maps a body that errors mid-stream to network", async () => {
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(new Error("socket hang up"));
        },
      });
      const error = await failure(
        downloadCustomerImage(URL_SIGNED, { fetchImpl: fetchOf(new Response(body, { status: 200 })) })
      );
      expect(error.kind).toBe("network");
    });
  });

  describe("deadline", () => {
    it("times out when the headers never come, and aborts the request", async () => {
      vi.useFakeTimers();
      let signal: AbortSignal | undefined;
      const fetchImpl = vi.fn(
        (_url: Parameters<typeof fetch>[0], init?: RequestInit) =>
          new Promise<Response>((_, reject) => {
            signal = init?.signal ?? undefined;
            signal?.addEventListener("abort", () => reject(new Error("aborted")));
          })
      ) as unknown as typeof fetch;
      const promise = failure(downloadCustomerImage(URL_SIGNED, { fetchImpl, timeoutMs: 5000 }));
      await vi.advanceTimersByTimeAsync(5000);
      const error = await promise;
      expect(error.kind).toBe("timeout");
      expect(signal?.aborted).toBe(true);
    });

    it("times out when the body stalls after the headers", async () => {
      vi.useFakeTimers();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(JPEG);
        },
      });
      const fetchImpl = fetchOf(new Response(body, { status: 200 }));
      const promise = failure(downloadCustomerImage(URL_SIGNED, { fetchImpl, timeoutMs: 15_000 }));
      await vi.advanceTimersByTimeAsync(15_000);
      expect((await promise).kind).toBe("timeout");
    });

    it("does not time out a fast download", async () => {
      vi.useFakeTimers();
      const result = await downloadCustomerImage(URL_SIGNED, { fetchImpl: fetchOf(ok(JPEG)), timeoutMs: 1000 });
      expect(result.mimeType).toBe("image/jpeg");
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("error messages", () => {
    it("never include the query string, in any kind", async () => {
      const cases: Array<Response | Error> = [
        new Response("no", { status: 403 }),
        ok(sample("GIF89a")),
        redirect("http://evil.example.com/a.jpg?sig=SECRET123"),
        new TypeError(`fetch failed for ${URL_SIGNED}`),
        new Response(null, { status: 200, headers: { "content-length": String(30 * 1024 * KIB) } }),
      ];
      for (const next of cases) {
        const error = await failure(downloadCustomerImage(URL_SIGNED, { fetchImpl: fetchOf(next), maxBytes: 256 * KIB }));
        expect(error.message).not.toMatch(/SECRET123|TOKEN456|_nc_sig|oh=|\?/);
        expect(error.message).not.toContain("photo.jpg");
      }
    });

    it("hides the query of an invalid URL and of a redirect loop", async () => {
      const bad = await failure(downloadCustomerImage("http://x.example.com/a?token=SECRET123"));
      expect(bad.message).not.toContain("SECRET123");
      const hop = (n: number) => redirect(`https://a.example.com/${n}?sig=SECRET123`);
      const loop = await failure(
        downloadCustomerImage(URL_SIGNED, { fetchImpl: fetchOf(hop(1), hop(2), hop(3), hop(4)) })
      );
      expect(loop.message).not.toContain("SECRET123");
      expect(loop.message).toContain("scontent.xx.fbcdn.net");
    });
  });
});
