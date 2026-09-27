// IncidentAgent: the Durable Object that owns traffic, incidents, rule versions and approvals.
//
// Two kinds of public method:
//   - @callable() methods are reachable from the browser over WebSocket. There are four, and
//     every argument is validated here, at the edge.
//   - Plain methods are Durable Object RPC for the InvestigationWorkflow. They are not
//     reachable from a browser.
//
// The Agent is always name-addressed (see src/server/index.ts), never by raw Durable Object ID.
// CLAUDE.md invariant 10.

import { Agent, callable, type Connection } from "agents";
import { aggregateChunk, finalizeSummary, mergePartials, TIME_BUCKETS, type PartialAggregate } from "../core/aggregator";
import { naiveBaseline } from "../core/baseline";
import { checkCitations } from "../core/citations";
import { planChunks } from "../core/chunks";
import { chunkDigest, decodeTraffic, encodeTraffic, trafficDigest } from "../core/codec";
import { isClassifyIntent } from "../core/narrative-schema";
import { toReplayResult } from "../core/replay";
import { compileRule, type ChunkReplay, type CompiledRule, replayChunk } from "../core/rules/evaluate";
import { checkRuleText, modelFailureOutcome, verifyAst, verifyModelDraft } from "../core/rules/pipeline";
import { checkSymptom } from "../core/sanitize";
import { SCENARIOS, type ScenarioDefinition } from "../core/scenarios";
import { compileScenario, generateRange } from "../core/simulator";
import type { Diagnostic, Incident, IncidentStatus, ReplayResult, RuleVersion, TrafficSummary } from "../core/types";
import type { ModelResponse } from "../model/client";
import { logEvent } from "./log";
import * as store from "./store";
import type { AgentState, IncidentView, InvestigationParams, StepStatus, TrafficState } from "./views";

export const WORKFLOW_BINDING = "INVESTIGATION_WORKFLOW";
export const MAX_ACTIVE_INVESTIGATIONS = 2;
const INCIDENTS_IN_STATE = 10;
const TERMINAL: readonly IncidentStatus[] = ["applied", "rejected", "failed", "timed-out"];
const MAX_ID_CHARS = 100;

const SETTING_SCENARIO_ID = "scenarioId";
/** Set to a timestamp the moment any real model call returns quota-exhausted, cleared the moment
 * one returns ok again. Durable (survives eviction) because the daily quota outlives any one
 * incident or investigation. Also treated as stale (modelStatus reads "live") once the UTC day it
 * was set on has passed, since Workers AI's daily free allocation resets at 00:00 UTC and nothing
 * else clears the flag if the account happens to make no real model call the next day. */
const SETTING_MODEL_QUOTA_EXHAUSTED_AT = "modelQuotaExhaustedAt";

/** YYYY-MM-DD in UTC, for comparing two timestamps fall on the same day as the 00:00 UTC quota reset. */
function utcDayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
}
const WORKFLOW_TRACKING_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** The registry is the only source of scenario definitions; SCENARIOS[0] is the default. */
function defaultScenario(): ScenarioDefinition {
  const def = SCENARIOS[0];
  if (!def) throw new Error("scenario registry is empty");
  return def;
}

function isId(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= MAX_ID_CHARS && /^[A-Za-z0-9_-]+$/.test(v);
}

function emptyTrafficState(def: ScenarioDefinition): TrafficState {
  return {
    status: "empty",
    chunksDone: 0,
    chunksTotal: planChunks(def.scenario.requestCount).length,
    requestCount: def.scenario.requestCount,
    digest: null,
    panel: null,
    bucketMs: def.scenario.durationMs / TIME_BUCKETS,
  };
}

/** The scenario-derived parts of AgentState, shared by the static initial state and refreshState. */
function scenarioState(def: ScenarioDefinition): Pick<AgentState, "scenario" | "asnNames" | "traffic"> {
  const s = def.scenario;
  return {
    scenario: {
      id: s.id,
      title: s.title,
      symptom: s.symptom,
      seed: s.seed,
      isTrap: s.isTrap,
      trapAttribute: s.trapAttribute,
      thresholds: s.thresholds,
    },
    asnNames: Object.fromEntries(Object.entries(def.asnNames).map(([k, v]) => [k, v])),
    traffic: emptyTrafficState(def),
  };
}

export class IncidentAgent extends Agent<Env, AgentState> {
  override initialState: AgentState = { ...scenarioState(defaultScenario()), incidents: [] };

  /** Per-isolate cache. Never authoritative: rebuilt from SQLite on a miss. */
  private compiled = new Map<string, CompiledRule>();
  /** Per-isolate cache of the finished traffic panel, so refreshState stays cheap. */
  private readyTraffic: TrafficState | null = null;

