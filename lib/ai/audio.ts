/**
 * Audio for voice transcription: download a voice message, tell its format
 * from its bytes, and re-encode it with ffmpeg when Gemini would not read it.
 *
 * ffmpeg is an external binary (FFMPEG_PATH, "ffmpeg" by default), fed on
 * stdin and read on stdout: this code never writes the audio to disk.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export type AudioErrorKind = "not_https" | "too_large" | "download_failed" | "timeout" | "conversion_failed";

export class AudioError extends Error {
  constructor(
    message: string,
    readonly kind: AudioErrorKind
  ) {
    super(message);
    this.name = "AudioError";
  }
}

/** The formats sniffAudioMime recognises. */
export type AudioMime =
  | "audio/mpeg"
  | "audio/wav"
  | "audio/ogg"
  | "audio/aac"
  | "audio/mp4"
  | "audio/webm"
  | "audio/flac";

const DOWNLOAD_TIMEOUT_MS = 20_000;
const CONVERSION_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ─── Download ───────────────────────────────────────────────────────────────

/** The URL, if it is https: checked before the first request and every redirect. */
function httpsUrl(value: string, base?: URL): URL {
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    throw new AudioError("The audio URL is not a valid URL", "not_https");
  }
  if (url.protocol !== "https:") {
    throw new AudioError(`The audio URL must use https, not ${url.protocol.slice(0, -1)}`, "not_https");
  }
  return url;
}

/** Why a request failed, with the system error code when there is one. */
function networkReason(error: unknown): string {
  const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof code === "string" ? `${errorText(error)} [${code}]` : errorText(error);
}

/** Frees the connection of a response whose body is not wanted. */
async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

/**
 * GET, following redirects by hand: fetch alone would follow one to http,
 * so every hop is checked for https before it is requested.
 */
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
      throw new AudioError(`The audio download failed (${url.hostname}): ${networkReason(error)}`, "download_failed");
    }
    const location = REDIRECT_STATUSES.has(response.status) ? response.headers.get("location") : null;
    if (!location) return { response, host: url.hostname };
    await discard(response);
    if (redirects >= MAX_REDIRECTS) {
      throw new AudioError(`The audio download redirected too many times (${first.hostname})`, "download_failed");
    }
    url = httpsUrl(location, url);
  }
}

/**
 * Download a Messenger/Telegram audio URL now (CDN links expire). https
 * only, size-capped, time-limited.
 *
 * Error messages name the host, never the URL: a Telegram file URL carries
 * the bot token in its path, and Messenger's carry signed query strings.
 */
