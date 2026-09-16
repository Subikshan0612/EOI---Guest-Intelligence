/**
 * Small, presentation-only helpers over the Phase 7D Learning report shape.
 * The report itself is already the API's own field names (decisionId,
 * intelligenceId, actionCount, ...) — no REST→frontend field renaming is
 * needed the way conversationMapping.js/operationsMapping.js do for other
 * resources, since Learning was designed API-first for exactly this
 * consumption. This file only builds lookup maps and derives the
 * incomplete-chain groupings the page needs to render.
 */

/** id -> record, for cross-referencing a Decision's lightweight {actionId,status} refs against the full Action records. */
export function indexById(records, idField) {
  const map = new Map();
  for (const record of records || []) {
    map.set(record[idField], record);
  }
  return map;
}

/** Actions with no decisionId — never reachable through any Decision card. */
export function actionsWithoutDecision(actions) {
  return (actions || []).filter((action) => !action.decisionId);
}

/** Outcomes with no actionId — never reachable through any Action. */
export function outcomesWithoutAction(outcomes) {
  return (outcomes || []).filter((outcome) => !outcome.actionId);
}

/** Outcomes belonging to one specific Action, read from the top-level list (works for both Decision-linked and standalone Actions). */
export function outcomesForAction(outcomes, actionId) {
  return (outcomes || []).filter((outcome) => outcome.actionId === actionId);
}
