import { Guest } from "../models/Guest.js";
import { Property } from "../models/Property.js";
import { Stay } from "../models/Stay.js";
import { Unit } from "../models/Unit.js";
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
  "unitId",
  "reservationId",
  "checkIn",
  "checkOut",
  "status",
  "adults",
  "children",
  "source",
  "metadata",
];

async function validateStayRefs({ workspaceId, guestId, propertyId, unitId }) {
  const [guest, property] = await Promise.all([
    findByIdOr404(Guest, guestId, "Guest"),
    findByIdOr404(Property, propertyId, "Property"),
  ]);

  assertSameWorkspace(guest, workspaceId, "Guest");
  assertSameWorkspace(property, workspaceId, "Property");

  if (unitId) {
    const unit = await findByIdOr404(Unit, unitId, "Unit");
    if (String(unit.propertyId) !== String(propertyId)) {
      throw new AppError("Unit does not belong to the given property", 400);
    }
  }
}

export async function createStay(body) {
  requireFields(body, ["workspaceId", "guestId", "propertyId"]);
  const workspaceId = requireObjectId(body.workspaceId, "workspaceId");
  const guestId = requireObjectId(body.guestId, "guestId");
  const propertyId = requireObjectId(body.propertyId, "propertyId");
  const unitId = parseObjectId(body.unitId, "unitId");

  await assertExists(Workspace, workspaceId, "Workspace");
  await validateStayRefs({ workspaceId, guestId, propertyId, unitId });

  const stay = await Stay.create({
    workspaceId,
    guestId,
    propertyId,
    unitId,
    reservationId: body.reservationId,
    checkIn: body.checkIn,
    checkOut: body.checkOut,
    status: body.status,
    adults: body.adults,
    children: body.children,
    source: body.source,
    metadata: body.metadata,
  });

  return toPlain(stay);
}

export async function listStays(query) {
  const workspaceId = requireObjectId(query.workspaceId, "workspaceId");
  const pagination = parsePagination(query);
  const sort = parseSort(query, ["createdAt", "updatedAt", "checkIn", "checkOut"], {
    createdAt: -1,
  });
  const filter = { workspaceId };

  if (query.guestId) filter.guestId = parseObjectId(query.guestId, "guestId");
  if (query.propertyId) filter.propertyId = parseObjectId(query.propertyId, "propertyId");
  if (query.unitId) filter.unitId = parseObjectId(query.unitId, "unitId");
  if (query.status) filter.status = query.status;

  return paginateQuery(Stay, filter, pagination, sort);
}

export async function getStayById(id, workspaceId) {
  const scope = requireObjectId(workspaceId, "workspaceId");
  return toPlain(await findInWorkspaceOr404(Stay, requireObjectId(id), scope, "Stay"));
}

export async function updateStay(id, body, workspaceId) {
  const scope = requireObjectId(workspaceId, "workspaceId");
  const stay = await findInWorkspaceOr404(Stay, requireObjectId(id), scope, "Stay");
  assertWorkspaceUnchanged(body, stay);
  const updates = pickDefined(body, UPDATABLE);

  if (Object.keys(updates).length === 0) {
    throw new AppError("No valid fields provided for update", 400);
  }

  if (updates.unitId !== undefined) {
    updates.unitId = parseObjectId(updates.unitId, "unitId");
    await validateStayRefs({
      workspaceId: stay.workspaceId,
      guestId: stay.guestId,
      propertyId: stay.propertyId,
      unitId: updates.unitId,
    });
  }

  Object.assign(stay, updates);
  await stay.save();
  return toPlain(stay);
}

export async function deleteStay(id, workspaceId) {
  const scope = requireObjectId(workspaceId, "workspaceId");
  const stay = await findInWorkspaceOr404(Stay, requireObjectId(id), scope, "Stay");
  await stay.deleteOne();
  return toPlain(stay);
}
