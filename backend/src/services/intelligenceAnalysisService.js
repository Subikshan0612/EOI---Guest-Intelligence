import { Signal } from "../models/Signal.js";
import { DEFAULT_RETRIEVAL_MIN_SIMILARITY, getAnalysisResponseWindowMs, getAnalysisTimeBudget, getLearningContextEnabled, getRetrievalMinSimilarity } from "../config/runtimeConfig.js";
import { assertApprovedProvenance, assertProviderRouteAllowed, isDeterministicTestProvenance } from "../config/providerPolicy.js";
import { AppError } from "../utils/AppError.js";
import { requireObjectId } from "../utils/objectId.js";
import { buildOperationalContext } from "./operationalContextService.js";
import { requestAnalysisFromAiService } from "./ai/aiServiceClient.js";
import { validateAnalysisResult } from "./ai/analysisSchema.js";
import { buildEvidenceReferenceIndex } from "./ai/evidenceReferenceIndex.js";
import { ADMISSION_STAGES } from "../models/AnalysisAdmission.js";
import { boundedIdentity, citedClassCounts, countBy, evidenceCounts, evidenceSetId, relevantKnowledgeCount } from "./ai/admissionMetadata.js";
import { validateClaims } from "./ai/claimValidator.js";
import { buildEvidenceEnvelope } from "./ai/evidenceEnvelope.js";
import { assertNoForeignIdentifiers } from "./ai/outputGuard.js";
import { applyConfidenceCeiling, deriveConfidenceCeiling } from "./ai/confidencePolicy.js";
import { assertProseConsistent } from "./ai/proseConsistency.js";
import { SAFETY_REVIEW_REQUIRED, deriveSafetyPolicy, enforceSafetyPolicy } from "./ai/safetyPolicy.js";
import { PYTHON_ROUTED_PROVIDERS, retrieveKnowledgeOrThrow } from "./ai/intelligenceService.js";
import { createAnalysisIntelligence, findAnalysisIntelligence } from "./intelligenceService.js";
import { buildLearningContext } from "./learningContextService.js";
import { maxVisibility, normalizeCallerLevel } from "./knowledge/visibility.js";
import { newAttemptId, recordAnalysisAdmission } from "./analysisAdmissionService.js";
import { claimAttempt, markAttemptFailed, markAttemptInterrupted, markAttemptSucceeded, toAttemptView } from "./analysisAttemptService.js";
import { logEvent } from "../utils/logEvent.js";
import { findInWorkspaceOr404 } from "./queryHelpers.js";

/**
 * Everything that must be true of the AI service's response BEFORE it may be persisted (pure: no database, no I/O):
 *   1. strict contract validation (analysisSchema.js), including provenance of chunk ids (Phase 28: every
 *      evidenceRefs/contradiction reference must be one this request's context/operationalHistory/knowledge supplied -
 *      never a fresh database lookup, never anything the model itself supplied);
 *   2. (Phase 34A-B) the reported provider/model identity must be exactly the approved one (config/providerPolicy.js).
 *      A non-empty string is not enough; a mismatch rejects the whole response.
 * @returns the validated, normalized analysis. Throws AppError (502) on any violation; the caller must not persist then.
 */
