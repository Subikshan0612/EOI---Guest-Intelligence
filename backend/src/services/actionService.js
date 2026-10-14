import { Action, ACTION_RISK_LEVELS, ACTION_TYPES, ACTION_VERSION } from "../models/Action.js";
import { DECISION_VERSION, Decision } from "../models/Decision.js";
import { Intelligence } from "../models/Intelligence.js";
import { Workspace } from "../models/Workspace.js";
import { AppError } from "../utils/AppError.js";
import { parseObjectId, requireObjectId } from "../utils/objectId.js";
import { parsePagination, parseSort } from "../utils/pagination.js";
import { intelligenceVisibleTo, visibleIntelligenceMatch } from "./decisionService.js";
import { GOVERNANCE_VERSION, assertReviewerIsNotProposer, requireActorUserId } from "./governance.js";
import { normalizeCallerLevel } from "./knowledge/visibility.js";
import { sanitizeProse } from "./ai/proseReferenceSanitizer.js";
import {
  assertExists,
  assertSameWorkspace,
  assertWorkspaceUnchanged,
  findByIdOr404,
  findInWorkspaceOr404,
  isDuplicateKeyError,
  paginateQuery,
  pickDefined,
  requireFields,
  toPlain,
} from "./queryHelpers.js";

/**
 * Action V1 (Phase 29) - a PROPOSAL derived from ONE stored, APPROVED Decision V1.
 *
 *   Decision (approved) -> Action "proposed" -> review -> "approved" (== ready for a future execution
 *                                                          phase; NOT executed) | "rejected" (terminal)
 *
 * This module executes NOTHING and calls nothing external: proposing, approving and rejecting write only
 * the Action itself. There is no field anywhere in the V1 contract that can carry a URL, an HTTP method, a
 * shell/database command, a tool/function name, or any other executable payload (see ACTION_TYPES / the
 * closed request shape below) - an Action V1 is data describing a proposed response, never an instruction.
 *
 * A V1 record, once created, is IMMUTABLE except for the single status transition made through
 * approveAction/rejectAction: there is no endpoint anywhere (including the legacy generic ones, see
 * updateAction below) that can change a V1 record's decisionId, actionType, target or risk after it is
 * proposed - approved or not. This is what makes "approve A, then mutate A" and "approval transferred to
 * B" structurally impossible rather than something a snapshot/hash has to detect after the fact.
 */

const NOTE_MAX_LENGTH = 2000;
const TARGET_NOTE_MAX_LENGTH = 500;

// Deterministic, server-side ONLY. The request body can never set riskLevel (see proposeAction below); an
// actionType outside this map cannot exist (ACTION_TYPES is a closed enum), so there is no "unknown type"
// case to default here - proposeAction rejects it before this is ever consulted.
const RISK_BY_ACTION_TYPE = Object.freeze({
  maintenance_dispatch: "medium",
  guest_communication: "low",
  escalation: "high",
  inspection: "low",
  other: "medium",
});

// Fields only the V1 flow may write. A generic create/update request naming any of them is refused
// outright, exactly like Decision V1's V1_OWNED_FIELDS.
const V1_OWNED_FIELDS = ["actionVersion", "signalId", "actionType", "riskLevel", "target", "review", "transitions", "governanceVersion", "proposedBy", "reviewedBy"];

const LEGACY_UPDATABLE = ["decisionId", "type", "description", "status", "assignedTo", "dueAt", "completedAt", "result"];

const ACTION_STATUS_TRANSITIONS = {
  pending: ["in_progress", "cancelled"],
  in_progress: ["completed", "cancelled", "failed"],
  completed: [],
  cancelled: [],
  failed: [],
};

const isV1 = (action) => action?.actionVersion === ACTION_VERSION;

/**
 * Phase 7B — a Decision attached to an Action (at creation or via PATCH)
 * must actually belong to the SAME Intelligence the Action itself
 * references, not merely the same workspace. Before this phase, only
 * workspace membership was checked, which allowed a Decision belonging to a
 * different Intelligence in the same workspace to be attached to an Action.
 *
 * A `rejected` Decision explicitly records that the operation will not
 * proceed, so an Action must never be attached to one — at creation or via
 * a later PATCH that reassigns decisionId.
 */
