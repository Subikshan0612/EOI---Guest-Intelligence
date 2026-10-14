# Learning L1.1 - shadow replay evaluation of case-based Learning

Evaluation only. L1 was not changed. No Gemini call, no embedding, no vector store, no feature flag, no write to any database that holds real data. The report contains aggregates only:
no credential, guest data, report text or record id.

Two populations were replayed through the real shadow path (`deriveShadowLearningObservation`), each case taken as the "current" case, itself excluded:

| Population | What it is | Script |
|---|---|---|
| **Real data** | the existing Atlas database `koi_staging`, READ-ONLY | `scripts/phase41/atlas-learning-replay-readonly.mjs` (artifact: `scripts/phase41/out/l1-replay-atlas.json`) |
| **Synthetic corpus** | 171 labelled completed workflows in a throwaway local database, two workspaces; it measures what the matcher does WHEN history exists, not how much history exists | `scripts/validate-learning-l1-replay.mjs` (17 checks, shared helpers in `scripts/lib/l1ReplayMetrics.mjs`) |

## 1. Executive result

**Classification: NOT READY.** Two independent reasons, either one sufficient:

1. **The real data cannot support Learning yet.** The real database holds **2 completed cases** (both the same AC situation). Every observation is "insufficient: too few cases".
2. **When history does exist, the matcher retrieves too much irrelevant history.** On a labelled corpus, **47.7% of the cases retrieved for ordinary (non-safety) reports are clearly irrelevant** (31% even under a deliberately lenient ground truth), 87.5% of ordinary reports retrieve at least one irrelevant case, and **79.4% of the observations that count as "sufficient" rest on evidence of which at least one third is borderline or irrelevant**. The cause is structural: the issue vocabulary is too coarse (finding 12).

What holds: determinism, tenant isolation, self-exclusion, and safety conditions (0 violations in every run). The foundation is safe; it is not yet useful. L2 should not start (section 15).

## 2. Dataset size

Real (Atlas, one workspace): 9 Signals; 9 Intelligence V1 (all with stored safety); 4 Decisions (all approved V1); 4 Actions (all approved V1); 2 Outcomes (both V1, both recorded by a person: 1 success, 1 unknown). Furthest stage reached by each Signal: 5 stopped at Intelligence, 2 at an approved Action with no Outcome, 2 have an Outcome.

Synthetic: 171 completed workflows = 19 situations x 6 (workspace A) + 19 x 3 (workspace B); 28% of reports mention two or more topic words.

## 3. Completed-case coverage

Real: 2 candidate chains -> **2 completed cases (100%)**, 0 excluded, no exclusion reason. 7 further Signals are simply not completed workflows (no Outcome), correctly not cases. Evaluated: 2 of 2 (100%).
Synthetic: 171 of 171 (100%).

## 4. Similarity availability (cases with N similar completed cases)

| | Real (2 cases) | Synthetic (171) |
|---|---|---|
| zero similar | 0 (0%) | 0 (0%) |
| at least one | 2 (100%) | 171 (100%) |
| at least three | **0 (0%)** | 165 (96.5%) |
| mean / max similar | 1 / 1 | 13.95 / 25 |

The two real cases match each other (identical topic, type, severity and unit type), so each has exactly one similar case. Type-only (weak) matches: 0 in both runs (they are never selected as evidence).

## 5. Evidence sufficiency

Real: sufficient **0 of 2 (0%)**; insufficient because of sample size 2 (100%); insufficient because outcomes are not determined 0.
Synthetic: sufficient 136 of 171 (79.5%); insufficient: safety condition 27 (15.8%, by design), sample size 6 (3.5%), outcomes not determined 2 (1.2%).

## 6. Outcome pattern distribution

Real: INSUFFICIENT_EVIDENCE 2 of 2.
Synthetic: POSITIVE 61 (35.7%), MIXED 75 (43.9%), INSUFFICIENT_EVIDENCE 35 (20.5%), NEGATIVE 0, PARTIAL 0 (the corpus contains no situation that is clearly failing or clearly partial; this is a property of the synthetic corpus, not a result). Among the 28 observations built on clean evidence: POSITIVE 20, MIXED 8.

## 7. Retrieval-quality findings

Structural dimensions of every retrieved pair (synthetic, 2386 pairs): safety 100% (a gate), topic 100% (a gate), same signal type 93%, same unit type 76.6%, same severity 62.8%; HIGH tier 42.9%, MEDIUM tier 57.1%; topic sets not identical in 55.8% of pairs.

Judged against hand-written ground truth (CLEARLY_RELEVANT = same equipment and same problem; BORDERLINE = same equipment with a different problem, or a leak from another source; CLEARLY_IRRELEVANT = neither; no machine-learned score):