export function validateAndVerifyAnalysis(raw, { context, operationalHistory, knowledge, learning, workspaceId }) {
  // Phase 35: every stage is recorded as it runs so a REJECTION can say which stage decided it (see recordAnalysisAdmission).
  // The trace rides on the thrown error as a non-enumerable property: it is never serialised to a client and never read back as data.
  const trace = { stages: Object.fromEntries(ADMISSION_STAGES.map((stage) => [stage, "not_run"])), identity: undefined, modelConfidence: undefined, claimTypeCounts: undefined };
  let current = "schema";
  const passed = () => { trace.stages[current] = "passed"; };
  try {
    trace.stages.provider = "passed"; // a response exists: the provider call itself succeeded
    const referenceIndex = buildEvidenceReferenceIndex(context, operationalHistory, knowledge.map((item) => item.chunkId));
    const analysis = validateAnalysisResult(raw, new Set(knowledge.map((item) => item.chunkId)), referenceIndex);
    passed();
    trace.identity = { provider: boundedIdentity(analysis.provenance.provider), model: boundedIdentity(analysis.provenance.model) };
    trace.modelConfidence = analysis.confidence;
    trace.claimTypeCounts = countBy(analysis.claims, (claim) => claim?.claimType);
    current = "identity";
    assertApprovedProvenance(analysis.provenance);
    passed();

    // Phase 34C - ADMISSIBILITY. Node owns facts, provenance, trust, tenant boundaries and policy; the model only
    // interpreted. Everything below is deterministic and runs on Node's own data, never on anything the model supplied:
    //   1. the evidence envelope for THIS request (classes + references, bound to the verified workspace);
    //   2. every claim rests on sources its type may rest on (claimValidator.js);
    //   3. the server safety minimum derived from the CURRENT Signal is met (safetyPolicy.js);
    //   4. (Phase 34D) the recommendation PROSE does not explicitly contradict the structured fields it was validated by
    //      (proseConsistency.js - a secondary check; the structured fields stay authoritative);
    //   5. the prose names no identifier that was not supplied for this request (outputGuard.js);
    //   6. (Phase 34D) the confidence is capped at the server's evidence-based ceiling (confidencePolicy.js): the model may be
    //      more conservative than the ceiling, never less. A cap lowers the stored value; it does not reject the analysis.
    //      (Phase 35) only retrieved chunks whose own similarity metadata meets the relevance floor count as grounding.
    // Any failure in 1-5 throws and the caller never reaches persistence. The one relaxation: the deterministic TEST provider's
    // output in development/test may omit claims/urgency/action type (it does no reasoning); whatever it states is checked.
    const strict = !isDeterministicTestProvenance(analysis.provenance);
    const envelope = buildEvidenceEnvelope({ workspaceId, context, operationalHistory, knowledge, learning });
    current = "claims";
    validateClaims(analysis.claims, envelope, { workspaceId, strict });
    passed();
    const policy = deriveSafetyPolicy(context, { includeReviewRequired: true });
    current = "safety";
    enforceSafetyPolicy(policy, analysis, { strict });
    passed();
    current = "prose";
    // Phase 52: with no relevant business guidance grounded (and a normal, non-safety case, where the canonical safety policy - not general wording - governs the response), the
    // recommendation must not present general reasoning as the business's own protocol or policy. Real providers only (the deterministic test provider does no reasoning).
    const relevanceFloorForProse = Math.max(DEFAULT_RETRIEVAL_MIN_SIMILARITY, getRetrievalMinSimilarity());
    assertProseConsistent(policy, analysis, { enforceUngroundedPolicy: strict && (policy.state === "NORMAL" || policy.state === SAFETY_REVIEW_REQUIRED) && relevantKnowledgeCount(knowledge, relevanceFloorForProse) === 0 });
    passed();
    current = "identifier";
    assertNoForeignIdentifiers(analysis, envelope);
    passed();

    const relevanceFloor = Math.max(DEFAULT_RETRIEVAL_MIN_SIMILARITY, getRetrievalMinSimilarity());
    const ceiling = deriveConfidenceCeiling({ claims: analysis.claims, envelope, context, contradictions: analysis.contradictions, strict, knowledge, minSimilarity: relevanceFloor });
    const calibrated = applyConfidenceCeiling(analysis.confidence, ceiling);
    // `admission` is audit metadata for callers, tests and recordAnalysisAdmission; createAnalysisIntelligence stores only the
    // fields it names, so it is neither persisted inside Intelligence nor exposed. `confidence` is the FINAL value (never above the ceiling).
    return {
      ...analysis,
      confidence: calibrated.confidence,
      admission: {
        modelConfidence: calibrated.modelConfidence,
        confidenceCeiling: calibrated.ceiling,
        confidenceCapped: calibrated.capped,
        ceilingReasons: ceiling.reasons,
        safetyState: policy.state,
        safetyRules: [...policy.rules],
        stages: { ...trace.stages },
        identity: trace.identity,
        claimTypeCounts: trace.claimTypeCounts,
        citedClassCounts: citedClassCounts(analysis.claims, envelope),
        evidenceCounts: evidenceCounts(envelope),
        evidenceSetId: evidenceSetId(envelope, knowledge, workspaceId),
        knowledgeRetrieved: knowledge.length,
        knowledgeRelevant: relevantKnowledgeCount(knowledge, relevanceFloor),
        relevanceFloor,
      },
    };
  } catch (error) {
    if (error && typeof error === "object") {
      trace.stages[current] = "failed";
      Object.defineProperty(error, "admissionTrace", { value: { ...trace, decidedAt: current }, enumerable: false, configurable: true });
    }
    throw error;
  }
}

