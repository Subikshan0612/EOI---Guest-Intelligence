# Learning L1.5b - real-data coverage measurement for a possible `learning-v2`

Status: READ-ONLY MEASUREMENT. Nothing was implemented. Production Learning stays OFF. No production source, test, `.env`, database content, index, flag or deployment configuration was changed; no Gemini or other model call
was made; nothing was committed or pushed. The measurement script lives in the session scratchpad (a documented scratch location outside the repository, not imported by production code); this document is the only
file added to the repository.

## 1. Executive coverage verdict: **INSUFFICIENT**

Of the 3 real completed cases, 1 has a usable structured issue, and it has no similar case. There is nothing to compare: 0 comparisons reached the algorithm's floors, 0 qualifying STRONG comparisons.
The real corpus cannot meaningfully exercise Learning v2 today.

A second, independent finding matters as much as the count: **the design review's own tie rule would have suppressed the very condition L1.5b validated** (section 7). The measurement is reported against the
exact rule, as instructed; the finding is recorded for the next design review and the rule was not changed.

## 2. What was measured and how

- **Question:** if the proposed deterministic comparison existed today, how many real completed cases would produce STRONG comparative evidence?
- **Pipeline (the design review's, using production functions unmodified):** `loadCompletedCases` (the L1 completed-case definition: Signal + stored Intelligence V1 safety + approved Decision V1 + approved Action V1 +
  person-recorded Outcome V1) -> the persisted, trusted L1.3 `Signal.issue` (`isTrustedIssue`; no re-parsing of any report text) -> safety eligibility -> the frozen L1.2 `selectSimilarCases` -> per-action outcome rows
  -> the comparison algorithm of `LEARNING_L1_5B_V2_DESIGN_REVIEW.md` section 5, implemented as pure code in the scratch script.
- **Two views, both reported:**
  - *Per-case leave-one-out* (strict): each completed case is treated as a new Signal of its own workspace, itself excluded, and the pipeline runs over the OTHER completed cases of the same workspace.
  - *New-Signal group view*: for each facet group in a workspace, the pipeline runs over ALL completed cases as if a new Signal with those facets arrived now (the more realistic proxy for "would v2 deliver").
- **Workspace boundary:** every query carries the workspace filter and the comparison never mixes workspaces; output contains only an aggregate workspace count and opaque labels.
- **Not modelled:** the proposed `GUIDANCE_PRESENT` suppression (it needs retrieval, which needs an embedding model call). Modelling it could only lower coverage further, so the figures are upper bounds.

## 3. Reproducibility

| Item | Value |
|---|---|
| measurement timestamp | 2026-10-12T09:16:45Z (script and config frozen at 09:16:42Z, before the Atlas read; the script was not changed after reading Atlas) |
| script SHA-256 | `ca72038a4518a94f00d7fc074f792ce91381eaab4d5ab4f57663ed1edd1e8065` |
| algorithm / config SHA-256 | `434f086b555ce390178a1b192cc63676f5cc4a3cae4a2f4ecb94f9d9f641d75d` |
| design review SHA-256 | `0beb5e50401944d4170d6aa63c256985d749401af7cadde649a0dc1f5116e1be` |
| `completedCase.js` | `cd044d1a38dcf0d2a1de5a0473cef0cc65dd3a14636f64785b1bed0d3132e246` |
| `completedCaseService.js` | `7da2c14f92823eb8e23aa7a9544438b60782862bb2d3e63ed36a09733f2e4ac4` |
| `caseSimilarity.js` | `e707d4e9d5fdf5f6707510994cf8c5291b2670751a9d9c3a52603bf583c62f71` |
| `caseFacets.js` | `195d622c6f26275f3a9f80f21a4618ec1d95eda8738ead4961767b3befaa753a` |
| `structuredIssue.js` | `8dc02c2815810fc3aa3e37c8df2da782d5f2ff667e688ddfe5fa9829d0c40de1` |
| `safetyPolicy.js` | `216907fde28be709ed64e45963f27e7c7cc2a0605bb9984949c3b16d7b7cfc60` |
| `models/Signal.js` | `5a0b7562075e9cdce68828359fe058e1a3fb5518751d799d857ce2d261c6b28b` |

