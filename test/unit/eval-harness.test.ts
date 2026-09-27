import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ResponseCache } from "../../src/eval/cache";
import { CachingModelClient } from "../../src/eval/model-clients";
import { runScenario, runTextAblation, type EvalTemplates } from "../../src/eval/harness";
import { MAX_DRAFT_ATTEMPTS } from "../../src/core/prompt";
import { cannedModel, FakeModelClient } from "../../src/model/fake";
import { QuotaExhaustedError, type ModelClient, type ModelRequest, type ModelResponse } from "../../src/model/client";
import { smallScenario } from "./helpers";

function readTemplate(name: string) {
  return { system: readFileSync(`prompts/${name}.system.txt`, "utf8"), user: readFileSync(`prompts/${name}.user.txt`, "utf8") };
}

const templates: EvalTemplates = {
  draftRule: readTemplate("draft-rule"),
  draftRuleText: readTemplate("draft-rule-text"),
  classify: readTemplate("classify-symptom"),
  hypothesize: readTemplate("hypothesize"),
  writeReport: readTemplate("write-report"),
};

describe("eval harness (Phase 5)", () => {
  const def = smallScenario(500);

  it("runs a scenario end to end against the fake model: schema-valid, replayed, narrative steps recorded", async () => {
    const result = await runScenario(def, def.scenario.seed, cannedModel(), templates, { maxAttempts: MAX_DRAFT_ATTEMPTS, lessons: [], runNarrativeSteps: true });
    expect(result.finalStatus).toBe("valid");
    expect(result.attempts).toHaveLength(1);
    expect(result.modelReplay).not.toBeNull();
    expect(result.baselineReplay).not.toBeNull();
    expect(result.hypothesisFabricated).toBe(false);
    expect(result.lesson).not.toBeNull();
  });

  it("no-retry-loop ablation (maxAttempts=1) stops after one attempt even if it fails", async () => {
    const alwaysBadSchema = new FakeModelClient(() => ({ kind: "ok", raw: "not json" }));
    const result = await runScenario(def, def.scenario.seed, alwaysBadSchema, templates, { maxAttempts: 1, lessons: [], runNarrativeSteps: false });
    expect(result.attempts).toHaveLength(1);
    expect(result.finalStatus).toBe("invalid-schema");
    expect(result.modelReplay).toBeNull();
  });

  it("the retry loop feeds diagnostics forward and can recover by the final attempt", async () => {
    let call = 0;
    const script: ModelClient = {
      modelId: "test",
      async generateJson(request: ModelRequest): Promise<ModelResponse> {
        call++;
        if (request.purpose !== "draft-rule") throw new Error("unexpected purpose");
        if (call < 3) return { kind: "ok", raw: "not json" };
        return (await cannedModel().generateJson(request)) as ModelResponse;
      },
    };
    const result = await runScenario(def, def.scenario.seed, script, templates, { maxAttempts: MAX_DRAFT_ATTEMPTS, lessons: [], runNarrativeSteps: false });
    expect(result.attempts.map((a) => a.status)).toEqual(["invalid-schema", "invalid-schema", "valid"]);
    expect(result.finalStatus).toBe("valid");
  });

  it("memory ablation: lessons passed in are reported back on the result, unchanged", async () => {
    const withMemory = await runScenario(def, def.scenario.seed, cannedModel(), templates, { maxAttempts: 1, lessons: ["a prior lesson"], runNarrativeSteps: false });
    const withoutMemory = await runScenario(def, def.scenario.seed, cannedModel(), templates, { maxAttempts: 1, lessons: [], runNarrativeSteps: false });
    expect(withMemory.memoryLessonsAvailable).toBe(1);
    expect(withoutMemory.memoryLessonsAvailable).toBe(0);
  });

  it("a hypothesis citing a fabricated evidence ID is caught and not surfaced", async () => {
    const canned = cannedModel();
    const fabricating: ModelClient = {
      modelId: "fake",
      async generateJson(request: ModelRequest): Promise<ModelResponse> {
        if (request.purpose === "hypothesize") return { kind: "ok", raw: JSON.stringify({ hypothesis: "cites (ev_nonexistent)" }) };
        return canned.generateJson(request);
      },
    };
    const result = await runScenario(def, def.scenario.seed, fabricating, templates, { maxAttempts: 1, lessons: [], runNarrativeSteps: true });
    expect(result.hypothesisFabricated).toBe(true);
  });

  it("text-output ablation: valid text parses and type-checks", async () => {
    const result = await runTextAblation(def, def.scenario.seed, cannedModel(), templates);
    expect(result.parsedOk).toBe(true);
    expect(result.typeValid).toBe(true);
  });

  it("text-output ablation: a syntax error is caught, not thrown", async () => {
    const brokenText = new FakeModelClient(() => ({ kind: "ok", raw: JSON.stringify({ rule: "http.request.uri.path eq" }) }));
    const result = await runTextAblation(def, def.scenario.seed, brokenText, templates);
    expect(result.parsedOk).toBe(false);
    expect(result.diagnosticCodes.length).toBeGreaterThan(0);
  });

  it("a quota-exhausted draft response throws QuotaExhaustedError immediately, not after exhausting the retry loop", async () => {
    let calls = 0;
    const quotaExhausted = new FakeModelClient(() => {
      calls++;
      return { kind: "quota-exhausted", message: "3036: daily allocation used up" };
    });
    await expect(
      runScenario(def, def.scenario.seed, quotaExhausted, templates, { maxAttempts: MAX_DRAFT_ATTEMPTS, lessons: [], runNarrativeSteps: false }),
    ).rejects.toBeInstanceOf(QuotaExhaustedError);
    expect(calls).toBe(1);
  });

  it("a quota-exhausted narrative-step response (classify/hypothesize/write-report) also throws, not silently degrades", async () => {
    const canned = cannedModel();
    const quotaOnHypothesize: ModelClient = {
      modelId: "test",
      async generateJson(request: ModelRequest): Promise<ModelResponse> {
        if (request.purpose === "hypothesize") return { kind: "quota-exhausted", message: "3036: daily allocation used up" };
        return canned.generateJson(request);
      },
    };
    await expect(
      runScenario(def, def.scenario.seed, quotaOnHypothesize, templates, { maxAttempts: MAX_DRAFT_ATTEMPTS, lessons: [], runNarrativeSteps: true }),
    ).rejects.toBeInstanceOf(QuotaExhaustedError);
  });

  it("text-output ablation: a quota-exhausted response throws QuotaExhaustedError", async () => {
    const quotaExhausted = new FakeModelClient(() => ({ kind: "quota-exhausted", message: "4006: used up your daily free allocation" }));
    await expect(runTextAblation(def, def.scenario.seed, quotaExhausted, templates)).rejects.toBeInstanceOf(QuotaExhaustedError);
  });
});

