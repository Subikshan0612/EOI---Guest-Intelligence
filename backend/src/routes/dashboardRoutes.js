import { Router } from "express";
import { requireAccess } from "../auth/authorize.js";
import { getDashboardSignal, listDashboardSignals } from "../controllers/dashboardController.js";

const dashboardRoutes = Router();

// Dashboard V1 - READ-ONLY read model. GET only: there is deliberately no POST, PATCH,
// PUT or DELETE, and nothing here can generate Intelligence.
//
// AUTHENTICATED: bearer token -> active membership of the requested workspace ->
// `intelligence:view`. The workspaceId a request names is only a selection; the
// authority is the membership, and the knowledge ceiling is the role's
// (getAuthorizedKnowledgeLevel reads req.actor).
dashboardRoutes.get("/signals", ...requireAccess("intelligence:view"), listDashboardSignals);
dashboardRoutes.get("/signals/:signalId", ...requireAccess("intelligence:view"), getDashboardSignal);

export { dashboardRoutes };