  override async onStart(): Promise<void> {
    store.migrate(this.ctx.storage.sql);
    this.refreshState();
  }

  /** Clients may not push state at all. Everything a client can change goes through @callable. */
  override validateStateChange(_next: AgentState, source: Connection | "server"): void {
    if (source !== "server") throw new Error("state is server-owned; use the callable methods");
  }

  /** Raw SqlStorage. The SDK's own `this.db` tag is not used, to keep one query style. */
  private get db(): SqlStorage {
    return this.ctx.storage.sql;
  }

  /** The operator's chosen scenario for the live traffic panel and the next investigation. */
  private activeScenario(): ScenarioDefinition {
    const id = store.getSetting(this.db, SETTING_SCENARIO_ID);
    return (id && SCENARIOS.find((d) => d.scenario.id === id)) || defaultScenario();
  }

  // =========================================================================
  // Browser-facing (@callable)
  // =========================================================================

  /**
   * Switch which scenario the live traffic panel shows and the next investigation targets.
   * Traffic for every scenario is kept (keyed by scenarioId + seed, store.ts), so switching back
   * to a previously generated scenario does not regenerate it.
   */
  @callable()
  async selectScenario(scenarioIdInput: unknown): Promise<TrafficState> {
    if (!isId(scenarioIdInput)) throw new Error("selectScenario takes a scenario ID");
    const def = SCENARIOS.find((d) => d.scenario.id === scenarioIdInput);
    if (!def) throw new Error(`unknown scenario ${JSON.stringify(scenarioIdInput)}`);
    store.setSetting(this.db, SETTING_SCENARIO_ID, def.scenario.id);
    this.readyTraffic = null;
    return this.refreshState().traffic;
  }

  /**
   * Generate the next missing traffic chunk. The browser calls this repeatedly on load; each
   * call is one WebSocket message, which the docs say refreshes the CPU budget, so each call
   * stays inside one 10 ms slice.
   */
  @callable()
  async generateTrafficChunk(): Promise<TrafficState> {
    const def = this.activeScenario();
    const have = new Set(store.listChunks(this.db, def.scenario.id, def.scenario.seed).map((c) => c.chunkIndex));
    const next = planChunks(def.scenario.requestCount).find((p) => !have.has(p.index));
    if (next) this.ensureTrafficChunk(def.scenario.id, def.scenario.seed, next.index);
    return this.refreshState().traffic;
  }

  @callable()
  async startInvestigation(symptomInput: unknown): Promise<{ incidentId: string }> {
    const checked = checkSymptom(symptomInput);
    if (!checked.ok) throw new Error(checked.reason);
    // Retention (DESIGN.md section 11): the SDK does not clean up cf_agents_workflows itself.
    // Cheap, so it runs on every investigation start rather than needing its own schedule.
    store.pruneWorkflowTracking(this.db, WORKFLOW_TRACKING_RETENTION_MS, Date.now());
    const active = store.countIncidentsWithStatus(this.db, ["investigating", "awaiting-approval"]);
    if (active >= MAX_ACTIVE_INVESTIGATIONS) {
      throw new Error(`at most ${MAX_ACTIVE_INVESTIGATIONS} investigations can be open at once`);
    }
    const def = this.activeScenario();
    const incidentId = `inc_${crypto.randomUUID().replace(/-/g, "")}`;
    const now = Date.now();
    const incident: Incident = {
      id: incidentId,
      scenarioId: def.scenario.id,
      seed: def.scenario.seed,
      symptom: checked.symptom,
      // The workflow instance ID is the incident ID, so it is known before the workflow starts
      // and callbacks can be matched without a lookup.
      workflowInstanceId: incidentId,
      status: "investigating",
      hypothesis: null,
      proposedRuleVersionId: null,
      baselineRuleVersionId: null,
      appliedRuleVersionId: null,
      approval: null,
      recovery: null,
      failureReason: null,
      evidenceIds: [],
      report: null,
      lesson: null,
      modelNeuronsUsed: 0,
      createdAt: now,
      updatedAt: now,
    };
    store.saveIncident(this.db, incident);
    const params: InvestigationParams = {
      incidentId,
      scenarioId: def.scenario.id,
      seed: def.scenario.seed,
      symptom: checked.symptom,
    };
    await this.runWorkflow(WORKFLOW_BINDING, params, { id: incidentId });
    this.refreshState();
    return { incidentId };
  }

