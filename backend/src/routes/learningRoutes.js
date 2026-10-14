import { Router } from "express";
import { requireAccess } from "../auth/authorize.js";
import { getLearningReport, getLearningPatterns, getOutcomeLearningPatterns } from "../controllers/learningController.js";

const learningRoutes = Router();

// Read-only analytical endpoints — no POST/PATCH/DELETE (Phase 7D/7F-A/31:
// Learning is a report, never a mutation).
// Phase 16: ADMIN-ONLY. The learning report reads Decisions, Actions and Outcomes directly, so it does NOT
// apply parent-Intelligence visibility; only the restricted-ceiling role (admin) may read it until it does.
learningRoutes.get("/", ...requireAccess("workspace:admin"), getLearningReport);
learningRoutes.get("/patterns", ...requireAccess("workspace:admin"), getLearningPatterns);
// Phase 31: same admin-only policy, unchanged and unbroadened - see outcomeLearningService.js.
learningRoutes.get("/outcomes", ...requireAccess("workspace:admin"), getOutcomeLearningPatterns);

export { learningRoutes };
