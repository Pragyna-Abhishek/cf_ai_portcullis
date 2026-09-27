import { env } from "cloudflare:workers";
import { evictDurableObject, introspectWorkflow, introspectWorkflowInstance } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { agentNamed, errorOf, waitForIncident } from "./helpers";

const SYMPTOM = "login latency spiked and users are getting locked out";

async function startInvestigation(agentName: string) {
  const agent = await agentNamed(agentName);
  const { incidentId } = await agent.startInvestigation(SYMPTOM);
  return { agent, incidentId };
}

describe("investigation workflow, end to end with the fake model", () => {
  it("reaches awaiting-approval with a verified proposal and a naive baseline beside it", async () => {
    const agent = await agentNamed("wf-await");
    // The incident ID is the workflow instance ID, so the introspector can be attached first.
    const pending = agent.startInvestigation(SYMPTOM);
    const { incidentId } = await pending;
    await using instance = await introspectWorkflowInstance(env.INVESTIGATION_WORKFLOW, incidentId);
    const incident = await waitForIncident(agent, incidentId, ["awaiting-approval", "failed"]);
    expect(incident.status).toBe("awaiting-approval");
    expect(incident.proposedRuleVersionId).toBe(`rv_${incidentId}_1`);
    expect(incident.baselineRuleVersionId).toBe(`rv_${incidentId}_baseline`);

    const state = await agent.state;
    const view = state.incidents.find((i) => i.id === incidentId);
    expect(view?.proposed?.status).toBe("valid");
    expect(view?.proposed?.text).toContain('http.request.uri.path eq "/login"');
    const replay = view?.proposed?.replay;
    const baseline = view?.baseline?.replay;
    if (!replay || !baseline) throw new Error("replays missing");
    // Blocked never exceeds total, and the counts cover the whole scenario.
    expect(replay.attackBlocked).toBeLessThanOrEqual(replay.attackTotal);
    expect(replay.legitimateBlocked).toBeLessThanOrEqual(replay.legitimateTotal);
    expect(replay.attackTotal + replay.legitimateTotal).toBe(6000);
    // The experiment: the naive rule blocks more legitimate traffic than the proposal.
    expect(baseline.legitimateBlocked).toBeGreaterThan(replay.legitimateBlocked);
    expect(view?.steps.map((s) => s.name)).toContain("wait-for-approval");
    expect(view?.modelId).toBe("fake");
    // Phase 7 (quota work): the fake model always reports "fake", never "quota-exhausted", and
    // reports no usage, so the neuron total for a fake-model incident stays zero.
    expect(view?.modelStatus).toBe("fake");
    expect(view?.modelNeuronsUsed).toBe(0);
    // Phase 4: the hypothesis cites real evidence, and the cited evidence is in the ledger.
    expect(incident.hypothesis).toContain("ev_4");
    expect(view?.evidence.some((e) => e.id === "ev_4" && e.kind === "breakdown")).toBe(true);
    expect(view?.evidence.length).toBeGreaterThan(0);
    void instance;
  });

  it("approve applies exactly the proposed version and verifies recovery from its stored text", async () => {
    const { agent, incidentId } = await startInvestigation("wf-approve");
    await using instance = await introspectWorkflowInstance(env.INVESTIGATION_WORKFLOW, incidentId);
    const waiting = await waitForIncident(agent, incidentId, ["awaiting-approval"]);
    const proposedId = waiting.proposedRuleVersionId;
    if (!proposedId) throw new Error("no proposal");

    await agent.approve(incidentId, proposedId);
    await instance.waitForStatus("complete");
    const done = await waitForIncident(agent, incidentId, ["applied"]);
    expect(done.appliedRuleVersionId).toBe(proposedId);
    expect(done.approval?.decision).toBe("approved");
    expect(done.recovery?.legitimateBlocked).toBe(0);
    expect(done.recovery?.attackBlocked).toBe(done.recovery?.attackTotal);
    expect(await agent.unsafeActionCount()).toBe(0);
  });

  it("reject leaves nothing applied", async () => {
    const { agent, incidentId } = await startInvestigation("wf-reject");
    await using instance = await introspectWorkflowInstance(env.INVESTIGATION_WORKFLOW, incidentId);
    await waitForIncident(agent, incidentId, ["awaiting-approval"]);
    await agent.reject(incidentId, "too broad");
    await instance.waitForStatus("complete");
    const done = await waitForIncident(agent, incidentId, ["rejected"]);
    expect(done.appliedRuleVersionId).toBeNull();
    expect(done.approval).toMatchObject({ decision: "rejected", reason: "too broad" });
    const state = await agent.state;
    expect(state.incidents.find((i) => i.id === incidentId)?.proposed?.status).toBe("rejected");
  });

  it("an approval timeout moves the incident to timed-out with nothing applied", async () => {
    const agent = await agentNamed("wf-timeout");
    // Modifiers registered before the instance exists, so there is no race with the gate.
    await using introspector = await introspectWorkflow(env.INVESTIGATION_WORKFLOW);
    await introspector.modifyAll(async (m) => {
      await m.forceEventTimeout({ name: "wait-for-approval" });
    });
    const { incidentId } = await agent.startInvestigation(SYMPTOM);
    const done = await waitForIncident(agent, incidentId, ["timed-out", "failed"]);
    expect(done.status).toBe("timed-out");
    expect(done.appliedRuleVersionId).toBeNull();
  });

  it("incident history survives Durable Object eviction", async () => {
    const { agent, incidentId } = await startInvestigation("wf-evict");
    await using instance = await introspectWorkflowInstance(env.INVESTIGATION_WORKFLOW, incidentId);
    await waitForIncident(agent, incidentId, ["awaiting-approval"]);
    const stub = env.IncidentAgent.get(env.IncidentAgent.idFromName("wf-evict"));
    await evictDurableObject(stub);
    const again = await agentNamed("wf-evict");
    const state = await again.state;
    expect(state.incidents.some((i) => i.id === incidentId && i.status === "awaiting-approval")).toBe(true);
    // The parked workflow is unaffected by the eviction and still accepts the decision.
    const incident = await again.getIncidentForTest(incidentId);
    if (!incident?.proposedRuleVersionId) throw new Error("no proposal");
    await again.approve(incidentId, incident.proposedRuleVersionId);
    await instance.waitForStatus("complete");
    await waitForIncident(again, incidentId, ["applied"]);
  });

  it("a model step that keeps failing fails the incident visibly", async () => {
    const agent = await agentNamed("wf-model-fail");
    await using introspector = await introspectWorkflow(env.INVESTIGATION_WORKFLOW);
    await introspector.modifyAll(async (m) => {
      await m.disableRetryDelays();
      await m.mockStepError({ name: "draft-rule-attempt-1" }, new Error("model unavailable"));
    });
    const { incidentId } = await agent.startInvestigation(SYMPTOM);
    const done = await waitForIncident(agent, incidentId, ["failed", "awaiting-approval"]);
    expect(done.status).toBe("failed");
    expect(done.failureReason).toMatch(/model unavailable/);
    expect(done.proposedRuleVersionId).toBeNull();
  });
});

