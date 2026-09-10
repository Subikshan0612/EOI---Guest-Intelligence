import { Conversation } from "../models/Conversation.js";
import { Guest } from "../models/Guest.js";
import { Intelligence } from "../models/Intelligence.js";
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
  requireFields,
  toPlain,
} from "./queryHelpers.js";

async function validateIntelligenceRefs(workspaceId, refs) {
  if (refs.conversationId) {
    const conversation = await findByIdOr404(Conversation, refs.conversationId, "Conversation");
    assertSameWorkspace(conversation, workspaceId, "Conversation");
  }
  if (refs.guestId) {
    const guest = await findByIdOr404(Guest, refs.guestId, "Guest");
    assertSameWorkspace(guest, workspaceId, "Guest");
  }
  if (refs.stayId) {
    const stay = await findByIdOr404(Stay, refs.stayId, "Stay");
    assertSameWorkspace(stay, workspaceId, "Stay");
  }
  if (Array.isArray(refs.signalIds) && refs.signalIds.length > 0) {
    const signals = await Signal.find({ _id: { $in: refs.signalIds } });
    if (signals.length !== refs.signalIds.length) {
      throw new AppError("One or more signals were not found", 404);
    }
    for (const signal of signals) {
      assertSameWorkspace(signal, workspaceId, "Signal");
    }
  }
}

export async function createIntelligence(body) {
  requireFields(body, ["workspaceId"]);
  const workspaceId = requireObjectId(body.workspaceId, "workspaceId");
  await assertExists(Workspace, workspaceId, "Workspace");

  const conversationId = parseObjectId(body.conversationId, "conversationId");
  const guestId = parseObjectId(body.guestId, "guestId");
  const stayId = parseObjectId(body.stayId, "stayId");
  const signalIds = Array.isArray(body.signalIds)
    ? body.signalIds.map((id, index) => requireObjectId(id, `signalIds[${index}]`))
    : [];

  await validateIntelligenceRefs(workspaceId, { conversationId, guestId, stayId, signalIds });

  if (body.confidence !== undefined) {
    const confidence = Number(body.confidence);
    if (Number.isNaN(confidence) || confidence < 0 || confidence > 1) {
      throw new AppError("confidence must be a number between 0 and 1", 400);
    }
  }

  const intelligence = await Intelligence.create({
    workspaceId,
    conversationId,
    guestId,
    stayId,
    signalIds,
    signal: body.signal,
    context: body.context,
    intelligence: body.intelligence,
    risk: body.risk,
    decision: body.decision,
    action: body.action,
    outcome: body.outcome,
    confidence: body.confidence,
    generatedBy: body.generatedBy,
    model: body.model,
  });

  return toPlain(intelligence);
}

export async function listIntelligence(query) {
  const pagination = parsePagination(query);
  const sort = parseSort(query, ["createdAt", "updatedAt"], { createdAt: -1 });
  const filter = {};

  if (query.workspaceId) filter.workspaceId = parseObjectId(query.workspaceId, "workspaceId");
  if (query.conversationId) {
    filter.conversationId = parseObjectId(query.conversationId, "conversationId");
  }
  if (query.guestId) filter.guestId = parseObjectId(query.guestId, "guestId");
  if (query.stayId) filter.stayId = parseObjectId(query.stayId, "stayId");
  if (query.signalId) filter.signalIds = parseObjectId(query.signalId, "signalId");

  return paginateQuery(Intelligence, filter, pagination, sort);
}

export async function getIntelligenceById(id) {
  return toPlain(await findByIdOr404(Intelligence, requireObjectId(id), "Intelligence"));
}
