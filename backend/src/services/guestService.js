import { Guest } from "../models/Guest.js";
import { Workspace } from "../models/Workspace.js";
import { AppError } from "../utils/AppError.js";
import { requireObjectId } from "../utils/objectId.js";
import { parsePagination, parseSort } from "../utils/pagination.js";
import {
  assertExists,
  assertWorkspaceUnchanged,
  findInWorkspaceOr404,
  paginateQuery,
  pickDefined,
  requireFields,
  toPlain,
} from "./queryHelpers.js";

const UPDATABLE = [
  "externalId",
  "firstName",
  "lastName",
  "email",
  "phone",
  "preferences",
  "metadata",
];

export async function createGuest(body) {
  requireFields(body, ["workspaceId"]);
  const workspaceId = requireObjectId(body.workspaceId, "workspaceId");
  await assertExists(Workspace, workspaceId, "Workspace");

  const guest = await Guest.create({
    workspaceId,
    externalId: body.externalId,
    firstName: body.firstName,
    lastName: body.lastName,
    email: body.email,
    phone: body.phone,
    preferences: body.preferences,
    metadata: body.metadata,
  });

  return toPlain(guest);
}

export async function listGuests(query) {
  const workspaceId = requireObjectId(query.workspaceId, "workspaceId");
  const pagination = parsePagination(query);
  const sort = parseSort(query, ["createdAt", "updatedAt", "lastName", "firstName"], {
    createdAt: -1,
  });
  const filter = { workspaceId };

  if (query.email) filter.email = String(query.email).toLowerCase();
  if (query.externalId) filter.externalId = query.externalId;

  if (query.name) {
    const pattern = new RegExp(String(query.name).trim(), "i");
    filter.$or = [{ firstName: pattern }, { lastName: pattern }];
  }

  return paginateQuery(Guest, filter, pagination, sort);
}

export async function getGuestById(id, workspaceId) {
  const scope = requireObjectId(workspaceId, "workspaceId");
  return toPlain(await findInWorkspaceOr404(Guest, requireObjectId(id), scope, "Guest"));
}

export async function updateGuest(id, body, workspaceId) {
  const scope = requireObjectId(workspaceId, "workspaceId");
  const guest = await findInWorkspaceOr404(Guest, requireObjectId(id), scope, "Guest");
  assertWorkspaceUnchanged(body, guest);
  const updates = pickDefined(body, UPDATABLE);

  if (Object.keys(updates).length === 0) {
    throw new AppError("No valid fields provided for update", 400);
  }

  Object.assign(guest, updates);
  await guest.save();
  return toPlain(guest);
}

export async function deleteGuest(id, workspaceId) {
  const scope = requireObjectId(workspaceId, "workspaceId");
  const guest = await findInWorkspaceOr404(Guest, requireObjectId(id), scope, "Guest");
  await guest.deleteOne();
  return toPlain(guest);
}
