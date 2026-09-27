// The single interface every model call goes through. One production implementation
// (workers-ai.ts) and one fake (fake.ts). CLAUDE.md, "Model access".

import type { Prompt } from "../core/prompt";

export type ModelRequest = Prompt & {
  /** What the call is for. Used for logging and for the eval cache key. */
  purpose: "draft-rule" | "draft-rule-text" | "classify-symptom" | "hypothesize" | "write-report";
  jsonSchema: object;
};

/**
 * Tokens billed for one call, and the neurons they cost on this model's published rate.
 * `maxTokens` is the completion cap the request was sent with (a request-side constant, not
 * something the model reports), carried here so a caller with only the response in hand can tell
 * whether the call was cut off. See `hitMaxTokens` in `RuleVersion["usage"]`.
 */
export type ModelUsage = { promptTokens: number; completionTokens: number; neurons: number; maxTokens: number };

export type ModelResponse =
  /** The raw text the model returned. Not yet validated: data under suspicion. */
  | { kind: "ok"; raw: string; usage?: ModelUsage | null }
  /** Workers AI's documented "JSON Mode couldn't be met". Treated as a schema failure. */
  | { kind: "json-mode-failed"; message: string }
  /** HTTP 429 or Workers AI 3040 (out of capacity): transient, worth backing off from. */
  | { kind: "rate-limited"; message: string }
  /**
   * Workers AI 3036/4006: the account's daily free neuron allocation is used up. Distinct from
   * "rate-limited" on purpose: a daily allocation does not refill on a step's retry timescale, so
   * treating it as transient just spends the rest of the day's allocation on retries that cannot
   * succeed. See CLAUDE.md and docs/spikes.md 0.1.
   */
  | { kind: "quota-exhausted"; message: string }
  | { kind: "error"; message: string };

export interface ModelClient {
  readonly modelId: string;
  generateJson(request: ModelRequest): Promise<ModelResponse>;
}

/** Thrown by requireOkResponse for a `quota-exhausted` response, so callers can tell it apart
 * from a transient failure and refuse to retry it, rather than relying on message sniffing. */
export class QuotaExhaustedError extends Error {}

/**
 * The draft-rule step has no diagnostic feedback loop for a transport failure (only for a
 * schema/type failure), so a rate limit, quota error, or a provider error is not retried at the
 * prompt level: it throws, which the Workflow's own step retry policy (backoff, then eventually
 * fail the incident visibly) handles instead -- except `quota-exhausted`, which throws
 * `QuotaExhaustedError` so the caller can refuse to retry it at all (CLAUDE.md: "a 3036 error is
 * never retried, at any level"). `json-mode-failed` is not thrown here: DESIGN.md treats it as a
 * schema failure, so the caller feeds it back into the retry loop like any other one.
 */
export function requireOkResponse(
  response: ModelResponse,
): asserts response is Exclude<ModelResponse, { kind: "rate-limited" } | { kind: "quota-exhausted" } | { kind: "error" }> {
  if (response.kind === "quota-exhausted") {
    throw new QuotaExhaustedError(`model call failed (quota-exhausted): ${response.message}`);
  }
  if (response.kind === "rate-limited" || response.kind === "error") {
    throw new Error(`model call failed (${response.kind}): ${response.message}`);
  }
}
