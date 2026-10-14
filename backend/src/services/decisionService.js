import mongoose from "mongoose";
import { DECISION_STATUSES, DECISION_VERSION, Decision } from "../models/Decision.js";
import { ANALYSIS_CONFIDENCE_LEVELS, ANALYSIS_VERSION, Intelligence } from "../models/Intelligence.js";
import { Signal } from "../models/Signal.js";
import { Workspace } from "../models/Workspace.js";
import { AppError } from "../utils/AppError.js";
import { parseObjectId, requireObjectId } from "../utils/objectId.js";
import { buildPagination, parsePagination, parseSort } from "../utils/pagination.js";
import { GOVERNANCE_VERSION, assertReviewerIsNotProposer, requireActorUserId } from "./governance.js";
import { allowedVisibilities, canAccess, normalizeCallerLevel, visibilityRank } from "./knowledge/visibility.js";
import { knowledgeTitles, sanitizeProse } from "./ai/proseReferenceSanitizer.js";
import {
  assertExists,
  assertSameWorkspace,
  assertWorkspaceUnchanged,
  findByIdOr404,
  findInWorkspaceOr404,
  isDuplicateKeyError,
  pickDefined,
  requireFields,
  toPlain,
} from "./queryHelpers.js";

/**
 * Decision V1 - a PROPOSAL derived from ONE stored Intelligence V1 record.
 *
 *   Signal -> Intelligence V1 (stored) -> Decision V1 (proposed) -> approved | rejected
 *
 * A Decision executes NOTHING. Proposing, approving and rejecting write only the
 * Decision itself: no Action, no Outcome, no message, no integration, no model
 * call. This module deliberately imports neither the Action/Outcome models nor
 * the AI client.
 *
 * There is no authentication in EOI, so a review records WHEN and an optional
 * note - never WHO. Approve/reject are gated on the trusted server-side
 * knowledge level (staff or above) as an interim, fail-closed measure; that is
 * not identity and not real authorization.
 */

const SEVERITY_TO_PRIORITY = Object.freeze({ low: "low", medium: "medium", high: "high", critical: "critical" });
const STAFF_RANK = visibilityRank("staff");
const NOTE_MAX_LENGTH = 2000;

// Fields only the V1 flow may write. A generic create/update request naming any of
// them is refused outright rather than silently ignored.
const V1_OWNED_FIELDS = [
  "decisionVersion",
  "signalId",
  "propertyId",
  "confidence",
  "analysisVersion",
  "analysisLevel",
  "knowledgeVisibility",
  "review",
  "transitions",
  // Phase 35: identity of the proposer/reviewer comes only from the authenticated actor, never from a body.
  "governanceVersion",
  "proposedBy",
  "reviewedBy",
];

const LEGACY_UPDATABLE = ["type", "description", "priority", "status"];

/**
 * LEGACY (pre-V1) lifecycle, kept unchanged for historical records only. It is
 * never applied to a Decision V1, which cannot be updated through the generic
 * endpoint at all.
 */
const DECISION_STATUS_TRANSITIONS = {
  proposed: ["approved", "rejected", "completed"],
  approved: ["completed"],
  rejected: ["completed"],
  completed: [],
};

const isV1 = (decision) => decision?.decisionVersion === DECISION_VERSION;

// --------------------------------------------------------------------------
// Serializer - the ONLY response shape. Never return a raw document.
// --------------------------------------------------------------------------

const iso = (value) => (value ? new Date(value).toISOString() : null);
const idOrNull = (value) => (value ? String(value) : null);

/**
 * @param {object} decision
 * @param {string|object} [viewerUserId] the AUTHENTICATED caller (req.actor.userId). It is used only to answer "was this proposed / reviewed by YOU?" (two booleans);
 *   no user id, name or email of anyone is ever returned. Without a viewer both are false.
 */
