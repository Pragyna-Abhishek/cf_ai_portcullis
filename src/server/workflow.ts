// InvestigationWorkflow. The sequence is fixed in code; the model decides nothing about which
// steps run. DESIGN.md section 8 has the full table. Steps 6, 7 and 8 are a bounded retry loop
// (Phase 3): up to MAX_DRAFT_ATTEMPTS drafts, diagnostics from a failed attempt fed back into
// the next prompt, every attempt persisted as its own RuleVersion.
//
// Determinism rules this file obeys (Rules of Workflows):
//   - Step names are constants, or derived from `attempt`, which is bounded by the constant
//     MAX_DRAFT_ATTEMPTS and driven by a plain `for` loop -- never by model output. CLAUDE.md
//     invariant 12.
//   - Every value that crosses a step boundary is a step return: IDs, digests, counts, and one
//     summary. Never traffic. CLAUDE.md invariant 9.
//   - No Date.now() or randomness outside steps. The seed comes from the payload.

import { AgentWorkflow, WorkflowRejectedError, type AgentWorkflowEvent, type AgentWorkflowStep } from "agents/workflows";
import { NonRetryableError } from "cloudflare:workflows";
import { planChunks } from "../core/chunks";
import { CLASSIFY_JSON_SCHEMA, HYPOTHESIZE_JSON_SCHEMA, TEXT_RULE_JSON_SCHEMA, WRITE_REPORT_JSON_SCHEMA } from "../core/narrative-schema";
import { buildClassifyPrompt, buildDraftRulePrompt, buildHypothesizePrompt, buildReportPrompt, MAX_DRAFT_ATTEMPTS, type PriorAttempt } from "../core/prompt";
import { toReplayResult } from "../core/replay";
import { mergeChunkReplays, type ChunkReplay } from "../core/rules/evaluate";
import { findScenario } from "../core/scenarios";
import type { ReplayResult, RuleVersionStatus, TrafficSummary } from "../core/types";
import { QuotaExhaustedError, requireOkResponse } from "../model/client";
import type { IncidentAgent } from "./agent";
import { modelFor } from "./model";
import { CLASSIFY_SYMPTOM_TEMPLATES, DRAFT_RULE_TEXT_TEMPLATES, HYPOTHESIZE_TEMPLATES, WRITE_REPORT_TEMPLATES } from "./prompts";
import type { InvestigationParams } from "./views";

export const STEP = {
  ensureTraffic: "ensure-traffic",
  aggregateTraffic: "aggregate-traffic",
  loadMemory: "load-memory",
  classifySymptom: "classify-symptom",
  hypothesize: "hypothesize",
  writeReport: "write-report",
  draftRule: (i: number) => `draft-rule-attempt-${i}`,
  validateRule: (i: number) => `validate-rule-attempt-${i}`,
  draftFeedback: (i: number) => `draft-feedback-attempt-${i}`,
  replayRule: (i: number) => `replay-rule-attempt-${i}`,
  baselineRule: "naive-baseline",
  replayBaseline: "replay-naive-baseline",
  failIncident: "fail-incident",
  publishProposal: "publish-proposal",
  waitForApproval: "wait-for-approval",
  markTimedOut: "mark-timed-out",
  applyRule: "apply-rule",
  verifyRecovery: "verify-recovery",
  persistIncident: "persist-incident",
} as const;

// Step results are plain data. RPC results arrive branded Disposable, which a step cannot
// serialize, so every tracked step names its plain result type explicitly.
type TrafficDigest = { digest: string; count: number; chunks: number };
type Validation = { status: RuleVersionStatus; diagnosticCodes: string[] };
type Applied = { ruleVersionId: string };
const APPROVAL_TIMEOUT = "7 days";
/** roundtrip-failed means our printer and parser disagree: our bug, never worth retrying. */
const HARD_FAILURE: RuleVersionStatus = "roundtrip-failed";

// Retry policies from DESIGN.md section 8.
const cpuHeavy = { retries: { limit: 3, delay: "2 seconds", backoff: "exponential" }, timeout: "5 minutes" } as const;
const cheap = { retries: { limit: 3, delay: "1 second", backoff: "exponential" }, timeout: "1 minute" } as const;
const modelCall = { retries: { limit: 2, delay: "5 seconds", backoff: "exponential" }, timeout: "2 minutes" } as const;

