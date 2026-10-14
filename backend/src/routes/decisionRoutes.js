import { Router } from "express";
import { requireAccess } from "../auth/authorize.js";
import {
  approveDecision,
  createDecision,
  getDecision,
  listDecisions,
  proposeDecision,
  rejectDecision,
  updateDecision,
} from "../controllers/decisionController.js";

const decisionRoutes = Router();

// Decision V1 - AUTHENTICATED, workspace-scoped, permissioned. Each chain is
// authenticate -> active membership of the requested workspace -> permission.
// The workspaceId a request names is only a selection; authority is the membership.
decisionRoutes.post("/propose/:intelligenceId", ...requireAccess("decision:propose"), proposeDecision);
decisionRoutes.post("/:id/approve", ...requireAccess("decision:review"), approveDecision);
decisionRoutes.post("/:id/reject", ...requireAccess("decision:review"), rejectDecision);

decisionRoutes.get("/", ...requireAccess("intelligence:view"), listDecisions);
decisionRoutes.get("/:id", ...requireAccess("intelligence:view"), getDecision);

// LEGACY generic endpoints: pre-V1 records only (see decisionService.js). They cannot create or
// change a Decision V1 (the service refuses). Phase 16: AUTHENTICATED. Creating needs decision:propose
// (workspace selected in the body), and setting any status other than the default "proposed" needs
// decision:review as well (checked in the controller), so a proposer cannot mint an "approved" record.
// Changing one (its status is a review) needs decision:review.
decisionRoutes.post("/", ...requireAccess("decision:propose", (req) => req.body?.workspaceId), createDecision);
decisionRoutes.patch("/:id", ...requireAccess("decision:review"), updateDecision);

export { decisionRoutes };
