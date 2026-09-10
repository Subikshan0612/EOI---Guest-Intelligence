import { Property } from "../models/Property.js";
import { Unit } from "../models/Unit.js";
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

const UPDATABLE = ["unitNumber", "type", "status", "metadata"];

export async function createUnit(body) {
  requireFields(body, ["propertyId", "unitNumber"]);
  const propertyId = requireObjectId(body.propertyId, "propertyId");
  await assertExists(Property, propertyId, "Property");

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
  const pagination = parsePagination(query);
  const sort = parseSort(query, ["createdAt", "updatedAt", "unitNumber"], { createdAt: -1 });
  const filter = {};

  if (query.propertyId) filter.propertyId = parseObjectId(query.propertyId, "propertyId");
  if (query.status) filter.status = query.status;
  if (query.type) filter.type = query.type;

  if (query.workspaceId) {
    const workspaceId = parseObjectId(query.workspaceId, "workspaceId");
    const properties = await Property.find({ workspaceId }).select("_id");
    filter.propertyId = { $in: properties.map((item) => item._id) };
  }

  return paginateQuery(Unit, filter, pagination, sort);
}

export async function getUnitById(id) {
  return toPlain(await findByIdOr404(Unit, requireObjectId(id), "Unit"));
}

export async function updateUnit(id, body) {
  const unit = await findByIdOr404(Unit, requireObjectId(id), "Unit");
  const updates = pickDefined(body, UPDATABLE);

  if (Object.keys(updates).length === 0) {
    throw new AppError("No valid fields provided for update", 400);
  }

  Object.assign(unit, updates);
  await unit.save();
  return toPlain(unit);
}

export async function deleteUnit(id) {
  const unit = await findByIdOr404(Unit, requireObjectId(id), "Unit");
  await unit.deleteOne();
  return toPlain(unit);
}
