import mongoose from "mongoose";
import { AppError } from "../utils/AppError.js";
import { ROLES, hasPermission } from "../auth/roles.js";

/**
 * Proposer / reviewer separation (Phase 35). PURE rules, no I/O: the services call these before they write.
 *
 * WHO is always the authenticated actor of the request (`req.actor.userId`, set by authenticate + workspace membership), passed down
 * by the controller. It is NEVER read from a request body, query or header, and no model output reaches this code.
 *
 * NEW records (created from Phase 35 on) carry `governanceVersion = GOVERNANCE_VERSION` and a REQUIRED `proposedBy`. A governed record
 * can only be approved or rejected by a DIFFERENT user than its proposer, and the reviewer is stored as `review.reviewedBy`.
 * A governed record WITHOUT a proposer is impossible to create (the schema requires it) and, if one were ever found, is refused here
 * (fail closed) - a missing proposer is never a way around the rule.
 *
 * LEGACY records (no `governanceVersion`) predate identity tracking: there is no recorded proposer to compare with, and rewriting
 * history with guessed users would be fabrication. They stay reviewable exactly as before (the review still records WHO reviewed);
 * the only way to be on this path is to have been created before this phase - new records cannot take it, because the field is set
 * by the server in the same write that creates the record.
 *
 * Scope note: this separates the PROPOSER of a Decision (or Action proposal) from its REVIEWER. It does not stop one person from
 * proposing a Decision and, separately, reviewing a different record. With a single-person workspace, review is impossible by design.
 */
export const GOVERNANCE_VERSION = "proposer-reviewer-v1";
export const SEPARATION_OF_DUTIES = "SEPARATION_OF_DUTIES";

/**
 * Phase 48.1 - the separation rule is now a POLICY per record kind, in this one place.
 *
 * EOI is currently a single-user product: an authenticated member of a workspace must be able to confirm the Decision they asked for, so a DECISION may be
 * reviewed by the user who proposed it. Everything else about the review is unchanged: the reviewer is still the authenticated actor and is still recorded
 * (`review.reviewedBy`), the proposer is still recorded (`proposedBy`), the permission and the workspace membership are still enforced by the route, and the
 * structured safety rules still apply. An ACTION proposal keeps the strict rule (nothing in this phase touches Actions).
 *
 * Moving to multi-user governance later is a one-line change here (set `selfReviewAllowed` to false), not a change to the services, the model or the data.
 *
 * Phase 49 - ACTION. The strict Action rule was Phase 35's mirror of Decision V1 (four eyes on a proposal); it is not an authentication or tenant control (the
 * reviewer is the authenticated actor either way). An Action V1 is INERT: nothing in EOI can execute one. So, for a single-user product, the person who proposed
 * an Action proposal may also confirm it - but ONLY while that remains true. `action:execute` exists in the vocabulary and no role holds it; the moment any role
 * is granted it, this policy computes `selfReviewAllowed: false` again by itself, with no code change, and a proposal that something could one day carry out
 * needs a second person once more. `KOI_ACTION_REVIEW_REQUIRES_SECOND_PERSON=true` (server configuration, never a request field) restores that requirement
 * today, for a deployment that wants it before multi-user governance is built - it can only make the rule STRICTER.
 */
const actionExecutionIsPossible = ROLES.some((role) => hasPermission(role, "action:execute"));
export const GOVERNANCE_POLICY = Object.freeze({
  Decision: Object.freeze({ selfReviewAllowed: true }),
  Action: Object.freeze({
    get selfReviewAllowed() {
      return !actionExecutionIsPossible && process.env.KOI_ACTION_REVIEW_REQUIRES_SECOND_PERSON !== "true";
    },
  }),
});

/** The authenticated actor's user id as an ObjectId, or a 401 (never a default, never a guess). */
export function requireActorUserId(actorUserId) {
  if (typeof actorUserId !== "string" && !(actorUserId instanceof mongoose.Types.ObjectId)) {
    throw new AppError("Authentication is required", 401, { code: "MISSING_CREDENTIAL" });
  }
  if (!mongoose.isValidObjectId(String(actorUserId)) || String(actorUserId).length !== 24) {
    throw new AppError("Authentication is required", 401, { code: "MISSING_CREDENTIAL" });
  }
  return new mongoose.Types.ObjectId(String(actorUserId));
}

/** True for a record created under this rule. */
export const isGoverned = (record) => record?.governanceVersion === GOVERNANCE_VERSION;

/**
 * Throws (403) when the reviewer is the record's proposer. A governed record with no proposer is a data-integrity failure and is
 * refused too. A legacy record passes (documented above). `label` is "Decision" or "Action".
 */
export function assertReviewerIsNotProposer(record, reviewerUserId, label) {
  const reviewer = requireActorUserId(reviewerUserId);
  if (!isGoverned(record)) return reviewer;
  if (!record.proposedBy) {
    throw new AppError(`This ${label} has no recorded proposer and cannot be reviewed`, 409, { code: "PROPOSER_UNKNOWN" });
  }
  if (GOVERNANCE_POLICY[label]?.selfReviewAllowed === true) return reviewer;
  if (String(record.proposedBy) === String(reviewer)) {
    throw new AppError(`A ${label} cannot be approved or rejected by the user who proposed it`, 403, { code: SEPARATION_OF_DUTIES });
  }
  return reviewer;
}
