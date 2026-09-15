import { Router } from "express";
import {
  createSignal,
  deleteSignal,
  generateSignalIntelligence,
  getSignal,
  getSignalContext,
  getSignalKnowledgeRetrieval,
  listSignals,
  updateSignal,
} from "../controllers/signalController.js";

const signalRoutes = Router();

signalRoutes.post("/", createSignal);
signalRoutes.get("/", listSignals);

signalRoutes.get("/:id/context", getSignalContext);
signalRoutes.post("/:id/intelligence", generateSignalIntelligence);
// Phase 6G — retrieval only (development/validation). GET: read-only,
// nothing is persisted, unlike POST .../chunks and .../embeddings which
// actually write to MongoDB.
signalRoutes.get("/:id/knowledge-retrieval", getSignalKnowledgeRetrieval);

signalRoutes.get("/:id", getSignal);
signalRoutes.patch("/:id", updateSignal);
signalRoutes.delete("/:id", deleteSignal);

export { signalRoutes };
