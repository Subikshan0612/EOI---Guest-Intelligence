import { Router } from "express";
import { getLearningReport } from "../controllers/learningController.js";

const learningRoutes = Router();

// Read-only analytical endpoint — no POST/PATCH/DELETE (Phase 7D: Learning
// v1 is a report, never a mutation).
learningRoutes.get("/", getLearningReport);

export { learningRoutes };
