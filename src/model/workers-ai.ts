// Workers AI implementation of ModelClient, using JSON mode with a JSON Schema.
// JSON mode does not support streaming (Workers AI docs), so this call never streams.

import type { ModelClient, ModelRequest, ModelResponse, ModelUsage } from "./client";

/** The subset of the AI binding this file uses, so the fake and tests need no Ai type. */
export type AiRunner = { run(model: string, inputs: Record<string, unknown>): Promise<unknown> };

// docs/spikes.md 0.1: this model's published Workers AI price, per million tokens.
const NEURONS_PER_MILLION_INPUT_TOKENS = 26_668;
const NEURONS_PER_MILLION_OUTPUT_TOKENS = 204_805;

/**
 * The completion cap sent with every call, regardless of purpose. Not part of the JSON schema or
 * prompt this change leaves untouched -- a transport parameter, recorded so a caller can compare
 * it against `completion_tokens` and tell a truncated draft from a short one. Workers AI's
 * JSON-mode response for this model has no finish-reason field (checked against the current docs
 * mirror, cloudflare/cloudflare-docs, 2026-09-27), so that comparison is the only way to tell.
 */
export const MAX_TOKENS = 1024;

export function neuronsForUsage(promptTokens: number, completionTokens: number): number {
  return (promptTokens / 1_000_000) * NEURONS_PER_MILLION_INPUT_TOKENS + (completionTokens / 1_000_000) * NEURONS_PER_MILLION_OUTPUT_TOKENS;
}

export class WorkersAiModelClient implements ModelClient {
  constructor(
    private readonly ai: AiRunner,
    readonly modelId: string,
  ) {}

  async generateJson(request: ModelRequest): Promise<ModelResponse> {
    let result: unknown;
    try {
      result = await this.ai.run(this.modelId, {
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.user },
        ],
        response_format: { type: "json_schema", json_schema: request.jsonSchema },
        max_tokens: MAX_TOKENS,
        temperature: 0,
      });
    } catch (e) {
      return classifyError(e);
    }
    return toResponse(result);
  }
}

function usageFrom(result: object): ModelUsage | null {
  if (!("usage" in result)) return null;
  const usage = (result as { usage: unknown }).usage;
  if (typeof usage !== "object" || usage === null) return null;
  const promptTokens = (usage as { prompt_tokens?: unknown }).prompt_tokens;
  const completionTokens = (usage as { completion_tokens?: unknown }).completion_tokens;
  if (typeof promptTokens !== "number" || typeof completionTokens !== "number") return null;
  return { promptTokens, completionTokens, neurons: neuronsForUsage(promptTokens, completionTokens), maxTokens: MAX_TOKENS };
}

export function toResponse(result: unknown): ModelResponse {
  if (typeof result !== "object" || result === null || !("response" in result)) {
    return { kind: "error", message: "Workers AI returned no response field" };
  }
  const response = (result as { response: unknown }).response;
  const usage = usageFrom(result);
  // JSON mode returns the parsed object; plain mode returns a string. Keep whatever came back
  // as a string: rawModelOutput is kept verbatim for audit, and parsing is the decoder's job.
  if (typeof response === "string") return { kind: "ok", raw: response, usage };
  if (response === null || response === undefined) return { kind: "error", message: "empty response" };
  return { kind: "ok", raw: JSON.stringify(response), usage };
}

export function classifyError(e: unknown): ModelResponse {
  const message = e instanceof Error ? e.message : String(e);
  if (/JSON Mode couldn't be met/i.test(message)) return { kind: "json-mode-failed", message };
  // 3036 is Cloudflare's documented "daily free neuron allocation used up" code (Workers AI
  // platform/errors.mdx). 4006 is not in that page; it is what this account observed for the same
  // condition (docs/spikes.md 0.1, docs/eval-results/README.md), so it is treated the same way.
  // Both are a standing condition for the rest of the day, never worth retrying. 429 and 3040 (out
  // of capacity, documented) are transient and worth backing off from instead.
  if (/\b(3036|4006)\b/.test(message)) return { kind: "quota-exhausted", message };
  if (/\b(429|3040)\b|rate.?limit|capacity/i.test(message)) return { kind: "rate-limited", message };
  return { kind: "error", message };
}