/**
 * Intelligence V1 - grounded analysis of one Signal. ANALYSIS AND
 * RECOMMENDATION ONLY: this flow reads operational data, reads authorized
 * knowledge, asks the AI service for a structured analysis, validates it, and
 * stores it. It performs no action, sends no message, and changes no
 * Signal/Guest/Stay/Property/Unit/knowledge record. The application - not the
 * model - owns persistence.
 *
 *   Signal
 *     -> operational context (operationalContextService.js: workspace-scoped, allowlisted, bounded, validated;
 *        guest contact details removed; bounded historical Intelligence / reviewed Decisions)
 *     -> knowledge retrieval (the EXISTING retrieval service; visibility, workspace and
 *        property scope are enforced in its MongoDB query, before scoring)
 *     -> (Phase 32, OFF by default) Learning context (learningContextService.js: Phase 31's read-only
 *        Outcome-derived aggregate, bounded/validated/never persisted) ONLY when
 *        KOI_LEARNING_CONTEXT_ENABLED=true - see backend/docs/LEARNING_INTELLIGENCE_PHASE32.md. Fail closed:
 *        if Learning cannot be safely built when the flag is on, this throws and NO AI call is made.
 *     -> AI service /v1/intelligence/analyze (its own LLM_PROVIDER decides the provider)
 *     -> strict validation (analysisSchema.js) incl. provenance ⊆ retrieved chunks AND (Phase 28)
 *        every evidenceRefs/contradiction reference ⊆ what THIS request's context/operationalHistory/
 *        knowledge actually supplied (evidenceReferenceIndex.js) - fail closed, whole response rejected
 *     -> persistence (intelligenceService.js createAnalysisIntelligence)
 *
 * `authorizedLevel` is supplied by the trusted server-side resolver
 * (middleware/knowledgeAccess.js), never by a request field. A missing/invalid
 * level fails closed to the lowest one.
 *
 * Idempotent: at most one V1 analysis per (workspace, Signal, level). Asking
 * again returns the stored one without any retrieval or model call.
 * @returns {{ record: object, created: boolean }}
 */
export async function analyzeSignal(signalId, workspaceId, options = {}) {
  // Workstream 5A - the HTTP response window is no longer the lifetime of the analysis. One ATTEMPT (the existing pipeline, started at most once) per (workspace, Signal, level) runs
  // to its own end whatever the HTTP request does; a request waits for it for at most the response window and, if the attempt is still running, answers { inProgress: true }
  // instead of treating the analysis as failed. Nothing is re-run and nothing is cancelled when a request stops waiting or disconnects.
  //
  // Phase 36 SINGLE-FLIGHT, in this process, is kept exactly as it was: without it two simultaneous first requests both miss the stored-analysis check and BOTH call the
  // model (the unique index would keep only one record, but the second call is paid for and wasted). Followers wait for the leader's attempt and receive its record with
  // created:false (or its failure - no second model call, no retry). The key contains the workspace and the level, so nothing is shared across tenants or authorization
  // levels. HONEST LIMIT: this map is process-local. The cross-process form is the durable attempt marker (analysisAttemptService.js: one in-progress attempt per key,
  // enforced by a partial unique index): a second instance finds the marker and starts no second model call; the unique (workspace, Signal, level) Intelligence index stays the final backstop.
  const scope = requireObjectId(workspaceId, "workspaceId");
  const id = requireObjectId(signalId, "signalId");
  const level = normalizeCallerLevel(options.authorizedLevel);
  const key = `${scope}:${id}:${level}`;
  let entry = IN_FLIGHT_ANALYSES.get(key);
  const leader = !entry;
  if (entry) {
    logEvent("analysis.coalesced", { requestId: options.requestId });
  } else {
    entry = { attemptId: undefined, view: undefined, promise: undefined };
    // runAttempt runs synchronously up to its first await, so the entry is registered before any other request for this key can look: no gap in which two leaders form.
    entry.promise = runAttempt(entry, id, scope, level, options);
    const current = entry;
    const release = () => { if (IN_FLIGHT_ANALYSES.get(key) === current) IN_FLIGHT_ANALYSES.delete(key); };
    IN_FLIGHT_ANALYSES.set(key, current);
    current.promise.then(release, release); // also marks the promise as handled: a failure after the response window ended is not an unhandled rejection
  }
  const settled = await settleWithinWindow(entry.promise, getAnalysisResponseWindowMs());
  if (settled.pending) return { inProgress: true, attempt: entry.view ?? toAttemptView(undefined, { status: "in_progress" }) };
  if (settled.error) throw settled.error;
  const outcome = settled.value;
  if (outcome.inProgress) return outcome;
  return leader ? outcome : { record: outcome.record, created: false };
}

const IN_FLIGHT_ANALYSES = new Map();

