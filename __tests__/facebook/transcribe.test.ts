/**
 * Voice transcription: the download, the format, ffmpeg and Gemini, all
 * mocked. The tests at the end run the real ffmpeg, only where it is installed.
 */
import { spawnSync, type spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { AudioError, downloadAudio, sniffAudioMime, toMp3Mono16k } from "../../lib/ai/audio";
import { GeminiError, type generateContent } from "../../lib/ai/gemini";
import {
  cleanTranscript,
  isNoSpeech,
  MAX_INLINE_AUDIO_BYTES,
  TranscriptionError,
  transcribeAudio,
  transcribeAudioUrl,
} from "../../lib/ai/transcribe";

const PROMPT = "اكتب كلام هذا الشخص كما قاله، بالدارجة الجزائرية أو الفرنسية أو العربية";
const ARGS = ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", "-f", "mp3", "pipe:1"];
// Read before any test stubs FFMPEG_PATH.
const FFMPEG = process.env.FFMPEG_PATH?.trim() || "ffmpeg";
const ffmpegAvailable = spawnSync(FFMPEG, ["-version"], { stdio: "ignore" }).status === 0;

// ─── Samples ────────────────────────────────────────────────────────────────

/** The given first bytes, padded into a little file. */
function sample(head: string | number[], size = 256): Buffer {
  const start = typeof head === "string" ? Buffer.from(head, "latin1") : Buffer.from(head);
  return Buffer.concat([start, Buffer.alloc(Math.max(0, size - start.length), 0x55)]);
}

/** ISO BMFF boxes in the given order. */
function mp4(...types: string[]): Buffer {
  return Buffer.concat(
    types.map((type) => {
      const payload =
        type === "ftyp" ? Buffer.from("M4A \0\0\0\0M4A isom", "latin1") : Buffer.alloc(type === "mdat" ? 400 : 64, 0x22);
      const box = Buffer.alloc(8 + payload.length);
      box.writeUInt32BE(box.length, 0);
      box.write(type, 4, "latin1");
      payload.copy(box, 8);
      return box;
    })
  );
}

/** A real 16-bit PCM mono WAV: a 440 Hz tone. */
function sineWav(seconds: number, rate = 16_000): Buffer {
  const samples = Math.round(seconds * rate);
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF", 0, "latin1");
  wav.writeUInt32LE(36 + samples * 2, 4);
  wav.write("WAVE", 8, "latin1");
  wav.write("fmt ", 12, "latin1");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "latin1");
  wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    wav.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12_000), 44 + i * 2);
  }
  return wav;
}

const MP3 = sample([0xff, 0xfb, 0x90, 0x64]);
const MP3_ID3 = sample("ID3\x04\x00\x00\x00\x00\x00\x00\xff\xfb\x90\x64");
const WAV = sineWav(0.05);
const OGG = sample("OggS\x00\x02\x00\x00");
const FLAC = sample("fLaC\x00\x00\x00\x22");
const MP4 = mp4("ftyp", "moov", "mdat");
const MP4_INDEX_LAST = mp4("ftyp", "free", "mdat", "moov");
const WEBM = sample([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]);
const AAC = sample([0xff, 0xf1, 0x50, 0x80]);
/** What the fake ffmpeg writes: an ID3 tag, then MPEG frames. */
const FFMPEG_MP3 = sample("ID3\x04\x00\x00\x00\x00\x00\x00\xff\xf3\x48\xc4", 512);

/** A Buffer as a body fetch's Response takes. */
const body = (bytes: Buffer) => new Uint8Array(bytes);

// ─── Fakes ──────────────────────────────────────────────────────────────────

type FakeChild = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: Mock<(signal?: NodeJS.Signals) => boolean>;
};

function fakeChild(): FakeChild {
  const child: FakeChild = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn((signal?: NodeJS.Signals) => {
      setImmediate(() => child.emit("close", null, signal ?? "SIGTERM"));
      return true;
    }),
  });
  return child;
}

interface FfmpegRun {
  command: string;
  args: string[];
  input: Buffer;
  child: FakeChild;
}

/** A stand-in for spawn: its "ffmpeg" does `behave` once it has read all its input. */
function fakeSpawn(behave: (child: FakeChild, input: Buffer) => void) {
  const runs: FfmpegRun[] = [];
  const impl = vi.fn((command: string, args: string[]) => {
    const child = fakeChild();
    const run: FfmpegRun = { command, args, input: Buffer.alloc(0), child };
    runs.push(run);
    const chunks: Buffer[] = [];
    child.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stdin.on("end", () => {
      run.input = Buffer.concat(chunks);
      behave(child, run.input);
    });
    return child;
  });
  return { spawnImpl: impl as unknown as typeof spawn, impl, runs };
}

/** A spawn that hands out `child` as it is, for tests that drive its events. */
function spawnReturning(child: FakeChild): typeof spawn {
  return vi.fn(() => child) as unknown as typeof spawn;
}

/** ffmpeg writes `output` and exits 0. */
const converts =
  (output: Buffer = FFMPEG_MP3) =>
  (child: FakeChild) => {
    child.stdout.end(output);
    child.stderr.end();
    setImmediate(() => child.emit("close", 0, null));
  };

