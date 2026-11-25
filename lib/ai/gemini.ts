/**
 * Gemini, over its REST API with fetch: no SDK to install or keep in step.
 *
 * The key travels in the x-goog-api-key header, never in the URL, so it
 * cannot end up in a log line. Errors are sorted into kinds the callers act
 * on: the bot hands the conversation to a person, transcription marks the
 * voice message as failed.
 */
import { getGeminiTemperature, getGoogleApiKey } from "./env";

export const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_TIMEOUT_MS = 25_000;
const RETRY_DELAYS_MS = [1_500, 4_000];
const MAX_RETRY_AFTER_MS = 10_000;

export type GeminiErrorKind =
  /** GOOGLE_API_KEY is not set. */
  | "missing_key"
  /** The key is wrong, disabled or not allowed to use the model. */
  | "auth"
  /** Quota or rate limit (429). */
  | "rate_limited"
  /** 5xx, or no answer in time. */
  | "unavailable"
  /** The request never reached Google. */
  | "network"
  /** Safety filters stopped the prompt or the answer. */
  | "blocked"
  /** Google refused the request itself (unknown model, bad field...). */
  | "bad_request"
  /** An answer that cannot be used: empty, cut off, not the JSON asked for. */
  | "invalid_response";

export class GeminiError extends Error {
  constructor(
    message: string,
    readonly kind: GeminiErrorKind,
    readonly httpStatus?: number,
    readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = "GeminiError";
  }

  get retryable(): boolean {
    return this.kind === "rate_limited" || this.kind === "unavailable" || this.kind === "network";
  }
}

export interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

export interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

export interface GenerateOptions {
  model: string;
  contents: GeminiContent[];
  systemInstruction?: string;
  /** Asks for JSON matching this schema (OpenAPI subset, as the API takes it). */
  responseSchema?: Record<string, unknown>;
  temperature?: number;
  timeoutMs?: number;
  /** Tries in all, for errors worth retrying. */
  maxAttempts?: number;
  apiKey?: string | null;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface GenerateResult {
  text: string;
  finishReason: string | null;
  usage: { promptTokens?: number; outputTokens?: number } | null;
}

const BLOCKED_FINISH = new Set([
  "SAFETY",
  "RECITATION",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "IMAGE_SAFETY",
  "LANGUAGE",
]);

type ApiError = {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: { "@type"?: string; reason?: string; retryDelay?: string }[];
  };
};

/** "12s" or "1.5s" (google.rpc.RetryInfo) in milliseconds. */
function parseRetryDelay(value: string | undefined): number | undefined {
  const match = value ? /^(\d+(?:\.\d+)?)s$/.exec(value) : null;
  return match ? Math.round(Number(match[1]) * 1000) : undefined;
}

export function classifyGeminiHttpError(status: number, payload: ApiError | null): GeminiError {
  const details = payload?.error?.details ?? [];
  const message = payload?.error?.message ?? `Gemini answered HTTP ${status}`;
  if (status === 429) {
    const retry = details.find((detail) => detail["@type"]?.endsWith("RetryInfo"))?.retryDelay;
    return new GeminiError(message, "rate_limited", status, parseRetryDelay(retry));
  }
  if (status >= 500) return new GeminiError(message, "unavailable", status);
  const keyProblem = details.some((detail) => /API_KEY/.test(detail.reason ?? ""));
  if (status === 401 || status === 403 || keyProblem) return new GeminiError(message, "auth", status);
  return new GeminiError(message, "bad_request", status);
}

function readResult(payload: unknown): GenerateResult {
  const body = payload as {
    promptFeedback?: { blockReason?: string };
    candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  } | null;
  if (body?.promptFeedback?.blockReason) {
    throw new GeminiError(`Prompt blocked: ${body.promptFeedback.blockReason}`, "blocked");
  }
  const candidate = body?.candidates?.[0];
  if (!candidate) throw new GeminiError("Gemini returned no answer", "invalid_response");
  const finishReason = candidate.finishReason ?? null;
  if (finishReason && BLOCKED_FINISH.has(finishReason)) {
    throw new GeminiError(`Answer blocked: ${finishReason}`, "blocked");
  }
  const text = (candidate.content?.parts ?? [])
    .filter((part) => typeof part.text === "string" && !part.thought)
    .map((part) => part.text)
    .join("")
    .trim();
  if (finishReason === "MAX_TOKENS") throw new GeminiError("The answer was cut off", "invalid_response");
  if (!text) throw new GeminiError("Gemini returned an empty answer", "invalid_response");
  return {
    text,
    finishReason,
    usage: body?.usageMetadata
      ? { promptTokens: body.usageMetadata.promptTokenCount, outputTokens: body.usageMetadata.candidatesTokenCount }
      : null,
  };
}

async function attempt(options: GenerateOptions, apiKey: string): Promise<GenerateResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const temperature = options.temperature ?? getGeminiTemperature();
  const generationConfig: Record<string, unknown> = {};
  if (temperature !== undefined) generationConfig.temperature = temperature;
  if (options.responseSchema) {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseSchema = options.responseSchema;
  }
  const body = {
    ...(options.systemInstruction ? { systemInstruction: { parts: [{ text: options.systemInstruction }] } } : {}),
    contents: options.contents,
    ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
  };

  let response: Response;
  try {
    response = await fetchImpl(`${GEMINI_API_BASE}/models/${encodeURIComponent(options.model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    const name = (error as { name?: string } | null)?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      throw new GeminiError("Gemini did not answer in time", "unavailable");
    }
    throw new GeminiError(error instanceof Error ? error.message : "Network error", "network");
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok) throw classifyGeminiHttpError(response.status, payload as ApiError | null);
  return readResult(payload);
}

export async function generateContent(options: GenerateOptions): Promise<GenerateResult> {
  const apiKey = options.apiKey === undefined ? getGoogleApiKey() : options.apiKey;
  if (!apiKey) throw new GeminiError("GOOGLE_API_KEY is not set", "missing_key");
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const maxAttempts = Math.max(1, options.maxAttempts ?? 2);

  for (let tries = 1; ; tries += 1) {
    try {
      return await attempt(options, apiKey);
    } catch (error) {
      if (!(error instanceof GeminiError) || !error.retryable || tries >= maxAttempts) throw error;
      const delay = Math.min(error.retryAfterMs ?? RETRY_DELAYS_MS[tries - 1] ?? 4_000, MAX_RETRY_AFTER_MS);
      await sleep(delay);
    }
  }
}

/** JSON mode: the answer parsed, or invalid_response. */
export async function generateJson(options: GenerateOptions & { responseSchema: Record<string, unknown> }): Promise<{
  data: unknown;
  result: GenerateResult;
}> {
  const result = await generateContent(options);
  const text = result.text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return { data: JSON.parse(text), result };
  } catch {
    throw new GeminiError("Gemini did not return valid JSON", "invalid_response");
  }
}
