import { presentUserText } from "../intelligence/presentation";
import { rejectionRequirements } from "../intelligence/safetyPresentation";

/**
 * The case's Decision, as the page may show it (Phase 48). Presentation mapping only - the server owns every fact and every rule:
 *   - the Decision is the human GOVERNANCE record; the Intelligence it concerns is never modified (this module only reads both);
 *   - safety is read from the STRUCTURED state the server stored with the Intelligence, never from prose;
 *   - an id is a key or a route value, never displayed text; a failed request is shown as a fixed sentence chosen from the status and the stable code.
 * The role (from the session) only decides which buttons to SHOW; whatever it says, the server authorizes each request.
 */
export const DECISION_STATE = Object.freeze({ PROPOSED: "proposed", APPROVED: "approved", REJECTED: "rejected" });

export function mapCaseDecision(view) {
  if (!view || typeof view !== "object" || view.decisionVersion !== "decision-v1") return null;
  if (!Object.values(DECISION_STATE).includes(view.status)) return null;
  return {
    id: String(view._id),
    intelligenceId: String(view.intelligenceId),
    status: view.status,
    priority: typeof view.priority === "string" ? view.priority : null,
    // The Decision's description is a snapshot of the AI recommendation, so it can carry the same internal references (Phase 43A: presentation only).
    recommendationSnapshot: presentUserText(view.description || ""),
    reviewedAt: view.review?.reviewedAt ?? null,
    reviewNote: view.review?.reviewNote ?? null,
    alternative: view.review?.alternative ?? null,
    proposedByYou: view.review?.you?.proposed === true,
    reviewedByYou: view.review?.you?.reviewed === true,
  };
}

/** Which buttons the role would SHOW. An unknown role shows them (the server then answers); a known one hides what it can never do. */
const PROPOSERS = new Set(["operator", "reviewer", "admin"]);
const REVIEWERS = new Set(["reviewer", "admin"]);
export const roleMayPropose = (role) => !role || PROPOSERS.has(role);
export const roleMayReview = (role) => !role || REVIEWERS.has(role);

/** What the Decision UI must respect, from the structured safety object the server stored with the Intelligence (the state table lives in safetyPresentation.js). */
export const safetyConstraint = rejectionRequirements;

/**
 * The per-case progress, in the words a person uses: Assessment, Decision, Action, Outcome. Assessment is "done" once the analysis exists. Decision is "done" once a person has
 * reviewed it, "review" while it waits for one. Action is "later" until the Decision is APPROVED (a rejected or unreviewed Decision never produces one), then "next"; "review" while
 * a proposal waits for a person; "done" once a person has reviewed it. Outcome is "later" until the Action is APPROVED, then "next", and "done" once a person has recorded what
 * happened. (Signal, context and the learning loop are internal and are not shown as steps.)
 */
export function caseStages({ intelligenceReady, assessing = false, decision, action, outcome }) {
  const decisionState = !intelligenceReady ? "later" : decision?.status === "approved" || decision?.status === "rejected" ? "done" : decision?.status === "proposed" ? "review" : "next";
  const actionState = decision?.status !== "approved" ? "later" : action?.status === "approved" || action?.status === "rejected" ? "done" : action?.status === "proposed" ? "review" : "next";
  const outcomeState = action?.status !== "approved" ? "later" : outcome ? "done" : "next";
  return [
    { label: "Assessment", state: intelligenceReady ? "done" : assessing ? "working" : "next" },
    { label: "Decision", state: decisionState },
    { label: "Action", state: actionState },
    { label: "Outcome", state: outcomeState },
  ];
}

/** Fixed, user-safe wording for a failed Decision request (never the server's message, a code, a status or an id). */
export function describeDecisionFailure(error) {
  const status = error?.status;
  const code = error?.code;
  if (status === 403) return "You're not allowed to do that in this workspace.";
  if (status === 400 && code === "DECISION_REASON_REQUIRED") return "Please record a reason before rejecting this recommendation.";
  if (status === 400 && code === "DECISION_ALTERNATIVE_REQUIRED") return "Please record what will be done instead before rejecting a recommendation about a life-safety hazard.";
  if (status === 400) return "That couldn't be recorded. Please check what you entered and try again.";
  if (status === 404) return "This decision is no longer available.";
  if (status === 409) return "This decision has already been reviewed. Reload to see the current state.";
  if (status === 422) return "A decision can't be recorded for this analysis.";
  if (status === 429) return "Too many requests in a short time. Please wait a moment and try again.";
  if (status === 0) return "We couldn't reach EOI. Check your connection and try again.";
  return "This decision could not be saved. Please try again.";
}
