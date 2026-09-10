import { asyncHandler } from "../utils/asyncHandler.js";
import { sendList, sendSuccess } from "../utils/response.js";
import * as intelligenceService from "../services/intelligenceService.js";

export const createIntelligence = asyncHandler(async (req, res) => {
  const data = await intelligenceService.createIntelligence(req.body);
  sendSuccess(res, data, 201);
});

export const listIntelligence = asyncHandler(async (req, res) => {
  const { items, pagination } = await intelligenceService.listIntelligence(req.query);
  sendList(res, items, pagination);
});

export const getIntelligence = asyncHandler(async (req, res) => {
  const data = await intelligenceService.getIntelligenceById(req.params.id);
  sendSuccess(res, data);
});