export async function downloadAudio(
  url: string,
  limits: { maxBytes: number; timeoutMs?: number },
  deps: { fetchImpl?: typeof fetch } = {}
): Promise<{ bytes: Buffer; contentType: string | null }> {
  const first = httpsUrl(url);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = limits.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  // One deadline for the whole download, body included: a CDN that sends
  // its headers and then stalls must not hold the worker.
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new AudioError(`The audio download took more than ${timeoutMs} ms (${first.hostname})`, "timeout"));
      controller.abort();
      void reader?.cancel().catch(() => undefined);
    }, timeoutMs);
  });

  const download = async () => {
    const { response, host } = await fetchFollowingRedirects(first, fetchImpl, controller.signal);
    if (!response.ok) {
      await discard(response);
      throw new AudioError(`The audio download failed (${host}): HTTP ${response.status}`, "download_failed");
    }
    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null && Number(declaredLength) > limits.maxBytes) {
      await discard(response);
      throw new AudioError(`The audio is ${declaredLength} bytes, over the limit of ${limits.maxBytes}`, "too_large");
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
          throw new AudioError(`The audio download failed (${host}): ${networkReason(error)}`, "download_failed");
        }
        if (next.done) break;
        total += next.value.byteLength;
        if (total > limits.maxBytes) {
          // A missing or lying content-length: stop now, the rest never downloads.
          await reader.cancel().catch(() => undefined);
          throw new AudioError(`The audio is over the limit of ${limits.maxBytes} bytes`, "too_large");
        }
        chunks.push(next.value);
      }
    }
    if (total === 0) throw new AudioError(`The audio download was empty (${host})`, "download_failed");
    return { bytes: Buffer.concat(chunks, total), contentType: response.headers.get("content-type") };
  };

  try {
    return await Promise.race([download(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

// ─── Format ─────────────────────────────────────────────────────────────────

/** Declared types, and their aliases, for the formats sniffAudioMime knows. */
const DECLARED_TYPES = new Map<string, AudioMime>([
  ["audio/mpeg", "audio/mpeg"],
  ["audio/mp3", "audio/mpeg"],
  ["audio/mpeg3", "audio/mpeg"],
  ["audio/mpg", "audio/mpeg"],
  ["audio/x-mpeg", "audio/mpeg"],
  ["audio/x-mp3", "audio/mpeg"],
  ["audio/x-mpeg-3", "audio/mpeg"],
  ["audio/wav", "audio/wav"],
  ["audio/wave", "audio/wav"],
  ["audio/x-wav", "audio/wav"],
  ["audio/vnd.wave", "audio/wav"],
  ["audio/ogg", "audio/ogg"],
  ["audio/opus", "audio/ogg"],
  ["audio/vorbis", "audio/ogg"],
  ["application/ogg", "audio/ogg"],
  ["audio/aac", "audio/aac"],
  ["audio/aacp", "audio/aac"],
  ["audio/x-aac", "audio/aac"],
  ["audio/mp4", "audio/mp4"],
  ["audio/m4a", "audio/mp4"],
  ["audio/x-m4a", "audio/mp4"],
  // Messenger serves some voice clips as video/mp4.
  ["video/mp4", "audio/mp4"],
  ["audio/webm", "audio/webm"],
  ["video/webm", "audio/webm"],
  ["audio/flac", "audio/flac"],
  ["audio/x-flac", "audio/flac"],
]);

/** "Audio/MP4; codecs=mp4a" → "audio/mp4"; null when there is none. */
export function mediaType(value: string | null | undefined): string | null {
  const type = value?.split(";")[0].trim().toLowerCase();
  return type || null;
}

/** Length of the ID3v2 tag that opens the bytes, 0 without one. */
function id3Length(bytes: Buffer): number {
  if (bytes.length < 10 || bytes.toString("latin1", 0, 3) !== "ID3") return 0;
  // The size is "syncsafe": 7 bits per byte.
  const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
  const footer = bytes[5] & 0x10 ? 10 : 0;
  return 10 + size + footer;
}

/** ADTS (raw AAC): a 12-bit sync and layer 00, which no MP3 frame has. */
function isAdts(bytes: Buffer, at: number): boolean {
  return at + 1 < bytes.length && bytes[at] === 0xff && (bytes[at + 1] & 0xf6) === 0xf0;
}

/** An MPEG audio (MP3) frame: an 11-bit sync and a layer other than the reserved 00. */
function isMpegFrame(bytes: Buffer, at: number): boolean {
  return (
    at + 1 < bytes.length && bytes[at] === 0xff && (bytes[at + 1] & 0xe0) === 0xe0 && (bytes[at + 1] & 0x06) !== 0
  );
}

function fromMagic(bytes: Buffer): AudioMime | null {
  const ascii = (start: number, end: number) => bytes.toString("latin1", start, end);
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return "audio/wav";
  if (ascii(0, 4) === "OggS") return "audio/ogg";
  if (ascii(0, 4) === "fLaC") return "audio/flac";
  if (ascii(4, 8) === "ftyp") return "audio/mp4";
  if (bytes.length >= 4 && bytes.readUInt32BE(0) === 0x1a45dfa3) return "audio/webm";
  // ADTS before MP3: both start with 0xFFF.
  if (isAdts(bytes, 0)) return "audio/aac";
  if (isMpegFrame(bytes, 0)) return "audio/mpeg";
  return null;
}

/** The audio format from the bytes (magic numbers), falling back to the declared type. */
export function sniffAudioMime(bytes: Buffer, declared?: string | null): AudioMime | null {
  const tag = id3Length(bytes);
  // An ID3 tag mostly opens an MP3, but AAC and FLAC files can carry one too.
  if (tag > 0) return fromMagic(bytes.subarray(tag)) ?? "audio/mpeg";
  return fromMagic(bytes) ?? DECLARED_TYPES.get(mediaType(declared) ?? "") ?? null;
}

// ─── Conversion ─────────────────────────────────────────────────────────────

export function getFfmpegPath(): string {
  return process.env.FFMPEG_PATH?.trim() || "ffmpeg";
}

const STDERR_KEPT = 4_000;
// Printed at error level by the cache: protocol on every run, and harmless.
const STDERR_NOISE = /Inner protocol failed to seekback|Last message repeated/;

function stderrExcerpt(stderr: string): string {
  const text = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !STDERR_NOISE.test(line))
    .join(" | ");
  return text.length > 300 ? `…${text.slice(-300)}` : text;
}

/**
 * True for an MP4 whose index (moov) comes after its audio (mdat), as
 * phones record them. ffmpeg must then seek back, which a pipe cannot do:
 * it exits 0 having written an MP3 with no audio in it.
 */
function indexAfterData(bytes: Buffer): boolean {
  if (bytes.length < 16 || bytes.toString("latin1", 4, 8) !== "ftyp") return false;
  for (let offset = 0; offset + 8 <= bytes.length; ) {
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    if (type === "moov") return false;
    if (type === "mdat") return true;
    let size = bytes.readUInt32BE(offset);
    if (size === 1 && offset + 16 <= bytes.length) size = Number(bytes.readBigUInt64BE(offset + 8));
    // 0 runs to the end of the file; under 8 is broken. Either way, no moov follows.
    if (size < 8) return false;
    offset += size;
  }
  return false;
}

/** ffmpeg can exit 0 having written only the ID3 tag: no frame, no audio. */
function hasMpegFrame(mp3: Buffer): boolean {
  return isMpegFrame(mp3, id3Length(mp3));
}

/**
 * Re-encode to MP3, mono, 16 kHz, through ffmpeg stdin/stdout.
 *
 * Non-zero exit, spawn error (ENOENT), an MP3 with no audio, or the timeout
 * (the process is killed) → conversion_failed. With maxOutputBytes, an MP3
 * growing past it stops ffmpeg → too_large.
 */
export async function toMp3Mono16k(
  bytes: Buffer,
  options: {
    ffmpegPath?: string;
    timeoutMs?: number;
    maxOutputBytes?: number;
    spawnImpl?: typeof spawn;
  } = {}
): Promise<Buffer> {
  const timeoutMs = options.timeoutMs ?? CONVERSION_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? Number.POSITIVE_INFINITY;
  const spawnImpl = options.spawnImpl ?? spawn;
  // The cache: protocol keeps what ffmpeg read from the pipe in a temporary
  // file of its own, so it can seek back into such an MP4.
  const input = indexAfterData(bytes) ? "cache:pipe:0" : "pipe:0";
  const args = [
    ...["-hide_banner", "-loglevel", "error"],
    ...["-i", input, "-vn"],
    ...["-ac", "1", "-ar", "16000", "-b:a", "32k"],
    ...["-f", "mp3", "pipe:1"],
  ];

  return new Promise<Buffer>((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnImpl(options.ffmpegPath ?? getFfmpegPath(), args, { windowsHide: true });
    } catch (error) {
      reject(new AudioError(`ffmpeg could not start: ${errorText(error)}`, "conversion_failed"));
      return;
    }

    const output: Buffer[] = [];
    let outputBytes = 0;
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      abandon(new AudioError(`ffmpeg did not finish within ${timeoutMs} ms`, "conversion_failed"));
    }, timeoutMs);
    // "error" and "close" can both come: the first outcome wins.
    const finish = (outcome: Buffer | AudioError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (outcome instanceof AudioError) reject(outcome);
      else resolve(outcome);
    };
    // A stuck or runaway ffmpeg is killed, not left running.
    const abandon = (error: AudioError) => {
      child.kill("SIGKILL");
      finish(error);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        abandon(new AudioError(`The converted audio is over ${maxOutputBytes} bytes`, "too_large"));
        return;
      }
      output.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < STDERR_KEPT) stderr += chunk.toString("utf8");
    });
    // EPIPE when ffmpeg stops reading early (it refused the input): the exit
    // code says why, and an unhandled stream error would crash the worker.
    child.stdin.on("error", () => undefined);
    child.on("error", (error) => {
      finish(new AudioError(`ffmpeg could not run: ${errorText(error)}`, "conversion_failed"));
    });
    child.on("close", (code, signal) => {
      const detail = stderrExcerpt(stderr);
      const said = detail ? `: ${detail}` : "";
      if (code !== 0) {
        const status = code === null ? `signal ${signal}` : `exit ${code}`;
        finish(new AudioError(`ffmpeg failed (${status})${said}`, "conversion_failed"));
        return;
      }
      const mp3 = Buffer.concat(output);
      finish(hasMpegFrame(mp3) ? mp3 : new AudioError(`ffmpeg produced no audio${said}`, "conversion_failed"));
    });

    child.stdin.end(bytes);
  });
}
