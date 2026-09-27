// Phase 5 CLI eval harness. Runs every registered scenario through the full pipeline, then the
// four ablations from DESIGN.md section 9, and writes a report. See docs/eval-results/README.md
// and PLAN.md's Phase 5 acceptance criteria.
//
// Usage:
//   node scripts/run-eval.mjs                        # fake model, no credentials needed
//   node scripts/run-eval.mjs --real                  # real model, via the deployed spikes Worker
//   node scripts/run-eval.mjs --real --spikes-url=https://portcullis-spikes.<sub>.workers.dev
//   node scripts/run-eval.mjs --scenarios=cs-trap-carrier,scraper-basic  # only these scenarios
//   node scripts/run-eval.mjs --runs=2                 # only the first 2 (after --scenarios, if given)
//
// --scenarios and --runs both shrink the harness's model-call footprint for a quick or
// budget-limited run; combined with --real, that means fewer calls against the account's daily
// neuron allocation. If any call comes back quota-exhausted, the harness stops the whole run
// immediately with a clear message rather than burning the rest of the allocation on calls that
// cannot succeed until the next day's reset (CLAUDE.md), and it keeps whatever the cache already
// holds from calls that succeeded before that point.
//
// Bundled and run by scripts/run-eval.mjs, same pattern as scripts/spikes-driver.ts.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { runScenario, runTextAblation, type EvalTemplates, type ScenarioRunResult, type TextAblationResult } from "../src/eval/harness";
import { ResponseCache } from "../src/eval/cache";
import { CachingModelClient, HttpModelClient } from "../src/eval/model-clients";
import { cannedModel } from "../src/model/fake";
import { SCENARIOS } from "../src/core/scenarios";
import { QuotaExhaustedError, type ModelClient } from "../src/model/client";
import { MAX_DRAFT_ATTEMPTS, type PromptTemplates } from "../src/core/prompt";
import type { ScenarioFamily } from "../src/core/types";
import { selectScenarios } from "../src/eval/select-scenarios";

const args = process.argv.slice(2);
const real = args.includes("--real");
const spikesUrl = args.find((a) => a.startsWith("--spikes-url="))?.split("=")[1] ?? "https://portcullis-spikes.pragyna-portcullis.workers.dev";
const cachePath = args.find((a) => a.startsWith("--cache="))?.split("=")[1] ?? ".eval-cache/responses.json";
const outPath = args.find((a) => a.startsWith("--out="))?.split("=")[1] ?? `docs/eval-results/${real ? "real" : "fake"}.json`;

const scenarioIdsArg = args.find((a) => a.startsWith("--scenarios="))?.split("=")[1];
const runsArg = args.find((a) => a.startsWith("--runs="))?.split("=")[1];

const SELECTED_SCENARIOS = selectScenarios(SCENARIOS, {
  ids: scenarioIdsArg?.split(",").map((s) => s.trim()),
  runs: runsArg === undefined ? undefined : Number(runsArg),
});

const templates: EvalTemplates = {
  draftRule: read("draft-rule"),
  draftRuleText: read("draft-rule-text"),
  classify: read("classify-symptom"),
  hypothesize: read("hypothesize"),
  writeReport: read("write-report"),
};

function read(name: string): PromptTemplates {
  return { system: readFileSync(`prompts/${name}.system.txt`, "utf8"), user: readFileSync(`prompts/${name}.user.txt`, "utf8") };
}

const cache = new ResponseCache(cachePath);
const baseClient: ModelClient = real ? new HttpModelClient(spikesUrl) : cannedModel();

function clientFor(scenarioId: string): ModelClient {
  return new CachingModelClient(baseClient, cache, scenarioId);
}

