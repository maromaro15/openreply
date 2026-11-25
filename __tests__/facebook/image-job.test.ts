import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";

/**
 * The photo job (PLAN.md 6.13): download, codes, then the pictures of the
 * closest products; the result is written over PENDING only, and a failure
 * leaves the message for a person.
 */
const db = vi.hoisted(() => ({
  facebookMessage: { findUnique: vi.fn(), updateMany: vi.fn() },
  product: { findMany: vi.fn() },
}));
const io = vi.hoisted(() => ({ download: vi.fn(), read: vi.fn(), match: vi.fn(), find: vi.fn() }));

vi.mock("@/lib/db/client", () => ({ prisma: db }));
vi.mock("@/lib/ai/image-download", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/ai/image-download")>()),
  downloadCustomerImage: io.download,
}));
vi.mock("@/lib/ai/vision", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/ai/vision")>()),
  readImageCodes: io.read,
  matchProductImage: io.match,
}));
vi.mock("@/lib/catalog/products", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/catalog/products")>()),
  findByCodeKey: io.find,
}));

import { GeminiError } from "../../lib/ai/gemini";
import { ImageDownloadError } from "../../lib/ai/image-download";
import { parseImageAnalysis, processRecognizeJob, recognizedProductIds } from "../../lib/facebook/image-recognition";
import type { FacebookRecognizeJob } from "../../lib/facebook/queue";

const job = (attemptsMade = 0) =>
  ({ id: "fbi_msg_1", data: { messageId: "msg_1" }, attemptsMade, opts: { attempts: 3 } }) as unknown as Job<FacebookRecognizeJob>;
const saved = () => db.facebookMessage.updateMany.mock.calls.map(([args]) => args.data.imageAnalysis);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("GOOGLE_API_KEY", "AIza-test");
  db.facebookMessage.findUnique.mockResolvedValue({
    id: "msg_1",
    workspaceId: "ws_a",
    attachmentType: "image",
    attachmentUrl: "https://cdn.example/p.jpg?sig=secret",
    imageAnalysis: { status: "PENDING" },
  });
  db.facebookMessage.updateMany.mockResolvedValue({ count: 1 });
  io.download.mockResolvedValue({ bytes: Buffer.from([0xff, 0xd8, 0xff, 1]), mimeType: "image/jpeg", size: 4 });
  io.read.mockResolvedValue({ codes: ["WP 12"], description: "grey 3d wallpaper" });
  io.find.mockResolvedValue([{ productId: "prod_wp", name: "Papier peint 3D", variant: null }]);
  db.product.findMany.mockResolvedValue([]);
});

afterEach(() => vi.unstubAllEnvs());

describe("the photo job", () => {
  it("recognises the product by the code written on the photo, within the brand", async () => {
    await expect(processRecognizeJob(job())).resolves.toBe("recognized");
    expect(io.find).toHaveBeenCalledWith("ws_a", "WP12");
    expect(saved()[0]).toMatchObject({ status: "DONE", recognition: { kind: "match", via: "code", productId: "prod_wp" } });
    // Written over PENDING only: a retry never undoes a result.
    expect(db.facebookMessage.updateMany.mock.calls[0][0].where).toEqual({
      id: "msg_1",
      imageAnalysis: { path: ["status"], equals: "PENDING" },
    });
  });

  it("falls back to the pictures of the closest products when no code is written", async () => {
    io.read.mockResolvedValue({ codes: [], description: "grey 3d wallpaper" });
    db.product.findMany
      .mockResolvedValueOnce([
        { id: "prod_wp", name: "Papier peint 3D gris", code: "WP-12", description: null },
        { id: "prod_lp", name: "Lambris PVC", code: "LP-7", description: null },
      ])
      .mockResolvedValueOnce([
        { id: "prod_wp", name: "Papier peint 3D gris", mainImage: { data: new Uint8Array([1, 2]), mimeType: "image/png" } },
      ]);
    io.match.mockResolvedValue({ candidateId: "prod_wp", confidence: "medium" });
    await processRecognizeJob(job());
    expect(db.product.findMany.mock.calls[0][0].where).toEqual({ workspaceId: "ws_a", status: "ACTIVE", mainImageId: { not: null } });
    const [, candidates] = io.match.mock.calls[0];
    expect(candidates).toEqual([
      expect.objectContaining({ id: "prod_wp", label: "Papier peint 3D gris", image: { bytes: Buffer.from([1, 2]), mimeType: "image/png" } }),
    ]);
    expect(saved()[0]).toMatchObject({ status: "DONE", recognition: { kind: "unsure", productId: "prod_wp" } });
  });

  it("fails cleanly, for a person: no AI key, a link that cannot be read", async () => {
    vi.stubEnv("GOOGLE_API_KEY", "");
    await expect(processRecognizeJob(job())).resolves.toBe("failed");
    expect(saved()[0]).toEqual({ status: "FAILED", error: "The AI service is not configured (GOOGLE_API_KEY)." });
    expect(io.download).not.toHaveBeenCalled();

    vi.stubEnv("GOOGLE_API_KEY", "AIza-test");
    db.facebookMessage.updateMany.mockClear();
    io.download.mockRejectedValue(new ImageDownloadError("The photo is too large.", "too_large"));
    await expect(processRecognizeJob(job())).resolves.toBe("failed");
    expect(saved()[0]).toMatchObject({ status: "FAILED" });
    expect(JSON.stringify(saved()[0])).not.toContain("secret");
  });

  it("tries again while the AI service is busy, then fails", async () => {
    io.read.mockRejectedValue(new GeminiError("busy", "rate_limited", 429));
    await expect(processRecognizeJob(job(0))).rejects.toThrow("busy");
    expect(db.facebookMessage.updateMany).not.toHaveBeenCalled();
    await expect(processRecognizeJob(job(2))).resolves.toBe("failed");
    expect(saved()[0]).toEqual({ status: "FAILED", error: "The AI service could not read the photo (rate_limited)." });
  });

  it("skips what is not a photo being read", async () => {
    db.facebookMessage.findUnique.mockResolvedValue({ id: "msg_1", workspaceId: "ws_a", attachmentType: "image", attachmentUrl: "x", imageAnalysis: { status: "DONE", recognition: { kind: "none", codes: [], description: "" } } });
    await expect(processRecognizeJob(job())).resolves.toBe("skipped");
    db.facebookMessage.findUnique.mockResolvedValue(null);
    await expect(processRecognizeJob(job())).resolves.toBe("skipped");
  });
});

describe("reading a stored analysis", () => {
  it("is tolerant, and gives the products a photo points at", () => {
    expect(parseImageAnalysis({ status: "PENDING" })).toEqual({ status: "PENDING" });
    expect(parseImageAnalysis({ status: "WHAT" })).toBeNull();
    expect(parseImageAnalysis("x")).toBeNull();
    const ambiguous = parseImageAnalysis({
      status: "DONE",
      recognition: { kind: "ambiguous", codes: ["12"], options: [{ productId: "a" }, { productId: "b" }] },
    });
    expect(recognizedProductIds(ambiguous)).toEqual(["a", "b"]);
    expect(recognizedProductIds(parseImageAnalysis({ status: "FAILED", error: "x" }))).toEqual([]);
  });
});
