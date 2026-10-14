# Learning L1.5b - design review for a possible `learning-v2` (comparative historical evidence)

Status: DESIGN REVIEW ONLY. Nothing here is implemented. Production Learning stays OFF (`KOI_LEARNING_CONTEXT_ENABLED` unset). No production source, schema, test, `.env`, database, deployment configuration or frozen
artifact was changed to write this document, no live Gemini call was made, and nothing was committed or pushed. Location: `backend/docs/`, beside the other `LEARNING_*` documents (L1 to L1.4), which is where the series lives.

Companion material (all uncommitted, in the session scratchpad, not in the repository): the L1.5 and L1.5b probe scripts, frozen hashes and raw outputs. The numbers below are quoted from the L1.4 report
(`LEARNING_L1_4_EFFECTIVENESS.md`) and from the L1.5 / L1.5b probe results.

---------------------------------------------------------------------------------------------------------------------------------------------------------------------

## 1. Executive verdict

**CONDITIONAL GO for a narrowly scoped implementation, behind the OFF flag, with one mandatory pre-condition (a read-only coverage measurement) and a mandatory post-implementation experiment before any production enablement.**

Why conditional, in one paragraph: the probe proves a *capability* (Gemini uses a clearly framed comparative outcome pattern that contains a concrete successful alternative), but three things are not yet proven and each must be measured, not assumed:
(1) how often real data will ever contain a qualifying comparison (the real database holds 3 completed cases; a qualifying comparison needs at least two actions, each with several determined outcomes, for the same equipment / problem / condition);
(2) whether the effect holds on the 20-scenario L1.4 structure, with a v1 arm and an A/A control, rather than on one scenario;
(3) whether the new prompt block changes behaviour of requests that carry no Learning (it must not: see section 8, conditional system block).

---------------------------------------------------------------------------------------------------------------------------------------------------------------------

## 2. What the evidence says (and why the design emphasis changes)

| Experiment | Evidence delivered | Result |
|---|---|---|
| L1.4 (20 scenarios x 3 repeats x 3 arms, 180 analyses) | `learning-v1` aggregate rows, per action type, "not evidence about the current Signal" | 0 beneficial pairs, 0 of 58 runs referred to the evidence; NOT EFFECTIVE |
| L1.5 | clear framing, ONE action (dispatch 0 / 1 / 4) or a second action | negative-only: 1 of 9 recognised; with an alternative: 6 of 6 switched, 2 of 6 explained; FAIL by its rule (S1 ignored) |
| L1.5b (80 calls, 79 valid) | the same eight framing rules, evidence blocks built by the real `buildLearningObservation` | baseline dispatch 11/11, inspection-first 0/11. **B negative-only 0/12** changed (9 ignored it). **C successful alternative 9/12** inspection-first (wording-only 8/12). **D mixed comparative 8/12**, hedged, no overclaim. Unrelated 0/8. Safety 8/8 immediate escalation. Reliability 79/80 |

Interpretation that drives this design:

1. **Framing was necessary but not sufficient** (L1.4 and L1.5 vs L1.5b). The model acts on a *contrast*: an action that did badly *and* an action that did well.
2. **A failure count alone is inert.** "This action failed" gives the model nothing to move to; it follows its strong prior (dispatch in 100% of baseline runs). Exposing failure counts or generic "similar cases" adds prompt length and risk (policy-language drift, extra rejections) for no measured benefit.
3. **Therefore the right unit of delivery is a COMPARISON, not a retrieval.** `learning-v2` must be delivered only when the server can say, deterministically, "in this workspace's similar completed cases, action X did meaningfully better than action Y". Otherwise it must deliver nothing. This is the design emphasis; it is different from L1.5 (generic similar-case evidence block) because:
   - it removes the cases the probe showed to be inert (negative-only, positive-only, equal);
   - it gives the model exactly the shape that worked (two rows with counts);
   - it makes "no evidence" the default, which is the safest state;
   - it makes the coverage question explicit (section 14): comparisons are rare.
4. **Mixed evidence (D) worked in the probe but is the least validated tier** (hedged language 60%, confidence flat because the production confidence ceiling caps no-guidance answers at MEDIUM). Section 5 therefore treats it as a disabled-by-default tier.

---------------------------------------------------------------------------------------------------------------------------------------------------------------------

## 3. Exact production contract (`learning-v2`)

A new, closed, version-discriminated variant of the existing `learning` field of `POST /v1/intelligence/analyze`. `learning-v1` is left byte-for-byte unchanged.

```jsonc
learning: {
  "learningVersion": "learning-v2",
  "evidenceType": "COMPARATIVE_HISTORICAL_EVIDENCE",          // literal; names what this is, never "policy" or "recommendation"
  "basis": { "equipment": "<EQUIPMENT_VALUES>", "problemFamily": "<PROBLEM_VALUES>", "condition": "<CONDITION_VALUES|UNKNOWN>" },
  "coverage": { "similarCases": 10, "comparedCases": 10, "minimumPerAction": 4 },
  "reference":   { "actionType": "<ACTION_TYPES>", "caseCount": 5, "determined": 5, "outcomes": { "success": 0, "partial": 1, "failed": 4 }, "successRate": 0.0 },
  "alternative": { "actionType": "<ACTION_TYPES>", "caseCount": 5, "determined": 5, "outcomes": { "success": 5, "partial": 0, "failed": 0 }, "successRate": 1.0 },
  "comparison": { "direction": "ALTERNATIVE_BETTER", "strength": "STRONG" }   // closed enums; strength: STRONG | MODERATE
}
```

