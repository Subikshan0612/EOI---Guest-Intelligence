import { asyncHandler } from "../utils/asyncHandler.js";
import { sendList, sendSuccess } from "../utils/response.js";
import * as conversationService from "../services/conversationService.js";
import * as messageService from "../services/messageService.js";

export const createConversation = asyncHandler(async (req, res) => {
  const data = await conversationService.createConversation(req.body);
  sendSuccess(res, data, 201);
});

export const listConversations = asyncHandler(async (req, res) => {
  const { items, pagination } = await conversationService.listConversations(req.query);
  sendList(res, items, pagination);
});

export const getConversation = asyncHandler(async (req, res) => {
  const data = await conversationService.getConversationById(req.params.id);
  sendSuccess(res, data);
});

export const updateConversation = asyncHandler(async (req, res) => {
  const data = await conversationService.updateConversation(req.params.id, req.body);
  sendSuccess(res, data);
});

export const deleteConversation = asyncHandler(async (req, res) => {
  const data = await conversationService.deleteConversation(req.params.id);
  sendSuccess(res, data);
});

export const createMessage = asyncHandler(async (req, res) => {
  const data = await messageService.createMessage(req.params.conversationId, req.body);
  sendSuccess(res, data, 201);
});

export const listMessages = asyncHandler(async (req, res) => {
  const { items, pagination } = await messageService.listMessages(
    req.params.conversationId,
    req.query,
  );
  sendList(res, items, pagination);
});