export function toDecisionView(decision, viewerUserId) {
  if (!decision) return null;
  const viewer = viewerUserId ? String(viewerUserId) : null;
  const sameUser = (id) => Boolean(viewer && id && String(id) === viewer);
  return {
    _id: String(decision._id),
    workspaceId: String(decision.workspaceId),
    intelligenceId: String(decision.intelligenceId),
    signalId: idOrNull(decision.signalId),
    propertyId: idOrNull(decision.propertyId),
    decisionVersion: decision.decisionVersion ?? null,
    type: decision.type ?? null,
    description: sanitizeProse(decision.description),
    priority: decision.priority,
    confidence: decision.confidence ?? null,
    analysisVersion: decision.analysisVersion ?? null,
    analysisLevel: decision.analysisLevel ?? null,
    knowledgeVisibility: decision.knowledgeVisibility ?? null,
    status: decision.status,
    review: {
      reviewedAt: iso(decision.review?.reviewedAt),
      reviewNote: decision.review?.reviewNote ?? null,
      alternative: decision.review?.alternative ?? null,
      // Phase 48: the CALLER's relation to this record - two booleans, never an identity (no id, name or email of anyone is returned). It lets the UI say
      // "you submitted this" so it never offers the submitter a review the server will refuse. The server enforces the rule regardless.
      you: { proposed: sameUser(decision.proposedBy), reviewed: sameUser(decision.review?.reviewedBy) },
    },
    transitions: (decision.transitions || []).map((t) => ({
      from: t.from,
      to: t.to,
      at: iso(t.at),
      note: t.note ?? null,
    })),
    createdAt: iso(decision.createdAt),
    updatedAt: iso(decision.updatedAt),
  };
}

// --------------------------------------------------------------------------
// Visibility - always evaluated against the LIVE parent Intelligence.
// The Decision's own snapshot markers are never used to authorize.
// --------------------------------------------------------------------------

/** True when a caller at `level` may see this Intelligence. Fails closed. */
export function intelligenceVisibleTo(intelligence, level) {
  if (!intelligence) return false;
  if (intelligence.analysisLevel != null && !canAccess(level, intelligence.analysisLevel)) return false;
  if (intelligence.knowledgeVisibility && !canAccess(level, intelligence.knowledgeVisibility)) return false;
  return true;
}

/** The same rule expressed as a MongoDB filter over Intelligence documents. */
export function visibleIntelligenceMatch(level) {
  const allowed = allowedVisibilities(level);
  return {
    $and: [
      { $or: [{ analysisLevel: { $exists: false } }, { analysisLevel: null }, { analysisLevel: { $in: allowed } }] },
      { knowledgeVisibility: { $in: [...allowed, null] } },
    ],
  };
}

async function loadVisibleDecision(id, workspaceId, level) {
  return (await loadVisibleDecisionWithParent(id, workspaceId, level)).decision;
}

/** The Decision AND its live parent Intelligence (needed by the review path, which applies the parent's STRUCTURED safety state). */
async function loadVisibleDecisionWithParent(id, workspaceId, level) {
  const decision = await findInWorkspaceOr404(Decision, id, workspaceId, "Decision");
  const parent = await Intelligence.findOne({ _id: decision.intelligenceId, workspaceId }).lean();
  // Same 404 as a missing Decision: a hidden or unresolvable parent reveals nothing.
  if (!intelligenceVisibleTo(parent, level)) throw new AppError("Decision not found", 404);
  return { decision, parent };
}

function assertNoKeys(body, forbidden, message) {
  for (const key of forbidden) {
    if (body && body[key] !== undefined) throw new AppError(`${message}: "${key}" is not accepted`, 400);
  }
}

// --------------------------------------------------------------------------
// Propose
// --------------------------------------------------------------------------

/**
 * POST /api/decisions/propose/:intelligenceId
 * Everything is derived server-side from the stored Intelligence V1 and its
 * Signal; the request may carry nothing. Idempotent per (workspace, Intelligence).
 * @returns {{ record: object, created: boolean }}
 */
