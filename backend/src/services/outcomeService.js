import { ACTION_VERSION, Action } from "../models/Action.js";
import { Intelligence } from "../models/Intelligence.js";
import { Outcome, OUTCOME_V1_STATUSES, OUTCOME_VERSION } from "../models/Outcome.js";
import { Workspace } from "../models/Workspace.js";
import { AppError } from "../utils/AppError.js";
import { parseObjectId, requireObjectId } from "../utils/objectId.js";
import { parsePagination, parseSort } from "../utils/pagination.js";
import { intelligenceVisibleTo, visibleIntelligenceMatch } from "./decisionService.js";
import { requireActorUserId } from "./governance.js";
import { normalizeCallerLevel } from "./knowledge/visibility.js";
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
 * Outcome V1 (Phase 30) - "the observed result of an Action after an execution attempt". It is NOT a
 * proposal, an approval, a recommendation, a prediction, or anything an LLM said - it is a fact recorded
 * about something that already happened. An approved Action with no execution result has
 * `Action.status === "approved"` and NO Outcome; nothing in this codebase changes that automatically.
 *
 * THERE IS NO EXECUTION ENGINE. Phase 50: recordOutcome() is now reached by ONE authenticated route, POST /api/outcomes/record/:actionId, where a PERSON reports what
 * actually happened ("record what happened"). An Outcome is a HUMAN-RECORDED observation: it is never generated, inferred, classified or summarised by a model, it calls
 * no AI service, and recording one executes nothing, changes no other record and feeds nothing into Learning. The Phase 17 boundary is untouched: `action:execute`
 * is still held by no role, and the legacy generic create / update endpoints (which need it) stay closed.
 */

const RESULT_TEXT_MAX_LENGTH = 2000;
const UPDATABLE = ["actionId", "status", "result", "metrics", "feedback", "occurredAt"];

// Fields only recordOutcome may write. The LEGACY generic create/update can never set them, exactly
// mirroring Decision/Action V1's own V1_OWNED_FIELDS pattern.
const V1_OWNED_FIELDS = ["outcomeVersion", "actionVersion", "decisionId", "signalId", "propertyId", "recordedAt"];

const isV1 = (outcome) => outcome?.outcomeVersion === OUTCOME_VERSION;

function assertNoKeys(body, forbidden, message) {
  for (const key of forbidden) {
    if (body && body[key] !== undefined) throw new AppError(`${message}: "${key}" is not accepted`, 400);
  }
}

/**
 * Phase 7C — an Action attached to an Outcome (at creation or via PATCH)
 * must actually belong to the SAME Intelligence the Outcome itself
 * references, not merely the same workspace. Before this phase, only
 * workspace membership was checked, which allowed an Action belonging to a
 * different Intelligence in the same workspace to be attached to an
 * Outcome — the same category of gap Phase 7B found and fixed one layer up
 * the chain, between Action and Decision.
 *
 * Deliberately does NOT check Action.status for a LEGACY Action: Outcome may attach to a legacy Action in
 * any status (pending/in_progress/completed/cancelled/failed) — that is an intentional Phase 7C decision,
 * not an oversight, and Phase 30 leaves it exactly as it was.
 *
 * Phase 30 ADDS one new rule, for Action V1 only: an Outcome can only attach to an Action V1 that has
 * actually reached "approved" - the same "not proposed, not rejected" gate Phase 7B/29 already apply one
 * layer up (Decision -> Action). This closes the same category of gap for the new V1 lifecycle; it does not
 * change legacy behavior at all.
 */
function assertActionUsableForOutcome(action, workspaceId, intelligenceId) {
  assertSameWorkspace(action, workspaceId, "Action");
  if (String(action.intelligenceId) !== String(intelligenceId)) {
    throw new AppError("Action does not belong to the same Intelligence as this Outcome", 400);
  }
  if (action.actionVersion === ACTION_VERSION && action.status !== "approved") {
    throw new AppError("An Outcome can only be recorded for an approved Action V1", 409);
  }
}

