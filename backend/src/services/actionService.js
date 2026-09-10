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
    assertSameWorkspace(decision, workspaceId, "Decision");
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
      assertSameWorkspace(decision, action.workspaceId, "Decision");
    }
  }

  Object.assign(action, updates);
  await action.save();
  return toPlain(action);
}
