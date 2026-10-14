import { FACET_AMBIGUOUS, FACET_UNKNOWN } from "./learning/caseFacets.js";
import { isTrustedIssue } from "./structuredIssue.js";

/**
 * RECURRENCE (safety/context hardening, P2-B). Pure and deterministic: no model, no database, no I/O, no embeddings, no text similarity.
 *
 * Question it answers, and nothing more: "is there an earlier report about the SAME KIND of problem in THIS room?" The answer is a record match, never an explanation: it says
 * nothing about a cause, about what an earlier visit did, or about what will work now.
 *
 * It uses ONLY the server-derived structured issue both Signals already carry (Signal.issue, source SERVER_DERIVED, learning/caseFacets.js vocabulary), through the same semantics
 * as the existing structured similarity (L1.2): a value that is UNKNOWN or AMBIGUOUS never matches anything (not even another UNKNOWN), so nothing is invented.
 *
 * HARD GATES - an earlier report is a recurrence of the current one only if ALL hold; failing any one means NO claim:
 *   1  both Signals have a TRUSTED structured issue (current version, SERVER_DERIVED, every value in the closed vocabulary): a legacy Signal (no issue) never matches
 *   2  the SAME room (unit): same unit id, not null. Other rooms - even the same equipment and problem in the same property - are not a room-specific recurrence
 *   3  the earlier report is strictly EARLIER (recorded before the current one) and is a different Signal
 *   4  equipment is KNOWN on both sides and equal (UNKNOWN / AMBIGUOUS on either side: no claim)
 *   5  problem family is KNOWN on both sides and equal (UNKNOWN / AMBIGUOUS on either side: no claim)
 *   6  condition is compatible: equal and known; or UNKNOWN on at least one side while the other is known/unknown (condition not recorded - reported as such, never as "same condition");
 *      two DIFFERENT known conditions (not cooling vs not heating) or AMBIGUOUS on either side: no claim
 * Shared words are never evidence: two reports that merely sound alike but carry different structured issues do not match.
 *
 * `earlier` items are plain records ({ unitId, createdAt, issue }); the caller (signalRecurrenceService.js) loads them workspace-scoped. At most MAX_MATCHES (newest first) are returned.
 */
export const RECURRENCE_VERSION = "recurrence-v1";
export const MAX_MATCHES = 3;
export const CONDITION_SAME = "same";
export const CONDITION_NOT_RECORDED = "not_recorded";

const known = (value) => typeof value === "string" && value !== "" && value !== FACET_UNKNOWN && value !== FACET_AMBIGUOUS;
const time = (value) => {
  const t = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(t) ? t : null;
};

/**
 * @returns {{ match: boolean, condition: string|null, excludedBy: string|null }}
 */
export function compareIssues(current, earlier) {
  const no = (excludedBy) => ({ match: false, condition: null, excludedBy });
  if (!isTrustedIssue(current) || !isTrustedIssue(earlier)) return no("ISSUE_NOT_TRUSTED");
  if (!known(current.equipment) || !known(earlier.equipment)) return no("EQUIPMENT_NOT_ESTABLISHED");
  if (current.equipment !== earlier.equipment) return no("EQUIPMENT_DIFFERS");
  if (!known(current.problemFamily) || !known(earlier.problemFamily)) return no("PROBLEM_NOT_ESTABLISHED");
  if (current.problemFamily !== earlier.problemFamily) return no("PROBLEM_DIFFERS");
  if (current.condition === FACET_AMBIGUOUS || earlier.condition === FACET_AMBIGUOUS) return no("CONDITION_AMBIGUOUS");
  if (known(current.condition) && known(earlier.condition)) return current.condition === earlier.condition ? { match: true, condition: CONDITION_SAME, excludedBy: null } : no("CONDITION_DIFFERS");
  return { match: true, condition: CONDITION_NOT_RECORDED, excludedBy: null };
}

/**
 * @param {{ id?: string, unitId?: unknown, createdAt?: unknown, issue?: object }} current
 * @param {Array<{ id?: string, unitId?: unknown, createdAt?: unknown, issue?: object }>} earlier
 * @returns {{ version: string, detected: boolean, scope: string, matches: Array<{ id: string|null, recordedAt: string, issue: object, condition: string }> }}
 */
export function deriveRecurrence(current, earlier) {
  const empty = { version: RECURRENCE_VERSION, detected: false, scope: "unit", matches: [] };
  const unit = current?.unitId == null ? null : String(current.unitId);
  const now = time(current?.createdAt);
  if (!unit || now === null || !Array.isArray(earlier)) return empty;
  const matches = [];
  for (const item of earlier) {
    if (!item || (current.id != null && String(item.id) === String(current.id))) continue;
    if (item.unitId == null || String(item.unitId) !== unit) continue;
    const then = time(item.createdAt);
    if (then === null || then >= now) continue;
    const verdict = compareIssues(current.issue, item.issue);
    if (!verdict.match) continue;
    matches.push({ at: then, id: item.id == null ? null : String(item.id), recordedAt: new Date(then).toISOString(), issue: { equipment: item.issue.equipment, problemFamily: item.issue.problemFamily, condition: item.issue.condition }, condition: verdict.condition });
  }
  matches.sort((a, b) => b.at - a.at);
  const top = matches.slice(0, MAX_MATCHES).map(({ at, ...rest }) => rest);
  return { version: RECURRENCE_VERSION, detected: top.length > 0, scope: "unit", matches: top };
}
