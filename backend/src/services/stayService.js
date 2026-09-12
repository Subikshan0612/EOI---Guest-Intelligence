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

/**
 * Statuses that mean the guest occupies (or is booked to occupy) the unit.
 * checked_out/cancelled/no_show never conflict with another stay's dates.
 */
const OCCUPYING_STAY_STATUSES = ["reserved", "confirmed", "checked_in"];

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

/**
 * checkOut must not be before checkIn, and both must be valid dates when
 * supplied. Either may be absent (an open-ended reservation) — this only
 * validates the relationship when both are present.
 */
function assertValidDateRange(checkIn, checkOut) {
  let start;
  let end;

  if (checkIn !== undefined && checkIn !== null) {
    start = new Date(checkIn);
    if (Number.isNaN(start.getTime())) {
      throw new AppError("checkIn is not a valid date", 400);
    }
  }

  if (checkOut !== undefined && checkOut !== null) {
    end = new Date(checkOut);
    if (Number.isNaN(end.getTime())) {
      throw new AppError("checkOut is not a valid date", 400);
    }
  }

  if (start && end && end < start) {
    throw new AppError("checkOut must not be before checkIn", 400);
  }
}

/**
 * Rejects a Stay whose date range overlaps another occupying Stay on the same
 * Unit. Deliberately narrow in scope (not a booking engine):
 *  - Only runs when a Unit AND both checkIn and checkOut are present — an
 *    unassigned or open-ended stay is not checked against the calendar.
 *  - Only OCCUPYING_STAY_STATUSES count as a conflict; a cancelled/no-show/
 *    checked-out stay never blocks a new one.
 *  - Ranges use a half-open interval [checkIn, checkOut): a checkout the same
 *    day as the next guest's checkin is not a conflict.
 */
async function assertNoOverlap({ workspaceId, unitId, checkIn, checkOut, status, excludeStayId }) {
  if (!unitId || !checkIn || !checkOut) return;
  if (!OCCUPYING_STAY_STATUSES.includes(status)) return;

  const start = new Date(checkIn);
  const end = new Date(checkOut);

  const filter = {
    workspaceId,
    unitId,
    status: { $in: OCCUPYING_STAY_STATUSES },
    checkIn: { $lt: end },
    checkOut: { $gt: start },
  };
  if (excludeStayId) filter._id = { $ne: excludeStayId };

  const conflict = await Stay.findOne(filter);
  if (conflict) {
    throw new AppError("This unit already has an overlapping stay for the selected dates", 409);
  }
}

export async function createStay(body) {
  requireFields(body, ["workspaceId", "guestId", "propertyId"]);
  const workspaceId = requireObjectId(body.workspaceId, "workspaceId");
  const guestId = requireObjectId(body.guestId, "guestId");
  const propertyId = requireObjectId(body.propertyId, "propertyId");
  const unitId = parseObjectId(body.unitId, "unitId");

  assertValidDateRange(body.checkIn, body.checkOut);

  await assertExists(Workspace, workspaceId, "Workspace");
  await validateStayRefs({ workspaceId, guestId, propertyId, unitId });
  await assertNoOverlap({
    workspaceId,
    unitId,
    checkIn: body.checkIn,
    checkOut: body.checkOut,
    status: body.status || "reserved",
  });

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

  const effectiveCheckIn = updates.checkIn !== undefined ? updates.checkIn : stay.checkIn;
  const effectiveCheckOut = updates.checkOut !== undefined ? updates.checkOut : stay.checkOut;
  assertValidDateRange(effectiveCheckIn, effectiveCheckOut);

  const revalidateOverlap =
    updates.unitId !== undefined || updates.checkIn !== undefined ||
    updates.checkOut !== undefined || updates.status !== undefined;

  if (revalidateOverlap) {
    await assertNoOverlap({
      workspaceId: stay.workspaceId,
      unitId: updates.unitId !== undefined ? updates.unitId : stay.unitId,
      checkIn: effectiveCheckIn,
      checkOut: effectiveCheckOut,
      status: updates.status !== undefined ? updates.status : stay.status,
      excludeStayId: stay._id,
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