  /**
   * Approve takes a rule version ID and nothing else. CLAUDE.md invariant 1: the rule that gets
   * applied is re-read from SQLite by the apply step; a client can never submit a rule here.
   */
  @callable()
  async approve(incidentIdInput: unknown, ruleVersionIdInput: unknown): Promise<{ ok: true }> {
    if (!isId(incidentIdInput) || !isId(ruleVersionIdInput)) throw new Error("approve takes an incident ID and a rule version ID");
    const incident = store.getIncident(this.db, incidentIdInput);
    if (!incident) throw new Error("unknown incident");
    if (incident.status !== "awaiting-approval") throw new Error(`incident is ${incident.status}, not awaiting-approval`);
    if (incident.proposedRuleVersionId !== ruleVersionIdInput) {
      throw new Error("rule version does not match the rule the operator was shown");
    }
    const decidedAt = Date.now();
    // Audit row first, then the signal. If the signal fails, the audit still shows intent,
    // and the apply step still requires this row.
    store.appendApproval(this.db, {
      incidentId: incident.id,
      ruleVersionId: ruleVersionIdInput,
      decision: "approved",
      reason: null,
      decidedAt,
    });
    store.saveIncident(this.db, {
      ...incident,
      approval: { decidedAt, decision: "approved", reason: null },
      updatedAt: decidedAt,
    });
    await this.approveWorkflow(incident.workflowInstanceId, { metadata: { ruleVersionId: ruleVersionIdInput } });
    logEvent(incident.id, "decision", { decision: "approved", ruleVersionId: ruleVersionIdInput });
    this.refreshState();
    return { ok: true };
  }

  @callable()
  async reject(incidentIdInput: unknown, reasonInput: unknown): Promise<{ ok: true }> {
    if (!isId(incidentIdInput)) throw new Error("reject takes an incident ID");
    const reason = typeof reasonInput === "string" ? reasonInput.slice(0, 500) : null;
    const incident = store.getIncident(this.db, incidentIdInput);
    if (!incident) throw new Error("unknown incident");
    if (incident.status !== "awaiting-approval") throw new Error(`incident is ${incident.status}, not awaiting-approval`);
    const decidedAt = Date.now();
    store.appendApproval(this.db, {
      incidentId: incident.id,
      ruleVersionId: incident.proposedRuleVersionId,
      decision: "rejected",
      reason,
      decidedAt,
    });
    store.saveIncident(this.db, {
      ...incident,
      status: "rejected",
      approval: { decidedAt, decision: "rejected", reason },
      updatedAt: decidedAt,
    });
    this.markVersion(incident.proposedRuleVersionId, "rejected");
    await this.rejectWorkflow(incident.workflowInstanceId, { reason: reason ?? "rejected by operator" });
    logEvent(incident.id, "decision", { decision: "rejected", reason });
    this.refreshState();
    return { ok: true };
  }

  // =========================================================================
  // Workflow-facing RPC. Each call is small, bounded work.
  // =========================================================================

  /** Generate, encode, aggregate and store one chunk. Idempotent. Bounded by CHUNK_SIZE. */
  ensureTrafficChunk(scenarioId: string, seed: number, chunkIndex: number): { digest: string; count: number } {
    const def = this.scenarioOrThrow(scenarioId);
    const plan = planChunks(def.scenario.requestCount)[chunkIndex];
    if (!plan || !Number.isInteger(chunkIndex)) throw new Error(`chunk ${chunkIndex} out of range`);
    const existing = store.listChunks(this.db, scenarioId, seed).find((c) => c.chunkIndex === chunkIndex);
    if (existing) return { digest: existing.digest, count: existing.count };
    const traffic = generateRange(def, seed, plan.start, plan.count);
    const blob = encodeTraffic(traffic);
    const digest = chunkDigest(blob);
    const partial = aggregateChunk(traffic, def.scenario.durationMs, def.scenario.symptomStatus);
    store.insertChunk(this.db, {
      scenarioId,
      seed,
      chunkIndex,
      start: plan.start,
      count: plan.count,
      blob,
      digest,
      partial: JSON.stringify(partial),
    });
    return { digest, count: plan.count };
  }

  /** Digest over all chunks. Fails if any chunk is missing: the caller must generate first. */
  trafficDigest(scenarioId: string, seed: number): { digest: string; count: number; chunks: number } {
    const def = this.scenarioOrThrow(scenarioId);
    const rows = store.listChunks(this.db, scenarioId, seed);
    const expected = planChunks(def.scenario.requestCount).length;
    if (rows.length !== expected) throw new Error(`traffic incomplete: ${rows.length} of ${expected} chunks`);
    return {
      digest: trafficDigest(rows.map((r) => r.digest)),
      count: rows.reduce((a, r) => a + r.count, 0),
      chunks: rows.length,
    };
  }