export async function proposeDecision(intelligenceId, workspaceId, body, { authorizedLevel, actorUserId } = {}) {
  if (body && typeof body === "object" && Object.keys(body).length > 0) {
    throw new AppError("Proposing a Decision takes no request body; it is derived from the stored Intelligence", 400);
  }
  // Phase 35: the proposer is the authenticated actor - required, so a Decision V1 can never be created without one.
  const proposer = requireActorUserId(actorUserId);
  const scope = requireObjectId(workspaceId, "workspaceId");
  const id = requireObjectId(intelligenceId, "intelligenceId");
  const level = normalizeCallerLevel(authorizedLevel);

  const intelligence = await findInWorkspaceOr404(Intelligence, id, scope, "Intelligence");
  if (!intelligenceVisibleTo(intelligence.toObject(), level)) throw new AppError("Intelligence not found", 404);

  const analysis = intelligence.analysis;
  if (
    intelligence.analysisVersion !== ANALYSIS_VERSION ||
    !analysis ||
    typeof analysis.recommendation !== "string" ||
    !analysis.recommendation.trim() ||
    !ANALYSIS_CONFIDENCE_LEVELS.includes(analysis.confidence)
  ) {
    throw new AppError("A Decision can only be proposed from a stored Intelligence V1 analysis", 422);
  }
  if (!Array.isArray(intelligence.signalIds) || intelligence.signalIds.length !== 1) {
    throw new AppError("The Intelligence V1 analysis does not reference exactly one Signal", 422);
  }

  const signal = await findInWorkspaceOr404(Signal, intelligence.signalIds[0], scope, "Signal");
  const severityPriority = SEVERITY_TO_PRIORITY[signal.severity];
  if (!severityPriority) throw new AppError("The Signal severity has no Decision priority", 422);
  // Phase 48: the priority honours the STRUCTURED safety state stored with the Intelligence (never prose, never the model): a life-safety hazard is never
  // filed below "critical", whatever severity the Signal happened to be recorded with. It can only RAISE the priority.
  const priority = intelligence.safety?.state === "LIFE_SAFETY_HAZARD" ? "critical" : severityPriority;

  const existing = await Decision.findOne({ workspaceId: scope, intelligenceId: id, decisionVersion: DECISION_VERSION });
  if (existing) return { record: toDecisionView(toPlain(existing), proposer), created: false };

  try {
    const created = await Decision.create({
      workspaceId: scope,
      intelligenceId: id,
      signalId: signal._id,
      propertyId: intelligence.propertyId,
      decisionVersion: DECISION_VERSION,
      type: "operational",
      // Phase 53D: the snapshot of the recommendation never carries an internal reference, even when the parent was stored before the persistence boundary existed.
      description: sanitizeProse(analysis.recommendation, { titles: knowledgeTitles(intelligence.knowledgeProvenance) }),
      priority,
      confidence: analysis.confidence,
      analysisVersion: intelligence.analysisVersion,
      analysisLevel: intelligence.analysisLevel,
      knowledgeVisibility: intelligence.knowledgeVisibility,
      governanceVersion: GOVERNANCE_VERSION,
      proposedBy: proposer,
      status: "proposed",
    });
    return { record: toDecisionView(toPlain(created), proposer), created: true };
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      const raced = await Decision.findOne({ workspaceId: scope, intelligenceId: id, decisionVersion: DECISION_VERSION });
      if (raced) return { record: toDecisionView(toPlain(raced), proposer), created: false };
    }
    throw error;
  }
}

// --------------------------------------------------------------------------
// Read
// --------------------------------------------------------------------------

export async function listDecisions(query, authorizedLevel, { viewerUserId } = {}) {
  const workspaceId = requireObjectId(query.workspaceId, "workspaceId");
  const level = normalizeCallerLevel(authorizedLevel);
  const pagination = parsePagination(query);
  const sort = parseSort(query, ["createdAt", "updatedAt", "priority"], { createdAt: -1 });
  // Aggregation does not cast ids the way find() does, so cast them explicitly.
  const oid = (value) => new mongoose.Types.ObjectId(String(value));
  const match = { workspaceId: oid(workspaceId) };

  if (query.intelligenceId) match.intelligenceId = oid(parseObjectId(query.intelligenceId, "intelligenceId"));
  if (query.signalId) match.signalId = oid(parseObjectId(query.signalId, "signalId"));
  if (query.propertyId) match.propertyId = oid(parseObjectId(query.propertyId, "propertyId"));
  for (const key of ["status", "priority"]) {
    if (query[key] !== undefined) {
      if (typeof query[key] !== "string") throw new AppError(`${key} must be a string`, 400);
      match[key] = query[key];
    }
  }

  // Visibility is decided by the LIVE parent Intelligence inside the query, so
  // pagination and totals only ever count Decisions the caller may see. A Decision
  // whose parent is missing or in another workspace is excluded (fail closed).
  const visibleOnly = [
    {
      $lookup: {
        from: Intelligence.collection.name,
        let: { intelligenceId: "$intelligenceId", workspaceId: "$workspaceId" },
        pipeline: [
          { $match: { $expr: { $and: [{ $eq: ["$_id", "$$intelligenceId"] }, { $eq: ["$workspaceId", "$$workspaceId"] }] } } },
          { $match: visibleIntelligenceMatch(level) },
          { $project: { _id: 1 } },
        ],
        as: "parent",
      },
    },
    { $match: { "parent.0": { $exists: true } } },
  ];

  const [rows, totals] = await Promise.all([
    Decision.aggregate([
      { $match: match },
      ...visibleOnly,
      { $sort: { ...sort, _id: -1 } },
      { $skip: pagination.skip },
      { $limit: pagination.limit },
    ]),
    Decision.aggregate([{ $match: match }, ...visibleOnly, { $count: "total" }]),
  ]);
  const total = totals[0]?.total ?? 0;

  return {
    items: rows.map((row) => toDecisionView(row, viewerUserId)),
    pagination: buildPagination({ page: pagination.page, limit: pagination.limit, total }),
  };
}

