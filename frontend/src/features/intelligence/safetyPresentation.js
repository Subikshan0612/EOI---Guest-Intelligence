/**
 * Phase 43B.2 - how the UI presents the server-VALIDATED safety result of an analysis (`safety.state`, `safety.urgency`, `safety.recommendedActionType`,
 * carried unchanged by safetyMapping.js). Node decided these (safetyPolicy.js) and stored them only after the analysis passed validation; this module
 * only chooses WORDS for values the server already sent. It is not a second safety engine:
 *   - its only input is the structured `safety` object - never the recommendation, impact, evidence, signal text or any other prose, and it imports nothing;
 *   - every lookup is an exact match against the backend's closed vocabularies (a closed table, own-property checked); there is no pattern matching,
 *     no keyword test, no case folding, no partial match and no default;
 *   - a value it does not know is never guessed: an unknown state is "unrecognised", an unknown urgency or action type is simply not presented.
 *
 * `status`:
 *   "not_recorded"  safety is null/absent (a record from before the field existed). NOT "safe", NOT "normal" - there is no assessment to show.
 *   "unrecognised"  a state this view does not know. Shown neutrally; never mapped to any known state.
 *   "recorded"      a known state. `alert` is true only for the two states the backend treats as safety conditions (CRITICAL, LIFE_SAFETY_HAZARD);
 *                   NORMAL is presented quietly (no alarm wording), whatever its urgency or action type. A NORMAL assessment CAN carry the exact action type
 *                   "escalation" (the backend policy neither requires nor forbids it outside a hazard / access refusal), so `escalation` is exposed for the
 *                   quiet line to state it plainly - as a recommendation, never as an alarm: it does not change `alert`, `headline` or `flags`.
 * The flags (IMMEDIATE ACTION REQUIRED / ESCALATION REQUIRED) are produced only inside an alert and only from the exact structured values
 * `urgency === "immediate"` and `recommendedActionType === "escalation"`. Informational only: nothing here executes, dispatches or escalates anything.
 */
const STATES = Object.freeze({
  NORMAL: Object.freeze({ label: "Normal", alert: false }),
  CRITICAL: Object.freeze({ label: "Critical", alert: true, headline: "CRITICAL SAFETY CONDITION" }),
  SAFETY_REVIEW_REQUIRED: Object.freeze({ label: "Safety review required", alert: false }),
  LIFE_SAFETY_HAZARD: Object.freeze({ label: "Life-safety hazard", alert: true, headline: "LIFE-SAFETY HAZARD" }),
});

// Phase 48: what the server REQUIRES of a person who rejects a recommendation in each recorded state (decisionService.assertSafetyAllowsRejection). The same exact-match table
// as above - this module remains the only place the UI names a safety state - and a state it does not know constrains nothing (it is never guessed).
const REJECTION_REQUIREMENTS_NONE = Object.freeze({ level: "none", reasonRequired: false, alternativeRequired: false });
const REJECTION_REQUIREMENTS = Object.freeze({
  NORMAL: REJECTION_REQUIREMENTS_NONE,
  SAFETY_REVIEW_REQUIRED: REJECTION_REQUIREMENTS_NONE,
  CRITICAL: Object.freeze({ level: "critical", reasonRequired: true, alternativeRequired: false }),
  LIFE_SAFETY_HAZARD: Object.freeze({ level: "hazard", reasonRequired: true, alternativeRequired: true }),
});
const NO_REQUIREMENTS = REJECTION_REQUIREMENTS.NORMAL;

// Safety/context hardening: the policy's ACCESS_REFUSED rule (safetyPolicy.js: maintenance dispatch and inspection both need entry and are not permitted; with a life-safety hazard the only
// permitted action type is escalation), stated from the exact rule code the server stored with the result. It adds no procedure, contact, role or deadline.
const ACCESS_REFUSED_NOTE = "Access was refused in this report. Under the safety rules, maintenance dispatch and inspection (which need entry) are not permitted.";
const ACCESS_REFUSED_HAZARD_NOTE = "Access was refused in this report. Under the safety rules, the only permitted action type is escalation.";

