import { Action } from "../models/Action.js";
import { Decision } from "../models/Decision.js";
import { Intelligence } from "../models/Intelligence.js";
import { Workspace } from "../models/Workspace.js";
import { AppError } from "../utils/AppError.js";
import { parseObjectId, requireObjectId } from "../utils/objectId.js";
import { parsePagination, parseSort } from "../utils/pagination.js";
import {
  assertExists,
  assertSameWorkspace,
  assertWorkspaceUnchanged,
  findByIdOr404,
  findInWorkspaceOr404,
  paginateQuery,
  pickDefined,
  requireFields,
  toPlain,
} from "./queryHelpers.js";

const UPDATABLE = [
  "decisionId",
  "type",
  "description",
  "status",
  "assignedTo",
  "dueAt",
  "completedAt",
  "result",
];

/**
 * Phase 7B — the existing Action model (Phase 2) already defines its own
 * status enum (pending/in_progress/completed/cancelled/failed). Before this
 * phase, PATCH accepted any enum value from any other (the same gap Phase
 * 7A found and fixed on Decision). This lifecycle reuses the existing enum
 * unchanged — no new status values.
 */
const ACTION_STATUS_TRANSITIONS = {
  pending: ["in_progress", "cancelled"],
  in_progress: ["completed", "cancelled", "failed"],
  completed: [],
  cancelled: [],
  failed: [],
};

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
}

export async function createAction(body) {
  requireFields(body, ["workspaceId", "intelligenceId", "description"]);
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

export async function listActions(query) {
  const workspaceId = requireObjectId(query.workspaceId, "workspaceId");
  const pagination = parsePagination(query);
  const sort = parseSort(query, ["createdAt", "updatedAt", "dueAt"], { createdAt: -1 });
  const filter = { workspaceId };

  if (query.intelligenceId) {
    filter.intelligenceId = parseObjectId(query.intelligenceId, "intelligenceId");
  }
  if (query.decisionId) filter.decisionId = parseObjectId(query.decisionId, "decisionId");
  if (query.status) filter.status = query.status;
  if (query.assignedTo) filter.assignedTo = query.assignedTo;

  return paginateQuery(Action, filter, pagination, sort);
}

export async function getActionById(id, workspaceId) {
  const scope = requireObjectId(workspaceId, "workspaceId");
  return toPlain(await findInWorkspaceOr404(Action, requireObjectId(id), scope, "Action"));
}

export async function updateAction(id, body, workspaceId) {
  const scope = requireObjectId(workspaceId, "workspaceId");
  const action = await findInWorkspaceOr404(Action, requireObjectId(id), scope, "Action");
  assertWorkspaceUnchanged(body, action);
  const updates = pickDefined(body, UPDATABLE);

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
