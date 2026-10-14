/**
 * Knowledge visibility hierarchy - the single definition every layer reuses
 * (retrieval, direct knowledge APIs, persisted Intelligence). Pure: no I/O.
 *
 *   guest < staff < restricted
 *
 * A caller authorized at level L may see knowledge whose visibility is at
 * most L: guest sees guest; staff sees guest + staff; restricted sees all.
 *
 * FAIL-CLOSED RULES (this module never widens access by accident):
 *   - An unknown/missing CALLER level is treated as "guest" (the lowest).
 *   - An unknown/missing KNOWLEDGE visibility is treated as "restricted"
 *     (the highest), so it is visible only to a restricted caller.
 */
export const VISIBILITY_LEVELS = Object.freeze(["guest", "staff", "restricted"]);

const RANK = Object.freeze({ guest: 0, staff: 1, restricted: 2 });

export function isValidVisibility(value) {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(RANK, value);
}

/** Numeric rank, or -1 for an invalid value. */
export function visibilityRank(value) {
  return isValidVisibility(value) ? RANK[value] : -1;
}

/** The caller's level, normalized fail-closed to "guest". */
export function normalizeCallerLevel(level) {
  return isValidVisibility(level) ? level : "guest";
}

/** Every visibility a caller at `level` may see, lowest first. */
export function allowedVisibilities(level) {
  const rank = RANK[normalizeCallerLevel(level)];
  return VISIBILITY_LEVELS.filter((candidate) => RANK[candidate] <= rank);
}

/** True when a caller at `callerLevel` may see knowledge marked `visibility`. */
export function canAccess(callerLevel, visibility) {
  const required = isValidVisibility(visibility) ? RANK[visibility] : RANK.restricted;
  return RANK[normalizeCallerLevel(callerLevel)] >= required;
}

/** The highest valid visibility in `levels`, or undefined when there is none. */
export function maxVisibility(levels) {
  let best;
  for (const level of levels || []) {
    if (!isValidVisibility(level)) continue;
    if (best === undefined || RANK[level] > RANK[best]) best = level;
  }
  return best;
}
