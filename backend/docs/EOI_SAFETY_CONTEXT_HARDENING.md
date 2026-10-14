# EOI — Safety Posture + Context Quality Hardening

Workstream scope: the two P2 weaknesses recorded in `EOI_CORE_ACCEPTANCE_TEST.md`.

- **P2-A** — vague / possible-hazard wording stays Normal; an access refusal plus a hazard is detected during analysis but is not carried strongly into the Decision/Action boundary.
- **P2-B** — relevant prior operational history is supplied to the model but is not surfaced when the current issue is a recurrence.

Nothing was committed, pushed or deployed. Learning stays OFF and untouched. No prompt, model, provider timeout, RAG semantics or general Decision/Action workflow was changed. `.claude/`, `CLAUDE.md` and `.env` files were not touched.

**FINAL GATE: BLOCKED** — one safety-policy decision is still required (section 4). Everything else in the workstream is delivered and verified.

---

## 1. Problem statement

1. **Access refusal was not carried to the Action stage.** The existing safety policy forbids `maintenance_dispatch` and `inspection` when access is refused (both need entry). The rule was applied while the analysis was admitted, but only its *result* (state / urgency / recommended action type) was stored. At the Action stage nothing knew access had been refused, so a refusal-only case allowed a `maintenance_dispatch` Action, and a hazard-plus-refusal case still permitted `maintenance_dispatch` alongside `escalation`.
2. **Vague hazard wording stays Normal.** Wording such as "suspected hazardous condition" is outside the policy's closed hazard list, so the deterministic policy does not classify it as a hazard. Whether and how that should change is a product/safety decision, not an engineering one (section 4).
3. **Recurrence was invisible.** A repeat report (same room, same kind of problem) had its history passed to the model as optional context, but nothing deterministic told the operator "this has been reported before for this room", and nothing showed what a person recorded after the earlier report.

## 2. Existing authoritative safety behavior

Authoritative source: `backend/src/services/ai/safetyPolicy.js` (deterministic; derived from the **current Signal text only**; never from the model).

| Rule code | Trigger (existing) | Effect (existing) |
|---|---|---|
| `SEVERITY_CRITICAL` | existing severity classification | critical urgency / escalation recommendation |
| `LIFE_SAFETY_HAZARD` | closed word list: gas smell / gas leak, smoke, fire, carbon monoxide | state `LIFE_SAFETY_HAZARD`, immediate urgency, escalation recommended |
| `ACCESS_REFUSED` | existing refusal detection in the Signal text | `maintenance_dispatch` and `inspection` are not permitted; with a hazard the only permitted action is escalation |

The policy documents its own limits ("HONEST LIMITS"): wording outside the lists is not recognised. Those limits were **not** widened.

Pre-existing Action-stage rule: for a `LIFE_SAFETY_HAZARD` the permitted types were `escalation` and `maintenance_dispatch`.

## 3. Safety investigation

- The policy result was written to `Intelligence.safety` as `{state, urgency, recommendedActionType}`. The rule codes that produced it (`rules`) were computed and used for the audit log but were not persisted with the analysis.
- `actionService` therefore had no server-side record that access was refused. Only the model's text and the frontend could have expressed it.
- An access refusal on its own (no hazard) does **not** make a hazard. That distinction was kept: refusal alone changes only which action types are forbidden.
- Safety classification is derived from the Signal at intake / admission, not from the AI result. It was verified that it remains available while the AI call is in progress or has failed (suite section F / AnalysisAttempt states).

## 4. Safety decision required

**Yes — one decision is required and was deliberately NOT implemented.**

**Case H — vague hazard wording.**

- *Current behavior:* "Room 165: the guest refuses entry to the room, and there is a suspected hazardous condition." is classified **Normal** by the policy (only the refusal is recognised). The model, on the real replay, returned urgency Immediate and an escalation recommendation, but the validated safety state remains Normal. Electrical-fire cues without the listed words behave the same way.
- *Ambiguity:* the closed hazard list is the only authority. Deciding that "suspected hazardous condition", "sparks", "burning smell", "exposed wiring", etc. are life-safety hazards is a new safety definition. Treating every "possible" or "suspected" hazard as a hazard would also raise the false-positive rate on ordinary reports, and the cost of that is an operations decision.
- *Affected workflow:* analysis admission (`safetyPolicy.js` state), the Decision priority derived from it, and the Action-type restriction for hazards (escalation-only with refusal).
- *Exact decision needed from the safety / product owner:*
  1. Which additional wordings (if any) must be treated as `LIFE_SAFETY_HAZARD`?
  2. Should an unrecognised-but-suspected hazard be a new, weaker state (for example "needs human safety review") or remain Normal with the model's urgency shown?
  3. What is the accepted false-positive trade-off?

