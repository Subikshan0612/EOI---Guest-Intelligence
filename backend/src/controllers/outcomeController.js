import { asyncHandler } from "../utils/asyncHandler.js";
import { sendList, sendSuccess } from "../utils/response.js";
import * as outcomeService from "../services/outcomeService.js";

export const createOutcome = asyncHandler(async (req, res) => {
  const data = await outcomeService.createOutcome(req.body);
  sendSuccess(res, data, 201);
});

export const listOutcomes = asyncHandler(async (req, res) => {
  const { items, pagination } = await outcomeService.listOutcomes(req.query);
  sendList(res, items, pagination);
});

export const getOutcome = asyncHandler(async (req, res) => {
  const data = await outcomeService.getOutcomeById(req.params.id, req.query.workspaceId);
  sendSuccess(res, data);
});

export const updateOutcome = asyncHandler(async (req, res) => {
  const data = await outcomeService.updateOutcome(
    req.params.id,
    req.body,
    req.query.workspaceId,
  );
  sendSuccess(res, data);
});
