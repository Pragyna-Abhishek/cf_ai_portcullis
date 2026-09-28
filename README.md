# Portcullis

Portcullis is an attack-response agent for simulated web traffic. An operator describes a symptom
("users are getting locked out"). An LLM reads label-blind traffic summaries and proposes one
firewall rule. Deterministic code then parses the rule, type checks it, proves the printer and
parser agree, and replays every request through it to count how much attack and how much legitimate
traffic it blocks. A human approves a specific stored rule version by ID, and only that stored
version is applied. The model proposes; code verifies and produces every number; a person decides.

Built on Cloudflare Workers, the Agents SDK (Durable Objects), Workflows and Workers AI, on the
Workers Free plan.

## Live demo

<https://portcullis.pragyna-portcullis.workers.dev>

1. Wait for the traffic panel to fill (the credential-stuffing trap scenario).
2. Type a symptom and press **Investigate**. The step list on the right updates live.
3. When a rule is proposed, compare it with the naive baseline shown beside it, then press
   **Approve this exact rule**. Traffic recovers.
4. Reload the page. The incident is still there, because state lives in the Durable Object.

The deployed site calls the real model. As of this writing the real model has not yet produced an
approved rule on the deployed site (see [Real-model results](#real-model-results)), so step 3 may
end in a visible `failed` state with the attempt history shown. The full flow has been driven end
to end locally against the fake model.

## Architecture

```
Browser (React UI)
   |  WebSocket: state sync + @callable RPC
   v
Worker entry (routeAgentRequest)
   v
IncidentAgent (Durable Object + SQLite) ---- deterministic core (src/core, no platform imports)
   |  runWorkflow / approve / reject              simulator, aggregator, rules language,
   v                                              evaluator, replay math
InvestigationWorkflow (durable steps) ------> Workers AI (llama-3.3-70b-instruct-fp8-fast)
   |  waits on approval gate
```

- **Worker**: serves the UI as static assets and routes `/agents/*` to the Agent.
- **Agent / Durable Object** (`IncidentAgent`): owns all state in SQLite (incidents, rule
  versions, evidence, traffic chunks, lessons) and exposes `startInvestigation`, `approve`,
  `reject`.
- **Workflow** (`InvestigationWorkflow`): the fixed investigation sequence as durable, retryable
  steps, parked on a durable approval gate until a human decides.
- **Workers AI**: classifies the symptom, forms a hypothesis citing evidence IDs, drafts the rule,
  writes the closing report. Nothing it returns reaches anything but a JSON Schema validator and
  our parser.
- **Rules language**: our own lexer, parser, type checker, printer and columnar evaluator for a
  subset of Cloudflare's Rules language. Every draft must round-trip printer to parser exactly.
- **Simulator**: seeded, deterministic traffic across 8 scenarios in 3 attack families, 5 of them
  traps where the obvious rule also blocks real customers.

Design, data model, grammar, security model and the 13 architecture invariants:
[DESIGN.md](DESIGN.md) (invariants in section 14).

## Real-model results

**Sample size: one investigation on the deployed site, 2026-09-27, three draft attempts.** Full
write-up: [docs/reviews/2026-09-27-first-real-model-run.md](docs/reviews/2026-09-27-first-real-model-run.md).

**First run: failed.** All 3 draft attempts were rejected as `E_SCHEMA_NOT_JSON`. The model was
then asked for the rule as a JSON syntax tree (a flat node list).

**Diagnosis.** A change merged the same day records, per attempt, completion tokens, the token
limit, and a head and tail excerpt of the raw output. All three attempts showed
`completionTokens: 1024` of `maxTokens: 1024`: cut off at the limit. The excerpts contained only
`and`/`or` nodes with doubling IDs and not one leaf condition. The model spent its whole budget
expanding connectives. This is the same pathology Phase 0's spike 0.4 measured on 2026-09-25 (0/30
valid JSON against the original schema), so the schema fallbacks tried since did not remove it.

**Fix adopted.** The model now returns `{"rule": "RULE TEXT"}`, and the rule text goes through the
same parser, type checker and round-trip check as a rule typed by the operator. Text has no
content-free node to repeat, and a truncated rule becomes an ordinary parse error fed back to the
next attempt. Validation was not loosened.

**Results after the fix: none yet.** The text route has not been run against the real model. No
number is reported for it.

**Naive baseline comparison** (simulator, credential-stuffing trap scenario, fixed seed; exact and
deterministic, pinned by `test/unit/scenario.test.ts`):

| Rule | Attack blocked | Legitimate blocked |
| --- | --- | --- |
| Naive baseline, `ip.src.asnum eq 64500` | 62.3% (1061 of 1704) | 46.3% (1987 of 4296) |
| Hand-written rule (the fake model's canned answer) | 100% (1704 of 1704) | 0% (0 of 4296) |

The second row shows the scenario can be separated precisely. It says nothing about what the real
model proposes.

## Harness self-tests (fake model)

`npm run eval` runs all 8 scenarios and four ablations against a fake model that returns one fixed
rule regardless of input. The results in
[docs/eval-results/fake.json](docs/eval-results/fake.json) (for example 8/8 schema-valid, and the
naive baseline failing its thresholds on 5 of 5 trap scenarios) show that the harness, retry loop,
ablations and reporting run correctly. **They are not evidence of model quality.** See
[docs/eval-results/README.md](docs/eval-results/README.md).

## Verification

Independent review sessions were run against the work and written up in
[docs/reviews/](docs/reviews/):

- [2026-09-26-quota-pr.md](docs/reviews/2026-09-26-quota-pr.md): a review of the quota-handling
  change found four issues. The "never retried" test mocked away the code it claimed to test; the
  quota flag never cleared at the daily reset; `modelStatus`/`recordModelOutcome` had no tests;
  a comment cited an error code the docs do not list. Writing the new tests also found a fifth bug
  (state not refreshed after recording an outcome).
- [2026-09-27-first-real-model-run.md](docs/reviews/2026-09-27-first-real-model-run.md): the
  diagnosis and fix above.

Fixes were checked by mutation: the fix was reverted, the new test was shown to fail, and the fix
was restored. For example, removing the non-retry wrapping made the quota test fail with
`expected 3 to be 1`, and removing the UTC-day check made the reset test fail with
`expected 'quota-exhausted' to be 'live'`.

## Free-plan operation

- Workers AI on the Free plan allows 10,000 neurons per day; the allocation resets daily
  ([docs/spikes.md](docs/spikes.md), spike 0.1).
- On 2026-09-25 the Phase 0 spikes used it up in one burst: about 42 near-max-length structured
  calls, 400 small rate probes and one 4,096-token diagnostic call. The Cloudflare dashboard showed
  15.52k neurons over that period and 0 of 10,000 used on 2026-09-27
  ([docs/spikes.md](docs/spikes.md), "investigating the Sep 25 neuron burst").
- Each incident shows a running neuron total, computed in code from each response's token usage
  and the model's published per-token rate. A measured per-investigation figure has not been
  recorded in this repository, and neither has a comparison against the dashboard.
- Quota errors (`3036`, and `4006` as observed on this account) are never retried at any level.
  The investigation fails at once with a clear reason, the UI shows "quota exhausted" until a
  successful call or the next UTC day, and the eval harness stops and keeps its cache. Rate-limit
  errors (`429`, `3040`) are retried with backoff. PR preview deploys use the fake model so they
  spend no neurons (`wrangler.jsonc`).

## Run locally, test, deploy

Needs Node 22. No Cloudflare account needed; local mode uses the fake model and the UI labels it.

```sh
npm install
npm run build
npx wrangler dev --local --var MODEL_MODE:fake   # http://localhost:8787
```

```sh
npm run typecheck
npm run test:unit          # 232 tests, plain Vitest: the deterministic core
npm run test:integration   # 50 tests in workerd via @cloudflare/vitest-plugin, fake model
npm run coverage           # Istanbul coverage for src/core
npm run bench              # CPU benchmarks
npm run eval               # eval harness, fake model; add -- --real for Workers AI
```

Test highlights: 1,000 generated rules round-trip through printer and parser; the columnar
evaluator agrees request by request with an independent naive evaluator; approving any rule version
other than the one shown is refused, and applying without an approval row is refused; every
Workflow step is forced to fail and must end in a defined `failed` state.

Deployment: pushes to `main` deploy through Cloudflare Workers Builds. Manual deploy:
`npx wrangler login && npm run deploy`.

## Known limitations

- **The real model has not yet produced a verified rule.** One real investigation, 0 of 3 drafts
  valid, on a route since replaced. The replacement is untested against the real model.
- **No authentication.** Anyone with the URL can approve. "A human authorizes" means whoever holds
  the link (DESIGN.md sections 11 and 12).
- **Simulated traffic only.** Rules apply to the simulator, never to a real zone.
- **CPU numbers are from Node on a development machine**, not Cloudflare hardware. The on-account
  spike found no 10 ms CPU ceiling at all, which leaves open whether it is enforced on that path
  ([docs/spikes.md](docs/spikes.md), 0.2).
- **The eval harness still measures the old AST route as its primary flow**, with the text route
  as an ablation (PLAN.md, deviations).
- **Account tier is UNVERIFIED** from the API; Workers Free is the stated target.
- **Grammar is a small subset** of Cloudflare's Rules language (DESIGN.md section 7).

## More

- [DESIGN.md](DESIGN.md): architecture and source of truth. [PLAN.md](PLAN.md): phases and status.
- [docs/spikes.md](docs/spikes.md): every measurement with date and conditions.
- [PROMPTS.md](PROMPTS.md): how the coding assistant was directed, and the runtime prompt templates
  in [prompts/](prompts/).
