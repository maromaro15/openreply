/**
 * Voice messages to text, with Gemini.
 *
 * MP3 and WAV go to Gemini as they are. Everything else (Messenger sends
 * MP4/AAC, Telegram voice notes are OGG/Opus) is re-encoded by ffmpeg to MP3
 * mono 16 kHz first. Every expected failure is a TranscriptionError, whose
 * kind says what went wrong: the worker marks the message FAILED and hands
 * the conversation to a person. Any other error is a bug and propagates.
 */
import type { spawn } from "node:child_process";
import { getFacebookAudioMaxBytes } from "@/lib/facebook/env";
import { AudioError, downloadAudio, mediaType, sniffAudioMime, toMp3Mono16k, type AudioErrorKind } from "./audio";
import { getGeminiTranscribeModel, getGeminiTranscribePrompt } from "./env";
import { GeminiError, generateContent } from "./gemini";

export type TranscriptionErrorKind =
  | "not_https"
  | "too_large"
  | "download_failed"
  /** No bytes, or bytes of no known audio format declared as something else (a web page, an image). */
  | "unsupported"
  | "conversion_failed"
  /** Gemini failed: the GeminiError is the cause. */
  | "ai_failed"
  /** Gemini answered, but heard no words. */
  | "empty";

export class TranscriptionError extends Error {
  constructor(
    message: string,
    readonly kind: TranscriptionErrorKind,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = "TranscriptionError";
  }
}

/** Gemini's inline request limit is 20 MB including base64, so the raw audio sent stays under this. */
export const MAX_INLINE_AUDIO_BYTES = 14 * 1024 * 1024;

const GEMINI_TIMEOUT_MS = 60_000;

export interface TranscribeDeps {
  generate?: typeof generateContent;
  fetchImpl?: typeof fetch;
  spawnImpl?: typeof spawn;
}

export interface Transcription {
  /** What the person said, without the quotes or code fences of the answer. */
  transcript: string;
  /** The format the audio came in: from its bytes, else its declared type. */
  mimeType: string;
  /** True when ffmpeg re-encoded the audio to MP3 before Gemini heard it. */
  converted: boolean;
}

const AUDIO_ERROR_KINDS: Record<AudioErrorKind, TranscriptionErrorKind> = {
  not_https: "not_https",
  too_large: "too_large",
  download_failed: "download_failed",
  // Only a download times out with this kind; an ffmpeg timeout is conversion_failed.
  timeout: "download_failed",
  conversion_failed: "conversion_failed",
};

/** An AudioError as the TranscriptionError of the same kind; anything else unchanged. */
function fromAudioError(error: unknown): unknown {
  if (!(error instanceof AudioError)) return error;
  return new TranscriptionError(error.message, AUDIO_ERROR_KINDS[error.kind], error);
}

// Declared types that cannot be audio. When no audio format shows in the
// bytes either, the download was an error page or a picture: ffmpeg need not try.
const NOT_AUDIO = /^(?:text|image|font|model|multipart|message)\/|^application\/(?:json|xml|pdf|zip|[\w.+-]+\+(?:json|xml))$/;

/** Transcribe audio bytes: as is when Gemini reads the format (mp3, wav), else converted to MP3 first. */
export async function transcribeAudio(
  bytes: Buffer,
  declaredMime: string | null,
  deps: TranscribeDeps = {}
): Promise<Transcription> {
  if (bytes.length === 0) throw new TranscriptionError("There is no audio to transcribe", "unsupported");
  // Only the bytes decide what goes to Gemini untouched: a declared type can
  // be wrong, and garbage sent as audio can come back as an invented transcript.
  const detected = sniffAudioMime(bytes);
  const declared = mediaType(declaredMime);
  if (!detected && declared && NOT_AUDIO.test(declared)) {
    throw new TranscriptionError(`This is not audio (${declared})`, "unsupported");
  }
  const mimeType = detected ?? sniffAudioMime(bytes, declaredMime) ?? declared ?? "application/octet-stream";

  const asIs = detected === "audio/mpeg" ? "audio/mp3" : detected === "audio/wav" ? "audio/wav" : null;
  if (asIs && bytes.length <= MAX_INLINE_AUDIO_BYTES) {
    const transcript = await askGemini(bytes, asIs, deps);
    return { transcript, mimeType, converted: false };
  }

  // Any other format, and an MP3 or WAV too large to send inline: MP3 mono
  // 16 kHz at 32 kb/s takes about 4 KB a second, so it nearly always fits.
  let mp3: Buffer;
  try {
    mp3 = await toMp3Mono16k(bytes, { spawnImpl: deps.spawnImpl, maxOutputBytes: MAX_INLINE_AUDIO_BYTES });
  } catch (error) {
    throw fromAudioError(error);
  }
  const transcript = await askGemini(mp3, "audio/mp3", deps);
  return { transcript, mimeType, converted: true };
}