Field-by-field:

| Field | Type | Source | Why it is there | Model-visible |
|---|---|---|---|---|
| `learningVersion` | literal `"learning-v2"` | constant | discriminator for the union (v1 stays valid) | yes |
| `evidenceType` | literal | constant | the prompt and the sanitizer can name what the block is; prevents reuse as a free-form channel | yes |
| `basis.equipment/problemFamily/condition` | closed enums, never UNKNOWN / AMBIGUOUS for equipment or problem | the CURRENT Signal's server-derived `Signal.issue` (L1.3), equal to every compared case's by the L1.2 gate | "why these cases are similar", with no historical identity | yes |
| `coverage.similarCases` | int | count of selected similar cases (L1.2 HIGH/MEDIUM) | stops the model overstating: shows how much history sits behind the two rows | yes |
| `coverage.comparedCases` | int | determined cases in the two rows | same | yes |
| `coverage.minimumPerAction` | int | server constant | the evidence floor the server applied | yes |
| `reference.*` | action enum + ints + rate | the MOST FREQUENT action among similar determined cases | "what this workspace usually did" (what the model would otherwise default to) | yes |
| `alternative.*` | same | the best-performing OTHER action that clears the comparison rule | the concrete alternative the probe showed the model needs | yes |
| `comparison.direction` | enum, only `ALTERNATIVE_BETTER` exists in v2.0 | Node comparison layer | a fixed label; there is deliberately no "REFERENCE_BETTER" (section 6, positive-only) | yes |
| `comparison.strength` | `STRONG` or `MODERATE` | Node comparison layer (section 5) | lets the prompt tell the model to hedge more on MODERATE; Node computes it, the model never does | yes |

Renames versus the draft shape in the request: `currentAlternative` -> `reference` and `preferredAlternative` -> `alternative`. "Current" is misleading (Node does not know what the model will recommend) and "preferred" reads as an instruction, which the prompt must never be. `refs: [...]` is not a field of the payload: refs are minted by the envelope (section 9), exactly as today.

The block carries a **successRate** (as the validated probe blocks did) so the model never has to compute one. It is Phase 31 semantics: success / determined, partial counted separately. `outcomes` deliberately lists only success / partial / failed; blocked and unknown outcomes are excluded from the comparison and not delivered (they say nothing about whether an approach works).

**One deviation from the validated probe shape must be called out:** the probe blocks carried `pattern` and `outcomeConsistency`; v2 replaces them with `comparison.strength`, and adds `coverage`, `evidenceType` and the two explicit row names. These changes are not covered by L1.5b. The post-implementation experiment therefore includes a parity arm (section 16).

### Never sent to the AI service

Workspace id, tenant markers, any Mongo id (Signal, Decision, Action, Outcome, Intelligence, guest, stay, property, unit), `caseKey`, `signalId`, `recordedAtMs` and any timestamp, historical room / unit / property names or numbers, guest or stay identity (historical or current-via-history), any historical title, description, Decision text, Action note, Outcome summary or notes, any model-generated historical prose, per-case rows (no row per case, no order), `riskLevel` / `urgency` / `followedRecommendedAction` of past actions, `dominantActionType`, relevance scores, weak-match counts, blocked / unknown counts, the other actions' rows, and the observation's `mode` / `advisoryOnly` / `safetyCondition` literals. Counts of at most two actions and closed enums are the whole payload.

---------------------------------------------------------------------------------------------------------------------------------------------------------------------

## 4. What Node must compute before anything reaches Gemini (pipeline and order)

New module under `services/learning/` (suggested `caseEvidenceService.js`), called from the existing Learning branch of `runAnalysis` (`intelligenceAnalysisService.js`, the line that today reads `getLearningContextEnabled() ? buildLearningContext(scope) : undefined`). Order is a hard requirement; the first failing gate returns "no Learning" with a closed reason code:

1. **Flag and source.** `getLearningContextEnabled()` AND the new server-only source setting equals `comparative` (section 11). Otherwise: no v2, reason `FLAG_OFF` (and v1 behaviour is whatever it is today).
2. **Workspace isolation already established.** The membership-verified `scope` that `runAnalysis` already uses. Nothing below runs without it.
3. **Safety eligibility (section 7)** using the existing `deriveSafetyPolicy(context)` result that the pipeline derives anyway. Reason `SAFETY_INELIGIBLE`.
4. **Authoritative guidance present?** If retrieval returned relevant business knowledge (the same `relevantKnowledgeCount(knowledge, floor)` the confidence ceiling and prose guard already use), deliver nothing. Reason `GUIDANCE_PRESENT` (section 6).
5. **Current facets known.** The current Signal's persisted, trusted issue must have a known equipment and problem family (not UNKNOWN / AMBIGUOUS; a legacy Signal has none). Reason `FACETS_UNKNOWN`.
6. **Load completed cases for THIS workspace only** (`loadCompletedCases(scope)`; every query carries the workspace filter and each case is re-verified), then L1.2 `selectSimilarCases` (frozen gates, unchanged). Reason `NO_SIMILAR_CASES`.
7. **Aggregate per action** over determined outcomes (success, partial, failed; blocked / unknown excluded).
8. **Comparison layer (section 5).** Reasons `INSUFFICIENT_SAMPLE`, `NO_ALTERNATIVE`, `NO_SEPARATION`, `AMBIGUOUS`.
9. **Build the v2 object, validate it with the new contract shape (closed, bounded), then attach.** Any failure: no Learning, reason `MALFORMED` (section 11). The request that reaches Gemini is then identical to a Learning-OFF request.
10. **Admission audit** (counts and a reason code only, section 12).

