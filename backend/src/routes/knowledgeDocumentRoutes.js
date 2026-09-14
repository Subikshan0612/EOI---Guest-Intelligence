import { Router } from "express";
import {
  chunkKnowledgeDocument,
  createKnowledgeDocument,
  deleteKnowledgeDocument,
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

knowledgeDocumentRoutes.get("/:id", getKnowledgeDocument);
knowledgeDocumentRoutes.patch("/:id", updateKnowledgeDocument);
knowledgeDocumentRoutes.delete("/:id", deleteKnowledgeDocument);

export { knowledgeDocumentRoutes };