/** ffmpeg refuses its input. */
const refuses =
  (code = 183, message = "[in#0 @ 0x5] Error opening input: Invalid data found when processing input") =>
  (child: FakeChild) => {
    child.stdout.end();
    child.stderr.end(`${message}\n`);
    setImmediate(() => child.emit("close", code, null));
  };

/** ffmpeg never finishes, until it is killed. */
const hangs = () => undefined;

function gemini(text = "سلام عليكم، شحال الروبة؟") {
  return vi.fn<typeof generateContent>(async () => ({ text, finishReason: "STOP", usage: null }));
}

/** What the transcription asked Gemini. */
function request(generate: ReturnType<typeof gemini>) {
  const options = generate.mock.calls[0][0];
  const inline = options.contents[0].parts[1].inlineData;
  return { options, mimeType: inline?.mimeType, audio: Buffer.from(inline?.data ?? "", "base64") };
}

function fetchReturning(...responses: Response[]) {
  const impl = vi.fn<typeof fetch>();
  for (const response of responses) impl.mockResolvedValueOnce(response);
  return impl;
}

/** A body that never ends: it counts its reads, and whether it was cancelled. */
function endlessBody(chunkSize = 1_000) {
  const state = { reads: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.reads += 1;
      controller.enqueue(new Uint8Array(chunkSize));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

/** A body that sends its first bytes, then nothing, ever. */
function stalledBody(first: Uint8Array) {
  const state = { cancelled: false };
  let sent = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) return new Promise<void>(() => undefined);
      sent = true;
      controller.enqueue(first);
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

/** The error a promise rejects with, checked to be of the given class. */
async function rejection<T extends Error>(promise: Promise<unknown>, type: new (...args: never[]) => T): Promise<T> {
  const error = await promise.then(
    () => {
      throw new Error("Expected a rejection");
    },
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(type);
  return error as T;
}

beforeEach(() => {
  // No test reaches the network: a real fetch fails loudly.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("A test tried to use the network");
    })
  );
  vi.stubEnv("GOOGLE_API_KEY", "");
  vi.stubEnv("GEMINI_TRANSCRIBE_MODEL", "");
  vi.stubEnv("GEMINI_TRANSCRIBE_PROMPT", "");
  vi.stubEnv("FACEBOOK_AUDIO_MAX_BYTES", "");
  vi.stubEnv("FFMPEG_PATH", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// ─── Gemini ─────────────────────────────────────────────────────────────────

describe("the Gemini request", () => {
  it("sends an MP3 as it is: the exact prompt, then the audio inline, to the transcription model", async () => {
    const generate = gemini();
    const ffmpeg = fakeSpawn(converts());
    const result = await transcribeAudio(MP3, "audio/mpeg", { generate, spawnImpl: ffmpeg.spawnImpl });

    expect(result).toEqual({ transcript: "سلام عليكم، شحال الروبة؟", mimeType: "audio/mpeg", converted: false });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0][0]).toEqual({
      model: "gemini-flash-latest",
      contents: [
        {
          role: "user",
          parts: [{ text: PROMPT }, { inlineData: { mimeType: "audio/mp3", data: MP3.toString("base64") } }],
        },
      ],
      timeoutMs: 60_000,
    });
    expect(ffmpeg.impl).not.toHaveBeenCalled();
  });

  it("leaves the temperature to generateContent (GEMINI_TEMPERATURE) and the model", async () => {
    const generate = gemini();
    await transcribeAudio(MP3, null, { generate });
    expect(request(generate).options).not.toHaveProperty("temperature");
  });

  it("sends a WAV as it is, as audio/wav", async () => {
    const generate = gemini();
    const ffmpeg = fakeSpawn(converts());
    const result = await transcribeAudio(WAV, "audio/x-wav", { generate, spawnImpl: ffmpeg.spawnImpl });

    expect(result).toMatchObject({ mimeType: "audio/wav", converted: false });
    expect(request(generate).mimeType).toBe("audio/wav");
    expect(request(generate).audio.equals(WAV)).toBe(true);
    expect(ffmpeg.impl).not.toHaveBeenCalled();
  });

  it("sends an MP3 that opens with an ID3 tag as it is too", async () => {
    const generate = gemini();
    const ffmpeg = fakeSpawn(converts());
    await expect(transcribeAudio(MP3_ID3, null, { generate, spawnImpl: ffmpeg.spawnImpl })).resolves.toMatchObject({
      converted: false,
    });
    expect(request(generate).mimeType).toBe("audio/mp3");
    expect(ffmpeg.impl).not.toHaveBeenCalled();
  });

  it("takes the model and the prompt from the environment", async () => {
    vi.stubEnv("GEMINI_TRANSCRIBE_MODEL", "models/gemini-2.5-flash");
    vi.stubEnv("GEMINI_TRANSCRIBE_PROMPT", "Write down what this person says.");
    const generate = gemini();
    await transcribeAudio(MP3, null, { generate });

    expect(request(generate).options.model).toBe("gemini-2.5-flash");
    expect(request(generate).options.contents[0].parts[0]).toEqual({ text: "Write down what this person says." });
  });

  it.each([
    ["rate_limited", new GeminiError("Quota exceeded", "rate_limited", 429)],
    ["unavailable", new GeminiError("Gemini did not answer in time", "unavailable")],
    ["missing_key", new GeminiError("GOOGLE_API_KEY is not set", "missing_key")],
    ["blocked", new GeminiError("Answer blocked: SAFETY", "blocked")],
    ["invalid_response", new GeminiError("Gemini returned an empty answer", "invalid_response")],
  ])("a GeminiError (%s) is ai_failed, with the GeminiError as its cause", async (kind, cause) => {
    const generate = vi.fn<typeof generateContent>(async () => {
      throw cause;
    });
    const error = await rejection(transcribeAudio(MP3, null, { generate }), TranscriptionError);

    expect(error.kind).toBe("ai_failed");
    expect(error.cause).toBe(cause);
    expect(error.message).toContain(`(${kind})`);
  });

  it("lets an error that is not Gemini's through unchanged: it is a bug", async () => {
    const bug = new TypeError("Cannot read properties of undefined");
    const generate = vi.fn<typeof generateContent>(async () => {
      throw bug;
    });
    await expect(transcribeAudio(MP3, null, { generate })).rejects.toBe(bug);
  });
});

// ─── Formats ────────────────────────────────────────────────────────────────

describe("formats Gemini is not sent as they are go through ffmpeg", () => {
  it.each([
    ["MP4 (Messenger)", MP4, "audio/mp4", "audio/mp4"],
    ["AAC", AAC, "audio/aac", "audio/aac"],
    ["OGG/Opus (Telegram)", OGG, "audio/ogg", "audio/ogg"],
    ["WebM", WEBM, null, "audio/webm"],
    ["FLAC", FLAC, null, "audio/flac"],
  ])("%s: the audio on stdin, the MP3 from stdout to Gemini", async (_name, bytes, declared, mimeType) => {
    const generate = gemini("نحب نعرف السعر");
    const ffmpeg = fakeSpawn(converts());
    const result = await transcribeAudio(bytes, declared, { generate, spawnImpl: ffmpeg.spawnImpl });

    expect(result).toEqual({ transcript: "نحب نعرف السعر", mimeType, converted: true });
    expect(ffmpeg.runs).toHaveLength(1);
    expect(ffmpeg.runs[0].command).toBe("ffmpeg");
    expect(ffmpeg.runs[0].args).toEqual(ARGS);
    expect(ffmpeg.runs[0].input.equals(bytes)).toBe(true);
    expect(request(generate).mimeType).toBe("audio/mp3");
    expect(request(generate).audio.equals(FFMPEG_MP3)).toBe(true);
  });

  it("trusts the bytes, not the declared type: a declared MP3 that does not look like one is converted", async () => {
    const generate = gemini();
    const ffmpeg = fakeSpawn(converts());
    const unknown = sample("\0\0\0\0 something ffmpeg may know");
    const result = await transcribeAudio(unknown, "audio/mpeg", { generate, spawnImpl: ffmpeg.spawnImpl });

    expect(result).toMatchObject({ mimeType: "audio/mpeg", converted: true });
    expect(ffmpeg.runs).toHaveLength(1);
    expect(request(generate).audio.equals(FFMPEG_MP3)).toBe(true);
  });

  it("reports an unknown format by its declared type, or as octet-stream", async () => {
    const ffmpeg = fakeSpawn(converts());
    const unknown = sample("#!AMR\n");
    await expect(
      transcribeAudio(unknown, "audio/AMR; rate=8000", { generate: gemini(), spawnImpl: ffmpeg.spawnImpl })
    ).resolves.toMatchObject({ mimeType: "audio/amr", converted: true });
    await expect(transcribeAudio(unknown, null, { generate: gemini(), spawnImpl: ffmpeg.spawnImpl })).resolves.toMatchObject({
      mimeType: "application/octet-stream",
    });
  });

  it("reads an MP4 whose index comes after its audio through cache:, as a pipe cannot seek back", async () => {
    const ffmpeg = fakeSpawn(converts());
    await transcribeAudio(MP4_INDEX_LAST, "audio/mp4", { generate: gemini(), spawnImpl: ffmpeg.spawnImpl });
    expect(ffmpeg.runs[0].args).toEqual(ARGS.map((arg) => (arg === "pipe:0" ? "cache:pipe:0" : arg)));
  });

  it("runs the ffmpeg FFMPEG_PATH names", async () => {
    vi.stubEnv("FFMPEG_PATH", "/opt/ffmpeg/bin/ffmpeg");
    const ffmpeg = fakeSpawn(converts());
    await transcribeAudio(OGG, "audio/ogg", { generate: gemini(), spawnImpl: ffmpeg.spawnImpl });
    expect(ffmpeg.runs[0].command).toBe("/opt/ffmpeg/bin/ffmpeg");
  });

  it("bytes ffmpeg cannot read are conversion_failed, and Gemini is not asked", async () => {
    const generate = gemini();
    const ffmpeg = fakeSpawn(refuses());
    const error = await rejection(
      transcribeAudio(sample("not audio at all"), null, { generate, spawnImpl: ffmpeg.spawnImpl }),
      TranscriptionError
    );

    expect(error.kind).toBe("conversion_failed");
    expect(error.message).toContain("Invalid data found when processing input");
    expect(error.cause).toBeInstanceOf(AudioError);
    expect(generate).not.toHaveBeenCalled();
  });

  it("no bytes at all are unsupported", async () => {
    const error = await rejection(transcribeAudio(Buffer.alloc(0), "audio/mp4", { generate: gemini() }), TranscriptionError);
    expect(error.kind).toBe("unsupported");
  });

  it("bytes of no audio format, declared as a web page, are unsupported without running ffmpeg", async () => {
    const ffmpeg = fakeSpawn(converts());
    const page = Buffer.from("<!DOCTYPE html><html><body>Link expired</body></html>");
    const error = await rejection(
      transcribeAudio(page, "text/html; charset=utf-8", { generate: gemini(), spawnImpl: ffmpeg.spawnImpl }),
      TranscriptionError
    );

    expect(error.kind).toBe("unsupported");
    expect(error.message).toContain("text/html");
    expect(ffmpeg.impl).not.toHaveBeenCalled();
  });

  it("audio bytes declared as something else are still audio", async () => {
    const generate = gemini();
    await expect(transcribeAudio(MP3, "text/plain", { generate })).resolves.toMatchObject({
      mimeType: "audio/mpeg",
      converted: false,
    });
  });
});

describe("ffmpeg", () => {
  it("is fed the audio on stdin and gives the MP3 on stdout", async () => {
    const ffmpeg = fakeSpawn(converts());
    const mp3 = await toMp3Mono16k(OGG, { spawnImpl: ffmpeg.spawnImpl });

    expect(mp3.equals(FFMPEG_MP3)).toBe(true);
    expect(ffmpeg.runs[0]).toMatchObject({ command: "ffmpeg", args: ARGS });
    expect(ffmpeg.runs[0].input.equals(OGG)).toBe(true);
  });

  it("a non-zero exit is conversion_failed, with what ffmpeg said", async () => {
    const ffmpeg = fakeSpawn(refuses(1, "Conversion failed!"));
    const error = await rejection(toMp3Mono16k(OGG, { spawnImpl: ffmpeg.spawnImpl }), AudioError);
    expect(error.kind).toBe("conversion_failed");
    expect(error.message).toBe("ffmpeg failed (exit 1): Conversion failed!");
  });

  it("a missing ffmpeg (ENOENT) is conversion_failed", async () => {
    const child = fakeChild();
    process.nextTick(() => {
      child.emit("error", Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" }));
      child.emit("close", -2, null);
    });
    const error = await rejection(toMp3Mono16k(OGG, { spawnImpl: spawnReturning(child) }), AudioError);
    expect(error.kind).toBe("conversion_failed");
    expect(error.message).toContain("ENOENT");
  });

  it("a spawn that throws is conversion_failed", async () => {
    const spawnImpl = vi.fn(() => {
      throw new TypeError("The argument 'file' cannot be empty");
    }) as unknown as typeof spawn;
    await expect(toMp3Mono16k(OGG, { spawnImpl })).rejects.toMatchObject({ kind: "conversion_failed" });
  });

  it("a stuck ffmpeg is killed at the timeout: conversion_failed", async () => {
    const ffmpeg = fakeSpawn(hangs);
    const error = await rejection(toMp3Mono16k(OGG, { spawnImpl: ffmpeg.spawnImpl, timeoutMs: 30 }), AudioError);

    expect(error.kind).toBe("conversion_failed");
    expect(error.message).toContain("30 ms");
    expect(ffmpeg.runs[0].child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("an exit 0 with nothing but an ID3 tag is conversion_failed: there is no audio", async () => {
    // What ffmpeg writes for an MP4 it cannot read from a pipe.
    const tagOnly = sample("ID3\x04\x00\x00\x00\x00\x00\x16TSSE", 32);
    const ffmpeg = fakeSpawn(converts(tagOnly));
    const error = await rejection(toMp3Mono16k(OGG, { spawnImpl: ffmpeg.spawnImpl }), AudioError);
    expect(error).toMatchObject({ kind: "conversion_failed", message: "ffmpeg produced no audio" });
  });

  it("an EPIPE on stdin, when ffmpeg stops reading early, does not crash anything", async () => {
    const child = fakeChild();
    process.nextTick(() => {
      child.stdin.destroy(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
      child.stderr.end("pipe:0: Invalid data found when processing input\n");
      setImmediate(() => child.emit("close", 183, null));
    });
    const error = await rejection(toMp3Mono16k(Buffer.alloc(4096, 7), { spawnImpl: spawnReturning(child) }), AudioError);
    expect(error).toMatchObject({ kind: "conversion_failed" });
    expect(error.message).toContain("exit 183");
  });

  it("stops ffmpeg once the MP3 grows past maxOutputBytes: too_large", async () => {
    const ffmpeg = fakeSpawn(converts(sample("ID3\x04\x00\x00\x00\x00\x00\x00\xff\xf3", 5_000)));
    const error = await rejection(toMp3Mono16k(OGG, { spawnImpl: ffmpeg.spawnImpl, maxOutputBytes: 4_096 }), AudioError);
    expect(error.kind).toBe("too_large");
    expect(ffmpeg.runs[0].child.kill).toHaveBeenCalledWith("SIGKILL");
  });
});

// ─── Size limits ────────────────────────────────────────────────────────────

describe("size limits", () => {
  it("a content-length over the limit is refused before the body is read", async () => {
    const { stream, state } = endlessBody();
    const fetchImpl = fetchReturning(new Response(stream, { headers: { "content-length": "20000" } }));
    const error = await rejection(downloadAudio("https://cdn.fbsbx.com/a.mp4", { maxBytes: 10_000 }, { fetchImpl }), AudioError);

    expect(error.kind).toBe("too_large");
    expect(state.cancelled).toBe(true);
    // A stream may fill its queue once on its own; nothing more was read.
    expect(state.reads).toBeLessThanOrEqual(1);
  });

  it("a body that streams past the limit is cut off as soon as it does", async () => {
    const { stream, state } = endlessBody(1_000);
    const fetchImpl = fetchReturning(new Response(stream));
    const error = await rejection(downloadAudio("https://cdn.fbsbx.com/a.mp4", { maxBytes: 10_000 }, { fetchImpl }), AudioError);

    expect(error.kind).toBe("too_large");
    expect(state.cancelled).toBe(true);
    expect(state.reads).toBeLessThan(15);
  });

  it("a body exactly at the limit is fine", async () => {
    const fetchImpl = fetchReturning(new Response(new Uint8Array(10_000)));
    const { bytes } = await downloadAudio("https://cdn.fbsbx.com/a.mp4", { maxBytes: 10_000 }, { fetchImpl });
    expect(bytes.length).toBe(10_000);
  });

  it("transcribeAudioUrl caps the download at FACEBOOK_AUDIO_MAX_BYTES by default", async () => {
    vi.stubEnv("FACEBOOK_AUDIO_MAX_BYTES", String(64 * 1024));
    const generate = gemini();
    const fetchImpl = fetchReturning(new Response(endlessBody().stream, { headers: { "content-length": String(70_000) } }));
    const error = await rejection(transcribeAudioUrl("https://cdn.fbsbx.com/a.mp4", {}, { fetchImpl, generate }), TranscriptionError);

    expect(error.kind).toBe("too_large");
    expect(error.message).toContain(String(64 * 1024));
    expect(generate).not.toHaveBeenCalled();
  });

  it("transcribeAudioUrl takes a maxBytes of its own", async () => {
    const fetchImpl = fetchReturning(new Response(new Uint8Array(2_000)));
    await expect(
      transcribeAudioUrl("https://cdn.fbsbx.com/a.mp4", { maxBytes: 1_000 }, { fetchImpl, generate: gemini() })
    ).rejects.toMatchObject({ kind: "too_large" });
  });

  it("a WAV over the inline limit is re-encoded to fit", async () => {
    const generate = gemini();
    const ffmpeg = fakeSpawn(converts());
    const bigWav = Buffer.concat([WAV, Buffer.alloc(MAX_INLINE_AUDIO_BYTES)]);
    const result = await transcribeAudio(bigWav, "audio/wav", { generate, spawnImpl: ffmpeg.spawnImpl });

    expect(result).toMatchObject({ mimeType: "audio/wav", converted: true });
    expect(ffmpeg.runs[0].input.length).toBe(bigWav.length);
    expect(request(generate)).toMatchObject({ mimeType: "audio/mp3" });
    expect(request(generate).audio.equals(FFMPEG_MP3)).toBe(true);
  });

  it("an MP3 still over the inline limit once re-encoded is too_large, and Gemini is not asked", async () => {
    const generate = gemini();
    const huge = Buffer.concat([FFMPEG_MP3, Buffer.alloc(MAX_INLINE_AUDIO_BYTES)]);
    const ffmpeg = fakeSpawn(converts(huge));
    const bigMp3 = Buffer.concat([MP3, Buffer.alloc(MAX_INLINE_AUDIO_BYTES)]);
    const error = await rejection(transcribeAudio(bigMp3, "audio/mpeg", { generate, spawnImpl: ffmpeg.spawnImpl }), TranscriptionError);

    expect(error.kind).toBe("too_large");
    expect(ffmpeg.runs[0].child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(generate).not.toHaveBeenCalled();
  });

  it("keeps the audio sent under Gemini's 20 MB inline request limit, base64 included", () => {
    expect(Math.ceil(MAX_INLINE_AUDIO_BYTES / 3) * 4).toBeLessThan(20_000_000 - 10_000);
  });
});

// ─── Download ───────────────────────────────────────────────────────────────

describe("the download", () => {
  it("returns the bytes and the declared type, with redirects handled by hand and a deadline", async () => {
    const fetchImpl = fetchReturning(new Response(body(OGG), { headers: { "content-type": "audio/ogg; codecs=opus" } }));
    const result = await downloadAudio("https://api.telegram.org/file/botTOKEN/voice/file_1.oga", { maxBytes: 1_000_000 }, { fetchImpl });

    expect(result.bytes.equals(OGG)).toBe(true);
    expect(result.contentType).toBe("audio/ogg; codecs=opus");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.telegram.org/file/botTOKEN/voice/file_1.oga");
    expect(init).toMatchObject({ redirect: "manual" });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    "http://cdn.fbsbx.com/v/audioclip.mp4",
    "ftp://files.example.com/a.mp3",
    "file:///etc/passwd",
    "data:audio/mp3;base64,SUQz",
    "javascript:alert(1)",
    "not a url",
    "",
  ])("only https: %j is refused before any request", async (url) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const error = await rejection(downloadAudio(url, { maxBytes: 1_000 }, { fetchImpl }), AudioError);
    expect(error.kind).toBe("not_https");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("follows https redirects, relative ones included", async () => {
    const fetchImpl = fetchReturning(
      new Response(null, { status: 302, headers: { location: "https://scontent.xx.fbcdn.net/v/clip.mp4?oh=1" } }),
      new Response(null, { status: 301, headers: { location: "/v/clip-2.mp4" } }),
      new Response(body(MP4), { headers: { "content-type": "audio/mp4" } })
    );
    const result = await downloadAudio("https://lookaside.fbsbx.com/clip", { maxBytes: 1_000_000 }, { fetchImpl });

    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "https://lookaside.fbsbx.com/clip",
      "https://scontent.xx.fbcdn.net/v/clip.mp4?oh=1",
      "https://scontent.xx.fbcdn.net/v/clip-2.mp4",
    ]);
    expect(result.bytes.equals(MP4)).toBe(true);
  });

  it("refuses a redirect to http without requesting it", async () => {
    const fetchImpl = fetchReturning(new Response(null, { status: 307, headers: { location: "http://cdn.example.com/a.mp4" } }));
    const error = await rejection(downloadAudio("https://cdn.example.com/a.mp4", { maxBytes: 1_000 }, { fetchImpl }), AudioError);
    expect(error.kind).toBe("not_https");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("gives up after five redirects", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 302, headers: { location: "https://cdn.example.com/again" } })
    );
    const error = await rejection(downloadAudio("https://cdn.example.com/a", { maxBytes: 1_000 }, { fetchImpl }), AudioError);
    expect(error.kind).toBe("download_failed");
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it.each([403, 404, 500])("HTTP %i is download_failed, and the body is let go", async (status) => {
    const { stream, state } = endlessBody();
    const fetchImpl = fetchReturning(new Response(stream, { status }));
    const error = await rejection(downloadAudio("https://cdn.fbsbx.com/a.mp4", { maxBytes: 1_000 }, { fetchImpl }), AudioError);

    expect(error.kind).toBe("download_failed");
    expect(error.message).toContain(`HTTP ${status}`);
    expect(state.cancelled).toBe(true);
  });

  it("a network failure is download_failed, with its code", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    });
    const error = await rejection(downloadAudio("https://cdn.fbsbx.com/a.mp4", { maxBytes: 1_000 }, { fetchImpl }), AudioError);
    expect(error.kind).toBe("download_failed");
    expect(error.message).toContain("[ENOTFOUND]");
  });

  it("a connection lost in the middle of the body is download_failed", async () => {
    let sent = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) return controller.error(new TypeError("terminated"));
        sent = true;
        controller.enqueue(new Uint8Array(100));
      },
    });
    const fetchImpl = fetchReturning(new Response(stream));
    await expect(
      downloadAudio("https://cdn.fbsbx.com/a.mp4", { maxBytes: 1_000 }, { fetchImpl })
    ).rejects.toMatchObject({ kind: "download_failed" });
  });

  it.each([
    ["no body", () => new Response(null)],
    ["an empty body", () => new Response(new Uint8Array(0))],
  ])("%s is download_failed", async (_name, response) => {
    const fetchImpl = fetchReturning(response());
    await expect(
      downloadAudio("https://cdn.fbsbx.com/a.mp4", { maxBytes: 1_000 }, { fetchImpl })
    ).rejects.toMatchObject({ kind: "download_failed" });
  });

  it("names the host in its errors, never the URL: a Telegram file URL holds the bot token", async () => {
    const url = "https://api.telegram.org/file/bot123456:AAH-secret-token/voice/file_7.oga?sig=abc";
    const notFound = await rejection(
      downloadAudio(url, { maxBytes: 1_000 }, { fetchImpl: fetchReturning(new Response("Not Found", { status: 404 })) }),
      AudioError
    );
    const offline = await rejection(
      downloadAudio(url, { maxBytes: 1_000 }, {
        fetchImpl: vi.fn<typeof fetch>(async () => {
          throw new TypeError("fetch failed");
        }),
      }),
      AudioError
    );
    for (const error of [notFound, offline]) {
      expect(error.message).toContain("api.telegram.org");
      expect(error.message).not.toContain("secret");
      expect(error.message).not.toContain("sig=");
    }
  });

  it("a server that never answers times out, and the request is aborted", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")));
        })
    );
    const error = await rejection(
      downloadAudio("https://cdn.fbsbx.com/a.mp4", { maxBytes: 1_000, timeoutMs: 30 }, { fetchImpl }),
      AudioError
    );

    expect(error.kind).toBe("timeout");
    expect(error.message).toContain("30 ms");
    expect(fetchImpl.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it("times out even when the fetch ignores the abort", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined));
    await expect(
      downloadAudio("https://cdn.fbsbx.com/a.mp4", { maxBytes: 1_000, timeoutMs: 30 }, { fetchImpl })
    ).rejects.toMatchObject({ kind: "timeout" });
  });

  it("a body that stalls times out too, and is let go", async () => {
    const { stream, state } = stalledBody(new Uint8Array(100));
    const fetchImpl = fetchReturning(new Response(stream));
    const error = await rejection(
      downloadAudio("https://cdn.fbsbx.com/a.mp4", { maxBytes: 1_000, timeoutMs: 30 }, { fetchImpl }),
      AudioError
    );
    expect(error.kind).toBe("timeout");
    expect(state.cancelled).toBe(true);
  });
});