/** Resolves with { value } or { error } when the attempt settles within `windowMs`, otherwise with { pending: true } (the attempt itself is left running). */
function settleWithinWindow(promise, windowMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ pending: true }), windowMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve({ value }); },
      (error) => { clearTimeout(timer); resolve({ error }); },
    );
  });
}

/**
 * The lifecycle of ONE attempt, wrapped around the unchanged pipeline (runAnalysis): the checks that must happen before anything is recorded (provider route, the Signal in
 * THIS workspace -> 404 otherwise, an already stored analysis -> returned with no model call), then claim the durable in-progress marker, run the pipeline, and record how it
 * ended. The marker is written/updated only AFTER the outcome of the pipeline is decided, and a marker problem never changes that outcome (best-effort, like the audit row).
 * Resolves { record, created } for a finished attempt, or { inProgress, attempt } when another process already owns an in-flight attempt for this key (no provider call is made).
 */
async function runAttempt(entry, id, scope, level, { requestId } = {}) {
  const provider = (process.env.LLM_PROVIDER || "").trim().toLowerCase();
  if (!PYTHON_ROUTED_PROVIDERS.has(provider)) {
    // Knowledge grounding exists only on the AI-service path; the Node-level
    // openai/test providers are not knowledge-grounded (see ai/intelligenceService.js).
    throw new AppError("Intelligence analysis requires the AI service (LLM_PROVIDER=gemini or test-python).", 503);
  }
  // Phase 34A-B: request-time provider policy. In production (and an unknown NODE_ENV) only the real `gemini` route may
  // produce Intelligence; the deterministic `test-python` route is development/test only. Server configuration only.
  assertProviderRouteAllowed(provider);

  // 404 for a missing or other-workspace Signal, before anything else happens (and before any marker could name it).
  const signal = await findInWorkspaceOr404(Signal, id, scope, "Signal");

  const existing = await findAnalysisIntelligence(scope, id, level);
  if (existing) return { record: existing, created: false };

  const attemptId = newAttemptId();
  const claim = await claimAttempt({ workspaceId: scope, signalId: id, level, attemptId, requestId });
  if (!claim.claimed) {
    // Another process holds a fresh in-progress attempt for this key (or one that has not yet gone stale). Start nothing: report its state.
    logEvent("analysis.attempt_elsewhere", { requestId });
    return { inProgress: true, attempt: toAttemptView(claim.attempt, { status: "in_progress" }) };
  }
  entry.attemptId = attemptId;
  entry.view = toAttemptView(claim.attempt);
  try {
    const result = await runAnalysis(id, scope, { authorizedLevel: level, requestId, attemptId, signal });
    await markAttemptSucceeded(attemptId, scope, result.record._id);
    return result;
  } catch (error) {
    await markAttemptFailed(attemptId, scope, error);
    throw error;
  }
}

/**
 * Graceful shutdown: the attempts THIS process owns cannot finish (the process is ending), so they are marked interrupted at once instead of staying "in progress" until
 * the staleness horizon. A crash or SIGKILL cannot run this; those markers expire by age (see analysisAttemptService.js). Best-effort; never throws.
 */
export async function abandonInFlightAnalyses() {
  const owned = [...IN_FLIGHT_ANALYSES.entries()].filter(([, entry]) => entry.attemptId);
  for (const [key, entry] of owned) await markAttemptInterrupted(entry.attemptId, key.split(":")[0]);
  return owned.length;
}

