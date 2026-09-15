import { Action } from "../models/Action.js";
import { Intelligence } from "../models/Intelligence.js";
import { Outcome } from "../models/Outcome.js";
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

const UPDATABLE = ["actionId", "status", "result", "metrics", "feedback", "occurredAt"];

/**
 * Phase 7C — an Action attached to an Outcome (at creation or via PATCH)
 * must actually belong to the SAME Intelligence the Outcome itself
 * references, not merely the same workspace. Before this phase, only
 * workspace membership was checked, which allowed an Action belonging to a
 * different Intelligence in the same workspace to be attached to an
 * Outcome — the same category of gap Phase 7B found and fixed one layer up
 * the chain, between Action and Decision.
 *
 * Deliberately does NOT check Action.status: Outcome may attach to an
 * Action in any status (pending/in_progress/completed/cancelled/failed) —
 * that is an intentional Phase 7C decision, not an oversight.
 */
function assertActionUsableForOutcome(action, workspaceId, intelligenceId) {
  assertSameWorkspace(action, workspaceId, "Action");
  if (String(action.intelligenceId) !== String(intelligenceId)) {
    throw new AppError("Action does not belong to the same Intelligence as this Outcome", 400);
  }
}

export async function createOutcome(body) {
  requireFields(body, ["workspaceId", "intelligenceId"]);
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

export async function listOutcomes(query) {
  const workspaceId = requireObjectId(query.workspaceId, "workspaceId");
  const pagination = parsePagination(query);
  const sort = parseSort(query, ["createdAt", "updatedAt", "occurredAt"], { occurredAt: -1 });
  const filter = { workspaceId };

  if (query.intelligenceId) {
    filter.intelligenceId = parseObjectId(query.intelligenceId, "intelligenceId");
  }
  if (query.actionId) filter.actionId = parseObjectId(query.actionId, "actionId");
  if (query.status) filter.status = query.status;

  return paginateQuery(Outcome, filter, pagination, sort);
}

export async function getOutcomeById(id, workspaceId) {
  const scope = requireObjectId(workspaceId, "workspaceId");
  return toPlain(await findInWorkspaceOr404(Outcome, requireObjectId(id), scope, "Outcome"));
}

export async function updateOutcome(id, body, workspaceId) {
  const scope = requireObjectId(workspaceId, "workspaceId");
  const outcome = await findInWorkspaceOr404(Outcome, requireObjectId(id), scope, "Outcome");
  assertWorkspaceUnchanged(body, outcome);
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
