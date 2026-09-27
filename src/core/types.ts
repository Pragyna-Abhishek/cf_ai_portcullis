// Shared vocabulary for the whole project. DESIGN.md section 6 is the source of truth; if a
// shape here changes, DESIGN.md changes in the same commit.
//
// Nothing in src/core imports anything platform specific. See CLAUDE.md invariant 6.

// ---------------------------------------------------------------------------
// Traffic
// ---------------------------------------------------------------------------

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "HEAD";

/**
 * One simulated HTTP request, decoded. This is the human-facing and test-facing
 * shape. It is NOT the storage or evaluation shape: see ColumnarTraffic.
 */
export type Request = {
  /** Index within the scenario. Stable for a given (scenarioId, seed). */
  index: number;
  /** Milliseconds since scenario start. */
  offsetMs: number;
  method: HttpMethod;
  path: string;
  /** ISO 3166-1 alpha-2, or "XX" when unknown. */
  country: string;
  /** Autonomous system number. */
  asn: number;
  userAgent: string;
  /** Status the origin produced for this request. */
  status: number;
  /** Ground truth from the generator. Never included in any model input. */
  label: "attack" | "legitimate";
};

/** Dictionary-encoded string columns, shared across a scenario. */
export type TrafficDictionary = {
  methods: string[];
  paths: string[];
  countries: string[];
  userAgents: string[];
};

/**
 * Storage and evaluation shape. Parallel arrays, one entry per request.
 * All string columns hold indices into the matching TrafficDictionary array.
 *
 * A ColumnarTraffic value may hold a whole scenario or one chunk of it. `start` is the
 * scenario index of element 0, so a chunk knows where it sits.
 */
export type ColumnarTraffic = {
  scenarioId: string;
  seed: number;
  /** Scenario index of the first request in this value. 0 for a whole scenario. */
  start: number;
  /** Number of requests. Every typed array below has this length. */
  count: number;
  dictionary: TrafficDictionary;
  offsetMs: Uint32Array;
  method: Uint8Array;
  path: Uint16Array;
  country: Uint16Array;
  /** Raw ASN values, not dictionary encoded. */
  asn: Uint32Array;
  userAgent: Uint16Array;
  status: Uint16Array;
  /** 1 = attack, 0 = legitimate. */
  label: Uint8Array;
};

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

export type ScenarioFamily = "credential-stuffing" | "scraper" | "l7-flood";

export type TrapAttribute = "asn" | "path" | "country" | "userAgent";

export type Scenario = {
  id: string;
  title: string;
  /** The symptom an operator would report. Seeds the demo chat message. */
  symptom: string;
  family: ScenarioFamily;
  /**
   * True when attack and legitimate traffic deliberately share one salient
   * attribute, so that a naive single attribute rule causes collateral damage.
   */
  isTrap: boolean;
  /** Which attribute is shared. Null when isTrap is false. */
  trapAttribute: TrapAttribute | null;
  seed: number;
  requestCount: number;
  /** Scenario length in milliseconds. Offsets fall in [0, durationMs). */
  durationMs: number;
  /**
   * The HTTP status that marks "the symptom" for this scenario: 401 for a credential-stuffing
   * scenario (failed logins), 503 for an l7-flood scenario (origin overload), 404 for a scraper
   * scenario (enumerating IDs that mostly don't exist). Never the ground truth label; purely a
   * status code an operator could report without knowing which requests are the attack.
   */
  symptomStatus: number;
  /** Pass and fail thresholds for this scenario. See DESIGN.md section 9. */
  thresholds: {
    minAttackBlockedRate: number;
    maxLegitimateBlockedRate: number;
  };
};

// ---------------------------------------------------------------------------
// Summaries: the only traffic representation the model ever sees
// ---------------------------------------------------------------------------

export type BreakdownDimension =
  | "path"
  | "method"
  | "country"
  | "asn"
  | "userAgent"
  | "status"
  | "timeBucket";

export type BreakdownRow = { key: string; count: number; share: number };

export type Breakdown = {
  dimension: BreakdownDimension;
  /** Descending by count, truncated to a fixed row cap. */
  rows: BreakdownRow[];
  /** Requests not represented in `rows` after truncation. */
  otherCount: number;
  /** The Evidence record this breakdown is addressable by. */
  evidenceId: string;
};

export type TrafficSummary = {
  scenarioId: string;
  seed: number;
  window: { fromMs: number; toMs: number };
  totalRequests: number;
  breakdowns: Breakdown[];
  /**
   * The same breakdowns restricted to the requests that show the symptom (the scenario's symptomStatus).
   * Computed from status alone, never from the ground truth label.
   */
  symptomSlice: {
    description: string;
    totalRequests: number;
    breakdowns: Breakdown[];
  };
  /** Aggregate signals the symptom classifier uses. */
  signals: {
    errorRate: number;
    /** Share of all requests returning the scenario's symptomStatus. */
    symptomStatusShare: number;
    status429Share: number;
  };
};

// ---------------------------------------------------------------------------
// Rule AST. This is what the model emits, validated against a JSON Schema.
// ---------------------------------------------------------------------------

