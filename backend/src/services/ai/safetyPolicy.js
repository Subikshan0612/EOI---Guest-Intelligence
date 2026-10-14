import { ACTION_TYPES } from "../../models/Action.js";
import { AppError } from "../../utils/AppError.js";

/**
 * Server-owned safety policy (Phase 34C).
 *
 *   CURRENT SAFETY FACT -> SERVER POLICY -> MINIMUM REQUIRED RESPONSE -> GEMINI RECOMMENDATION -> NODE VALIDATION
 *
 * The minimum response for a safety condition is derived HERE, from the current Signal, by rules - never by the model, and
 * never from history, Learning or business knowledge (those are not even inputs to `deriveSafetyPolicy`, so they cannot
 * lower it). The model states two structured fields: `urgency` and `recommendedActionType` (the closed Action V1 vocabulary).
 * Node compares them with the minimum. A response below the minimum is REJECTED whole (fail closed, nothing stored); it is
 * never silently "corrected" and no reasoning is fabricated for the model.
 *
 * Every rule is grounded in a scenario already in the Phase 33 evaluation corpus / the application's own semantics:
 *   SEVERITY_CRITICAL     Signal severity "critical" (cases K, P, V: security, access and fire signals)
 *                         -> urgency must be "immediate".
 *   LIFE_SAFETY_HAZARD    the Signal describes gas smell/leak, smoke, fire or carbon monoxide (cases Q: "gas odor ... requires an
 *                         immediate maintenance dispatch regardless of past outcomes", V: "fire alarm ... immediate escalation")
 *                         -> urgency "immediate" AND action type "escalation" or "maintenance_dispatch".
 *   ACCESS_REFUSED        the Signal records that the guest refuses entry/access (case K: "refuse any staff entry ... any
 *                         dispatch must wait") -> action type must not be "maintenance_dispatch" or "inspection" (both need
 *                         entry). If a life-safety hazard is ALSO described, the only permitted type is "escalation": a person
 *                         must decide how to reconcile a refusal with a hazard; the system neither dispatches nor shrugs.
 * Cases where history or Learning pull the other way (C: "historically successful dispatch", Q: "historically failing
 * dispatch", U: "AC fixed itself") change none of this: the policy takes only the current Signal as input.
 *
 *   SAFETY_REVIEW_REQUIRED  (owner-approved Option C, EOI_VAGUE_HAZARD_POLICY_DECISION.md) the Signal text contains one of FIVE exact phrases that state a POSSIBLE or UNCERTAIN safety
 *                         concern: "suspected hazardous condition", "possible hazardous condition", "potentially hazardous condition", "suspected danger", "possible danger". It means only
 *                         "a person must look at this before it is treated as completely ordinary". It does NOT establish a hazard, forces no urgency, no action type, no priority or risk,
 *                         forbids nothing and changes nothing about Decision or Action. Precedence: LIFE_SAFETY_HAZARD > CRITICAL (Signal severity, unchanged) > SAFETY_REVIEW_REQUIRED > NORMAL;
 *                         the cue never downgrades a hazard (no review rule is recorded beside a hazard) and never replaces CRITICAL (the rule is recorded, the state stays CRITICAL).
 *                         ACCESS_REFUSED is independent of all of this. The cue list is closed: no synonyms, no fuzzy or semantic matching, no model judgement, no history, no Learning.
 *                         It is OPT-IN per caller (`includeReviewRequired`): only the analysis pipeline asks for it, so Learning and the structured-issue code keep the three-state result they always had.
 *
 * HONEST LIMITS: the hazard and refusal rules read the Signal's free text, which is UNTRUSTED input. That is safe by
 * construction because those rules can only RAISE requirements, never lower them - hostile text can at worst demand more
 * caution. They are small closed word lists, not a generic classifier: a message such as "gas stove will not light" or
 * "fireplace instructions" is not a hazard, and a stale refusal ("no longer refuses entry") is not a refusal, but wording
 * outside the lists is not recognized. `urgency` and `recommendedActionType` are not checked against the recommendation's
 * prose: that would be semantic judgement, which this phase deliberately does not attempt.
 */
