import { Router } from "express";
import {
  createKnowledgeDocument,
  deleteKnowledgeDocument,
  getKnowledgeDocument,
  listKnowledgeDocuments,
  updateKnowledgeDocument,
} from "../controllers/knowledgeDocumentController.js";

const knowledgeDocumentRoutes = Router();

knowledgeDocumentRoutes.post("/", createKnowledgeDocument);
knowledgeDocumentRoutes.get("/", listKnowledgeDocuments);
knowledgeDocumentRoutes.get("/:id", getKnowledgeDocument);
knowledgeDocumentRoutes.patch("/:id", updateKnowledgeDocument);
knowledgeDocumentRoutes.delete("/:id", deleteKnowledgeDocument);

export { knowledgeDocumentRoutes };