export async function getDecisionById(id, workspaceId, authorizedLevel, { viewerUserId } = {}) {
  const scope = requireObjectId(workspaceId, "workspaceId");
  const level = normalizeCallerLevel(authorizedLevel);
  const decision = await loadVisibleDecision(requireObjectId(id), scope, level);
  return toDecisionView(toPlain(decision), viewerUserId);
}

// --------------------------------------------------------------------------
// Review (approve / reject)
// --------------------------------------------------------------------------

function parseReviewBody(body, target) {
  if (body === undefined || body === null) return {};
  if (typeof body !== "object" || Array.isArray(body)) throw new AppError("Request body must be an object", 400);
  // Phase 48: a REJECTION may also carry the human's `alternative` decision; nothing else is ever accepted, and an approval takes only a note.
  const allowed = target === "rejected" ? ["note", "alternative"] : ["note"];
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw new AppError(`Only ${allowed.map((k) => `"${k}"`).join(" and ")} ${allowed.length > 1 ? "are" : "is"} accepted; "${key}" is not`, 400);
  }
  const text = (value, field) => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string") throw new AppError(`${field} must be a string`, 400);
    const trimmed = value.trim();
    if (trimmed.length > NOTE_MAX_LENGTH) throw new AppError(`${field} must be at most ${NOTE_MAX_LENGTH} characters`, 400);
    return trimmed || undefined;
  };
  const note = text(body.note, "note");
  const alternative = text(body.alternative, "alternative");
  return { ...(note ? { note } : {}), ...(alternative ? { alternative } : {}) };
}

// Phase 48 - SAFETY. The stored, server-validated safety state of the parent Intelligence constrains how the recommendation may be turned down. Structured field
// only (never prose, never the model); it can only ADD a requirement to a rejection, never relax anything, and an approval is never blocked by it.
//   CRITICAL, LIFE_SAFETY_HAZARD   rejecting requires a recorded reason
//   LIFE_SAFETY_HAZARD             rejecting also requires what will be done INSTEAD (a hazard cannot simply be set aside)
export const DECISION_REASON_REQUIRED = "DECISION_REASON_REQUIRED";
export const DECISION_ALTERNATIVE_REQUIRED = "DECISION_ALTERNATIVE_REQUIRED";
function assertSafetyAllowsRejection(parent, { note, alternative }) {
  const state = parent?.safety?.state;
  if ((state === "CRITICAL" || state === "LIFE_SAFETY_HAZARD") && !note) {
    throw new AppError("Rejecting a recommendation that carries a safety assessment requires a recorded reason", 400, { code: DECISION_REASON_REQUIRED });
  }
  if (state === "LIFE_SAFETY_HAZARD" && !alternative) {
    throw new AppError("Rejecting a recommendation for a life-safety hazard requires recording what will be done instead", 400, { code: DECISION_ALTERNATIVE_REQUIRED });
  }
}

/** Interim, fail-closed gate on the trusted server-side level. Not identity. */
function assertReviewAllowed(level) {
  if (visibilityRank(normalizeCallerLevel(level)) < STAFF_RANK) {
    throw new AppError("Approving or rejecting a Decision requires staff-level authorization", 403);
  }
}

