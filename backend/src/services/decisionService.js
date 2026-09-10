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

const UPDATABLE = ["type", "description", "priority", "status"];

export async function createDecision(body) {
  requireFields(body, ["workspaceId", "intelligenceId", "description"]);
  const workspaceId = requireObjectId(body.workspaceId, "workspaceId");
  const intelligenceId = requireObjectId(body.intelligenceId, "intelligenceId");

  await assertExists(Workspace, workspaceId, "Workspace");
  const intelligence = await findByIdOr404(Intelligence, intelligenceId, "Intelligence");
  assertSameWorkspace(intelligence, workspaceId, "Intelligence");

  const decision = await Decision.create({
    workspaceId,
    intelligenceId,
    type: body.type,
    description: body.description,
    priority: body.priority,
    status: body.status,
  });

  return toPlain(decision);
}

export async function listDecisions(query) {
  const workspaceId = requireObjectId(query.workspaceId, "workspaceId");
  const pagination = parsePagination(query);
  const sort = parseSort(query, ["createdAt", "updatedAt", "priority"], { createdAt: -1 });
  const filter = { workspaceId };

  if (query.intelligenceId) {
    filter.intelligenceId = parseObjectId(query.intelligenceId, "intelligenceId");
  }
  if (query.status) filter.status = query.status;
  if (query.priority) filter.priority = query.priority;

  return paginateQuery(Decision, filter, pagination, sort);
}

export async function getDecisionById(id, workspaceId) {
  const scope = requireObjectId(workspaceId, "workspaceId");
  return toPlain(await findInWorkspaceOr404(Decision, requireObjectId(id), scope, "Decision"));
}

export async function updateDecision(id, body, workspaceId) {
  const scope = requireObjectId(workspaceId, "workspaceId");
  const decision = await findInWorkspaceOr404(Decision, requireObjectId(id), scope, "Decision");
  assertWorkspaceUnchanged(body, decision);
  const updates = pickDefined(body, UPDATABLE);

  if (Object.keys(updates).length === 0) {
    throw new AppError("No valid fields provided for update", 400);
  }

  Object.assign(decision, updates);
  await decision.save();
  return toPlain(decision);
}
