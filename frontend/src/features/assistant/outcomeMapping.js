/**
 * The case's OUTCOME, as the page may show it (Phase 50). Presentation mapping only - the server owns every fact and every rule:
 *   - an Outcome is what a PERSON reports actually happened after an approved Action ("record what happened"). It is never generated, inferred or checked by EOI;
 *   - the result is one of a small closed vocabulary the server accepts; this module only chooses words for it;
 *   - an id is a key or a route value, never displayed text; a failed request is shown as a fixed sentence chosen from the status and the stable code.
 */
export const OUTCOME_CHOICES = Object.freeze([
  { value: "success", label: "Success", hint: "It was done and worked." },
  { value: "partial", label: "Partial", hint: "Some of it was done." },
  { value: "failed", label: "Failed", hint: "It was tried and did not work." },
  { value: "blocked", label: "Blocked", hint: "It could not be done (for example access was refused)." },
  { value: "unknown", label: "Unknown", hint: "It is not known what happened." },
]);

const LABELS = Object.freeze(Object.fromEntries(OUTCOME_CHOICES.map((c) => [c.value, c.label])));
export const OUTCOME_TEXT_MAX = 2000;

export function mapCaseOutcome(view) {
  if (!view || typeof view !== "object" || view.outcomeVersion !== "outcome-v1") return null;
  if (!Object.prototype.hasOwnProperty.call(LABELS, view.status)) return null;
  return {
    id: String(view._id),
    status: view.status,
    statusLabel: LABELS[view.status],
    // What the person wrote, shown as plain text exactly as recorded.
    observation: typeof view.result?.summary === "string" ? view.result.summary : "",
    recordedAt: view.recordedAt ?? null,
    recordedByYou: view.recordedByYou === true,
  };
}

/** What the Outcome section may offer, from the Action's state ALONE: only an APPROVED Action can have one recorded. */
export function outcomeAvailability(action) {
  if (!action) return "waiting";
  if (action.status === "approved") return "available";
  if (action.status === "rejected") return "closed";
  return "waiting";
}

/** Fixed, user-safe wording for a failed Outcome request (never the server's message, a code, a status or an id). */
export function describeOutcomeFailure(error) {
  const status = error?.status;
  const code = error?.code;
  if (status === 403) return "You're not allowed to do that in this workspace.";
  if (status === 400 && code === "OUTCOME_DESCRIPTION_REQUIRED") return "Please describe what happened before recording the outcome.";
  if (status === 400) return "That couldn't be recorded. Please check what you entered and try again.";
  if (status === 404) return "This action is no longer available.";
  if (status === 409) return "An outcome has already been recorded for this action, or the action can't take one. Reload to see where it stands.";
  if (status === 422) return "That result can't be recorded. Please choose one of the listed results.";
  if (status === 429) return "Too many requests in a short time. Please wait a moment and try again.";
  if (status === 0) return "We couldn't reach EOI. Check your connection and try again.";
  return "This outcome could not be saved. Please try again.";
}