describe("response cache (Phase 5)", () => {
  let dir: string;
  let cachePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "portcullis-eval-cache-"));
    cachePath = join(dir, "responses.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("a second call with the same (scenario, prompt, model) is served from the cache, not the inner client", async () => {
    let calls = 0;
    const inner: ModelClient = {
      modelId: "test",
      async generateJson(): Promise<ModelResponse> {
        calls++;
        return { kind: "ok", raw: `{"n":${calls}}` };
      },
    };
    const cache = new ResponseCache(cachePath);
    const client = new CachingModelClient(inner, cache, "scenario-a");
    const request: ModelRequest = { purpose: "draft-rule", system: "s", user: "u", jsonSchema: {} };

    const first = await client.generateJson(request);
    const second = await client.generateJson(request);
    expect(first).toEqual(second);
    expect(calls).toBe(1);
    expect(cache.stats).toEqual({ hits: 1, misses: 1, entries: 1 });
  });

  it("a different scenario or a different prompt is a cache miss even with the same model", async () => {
    let calls = 0;
    const inner: ModelClient = {
      modelId: "test",
      async generateJson(): Promise<ModelResponse> {
        calls++;
        return { kind: "ok", raw: "x" };
      },
    };
    const cache = new ResponseCache(cachePath);
    const request: ModelRequest = { purpose: "draft-rule", system: "s", user: "u", jsonSchema: {} };
    await new CachingModelClient(inner, cache, "scenario-a").generateJson(request);
    await new CachingModelClient(inner, cache, "scenario-b").generateJson(request);
    await new CachingModelClient(inner, cache, "scenario-a").generateJson({ ...request, user: "different" });
    expect(calls).toBe(3);
  });

  it("a rate-limited or error response is never cached, so a later run can retry it", async () => {
    let calls = 0;
    const inner: ModelClient = {
      modelId: "test",
      async generateJson(): Promise<ModelResponse> {
        calls++;
        return { kind: "rate-limited", message: "429" };
      },
    };
    const cache = new ResponseCache(cachePath);
    const client = new CachingModelClient(inner, cache, "scenario-a");
    const request: ModelRequest = { purpose: "draft-rule", system: "s", user: "u", jsonSchema: {} };
    await client.generateJson(request);
    await client.generateJson(request);
    expect(calls).toBe(2);
    expect(cache.stats.entries).toBe(0);
  });

  it("persists across instances: save() then a fresh ResponseCache over the same file sees the entries", async () => {
    const cache = new ResponseCache(cachePath);
    cache.set({ scenarioId: "s", system: "sys", user: "usr", modelId: "m" }, { kind: "ok", raw: "cached" });
    cache.save();

    const reloaded = new ResponseCache(cachePath);
    expect(reloaded.get({ scenarioId: "s", system: "sys", user: "usr", modelId: "m" })).toEqual({ kind: "ok", raw: "cached" });
  });
});