describe("the bounded draft retry loop (Phase 3)", () => {
  it("a draft scripted to fail validation twice then succeed completes on attempt 3, with all three attempts persisted", async () => {
    const agent = await agentNamed("wf-retry-succeed");
    await using introspector = await introspectWorkflow(env.INVESTIGATION_WORKFLOW);
    await introspector.modifyAll(async (m) => {
      await m.disableRetryDelays();
      await m.mockStepResult({ name: "validate-rule-attempt-1" }, { status: "invalid-schema", diagnosticCodes: ["E_SCHEMA_INVALID"] });
      await m.mockStepResult({ name: "validate-rule-attempt-2" }, { status: "invalid-types", diagnosticCodes: ["E_TYPE_MISMATCH"] });
      // attempt 3 is not mocked: it runs for real, against the canned fake model, and succeeds.
    });
    const { incidentId } = await agent.startInvestigation(SYMPTOM);
    const done = await waitForIncident(agent, incidentId, ["awaiting-approval", "failed"]);
    expect(done.status).toBe("awaiting-approval");
    expect(done.proposedRuleVersionId).toBe(`rv_${incidentId}_3`);

    const state = await agent.state;
    const view = state.incidents.find((i) => i.id === incidentId);
    expect(view?.attempts.map((a) => a.attempt)).toEqual([1, 2, 3]);
    expect(view?.attempts.map((a) => a.id)).toEqual([`rv_${incidentId}_1`, `rv_${incidentId}_2`, `rv_${incidentId}_3`]);
    // validate-rule-attempt-1 and -2 are mocked: mockStepResult replaces the step's execution
    // entirely, so tracked()'s own recordStep call never runs for those two. Attempt 3 runs for
    // real, unmocked, and is recorded normally.
    const stepNames = view?.steps.map((s) => s.name) ?? [];
    expect(stepNames).toEqual(
      expect.arrayContaining([
        "draft-rule-attempt-1",
        "draft-feedback-attempt-1",
        "draft-rule-attempt-2",
        "draft-feedback-attempt-2",
        "draft-rule-attempt-3",
        "validate-rule-attempt-3",
        "replay-rule-attempt-3",
      ]),
    );
    // No feedback step after the final attempt: there is no next attempt to feed it into.
    expect(stepNames).not.toContain("draft-feedback-attempt-3");
  });

  it("a draft that always fails validation exhausts all attempts and fails the incident with no rule proposed", async () => {
    const agent = await agentNamed("wf-retry-exhausted");
    await using introspector = await introspectWorkflow(env.INVESTIGATION_WORKFLOW);
    await introspector.modifyAll(async (m) => {
      await m.disableRetryDelays();
      for (const i of [1, 2, 3]) {
        await m.mockStepResult({ name: `validate-rule-attempt-${i}` }, { status: "invalid-schema", diagnosticCodes: ["E_SCHEMA_NOT_JSON"] });
      }
    });
    const { incidentId } = await agent.startInvestigation(SYMPTOM);
    const done = await waitForIncident(agent, incidentId, ["failed", "awaiting-approval"]);
    expect(done.status).toBe("failed");
    expect(done.proposedRuleVersionId).toBeNull();
    expect(done.failureReason).toMatch(/invalid-schema/);

    const state = await agent.state;
    const view = state.incidents.find((i) => i.id === incidentId);
    expect(view?.attempts.map((a) => a.attempt)).toEqual([1, 2, 3]);
    const stepNames = view?.steps.map((s) => s.name) ?? [];
    expect(stepNames).toContain("draft-rule-attempt-3");
    expect(stepNames).not.toContain("draft-rule-attempt-4");
    // No feedback step after the last attempt: the loop is over, not waiting on a fourth attempt.
    expect(stepNames).not.toContain("draft-feedback-attempt-3");
  });

  it("a roundtrip failure is a hard failure: it fails the incident on attempt 1, never retried", async () => {
    const agent = await agentNamed("wf-retry-hardfail");
    await using introspector = await introspectWorkflow(env.INVESTIGATION_WORKFLOW);
    await introspector.modifyAll(async (m) => {
      await m.disableRetryDelays();
      await m.mockStepResult({ name: "validate-rule-attempt-1" }, { status: "roundtrip-failed", diagnosticCodes: ["E_ROUNDTRIP_MISMATCH"] });
    });
    const { incidentId } = await agent.startInvestigation(SYMPTOM);
    const done = await waitForIncident(agent, incidentId, ["failed", "awaiting-approval"]);
    expect(done.status).toBe("failed");
    expect(done.failureReason).toMatch(/roundtrip-failed/);

    const state = await agent.state;
    const view = state.incidents.find((i) => i.id === incidentId);
    expect(view?.attempts.map((a) => a.attempt)).toEqual([1]);
    const stepNames = view?.steps.map((s) => s.name) ?? [];
    expect(stepNames).not.toContain("draft-rule-attempt-2");
    expect(stepNames).not.toContain("draft-feedback-attempt-1");
  });
});

