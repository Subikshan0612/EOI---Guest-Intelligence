import { Router } from "express";
import { requireAccess } from "../auth/authorize.js";
import {
  createSignal,
  deleteSignal,
  getSignal,
  getSignalContext,
  getSignalKnowledgeRetrieval,
  listSignals,
  updateSignal,
} from "../controllers/signalController.js";

const signalRoutes = Router();

// Phase 15: every Signal route is AUTHENTICATED. The workspace a caller names is only a SELECTOR
// (query for reads/updates/deletes, body for creates), verified against the caller's membership.
//   read (list, detail)    intelligence:view   every member (viewers included)
//   context                operations:view     it embeds Guest and Stay facts (PII), so viewers may not read it
//   create / update        operations:manage
//   delete                 workspace:admin
signalRoutes.post("/", ...requireAccess("operations:manage", (req) => req.body?.workspaceId), createSignal);
signalRoutes.get("/", ...requireAccess("intelligence:view"), listSignals);
signalRoutes.get("/:id/context", ...requireAccess("operations:view"), getSignalContext);
// Phase 24: the legacy POST /:id/intelligence generation route is RETIRED (it no longer exists, so it answers 404
// like any unknown path). The one canonical generation route is POST /api/intelligence/analyze/:signalId.
// Phase 6G — retrieval only (development/validation). GET: read-only,
// nothing is persisted, unlike POST .../chunks and .../embeddings which
// actually write to MongoDB.
// DEVELOPMENT / DEBUG endpoint (a future retirement candidate): it spends embedding budget and
// returns retrieved knowledge. AUTHENTICATED and ADMIN-ONLY: bearer -> membership -> workspace:admin.
signalRoutes.get("/:id/knowledge-retrieval", ...requireAccess("workspace:admin", undefined, { tier: "ai" }), getSignalKnowledgeRetrieval);

signalRoutes.get("/:id", ...requireAccess("intelligence:view"), getSignal);
signalRoutes.patch("/:id", ...requireAccess("operations:manage"), updateSignal);
signalRoutes.delete("/:id", ...requireAccess("workspace:admin"), deleteSignal);

export { signalRoutes };