describe("transcribeAudioUrl", () => {
  it("downloads, converts and transcribes a Messenger voice clip", async () => {
    const url = "https://cdn.fbsbx.com/v/t59.3654-21/audioclip-1732.mp4?_nc_cat=1&oh=00_sig&oe=67";
    const fetchImpl = fetchReturning(new Response(body(MP4), { headers: { "content-type": "audio/mp4" } }));
    const ffmpeg = fakeSpawn(converts());
    const generate = gemini("واش كاين التوصيل لقسنطينة؟");
    const result = await transcribeAudioUrl(url, {}, { fetchImpl, generate, spawnImpl: ffmpeg.spawnImpl });

    expect(result).toEqual({ transcript: "واش كاين التوصيل لقسنطينة؟", mimeType: "audio/mp4", converted: true });
    expect(fetchImpl.mock.calls[0][0]).toBe(url);
    expect(ffmpeg.runs[0].input.equals(MP4)).toBe(true);
    expect(request(generate).audio.equals(FFMPEG_MP3)).toBe(true);
  });

  it("an http URL is not_https, and nothing is downloaded", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const error = await rejection(
      transcribeAudioUrl("http://cdn.fbsbx.com/a.mp4", {}, { fetchImpl, generate: gemini() }),
      TranscriptionError
    );
    expect(error.kind).toBe("not_https");
    expect(error.cause).toBeInstanceOf(AudioError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a download that times out is download_failed, its AudioError (timeout) as the cause", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined));
    const error = await rejection(
      transcribeAudioUrl("https://cdn.fbsbx.com/a.mp4", { timeoutMs: 30 }, { fetchImpl, generate: gemini() }),
      TranscriptionError
    );
    expect(error.kind).toBe("download_failed");
    expect(error.cause).toMatchObject({ kind: "timeout" });
  });

  it("a refused download is download_failed", async () => {
    const fetchImpl = fetchReturning(new Response("gone", { status: 410 }));
    await expect(
      transcribeAudioUrl("https://cdn.fbsbx.com/a.mp4", {}, { fetchImpl, generate: gemini() })
    ).rejects.toMatchObject({ kind: "download_failed" });
  });
});