export async function createOutcome(body) {
  requireFields(body, ["workspaceId", "intelligenceId"]);
  assertNoKeys(body, V1_OWNED_FIELDS, "Outcome V1 fields are set by the trusted execution boundary only");
  const workspaceId = requireObjectId(body.workspaceId, "workspaceId");
  const intelligenceId = requireObjectId(body.intelligenceId, "intelligenceId");
  const actionId = parseObjectId(body.actionId, "actionId");

  await assertExists(Workspace, workspaceId, "Workspace");
  const intelligence = await findByIdOr404(Intelligence, intelligenceId, "Intelligence");
  assertSameWorkspace(intelligence, workspaceId, "Intelligence");

  if (actionId) {
    const action = await findByIdOr404(Action, actionId, "Action");
    assertActionUsableForOutcome(action, workspaceId, intelligenceId);
  }

  const outcome = await Outcome.create({
    workspaceId,
    intelligenceId,
    actionId,
    status: body.status,
    result: body.result,
    metrics: body.metrics,
    feedback: body.feedback,
    occurredAt: body.occurredAt,
  });

  return toPlain(outcome);
}

/**
 * Phase 16: a read is limited to records whose PARENT Intelligence the caller may see (the caller's
 * role ceiling, evaluated against the live Intelligence). A record whose parent is hidden or missing is
 * treated as absent - the same 404 as a record that does not exist.
 */
async function visibleIntelligenceIds(workspaceId, level) {
  return Intelligence.find({ workspaceId, ...visibleIntelligenceMatch(level) }).distinct("_id");
}

export async function listOutcomes(query, authorizedLevel, { viewerUserId } = {}) {
  const workspaceId = requireObjectId(query.workspaceId, "workspaceId");
  const pagination = parsePagination(query);
  const sort = parseSort(query, ["createdAt", "updatedAt", "occurredAt"], { occurredAt: -1 });
  const filter = { workspaceId };
  const visibleIds = authorizedLevel === undefined ? null : await visibleIntelligenceIds(workspaceId, authorizedLevel);

  if (visibleIds) filter.intelligenceId = { $in: visibleIds };
  if (query.intelligenceId) {
    const requested = parseObjectId(query.intelligenceId, "intelligenceId");
    filter.intelligenceId = !visibleIds || visibleIds.some((id) => String(id) === String(requested)) ? requested : { $in: [] };
  }
  if (query.actionId) filter.actionId = parseObjectId(query.actionId, "actionId");
  if (query.status) filter.status = query.status;

  const page = await paginateQuery(Outcome, filter, pagination, sort);
  // Phase 50: a V1 record is returned in its ONE view shape (no actor identity); a legacy record keeps its existing shape.
  return { ...page, items: page.items.map((item) => (isV1(item) ? toOutcomeView(item, viewerUserId) : item)) };
}

export async function getOutcomeById(id, workspaceId, authorizedLevel, { viewerUserId } = {}) {
  const scope = requireObjectId(workspaceId, "workspaceId");
  const record = await findInWorkspaceOr404(Outcome, requireObjectId(id), scope, "Outcome");
  if (authorizedLevel !== undefined) {
    const parent = await Intelligence.findOne({ _id: record.intelligenceId, workspaceId: scope }).lean();
    if (!intelligenceVisibleTo(parent, authorizedLevel)) throw new AppError("Outcome not found", 404);
  }
  return isV1(record) ? toOutcomeView(toPlain(record), viewerUserId) : toPlain(record);
}