Algorithm constants (frozen): outcome quality `(success + 0.5 * partial) / determined`, blocked and unknown excluded; at least 4 determined cases for BOTH compared actions; reference = the most frequent action, a
frequency tie means no comparison; alternative = the best-performing other action; STRONG only when the 95% Wilson lower bound of the alternative is at least the 95% upper bound of the reference; MODERATE disabled;
two qualifying alternatives within 0.05 omitted as ambiguous. Safety eligibility: state NORMAL, no safety rules (no critical severity, no refused access), problem family not `safety_hazard` / `electrical_fault`.
Facet requirement: persisted trusted issue with a KNOWN equipment and problem family.

The script was first run once against a throwaway LOCAL database with known answers (a strong AC comparison, a tied sink comparison, a hazard group, a blocked-only group): it produced the expected classifications
and a clean fingerprint. That self-test is the reason the sensitivity variant in section 7 was added and frozen before the Atlas read.

## 4. Database safety

| Item | Result |
|---|---|
| database queried | the existing Atlas staging database `koi_staging` (the only database; no other was touched) |
| credential | the existing application user; it holds `readWrite@koi_staging` at the server, which is NOT read-only, so read-only was enforced at the driver level |
| write guard | `autoIndex` and `autoCreate` off before any model registered; every insert / update / replace / delete / bulk / drop / index / rename / collection-management method of the driver replaced by a function that throws |
| blocked write attempts | **0** |
| operations issued | find / count style reads only |
| collections read (21 fingerprinted; the pipeline itself reads) | `outcomes`, `actions`, `decisions`, `intelligences`, `signals`, `units`, `properties`, `workspaces` (plus a full read of all 21 collections for the content fingerprint) |
| documents observed | 149 in 21 collections |
| per-collection counts | actions 7, analysisadmissions 23, authidentities 0, authsessions 8, authtokens 0, conversations 17, decisions 7, guests 1, importbatches 0, intelligences 16, knowledgechunks 0, knowledgedocuments 0, messages 44, outcomes 3, properties 1, signals 17, stays 1, units 1, users 1, workspaces 1, workspacememberships 1 |
| content fingerprint before = after | **identical in all 21 collections** (counts and content hashes) |
| writes | **zero** |

## 5. Coverage funnel (real corpus)

| Metric | Count | Percentage of completed cases |
|---|---|---|
| Outcomes considered (candidate chains) | 3 | n/a |
| Chains rejected as incomplete (partial workflows, not counted) | 0 | n/a |
| **Total completed cases** | **3** | 100% |
| With a persisted, trusted L1.3 issue | 1 | 33% |
| With known equipment and problem family ("fully determined facets") | 1 | 33% |
| Safety-eligible (NORMAL, no rules, no excluded family) | 1 | 33% |
| With >= 2 action types among their similar cases | 0 | 0% |
| With >= 4 determined cases per compared action (floor met) | 0 | 0% |
| Frequency tie | 0 | 0% |
| Equal outcome quality | 0 | 0% |
| Insufficient separation | 0 | 0% |
| **Qualifying STRONG comparisons (exact design rule)** | **0** | **0%** |
| Qualifying STRONG, sensitivity variant (section 7) | 0 | 0% |

New-Signal group view: 1 facet group exists in the whole corpus (door lock, not operating, 1 case, a single action type): `SAME_ACTION_ONLY`. 0 STRONG groups under the exact rule and 0 under the variant.

## 6. Exclusion breakdown (first failing reason per case)

| Exclusion | Cases |
|---|---|
| missing issue (legacy Signal) | **2** |
| UNKNOWN facet (issue present) | 0 |
| AMBIGUOUS facet | 0 |
| safety (state not NORMAL, or a safety rule) | 0 |
| access refusal | 0 |
| facet exclusion (`safety_hazard` / `electrical_fault`) | 0 |
| no similar case (the only usable case has no other completed case to compare with) | **1** |
| same action only | 0 |
| insufficient cases (per-action floor) | 0 |
| tie | 0 |
| equal outcomes | 0 |
| no meaningful comparison (reference already best) | 0 |
| insufficient separation | 0 |
| ambiguous alternative | 0 |
| **STRONG** | **0** |

## 7. Qualifying comparative situations, and the tie-rule finding