// ─── The answer ─────────────────────────────────────────────────────────────

describe("the transcript", () => {
  it.each([
    ['"سلام عليكم"', "سلام عليكم"],
    ["«نحب نعرف السعر»", "نحب نعرف السعر"],
    ["“Bonjour, c’est combien ?”", "Bonjour, c’est combien ?"],
    ["```\nشحال التوصيل لوهران؟\n```", "شحال التوصيل لوهران؟"],
    ["```text\nBonjour, vous livrez à Oran ?\n```", "Bonjour, vous livrez à Oran ?"],
    ["```واش كاين```", "واش كاين"],
    ['  "```\nسلام\n```"  \n', "سلام"],
    ["**سلام خويا**", "سلام خويا"],
    ["‏«سلام»", "سلام"],
    ["  نحب جوج\nواحد أحمر  \n", "نحب جوج\nواحد أحمر"],
  ])("cleans %j", (answer, transcript) => {
    expect(cleanTranscript(answer)).toBe(transcript);
  });

  it.each(["«salam» w «bslama»", '"Allô" dit-il, "ça va"', "c'est 'combien'"])("keeps the quotes that belong to the words: %j", (answer) => {
    expect(cleanTranscript(answer)).toBe(answer);
  });

  it("is cleaned before it is returned", async () => {
    const generate = gemini("```\n«شحال الروبة؟»\n```");
    await expect(transcribeAudio(MP3, null, { generate })).resolves.toMatchObject({ transcript: "شحال الروبة؟" });
  });

  it.each([
    '""',
    "```\n```",
    "...",
    "…",
    "[inaudible]",
    "(silence)",
    "[موسيقى] [ضجيج]",
    "[صمت]",
    "Inaudible.",
    "No speech detected.",
    "There is no speech in this audio.",
    "The audio is silent.",
    "I can't transcribe this audio.",
    "Sorry, I could not understand the recording.",
    "Il n'y a pas de parole dans cet enregistrement.",
    "Aucune parole audible.",
    "Je n'arrive pas à comprendre l'audio.",
    "لا يوجد كلام",
    "لا يوجد كلام في هذا التسجيل.",
    "«لا يوجد أي كلام مسموع في المقطع الصوتي»",
    "التسجيل فارغ",
    "الرسالة الصوتية فارغة.",
    "لم أتمكن من سماع أي كلام.",
    "عذراً، لا أستطيع فهم التسجيل.",
    "صمت",
  ])("an answer that holds no speech is empty: %j", async (answer) => {
    const error = await rejection(transcribeAudio(MP3, null, { generate: gemini(answer) }), TranscriptionError);
    expect(error.kind).toBe("empty");
  });

  it.each([
    "سلام عليكم، شحال الروبة؟",
    "لا يوجد مشكل، نحب نطلب جوج",
    "ما نسمعش مليح، عاود من فضلك",
    "Je ne peux pas comprendre le prix",
    "I can't hear you well, call me",
    "Bonjour, il n'y a pas de taille L ?",
    "[ضحك] واش راك خويا",
    "4500",
    "no",
  ])("a real message is kept, even one that sounds like a refusal: %j", (transcript) => {
    expect(isNoSpeech(transcript)).toBe(false);
  });
});

