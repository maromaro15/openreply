/**
 * One bot answer: prompt, Gemini, then the code's decision. Shared by the
 * Messenger worker and the "try the bot" box, which sends nothing.
 *
 * Any failure of the AI service ends in a handoff, never in silence and
 * never in a guess.
 */
import { getGeminiChatModel, getGoogleApiKey } from "@/lib/ai/env";
import { GeminiError, generateJson, type GenerateOptions } from "@/lib/ai/gemini";
import { decide, SYSTEM_REASONS, type BotDecision } from "./classify";
import { knowledgeTexts } from "./knowledge";
import { BOT_RESPONSE_SCHEMA, buildBotRequest, referenceTexts, type PromptInput } from "./prompt";

export interface BotAnswer {
  decision: BotDecision;
  /** The model's JSON as it came, for the "try the bot" box. */
  modelOutput: unknown;
  /** Why the AI call failed, when it did. */
  error: string | null;
}

export async function answerCustomer(
  input: PromptInput,
  { generate = generateJson }: { generate?: typeof generateJson } = {}
): Promise<BotAnswer> {
  if (!getGoogleApiKey()) {
    return {
      decision: { kind: "handoff", category: "OTHER", reason: SYSTEM_REASONS.aiMissing, source: "system" },
      modelOutput: null,
      error: "missing_key",
    };
  }

  const request = buildBotRequest(input);
  const options: GenerateOptions & { responseSchema: Record<string, unknown> } = {
    model: getGeminiChatModel(),
    systemInstruction: request.systemInstruction,
    contents: request.contents,
    responseSchema: BOT_RESPONSE_SCHEMA as unknown as Record<string, unknown>,
  };

  try {
    const { data } = await generate(options);
    return {
      decision: decide(data, referenceTexts(input, knowledgeTexts(input.knowledge))),
      modelOutput: data,
      error: null,
    };
  } catch (error) {
    const kind = error instanceof GeminiError ? error.kind : "unavailable";
    const reason =
      kind === "missing_key"
        ? SYSTEM_REASONS.aiMissing
        : kind === "blocked"
          ? SYSTEM_REASONS.aiBlocked
          : kind === "invalid_response"
            ? SYSTEM_REASONS.invalidAnswer
            : SYSTEM_REASONS.aiUnavailable;
    return {
      decision: { kind: "handoff", category: "OTHER", reason, source: "system", detail: kind },
      modelOutput: null,
      error: error instanceof Error ? `${kind}: ${error.message}` : kind,
    };
  }
}
