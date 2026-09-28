# Eval results

`npm run eval` runs every scenario in `src/core/scenarios.ts` through the same pipeline
production uses (aggregate, baseline, draft with retries, replay, and the Phase 4 narrative
steps), plus the four ablations from `DESIGN.md` section 9, and writes a JSON report.

- `npm run eval` (no flags) runs against the fake model (`src/model/fake.ts`). No credentials
  needed.
- `npm run eval -- --real` runs against Workers AI, via the deployed spikes Worker's
  `POST /model/run` (Node cannot reach the `AI` binding directly; see `docs/spikes.md`).

Both modes go through `src/eval/cache.ts`, a response cache keyed by hash of
`(scenario, prompt, model)`. Only `kind: "ok"` responses are cached; a rate-limit or transient
error is never cached, so a later run can retry it instead of replaying a stale failure forever.
Re-running with a warm cache reproduces the same output byte-for-byte: confirmed by running
`npm run eval` twice in a row and diffing the two `docs/eval-results/fake.json` outputs (no
differences, second run: 80/80 cache hits, 0 misses).

## `fake.json`

Committed. Generated deterministically by `npm run eval` against `cannedModel()`.

This run proves the harness, the four ablations, and the reporting code all execute correctly
end to end. **It is not evaluation signal about the model.** `cannedModel()` returns one fixed
rule regardless of the scenario or traffic summary it is given, so `modelSafetyScore`,
`schemaValidFirstAttempt`, and the rest of the metrics in this file measure "does the fake model
always emit valid, well-formed JSON" (yes, by construction), not "can a real model draft a good
rule." Treat every number in `fake.json` as a harness self-test, not a measured result.

## `real.json`

Not present. When this section was first written, on 2026-09-25, the account's daily Workers AI
free-tier neuron allocation (10,000/day) was used up, confirmed by a direct probe of the deployed
spikes Worker's `/model/probe` endpoint (`4006: you have used up your daily free allocation of
10,000 neurons`). That was a single burst from the Phase 0 spikes. The allocation resets daily, and
the dashboard showed 0 of 10,000 used on 2026-09-27 (`docs/spikes.md`, "investigating the Sep 25
neuron burst"). `--real` has simply not been run since.

The `--real` code path itself has been smoke-tested end to end against the live binding (it
correctly reaches the model, receives the quota error, and (after a cache-poisoning bug was
found and fixed) correctly declines to cache it). But no real-model metrics have been measured
by this harness, so none are reported here. Per `CLAUDE.md`, an unmeasured number is marked
UNVERIFIED or left out rather than reported; this file is left out until a real run is made.

To produce it:

```
npm run eval -- --real
```
