import { asyncHandler } from "../utils/asyncHandler.js";
import { sendList, sendSuccess } from "../utils/response.js";
import * as decisionService from "../services/decisionService.js";

export const createDecision = asyncHandler(async (req, res) => {
  const data = await decisionService.createDecision(req.body);
  sendSuccess(res, data, 201);
});

export const listDecisions = asyncHandler(async (req, res) => {
  const { items, pagination } = await decisionService.listDecisions(req.query);
  sendList(res, items, pagination);
});

export const getDecision = asyncHandler(async (req, res) => {
  const data = await decisionService.getDecisionById(req.params.id, req.query.workspaceId);
  sendSuccess(res, data);
});

export const updateDecision = asyncHandler(async (req, res) => {
  const data = await decisionService.updateDecision(
    req.params.id,
    req.body,
    req.query.workspaceId,
  );
  sendSuccess(res, data);
});