// ─── Formats ────────────────────────────────────────────────────────────────

describe("sniffAudioMime", () => {
  it.each([
    ["MP3 with an ID3 tag", MP3_ID3, "audio/mpeg"],
    ["MP3 frame (MPEG-1)", MP3, "audio/mpeg"],
    ["MP3 frame (MPEG-2)", sample([0xff, 0xf3, 0x48, 0xc4]), "audio/mpeg"],
    ["WAV", WAV, "audio/wav"],
    ["OGG", OGG, "audio/ogg"],
    ["FLAC", FLAC, "audio/flac"],
    ["MP4/M4A", MP4, "audio/mp4"],
    ["WebM", WEBM, "audio/webm"],
    ["AAC ADTS (MPEG-4)", AAC, "audio/aac"],
    ["AAC ADTS (MPEG-2)", sample([0xff, 0xf9, 0x50, 0x80]), "audio/aac"],
    ["AAC behind an ID3 tag", sample("ID3\x04\x00\x00\x00\x00\x00\x00\xff\xf1\x50\x80"), "audio/aac"],
  ])("%s", (_name, bytes, mime) => {
    expect(sniffAudioMime(bytes)).toBe(mime);
  });

  it("goes by the bytes before the declared type", () => {
    expect(sniffAudioMime(OGG, "audio/mpeg")).toBe("audio/ogg");
    expect(sniffAudioMime(MP4, "audio/wav")).toBe("audio/mp4");
  });

  it.each([
    ["audio/mpeg", "audio/mpeg"],
    ["audio/mp3", "audio/mpeg"],
    ["audio/x-wav", "audio/wav"],
    ["audio/ogg; codecs=opus", "audio/ogg"],
    ["audio/opus", "audio/ogg"],
    ["Audio/X-M4A", "audio/mp4"],
    ["video/mp4", "audio/mp4"],
    ["audio/aac", "audio/aac"],
    ["audio/webm", "audio/webm"],
    ["audio/x-flac", "audio/flac"],
  ])("falls back to the declared type %j", (declared, mime) => {
    expect(sniffAudioMime(sample("\0\0\0\0unknown"), declared)).toBe(mime);
  });

  it.each([
    ["no declared type", null],
    ["a generic type", "application/octet-stream"],
    ["a type that is not audio", "text/html"],
    ["an Object property name", "constructor"],
  ])("is null for unknown bytes with %s", (_name, declared) => {
    expect(sniffAudioMime(sample("\0\0\0\0unknown"), declared)).toBeNull();
  });

  it("is null for too few bytes", () => {
    expect(sniffAudioMime(Buffer.alloc(0))).toBeNull();
    expect(sniffAudioMime(Buffer.from([0xff]))).toBeNull();
  });
});