Until that is answered, vague-hazard wording is a documented, unchanged limitation. Access refusal alone was **not** promoted to a hazard.

## 5. Safety changes (implemented)

All changes carry the **existing** policy to the Action boundary. No new prohibition, procedure, contact, role or deadline was added.

| File | Change |
|---|---|
| `backend/src/models/Intelligence.js` | exports closed `SAFETY_RULE_CODES`; `safety.rules` stored as an enum-restricted array (absent = "not recorded", so older records keep working) |
| `backend/src/services/intelligenceAnalysisService.js` | persists the policy's rule codes with the safety result |
| `backend/src/services/intelligenceService.js` | writes / reads `safety.rules` (closed-list filtered); view omits it when empty |
| `backend/src/services/actionService.js` | `ACCESS_REFUSED` stored with the analysis → `maintenance_dispatch` / `inspection` rejected with `409 ACTION_TYPE_CONFLICTS_WITH_SAFETY`; hazard **plus** refusal → permitted type is `escalation` only (also when no type was recorded) |
| `frontend/src/features/intelligence/safetyMapping.js` | passes `rules` through |
| `frontend/src/features/intelligence/safetyPresentation.js` | words for the existing restriction, keyed on the exact code `ACCESS_REFUSED` |
| `frontend/src/features/intelligence/SafetyAssessment.jsx` | shows the restriction line in the quiet and the alert blocks |
| `frontend/src/styles/assistant.css` | `.safety-refusal-note` style |

Shown to the user, for refusal only: "Access was refused in this report. Under the safety rules, maintenance dispatch and inspection (which need entry) are not permitted." For hazard + refusal: "…the only permitted action type is escalation."

## 6. Context / history investigation