async function runAnalysis(id, scope, { authorizedLevel, requestId, attemptId, signal } = {}) {
  const requestStartedAt = Date.now();
  const level = normalizeCallerLevel(authorizedLevel);

  // The preflight (provider route, Signal in this workspace) already ran in runAttempt. The stored-analysis check below stays: another process may have finished the same
  // analysis between that check and the claim, and then no provider call must be made.
  const existing = await findAnalysisIntelligence(scope, id, level);
  if (existing) return { record: existing, created: false };

  // Phase 35: one audit row per attempt that gets past the idempotency check - accepted or rejected (recordAnalysisAdmission is
  // best-effort and metadata-only; see analysisAdmissionService.js). `attempt.phase` says where an error without an admission trace happened.
  const attempt = { id: attemptId ?? newAttemptId(), phase: "retrieval", admission: undefined, providerStartedAt: undefined, latencyMs: undefined, learningUsed: false };
  try {
    // Phase 27: all operational data is read HERE, in the backend, and validated against the operational
    // context contract. The retrieval input is the unchanged Phase 24 context; the model receives only the
    // bounded `context` + `operationalHistory`.
    const { context, operationalHistory, retrievalContext } = await buildOperationalContext(id, scope, { authorizedLevel: level });
    // Phase 35.1: the request deadline is enforced. Retrieval may use only what is left of it after the analysis call's full timeout is
    // reserved, measured from the START of this request (so the database reads above count against it); when that is spent, retrieval
    // fails closed and no model call is made. Retrieval + analysis therefore cannot exceed the deadline (see getAnalysisTimeBudget).
    const knowledge = await retrieveKnowledgeOrThrow(retrievalContext, scope, level, { deadlineAt: requestStartedAt + getAnalysisTimeBudget().retrievalBudgetMs });

    // Phase 32: the ONLY branch in this function gated by the Learning feature flag. It touches nothing else -
    // `context`, `knowledge`, `operationalHistory` and `level` above are built exactly as they always were,
    // flag on or off (see backend/scripts/validate-phase32-learning-integration.mjs's static "only learning
    // differs" check). `learning` stays `undefined` (never attached, not even as `null`) when the flag is off.
    const learning = getLearningContextEnabled() ? await buildLearningContext(scope) : undefined;
    attempt.learningUsed = learning !== undefined;

    attempt.phase = "provider";
    attempt.providerStartedAt = Date.now();
    const raw = await requestAnalysisFromAiService(context, knowledge, level, operationalHistory, learning, { requestId });
    attempt.latencyMs = Date.now() - attempt.providerStartedAt;
    // Validation AND provider-identity verification both happen here, before anything is persisted: a response that fails
    // either one throws and createAnalysisIntelligence below is never reached.
    const analysis = validateAndVerifyAnalysis(raw, { context, operationalHistory, knowledge, learning, workspaceId: scope });
    attempt.admission = analysis.admission;
    attempt.phase = "persistence";

    // Provenance is built from Node's OWN retrieval results for the chunks the
    // analysis reports using - never from anything the model or Python supplied.
    const used = new Set(analysis.usedKnowledgeChunkIds);
    const knowledgeProvenance = knowledge
      .filter((item) => used.has(item.chunkId))
      .map((item) => ({
        chunkId: item.chunkId,
        knowledgeDocumentId: item.knowledgeDocumentId,
        version: item.version,
        scope: item.scope,
        section: item.section,
        sectionPath: item.sectionPath,
        visibility: item.visibility,
        chunkIndex: item.chunkIndex,
        similarityScore: item.similarityScore,
        retrievalScore: item.retrievalScore,
      }));

    const stored = await createAnalysisIntelligence({
      workspaceId: scope,
      signal: { id: context.signal.id, title: signal.title, type: signal.type, severity: signal.severity },
      guestId: context.guest?.available ? context.guest.id : undefined,
      stayId: context.stay?.available ? context.stay.id : undefined,
      propertyId: context.property?.available ? context.property.id : undefined,
      level,
      analysis,
      provider: analysis.provenance.provider,
      model: analysis.provenance.model,
      knowledgeProvenance,
      // Phase 43B.1: only what Node derived or admitted above - the policy state (never the model's) and the two structured fields that passed
      // enforceSafetyPolicy. The rule codes are stored too (safety/context hardening) so the Action stage can enforce the existing ACCESS_REFUSED restriction; they are also kept on AnalysisAdmission for audit.
      safety: { state: analysis.admission.safetyState, urgency: analysis.urgency, recommendedActionType: analysis.recommendedActionType, rules: analysis.admission.safetyRules },
      evidenceRefs: analysis.evidenceRefs,
      contradictions: analysis.contradictions,
      // Every retrieved chunk was in the prompt, so the record inherits the highest
      // visibility among them (undefined when none were retrieved).
      knowledgeVisibility: maxVisibility(knowledge.map((item) => item.visibility)),
    });
    // A concurrent request that lost the unique-index race returns the winner's record (created: false); only the attempt that
    // actually stored an analysis is audited as accepted.
    if (stored.created) {
      await recordAnalysisAdmission({
        workspaceId: scope, signalId: id, attemptId: attempt.id, requestId, level, latencyMs: attempt.latencyMs, learningUsed: attempt.learningUsed,
        accepted: { intelligenceId: stored.record._id, analysis },
      });
    }
    return stored;
  } catch (error) {
    if (attempt.phase === "provider" && attempt.latencyMs === undefined) attempt.latencyMs = Date.now() - attempt.providerStartedAt;
    await recordAnalysisAdmission({
      workspaceId: scope, signalId: id, attemptId: attempt.id, requestId, level, latencyMs: attempt.latencyMs, learningUsed: attempt.learningUsed,
      error, phase: attempt.phase, admission: attempt.admission,
    });
    throw error;
  }
}