export async function updateOutcome(id, body, workspaceId) {
  const scope = requireObjectId(workspaceId, "workspaceId");
  const outcome = await findInWorkspaceOr404(Outcome, requireObjectId(id), scope, "Outcome");
  // Phase 30: an Outcome V1 is an immutable, already-recorded observation. There is no "correction" route in
  // this phase (see backend/docs/OUTCOME_INTEGRITY_PHASE30.md) - the original result must never silently
  // disappear or be overwritten. Defense in depth, independent of the action:execute permission gate that
  // already blocks every role from reaching this function over HTTP.
  if (isV1(outcome)) {
    throw new AppError("An Outcome V1 is immutable once recorded; there is no PATCH route for it", 409);
  }
  assertWorkspaceUnchanged(body, outcome);
  assertNoKeys(body, V1_OWNED_FIELDS, "Outcome V1 fields cannot be set on a legacy Outcome");
  const updates = pickDefined(body, UPDATABLE);

  if (Object.keys(updates).length === 0) {
    throw new AppError("No valid fields provided for update", 400);
  }

  if (updates.actionId !== undefined) {
    updates.actionId = parseObjectId(updates.actionId, "actionId");
    if (updates.actionId) {
      const action = await findByIdOr404(Action, updates.actionId, "Action");
      assertActionUsableForOutcome(action, outcome.workspaceId, outcome.intelligenceId);
    }
  }

  Object.assign(outcome, updates);
  await outcome.save();
  return toPlain(outcome);
}

// --------------------------------------------------------------------------
// Outcome V1 - the future trusted execution boundary's recording contract (Phase 30)
// --------------------------------------------------------------------------

const iso = (value) => (value ? new Date(value).toISOString() : null);
const idOrNull = (value) => (value ? String(value) : null);

const sameUser = (a, b) => Boolean(a && b && String(a) === String(b));

/** The ONE response shape for a V1 record. Phase 50: no actor identity - the caller's relation is a boolean (`recordedByYou`). */
export function toOutcomeView(outcome, viewerUserId) {
  if (!outcome) return null;
  return {
    _id: String(outcome._id),
    workspaceId: String(outcome.workspaceId),
    intelligenceId: String(outcome.intelligenceId),
    actionId: idOrNull(outcome.actionId),
    decisionId: idOrNull(outcome.decisionId),
    signalId: idOrNull(outcome.signalId),
    propertyId: idOrNull(outcome.propertyId),
    outcomeVersion: outcome.outcomeVersion ?? null,
    status: outcome.status,
    result: { summary: outcome.result?.summary ?? "", notes: outcome.result?.notes ?? "" },
    recordedAt: iso(outcome.recordedAt),
    recordedByYou: sameUser(outcome.recordedBy, viewerUserId),
    createdAt: iso(outcome.createdAt),
    updatedAt: iso(outcome.updatedAt),
  };
}

/** Closed shape for recordOutcome: exactly {status, result?:{summary?, notes?}} - nothing else, ever. */
function parseRecordPayload(payload, { requireSummary = false } = {}) {
  if (payload === undefined || payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new AppError("Outcome payload must be an object with a status", 400);
  }
  for (const key of Object.keys(payload)) {
    if (key !== "status" && key !== "result") {
      throw new AppError(`Only "status" and "result" are accepted; "${key}" is not`, 400, { code: "UNSUPPORTED_FIELD", field: key });
    }
  }
  if (typeof payload.status !== "string" || !OUTCOME_V1_STATUSES.includes(payload.status)) {
    throw new AppError(`status must be one of: ${OUTCOME_V1_STATUSES.join(", ")}`, 422, { code: "UNKNOWN_OUTCOME_STATUS" });
  }
  let result;
  if (payload.result !== undefined) {
    if (payload.result === null || typeof payload.result !== "object" || Array.isArray(payload.result)) {
      throw new AppError("result must be an object", 400);
    }
    for (const key of Object.keys(payload.result)) {
      if (key !== "summary" && key !== "notes") throw new AppError(`Only "result.summary" and "result.notes" are accepted; "result.${key}" is not`, 400, { code: "UNSUPPORTED_FIELD", field: `result.${key}` });
    }
    result = {};
    for (const field of ["summary", "notes"]) {
      if (payload.result[field] === undefined) continue;
      if (typeof payload.result[field] !== "string") throw new AppError(`result.${field} must be a string`, 400);
      const trimmed = payload.result[field].trim();
      if (trimmed.length > RESULT_TEXT_MAX_LENGTH) throw new AppError(`result.${field} must be at most ${RESULT_TEXT_MAX_LENGTH} characters`, 400);
      result[field] = trimmed;
    }
  }
  // A person's own report needs words: a status alone says nothing about what was observed.
  if (requireSummary && !result?.summary) throw new AppError("Describe what happened", 400, { code: "OUTCOME_DESCRIPTION_REQUIRED" });
  return { status: payload.status, result };
}

