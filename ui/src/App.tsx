// The operator's view. Everything shown here arrives as Agent state over the WebSocket; the
// browser holds nothing that matters. Reloading the page loses nothing.
//
// Every number on this page is computed by server code from replay counts. The model produces
// none of them.

import { useAgent } from "agents/react";
import { useEffect, useMemo, useState } from "react";
import { SCENARIOS } from "../../src/core/scenarios";
import { excerpt } from "../../src/core/text-excerpt";
import type { Diagnostic, ReplayResult, RuleVersion, TrafficSummary } from "../../src/core/types";
import type { IncidentAgent } from "../../src/server/agent";
import type { AgentState, IncidentView, TrafficState } from "../../src/server/views";

const STATUS_CLASSES = [
  { key: "ok", label: "2xx/3xx", color: "var(--ok)" },
  { key: "unauthorized", label: "401", color: "var(--bad)" },
  { key: "rateLimited", label: "429", color: "var(--warn)" },
  { key: "otherError", label: "other errors", color: "var(--muted)" },
] as const;

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export function App() {
  const [error, setError] = useState<string | null>(null);
  const agent = useAgent<IncidentAgent, AgentState>({
    agent: "incident-agent",
    name: "main",
  });
  const state = agent.state;

  // Generate traffic one chunk per call until it is ready. Each call is one WebSocket message,
  // so each one stays inside a single CPU slice on the server.
  useEffect(() => {
    if (!state || state.traffic.status === "ready") return;
    let cancelled = false;
    (async () => {
      let t: TrafficState = state.traffic;
      while (!cancelled && t.status !== "ready") t = await agent.stub.generateTrafficChunk();
    })().catch((e: unknown) => setError(String(e)));
    return () => {
      cancelled = true;
    };
    // Only when the traffic status changes, not on every broadcast.
  }, [state?.traffic.status]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = useMemo(
    () => state?.incidents.find((i) => i.id === selectedId) ?? state?.incidents[0] ?? null,
    [state, selectedId],
  );

  if (!state) return <main className="loading">Connecting to the agent...</main>;

  const applied = selected?.status === "applied" ? selected.blockedPanels.proposed : null;

  return (
    <main>
      <header>
        <h1>Portcullis</h1>
        <p className="tagline">The model proposes. Code verifies. You decide.</p>
        <div className="scenario">
          Scenario:{" "}
          <select
            value={state.scenario.id}
            disabled={state.incidents.some((i) => i.status === "investigating" || i.status === "awaiting-approval")}
            onChange={async (e) => {
              setError(null);
              setSelectedId(null);
              try {
                await agent.stub.selectScenario(e.target.value);
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              }
            }}
          >
            {SCENARIOS.map((d) => (
              <option key={d.scenario.id} value={d.scenario.id}>
                {d.scenario.title}
              </option>
            ))}
          </select>
          {state.scenario.isTrap && <span className="pill">trap: shared {state.scenario.trapAttribute}</span>}
        </div>
      </header>
      {error && (
        <div className="error" role="alert">
          {error} <button onClick={() => setError(null)}>dismiss</button>
        </div>
      )}
      <div className="grid">
        <section className="card">
          <h2>Traffic</h2>
          <TrafficPanel traffic={state.traffic} blocked={null} caption="Observed" />
          {applied && <TrafficPanel traffic={state.traffic} blocked={applied} caption="With the applied rule" />}
          <Legend />
        </section>
        <section className="card">
          <h2>Report a symptom</h2>
          <SymptomForm
            placeholder={state.scenario.symptom}
            disabled={state.traffic.status !== "ready"}
            onSubmit={async (symptom) => {
              setError(null);
              try {
                const { incidentId } = await agent.stub.startInvestigation(symptom);
                setSelectedId(incidentId);
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              }
            }}
          />
          <History incidents={state.incidents} selectedId={selected?.id ?? null} onSelect={setSelectedId} />
        </section>
      </div>
      {selected && (
        <IncidentPanel
          incident={selected}
          thresholds={state.scenario.thresholds}
          onApprove={async () => {
            // The approve call carries IDs only, never rule text. The server applies what it stored.
            if (!selected.proposedRuleVersionId) return;
            try {
              await agent.stub.approve(selected.id, selected.proposedRuleVersionId);
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            }
          }}
          onReject={async (reason) => {
            try {
              await agent.stub.reject(selected.id, reason);
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            }
          }}
        />
      )}
    </main>
  );
}

function TrafficPanel({ traffic, blocked, caption }: { traffic: TrafficState; blocked: number[][] | null; caption: string }) {
  if (traffic.status !== "ready" || !traffic.panel) {
    return (
      <p className="muted">
        Generating traffic: {traffic.chunksDone} of {traffic.chunksTotal} chunks ({traffic.requestCount} requests)
      </p>
    );
  }
  const panel = traffic.panel.map((row, b) => row.map((v, c) => v - (blocked?.[b]?.[c] ?? 0)));
  const max = Math.max(1, ...traffic.panel.map((row) => row.reduce((a, v) => a + v, 0)));
  const W = 400;
  const H = 110;
  const bw = W / panel.length;
  return (
    <figure className="traffic">
      <figcaption>
        {caption}
        {blocked && <span className="muted"> (blocked requests removed)</span>}
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${caption}: requests per time bucket by status`}>
        {panel.map((row, b) => {
          let y = H;
          return (
            <g key={b}>
              {row.map((v, c) => {
                const h = (v / max) * (H - 4);
                y -= h;
                const cls = STATUS_CLASSES[c];
                return <rect key={c} x={b * bw + 1} y={y} width={bw - 2} height={h} fill={cls?.color} />;
              })}
            </g>
          );
        })}
      </svg>
      <div className="axis">
        <span>0:00</span>
        <span>{Math.round((traffic.bucketMs * panel.length) / 60000)} min</span>
      </div>
    </figure>
  );
}

function Legend() {
  return (
    <div className="legend">
      {STATUS_CLASSES.map((c) => (
        <span key={c.key}>
          <i style={{ background: c.color }} /> {c.label}
        </span>
      ))}
    </div>
  );
}

function SymptomForm({ placeholder, disabled, onSubmit }: { placeholder: string; disabled: boolean; onSubmit: (s: string) => void }) {
  const [text, setText] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(text.trim() || placeholder);
        setText("");
      }}
    >
      <textarea
        value={text}
        maxLength={500}
        rows={3}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        aria-label="Symptom"
      />
      <button type="submit" disabled={disabled}>
        Investigate
      </button>
    </form>
  );
}

function History({ incidents, selectedId, onSelect }: { incidents: IncidentView[]; selectedId: string | null; onSelect: (id: string) => void }) {
  if (incidents.length === 0) return <p className="muted">No incidents yet.</p>;
  return (
    <ul className="history">
      {incidents.map((i) => (
        <li key={i.id}>
          <button className={i.id === selectedId ? "selected" : ""} onClick={() => onSelect(i.id)}>
            <span className={`status status-${i.status}`}>{i.status}</span> {i.symptom.slice(0, 60)}
            <span className="muted"> {new Date(i.createdAt).toLocaleTimeString()}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function IncidentPanel({
  incident,
  thresholds,
  onApprove,
  onReject,
}: {
  incident: IncidentView;
  thresholds: AgentState["scenario"]["thresholds"];
  onApprove: () => void;
  onReject: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const awaiting = incident.status === "awaiting-approval";
  return (
    <section className="card incident">
      <h2>
        Incident <code>{incident.id.slice(0, 12)}</code> <span className={`status status-${incident.status}`}>{incident.status}</span>
      </h2>
      <p className="muted">
        Symptom: "{incident.symptom}". Model: <code>{incident.modelId}</code> <ModelStatus status={incident.modelStatus} />
        {incident.modelNeuronsUsed > 0 && <> · {Math.round(incident.modelNeuronsUsed).toLocaleString()} neurons used</>}
      </p>
      {incident.failureReason && <p className="error">{incident.failureReason}</p>}
      {incident.hypothesis && <Cited className="hypothesis" label="Hypothesis" text={incident.hypothesis} />}
      <Steps incident={incident} />
      <div className="rules">
        <RuleCard title="Proposed rule (model draft, verified in code)" version={incident.proposed} thresholds={thresholds} />
        <RuleCard title="Naive baseline (block the top source attribute)" version={incident.baseline} thresholds={thresholds} />
      </div>
      {incident.attempts.length > 1 && <AttemptHistory attempts={incident.attempts} />}
      {awaiting && (
        <div className="decision">
          <button className="approve" onClick={onApprove}>
            Approve this exact rule
          </button>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason for rejecting (optional)" maxLength={500} />
          <button className="reject" onClick={() => onReject(reason)}>
            Reject
          </button>
        </div>
      )}
      {incident.recovery && (
        <div className="recovery">
          <h3>Recovery, measured after apply</h3>
          <Counts replay={incident.recovery} />
        </div>
      )}
      {incident.report && <Cited className="report" label="Report" text={incident.report} />}
      {incident.lesson && <Cited className="lesson" label="Lesson learned" text={incident.lesson} />}
      {incident.summary && <Evidence summary={incident.summary} />}
    </section>
  );
}

/**
 * Distinguishes a real model call from a scripted fake one, and both from the account's daily
 * neuron allocation being used up (CLAUDE.md: never report an unmeasured or ambiguous state).
 */
function ModelStatus({ status }: { status: IncidentView["modelStatus"] }) {
  const label = status === "quota-exhausted" ? "model unavailable: daily quota used" : status === "fake" ? "fake model" : "live model";
  return <span className={`model-status model-status-${status}`}>{label}</span>;
}

/** Phase 6: step timings, so a reviewer can see where an incident spent its time. */
function formatDurationMs(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function Steps({ incident }: { incident: IncidentView }) {
  return (
    <ol className="steps">
      {incident.steps.map((s) => (
        <li key={s.name} className={`step step-${s.status}`}>
          <span className="step-name">{s.name}</span>
          <span className="step-status">{s.status}</span>
          <span className="muted step-duration">{s.durationMs !== null ? formatDurationMs(s.durationMs) : ""}</span>
          {s.detail && <span className="muted step-detail">{s.detail}</span>}
        </li>
      ))}
    </ol>
  );
}

/** Every draft attempt, so a reviewer can see what was rejected and why (Phase 3). */
function AttemptHistory({ attempts }: { attempts: RuleVersion[] }) {
  return (
    <details className="attempt-history">
      <summary>Attempt history ({attempts.length} attempt{attempts.length === 1 ? "" : "s"})</summary>
      <ol>
        {attempts.map((a) => (
          <li key={a.id} className={`status status-${a.status}`}>
            <span className="step-name">attempt {a.attempt}</span>
            <span className="step-status">{a.status}</span>
            {a.text && <pre className="rule-text">{a.text}</pre>}
            {a.diagnostics.length > 0 && <Diagnostics text={a.text} diagnostics={a.diagnostics} />}
            {a.usage && <AttemptUsage usage={a.usage} />}
            {a.rawModelOutput && <RawOutput text={a.rawModelOutput} />}
          </li>
        ))}
      </ol>
    </details>
  );
}

/** Token accounting for a draft attempt's model call, so a diagnosis of E_SCHEMA_NOT_JSON does
 * not require guessing whether the call was cut off. `hitMaxTokens` is computed in code from the
 * other two counts (CLAUDE.md invariant 5); the model produces none of this. */
function AttemptUsage({ usage }: { usage: NonNullable<RuleVersion["usage"]> }) {
  return (
    <p className="muted attempt-usage">
      {usage.completionTokens} / {usage.maxTokens} completion tokens
      {usage.hitMaxTokens && <span className="warn"> — hit the token limit</span>}
    </p>
  );
}

const RAW_OUTPUT_EXCERPT_CHARS = 400;

/**
 * The model's raw output, before validation: untrusted text (CLAUDE.md invariant 3). Rendered as
 * plain text only, via JSX text children, which React escapes -- never via
 * dangerouslySetInnerHTML or any other path that would let it be interpreted as HTML.
 */
function RawOutput({ text }: { text: string }) {
  const e = excerpt(text, RAW_OUTPUT_EXCERPT_CHARS);
  return (
    <details className="raw-output">
      <summary>Raw model output ({e.length} characters{e.truncated ? ", truncated" : ""})</summary>
      <pre className="raw-output-text">{e.head}</pre>
      {e.truncated && (
        <>
          <p className="muted">… {e.length - e.head.length - e.tail.length} characters omitted …</p>
          <pre className="raw-output-text">{e.tail}</pre>
        </>
      )}
    </details>
  );
}

function RuleCard({ title, version, thresholds }: { title: string; version: RuleVersion | null; thresholds: AgentState["scenario"]["thresholds"] }) {
  return (
    <div className="rule">
      <h3>{title}</h3>
      {!version && <p className="muted">Not drafted yet.</p>}
      {version && (
        <>
          <p>
            Status: <span className={`status status-${version.status}`}>{version.status}</span>
          </p>
          {version.text ? <pre className="rule-text">{version.text}</pre> : <p className="muted">No rule text (output failed validation).</p>}
          {version.diagnostics.length > 0 && <Diagnostics text={version.text} diagnostics={version.diagnostics} />}
          {version.replay && (
            <>
              <Counts replay={version.replay} />
              <p className={version.replay.passesThresholds ? "pass" : "fail"}>
                {version.replay.passesThresholds ? "Passes" : "Fails"} the scenario thresholds: attack blocked at least{" "}
                {pct(thresholds.minAttackBlockedRate)}, legitimate blocked at most {pct(thresholds.maxLegitimateBlockedRate)}.
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}

function Counts({ replay }: { replay: ReplayResult }) {
  return (
    <table className="counts">
      <tbody>
        <tr>
          <th>Attack blocked</th>
          <td>
            {replay.attackBlocked} of {replay.attackTotal}
          </td>
          <td>{pct(replay.attackBlockedRate)}</td>
        </tr>
        <tr>
          <th>Legitimate blocked</th>
          <td>
            {replay.legitimateBlocked} of {replay.legitimateTotal}
          </td>
          <td>{pct(replay.legitimateBlockedRate)}</td>
        </tr>
        <tr>
          <th>Safety score</th>
          <td colSpan={2}>
            {replay.safetyScore.toFixed(3)} <span className="muted">(attack rate x (1 - legitimate rate))</span>
          </td>
        </tr>
      </tbody>
    </table>
  );
}

function Diagnostics({ text, diagnostics }: { text: string | null; diagnostics: Diagnostic[] }) {
  return (
    <ul className="diagnostics">
      {diagnostics.map((d, i) => (
        <li key={i} className={d.severity}>
          <code>{d.code}</code> {d.message}
          {text && d.span && (
            <pre className="span">
              {text.slice(0, d.span.start)}
              <mark>{text.slice(d.span.start, d.span.end)}</mark>
              {text.slice(d.span.end)}
            </pre>
          )}
        </li>
      ))}
    </ul>
  );
}

const CITATION_TOKEN = /\bev_[a-zA-Z0-9_]+\b/g;

/** Renders text with every `ev_...` citation as a link to that evidence record's anchor. */
function Cited({ className, label, text }: { className: string; label: string; text: string }) {
  const parts: Array<string | { citation: string }> = [];
  let lastIndex = 0;
  for (const match of text.matchAll(CITATION_TOKEN)) {
    const start = match.index ?? 0;
    if (start > lastIndex) parts.push(text.slice(lastIndex, start));
    parts.push({ citation: match[0] });
    lastIndex = start + match[0].length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return (
    <div className={className}>
      <h3>{label}</h3>
      <p>
        {parts.map((p, i) =>
          typeof p === "string" ? (
            <span key={i}>{p}</span>
          ) : (
            <a key={i} href={`#${p.citation}`}>
              {p.citation}
            </a>
          ),
        )}
      </p>
    </div>
  );
}