// ─── The real ffmpeg ────────────────────────────────────────────────────────

describe("with the real ffmpeg", () => {
  it.skipIf(!ffmpegAvailable)("turns a WAV made in memory into an MP3", async () => {
    const mp3 = await toMp3Mono16k(sineWav(1, 44_100), { ffmpegPath: FFMPEG });
    expect(sniffAudioMime(mp3)).toBe("audio/mpeg");
    // One second at 32 kb/s is about 4 KB.
    expect(mp3.length).toBeGreaterThan(3_000);
  });

  it.skipIf(!ffmpegAvailable)("reads a phone-style MP4 whose index comes after its audio", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openreply-transcribe-"));
    let clip: Buffer;
    try {
      const file = join(dir, "voice.mp4");
      const made = spawnSync(FFMPEG, [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=10",
        "-ac",
        "1",
        "-c:a",
        "aac",
        "-b:a",
        "64k",
        file,
      ]);
      expect(made.status).toBe(0);
      clip = readFileSync(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(clip.indexOf("mdat")).toBeLessThan(clip.indexOf("moov"));

    const mp3 = await toMp3Mono16k(clip, { ffmpegPath: FFMPEG });
    expect(sniffAudioMime(mp3)).toBe("audio/mpeg");
    // All ten seconds (about 40 KB), not the empty MP3 a plain pipe gives.
    expect(mp3.length).toBeGreaterThan(30_000);
  });

  it.skipIf(!ffmpegAvailable)("refuses bytes that are not audio", async () => {
    await expect(toMp3Mono16k(Buffer.alloc(64 * 1024, 7), { ffmpegPath: FFMPEG })).rejects.toMatchObject({
      kind: "conversion_failed",
    });
  });

  it("a missing binary is conversion_failed (no ffmpeg needed)", async () => {
    const error = await rejection(toMp3Mono16k(WAV, { ffmpegPath: "/nonexistent/openreply-ffmpeg" }), AudioError);
    expect(error.kind).toBe("conversion_failed");
    expect(error.message).toContain("ENOENT");
  });
});
