import { Property } from "../models/Property.js";
import { Workspace } from "../models/Workspace.js";
import { AppError } from "../utils/AppError.js";
import { parseObjectId, requireObjectId } from "../utils/objectId.js";
import { parsePagination, parseSort } from "../utils/pagination.js";
import {
  assertExists,
  findByIdOr404,
  paginateQuery,
  pickDefined,
  requireFields,
  toPlain,
} from "./queryHelpers.js";

const UPDATABLE = ["name", "code", "address", "timezone", "status"];

export async function createProperty(body) {
  requireFields(body, ["workspaceId", "name", "code"]);
  const workspaceId = requireObjectId(body.workspaceId, "workspaceId");
  await assertExists(Workspace, workspaceId, "Workspace");

  const property = await Property.create({
    workspaceId,
    name: body.name,
    code: body.code,
    address: body.address,
    timezone: body.timezone,
    status: body.status,
  });

  return toPlain(property);
}

export async function listProperties(query) {
  const pagination = parsePagination(query);
  const sort = parseSort(query, ["createdAt", "updatedAt", "name", "code"], { createdAt: -1 });
  const filter = {};

  if (query.workspaceId) filter.workspaceId = parseObjectId(query.workspaceId, "workspaceId");
  if (query.status) filter.status = query.status;
  if (query.code) filter.code = String(query.code).toUpperCase();

  return paginateQuery(Property, filter, pagination, sort);
}

export async function getPropertyById(id) {
  return toPlain(await findByIdOr404(Property, requireObjectId(id), "Property"));
}

export async function updateProperty(id, body) {
  const property = await findByIdOr404(Property, requireObjectId(id), "Property");
  const updates = pickDefined(body, UPDATABLE);

  if (Object.keys(updates).length === 0) {
    throw new AppError("No valid fields provided for update", 400);
  }

  Object.assign(property, updates);
  await property.save();
  return toPlain(property);
}

export async function deleteProperty(id) {
  const property = await findByIdOr404(Property, requireObjectId(id), "Property");
  await property.deleteOne();
  return toPlain(property);
}