function Evidence({ summary }: { summary: TrafficSummary }) {
  return (
    <details className="evidence">
      <summary>Evidence: the label-blind summary the model saw ({summary.totalRequests} requests)</summary>
      <div className="breakdowns">
        {summary.breakdowns
          .filter((b) => b.dimension !== "timeBucket")
          .map((b) => (
            <div key={b.evidenceId} id={b.evidenceId} className="breakdown">
              <h4>
                <code>{b.evidenceId}</code> {b.dimension}
              </h4>
              <table>
                <tbody>
                  {b.rows.map((r) => (
                    <tr key={r.key}>
                      <td className="key">{r.key}</td>
                      <td>{r.count}</td>
                      <td>{pct(r.share)}</td>
                    </tr>
                  ))}
                  {b.otherCount > 0 && (
                    <tr>
                      <td className="muted">other</td>
                      <td>{b.otherCount}</td>
                      <td />
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          ))}
        {summary.symptomSlice.breakdowns
          .filter((b) => b.dimension !== "timeBucket")
          .map((b) => (
            <div key={b.evidenceId} id={b.evidenceId} className="breakdown">
              <h4>
                <code>{b.evidenceId}</code> {b.dimension} ({summary.symptomSlice.description})
              </h4>
              <table>
                <tbody>
                  {b.rows.map((r) => (
                    <tr key={r.key}>
                      <td className="key">{r.key}</td>
                      <td>{r.count}</td>
                      <td>{pct(r.share)}</td>
                    </tr>
                  ))}
                  {b.otherCount > 0 && (
                    <tr>
                      <td className="muted">other</td>
                      <td>{b.otherCount}</td>
                      <td />
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          ))}
      </div>
    </details>
  );
}
