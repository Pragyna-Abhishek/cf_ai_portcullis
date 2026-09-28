# Phase 0 spikes and measurements

Every number the design relies on lives here, with its date, where it was measured, and on what.
Cite this file rather than restating a number from memory.

**Target account tier:** Workers Free (as stated in PLAN.md). The account's actual billing tier
could not be confirmed from the API token used here (`GET /accounts/:id/subscriptions` returned an
authentication error, likely a token-scope limit, not a tier answer). Marked UNVERIFIED below where
it matters.

**Where these were measured:** 0.1, 0.2 and 0.4 were run 2026-09-25 against the real account, via
`portcullis-spikes.pragyna-portcullis.workers.dev` (a `workers.dev` subdomain registered on this
account for the spike Worker; none existed before). Raw results are in `docs/spike-results/`. 0.3 is
unchanged, measured locally.

| Spike | Status | Decision taken |
| --- | --- | --- |
| 0.1 Model usable on the account, and its rate limit | MEASURED on account, 2026-09-25 | Keep `@cf/meta/llama-3.3-70b-instruct-fp8-fast`. No fallback needed |
| 0.2 Does a Durable Object RPC call refresh the CPU budget | MEASURED on account, 2026-09-25 (partial, see below) | Keep RPC; no failure was found to force a change |
| 0.3 How many requests fit in 10 ms | MEASURED locally, 2026-09-25 | `CHUNK_SIZE = 500`, `requestCount = 6000` |
| 0.4 Structured output reliability | MEASURED on account, 2026-09-25, **fails**; fallback 1 (flat schema) also measured, still fails; fallback 2 (type-split leaf kinds) measured 2026-09-27 on the deployed site, also fails (0/3, `docs/reviews/2026-09-27-first-real-model-run.md`); production moved to rule text | Flat, type-split node-list JSON Schema (`RULE_JSON_SCHEMA`), no `$ref` recursion and no union-typed fields. See below |

## 0.3 CPU per chunk

Measured 2026-09-25 in Node 22.22.2 on an Intel Xeon at 2.10 GHz (4 vCPU) in the development
container. Not on Cloudflare hardware.

Why Node and not workerd: inside a Worker, timers do not advance during synchronous CPU work (a
Spectre mitigation), so CPU time cannot be measured from inside a Worker. Node runs the same V8
engine. The numbers are an estimate of the production figure, which is why the chunk size keeps a
wide margin.

### Warm (median of 41 runs after 20 warm-up runs)

Command: `npm run bench`. Source: `test/bench/cpu.test.ts`.

| chunk | generate | encode | decode | aggregate | eval trivial | eval ~10 nodes |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 250 | 0.128 ms | 0.002 ms | 0.004 ms | 0.098 ms | 0.044 ms | 0.103 ms |
| 500 | 0.055 ms | 0.006 ms | 0.007 ms | 0.122 ms | 0.018 ms | 0.027 ms |
| 1000 | 0.128 ms | 0.012 ms | 0.013 ms | 0.153 ms | 0.021 ms | 0.031 ms |
| 2000 | 0.209 ms | 0.019 ms | 0.019 ms | 0.329 ms | 0.044 ms | 0.067 ms |
| 4000 | 0.527 ms | 0.034 ms | 0.035 ms | 0.996 ms | 0.152 ms | 0.217 ms |

### Cold (first call in a fresh process, p50 and max of 15 processes)

Command: `node scripts/bench-cold.mjs 15`. Source: `test/bench/cold.ts`. This is the honest bound:
the first request into a new isolate gets no warm JIT.

