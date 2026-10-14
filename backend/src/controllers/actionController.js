import { asyncHandler } from "../utils/asyncHandler.js";
import { sendList, sendSuccess } from "../utils/response.js";
import { getAuthorizedKnowledgeLevel } from "../middleware/knowledgeAccess.js";
import * as actionService from "../services/actionService.js";

export const createAction = asyncHandler(async (req, res) => {
  const data = await actionService.createAction({ ...req.body, workspaceId: req.actor.workspaceId });
  sendSuccess(res, data, 201);
});

export const listActions = asyncHandler(async (req, res) => {
  const { items, pagination } = await actionService.listActions({ ...req.query, workspaceId: req.actor.workspaceId }, getAuthorizedKnowledgeLevel(req), { viewerUserId: req.actor.userId });
  sendList(res, items, pagination);
});

export const getAction = asyncHandler(async (req, res) => {
  const data = await actionService.getActionById(req.params.id, req.actor.workspaceId, getAuthorizedKnowledgeLevel(req), { viewerUserId: req.actor.userId });
  sendSuccess(res, data);
});

export const updateAction = asyncHandler(async (req, res) => {
  const data = await actionService.updateAction(req.params.id, req.body, req.actor.workspaceId);
  sendSuccess(res, data);
});

/**
 * Action V1 - POST /api/actions/propose/:decisionId?workspaceId=...
 * 201 when a new proposal was created, 200 when the existing one is returned. Workspace and knowledge level
 * come only from `req.actor` / the trusted server-side resolver - never from the request body.
 */
export const proposeAction = asyncHandler(async (req, res) => {
  const { record, created } = await actionService.proposeAction(
    req.params.decisionId,
    req.actor.workspaceId,
    req.body,
    { authorizedLevel: getAuthorizedKnowledgeLevel(req), actorUserId: req.actor.userId },
  );
  sendSuccess(res, record, created ? 201 : 200);
});

export const approveAction = asyncHandler(async (req, res) => {
  const data = await actionService.approveAction(req.params.id, req.actor.workspaceId, req.body, {
    authorizedLevel: getAuthorizedKnowledgeLevel(req),
    actorUserId: req.actor.userId,
  });
  sendSuccess(res, data);
});

export const rejectAction = asyncHandler(async (req, res) => {
  const data = await actionService.rejectAction(req.params.id, req.actor.workspaceId, req.body, {
    authorizedLevel: getAuthorizedKnowledgeLevel(req),
    actorUserId: req.actor.userId,
  });
  sendSuccess(res, data);
});
