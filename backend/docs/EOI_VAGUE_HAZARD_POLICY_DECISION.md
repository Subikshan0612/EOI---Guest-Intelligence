# EOI — Vague / Possible-Hazard Wording: Policy Decision Proposal

**Status: POLICY DECISION PENDING.** This is a proposal for the product / safety owner. It is **not** an approved policy. Nothing described here has been implemented, and no code, test, prompt, schema, frontend or configuration was changed to write it.

Sources read: `backend/docs/EOI_SAFETY_CONTEXT_HARDENING.md`, `backend/src/services/ai/safetyPolicy.js`, `backend/src/services/actionService.js` (Action-stage enforcement), `backend/src/services/decisionService.js` (priority and rejection rules), `backend/src/models/Intelligence.js` (stored safety state), `frontend/src/features/intelligence/safetyPresentation.js`.

---

## 0. The question and the facts it rests on

**Question.** The closed `LIFE_SAFETY_HAZARD` vocabulary recognises only gas smell/leak/fumes, smoke, fire and carbon monoxide. What should EOI do with wording that hints at a hazard but is outside that list?

**Reference case.** "Room 165: the guest refuses entry to the room, and there is a suspected hazardous condition." Other wordings identified in the hardening report: *sparks*, *burning smell*, *exposed wiring*.

**Facts (verified in the current code):**

1. `deriveSafetyPolicy` reads only the current Signal text and produces one of three states: `NORMAL`, `CRITICAL` (from Signal severity `critical`, not from text), `LIFE_SAFETY_HAZARD` (from the closed word list). The policy file states its own limit: "wording outside the lists is not recognized".
2. For the reference case the state is `NORMAL` with rule `ACCESS_REFUSED` only. On the real-model replay the model nevertheless answered urgency *Immediate* with an escalation recommendation, so the page shows "Normal · Urgency: Immediate · Escalation recommended". That mix is model output, not server-enforced policy.
3. What each state enforces today:

   | | NORMAL | CRITICAL | LIFE_SAFETY_HAZARD |
   |---|---|---|---|
   | Analysis admission | urgency/type only checked against refusal | urgency must be *immediate* | urgency *immediate*; type must be escalation or maintenance_dispatch (escalation only with refusal) |
   | Decision priority | from Signal severity | from Signal severity | forced *critical* |
   | Decision rejection | free | needs a recorded reason | needs a reason **and** what will be done instead |
   | Action type | free | must equal the validated recommended type | must equal the recommended type; if none recorded: escalation / dispatch (escalation only with refusal) |
   | Action risk | by type | raised to at least *high* | forced *critical* |
   | UI | quiet line | alert "CRITICAL SAFETY CONDITION" | alert "LIFE-SAFETY HAZARD" |

4. `ACCESS_REFUSED` is independent of all three states: it forbids `maintenance_dispatch` and `inspection` whenever it applies, and (new in the hardening work) is enforced at the Action stage. It alone never makes a hazard. **This proposal keeps that unchanged under every option.**
5. The safety state is a closed three-value enum in several places (the `Intelligence` model, `analysisAdmissionService`/`AnalysisAdmission` field, the frontend state table, the Learning case-similarity / completed-case code). Any new state touches all of them.
6. Existing precedent for a middle tier: `CRITICAL` already sits between Normal and hazard (an alert, a rejection reason, a minimum urgency, risk at least high, but no forced action type beyond the validated one). A new middle state would be a *second* middle tier, so its relationship to `CRITICAL` has to be defined.

**Honest limit common to every option.** All three rely on wording lists over untrusted Signal text. None of them recognises hazard wording that is not on a list. Options B and C change *which* wordings are on a list and what happens on a match; they do not make the policy a classifier. Wording nobody listed stays Normal.

---

## OPTION A — Keep vague hazards as NORMAL

1. **Definition.** No policy change. Only the existing closed hazard list produces `LIFE_SAFETY_HAZARD`. Vague, possible or unlisted hazard wording is `NORMAL` (plus `ACCESS_REFUSED` if refusal is stated).
2. **Example behavior.**
   - *Room 165 (refusal + suspected hazardous condition)*: state Normal; dispatch/inspection refused at the Action stage; guest communication / escalation / other allowed. The model may still recommend escalation at *Immediate* urgency, but nothing forces it.
   - *"sparks from the socket"*, *"burning smell"*, *"exposed wiring"*: state Normal; dispatch is permitted; Decision priority follows the Signal severity.
   - *"burning smell"* is partly caught if the text also contains "smell … gas" or "smoke"; otherwise not.