export const URGENCY_LEVELS = Object.freeze(["immediate", "prompt", "routine"]);
export const SAFETY_POLICY_VIOLATION = "SAFETY_POLICY_VIOLATION";

export const SEVERITY_CRITICAL = "SEVERITY_CRITICAL";
export const LIFE_SAFETY_HAZARD = "LIFE_SAFETY_HAZARD";
export const ACCESS_REFUSED = "ACCESS_REFUSED";
export const SAFETY_REVIEW_REQUIRED = "SAFETY_REVIEW_REQUIRED";

// A small closed list of life-safety hazards. Word boundaries throughout; each excludes the ordinary non-hazard phrasing
// that shares its word (fireplace, fire extinguisher, smoke-free, gas stove).
const HAZARD_PATTERNS = Object.freeze([
  /\bgas\s+(?:smell\w*|odou?r\w*|leak\w*|fumes?)\b/i,
  /\b(?:smell\w*|odou?r|leak\w*)\s+(?:of\s+|like\s+)?gas\b/i,
  /\b(?:smell\w*|odou?r)\b[^.;]{0,25}\bgas\b/i,
  /\bsmoke\b(?!-free|\s+free)/i,
  /\bfire\b(?!\s*(?:extinguishers?|exits?|doors?|drills?|escapes?|pits?|bowls?|tables?|blankets?|hoses?|marshals?|safety\s+(?:checks?|inspections?|equipment)))/i,
  /\bcarbon\s+monoxide\b|\bCO\s+(?:alarm|detector|poisoning)\b/i,
]);

