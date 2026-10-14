# Learning L1.4 - structured case-based Learning effectiveness validation

**Result: NOT EFFECTIVE.** Production Learning stays OFF. Nothing in production source was changed; no Learning observation reaches any production Intelligence request.

## Question

Does retrieving similar *completed* operational cases with the L1.2 structured similarity (over the L1.3 `Signal.issue`) materially improve the usefulness of the Intelligence for a new report, compared with the
same report analysed without any case-learning context? (Not a comparison with the old aggregate Learning, which Phase 53C already judged ineffective.)

## Design (frozen before the experiment run; hashes in `scripts/l14/out/freeze.sha256`)

- **Data.** 20 synthetic scenarios, each in its own workspace. Every completed case went through the application's own services (createSignal, which derives the L1.3 `Signal.issue`; stored analysis; approved Decision;
  approved Action; person-recorded Outcome). The facets of every seeded case were checked against the real extractor (a mismatch aborts before any model call). The target report is a Signal of the same workspace.
  Completed cases live in a separate archive property, so they are NOT in the target's ordinary history: the model cannot see them in any arm; only the case observation carries them.
- **Cases per scenario.** 5-10 SIMILAR cases (the class defines their outcome distribution) plus adversarial DECOYS the frozen L1.2 gates must exclude: a different device with the same problem, the same device with
  a different problem, the opposite condition (LOW = weak, never evidence), an UNKNOWN device, normal vs hazard state, refused vs free access.
- **Classes (as Phase 53C).** SUCCESS 4, PARTIAL 3, FAILED 4, BLOCKED 1, UNKNOWN 1, IRRELEVANT 2 (one is the cross-workspace case: the only matches are tenant X's), SAFETY 5 (gas, smoke, CO, sparks + burning smell - a
  policy-NORMAL gap with ADVERSARIAL low-protection cases - and gas + refused access). Tenant X holds perfect marker-tagged matches for every target.
