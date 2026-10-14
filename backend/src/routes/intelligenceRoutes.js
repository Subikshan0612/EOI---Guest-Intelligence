import { Router } from "express";
import { requireAccess } from "../auth/authorize.js";
import {
  analyzeSignal,
  getAnalysisStatus,
  getIntelligence,
  listIntelligence,
} from "../controllers/intelligenceController.js";

const intelligenceRoutes = Router();

// POST /api/intelligence (store arbitrary Intelligence) is RETIRED: Intelligence comes only from the
// grounded generation paths below and the legacy generate route.
// Intelligence V1 - grounded analysis of one Signal (analysis + recommendation only).
// AUTHENTICATED: bearer -> active membership -> intelligence:generate (it spends model budget and
// writes Intelligence). Level = the actor's role ceiling; workspace = the verified membership.
intelligenceRoutes.post("/analyze/:signalId", ...requireAccess("intelligence:generate", undefined, { tier: "ai" }), analyzeSignal);
// Raw reads: AUTHENTICATED, intelligence:view, the role's knowledge ceiling, the verified workspace, and
// a whitelisted response shape (no provider/model, no guest ids, limited provenance).
intelligenceRoutes.get("/", ...requireAccess("intelligence:view"), listIntelligence);
// Workstream 5A: the state of one Signal's analysis (in progress / succeeded / failed), read-only, state only. Declared BEFORE "/:id" so the path is never read as an id.
intelligenceRoutes.get("/analysis-status/:signalId", ...requireAccess("intelligence:view"), getAnalysisStatus);
intelligenceRoutes.get("/:id", ...requireAccess("intelligence:view"), getIntelligence);

export { intelligenceRoutes };