function assertDecisionUsableForAction(decision, workspaceId, intelligenceId) {
  assertSameWorkspace(decision, workspaceId, "Decision");
  if (String(decision.intelligenceId) !== String(intelligenceId)) {
    throw new AppError("Decision does not belong to the same Intelligence as this Action", 400);
  }
  if (decision.status === "rejected") {
    throw new AppError("Cannot attach an Action to a rejected Decision", 400);
  }
  // Decision V1 is a PROPOSAL: an Action may only follow one that a human has approved.
  // (Legacy, pre-V1 Decisions keep their existing behaviour.) This closes the route by
  // which a merely PROPOSED V1 Decision could be turned into an Action. It is a data
  // invariant only - who may create an Action at all (action:execute) is undecided.
  if (decision.decisionVersion === DECISION_VERSION && decision.status !== "approved") {
    throw new AppError("An Action can only be attached to an approved Decision V1", 409);
  }
}

export async function createAction(body) {
  requireFields(body, ["workspaceId", "intelligenceId", "description"]);
  assertNoKeys(body, V1_OWNED_FIELDS, "Action V1 fields are set by POST /api/actions/propose/:decisionId only");
  const workspaceId = requireObjectId(body.workspaceId, "workspaceId");
  const intelligenceId = requireObjectId(body.intelligenceId, "intelligenceId");
  const decisionId = parseObjectId(body.decisionId, "decisionId");

  await assertExists(Workspace, workspaceId, "Workspace");
  const intelligence = await findByIdOr404(Intelligence, intelligenceId, "Intelligence");
  assertSameWorkspace(intelligence, workspaceId, "Intelligence");

  if (decisionId) {
    const decision = await findByIdOr404(Decision, decisionId, "Decision");
    assertDecisionUsableForAction(decision, workspaceId, intelligenceId);
  }

  const action = await Action.create({
    workspaceId,
    intelligenceId,
    decisionId,
    type: body.type,
    description: body.description,
    status: body.status,
    assignedTo: body.assignedTo,
    dueAt: body.dueAt,
    completedAt: body.completedAt,
    result: body.result,
  });

  return toPlain(action);
}

/**
 * Phase 16: a read is limited to records whose PARENT Intelligence the caller may see (the caller's
 * role ceiling, evaluated against the live Intelligence). A record whose parent is hidden or missing is
 * treated as absent - the same 404 as a record that does not exist.
 */
async function visibleIntelligenceIds(workspaceId, level) {
  return Intelligence.find({ workspaceId, ...visibleIntelligenceMatch(level) }).distinct("_id");
}

export async function listActions(query, authorizedLevel, { viewerUserId } = {}) {
  const workspaceId = requireObjectId(query.workspaceId, "workspaceId");
  const pagination = parsePagination(query);
  const sort = parseSort(query, ["createdAt", "updatedAt", "dueAt"], { createdAt: -1 });
  const filter = { workspaceId };
  const visibleIds = authorizedLevel === undefined ? null : await visibleIntelligenceIds(workspaceId, authorizedLevel);

  if (visibleIds) filter.intelligenceId = { $in: visibleIds };
  if (query.intelligenceId) {
    const requested = parseObjectId(query.intelligenceId, "intelligenceId");
    filter.intelligenceId = !visibleIds || visibleIds.some((id) => String(id) === String(requested)) ? requested : { $in: [] };
  }
  if (query.decisionId) filter.decisionId = parseObjectId(query.decisionId, "decisionId");
  if (query.status) filter.status = query.status;
  if (query.assignedTo) filter.assignedTo = query.assignedTo;

  const page = await paginateQuery(Action, filter, pagination, sort);
  // Phase 49: a V1 record is returned in its ONE view shape (no actor identity); a legacy record keeps its existing shape.
  return { ...page, items: page.items.map((item) => (isV1(item) ? toActionView(item, viewerUserId) : item)) };
}

export async function getActionById(id, workspaceId, authorizedLevel, { viewerUserId } = {}) {
  const scope = requireObjectId(workspaceId, "workspaceId");
  const record = await findInWorkspaceOr404(Action, requireObjectId(id), scope, "Action");
  if (authorizedLevel !== undefined) {
    const parent = await Intelligence.findOne({ _id: record.intelligenceId, workspaceId: scope }).lean();
    if (!intelligenceVisibleTo(parent, authorizedLevel)) throw new AppError("Action not found", 404);
  }
  return isV1(record) ? toActionView(toPlain(record), viewerUserId) : toPlain(record);
}

