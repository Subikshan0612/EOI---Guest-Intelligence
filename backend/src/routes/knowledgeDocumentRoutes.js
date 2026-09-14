import { Router } from "express";
import {
  chunkKnowledgeDocument,
  createKnowledgeDocument,
  deleteKnowledgeDocument,
  embedKnowledgeDocument,
  getKnowledgeDocument,
  listKnowledgeChunks,
  listKnowledgeDocuments,
  updateKnowledgeDocument,
} from "../controllers/knowledgeDocumentController.js";

const knowledgeDocumentRoutes = Router();

knowledgeDocumentRoutes.post("/", createKnowledgeDocument);
knowledgeDocumentRoutes.get("/", listKnowledgeDocuments);

// Phase 6D — nested chunk sub-resource, same shape as
// conversationRoutes.js's /:conversationId/messages: POST (re)builds,
// GET reads back. Defined before the generic /:id routes below.
knowledgeDocumentRoutes.post("/:documentId/chunks", chunkKnowledgeDocument);
knowledgeDocumentRoutes.get("/:documentId/chunks", listKnowledgeChunks);

// Phase 6E — embeds the document's existing chunks. No GET counterpart:
// GET .../chunks above already returns each chunk's embedding/embeddingModel,
// so a second read endpoint would be redundant.
knowledgeDocumentRoutes.post("/:documentId/embeddings", embedKnowledgeDocument);

knowledgeDocumentRoutes.get("/:id", getKnowledgeDocument);
knowledgeDocumentRoutes.patch("/:id", updateKnowledgeDocument);
knowledgeDocumentRoutes.delete("/:id", deleteKnowledgeDocument);

export { knowledgeDocumentRoutes };
