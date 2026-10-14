import { Router } from "express";
import { requireAccess } from "../auth/authorize.js";
import {
  approveAction,
  createAction,
  getAction,
  listActions,
  proposeAction,
  rejectAction,
  updateAction,
} from "../controllers/actionController.js";

const actionRoutes = Router();

// Action V1 (Phase 29) - AUTHENTICATED, workspace-scoped, permissioned, exactly the same chain shape as
// Decision V1: authenticate -> active membership of the requested workspace -> permission. Proposing needs
// action:propose (operator and above); approving/rejecting needs action:review (reviewer, admin) - NEITHER
// grants action:execute, which still no role holds (see auth/roles.js and the untouched routes below).
actionRoutes.post("/propose/:decisionId", ...requireAccess("action:propose"), proposeAction);
actionRoutes.post("/:id/approve", ...requireAccess("action:review"), approveAction);
actionRoutes.post("/:id/reject", ...requireAccess("action:review"), rejectAction);

// Phase 17 WRITES: AUTHENTICATED and authorized by `action:execute`, which NO role holds (Phase 12 policy: Action
// and Outcome writes are blocked "for nobody yet"; an `outcome:record` permission is deliberately NOT created).
// An authenticated member of the verified workspace therefore always gets 403. No permission is granted here.
// UNCHANGED by Phase 29: these legacy generic endpoints remain exactly as inaccessible as before.
actionRoutes.post("/", ...requireAccess("action:execute", (req) => req.body?.workspaceId), createAction);
// Phase 16 READS: authenticated, decision:review (reviewer, admin), the role's knowledge ceiling applied to
// the PARENT Intelligence. WRITES: see below. UNCHANGED by Phase 29.
actionRoutes.get("/", ...requireAccess("decision:review"), listActions);
actionRoutes.get("/:id", ...requireAccess("decision:review"), getAction);
actionRoutes.patch("/:id", ...requireAccess("action:execute"), updateAction);

export { actionRoutes };
