// Phase 6: every step in DESIGN.md section 8 forced to fail, asserting the incident always ends
// in a defined terminal state (never a silent hang) via IncidentAgent.onWorkflowError, the
// single catch-all for any step that exhausts its retries. wait-for-approval's own timeout and
// rejection paths, and the retry loop's three failure classes, already have dedicated tests in
// workflow.test.ts and are not repeated here.

import { env } from "cloudflare:workers";
import { introspectWorkflow, introspectWorkflowInstance } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { CLASSIFY_JSON_SCHEMA, HYPOTHESIZE_JSON_SCHEMA } from "../../src/core/narrative-schema";
import { RULE_JSON_SCHEMA } from "../../src/core/rules/schema";
import type { AiRunner } from "../../src/model/workers-ai";
import { agentNamed, waitForIncident } from "./helpers";

const SYMPTOM = "login latency spiked and users are getting locked out";

/** Steps that run before publish-proposal: forcing one of these to error needs no approval. */
const PRE_APPROVAL_STEPS = [
  "ensure-traffic",
  "aggregate-traffic",
  "load-memory",
  "classify-symptom",
  "hypothesize",
  "replay-rule-attempt-1",
  "naive-baseline",
  "replay-naive-baseline",
  "publish-proposal",
];

describe("failure injection: pre-approval steps forced to error (Phase 6)", () => {
  it.each(PRE_APPROVAL_STEPS)("a failing '%s' step fails the incident visibly, never a silent hang", async (stepName) => {
    const agent = await agentNamed(`fi-${stepName}`);
    await using introspector = await introspectWorkflow(env.INVESTIGATION_WORKFLOW);
    await introspector.modifyAll(async (m) => {
      await m.disableRetryDelays();
      await m.mockStepError({ name: stepName }, new Error(`injected failure: ${stepName}`));
    });
    const { incidentId } = await agent.startInvestigation(SYMPTOM);
    const done = await waitForIncident(agent, incidentId, ["failed", "awaiting-approval"]);
    expect(done.status).toBe("failed");
    expect(done.failureReason).toMatch(new RegExp(`injected failure: ${stepName}`));
  });
});

/** Steps that only run after the operator approves. */
const POST_APPROVAL_STEPS = ["apply-rule", "verify-recovery", "write-report", "persist-incident"];

describe("failure injection: post-approval steps forced to error (Phase 6)", () => {
  it.each(POST_APPROVAL_STEPS)("a failing '%s' step fails the incident visibly, never a silent hang", async (stepName) => {
    const agent = await agentNamed(`fi-post-${stepName}`);
    await using introspector = await introspectWorkflow(env.INVESTIGATION_WORKFLOW);
    await introspector.modifyAll(async (m) => {
      await m.disableRetryDelays();
      await m.mockStepError({ name: stepName }, new Error(`injected failure: ${stepName}`));
    });
    const { incidentId } = await agent.startInvestigation(SYMPTOM);
    const waiting = await waitForIncident(agent, incidentId, ["awaiting-approval"]);
    const proposedId = waiting.proposedRuleVersionId;
    if (!proposedId) throw new Error("no proposal");
    await agent.approve(incidentId, proposedId);
    const done = await waitForIncident(agent, incidentId, ["failed"]);
    expect(done.status).toBe("failed");
    expect(done.failureReason).toMatch(new RegExp(`injected failure: ${stepName}`));
  });
});

describe("failure injection: draft-feedback-attempt-1 forced to error (Phase 6)", () => {
  it("fails the incident visibly when the retry loop's own feedback step errors", async () => {
    const agent = await agentNamed("fi-draft-feedback");
    await using introspector = await introspectWorkflow(env.INVESTIGATION_WORKFLOW);
    await introspector.modifyAll(async (m) => {
      await m.disableRetryDelays();
      // Force attempt 1 to fail validation, so draft-feedback-attempt-1 runs, then fail it too.
      await m.mockStepResult({ name: "validate-rule-attempt-1" }, { status: "invalid-schema", diagnosticCodes: ["E_SCHEMA_INVALID"] });
      await m.mockStepError({ name: "draft-feedback-attempt-1" }, new Error("injected failure: draft-feedback-attempt-1"));
    });
    const { incidentId } = await agent.startInvestigation(SYMPTOM);
    const done = await waitForIncident(agent, incidentId, ["failed", "awaiting-approval"]);
    expect(done.status).toBe("failed");
    expect(done.failureReason).toMatch(/injected failure: draft-feedback-attempt-1/);
  });
});

describe("failure injection: forced timeout, not just a thrown error (Phase 6)", () => {
  it("forceStepTimeout on aggregate-traffic also fails the incident visibly", async () => {
    const agent = await agentNamed("fi-timeout-aggregate");
    await using introspector = await introspectWorkflow(env.INVESTIGATION_WORKFLOW);
    await introspector.modifyAll(async (m) => {
      await m.disableRetryDelays();
      await m.forceStepTimeout({ name: "aggregate-traffic" });
    });
    const { incidentId } = await agent.startInvestigation(SYMPTOM);
    const done = await waitForIncident(agent, incidentId, ["failed", "awaiting-approval"], 60_000);
    expect(done.status).toBe("failed");
  }, 60_000);
});

