# Learning L1.5b - real-data coverage measurement under the CORRECTED pairwise rule

Status: READ-ONLY MEASUREMENT. Nothing was implemented. Production Learning stays OFF. No production source, test, `.env`, flag, database content, index, deployment configuration, `.claude/` or `CLAUDE.md` was changed; no
synthetic production case was created; no Gemini or other model call was made; nothing was committed or pushed. The script lives in the session scratchpad (a documented scratch location outside the repository, not imported
by production code); this document is the only file added. It supplements `LEARNING_L1_5B_V2_COVERAGE_MEASUREMENT.md` (the old-rule measurement) and applies the comparison contract of
`LEARNING_L1_5B_V2_CONTRACT_CORRECTION_REVIEW.md`.

## 1. Verdict: **INSUFFICIENT**

The corrected rule finds **0 qualifying comparisons** on the real corpus: 3 completed cases in 1 workspace, 1 with a trusted L1.3 issue, no facet group with two action types. The corrected rule does not change the
coverage conclusion; the corpus simply cannot exercise Learning v2 today.

## 2. Method

- **Pipeline (the corrected contract, production functions unmodified):** `loadCompletedCases` (L1 completed-case definition) -> persisted trusted L1.3 `Signal.issue` (`isTrustedIssue`; no re-parse) -> safety eligibility
  (state NORMAL, no rules, no `safety_hazard` / `electrical_fault` family) -> the frozen L1.2 `selectSimilarCases` -> per-action rows of determined outcomes -> the corrected pairwise comparison, implemented as pure code:
  floor of 4 determined cases per row; every pair of floor-qualifying rows; significance level adjusted for the number of pairs; CLEAR only if the difference of quality is at least 0.30 and the lower bound of the
  Newcombe-Wilson interval for the difference is at least 0.10 at partial weights 0.25, 0.5 and 0.75 with the same action higher each time; several CLEAR pairs within 0.05 are omitted as ambiguous; frequency is not used.
- **Two views:** per-case leave-one-out (strict) and the new-Signal group view per workspace and facet triple.
- **Workspaces are never mixed.** Not modelled: the `GUIDANCE_PRESENT` suppression (it needs a model call); that could only lower coverage.
- **Self-test before freezing** (throwaway LOCAL database, not production data): the L1.5b C regression fixture (dispatch 0/1/4, inspection 5/0/0) is CLEAR with difference lower bounds 0.33 / 0.28 / 0.24; 4 vs 4 all-failed /
  all-success is CLEAR (0.31); mixed (2/1/2 vs 4/1/0) is `NO_SEPARATION`; equal outcomes are `EQUAL_OUTCOMES`; 3 vs 12 is `INSUFFICIENT_SAMPLE`; a single-action group is `SAME_ACTION_ONLY`; a gas group is excluded. All
  matched the correction review.

## 3. Results

| Item | Result |
|---|---|
| Verdict | **INSUFFICIENT** |
| Workspaces in the database / with completed cases | 1 / 1 |
| Completed cases examined | **3** (3 outcome chains considered, 0 rejected as incomplete) |
| With a persisted, trusted L1.3 issue | **1** (33%) |
| With known equipment and problem family | 1 (33%) |
| Safety-eligible | 1 (33%) |
| Candidate action-pair groups (facet groups with at least 2 action types) | **0** (eligible facet groups: 1; candidate action pairs: 0; groups with a floor-qualifying pair: 0) |
| Qualifying comparisons under the corrected rule | **0** (leave-one-out 0; group view 0) |
| CLEAR contrasts found | **none** |
| Distinct action pairs / workspaces with a CLEAR contrast | 0 / 0 |

Exclusion reasons (leave-one-out, first failing reason per completed case):

| Reason | Cases |
|---|---|
| `MISSING_ISSUE` (legacy Signal without an issue) | 2 |
| `NO_SIMILAR_CASES` (the one usable case has no other completed case to compare with) | 1 |
| `UNKNOWN_FACET`, `AMBIGUOUS_FACET`, `SAFETY`, `ACCESS_REFUSAL`, `FACET_EXCLUSION`, `SAME_ACTION_ONLY`, `INSUFFICIENT_SAMPLE`, `EQUAL_OUTCOMES`, `NO_SEPARATION`, `AMBIGUOUS` | 0 each |
| `CLEAR` | 0 |

