import { FACET_AMBIGUOUS, FACET_NOT_APPLICABLE, FACET_UNKNOWN } from "./caseFacets.js";

/**
 * Case-based Learning L1.2 - DETERMINISTIC STRUCTURED SIMILARITY (v2) between the CURRENT case and completed cases. Pure: no database, no model, no embeddings, no vector store.
 * The server selects the cases; the model never sees a candidate, never ranks one and never decides what counts as similar.
 *
 * WHAT CHANGED FROM v1. v1 granted a match when ONE broad topic word (water, climate, noise, electrical ...) was shared, so a refrigerator matched an AC and a drain matched every
 * leak (L1.1: about half of the retrieved cases were clearly irrelevant). Topics are now SUPPORTING EVIDENCE ONLY: they add one point to the order of already-compatible cases
 * and can never create a match. A match now requires the same EQUIPMENT and the same PROBLEM family (caseFacets.js), and the facets are never guessed.
 *
 * HARD GATES (a case failing any gate is EXCLUDED with a fixed reason; no score can rescue it). In this order:
 *   1  SAME_CASE               the current Signal is never its own history
 *   2  SAFETY_STATE_MISMATCH   safety state identical (NORMAL / CRITICAL / LIFE_SAFETY_HAZARD). Compared first: nothing below can override safety
 *   3  SAFETY_RULES_MISMATCH   safety rule set identical (ACCESS_REFUSED, LIFE_SAFETY_HAZARD, SEVERITY_CRITICAL). A refused-access case never matches a free-access one
 *   4  FACET_AMBIGUOUS         equipment, problem or condition is AMBIGUOUS on either side (the report names two devices or two problems): a conflict is excluded, never resolved by choosing
 *   5  EQUIPMENT_UNKNOWN       equipment is UNKNOWN on either side: UNKNOWN is never equal to anything (not even another UNKNOWN), so nothing is invented
 *      EQUIPMENT_MISMATCH      both known and different
 *   6  PROBLEM_UNKNOWN / PROBLEM_MISMATCH   the same rule for the problem family
 * So: the same equipment with a different problem is EXCLUDED, a different equipment with the same problem is EXCLUDED, known equipment with an unknown problem is EXCLUDED.
 *
 * TIERS (after the gates; decided ONLY by the facets, never by a score):
 *   HIGH    same equipment, same problem, and the condition agrees: equal and known, or NOT_APPLICABLE for this problem family
 *   MEDIUM  same equipment, same problem, the problem family has a condition (temperature_fault: not_cooling | not_heating) and it is UNKNOWN on at least one side
 *   LOW     same equipment, same problem, both conditions known and DIFFERENT (an AC that is not cooling vs an AC that is not heating) - counted as a weak match, NEVER as evidence
 *   EXCLUDED  failed a gate
 * Only HIGH and MEDIUM are selected as evidence (as in L1); LOW is only counted in weakMatchCount.
 *
 * SCORE (orders cases that already passed the gates; integers; cannot cross a tier or bypass a gate):
 *   +8 equipment and problem agree (every compatible case)   +4 condition equal and known   +2 same Signal type   +1 same severity   +1 same known unit type   +1 any shared topic
 *
 * Access: the access condition is part of the safety rules (ACCESS_REFUSED), so gate 3 is the access gate. A tie in score is broken by the case's recorded order and key
 * (the loader's order), so the same data always yields the same selection.
 */
export const SIMILARITY_VERSION = "case-similarity-v2";
export const EXCLUSION = Object.freeze({
  SAME_CASE: "SAME_CASE",
  SAFETY_STATE_MISMATCH: "SAFETY_STATE_MISMATCH",
  SAFETY_RULES_MISMATCH: "SAFETY_RULES_MISMATCH",
  FACET_AMBIGUOUS: "FACET_AMBIGUOUS",
  EQUIPMENT_UNKNOWN: "EQUIPMENT_UNKNOWN",
  EQUIPMENT_MISMATCH: "EQUIPMENT_MISMATCH",
  PROBLEM_UNKNOWN: "PROBLEM_UNKNOWN",
  PROBLEM_MISMATCH: "PROBLEM_MISMATCH",
});
export const RELEVANCE = Object.freeze({ HIGH: "HIGH", MEDIUM: "MEDIUM", LOW: "LOW" });
export const MAX_SELECTED_CASES = 25;

const sameSet = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]); // both sorted
const sharedCount = (a, b) => a.filter((v) => b.includes(v)).length;
const facet = (issue, name) => (typeof issue?.[name] === "string" ? issue[name] : FACET_UNKNOWN); // a profile without facets is UNKNOWN, never assumed

