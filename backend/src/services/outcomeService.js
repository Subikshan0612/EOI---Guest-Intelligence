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
  findByIdOr404,
  paginateQuery,
  pickDefined,
  requireFields,
  toPlain,
} from "./queryHelpers.js";

const UPDATABLE = ["actionId", "status", "result", "metrics", "feedback", "occurredAt"];

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
    assertSameWorkspace(action, workspaceId, "Action");
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
  const pagination = parsePagination(query);
  const sort = parseSort(query, ["createdAt", "updatedAt", "occurredAt"], { occurredAt: -1 });
  const filter = {};

  if (query.workspaceId) filter.workspaceId = parseObjectId(query.workspaceId, "workspaceId");
  if (query.intelligenceId) {
    filter.intelligenceId = parseObjectId(query.intelligenceId, "intelligenceId");
  }
  if (query.actionId) filter.actionId = parseObjectId(query.actionId, "actionId");
  if (query.status) filter.status = query.status;

  return paginateQuery(Outcome, filter, pagination, sort);
}

export async function getOutcomeById(id) {
  return toPlain(await findByIdOr404(Outcome, requireObjectId(id), "Outcome"));
}

export async function updateOutcome(id, body) {
  const outcome = await findByIdOr404(Outcome, requireObjectId(id), "Outcome");
  const updates = pickDefined(body, UPDATABLE);

  if (Object.keys(updates).length === 0) {
    throw new AppError("No valid fields provided for update", 400);
  }

  if (updates.actionId !== undefined) {
    updates.actionId = parseObjectId(updates.actionId, "actionId");
    if (updates.actionId) {
      const action = await findByIdOr404(Action, updates.actionId, "Action");
      assertSameWorkspace(action, outcome.workspaceId, "Action");
    }
  }

  Object.assign(outcome, updates);
  await outcome.save();
  return toPlain(outcome);
}