/** Download, then transcribe. maxBytes defaults to getFacebookAudioMaxBytes(); timeoutMs is the download's. */
export async function transcribeAudioUrl(
  url: string,
  options: { maxBytes?: number; timeoutMs?: number } = {},
  deps: TranscribeDeps = {}
): Promise<Transcription> {
  let audio: { bytes: Buffer; contentType: string | null };
  try {
    audio = await downloadAudio(
      url,
      { maxBytes: options.maxBytes ?? getFacebookAudioMaxBytes(), timeoutMs: options.timeoutMs },
      { fetchImpl: deps.fetchImpl }
    );
  } catch (error) {
    throw fromAudioError(error);
  }
  return transcribeAudio(audio.bytes, audio.contentType, deps);
}

async function askGemini(audio: Buffer, mimeType: "audio/mp3" | "audio/wav", deps: TranscribeDeps): Promise<string> {
  const generate = deps.generate ?? generateContent;
  let answer: string;
  try {
    const result = await generate({
      model: getGeminiTranscribeModel(),
      contents: [
        {
          role: "user",
          parts: [{ text: getGeminiTranscribePrompt() }, { inlineData: { mimeType, data: audio.toString("base64") } }],
        },
      ],
      // No temperature here: generateContent applies GEMINI_TEMPERATURE when
      // it is set, and Google advises keeping Gemini 3 models at their default.
      timeoutMs: GEMINI_TIMEOUT_MS,
    });
    answer = result.text;
  } catch (error) {
    if (error instanceof GeminiError) {
      throw new TranscriptionError(`Gemini could not transcribe the audio (${error.kind}): ${error.message}`, "ai_failed", error);
    }
    throw error;
  }

  const transcript = cleanTranscript(answer);
  if (isNoSpeech(transcript)) {
    const excerpt = transcript.length > 80 ? `${transcript.slice(0, 80)}…` : transcript;
    throw new TranscriptionError(`Gemini heard no speech${excerpt ? ` (it answered "${excerpt}")` : ""}`, "empty");
  }
  return transcript;
}

// ─── The answer ─────────────────────────────────────────────────────────────

// Bidi marks and zero-width characters count as edges too: an Arabic answer
// can start with one, which would hide the quote behind it.
const EDGES = /^[\s​-‏‪-‮⁦-⁩﻿]+|[\s​-‏‪-‮⁦-⁩﻿]+$/g;
const FENCED_BLOCK = /^```[^\n`]*\n([\s\S]*?)\n?```$/;
const FENCED_LINE = /^```([^`]*)```$/;
// Longest first, so ** is not taken for a pair of single *.
const WRAPPERS: [string, string][] = [
  ["**", "**"],
  ["*", "*"],
  ['"', '"'],
  ["'", "'"],
  ["`", "`"],
  ["“", "”"],
  ["”", "”"],
  ["„", "“"],
  ["«", "»"],
  ["»", "«"],
  ["‘", "’"],
  ["‹", "›"],
  ["「", "」"],
];

function unwrap(text: string): string | null {
  for (const [open, close] of WRAPPERS) {
    if (text.length < open.length + close.length || !text.startsWith(open) || !text.endsWith(close)) continue;
    const inner = text.slice(open.length, text.length - close.length);
    // «a» w «b»: these quotes belong to the words, not around the answer.
    if (inner.includes(open) || inner.includes(close)) return null;
    return inner;
  }
  return null;
}

/** The answer without what models wrap around it: code fences, quotes, emphasis. */
export function cleanTranscript(answer: string): string {
  let text = answer.replace(EDGES, "");
  for (;;) {
    const fenced = FENCED_BLOCK.exec(text) ?? FENCED_LINE.exec(text);
    const inner = fenced ? fenced[1] : unwrap(text);
    if (inner === null) return text;
    text = inner.replace(EDGES, "");
  }
}

// [inaudible], (silence), [موسيقى]...: what models write for sounds that are not words.
const TAGS = /\[[^\]]*\]|\([^)]*\)|（[^）]*）|【[^】]*】|<[^>]*>|\{[^}]*\}/g;

