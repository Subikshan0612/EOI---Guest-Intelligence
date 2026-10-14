import { Router } from "express";
import { requireAccess } from "../auth/authorize.js";
import {
  createOutcome,
  getOutcome,
  listOutcomes,
  recordOutcome,
  updateOutcome,
} from "../controllers/outcomeController.js";

const outcomeRoutes = Router();

// Outcome V1 (Phase 50) - a PERSON records what actually happened for an APPROVED Action V1. AUTHENTICATED, workspace-scoped, and permissioned by the EXISTING
// `operations:manage` (operator, reviewer, admin - the same permission that records a Signal): no new permission and no new role. The Action is named by the route; nothing
// else about ownership is accepted from the request. It executes nothing and calls no AI service.
outcomeRoutes.post("/record/:actionId", ...requireAccess("operations:manage"), recordOutcome);

// Phase 17 WRITES: AUTHENTICATED and authorized by `action:execute`, which NO role holds (Phase 12 policy: Action
// and Outcome writes are blocked "for nobody yet"; an `outcome:record` permission is deliberately NOT created).
// An authenticated member of the verified workspace therefore always gets 403. No permission is granted here.
outcomeRoutes.post("/", ...requireAccess("action:execute", (req) => req.body?.workspaceId), createOutcome);
// Phase 16 READS: authenticated, decision:review (reviewer, admin), the role's knowledge ceiling applied to
// the PARENT Intelligence. WRITES: see below.
outcomeRoutes.get("/", ...requireAccess("decision:review"), listOutcomes);
outcomeRoutes.get("/:id", ...requireAccess("decision:review"), getOutcome);
outcomeRoutes.patch("/:id", ...requireAccess("action:execute"), updateOutcome);

export { outcomeRoutes };