describe("failure injection: model rate limiting (Phase 6)", () => {
  it("a draft-rule call that fails with a rate-limit-shaped error fails the incident with the message intact", async () => {
    // src/model/client.ts's requireOkResponse (unit-tested directly in test/unit/model.test.ts)
    // is what turns a ModelResponse of kind "rate-limited" into this same thrown message, inside
    // draft-rule-attempt-1's real (unmocked) step body. Mocking the step error here reproduces
    // its exact wording without needing to inject a scripted ModelClient into a live Workflow.
    const agent = await agentNamed("fi-rate-limited");
    await using introspector = await introspectWorkflow(env.INVESTIGATION_WORKFLOW);
    await introspector.modifyAll(async (m) => {
      await m.disableRetryDelays();
      await m.mockStepError({ name: "draft-rule-attempt-1" }, new Error("model call failed (rate-limited): 429: too many requests"));
    });
    const { incidentId } = await agent.startInvestigation(SYMPTOM);
    const done = await waitForIncident(agent, incidentId, ["failed", "awaiting-approval"]);
    expect(done.status).toBe("failed");
    expect(done.failureReason).toMatch(/model call failed \(rate-limited\): 429/);
  });
});

/**
 * Swaps env.MODEL_MODE and env.AI for the duration of `fn`, so the Workflow's real (unmocked)
 * model call goes through the real WorkersAiModelClient path instead of the fake model that every
 * other integration test uses. Always restored, even if `fn` throws, since --no-isolate shares
 * this env object across every test in the run.
 */
async function withScriptedAi<T>(run: AiRunner["run"], fn: () => Promise<T>): Promise<T> {
  const originalMode = env.MODEL_MODE;
  const originalAi = env.AI;
  env.MODEL_MODE = "workers-ai";
  env.AI = { run } as unknown as Ai;
  try {
    return await fn();
  } finally {
    env.MODEL_MODE = originalMode;
    env.AI = originalAi;
  }
}

describe("failure injection: model quota exhaustion (CLAUDE.md: never retried, at any level)", () => {
  it("a real draft-rule call that returns quota-exhausted fails the incident after exactly one model call, never retried", async () => {
    // Regression test: an earlier version of this test used mockStepError, which replaces the
    // step's entire body and so kept passing even after the NonRetryableError wrapping around
    // requireOkResponse in workflow.ts was removed. This version runs the real (unmocked)
    // draft-rule-attempt-1 step body against a scripted AI binding, so it actually exercises
    // requireOkResponse -> QuotaExhaustedError -> NonRetryableError and would fail if that
    // wrapping were removed (draft-rule-attempt-2 would then be attempted).
    const agent = await agentNamed("fi-quota-exhausted-real");
    await using introspector = await introspectWorkflow(env.INVESTIGATION_WORKFLOW);
    await introspector.modifyAll(async (m) => {
      await m.disableRetryDelays();
    });
    let draftCalls = 0;
    const done = await withScriptedAi(
      async (_model, inputs) => {
        const schema = (inputs as { response_format?: { json_schema?: unknown } }).response_format?.json_schema;
        if (schema === RULE_JSON_SCHEMA) {
          draftCalls++;
          throw new Error("3036: daily allocation used up");
        }
        if (schema === CLASSIFY_JSON_SCHEMA) return { response: { intent: "credential-stuffing" } };
        if (schema === HYPOTHESIZE_JSON_SCHEMA) return { response: { hypothesis: "a plausible hypothesis with no citations" } };
        throw new Error("unexpected schema in test's scripted AI binding");
      },
      async () => {
        const { incidentId } = await agent.startInvestigation(SYMPTOM);
        return waitForIncident(agent, incidentId, ["failed", "awaiting-approval"]);
      },
    );
    expect(done.status).toBe("failed");
    expect(done.failureReason).toMatch(/model call failed \(quota-exhausted\): 3036/);
    expect(draftCalls).toBe(1);
  });
});

describe("step timings are recorded and surfaced (Phase 6)", () => {
  it("a completed step has a non-null duration; a running or waiting one does not", async () => {
    const agent = await agentNamed("fi-timings");
    const { incidentId } = await agent.startInvestigation(SYMPTOM);
    await using instance = await introspectWorkflowInstance(env.INVESTIGATION_WORKFLOW, incidentId);
    void instance;
    await waitForIncident(agent, incidentId, ["awaiting-approval", "failed"]);
    const view = (await agent.state).incidents.find((i) => i.id === incidentId);
    const finishedSteps = view?.steps.filter((s) => s.status === "complete") ?? [];
    expect(finishedSteps.length).toBeGreaterThan(0);
    for (const s of finishedSteps) {
      expect(s.durationMs).not.toBeNull();
      expect(s.durationMs).toBeGreaterThanOrEqual(0);
      expect(s.startedAt).toBeLessThanOrEqual(s.at);
    }
    const waitingStep = view?.steps.find((s) => s.status === "waiting");
    if (waitingStep) expect(waitingStep.durationMs).toBeNull();
  });
});
