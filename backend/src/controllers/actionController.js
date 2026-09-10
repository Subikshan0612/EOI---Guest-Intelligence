import { asyncHandler } from "../utils/asyncHandler.js";
import { sendList, sendSuccess } from "../utils/response.js";
import * as actionService from "../services/actionService.js";

export const createAction = asyncHandler(async (req, res) => {
  const data = await actionService.createAction(req.body);
  sendSuccess(res, data, 201);
});

export const listActions = asyncHandler(async (req, res) => {
  const { items, pagination } = await actionService.listActions(req.query);
  sendList(res, items, pagination);
});

export const getAction = asyncHandler(async (req, res) => {
  const data = await actionService.getActionById(req.params.id, req.query.workspaceId);
  sendSuccess(res, data);
});

export const updateAction = asyncHandler(async (req, res) => {
  const data = await actionService.updateAction(req.params.id, req.body, req.query.workspaceId);
  sendSuccess(res, data);
});