describe("hypothesis citations and memory (Phase 4)", () => {
  it("a hypothesis citing a fabricated evidence ID is caught and never rendered", async () => {
    const agent = await agentNamed("wf-fabricated-citation");
    await using introspector = await introspectWorkflow(env.INVESTIGATION_WORKFLOW);
    await introspector.modifyAll(async (m) => {
      await m.disableRetryDelays();
      await m.mockStepResult(
        { name: "hypothesize" },
        { hypothesis: "This cites a made-up id (ev_9999) that does not exist.", fabricatedCitations: ["ev_9999"] },
      );
    });
    const { incidentId } = await agent.startInvestigation(SYMPTOM);
    const incident = await waitForIncident(agent, incidentId, ["awaiting-approval", "failed"]);
    // A rejected hypothesis does not stop the investigation: it is informational only, and it
    // is never stored or rendered once its citation is fabricated.
    expect(incident.status).toBe("awaiting-approval");
    expect(incident.hypothesis).toBeNull();
  });

  it("a completed incident's lesson is retrieved by the next investigation in the same scenario family", async () => {
    const agent = await agentNamed("wf-memory");
    const first = await agent.startInvestigation(SYMPTOM);
    await using firstInstance = await introspectWorkflowInstance(env.INVESTIGATION_WORKFLOW, first.incidentId);
    const awaiting = await waitForIncident(agent, first.incidentId, ["awaiting-approval"]);
    if (!awaiting.proposedRuleVersionId) throw new Error("no proposal");
    await agent.approve(first.incidentId, awaiting.proposedRuleVersionId);
    await firstInstance.waitForStatus("complete");
    const done = await waitForIncident(agent, first.incidentId, ["applied"]);
    expect(done.lesson).not.toBeNull();
    expect(done.report).not.toBeNull();

    const second = await agent.startInvestigation(SYMPTOM);
    await using secondInstance = await introspectWorkflowInstance(env.INVESTIGATION_WORKFLOW, second.incidentId);
    await waitForIncident(agent, second.incidentId, ["awaiting-approval", "failed"]);
    const state = await agent.state;
    const view = state.incidents.find((i) => i.id === second.incidentId);
    const step = view?.steps.find((s) => s.name === "load-memory");
    expect(step?.detail).toBe("1 prior lesson(s)");
    void secondInstance;
  });
});