- Operational history reached the model only as optional "clearly labelled prior context" (evidence class `OPERATIONAL_HISTORY`, third in the prompt's precedence). It was never surfaced to the human reading the case and was never determined by a deterministic rule.
- Each Signal already carries a server-derived structured issue (`Signal.issue`: equipment, problem family, condition, `source: SERVER_DERIVED`) over a closed vocabulary where UNKNOWN / AMBIGUOUS never match. That is the same trusted basis the L1.2 structured-similarity work uses. It was reused; no new text-similarity, embedding or model call was introduced.
- Outcomes are person-recorded and already role-restricted (`decision:review`); that existing permission is reused.

## 7. Recurrence rule

Implemented in `backend/src/services/recurrence.js` (pure, no I/O) and `signalRecurrenceService.js` (workspace-scoped loading). An earlier report counts as a recurrence **only if all** hold:

1. Both Signals have a trusted structured issue (current version, `SERVER_DERIVED`, closed vocabulary). A legacy Signal without one never matches.
2. Same workspace (every query filters `workspaceId`) and **same unit/room**. Same equipment in another room is not a room recurrence.
3. The earlier Signal is strictly earlier and a different Signal.
4. Equipment is known on both sides and equal.
5. Problem family is known on both sides and equal.
6. Condition is compatible: equal and known (`same`), or not recorded on at least one side (`not_recorded`, stated as such). Two different known conditions (not cooling vs not heating) or an ambiguous condition: no claim.

At most 3 newest matches. Free-text similarity is never used. The result is recomputed from stored records on every read, can't be set by a client, and is not called Learning. `GET /api/signals/:id/context` now includes `recurrence: {version, detected, scope, matches:[{reportedAt, issue:{equipment, problem, condition}, condition, outcome?}]}` with no record ids.

## 8. Historical evidence behavior

- The page says only that an earlier report about the same kind of problem is **on record** for this room, with its date. No cause, no "always", no "best action", no prediction.
- Wording is chosen by `recurrencePresentation.js` from exact-match tables over the closed vocabulary; an unknown value is left out, never guessed.
- A recorded Outcome of the earlier report appears only for callers who may already read Outcomes (`decision:review`) and only when the parent Intelligence is visible at the caller's knowledge level. It is labelled "What a person recorded for the earlier report of …" with the person's own words, and is visibly separate from the current facts.
- A fixed caveat is always shown: "This is a match between records only. It does not say why it happened or what will work this time."
- The model prompt, contract and Gemini configuration are unchanged; recurrence is not sent to the model. (Making recurrence visible to the model would need a contract/prompt change and is left as a documented option, not done.)

Files: `backend/src/services/recurrence.js` (new), `backend/src/services/signalRecurrenceService.js` (new), `backend/src/controllers/signalController.js`, `frontend/src/features/assistant/recurrencePresentation.js` (new), `assistantMapping.js`, `SignalCaseCard.jsx`, `frontend/src/styles/assistant.css`.

## 9. Test matrix

New suite `backend/scripts/validate-safety-context-hardening.mjs` — **46 passed, 0 failed** (isolated database, deterministic test AI service, dropped afterwards). Checks D3 and D7 fail against the old Action behavior, confirming the suite detects the weakness.

| Case (task letters) | Suite checks | What it proves | Result |
|---|---|---|---|
| Existing policy unchanged | A1, A2, A3, A5 | stored rule codes equal the codes the existing policy can emit; refusal alone is not a hazard; hazard + refusal permits only escalation; the policy source (closed word lists, "HONEST LIMITS") is unchanged | pass |
| A–E recurrence (pure rule) | B1–B8 | no earlier report: none; same room + equipment + problem + condition: recurrence; other room: none; similar wording but different structured issue: none; insufficient structured information (legacy, UNKNOWN, AMBIGUOUS): none; different known conditions: none; strictly earlier only, newest first, max 3; model-free, deterministic | pass |
| A–E recurrence (real backend) | C1–C9 | context response otherwise unchanged; earlier case completed; recurrence on the same room; outcome visible to reviewer/admin, hidden from operator/viewer; other room none; different issue none; legacy / UNKNOWN / AMBIGUOUS prior none; stable on re-read, later reports never evidence; **tenant isolation** (other workspace never counts, 404 across workspaces) | pass |
| F refusal without hazard | D1–D5, D10 | stored as NORMAL with rule `ACCESS_REFUSED`; dispatch/inspection refused (409 `ACTION_TYPE_CONFLICTS_WITH_SAFETY`); guest_communication / escalation / default still allowed; no invented hazard gating; legacy records without stored rules behave as before | pass |
| G hazard + refusal | D6–D9 | both rules stored; escalation only, even when no type was recorded; hazard without refusal unchanged; life-safety rejection still needs a reason and alternative | pass |
| H vague hazard wording | A4 | pins the current behavior (Normal) as an **open policy question**; nothing implemented | **BLOCKED — decision required (section 4)** |
| I AI failed | D-I, D-I2 | attempt terminal `failed`; classification unchanged and readable; policy still says hazard; explicit retry stores hazard + rules | pass |
| J AI in progress | D-J, D-J2 | 202 / in_progress; same server-derived classification before and during; no Decision/Action can exist; one provider call | pass |
| Full lifecycle | F1–F4 | recurrence, normal and hazard + refusal cases each: one record of each type, one provider call, none on reload, history and safety persist; Learning stayed OFF and the model never received the new fields | pass |
| Frontend | G1–G6 | refusal wording from the server's rule code only; `mapSafety` passes codes through; repeat note states only a record match; nothing when no recurrence; no ids shown; no safety logic or storage in the page; L1.3 field-name guard holds | pass |

Real-Gemini replay (shipped defaults, real stack, API and browser as admin):

| Replay | Before | After |
|---|---|---|
| R2 "Room 204: AC not cooling again" (earlier 204 report with Success outcome) | no recurrence signal | recurrence detected; admin sees the outcome, operator does not |
| R4 "Room 312 AC not cooling" (earlier 312 report is a sink leak) | no recurrence signal | no recurrence (correct: different problem) |
| R5 refusal + vague hazard, `maintenance_dispatch` | **201 created** | **409** `ACTION_TYPE_CONFLICTS_WITH_SAFETY`; `inspection` 409; `guest_communication` allowed |
| R6 gas smell + refusal, `maintenance_dispatch` / `inspection` | dispatch permitted | both **409**; escalation only; full Decision → Action (Not Executed) → Outcome |
| R7 AC not cooling + refusal, `maintenance_dispatch` | not restricted (same code path as R5) | **409** |

Browser-verified as admin on the real frontend: recurrence note + outcome + caveat on the 204 case; refusal restriction under "Validated safety assessment: Normal · Urgency: Immediate · Escalation recommended" for 165; the alert block with the escalation-only line for 166.

## 10. Regression results

Verification levels: **implemented → unit tested → API tested → browser tested** (the new behavior reaches the last level; the sweep below is API/script level).

Guards updated for the intended change (narrowed, not weakened; each still enforces its original invariant):

| Suite | Check | Why it changed |
|---|---|---|
| `validate-phase43b1-safety-metadata.mjs` | F2, G1, G2, F7 | previously "rule codes are audit-only"; now "only the closed `safety.rules` list is stored; the `safetyRules` audit field name never appears" |
| `validate-phase43b2-safety-presentation.mjs` | M14 | refusal wording confined to `safetyPresentation.js`, gated on the exact `safety.rules.some((rule) => rule === "ACCESS_REFUSED")` |
| `validate-phase34c-evidence-guardrails.mjs` | I5 | only a source comment I wrote matched a claim-word regex; the comment was reworded, test unchanged |

Failure classification used: P0/P1/P2/P3 product, INFRA environment, TEST test defect.

**Final full backend sweep (all `scripts/validate-*.mjs`, default environment, compared with the Phase 5C baseline):** 67 suites exit 0 (baseline 66). No suite that passed in the baseline fails now, apart from the two environment/flake items below. Focused results:

| Suite | Result |
|---|---|
| `validate-safety-context-hardening` (new) | 46 passed, 0 failed |
| `validate-phase43b1-safety-metadata` | 47 passed, 0 failed |
| `validate-phase43b2-safety-presentation` | 48 passed, 0 failed |
| `validate-phase34c-evidence-guardrails` | 58 passed, 0 failed |
| `validate-phase43a`, `43b`, `43c`, `43d`, `34`, `34d` | all pass |
| `validate-learning-l1-3-structured-intake`, `l1-4`, `l1-case-based`, `l1-replay`, `learning`, `learning-patterns` | all pass (Learning untouched, still OFF) |
| `validate-outcome`, `phase48`, `phase49`, `phase50`, `phase52`, `phase53d`, `security-boundary`, `phase13`–`phase23` authorization/hardening | all pass |
| Stack-dependent suites re-run with the real service stack: `intelligence-analysis-api` 81/0, `knowledge-visibility-api` 144/0, `knowledge-embedding` 42/0, `phase24-canonical-intelligence` 60/0 | pass |

Failures, classified:

| Item | Class | Evidence |
|---|---|---|
| `phase45c-account-onboarding` C6 (once in the final sweep) | TEST (known intermittent) | re-run twice: 37 passed, 0 failed both times; unrelated to this work |
| `ai-service`, `api`, `import`, `dev-token`, `knowledge*`, `intelligence-persistence`, `provision-dev-identity` and similar in the default-environment run | INFRA | these suites need the live local stack or a Python service; they fail identically in the Phase 5C baseline (`api`, `dev-token`, `import`, `knowledge*`, `provision-dev-identity`) or pass when run with the stack (shown above). The 5C baseline had a stray AI service on :8000 that made some of them look different. |
| `phase24`, `27`, `29`–`33`, `33-real`, `38`, `41`, `45a`, `45b22`, `dashboard`, `phase26*` | pre-existing | the same failing checks with the same counts as the Phase 5C baseline (for example 27: 111/2, 29: 83/2, 45a: 68/6); none touches code changed here |

No P0/P1/P2/P3 regression was found in this workstream. No unrelated test was weakened; the only guards edited are the three listed above, each narrowed to the new closed contract and still enforcing its original invariant.

Cleanup: replay stack stopped (:5199, :5500, :8150), throwaway databases dropped, no Atlas connection, no commit, push or deploy.

## 11. Before / after behavior

**Safety**

| Situation | Before | After |
|---|---|---|
| Refusal only, request `maintenance_dispatch` or `inspection` | Action created | `409 ACTION_TYPE_CONFLICTS_WITH_SAFETY` |
| Refusal only, other types (`guest_communication`, `escalation`, `other`) | allowed | allowed |
| Hazard only | escalation or dispatch | unchanged |
| Hazard + refusal | escalation or dispatch | **escalation only**, also when no type was recorded |
| Refusal shown to the user | not shown | one plain line under the safety assessment |
| Refusal alone | Normal | still Normal (not promoted to a hazard) |
| Vague hazard wording | Normal | **unchanged — decision pending** |
| AI failed / in progress | safety from the Signal available | unchanged, verified |

**Recurrence**

| Situation | Before | After |
|---|---|---|
| Same room, same kind of problem reported before | history to the model only; nothing shown | "This looks like a repeat…" note with date, and (for reviewers/admins) what a person recorded |
| Other room / equipment / problem / different condition | n/a | no note |
| Legacy Signal with no structured issue | n/a | no note |
| Operator (no outcome permission) | n/a | note without outcome |

## 12. Remaining limitations

1. **Vague hazard wording is not recognised** (section 4). It remains Normal at the policy level; the model's own urgency/escalation is shown but is not authoritative.
2. Recurrence needs a trusted structured issue on both Signals; Signals created before structured intake never match. Recurrence is scoped to the same unit; the same fault across rooms is not claimed.
3. Recurrence is shown to the human only. The model does not receive it (would require a contract/prompt change).
4. The refusal restriction depends on the existing refusal detection wording; unusual phrasings of a refusal share the policy's documented limits.
5. Safety `rules` are absent on Intelligence records created before this change; for those, the Action-stage refusal restriction does not apply (the field means "not recorded").
6. Generated Intelligence persistence, authentication limits, and the provider-reliability items from earlier workstreams are unchanged and out of scope.

## 13. Pilot readiness assessment

For a **supervised** pilot, the two P2 weaknesses are materially reduced: refusal restrictions are now enforced server-side at the Action boundary, and recurrence is visible, deterministic and honestly worded. The remaining blocker is the **vague-hazard policy decision** (section 4): until the safety/product owner defines it, a supervised pilot should state that a human must treat any report containing hazard language outside the closed list as potentially urgent regardless of the displayed state, and the operator briefing should say so.

**Final gate: BLOCKED** (pending the safety-policy decision; no other blocker).

---

# Addendum: SAFETY_REVIEW_REQUIRED (owner-approved Option C)

This section records the policy decision taken after the BLOCKED gate above, and its implementation. It supersedes section 4 ("Safety decision required") and the "vague hazard wording" limitation in section 12 **for the five approved phrases only**. Nothing else in the sections above changed. Source of the decision: `EOI_VAGUE_HAZARD_POLICY_DECISION.md` (Option C).

## A1. Exact semantics

| State | Meaning | Source |
|---|---|---|
| `NORMAL` | no deterministic safety concern identified | policy |
| `CRITICAL` | Signal severity `critical` (unchanged, not redefined) | Signal severity |
| `SAFETY_REVIEW_REQUIRED` (new) | the report contains explicit wording for a **possible / uncertain** safety concern; a person must look at it before it is treated as completely ordinary | closed phrase list in the Signal text |
| `LIFE_SAFETY_HAZARD` | confirmed life-safety hazard, existing closed word list (unchanged) | policy |

`SAFETY_REVIEW_REQUIRED` does **not** establish a hazard, forces **no** escalation, no urgency, no action type, no priority and no risk, and forbids nothing. It adds no causal claim. Human review is the control point.

## A2. Exact closed cue list

Exactly five phrases, nothing else (no plurals, synonyms, stems, fuzzy, semantic or model matching):

1. `suspected hazardous condition`
2. `possible hazardous condition`
3. `potentially hazardous condition`
4. `suspected danger`
5. `possible danger`

Matching (in `backend/src/services/ai/safetyPolicy.js`, one anchored pattern): case-insensitive; NFKC-normalised; extra whitespace or a hyphen between the words is tolerated; word boundaries at both ends. Sentence or clause punctuation between the words (`. , ; :`) deliberately breaks the phrase. The user's text is never altered. Not cues (tested): "dangerous", "possible dangers", "suspected hazardous conditions", "unsuspected danger", "suspected hazard", "possible hazardous", and the vocabulary the owner excluded (sparks, burning smell, exposed wiring), which stays with the existing policy. Gas, smoke, fire and carbon monoxide remain `LIFE_SAFETY_HAZARD` exactly as before.

## A3. Precedence and interactions

- **Order:** `LIFE_SAFETY_HAZARD` > `CRITICAL` > `SAFETY_REVIEW_REQUIRED` > `NORMAL`.
- **With LIFE_SAFETY_HAZARD:** the hazard always wins. When a hazard is present the cue records nothing, so the result is byte-identical to the hazard without the cue; nothing is downgraded and the hazard presentation is unchanged.
- **With CRITICAL:** the state stays `CRITICAL` with the same requirements. The cue is only recorded as the rule `SAFETY_REVIEW_REQUIRED` so it is not lost. This is an interpretation of "do not repurpose CRITICAL" and is flagged for the owner (see A10).
- **With ACCESS_REFUSED:** independent. Refusal alone is not review-required. Refusal + cue gives `SAFETY_REVIEW_REQUIRED` + `ACCESS_REFUSED`. Every existing refusal restriction is unchanged: `maintenance_dispatch` and `inspection` stay `409 ACTION_TYPE_CONFLICTS_WITH_SAFETY`; `guest_communication` stays allowed; escalation is allowed but **not forced**; confirmed hazard + refusal stays escalation-only.

## A4. Persistence and historical records

- `Intelligence.safety.state` enum gains `SAFETY_REVIEW_REQUIRED`; `safety.rules` enum gains the rule code `SAFETY_REVIEW_REQUIRED` (one new code, no speculative codes). The result is written at the same boundary as before (the analysis pipeline, from the server-derived policy). The audit record `AnalysisAdmission` carries codes only, never Signal text.
- **Legacy records are untouched:** no migration, no backfill, no rewrite. A record stored as `NORMAL` stays `NORMAL` (verified: re-analysing returns the same record unchanged).
- A client cannot set the state or the rules (verified: spoofed bodies on `analyze` are ignored; no HTTP route creates or patches Intelligence).

## A5. Opt-in design (why Learning is untouched)

`deriveSafetyPolicy(context, { includeReviewRequired })` defaults to **false**; only the analysis pipeline passes `true`. Learning (`completedCase`, `caseSimilarity`, `caseLearningObservation`) and structured intake call the same function without the option, so they receive the three-state result they always had. Consequence, verified: a completed case stored with `SAFETY_REVIEW_REQUIRED` is **rejected by the existing Learning normaliser** (`SAFETY_INCONSISTENT`, fail closed), so the state cannot become Learning. No Learning file was edited.

## A6. Other consumers traced

| Consumer | Change |
|---|---|
| `analysisAdmissionService` / `AnalysisAdmission` | none (free string, at most 32 characters) |
| `intelligenceService.toSafetyView` | none (uses the model enum) |
| `proseConsistency` "ungrounded policy" check | `intelligenceAnalysisService` treats `SAFETY_REVIEW_REQUIRED` like `NORMAL` there, so the behaviour for these reports is exactly what it was before the state existed (one expression; guard `phase52 D6` updated to match) |
| `decisionService` (priority, rejection rules) | none: the state adds no requirement |
| `actionService` (constrained states, risk, refusal) | none: the state adds no restriction |
| Frontend | `safetyPresentation.js` (state label, calm note, no rejection requirement), `SafetyAssessment.jsx` (renders the note) |
| `ai-service`, prompts, model, timeouts, RAG, recurrence, Learning | none |

## A7. Frontend behaviour

Non-alert block: "Validated safety assessment: Safety review required · Urgency …" and the sentence "The report contains wording that indicates a possible safety concern. The concern has not been established as a confirmed hazard." With a refusal, both notes appear (review concern, then the unchanged refusal line). No alert role, no "hazard confirmed", "critical", "emergency" or "escalate immediately" wording. The hazard alert and the refusal wording are unchanged. Server and page agree: no extra rejection requirement.

## A8. Files changed

Backend: `src/services/ai/safetyPolicy.js`, `src/models/Intelligence.js`, `src/services/intelligenceAnalysisService.js`. Frontend: `features/intelligence/safetyPresentation.js`, `SafetyAssessment.jsx`. Tests: `scripts/validate-safety-review-required.mjs` (new); guards narrowed to the fourth state: `validate-phase43b1-safety-metadata.mjs`, `validate-phase43b2-safety-presentation.mjs`, `validate-safety-context-hardening.mjs` (A1, A4), `validate-phase52-correctness.mjs` (D6). Docs: this file.

## A9. Verification

- **New suite `validate-safety-review-required.mjs`: 56 passed, 0 failed** (isolated DB dropped, deterministic AI, zero Gemini). Covers the 26 required cases: ordinary; each of the five phrases; case, whitespace, punctuation and hyphen variants; "dangerous" not matching; gas / smoke / fire / CO; refusal alone; refusal + cue; hazard + cue (never downgraded); hazard + refusal; dispatch and inspection rejected under refusal; guest communication unchanged; legacy record unchanged; reload (no second analysis, no provider call); AI failed; AI in progress; cross-workspace (no leakage); viewer role; spoofed state and rules; Learning OFF; audit holds codes only; no prompt / AI-service / Decision / Action / recurrence / config source mentions the state.
- **Real stack (real Gemini, shipped defaults, isolated DB, API plus browser as admin), scenarios A–E:**
  - A "Room 204 has an issue; guest reports a suspected hazardous condition." stored `SAFETY_REVIEW_REQUIRED`, priority medium, assessment generated, dispatch accepted (nothing forced); the page shows the calm wording.
  - B gas smell: `LIFE_SAFETY_HAZARD`, priority critical, escalation with critical risk.
  - C refusal + vague wording: `SAFETY_REVIEW_REQUIRED` + `ACCESS_REFUSED`; dispatch 409, inspection 409, guest communication 201. (The model itself recommended escalation here; the server did not force it.) The page shows both notes and no alert.
  - D refusal + gas smell: `LIFE_SAFETY_HAZARD` + `ACCESS_REFUSED`; dispatch 409, inspection 409, escalation 201 with critical risk.
  - E ordinary: `NORMAL`, no rules.
  - Re-analysing each returned the same record (200), and after a browser reload the database still held exactly 5 analyses, 5 Decisions and 5 Actions; Learning was not used.
- **Regression:** full backend sweep, 68 suites exit 0 (previous 67; the new suite is the addition). One difference from the previous sweep: `phase52-correctness` D6 (a static check pinning the exact condition) failed because of the one-expression change above; it was updated narrowly and re-run: 39 passed, 0 failed. Every other non-zero suite shows the identical failures and counts as the Phase 5C and previous baselines (INFRA / pre-existing, for example `phase24`, `27`, `29`–`33`, `38`, `41`, `45a`, `45b22`, `dashboard`, `phase26*`, and the suites that need the live stack). With the live stack: `intelligence-analysis-api` 81/0, `knowledge-visibility-api` 144/0, `knowledge-embedding` 42/0, `phase24` 60/0. Safety / Decision / Action suites: `safety-context-hardening` 46/0, `43b1` 47/0, `43b2` 48/0, `34c` 58/0, `action` 76/0, `decision-v1` 145/0, `phase49` 49/0, `phase48` 45/0, `outcome` 73/0. L1.3 61/0, 5A 46/0, 5B 72/0, 5C 46/0. Frontend `npm run build` succeeds. `ai-service` tests were not run because nothing in `ai-service/` changed and no shared enum or schema reaches it.

## A10. Limitations and items for the owner

1. The cue list is closed. Plurals ("suspected hazardous conditions"), "possible hazard", "suspected hazard" and every other wording are not cues. Extending it is a new owner decision.
2. Negation is not understood: "no possible danger" still triggers the state (it can only raise a review, never lower anything).
3. The title and description are joined by a line break for matching, so a phrase split exactly across them can match.
4. A cue beside `CRITICAL` keeps the state `CRITICAL` and records the rule (interpretation, see A3). A cue beside a hazard records nothing. The owner may prefer a different recording rule.
5. The state does not add a "reason required to reject" rule (the decision document listed it as a possible consequence; the implementation instruction forbids new restrictions). It remains a possible follow-up decision.
6. Safety classification for in-progress or failed analyses is derived from the Signal by the deterministic policy and was verified; the audit record is written only when an analysis passes the safety stage, as before.
7. Learning excludes review-required completed cases (fail closed) by its existing consistency rule. If the owner later wants them in Learning, that is a Learning decision.
8. Records created before this change keep their stored state, so a historical report with these phrases remains `NORMAL`.

**Addendum gate: PASS** for the implementation as specified.