/**
 * recordOutcome(actionId, workspaceId, payload)
 *
 * THE FUTURE EXECUTION BOUNDARY'S ONLY WRITE PATH. Not reachable from any route in this codebase - see the
 * module docstring and backend/docs/OUTCOME_INTEGRITY_PHASE30.md for the exact contract a future trusted
 * execution service must satisfy before it may be wired to a route that calls this.
 *
 * `workspaceId` is NOT a client selector here - it is whatever a future trusted caller supplies as the
 * Action's own, already-established workspace. Every security property is enforced server-side from data
 * this function itself loads, never from caller-asserted identity/role/timestamp:
 *   - actionId must resolve to a REAL Action in `workspaceId` (fail closed, no existence oracle)
 *   - the Action must be a V1 Action (actionVersion === "action-v1") that has reached "approved" - a
 *     proposed, rejected, or legacy Action produces no Outcome
 *   - the payload is exactly {status, result?:{summary?, notes?}} - no actor, no timestamp, no tool name, no
 *     URL, no credentials, no arbitrary metadata can ever reach a stored Outcome through this function
 *   - at most ONE Outcome V1 per Action: a second call for the same Action is refused (409) - this is a
 *     CONFLICT, not an idempotent no-op, because Outcome represents an already-observed fact and a second,
 *     possibly different claim about it must never silently win or be silently dropped
 *   - `recordedAt` is always `new Date()` set here, never accepted from the caller
 * @returns the public Outcome view
 */
export async function recordOutcome(actionId, workspaceId, payload, { actorUserId, authorizedLevel, requireSummary = false } = {}) {
  const scope = requireObjectId(workspaceId, "workspaceId");
  const id = requireObjectId(actionId, "actionId");
  const { status, result } = parseRecordPayload(payload, { requireSummary });
  // Phase 50: when a person records (the route always passes the actor), the recorder is the AUTHENTICATED user - required, never a body field.
  const recorder = actorUserId === undefined ? undefined : requireActorUserId(actorUserId);

  // Fails closed with the SAME 404 a missing Action would give - never reveals whether a foreign Action exists.
  const action = await findInWorkspaceOr404(Action, id, scope, "Action");
  if (authorizedLevel !== undefined) {
    const parent = await Intelligence.findOne({ _id: action.intelligenceId, workspaceId: scope }).lean();
    if (!intelligenceVisibleTo(parent, normalizeCallerLevel(authorizedLevel))) throw new AppError("Action not found", 404);
  }
  if (action.actionVersion !== ACTION_VERSION) {
    throw new AppError("An Outcome can only be recorded for an Action V1", 422);
  }
  if (action.status !== "approved") {
    throw new AppError(`An Outcome can only be recorded for an approved Action (this one is "${action.status}")`, 409);
  }

  const existing = await Outcome.findOne({ workspaceId: scope, actionId: id, outcomeVersion: OUTCOME_VERSION });
  if (existing) {
    // Deliberately NOT idempotent-return (unlike Decision/Action propose): a second recording attempt,
    // identical or not, is a conflicting claim about an already-observed fact.
    throw new AppError("An Outcome has already been recorded for this Action", 409, { code: "OUTCOME_ALREADY_RECORDED" });
  }

  try {
    const created = await Outcome.create({
      workspaceId: scope,
      intelligenceId: action.intelligenceId,
      actionId: id,
      decisionId: action.decisionId,
      signalId: action.signalId,
      propertyId: action.propertyId,
      outcomeVersion: OUTCOME_VERSION,
      actionVersion: action.actionVersion,
      status,
      result: result ?? {},
      recordedAt: new Date(),
      ...(recorder ? { recordedBy: recorder } : {}),
    });
    return toOutcomeView(toPlain(created), recorder);
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw new AppError("An Outcome has already been recorded for this Action", 409, { code: "OUTCOME_ALREADY_RECORDED" });
    }
    throw error;
  }
}