/** Lower case, accents and Arabic vowel marks dropped, hamza forms of alef as ا, punctuation as spaces. */
function forMatching(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/ـ/g, "")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/[’‘`´]/g, "'")
    .replace(/[^\p{L}\p{N}']+/gu, " ")
    .trim();
}

const EN_AUDIO = "(?:audio|audio file|audio clip|audio recording|recording|clip|file|message|voice message|voice note)";
const FR_AUDIO = "(?:audio|enregistrement|message vocal|message|vocal|fichier audio|fichier|clip|extrait)";
const AR_AUDIO = "(?:التسجيل الصوتي|التسجيل|المقطع الصوتي|المقطع|الصوت|الملف الصوتي|الملف|الرساله الصوتيه|الرساله)";

/**
 * Whole answers that only say no words were heard, in the languages the
 * model answers in. Anchored at both ends: a customer saying "I can't hear
 * you well" or "لا يوجد مشكل" is a real message.
 */
const NO_SPEECH: RegExp[] = [
  /^(?:inaudible|unintelligible|silence|no speech|no audio|no sound|no voice|no words|incomprehensible|aucun son|aucune parole|pas de parole|pas de son|صمت|صامت|سكوت|غير مسموع|غير واضح|لا كلام|بدون كلام|لا صوت|تسجيل فارغ)$/,
  new RegExp(
    `^(?:there (?:is|was|are|were) )?no (?:audible |clear |discernible |intelligible |recognizable |human |actual )?(?:speech|voice|voices|words?|talking|dialogue|spoken words?|spoken content|spoken language|audio|sound|sounds)(?: (?:detected|found|present|heard))?(?: (?:in|on) (?:this|the) ${EN_AUDIO})?$`
  ),
  new RegExp(
    `^(?:the |this )?${EN_AUDIO}(?: (?:is|was|seems|appears))?(?: to be)?(?: completely| entirely| totally)? (?:silent|empty|blank|inaudible|unintelligible)$`
  ),
  new RegExp(
    `^(?:sorry )?(?:i )?(?:can't|cannot|can not|couldn't|could not|am unable to|was unable to|am not able to|wasn't able to) (?:hear|understand|transcribe|make out|detect)(?: (?:any|the|this|anything))?(?: (?:speech|words?|voice|audio|recording|clip|message|content))?(?: (?:in|from|of) (?:this|the) ${EN_AUDIO})?$`
  ),
  new RegExp(
    `^(?:il n'y a )?(?:aucune?|pas de) (?:parole|paroles|voix|son|discours|mot|mots)(?: (?:audibles?|intelligibles?|claires?|clairs?|detectees?|detectes?))?(?: (?:dans|sur) (?:cet |ce |cette |le |la |l')${FR_AUDIO})?$`
  ),
  new RegExp(
    `^(?:l'|le |la |cet |ce |cette )${FR_AUDIO} (?:est )?(?:completement |totalement |entierement )?(?:vide|silencieux|silencieuse|inaudible|incomprehensible)$`
  ),
  new RegExp(
    `^(?:desole )?(?:je )?(?:ne peux pas|n'arrive pas a|ne parviens pas a|n'ai pas pu|ne suis pas en mesure de) (?:entendre|comprendre|transcrire)(?: (?:l'|le |la |les |cet |ce |cette )${FR_AUDIO}| les paroles| la voix)?$`
  ),
  new RegExp(
    `^لا (?:يوجد|توجد) (?:اي )?(?:كلام|صوت|حديث|كلمات|اصوات|محتوي صوتي)(?: (?:مسموع|مسموعه|واضح|واضحه|مفهوم|مفهومه))?(?: في (?:هذا |هذه )?${AR_AUDIO})?$`
  ),
  new RegExp(
    `^(?:هذا |هذه )?${AR_AUDIO} (?:فارغ|فارغه|صامت|صامته|غير واضح|غير واضحه|غير مسموع|غير مسموعه|لا يحتوي علي (?:اي )?كلام)$`
  ),
  new RegExp(
    `^(?:عذرا )?(?:لم|لا) (?:اتمكن|استطع|استطيع|يمكنني|اقدر)(?: من)? (?:سماع|فهم|تفريغ|كتابه|تمييز)(?: اي)?(?: (?:كلام|الكلام|الصوت|التسجيل|المقطع|كلمات|الكلمات|المحتوي|شيء))?(?: في (?:هذا |هذه )?${AR_AUDIO})?$`
  ),
];

/** True when a cleaned answer holds no words: empty, tags only, or the model saying it heard nothing. */
export function isNoSpeech(transcript: string): boolean {
  if (!/[\p{L}\p{N}]/u.test(transcript.replace(TAGS, ""))) return true;
  const plain = forMatching(transcript);
  // Real refusals are one short sentence; a longer answer is speech.
  return plain.length <= 120 && NO_SPEECH.some((pattern) => pattern.test(plain));
}