export async function updateAction(id, body, workspaceId) {
  const scope = requireObjectId(workspaceId, "workspaceId");
  const action = await findInWorkspaceOr404(Action, requireObjectId(id), scope, "Action");
  // Defense in depth beyond the route permission (action:execute, held by no role): even a caller who
  // somehow reached this function cannot mutate a V1 record through it. Mirrors Decision V1 exactly.
  if (isV1(action)) {
    throw new AppError("An Action V1 changes only through POST /api/actions/:id/approve or /reject", 409);
  }
  assertWorkspaceUnchanged(body, action);
  assertNoKeys(body, V1_OWNED_FIELDS, "Action V1 fields cannot be set on a legacy Action");
  const updates = pickDefined(body, LEGACY_UPDATABLE);

  if (Object.keys(updates).length === 0) {
    throw new AppError("No valid fields provided for update", 400);
  }

  if (updates.decisionId !== undefined) {
    updates.decisionId = parseObjectId(updates.decisionId, "decisionId");
    if (updates.decisionId) {
      const decision = await findByIdOr404(Decision, updates.decisionId, "Decision");
      assertDecisionUsableForAction(decision, action.workspaceId, action.intelligenceId);
    }
  }

  if (updates.status !== undefined && updates.status !== action.status) {
    const allowed = ACTION_STATUS_TRANSITIONS[action.status] || [];
    if (!allowed.includes(updates.status)) {
      throw new AppError(
        `Invalid status transition from "${action.status}" to "${updates.status}"`,
        400,
      );
    }
    // Deterministic, server-set — never trusts a client-supplied completedAt
    // for the transition that actually completes an Action.
    if (updates.status === "completed") {
      updates.completedAt = new Date();
    }
  }

  Object.assign(action, updates);
  await action.save();
  return toPlain(action);
}

// --------------------------------------------------------------------------
// Action V1 - propose / approve / reject (Phase 29)
// --------------------------------------------------------------------------

const iso = (value) => (value ? new Date(value).toISOString() : null);
const idOrNull = (value) => (value ? String(value) : null);

const sameUser = (a, b) => Boolean(a && b && String(a) === String(b));

/**
 * The ONE response shape for a V1 record. A legacy record simply has null in every V1-only field. Phase 49: no actor identity is exposed - the caller's relation to the
 * record is two booleans (`review.you`), exactly like the Decision view.
 */
export function toActionView(action, viewerUserId) {
  if (!action) return null;
  return {
    _id: String(action._id),
    workspaceId: String(action.workspaceId),
    intelligenceId: String(action.intelligenceId),
    decisionId: idOrNull(action.decisionId),
    signalId: idOrNull(action.signalId),
    propertyId: idOrNull(action.propertyId),
    actionVersion: action.actionVersion ?? null,
    actionType: action.actionType ?? null,
    riskLevel: action.riskLevel ?? null,
    urgency: action.urgency ?? null,
    target: action.target ? { note: action.target.note ?? null } : null,
    type: action.type ?? null,
    description: sanitizeProse(action.description),
    status: action.status,
    review: {
      reviewedAt: iso(action.review?.reviewedAt),
      reviewNote: action.review?.reviewNote ?? null,
      you: { proposed: sameUser(action.proposedBy, viewerUserId), reviewed: sameUser(action.review?.reviewedBy, viewerUserId) },
    },
    transitions: (action.transitions || []).map((t) => ({
      from: t.from,
      to: t.to,
      at: iso(t.at),
      note: t.note ?? null,
    })),
    createdAt: iso(action.createdAt),
    updatedAt: iso(action.updatedAt),
  };
}

function assertNoKeys(body, forbidden, message) {
  for (const key of forbidden) {
    if (body && body[key] !== undefined) throw new AppError(`${message}: "${key}" is not accepted`, 400);
  }
}

/**
 * Closed request shape for proposeAction: exactly {actionType?, target?:{note?}} - nothing else, ever. Phase 49: `actionType` is OPTIONAL - when it is absent the
 * server derives it from the parent Intelligence's validated structured safety result (see proposeAction); the person never has to choose it.
 */