| Comparative situation | Equipment | Problem | Condition | Actions | Case counts | Outcome distribution | Quality | Wilson result | Qualifies? |
|---|---|---|---|---|---|---|---|---|---|
| (none) | | | | | | | | | **no situation qualifies** |
| CASE_GROUP_001 (informational; the only usable group) | door_lock | not_operating | NOT_APPLICABLE | maintenance_dispatch | 1 | 1 success / 0 / 0 | 1.00 | not computed (single action) | no: `SAME_ACTION_ONLY` |

Distinct comparative situations: 0. Distinct action pairs: 0. Workspaces represented: 0 of 1 workspace that holds any completed case (the database has exactly 1 workspace).

**Finding about the design rule (not changed).** In the local self-test, the strong AC situation from L1.5b condition C (dispatch 5 cases at 0 / 1 / 4, inspection 5 cases at 5 / 0 / 0) is classified `TIE` by the exact rule
("reference = most frequent action; frequency tie => no comparison"): both actions have 5 cases, so nothing is delivered. Equal case counts are exactly the shape L1.5b validated, so the rule as written would suppress the
validated condition whenever the two rows are equally frequent. As a clearly labelled sensitivity variant (frozen before the Atlas read, NOT the verdict) the tie was broken toward the tied action with the lowest quality: it classifies
that situation STRONG in the self-test. On the real data the variant also finds 0 (there is nothing to tie). The design review should fix the reference-selection rule before any implementation (candidates: reference = the
lowest-quality action among those meeting the floor, or evaluate every ordered pair).

## 8. Real legacy-case findings

| Question | Answer |
|---|---|
| completed cases whose Signal has no usable L1.3 issue (legacy) | **2 of 3** (67%) |
| of those, with an issue but UNKNOWN or AMBIGUOUS facets | 0 (they have no issue at all, so the production derivation treats their facets as UNKNOWN; they were not repaired) |
| cases that therefore cannot take part in any comparison | those 2, plus the 1 usable case (no peer): **3 of 3** |

Not repaired, not re-parsed. The one usable case was recorded through the post-L1.3 intake.

## 9. Workspace coverage (aggregate only)

1 workspace in the database; 1 with completed cases (3); 1 with at least one usable issue; 0 with any qualifying comparison. No workspace id appears in this document.

## 10. Interpretation (not a single percentage)

"Meaningful coverage" should be judged on independent comparative situations, action pairs, workspaces and outcome diversity, for example at least 3 independent comparative situations, at least 2 distinct action pairs,
at least 2 workspaces (or one workspace with several situations) and a mix of strongly separated and non-separated pairs. Real figures today: 0 situations, 0 action pairs, 0 workspaces, 1 outcome type.

This is **case A: near-zero coverage**. A comparison under the exact rule needs, within one workspace and one situation, roughly 9 or more completed cases with persisted issues, split unevenly across two actions
(at least 4 determined each, the more frequent action having the clearly worse outcomes). The corpus is 3 cases, 2 of them legacy. The current completed-case corpus cannot meaningfully exercise v2, and no real replay
can evaluate it.

## 11. Recommendation

1. **Do not proceed to implementation.** Do not wire `learning-v2` and do not plan its production enablement on the strength of this corpus.
2. **Gather structured completed cases first,** through the normal Signal -> Intelligence -> Decision -> Action -> Outcome lifecycle, now that intake derives the issue server-side. Re-run this frozen measurement as the corpus grows
   (it is cheap and read-only); proceed to implementation planning only when the "meaningful coverage" criteria of section 10 are met or a justified synthetic-only evaluation plan is approved.
3. **Amend the design review before any implementation:** resolve the reference / tie rule (section 7). This is a design defect found by measurement, independent of coverage.
4. If v2 is built anyway as dormant infrastructure, its experiment must rely on synthetic / controlled cases (as L1.4 did); real replay can only report would-deliver rate, which is currently 0.

## 12. Confirmations

- Production Learning remains OFF; no flag or default was touched.
- No production source was modified, and no production test was modified.
- No `.env` file or secret was modified, printed or stored (the existing credential was used through the existing mechanism, never displayed).
- No MongoDB write, index, collection or schema change: 0 blocked write attempts, content fingerprints identical before and after across all 21 collections.
- No Gemini or other external model call; no embedding call; the AI service was not used.
- Nothing was committed or pushed.
