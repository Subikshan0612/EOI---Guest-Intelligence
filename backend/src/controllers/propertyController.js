import { asyncHandler } from "../utils/asyncHandler.js";
import { sendList, sendSuccess } from "../utils/response.js";
import * as propertyService from "../services/propertyService.js";

export const createProperty = asyncHandler(async (req, res) => {
  const data = await propertyService.createProperty(req.body);
  sendSuccess(res, data, 201);
});

export const listProperties = asyncHandler(async (req, res) => {
  const { items, pagination } = await propertyService.listProperties(req.query);
  sendList(res, items, pagination);
});

export const getProperty = asyncHandler(async (req, res) => {
  const data = await propertyService.getPropertyById(req.params.id);
  sendSuccess(res, data);
});

export const updateProperty = asyncHandler(async (req, res) => {
  const data = await propertyService.updateProperty(req.params.id, req.body);
  sendSuccess(res, data);
});

export const deleteProperty = asyncHandler(async (req, res) => {
  const data = await propertyService.deleteProperty(req.params.id);
  sendSuccess(res, data);
});
