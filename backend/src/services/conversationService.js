import { Conversation } from "../models/Conversation.js";
import { Guest } from "../models/Guest.js";
import { Signal } from "../models/Signal.js";
import { Stay } from "../models/Stay.js";
import { Workspace } from "../models/Workspace.js";
import { AppError } from "../utils/AppError.js";
import { parseObjectId, requireObjectId } from "../utils/objectId.js";
import { parsePagination, parseSort } from "../utils/pagination.js";
import {
  assertExists,
  assertSameWorkspace,
  findByIdOr404,
  paginateQuery,
  pickDefined,
  requireFields,
  toPlain,
} from "./queryHelpers.js";

const UPDATABLE = ["userId", "guestId", "stayId", "signalIds", "title", "status"];

async function validateConversationRefs(workspaceId, { guestId, stayId, signalIds }) {
  if (guestId) {
    const guest = await findByIdOr404(Guest, guestId, "Guest");
    assertSameWorkspace(guest, workspaceId, "Guest");
  }

  if (stayId) {
    const stay = await findByIdOr404(Stay, stayId, "Stay");
    assertSameWorkspace(stay, workspaceId, "Stay");
  }

  if (Array.isArray(signalIds) && signalIds.length > 0) {
    const signals = await Signal.find({ _id: { $in: signalIds } });
    if (signals.length !== signalIds.length) {
      throw new AppError("One or more signals were not found", 404);
    }
    for (const signal of signals) {
      assertSameWorkspace(signal, workspaceId, "Signal");
    }
  }
}

export async function createConversation(body) {
  requireFields(body, ["workspaceId"]);
  const workspaceId = requireObjectId(body.workspaceId, "workspaceId");
  await assertExists(Workspace, workspaceId, "Workspace");

  const guestId = parseObjectId(body.guestId, "guestId");
  const stayId = parseObjectId(body.stayId, "stayId");
  const signalIds = Array.isArray(body.signalIds)
    ? body.signalIds.map((id, index) => requireObjectId(id, `signalIds[${index}]`))
    : [];

  await validateConversationRefs(workspaceId, { guestId, stayId, signalIds });

  const conversation = await Conversation.create({
    workspaceId,
    userId: body.userId,
    guestId,
    stayId,
    signalIds,
    title: body.title,
    status: body.status,
  });

  return toPlain(conversation);
}

export async function listConversations(query) {
  const pagination = parsePagination(query);
  const sort = parseSort(query, ["createdAt", "updatedAt", "title"], { updatedAt: -1 });
  const filter = {};

  if (query.workspaceId) filter.workspaceId = parseObjectId(query.workspaceId, "workspaceId");
  if (query.guestId) filter.guestId = parseObjectId(query.guestId, "guestId");
  if (query.stayId) filter.stayId = parseObjectId(query.stayId, "stayId");
  if (query.status) filter.status = query.status;

  return paginateQuery(Conversation, filter, pagination, sort);
}

export async function getConversationById(id) {
  return toPlain(await findByIdOr404(Conversation, requireObjectId(id), "Conversation"));
}

export async function updateConversation(id, body) {
  const conversation = await findByIdOr404(Conversation, requireObjectId(id), "Conversation");
  const updates = pickDefined(body, UPDATABLE);

  if (Object.keys(updates).length === 0) {
    throw new AppError("No valid fields provided for update", 400);
  }

  if (updates.guestId !== undefined) updates.guestId = parseObjectId(updates.guestId, "guestId");
  if (updates.stayId !== undefined) updates.stayId = parseObjectId(updates.stayId, "stayId");
  if (updates.signalIds !== undefined) {
    updates.signalIds = Array.isArray(updates.signalIds)
      ? updates.signalIds.map((value, index) => requireObjectId(value, `signalIds[${index}]`))
      : [];
  }

  await validateConversationRefs(conversation.workspaceId, {
    guestId: updates.guestId ?? conversation.guestId,
    stayId: updates.stayId ?? conversation.stayId,
    signalIds: updates.signalIds ?? conversation.signalIds,
  });

  Object.assign(conversation, updates);
  await conversation.save();
  return toPlain(conversation);
}

export async function deleteConversation(id) {
  const conversation = await findByIdOr404(Conversation, requireObjectId(id), "Conversation");
  await conversation.deleteOne();
  return toPlain(conversation);
}
