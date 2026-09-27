// Phase 5 eval harness core. Runs one scenario through the same pipeline production uses
// (aggregate, baseline, draft, verify, replay, and the Phase 4 narrative steps), against
// whatever ModelClient it is given (fake, cached-real, or real). Kept free of file I/O and
// process.argv so it is directly testable; scripts/eval-driver.ts is the CLI that wires it up.
//
// The narrative-step parsing (classify/hypothesize/write-report) duplicates the small amount of
// parsing logic in src/server/agent.ts rather than importing it: agent.ts needs a Durable
// Object's SQLite for its evidence lookups and lesson storage, which does not exist here. The
// harness keeps its own evidence ID set and lesson list per run instead.

import { aggregateChunk, finalizeSummary } from "../core/aggregator";
import { naiveBaseline } from "../core/baseline";
import { CLASSIFY_JSON_SCHEMA, HYPOTHESIZE_JSON_SCHEMA, TEXT_RULE_JSON_SCHEMA, WRITE_REPORT_JSON_SCHEMA, isClassifyIntent } from "../core/narrative-schema";
import { CHUNK_SIZE, planChunks } from "../core/chunks";
import { buildClassifyPrompt, buildDraftRulePrompt, buildHypothesizePrompt, buildReportPrompt, type PriorAttempt, type PromptTemplates } from "../core/prompt";
import { checkCitations } from "../core/citations";
import { compileRule, replayChunk } from "../core/rules/evaluate";
import { checkRuleText, modelFailureOutcome, verifyModelDraft, type DraftOutcome } from "../core/rules/pipeline";
import { RULE_JSON_SCHEMA } from "../core/rules/schema";
import { safetyScore, toReplayResult } from "../core/replay";
import type { ScenarioDefinition } from "../core/scenarios";
import { generateAll } from "../core/simulator";
import type { ReplayResult, RuleVersionStatus, ScenarioFamily } from "../core/types";
import { QuotaExhaustedError, type ModelClient, type ModelResponse } from "../model/client";

export type EvalTemplates = {
  draftRule: PromptTemplates;
  draftRuleText: PromptTemplates;
  classify: PromptTemplates;
  hypothesize: PromptTemplates;
  writeReport: PromptTemplates;
};

export type DraftAttemptResult = { attempt: number; status: RuleVersionStatus; diagnosticCodes: string[] };

export type ScenarioRunResult = {
  scenarioId: string;
  family: ScenarioFamily;
  isTrap: boolean;
  totalRequests: number;
  attempts: DraftAttemptResult[];
  finalStatus: RuleVersionStatus;
  modelReplay: ReplayResult | null;
  baselineReplay: ReplayResult | null;
  latencyMs: number;
  /** Requests / CHUNK_SIZE, rounded up: the chunk count production would use. Not measured CPU. */
  chunksEstimate: number;
  memoryLessonsAvailable: number;
  hypothesisFabricated: boolean;
  lesson: string | null;
};

/**
 * A quota-exhausted response means the account cannot succeed again until the daily reset:
 * stopping the whole harness run cleanly (main() catches this) is the only thing worth doing,
 * rather than burning the rest of a scenario's retries, the rest of the scenarios, or the
 * ablations on calls that are guaranteed to fail the same way. CLAUDE.md: never retry a quota
 * error, at any level.
 */
function assertNotQuotaExhausted(response: ModelResponse): void {
  if (response.kind === "quota-exhausted") throw new QuotaExhaustedError(response.message);
}

function outcomeFromResponse(response: ModelResponse): DraftOutcome {
  assertNotQuotaExhausted(response);
  if (response.kind === "ok") return verifyModelDraft(response.raw);
  if (response.kind === "json-mode-failed") return modelFailureOutcome("json-mode-failed", response.message);
  return modelFailureOutcome("error", response.message);
}

function parseClassifyIntent(response: ModelResponse): string {
  if (response.kind !== "ok") return "unknown";
  try {
    const parsed = JSON.parse(response.raw) as unknown;
    if (parsed && typeof parsed === "object" && "intent" in parsed && isClassifyIntent((parsed as { intent: unknown }).intent)) {
      return (parsed as { intent: string }).intent;
    }
  } catch {
    // falls through
  }
  return "unknown";
}

