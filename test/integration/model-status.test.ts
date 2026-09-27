// Phase 7 (quota work): modelStatus() and recordModelOutcome() are exercised directly through
// Durable Object RPC, without a full Workflow run, since neither reads or writes anything a
// Workflow step produces. An injected fixed clock (setClockForTest), not real time, drives the
// UTC-day reset boundary case.

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { agentNamed } from "./helpers";

const SYMPTOM = "login latency spiked and users are getting locked out";

/**
 * modelStatus() only reads "live"/"quota-exhausted" when MODEL_MODE is not "fake" (agent.ts).
 * The Agent's env is bound once, when its Durable Object is first constructed, so any agent used
 * inside this override must also be named and first called inside it (see the tests below).
 *
 * env.AI is also stubbed for the duration: these tests only care about modelStatus() and
 * recordModelOutcome(), set directly by RPC, but startInvestigation still kicks off a real
 * Workflow in the background that will otherwise try to reach the real (remote-only, unavailable
 * in tests) AI binding on its own narrative-step calls. A fast, deterministic failure here keeps
 * that background Workflow from hanging or spamming unrelated errors.
 */
async function withRealModelMode<T>(fn: () => Promise<T>): Promise<T> {
  const originalMode = env.MODEL_MODE;
  const originalAi = env.AI;
  env.MODEL_MODE = "workers-ai";
  env.AI = { run: async () => { throw new Error("stubbed for model-status tests: no real model call expected"); } } as unknown as Ai;
  try {
    return await fn();
  } finally {
    env.MODEL_MODE = originalMode;
    env.AI = originalAi;
  }
}

async function modelStatusOf(agent: Awaited<ReturnType<typeof agentNamed>>, incidentId: string) {
  const state = await agent.state;
  const view = state.incidents.find((i) => i.id === incidentId);
  if (!view) throw new Error(`incident ${incidentId} not in state`);
  return view.modelStatus;
}

const DAY_1 = Date.UTC(2026, 8, 25, 12, 0, 0); // 2026-09-25 12:00 UTC
const DAY_1_LATER = Date.UTC(2026, 8, 25, 23, 0, 0); // same UTC day, later
const DAY_2 = Date.UTC(2026, 8, 26, 0, 30, 0); // next UTC day, just after the 00:00 reset

describe("model status: quota-exhausted flag (CLAUDE.md: UTC daily reset)", () => {
  it("is 'fake' regardless of any recorded outcome, when MODEL_MODE is fake", async () => {
    const agent = await agentNamed("ms-fake");
    const { incidentId } = await agent.startInvestigation(SYMPTOM);
    await agent.recordModelOutcome(incidentId, { kind: "quota-exhausted", message: "3036: daily allocation used up" });
    expect(await modelStatusOf(agent, incidentId)).toBe("fake");
  });

  it("is 'live' when MODEL_MODE is not fake and no quota-exhausted response has been recorded", async () => {
    await withRealModelMode(async () => {
      // The Agent's env is captured when its Durable Object is first constructed (the first RPC
      // call reaches it), so both the agent name and the first call must be inside the mode
      // override -- an agent built under "fake" keeps reporting "fake" even after MODEL_MODE
      // flips back, because modelStatus() reads this.env, not the live module export.
      const agent = await agentNamed("ms-live");
      const { incidentId } = await agent.startInvestigation(SYMPTOM);
      expect(await modelStatusOf(agent, incidentId)).toBe("live");
    });
  });

  it("becomes 'quota-exhausted' the moment a quota-exhausted response is recorded", async () => {
    await withRealModelMode(async () => {
      const agent = await agentNamed("ms-set");
      const { incidentId } = await agent.startInvestigation(SYMPTOM);
      await agent.setClockForTest(DAY_1);
      await agent.recordModelOutcome(incidentId, { kind: "quota-exhausted", message: "3036: daily allocation used up" });
      expect(await modelStatusOf(agent, incidentId)).toBe("quota-exhausted");
      await agent.setClockForTest(null);
    });
  });

  it("clears back to 'live' the moment a later ok response is recorded, same UTC day", async () => {
    await withRealModelMode(async () => {
      const agent = await agentNamed("ms-clear");
      const { incidentId } = await agent.startInvestigation(SYMPTOM);
      await agent.setClockForTest(DAY_1);
      await agent.recordModelOutcome(incidentId, { kind: "quota-exhausted", message: "3036: daily allocation used up" });
      expect(await modelStatusOf(agent, incidentId)).toBe("quota-exhausted");
      await agent.setClockForTest(DAY_1_LATER);
      await agent.recordModelOutcome(incidentId, { kind: "ok", raw: "{}" });
      expect(await modelStatusOf(agent, incidentId)).toBe("live");
      await agent.setClockForTest(null);
    });
  });

  it("expires back to 'live' once the UTC day it was set on has passed, with no later ok response needed", async () => {
    await withRealModelMode(async () => {
      const agent = await agentNamed("ms-expire");
      const { incidentId } = await agent.startInvestigation(SYMPTOM);
      await agent.setClockForTest(DAY_1);
      await agent.recordModelOutcome(incidentId, { kind: "quota-exhausted", message: "3036: daily allocation used up" });
      expect(await modelStatusOf(agent, incidentId)).toBe("quota-exhausted");
      // Still quota-exhausted later the same UTC day.
      await agent.setClockForTest(DAY_1_LATER);
      await agent.refreshStateForTest();
      expect(await modelStatusOf(agent, incidentId)).toBe("quota-exhausted");
      // Past the 00:00 UTC reset: live again, even though nothing cleared the flag. modelStatus
      // is only recomputed when state refreshes, same as in production (the next step or
      // browser action), so refreshStateForTest stands in for "something happens after midnight".
      await agent.setClockForTest(DAY_2);
      await agent.refreshStateForTest();
      expect(await modelStatusOf(agent, incidentId)).toBe("live");
      await agent.setClockForTest(null);
    });
  });
});
