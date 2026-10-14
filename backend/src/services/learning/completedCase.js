import crypto from "node:crypto";
import { ACTION_TYPES, ACTION_RISK_LEVELS, ACTION_VERSION } from "../../models/Action.js";
import { OUTCOME_V1_STATUSES, OUTCOME_VERSION } from "../../models/Outcome.js";
import { SIGNAL_SEVERITIES, SIGNAL_TYPES } from "../../models/Signal.js";
import { UNIT_TYPES } from "../../models/Unit.js";
import { topicsOf } from "../historyRelevance.js";
import { deriveSafetyPolicy, URGENCY_LEVELS } from "../ai/safetyPolicy.js";
import { EQUIPMENT_VALUES, FACET_NOT_APPLICABLE, FACET_UNKNOWN } from "./caseFacets.js";
import { isTrustedIssue } from "../structuredIssue.js";

/**
 * Case-based Learning L1 - the NORMALIZED COMPLETED OPERATIONAL CASE. Pure: no database, no model, no I/O.
 *
 * A completed case is DERIVED (never stored, never migrated) from the persisted chain
 *     Signal -> Intelligence V1 -> Decision V1 (approved) -> Action V1 (approved) -> Outcome V1 (recorded by a person)
 * and keeps ONLY controlled-vocabulary facts. Everything that could identify a person, a tenant or a record, and everything a model wrote, is dropped:
 *   NOT in a case: guest / stay / property identity, report or conversation text, Outcome summary or notes, any model prose, any Mongo id, any timestamp
 *   in `facts`. The few values the server needs to order, de-duplicate and audit cases live in `internal`, which is never part of anything model-facing.
 *
 * What a case contains (each value is a closed enum or a boolean, derived deterministically):
 *   issue      topics (the existing closed topic vocabulary of historyRelevance.js; supporting evidence only since L1.2), signalType, severity, and (L1.2) the structured
 *              facets equipment / problem / condition from caseFacets.js (closed vocabulary, UNKNOWN / AMBIGUOUS when the words do not establish one)
 *   conditions unitType (Unit.type, or null), accessRefused (the safety policy's ACCESS_REFUSED rule over the Signal)
 *   safety     state (the validated state stored with the Intelligence), urgency, rules (the safety policy's rules over the Signal)
 *   decision   result (always "approved": only approved Decisions complete a workflow), priority
 *   action     actionType, riskLevel, urgency (the server-computed values stored on the Action), followedRecommendedAction
 *   outcome    status (success | partial | failed | blocked | unknown), effectiveness (derived from the status alone)
 */

export const COMPLETED_CASE_VERSION = "completed-case-v2"; // v2 (L1.2): the issue carries the structured facets
export const SAFETY_RULE_CODES = Object.freeze(["ACCESS_REFUSED", "LIFE_SAFETY_HAZARD", "SEVERITY_CRITICAL"]);

/** Why a persisted chain was NOT turned into a completed case (counted by the loader; never contains a value). */
export const REJECTION = Object.freeze({
  OUTCOME_NOT_V1: "OUTCOME_NOT_V1",
  OUTCOME_NOT_RECORDED_BY_PERSON: "OUTCOME_NOT_RECORDED_BY_PERSON",
  OUTCOME_STATUS_UNKNOWN_VALUE: "OUTCOME_STATUS_UNKNOWN_VALUE",
  ACTION_MISSING: "ACTION_MISSING",
  ACTION_NOT_APPROVED_V1: "ACTION_NOT_APPROVED_V1",
  DECISION_MISSING: "DECISION_MISSING",
  DECISION_NOT_APPROVED_V1: "DECISION_NOT_APPROVED_V1",
  INTELLIGENCE_MISSING: "INTELLIGENCE_MISSING",
  INTELLIGENCE_NOT_V1: "INTELLIGENCE_NOT_V1",
  SAFETY_NOT_RECORDED: "SAFETY_NOT_RECORDED",
  SAFETY_INCONSISTENT: "SAFETY_INCONSISTENT",
  SIGNAL_MISSING: "SIGNAL_MISSING",
  LINK_MISMATCH: "LINK_MISMATCH",
  WORKSPACE_MISMATCH: "WORKSPACE_MISMATCH",
});