function parseProposeBody(body) {
  if (body === undefined || body === null) return { actionType: undefined, targetNote: undefined };
  if (typeof body !== "object" || Array.isArray(body)) throw new AppError("Request body must be an object", 400);
  for (const key of Object.keys(body)) {
    if (key !== "actionType" && key !== "target") {
      throw new AppError(`Only "actionType" and "target" are accepted; "${key}" is not`, 400, { code: "UNSUPPORTED_FIELD", field: key });
    }
  }
  if (body.actionType !== undefined && (typeof body.actionType !== "string" || !ACTION_TYPES.includes(body.actionType))) {
    throw new AppError(`actionType must be one of: ${ACTION_TYPES.join(", ")}`, 422, { code: "UNKNOWN_ACTION_TYPE" });
  }
  let targetNote;
  if (body.target !== undefined) {
    if (body.target === null || typeof body.target !== "object" || Array.isArray(body.target)) {
      throw new AppError("target must be an object", 400);
    }
    for (const key of Object.keys(body.target)) {
      if (key !== "note") throw new AppError(`Only "target.note" is accepted; "target.${key}" is not`, 400, { code: "UNSUPPORTED_FIELD", field: `target.${key}` });
    }
    if (body.target.note !== undefined) {
      if (typeof body.target.note !== "string") throw new AppError("target.note must be a string", 400);
      const trimmed = body.target.note.trim();
      if (trimmed.length > TARGET_NOTE_MAX_LENGTH) {
        throw new AppError(`target.note must be at most ${TARGET_NOTE_MAX_LENGTH} characters`, 400);
      }
      targetNote = trimmed || undefined;
    }
  }
  return { actionType: body.actionType, targetNote };
}

// Phase 49 - SAFETY. The parent Intelligence's STRUCTURED, server-validated safety result (never prose, never the model, never the request) constrains the Action:
//   * under CRITICAL or LIFE_SAFETY_HAZARD the Action type IS the validated recommendedActionType; a request naming a different one is refused, so an Action can
//     never quietly weaken or contradict the requirement the analysis was admitted under (urgency and type);
//   * the risk class can only be RAISED by it (hazard -> critical, critical -> at least high);
//   * rejecting such an Action requires a recorded reason (a safety requirement is not set aside without one).
const SAFETY_CONSTRAINED_STATES = new Set(["CRITICAL", "LIFE_SAFETY_HAZARD"]);
export const ACTION_TYPE_CONFLICTS_WITH_SAFETY = "ACTION_TYPE_CONFLICTS_WITH_SAFETY";
export const ACTION_REASON_REQUIRED = "ACTION_REASON_REQUIRED";

// What a life-safety hazard requires of the response (safetyPolicy.js requiredActionTypes). Used only when the analysis recorded no type of its own - the deterministic
// TEST provider states none - so a hazard never falls back to a weaker type.
const HAZARD_REQUIRED_TYPES = ["escalation", "maintenance_dispatch"];
// The EXISTING access-refusal restriction (safetyPolicy.js ACCESS_REFUSED: "action type must not be maintenance_dispatch or inspection (both need entry); if a life-safety hazard is ALSO described, the only
// permitted type is escalation"), carried to this stage from the rule codes the server stored with the analysis. Nothing here is a new rule and access refusal never makes a hazard by itself.
const ACCESS_REFUSED_FORBIDDEN_TYPES = ["maintenance_dispatch", "inspection"];

function resolveActionType(requested, safety) {
  const refused = Array.isArray(safety?.rules) && safety.rules.includes("ACCESS_REFUSED");
  const type = pickActionType(requested, safety, refused);
  // Whatever the type came from (the request, the analysis, a default), an entry-requiring type is never admitted for a refused-access case.
  if (refused && ACCESS_REFUSED_FORBIDDEN_TYPES.includes(type)) throw new AppError("This Action must follow the safety requirement recorded with the analysis", 409, { code: ACTION_TYPE_CONFLICTS_WITH_SAFETY });
  return type;
}

