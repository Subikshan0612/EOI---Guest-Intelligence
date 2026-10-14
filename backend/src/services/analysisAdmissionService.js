import { randomUUID } from "node:crypto";
import { AnalysisAdmission } from "../models/AnalysisAdmission.js";
import { AppError } from "../utils/AppError.js";
import { requireObjectId } from "../utils/objectId.js";
import { boundedIdentity } from "./ai/admissionMetadata.js";
import { classifyFailure } from "./ai/analysisFailureTaxonomy.js";
import { logEvent } from "../utils/logEvent.js";

/**
 * Durable audit of analysis admission decisions (Phase 35). See models/AnalysisAdmission.js for exactly what is (and is not) kept.
 *
 *   buildAdmissionDocument   PURE: turns what Node already knows about one attempt into the stored fields.
 *   recordAnalysisAdmission  BEST-EFFORT write. An audit-write failure is logged (class only) and NEVER changes the analysis outcome:
 *                            a paid, validated analysis is not discarded, and a rejection is not turned into a different error,
 *                            because the audit store is unavailable. The consequence is stated, not hidden: such an attempt has
 *                            no audit row (the console line is then the only trace).
 *   listAnalysisAdmissions   workspace-scoped read. `workspaceId` is REQUIRED and always part of the filter.
 *
 * There is no HTTP route for these records yet: exposing them needs a permission decision (who may see admission metadata) that is
 * outside this phase. They are read through this service only.
 */

export const newAttemptId = () => randomUUID();

const UUID_36 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RULE_CODE = /^[A-Z][A-Z_]{2,47}$/;
const asRule = (value) => (typeof value === "string" && RULE_CODE.test(value) ? value : undefined);
const CONFIDENCE = new Set(["low", "medium", "high"]);
const asConfidence = (value) => (typeof value === "string" && CONFIDENCE.has(value) ? value : undefined);
const asCode = (value) => (typeof value === "string" && /^[A-Z0-9_]{1,64}$/.test(value) ? value : undefined);

/**
 * @param {object} input
 * @param {string} input.workspaceId  the membership-verified workspace
 * @param {string} input.signalId
 * @param {string} input.attemptId
 * @param {string} [input.level]
 * @param {number} [input.latencyMs]
 * @param {boolean} [input.learningUsed]
 * @param {object} [input.accepted]   { intelligenceId, analysis } - the validated analysis (carries `admission`) of an ACCEPTED attempt
 * @param {Error}  [input.error]      the thrown error of a REJECTED attempt (may carry `admissionTrace`)
 * @param {string} [input.phase]      where an error without a trace happened: "retrieval" | "provider" | "persistence"
 * @param {object} [input.admission]  the admission metadata of an attempt that was admitted but then failed to persist
 */
export function buildAdmissionDocument({ workspaceId, signalId, attemptId, requestId, level, latencyMs, learningUsed = false, accepted, error, phase, admission }) {
  const base = {
    workspaceId: requireObjectId(workspaceId, "workspaceId"),
    signalId: requireObjectId(signalId, "signalId"),
    attemptId,
    requestId: typeof requestId === "string" && UUID_36.test(requestId) ? requestId.toLowerCase() : undefined,
    analysisLevel: level,
    learningUsed: Boolean(learningUsed),
    latencyMs: Number.isFinite(latencyMs) && latencyMs >= 0 ? Math.round(latencyMs) : undefined,
  };

  if (accepted) {
    const info = accepted.analysis.admission;
    return {
      ...base,
      intelligenceId: accepted.intelligenceId,
      outcome: "accepted",
      decidedAt: "admitted",
      ...fromAdmission(info),
      provider: boundedIdentity(accepted.analysis.provenance?.provider),
      model: boundedIdentity(accepted.analysis.provenance?.model),
      finalConfidence: asConfidence(accepted.analysis.confidence),
    };
  }

  const trace = error?.admissionTrace;
  const decidedAt = trace?.decidedAt ?? phase ?? "provider";
  const stages = trace ? { ...trace.stages } : { provider: decidedAt === "provider" ? "failed" : decidedAt === "retrieval" ? "not_run" : "passed" };
  return {
    ...base,
    outcome: "rejected",
    decidedAt,
    reasonCode: asCode(error?.details?.code) ?? "INTERNAL_ERROR",
    ruleCode: asRule(error?.details?.rule),
    failureClass: classifyFailure(error),
    httpStatus: Number.isInteger(error?.statusCode) ? error.statusCode : undefined,
    stages,
    // What the AI service reported about itself, bounded; absent when the response never got far enough to carry it.
    provider: trace?.identity?.provider,
    model: trace?.identity?.model,
    modelConfidence: asConfidence(trace?.modelConfidence),
    claimTypeCounts: trace?.claimTypeCounts,
    ...(admission ? fromAdmission(admission) : {}),
  };
}