Nothing computed here is read from a model output, a client field or a prompt.

---------------------------------------------------------------------------------------------------------------------------------------------------------------------

## 5. The comparison algorithm (deterministic, sample-size-aware, conservative)

Design principles: Node decides; thresholds are a minimum evidence floor plus a sample-size-aware separation test, not a fixed "80% success is preferred" rule; the thresholds are named server constants documented as *starting values to be calibrated by the post-implementation experiment*, not as domain truths.

**Outcome quality.** For each action row over determined cases: `q = (success + 0.5 * partial) / determined` (an ordinal, domain-agnostic ordering: success > partial > failed; blocked and unknown are not determined and are excluded). The 0.5 for partial is a modelling choice and is listed as an open question.

**Reference action.** The most frequent action among the similar determined cases (what the workspace usually does, so what the model would most likely default to). A tie for most frequent: omit (`AMBIGUOUS`).

**Candidate alternatives.** Every other action row.

**Floors (per action).** `determined >= MIN_PER_ACTION` (starting value 4) for BOTH the reference and the candidate. Below that: `INSUFFICIENT_SAMPLE`. (The existing L1 floor is 3 similar cases overall; a comparison needs more because it compares two rows.)

**Separation (sample-size-aware).** Wilson score interval for each row's `q` treated as a proportion over `determined`:
- `STRONG`: `lower95(alternative) >= upper95(reference)` (the 95% intervals do not overlap).
- `MODERATE` (defined but DISABLED by default, constant `ENABLE_MODERATE=false`): point difference `>= 0.25` AND `lower80(alternative) >= upper80(reference)`.

**Choice.** Among candidates that qualify, deliver the one with the highest lower bound. Two qualifying candidates within 0.05 of each other: omit (`AMBIGUOUS`; the server will not pick arbitrarily).

**Direction.** The only delivered direction is `ALTERNATIVE_BETTER`. If the reference is the best performer, the result is "no alternative": omit (`NO_ALTERNATIVE`).

Worked examples with the starting values (computed offline, no model call), reference vs alternative, `q` as a proportion, floor 4:

| Situation (success / partial / failed) | q ref / alt | Result |
|---|---|---|
| L1.5b C: dispatch 0/1/4 vs inspection 5/0/0 | 0.10 / 1.00 (alt lower 0.57 > ref upper 0.54) | **STRONG, delivered** |
| 4/0 vs 0/4 style: dispatch 0/0/4 vs inspection 4/0/0 | 0.00 / 1.00 | STRONG, delivered |
| larger n: dispatch 4/3/13 vs inspection 14/3/3 | 0.28 / 0.78 | STRONG, delivered |
| L1.5b D: dispatch 2/1/2 vs inspection 4/1/0 | 0.50 / 0.90 (intervals overlap) | **not delivered** with MODERATE disabled; delivered as MODERATE only if enabled |
| similar outcomes: 3/1/1 vs 3/1/1 | 0.70 / 0.70 | no separation, omitted |
| slightly better: 2/1/2 vs 3/1/1 | 0.50 / 0.70 | no separation, omitted |
| usual action already good: 4/0/1 vs 5/0/0 | 0.80 / 1.00 | no separation, omitted |
| 3 cases per action | any | below the floor, omitted |
| alternative has 2 cases: dispatch 0/0/5 vs inspection 2/0/0 | 0.00 / 1.00 | below the floor, omitted |
| only a negative row exists (L1.5b B) | n/a | no alternative, omitted |
| only a positive row exists | n/a | no alternative, omitted |

Two consequences are stated openly:
- **Under the starting values the validated probe condition D would not be delivered.** That is deliberate conservatism: D showed use and hedging but is the tier least covered by evidence. The experiment in section 16 pre-registers whether enabling MODERATE is justified.
- **Thresholds are not universal.** `MIN_PER_ACTION`, the 95% / 80% levels, the 0.25 margin, the 0.5 partial weight and the 0.05 tie band are configuration constants of the comparison module, versioned with the contract (`comparisonVersion` in the audit record) and changed only through a reviewed change plus a re-run of the frozen harness. They are NOT policy, are never client-controllable and never appear in prompt text as a rule for the model.

Nothing here lets Gemini compute a rate or judge significance: it receives counts, a rate and a two-value strength label.

---------------------------------------------------------------------------------------------------------------------------------------------------------------------

## 6. Edge cases: what happens and why (deliver means `learning-v2` is attached; omit means the request is identical to Learning OFF)