| chunk | generate | encode | decode | aggregate | verify (pipeline) | compile | evaluate |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 500 | 2.42 / 3.60 ms | 0.15 / 0.25 ms | 0.14 / 0.24 ms | 0.68 / 1.61 ms | 2.04 / 3.54 ms | 0.29 / 0.42 ms | 1.06 / 1.76 ms |
| 1000 | 4.25 / 5.58 ms | 0.18 / 0.24 ms | 0.15 / 0.35 ms | 1.01 / 1.59 ms | 1.98 / 2.58 ms | 0.32 / 1.39 ms | 0.47 / 0.70 ms |
| 2000 | 6.00 / 6.89 ms | 0.18 / 0.55 ms | 0.16 / 0.32 ms | 1.69 / 2.94 ms | 2.05 / 4.01 ms | 0.29 / 0.53 ms | 0.69 / 1.12 ms |
| 6000 | 9.21 / 11.26 ms | 0.25 / 0.36 ms | 0.26 / 0.33 ms | 3.47 / 5.27 ms | 2.43 / 4.43 ms | 0.35 / 0.50 ms | 1.64 / 2.19 ms |

### What this decides

- **Generating a whole scenario in one call does not fit.** 6,000 requests cold is 9.2 ms at the
  median and 11.3 ms at worst, before any SQLite write. Chunking is required, as DESIGN.md section 5
  predicted.
- **`CHUNK_SIZE = 500`.** The heaviest single call is `ensureTrafficChunk`: generate, encode and
  aggregate one chunk. At 500 that is 3.3 ms at the median and at most 5.5 ms cold (summing the
  per-operation maxima, which is pessimistic), leaving room for the SQLite write and RPC overhead.
  At 1,000 the same sum is 7.4 ms, too close to 10 ms. Warm, every operation on a 500 chunk is well
  under 1 ms.
- **`Scenario.requestCount = 6000`**, which is 12 chunks. Each heavy workflow step makes 12 Agent
  calls, inside the Workers Free limit of 50 subrequests per request.
- **Evaluation is cheap.** Even cold, replaying 6,000 requests through a real rule is 1.6 ms median.
  Replay is still chunked, because it shares the chunk loop with generation and because the budget
  is per call.
- **Re-measure on the account.** Look for `exceededCpu` in Workers logs during the first cold
  generation. If it appears, halve `CHUNK_SIZE` in `src/core/chunks.ts`; nothing else changes.

Phase 2 re-measurement at the full grammar: the "eval ~10 nodes" column uses a rule touching every
column kind (`and`, `or`, `not`, `contains` with `lower()`, string `in`, number `in`), and the
"verify" column runs the whole pipeline (decode, limits, type check, print, parse, round trip) on a
realistic rule. Both are inside budget.

## 0.1 Model availability and rate limit (MEASURED)

Measured 2026-09-25 against the deployed spike Worker
(`portcullis-spikes.pragyna-portcullis.workers.dev`), calling `/model/probe` (a tiny JSON-mode
prompt, `max_tokens: 16`), 400 requests in waves of 20 concurrent. Command:
`node scripts/run-spikes.mjs <url> model-rate 400`. Raw result:
`docs/spike-results/0.1-model-rate.json`.

| Requests sent | Succeeded | Rate-limited | Elapsed | Sustained rate |
| ---: | ---: | ---: | ---: | ---: |
| 400 | 400 | 0 | 26.1 s | ~15.3 req/s |

**The model is usable on this account and no fallback is needed.** 400/400 succeeded with kind
`"ok"`; the driver never observed `kind: "rate-limited"`, so the true rate-limit ceiling was not
found, only that it sits above ~15.3 req/s sustained (and above 20 concurrent in a wave), which is
already above the docs' 300/min (5/s) figure for the default tier and far above the 20/min (0.33/s)
figure for the Workers-Paid-only tier. This is consistent with (but does not by itself confirm)
Llama 3.3 70B fp8-fast being on the default tier, as PLAN.md's reading of the changelog assumed.

What the docs say, read 2026-09-25 from the `cloudflare/cloudflare-docs` repository:

- Text generation models get 300 requests per minute by default. Models that require Workers Paid
  get 20 per minute (`workers-ai/platform/limits.mdx`).