function fromAdmission(info) {
  return {
    stages: info.stages,
    modelConfidence: asConfidence(info.modelConfidence),
    confidenceCeiling: asConfidence(info.confidenceCeiling),
    confidenceCapped: typeof info.confidenceCapped === "boolean" ? info.confidenceCapped : undefined,
    ceilingReasons: Array.isArray(info.ceilingReasons) && info.ceilingReasons.length ? info.ceilingReasons.filter((r) => typeof r === "string").slice(0, 8) : undefined,
    safetyState: boundedIdentity(info.safetyState, 32),
    safetyRules: Array.isArray(info.safetyRules) && info.safetyRules.length ? info.safetyRules.filter((r) => typeof r === "string").slice(0, 8) : undefined,
    claimTypeCounts: info.claimTypeCounts,
    citedClassCounts: info.citedClassCounts,
    evidenceCounts: info.evidenceCounts,
    evidenceSetId: info.evidenceSetId,
    knowledgeRetrieved: info.knowledgeRetrieved,
    knowledgeRelevant: info.knowledgeRelevant,
    relevanceFloor: info.relevanceFloor,
  };
}

// Audit persistence policy (Phase 35 decision): BEST-EFFORT, not part of the analysis write and not fail-closed.
//   - The analysis (Intelligence) is a single-document write; this codebase uses no multi-document transactions, so "atomic with the
//     analysis" would need a transaction redesign that is out of scope. It is therefore a SECOND, independent write made AFTER the
//     analysis outcome is already decided.
//   - FAIL-CLOSED was rejected on purpose: it would make the audit store an availability dependency of the analysis path, and it
//     would answer "analysis failed" for an analysis that was validated AND stored. The caller would then retry and, for a failure
//     before the idempotency record exists, pay for the model call again.
//   - It is NOT silent: every failure is logged (error class only - never the document) and counted in-process. A failed write means
//     that attempt has no audit row; nothing claims otherwise, and the count lets a health check or test see it happened.
//   - recordAnalysisAdmission never throws, so a failed audit write can neither change the outcome of an accepted analysis nor
//     turn it into a spurious "rejected" audit row via analyzeSignal's catch block.
// LIMIT: the counter is process-local and resets on restart.
let auditWriteFailures = 0;
export const getAdmissionAuditFailureCount = () => auditWriteFailures;
export const resetAdmissionAuditFailureCount = () => { auditWriteFailures = 0; };

/**
 * Phase 36: the structured event for one attempt, built from the stored FIELDS only (never prompts, outputs, Signal text, ids of
 * users/workspaces/signals). It is emitted whether or not the audit write succeeds, so the log stream stays complete during an audit outage.
 * `analysis.accepted` / `analysis.rejected` plus `decidedAt`, `reasonCode` and `failureClass` tell an operator which of: success, provider
 * failure, retrieval timeout, schema failure, evidence/provenance rejection, safety rejection it was.
 */
function emitAttemptEvent(doc, requestId) {
  logEvent(doc.outcome === "accepted" ? "analysis.accepted" : "analysis.rejected", {
    requestId, attemptId: doc.attemptId, outcome: doc.outcome, decidedAt: doc.decidedAt, reasonCode: doc.reasonCode, ruleCode: doc.ruleCode, failureClass: doc.failureClass,
    httpStatus: doc.httpStatus, provider: doc.provider, model: doc.model, latencyMs: doc.latencyMs, modelConfidence: doc.modelConfidence,
    confidenceCeiling: doc.confidenceCeiling, finalConfidence: doc.finalConfidence, confidenceCapped: doc.confidenceCapped,
    learningUsed: doc.learningUsed, evidenceSetId: doc.evidenceSetId,
  });
}

/** Best-effort. Resolves to the stored plain record, or null when the audit write failed (logged by class only, counted, and evented). */
export async function recordAnalysisAdmission(input) {
  try {
    const doc = buildAdmissionDocument(input);
    emitAttemptEvent(doc, input.requestId);
    const stored = await AnalysisAdmission.create(doc);
    return toAdmissionView(stored.toObject());
  } catch (error) {
    auditWriteFailures += 1;
    console.error("[KOI API] Analysis admission audit write failed:", error?.name || "Error");
    logEvent("analysis.audit_write_failed", { requestId: input?.requestId, attemptId: input?.attemptId, errorClass: error?.name || "Error" });
    return null;
  }
}