| | relevant | borderline | irrelevant |
|---|---|---|---|
| all retrieved (2386) | 32.4% | 16.1% | 51.5% |
| ordinary reports only (2008) - the only ones Learning could reach | 33.2% | 19.1% | **47.7%** |
| same, lenient ground truth (also borderline when two items belong to one system, e.g. plumbing) | 666 | 720 | 622 (**31%**) |

Only 28 of the 136 "sufficient" observations (20.6%) have clean evidence; 108 (79.4%) have at least one third of their evidence borderline or irrelevant.

## 8. Safety findings

0 safety violations. Real: no safety-condition case exists. Synthetic: 27 gas / smoke / CO cases: **0** where Learning influenced anything (always insufficient, no suggested action); **0** safety-incompatible retrievals among all 2386; the 8 adversarial variants confirm the gates (a critical severity, a refusal of access and a gas smell added to an AC report each exclude the ordinary AC cases, and identical topics cannot rescue them).
One safety-adjacent GAP, not a violation: "sparks and a burning smell from a socket" has topics electrical + life_safety, but the server safety policy does not treat it as a hazard (its state is NORMAL), so it is retrieved against ordinary cases (6 of 11 of its retrieved cases were power-outage cases). The policy gap pre-dates L1 (Phase 53 canonical gap); L1 inherits it.

## 9. Tenant-isolation findings

0 cross-workspace retrievals (Real: 1 workspace. Synthetic: 2 workspaces holding the same 19 situations: 0 of 2386 retrieved cases belonged to the other workspace).

## 10. Self-match findings

0 of 2388 retrieved cases were the current case (real 2, synthetic 2386). An identical report filed twice as two Signals is correctly history, not self.

## 11. Determinism result

Identical. Each replay ran twice (real: 2 cases; synthetic: 171): the retrieved set and its order, counts, pattern, dominant action, relevance and sufficiency were identical for every case. The real-data run also proved it was read-only: 0 write attempts reached the driver (all write methods were blocked), and a content hash of all 21 collections (84 documents) was identical before and after.

## 12. Topic-widening findings (measured, not fixed)

- 28.1% of synthetic reports name two or more topics; for them only 26.3% of retrieved cases are relevant (52.1% irrelevant), against 39.3% relevant (50.8% irrelevant) for single-topic reports. Multi-topic wording therefore widens matches, but **single-topic reports are almost as bad**: the dominant cause is the coarseness of the 10-topic vocabulary itself, because one shared topic is enough to match.
- Coarse buckets that merge different operational situations: `water` (toilet leak, sink blockage, no hot water, AC leak), `appliance_it` (refrigerator and wifi), `electrical` (power outage and sparking socket), `life_safety` (gas, smoke, CO), `noise` (a noisy AC and a noisy neighbour).
- Wording examples (no report text): a refrigerator that "is not cooling" shares the `climate` topic with an AC that "is not cooling"; a shower "not heating" shares `climate` with the AC; a drain or a "water" word shares `water` with every leak.
- 54% of MEDIUM-tier matches come from multi-topic current reports (737 of 1362).

## 13. Concrete examples of useful matches (situation labels only)

- Housekeeping (towels / linen): 5 similar cases, all relevant -> POSITIVE, HIGH consistency, dominant action guest communication.
- Billing disputes: 5 similar, all relevant -> MIXED, LOW consistency (honest uncertainty).
- Key card / late check-out: 7 similar, 5 relevant (2 weak) -> POSITIVE.

## 14. Concrete examples of false / weak matches (situation labels only)

- Refrigerator not working: 25 similar cases, 5 relevant and 20 irrelevant (AC cases, via `climate`).
- No hot water: 25 similar, 5 relevant, 20 irrelevant (toilet, sink and AC-leak cases via `water`).
- Blocked sink: 23 similar, 5 relevant, 18 irrelevant. Sparking socket: 11 similar, 5 relevant, 6 irrelevant (power outages).
- Noisy neighbour retrieved noisy AC cases; wifi retrieved refrigerator cases.
- AC situations: 6-10 irrelevant or borderline cases each (AC leak vs AC noise vs AC not cooling).

## 15. Recommendation

**Do not proceed to L2.** L2 (embeddings / vector retrieval) would not fix either cause: there is not enough real history to retrieve, and the weakness is the coarse structured similarity, which embeddings would obscure rather than repair.
1. Treat the matcher as the next unit of work (a separate approval, still shadow): add finer deterministic facets (equipment and problem) to the existing vocabulary so that a shared coarse topic is no longer enough; re-run this same replay harness and require, for example, that irrelevant retrievals fall well below 10% and that clean sufficient observations become the large majority.
2. Separately, real outcome volume is the limit: 2 completed cases cannot form a pattern. Learning needs people to record Outcomes for approved Actions, over time; re-run the read-only Atlas replay periodically and revisit when several situations have at least 3 determined outcomes.
3. Decide the sparks / burning-smell safety gap in the safety policy (its own phase); Learning must not inherit it.