export class InvestigationWorkflow extends AgentWorkflow<IncidentAgent, InvestigationParams> {
  override async run(event: AgentWorkflowEvent<InvestigationParams>, step: AgentWorkflowStep) {
    const p = event.payload;
    const def = findScenario(p.scenarioId);
    if (!def) throw new NonRetryableError(`unknown scenario ${p.scenarioId}`);
    const agent = this.agent;

    /** Record step progress for the UI from inside the step, so a replayed step does not repeat it. */
    const tracked = async <T>(name: string, fn: () => Promise<T>, detail?: (r: T) => string | null): Promise<T> => {
      await agent.recordStep(p.incidentId, name, "running", null);
      try {
        const r = await fn();
        await agent.recordStep(p.incidentId, name, "complete", detail ? detail(r) : null);
        return r;
      } catch (e) {
        await agent.recordStep(p.incidentId, name, "error", e instanceof Error ? e.message.slice(0, 300) : String(e));
        throw e;
      }
    };

    // 1. Traffic exists, chunk by chunk. Each chunk is a separate call into the Agent.
    const traffic = await step.do(STEP.ensureTraffic, cpuHeavy, () =>
      tracked<TrafficDigest>(
        STEP.ensureTraffic,
        async () => {
          for (const c of planChunks(def.scenario.requestCount)) await agent.ensureTrafficChunk(p.scenarioId, p.seed, c.index);
          return agent.trafficDigest(p.scenarioId, p.seed);
        },
        (r) => `${r.count} requests in ${r.chunks} chunks, digest ${r.digest}`,
      ),
    );

    // 4. Summaries only. This is the whole of what the model will see about traffic.
    // Runs before steps 2 and 3 below: both need the summary (its "signals", or its evidence
    // IDs), which does not exist yet at DESIGN.md section 8's original step numbering. Recorded
    // there as a correction, the same way the retry loop's exit condition was.
    const summary = await step.do(STEP.aggregateTraffic, cpuHeavy, () =>
      tracked<TrafficSummary>(
        STEP.aggregateTraffic,
        () => agent.summarizeTraffic(p.incidentId, p.scenarioId, p.seed),
        (s) => `${s.breakdowns.length + s.symptomSlice.breakdowns.length} breakdowns over ${s.totalRequests} requests`,
      ),
    );

    // 2. Prior lessons for this scenario's family, if any.
    const memory = await step.do(STEP.loadMemory, cheap, () =>
      tracked<{ lessons: string[] }>(
        STEP.loadMemory,
        () => agent.loadMemory(p.scenarioId, p.incidentId),
        (m) => (m.lessons.length ? `${m.lessons.length} prior lesson(s)` : "no prior lessons"),
      ),
    );

    // 3. Classify the symptom into a fixed enum. Informational only: it shapes the hypothesize
    // prompt below and nothing else, so a bad classification degrades gracefully.
    const classification = await step.do(STEP.classifySymptom, modelCall, () =>
      tracked<{ intent: string }>(
        STEP.classifySymptom,
        async () => {
          const model = modelFor(this.env);
          const prompt = buildClassifyPrompt(CLASSIFY_SYMPTOM_TEMPLATES, { symptom: p.symptom, signals: summary.signals });
          const response = await model.generateJson({ ...prompt, purpose: "classify-symptom", jsonSchema: CLASSIFY_JSON_SCHEMA });
          await agent.recordModelOutcome(p.incidentId, response);
          return agent.classifySymptom(response);
        },
        (c) => c.intent,
      ),
    );

    // 5. A hypothesis citing evidence IDs. A fabricated citation is caught and surfaced (the
    // step's own recorded detail says so), never rendered as if it were backed by data.
    const hypothesis = await step.do(STEP.hypothesize, modelCall, () =>
      tracked<{ hypothesis: string | null; fabricatedCitations: string[] }>(
        STEP.hypothesize,
        async () => {
          const model = modelFor(this.env);
          const prompt = buildHypothesizePrompt(HYPOTHESIZE_TEMPLATES, {
            symptom: p.symptom,
            intent: classification.intent,
            summary,
            lessons: memory.lessons,
          });
          const response = await model.generateJson({ ...prompt, purpose: "hypothesize", jsonSchema: HYPOTHESIZE_JSON_SCHEMA });
          await agent.recordModelOutcome(p.incidentId, response);
          return agent.hypothesize(p.incidentId, response);
        },
        (h) => (h.fabricatedCitations.length ? `rejected: fabricated citations ${h.fabricatedCitations.join(", ")}` : (h.hypothesis ?? "none")),
      ),
    );
    void hypothesis;

    // 6, 7, 8 (loop). Up to MAX_DRAFT_ATTEMPTS drafts. A schema or type failure feeds its
    // diagnostics back into the next attempt's prompt and retries; a roundtrip failure is our
    // bug and is never retried; exhausting every attempt fails the incident visibly.
    let draftId: string | null = null;
    let validation: Validation | null = null;
    let finalAttempt = 1;
    let priorAttempts: PriorAttempt[] = [];
    for (let attempt = 1; attempt <= MAX_DRAFT_ATTEMPTS; attempt++) {
      finalAttempt = attempt;
      const draftName = STEP.draftRule(attempt);
      const attemptDraftId = await step.do(draftName, modelCall, () =>
        tracked<string>(draftName, async () => {
          const model = modelFor(this.env);
          const prompt = buildDraftRulePrompt(DRAFT_RULE_TEXT_TEMPLATES, { symptom: p.symptom, summary, priorAttempts });
          const response = await model.generateJson({ ...prompt, purpose: "draft-rule-text", jsonSchema: TEXT_RULE_JSON_SCHEMA });
          await agent.recordModelOutcome(p.incidentId, response);
          try {
            requireOkResponse(response);
          } catch (e) {
            // A daily quota error is never retried, at any level (CLAUDE.md): NonRetryableError
            // stops the Workflow's own step-retry policy from spending the rest of the day's
            // allocation on a call that cannot succeed until the daily reset.
            if (e instanceof QuotaExhaustedError) throw new NonRetryableError(e.message);
            throw e;
          }
          return agent.recordDraft(p.incidentId, attempt, response);
        }),
      );
      draftId = attemptDraftId;

      const validateName = STEP.validateRule(attempt);
      const attemptValidation = await step.do(validateName, cheap, () =>
        tracked<Validation>(
          validateName,
          () => agent.validateRuleVersion(attemptDraftId),
          (v) => (v.diagnosticCodes.length ? `${v.status}: ${v.diagnosticCodes.join(", ")}` : v.status),
        ),
      );
      validation = attemptValidation;

      if (attemptValidation.status === "valid" || attemptValidation.status === HARD_FAILURE) break;
      if (attempt === MAX_DRAFT_ATTEMPTS) break;

      // Feed this attempt's raw output and diagnostics back into the next prompt.
      const feedbackName = STEP.draftFeedback(attempt);
      const feedback = await step.do(feedbackName, cheap, () =>
        tracked<PriorAttempt>(feedbackName, () => agent.draftFeedback(attemptDraftId)),
      );
      priorAttempts = [...priorAttempts, feedback];
    }
    if (!draftId || !validation) throw new Error("unreachable: loop always runs at least once");

    if (validation.status !== "valid") {
      // All attempts exhausted, or a hard (roundtrip) failure: fail the incident, visibly, with
      // every attempt already persisted (RuleVersion rows) and the reason it stopped.
      await step.do(STEP.failIncident, cheap, () =>
        tracked<string>(STEP.failIncident, async () => {
          await agent.markIncident(p.incidentId, "failed", `draft ${validation.status}: ${validation.diagnosticCodes.join(", ")}`);
          return validation.status;
        }),
      );
      return { status: "failed" as const };
    }

    // 8. Replay the proposal, and the naive baseline beside it.
    const replayAll = async (ruleVersionId: string, fromText: boolean): Promise<ChunkReplay> => {
      let merged: ChunkReplay | null = null;
      for (const c of planChunks(def.scenario.requestCount)) {
        const part = await agent.replayRuleChunk(ruleVersionId, c.index, fromText);
        merged = merged ? mergeChunkReplays(merged, part) : part;
      }
      if (!merged) throw new Error("scenario has no traffic");
      return merged;
    };

    const finalDraftId = draftId;
    const replayName = STEP.replayRule(finalAttempt);
    const proposedReplay = await step.do(replayName, cpuHeavy, () =>
      tracked<ReplayResult>(replayName, async () => agent.recordReplay(finalDraftId, await replayAll(finalDraftId, false)), describeReplay),
    );

    const baselineId = await step.do(STEP.baselineRule, cheap, () =>
      tracked<string | null>(STEP.baselineRule, () => agent.createBaselineVersion(p.incidentId)),
    );
    if (baselineId) {
      await step.do(STEP.replayBaseline, cpuHeavy, () =>
        tracked<ReplayResult>(STEP.replayBaseline, async () => agent.recordReplay(baselineId, await replayAll(baselineId, false)), describeReplay),
      );
    }

    // 9. Ask the human.
    await step.do(STEP.publishProposal, cheap, () =>
      tracked<string>(STEP.publishProposal, async () => {
        const status = await agent.publishProposal(p.incidentId, finalDraftId, baselineId);
        await agent.recordStep(p.incidentId, STEP.waitForApproval, "waiting", "waiting for the operator");
        return status;
      }),
    );

    // 10. Durable gate. Nothing below runs without an approval event.
    try {
      await this.waitForApproval(step, { timeout: APPROVAL_TIMEOUT, stepName: STEP.waitForApproval });
    } catch (e) {
      if (e instanceof WorkflowRejectedError) {
        // The reject callable already recorded the decision and the audit row.
        await agent.recordStep(p.incidentId, STEP.waitForApproval, "complete", "rejected by operator");
        return { status: "rejected" as const };
      }
      // waitForEvent throws on timeout (Workflows docs, "Timeout behavior").
      await step.do(STEP.markTimedOut, cheap, () =>
        tracked<string>(STEP.markTimedOut, async () => {
          await agent.markIncident(p.incidentId, "timed-out", null);
          return "timed-out";
        }),
      );
      return { status: "timed-out" as const };
    }
    await agent.recordStep(p.incidentId, STEP.waitForApproval, "complete", "approved by operator");

    // 11. Apply exactly the stored version the operator was shown. The Agent re-reads it and
    //     checks the approval row itself; a refusal is final, not retried.
    const applied = await step.do(STEP.applyRule, cheap, () =>
      tracked<Applied>(STEP.applyRule, async () => {
        try {
          return await agent.applyApprovedRule(p.incidentId);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          if (message.includes("refusing to apply")) throw new NonRetryableError(message);
          throw e;
        }
      }),
    );

    // 12. Re-parse the applied rule from its stored text and replay it: what is measured is
    //     what is applied.
    const recovery = await step.do(STEP.verifyRecovery, cpuHeavy, () =>
      tracked<ReplayResult>(
        STEP.verifyRecovery,
        async () => toReplayResult((await replayAll(applied.ruleVersionId, true)).counts, def.scenario.thresholds, "ev_recovery"),
        describeReplay,
      ),
    );

    // 13. Report and lesson. The lesson is persisted for later investigations in this family.
    await step.do(STEP.writeReport, modelCall, () =>
      tracked<{ report: string | null; lesson: string | null }>(
        STEP.writeReport,
        async () => {
          const model = modelFor(this.env);
          const outcome = { proposedRule: describeReplay(proposedReplay), recovery: describeReplay(recovery), approved: true };
          const prompt = buildReportPrompt(WRITE_REPORT_TEMPLATES, { symptom: p.symptom, hypothesis: hypothesis.hypothesis, outcome });
          const response = await model.generateJson({ ...prompt, purpose: "write-report", jsonSchema: WRITE_REPORT_JSON_SCHEMA });
          await agent.recordModelOutcome(p.incidentId, response);
          return agent.writeReport(p.incidentId, response);
        },
        (r) => r.lesson ?? "no lesson recorded",
      ),
    );

    // 14. Final state.
    await step.do(STEP.persistIncident, cheap, () =>
      tracked<string>(STEP.persistIncident, async () => {
        await agent.finishIncident(p.incidentId, recovery);
        return traffic.digest;
      }),
    );
    return { status: "applied" as const, ruleVersionId: applied.ruleVersionId };
  }
}

function describeReplay(r: ReplayResult | null): string | null {
  if (!r) return null;
  return `attack blocked ${r.attackBlocked}/${r.attackTotal}, legitimate blocked ${r.legitimateBlocked}/${r.legitimateTotal}`;
}