/** Outcome status -> what can be said about effectiveness, from the status alone (no prose is read). */
export const EFFECTIVENESS = Object.freeze({ success: "EFFECTIVE", partial: "PARTIALLY_EFFECTIVE", failed: "INEFFECTIVE", blocked: "NOT_ATTEMPTED", unknown: "UNDETERMINED" });
export const DETERMINED_STATUSES = Object.freeze(["success", "partial", "failed"]);

const sid = (value) => (value === undefined || value === null ? "" : String(value));
const oneOf = (value, allowed) => (allowed.includes(value) ? value : null);
const policyOf = (signal) => deriveSafetyPolicy({ signal: { title: signal?.title, description: signal?.description, severity: signal?.severity } });
const sortedTopics = (signal) => [...topicsOf(signal?.title, signal?.description)].sort();

/**
 * L1.3: the facets of a Signal are the AUTHORITATIVE server-derived `Signal.issue` captured at intake - the operator's words are NOT parsed again here. A legacy Signal (no issue), or one whose
 * stored issue is not a complete SERVER_DERIVED record of the current version, has UNKNOWN facets: nothing is inferred from its free text. Two defensive rules:
 *   - a hazard source (gas_supply / smoke_fire / co_alarm) counts only while the server safety policy still says life-safety hazard;
 *   - a condition is only meaningful inside temperature_fault, so "condition not stated" on any other family is NOT_APPLICABLE for the similarity tiers (not a new fact).
 */
export function facetsOfIssue(issue, { hazard = false } = {}) {
  if (!isTrustedIssue(issue)) return { equipment: FACET_UNKNOWN, problem: FACET_UNKNOWN, condition: FACET_UNKNOWN };
  const hazardSource = ["gas_supply", "smoke_fire", "co_alarm"].includes(issue.equipment);
  if (hazardSource && !hazard) return { equipment: FACET_UNKNOWN, problem: FACET_UNKNOWN, condition: FACET_UNKNOWN };
  const conditionNotApplicable = issue.condition === FACET_UNKNOWN && !["temperature_fault", FACET_UNKNOWN, "AMBIGUOUS"].includes(issue.problemFamily);
  const condition = conditionNotApplicable ? FACET_NOT_APPLICABLE : issue.condition;
  return { equipment: EQUIPMENT_VALUES.includes(issue.equipment) || issue.equipment === "AMBIGUOUS" ? issue.equipment : FACET_UNKNOWN, problem: issue.problemFamily, condition };
}

/**
 * The issue / condition / safety profile of ONE Signal, in controlled vocabulary only. Used for completed cases and for the CURRENT case alike, so both sides of a
 * comparison are derived by exactly the same code.
 */
export function profileOfSignal(signal, unit) {
  const policy = policyOf(signal);
  const facets = facetsOfIssue(signal?.issue, { hazard: policy.rules.includes("LIFE_SAFETY_HAZARD") });
  return {
    issue: { topics: sortedTopics(signal), signalType: oneOf(signal?.type, SIGNAL_TYPES), severity: oneOf(signal?.severity, SIGNAL_SEVERITIES), equipment: facets.equipment, problem: facets.problem, condition: facets.condition },
    conditions: { unitType: oneOf(unit?.type, UNIT_TYPES), accessRefused: policy.rules.includes("ACCESS_REFUSED") },
    safety: { state: policy.state, rules: [...policy.rules].filter((r) => SAFETY_RULE_CODES.includes(r)).sort() },
  };
}

/**
 * Normalise one persisted chain. `parts` are PLAIN records ({ outcome, action, decision, intelligence, signal, unit? }), each already fetched by the loader under the
 * workspace filter. This function re-checks every link and every workspaceId itself (defence in depth) and never trusts a single field it did not verify.
 * @returns {{ ok: true, case: object } | { ok: false, reason: string }}
 */
