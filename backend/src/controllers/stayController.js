import { asyncHandler } from "../utils/asyncHandler.js";
import { sendList, sendSuccess } from "../utils/response.js";
import * as stayService from "../services/stayService.js";

export const createStay = asyncHandler(async (req, res) => {
  const data = await stayService.createStay({ ...req.body, workspaceId: req.actor.workspaceId });
  sendSuccess(res, data, 201);
});

export const listStays = asyncHandler(async (req, res) => {
  const { items, pagination } = await stayService.listStays({ ...req.query, workspaceId: req.actor.workspaceId });
  sendList(res, items, pagination);
});

export const getStay = asyncHandler(async (req, res) => {
  const data = await stayService.getStayById(req.params.id, req.actor.workspaceId);
  sendSuccess(res, data);
});

export const updateStay = asyncHandler(async (req, res) => {
  const data = await stayService.updateStay(req.params.id, req.body, req.actor.workspaceId);
  sendSuccess(res, data);
});

export const deleteStay = asyncHandler(async (req, res) => {
  const data = await stayService.deleteStay(req.params.id, req.actor.workspaceId);
  sendSuccess(res, data);
});