  /** Merge the per-chunk partial aggregates. Cheap: partials are small count arrays. */
  summarizeTraffic(incidentId: string, scenarioId: string, seed: number): TrafficSummary {
    const def = this.scenarioOrThrow(scenarioId);
    const summary = this.mergedSummary(def, seed);
    store.saveSummary(this.db, incidentId, JSON.stringify(summary));
    this.recordBreakdownEvidence(incidentId, summary);
    this.refreshState();
    return summary;
  }

  /** One Evidence row per breakdown, so a hypothesis can cite it and the UI can drill into it. */
  private recordBreakdownEvidence(incidentId: string, summary: TrafficSummary): void {
    const now = Date.now();
    const record = (slice: "all" | "symptom", b: TrafficSummary["breakdowns"][number]) => {
      store.saveEvidence(this.db, {
        id: b.evidenceId,
        incidentId,
        kind: "breakdown",
        claim: `${b.dimension} breakdown over ${slice === "all" ? "all traffic" : summary.symptomSlice.description}`,
        producedBy: "aggregator",
        data: b,
        createdAt: now,
      });
    };
    for (const b of summary.breakdowns) record("all", b);
    for (const b of summary.symptomSlice.breakdowns) record("symptom", b);
  }

  recordStep(incidentId: string, name: string, status: StepStatus, detail: string | null): void {
    store.upsertStep(this.db, incidentId, name, status, detail, Date.now());
    logEvent(incidentId, "step", { name, status, detail });
    this.refreshState();
  }

  /** Prior lessons for this scenario's family, most recent first. Step 2, load-memory. */
  loadMemory(scenarioId: string, excludeIncidentId: string): { lessons: string[] } {
    const def = this.scenarioOrThrow(scenarioId);
    const rows = store.recentLessons(this.db, def.scenario.family, excludeIncidentId, 3);
    return { lessons: rows.map((r) => r.lesson) };
  }

  /**
   * Parses a classify-symptom response into the fixed intent enum. Falls back to "unknown" on
   * any shape the model got wrong, rather than throwing: classification is informational (it
   * only shapes the hypothesize prompt) and never gates anything safety-relevant, so a bad
   * classification degrades gracefully instead of failing the incident. Step 3.
   */
  classifySymptom(response: ModelResponse): { intent: string } {
    if (response.kind !== "ok") return { intent: "unknown" };
    try {
      const parsed = JSON.parse(response.raw) as unknown;
      if (parsed && typeof parsed === "object" && "intent" in parsed && isClassifyIntent((parsed as { intent: unknown }).intent)) {
        return { intent: (parsed as { intent: string }).intent };
      }
    } catch {
      // falls through to "unknown"
    }
    return { intent: "unknown" };
  }

  /**
   * Parses a hypothesize response and checks its citations against this incident's real
   * evidence IDs. A fabricated citation is caught and surfaced, never rendered: the hypothesis
   * is not stored (Incident.hypothesis stays null) and the returned diagnostic explains why, so
   * the UI and the step's own recorded detail can show it. DESIGN.md section 9.
   */
  hypothesize(incidentId: string, response: ModelResponse): { hypothesis: string | null; fabricatedCitations: string[] } {
    if (response.kind !== "ok") return { hypothesis: null, fabricatedCitations: [] };
    let text: string | null = null;
    try {
      const parsed = JSON.parse(response.raw) as unknown;
      if (parsed && typeof parsed === "object" && "hypothesis" in parsed && typeof (parsed as { hypothesis: unknown }).hypothesis === "string") {
        text = (parsed as { hypothesis: string }).hypothesis;
      }
    } catch {
      // text stays null
    }
    if (text === null) return { hypothesis: null, fabricatedCitations: [] };
    const known = store.getEvidenceIds(this.db, incidentId);
    const check = checkCitations(text, known);
    if (!check.ok) return { hypothesis: null, fabricatedCitations: check.fabricated };
    const incident = this.incidentOrThrow(incidentId);
    this.saveIncident({ ...incident, hypothesis: text });
    return { hypothesis: text, fabricatedCitations: [] };
  }

