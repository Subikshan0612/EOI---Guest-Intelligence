import { Property } from "../models/Property.js";
import { Unit } from "../models/Unit.js";
import { AppError } from "../utils/AppError.js";
import { requireObjectId } from "../utils/objectId.js";
import { parsePagination, parseSort } from "../utils/pagination.js";
import {
  findByIdOr404,
  findInWorkspaceOr404,
  paginateQuery,
  pickDefined,
  requireFields,
  toPlain,
} from "./queryHelpers.js";

const UPDATABLE = ["unitNumber", "type", "status", "metadata"];

/**
 * Unit has no workspaceId column. Its tenant is resolved through its parent
 * Property, so every scoped operation loads the Unit, then confirms the owning
 * Property belongs to the caller's workspace. A mismatch resolves to 404.
 */
async function findUnitInWorkspace(id, workspaceId, label = "Unit") {
  const unit = await findByIdOr404(Unit, id, label);
  const property = await Property.findOne({ _id: unit.propertyId, workspaceId });
  if (!property) {
    throw new AppError(`${label} not found`, 404);
  }
  return unit;
}

async function workspacePropertyIds(workspaceId) {
  const properties = await Property.find({ workspaceId }).select("_id");
  return properties.map((item) => item._id);
}

export async function createUnit(body) {
  requireFields(body, ["workspaceId", "propertyId", "unitNumber"]);
  const workspaceId = requireObjectId(body.workspaceId, "workspaceId");
  const propertyId = requireObjectId(body.propertyId, "propertyId");
  await findInWorkspaceOr404(Property, propertyId, workspaceId, "Property");

  const unit = await Unit.create({
    propertyId,
    unitNumber: body.unitNumber,
    type: body.type,
    status: body.status,
    metadata: body.metadata,
  });

  return toPlain(unit);
}

export async function listUnits(query) {
  const workspaceId = requireObjectId(query.workspaceId, "workspaceId");
  const pagination = parsePagination(query);
  const sort = parseSort(query, ["createdAt", "updatedAt", "unitNumber"], { createdAt: -1 });

  const propertyIds = await workspacePropertyIds(workspaceId);
  const filter = { propertyId: { $in: propertyIds } };

  if (query.propertyId) {
    const requested = requireObjectId(query.propertyId, "propertyId");
    const inWorkspace = propertyIds.some((id) => String(id) === String(requested));
    filter.propertyId = inWorkspace ? requested : { $in: [] };
  }
  if (query.status) filter.status = query.status;
  if (query.type) filter.type = query.type;

  return paginateQuery(Unit, filter, pagination, sort);
}

export async function getUnitById(id, workspaceId) {
  const scope = requireObjectId(workspaceId, "workspaceId");
  return toPlain(await findUnitInWorkspace(requireObjectId(id), scope, "Unit"));
}

export async function updateUnit(id, body, workspaceId) {
  const scope = requireObjectId(workspaceId, "workspaceId");
  const unit = await findUnitInWorkspace(requireObjectId(id), scope, "Unit");
  const updates = pickDefined(body, UPDATABLE);

  if (Object.keys(updates).length === 0) {
    throw new AppError("No valid fields provided for update", 400);
  }

  Object.assign(unit, updates);
  await unit.save();
  return toPlain(unit);
}

export async function deleteUnit(id, workspaceId) {
  const scope = requireObjectId(workspaceId, "workspaceId");
  const unit = await findUnitInWorkspace(requireObjectId(id), scope, "Unit");
  await unit.deleteOne();
  return toPlain(unit);
}
