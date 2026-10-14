# Learning L1 - case-based operational Learning (foundation, SHADOW only)

Status: **foundation only.** Nothing here is wired into the Intelligence request, no route serves it, no screen shows it, and the existing production Learning flag
(`KOI_LEARNING_CONTEXT_ENABLED`, aggregate Learning of Phases 31/32) is untouched and stays OFF. Phase 53C found the aggregate approach not effective; L1 builds the replacement's
foundation without enabling anything.

```
Completed Outcome -> Normalized Completed Case -> Deterministic Similarity -> Bounded Learning Observation      (L1: derive + evaluate, shadow)
                                                                                    |
                                    (later phases, NOT L1)  evidence envelope -> Intelligence -> Human Decision -> Action -> Outcome
```

## Files (all new, `backend/src/services/learning/`)

| File | Role | I/O |
|---|---|---|
| `completedCase.js` | the normalized completed case, `profileOfSignal`, `normalizeCompletedCase` (re-checks every link and workspace) | pure |
| `completedCaseService.js` | `loadCompletedCases(workspaceId, { excludeSignalId })`, `buildCurrentCaseProfile` - derives cases when asked | read-only DB |
| `caseSimilarity.js` | hard gates, score, relevance tier, `selectSimilarCases` | pure |
| `caseLearningObservation.js` | `buildLearningObservation` + the closed `OBSERVATION_SHAPE` | pure |
| `caseLearningShadow.js` | `deriveShadowLearningObservation({ workspaceId, signalId })` - the isolated evaluation entry point | read-only DB |

Tests: `backend/scripts/validate-learning-l1-case-based.mjs` (throwaway loopback database).

## A completed case

Derived on query from `Signal -> Intelligence V1 -> Decision V1 (approved) -> Action V1 (approved) -> Outcome V1 (recorded by a person)`; never stored, no migration. A chain missing
any link, with an unapproved Decision / Action, a legacy or person-less Outcome, an Intelligence with no stored safety result, or links / workspaces that disagree is **not** a case.

`facts` (closed vocabulary only): `issue {topics[], signalType, severity}`, `conditions {unitType, accessRefused}`, `safety {state, urgency, rules[]}`, `decision {result, priority}`,
`action {actionType, riskLevel, urgency, followedRecommendedAction}`, `outcome {status, effectiveness}`.
`internal` (server only): an opaque `caseKey` (hash, not a Mongo id), the Signal id (for self-exclusion) and the order key.
Never in a case: guest / stay / property identity, report / conversation / Outcome / model text, tenant or record ids, timestamps.

## Similarity (deterministic; no embeddings; the model never selects)

Hard gates (a failing case is excluded with a fixed reason): safety state identical -> safety rule set identical -> topic overlap (existing `historyRelevance` vocabulary; one-sided or
disjoint topics do not match) -> with no topics, same Signal type. The current Signal is never its own history. Score (ordering only): shared topics, identical topic set, same type,
same severity, same unit type. Tier: HIGH (identical topics + same type), MEDIUM (a shared topic), LOW (type only; never evidence).

## Learning Observation (`case-learning-v1`, mode `SHADOW`, `advisoryOnly`)

Counted by the server: `similarCaseCount`, `determinedCaseCount`, `weakMatchCount`, `relevance` (weakest tier), `outcomeDistribution`, `successRate` (determined outcomes only),
`dominantOutcome`, `outcomeConsistency` (HIGH >= 80% / MEDIUM >= 60% of determined outcomes, else LOW; a tie is LOW), `pattern` (INSUFFICIENT_EVIDENCE | POSITIVE | NEGATIVE | PARTIAL |
MIXED), `dominantActionType` (>= 60% and a strict plurality), `actionPatterns`, `sufficientEvidence` + `insufficientReason`. Minimum 3 similar cases and 3 determined outcomes. A current
safety condition (CRITICAL / LIFE_SAFETY_HAZARD) is never informed: `sufficientEvidence` false, reason SAFETY_CONDITION, no action suggested.

## Boundaries

Authority: current facts > safety > business knowledge > relevant history > case-based Learning. Tenant isolation: workspace-filtered queries, ObjectId validation, a 404 for a foreign
Signal, a per-record workspace re-check, Units resolved through their Property's workspace. Known limits: topic words come from untrusted report text (they can only widen matches inside
the same workspace, and the safety gate is compared first); Property has no stable characteristics, so none are used; the Outcome window is the most recent 500.
