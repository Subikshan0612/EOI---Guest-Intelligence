import { Conversation } from "../models/Conversation.js";
import { Message } from "../models/Message.js";
import { requireObjectId } from "../utils/objectId.js";
import { parsePagination, parseSort } from "../utils/pagination.js";
import {
  findByIdOr404,
  findInWorkspaceOr404,
  paginateQuery,
  requireFields,
  toPlain,
} from "./queryHelpers.js";

/**
 * Message carries no workspaceId of its own. Tenant isolation for messages is
 * enforced entirely through the parent Conversation: a caller must supply the
 * workspace that owns the conversation, and a conversation from another
 * workspace resolves to a 404.
 */
export async function createMessage(conversationId, body, workspaceId) {
  const scope = requireObjectId(workspaceId, "workspaceId");
  const conversation = await findInWorkspaceOr404(
    Conversation,
    requireObjectId(conversationId, "conversationId"),
    scope,
    "Conversation",
  );

  requireFields(body, ["role", "content"]);

  const message = await Message.create({
    conversationId: conversation._id,
    role: body.role,
    type: body.type,
    content: body.content,
    metadata: body.metadata,
  });

  conversation.updatedAt = new Date();
  await conversation.save();

  return toPlain(message);
}

export async function listMessages(conversationId, query, workspaceId) {
  const scope = requireObjectId(workspaceId, "workspaceId");
  const conversationObjectId = requireObjectId(conversationId, "conversationId");
  await findInWorkspaceOr404(Conversation, conversationObjectId, scope, "Conversation");

  const pagination = parsePagination(query);
  const sort = parseSort(query, ["createdAt"], { createdAt: 1 });

  return paginateQuery(
    Message,
    { conversationId: conversationObjectId },
    pagination,
    sort,
  );
}

export async function getMessageById(id) {
  return toPlain(await findByIdOr404(Message, requireObjectId(id), "Message"));
}
