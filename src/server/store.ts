// SQLite persistence for the Agent. Plain functions over SqlStorage so the schema and the
// queries are in one place. JSON columns hold values that are only ever read back whole.

import type { Diagnostic, Evidence, Incident, IncidentStatus, ReplayResult, RuleAST, RuleVersion } from "../core/types";
import type { StepStatus, StepView } from "./views";

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS traffic_chunks (
     scenario_id TEXT NOT NULL,
     seed INTEGER NOT NULL,
     chunk_index INTEGER NOT NULL,
     start INTEGER NOT NULL,
     count INTEGER NOT NULL,
     blob BLOB NOT NULL,
     digest TEXT NOT NULL,
     partial TEXT NOT NULL,
     PRIMARY KEY (scenario_id, seed, chunk_index)
   )`,
  `CREATE TABLE IF NOT EXISTS incidents (
     id TEXT PRIMARY KEY,
     status TEXT NOT NULL,
     proposed_rule_version_id TEXT,
     applied_rule_version_id TEXT,
     data TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS rule_versions (
     id TEXT PRIMARY KEY,
     incident_id TEXT NOT NULL,
     source TEXT NOT NULL,
     attempt INTEGER NOT NULL,
     status TEXT NOT NULL,
     raw_model_output TEXT NOT NULL,
     ast TEXT,
     text TEXT,
     replay TEXT,
     diagnostics TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  // Append-only audit log. Written before the workflow is signaled; read by the apply step.
  `CREATE TABLE IF NOT EXISTS approvals (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     incident_id TEXT NOT NULL,
     rule_version_id TEXT,
     decision TEXT NOT NULL,
     reason TEXT,
     decided_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS steps (
     incident_id TEXT NOT NULL,
     name TEXT NOT NULL,
     status TEXT NOT NULL,
     detail TEXT,
     at INTEGER NOT NULL,
     PRIMARY KEY (incident_id, name)
   )`,
  // Blocked requests per time bucket and status class, for the traffic panel. Derived from the
  // same replay as the counts.
  `CREATE TABLE IF NOT EXISTS replay_panels (
     rule_version_id TEXT PRIMARY KEY,
     panel TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS summaries (
     incident_id TEXT PRIMARY KEY,
     data TEXT NOT NULL
   )`,
  // Small durable settings, currently just the operator's chosen scenario. A table rather than
  // Agent state so it survives eviction the same way everything else here does.
  `CREATE TABLE IF NOT EXISTS settings (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
  // Evidence ledger: one row per deterministic claim a hypothesis or the UI can cite. Phase 4.
  `CREATE TABLE IF NOT EXISTS evidence (
     id TEXT NOT NULL,
     incident_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     claim TEXT NOT NULL,
     produced_by TEXT NOT NULL,
     data TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (incident_id, id)
   )`,
  // One sentence per finished incident, retrieved by later investigations in the same family.
  `CREATE TABLE IF NOT EXISTS lessons (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     scenario_family TEXT NOT NULL,
     lesson TEXT NOT NULL,
     incident_id TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
];

export function migrate(sql: SqlStorage): void {
  for (const stmt of SCHEMA) sql.exec(stmt);
  // Added in Phase 6 for step timings. A Durable Object created before this change already has
  // the `steps` table, so `CREATE TABLE IF NOT EXISTS` above does not add the column; this does.
  try {
    sql.exec("ALTER TABLE steps ADD COLUMN started_at INTEGER");
  } catch {
    // Column already exists.
  }
  // Added to make a failed draft attempt diagnosable: token accounting for the model call that
  // produced it, as JSON (same convention as the `diagnostics` and `replay` columns). A Durable
  // Object created before this change already has `rule_versions` without it.
  try {
    sql.exec("ALTER TABLE rule_versions ADD COLUMN usage TEXT");
  } catch {
    // Column already exists.
  }
}

// ---------------------------------------------------------------------------
// Traffic
// ---------------------------------------------------------------------------

export type ChunkRow = { chunkIndex: number; start: number; count: number; digest: string };

export function listChunks(sql: SqlStorage, scenarioId: string, seed: number): ChunkRow[] {
  return sql
    .exec<{ chunk_index: number; start: number; count: number; digest: string }>(
      "SELECT chunk_index, start, count, digest FROM traffic_chunks WHERE scenario_id = ? AND seed = ? ORDER BY chunk_index",
      scenarioId,
      seed,
    )
    .toArray()
    .map((r) => ({ chunkIndex: r.chunk_index, start: r.start, count: r.count, digest: r.digest }));
}

export function readChunkBlob(sql: SqlStorage, scenarioId: string, seed: number, chunkIndex: number): ArrayBuffer | null {
  const row = sql
    .exec<{ blob: ArrayBuffer }>(
      "SELECT blob FROM traffic_chunks WHERE scenario_id = ? AND seed = ? AND chunk_index = ?",
      scenarioId,
      seed,
      chunkIndex,
    )
    .toArray()[0];
  return row ? row.blob : null;
}

export function readPartials(sql: SqlStorage, scenarioId: string, seed: number): string[] {
  return sql
    .exec<{ partial: string }>(
      "SELECT partial FROM traffic_chunks WHERE scenario_id = ? AND seed = ? ORDER BY chunk_index",
      scenarioId,
      seed,
    )
    .toArray()
    .map((r) => r.partial);
}

export function insertChunk(
  sql: SqlStorage,
  row: ChunkRow & { scenarioId: string; seed: number; blob: Uint8Array; partial: string },
): void {
  // INSERT OR IGNORE: generation is deterministic, so a retried chunk call writes identical
  // bytes and the first write wins.
  sql.exec(
    "INSERT OR IGNORE INTO traffic_chunks (scenario_id, seed, chunk_index, start, count, blob, digest, partial) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    row.scenarioId,
    row.seed,
    row.chunkIndex,
    row.start,
    row.count,
    row.blob,
    row.digest,
    row.partial,
  );
}

// ---------------------------------------------------------------------------
// Incidents
// ---------------------------------------------------------------------------

export function saveIncident(sql: SqlStorage, incident: Incident): void {
  sql.exec(
    `INSERT INTO incidents (id, status, proposed_rule_version_id, applied_rule_version_id, data, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET status = excluded.status,
       proposed_rule_version_id = excluded.proposed_rule_version_id,
       applied_rule_version_id = excluded.applied_rule_version_id,
       data = excluded.data`,
    incident.id,
    incident.status,
    incident.proposedRuleVersionId,
    incident.appliedRuleVersionId,
    JSON.stringify(incident),
    incident.createdAt,
  );
}

export function getIncident(sql: SqlStorage, id: string): Incident | null {
  const row = sql.exec<{ data: string }>("SELECT data FROM incidents WHERE id = ?", id).toArray()[0];
  return row ? (JSON.parse(row.data) as Incident) : null;
}

export function listIncidents(sql: SqlStorage, limit: number): Incident[] {
  return sql
    .exec<{ data: string }>("SELECT data FROM incidents ORDER BY created_at DESC, id DESC LIMIT ?", limit)
    .toArray()
    .map((r) => JSON.parse(r.data) as Incident);
}

export function countIncidentsWithStatus(sql: SqlStorage, statuses: readonly IncidentStatus[]): number {
  const placeholders = statuses.map(() => "?").join(", ");
  const row = sql
    .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM incidents WHERE status IN (${placeholders})`, ...statuses)
    .toArray()[0];
  return row?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Rule versions
// ---------------------------------------------------------------------------

type RuleVersionRow = {
  id: string;
  incident_id: string;
  source: string;
  attempt: number;
  status: string;
  raw_model_output: string;
  usage: string | null;
  ast: string | null;
  text: string | null;
  replay: string | null;
  diagnostics: string;
  created_at: number;
};

function rowToRuleVersion(r: RuleVersionRow): RuleVersion {
  return {
    id: r.id,
    incidentId: r.incident_id,
    source: r.source === "naive-baseline" ? "naive-baseline" : "model",
    attempt: r.attempt,
    status: r.status as RuleVersion["status"],
    rawModelOutput: r.raw_model_output,
    usage: r.usage ? (JSON.parse(r.usage) as RuleVersion["usage"]) : null,
    ast: r.ast ? (JSON.parse(r.ast) as RuleAST) : null,
    text: r.text,
    replay: r.replay ? (JSON.parse(r.replay) as ReplayResult) : null,
    diagnostics: JSON.parse(r.diagnostics) as Diagnostic[],
    createdAt: r.created_at,
  };
}

export function saveRuleVersion(sql: SqlStorage, v: RuleVersion): void {
  sql.exec(
    `INSERT INTO rule_versions (id, incident_id, source, attempt, status, raw_model_output, usage, ast, text, replay, diagnostics, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET status = excluded.status, ast = excluded.ast, text = excluded.text,
       replay = excluded.replay, diagnostics = excluded.diagnostics`,
    v.id,
    v.incidentId,
    v.source,
    v.attempt,
    v.status,
    v.rawModelOutput,
    v.usage ? JSON.stringify(v.usage) : null,
    v.ast ? JSON.stringify(v.ast) : null,
    v.text,
    v.replay ? JSON.stringify(v.replay) : null,
    JSON.stringify(v.diagnostics),
    v.createdAt,
  );
}

export function getRuleVersion(sql: SqlStorage, id: string): RuleVersion | null {
  const r = sql.exec<RuleVersionRow>("SELECT * FROM rule_versions WHERE id = ?", id).toArray()[0];
  return r ? rowToRuleVersion(r) : null;
}

/** Every model-drafted attempt for an incident, in attempt order. For the UI's attempt history. */
export function listDraftAttempts(sql: SqlStorage, incidentId: string): RuleVersion[] {
  return sql
    .exec<RuleVersionRow>("SELECT * FROM rule_versions WHERE incident_id = ? AND source = 'model' ORDER BY attempt ASC", incidentId)
    .toArray()
    .map(rowToRuleVersion);
}

// ---------------------------------------------------------------------------
// Approvals (append only)
// ---------------------------------------------------------------------------

export type ApprovalRow = {
  incidentId: string;
  ruleVersionId: string | null;
  decision: "approved" | "rejected";
  reason: string | null;
  decidedAt: number;
};

export function appendApproval(sql: SqlStorage, a: ApprovalRow): void {
  sql.exec(
    "INSERT INTO approvals (incident_id, rule_version_id, decision, reason, decided_at) VALUES (?, ?, ?, ?, ?)",
    a.incidentId,
    a.ruleVersionId,
    a.decision,
    a.reason,
    a.decidedAt,
  );
}

export function findApproval(sql: SqlStorage, incidentId: string, ruleVersionId: string): ApprovalRow | null {
  const r = sql
    .exec<{ decided_at: number; reason: string | null }>(
      "SELECT decided_at, reason FROM approvals WHERE incident_id = ? AND rule_version_id = ? AND decision = 'approved' ORDER BY seq DESC LIMIT 1",
      incidentId,
      ruleVersionId,
    )
    .toArray()[0];
  return r ? { incidentId, ruleVersionId, decision: "approved", reason: r.reason, decidedAt: r.decided_at } : null;
}

/** "Unsafe actions" from DESIGN.md section 9: applied rules with no matching approval row. */
export function countUnsafeActions(sql: SqlStorage): number {
  const row = sql
    .exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM incidents i
       WHERE i.applied_rule_version_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.incident_id = i.id
           AND a.rule_version_id = i.applied_rule_version_id AND a.decision = 'approved')`,
    )
    .toArray()[0];
  return row?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Steps and summaries
// ---------------------------------------------------------------------------

/**
 * `started_at` is only ever set by the INSERT branch: it is not in the ON CONFLICT SET list, so
 * a step's first recorded timestamp (when it moved to "running") survives every later update to
 * the same row, and `at` keeps tracking the most recent one.
 */
export function upsertStep(sql: SqlStorage, incidentId: string, name: string, status: StepStatus, detail: string | null, at: number) {
  sql.exec(
    `INSERT INTO steps (incident_id, name, status, detail, at, started_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(incident_id, name) DO UPDATE SET status = excluded.status, detail = excluded.detail, at = excluded.at`,
    incidentId,
    name,
    status,
    detail,
    at,
    at,
  );
}

const TERMINAL_STEP_STATUS: readonly StepStatus[] = ["complete", "error"];

export function listSteps(sql: SqlStorage, incidentId: string): StepView[] {
  return sql
    .exec<{ name: string; status: StepStatus; detail: string | null; at: number; started_at: number | null }>(
      "SELECT name, status, detail, at, started_at FROM steps WHERE incident_id = ? ORDER BY rowid",
      incidentId,
    )
    .toArray()
    .map((r) => {
      const startedAt = r.started_at ?? r.at;
      const durationMs = TERMINAL_STEP_STATUS.includes(r.status) ? r.at - startedAt : null;
      return { name: r.name, status: r.status, detail: r.detail, at: r.at, startedAt, durationMs };
    });
}

export function saveSummary(sql: SqlStorage, incidentId: string, data: string): void {
  sql.exec("INSERT OR REPLACE INTO summaries (incident_id, data) VALUES (?, ?)", incidentId, data);
}

export function getSummary(sql: SqlStorage, incidentId: string): string | null {
  return sql.exec<{ data: string }>("SELECT data FROM summaries WHERE incident_id = ?", incidentId).toArray()[0]?.data ?? null;
}

export function savePanel(sql: SqlStorage, ruleVersionId: string, panel: number[][]): void {
  sql.exec("INSERT OR REPLACE INTO replay_panels (rule_version_id, panel) VALUES (?, ?)", ruleVersionId, JSON.stringify(panel));
}

export function getPanel(sql: SqlStorage, ruleVersionId: string | null): number[][] | null {
  if (!ruleVersionId) return null;
  const raw = sql.exec<{ panel: string }>("SELECT panel FROM replay_panels WHERE rule_version_id = ?", ruleVersionId).toArray()[0];
  return raw ? (JSON.parse(raw.panel) as number[][]) : null;
}

// ---------------------------------------------------------------------------
// Settings (small durable key/value, currently just the chosen scenario)
// ---------------------------------------------------------------------------

export function getSetting(sql: SqlStorage, key: string): string | null {
  return sql.exec<{ value: string }>("SELECT value FROM settings WHERE key = ?", key).toArray()[0]?.value ?? null;
}

export function setSetting(sql: SqlStorage, key: string, value: string): void {
  sql.exec("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
}

// ---------------------------------------------------------------------------
// Evidence ledger
// ---------------------------------------------------------------------------

type EvidenceRow = {
  id: string;
  incident_id: string;
  kind: string;
  claim: string;
  produced_by: string;
  data: string;
  created_at: number;
};

export function saveEvidence(sql: SqlStorage, e: Evidence): void {
  sql.exec(
    `INSERT INTO evidence (id, incident_id, kind, claim, produced_by, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(incident_id, id) DO NOTHING`,
    e.id,
    e.incidentId,
    e.kind,
    e.claim,
    e.producedBy,
    JSON.stringify(e.data),
    e.createdAt,
  );
}

export function listEvidence(sql: SqlStorage, incidentId: string): Evidence[] {
  return sql
    .exec<EvidenceRow>("SELECT * FROM evidence WHERE incident_id = ? ORDER BY rowid", incidentId)
    .toArray()
    .map((r) => ({
      id: r.id,
      incidentId: r.incident_id,
      kind: r.kind as Evidence["kind"],
      claim: r.claim,
      producedBy: r.produced_by,
      data: JSON.parse(r.data) as Evidence["data"],
      createdAt: r.created_at,
    }));
}

export function getEvidenceIds(sql: SqlStorage, incidentId: string): Set<string> {
  return new Set(sql.exec<{ id: string }>("SELECT id FROM evidence WHERE incident_id = ?", incidentId).toArray().map((r) => r.id));
}

// ---------------------------------------------------------------------------
// Lessons: retrieved by scenario family for later investigations. Phase 4.
// ---------------------------------------------------------------------------

export type LessonRow = { scenarioFamily: string; lesson: string; incidentId: string; createdAt: number };

export function saveLesson(sql: SqlStorage, row: LessonRow): void {
  sql.exec(
    "INSERT INTO lessons (scenario_family, lesson, incident_id, created_at) VALUES (?, ?, ?, ?)",
    row.scenarioFamily,
    row.lesson,
    row.incidentId,
    row.createdAt,
  );
}

/** Most recent lessons for a scenario family, newest first, excluding the given incident. */
export function recentLessons(sql: SqlStorage, scenarioFamily: string, excludeIncidentId: string, limit: number): LessonRow[] {
  return sql
    .exec<{ scenario_family: string; lesson: string; incident_id: string; created_at: number }>(
      "SELECT * FROM lessons WHERE scenario_family = ? AND incident_id != ? ORDER BY created_at DESC LIMIT ?",
      scenarioFamily,
      excludeIncidentId,
      limit,
    )
    .toArray()
    .map((r) => ({ scenarioFamily: r.scenario_family, lesson: r.lesson, incidentId: r.incident_id, createdAt: r.created_at }));
}

// ---------------------------------------------------------------------------
// Retention: cf_agents_workflows grows unbounded, the SDK does not clean it up. DESIGN.md
// section 11. Deletes tracking rows for workflows finished more than `olderThanMs` ago.
// ---------------------------------------------------------------------------

/**
 * Deletes `complete`/`errored` `cf_agents_workflows` tracking rows older than `olderThanMs`.
 * That table is the Agents SDK's own (`agents/src/index.ts`, `runWorkflow`), keyed by
 * `updated_at` stored as `unixepoch()` (whole seconds, not `Date.now()`'s milliseconds) -- the
 * cutoff below is converted to match. Returns how many rows were deleted.
 */
export function pruneWorkflowTracking(sql: SqlStorage, olderThanMs: number, now: number): number {
  const cutoffSeconds = Math.floor((now - olderThanMs) / 1000);
  const before = sql.exec<{ n: number }>("SELECT COUNT(*) as n FROM cf_agents_workflows").toArray()[0]?.n ?? 0;
  sql.exec("DELETE FROM cf_agents_workflows WHERE status IN ('complete', 'errored') AND updated_at < ?", cutoffSeconds);
  const after = sql.exec<{ n: number }>("SELECT COUNT(*) as n FROM cf_agents_workflows").toArray()[0]?.n ?? 0;
  return before - after;
}
