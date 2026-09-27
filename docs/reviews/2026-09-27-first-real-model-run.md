# Review: the first real-model investigation on the deployed site

This covers the first time the deployed site ran an investigation against the real model
(`@cf/meta/llama-3.3-70b-instruct-fp8-fast`, not the fake model tests use), what failed, why the
UI could not show why at first, the evidence once it could, the root cause, and the fix.

## What failed

All three of the draft-rule attempts failed with `E_SCHEMA_NOT_JSON`: the model's raw output was
not valid JSON. The retry loop (`MAX_DRAFT_ATTEMPTS = 3`) exhausted every attempt and the incident
ended `failed`, with no rule ever proposed to the operator.

## Why the UI could not show why, at first

The attempt history showed three failed attempts and the diagnostic code, but nothing about the
raw model output itself: no length, no token usage, nothing to say whether the model produced
almost-valid JSON that was slightly wrong, or ran off somewhere else entirely. `E_SCHEMA_NOT_JSON`
alone does not distinguish those.

This gap was closed the same day, before this investigation, by PR #5 (`Make failed draft attempts
diagnosable`): each attempt now stores `completionTokens`, `maxTokens`, and whether the completion
was cut off at the token limit (`hitMaxTokens`, computed in code as `completionTokens >=
maxTokens`, never model reported), plus a head-and-tail excerpt of the raw output
(`src/core/text-excerpt.ts`, rendered as plain text, never HTML). Without that PR, there would have
been nothing more to go on here than "it was not JSON."

## The evidence

With PR #5's diagnostics live, the attempt history showed, for all three attempts:

- `completionTokens: 1024`, `maxTokens: 1024`, `hitMaxTokens: true`. Every attempt used the full
  completion budget and was cut off mid-output, not returned early with a wrong answer.
- Raw output lengths of 2159, 2159, and 2161 characters, all reported as truncated.

The expanded raw-output excerpt showed the actual shape. The head of all three attempts was:

```
{"nodes": [{"id": 0, "kind": "and", "left": 1, "right": 2}, {"id": 1, "kind": "or", "left": 3, "right": 4},
{"id": 2, "kind": "or", "left": 5, "right": 6}, {"id": 3, "kind": "or", "left": 7, "right": 8},
{"id": 4, "kind": "or", "left": 9, "right": 10}, {"id": 5, "kind": "or", "left": 11, "right": 12},
{"id": 6, "kind": "or", "left": 13, "right": 14}, {"id": 7, "kind": "or", "left": 15, "right": 16 ...
```

and the tail (still mid-object when the token budget ran out) continued the same pattern up through
node ids in the 80s, still nothing but `and`/`or` nodes:

```
... {"id": 41, "kind": "or", "left": 83, "right": 84}, {"id": 42, "kind": "or", ...
```

Every node visible in either excerpt is a connective (`and` or `or`). None is a leaf condition
(`compareString`, `compareNumber`, `contains`, `inStrings`, `inNumbers`). The ids double at each
level (1&2, 3&4&5&6, 7 through 14, ...), which is a perfectly balanced binary tree of connectives,
consistent with the model recursing one level deeper each time rather than ever writing a
condition. Attempts 1 and 2 were byte-identical; attempt 3 differed by two characters, consistent
with the same behavior running two tokens further before the same 1024-token cutoff.

This is not "the model wrote a rule with a typo." It never got as far as writing a rule. It spent
its entire completion budget expanding connectives and never reached a single field, operator, or
value.

The exact byte sequence between the visible head and tail (1359 to 1361 characters, depending on
the attempt) was never captured: the UI's raw-output view only ever shows the first and last 400
characters, by design, and no fuller capture exists. `test/unit/rules/schema.test.ts`'s
"regression: the real truncated connective-explosion output" tests use the real head and real tail
bytes joined directly, with nothing invented for the missing middle, and document this limitation
in a comment. The test does not depend on the missing middle: any string with this shape (an
object opened but never closed) is truncated JSON either way, and `decodeModelOutput` must reject
it as `E_SCHEMA_NOT_JSON` regardless of exactly what filled the gap.

## Root cause

This is the same failure mode `docs/spikes.md`'s spike 0.4 first measured on 2026-09-25, against
an earlier version of the rule schema: a JSON-Schema-constrained recursive node list gives the
model a content-free escape valve. As long as `and`/`or` nodes remain valid against the schema, the
model can keep emitting them forever without ever being forced to commit to a real condition,
because nothing in the schema bounds how much of the node budget goes to connectives versus leaves.
`maxItems` caps the array, but by the time the model would hit that cap it has already run out of
the (smaller) token budget first.

Spike 0.4's own fallback 2, splitting leaf node kinds by value type (`compareString` /
`compareNumber`, `inStrings` / `inNumbers`, so no field in the schema has a `["string", "integer"]`
union type) was already implemented and shipped in `src/core/rules/schema.ts`, on the theory that
removing every union-typed field would remove whatever was pushing the model toward connectives.
It had never been measured against the real account before this investigation, only unit tested.
This investigation is that measurement, and the result is negative: fallback 2 narrows the schema
but does not close the escape valve. The pathology is not caused by the union type specifically. It
is caused by connectives being representable at all without a bound on how many of them can appear
before a leaf is required, which no schema fallback in this family removes, because JSON Schema has
no way to express "at least one of every N nodes must be a leaf."

## The fix

Stop asking the model for the AST as JSON at all. Ask for the rule as literal Rules-language text,
inside a flat `{"rule": "RULE TEXT"}` wrapper (`TEXT_RULE_JSON_SCHEMA`,
`src/core/narrative-schema.ts`), and parse that text with the real parser
(`src/core/rules/parser.ts`) instead of decoding a wire-format object.

Free text has no schema-level connective-only shape to run away into. Every token the model writes
is part of a field name, an operator, or a literal value; there is no way to write "more tree" for
its own sake. If the model runs out of tokens mid-rule under this route, the result is ordinary
truncated text, which the parser rejects as a normal syntax error (for example
`E_UNEXPECTED_EOF`), fed back to the model like any other diagnostic. That is a difference in kind
from `E_SCHEMA_NOT_JSON` on a document that was never going to reach a leaf condition no matter how
many tokens it was given.

This does not loosen validation. Truncated or malformed input is still rejected, just by a
different, more specific diagnostic:

- The outer JSON wrapper is still decoded and checked (missing property, wrong type, extra
  properties) before anything touches the parser, same as the AST route's own outer decode.
- The rule text itself goes through the same parser, type checker, printer, and round-trip
  assertion that operator-typed rules from the UI already go through
  (`checkRuleText`/`verifyAst` in `src/core/rules/pipeline.ts`), so no new grammar and no new
  decoder logic was written for the rule text itself.
- The round-trip property (CLAUDE.md invariant 13: a printer/parser disagreement is a bug, never
  retried) is unchanged. Only the step that produces the first `RuleAST` changed, from decoding a
  wire-format object to parsing text.

**Infrastructure that already existed, unused.** The prompt (`prompts/draft-rule-text.*.txt`), the
schema (`TEXT_RULE_JSON_SCHEMA`), the fake model's canned response for it, and an eval-harness
ablation (`runTextAblation`, Phase 5's "ablation 4") were all already built, on the assumption that
text output would be *compared against* a working AST route to measure its syntax-error rate. That
assumption is what this investigation falsified: the AST route does not work at all on this
account, so the comparison this ablation was built to make no longer applies. What changed in this
fix is wiring: the production Workflow's draft step (`src/server/workflow.ts`) and
`IncidentAgent.validateRuleVersion` (`src/server/agent.ts`) now call the text route
(`verifyModelDraftText`, a small new function in `src/core/rules/pipeline.ts` that decodes the
`{"rule": ...}` wrapper and then delegates to the existing `verifyAst` for everything else) instead
of the AST route (`verifyModelDraft`). No Workflow step was renamed or added; only the model call's
`purpose`, schema, and prompt template inside the existing `draft-rule-attempt-{i}` step changed.

**What did not change.** The AST route (`RULE_JSON_SCHEMA`, `decodeModelOutput`,
`verifyModelDraft`) is not deleted. It is still fully tested and still used by the eval harness's
primary (non-ablation) scenario runner, for side-by-side comparison against the route that now
ships. Reconciling which of the two the harness treats as "primary" is real, separate work
(tracked in `PLAN.md`), not folded into this fix.

One thing this investigation raised but did not resolve: the model was not asked for a rationale
alongside the rule, only the rule text itself (`{"rule": "..."}`, no `rationale` field). Adding one
would touch the prompt, the schema, the `RuleVersion` type, storage, and the UI, none of which the
connective-explosion bug requires fixing. It was left out of this change rather than folded in
without being asked for explicitly.

## Tests added

- `test/unit/rules/schema.test.ts`, "regression: the real truncated connective-explosion output
  (2026-09-27)": two tests asserting `decodeModelOutput` still correctly rejects the real captured
  attempt 1/2 and attempt 3 outputs as `E_SCHEMA_NOT_JSON`. This documents that the AST route's
  failure was real and reproducible; it is not a claim that the AST route is used in production
  going forward.
- `test/unit/rules/pipeline.test.ts`, `verifyModelDraftText`: a valid draft round-trips the same as
  the AST route; a non-JSON wrapper, a missing/mistyped/extra-property wrapper, a syntax error in
  the rule text, and a type error in the rule text each produce the expected outcome and diagnostic
  code, with no new diagnostic codes needed; and a test noting explicitly that the connective-only
  pathology has no equivalent failure mode under the text route, only an ordinary truncation.
- `test/integration/failure-injection.test.ts`'s quota-exhaustion test was updated to script the AI
  binding against `TEXT_RULE_JSON_SCHEMA` instead of `RULE_JSON_SCHEMA`, since that is what the
  real `draft-rule-attempt-1` step body now sends.

## Result

- `npm run typecheck`: clean.
- `npm run test:unit`: 232 tests passed, 18 files.
- `npm run test:integration`: 50 tests passed, 6 files.

Not yet done: confirming this fix against the real model on the deployed account. That costs
neurons and needs a separate go-ahead before spending them.
