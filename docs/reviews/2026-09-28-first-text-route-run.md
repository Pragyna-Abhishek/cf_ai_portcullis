# First real-model run after the rule-text fix

Recorded by the maintainer from the deployed site
(`https://portcullis.pragyna-portcullis.workers.dev`) after PR #6 (rule text instead of AST JSON)
was deployed. Source: three screenshots of one incident, `inc_4c592724`, taken while it was
`awaiting-approval`. The screenshots are not committed; every number below is transcribed from
them. The incident was not approved or rejected at the time of the screenshots.

**Sample size: one investigation, one scenario, one draft attempt.** This is not a rate.

## Setup

- Scenario: `l7-trap-carrier`, "Layer 7 flood against the homepage, sharing a carrier ASN with
  real users" (trap: shared ASN). Thresholds: attack blocked at least 90%, legitimate blocked at
  most 3% (`src/core/scenarios.ts`).
- Symptom typed: "the site is timing out for a lot of visitors and origin CPU is maxed out".
- Model: `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, UI status "live model".

## What happened

| Step | Result shown |
| --- | --- |
| classify-symptom | `l7-flood` (correct family) |
| hypothesize | Cites `ev_6`, `ev_4`, `ev_5`; all three exist in the evidence ledger |
| draft-rule-attempt-1 | Completed in 1.1 s |
| validate-rule-attempt-1 | `valid` on the first attempt, no retry |
| replay-rule-attempt-1 | attack blocked 865/2067, legitimate blocked 0/3933 |
| replay-naive-baseline | attack blocked 1955/2067, legitimate blocked 1636/3933 |

| Rule | Attack blocked | Legitimate blocked | Safety score | Thresholds |
| --- | --- | --- | --- | --- |
| Model: `http.request.uri.path eq "/" and lower(http.user_agent) contains "okhttp"` | 865 of 2067 (41.8%) | 0 of 3933 (0.0%) | 0.418 | Fails (attack too low) |
| Naive baseline: `ip.src.asnum eq 64500` | 1955 of 2067 (94.6%) | 1636 of 3933 (41.6%) | 0.552 | Fails (legitimate too high) |

The incident's running total read 124 neurons at this point (before the report step). That figure
is computed in code from token usage and the published rate; it has not been compared against the
Cloudflare dashboard.

## Reading it

- **The fix did what it was for.** The text route produced a syntactically valid, well-typed rule
  on the first attempt, where the AST route produced 0 of 3 on 2026-09-27.
- **The rule is safe but incomplete.** It blocked no legitimate traffic and avoided the trap (it did
  not block the shared ASN), but it caught only 865 of 2067 attack requests. The 503 slice
  (`ev_12`) shows other user agents besides `okhttp/4.9.3` (697 of 1670), such as
  `HeadlessChrome/99.0.4844.51` (499 of 1670), that the rule does not cover. It fails the scenario's 90% attack threshold, and the
  UI says so.
- **Possible prompt anchoring, unconfirmed.** The rule has the same shape as the one worked example
  in `prompts/draft-rule-text.system.txt` (path equals X and lowercased user agent contains
  "okhttp"). `okhttp/4.9.3` really is the top user agent in this scenario's 503 slice, so the choice
  is supported by the data; whether the example biased it cannot be told from one run.
- The operator would see both rules failing thresholds, with the numbers, and decide. Nothing is
  applied without approval.
