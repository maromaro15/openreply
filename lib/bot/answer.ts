/**
 * One bot answer: prompt, Gemini, then the code's decision. Shared by the
 * Messenger worker and the "try the bot" box, which sends nothing.
 *
 * Any failure of the AI service ends in a handoff, never in silence and
 * never in a guess.
 */
import { getGeminiChatModel, getGoogleApiKey } from "@/lib/ai/env";
import { GeminiError, generateJson, type GenerateOptions } from "@/lib/ai/gemini";
import { decide, readCustomer, SYSTEM_REASONS, type BotDecision } from "./classify";
import { knowledgeTexts } from "./knowledge";
import type { CustomerStateValue } from "./persona";
import { BOT_RESPONSE_SCHEMA, buildBotRequest, guardSources, type PromptInput } from "./prompt";
import { applyCorrections } from "@/lib/voice/select";

/** The model's JSON with the brand's dictionary applied to its reply, before the guard reads it. */
export function correctedOutput(data: unknown, input: Pick<PromptInput, "voice">): unknown {
  const corrections = input.voice?.corrections ?? [];
  if (corrections.length === 0 || !data || typeof data !== "object" || Array.isArray(data)) return data;
  const output = data as Record<string, unknown>;
  return typeof output.reply === "string" ? { ...output, reply: applyCorrections(output.reply, corrections) } : data;
}

export interface BotAnswer {
  decision: BotDecision;
  /** What the model read of the customer, even when it handed off. */
  customerState: CustomerStateValue | null;
  order: Record<string, unknown> | null;
  /** Pictures or comparisons the model asked for, unchecked. */
  actions: unknown[];
  /** The model's JSON as it came (the rewrite's, after one), for the "try the bot" box. */
  modelOutput: unknown;
  /** Why the AI call failed, when it did. */
  error: string | null;
  /** 2 when the guard refused the first reply and the model was asked to rewrite it. */
  attempts: number;
}

/** What the model is told when the guard refused its reply: once, then a person answers. */
export function rewriteRequest(decision: Extract<BotDecision, { kind: "handoff" }>): string {
  const what = decision.detail ? `${decision.reason} (${decision.detail})` : decision.reason;
  return [
    `Your reply was not sent: ${what}`,
    "Write it again without that, using only the knowledge base, the catalog and the shop's instructions, or hand off.",
    "Answer with the same JSON.",
  ].join(" ");
}

export async function answerCustomer(
  input: PromptInput,
  { generate = generateJson }: { generate?: typeof generateJson } = {}
): Promise<BotAnswer> {
  if (!getGoogleApiKey()) {
    return {
      decision: { kind: "handoff", category: "OTHER", reason: SYSTEM_REASONS.aiMissing, source: "system" },
      customerState: null,
      order: null,
      actions: [],
      modelOutput: null,
      error: "missing_key",
      attempts: 0,
    };
  }

  const request = buildBotRequest(input);
  const options: GenerateOptions & { responseSchema: Record<string, unknown> } = {
    model: getGeminiChatModel(),
    systemInstruction: request.systemInstruction,
    contents: request.contents,
    responseSchema: BOT_RESPONSE_SCHEMA as unknown as Record<string, unknown>,
  };

  const sources = guardSources(input, knowledgeTexts(input.knowledge));
  try {
    const data = correctedOutput((await generate(options)).data, input);
    const decision = decide(data, sources);
    if (decision.kind === "handoff" && decision.source === "guard") {
      // One chance to rewrite, told why; refused again, a person answers.
      try {
        const retried = await generate({
          ...options,
          contents: [
            ...options.contents,
            { role: "model", parts: [{ text: JSON.stringify(data) }] },
            { role: "user", parts: [{ text: rewriteRequest(decision) }] },
          ],
        });
        const retry = correctedOutput(retried.data, input);
        return {
          decision: decide(retry, sources),
          ...readCustomer(retry),
          modelOutput: retry,
          error: null,
          attempts: 2,
        };
      } catch {
        // The rewrite could not be had: the guard's handoff stands.
        return { decision, ...readCustomer(data), modelOutput: data, error: null, attempts: 2 };
      }
    }
    return { decision, ...readCustomer(data), modelOutput: data, error: null, attempts: 1 };
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
      customerState: null,
      order: null,
      actions: [],
      modelOutput: null,
      error: error instanceof Error ? `${kind}: ${error.message}` : kind,
      attempts: 1,
    };
  }
}