function pickActionType(requested, safety, refused) {
  const recorded = ACTION_TYPES.includes(safety?.recommendedActionType) ? safety.recommendedActionType : undefined;
  const conflict = () => new AppError("This Action must follow the safety requirement recorded with the analysis", 409, { code: ACTION_TYPE_CONFLICTS_WITH_SAFETY });
  if (SAFETY_CONSTRAINED_STATES.has(safety?.state)) {
    if (recorded) {
      if (requested !== undefined && requested !== recorded) throw conflict();
      return recorded;
    }
    if (safety.state === "LIFE_SAFETY_HAZARD") {
      // hazard + refusal: the only permitted type is escalation, even when the analysis recorded no type of its own (the deterministic test provider, an older record)
      const permitted = refused ? ["escalation"] : HAZARD_REQUIRED_TYPES;
      if (requested !== undefined && !permitted.includes(requested)) throw conflict();
      return requested ?? "escalation";
    }
  }
  // Nothing constrains the type: the one the analysis recorded, else the one named, else the neutral "other" (a label for a person to read, executing nothing).
  return requested ?? recorded ?? "other";
}

function riskFor(actionType, safety) {
  const base = RISK_BY_ACTION_TYPE[actionType];
  if (safety?.state === "LIFE_SAFETY_HAZARD") return "critical";
  if (safety?.state === "CRITICAL" && (base === "low" || base === "medium")) return "high";
  return base;
}

async function loadVisibleDecisionForAction(decisionId, workspaceId, level) {
  // Fails closed with the SAME 404 a missing Decision would give - never reveals whether a foreign or
  // hidden Decision exists (findInWorkspaceOr404 is workspace-scoped; the visibility check below adds the
  // parent-Intelligence ceiling on top, exactly like decisionService.js's loadVisibleDecision).
  const decision = await findInWorkspaceOr404(Decision, decisionId, workspaceId, "Decision");
  const parent = await Intelligence.findOne({ _id: decision.intelligenceId, workspaceId }).lean();
  if (!intelligenceVisibleTo(parent, level)) throw new AppError("Decision not found", 404);
  return { decision, parent };
}

/**
 * POST /api/actions/propose/:decisionId
 * Requires an APPROVED Decision V1. `actionType` is the only meaningful client input; `riskLevel` is always
 * computed server-side from it (RISK_BY_ACTION_TYPE) - a client can never set, lower or otherwise influence
 * it. Idempotent per (workspace, Decision): re-proposing returns the existing proposal (200) rather than a
 * duplicate. Never approves, never mutates, the Decision it reads.
 * @returns {{ record: object, created: boolean }}
 */
export async function proposeAction(decisionId, workspaceId, body, { authorizedLevel, actorUserId } = {}) {
  const scope = requireObjectId(workspaceId, "workspaceId");
  // Phase 35: the proposer is the authenticated actor - required, so an Action V1 can never be created without one.
  const proposer = requireActorUserId(actorUserId);
  const id = requireObjectId(decisionId, "decisionId");
  const level = normalizeCallerLevel(authorizedLevel);
  const { actionType, targetNote } = parseProposeBody(body);

  const { decision, parent } = await loadVisibleDecisionForAction(id, scope, level);
  if (decision.decisionVersion !== DECISION_VERSION) {
    throw new AppError("An Action can only be proposed from a Decision V1", 422);
  }
  // The security rule this phase exists to enforce: a Decision that has not reached "approved" must not
  // produce a ready Action. "proposed" and "rejected" are both refused here, identically.
  if (decision.status !== "approved") {
    throw new AppError(`An Action can only be proposed from an approved Decision (this one is "${decision.status}")`, 409);
  }

  const existing = await Action.findOne({ workspaceId: scope, decisionId: id, actionVersion: ACTION_VERSION });
  if (existing) return { record: toActionView(toPlain(existing), proposer), created: false };

  const safety = parent?.safety;
  const resolvedType = resolveActionType(actionType, safety);

  try {
    const created = await Action.create({
      workspaceId: scope,
      intelligenceId: decision.intelligenceId,
      decisionId: id,
      signalId: decision.signalId,
      propertyId: decision.propertyId,
      actionVersion: ACTION_VERSION,
      actionType: resolvedType,
      riskLevel: riskFor(resolvedType, safety),
      urgency: ["immediate", "prompt", "routine"].includes(safety?.urgency) ? safety.urgency : SAFETY_CONSTRAINED_STATES.has(safety?.state) ? "immediate" : undefined,
      target: targetNote ? { note: targetNote } : undefined,
      type: "operational",
      description: sanitizeProse(decision.description),
      governanceVersion: GOVERNANCE_VERSION,
      proposedBy: proposer,
      status: "proposed",
    });
    return { record: toActionView(toPlain(created), proposer), created: true };
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      const raced = await Action.findOne({ workspaceId: scope, decisionId: id, actionVersion: ACTION_VERSION });
      if (raced) return { record: toActionView(toPlain(raced), proposer), created: false };
    }
    throw error;
  }
}

