import { Workspace } from "../models/Workspace.js";
import { AppError } from "../utils/AppError.js";
import { requireObjectId } from "../utils/objectId.js";
import { parsePagination, parseSort } from "../utils/pagination.js";
import {
  findByIdOr404,
  paginateQuery,
  pickDefined,
  requireFields,
  toPlain,
} from "./queryHelpers.js";

const UPDATABLE = ["name", "slug", "status", "settings"];

export async function createWorkspace(body) {
  requireFields(body, ["name", "slug"]);
  const workspace = await Workspace.create({
    name: body.name,
    slug: body.slug,
    status: body.status,
    settings: body.settings,
  });
  return toPlain(workspace);
}

export async function listWorkspaces(query) {
  const pagination = parsePagination(query);
  const sort = parseSort(query, ["createdAt", "updatedAt", "name"], { createdAt: -1 });
  const filter = {};

  if (query.status) filter.status = query.status;
  if (query.slug) filter.slug = String(query.slug).toLowerCase();

  return paginateQuery(Workspace, filter, pagination, sort);
}

export async function getWorkspaceById(id) {
  const workspace = await findByIdOr404(Workspace, requireObjectId(id), "Workspace");
  return toPlain(workspace);
}

export async function updateWorkspace(id, body) {
  const workspace = await findByIdOr404(Workspace, requireObjectId(id), "Workspace");
  const updates = pickDefined(body, UPDATABLE);

  if (Object.keys(updates).length === 0) {
    throw new AppError("No valid fields provided for update", 400);
  }

  Object.assign(workspace, updates);
  await workspace.save();
  return toPlain(workspace);
}

export async function deleteWorkspace(id) {
  const workspace = await findByIdOr404(Workspace, requireObjectId(id), "Workspace");
  await workspace.deleteOne();
  return toPlain(workspace);
}
