import { asyncHandler } from "../utils/asyncHandler.js";
import { sendList, sendSuccess } from "../utils/response.js";
import { getAuthorizedKnowledgeLevel } from "../middleware/knowledgeAccess.js";
import * as outcomeService from "../services/outcomeService.js";

export const createOutcome = asyncHandler(async (req, res) => {
  const data = await outcomeService.createOutcome({ ...req.body, workspaceId: req.actor.workspaceId });
  sendSuccess(res, data, 201);
});

export const listOutcomes = asyncHandler(async (req, res) => {
  const { items, pagination } = await outcomeService.listOutcomes({ ...req.query, workspaceId: req.actor.workspaceId }, getAuthorizedKnowledgeLevel(req), { viewerUserId: req.actor.userId });
  sendList(res, items, pagination);
});

export const getOutcome = asyncHandler(async (req, res) => {
  const data = await outcomeService.getOutcomeById(req.params.id, req.actor.workspaceId, getAuthorizedKnowledgeLevel(req), { viewerUserId: req.actor.userId });
  sendSuccess(res, data);
});

/**
 * Outcome V1 - POST /api/outcomes/record/:actionId?workspaceId=...   body: { status, result: { summary } }
 * A PERSON reports what actually happened. The Action is named by the route; the workspace, the actor and every relationship (decision, intelligence, signal, property)
 * come from the authenticated session and the stored Action - never from the body. 201 when recorded; a second attempt for the same Action is a 409 conflict.
 */
export const recordOutcome = asyncHandler(async (req, res) => {
  const data = await outcomeService.recordOutcome(req.params.actionId, req.actor.workspaceId, req.body, {
    actorUserId: req.actor.userId,
    authorizedLevel: getAuthorizedKnowledgeLevel(req),
    requireSummary: true,
  });
  sendSuccess(res, data, 201);
});

export const updateOutcome = asyncHandler(async (req, res) => {
  const data = await outcomeService.updateOutcome(
    req.params.id,
    req.body,
    req.actor.workspaceId,
  );
  sendSuccess(res, data);
});