function parseHypothesis(response: ModelResponse, knownEvidenceIds: ReadonlySet<string>): { hypothesis: string | null; fabricated: boolean } {
  if (response.kind !== "ok") return { hypothesis: null, fabricated: false };
  let text: string | null = null;
  try {
    const parsed = JSON.parse(response.raw) as unknown;
    if (parsed && typeof parsed === "object" && "hypothesis" in parsed && typeof (parsed as { hypothesis: unknown }).hypothesis === "string") {
      text = (parsed as { hypothesis: string }).hypothesis;
    }
  } catch {
    // text stays null
  }
  if (text === null) return { hypothesis: null, fabricated: false };
  const check = checkCitations(text, knownEvidenceIds);
  if (!check.ok) return { hypothesis: null, fabricated: true };
  return { hypothesis: text, fabricated: false };
}

function parseReportLesson(response: ModelResponse): string | null {
  if (response.kind !== "ok") return null;
  try {
    const parsed = JSON.parse(response.raw) as unknown;
    if (parsed && typeof parsed === "object" && "lesson" in parsed && typeof (parsed as { lesson: unknown }).lesson === "string") {
      return (parsed as { lesson: string }).lesson;
    }
  } catch {
    // falls through
  }
  return null;
}

export type ScenarioRunOptions = {
  /** MAX_DRAFT_ATTEMPTS in production; the "no retry loop" ablation sets this to 1. */
  maxAttempts: number;
  /** Prior lessons for this scenario's family; the "no memory" ablation always passes []. */
  lessons: readonly string[];
  /** Skip the classify/hypothesize/write-report calls entirely (used by ablations that only care about the draft). */
  runNarrativeSteps: boolean;
};

/** Runs one scenario through the full pipeline: aggregate, baseline, draft (with retries), replay, narrative steps. */
export async function runScenario(def: ScenarioDefinition, seed: number, model: ModelClient, templates: EvalTemplates, opts: ScenarioRunOptions): Promise<ScenarioRunResult> {
  const t0 = Date.now();
  const traffic = generateAll(def, seed);
  const summary = finalizeSummary(aggregateChunk(traffic, def.scenario.durationMs, def.scenario.symptomStatus), traffic.dictionary);

  const baselineChoice = naiveBaseline(summary);
  let baselineReplay: ReplayResult | null = null;
  if (baselineChoice) {
    const compiled = compileRule(baselineChoice.ast, traffic.dictionary);
    if (compiled.ok) {
      baselineReplay = toReplayResult(replayChunk(compiled.rule, traffic, def.scenario.durationMs).counts, def.scenario.thresholds, "eval-baseline");
    }
  }

  const priorAttempts: PriorAttempt[] = [];
  const attempts: DraftAttemptResult[] = [];
  let finalOutcome: DraftOutcome | null = null;
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    const prompt = buildDraftRulePrompt(templates.draftRule, { symptom: def.scenario.symptom, summary, priorAttempts });
    const response = await model.generateJson({ ...prompt, purpose: "draft-rule", jsonSchema: RULE_JSON_SCHEMA });
    const outcome = outcomeFromResponse(response);
    attempts.push({ attempt, status: outcome.status, diagnosticCodes: outcome.diagnostics.map((d) => d.code) });
    finalOutcome = outcome;
    if (outcome.status === "valid" || outcome.status === "roundtrip-failed") break;
    if (attempt === opts.maxAttempts) break;
    priorAttempts.push({ raw: response.kind === "ok" ? response.raw : "", diagnostics: outcome.diagnostics });
  }
  if (!finalOutcome) throw new Error("maxAttempts must be >= 1");

  let modelReplay: ReplayResult | null = null;
  if (finalOutcome.status === "valid" && finalOutcome.ast) {
    const compiled = compileRule(finalOutcome.ast, traffic.dictionary);
    if (compiled.ok) {
      modelReplay = toReplayResult(replayChunk(compiled.rule, traffic, def.scenario.durationMs).counts, def.scenario.thresholds, "eval-model");
    }
  }

  let hypothesisFabricated = false;
  let lesson: string | null = null;
  if (opts.runNarrativeSteps) {
    const evidenceIds = new Set<string>([...summary.breakdowns, ...summary.symptomSlice.breakdowns].map((b) => b.evidenceId));

    const classifyPrompt = buildClassifyPrompt(templates.classify, { symptom: def.scenario.symptom, signals: summary.signals });
    const classifyResponse = await model.generateJson({ ...classifyPrompt, purpose: "classify-symptom", jsonSchema: CLASSIFY_JSON_SCHEMA });
    assertNotQuotaExhausted(classifyResponse);
    const intent = parseClassifyIntent(classifyResponse);

    const hypothesizePrompt = buildHypothesizePrompt(templates.hypothesize, { symptom: def.scenario.symptom, intent, summary, lessons: opts.lessons });
    const hypothesizeResponse = await model.generateJson({ ...hypothesizePrompt, purpose: "hypothesize", jsonSchema: HYPOTHESIZE_JSON_SCHEMA });
    assertNotQuotaExhausted(hypothesizeResponse);
    const { hypothesis, fabricated } = parseHypothesis(hypothesizeResponse, evidenceIds);
    hypothesisFabricated = fabricated;

    const outcomeForReport = { proposedRule: modelReplay, approved: modelReplay?.passesThresholds ?? false };
    const reportPrompt = buildReportPrompt(templates.writeReport, { symptom: def.scenario.symptom, hypothesis, outcome: outcomeForReport });
    const reportResponse = await model.generateJson({ ...reportPrompt, purpose: "write-report", jsonSchema: WRITE_REPORT_JSON_SCHEMA });
    assertNotQuotaExhausted(reportResponse);
    lesson = parseReportLesson(reportResponse);
  }

  return {
    scenarioId: def.scenario.id,
    family: def.scenario.family,
    isTrap: def.scenario.isTrap,
    totalRequests: summary.totalRequests,
    attempts,
    finalStatus: finalOutcome.status,
    modelReplay,
    baselineReplay,
    latencyMs: Date.now() - t0,
    chunksEstimate: planChunks(def.scenario.requestCount, CHUNK_SIZE).length,
    memoryLessonsAvailable: opts.lessons.length,
    hypothesisFabricated,
    lesson,
  };
}

