import { asyncHandler } from "../utils/asyncHandler.js";
import { sendList, sendSuccess } from "../utils/response.js";
import * as signalService from "../services/signalService.js";
import { getSignalContextWithRecurrence } from "../services/signalRecurrenceService.js";
import { actorHasPermission } from "../auth/authorize.js";
import { retrieveKnowledgeForSignal } from "../services/knowledgeRetrievalService.js";
import { getAuthorizedKnowledgeLevel } from "../middleware/knowledgeAccess.js";

export const createSignal = asyncHandler(async (req, res) => {
  const data = await signalService.createSignal({ ...req.body, workspaceId: req.actor.workspaceId });
  sendSuccess(res, data, 201);
});

export const listSignals = asyncHandler(async (req, res) => {
  const { items, pagination } = await signalService.listSignals({ ...req.query, workspaceId: req.actor.workspaceId });
  sendList(res, items, pagination);
});

export const getSignal = asyncHandler(async (req, res) => {
  const data = await signalService.getSignalById(req.params.id, req.actor.workspaceId);
  sendSuccess(res, data);
});

export const updateSignal = asyncHandler(async (req, res) => {
  const data = await signalService.updateSignal(req.params.id, req.body, req.actor.workspaceId);
  sendSuccess(res, data);
});

export const deleteSignal = asyncHandler(async (req, res) => {
  const data = await signalService.deleteSignal(req.params.id, req.actor.workspaceId);
  sendSuccess(res, data);
});

export const getSignalContext = asyncHandler(async (req, res) => {
  // The context plus the server-derived recurrence note (signalRecurrenceService.js); earlier Outcomes only for a caller who may already read Outcomes.
  const data = await getSignalContextWithRecurrence(req.params.id, req.actor.workspaceId, {
    includeOutcomes: actorHasPermission(req.actor, "decision:review"),
    authorizedLevel: getAuthorizedKnowledgeLevel(req),
  });
  sendSuccess(res, data);
});

/**
 * Phase 6G — retrieval only, development/validation endpoint. Not wired
 * into intelligence generation; that integration is Phase 6H's job.
 */
export const getSignalKnowledgeRetrieval = asyncHandler(async (req, res) => {
  const data = await retrieveKnowledgeForSignal(
    req.params.id,
    req.actor.workspaceId,
    getAuthorizedKnowledgeLevel(req),
  );
  sendSuccess(res, data);
});