const mapToObject = (value) => (value instanceof Map ? Object.fromEntries(value) : value ?? undefined);

/** The only shape these records are read in: every stored field, ids as strings, maps as plain objects. */
export function toAdmissionView(doc) {
  if (!doc) return null;
  const out = {
    _id: String(doc._id),
    workspaceId: String(doc.workspaceId),
    signalId: String(doc.signalId),
    attemptId: doc.attemptId,
    requestId: doc.requestId ?? null,
    intelligenceId: doc.intelligenceId ? String(doc.intelligenceId) : null,
    analysisLevel: doc.analysisLevel ?? null,
    outcome: doc.outcome,
    decidedAt: doc.decidedAt,
    reasonCode: doc.reasonCode ?? null,
    ruleCode: doc.ruleCode ?? null,
    failureClass: doc.failureClass ?? null,
    httpStatus: doc.httpStatus ?? null,
    stages: doc.stages ? { ...doc.stages } : {},
    provider: doc.provider ?? null,
    model: doc.model ?? null,
    evidenceSetId: doc.evidenceSetId ?? null,
    evidenceCounts: mapToObject(doc.evidenceCounts) ?? null,
    claimTypeCounts: mapToObject(doc.claimTypeCounts) ?? null,
    citedClassCounts: mapToObject(doc.citedClassCounts) ?? null,
    knowledgeRetrieved: doc.knowledgeRetrieved ?? null,
    knowledgeRelevant: doc.knowledgeRelevant ?? null,
    relevanceFloor: doc.relevanceFloor ?? null,
    modelConfidence: doc.modelConfidence ?? null,
    confidenceCeiling: doc.confidenceCeiling ?? null,
    finalConfidence: doc.finalConfidence ?? null,
    confidenceCapped: doc.confidenceCapped ?? null,
    ceilingReasons: doc.ceilingReasons ?? [],
    safetyState: doc.safetyState ?? null,
    safetyRules: doc.safetyRules ?? [],
    learningUsed: Boolean(doc.learningUsed),
    latencyMs: doc.latencyMs ?? null,
    createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : null,
  };
  return out;
}

const MAX_LIMIT = 100;

/** Newest first. ALWAYS filtered by the workspace; a missing/invalid workspace is a 400, never "all workspaces". */
export async function listAnalysisAdmissions(workspaceId, { signalId, outcome, limit = 25 } = {}) {
  const scope = requireObjectId(workspaceId, "workspaceId");
  const filter = { workspaceId: scope };
  if (signalId !== undefined) filter.signalId = requireObjectId(signalId, "signalId");
  if (outcome !== undefined) {
    if (outcome !== "accepted" && outcome !== "rejected") throw new AppError("outcome must be accepted or rejected", 400);
    filter.outcome = outcome;
  }
  const size = Math.min(MAX_LIMIT, Math.max(1, Number.isInteger(limit) ? limit : 25));
  const rows = await AnalysisAdmission.find(filter).sort({ createdAt: -1, _id: -1 }).limit(size).lean();
  return rows.map(toAdmissionView);
}

/** Phase 37: the record of the attempt a request started, by the X-Request-Id the client reported - within the workspace only (another tenant's id is a 404). */
export async function getAnalysisAdmissionByRequestId(workspaceId, requestId) {
  const scope = requireObjectId(workspaceId, "workspaceId");
  if (typeof requestId !== "string" || !UUID_36.test(requestId)) throw new AppError("requestId is invalid", 400);
  const row = await AnalysisAdmission.findOne({ workspaceId: scope, requestId: requestId.toLowerCase() }).sort({ createdAt: -1 }).lean();
  if (!row) throw new AppError("Analysis admission record not found", 404);
  return toAdmissionView(row);
}

/** One record by its attempt id, within the workspace. Another workspace's attempt id is a 404, indistinguishable from a missing one. */
export async function getAnalysisAdmissionByAttempt(workspaceId, attemptId) {
  const scope = requireObjectId(workspaceId, "workspaceId");
  if (typeof attemptId !== "string" || !/^[0-9a-f-]{36}$/.test(attemptId)) throw new AppError("attemptId is invalid", 400);
  const row = await AnalysisAdmission.findOne({ workspaceId: scope, attemptId }).lean();
  if (!row) throw new AppError("Analysis admission record not found", 404);
  return toAdmissionView(row);
}