export type TextAblationResult = {
  scenarioId: string;
  parsedOk: boolean;
  typeValid: boolean;
  diagnosticCodes: string[];
  latencyMs: number;
};

/** Ablation 4: ask for the rule as literal text instead of the flat AST, and parse it for real. */
export async function runTextAblation(def: ScenarioDefinition, seed: number, model: ModelClient, templates: EvalTemplates): Promise<TextAblationResult> {
  const t0 = Date.now();
  const traffic = generateAll(def, seed);
  const summary = finalizeSummary(aggregateChunk(traffic, def.scenario.durationMs, def.scenario.symptomStatus), traffic.dictionary);
  const prompt = buildDraftRulePrompt(templates.draftRuleText, { symptom: def.scenario.symptom, summary });
  const response = await model.generateJson({ ...prompt, purpose: "draft-rule-text", jsonSchema: TEXT_RULE_JSON_SCHEMA });
  assertNotQuotaExhausted(response);
  if (response.kind !== "ok") {
    return { scenarioId: def.scenario.id, parsedOk: false, typeValid: false, diagnosticCodes: [response.kind], latencyMs: Date.now() - t0 };
  }
  let ruleText: string | null = null;
  try {
    const parsed = JSON.parse(response.raw) as unknown;
    if (parsed && typeof parsed === "object" && "rule" in parsed && typeof (parsed as { rule: unknown }).rule === "string") {
      ruleText = (parsed as { rule: string }).rule;
    }
  } catch {
    // ruleText stays null
  }
  if (ruleText === null) {
    return { scenarioId: def.scenario.id, parsedOk: false, typeValid: false, diagnosticCodes: ["E_JSON_SHAPE"], latencyMs: Date.now() - t0 };
  }
  const checked = checkRuleText(ruleText);
  const errored = checked.diagnostics.some((d) => d.severity === "error");
  return {
    scenarioId: def.scenario.id,
    parsedOk: checked.ast !== null,
    typeValid: checked.ast !== null && !errored,
    diagnosticCodes: checked.diagnostics.map((d) => d.code),
    latencyMs: Date.now() - t0,
  };
}

export { safetyScore };