3. **Safety benefit.** Zero new false alarms. The existing hazard meaning stays sharp: when the system says "life-safety hazard" it is the closed, documented list, so the heavy rules (forced critical, reason + alternative to reject) keep their credibility. No new definition to defend.
4. **Safety risk.** A genuine possible hazard reaches a person as an ordinary case: no alert, no forced urgency, no required reason to set it aside, and a dispatch can be proposed and approved without any hazard gating. In the refused-access case the only protection is the refusal restriction. Reliance on the model's discretionary urgency is not a control.
5. **False-positive trade-off.** None added. The cost is false negatives, accepted by design.
6. **Operational impact.** Operators and reviewers must themselves recognise hazard language the system does not flag. The page can look reassuring ("Normal") next to an *Immediate / Escalation recommended* line, which is mixed. Training and a written instruction are the only mitigation.
7. **Implementation impact.** None. At most documentation (a pilot briefing). The existing suite check A4 keeps pinning the current behavior.
8. **Pilot impact.** Acceptable only if the pilot is closely supervised, the operator briefing states plainly that hazard wording outside the closed list is *not* flagged by the system, and the pilot volume is low enough that a person reads every report. Without that, this is the weakest option for a pilot with real guests.

---

## OPTION B — Expand LIFE_SAFETY_HAZARD

1. **Definition.** Widen the closed hazard list so additional wordings produce `LIFE_SAFETY_HAZARD` with everything that state already means. No new state.
2. **Example behavior.** *Room 165* (if "suspected hazardous condition" is added): state `LIFE_SAFETY_HAZARD` + `ACCESS_REFUSED`; urgency must be immediate; the only permitted action type is escalation; Decision priority critical; Action risk critical; rejecting the Decision needs a reason and an alternative. *"sparks"*, *"burning smell"*, *"exposed wiring"* (if added) behave the same, without refusal: escalation or dispatch.
3. **Safety benefit.** The strongest enforcement for the added wordings, using machinery that already exists and is tested. Simple for people to understand: "hazard" means hazard.
4. **Safety risk.** Dilution. If hazard wording is broad, the strongest state fires often, and operators may learn to treat it as noise, which weakens the true life-safety signal. A vague word such as "suspected" or "hazardous" has no clear boundary, so a list for it is arbitrary.
5. **False-positive trade-off.** Highest cost per false positive of any option, because `LIFE_SAFETY_HAZARD` is not advisory: it constrains the model's output (a response below the minimum is *rejected whole*, so a wrong flag can make an analysis fail with a 502 rather than merely warn), forces critical priority and risk, and obliges a reason *and* an alternative to reject. A false positive therefore costs operator time and can block an analysis; it cannot be downgraded by a person.
6. **Operational impact.**
   - *Categories to add (for the owner to choose, not proposed here as final):* electrical (sparks, burning smell, exposed wiring), generic possibility wording (suspected / possible hazardous or dangerous condition), and anything else the owner names.
   - *Maintenance / inspection / refusal:* with refusal the case is escalation-only; without refusal, dispatch is allowed alongside escalation. Both are the existing hazard rules, now applied to more reports. A refusal plus a vague hazard would remove dispatch and inspection and leave escalation as the only route.
   - *Governance:* the owner must govern the list: who may change it, how an addition is reviewed, and how a false positive is reported. Expanding it is a safety-policy change that should have a named approver and a record.
7. **Implementation impact.** Smallest code change: add patterns to `HAZARD_PATTERNS` plus tests. Persisted states and enums are unchanged. But the pattern work is the hard part: word boundaries and exclusions (as the current patterns have for "fireplace", "fire extinguisher", "gas stove") must be designed for each new term, and "suspected hazardous condition" has no safe exclusion set.
8. **Pilot impact.** Best protection for the chosen wordings; most likely to produce visible false alarms in the pilot, with no way for a person to dismiss them. A short, narrow list (electrical cues only) is realistic; including the generic "suspected hazard" wording is the high-false-positive part.

---

## OPTION C — Introduce an intermediate `SAFETY_REVIEW_REQUIRED` state