/**
 * @param {{ issue, conditions, safety }} current  profile of the current Signal (completedCaseService.buildCurrentCaseProfile)
 * @param {{ facts, internal }} candidate          a completed case
 * @param {{ currentSignalId?: string }} [options]
 * @returns {{ eligible: boolean, excludedBy: string|null, score: number, relevance: string|null, matched: string[] }}
 */
export function compareCases(current, candidate, { currentSignalId } = {}) {
  const none = (excludedBy) => ({ eligible: false, excludedBy, score: 0, relevance: null, matched: [] });
  const c = candidate.facts;
  if (currentSignalId && candidate.internal.signalId === String(currentSignalId)) return none(EXCLUSION.SAME_CASE);
  if (current.safety.state !== c.safety.state) return none(EXCLUSION.SAFETY_STATE_MISMATCH);
  if (!sameSet(current.safety.rules, c.safety.rules)) return none(EXCLUSION.SAFETY_RULES_MISMATCH);

  const [eqA, eqB] = [facet(current.issue, "equipment"), facet(c.issue, "equipment")];
  const [prA, prB] = [facet(current.issue, "problem"), facet(c.issue, "problem")];
  const [coA, coB] = [facet(current.issue, "condition"), facet(c.issue, "condition")];
  if ([eqA, eqB, prA, prB, coA, coB].includes(FACET_AMBIGUOUS)) return none(EXCLUSION.FACET_AMBIGUOUS);
  if (eqA === FACET_UNKNOWN || eqB === FACET_UNKNOWN) return none(EXCLUSION.EQUIPMENT_UNKNOWN);
  if (eqA !== eqB) return none(EXCLUSION.EQUIPMENT_MISMATCH);
  if (prA === FACET_UNKNOWN || prB === FACET_UNKNOWN) return none(EXCLUSION.PROBLEM_UNKNOWN);
  if (prA !== prB) return none(EXCLUSION.PROBLEM_MISMATCH);

  // tier: decided by the condition facet alone
  const conditionKnown = (v) => v !== FACET_UNKNOWN && v !== FACET_NOT_APPLICABLE;
  let relevance; let conditionEqual = false;
  if (coA === FACET_NOT_APPLICABLE && coB === FACET_NOT_APPLICABLE) relevance = RELEVANCE.HIGH;
  else if (!conditionKnown(coA) || !conditionKnown(coB)) relevance = RELEVANCE.MEDIUM;
  else if (coA === coB) { relevance = RELEVANCE.HIGH; conditionEqual = true; } else relevance = RELEVANCE.LOW;

  const matched = ["safety", "equipment", "problem"];
  let score = 8;
  if (conditionEqual) { score += 4; matched.push("condition"); }
  if (current.issue.signalType !== null && current.issue.signalType === c.issue.signalType) { score += 2; matched.push("signalType"); }
  if (current.issue.severity !== null && current.issue.severity === c.issue.severity) { score += 1; matched.push("severity"); }
  if (current.conditions.unitType !== null && current.conditions.unitType === c.conditions.unitType) { score += 1; matched.push("unitType"); }
  if (sharedCount(current.issue.topics, c.issue.topics) > 0) { score += 1; matched.push("topic"); }
  return { eligible: true, excludedBy: null, score, relevance, matched };
}

/**
 * Compare the current case with every completed case and select the similar ones.
 * @returns {{ similarityVersion: string, evaluated: number, excluded: Record<string, number>, weakMatchCount: number, selected: Array<{ case: object, score: number, relevance: string, matched: string[] }> }}
 *   `selected` holds only HIGH / MEDIUM cases (at most MAX_SELECTED_CASES, best score first); LOW matches are counted in weakMatchCount and never used as evidence.
 */
export function selectSimilarCases(current, cases, { currentSignalId, max = MAX_SELECTED_CASES } = {}) {
  const excluded = {}; const eligible = []; let weak = 0;
  for (const candidate of Array.isArray(cases) ? cases : []) {
    const r = compareCases(current, candidate, { currentSignalId });
    if (!r.eligible) { excluded[r.excludedBy] = (excluded[r.excludedBy] ?? 0) + 1; continue; }
    if (r.relevance === RELEVANCE.LOW) { weak += 1; continue; }
    eligible.push({ case: candidate, score: r.score, relevance: r.relevance, matched: r.matched });
  }
  // stable, deterministic order: score, then the loader's order (most recently recorded first), then the opaque key
  eligible.sort((a, b) => b.score - a.score || b.case.internal.recordedAtMs - a.case.internal.recordedAtMs || (a.case.internal.caseKey < b.case.internal.caseKey ? -1 : 1));
  return { similarityVersion: SIMILARITY_VERSION, evaluated: Array.isArray(cases) ? cases.length : 0, excluded, weakMatchCount: weak, selected: eligible.slice(0, Math.max(0, max)) };
}