| Situation | Behaviour | Reason code | Rationale |
|---|---|---|---|
| both actions have similar outcomes | omit | `NO_SEPARATION` | no contrast to act on; an inert block only adds risk |
| one action has very few cases | omit | `INSUFFICIENT_SAMPLE` | a 2-case row is not a pattern |
| only negative evidence | omit | `NO_ALTERNATIVE` | L1.5b B: inert; do not spend prompt budget or invite policy language |
| only positive evidence | omit (v2.0) | `NO_ALTERNATIVE` | "your usual action works" is untested and the model already defaults to it; a separate future tier |
| evidence conflicts (two similar-strength alternatives) | omit | `AMBIGUOUS` | the server will not choose arbitrarily |
| evidence is weak (overlapping intervals) | omit (MODERATE disabled) | `NO_SEPARATION` | conservative start |
| evidence is irrelevant (other equipment / problem / condition) | never selected | (L1.2 gates) | UNKNOWN / AMBIGUOUS facets and mismatches are excluded before any comparison; L1.4 measured 0 of 95 irrelevant retrievals |
| current facts differ from historical facets (for example the current unit status or stay contradicts the report) | deliver only if the facets match; the prompt rule "current facts win" applies | n/a | the matcher compares the report's classification, not current state; the model keeps current facts primary |
| safety state differs | never selected (L1.2 safety-state and safety-rules gates) and never delivered for any non-NORMAL current state | `SAFETY_INELIGIBLE` | section 7 |
| access state differs | same: `ACCESS_REFUSED` is a safety rule; the current policy FORBIDS dispatch and inspection when access is refused | `SAFETY_INELIGIBLE` | section 7 |
| authoritative business guidance is present and relevant | omit | `GUIDANCE_PRESENT` | L1.5b only tested a RAG miss; precedence is a prompt rule, but an untested interaction must not ship enabled. Learning is therefore a fallback for the RAG-miss case in v2.0 |
| the model must recommend something the evidence disfavours | allowed | n/a | the evidence never forces an action (prompt rule P3); safety minimums and claim admissibility still apply |

---------------------------------------------------------------------------------------------------------------------------------------------------------------------

## 7. Safety eligibility (exactly where suppression belongs)

There is no second safety policy. Eligibility is computed in the new Node builder from the object the pipeline already derives: `deriveSafetyPolicy(context)` (`services/ai/safetyPolicy.js`, unmodified; history, Learning and knowledge are not its inputs).

Deliver only if ALL hold:
1. `policy.state === "NORMAL"` and `policy.rules` is empty (so no `SEVERITY_CRITICAL`, no `LIFE_SAFETY_HAZARD`, no `ACCESS_REFUSED`).
2. `policy.forbiddenActionTypes` does not contain either delivered action and, if `policy.requiredActionTypes` is non-null, both delivered actions are within it (defence in depth: under rule 1 these are empty, but the check keeps the builder correct if the policy ever grows a rule).
3. Defence in depth for the one documented policy gap ("sparks and a burning smell" is classed NORMAL): never deliver when the current `basis.problemFamily` is `safety_hazard` or `electrical_fault` (a deterministic L1.3 facet check; it changes no policy and is removed when the policy gap is closed by its own phase).

Everything the AI side does about safety stays where it is: rule 26 of the system prompt, `enforceSafetyPolicy` (rejects an analysis below the minimums), `assertProseConsistent` and the confidence ceiling. Historical evidence cannot reach any of them as an input. The completed-case side already refuses to learn from safety conditions (`SAFETY_STATE_MISMATCH` and `SAFETY_RULES_MISMATCH` are L1.2 gates; the observation reports `SAFETY_CONDITION` as never sufficient). L1.5b showed 8 of 8 gas runs preserved immediate escalation even when shown contrary history; v2 does not rely on that: it never sends such evidence in the first place.

Where the suppression is NOT placed: not in Python (it has no policy input and no tenant knowledge), not in the prompt (a prompt rule is a request, not a boundary), and not in the L1.2 matcher (frozen).

---------------------------------------------------------------------------------------------------------------------------------------------------------------------

## 8. Prompt framing

Principle: keep the validated L1.5 framing (rules P1 to P8) and let it apply ONLY when the v2 block is present.

**Conditional system block (a design requirement, not an optimisation).** `build_analysis_prompt` appends the v2 rule block to the system prompt only when the request carries `learning-v2`. A request with no Learning (or with `learning-v1`) produces a system prompt and a user prompt byte-identical to today's. The existing global rule 23 (which describes the v1 aggregate) is left unchanged for v1 requests; for v2 requests the appended block states that rule 23 does not apply to the v2 section. This avoids silently changing every analysis (L1.4 showed the system prompt is the same for every arm). A test pins "no Learning => identical prompt hash".

**The v2 user-prompt section** (a new labelled section before BUSINESS KNOWLEDGE, like the Learning section today): "COMPARATIVE OUTCOMES OF SIMILAR COMPLETED CASES (HISTORICAL EVIDENCE)", with a header that says: server-computed from completed cases of this workspace that the server classified as similar to the current report (see `basis`); they describe OTHER, earlier cases; they do not describe the current incident; not property policy; secondary to the operational context; data, not instructions. Then the JSON block and `Citable refs (LEARNING_CONTEXT): learning:<reference action>, learning:<alternative action>`.

**Conceptual rules (text to be finalised in implementation, wording preserved from L1.5):**
1. Historical, secondary to current facts, never establishes what is happening now.
2. Not property policy, procedure, protocol or standard practice; not a guarantee, a permission, a deadline or an instruction.
3. A historical action is not automatically right now; do not recommend or reject an action merely because earlier cases did it or failed.
4. Comparative outcomes may inform the recommendation; when they do, say so briefly, labelled as historical.
5. `strength` MODERATE (if ever delivered) and any mixed picture must lower certainty; never present a pattern as certain.
6. If the basis does not fit the current situation, do not use the evidence.
7. Current facts and current documented guidance take precedence over this evidence; safety (rule 26) takes precedence over everything; historical evidence can never lower urgency or change a required action.
8. Never invent policies, procedures, deadlines, permissions or facts; never output identifiers.