describe("workflow tracking retention (Phase 4)", () => {
  it("deletes complete/errored tracking rows older than the retention window, keeps the rest", async () => {
    const agent = await agentNamed("wf-retention");
    const dayMs = 24 * 60 * 60 * 1000;
    // Older than the 7 day retention window and finished: should be pruned.
    await agent.seedWorkflowTrackingRowForTest("old-complete", "complete", 8 * 24 * 60 * 60);
    await agent.seedWorkflowTrackingRowForTest("old-errored", "errored", 10 * 24 * 60 * 60);
    // Within the window: kept even though finished.
    await agent.seedWorkflowTrackingRowForTest("recent-complete", "complete", 60);
    // Old but still running: kept regardless of age.
    await agent.seedWorkflowTrackingRowForTest("old-running", "running", 30 * 24 * 60 * 60);

    const before = await agent.countWorkflowTrackingRowsForTest();
    const deleted = await agent.pruneWorkflowTrackingForTest(7 * dayMs);
    const after = await agent.countWorkflowTrackingRowsForTest();

    expect(deleted).toBe(2);
    expect(after).toBe(before - 2);
  });
});

describe("scenario selection (Phase 4)", () => {
  it("defaults to the first registered scenario, and selectScenario switches it", async () => {
    const agent = await agentNamed("scn-select");
    const initial = await agent.state;
    expect(initial.scenario.id).toBe("cs-trap-carrier");

    const traffic = await agent.selectScenario("l7-hosting-easy");
    expect(traffic.status).toBe("empty");
    const after = await agent.state;
    expect(after.scenario.id).toBe("l7-hosting-easy");
    expect(after.scenario.isTrap).toBe(false);
  });

  it("rejects an unknown scenario id", async () => {
    const agent = await agentNamed("scn-select-bad");
    expect(await errorOf(() => agent.selectScenario("not-a-real-scenario"))).toMatch(/unknown scenario/);
  });

  it("a new investigation targets the currently selected scenario, and replay uses the incident's own scenario even after switching away", async () => {
    const agent = await agentNamed("scn-select-investigate");
    await agent.selectScenario("cs-hosting-easy");
    const { incidentId } = await agent.startInvestigation("login endpoint is getting hammered");
    const incident = await waitForIncident(agent, incidentId, ["awaiting-approval", "failed"]);
    expect(incident.scenarioId).toBe("cs-hosting-easy");

    // Switch the live panel away from the incident's scenario; its own replay must not follow.
    await agent.selectScenario("l7-hosting-easy");
    const state = await agent.state;
    expect(state.scenario.id).toBe("l7-hosting-easy");
    const view = state.incidents.find((i) => i.id === incidentId);
    expect(view?.proposed?.replay?.attackTotal ?? 0).toBeGreaterThan(0);
  });
});

describe("input validation at the edge", () => {
  it("rejects an oversized or empty symptom", async () => {
    const agent = await agentNamed("edge");
    expect(await errorOf(() => agent.startInvestigation("x".repeat(501)))).toMatch(/longer than/);
    expect(await errorOf(() => agent.startInvestigation("  "))).toMatch(/empty/);
    expect(await errorOf(() => agent.startInvestigation(42 as unknown as string))).toMatch(/string/);
  });

  it("caps concurrent investigations", async () => {
    const agent = await agentNamed("edge-cap");
    await agent.startInvestigation(SYMPTOM);
    await agent.startInvestigation(SYMPTOM);
    expect(await errorOf(() => agent.startInvestigation(SYMPTOM))).toMatch(/at most/);
  });
});
