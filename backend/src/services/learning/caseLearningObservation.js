import { ACTION_TYPES } from "../../models/Action.js";
import { assertShape } from "../learningContextContract.js";
import { DETERMINED_STATUSES, deepFreeze } from "./completedCase.js";
import { RELEVANCE } from "./caseSimilarity.js";

/**
 * Case-based Learning L1 - the BOUNDED LEARNING OBSERVATION. Pure: no database, no model, no I/O. Every number is COUNTED by the server from the selected completed
 * cases; no field is ever read from a model's output, and the builder has no parameter through which a model could supply one.
 *
 * It is SECONDARY evidence. Authority, highest first: current operational facts, safety, business knowledge, relevant operational history, case-based Learning.
 * An observation can never override a current fact, lower a safety requirement, create a fact, authorise / execute an action, approve a Decision, create an Outcome
 * or change a workspace boundary: it is a summary of what happened in similar, completed, person-recorded cases of the SAME workspace, and nothing more.
 *
 * SAFETY. L1 never lets Learning inform a current safety condition (CRITICAL or LIFE_SAFETY_HAZARD): the counts are still reported, but `sufficientEvidence` is false
 * (insufficientReason SAFETY_CONDITION), `dominantActionType` is null and `pattern` is INSUFFICIENT_EVIDENCE - the safety policy owns the response there.
 *
 * INSUFFICIENT EVIDENCE is explicit, never a quiet pattern: fewer than MINIMUM_CASES similar cases, or fewer than MINIMUM_CASES with a determined outcome
 * (success / partial / failed - blocked and unknown say nothing about whether the approach works), yields sufficientEvidence=false and no pattern.
 *
 * STATUS: SHADOW. mode is the literal "SHADOW" and advisoryOnly the literal true: nothing in L1 attaches this object to a model request or to an Intelligence record.
 */
export const OBSERVATION_VERSION = "case-learning-v1";
export const MINIMUM_CASES = 3;
export const CONSISTENCY = Object.freeze({ HIGH: "HIGH", MEDIUM: "MEDIUM", LOW: "LOW", NONE: "NONE" });
export const PATTERN = Object.freeze({ INSUFFICIENT_EVIDENCE: "INSUFFICIENT_EVIDENCE", POSITIVE: "POSITIVE", NEGATIVE: "NEGATIVE", PARTIAL: "PARTIAL", MIXED: "MIXED" });
export const INSUFFICIENT = Object.freeze({ NO_SIMILAR_CASES: "NO_SIMILAR_CASES", TOO_FEW_CASES: "TOO_FEW_CASES", TOO_FEW_DETERMINED_OUTCOMES: "TOO_FEW_DETERMINED_OUTCOMES", SAFETY_CONDITION: "SAFETY_CONDITION" });
const OUTCOME_KEYS = ["success", "partial", "failed", "blocked", "unknown"];
const CONSISTENCY_HIGH = 0.8; const CONSISTENCY_MEDIUM = 0.6; const DOMINANT_ACTION_SHARE = 0.6;

const enumOf = (values) => ({ kind: "enum", values: new Set(values), nullable: false });
const nullableEnum = (values) => ({ kind: "enum", values: new Set(values), nullable: true });
const int = { kind: "int", nullable: false, min: 0 };
const bool = { kind: "bool", nullable: false };
const rate = { kind: "rate", nullable: true };
const literal = (value) => ({ kind: "literal", value, nullable: false });
const obj = (fields, required) => ({ kind: "object", fields, required: required ?? Object.keys(fields), nullable: false });
const arr = (item, max) => ({ kind: "array", item, max, nullable: false });
const counts = obj(Object.fromEntries(OUTCOME_KEYS.map((k) => [k, int])));
const SAFETY_STATES = ["NORMAL", "CRITICAL", "LIFE_SAFETY_HAZARD"];

/** The ONLY shape an observation may have: closed enums, counts and booleans. No string, id, timestamp or text field exists in it. */
export const OBSERVATION_SHAPE = obj({
  observationVersion: literal(OBSERVATION_VERSION),
  mode: literal("SHADOW"),
  advisoryOnly: literal(true),
  safetyCondition: enumOf(SAFETY_STATES),
  sufficientEvidence: bool,
  insufficientReason: nullableEnum(Object.values(INSUFFICIENT)),
  minimumCases: int,
  similarCaseCount: int,
  determinedCaseCount: int,
  weakMatchCount: int,
  relevance: nullableEnum(Object.values(RELEVANCE)),
  relevanceCounts: obj({ high: int, medium: int }),
  outcomeDistribution: counts,
  successRate: rate,
  dominantOutcome: nullableEnum(["success", "partial", "failed"]),
  outcomeConsistency: enumOf(Object.values(CONSISTENCY)),
  pattern: enumOf(Object.values(PATTERN)),
  dominantActionType: nullableEnum(ACTION_TYPES),
  actionPatterns: arr(obj({ actionType: enumOf(ACTION_TYPES), caseCount: int, outcomes: counts }), ACTION_TYPES.length),
});