async function reviewDecision(target, id, workspaceId, body, { authorizedLevel, actorUserId } = {}) {
  const level = normalizeCallerLevel(authorizedLevel);
  assertReviewAllowed(level);
  const { note, alternative } = parseReviewBody(body, target);
  const scope = requireObjectId(workspaceId, "workspaceId");
  const decisionId = requireObjectId(id);

  const { decision: current, parent } = await loadVisibleDecisionWithParent(decisionId, scope, level);
  if (!isV1(current)) throw new AppError("Only a Decision V1 can be approved or rejected here", 409);
  // The reviewer is the authenticated actor (never a body field) and is recorded. Whether the proposer may also be the reviewer is the Decision policy in
  // governance.js (Phase 48.1: yes - a single-user product; an Action proposal still requires a different reviewer). Checked BEFORE any outcome.
  const reviewer = assertReviewerIsNotProposer(current, actorUserId, "Decision");

  // Already in the requested state: nothing to write, and no second transition.
  if (current.status === target) return toDecisionView(toPlain(current), reviewer);
  if (current.status !== "proposed") {
    throw new AppError(`A ${current.status} Decision cannot be ${target}`, 409);
  }
  if (target === "rejected") assertSafetyAllowsRejection(parent, { note, alternative });

  const now = new Date();
  const transition = { from: "proposed", to: target, at: now, ...(note ? { note } : {}) };
  // The status guard is part of the filter, so two racing reviews cannot both win.
  const updated = await Decision.findOneAndUpdate(
    { _id: decisionId, workspaceId: scope, decisionVersion: DECISION_VERSION, status: "proposed" },
    {
      $set: { status: target, "review.reviewedAt": now, "review.reviewedBy": reviewer, ...(note ? { "review.reviewNote": note } : {}), ...(alternative ? { "review.alternative": alternative } : {}) },
      $push: { transitions: transition },
    },
    { new: true },
  );
  if (updated) return toDecisionView(toPlain(updated), reviewer);

  const after = await Decision.findOne({ _id: decisionId, workspaceId: scope });
  if (after && after.status === target) return toDecisionView(toPlain(after), reviewer);
  throw new AppError(`A ${after?.status ?? "missing"} Decision cannot be ${target}`, 409);
}

export const approveDecision = (id, workspaceId, body, options = {}) =>
  reviewDecision("approved", id, workspaceId, body, options);

export const rejectDecision = (id, workspaceId, body, options = {}) =>
  reviewDecision("rejected", id, workspaceId, body, options);

// --------------------------------------------------------------------------
// LEGACY generic create/update. Kept only for pre-V1 records; they can neither
// create nor touch a Decision V1, nor attach arbitrary text to a V1 Intelligence.
// --------------------------------------------------------------------------

export async function createDecision(body) {
  requireFields(body, ["workspaceId", "intelligenceId", "description"]);
  assertNoKeys(body, V1_OWNED_FIELDS, "Decision V1 fields are set by POST /api/decisions/propose/:intelligenceId only");
  const workspaceId = requireObjectId(body.workspaceId, "workspaceId");
  const intelligenceId = requireObjectId(body.intelligenceId, "intelligenceId");

  await assertExists(Workspace, workspaceId, "Workspace");
  const intelligence = await findByIdOr404(Intelligence, intelligenceId, "Intelligence");
  assertSameWorkspace(intelligence, workspaceId, "Intelligence");
  if (intelligence.analysisVersion === ANALYSIS_VERSION) {
    throw new AppError(
      "A Decision for an Intelligence V1 analysis must be proposed with POST /api/decisions/propose/:intelligenceId",
      409,
    );
  }

  const decision = await Decision.create({
    workspaceId,
    intelligenceId,
    type: body.type,
    description: body.description,
    priority: body.priority,
    status: body.status,
  });

  return toDecisionView(toPlain(decision));
}

export async function updateDecision(id, body, workspaceId) {
  const scope = requireObjectId(workspaceId, "workspaceId");
  const decision = await findInWorkspaceOr404(Decision, requireObjectId(id), scope, "Decision");
  if (isV1(decision)) {
    throw new AppError("A Decision V1 changes only through POST /api/decisions/:id/approve or /reject", 409);
  }
  assertWorkspaceUnchanged(body, decision);
  assertNoKeys(body, V1_OWNED_FIELDS, "Decision V1 fields cannot be set on a legacy Decision");
  const updates = pickDefined(body, LEGACY_UPDATABLE);

  if (Object.keys(updates).length === 0) {
    throw new AppError("No valid fields provided for update", 400);
  }

  if (updates.status !== undefined && updates.status !== decision.status) {
    const allowed = DECISION_STATUS_TRANSITIONS[decision.status] || [];
    if (!allowed.includes(updates.status)) {
      throw new AppError(
        `Invalid status transition from "${decision.status}" to "${updates.status}"`,
        400,
      );
    }
  }

  Object.assign(decision, updates);
  await decision.save();
  return toDecisionView(toPlain(decision));
}

export { DECISION_STATUSES };