1. **Definition.** A fourth server-derived state meaning: *the report contains wording that may indicate a hazard but does not establish one; a person must look at it as a possible safety matter.* It is derived from a second closed list of "possible hazard" cues, separate from the confirmed-hazard list. Name and wording are provisional.

   **What it means:** "a human must assess this as a possible safety issue." **What it does not mean:** that a hazard exists; that dispatch or inspection is forbidden by itself; that any specific procedure, contact, role or deadline applies; that the model's recommendation is wrong.

   - *Versus NORMAL:* it is visible, recorded, and carries a small, defined set of requirements. NORMAL carries none.
   - *Versus LIFE_SAFETY_HAZARD:* it does not claim a hazard, does not force the action type, does not force risk to critical, and does not demand an alternative to reject.
   - *Versus CRITICAL:* CRITICAL comes from Signal severity, SAFETY_REVIEW_REQUIRED from wording; the owner must decide whether they are distinct states or whether the new cue should simply feed the existing `CRITICAL` handling (see questions).

2. **Example behavior.**
   - *Room 165 (refusal + suspected hazardous condition)*: state `SAFETY_REVIEW_REQUIRED` + rule `ACCESS_REFUSED`. The refusal restriction applies as today (no dispatch/inspection). The page shows a clearly marked "possible safety matter, review required" notice instead of "Normal".
   - *"sparks from the socket" with free access*: state `SAFETY_REVIEW_REQUIRED`; dispatch is not forbidden; the notice is shown; an approved Decision needs the reviewer to have seen the notice.
   - *Gas smell*: unchanged, still `LIFE_SAFETY_HAZARD`. Cues already on the confirmed list are never downgraded.
3. **Safety benefit.** Closes the "reads as Normal" gap for the examples without declaring a hazard. Because the requirements are lighter, the cue list can be broader than a hazard list at an acceptable cost. It keeps `LIFE_SAFETY_HAZARD` meaningful.
4. **Safety risk.** One more state to understand; the boundary between review and hazard is a judgement the owner must set. It may feel like a half-measure: a possible serious hazard (for example exposed wiring) is only "review", not "immediate escalation". The cue list is still closed and still misses unlisted wording.
5. **False-positive trade-off.** Cheaper per false positive than Option B: a false flag costs a visible notice and a recorded review step, but it does not force action type, risk, or rejection of the analysis. More flags will occur than under A, fewer consequences per flag than under B.
6. **Operational impact.**
   - *Logical Decision/Action restrictions (to be confirmed by the owner, not decided here):* the minimum that follows from "a person must review" is (a) the state is shown and persisted, (b) setting the recommendation aside needs a recorded reason (the same kind of rule `CRITICAL` has today), (c) no change to which action types are allowed, (d) no forced risk or priority change. Anything stronger, such as a minimum urgency or a risk floor, is a policy question for the owner.
   - *Access refusal interaction:* `ACCESS_REFUSED` keeps its own effect (no dispatch/inspection). Whether review-required **plus** refusal should additionally narrow to escalation-only, as hazard plus refusal does, is a decision for the owner. The safe default for the document is to keep the two rules independent and not to narrow.
   - *Operator experience:* a distinct, calmer notice than the hazard alert, so operators can tell "look at this" from "this is an emergency".
7. **Implementation impact.** Largest: a new state in the `Intelligence` model enum, in the admission record, in the frontend state table and presentation, in the Decision rejection rule, in the Action constraint set, and in the Learning code that currently enumerates the three states (`caseSimilarity`, `completedCase`, `caseLearningObservation`); a second cue list in the policy; new rule code if the owner wants it recorded separately; new tests including a "never downgrades a confirmed hazard" check. No change to the AI prompt is required (the policy already is server-side).
8. **Pilot impact.** Gives supervised pilot users an explicit "possible safety matter" notice for the known gaps, with limited downside. It adds one concept to the operator briefing and needs the owner's cue list before it can ship.

---

## RECOMMENDATION (a recommendation only, not an approved policy)

**Recommend Option C**, provided the owner approves a short, explicit cue list.

Reasons, from the existing architecture and the hardening findings:

