import mongoose from "mongoose";
import { Conversation } from "../models/Conversation.js";
import { Message } from "../models/Message.js";
import { Guest } from "../models/Guest.js";
import { Signal } from "../models/Signal.js";
import { Stay } from "../models/Stay.js";
import { Workspace } from "../models/Workspace.js";
import { AppError } from "../utils/AppError.js";
import { requireBoundedString } from "../utils/boundedJson.js";
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
import { resolveOperationalScope } from "./operationalScope.js";

const UPDATABLE = ["userId", "guestId", "stayId", "signalIds", "title", "status"];

// Field bounds (the UI's rename box allows 120 characters and generated titles are ~45; real titles are <= 19).
export const CONVERSATION_LIMITS = Object.freeze({ titleMax: 200, userIdMax: 200, signalIdsMax: 100 });

/**
 * `userId` is legacy, NON-AUTHORITATIVE metadata (never compared to the token, never an ownership check). It is only
 * shape-checked here: absent, null, or a bounded string.
 */
function checkedUserId(value) {
  if (value === undefined || value === null) return value;
  if (typeof value !== "string") throw new AppError("userId must be a string", 400, { code: "INVALID_FIELD", field: "userId" });
  if (value.length > CONVERSATION_LIMITS.userIdMax) throw new AppError(`userId must be at most ${CONVERSATION_LIMITS.userIdMax} characters`, 400, { code: "INVALID_FIELD", field: "userId" });
  return value;
}

function checkedTitle(value) {
  if (value === undefined) return undefined;
  return requireBoundedString(value, { max: CONVERSATION_LIMITS.titleMax, label: "title" });
}

function checkedSignalIds(value) {
  if (Array.isArray(value) && value.length > CONVERSATION_LIMITS.signalIdsMax) {
    throw new AppError(`signalIds must contain at most ${CONVERSATION_LIMITS.signalIdsMax} items`, 400, { code: "INVALID_FIELD", field: "signalIds" });
  }
  return value;
}

async function validateConversationRefs(workspaceId, { propertyId, guestId, stayId, signalIds }) {
  if (propertyId) {
    // A conversation that carries a property carries a verified operational context: its guest and stay must belong to that property (and the stay to that guest).
    await resolveOperationalScope(workspaceId, { propertyId, guestId, stayId });
  } else if (guestId) {
    const guest = await findByIdOr404(Guest, guestId, "Guest");
    assertSameWorkspace(guest, workspaceId, "Guest");
  }

  if (!propertyId && stayId) {
    const stay = await findByIdOr404(Stay, stayId, "Stay");
    assertSameWorkspace(stay, workspaceId, "Stay");
  }

  if (Array.isArray(signalIds) && signalIds.length > 0) {
    const signals = await Signal.find({ _id: { $in: signalIds } });
    if (signals.length !== signalIds.length) {
      throw new AppError("One or more signals were not found", 404);
    }
    // A Signal of another workspace gets the SAME response as a missing one (Phase 21).
    if (signals.some((signal) => String(signal.workspaceId) !== String(workspaceId))) {
      throw new AppError("One or more signals were not found", 404);
    }
  }
}

export async function createConversation(body) {
  requireFields(body, ["workspaceId"]);
  const workspaceId = requireObjectId(body.workspaceId, "workspaceId");
  await assertExists(Workspace, workspaceId, "Workspace");

  const propertyId = parseObjectId(body.propertyId, "propertyId");
  const guestId = parseObjectId(body.guestId, "guestId");
  const stayId = parseObjectId(body.stayId, "stayId");
  const signalIds = Array.isArray(checkedSignalIds(body.signalIds))
    ? body.signalIds.map((id, index) => requireObjectId(id, `signalIds[${index}]`))
    : [];
  const title = checkedTitle(body.title);
  const userId = checkedUserId(body.userId);

  await validateConversationRefs(workspaceId, { propertyId, guestId, stayId, signalIds });

  const conversation = await Conversation.create({
    workspaceId,
    userId,
    propertyId,
    guestId,
    stayId,
    signalIds,
    title,
    status: body.status,
  });

  return toPlain(conversation);
}