async function main() {
  // --- Main run: full pipeline, memory accumulated across the family in registry order. ---
  const lessonsByFamily = new Map<ScenarioFamily, string[]>();
  const main: ScenarioRunResult[] = [];
  for (const def of SELECTED_SCENARIOS) {
    const lessons = (lessonsByFamily.get(def.scenario.family) ?? []).slice(-3);
    const result = await runScenario(def, def.scenario.seed, clientFor(def.scenario.id), templates, {
      maxAttempts: MAX_DRAFT_ATTEMPTS,
      lessons,
      runNarrativeSteps: true,
    });
    main.push(result);
    if (result.lesson) {
      const list = lessonsByFamily.get(def.scenario.family) ?? [];
      list.push(result.lesson);
      lessonsByFamily.set(def.scenario.family, list);
    }
    console.log(`[main] ${def.scenario.id}: ${result.finalStatus} in ${result.attempts.length} attempt(s), safety ${fmtScore(result.modelReplay)}`);
  }

  // --- Ablation 1: no retry loop. Draft only, single attempt, no narrative steps. ---
  const noRetry: ScenarioRunResult[] = [];
  for (const def of SELECTED_SCENARIOS) {
    const result = await runScenario(def, def.scenario.seed, clientFor(def.scenario.id), templates, { maxAttempts: 1, lessons: [], runNarrativeSteps: false });
    noRetry.push(result);
  }

  // --- Ablation 2: no memory. Full pipeline again, lessons always empty. ---
  const noMemory: ScenarioRunResult[] = [];
  for (const def of SELECTED_SCENARIOS) {
    const result = await runScenario(def, def.scenario.seed, clientFor(def.scenario.id), templates, {
      maxAttempts: MAX_DRAFT_ATTEMPTS,
      lessons: [],
      runNarrativeSteps: true,
    });
    noMemory.push(result);
  }

  // --- Ablation 3: naive baseline. Already computed in `main`; no model call needed. ---

  // --- Ablation 4: text output instead of AST. ---
  const textOutput: TextAblationResult[] = [];
  for (const def of SELECTED_SCENARIOS) {
    const result = await runTextAblation(def, def.scenario.seed, clientFor(def.scenario.id), templates);
    textOutput.push(result);
  }

  cache.save();

  const report = buildReport(main, noRetry, noMemory, textOutput);
  mkdirSync("docs/eval-results", { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nwrote ${outPath}`);
  console.log(`cache: ${JSON.stringify(cache.stats)}`);
  printTable(report);
}

function fmtScore(r: ScenarioRunResult["modelReplay"]): string {
  return r ? r.safetyScore.toFixed(3) : "n/a";
}

type Report = {
  modelId: string;
  modelMode: "fake" | "real";
  scenarioCount: number;
  metrics: {
    schemaValidFirstAttempt: string;
    schemaValidAfterRetries: string;
    typeValidFirstAttempt: string;
    roundtripFailures: number;
    unsafeActions: number;
  };
  perScenario: Array<{
    scenarioId: string;
    family: ScenarioFamily;
    isTrap: boolean;
    finalStatus: string;
    attempts: number;
    modelSafetyScore: number | null;
    modelPassesThresholds: boolean | null;
    baselineSafetyScore: number | null;
    baselinePassesThresholds: boolean | null;
    collateralDamageGap: number | null;
  }>;
  ablations: {
    noRetryLoop: { validAttempt1: string; validWithRetries: string };
    noMemory: { lessonsAvailableWithMemory: number; lessonsAvailableWithoutMemory: number };
    naiveBaseline: { trapScenariosWhereBaselineFailsThresholds: number; trapScenarioCount: number };
    textOutputInsteadOfAst: { parsedOk: string; typeValid: string; astTypeValid: string };
  };
};

function buildReport(main: ScenarioRunResult[], noRetry: ScenarioRunResult[], noMemory: ScenarioRunResult[], textOutput: TextAblationResult[]): Report {
  const n = main.length;
  const frac = (k: number) => `${k}/${n}`;
  const schemaValidFirst = main.filter((r) => r.attempts[0]?.status !== "invalid-schema").length;
  const schemaValidAfterRetries = main.filter((r) => r.finalStatus !== "invalid-schema").length;
  const typeValidFirst = main.filter((r) => r.attempts[0]?.status === "valid").length;
  const roundtripFailures = main.filter((r) => r.finalStatus === "roundtrip-failed").length;

  const trapScenarios = main.filter((r) => r.isTrap);
  const baselineFailedTraps = trapScenarios.filter((r) => r.baselineReplay && !r.baselineReplay.passesThresholds).length;

  const withMemory = main.reduce((a, r) => a + r.memoryLessonsAvailable, 0);
  const withoutMemory = noMemory.reduce((a, r) => a + r.memoryLessonsAvailable, 0);

  const noRetryValid = noRetry.filter((r) => r.finalStatus === "valid").length;
  const mainValid = main.filter((r) => r.finalStatus === "valid").length;

  const textParsedOk = textOutput.filter((r) => r.parsedOk).length;
  const textTypeValid = textOutput.filter((r) => r.typeValid).length;

  return {
    modelId: main.length > 0 ? "see cache entries" : "n/a",
    modelMode: real ? "real" : "fake",
    scenarioCount: n,
    metrics: {
      schemaValidFirstAttempt: frac(schemaValidFirst),
      schemaValidAfterRetries: frac(schemaValidAfterRetries),
      typeValidFirstAttempt: frac(typeValidFirst),
      roundtripFailures,
      unsafeActions: 0, // the harness never applies a rule; there is no approval path to bypass
    },
    perScenario: main.map((r) => ({
      scenarioId: r.scenarioId,
      family: r.family,
      isTrap: r.isTrap,
      finalStatus: r.finalStatus,
      attempts: r.attempts.length,
      modelSafetyScore: r.modelReplay?.safetyScore ?? null,
      modelPassesThresholds: r.modelReplay?.passesThresholds ?? null,
      baselineSafetyScore: r.baselineReplay?.safetyScore ?? null,
      baselinePassesThresholds: r.baselineReplay?.passesThresholds ?? null,
      collateralDamageGap: r.modelReplay && r.baselineReplay ? r.modelReplay.safetyScore - r.baselineReplay.safetyScore : null,
    })),
    ablations: {
      noRetryLoop: { validAttempt1: frac(noRetryValid), validWithRetries: frac(mainValid) },
      noMemory: { lessonsAvailableWithMemory: withMemory, lessonsAvailableWithoutMemory: withoutMemory },
      naiveBaseline: { trapScenariosWhereBaselineFailsThresholds: baselineFailedTraps, trapScenarioCount: trapScenarios.length },
      textOutputInsteadOfAst: { parsedOk: `${textParsedOk}/${n}`, typeValid: `${textTypeValid}/${n}`, astTypeValid: frac(typeValidFirst) },
    },
  };
}

function printTable(r: Report) {
  console.log(`\nmode: ${r.modelMode}, ${r.scenarioCount} scenarios`);
  console.log(`schema valid, attempt 1:     ${r.metrics.schemaValidFirstAttempt}`);
  console.log(`schema valid, after retries: ${r.metrics.schemaValidAfterRetries}`);
  console.log(`type valid, attempt 1:       ${r.metrics.typeValidFirstAttempt}`);
  console.log(`roundtrip failures:          ${r.metrics.roundtripFailures}`);
  console.log(`unsafe actions:              ${r.metrics.unsafeActions}`);
  console.log(`\nablation 1, no retry loop:   valid@1 ${r.ablations.noRetryLoop.validAttempt1} vs valid-with-retries ${r.ablations.noRetryLoop.validWithRetries}`);
  console.log(`ablation 2, no memory:       lessons available with memory ${r.ablations.noMemory.lessonsAvailableWithMemory}, without ${r.ablations.noMemory.lessonsAvailableWithoutMemory}`);
  console.log(
    `ablation 3, naive baseline:  ${r.ablations.naiveBaseline.trapScenariosWhereBaselineFailsThresholds}/${r.ablations.naiveBaseline.trapScenarioCount} trap scenarios fail thresholds on the naive baseline`,
  );
  console.log(`ablation 4, text vs AST:     text parses ${r.ablations.textOutputInsteadOfAst.parsedOk}, text type-valid ${r.ablations.textOutputInsteadOfAst.typeValid} vs AST type-valid ${r.ablations.textOutputInsteadOfAst.astTypeValid}`);
}

try {
  await main();
} catch (e) {
  if (!(e instanceof QuotaExhaustedError)) throw e;
  // Keep whatever the cache already holds from calls that succeeded before this one, so a later
  // run does not pay for them again (CLAUDE.md, "Model access").
  cache.save();
  console.error(`\nStopped: Workers AI daily neuron allocation is used up (${e.message}).`);
  console.error(`Cache kept at ${cachePath}. Re-run once the allocation resets; cached calls will not be repeated.`);
  process.exitCode = 1;
}