const ACCESS_REFUSAL_PATTERN = /\b(?:refus\w*|declin\w*|den(?:y|ies|ied)|will\s+not\s+allow|won'?t\s+allow|does\s+not\s+(?:want|allow))\b[^.;]{0,60}\b(?:entry|access|enter(?:ing)?|staff|maintenance|technicians?|housekeeping|dispatch)\b|\bdo\s+not\s+(?:enter|disturb)\b/i;
// A refusal that the same text withdraws. Without this, "guest no longer refuses entry" would forbid a needed dispatch.
const REFUSAL_WITHDRAWN_PATTERN = /\b(?:no\s+longer|now\s+(?:allows?|agrees?|permits?)|has\s+agreed|have\s+agreed|agreed\s+to|granted\s+(?:access|permission)|gave\s+permission)\b/i;

// The CLOSED cue list for SAFETY_REVIEW_REQUIRED: exactly these five phrases and nothing else (no plurals, synonyms, stems or related vocabulary). Matching is case-insensitive and tolerant of
// extra whitespace or a hyphen between the words (NFKC-normalised first); sentence or clause punctuation between the words (. , ; :) breaks the phrase on purpose, so two sentences are never
// joined into a cue. Word boundaries at both ends: "dangerous", "unsuspected" and "possible dangers" are not cues. Like the other text rules this can only RAISE a requirement for a person to look.
const CUE_SEP = "[\\s\\-\\u2010-\\u2015]+";
const REVIEW_CUE_PATTERN = new RegExp(`\\b(?:(?:suspected|possible|potentially)${CUE_SEP}hazardous${CUE_SEP}condition|(?:suspected|possible)${CUE_SEP}danger)\\b`, "i");

const ENTRY_REQUIRING = Object.freeze(["maintenance_dispatch", "inspection"]);

const signalText = (context) => [context?.signal?.title, context?.signal?.description].filter((part) => typeof part === "string").join("\n");

/**
 * The minimum safe response for this request. Input is the CURRENT context only: history, Learning and knowledge are not
 * parameters, so no amount of historical success can change the result.
 */
export function deriveSafetyPolicy(context, { includeReviewRequired = false } = {}) {
  const text = signalText(context);
  const critical = String(context?.signal?.severity || "").toLowerCase() === "critical";
  const hazard = HAZARD_PATTERNS.some((pattern) => pattern.test(text));
  const refused = ACCESS_REFUSAL_PATTERN.test(text) && !REFUSAL_WITHDRAWN_PATTERN.test(text);
  // Opt-in (see the header): a cue beside an established hazard records nothing (the hazard wins and is never downgraded); beside CRITICAL it is recorded but the state stays CRITICAL.
  const review = includeReviewRequired && !hazard && REVIEW_CUE_PATTERN.test(String(text).normalize("NFKC"));

  const rules = [];
  if (critical) rules.push(SEVERITY_CRITICAL);
  if (hazard) rules.push(LIFE_SAFETY_HAZARD);
  if (review) rules.push(SAFETY_REVIEW_REQUIRED);
  if (refused) rules.push(ACCESS_REFUSED);

  let requiredActionTypes = null;
  if (hazard) requiredActionTypes = refused ? ["escalation"] : ["escalation", "maintenance_dispatch"];
  return Object.freeze({
    state: hazard ? "LIFE_SAFETY_HAZARD" : critical ? "CRITICAL" : review ? SAFETY_REVIEW_REQUIRED : "NORMAL",
    rules: Object.freeze(rules),
    minimumUrgency: critical || hazard ? "immediate" : null,
    requiredActionTypes: requiredActionTypes && Object.freeze(requiredActionTypes),
    forbiddenActionTypes: Object.freeze(refused ? [...ENTRY_REQUIRING] : []),
  });
}

/**
 * @param {object} policy from deriveSafetyPolicy
 * @param {{urgency?: unknown, recommendedActionType?: unknown}} analysis
 * @param {{strict?: boolean}} options strict (default): both fields are REQUIRED. strict=false (the deterministic test
 *   identity in development/test only) tolerates their absence; a value that IS present is always checked.
 * @returns {string[]} violation codes, empty when the analysis meets the minimum
 */
export function evaluateSafetyPolicy(policy, analysis, { strict = true } = {}) {
  const violations = [];
  const { urgency, recommendedActionType } = analysis || {};

  if (urgency === undefined || urgency === null) {
    if (strict) violations.push("URGENCY_MISSING");
  } else if (!URGENCY_LEVELS.includes(urgency)) {
    violations.push("URGENCY_INVALID");
  } else if (policy.minimumUrgency === "immediate" && urgency !== "immediate") {
    violations.push("URGENCY_BELOW_MINIMUM");
  }

  if (recommendedActionType === undefined || recommendedActionType === null) {
    if (strict) violations.push("ACTION_TYPE_MISSING");
  } else if (!ACTION_TYPES.includes(recommendedActionType)) {
    violations.push("ACTION_TYPE_INVALID");
  } else {
    if (policy.requiredActionTypes && !policy.requiredActionTypes.includes(recommendedActionType)) violations.push("ACTION_TYPE_NOT_PERMITTED");
    if (policy.forbiddenActionTypes.includes(recommendedActionType)) violations.push("ACTION_FORBIDDEN_BY_ACCESS_REFUSAL");
  }
  return violations;
}

/** Throws (the caller must not persist) when the analysis is below the server's minimum. Logs rule/violation codes only. */
export function enforceSafetyPolicy(policy, analysis, options) {
  const violations = evaluateSafetyPolicy(policy, analysis, options);
  if (violations.length === 0) return;
  console.error("[KOI API] Safety policy rejected the analysis: state=%s rules=%s violations=%s", policy.state, policy.rules.join(",") || "none", violations.join(","));
  throw new AppError(`AI analysis was rejected by the server safety policy (${violations.join(", ")}). Intelligence was not generated.`, 502, {
    code: SAFETY_POLICY_VIOLATION,
  });
}
