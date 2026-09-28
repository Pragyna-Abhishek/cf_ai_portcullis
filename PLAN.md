# Portcullis: build plan

Phases are vertical slices. Each one ends with something that runs, not a layer that waits for the
next layer. Read DESIGN.md first.

Sizes are rough and relative: **S** is a few hours, **M** is about a day, **L** is two days or more.
They are estimates, not measurements.

Every phase lists acceptance criteria that can be checked without asking anyone. If a criterion
cannot be verified by running something, it is not a criterion.

## Status (2026-09-28)

| Phase | State | What is left |
| --- | --- | --- |
| 0 | All four spikes measured (`docs/spikes.md`); 0.4 measured **negative** against the real account twice | Fallback 1 (flatten the schema) measured, still fails. Fallback 2 (split leaf kinds by value type) re-measured 2026-09-27 against the deployed site's first real investigation: also fails, same connective-explosion pathology, 0/3 real attempts schema-valid. Production has moved off the AST-JSON route entirely, to the model emitting rule text directly (not one of 0.4's four listed schema fallbacks): see DESIGN.md section 7 ("Round-trip property") and `docs/reviews/2026-09-27-first-real-model-run.md`. Fallbacks 3 (two-call decomposition) and 4 (few-shot) are moot unless the text route itself is later found insufficient |
| 1 | Built, tested locally, deployed | `https://portcullis.pragyna-portcullis.workers.dev` is live and serving. The first real-model investigation on the deployed URL ran on 2026-09-27 and failed at the draft step (0/3, see Phase 0). After the rule-text fix, one investigation on `l7-trap-carrier` produced a valid rule on the first attempt that failed the attack threshold (865/2067 blocked, 0/3933 legitimate; `docs/reviews/2026-09-28-first-text-route-run.md`). The demo has not been driven through approval on the deployed URL |
| 2 | Built, tested | Abhishek to review the grammar in DESIGN.md section 7 |
| 3 | Built, tested (fake model only; not yet exercised against the real model, see Phase 0) | Bounded retry loop, diagnostics feedback, attempt history all implemented (`src/server/workflow.ts`, `src/core/prompt.ts`). Real-model behavior under retry is unverified until 0.4 is resolved |
| 4 | Built, tested (fake model only; not yet exercised against the real model, see Phase 0) | 8 scenarios across 3 families (3 traps: asn, country, userAgent) in `src/core/scenarios.ts`. Evidence ledger (`evidence` table), citation checking (`src/core/citations.ts`), memory (`lessons` table, retrieved per scenario family), classify/hypothesize/write-report steps, retention pruning of `cf_agents_workflows`, and UI display of hypothesis/report/lesson with clickable evidence citations are all implemented and tested. All five Phase 4 acceptance criteria have a passing test (`test/unit/scenarios-all.test.ts`, `test/unit/citations.test.ts`, `test/integration/workflow.test.ts`) |
| 5 | Built, tested (fake model only; `--real` implemented and smoke-tested, not measured, see Phase 0) | `npm run eval` (`src/eval/harness.ts`, `scripts/eval-driver.ts`) runs the full pipeline plus all four ablations (no retry loop, no memory, naive baseline, text-vs-AST) across all 8 scenarios, against the fake model with no credentials, or the real model via `--real` (the deployed spikes Worker's `/model/run`). `--scenarios=id1,id2` and `--runs=N` (`src/eval/select-scenarios.ts`, unit-tested) narrow which scenarios run, so a `--real` run's model-call footprint against the account's daily allocation can be sized deliberately instead of always spending it on all 8 scenarios times 4 ablations. A `quota-exhausted` response (`QuotaExhaustedError`, `src/eval/harness.ts`) stops the whole run immediately with a clear message and keeps the cache, rather than burning the rest of the allocation retrying calls that cannot succeed until the next day's reset. Response cache (`src/eval/cache.ts`) keyed by `(scenario, prompt, model)`, tested for hit/miss/no-cache-on-failure (`test/unit/eval-harness.test.ts`). Reproducibility confirmed: two consecutive fake runs are byte-identical, second run all cache hits. `docs/eval-results/fake.json` committed; `real.json` not produced: the account's daily neuron allocation was used up on 2026-09-25 by Phase 0's spikes (it resets daily; docs/spikes.md, "investigating the Sep 25 neuron burst") and `--real` has not been run since; see `docs/eval-results/README.md` |
| 6 | Built, tested | Failure injection (`test/integration/failure-injection.test.ts`): every step named in DESIGN.md section 8 forced to error via `mockStepError`, asserting the incident always reaches `failed` through `onWorkflowError`'s catch-all, never a silent hang; one step (`aggregate-traffic`) also forced to time out via `forceStepTimeout`; a model-rate-limit-shaped failure on `draft-rule-attempt-1`, matching the exact message `src/model/client.ts`'s `requireOkResponse` (unit-tested) produces. Step timings: `StepView` now carries `startedAt`/`durationMs`, computed in `store.ts`'s `listSteps` and shown in the UI next to each step's status. Structured logging (`src/server/log.ts`): one JSON line per step transition, decision, and terminal status change, keyed by `incidentId` |
| 7 | Built | `README.md` rewritten to the current state (deployed URL, measured numbers, current test counts, honest about what is unmeasured). `PROMPTS.md` added: the AI prompt history, distinct from the runtime prompt templates in `prompts/`. `EXPLAINER.md` and DESIGN.md section 3 brought current (EXPLAINER.md updated again on 2026-09-28 for the rule-text route and the real-model runs). UI polish items (evidence drill-down, attempt history, before/after traffic panels, naive-vs-proposed comparison) were already built in earlier phases; verified by driving the full demo flow end to end against `wrangler dev --local --var MODEL_MODE:fake` with a headless browser. The 60-second demo has been driven locally, not yet against the deployed URL with a working real-model call (the 2026-09-27 real-model attempt failed at the draft step; see Phase 0). Follow-up: a real-model investigation on the deployed site had all three draft attempts rejected with `E_SCHEMA_NOT_JSON` and no way to tell why, so each draft attempt now also stores `completionTokens`, `maxTokens`, and `hitMaxTokens` (`src/core/types.ts`'s `ModelCallUsage`, computed in code from the client's reported usage, never model produced), and the attempt history shows those plus a head/tail excerpt of the raw output (`src/core/text-excerpt.ts`, rendered as plain text only). Prompt, schema, and validation unchanged |

Deviations from this plan, on purpose:

- **Phase 1 started before Phase 0 finished.** The sequencing note below says not to. Three of the
  four Phase 0 answers need a Cloudflare account and none was available where this was built. The
  work went ahead with each unmeasured assumption behind one seam (`ModelClient`, the chunk loops in
  `src/server/workflow.ts`, `CHUNK_SIZE`), so a bad measurement changes one file. The risk is
  recorded here rather than hidden.
- **Phases 1 and 2 were built together**, so the full grammar went in directly instead of the
  narrow Phase 1 grammar.
- **The 0.1 fallback model is gone.** `@cf/meta/llama-3.1-8b-instruct` was deprecated on
  2026-05-30. Candidates are listed in `docs/spikes.md`.
- **Phase 1 acceptance items that name the deployed URL are not met** until someone deploys. The
  Phase 2 list and the remaining Phase 1 items are covered by committed tests, except the UI ones
  (live traffic panel, step list updating over WebSocket, panel recovering after approve, history
  after reload). Those were checked on 2026-09-25 by driving the local app in a headless browser,
  which is not a committed test.
- **2026-09-27: the production draft step moved from AST JSON to rule text**, ahead of Phase 5's
  original ablation ordering, because the first real-account investigation showed the AST route
  failing structurally, not by occasional syntax slip (see the Phase 0 row above). Follow-up not
  done as part of this fix: `src/eval/harness.ts`'s primary (non-ablation) scenario runner still
  measures the AST route via `RULE_JSON_SCHEMA`/`verifyModelDraft`, and ablation 4 (Phase 5) still
  measures the text route as if it were the alternative. Swapping which one the harness treats as
  primary is real work (the ablation's `TextAblationResult` type is narrower than the primary
  flow's `DraftOutcome`) and belongs to whoever next touches Phase 5, not bundled into this fix.

## Testing setup, established in Phase 0 and used by every phase after

Two test projects, because the constraints differ:

1. **`test/unit`, plain Vitest, no Workers runtime.** Simulator, aggregator, printer, lexer, parser,
   type checker, evaluator. These are pure functions over plain data. They need no platform and run
   far faster outside the Workers pool. This is where most tests live.
2. **`test/integration`, `@cloudflare/vitest-plugin`.** Agent, WebSocket, Workflow. Run with
   `--max-workers=1 --no-isolate`, because WebSockets with Durable Objects are documented as
   unsupported under per-file storage isolation.

Coverage uses Istanbul. V8 coverage is documented as unsupported in the Workers pool.

Workflow tests use the plugin's introspection API: `introspectWorkflow`,
`introspectWorkflowInstance`, with `mockStepResult`, `mockStepError`, `forceStepTimeout`,
`mockEvent`, `forceEventTimeout`, `disableSleeps`, `disableRetryDelays`. Introspectors are always
disposed with `await using` or storage isolation leaks between tests.

## Phase 0: spikes and measurements

Size: **M**. Nothing architectural is committed until this phase answers its questions.

This project targets Workers Free, which means a 10 ms CPU ceiling per request everywhere. Three
numbers have to be measured before the design can be trusted, plus one model behavior.

### 0.1 Is the model usable on this account

Call `@cf/meta/llama-3.3-70b-instruct-fp8-fast` from a deployed Worker on the target account. Record
whether it succeeds, and measure the actual rate limit by driving it until it returns 429.

The docs say text generation is 300 requests per minute by default, but models requiring the Workers
Paid plan get 20 per minute. Whether this model is in that category is UNVERIFIED and could not be
read from the docs repository, because the model reference pages are generated from a separate data
source.

Fallback if it is unavailable or too limited: `@cf/meta/llama-3.1-8b-instruct` also supports JSON
mode per the Workers AI docs, and the `ModelClient` interface makes the swap a one-line change. Record
the decision and the reason.

### 0.2 Does a Durable Object RPC call refresh the CPU budget

Write a Durable Object method that burns CPU in a measured loop, call it repeatedly over RPC, and
find where `exceededCpu` appears. Then repeat the same experiment over `fetch()` and over WebSocket
messages.

The docs say the budget is refreshed by "each incoming HTTP request or WebSocket message" and do not
mention RPC. DESIGN.md section 5 depends on the answer. The chunk driver sits behind one interface so
the answer changes one implementation, not the architecture.

### 0.3 How many requests fit in 10 ms

Build the columnar representation and a throwaway evaluator for a single comparison node. Measure:

- requests generated per 10 ms slice
- requests evaluated per 10 ms slice, for a trivial rule and for a rule with about ten nodes
- cost of decoding one traffic blob out of SQLite

Output is a chosen `Scenario.requestCount` with the measurement written next to it, and a chunk size
set conservatively below the measured ceiling.

If generation cannot be made to fit even when chunked, switch to build-time precomputation with a
digest assertion, as described in DESIGN.md section 5.

### 0.4 Structured output reliability for rule drafting

The important spike. Ask the model for a `RuleAST` as JSON against a JSON Schema, using
`response_format: { type: "json_schema", json_schema: ... }`, across at least 30 attempts spanning
three scenario shapes. Record:

- fraction that are valid JSON
- fraction that satisfy the schema
- fraction that also pass the type checker
- how often Workers AI returns the documented `JSON Mode couldn't be met` error
- which schema shapes fail most

Note that JSON mode does not support streaming, per the docs, so this call can never be streamed.

**Fallback plan, in order.** Each step is only taken if the previous one is measured to be
insufficient:

1. Flatten the schema. Nested recursive `RuleAST` unions are the most likely failure source. Try a
   flat node-list encoding with integer parent references instead of nesting.
2. Constrain harder. Replace open `string` value fields with enums drawn from the actual dictionary
   for that scenario, so the model picks an existing path or ASN rather than inventing one.
3. Two-call decomposition. First call picks the field and operator from enums; second call supplies
   only the value. Each call has a trivial schema.
4. Few-shot with three worked examples in the prompt.
5. If structured output is still unreliable, fall back to a constrained template: the model selects
   from a small set of parameterized rule shapes by index and supplies values. This preserves the
   thesis, since the model still proposes and code still verifies, and it is worth reporting honestly
   in the README as a measured finding rather than hidden.

Acceptance criteria for Phase 0:

- A `docs/spikes.md` exists recording all four measurements with dates and the account tier.
- `Scenario.requestCount` and the chunk size are chosen, with the measurement cited.
- The chunk transport (RPC, fetch, or WebSocket) is decided and recorded.
- The model is chosen and recorded.
- DESIGN.md section 5 and section 13 are updated so no measured item is still marked UNVERIFIED.

Tests added: benchmark harness under `test/bench`, excluded from the normal test run.

## Phase 1: thin end-to-end slice, deployed

Size: **L**. This is the phase that de-risks everything. It goes all the way through and it ships.

Deliberately thin. One scenario, a grammar of one field and one operator, no retry loop, no memory,
no evidence ledger. The point is that every boundary in DESIGN.md is crossed once by real code
running on Cloudflare.

Scope:

- Worker entrypoint with `routeAgentRequest()` and React UI served as static assets
  (`assets.not_found_handling: "single-page-application"`).
- `IncidentAgent` extending `Agent`, name-addressed, with SQLite schema for incidents, rule versions
  and traffic. `@callable()` methods: `startInvestigation`, `approve`, `reject`.
- Seeded simulator producing columnar traffic for **one** scenario, which is the credential stuffing
  **trap** scenario. The trap is in Phase 1 and not later, because it is the thing that validates the
  thesis, and building it last would mean discovering late that the loop does not actually change any
  outcome.
- Aggregator producing the seven breakdowns in a single pass.
- Minimal grammar: `http.request.uri.path` and `ip.src.asnum`, operators `eq` and `in`, plus `and`.
  Printer, lexer, parser, type checker, evaluator, and the round-trip assertion, all real, just
  narrow.
- One model call that emits `RuleAST` JSON. No retries yet: a failure fails the incident visibly.
- Replay evaluator producing the four counts and the safety score.
- `InvestigationWorkflow` with the steps from DESIGN.md section 8 that this slice needs, including
  `waitForApproval`.
- Approve and reject wired end to end, carrying a **rule version ID only**.
- Naive baseline rule generated in code, shown beside the model's rule. No model needed, so it always
  works.
- Deployed to a `workers.dev` subdomain.

Acceptance criteria:

- The deployed URL loads and the traffic panel shows live data.
- Typing a symptom starts a workflow and the step list updates over WebSocket without a reload.
- A rule is drafted, rendered, parsed back, and the round-trip assertion passes.
- Replay reports four counts and they are internally consistent: blocked never exceeds total.
- The naive baseline rule blocks measurably more legitimate traffic than the model's rule on the trap
  scenario, **or** this is recorded as a negative result in `docs/spikes.md`. Either outcome is
  acceptable at this stage; an unexamined outcome is not.
- Approve applies the rule and the traffic panel visibly recovers.
- Reject leaves nothing applied.
- Reloading the browser preserves incident history.
- The 60 second demo script in DESIGN.md section 3 can be performed against the deployed URL.

Tests added:

- Unit: simulator determinism (same seed gives an identical digest), aggregator counts sum to total,
  printer and parser round-trip on hand-written ASTs, evaluator against hand-checked expected counts.
- Integration: agent state survives eviction (`await using` on the introspector), workflow reaches
  `awaiting-approval`, `mockEvent` drives approval to completion, reject produces
  `WorkflowRejectedError`.
- Security: approving with a rule version ID that is not `Incident.proposedRuleVersionId` is
  rejected. Applying without an approval row is rejected. These two tests exist from Phase 1 onward
  and never get deleted.

## Phase 2: the real parser and evaluator

Size: **L**. The core of the project. Abhishek owns the grammar and must be able to explain every
line.

- Finalize the grammar from DESIGN.md section 7. Cut anything not defensible.
- Full lexer with position tracking, so diagnostics carry byte spans.
- Recursive descent parser with correct precedence: `lower()`, then `not`, then `and`, then `or`.
- Type checker: string fields reject numeric literals and vice versa, `contains` rejects number
  fields, `in` requires a homogeneous set, `lower()` rejects number fields.
- Diagnostics with stable machine codes, useful messages, and spans.
- Evaluator covering the whole grammar over columnar traffic, in integer space.
- AST depth and node count caps, enforced before printing.

Acceptance criteria:

- Every grammar production has at least one positive and one negative test.
- Every diagnostic code is produced by at least one test.
- Property test: 1,000 generated ASTs all round-trip through printer and parser.
- Property test: evaluator over columnar traffic agrees with a naive reference evaluator over decoded
  `Request` objects, on generated rules and traffic. This is the real correctness argument for the
  columnar optimization.
- Precedence tests pin `a or b and c` and `not a and b` to the documented order.
- Evaluator still fits the measured CPU budget at the full grammar. Re-measure; do not assume.

Tests added: a large unit suite. This phase is mostly tests by volume.

## Phase 3: retry loop and diagnostics feedback

Size: **M**.

- Bounded loop over steps 6, 7 and 8 from DESIGN.md section 8, with deterministic step names.
- Diagnostics fed back into the drafting prompt.
- `RuleVersion` rows recorded for every attempt including failures, with `rawModelOutput` kept.
- Every failure class handled distinctly: `invalid-schema`, `invalid-types`, `roundtrip-failed`.
  `roundtrip-failed` is a hard failure and never retried, because it is our bug.
- UI shows the attempt history so a reviewer can see what was rejected and why.

Acceptance criteria:

- With a fake model scripted to fail twice then succeed, the incident completes on attempt 3 and all
  three rule versions are persisted.
- With a fake model that always fails, the incident reaches `failed` with three recorded attempts and
  no rule proposed.
- A forced printer bug makes the round-trip assertion fail loudly rather than retry.
- Step names in a three-attempt run are exactly the deterministic names from DESIGN.md.

Tests added: unit tests for the loop against the fake model; integration test using `mockStepError`
to fail a validate step and confirm the retry policy behaves.

## Phase 4: scenarios, evidence ledger, memory

Size: **L**.

- Grow to 8 to 12 scenarios across the three families, of which at least 3 are traps with different
  `trapAttribute` values.
- `Evidence` records created by every deterministic tool, with stable IDs.
- Hypothesis must cite evidence IDs; citations to non-existent IDs are a detected failure.
- UI makes every claim clickable through to its evidence.
- Lessons persisted per incident and retrieved by scenario family in step 2.
- Retention policy for `cf_agents_workflows`, since the SDK does not clean it up.

Acceptance criteria:

- Every scenario runs end to end and its threshold outcome is recorded.
- Every claim shown in the UI resolves to an evidence record.
- A hypothesis citing a fabricated evidence ID is caught and surfaced, not rendered.
- Running the same scenario twice shows the prior lesson retrieved on the second run.
- Workflow tracking rows older than the retention window are deleted.

Tests added: one scenario-level test per scenario asserting its threshold outcome; evidence integrity
tests; a memory retrieval test.

## Phase 5: eval harness and ablations

Size: **M**.

- CLI harness running all scenarios and emitting a table of the metrics in DESIGN.md section 9.
- Response cache keyed by hash of `(scenario, prompt, model)`, so ablations and re-runs are nearly
  free and results are reproducible.
- All four ablations from DESIGN.md section 9: no retry loop, no memory, naive baseline, text output
  instead of AST.
- Results committed as a checked-in report so the README can cite measured numbers.

Acceptance criteria:

- `npm run eval` produces the metrics table against the fake model with no credentials.
- `npm run eval -- --real` produces it against Workers AI.
- Re-running with a warm cache produces byte-identical results.
- The naive baseline ablation shows the collateral damage gap on trap scenarios, or the absence of a
  gap is reported.
- The text-versus-AST ablation quantifies the syntax error rate the AST approach avoids.

Tests added: a smoke test that the harness runs and the cache is honored.

## Phase 6: failure injection and tracing

Size: **M**. Mostly a matter of using the plugin's introspection API.

- Failure injection tests: every step forced to error and to time out; approval forced to time out;
  rejection path; model rate limiting.
- Step timings and chunk counts recorded and surfaced.
- Structured logging with the incident ID as a correlation key.

Acceptance criteria:

- Every step in DESIGN.md section 8 has a test that forces it to fail and asserts the incident ends
  in a defined state, never a silent hang.
- `forceEventTimeout` on the approval gate moves the incident to `timed-out` with nothing applied.
- Step timings and chunk counts appear in the UI for a completed incident.

Tests added: the failure injection suite.

## Phase 7: UI polish, README, PROMPTS

Size: **M**. Required for submission, so it is a phase and not an afterthought.

- README with clear run instructions, the deployed demo link, the architecture summary, and measured
  numbers from Phase 5 or an explicit statement that a number is not yet measured.
- PROMPTS.md with the AI prompt history.
- `prompts/` directory committed, holding every prompt template under version control.
- UI: evidence drill-down, attempt history, before-and-after traffic panels, naive-versus-proposed
  comparison.

Acceptance criteria:

- A reviewer can clone, install, and run locally by following the README with no other knowledge.
- The deployed link works from a clean browser profile.
- Every number in the README traces to a Phase 5 artifact or is marked as unmeasured.
- PROMPTS.md and `prompts/` are present and current.
- The 60 second demo script performs as written.

## Sequencing notes

- Phase 0 gates everything. Do not start Phase 1 before its four answers exist.
- Phase 1 includes the trap scenario and the naive baseline. Neither is deferred, because together
  they are the experiment that decides whether the project's thesis is demonstrable at all. Finding
  out in Phase 4 would be too late to change course.
- Phases 2 and 3 can overlap slightly, but the grammar should settle before the retry loop is tuned,
  since the diagnostics are what the loop feeds back.
- Tier 1 in the original scope is Phases 0 through 3. Tier 2 is Phases 4 through 6. Phase 7 is
  required regardless of tier, so it is never traded away.
- If time runs short, cut scenario count (Phase 4) and tracing (Phase 6) before cutting tests.
