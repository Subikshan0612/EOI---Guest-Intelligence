import { asyncHandler } from "../utils/asyncHandler.js";
import { sendList, sendSuccess } from "../utils/response.js";
import { actorHasPermission } from "../auth/authorize.js";
import { AppError } from "../utils/AppError.js";
import * as decisionService from "../services/decisionService.js";
import { getAuthorizedKnowledgeLevel } from "../middleware/knowledgeAccess.js";

export const createDecision = asyncHandler(async (req, res) => {
  const status = req.body?.status;
  if (status !== undefined && status !== "proposed" && !actorHasPermission(req.actor, "decision:review")) {
    throw new AppError("Setting a Decision status requires review permission", 403, { code: "FORBIDDEN", permission: "decision:review" });
  }
  const data = await decisionService.createDecision({ ...req.body, workspaceId: req.actor.workspaceId });
  sendSuccess(res, data, 201);
});

/**
 * Decision V1 - POST /api/decisions/propose/:intelligenceId?workspaceId=...
 * 201 when a new proposal was created, 200 when the existing one is returned.
 * The level comes only from the trusted server-side resolver.
 */
export const proposeDecision = asyncHandler(async (req, res) => {
  const { record, created } = await decisionService.proposeDecision(
    req.params.intelligenceId,
    req.actor.workspaceId,
    req.body,
    { authorizedLevel: getAuthorizedKnowledgeLevel(req), actorUserId: req.actor.userId },
  );
  sendSuccess(res, record, created ? 201 : 200);
});

export const listDecisions = asyncHandler(async (req, res) => {
  // The membership-verified workspace overrides whatever the query named.
  const query = { ...req.query, workspaceId: req.actor.workspaceId };
  const { items, pagination } = await decisionService.listDecisions(query, getAuthorizedKnowledgeLevel(req), { viewerUserId: req.actor.userId });
  sendList(res, items, pagination);
});

export const getDecision = asyncHandler(async (req, res) => {
  const data = await decisionService.getDecisionById(
    req.params.id,
    req.actor.workspaceId,
    getAuthorizedKnowledgeLevel(req),
    { viewerUserId: req.actor.userId },
  );
  sendSuccess(res, data);
});

export const approveDecision = asyncHandler(async (req, res) => {
  const data = await decisionService.approveDecision(req.params.id, req.actor.workspaceId, req.body, {
    authorizedLevel: getAuthorizedKnowledgeLevel(req),
    actorUserId: req.actor.userId,
  });
  sendSuccess(res, data);
});

export const rejectDecision = asyncHandler(async (req, res) => {
  const data = await decisionService.rejectDecision(req.params.id, req.actor.workspaceId, req.body, {
    authorizedLevel: getAuthorizedKnowledgeLevel(req),
    actorUserId: req.actor.userId,
  });
  sendSuccess(res, data);
});

export const updateDecision = asyncHandler(async (req, res) => {
  const data = await decisionService.updateDecision(req.params.id, req.body, req.actor.workspaceId);
  sendSuccess(res, data);
});