  /**
   * Parses a write-report response, persists the report and lesson on the incident, and records
   * the lesson for later investigations in the same scenario family (step 2, load-memory, reads
   * this back). Step 13.
   */
  writeReport(incidentId: string, response: ModelResponse): { report: string | null; lesson: string | null } {
    if (response.kind !== "ok") return { report: null, lesson: null };
    let report: string | null = null;
    let lesson: string | null = null;
    try {
      const parsed = JSON.parse(response.raw) as unknown;
      if (
        parsed &&
        typeof parsed === "object" &&
        "report" in parsed &&
        "lesson" in parsed &&
        typeof (parsed as { report: unknown }).report === "string" &&
        typeof (parsed as { lesson: unknown }).lesson === "string"
      ) {
        report = (parsed as { report: string }).report;
        lesson = (parsed as { lesson: string }).lesson;
      }
    } catch {
      // report and lesson stay null
    }
    const incident = this.incidentOrThrow(incidentId);
    this.saveIncident({ ...incident, report, lesson });
    if (lesson) {
      const def = this.scenarioOrThrow(incident.scenarioId);
      store.saveLesson(this.db, { scenarioFamily: def.scenario.family, lesson, incidentId, createdAt: Date.now() });
    }
    return { report, lesson };
  }

  /**
   * Called by the Workflow once per model call, for every purpose, before any purpose-specific
   * parsing. Tracks the two things the UI needs that no single per-purpose parser (classifySymptom,
   * hypothesize, writeReport, recordDraft) owns on its own: whether the account is currently
   * quota-exhausted, and the running neuron total for this incident. Never affects retries; that
   * is `requireOkResponse`'s job (src/model/client.ts).
   */
  recordModelOutcome(incidentId: string, response: ModelResponse): void {
    if (response.kind === "quota-exhausted") {
      store.setSetting(this.db, SETTING_MODEL_QUOTA_EXHAUSTED_AT, String(this.now()));
      // Refresh here rather than relying on the step's own recordStep call to do it: this method
      // must be self-contained so modelStatus() reflects the change the instant it is called, not
      // only once something else happens to touch the state.
      this.refreshState();
      return;
    }
    if (response.kind !== "ok") return;
    store.setSetting(this.db, SETTING_MODEL_QUOTA_EXHAUSTED_AT, "");
    if (!response.usage) {
      this.refreshState();
      return;
    }
    const incident = this.incidentOrThrow(incidentId);
    this.saveIncident({ ...incident, modelNeuronsUsed: incident.modelNeuronsUsed + response.usage.neurons });
  }

  /** Persist exactly what the model returned, before anything interprets it. */
  recordDraft(incidentId: string, attempt: number, response: ModelResponse): string {
    const id = `rv_${incidentId}_${attempt}`;
    const existing = store.getRuleVersion(this.db, id);
    if (existing) return id; // A retried step records the same attempt once.
    const raw = response.kind === "ok" ? response.raw : "";
    const usage: RuleVersion["usage"] =
      response.kind === "ok" && response.usage
        ? {
            completionTokens: response.usage.completionTokens,
            maxTokens: response.usage.maxTokens,
            hitMaxTokens: response.usage.completionTokens >= response.usage.maxTokens,
          }
        : null;
    const version: RuleVersion = {
      id,
      incidentId,
      source: "model",
      attempt,
      rawModelOutput: raw,
      usage,
      ast: null,
      text: null,
      // Placeholder until validate runs; a draft is untrusted until then.
      status: "invalid-schema",
      replay: null,
      diagnostics: [],
      createdAt: Date.now(),
    };
    if (response.kind === "json-mode-failed" || response.kind === "error") {
      const failed = modelFailureOutcome(response.kind, response.message);
      version.diagnostics = failed.diagnostics;
    }
    store.saveRuleVersion(this.db, version);
    this.refreshState();
    return id;
  }

  /** Run the verification pipeline over the stored raw output. */
  validateRuleVersion(id: string): { status: RuleVersion["status"]; diagnosticCodes: string[] } {
    const v = this.versionOrThrow(id);
    if (v.source !== "model") throw new Error("only model drafts are validated here");
    if (v.rawModelOutput === "" && v.diagnostics.length > 0) {
      // The model call itself failed; the draft already carries its diagnostic.
      return { status: v.status, diagnosticCodes: v.diagnostics.map((d) => d.code) };
    }
    const outcome = verifyModelDraft(v.rawModelOutput);
    const updated: RuleVersion = { ...v, status: outcome.status, ast: outcome.ast, text: outcome.text, diagnostics: outcome.diagnostics };
    store.saveRuleVersion(this.db, updated);
    this.refreshState();
    return { status: updated.status, diagnosticCodes: updated.diagnostics.map((d) => d.code) };
  }

  /** What a failed attempt looked like, for the retry prompt. Phase 3. */
  draftFeedback(id: string): { raw: string; diagnostics: Diagnostic[] } {
    const v = this.versionOrThrow(id);
    return { raw: v.rawModelOutput, diagnostics: v.diagnostics };
  }