- On 2026-07-28, Kimi K2.6, Kimi K2.7 Code and GLM-5.2 moved to Workers Paid only
  (`changelog/workers-ai/2026-07-28-models-require-workers-paid.mdx`). Llama 3.3 70B is not on that
  list, and the pricing page lists it with no paid-only note. So it is probably callable on Free at
  300 per minute. UNVERIFIED until measured.
- Free accounts get 10,000 neurons per day. Llama 3.3 70B fp8-fast costs 26,668 neurons per million
  input tokens and 204,805 per million output tokens (`workers-ai/platform/pricing.mdx`).
- The current draft prompt is 5,795 characters for the trap scenario at seed 1 (measured
  2026-09-25 by assembling it with `buildDraftRulePrompt`; `test/unit/model.test.ts` keeps it
  under 12,000). At a rough 4 characters per token (UNVERIFIED) that is
  about 1,450 input tokens, so a draft with 150 output tokens would cost about 70 neurons, or roughly
  140 drafts per day on the free allocation. This is an estimate, not a measurement, and it is the
  reason the Phase 5 eval harness caches responses.

**The planned fallback model no longer exists.** PLAN.md named `@cf/meta/llama-3.1-8b-instruct` as
the fallback. It was deprecated on 2026-05-30
(`changelog/workers-ai/2026-05-08-planned-model-deprecations.mdx`). Llama 3.3 70B fp8-fast is
explicitly listed there as remaining active. Replacement fallback candidates from the same
changelog, all UNVERIFIED for JSON mode support: `@cf/meta/llama-3.1-8b-instruct-fast`,
`@cf/google/gemma-4-26b-a4b-it`, `@cf/zai-org/glm-4.7-flash`. The model ID is one variable
(`MODEL_ID` in `wrangler.jsonc`).

Also from the docs: error `3036` means the daily neuron allocation is used up and `3040` means out
of capacity. A live probe of this account (docs/eval-results/README.md) returned `4006` for the
same daily-allocation condition, so `src/model/workers-ai.ts` treats `3036`/`4006` as
`quota-exhausted`, never retried at any level, and `3040`/429 as `rate-limited`, retried with
backoff. Originally (Phase 0) both were treated alike as retryable; that was a bug, found after the
2026-09-25 spikes had already spent the daily allocation retrying calls that could not succeed
until the next day's reset.

## 0.2 CPU budget refresh per transport (MEASURED, partial)

Measured 2026-09-25 against the deployed spike Worker. Command:
`node scripts/run-spikes.mjs <url> cpu`. Raw result: `docs/spike-results/0.2-cpu.json`.

The driver's method: call `Burner.burnRpc(iters)` once per request over RPC, doubling `iters` from
250,000 until a call fails with `exceededCpu`, to find a single-call ceiling. It would then issue
four calls at 60% of that ceiling back-to-back over RPC, `fetch()`, and WebSocket, to see whether
each transport gets a fresh budget.

