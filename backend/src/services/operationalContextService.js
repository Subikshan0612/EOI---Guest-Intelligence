import { Decision, DECISION_VERSION } from "../models/Decision.js";
import { ANALYSIS_VERSION, Intelligence } from "../models/Intelligence.js";
import { requireObjectId } from "../utils/objectId.js";
import { buildAnalysisContext } from "./analysisContextService.js";
import { intelligenceVisibleTo, visibleIntelligenceMatch } from "./decisionService.js";
import { relevantHistory } from "./historyRelevance.js";
import { detectReportConflicts } from "./reportConflicts.js";
import { normalizeCallerLevel } from "./knowledge/visibility.js";
import {
  CONTEXT_SHAPE,
  HISTORICAL_DECISION_SHAPE,
  HISTORICAL_INTELLIGENCE_SHAPE,
  OPERATIONAL_CONTEXT_CONTRACT_VERSION,
  OPERATIONAL_CONTEXT_LIMITS as LIMITS,
  project,
  validateOperationalPayload,
} from "./operationalContextContract.js";

/**
 * Operational context builder (Phase 27).
 *
 * The one place that decides which operational data may be shown to the language model for a Signal
 * analysis. It runs entirely inside the backend, BEFORE the AI-service request: the model receives the
 * finished, bounded, validated object and nothing else - no database handle, query, filter or tool.
 *
 * Inputs are exactly a Signal id, the workspace and the caller's authorized level, all supplied by the
 * server (`req.actor.workspaceId`, the server-side level resolver). There is deliberately no parameter
 * that selects fields, related ids, filters or collections, and no generic "find anything" function.
 *
 * Selection (deterministic, explainable - see backend/docs/OPERATIONAL_CONTEXT_PHASE27.md; Phase 52: related Signals are also filtered to the same kind of problem, historyRelevance.js):
 *   - Signal, Guest, Stay, Property, Unit, related Signals: the existing workspace-scoped assembly
 *     (signalContextService.js) + the Phase 24 guest allowlist, then this module's contract allowlist.
 *   - historicalIntelligence: prior V1 analyses of OTHER Signals that share this Signal's Stay, Guest or
 *     Unit (not merely its Property), visible to the caller's level, newest first, at most 3.
 *   - historicalDecisions: human-REVIEWED (approved / rejected) V1 Decisions for those same Signals, whose
 *     LIVE parent Intelligence is visible to the caller's level, newest first, at most 3.
 * Every query filters `workspaceId` itself; nothing is trusted to be scoped because "the id came from
 * a scoped record". This module performs no write of any kind.
 *
 * @returns {{ context: object, operationalHistory: object, retrievalContext: object }}
 *   `context` and `operationalHistory` are what the model may see. `retrievalContext` is the Phase 24
 *   context the (unchanged) knowledge retrieval consumes.
 */
export async function buildOperationalContext(signalId, workspaceId, { authorizedLevel } = {}) {
  const scope = requireObjectId(workspaceId, "workspaceId");
  const id = requireObjectId(signalId, "signalId");
  const level = normalizeCallerLevel(authorizedLevel);

  // assembleSignalContext 404s on a missing / other-workspace Signal and scopes every relation itself.
  const retrievalContext = await buildAnalysisContext(id, scope);
  // Relationship alone (same stay / guest / unit / property) is not relevance: only earlier reports about the same KIND of problem may inform this one, so an unrelated earlier
  // incident in the same room (a gas smell) cannot become evidence for, or set the urgency of, a different report (an AC fault). Removal only - nothing is deleted or added,
  // the safety policy never reads history, and tenant scoping already happened above. The historical Intelligence / Decisions below are selected from this filtered list.
  retrievalContext.history = { ...retrievalContext.history, signals: relevantHistory(retrievalContext.signal, retrievalContext.history?.signals) };
  const context = project(retrievalContext, CONTEXT_SHAPE);
  // Phase 52: a conflict between the operator's words and a current record becomes an explicit, server-derived fact (the record stays authoritative; nothing is resolved here).
  const reportChecks = detectReportConflicts(context);
  if (reportChecks.length > 0) context.reportChecks = reportChecks;

  const related = relatedSignalsForHistory(context);
  const operationalHistory = {
    contractVersion: OPERATIONAL_CONTEXT_CONTRACT_VERSION,
    intelligence: await selectHistoricalIntelligence(scope, level, related),
    decisions: await selectHistoricalDecisions(scope, level, related),
  };

  // Fail closed: anything outside the contract, or over the size ceiling, means no AI request at all.
  validateOperationalPayload({ context, operationalHistory });
  return { context, operationalHistory, retrievalContext };
}