  /** The naive single attribute rule, generated in code from the label-blind summary. */
  createBaselineVersion(incidentId: string): string | null {
    const id = `rv_${incidentId}_baseline`;
    if (store.getRuleVersion(this.db, id)) return id;
    const raw = store.getSummary(this.db, incidentId);
    if (!raw) throw new Error("summary missing; aggregate first");
    const choice = naiveBaseline(JSON.parse(raw) as TrafficSummary);
    if (!choice) return null;
    const outcome = verifyAst(choice.ast);
    store.saveRuleVersion(this.db, {
      id,
      incidentId,
      source: "naive-baseline",
      attempt: 0,
      rawModelOutput: "",
      usage: null,
      ast: outcome.ast,
      text: outcome.text,
      status: outcome.status,
      replay: null,
      diagnostics: outcome.diagnostics,
      createdAt: Date.now(),
    });
    return id;
  }

  /**
   * Replay one chunk through a stored, verified rule. With `fromText`, the rule is re-parsed
   * from its stored text instead of its stored AST: that is how verify-recovery proves the
   * applied text is the rule that was measured.
   */
  replayRuleChunk(ruleVersionId: string, chunkIndex: number, fromText = false): ChunkReplay {
    const v = this.versionOrThrow(ruleVersionId);
    if (v.status !== "valid" && v.status !== "applied") throw new Error(`rule version is ${v.status}; only verified rules replay`);
    // The incident's own scenario, not whatever the operator has the live panel pointed at now.
    const incident = this.incidentOrThrow(v.incidentId);
    const def = this.scenarioOrThrow(incident.scenarioId);
    const dictionary = compileScenario(def).dictionary;
    const cacheKey = `${ruleVersionId}:${fromText ? "text" : "ast"}`;
    let rule = this.compiled.get(cacheKey);
    if (!rule) {
      let ast = v.ast;
      if (fromText) {
        const checked = checkRuleText(v.text ?? "");
        ast = checked.ast;
      }
      if (!ast) throw new Error("rule has no AST");
      const c = compileRule(ast, dictionary);
      if (!c.ok) throw new Error(`rule does not compile: ${c.diagnostics.map((d) => d.code).join(", ")}`);
      rule = c.rule;
      this.compiled.set(cacheKey, rule);
    }
    const blob = store.readChunkBlob(this.db, incident.scenarioId, incident.seed, chunkIndex);
    if (!blob) throw new Error(`chunk ${chunkIndex} missing`);
    const traffic = decodeTraffic(blob, incident.scenarioId, dictionary);
    if ("kind" in traffic) throw new Error(traffic.message);
    return replayChunk(rule, traffic, def.scenario.durationMs);
  }

  /** Store a merged replay on its rule version. Evidence ID is derived, stable per version. */
  recordReplay(ruleVersionId: string, merged: ChunkReplay): ReplayResult {
    const v = this.versionOrThrow(ruleVersionId);
    const incident = this.incidentOrThrow(v.incidentId);
    const def = this.scenarioOrThrow(incident.scenarioId);
    const result = toReplayResult(merged.counts, def.scenario.thresholds, `ev_replay_${v.source === "model" ? v.attempt : "baseline"}`);
    store.saveRuleVersion(this.db, { ...v, replay: result });
    store.savePanel(this.db, ruleVersionId, merged.blockedPanel);
    store.saveEvidence(this.db, {
      id: result.evidenceId,
      incidentId: v.incidentId,
      kind: "replay",
      claim: `replaying ${v.source === "model" ? `attempt ${v.attempt}'s rule` : "the naive baseline"} blocks ${result.attackBlocked}/${result.attackTotal} attack and ${result.legitimateBlocked}/${result.legitimateTotal} legitimate requests`,
      producedBy: "evaluator",
      data: result,
      createdAt: Date.now(),
    });
    this.refreshState();
    return result;
  }

  publishProposal(incidentId: string, proposedId: string, baselineId: string | null): IncidentStatus {
    const incident = this.incidentOrThrow(incidentId);
    const v = this.versionOrThrow(proposedId);
    if (v.incidentId !== incidentId || v.status !== "valid" || !v.replay) {
      throw new Error("only a verified, replayed rule version of this incident can be proposed");
    }
    this.saveIncident({
      ...incident,
      status: "awaiting-approval",
      proposedRuleVersionId: proposedId,
      baselineRuleVersionId: baselineId,
    });
    return "awaiting-approval";
  }