The only facet group in the whole corpus is door lock / not operating, 1 case, a single action type (`SAME_ACTION_ONLY`). The measurement is identical to the old-rule result because nothing is close to a comparison under either rule.

## 4. Read-only evidence

| Item | Result |
|---|---|
| database | the existing Atlas staging database `koi_staging` |
| credential | the existing application user, `readWrite@koi_staging` at the server (not read-only), so read-only was enforced at the driver level |
| write block | `autoIndex` / `autoCreate` off; every insert / update / replace / delete / bulk / drop / index / rename / collection-management driver method replaced by a function that throws; **0 blocked attempts** |
| operations | find / count style reads only |
| content fingerprint before = after | **identical in all 21 collections** (counts and content hashes) |
| documents observed | 149 (actions 7, analysisadmissions 23, authidentities 0, authsessions 8, authtokens 0, conversations 17, decisions 7, guests 1, importbatches 0, intelligences 16, knowledgechunks 0, knowledgedocuments 0, messages 44, outcomes 3, properties 1, signals 17, stays 1, units 1, users 1, workspaces 1, workspacememberships 1) |
| writes | **zero** |
| output hygiene | only counts, closed enums and opaque labels; no workspace, Signal, Decision, Action or Outcome id, guest, stay, room, timestamp or report text |

## 5. Reproducibility

| Item | Value |
|---|---|
| frozen at / measured at | 2026-10-12T10:10:10Z / 2026-10-12T10:10:13Z (the script was not changed after the Atlas read) |
| script SHA-256 | `977919e2fb8ced71c5b9580222011c22ad340bf218a92912fdf8f8b1c0069001` |
| algorithm / config SHA-256 | `af3c3dfda4bdf975e08acd1ab5c3adada4daa3e732e901448cf54f8ecb63478e` |
| correction review SHA-256 | `e190d2234cbe1f4742f4bc9fe89fa5fe1c91a3d50742400709306dae47993803` |
| `completedCase.js` | `cd044d1a38dcf0d2a1de5a0473cef0cc65dd3a14636f64785b1bed0d3132e246` |
| `completedCaseService.js` | `7da2c14f92823eb8e23aa7a9544438b60782862bb2d3e63ed36a09733f2e4ac4` |
| `caseSimilarity.js` | `e707d4e9d5fdf5f6707510994cf8c5291b2670751a9d9c3a52603bf583c62f71` |
| `caseFacets.js` | `195d622c6f26275f3a9f80f21a4618ec1d95eda8738ead4961767b3befaa753a` |
| `structuredIssue.js` | `8dc02c2815810fc3aa3e37c8df2da782d5f2ff667e688ddfe5fa9829d0c40de1` |
| `safetyPolicy.js` | `216907fde28be709ed64e45963f27e7c7cc2a0605bb9984949c3b16d7b7cfc60` |
| `models/Signal.js` | `5a0b7562075e9cdce68828359fe058e1a3fb5518751d799d857ce2d261c6b28b` |

## 6. Interpretation and next step

Case A (near-zero coverage) stands. The corrected rule is robust on the self-test fixtures but has nothing to apply to: a comparison needs, within one workspace and one situation, at least two actions with four or more
determined outcomes each, and a clearly separated outcome contrast. The next gate is unchanged: let naturally completed, structured cases accumulate through the normal lifecycle (which the correction review verified keeps
the L1.3 issue intact), re-run this frozen read-only measurement periodically, and consider implementation planning only when the coverage targets of the correction review are met or a synthetic-only dark build is separately
approved. No implementation follows from this measurement.

## 7. Confirmations

- Production Learning remains OFF; no flag or default was touched.
- No production source or test was modified; no `.env` or secret was modified, printed or stored.
- No MongoDB write, index, collection or schema change (0 blocked attempts; fingerprints identical across all 21 collections); no synthetic production case was created.
- No Gemini or other external model call.
- Nothing was committed or pushed.
