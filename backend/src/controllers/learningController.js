import { asyncHandler } from "../utils/asyncHandler.js";
import { sendSuccess } from "../utils/response.js";
import * as learningService from "../services/learningService.js";
import * as patternService from "../services/patternService.js";
import * as outcomeLearningService from "../services/outcomeLearningService.js";

export const getLearningReport = asyncHandler(async (req, res) => {
  const data = await learningService.getLearningReport({ ...req.query, workspaceId: req.actor.workspaceId });
  sendSuccess(res, data);
});

export const getLearningPatterns = asyncHandler(async (req, res) => {
  const data = await patternService.getRecurringSignalPatterns({ ...req.query, workspaceId: req.actor.workspaceId });
  sendSuccess(res, data);
});

/** Phase 31 - Outcome-derived action-type patterns. Read-only; see outcomeLearningService.js. */
export const getOutcomeLearningPatterns = asyncHandler(async (req, res) => {
  const data = await outcomeLearningService.getOutcomeLearningPatterns({ ...req.query, workspaceId: req.actor.workspaceId });
  sendSuccess(res, data);
});
