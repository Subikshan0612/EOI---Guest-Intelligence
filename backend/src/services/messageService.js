import { Conversation } from "../models/Conversation.js";
import { Message } from "../models/Message.js";
import { requireObjectId } from "../utils/objectId.js";
import { parsePagination, parseSort } from "../utils/pagination.js";
import { findByIdOr404, paginateQuery, requireFields, toPlain } from "./queryHelpers.js";

export async function createMessage(conversationId, body) {
  const conversation = await findByIdOr404(
    Conversation,
    requireObjectId(conversationId, "conversationId"),
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

export async function listMessages(conversationId, query) {
  const conversationObjectId = requireObjectId(conversationId, "conversationId");
  await findByIdOr404(Conversation, conversationObjectId, "Conversation");

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
