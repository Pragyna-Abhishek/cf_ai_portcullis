// Phase 6: every step in DESIGN.md section 8 forced to fail, asserting the incident always ends
// in a defined terminal state (never a silent hang) via IncidentAgent.onWorkflowError, the
// single catch-all for any step that exhausts its retries. wait-for-approval's own timeout and
// rejection paths, and the retry loop's three failure classes, already have dedicated tests in
// workflow.test.ts and are not repeated here.

import { env } from "cloudflare:workers";
import { introspectWorkflow, introspectWorkflowInstance } from "cloudflare:test";
import { describe, expect, it } from "vitest";
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

describe("failure injection: model quota exhaustion (CLAUDE.md: never retried, at any level)", () => {
  it("a draft-rule call that fails with a quota-exhausted-shaped error fails the incident immediately, with the message intact", async () => {
    // src/model/client.ts's requireOkResponse throws QuotaExhaustedError for a "quota-exhausted"
    // response, and draft-rule-attempt-1's real (unmocked) step body wraps that as
    // NonRetryableError so the Workflow's own step-retry policy never re-runs it. Mocking the step
    // error here reproduces the exact wording that failure produces, the same pattern as the
    // rate-limited case above.
    const agent = await agentNamed("fi-quota-exhausted");
    await using introspector = await introspectWorkflow(env.INVESTIGATION_WORKFLOW);
    await introspector.modifyAll(async (m) => {
      await m.disableRetryDelays();
      await m.mockStepError(
        { name: "draft-rule-attempt-1" },
        new Error("model call failed (quota-exhausted): 3036: daily allocation used up"),
      );
    });
    const { incidentId } = await agent.startInvestigation(SYMPTOM);
    const done = await waitForIncident(agent, incidentId, ["failed", "awaiting-approval"]);
    expect(done.status).toBe("failed");
    expect(done.failureReason).toMatch(/model call failed \(quota-exhausted\): 3036/);
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
