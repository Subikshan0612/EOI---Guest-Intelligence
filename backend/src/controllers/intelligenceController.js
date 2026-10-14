import { asyncHandler } from "../utils/asyncHandler.js";
import { sendList, sendSuccess } from "../utils/response.js";
import * as intelligenceService from "../services/intelligenceService.js";
import { analyzeSignal as analyzeSignalService } from "../services/intelligenceAnalysisService.js";
import { getAnalysisStatus as getAnalysisStatusService } from "../services/analysisAttemptService.js";
import { getAuthorizedKnowledgeLevel } from "../middleware/knowledgeAccess.js";

export const listIntelligence = asyncHandler(async (req, res) => {
  // The membership-verified workspace overrides whatever the query named.
  const query = { ...req.query, workspaceId: req.actor.workspaceId };
  const { items, pagination } = await intelligenceService.listIntelligence(query, getAuthorizedKnowledgeLevel(req));
  sendList(res, items, pagination);
});

export const getIntelligence = asyncHandler(async (req, res) => {
  const data = await intelligenceService.getIntelligenceById(
    req.params.id,
    req.actor.workspaceId,
    getAuthorizedKnowledgeLevel(req),
  );
  sendSuccess(res, data);
});

/**
 * Intelligence V1 - POST /api/intelligence/analyze/:signalId?workspaceId=...
 * The knowledge level comes only from the trusted server-side resolver; no
 * request field can raise it. 201 when a new analysis was created, 200 when
 * the existing one for this Signal and level is returned.
 */
export const analyzeSignal = asyncHandler(async (req, res) => {
  const result = await analyzeSignalService(req.params.signalId, req.actor.workspaceId, {
    authorizedLevel: getAuthorizedKnowledgeLevel(req),
    requestId: req.requestId, // Phase 36: correlation only (structured events); never an input to any decision
  });
  // Workstream 5A: the analysis is still running when this request's response window ends. 202 with the attempt state (never an error, never a recommendation):
  // the attempt carries on in this process and the client reads its state from GET /api/intelligence/analysis-status/:signalId.
  if (result.inProgress) return sendSuccess(res, result.attempt, 202);
  const { record, created } = result;
  // Phase 24: the SAME public representation as GET /api/intelligence/:id (toIntelligenceView), never the stored record.
  sendSuccess(res, intelligenceService.toIntelligenceView(record), created ? 201 : 200);
});

/**
 * GET /api/intelligence/analysis-status/:signalId - the state of the analysis of one Signal (not_started | in_progress | succeeded | failed) for the caller's
 * verified workspace and knowledge level. Read-only: it starts nothing and returns no analysis content, only the state (see analysisAttemptService.getAnalysisStatus).
 */
export const getAnalysisStatus = asyncHandler(async (req, res) => {
  const data = await getAnalysisStatusService(req.params.signalId, req.actor.workspaceId, getAuthorizedKnowledgeLevel(req));
  sendSuccess(res, data);
});
