// Shapes shared by the Agent, the Workflow and the UI. Server-side only in the sense that the
// server produces them; the UI imports these types, never the server code.

import type { Evidence, Incident, RuleVersion, Scenario, TrafficSummary } from "../core/types";

export type StepStatus = "running" | "complete" | "error" | "waiting";

/**
 * `durationMs` is `at - startedAt`, populated once the step reaches a terminal status
 * (`complete` or `error`); `null` while `running` or `waiting`, since there is no end time yet.
 * Phase 6: step timings surfaced in the UI.
 */
export type StepView = { name: string; status: StepStatus; detail: string | null; at: number; startedAt: number; durationMs: number | null };

export type IncidentView = Incident & {
  steps: StepView[];
  proposed: RuleVersion | null;
  baseline: RuleVersion | null;
  applied: RuleVersion | null;
  /** Every model-drafted attempt, in attempt order, including failed ones. Phase 3 retry loop. */
  attempts: RuleVersion[];
  /** Blocked requests per [bucket][statusClass] for each replayed rule, for the traffic panel. */
  blockedPanels: { proposed: number[][] | null; baseline: number[][] | null };
  /** Summary the rule was drafted from, for the evidence panel. */
  summary: TrafficSummary | null;
  /** Every evidence record produced for this incident, for the hypothesis's citations to resolve. */
  evidence: Evidence[];
  modelId: string;
  /** "fake" when MODEL_MODE is fake; otherwise "quota-exhausted" until a real call succeeds again. */
  modelStatus: "live" | "fake" | "quota-exhausted";
};

export type TrafficState = {
  status: "empty" | "generating" | "ready";
  chunksDone: number;
  chunksTotal: number;
  requestCount: number;
  digest: string | null;
  /** panel[bucket][statusClass] for the unmitigated traffic. */
  panel: number[][] | null;
  bucketMs: number;
};

/**
 * The broadcast Agent state. Small and reconstructible from SQLite by design: the Durable
 * Object can be evicted at any time and nothing here is the only copy.
 */
export type AgentState = {
  scenario: Pick<Scenario, "id" | "title" | "symptom" | "seed" | "isTrap" | "trapAttribute" | "thresholds">;
  asnNames: Record<string, string>;
  traffic: TrafficState;
  incidents: IncidentView[];
};

/** Params of the investigation workflow. Small by design: IDs and a seed, never traffic. */
export type InvestigationParams = {
  incidentId: string;
  scenarioId: string;
  seed: number;
  symptom: string;
};
