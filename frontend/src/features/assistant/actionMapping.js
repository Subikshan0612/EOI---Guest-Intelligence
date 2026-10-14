import { presentUserText } from "../intelligence/presentation";

/**
 * The case's Action PROPOSAL, as the page may show it (Phase 49). Presentation mapping only - the server owns every fact and every rule:
 *   - an Action here is a proposal derived by the server from one APPROVED Decision; it represents what a person decided should be done and executes NOTHING;
 *   - the type, risk and urgency are the server's (derived from the stored, validated analysis); this module only chooses words for values it already sent;
 *   - an id is a key or a route value, never displayed text; a failed request is shown as a fixed sentence chosen from the status and the stable code.
 */
export const ACTION_STATE = Object.freeze({ PROPOSED: "proposed", APPROVED: "approved", REJECTED: "rejected" });

const known = (table, key) => typeof key === "string" && Object.prototype.hasOwnProperty.call(table, key);
const TYPE_LABELS = Object.freeze({
  maintenance_dispatch: "Maintenance dispatch",
  guest_communication: "Guest communication",
  escalation: "Escalation",
  inspection: "Inspection",
  other: "Other",
});
const RISK_LABELS = Object.freeze({ low: "Low", medium: "Medium", high: "High", critical: "Critical" });
const URGENCY_LABELS = Object.freeze({ immediate: "Immediate", prompt: "Prompt", routine: "Routine" });

export function mapCaseAction(view) {
  if (!view || typeof view !== "object" || view.actionVersion !== "action-v1") return null;
  if (!Object.values(ACTION_STATE).includes(view.status)) return null;
  return {
    id: String(view._id),
    status: view.status,
    typeLabel: known(TYPE_LABELS, view.actionType) ? TYPE_LABELS[view.actionType] : null,
    riskLabel: known(RISK_LABELS, view.riskLevel) ? RISK_LABELS[view.riskLevel] : null,
    riskTone: known(RISK_LABELS, view.riskLevel) ? view.riskLevel : null,
    urgencyLabel: known(URGENCY_LABELS, view.urgency) ? URGENCY_LABELS[view.urgency] : null,
    // The proposal's description is a snapshot of the approved recommendation, so it can carry the same internal references (Phase 43A: presentation only).
    description: presentUserText(view.description || ""),
    reviewedAt: view.review?.reviewedAt ?? null,
    reviewNote: view.review?.reviewNote ?? null,
    proposedByYou: view.review?.you?.proposed === true,
    reviewedByYou: view.review?.you?.reviewed === true,
  };
}

/** What the Action section may offer, from the Decision's state ALONE: only an APPROVED Decision produces a proposal. */
export function actionAvailability(decision) {
  if (!decision) return "waiting";
  if (decision.status === "approved") return "available";
  if (decision.status === "rejected") return "closed";
  return "waiting";
}

/** Fixed, user-safe wording for a failed Action request (never the server's message, a code, a status or an id). */
export function describeActionFailure(error) {
  const status = error?.status;
  const code = error?.code;
  if (status === 403) return "You're not allowed to do that in this workspace.";
  if (status === 400 && code === "ACTION_REASON_REQUIRED") return "Please record a reason before rejecting an action proposal that carries a safety requirement.";
  if (status === 400) return "That couldn't be recorded. Please check what you entered and try again.";
  if (status === 404) return "This action proposal is no longer available.";
  if (status === 409) return "This action proposal can't be changed in its current state. Reload to see where it stands.";
  if (status === 422) return "An action proposal can't be made for this decision.";
  if (status === 429) return "Too many requests in a short time. Please wait a moment and try again.";
  if (status === 0) return "We couldn't reach EOI. Check your connection and try again.";
  return "This action proposal could not be saved. Please try again.";
}
