import { asyncHandler } from "../utils/asyncHandler.js";
import { sendList, sendSuccess } from "../utils/response.js";
import * as knowledgeDocumentService from "../services/knowledgeDocumentService.js";
import * as knowledgeChunkService from "../services/knowledgeChunkService.js";
import * as knowledgeEmbeddingService from "../services/knowledgeEmbeddingService.js";

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

/** Phase 6D — (re)chunks the document's current canonical content. No request body: chunking derives entirely from the document Node already holds. */
export const chunkKnowledgeDocument = asyncHandler(async (req, res) => {
  const data = await knowledgeChunkService.rebuildChunksForDocument(
    req.params.documentId,
    req.query.workspaceId,
  );
  sendSuccess(res, data, 201);
});

export const listKnowledgeChunks = asyncHandler(async (req, res) => {
  const { items, pagination } = await knowledgeChunkService.listKnowledgeChunks(
    req.params.documentId,
    req.query,
    req.query.workspaceId,
  );
  sendList(res, items, pagination);
});

/** Phase 6E — embeds the document's current chunks via Python. No request body: chunk text is loaded from MongoDB, never accepted from a caller. */
export const embedKnowledgeDocument = asyncHandler(async (req, res) => {
  const data = await knowledgeEmbeddingService.embedKnowledgeDocument(
    req.params.documentId,
    req.query.workspaceId,
  );
  sendSuccess(res, data, 201);
});
