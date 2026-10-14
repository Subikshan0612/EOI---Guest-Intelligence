# Learning L1.5b - `learning-v2` contract correction review

Status: DESIGN REVIEW ONLY. It corrects section 5 (comparison algorithm) and parts of sections 3 and 6 of `LEARNING_L1_5B_V2_DESIGN_REVIEW.md` in response to the defect found by
`LEARNING_L1_5B_V2_COVERAGE_MEASUREMENT.md`. Nothing is implemented. Production Learning stays OFF. No production source, test, `.env`, flag, database, frozen artifact or deployment configuration was changed; no database
was accessed; no Gemini call was made; nothing was committed or pushed. The only computation was offline arithmetic (interval formulas on the example counts below).

---------------------------------------------------------------------------------------------------------------------------------------------------------------------

## 1. Executive verdict

**CONDITIONAL GO for the corrected DESIGN. NO-GO for implementation today.**

- The corrected comparison rule (section 3) fixes the defect, keeps the validated L1.5b successful-alternative situation deliverable with a comfortable margin, and is more conservative than the old rule where evidence is weak.
- Implementation stays blocked by the coverage result: the real corpus holds 3 completed cases and 0 comparisons. The corrected rule does not change that (on the real data it would also find 0). Proceeding requires either the coverage targets of section 9 on real data or a separately approved, clearly dark, synthetic-only build.
- Before any implementation the coverage measurement script must be re-run under the corrected rule (read-only, new frozen hash) so the two documents agree.

---------------------------------------------------------------------------------------------------------------------------------------------------------------------

## 2. Diagnosis of the defect

The old rule: reference = the most frequent action; a frequency tie means no comparison; alternative = the best other action; STRONG only if the 95% Wilson intervals do not overlap.

1. **Frequency is the wrong organising idea.** The reference was meant to be "what the workspace usually does", on the assumption that this is what the model would default to. But the model's default is its own strong prior (dispatch in 100% of the L1.5b baseline runs), not the workspace's habit. Case counts per action reflect how often an action was *chosen and completed*, not what the model will lean towards.
2. **It breaks on the validated condition.** L1.5b C has 5 dispatch cases and 5 inspection cases: a frequency tie. L1.5b D also has 5 and 5. Every condition validated by the probe has equal counts, so the exact rule would have suppressed all of them. The rule was never tested against its own motivating example.
3. **It is discontinuous.** 6 dispatch vs 5 inspection cases would pass; 5 vs 6 would flip the roles. A one-case change should not change which action is "the reference".
4. **Non-overlap of two 95% intervals is brittle at these sample sizes.** Computed offline: L1.5b C passes with a gap of only 0.03 between the interval ends. One-case perturbations of C (dispatch 0/1/4 vs inspection 4/1/0, or dispatch 0/2/3 vs inspection 5/0/0) fail non-overlap (gaps -0.07 and -0.06) although the contrast is plainly large. Non-overlap of two separate intervals is also a known conservative stand-in for a test of the *difference*. The rule suppresses a validated situation by an accident of one case.

The correction therefore replaces the reference concept and the interval test (section 3). It does not tune a threshold to reproduce L1.5b: C is not a design target, it is the regression fixture (section 7).

---------------------------------------------------------------------------------------------------------------------------------------------------------------------

## 3. Review question 1 - what determines the two rows (options compared)

Setting: after the production L1.2 selection and the safety / guidance / facet gates (unchanged), the similar determined cases are grouped by action type. Each action row has `s` success, `p` partial, `f` failed determined outcomes (blocked and unknown excluded), `n = s + p + f`, quality `q = (s + w*p) / n` with partial weight `w`.