const emptyCounts = () => Object.fromEntries(OUTCOME_KEYS.map((k) => [k, 0]));

/**
 * @param {{ selected: Array<{ case: object, relevance: string }>, weakMatchCount?: number }} selection from caseSimilarity.selectSimilarCases
 * @param {{ safetyCondition: string }} current  the CURRENT case's safety state (server policy over the current Signal)
 * @returns {object} a deep-frozen, shape-checked observation
 */
export function buildLearningObservation(selection, current) {
  const selected = Array.isArray(selection?.selected) ? selection.selected : [];
  const distribution = emptyCounts(); const byAction = new Map();
  const tiers = { high: 0, medium: 0 };
  for (const { case: c, relevance } of selected) {
    distribution[c.facts.outcome.status] += 1;
    if (relevance === RELEVANCE.HIGH) tiers.high += 1; else if (relevance === RELEVANCE.MEDIUM) tiers.medium += 1;
    const type = c.facts.action.actionType;
    if (!byAction.has(type)) byAction.set(type, { actionType: type, caseCount: 0, outcomes: emptyCounts() });
    const row = byAction.get(type); row.caseCount += 1; row.outcomes[c.facts.outcome.status] += 1;
  }
  const similar = selected.length;
  const determined = DETERMINED_STATUSES.reduce((s, k) => s + distribution[k], 0);
  const safetyCondition = SAFETY_STATES.includes(current?.safetyCondition) ? current.safetyCondition : "CRITICAL"; // an unreadable condition is treated as the cautious one

  let insufficientReason = null;
  if (safetyCondition !== "NORMAL") insufficientReason = INSUFFICIENT.SAFETY_CONDITION;
  else if (similar === 0) insufficientReason = INSUFFICIENT.NO_SIMILAR_CASES;
  else if (similar < MINIMUM_CASES) insufficientReason = INSUFFICIENT.TOO_FEW_CASES;
  else if (determined < MINIMUM_CASES) insufficientReason = INSUFFICIENT.TOO_FEW_DETERMINED_OUTCOMES;
  const sufficient = insufficientReason === null;

  // consistency and pattern, from the DETERMINED outcomes only, and only when the evidence is sufficient
  let consistency = CONSISTENCY.NONE; let dominantOutcome = null; let pattern = PATTERN.INSUFFICIENT_EVIDENCE;
  if (sufficient) {
    const ranked = DETERMINED_STATUSES.map((k) => [k, distribution[k]]).sort((a, b) => b[1] - a[1]);
    const unique = ranked[0][1] > ranked[1][1];
    const share = ranked[0][1] / determined;
    consistency = !unique ? CONSISTENCY.LOW : share >= CONSISTENCY_HIGH ? CONSISTENCY.HIGH : share >= CONSISTENCY_MEDIUM ? CONSISTENCY.MEDIUM : CONSISTENCY.LOW;
    dominantOutcome = unique && consistency !== CONSISTENCY.LOW ? ranked[0][0] : null;
    pattern = dominantOutcome === "success" ? PATTERN.POSITIVE : dominantOutcome === "failed" ? PATTERN.NEGATIVE : dominantOutcome === "partial" ? PATTERN.PARTIAL : PATTERN.MIXED;
  }
  const patterns = [...byAction.values()].sort((a, b) => b.caseCount - a.caseCount || (a.actionType < b.actionType ? -1 : 1));
  const top = patterns[0];
  const dominantActionType = sufficient && top && (patterns.length === 1 || top.caseCount > patterns[1].caseCount) && top.caseCount / similar >= DOMINANT_ACTION_SHARE ? top.actionType : null;
  // the observation's relevance is its WEAKEST selected case's tier (conservative); null when nothing was selected
  const relevance = similar === 0 ? null : tiers.medium > 0 ? RELEVANCE.MEDIUM : RELEVANCE.HIGH;

  const observation = {
    observationVersion: OBSERVATION_VERSION, mode: "SHADOW", advisoryOnly: true, safetyCondition, sufficientEvidence: sufficient, insufficientReason, minimumCases: MINIMUM_CASES,
    similarCaseCount: similar, determinedCaseCount: determined, weakMatchCount: Number.isInteger(selection?.weakMatchCount) ? selection.weakMatchCount : 0,
    relevance, relevanceCounts: tiers, outcomeDistribution: distribution, successRate: determined > 0 ? distribution.success / determined : null,
    dominantOutcome, outcomeConsistency: consistency, pattern, dominantActionType, actionPatterns: patterns,
  };
  assertShape(observation, OBSERVATION_SHAPE, "learningObservation"); // fail closed: nothing outside the closed shape can leave this function
  return deepFreeze(observation);
}
