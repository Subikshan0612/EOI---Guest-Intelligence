import { asyncHandler } from "../utils/asyncHandler.js";
import { sendList, sendSuccess } from "../utils/response.js";
import * as propertyService from "../services/propertyService.js";

export const createProperty = asyncHandler(async (req, res) => {
  const data = await propertyService.createProperty({ ...req.body, workspaceId: req.actor.workspaceId });
  sendSuccess(res, data, 201);
});

export const listProperties = asyncHandler(async (req, res) => {
  const { items, pagination } = await propertyService.listProperties({ ...req.query, workspaceId: req.actor.workspaceId });
  sendList(res, items, pagination);
});

export const getProperty = asyncHandler(async (req, res) => {
  const data = await propertyService.getPropertyById(req.params.id, req.actor.workspaceId);
  sendSuccess(res, data);
});

export const updateProperty = asyncHandler(async (req, res) => {
  const data = await propertyService.updateProperty(
    req.params.id,
    req.body,
    req.actor.workspaceId,
  );
  sendSuccess(res, data);
});

export const deleteProperty = asyncHandler(async (req, res) => {
  const data = await propertyService.deleteProperty(req.params.id, req.actor.workspaceId);
  sendSuccess(res, data);
});