function parseReviewBody(body) {
  if (body === undefined || body === null) return {};
  if (typeof body !== "object" || Array.isArray(body)) throw new AppError("Request body must be an object", 400);
  for (const key of Object.keys(body)) {
    if (key !== "note") throw new AppError(`Only "note" is accepted; "${key}" is not`, 400);
  }
  if (body.note === undefined || body.note === null) return {};
  if (typeof body.note !== "string") throw new AppError("note must be a string", 400);
  const note = body.note.trim();
  if (note.length > NOTE_MAX_LENGTH) throw new AppError(`note must be at most ${NOTE_MAX_LENGTH} characters`, 400);
  return note ? { note } : {};
}

async function loadVisibleActionV1(id, workspaceId, level) {
  const action = await findInWorkspaceOr404(Action, id, workspaceId, "Action");
  const parent = await Intelligence.findOne({ _id: action.intelligenceId, workspaceId }).lean();
  if (!intelligenceVisibleTo(parent, level)) throw new AppError("Action not found", 404);
  return { action, parent };
}

/**
 * approve/reject an Action V1. Bound to the EXACT Action named in the URL - there is no field anywhere in
 * the request that names a different Action, so "approve A, apply to B" has no expressible request shape.
 * Idempotent: repeating the SAME transition returns the current record unchanged (200), no duplicate
 * transition recorded; the opposite transition from a terminal state is refused (409).
 */
async function reviewAction(target, id, workspaceId, body, { authorizedLevel, actorUserId } = {}) {
  const level = normalizeCallerLevel(authorizedLevel);
  const { note } = parseReviewBody(body);
  const scope = requireObjectId(workspaceId, "workspaceId");
  const actionId = requireObjectId(id);

  const { action: current, parent } = await loadVisibleActionV1(actionId, scope, level);
  if (!isV1(current)) throw new AppError("Only an Action V1 can be approved or rejected here", 409);
  // Phase 35: proposer != reviewer (see services/governance.js), checked before any outcome, including the idempotent answer.
  const reviewer = assertReviewerIsNotProposer(current, actorUserId, "Action");

  if (current.status === target) return toActionView(toPlain(current), reviewer);
  if (current.status !== "proposed") {
    throw new AppError(`A ${current.status} Action cannot be ${target}`, 409);
  }
  if (target === "rejected" && SAFETY_CONSTRAINED_STATES.has(parent?.safety?.state) && !note) {
    throw new AppError("Rejecting an Action that carries a safety requirement needs a recorded reason", 400, { code: ACTION_REASON_REQUIRED });
  }

  const now = new Date();
  const transition = { from: "proposed", to: target, at: now, ...(note ? { note } : {}) };
  // The status guard is part of the filter, so two racing reviews cannot both win, and this UPDATE can
  // never touch any document but the one named by _id - there is no way to redirect it to another Action.
  const updated = await Action.findOneAndUpdate(
    { _id: actionId, workspaceId: scope, actionVersion: ACTION_VERSION, status: "proposed" },
    {
      $set: { status: target, "review.reviewedAt": now, "review.reviewedBy": reviewer, ...(note ? { "review.reviewNote": note } : {}) },
      $push: { transitions: transition },
    },
    { new: true },
  );
  if (updated) return toActionView(toPlain(updated), reviewer);

  const after = await Action.findOne({ _id: actionId, workspaceId: scope });
  if (after && after.status === target) return toActionView(toPlain(after), reviewer);
  throw new AppError(`A ${after?.status ?? "missing"} Action cannot be ${target}`, 409);
}

export const approveAction = (id, workspaceId, body, options = {}) =>
  reviewAction("approved", id, workspaceId, body, options);

export const rejectAction = (id, workspaceId, body, options = {}) =>
  reviewAction("rejected", id, workspaceId, body, options);

export { ACTION_TYPES, ACTION_RISK_LEVELS, RISK_BY_ACTION_TYPE };