  markIncident(incidentId: string, status: Extract<IncidentStatus, "failed" | "timed-out" | "rejected">, reason: string | null): void {
    const incident = this.incidentOrThrow(incidentId);
    if (TERMINAL.includes(incident.status)) return;
    logEvent(incidentId, "status", { status, reason });
    this.saveIncident({ ...incident, status, failureReason: status === "failed" ? reason : incident.failureReason });
  }

  /**
   * CLAUDE.md invariants 1 and 2. Applies the rule version the operator was shown, re-read from
   * SQLite, and only if an approval row for exactly that version exists. It does not trust that
   * it was reached through the approval gate.
   */
  applyApprovedRule(incidentId: string): { ruleVersionId: string } {
    const incident = this.incidentOrThrow(incidentId);
    const proposedId = incident.proposedRuleVersionId;
    if (!proposedId) throw new Error("no proposed rule to apply");
    if (incident.appliedRuleVersionId === proposedId) return { ruleVersionId: proposedId }; // retried step
    const approval = store.findApproval(this.db, incidentId, proposedId);
    if (!approval) throw new Error("refusing to apply: no approval row for this rule version");
    const v = this.versionOrThrow(proposedId);
    if (v.status !== "valid") throw new Error(`refusing to apply: rule version is ${v.status}`);
    store.saveRuleVersion(this.db, { ...v, status: "applied" });
    this.compiled.clear();
    this.saveIncident({ ...incident, appliedRuleVersionId: proposedId });
    logEvent(incidentId, "status", { status: "applied", ruleVersionId: proposedId });
    return { ruleVersionId: proposedId };
  }

  finishIncident(incidentId: string, recovery: ReplayResult): void {
    const incident = this.incidentOrThrow(incidentId);
    if (!incident.appliedRuleVersionId) throw new Error("cannot finish: nothing applied");
    store.saveEvidence(this.db, {
      id: recovery.evidenceId,
      incidentId,
      kind: "recovery",
      claim: `after applying the rule, traffic recovery shows ${recovery.attackBlocked}/${recovery.attackTotal} attack and ${recovery.legitimateBlocked}/${recovery.legitimateTotal} legitimate requests blocked`,
      producedBy: "evaluator",
      data: recovery,
      createdAt: Date.now(),
    });
    this.saveIncident({ ...incident, status: "applied", recovery });
  }

  /** For tests and the audit query in DESIGN.md section 9. */
  unsafeActionCount(): number {
    return store.countUnsafeActions(this.db);
  }

  getIncidentForTest(incidentId: string): Incident | null {
    return store.getIncident(this.db, incidentId);
  }

  /** Test-only: insert a raw `cf_agents_workflows` row, to exercise retention pruning without waiting real time. */
  seedWorkflowTrackingRowForTest(id: string, status: string, ageSeconds: number): void {
    const updatedAt = Math.floor(Date.now() / 1000) - ageSeconds;
    this.db.exec(
      "INSERT INTO cf_agents_workflows (id, workflow_id, workflow_name, status, updated_at) VALUES (?, ?, ?, ?, ?)",
      id,
      id,
      "test-workflow",
      status,
      updatedAt,
    );
  }

  countWorkflowTrackingRowsForTest(): number {
    return this.db.exec<{ n: number }>("SELECT COUNT(*) as n FROM cf_agents_workflows").toArray()[0]?.n ?? 0;
  }

  pruneWorkflowTrackingForTest(olderThanMs: number): number {
    return store.pruneWorkflowTracking(this.db, olderThanMs, Date.now());
  }

  /** Test-only: recompute state.incidents[].modelStatus against the current (possibly
   * setClockForTest-fixed) clock, without any other state change to trigger it. */
  refreshStateForTest(): void {
    this.refreshState();
  }

  // =========================================================================
  // Workflow lifecycle callbacks
  // =========================================================================

  override async onWorkflowError(_workflowName: string, instanceId: string, error: string): Promise<void> {
    const incident = store.getIncident(this.db, instanceId);
    // A rejection also reports an error through the SDK; the incident is already "rejected".
    if (!incident || TERMINAL.includes(incident.status)) return;
    this.saveIncident({ ...incident, status: "failed", failureReason: error.slice(0, 500) });
  }

  // =========================================================================
  // Internals
  // =========================================================================

  private saveIncident(incident: Incident): void {
    store.saveIncident(this.db, { ...incident, updatedAt: Date.now() });
    this.refreshState();
  }

  private markVersion(id: string | null, status: RuleVersion["status"]): void {
    if (!id) return;
    const v = store.getRuleVersion(this.db, id);
    if (v) store.saveRuleVersion(this.db, { ...v, status });
  }