export type StringField =
  | "http.request.method"
  | "http.request.uri.path"
  | "http.user_agent"
  | "ip.src.country";

export type NumberField = "http.response.code" | "ip.src.asnum";

export type RuleField = StringField | NumberField;

export type RuleAST =
  | { kind: "and"; left: RuleAST; right: RuleAST }
  | { kind: "or"; left: RuleAST; right: RuleAST }
  | { kind: "not"; operand: RuleAST }
  | {
      kind: "compare";
      field: RuleField;
      op: "eq" | "ne";
      value: string | number;
      /** Wrap the field in lower() before comparing. String fields only. */
      lower?: boolean;
    }
  | { kind: "contains"; field: StringField; value: string; lower?: boolean }
  | { kind: "in"; field: RuleField; values: Array<string | number>; lower?: boolean };

// ---------------------------------------------------------------------------
// Evidence, rule versions, incidents
// ---------------------------------------------------------------------------

export type Evidence = {
  /** Stable within an incident, for example "ev_3". Cited by the model. */
  id: string;
  incidentId: string;
  kind: "breakdown" | "replay" | "recovery" | "memory";
  /** Plain language claim this evidence supports. */
  claim: string;
  /** Which deterministic tool produced it. */
  producedBy: string;
  /**
   * Small serialized payload, never raw requests. Typed as a concrete union rather than
   * `unknown`: the Agent SDK's RPC stub typing collapses a state shape containing `unknown` to
   * `never`, which silently breaks every `agent.state` access at every call site, not just this
   * one (measured while wiring the evidence ledger into AgentState in Phase 4).
   */
  data: Breakdown | ReplayResult;
  createdAt: number;
};

/** Offsets into the rule text, as JavaScript string indices (UTF-16 code units). */
export type Span = { start: number; end: number };

export type Diagnostic = {
  severity: "error" | "warning";
  /** Stable machine code, for example "E_UNKNOWN_FIELD". See src/core/rules/diagnostics.ts. */
  code: string;
  message: string;
  /** Where in the rule text the problem is, when known. */
  span: Span | null;
};

/** The four counts every replay produces. Everything else is derived from these. */
export type ReplayCounts = {
  attackTotal: number;
  attackBlocked: number;
  legitimateTotal: number;
  legitimateBlocked: number;
};

export type ReplayResult = ReplayCounts & {
  /** Derived in code from the four counts above. */
  attackBlockedRate: number;
  legitimateBlockedRate: number;
  /** Deterministic. Formula in DESIGN.md section 9. Never model produced. */
  safetyScore: number;
  /** True when the rates clear the scenario's thresholds. */
  passesThresholds: boolean;
  evidenceId: string;
};

export type RuleVersionStatus =
  | "invalid-schema"
  | "invalid-types"
  | "roundtrip-failed"
  | "valid"
  | "applied"
  | "rejected";

/** Where a rule version came from. The baseline is generated in code, never by the model. */
export type RuleVersionSource = "model" | "naive-baseline";

export type RuleVersion = {
  id: string;
  incidentId: string;
  source: RuleVersionSource;
  /** 1-based. Bounded by MAX_DRAFT_ATTEMPTS. */
  attempt: number;
  /** Exactly what the model returned, pre-validation. Kept for audit. */
  rawModelOutput: string;
  /** Null when the output failed schema validation. */
  ast: RuleAST | null;
  /** Rendered by our printer from `ast`. Null when `ast` is null. */
  text: string | null;
  status: RuleVersionStatus;
  /** Set for every status from "valid" onward. */
  replay: ReplayResult | null;
  diagnostics: Diagnostic[];
  createdAt: number;
};

export type IncidentStatus =
  | "investigating"
  | "awaiting-approval"
  | "applied"
  | "rejected"
  | "failed"
  | "timed-out";

export type Incident = {
  id: string;
  scenarioId: string;
  seed: number;
  /** The operator's own words. Treated as untrusted input. */
  symptom: string;
  workflowInstanceId: string;
  status: IncidentStatus;
  hypothesis: string | null;
  /** The rule version the operator was shown and asked to approve. */
  proposedRuleVersionId: string | null;
  /** The naive single attribute rule, generated in code, shown beside the proposal. */
  baselineRuleVersionId: string | null;
  /** Set only by the apply step, only after approval. */
  appliedRuleVersionId: string | null;
  approval: {
    decidedAt: number;
    decision: "approved" | "rejected";
    reason: string | null;
  } | null;
  /** Replay of the applied rule against the same traffic, computed after apply. */
  recovery: ReplayResult | null;
  /** Why the incident failed, when status is "failed". Written by code, not the model. */
  failureReason: string | null;
  evidenceIds: string[];
  report: string | null;
  /** One sentence, retrieved by later investigations in the same family. */
  lesson: string | null;
  /**
   * Neurons billed across every model call this incident has made so far, computed in code from
   * each response's token usage (never model produced). Zero for the fake model, which reports no
   * usage. Accumulates across classify, hypothesize, every draft attempt, and write-report.
   */
  modelNeuronsUsed: number;
  createdAt: number;
  updatedAt: number;
};
