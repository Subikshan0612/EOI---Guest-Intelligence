import { Router } from "express";
import { getLearningReport, getLearningPatterns } from "../controllers/learningController.js";

const learningRoutes = Router();

// Read-only analytical endpoints — no POST/PATCH/DELETE (Phase 7D/7F-A:
// Learning is a report, never a mutation).
learningRoutes.get("/", getLearningReport);
learningRoutes.get("/patterns", getLearningPatterns);

export { learningRoutes };
