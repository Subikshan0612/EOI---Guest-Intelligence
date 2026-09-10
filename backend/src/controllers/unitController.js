import { asyncHandler } from "../utils/asyncHandler.js";
import { sendList, sendSuccess } from "../utils/response.js";
import * as unitService from "../services/unitService.js";

export const createUnit = asyncHandler(async (req, res) => {
  const data = await unitService.createUnit(req.body);
  sendSuccess(res, data, 201);
});

export const listUnits = asyncHandler(async (req, res) => {
  const { items, pagination } = await unitService.listUnits(req.query);
  sendList(res, items, pagination);
});

export const getUnit = asyncHandler(async (req, res) => {
  const data = await unitService.getUnitById(req.params.id, req.query.workspaceId);
  sendSuccess(res, data);
});

export const updateUnit = asyncHandler(async (req, res) => {
  const data = await unitService.updateUnit(req.params.id, req.body, req.query.workspaceId);
  sendSuccess(res, data);
});

export const deleteUnit = asyncHandler(async (req, res) => {
  const data = await unitService.deleteUnit(req.params.id, req.query.workspaceId);
  sendSuccess(res, data);
});
