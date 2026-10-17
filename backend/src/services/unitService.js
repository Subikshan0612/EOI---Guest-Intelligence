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

const UNIT_NUMBER_MAX = 40;
// A room / unit identifier is TEXT, never a number: 101, B1, A-12, G01, 12A, "Villa 3", Penthouse.
const UNIT_NUMBER_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._/#-]*$/u;

/** The identifier as typed by a person: trimmed, inner whitespace collapsed; 400 when it is not a plausible room / unit identifier. */
export function cleanUnitNumber(value) {
  const text = typeof value === "string" ? value.normalize("NFKC").replace(/\s+/g, " ").trim() : "";
  if (!text || text.length > UNIT_NUMBER_MAX || !UNIT_NUMBER_PATTERN.test(text)) {
    throw new AppError(`unitNumber must be 1-${UNIT_NUMBER_MAX} letters, digits, spaces or . _ / # -`, 400, { code: "INVALID_FIELD", field: "unitNumber" });
  }
  return text;
}

// The same equivalence the assistant's room matching uses (case and spaces do not make a different room): "b1", "B1" and "B 1" are one room.
const unitKey = (value) => String(value ?? "").replace(/\s+/g, "").toUpperCase();

/**
 * The unit of THIS property that carries the identifier, or null. The property is the authority: a unit of any other property is never looked at.
 * The caller has already proven `propertyId` belongs to the caller's workspace.
 */
export async function findUnitByNumberInProperty(propertyId, unitNumber) {
  const key = unitKey(unitNumber);
  const units = await Unit.find({ propertyId }).select("propertyId unitNumber type status").limit(5000);
  return units.find((unit) => unitKey(unit.unitNumber) === key) ?? null;
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