- **Arms.** A: no Learning. B: the L1.2 observation (server-derived by the existing shadow path), delivered ONLY through the existing `learning-v1` shape (the AI service's contract is closed, so there is no other path),
  and only when the server found similar cases (otherwise B's request is identical to A). A2: a second independent no-Learning sample (the A/A noise control). RAG is isolated: no knowledge in any arm.
- **Pipeline per run.** Real operational context -> real AI service / Gemini -> the full production validator chain (`validateAndVerifyAnalysis`, with the Learning context in the evidence envelope for B) -> the production
  prose sanitizer -> the user-facing view. 20 scenarios x 3 repeats x 3 arms = 180 analyses, counterbalanced order; one analysis attempt per run except ONE re-attempt of a provider failure (HTTP 5xx / timeout).
- **Scoring.** The frozen Phase 53C rubric (rubric3 over rubric2) reused unmodified, with the 53C decision thresholds unchanged, plus a STRICTER credit rule (an improvement must also be explained in the prose from the supplied
  evidence), extra regressions (contradiction weaker, internal reference leak) and fidelity gates (tenant marker, closed shape, built from the server's observation).

## Results

| metric | value |
|---|---|
| scenarios x repeats x arms | 20 x 3 x 3 (180 analyses; 60 A-vs-B pairs, 55 valid) |
| successful analyses A / B / A2 | 57 / 58 / 58 |
| provider failures after the re-attempt (A / B / A2) | 0 / 0 / 1 (3 runs recovered on the re-attempt; Gemini returned 3x 503 and 1x 504 in total) |
| validator rejections A / B / A2 | 3 / 2 / 1 (all reviewed: prompt-contract or prose-guard, none a Learning leak) |
| beneficial / neutral / harmful (A vs B) | **0 / 49 / 6** (0% / 89% / 11%) |
| A/A control beneficial / neutral / harmful | 2% / 73% / 25% |
| structured change rate (action type, urgency or confidence differs) A/A vs A/B | 13% vs 15% |
| ... where Learning was actually attached | 10% (action type changed in 3 of 51 pairs; A/A: 4 of 55) |
| ... where nothing was attached (identical requests) | 75% (pure model noise) |
| informative classes (SUCCESS / PARTIAL / FAILED) improved | 0 of 31 valid pairs (A/A: 3%) |
| restraint classes misuse | 0% (A/A: 30%) |
| sufficient retrieval rate | 60% of scenarios (12 of 20); 18 of 20 retrieved at least one similar case |
| irrelevant retrieval rate | **0%** (0 of 95 retrieved cases); similar cases missed 0; safety-incompatible retrieved 0 |
| safety violations | no A-vs-B safety weakening; one B-only hard gate (L4-G2 repeat 3, see below); A/A control showed 3 hard events |
| contradiction violations | 0 (D5 100% in all arms) |
| unsupported policy / invented fact rate A / B / A2 | 2% / 2% / 3% |
| cross-workspace leakage | 0 requests, 0 prose, 0 gate runs |
| internal reference leakage (user-facing prose) | 0 (24-hex ids appeared in the validated prose before the production sanitizer in 26 / 24 / 23 runs of A / B / A2 and in 0 after it) |
| the model cited or acknowledged the case evidence in B | **0 of 58 runs** (no success / partial language; no aggregate citation) |

**Decision (mechanical, frozen rule): NOT EFFECTIVE.** Zero improved pairs, no excess over the noise control, and no scenario with two improved repeats.

## What the data say

1. **Retrieval works; the model does not use it.** The L1.2 matcher retrieved exactly the similar cases in every scenario and excluded every decoy (irrelevant retrieval 0%, hazard / normal never mixed, access-refused kept
   separate, tenant X never evaluated). But in arm B the model's action type was the same as arm A's in 48 of 51 attached pairs, never referred to the earlier outcomes, and never changed its answer in the direction the
   outcomes supported (for example, with 4 of 5 earlier "maintenance dispatch" cases failed, B still recommended a maintenance dispatch in all repeats of L4-F1 / F3 / F4).
2. **The only action-type changes were in hazard scenarios** (3 runs, maintenance dispatch -> escalation, the MORE protective option the policy allows). There the observation is deliberately ineligible and the correct behaviour is no
   change; the A/A control flips the action type about as often (4 of 55), so this is consistent with noise, but it is reported, not credited.
3. **No harm attributable to Learning.** The 6 harmful B pairs are the same kinds of events the A/A control shows more often (14 harmful A/A pairs): a lower guidance score in a no-guidance run (4 in B vs 8 in A/A), a failed approach not
   re-acknowledged (repeats failed approach: 2 vs 4), and one B-only fabricated-policy gate in L4-G2 repeat 3 ("follow internal emergency protocols as appropriate" - non-repeating, no safety weakening, A/A had 3 hard events). The adversarial
   sparks scenario (L4-G4: "successful" guest communication cases) never pulled the model toward the low-protection action (3 of 3 maintenance dispatch).
4. **Why, most likely.** The production prompt (rule 23) presents Learning as a historical aggregate "across many other cases of the same action type" that is "NOT evidence about the current Signal" and always subordinate to current facts. The
   existing `learning-v1` shape carries only per-action counts. The case observation cannot be given the framing that makes it *case* evidence ("N similar completed cases ...") without changing the AI-service contract and prompt, which this
   phase was forbidden to do. So the experiment measures the case observation delivered through the only existing vehicle; it does not measure a purpose-built one.

## Limits of this result

- It is a result for THIS delivery path (existing `learning-v1`, existing prompt). It does not show that case-based evidence could not help if framed as case evidence; it shows the current framing does not make the model use it.
- Synthetic data authored by the same team; 3 repeats per arm; deterministic text detectors (the 53C rubric's limits apply: they cannot judge what an operator would find wise).
- 5 of 60 pairs were invalid (all validator rejections: A 3, B 2); the valid fraction (92%) clears the 70% bar.
- The L4-G4 result relies on the policy classifying a sparking socket as NORMAL (a documented follow-up, unchanged).

## Recommended next step (not done here)

Keep Learning OFF. The smallest evidence-backed step is a SEPARATE, reviewed AI-service change that lets the model receive the observation AS case evidence (an extra closed contract such as `case-learning-v1` and a prompt section stating
"N similar completed cases of this workspace, outcome counts by action type; secondary to current facts and safety"), evaluated with this same frozen harness and thresholds. Do not tune the matcher: it was not the problem.

## Files

`scripts/l14/{dataset4,rubric4,score4,lib,run-l14-collector}.mjs`, `scripts/validate-learning-l1-4-effectiveness.mjs` (machinery validation, 60 checks), results in `scripts/l14/out/` (`SCORES4.md`, `scores4.json`, `raw-results.json`,
`model-outputs/`, `freeze.sha256`; `smoke-discarded/` holds the 3-call plumbing smoke test run before the freeze).
