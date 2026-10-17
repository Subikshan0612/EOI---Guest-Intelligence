import { asyncHandler } from "../utils/asyncHandler.js";
import { sendList, sendSuccess } from "../utils/response.js";
import * as conversationService from "../services/conversationService.js";
import * as messageService from "../services/messageService.js";
import { processIntakeTurn } from "../services/signalIntakeService.js";

/**
 * Phase 47 - one operator turn of the conversational Signal intake: POST /api/conversations/intake { conversationId?, content, context?: { propertyId, guestId?, stayId? } }. The workspace is the VERIFIED
 * membership; no body field names a role, user, workspace or model. `context` is a SELECTION only: the records are loaded inside the verified workspace and their relationships
 * (guest -> property, stay -> property and guest) are checked by the server before anything is created. It creates a Signal (201) or answers with a clarification / refusal (200) and never calls AI.
 */
export const intakeTurn = asyncHandler(async (req, res) => {
  const result = await processIntakeTurn({ workspaceId: req.actor.workspaceId, conversationId: req.body?.conversationId, content: req.body?.content, context: req.body?.context });
  sendSuccess(res, result, result.created ? 201 : 200);
});

export const createConversation = asyncHandler(async (req, res) => {
  const data = await conversationService.createConversation({ ...req.body, workspaceId: req.actor.workspaceId });
  sendSuccess(res, data, 201);
});

export const listConversations = asyncHandler(async (req, res) => {
  const { items, pagination } = await conversationService.listConversations({ ...req.query, workspaceId: req.actor.workspaceId });
  sendList(res, items, pagination);
});

export const getConversation = asyncHandler(async (req, res) => {
  const data = await conversationService.getConversationById(
    req.params.id,
    req.actor.workspaceId,
  );
  sendSuccess(res, data);
});

export const updateConversation = asyncHandler(async (req, res) => {
  const data = await conversationService.updateConversation(
    req.params.id,
    req.body,
    req.actor.workspaceId,
  );
  sendSuccess(res, data);
});

export const deleteConversation = asyncHandler(async (req, res) => {
  const data = await conversationService.deleteConversation(
    req.params.id,
    req.actor.workspaceId,
  );
  sendSuccess(res, data);
});

export const createMessage = asyncHandler(async (req, res) => {
  const data = await messageService.createMessage(
    req.params.conversationId,
    req.body,
    req.actor.workspaceId,
  );
  sendSuccess(res, data, 201);
});

export const listMessages = asyncHandler(async (req, res) => {
  const { items, pagination } = await messageService.listMessages(
    req.params.conversationId,
    { ...req.query, workspaceId: req.actor.workspaceId },
    req.actor.workspaceId,
  );
  sendList(res, items, pagination);
});
