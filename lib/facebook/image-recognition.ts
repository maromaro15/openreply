/**
 * A customer's photo, read in its own job (PLAN.md 6.13): downloaded at once
 * (Messenger's links are temporary), the codes written on it looked up in
 * the brand's catalog, and, when it shows none, matched against the
 * pictures of the closest products. The result is kept on the message; the
 * bot waits for it, then answers, asks which product, or hands off.
 *
 * The photo itself is never stored.
 */
import type { Job } from "bullmq";
import { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { getGoogleApiKey } from "@/lib/ai/env";
import { GeminiError } from "@/lib/ai/gemini";
import { downloadCustomerImage, ImageDownloadError } from "@/lib/ai/image-download";
import { getImageMatchMaxCandidates, matchProductImage, readImageCodes, type ImageInput } from "@/lib/ai/vision";
import { findByCodeKey } from "@/lib/catalog/products";
import {
  pickCandidates,
  recognitionFromImageMatch,
  recognizeFromCodes,
  type Recognition,
} from "@/lib/catalog/recognize";
import { FB_RECOGNIZE_JOB, getFacebookQueue, recognizeJobId, type FacebookRecognizeJob } from "./queue";

export const IMAGE = "image";
const RECOGNIZE_ATTEMPTS = 3;

export type ImageAnalysis =
  | { status: "PENDING" }
  | { status: "DONE"; recognition: Recognition }
  | { status: "FAILED"; error: string };

/** The stored JSON, read tolerantly: anything unknown is no analysis. */
export function parseImageAnalysis(value: unknown): ImageAnalysis | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { status, recognition, error } = value as Record<string, unknown>;
  if (status === "PENDING") return { status };
  if (status === "FAILED") return { status, error: typeof error === "string" ? error : "" };
  if (status === "DONE" && recognition && typeof recognition === "object" && "kind" in recognition) {
    return { status, recognition: recognition as Recognition };
  }
  return null;
}

/** Products a recognised photo points at, for the bot's full cards. */
export function recognizedProductIds(analysis: ImageAnalysis | null): string[] {
  if (analysis?.status !== "DONE") return [];
  const { recognition } = analysis;
  if (recognition.kind === "match" || recognition.kind === "unsure") return [recognition.productId];
  if (recognition.kind === "ambiguous") return recognition.options.map((option) => option.productId);
  return [];
}

/** Safe to call twice: the job ID is the message's. */
export async function queueImageRecognition(messageId: string): Promise<void> {
  await getFacebookQueue().add(
    FB_RECOGNIZE_JOB,
    { messageId },
    { jobId: recognizeJobId(messageId), attempts: RECOGNIZE_ATTEMPTS, backoff: { type: "exponential", delay: 15_000 } }
  );
}

/**
 * What the photo shows, within one brand's catalog: its written codes first
 * (an exact match only), then the closest products' pictures.
 */
export async function recognizeImage(workspaceId: string, image: ImageInput): Promise<Recognition> {
  const reading = await readImageCodes(image);
  const byCode = await recognizeFromCodes(reading.codes, (key) => findByCodeKey(workspaceId, key));
  if (byCode) return byCode;

  const products = await prisma.product.findMany({
    where: { workspaceId, status: "ACTIVE", mainImageId: { not: null } },
    select: { id: true, name: true, code: true, description: true },
    take: 2000,
  });
  const chosen = pickCandidates(
    reading.description,
    products.map((product) => ({
      id: product.id,
      text: [product.name, product.code ?? "", product.description ?? ""].join(" "),
    })),
    getImageMatchMaxCandidates()
  );
  if (chosen.length === 0) return { kind: "none", codes: reading.codes, description: reading.description };

  // Only the chosen products' pictures are read from the database.
  const rows = await prisma.product.findMany({
    where: { workspaceId, id: { in: chosen } },
    select: { id: true, name: true, mainImage: { select: { data: true, mimeType: true } } },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const candidates = chosen.flatMap((id) => {
    const row = byId.get(id);
    if (!row?.mainImage) return [];
    const data = row.mainImage.data;
    return [
      {
        id,
        label: row.name,
        image: { bytes: Buffer.from(data.buffer, data.byteOffset, data.byteLength), mimeType: row.mainImage.mimeType },
      },
    ];
  });
  const match = await matchProductImage(image, candidates);
  return recognitionFromImageMatch(
    match,
    candidates.map((candidate) => ({ id: candidate.id, name: candidate.label })),
    reading
  );
}

/** Gemini errors worth another try later. */
function retryable(error: GeminiError): boolean {
  return error.kind === "rate_limited" || error.kind === "unavailable" || error.kind === "network";
}

export async function processRecognizeJob(job: Job<FacebookRecognizeJob>): Promise<"recognized" | "failed" | "skipped"> {
  const message = await prisma.facebookMessage.findUnique({
    where: { id: job.data.messageId },
    select: { id: true, workspaceId: true, attachmentType: true, attachmentUrl: true, imageAnalysis: true },
  });
  if (!message || message.attachmentType !== IMAGE || parseImageAnalysis(message.imageAnalysis)?.status !== "PENDING") {
    return "skipped";
  }

  // Written only over PENDING: a retry never undoes a result.
  const save = async (analysis: ImageAnalysis) => {
    await prisma.facebookMessage.updateMany({
      where: { id: message.id, imageAnalysis: { path: ["status"], equals: "PENDING" } },
      data: { imageAnalysis: analysis as unknown as Prisma.InputJsonValue },
    });
  };
  const fail = async (error: string) => {
    await save({ status: "FAILED", error });
    return "failed" as const;
  };

  if (!getGoogleApiKey()) return fail("The AI service is not configured (GOOGLE_API_KEY).");
  if (!message.attachmentUrl) return fail("The photo came without a link.");

  let image: ImageInput;
  try {
    const downloaded = await downloadCustomerImage(message.attachmentUrl);
    image = { bytes: downloaded.bytes, mimeType: downloaded.mimeType };
  } catch (error) {
    if (error instanceof ImageDownloadError) return fail(error.message);
    throw error;
  }

  try {
    await save({ status: "DONE", recognition: await recognizeImage(message.workspaceId, image) });
    return "recognized";
  } catch (error) {
    if (!(error instanceof GeminiError)) throw error;
    // A busy or unreachable service: BullMQ tries again, then it is a failure.
    if (retryable(error) && job.attemptsMade + 1 < (job.opts.attempts ?? 1)) throw error;
    return fail(`The AI service could not read the photo (${error.kind}).`);
  }
}