| | A. Frequency rule (current) | B. Quality-first: lowest-quality vs highest-quality action | C. Pairwise, independent of frequency | D. **Recommended**: C refined (difference interval, effect size, weight-robustness, multiplicity) |
|---|---|---|---|---|
| mathematics | reference = argmax n; test = Wilson non-overlap vs the best other row | take the extreme rows by `q`, test them | test every pair of floor-qualifying rows | test every pair; a pair is CLEAR only if the lower bound of the *difference* of quality exceeds a margin, the difference is material, and the verdict holds for three partial weights |
| effect on L1.5b C (5 vs 5) | **TIE, suppressed** (the defect) | CLEAR | CLEAR | **CLEAR** (difference lower bound 0.24 to 0.33 across weights) |
| mixed outcomes | depends on the reference accident | extremes can look separated by chance | intervals decide | omitted unless the difference is clear under every weight |
| unequal sample sizes | role flips with counts (6 vs 5 / 5 vs 6) | fine, but picks extremes | handled by the intervals | handled by the intervals; the floor stops anecdote rows |
| safety | none in itself; the safety gate precedes it | none in itself | none in itself | none in itself; the safety gate precedes it |
| risk of becoming an instruction | the label "reference" suggests "what to keep doing" | "best / worst" invites "choose the best" | neutral | neutral: two rows described by their outcomes, no role label (section 4) |
| selection bias | low | **high**: extremes of up to five actions (winner's curse) | rises with the number of pairs | controlled: significance level adjusted to the number of pairs |
| interpretability | high, but the rule is arbitrary | high, but "best / worst" language | moderate | moderate: "these two actions had clearly different outcomes in similar completed cases" |
| complexity | low | low | moderate | moderate (about 40 lines of pure code) |

**Recommendation: D.** The comparison asks "is there a sufficiently supported contrast between two actions in similar completed cases?", not "which action is best". Frequency is removed from qualification altogether.

### The recommended deterministic procedure (replaces section 5 of the previous review)

1. Rows: group the selected similar cases (L1.2 HIGH and MEDIUM, unchanged) by `actionType`; count determined outcomes.
2. **Floor:** keep rows with `n >= 4` determined cases (section 5 below). If fewer than two rows remain: omit (`INSUFFICIENT_SAMPLE` if rows existed, `NO_ALTERNATIVE` if one action only).
3. **Pairs:** let `k` be the number of rows and `m = k(k-1)/2`. Use a significance level adjusted for `m`: two-sided 95% divided by `m` (z = 1.960 for m = 1, 2.394 for 3, 2.638 for 6, 2.807 for 10; at most 5 action types exist so m <= 10).
4. For each pair and each **partial weight `w` in {0.25, 0.5, 0.75}**: let `q_hi` and `q_lo` be the higher and lower quality, `d = q_hi - q_lo`, and `L` the lower bound of the Newcombe-Wilson (hybrid score) interval for `d`: `L = d - sqrt((q_hi - wilsonLo(q_hi))^2 + (wilsonHi(q_lo) - q_lo)^2)`. The pair is CLEAR at `w` if `d >= 0.30` (material difference) and `L >= 0.10` (the difference is supported with a margin). The pair is CLEAR only if it is CLEAR at all three weights AND the same action is the higher-quality one at all three.
5. If no pair is CLEAR: omit (`NO_SEPARATION`, or `EQUAL_OUTCOMES` when every pair has `d = 0`).
6. If several pairs are CLEAR: take the pair with the largest `L` at `w = 0.5`. If a different pair is within 0.05 of it: omit (`AMBIGUOUS`), because the server will not choose arbitrarily between contrasts.
7. Deliver the chosen pair, two rows.

Why each part exists: the *difference interval* tests the thing we care about (is the gap real) instead of comparing two intervals; the *effect size* `d >= 0.30` stops a statistically detectable but operationally small gap from being shown; the *margin* `L >= 0.10` keeps pairs that barely pass from being shown; the *weight robustness* removes the dependence on the arbitrary 0.5 weight for partial outcomes (a contrast that exists only because of how partial is valued is not delivered); the *multiplicity adjustment* prevents "pick the best pair of five" from inflating false contrasts. All constants are server-side configuration, versioned (`comparisonVersion` in the audit record), documented as starting values to be calibrated by the post-implementation experiment, never client-controllable and never shown to the model.

### Worked examples (offline arithmetic; floor 4, z = 1.96, margin 0.10, effect 0.30)

| Situation (success / partial / failed) | Old rule | Corrected rule (d; L at w = 0.25 / 0.5 / 0.75) |
|---|---|---|
| **L1.5b C**: dispatch 0/1/4, inspection 5/0/0 (5 vs 5) | TIE, suppressed | **CLEAR** (d 0.95 / 0.90 / 0.85; L 0.33 / 0.28 / 0.24) |
| **L1.5b D**: dispatch 2/1/2, inspection 4/1/0 | omitted (tie) | omit (d 0.40; L -0.16 / -0.15 / -0.13) |
| 4 vs 4 all-failed / all-success | passes by 0.02 | CLEAR (d 1.00, L 0.31) |
| 4 vs 10 (all-failed 4, all-success 10) | CLEAR | CLEAR (L 0.44) |
| 4 vs 20 (either direction) | CLEAR | CLEAR (L 0.48) |
| 3 vs 20 (all-failed vs all-success) | floor | omit (floor); the interval alone would pass |
| 5 vs 5 all-failed / all-success | CLEAR | CLEAR (L 0.39) |
| partial-heavy 5 vs 5 (0/5/0 vs 5/0/0) | omit | omit (verdict flips with the partial weight) |
| partial-heavy 10 vs 10 (0/10/0 vs 10/0/0) | omit | omit (d falls to 0.25 at w = 0.75) |
| mixed 10 vs 10 (3/2/5 vs 8/2/0) | omit | omit (L 0.07 to 0.10) |
| 8 vs 8 (2/1/5 vs 6/1/1) | omit | omit (L 0.02) |
| equal outcomes (3/1/1 both) | omit | omit (`EQUAL_OUTCOMES`) |
| C perturbed: dispatch 0/1/4, inspection 4/1/0 | omit (gap -0.07) | CLEAR (L 0.18) |
| C perturbed: dispatch 0/2/3, inspection 5/0/0 | omit (gap -0.06) | CLEAR (L 0.11 to 0.28) |
| C perturbed: dispatch 1/1/3, inspection 5/0/0 | omit | omit (verdict fails at w = 0.75) |
| larger corpus: 4/3/10 vs 14/3/3 (17 vs 20) | omit | CLEAR (L 0.13) |

The corrected rule is stricter where evidence is weak or depends on the partial weight, and more stable where the contrast is large.

---------------------------------------------------------------------------------------------------------------------------------------------------------------------

## 4. Review question 2 - the contract represents a contrast, not a "best action"

The goal is: **identify a sufficiently supported historical contrast that may inform the current recommendation**. It is not "find the best historical action". Consequences:

- The payload names the evidence `HISTORICAL_OUTCOME_CONTRAST`. No field or prompt text uses "preferred", "recommended", "best", "choose" or "reference".
- It carries outcome counts and rates for two actions and a fixed constant `separation: "CLEAR"`. It carries no role labels: the two rows appear in a fixed, neutral order (alphabetical by action type), which is also the order the L1.5b probe used. The higher-outcome row is therefore not singled out by position or by a field; the numbers carry the information.
- Direction, strength tiers and a `lower` / `higher` label are NOT included in v2.0. They add instruction-like framing, were not part of the validated probe shape, and `strength` has only one possible value while MODERATE is disabled. (If a tier is ever enabled it is added in a new minor version with its own experiment.)

Proposed v2.0 payload (probe-shape parity plus two constants; counts are over the two compared rows only):

```jsonc
learning: {
  "learningVersion": "learning-v2",
  "evidenceType": "HISTORICAL_OUTCOME_CONTRAST",
  "basis": { "equipment": "air_conditioner", "problemFamily": "temperature_fault", "condition": "not_cooling" },
  "similarCaseCount": 10, "determinedCaseCount": 10, "minimumCases": 4,
  "relevance": { "high": 10, "medium": 0 },
  "sufficientEvidence": true,
  "outcomeDistribution": { "success": 5, "partial": 1, "failed": 4, "blocked": 0, "unknown": 0 },
  "pattern": "MIXED", "outcomeConsistency": "LOW",
  "actions": [
    { "actionType": "inspection",           "caseCount": 5, "determined": 5, "successRate": 1.0, "outcomes": { "success": 5, "partial": 0, "failed": 0 } },
    { "actionType": "maintenance_dispatch", "caseCount": 5, "determined": 5, "successRate": 0.0, "outcomes": { "success": 0, "partial": 1, "failed": 4 } }
  ],
  "contrast": { "separation": "CLEAR" }
}
```

Differences from the previous review's draft: `reference` / `alternative` / `comparison.direction` / `comparison.strength` removed in favour of the validated unlabelled `actions[2]` plus `contrast.separation`; `coverage` folded back into the probe's counts. `pattern` and `outcomeConsistency` are kept only for parity with the validated probe and are candidates for removal in the ablation arm. The row-order and no-role-label choices are *not* proven safe by the probe (it always listed inspection first); the post-implementation experiment includes an order-swapped arm.

What the contract must never contain (unchanged): any id, workspace or tenant marker, guest / stay / room identity, timestamp, historical text, notes, model-generated prose, per-case rows, blocked / unknown counts, `riskLevel` / `urgency` of past actions, relevance scores, or any threshold.

**Interpretive limit stated in the prompt:** the evidence is observational. Actions were chosen by people for reasons that are not recorded, and only completed, person-recorded outcomes exist, so the difference may reflect which situations received which action. The prompt says the evidence "may inform" and must never say or imply that one action causes better outcomes.

---------------------------------------------------------------------------------------------------------------------------------------------------------------------

## 5. Review question 3 - the minimum sample rule

**Keep at least 4 determined cases for every compared action, on both sides, unchanged. Do not lower it, and do not raise it now.**

Why keep it:
- Statistics alone would admit a 3-case row (3 vs 20 all-failed / all-success has a clear interval gap). A row of three completed cases is an anecdote: one mis-recorded outcome changes it, and person-recorded outcomes are the only source.
- It keeps the existing L1 philosophy (`MINIMUM_CASES = 3` is the floor for *any* case-based observation; a comparison needs more because it compares two rows).
- It rarely binds on its own: with the corrected test, a symmetric all-failed vs all-success contrast needs 4 vs 4 (difference lower bound 0.31); anything less perfect needs more cases, so the floor mainly blocks degenerate tiny rows.

Why not raise it: 4 vs 4 all-failed / all-success qualifies by a modest but real margin under the corrected rule (L 0.31), and the margin / effect-size rules already refuse weaker pairs. Raising to 5 would only remove the 4 vs 4 and 4 vs 20 cases that the data support. It stays a named constant; the experiment may recommend 5 if the 4-case rows look unstable.

Behaviour on the requested shapes:

| Shape | Result | Reason |
|---|---|---|
| 4 vs 4 (0/0/4 vs 4/0/0) | CLEAR | L 0.31, d 1.00 |
| 4 vs 10 | CLEAR | L 0.44 |
| 5 vs 5 (L1.5b C) | CLEAR | L 0.24 to 0.33 |
| 4 vs 20 | CLEAR | L 0.48; the interval accounts for the imbalance |
| 3 vs 20 | omit | floor: a 3-case row |
| partial-heavy (0/5/0 vs 5/0/0, 0/10/0 vs 10/0/0) | omit | the verdict depends on the partial weight |
| all-failed vs all-successful | CLEAR from 4 vs 4 | d 1.00 |

This optimises for trustworthy evidence, not coverage.

---------------------------------------------------------------------------------------------------------------------------------------------------------------------

## 6. Review question 4 - deterministic behaviour

"Omit" means the AI-service request is byte-identical to Learning OFF and an audit reason code is recorded. Gates run in the order of the previous review (flag, workspace, safety, guidance, facets, similar cases) and are unchanged except for the comparison step.

| # | Situation | Behaviour | Reason | Note |
|---|---|---|---|---|
| 1 | equal action frequencies | no effect on qualification | n/a | frequency is not used; L1.5b C (5 vs 5) is delivered |
| 2 | equal outcome quality | omit | `EQUAL_OUTCOMES` | d = 0 for every pair |
| 3 | materially separated outcomes | deliver | `DELIVERED` | d >= 0.30 and L >= 0.10 at every partial weight, floors met |
| 4 | mixed outcomes | omit | `NO_SEPARATION` | overlapping or weight-dependent contrasts are never delivered; MODERATE stays disabled |
| 5 | one action with too few cases | that row is dropped; omit if fewer than two rows remain | `INSUFFICIENT_SAMPLE` | the floor applies to every row |
| 6 | negative-only evidence (one action, poor outcomes) | omit | `NO_ALTERNATIVE` | L1.5b B: 0 of 12 changed; inert |
| 7 | positive-only evidence (one action, good outcomes) | omit | `NO_ALTERNATIVE` | no contrast; an untested reinforcement tier |
| 8 | blocked / unknown outcomes | excluded from `n` and `q`, never delivered; they can only reduce `n` toward the floor | n/a | they say nothing about whether an approach works |
| 9 | safety mismatch / any non-NORMAL safety state, critical severity, refused access, `safety_hazard` / `electrical_fault` family | omit | `SAFETY_INELIGIBLE` | existing `deriveSafetyPolicy`, then the L1.2 safety gates; unchanged |
| 10 | facet mismatch, UNKNOWN or AMBIGUOUS facets, legacy Signal without an issue | omit | `NO_SIMILAR_CASES` / `FACETS_UNKNOWN` | L1.2 gates and the trusted-issue check; unchanged |
| 11 | relevant authoritative business guidance present | omit | `GUIDANCE_PRESENT` | precedence is untested; Learning is a fallback for the RAG-miss case in v2.0 |
| 12 | two or more CLEAR pairs within 0.05 of each other | omit | `AMBIGUOUS` | the server does not choose arbitrarily |
| 13 | one CLEAR pair clearly ahead of the others | deliver that pair only | `DELIVERED` | at most two rows |
| 14 | the higher-outcome action is also the more frequent one (a "status-quo" contrast) | deliver | `DELIVERED` | NOT validated by L1.5b (all probe conditions had equal counts); the experiment carries a dedicated arm and the rule gets an eligibility constraint if harm appears |
| 15 | malformed v2 object | omit | `MALFORMED` | never sent; Intelligence proceeds |

---------------------------------------------------------------------------------------------------------------------------------------------------------------------

## 7. L1.5b regression fixtures (deterministic, pure-function tests)

The corrected rule must pass these fixtures. They are listed as design requirements; none is written here.

| Fixture | Input rows (s/p/f) | Expected |
|---|---|---|
| **FX-C (the validated L1.5b successful alternative)** | AC / temperature_fault / not_cooling; `maintenance_dispatch` 0/1/4 (5), `inspection` 5/0/0 (5); safety NORMAL, no rules, no guidance | **DELIVER**. Equal frequencies (5 and 5) must NOT suppress it. `actions` alphabetical (`inspection`, `maintenance_dispatch`); `successRate` 1.0 / 0.0; contrast CLEAR; difference lower bound >= 0.24 at every weight |
| FX-C-swap | same counts with the action types exchanged | DELIVER; the output is independent of which action has which name |
| FX-C-count-order | dispatch 6 cases and inspection 5, then dispatch 5 and inspection 6 | DELIVER in both; the result must be identical under the exchange of counts |
| FX-D (L1.5b mixed) | dispatch 2/1/2, inspection 4/1/0 | OMIT (`NO_SEPARATION`) |
| FX-B (L1.5b negative-only) | dispatch 0/1/4 only | OMIT (`NO_ALTERNATIVE`) |
| FX-eq | both actions 3/1/1 | OMIT (`EQUAL_OUTCOMES`) |
| FX-4v4 | 0/0/4 vs 4/0/0 | DELIVER |
| FX-3v20 | 0/0/3 vs 20/0/0 | OMIT (`INSUFFICIENT_SAMPLE`) |
| FX-partial | 0/5/0 vs 5/0/0 and 0/10/0 vs 10/0/0 | OMIT |
| FX-perturb | dispatch 0/1/4 vs inspection 4/1/0; dispatch 0/2/3 vs inspection 5/0/0 | DELIVER; dispatch 1/1/3 vs inspection 5/0/0 OMIT |
| FX-3actions | three floor-qualifying rows (two strong contrasts of similar size) | OMIT (`AMBIGUOUS`); with one clearly larger contrast DELIVER that pair; the adjusted z for m = 3 is 2.394 |
| FX-blocked | the same rows plus large blocked / unknown counts | identical result to the same rows without them |
| FX-safety / FX-access | FX-C facts with a gas, smoke, critical or refused-access current Signal | OMIT (`SAFETY_INELIGIBLE`) |
| FX-guidance | FX-C facts with relevant retrieved guidance | OMIT (`GUIDANCE_PRESENT`) |
| FX-determinism | any fixture run twice, rows presented in two orders | identical output |

---------------------------------------------------------------------------------------------------------------------------------------------------------------------

## 8. Review question 5 - what the probe supports (and does not)

Evidence used (L1.5b, one scenario, one model, 12 runs per arm, detector-scored):
- negative-only (B): 0 of 12 changed their action; 9 never referred to the history.
- successful alternative (C): 9 of 12 chose `inspection` (8 of 12 on a wording-only reading); 70% of the changed runs explained why.
- mixed comparative (D): 8 of 12 chose `inspection`, generally with hedged wording, no overclaim detected.
- unrelated: 0 of 8 contaminated; safety: 8 of 8 kept immediate escalation.

What this means for the v2 contract:
1. **Deliver a contrast, not a count.** Negative-only evidence is inert, so a contract that can carry only failures adds risk without benefit. This is already built into the rule (rows below two are omitted).
2. **The model does not scale its response to the strength of the evidence.** It moved at nearly the same rate for the strong contrast (9 of 12) and the mixed one (8 of 12), and confidence stayed flat under the production ceiling. The model therefore cannot be relied on to discount mixed evidence by itself; the **server-side threshold is the control**. That is why the corrected rule is strict about separation and why the mixed condition (D) is omitted rather than delivered with a "be careful" label. The probe shows that mixed evidence was *used*, not that using it was *appropriate*.
3. **Do not overgeneralise.** One scenario (an AC fault), one action pair (dispatch vs inspection), one model, one prompt wording, equal action counts in every condition, detectors that are text heuristics, and a wording-only effect of 67% (type-or-wording 83%). The probe does not show effects for other action pairs, for unequal frequencies, for a status-quo contrast, for three or more actions, with relevant guidance present, or with different row order.
4. **Causal language stays out.** The contrast is observational (section 4).

---------------------------------------------------------------------------------------------------------------------------------------------------------------------

## 9. L1.3 to completed-case lifecycle (verified by code inspection only)

Question: does the L1.3 `Signal.issue` survive Signal -> Intelligence -> Decision -> Action -> Outcome -> completed case, so that future naturally completed cases supply coverage?

| Stage | Finding (file, function) |
|---|---|
| New Signal stores the server-derived issue | `services/signalService.js` `createSignal` builds the stored object from named fields and sets `issue: extractStructuredIssue(...)`; the conversational intake path (`services/signalIntakeService.js` `processIntakeTurn`) calls the same `createSignal`. There is no other creator of a Signal in `src` |
| Intelligence does not alter it | `services/intelligenceService.js` and `services/intelligenceAnalysisService.js` import the Signal model only to READ (`findInWorkspaceOr404(Signal, ...)`); no `Signal.` write exists in either file |
| Decision does not alter it | `services/decisionService.js` imports Signal only to read the parent Signal; no write. Decisions snapshot recommendation text, not the issue |
| Action does not alter it | `services/actionService.js` does not import the Signal model |
| Outcome does not alter it | `services/outcomeService.js` does not import the Signal model |
| Nothing reparses or replaces it | the extractor is called from exactly two places, `signalService.createSignal` and `signalService.updateSignal`; a grep of `src` for `extractStructuredIssue`, `extractIssueFacets`, `extractFacets`, `facetsOfIssue`, `isTrustedIssue` finds no other caller. `Signal.issue` is not in the updatable list; the schema enforces the closed vocabulary and `source` |
| Completed-case derivation reads the persisted issue | `services/learning/completedCaseService.js` `loadCompletedCases` fetches the full Signal (`Signal.find({ workspaceId, _id: { $in } }).lean()`), and `services/learning/completedCase.js` `profileOfSignal` takes the facets from `facetsOfIssue(signal.issue)` (trusted records only; a legacy or tampered issue gives UNKNOWN facets, never a re-parse) |

**Verdict: the lifecycle is sound. No lifecycle defect found.** Future naturally completed cases will carry the issue captured at intake.

Documented nuances (behaviours to know about, not defects; none was changed):
1. **Editing the words re-derives the issue.** `updateSignal` re-derives when the title, description or severity changes, so the facets of an already-completed case can change if its Signal is edited later, and there is no audit trail of the facet change.
2. **An edit after analysis can drop the case.** A changed severity or wording can make the recomputed safety state differ from the Intelligence's stored one, so `normalizeCompletedCase` rejects the chain (`SAFETY_INCONSISTENT`) and the loader counts it as rejected rather than as a completed case.
3. **Legacy Signals never gain an issue** unless their words are edited; they stay UNKNOWN (2 of the 3 real completed cases).
4. **The loader considers only the 500 most recent Outcomes** (`MAX_COMPLETED_CASES`), a development-oriented bound.
5. **The real coverage lever is intake wording, not the lifecycle.** The extractor never invents a device: "Room 204 is not cooling" yields an UNKNOWN equipment, and only cases with a KNOWN equipment and problem can ever take part. Coverage grows with reports that name the device.

---------------------------------------------------------------------------------------------------------------------------------------------------------------------

## 10. Coverage strategy (no synthetic production data)

Not a single percentage. A future real-data replay or experiment is "sufficiently supported" when ALL hold for the SAME frozen measurement run (re-run under the corrected rule, read-only):

| Dimension | Conservative target |
|---|---|
| independent comparative situations (distinct workspace + facet triple + action pair) that DELIVER | >= 5 |
| distinct action pairs among them | >= 3 |
| workspaces represented | >= 2, or one workspace with >= 5 situations if the pilot is single-tenant (reported as a limitation) |
| cases per delivered contrast | both rows >= 6 determined (above the floor of 4) in at least 3 of the situations |
| outcome diversity | at least 2 different higher-outcome actions; at least 1 situation where the contrast is large but the higher-outcome action is also the more frequent (status-quo), and at least 2 situations that do NOT qualify (mixed or equal) so restraint can be tested on real data |
| corpus usability | >= 40 completed cases with trusted issues, and >= 50% of completed cases with known equipment and problem |
| eligibility | the delivered situations are NORMAL-safety, no refused access, no guidance present |

Until then the experiment relies on synthetic, clearly labelled, throwaway-database cases (as in L1.4), and real replay is used only to report the would-deliver rate. Do not manufacture cases to reach the targets; do not enable Learning to "collect" data (it needs none: completed cases accumulate from normal use). Re-running the frozen read-only measurement monthly (with the script updated to the corrected rule and re-hashed) gives the trend. No timeline is promised: it depends on volume and on how often reports name the device.

---------------------------------------------------------------------------------------------------------------------------------------------------------------------

## 11. Risks and unresolved questions

- **Constants are judgement calls:** effect size 0.30, margin 0.10, floor 4, the three partial weights, the 0.05 ambiguity band and the multiplicity adjustment. They are calibrated on one probe and one analytic argument, not on data.
- **Selection bias and confounding:** actions are chosen by people and only completed outcomes exist. A contrast can reflect easy versus hard cases. The prompt must stay non-causal, and no contract field may imply "works better".
- **Status-quo contrasts (item 14) are unvalidated,** as are unequal action counts, three-action cases, row order, the removal of role labels, and the dropped `strength` / `direction`. The experiment needs a dedicated arm for each.
- **The model does not discount weaker evidence** (D vs C): strictness is entirely server-side. If the thresholds are wrong, the model will not compensate.
- **Newcombe-Wilson at small n** is an approximation; an exact or Bayesian difference test could replace it with the same deterministic interface if the experiment shows brittleness.
- **Coverage may remain near zero for a long time;** the design may stay dark infrastructure. The corrected rule does not create comparisons that do not exist.
- **Edits after completion can change or drop a case** (section 9 notes 1 and 2); whether to freeze the issue at completion is an open lifecycle question, not a defect fixed here.
- **The coverage script is frozen under the old rule;** its result (0) stands, but a re-measurement under the corrected rule is required before implementation planning.
- **The previous design review is superseded in section 5 and in the draft payload of section 3;** the other sections (safety eligibility, guidance suppression, flag and source setting, audit metadata, tenancy, test matrix, post-implementation experiment) are unchanged except that the test matrix gains the fixtures of section 7 and the experiment gains the arms listed above (status-quo, order-swapped, parity ablation).

---------------------------------------------------------------------------------------------------------------------------------------------------------------------

## 12. Confirmations

- Production Learning remains OFF; no flag or default was touched.
- No production source, test, `.env`, secret, frozen artifact, `.claude/` or `CLAUDE.md` was modified.
- No database was accessed or modified; no synthetic production case was created.
- No Gemini or other model call was made.
- Nothing was committed or pushed.
