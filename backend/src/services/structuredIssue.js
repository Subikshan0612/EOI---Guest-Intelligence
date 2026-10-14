import { deriveSafetyPolicy } from "./ai/safetyPolicy.js";
import { FACET_UNKNOWN, ISSUE_CONDITION_VALUES, ISSUE_EQUIPMENT_VALUES, ISSUE_PROBLEM_VALUES, extractIssueFacets } from "./learning/caseFacets.js";

/**
 * Learning L1.3 - STRUCTURED ISSUE CAPTURE AT SIGNAL INTAKE. Pure and deterministic: no model, no database, no I/O.
 *
 * A Signal carries the operator's own words (title, description - never touched here) and, since L1.3, a small server-derived record of WHAT the report is about:
 *     issue: { version: 1, equipment, problemFamily, condition, source: "SERVER_DERIVED" }
 * Every value comes from the closed vocabularies of learning/caseFacets.js (reused, not copied) or is UNKNOWN (the words do not establish it) or AMBIGUOUS (the words name more than one
 * equipment / problem, or no single target). Nothing is guessed: "not cooling" alone is a temperature fault of an UNKNOWN device, never an air conditioner.
 *
 * Ownership. The record is derived HERE, by the server, from the Signal's own title / description / severity and the server safety policy's verdict (hazard sources are only assigned when
 * the policy already says life-safety hazard). It is never accepted from a client, a model or the Learning layer; `source` has exactly one legal value.
 */
export const ISSUE_VERSION = 1;
export const ISSUE_SOURCE = "SERVER_DERIVED";
export { ISSUE_CONDITION_VALUES, ISSUE_EQUIPMENT_VALUES, ISSUE_PROBLEM_VALUES };

/**
 * @param {{ title?: string, description?: string, severity?: string }} signal  the Signal's own words and severity (the inputs of the server safety policy)
 * @returns {{ version: number, equipment: string, problemFamily: string, condition: string, source: string }}
 */
export function extractStructuredIssue({ title, description, severity } = {}) {
  const policy = deriveSafetyPolicy({ signal: { title, description, severity } });
  const facets = extractIssueFacets({ title, description }, { hazard: policy.rules.includes("LIFE_SAFETY_HAZARD") });
  return { version: ISSUE_VERSION, equipment: facets.equipment, problemFamily: facets.problem, condition: facets.condition, source: ISSUE_SOURCE };
}

/** True only for a complete, current-version record whose every value is in the closed vocabulary and whose source is SERVER_DERIVED. A legacy Signal (no issue) is false. */
export function isTrustedIssue(issue) {
  return Boolean(issue) && typeof issue === "object" && issue.version === ISSUE_VERSION && issue.source === ISSUE_SOURCE &&
    ISSUE_EQUIPMENT_VALUES.includes(issue.equipment) && ISSUE_PROBLEM_VALUES.includes(issue.problemFamily) && ISSUE_CONDITION_VALUES.includes(issue.condition);
}
