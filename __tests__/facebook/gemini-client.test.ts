import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyGeminiHttpError,
  GEMINI_API_BASE,
  GeminiError,
  generateContent,
  generateJson,
} from "../../lib/ai/gemini";
import { getGeminiChatModel, getGeminiTemperature, getGeminiTranscribePrompt } from "../../lib/ai/env";

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function answer(text: string, finishReason = "STOP") {
  return reply({
    candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason }],
    usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 30 },
  });
}

const base = {
  model: "gemini-flash-latest",
  contents: [{ role: "user" as const, parts: [{ text: "شحال السعر؟" }] }],
  apiKey: "AIza-test-key",
};

let fetchImpl: ReturnType<typeof vi.fn>;
let sleep: ReturnType<typeof vi.fn<(ms: number) => Promise<void>>>;

beforeEach(() => {
  fetchImpl = vi.fn();
  sleep = vi.fn<(ms: number) => Promise<void>>(async () => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the request", () => {
  it("puts the key in a header, never in the URL, and asks for JSON with the schema", async () => {
    fetchImpl.mockResolvedValue(answer('{"handoff":false}'));
    const schema = { type: "OBJECT", properties: { handoff: { type: "BOOLEAN" } } };
    await generateContent({
      ...base,
      systemInstruction: "RULES",
      responseSchema: schema,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${GEMINI_API_BASE}/models/gemini-flash-latest:generateContent`);
    expect(url).not.toContain("AIza");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("AIza-test-key");
    expect(JSON.parse(init.body as string)).toEqual({
      systemInstruction: { parts: [{ text: "RULES" }] },
      contents: base.contents,
      generationConfig: { responseMimeType: "application/json", responseSchema: schema },
    });
  });

  it("leaves the temperature to the model unless GEMINI_TEMPERATURE is set", async () => {
    fetchImpl.mockImplementation(async () => answer("ok"));
    await generateContent({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string)).not.toHaveProperty("generationConfig");

    vi.stubEnv("GEMINI_TEMPERATURE", "0.3");
    await generateContent({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(JSON.parse((fetchImpl.mock.calls[1][1] as RequestInit).body as string).generationConfig).toEqual({
      temperature: 0.3,
    });
    vi.stubEnv("GEMINI_TEMPERATURE", "hot");
    expect(getGeminiTemperature()).toBeUndefined();
  });

  it("reads its settings from the environment", () => {
    expect(getGeminiChatModel()).toBe("gemini-flash-latest");
    vi.stubEnv("GEMINI_CHAT_MODEL", "models/gemini-2.5-flash");
    expect(getGeminiChatModel()).toBe("gemini-2.5-flash");
    expect(getGeminiTranscribePrompt()).toBe(
      "اكتب كلام هذا الشخص كما قاله، بالدارجة الجزائرية أو الفرنسية أو العربية"
    );
  });

  it("does not call Google without a key", async () => {
    vi.stubEnv("GOOGLE_API_KEY", "");
    await expect(
      generateContent({ ...base, apiKey: undefined, fetchImpl: fetchImpl as unknown as typeof fetch })
    ).rejects.toMatchObject({ kind: "missing_key" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("the answer", () => {
  it("joins the text parts and skips the model's thoughts", async () => {
    fetchImpl.mockResolvedValue(
      reply({
        candidates: [
          {
            content: { parts: [{ text: "thinking…", thought: true }, { text: '{"a":' }, { text: "1}" }] },
            finishReason: "STOP",
          },
        ],
      })
    );
    const { data, result } = await generateJson({
      ...base,
      responseSchema: { type: "OBJECT" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(data).toEqual({ a: 1 });
    expect(result.finishReason).toBe("STOP");
  });

  it("accepts JSON wrapped in a code fence", async () => {
    fetchImpl.mockResolvedValue(answer('```json\n{"handoff":true}\n```'));
    const { data } = await generateJson({ ...base, responseSchema: {}, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(data).toEqual({ handoff: true });
  });

  it.each([
    [reply({ promptFeedback: { blockReason: "SAFETY" } }), "blocked"],
    [answer("", "SAFETY"), "blocked"],
    [answer('{"reply":"…', "MAX_TOKENS"), "invalid_response"],
    [answer("   "), "invalid_response"],
    [reply({ candidates: [] }), "invalid_response"],
  ])("refuses an answer it cannot use (%#)", async (response, kind) => {
    fetchImpl.mockResolvedValue(response);
    await expect(generateContent({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toMatchObject({
      kind,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses text that is not JSON when JSON was asked for", async () => {
    fetchImpl.mockResolvedValue(answer("السعر 2500 دج"));
    await expect(
      generateJson({ ...base, responseSchema: {}, fetchImpl: fetchImpl as unknown as typeof fetch })
    ).rejects.toMatchObject({ kind: "invalid_response" });
  });
});

describe("errors and retries", () => {
  it("a wrong key is not retried", async () => {
    fetchImpl.mockResolvedValue(
      reply(
        {
          error: {
            code: 400,
            message: "API key not valid. Please pass a valid API key.",
            status: "INVALID_ARGUMENT",
            details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID" }],
          },
        },
        400
      )
    );
    await expect(generateContent({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch, sleep })).rejects.toMatchObject({
      kind: "auth",
      httpStatus: 400,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("a quota error waits for Google's retry delay (capped), then retries once", async () => {
    fetchImpl
      .mockResolvedValueOnce(
        reply(
          {
            error: {
              code: 429,
              status: "RESOURCE_EXHAUSTED",
              message: "Quota exceeded",
              details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "37s" }],
            },
          },
          429
        )
      )
      .mockResolvedValueOnce(answer("ok"));
    await expect(generateContent({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch, sleep })).resolves.toMatchObject({
      text: "ok",
    });
    expect(sleep).toHaveBeenCalledWith(10_000);
  });

  it("gives up after the second 5xx", async () => {
    fetchImpl.mockImplementation(async () => reply({ error: { code: 503, message: "overloaded" } }, 503));
    await expect(generateContent({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch, sleep })).rejects.toMatchObject({
      kind: "unavailable",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries a network failure and a timeout", async () => {
    fetchImpl
      .mockRejectedValueOnce(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }))
      .mockRejectedValueOnce(Object.assign(new Error("timed out"), { name: "TimeoutError" }));
    const error = await generateContent({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch, sleep }).catch(
      (caught) => caught
    );
    expect(error).toBeInstanceOf(GeminiError);
    expect(error.kind).toBe("unavailable");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("classifies HTTP errors", () => {
    expect(classifyGeminiHttpError(403, null).kind).toBe("auth");
    expect(classifyGeminiHttpError(404, { error: { message: "models/x is not found" } }).kind).toBe("bad_request");
    expect(classifyGeminiHttpError(500, null).retryable).toBe(true);
    expect(classifyGeminiHttpError(400, null).retryable).toBe(false);
  });
});