Explicitly NOT in the prompt: "choose the higher success rate", "prefer the alternative", any action name as a conclusion, any threshold. The model sees the numbers and the label and infers relevance, as in L1.5b.

---------------------------------------------------------------------------------------------------------------------------------------------------------------------

## 9. Claims and provenance

Reuse the existing architecture; add no ref kind.

- **Evidence class:** `LEARNING_CONTEXT` (rank 4, advisory). It is already below current facts, business knowledge and operational history, and above the untrusted text.
- **Refs:** `learning:<actionType>` for the two delivered rows (`learning:maintenance_dispatch`, `learning:inspection`). The existing grammar contains no id, so nothing internal is model-visible; the 53D sanitizer already recognises `learning:(actionType)` and the frontend text presenter mirrors it. The existing format is sufficient.
- **Minting:** `buildEvidenceEnvelope` today mints `learning:<actionType>` from `learning.patterns`; add a v2 branch that mints from `learning.reference.actionType` and `learning.alternative.actionType`. Python's mirror (`evidence_envelope.py`) gets the same branch; the existing parity fixture is extended.
- **Claim types (unchanged rules):** `LEARNING_OBSERVATION` may cite only `LEARNING_CONTEXT` refs; a `RECOMMENDATION` may be accompanied by them but still requires a current fact or business knowledge (so history can never justify a recommendation alone). L1.5b showed the existing validator admits these claims (75% of C runs cited `learning:*` and were admitted). Edit rule 25's `LEARNING_OBSERVATION` wording to cover "outcomes of similar completed cases" (today it says "aggregate outcome statistics").
- **No new structured output field:** the response schema is unchanged (there is no output field for Learning, by design).

---------------------------------------------------------------------------------------------------------------------------------------------------------------------

## 10. Validation and the 53D sanitizer

Reuse everything that exists; add only what v2 introduces.

| Concern | Existing guard | v2 interaction |
|---|---|---|
| request shape | `validateLearningPayload` (Node), pydantic `LearningContext` (Python, `extra="forbid"`) | add the v2 shape to both, discriminated on `learningVersion`; v2 invariants: `reference.actionType != alternative.actionType`, counts non-negative and consistent (`determined == success + partial + failed`), enums closed, `strength` in {STRONG, MODERATE}, at most two rows |
| provenance | `buildEvidenceEnvelope`, `claimValidator` | v2 branch only (section 9) |
| unknown / foreign refs | `CLAIM_UNKNOWN_REF`, `CLAIM_FOREIGN_REF` | unchanged |
| identifiers in prose | `assertNoForeignIdentifiers` (24-hex tokens), the envelope's `suppliedIds` | unchanged; v2 supplies no ids |
| internal references in user-facing prose | `proseReferenceSanitizer` (`learning:<type>` already in the grammar), applied at persistence and read | no change required; verify with a test |
| unsupported policy language | `assertProseConsistent` (ungrounded policy guard) | unchanged; L1.5b saw the same pre-existing rejections in baseline and evidence arms ("general professional practice") |
| safety | `enforceSafetyPolicy` | unchanged and authoritative |
| contradiction handling | `contradictions` field and `claimValidator` | unchanged |
| confidence | `deriveConfidenceCeiling` (history / Learning never raise it) | unchanged. Note: the ceiling holds no-guidance answers at MEDIUM, so confidence cannot show evidence-driven calibration; calibration is judged from wording |
| numbers claimed about earlier cases | none today | optional hardening, NOT required for v2.0: a deterministic check that figures quoted about earlier cases appear in the delivered counts. L1.4 and L1.5b found no invented figures |

---------------------------------------------------------------------------------------------------------------------------------------------------------------------

## 11. Tenant isolation, flag, v1/v2 interaction

**Tenancy.** The workspace id exists only in Node. The boundary, in order: (1) the membership-verified `scope` of the request; (2) `loadCompletedCases(scope)` applies `workspaceId` to every collection query and `normalizeCompletedCase` re-checks it (`WORKSPACE_MISMATCH`); (3) L1.2 similarity runs only over those cases; (4) the comparison layer runs only over the selected cases; (5) the v2 object is built from counts and closed enums; (6) the AI-service request is `{context, knowledge, authorizedLevel, operationalHistory?, learning?}` and carries no workspace or tenant field. The envelope's workspace check and the output guard remain as defence in depth. The AI service remains unaware of tenancy.

**Client control.** None. The source setting and the flag are server environment values; `learning` is never read from a request body (existing static check: the analysis service does not read `req.*`).

