import { getAuthorizedKnowledgeLevel } from "../middleware/knowledgeAccess.js";
import * as dashboardService from "../services/dashboardService.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { sendList, sendSuccess } from "../utils/response.js";

/**
 * Dashboard V1 - read-only. By the time these run, the route has authenticated the
 * caller and resolved an ACTIVE workspace membership with `intelligence:view`.
 *   - the workspace is the membership-verified `req.actor.workspaceId`; whatever the
 *     query named is only the selection that was validated, and can never override it;
 *   - the knowledge level is the actor's role ceiling (getAuthorizedKnowledgeLevel
 *     reads req.actor and never the process environment for an authenticated request).
 */
export const listDashboardSignals = asyncHandler(async (req, res) => {
  const query = { ...req.query, workspaceId: req.actor.workspaceId };
  const { items, pagination } = await dashboardService.listDashboardSignals(query, getAuthorizedKnowledgeLevel(req));
  sendList(res, items, pagination);
});

export const getDashboardSignal = asyncHandler(async (req, res) => {
  const data = await dashboardService.getDashboardSignal(req.params.signalId, req.actor.workspaceId, getAuthorizedKnowledgeLevel(req));
  sendSuccess(res, data);
});