  private scenarioOrThrow(scenarioId: string): ScenarioDefinition {
    const def = SCENARIOS.find((d) => d.scenario.id === scenarioId);
    if (!def) throw new Error(`unknown scenario ${scenarioId}`);
    return def;
  }

  private incidentOrThrow(id: string): Incident {
    const i = store.getIncident(this.db, id);
    if (!i) throw new Error(`unknown incident ${id}`);
    return i;
  }

  private versionOrThrow(id: string): RuleVersion {
    const v = store.getRuleVersion(this.db, id);
    if (!v) throw new Error(`unknown rule version ${id}`);
    return v;
  }

  private mergedSummary(def: ScenarioDefinition, seed: number): TrafficSummary {
    const partials = store.readPartials(this.db, def.scenario.id, seed).map((p) => JSON.parse(p) as PartialAggregate);
    const first = partials[0];
    if (!first || partials.length !== planChunks(def.scenario.requestCount).length) {
      throw new Error("traffic incomplete");
    }
    return finalizeSummary(partials.slice(1).reduce(mergePartials, first), compileScenario(def).dictionary);
  }

  /** Rebuild the broadcast state from SQLite. The only writer of this.state. */
  private refreshState(): AgentState {
    const def = this.activeScenario();
    const next: AgentState = { ...scenarioState(def), traffic: this.trafficState(def), incidents: this.incidentViews() };
    this.setState(next);
    return next;
  }

  private trafficState(def: ScenarioDefinition): TrafficState {
    if (this.readyTraffic) return this.readyTraffic;
    const rows = store.listChunks(this.db, def.scenario.id, def.scenario.seed);
    const total = planChunks(def.scenario.requestCount).length;
    const traffic: TrafficState = { ...emptyTrafficState(def), chunksDone: rows.length };
    if (rows.length > 0) traffic.status = "generating";
    if (rows.length === total) {
      const partials = store
        .readPartials(this.db, def.scenario.id, def.scenario.seed)
        .map((p) => JSON.parse(p) as PartialAggregate);
      const first = partials[0];
      if (first) {
        traffic.status = "ready";
        traffic.panel = partials.slice(1).reduce(mergePartials, first).panel;
        traffic.digest = trafficDigest(rows.map((r) => r.digest));
        this.readyTraffic = traffic;
      }
    }
    return traffic;
  }

  private incidentViews(): IncidentView[] {
    return store.listIncidents(this.db, INCIDENTS_IN_STATE).map((i) => {
      const summaryRaw = store.getSummary(this.db, i.id);
      const proposedId = i.proposedRuleVersionId ?? `rv_${i.id}_1`;
      return {
        ...i,
        steps: store.listSteps(this.db, i.id),
        proposed: store.getRuleVersion(this.db, proposedId),
        baseline: store.getRuleVersion(this.db, `rv_${i.id}_baseline`),
        applied: i.appliedRuleVersionId ? store.getRuleVersion(this.db, i.appliedRuleVersionId) : null,
        attempts: store.listDraftAttempts(this.db, i.id),
        evidence: store.listEvidence(this.db, i.id),
        blockedPanels: {
          proposed: store.getPanel(this.db, proposedId),
          baseline: store.getPanel(this.db, `rv_${i.id}_baseline`),
        },
        summary: summaryRaw ? (JSON.parse(summaryRaw) as TrafficSummary) : null,
        modelId: this.env.MODEL_MODE === "fake" ? "fake" : this.env.MODEL_ID,
        modelStatus: this.modelStatus(),
      };
    });
  }

  /**
   * "fake" always wins (the fake model never returns quota-exhausted, so there is nothing to
   * distinguish it from). Otherwise "quota-exhausted" until a real model call succeeds again and
   * clears the flag in recordModelOutcome, or until the UTC day it was set on has passed (the
   * daily allocation resets at 00:00 UTC), or "live".
   */
  private modelStatus(): "live" | "fake" | "quota-exhausted" {
    if (this.env.MODEL_MODE === "fake") return "fake";
    const raw = store.getSetting(this.db, SETTING_MODEL_QUOTA_EXHAUSTED_AT);
    if (!raw) return "live";
    const setAt = Number(raw);
    if (!Number.isFinite(setAt) || utcDayKey(setAt) !== utcDayKey(this.now())) return "live";
    return "quota-exhausted";
  }

  /** Test-only: fixes the clock modelStatus and recordModelOutcome use to this timestamp, so the
   * UTC-day reset boundary can be exercised without waiting real time. Null restores the real clock. */
  private clockForTest: number | null = null;
  setClockForTest(fixedMs: number | null): void {
    this.clockForTest = fixedMs;
  }
  private now(): number {
    return this.clockForTest ?? Date.now();
  }
}

