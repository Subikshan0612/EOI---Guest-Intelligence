import { asyncHandler } from "../utils/asyncHandler.js";
import { sendList, sendSuccess } from "../utils/response.js";
import * as knowledgeDocumentService from "../services/knowledgeDocumentService.js";

export const createKnowledgeDocument = asyncHandler(async (req, res) => {
  const data = await knowledgeDocumentService.createKnowledgeDocument(req.body);
  sendSuccess(res, data, 201);
});

export const listKnowledgeDocuments = asyncHandler(async (req, res) => {
  const { items, pagination } = await knowledgeDocumentService.listKnowledgeDocuments(req.query);
  sendList(res, items, pagination);
});

export const getKnowledgeDocument = asyncHandler(async (req, res) => {
  const data = await knowledgeDocumentService.getKnowledgeDocumentById(
    req.params.id,
    req.query.workspaceId,
  );
  sendSuccess(res, data);
});

export const updateKnowledgeDocument = asyncHandler(async (req, res) => {
  const data = await knowledgeDocumentService.updateKnowledgeDocument(
    req.params.id,
    req.body,
    req.query.workspaceId,
  );
  sendSuccess(res, data);
});

export const deleteKnowledgeDocument = asyncHandler(async (req, res) => {
  const data = await knowledgeDocumentService.deleteKnowledgeDocument(
    req.params.id,
    req.query.workspaceId,
  );
  sendSuccess(res, data);
});
