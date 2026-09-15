import { asyncHandler } from "../utils/asyncHandler.js";
import { sendSuccess } from "../utils/response.js";
import * as learningService from "../services/learningService.js";

export const getLearningReport = asyncHandler(async (req, res) => {
  const data = await learningService.getLearningReport(req.query);
  sendSuccess(res, data);
});
