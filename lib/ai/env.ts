/**
 * Settings of the AI features (the Messenger bot and voice transcription).
 * GOOGLE_API_KEY stays on the server; nothing here reaches the browser.
 */
import { readIntEnv } from "@/lib/facebook/env";

export const DEFAULT_GEMINI_MODEL = "gemini-flash-latest";

/** The transcription instruction, word for word as asked. */
export const DEFAULT_TRANSCRIBE_PROMPT =
  "اكتب كلام هذا الشخص كما قاله، بالدارجة الجزائرية أو الفرنسية أو العربية";

function read(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

/** A model name, with or without the "models/" prefix the API uses. */
function modelName(value: string | null): string {
  return (value ?? DEFAULT_GEMINI_MODEL).replace(/^models\//, "");
}

export function getGoogleApiKey(): string | null {
  return read("GOOGLE_API_KEY");
}

export function getGeminiChatModel(): string {
  return modelName(read("GEMINI_CHAT_MODEL"));
}

export function getGeminiTranscribeModel(): string {
  return modelName(read("GEMINI_TRANSCRIBE_MODEL"));
}

export function getGeminiTranscribePrompt(): string {
  return read("GEMINI_TRANSCRIBE_PROMPT") ?? DEFAULT_TRANSCRIBE_PROMPT;
}

/**
 * Left to the model unless set: Google advises keeping Gemini 3 models at
 * their default temperature, and lower values can degrade their answers.
 */
export function getGeminiTemperature(): number | undefined {
  const raw = read("GEMINI_TEMPERATURE");
  if (raw === null) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= 2 ? value : undefined;
}

/** How long the bot waits for a person to finish typing before it answers. */
export function getBotDebounceMs(): number {
  return readIntEnv("BOT_DEBOUNCE_MS", 7000, { min: 0, max: 60_000 });
}

/** Messages of the conversation the bot reads before answering. */
export function getBotHistoryMessages(): number {
  return readIntEnv("BOT_HISTORY_MESSAGES", 20, { min: 1, max: 50 });
}

/** Product cards given in full to the model in one answer (the others are only in the index). */
export function getBotMaxFullCards(): number {
  return readIntEnv("BOT_MAX_FULL_CARDS", 8, { min: 1, max: 20 });
}