**No single RPC call failed, up to 512,000,000 loop iterations** (the ladder's cap). Because no
ceiling was found, the second half of the experiment (the fetch/WebSocket comparison) did not run:
there was no ceiling to compute 60% of. This is a genuine result, not a bug: every rung of the
ladder, from 250,000 to 512,000,000 iterations, returned `ok: true`.

**This does not confirm the account enforces a 10 ms CPU budget on this call path at all**, which is
the more important open question than the original one (whether RPC specifically refreshes it). Two
explanations are both consistent with the data and neither is confirmed:

1. The account tier is not Workers Free CPU-limited at 10 ms (tier is UNVERIFIED here, see above).
2. `Burner.burnRpc`'s CPU cost, even at 512M xorshift iterations, executes fast enough under V8's
   JIT to stay under 10 ms in the Durable Object's own accounting, and DO RPC calls are charged to
   an isolate whose CPU accounting is separate from the calling Worker's, which would itself answer
   the original question (RPC gets its own budget) but was not directly observed, only inferred.

**Decision:** keep RPC for the Workflow's chunk loops, per the existing design. No measurement forced
a change to `fetch()`. But the underlying assumption (that a chunked call this size fits under
10 ms in production) is not proven by this spike; it rests on the local CPU-per-operation numbers
in 0.3 instead. If `exceededCpu` appears in Workers logs once the real app runs Workflow steps
against real traffic chunks, revisit this and switch the transport per the plan already in DESIGN.md
section 5.

## 0.4 Structured output reliability (MEASURED, fails)

Measured 2026-09-25 against the deployed spike Worker. Command:
`node scripts/run-spikes.mjs <url> structured 10`. Raw result:
`docs/spike-results/0.4-structured.json` (all 30 attempts, full raw model output for each).

The driver sends the real production prompt and schema for three scenario shapes, 10 seeds each (30
attempts), and verifies every output locally with the real pipeline. It records the fractions the
plan asks for: valid JSON, schema-valid, type-valid, `JSON Mode couldn't be met`, and which
diagnostics occur. As a bonus it replays each valid rule and the naive baseline.

The three shapes: the committed trap (`cs-trap-carrier`), the same trap with a single attack user
agent and different wording, and a non-trap where the attack comes only from hosting ASNs.

Temperature is 0, as in production, so the 30 attempts differ by traffic seed and wording rather
than by sampling.

### Result: 0/30 valid JSON, 0/30 schema-valid, 0/30 type-valid

| Metric | Result |
| --- | --- |
| Attempts | 30 (3 shapes x 10 seeds) |
| Valid JSON | 0/30 |
| Schema-valid | 0/30 |
| Type-valid | 0/30 |
| `JSON Mode couldn't be met` | 0/30 |
| Other errors | 0/30 |
| Passes replay thresholds | 0/30 |

Every attempt returns `responseKind: "ok"`. Workers AI does not report a JSON-mode failure, but the
raw text is not parseable JSON. All 30 fail with the same diagnostic (`E_SCHEMA_NOT_JSON`), the same
failure shape, and a similar wall time (26.0-35.7 s per call). This is fully reproducible: identical
across all three scenario shapes and all ten seeds, not a rare or seed-dependent flake.

**Root cause, read from the raw output:** the model gets stuck generating an unboundedly deep,
degenerate `RuleAST`. Instead of a shallow tree, it emits `{"kind": "or", "left": {"kind": "or",
"left": {"kind": "or", ...` nested many hundreds of levels deep, never reaching a leaf condition or
closing the object, until `max_tokens` (1024) cuts it off mid-string. The truncated text is not valid
JSON, so it never even reaches the JSON Schema validator. Raw output length is consistently
2,619-2,731 characters of pure nested `"or"` wrapper with no actual conditions.

This is exactly the risk PLAN.md's fallback plan named first: "Nested recursive `RuleAST` unions are
the most likely failure source." It was correct. **The AST-as-nested-JSON-Schema approach, as
currently designed and prompted, is not usable with this model at this schema.** This is a measured,
negative result, recorded rather than hidden per CLAUDE.md's "never report an unmeasured number" and
the parallel rule against skipping inconvenient findings.

### Fallback 1, flattening the schema: implemented, measured, not sufficient alone

Replaced the nested `$ref` schema with a flat node list (`{"root": ID, "nodes": [{"id", "kind", ...},
...]}`), children referenced by integer id, capped at `maxItems: 64`. `src/core/rules/schema.ts`,
`RULE_JSON_SCHEMA`; decoder rewritten to resolve ids with an explicit depth guard (`maxDepth`, still
32) *and* a separate expansion-budget guard (`maxNodes`, 64): a node referenced by two parents
expands at each reference, so depth alone does not bound total work; a small node list could still
blow up combinatorially within the depth cap. `prompts/draft-rule.system.txt` and
`draft-rule.user.txt` updated to describe the flat format. Full unit test coverage in
`test/unit/rules/schema.test.ts`, including the reused-reference case.

Re-ran the structured spike (30 attempts) against the account with the flat schema alone:
**still fails.** `docs/spike-results/0.4-structured.json` (overwritten with this run):

| Metric | Result |
| --- | --- |
| Valid JSON | 2/30 |
| Schema-valid | 0/30 |
| Other errors (rate-limited from the earlier back-to-back spike runs) | 18/30 |

Flattening alone did not fix the underlying problem; it changed its shape. A follow-up single-call
probe with `max_tokens` raised from 1024 to 4096 (temporarily, on the spike Worker only, to see the
model's output past the previous truncation point) showed why: **the model built a perfect binary
tree of exactly 64 `"and"`/`"or"` nodes and zero leaf conditions**, every leaf-shaped reference
pointing past the end of the array (ids up to 128 against a 64-entry list). This is a genuine model
pathology, not an artifact of either encoding: without a recursion depth to run away in, the model
instead ran away in sibling count, building out logical connectives it never resolved into an actual
condition, until it exactly filled the array-length cap with nothing but `and`/`or`.

### Fallback 2, splitting leaf kinds by value type: implemented; measured 2026-09-27, also fails

Hypothesis: the leaf kinds' `value: ["string", "integer"]` union type is the reason the model avoids
them. Workers AI's constrained JSON-mode decoder may handle a union-typed field poorly compared to
the plain-integer `left`/`right`/`operand` fields on `"and"`/`"or"`/`"not"`, making the connective
kinds structurally "easier" to keep emitting.

Implemented: `"compare"` and `"in"` split at the wire level into `"compareString"`/`"compareNumber"`
and `"inStrings"`/`"inNumbers"`, each with a single-typed `value`/`values` and a field enum
restricted to that type's fields. No union types remain anywhere in `RULE_JSON_SCHEMA` (asserted by a
test). The internal `RuleAST` type is unchanged; `encodeRuleAst` picks the wire kind from the
literal's JS type, `decodeRuleAst` maps back. `prompts/` updated to match. Full unit coverage in
`test/unit/rules/schema.test.ts`.

**Not measured on 2026-09-25.** Testing fallback 1 and probing the failure mode (including the
`max_tokens: 4096` probe above) spent that day's 10,000 neuron free allocation; the account started
returning error `3036`/`4006` ("used up your daily free allocation") partway through verification.

**Measured 2026-09-27, on the deployed site's first real investigation: also fails.** All three
draft attempts ran to the 1,024-token limit emitting only `and`/`or` nodes, `E_SCHEMA_NOT_JSON`,
0/3. This was one investigation of three attempts, not a 30-attempt spike run. Full
account: `docs/reviews/2026-09-27-first-real-model-run.md`. Production moved to asking for rule text
instead of AST JSON (DESIGN.md section 7, "Round-trip property"). One post-fix run produced a valid
rule on the first attempt (`docs/reviews/2026-09-28-first-text-route-run.md`).

If the type split is also insufficient once re-measured, the next fallback in PLAN.md's ordered list
is two-call decomposition (one call picks field/operator from enums, a second supplies only the
value), then few-shot examples, then constrained template selection as the final fallback.

## Measured on the simulator: the trap works

This is deterministic, so it is exact for the committed scenario and seed. Pinned by
`test/unit/scenario.test.ts`.

| Rule | Attack blocked | Legitimate blocked | Passes thresholds |
| --- | --- | --- | --- |
| Naive baseline, `ip.src.asnum eq 64500` | 1061 of 1704 (62.3%) | 1987 of 4296 (46.3%) | No |
| The fake model's canned rule | 1704 of 1704 (100%) | 0 of 4296 (0%) | Yes |

The canned rule is written by hand in `src/model/fake.ts`. It shows the scenario can be separated
precisely; it says nothing about whether the real model will find such a rule. That is what 0.4
measures.

## How to run the account spikes

Needs a Cloudflare account on the target tier and `wrangler login` (or `CLOUDFLARE_API_TOKEN`).

```sh
npx wrangler deploy -c spikes/wrangler.jsonc
# prints https://portcullis-spikes.<your-subdomain>.workers.dev

node scripts/run-spikes.mjs https://portcullis-spikes.<sub>.workers.dev cpu
node scripts/run-spikes.mjs https://portcullis-spikes.<sub>.workers.dev structured 10
node scripts/run-spikes.mjs https://portcullis-spikes.<sub>.workers.dev model-rate 400
```

Each writes `docs/spike-results/<spike>.json`. Run `model-rate` last: it deliberately drives the
account into rate limiting, and it spends neurons (tiny prompts, `max_tokens` 16).

Done 2026-09-25 on this account: subdomain `pragyna-portcullis.workers.dev`, registered via
`PUT /accounts/:id/workers/subdomain` (the account had none; wrangler's auto-registration failed
because the default name `portcullis` is taken globally). Deployed URL:
`https://portcullis-spikes.pragyna-portcullis.workers.dev`. All three spikes ran; results above and
in `docs/spike-results/`.

Node's built-in `fetch` does not read `HTTPS_PROXY`/`NO_PROXY` by default (unlike `curl`), which
matters only inside a network-sandboxed dev container like the one these spikes were run from. If
`node scripts/run-spikes.mjs` fails with a "Host not in allowlist" body instead of JSON, run
`node --use-env-proxy dist/spikes/driver.mjs <args>` directly after the `esbuild` step instead
(Node 22's experimental env-proxy support). Not needed against a real network with no egress proxy.

## 2026-09-27: investigating the Sep 25 neuron burst

The Cloudflare dashboard showed 15.52k neurons used in the three days before this entry, all on
`@cf/meta/llama-3.3-70b-instruct-fp8-fast`, in a single burst around 2026-09-25, and zero before or
since (today's usage: 0 of 10,000). This contradicted the standing claim elsewhere in this repo that
the daily allocation "has been exhausted since Phase 0." This section records what was found.

**What produced the burst.** Git history places every account-touching command in one sitting on
2026-09-25, between 21:45 and 22:22 UTC:

- `node scripts/run-spikes.mjs <url> structured 10`, run twice: once against the original nested
  `$ref` schema (30 calls, each running to `max_tokens: 1024` before truncation, 0/30 valid; this is
  the run recorded as spike 0.4's headline result), and once again after flattening the schema (spike
  0.4's "fallback 1"): 30 more attempts, but only 12 of those actually reached the model, because
  18/30 came back rate-limited from calls made in the same back-to-back run.
- A single manual follow-up call with `max_tokens` raised from 1024 to 4096, made to see the model's
  output past the previous truncation point while diagnosing the failure mode (recorded under
  fallback 1's write-up).
- `node scripts/run-spikes.mjs <url> model-rate 400`: 400 calls with a tiny prompt and
  `max_tokens: 16`, run to find a rate-limit ceiling (spike 0.1). None was found; all 400 succeeded.

So: roughly 42 near-max-output structured-draft calls, plus 400 tiny probe calls, plus one large
`max_tokens` diagnostic call, all in one sitting. Rough neuron math (1,450 input tokens per draft
call per spike 0.1's own estimate, up to 1,024 output tokens; ~50 input tokens and 16 output tokens
per rate probe): about 10.4k neurons from the structured-output calls, about 1.8k from the rate
probes, and about 0.9k from the one 4096-token diagnostic call, roughly 13.1k total. That is the
same order of magnitude as the dashboard's 15.52k and is consistent with a single burst on one
model; it is an estimate from token-count assumptions, not a reconciliation against a per-call log,
so it is not exact.

**Retries: none from application code, but the classifier amplified real quota errors.** The spike
driver itself (`scripts/spikes-driver.ts`) has no retry or backoff around its `fetch` calls, so the
burst above reflects calls actually issued, not retries of a smaller number. Separately, and this is
the actual bug found: `src/model/workers-ai.ts`'s `classifyError` (before this investigation's fix)
mapped Workers AI's `3036` (daily allocation used up) to the same `"rate-limited"` kind as `3040`
(transient, out of capacity) and HTTP `429`. The Workflow's `modelCall` step-retry policy (2
retries, 5 s exponential backoff) then retried a `3036` exactly like a transient failure, which
cannot help: the daily allocation does not refill on a step's retry timescale. This did not cause
the Sep 25 burst itself (that was live spike-driver traffic, not Workflow retries), but it meant any
production investigation that started after the quota was hit would have compounded the damage.

**Worst-case model calls per investigation.** The Workflow calls the model at four points:
`classify-symptom`, `hypothesize`, `draft-rule-attempt-{1..3}` (`MAX_DRAFT_ATTEMPTS = 3`), and
`write-report`. Only the draft-rule step throws on a non-ok response
(`requireOkResponse`, `src/model/client.ts`); classify/hypothesize/write-report degrade gracefully on
any non-ok response and do not retry. The draft step's `modelCall` retry policy allows up to 3
physical attempts per logical call (1 initial + 2 retries). So:

- Normal case (first draft attempt succeeds, no transport errors): 4 physical model calls
  (classify + hypothesize + 1 draft + report).
- Worst case (all 3 draft attempts needed, and every one of them hits a retryable failure that
  exhausts its step's retry budget): 1 (classify) + 1 (hypothesize) + 3 attempts x 3 physical calls
  each (9) + 1 (report) = 14 physical model calls per investigation.
  (An earlier estimate in this investigation, before checking `agent.ts`, assumed
  classify/hypothesize/write-report also retried on a bad response and arrived at 18; they do not,
  since they never throw, so 14 is the corrected figure.) With the fix in this branch, a
  `quota-exhausted` (3036/4006) draft response is never retried at all: it fails the incident on the
  first attempt instead of consuming the retry budget.

**Exact error codes and messages found in this repo's records, quoted:**

- `docs/spikes.md` (pre-existing, spike 0.1): "error `3036` means the daily neuron allocation is used
  up and `3040` means out of capacity."
- `docs/eval-results/README.md`: a direct probe of the deployed spikes Worker's `/model/probe`
  returned `"4006: you have used up your daily free allocation of 10,000 neurons"`.
- `docs/spikes.md` (pre-existing, spike 0.4 fallback 2 write-up): "the account started returning
  error `3036`/`4006` ('used up your daily free allocation') partway through verification."

No occurrence of Workers AI's documented `"JSON Mode couldn't be met"` error was found anywhere in
this repo's records; every 0.4 failure was a schema/shape failure on ordinarily-returned text, not
that error.

**What this means for the "exhausted since Phase 0" claim.** README.md, DESIGN.md, PLAN.md,
EXPLAINER.md, PROMPTS.md and `docs/eval-results/README.md` all state, in present tense, that the
account's daily neuron quota "has been exhausted since Phase 0" or "is currently exhausted." Those
statements were accurate on 2026-09-25, the day they were written, but a Workers AI daily allocation
resets daily; nothing in this repo's records shows anyone re-attempted a real-model call on any day
since. The accurate statement is that the quota was exhausted on 2026-09-25 by the spikes above, and
spike 0.4's fallback 2 (the type-split schema) has not been re-measured since; that is a "not yet
attempted again" situation, not a standing "still exhausted" one. Those documents have not been
rewritten as part of this entry; this is a note that they are due for a pass, not a fix.

**Update 2026-09-28.** The documentation pass has now been done: README.md, DESIGN.md, PLAN.md,
PROMPTS.md and `docs/eval-results/README.md` state the dated fact (used up on 2026-09-25 by this
burst, resets daily) instead of a standing "still exhausted". EXPLAINER.md was deleted rather than
corrected. Fallback 2 was measured on 2026-09-27 by the deployed site's first real investigation
and failed; see `docs/reviews/2026-09-27-first-real-model-run.md`.
