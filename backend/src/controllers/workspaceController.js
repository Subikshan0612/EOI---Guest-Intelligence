import { asyncHandler } from "../utils/asyncHandler.js";
import { sendList, sendSuccess } from "../utils/response.js";
import * as workspaceService from "../services/workspaceService.js";

export const createWorkspace = asyncHandler(async (req, res) => {
  const data = await workspaceService.createWorkspace(req.body);
  sendSuccess(res, data, 201);
});

export const listWorkspaces = asyncHandler(async (req, res) => {
  const { items, pagination } = await workspaceService.listWorkspaces(req.query);
  sendList(res, items, pagination);
});

export const getWorkspace = asyncHandler(async (req, res) => {
  const data = await workspaceService.getWorkspaceById(req.params.id);
  sendSuccess(res, data);
});

export const updateWorkspace = asyncHandler(async (req, res) => {
  const data = await workspaceService.updateWorkspace(req.params.id, req.body);
  sendSuccess(res, data);
});

export const deleteWorkspace = asyncHandler(async (req, res) => {
  const data = await workspaceService.deleteWorkspace(req.params.id);
  sendSuccess(res, data);
});