export function normalizeCompletedCase({ outcome, action, decision, intelligence, signal, unit }, workspaceId) {
  const ws = sid(workspaceId);
  if (!outcome || outcome.outcomeVersion !== OUTCOME_VERSION) return { ok: false, reason: REJECTION.OUTCOME_NOT_V1 };
  if (!outcome.recordedBy || !outcome.recordedAt) return { ok: false, reason: REJECTION.OUTCOME_NOT_RECORDED_BY_PERSON };
  if (!OUTCOME_V1_STATUSES.includes(outcome.status)) return { ok: false, reason: REJECTION.OUTCOME_STATUS_UNKNOWN_VALUE };
  if (!action) return { ok: false, reason: REJECTION.ACTION_MISSING };
  if (action.actionVersion !== ACTION_VERSION || action.status !== "approved") return { ok: false, reason: REJECTION.ACTION_NOT_APPROVED_V1 };
  if (!decision) return { ok: false, reason: REJECTION.DECISION_MISSING };
  if (decision.decisionVersion !== "decision-v1" || !["approved", "completed"].includes(decision.status)) return { ok: false, reason: REJECTION.DECISION_NOT_APPROVED_V1 };
  if (!intelligence) return { ok: false, reason: REJECTION.INTELLIGENCE_MISSING };
  if (intelligence.analysisVersion !== "intelligence-v1") return { ok: false, reason: REJECTION.INTELLIGENCE_NOT_V1 };
  if (!intelligence.safety?.state) return { ok: false, reason: REJECTION.SAFETY_NOT_RECORDED }; // "no safety result recorded" is NOT "normal": it cannot be compared
  if (!signal) return { ok: false, reason: REJECTION.SIGNAL_MISSING };

  const wsOk = [outcome, action, decision, intelligence, signal].every((r) => sid(r.workspaceId) === ws);
  if (!wsOk) return { ok: false, reason: REJECTION.WORKSPACE_MISMATCH };
  const linked =
    sid(outcome.actionId) === sid(action._id) && sid(outcome.decisionId) === sid(decision._id) && sid(action.decisionId) === sid(decision._id) &&
    sid(outcome.signalId) === sid(signal._id) && sid(action.signalId) === sid(signal._id) && sid(decision.signalId) === sid(signal._id) &&
    sid(outcome.intelligenceId) === sid(intelligence._id) && sid(action.intelligenceId) === sid(intelligence._id) && sid(decision.intelligenceId) === sid(intelligence._id) &&
    (intelligence.signalIds ?? []).map(sid).includes(sid(signal._id));
  if (!linked) return { ok: false, reason: REJECTION.LINK_MISMATCH };
  if (unit && sid(unit._id) !== sid(signal.unitId)) return { ok: false, reason: REJECTION.LINK_MISMATCH };

  const profile = profileOfSignal(signal, unit);
  // the validated state stored with the Intelligence must agree with what the server policy derives from the Signal today; otherwise the case's safety is ambiguous and it is not used
  if (profile.safety.state !== intelligence.safety.state) return { ok: false, reason: REJECTION.SAFETY_INCONSISTENT };

  const actionType = oneOf(action.actionType, ACTION_TYPES);
  const recommended = oneOf(intelligence.safety.recommendedActionType, ACTION_TYPES);
  const facts = {
    caseVersion: COMPLETED_CASE_VERSION,
    issue: profile.issue,
    conditions: profile.conditions,
    safety: { state: profile.safety.state, urgency: oneOf(intelligence.safety.urgency, URGENCY_LEVELS), rules: profile.safety.rules },
    decision: { result: "approved", priority: oneOf(decision.priority, ["low", "medium", "high", "critical"]) },
    action: { actionType, riskLevel: oneOf(action.riskLevel, ACTION_RISK_LEVELS), urgency: oneOf(action.urgency, URGENCY_LEVELS), followedRecommendedAction: actionType && recommended ? actionType === recommended : null },
    outcome: { status: outcome.status, effectiveness: EFFECTIVENESS[outcome.status] },
  };
  if (!facts.action.actionType) return { ok: false, reason: REJECTION.ACTION_NOT_APPROVED_V1 }; // an Action V1 without a valid closed type cannot be learned from
  // `internal` is for the server only: an opaque case key (a salted-by-workspace hash, never a Mongo id), the signal id (so the CURRENT case can be excluded) and the order key.
  const caseKey = crypto.createHash("sha256").update(`case-v1:${ws}:${sid(outcome._id)}`).digest("hex").slice(0, 20);
  return { ok: true, case: deepFreeze({ facts, internal: { caseKey, signalId: sid(signal._id), recordedAtMs: new Date(outcome.recordedAt).getTime() } }) };
}

export function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}