/**
 * Signals whose recorded Intelligence / Decisions may inform this analysis: the related Signals matched by
 * the SAME stay, guest or unit. A Signal matched only because it is at the same property is excluded - a
 * whole property's history is not "related" to one room's problem. The current Signal is never included:
 * its own earlier analyses (at another level) would anchor the new analysis on its own earlier output.
 * @returns {Map<string, string[]>} signalId -> matchedBy
 */
function relatedSignalsForHistory(context) {
  const related = new Map();
  for (const item of context.history.signals) {
    const specific = item.matchedBy.filter((key) => key === "stay" || key === "guest" || key === "unit");
    if (specific.length > 0 && item.id !== context.signal.id) related.set(item.id, specific);
  }
  return related;
}

const iso = (value) => (value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : undefined);

async function selectHistoricalIntelligence(workspaceId, level, related) {
  if (related.size === 0) return [];
  const ids = [...related.keys()];
  const docs = await Intelligence.find({
    workspaceId,
    analysisVersion: ANALYSIS_VERSION,
    signalIds: { $in: ids },
    analysis: { $exists: true },
    ...visibleIntelligenceMatch(level),
  })
    .sort({ createdAt: -1, _id: -1 })
    .limit(LIMITS.historicalIntelligence)
    .select("workspaceId signalIds analysis createdAt analysisLevel knowledgeVisibility")
    .lean();

  const items = [];
  for (const doc of docs) {
    // Belt and braces: the query is already scoped and visibility-filtered; re-check before use.
    if (String(doc.workspaceId) !== String(workspaceId) || !intelligenceVisibleTo(doc, level)) continue;
    const signalId = (doc.signalIds || []).map(String).find((candidate) => related.has(candidate));
    if (!signalId || !doc.analysis) continue;
    items.push(
      project(
        {
          kind: "prior_ai_analysis",
          signalId,
          matchedBy: related.get(signalId),
          recordedAt: iso(doc.createdAt),
          situation: doc.analysis.situation,
          recommendation: doc.analysis.recommendation,
          confidence: doc.analysis.confidence,
        },
        HISTORICAL_INTELLIGENCE_SHAPE,
      ),
    );
  }
  return items;
}

async function selectHistoricalDecisions(workspaceId, level, related) {
  if (related.size === 0) return [];
  const ids = [...related.keys()];
  const candidates = await Decision.find({
    workspaceId,
    decisionVersion: DECISION_VERSION,
    signalId: { $in: ids },
    status: { $in: ["approved", "rejected"] },
  })
    .sort({ updatedAt: -1, _id: -1 })
    .limit(LIMITS.decisionCandidateScan)
    .select("workspaceId intelligenceId signalId status priority description review updatedAt")
    .lean();
  if (candidates.length === 0) return [];

  // A Decision is only as visible as its LIVE parent Intelligence (decisionService.js): never the
  // Decision's own snapshot markers.
  const parents = await Intelligence.find({
    workspaceId,
    _id: { $in: candidates.map((decision) => decision.intelligenceId) },
    ...visibleIntelligenceMatch(level),
  })
    .select("workspaceId analysisLevel knowledgeVisibility")
    .lean();
  const visibleParents = new Set(
    parents
      .filter((parent) => String(parent.workspaceId) === String(workspaceId) && intelligenceVisibleTo(parent, level))
      .map((parent) => String(parent._id)),
  );

  const items = [];
  for (const decision of candidates) {
    if (items.length >= LIMITS.historicalDecisions) break;
    if (String(decision.workspaceId) !== String(workspaceId)) continue;
    if (!visibleParents.has(String(decision.intelligenceId))) continue;
    const signalId = String(decision.signalId);
    if (!related.has(signalId)) continue;
    items.push(
      project(
        {
          kind: "human_reviewed_decision",
          signalId,
          matchedBy: related.get(signalId),
          status: decision.status,
          priority: decision.priority,
          description: decision.description,
          reviewedAt: iso(decision.review?.reviewedAt),
        },
        HISTORICAL_DECISION_SHAPE,
      ),
    );
  }
  return items;
}
