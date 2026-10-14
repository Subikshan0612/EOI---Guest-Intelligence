import { asyncHandler } from "../utils/asyncHandler.js";
import { sendList, sendSuccess } from "../utils/response.js";
import * as workspaceService from "../services/workspaceService.js";

export const listWorkspaces = asyncHandler(async (req, res) => {
  const { items, pagination } = await workspaceService.listWorkspacesForActor(req.actor, req.query);
  sendList(res, items, pagination);
});

export const getWorkspace = asyncHandler(async (req, res) => {
  const data = await workspaceService.getWorkspaceById(req.actor.workspaceId);
  sendSuccess(res, data);
});

export const updateWorkspace = asyncHandler(async (req, res) => {
  const data = await workspaceService.updateWorkspace(req.params.id, req.body);
  sendSuccess(res, data);
});

export const deleteWorkspace = asyncHandler(async (req, res) => {
  const data = await workspaceService.deleteWorkspace(req.params.id, req.body);
  sendSuccess(res, data);
});