export async function listConversations(query) {
  const workspaceId = requireObjectId(query.workspaceId, "workspaceId");
  const pagination = parsePagination(query);
  const sort = parseSort(query, ["createdAt", "updatedAt", "title"], { updatedAt: -1 });
  const filter = { workspaceId };

  if (query.guestId) filter.guestId = parseObjectId(query.guestId, "guestId");
  if (query.stayId) filter.stayId = parseObjectId(query.stayId, "stayId");
  if (query.status) filter.status = query.status;

  return paginateQuery(Conversation, filter, pagination, sort);
}

export async function getConversationById(id, workspaceId) {
  const scope = requireObjectId(workspaceId, "workspaceId");
  return toPlain(
    await findInWorkspaceOr404(Conversation, requireObjectId(id), scope, "Conversation"),
  );
}

export async function updateConversation(id, body, workspaceId) {
  const scope = requireObjectId(workspaceId, "workspaceId");
  const conversation = await findInWorkspaceOr404(
    Conversation,
    requireObjectId(id),
    scope,
    "Conversation",
  );
  assertWorkspaceUnchanged(body, conversation);
  const updates = pickDefined(body, UPDATABLE);

  if (Object.keys(updates).length === 0) {
    throw new AppError("No valid fields provided for update", 400);
  }

  if (updates.title !== undefined) updates.title = checkedTitle(updates.title);
  if (updates.userId !== undefined) updates.userId = checkedUserId(updates.userId);
  checkedSignalIds(updates.signalIds);
  if (updates.guestId !== undefined) updates.guestId = parseObjectId(updates.guestId, "guestId");
  if (updates.stayId !== undefined) updates.stayId = parseObjectId(updates.stayId, "stayId");
  if (updates.signalIds !== undefined) {
    updates.signalIds = Array.isArray(updates.signalIds)
      ? updates.signalIds.map((value, index) => requireObjectId(value, `signalIds[${index}]`))
      : [];
  }

  await validateConversationRefs(conversation.workspaceId, {
    propertyId: conversation.propertyId, // the property an investigation started with is fixed (not updatable); a new guest or stay must still belong to it
    guestId: updates.guestId ?? conversation.guestId,
    stayId: updates.stayId ?? conversation.stayId,
    signalIds: updates.signalIds ?? conversation.signalIds,
  });

  Object.assign(conversation, updates);
  await conversation.save();
  return toPlain(conversation);
}

/** True when the connected MongoDB supports multi-document transactions (a replica set or sharded cluster). */
function supportsTransactions() {
  const type = mongoose.connection.getClient?.()?.topology?.description?.type;
  return type === "ReplicaSetWithPrimary" || type === "Sharded";
}

/**
 * Deletes a Conversation AND its Messages (Phase 20; previously the Messages were left orphaned).
 *   1. the Conversation is resolved INSIDE the caller's workspace (404 otherwise: nothing is touched);
 *   2. its Messages are deleted (only `conversationId = this conversation`);
 *   3. the Conversation is deleted.
 * With a replica set the two deletes run in ONE transaction. On a standalone MongoDB (the development setup) a
 * transaction is not available, so the ORDER is the safeguard: Messages first, so a failure between the steps leaves an
 * EMPTY conversation (still reachable and retryable) and never orphaned Messages. That window is documented, not atomic.
 */
export async function deleteConversation(id, workspaceId) {
  const scope = requireObjectId(workspaceId, "workspaceId");
  const conversation = await findInWorkspaceOr404(
    Conversation,
    requireObjectId(id),
    scope,
    "Conversation",
  );

  if (supportsTransactions()) {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await Message.deleteMany({ conversationId: conversation._id }, { session });
        await Conversation.deleteOne({ _id: conversation._id, workspaceId: scope }, { session });
      });
    } finally {
      await session.endSession();
    }
  } else {
    await Message.deleteMany({ conversationId: conversation._id });
    await Conversation.deleteOne({ _id: conversation._id, workspaceId: scope });
  }
  return toPlain(conversation);
}