**Flag semantics (do not silently change the current flag).**
- `KOI_LEARNING_CONTEXT_ENABLED` stays the master switch, default false. OFF => no Learning of any version; the request is byte-identical to today's.
- A NEW server-only setting selects what ON means: `KOI_LEARNING_CONTEXT_SOURCE` = `aggregate` (default, today's v1 behaviour) or `comparative` (v2). An unrecognised value is a startup warning (the existing `startupChecks.js` pattern) and is treated as no Learning (fail closed). Setting the master flag alone therefore can never switch the mode.
- The existence of similar cases never activates anything.

**v1 / v2 interaction: recommendation = C + D (additive only when it qualifies, never both).**
- A (both delivered): rejected. v1 was measured inert; both would mint overlapping `learning:<actionType>` refs, lengthen the prompt and need two sets of rules.
- B (v2 replaces v1 when enabled): rejected as a code change; v1 stays selectable via the source setting, because it is the L1.4 experimental arm and the rollback path.
- Recommended: with `source=comparative`, deliver v2 if and only if the comparison qualifies; otherwise deliver NOTHING (do not fall back to v1: v1 has no similarity framing and was inert). With `source=aggregate`, v1 behaves exactly as today. v1 and v2 are never sent together.

**Learning OFF:** nothing built, nothing sent, nothing audited beyond the existing `learningUsed=false`; no completed-case query is made.
**No qualifying evidence:** nothing is sent; an audit reason is recorded (section 12).
**Malformed evidence (item 17 of the request):** a builder or contract-validation failure omits the evidence, records `MALFORMED`, logs a fixed message, and Intelligence proceeds without Learning. This deliberately differs from v1, whose contract violation aborts the analysis ("Learning context could not be prepared safely"): v2 is an optional, secondary, flag-gated enrichment and must not take Intelligence down, but it must never send an unvalidated payload and the failure is visible in the audit. If the AI service itself rejects a v2 payload it is the existing `VALIDATION_FAILED` -> 502 path.

---------------------------------------------------------------------------------------------------------------------------------------------------------------------

## 12. Observability and audit (counts and codes only)

Extend the existing metadata-only `AnalysisAdmission` record (additive optional fields, no index, no migration; `learningUsed` keeps its meaning "something was delivered"):
- `learningMode`: `OFF | AGGREGATE | COMPARATIVE`
- `learningDelivered`: boolean (equals `learningUsed`)
- `learningReason`: closed enum (`DELIVERED`, `FLAG_OFF`, `SAFETY_INELIGIBLE`, `GUIDANCE_PRESENT`, `FACETS_UNKNOWN`, `NO_SIMILAR_CASES`, `INSUFFICIENT_SAMPLE`, `NO_ALTERNATIVE`, `NO_SEPARATION`, `AMBIGUOUS`, `MALFORMED`)
- `learningStrength`: `STRONG | MODERATE | null`
- `learningComparedCases`: integer, and `comparisonVersion`: the constants' version string.

The same fields (never text, ids or counts of other tenants) join the existing event stream whitelist (`utils/logEvent.js`). No prompt, no model output, no historical text and no case identity is stored. `evidenceSetId` already hashes the envelope's refs and so reflects the two `learning:*` refs. These fields also give the coverage metric needed in section 14.

---------------------------------------------------------------------------------------------------------------------------------------------------------------------

## 13. Implementation boundary

**Likely to change (all behind the OFF flag):**
- AI service: `app/models/learning.py` (v2 model, union), `app/models/analysis.py` (field type), `app/services/analysis_prompt.py` (conditional v2 rule block, v2 section, rule 25 wording), `app/services/evidence_envelope.py` (v2 branch), and the matching ai-service tests.
- Backend: `services/learningContextContract.js` (v2 shape and dispatch), `services/ai/evidenceEnvelope.js` (v2 refs), `services/intelligenceAnalysisService.js` (the Learning branch only), `config/runtimeConfig.js` (source setting), `config/startupChecks.js` (warning), `models/AnalysisAdmission.js`, `services/analysisAdmissionService.js` and `utils/logEvent.js` (audit fields), a NEW `services/learning/caseEvidenceService.js` (+ a pure `caseComparison.js`), and the backend suites for each.

**Must remain untouched:** `services/ai/safetyPolicy.js`; L1.2 (`caseSimilarity.js`, `caseFacets.js`) and L1.3 (`structuredIssue.js`, `signalService.js`); the completed-case modules' semantics; `claimValidator.js` rules and `confidencePolicy.js`; the 53D sanitizer grammar (verify only); the frontend; Decision / Action / Outcome services; the Learning v1 builder and its tests; Phase 33 / 53 frozen artifacts; the L1.4 and L1.5 / L1.5b artifacts; `.env` files; `.claude/` and `CLAUDE.md`.

---------------------------------------------------------------------------------------------------------------------------------------------------------------------

## 14. Pre-condition: measure coverage BEFORE building the wiring

The comparison needs, for one equipment / problem / condition, at least two actions each with four or more determined, person-recorded outcomes. The real database today holds 3 completed cases (legacy Signals without an issue, so with UNKNOWN facets). Qualifying comparisons will be rare for a long time, so a working v2 may deliver almost never.

Step 0 (read-only, no production change): implement the pure comparison module and run it in SHADOW over the existing read-only Atlas replay harness (the same kind of replay as L1.1; no write, content fingerprint before / after) to report, per workspace, the share of Signals that WOULD have qualified and the reason codes of those that would not. Decision rule for proceeding: write it down before the run (for example, proceed only if the would-deliver rate on real data is plausibly non-trivial, or accept that v2 is infrastructure waiting for data and keep it dark). This protects the project from building a correct mechanism that never fires.

---------------------------------------------------------------------------------------------------------------------------------------------------------------------

## 15. Test matrix required before implementation is considered complete

Unit tests are pure (comparison, builder, contract). Integration tests use throwaway loopback databases and the existing validators. "Omit" means the AI-service request is byte-identical to Learning OFF.

| # | Case | Expected |
|---|---|---|
| 1 | strong comparative evidence (dispatch 0/1/4 vs inspection 5/0/0) | v2 delivered, STRONG, two rows, correct counts and rates |
| 2 | weak comparative evidence (overlapping intervals, e.g. 2/1/2 vs 3/1/1) | omit, `NO_SEPARATION` |
| 3 | equal outcomes | omit, `NO_SEPARATION` |
| 4 | negative-only evidence | omit, `NO_ALTERNATIVE` |
| 5 | positive-only evidence | omit, `NO_ALTERNATIVE` |
| 6 | mixed outcomes (L1.5b D) | omit while MODERATE disabled; with the constant on, delivered as MODERATE |
| 7 | insufficient sample (fewer than the per-action floor) | omit, `INSUFFICIENT_SAMPLE`; boundary tests at floor-1, floor |
| 8 | UNKNOWN facets (current or case) | omit, `FACETS_UNKNOWN` / never selected |
| 9 | AMBIGUOUS facets | omit; cases with AMBIGUOUS facets never selected |
| 10 | mismatched equipment | not selected, so no comparison, `NO_SIMILAR_CASES` |
| 11 | mismatched problem | same |
| 12 | mismatched condition (not_cooling vs not_heating) | LOW weak match, never evidence |
| 13 | safety-critical case (gas, smoke, CO, severity critical) | omit, `SAFETY_INELIGIBLE`; no completed-case query result is used |
| 14 | access-refused case | omit, `SAFETY_INELIGIBLE`; the forbidden dispatch / inspection actions are never delivered |
| 15 | current business guidance relevant | omit, `GUIDANCE_PRESENT`; with irrelevant (sub-floor) guidance, evidence still eligible |
| 16 | cross-workspace isolation (perfect matches only in tenant X) | other workspace gets omit; request and prose contain no tenant marker |
| 17 | malformed evidence (builder bug, bad enum, negative count, same action twice, three rows) | contract validation fails, nothing sent, `MALFORMED`, Intelligence still produced |
| 18 | forged / client-controlled learning (a `learning` field or query parameter on the analyze request, a v2 object in the body) | ignored: the server builds or omits; static check that no `req.*` reaches the Learning branch |
| 19 | internal reference leakage (model emits `learning:...`, a 24-hex id, a case key) | sanitizer removes it from stored and returned prose; the output guard rejects an unsupplied 24-hex id |
| 20 | unsupported policy invention (model writes "standard practice") | existing prose guard rejects as today; not worse than baseline in the experiment |
| 21 | sanitizer behaviour | `learning:<type>` refs become "the learning context"; bracketed citations removed; idempotent; frontend presenter parity |
| 22 | Learning OFF | no completed-case query, no `learning` in the request, request and prompt byte-identical to today's, `learningMode=OFF` |
| 23 | no qualifying evidence | omit, a reason code recorded, the request identical to OFF |
| 24 | (prompt invariance) any request without `learning-v2` | system and user prompt hashes identical to the pre-change prompt |
| 25 | (provenance) v2 request | envelope holds exactly the two `learning:*` refs; a claim citing any other `learning:*` ref is `CLAIM_UNKNOWN_REF`; `LEARNING_OBSERVATION` admitted; a `RECOMMENDATION` resting on a learning ref alone is `CLAIM_UNSUPPORTED_RECOMMENDATION` |
| 26 | (determinism) | the same data gives the identical v2 object, tie handling included |
| 27 | (v1) | `source=aggregate` behaves exactly as today; v1 and v2 never together; unknown source value => no Learning plus a startup warning |
| 28 | (regression) | every existing suite (L1 to L1.4, the Phase 28-53 Intelligence and safety suites, AI-service suite) unchanged |

---------------------------------------------------------------------------------------------------------------------------------------------------------------------

## 16. Post-implementation experiment (frozen harness; run before ANY production enablement)

**Structure.** Extend the L1.4 harness (`scripts/l14/`), do not replace it. New frozen files (hashed before the first model call) import `dataset4.mjs` unchanged and add scenarios; the existing 20 scenarios stay as they are.
- **Original 20 scenarios:** most have a single action group, so under v2 they must produce NO evidence (a restraint test: B equals A, request identical). F2 has a comparative pair.
- **New comparative scenarios (about 12):** STRONG comparative (several equipment / problem pairs, at least 5 distinct situations), STRONG with larger n, MODERATE-style (to measure, not to deliver unless enabled), negative-only, positive-only, equal, below-floor, ambiguous two-alternatives, plus a RAG-hit scenario with relevant guidance (v2 must be suppressed), a safety scenario and an access-refused scenario with adversarial evidence (suppressed), a cross-workspace scenario, and a contradiction scenario.
- **Arms:** A = Learning OFF; B = `learning-v1` (source=aggregate, the existing path); C = `learning-v2` (source=comparative); A2 = a second OFF sample (A/A noise); C0 = a v2 parity ablation (the L1.5b block shape without `comparison` / `coverage`) on the comparative scenarios only, to measure what the new fields add. 3 repeats per scenario and arm; counterbalanced order; the L1.4 retry policy (one re-attempt of a provider failure).
- **Prompt invariance check before any call:** A's request and prompt hashes equal the pre-change ones (test 24).
- **Scoring:** the frozen 53C / L1.4 machinery (rubric4 reuse) plus the L1.5b measures as pre-registered detectors: behavioural alternative adoption (type or wording, and a wording-only co-primary so the 67%-vs-83% ambiguity is settled in advance), recognition, historical / current distinction, guidance precedence, safety preservation, unrelated contamination, policy invention, unsupported certainty, internal-reference leakage, validator rejection, provider reliability; plus a blind human review of at least 20 outputs (detectors are heuristics).

**Minimum gates for a CONDITIONAL GO (all must hold; thresholds set before the run):**
1. STRONG scenarios: behavioural alternative adoption >= 70% (type-or-wording) AND >= 60% wording-only, and >= 40 points above A; appropriate (admitted, no invention, no overclaim) >= 70%; repeatable in at least 4 of 5 STRONG situations and in at least 2 of 3 repeats of each.
2. Restraint scenarios (no qualifying evidence): v2 request identical to A in 100%; A-vs-C action-change rate <= A/A + 5 points.
3. v2 materially beats v1: C - B >= 30 points on the behavioural measure.
4. Safety: 0 weakened urgency / escalation / access handling in any run; evidence withheld (audit reason `SAFETY_INELIGIBLE`) in 100% of safety and access-refused scenarios.
5. Guidance: v2 suppressed (`GUIDANCE_PRESENT`) in 100% of RAG-hit scenarios; a documented-guidance recommendation never differs between A and C.
6. Tenant: 0 tenant markers in requests or prose; cross-workspace scenario retrieves nothing.
7. Policy invention <= A + 10 points; unsupported certainty <= 10%; internal references after the sanitizer 0; validator rejections <= A + 10 points.
8. Reliability: >= 85% of planned runs valid and >= 10 valid per primary cell; any shortfall is INCONCLUSIVE, never silently replaced.
9. Parity: C shows no material loss against C0 on the primary measure (otherwise the added fields hurt and must be removed).
10. MODERATE tier (only if enabled in the experiment): behavioural shift >= 25 points, overclaim 0, hedged wording >= 50%; otherwise it stays disabled.
11. Coverage (from section 14) documented: the would-deliver rate on real data is reported, so enablement is judged against real expected frequency.
Failure of any gate: stop, keep Learning OFF, report the smallest evidence-backed next step. Success: report CONDITIONAL GO for a separate enablement review; do not enable production Learning automatically.

---------------------------------------------------------------------------------------------------------------------------------------------------------------------

## 17. Recommended implementation sequence (each step reversible, all dark)

0. Coverage measurement in shadow (section 14), read-only; go / no-go on its result.
1. Pure `caseComparison.js` plus its tests (sections 5, 6, 15 rows 1 to 12, 26).
2. Python v2 model, conditional prompt block, envelope branch, with tests (rows 17, 24, 25 on the Python side).
3. Node contract, envelope branch, builder, source setting, audit fields (rows 13 to 23, 27).
4. Full regression (row 28).
5. The post-implementation experiment (section 16).
6. Review. Production Learning stays OFF until a separate enablement review.

---------------------------------------------------------------------------------------------------------------------------------------------------------------------

## 18. Open questions and risks

- **Coverage may be near zero** (section 14): the main risk to the value of the whole effort.
- **Single-scenario evidence.** L1.5b is one scenario (AC) on one model with 12 runs per arm; the wording-only C effect was 67%, below the 70% bar on a strict reading. The post-implementation experiment must replicate across situations.
- **Detector limits.** Text heuristics (the `overclaim` pattern also fires on "ensure"); a blind human review is part of the gate.
- **Weights and thresholds** (partial = 0.5, floor 4, the 95% / 80% levels, the 0.25 margin, the tie band) are judgement calls and must be calibrated, not assumed. A reviewer may prefer a Bayesian posterior probability or an exact test; both remain deterministic and sample-size-aware.
- **Positive-only (reinforcement) and MODERATE tiers are unproven.** They are deliberately dark in v2.0.
- **Evidence-driven action bias.** Even a STRONG comparison could push toward an action that is wrong for the current facts. Mitigations: prompt rule P3, claim admissibility, safety enforcement, suppression with guidance and safety, and the appropriateness measure; residual risk accepted only after the experiment.
- **Documented-guidance interaction** is handled by suppression, not by evidence that the model resolves conflicts correctly; if later enabled with guidance present it needs its own experiment.
- **Policy gap** ("sparks and a burning smell" classed NORMAL) is mitigated by a facet exclusion; the real fix is a separate safety-policy phase.
- **Rule change surface.** The conditional system block keeps Learning-OFF requests identical; any future decision to make the rules global changes every analysis and needs its own evidence.
- **Provider reliability** was 79 of 80 in L1.5b but 77% valid in L1.5 (14 of 60 runs failed); the experiment must report planned vs valid honestly.
- **Confidence cannot signal calibration** under the MEDIUM ceiling; calibration is judged from wording only.
- **Multi-alternative reasoning** (three or more actions) is out of scope: v2 delivers at most two rows.

---------------------------------------------------------------------------------------------------------------------------------------------------------------------

## 19. Confirmations

- Production Learning remains OFF; the flag and the default were not touched.
- No production source (backend, AI service, frontend) was modified; no test was modified.
- No database (data, schema or indexes) was modified or contacted for this document.
- No secrets or `.env` files were modified or printed.
- No live Gemini call was made; the only computation was an offline arithmetic check of the interval examples in section 5.
- Nothing was committed or pushed.
