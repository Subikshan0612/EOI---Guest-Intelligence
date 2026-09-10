import { Guest } from "../models/Guest.js";
import { Property } from "../models/Property.js";
import { Signal } from "../models/Signal.js";
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
  "propertyId",
  "unitId",
  "guestId",
  "stayId",
  "type",
  "source",
  "severity",
  "status",
  "title",
  "description",
  "occurredAt",
  "detectedAt",
  "metadata",
];

async function validateOptionalRefs(workspaceId, refs) {
  if (refs.propertyId) {
    const property = await findByIdOr404(Property, refs.propertyId, "Property");
    assertSameWorkspace(property, workspaceId, "Property");
  }
  if (refs.unitId) {
    const unit = await findByIdOr404(Unit, refs.unitId, "Unit");
    const unitProperty = await findByIdOr404(Property, unit.propertyId, "Property");
    assertSameWorkspace(unitProperty, workspaceId, "Unit");
  }
  if (refs.guestId) {
    const guest = await findByIdOr404(Guest, refs.guestId, "Guest");
    assertSameWorkspace(guest, workspaceId, "Guest");
  }
  if (refs.stayId) {
    const stay = await findByIdOr404(Stay, refs.stayId, "Stay");
    assertSameWorkspace(stay, workspaceId, "Stay");
  }
}

export async function createSignal(body) {
  requireFields(body, ["workspaceId", "type", "title"]);
  const workspaceId = requireObjectId(body.workspaceId, "workspaceId");
  await assertExists(Workspace, workspaceId, "Workspace");

  const refs = {
    propertyId: parseObjectId(body.propertyId, "propertyId"),
    unitId: parseObjectId(body.unitId, "unitId"),
    guestId: parseObjectId(body.guestId, "guestId"),
    stayId: parseObjectId(body.stayId, "stayId"),
  };

  await validateOptionalRefs(workspaceId, refs);

  const signal = await Signal.create({
    workspaceId,
    ...refs,
    type: body.type,
    source: body.source,
    severity: body.severity,
    status: body.status,
    title: body.title,
    description: body.description,
    occurredAt: body.occurredAt,
    detectedAt: body.detectedAt,
    metadata: body.metadata,
  });

  return toPlain(signal);
}

export async function listSignals(query) {
  const pagination = parsePagination(query);
  const sort = parseSort(query, ["createdAt", "updatedAt", "occurredAt", "severity"], {
    createdAt: -1,
  });
  const filter = { workspaceId: requireObjectId(query.workspaceId, "workspaceId") };

  if (query.propertyId) filter.propertyId = parseObjectId(query.propertyId, "propertyId");
  if (query.unitId) filter.unitId = parseObjectId(query.unitId, "unitId");
  if (query.guestId) filter.guestId = parseObjectId(query.guestId, "guestId");
  if (query.stayId) filter.stayId = parseObjectId(query.stayId, "stayId");
  if (query.type) filter.type = query.type;
  if (query.severity) filter.severity = query.severity;
  if (query.status) filter.status = query.status;

  return paginateQuery(Signal, filter, pagination, sort);
}

export async function getSignalById(id, workspaceId) {
  const scope = requireObjectId(workspaceId, "workspaceId");
  return toPlain(await findInWorkspaceOr404(Signal, requireObjectId(id), scope, "Signal"));
}

export async function updateSignal(id, body, workspaceId) {
  const scope = requireObjectId(workspaceId, "workspaceId");
  const signal = await findInWorkspaceOr404(Signal, requireObjectId(id), scope, "Signal");
  assertWorkspaceUnchanged(body, signal);
  const updates = pickDefined(body, UPDATABLE);

  if (Object.keys(updates).length === 0) {
    throw new AppError("No valid fields provided for update", 400);
  }

  for (const key of ["propertyId", "unitId", "guestId", "stayId"]) {
    if (updates[key] !== undefined) {
      updates[key] = parseObjectId(updates[key], key);
    }
  }

  await validateOptionalRefs(signal.workspaceId, {
    propertyId: updates.propertyId ?? signal.propertyId,
    unitId: updates.unitId ?? signal.unitId,
    guestId: updates.guestId ?? signal.guestId,
    stayId: updates.stayId ?? signal.stayId,
  });

  Object.assign(signal, updates);
  await signal.save();
  return toPlain(signal);
}

export async function deleteSignal(id, workspaceId) {
  const scope = requireObjectId(workspaceId, "workspaceId");
  const signal = await findInWorkspaceOr404(Signal, requireObjectId(id), scope, "Signal");
  await signal.deleteOne();
  return toPlain(signal);
}