// Owner-approved SAFETY_REVIEW_REQUIRED (EOI_VAGUE_HAZARD_POLICY_DECISION.md Option C): calm wording, no alarm, and no claim that anything is confirmed. Shown from the server's state or rule code
// by exact match; never for a confirmed hazard (that presentation is unchanged). It adds no rejection requirement: the server asks nothing extra for this state.
const SAFETY_REVIEW_NOTE = "The report contains wording that indicates a possible safety concern. The concern has not been established as a confirmed hazard.";

const URGENCY_LABELS = Object.freeze({ immediate: "Immediate", prompt: "Prompt", routine: "Routine" });

const ACTION_TYPE_LABELS = Object.freeze({
  maintenance_dispatch: "Maintenance dispatch",
  guest_communication: "Guest communication",
  escalation: "Escalation",
  inspection: "Inspection",
  other: "Other",
});

const known = (table, key) => typeof key === "string" && Object.prototype.hasOwnProperty.call(table, key);

/** What rejecting this recommendation requires, from the structured `safety` object only (see REJECTION_REQUIREMENTS). Unknown or absent -> nothing extra. */
export function rejectionRequirements(safety) {
  return safety && typeof safety === "object" && known(REJECTION_REQUIREMENTS, safety.state) ? REJECTION_REQUIREMENTS[safety.state] : NO_REQUIREMENTS;
}

/** @returns {{status: "not_recorded"} | {status: "unrecognised"} | {status: "recorded", state: string, stateLabel: string, alert: boolean, headline: string|null, flags: string[], escalation: boolean, urgencyLabel: string|null, actionTypeLabel: string|null}} */
export function presentSafety(safety) {
  if (safety === null || safety === undefined) return { status: "not_recorded" };
  if (typeof safety !== "object" || !known(STATES, safety.state)) return { status: "unrecognised" };

  const state = STATES[safety.state];
  const urgencyLabel = known(URGENCY_LABELS, safety.urgency) ? URGENCY_LABELS[safety.urgency] : null;
  const actionTypeLabel = known(ACTION_TYPE_LABELS, safety.recommendedActionType) ? ACTION_TYPE_LABELS[safety.recommendedActionType] : null;

  const reviewRequired = safety.state !== "LIFE_SAFETY_HAZARD" && (safety.state === "SAFETY_REVIEW_REQUIRED" || (Array.isArray(safety.rules) && safety.rules.some((rule) => rule === "SAFETY_REVIEW_REQUIRED")));
  const accessRefused = Array.isArray(safety.rules) && safety.rules.some((rule) => rule === "ACCESS_REFUSED");
  const flags = [];
  if (state.alert) {
    if (safety.urgency === "immediate") flags.push("IMMEDIATE ACTION REQUIRED");
    if (safety.recommendedActionType === "escalation") flags.push("ESCALATION REQUIRED");
  }
  return {
    status: "recorded",
    state: safety.state,
    stateLabel: state.label,
    alert: state.alert,
    headline: state.alert ? state.headline : null,
    flags,
    escalation: safety.recommendedActionType === "escalation",
    urgencyLabel,
    actionTypeLabel,
    reviewRequired,
    reviewRequiredNote: reviewRequired ? SAFETY_REVIEW_NOTE : null,
    accessRefused,
    accessRefusedNote: accessRefused ? (safety.state === "LIFE_SAFETY_HAZARD" ? ACCESS_REFUSED_HAZARD_NOTE : ACCESS_REFUSED_NOTE) : null,
  };
}

// The vocabularies this table mirrors are the backend's (safetyPolicy.js URGENCY_LEVELS, the Action model's ACTION_TYPES, the policy's state values);
// validate-phase43b2-safety-presentation.mjs ties them together so a new backend value cannot go unnoticed here.
export const PRESENTED_VOCABULARY = Object.freeze({
  states: Object.freeze(Object.keys(STATES)),
  urgencies: Object.freeze(Object.keys(URGENCY_LABELS)),
  actionTypes: Object.freeze(Object.keys(ACTION_TYPE_LABELS)),
});