- The gap found in the hardening work is *invisibility*: the reference case displays "Normal" next to a model-supplied "Immediate / Escalation recommended". Option A leaves that. Option C removes it with a visible server-owned state.
- The existing hazard state is deliberately heavy (forced critical priority and risk, reason and alternative to reject, whole-response rejection when the model undershoots). Option B would apply that weight to reports that only *might* describe a hazard, with no way for a person to downgrade a false flag. That is the opposite of how the existing design treats uncertainty.
- The architecture already has an intermediate tier (`CRITICAL`) with light, defined requirements, so a middle level is consistent with how the system is built. The policy file's own principle also supports it: server rules may only *raise* requirements, which fits a state whose only effect is to demand human review.
- The hardening work kept two distinctions that C also keeps: refusal is not a hazard, and the confirmed hazard list is untouched.

Conditions on this recommendation:

- It depends on the owner defining the cue list and the minimal requirements. Where the owner prefers the strongest enforcement for narrow electrical cues, a combination (a narrow addition to the confirmed list for the clearest cues plus C for generic possibility wording) is a reasonable variation, but that is an owner choice and is not part of this recommendation.
- If the owner will not approve any new state before the pilot, Option A with an explicit operator briefing is the only safe fallback; Option B should not be chosen for the generic "suspected hazard" wording.

---

## DECISION REQUIRED FROM PRODUCT / SAFETY OWNER

Minimum questions before any implementation:

1. **Which option** (A, B, C, or a stated combination)?
2. **Cue list.** Which exact wordings count? At least: "suspected / possible hazardous (or dangerous) condition", sparks, burning smell, exposed wiring. Which others, and which look-alike phrasings must be excluded (as "gas stove" and "fire extinguisher" are today)?
3. **Boundary.** Do any of those cues belong on the *confirmed* hazard list, and if so which?
4. **(Options B, C) Consequences.** What exactly must follow from the new classification: minimum urgency, required action type, risk or priority floor, reason required to reject, alternative required to reject? Each is an owner decision; the code can enforce only what is stated.
5. **(Option C) Relation to `CRITICAL`.** Is this a new, separate state, or should these cues feed the existing `CRITICAL` handling?
6. **(Option C) Access refusal.** Should refusal plus review-required stay independent (dispatch/inspection forbidden by refusal only), or narrow to escalation-only like hazard plus refusal?
7. **False-positive tolerance.** Is a visible notice on ordinary reports acceptable in a pilot, and how will false positives be reported and reviewed?
8. **Governance.** Who owns and approves changes to the cue lists, and how are changes recorded?
9. **Existing records.** Should earlier analyses be re-evaluated against a new list, or keep their stored state (see the consequences table)?
10. **Pilot stance until implemented.** Is the interim instruction "treat hazard language outside the closed list as potentially urgent regardless of the displayed state" the approved pilot rule?

---

## IMPLEMENTATION CONSEQUENCES (not implemented)

Legend: — none; ▲ small; ▲▲ moderate; ▲▲▲ large.

| Area | Option A | Option B | Option C |
|---|---|---|---|
| **Safety policy** (`safetyPolicy.js`) | — (documentation of the limit only) | ▲ add patterns and exclusions to the hazard list | ▲▲ second closed cue list; state derivation; documented "never downgrades a confirmed hazard" |
| **Persisted safety state / rules** | — | — (existing state and codes) | ▲▲ new state value in the model enum and in the admission record; possibly a new rule code |
| **Analysis admission** | — | ▲ more reports get the hazard minimum urgency/type; a model answer below it is rejected whole | ▲ admit with the new state; whether any minimum urgency applies is owner-defined |
| **Decision** | — | — (existing hazard rules apply to more reports) | ▲ rejection-reason rule for the new state (priority floor only if the owner states one) |
| **Action enforcement** | — | — (existing hazard rules apply) | ▲ add the state to the constrained set only if the owner wants a type constraint; refusal interaction as decided in question 6 |
| **Frontend presentation** | — (briefing only) | — | ▲▲ new state label and a distinct notice; the frontend must keep reading the stored state and rules only |
| **Tests** | — (case H stays pinned as Normal) | ▲ new cue tests and look-alike exclusions; case H pin changes; hazard-state suites unchanged | ▲▲▲ new-state tests across policy, admission, Decision, Action, UI; case H pin changes; "never downgrades a hazard"; Learning suites that enumerate states |
| **Historical / legacy Intelligence** | — | records keep their stored state (hazard cues were not recognised then); re-evaluation would rewrite history and needs its own decision | same: stored state stays; absent or older state means "assessed under the earlier policy"; no backfill unless the owner decides one |

Learning stays OFF under every option; the Learning code that lists safety states would need to accept a new value only under Option C.

---

**Final status: POLICY DECISION PENDING**
