import { Conversation } from "../models/Conversation.js";
import { Message } from "../models/Message.js";
import { AppError } from "../utils/AppError.js";
import { assertBoundedJson, requireBoundedString } from "../utils/boundedJson.js";
import { requireObjectId } from "../utils/objectId.js";
import { parsePagination, parseSort } from "../utils/pagination.js";
import { findByIdOr404, findInWorkspaceOr404, paginateQuery, toPlain } from "./queryHelpers.js";

// The chat UI loads a conversation's history in one request (it asks for 200), so messages allow a page of
// up to 200 - still a hard server-side bound (other lists stay at 100).
export const MAX_MESSAGE_PAGE = 200;

/**
 * MESSAGE INTEGRITY (Phase 20).
 *
 * Two kinds of message data, kept apart:
 *
 *   CLIENT-WRITABLE   what an authenticated browser may create through POST /conversations/:id/messages:
 *                     a plain user-authored text message. role must be "user", type must be "text" (or omitted), and
 *                     metadata is small free-form data that may NOT carry the AI-provenance key `koiIntelligence`.
 *   SERVER-OWNED      assistant / system roles, type "intelligence" and `metadata.koiIntelligence` (a generated-analysis
 *                     card). Only server code may create these: `createServerMessage` below, which no HTTP route calls.
 *                     A browser can therefore never manufacture trusted AI/system semantics in a shared conversation.
 *
 * Limits are based on the real data (longest message 162 chars, largest metadata 2 KB / depth 5 / 3 items) with generous
 * headroom, so legitimate use is never affected.
 */
export const CLIENT_MESSAGE_LIMITS = Object.freeze({
  contentMax: 8000,
  metadata: Object.freeze({ maxBytes: 4096, maxDepth: 4, maxKeys: 20, maxArray: 50, maxString: 1000 }),
});
export const SERVER_MESSAGE_LIMITS = Object.freeze({
  contentMax: 20000,
  metadata: Object.freeze({ maxBytes: 32768, maxDepth: 8, maxKeys: 50, maxArray: 100, maxString: 5000 }),
});
export const INTELLIGENCE_METADATA_KEY = "koiIntelligence";
const CLIENT_ROLE = "user";
const CLIENT_TYPE = "text";

function assertPlainBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new AppError("A JSON object body is required", 400, { code: "INVALID_BODY" });
}

/** Validates + normalizes a CLIENT message body; returns the fields that may be stored. */
export function validateClientMessage(body) {
  assertPlainBody(body);
  if (body.role !== undefined && body.role !== CLIENT_ROLE) {
    throw new AppError('role must be "user": assistant and system messages are created by the server', 400, { code: "MESSAGE_ROLE_NOT_ALLOWED", field: "role" });
  }
  if (body.type !== undefined && body.type !== CLIENT_TYPE) {
    throw new AppError('type must be "text": intelligence messages are created by the server', 400, { code: "MESSAGE_TYPE_NOT_ALLOWED", field: "type" });
  }
  const content = requireBoundedString(body.content, { max: CLIENT_MESSAGE_LIMITS.contentMax, label: "content" });
  let metadata;
  if (body.metadata !== undefined && body.metadata !== null) {
    if (typeof body.metadata !== "object" || Array.isArray(body.metadata)) throw new AppError("metadata must be an object", 400, { code: "INVALID_FIELD", field: "metadata" });
    if (Object.prototype.hasOwnProperty.call(body.metadata, INTELLIGENCE_METADATA_KEY)) {
      throw new AppError(`metadata.${INTELLIGENCE_METADATA_KEY} is server-owned and cannot be supplied`, 400, { code: "METADATA_KEY_NOT_ALLOWED", field: "metadata" });
    }
    assertBoundedJson(body.metadata, CLIENT_MESSAGE_LIMITS.metadata, "metadata");
    metadata = body.metadata;
  }
  return { role: CLIENT_ROLE, type: CLIENT_TYPE, content, metadata };
}

async function conversationInWorkspace(conversationId, workspaceId) {
  return findInWorkspaceOr404(Conversation, requireObjectId(conversationId, "conversationId"), requireObjectId(workspaceId, "workspaceId"), "Conversation");
}

async function store(conversation, fields) {
  const message = await Message.create({ conversationId: conversation._id, ...fields });
  conversation.updatedAt = new Date();
  await conversation.save();
  return toPlain(message);
}

/** HTTP path: POST /conversations/:conversationId/messages. Client-writable data only. */
export async function createMessage(conversationId, body, workspaceId) {
  const conversation = await conversationInWorkspace(conversationId, workspaceId);
  return store(conversation, validateClientMessage(body));
}

/**
 * SERVER-OWNED path: creates assistant / system / intelligence messages. Called only by server code (future AI or
 * automation, and validation fixtures); NO HTTP route reaches it. It still resolves the conversation inside the workspace
 * and still bounds size and shape (with larger limits, since generated analysis cards are bigger than chat text).
 */
export async function createServerMessage(conversationId, workspaceId, input) {
  assertPlainBody(input);
  if (!["user", "assistant", "system"].includes(input.role)) throw new AppError("role must be user, assistant or system", 400, { code: "INVALID_FIELD", field: "role" });
  const type = input.type ?? "text";
  if (!["text", "intelligence"].includes(type)) throw new AppError("type must be text or intelligence", 400, { code: "INVALID_FIELD", field: "type" });
  const content = requireBoundedString(input.content, { max: SERVER_MESSAGE_LIMITS.contentMax, label: "content" });
  if (input.metadata !== undefined && input.metadata !== null) {
    if (typeof input.metadata !== "object" || Array.isArray(input.metadata)) throw new AppError("metadata must be an object", 400, { code: "INVALID_FIELD", field: "metadata" });
    assertBoundedJson(input.metadata, SERVER_MESSAGE_LIMITS.metadata, "metadata");
  }
  const conversation = await conversationInWorkspace(conversationId, workspaceId);
  return store(conversation, { role: input.role, type, content, metadata: input.metadata ?? undefined });
}

export async function listMessages(conversationId, query, workspaceId) {
  const scope = requireObjectId(workspaceId, "workspaceId");
  const conversationObjectId = requireObjectId(conversationId, "conversationId");
  await findInWorkspaceOr404(Conversation, conversationObjectId, scope, "Conversation");

  const pagination = parsePagination(query, MAX_MESSAGE_PAGE);
  const sort = parseSort(query, ["createdAt"], { createdAt: 1 });

  return paginateQuery(Message, { conversationId: conversationObjectId }, pagination, sort);
}

/**
 * A Message is only ever resolved THROUGH its Conversation: Message -> Conversation -> workspace. A message of
 * another workspace, or one whose conversation is missing, is the same 404 as a message that does not exist.
 */
export async function getMessageById(id, workspaceId) {
  const scope = requireObjectId(workspaceId, "workspaceId");
  const message = await findByIdOr404(Message, requireObjectId(id), "Message");
  const conversation = await Conversation.findOne({ _id: message.conversationId, workspaceId: scope }).select("_id");
  if (!conversation) throw new AppError("Message not found", 404);
  return toPlain(message);
}
