import { asyncHandler } from "../utils/asyncHandler.js";
import { sendList, sendSuccess } from "../utils/response.js";
import * as signalService from "../services/signalService.js";
import { assembleSignalContext } from "../services/signalContextService.js";
import { generateSignalIntelligence as generateSignalIntelligenceService } from "../services/ai/intelligenceService.js";
import { retrieveKnowledgeForSignal } from "../services/knowledgeRetrievalService.js";

export const createSignal = asyncHandler(async (req, res) => {
  const data = await signalService.createSignal(req.body);
  sendSuccess(res, data, 201);
});

export const listSignals = asyncHandler(async (req, res) => {
  const { items, pagination } = await signalService.listSignals(req.query);
  sendList(res, items, pagination);
});

export const getSignal = asyncHandler(async (req, res) => {
  const data = await signalService.getSignalById(req.params.id, req.query.workspaceId);
  sendSuccess(res, data);
});

export const updateSignal = asyncHandler(async (req, res) => {
  const data = await signalService.updateSignal(req.params.id, req.body, req.query.workspaceId);
  sendSuccess(res, data);
});

export const deleteSignal = asyncHandler(async (req, res) => {
  const data = await signalService.deleteSignal(req.params.id, req.query.workspaceId);
  sendSuccess(res, data);
});

export const getSignalContext = asyncHandler(async (req, res) => {
  const data = await assembleSignalContext(req.params.id, req.query.workspaceId);
  sendSuccess(res, data);
});

export const generateSignalIntelligence = asyncHandler(async (req, res) => {
  const data = await generateSignalIntelligenceService(req.params.id, req.query.workspaceId, {
    testScenario: req.query.__testScenario,
  });
  sendSuccess(res, data);
});

/**
 * Phase 6G — retrieval only, development/validation endpoint. Not wired
 * into intelligence generation; that integration is Phase 6H's job.
 */
export const getSignalKnowledgeRetrieval = asyncHandler(async (req, res) => {
  const data = await retrieveKnowledgeForSignal(req.params.id, req.query.workspaceId);
  sendSuccess(res, data);
});
