import { asyncHandler } from "../utils/asyncHandler.js";
import { sendSuccess } from "../utils/response.js";
import * as learningService from "../services/learningService.js";
import * as patternService from "../services/patternService.js";

export const getLearningReport = asyncHandler(async (req, res) => {
  const data = await learningService.getLearningReport(req.query);
  sendSuccess(res, data);
});

export const getLearningPatterns = asyncHandler(async (req, res) => {
  const data = await patternService.getRecurringSignalPatterns(req.query);
  sendSuccess(res, data);
});
