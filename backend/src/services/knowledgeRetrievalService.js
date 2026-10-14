import { KnowledgeChunk } from "../models/KnowledgeChunk.js";
import { assembleSignalContext } from "./signalContextService.js";
import { requestKnowledgeRetrievalFromAiService } from "./ai/aiServiceClient.js";
import { allowedVisibilities, normalizeCallerLevel } from "./knowledge/visibility.js";
import { getAiTimeoutMs, getAnalysisTimeBudget, getRetrievalMinSimilarity, nextRetrievalCallTimeoutMs } from "../config/runtimeConfig.js";
import { AppError } from "../utils/AppError.js";

/**
 * Knowledge retrieval pipeline (Phase 6G, hardened in Phase 25):
 *
 *   Signal -> trusted operational context (Node, existing Phase 3D code)
 *   -> MongoDB candidate selection, PAGED in deterministic _id order (Node, this file)
 *        workspace, status, visibility ceiling, property/unit scope, effective window, "has an embedding"
 *        - every rule is in the query, so it is applied BEFORE any embedding or similarity
 *   -> per page: query embedding + compatibility check + cosine similarity + scope boost (Python)
 *   -> independent re-verification (Node): candidate identity, scope, finite scores, embedding model
 *   -> server-side relevance floor on the RAW cosine similarity (Node, getRetrievalMinSimilarity)
 *   -> stable descending order, de-duplicated by chunk id, top-K (Node)
 *   -> result (returned, never persisted)
 *
 * This is retrieval only - nothing here touches generation, prompts, or the Intelligence collection.
 * Node remains the sole MongoDB owner and tenant authority throughout: Python receives only opaque chunk ids,
 * embeddings, an embedding-model label and a scope label Node already computed - never a workspaceId, never a
 * MongoDB query of its own, and its ranking is never trusted at face value (see verifyAndBuildResults).
 *
 * NONE of the retrieval controls below can be influenced by a client: the relevance floor, top-K, page size, the
 * candidate ceiling and the embedding model are all server-side; the workspace and the visibility ceiling come
 * from the verified actor.
 */

// One MongoDB page == one Python request. Python accepts at most `similarity_max_candidates` (200) candidates per
// request; Node cannot read Python's env, so the two are deliberately separate constants that agree.
export const CANDIDATE_PAGE_SIZE = 200;

// Hard ceiling on how many ELIGIBLE chunks one retrieval scans (10 pages). Phase 25: previously the first 200 chunks in
// _id order were silently the ONLY candidates, however many were eligible. Now every eligible chunk up to this ceiling is
// scored; a corpus above it FAILS CLOSED (retrieval error) instead of quietly ignoring the rest.
export const MAX_ELIGIBLE_CANDIDATES = 2000;

// Phase 35.1: the stable code of a retrieval that ran out of its time budget (a 504, classified provider_timeout).
export const RETRIEVAL_BUDGET_EXHAUSTED = "KNOWLEDGE_RETRIEVAL_BUDGET_EXHAUSTED";

// Small final evidence set. Unchanged from Phase 6G: more candidates never means more context.
export const TOP_K = 5;

// Shown in place of a missing embeddingModel so an unlabeled vector is counted as INCOMPATIBLE, never compared.
const UNLABELED_EMBEDDING_MODEL = "(unlabeled)";

/**
 * Deterministic, LLM-free retrieval query text - derived only from the Signal's own type, title and description
 * (never client-supplied, never guest/stay/unit/property data, so it cannot become a PII side channel).
 * Intentionally simple: this is a query for cosine similarity, not a prompt for a model.
 */
export function buildRetrievalQueryText(context) {
  const { signal } = context;
  return [signal.type, signal.title, signal.description]
    .filter((part) => typeof part === "string" && part.trim().length > 0)
    .join(". ");
}

/** A chunk's own scope is a fact about that chunk, not about the query context. */
export function scopeLabelForChunk(chunk) {
  if (chunk.unitId) return "unit";
  if (chunk.propertyId) return "property";
  return "workspace";
}

const SCOPE_SPECIFICITY = { unit: 3, property: 2, workspace: 1 };

/**
 * Every eligible scope tier for this Signal's own property/unit - never
 * another workspace's data, and never a broader tier silently expanded
 * into a narrower one the Signal doesn't actually have.
 */
function buildScopeFilter(workspaceId, propertyId, unitId) {
  const scopeOr = [{ propertyId: null, unitId: null }]; // workspace-wide, always eligible
  if (propertyId) {
    scopeOr.push({ propertyId, unitId: null }); // this exact property, workspace-wide within it
    if (unitId) {
      scopeOr.push({ propertyId, unitId }); // this exact unit
    }
  }
  return scopeOr;
}

/**
 * MongoDB candidate selection - the only place tenant/eligibility rules are decided. Enforces, in one query: current
 * workspace, eligible property/unit scope, active status, in-force effective-date window, "has an embedding at all"
 * (never send an un-embedded chunk to Python) - and the caller's authorized VISIBILITY. Visibility is part of this same
 * query, so it is applied before paging, before Python, and before any scoring: a chunk above the caller's level is never
 * a candidate, never a result, and never reaches a prompt.
 *
 * Phase 25: returns ONE page, in ascending _id order, strictly after `afterId`. Paging by _id cursor is deterministic and
 * stable, and - unlike the former single `limit(200)` - it never leaves eligible chunks unscored: the caller walks every page.
 */
async function selectCandidatePage(workspaceId, propertyId, unitId, authorizedLevel, afterId) {
  const now = new Date();

  const filter = {
    workspaceId,
    status: "active",
    visibility: { $in: allowedVisibilities(authorizedLevel) },
    embedding: { $exists: true, $ne: null },
    $and: [
      { $or: buildScopeFilter(workspaceId, propertyId, unitId) },
      { $or: [{ effectiveFrom: null }, { effectiveFrom: { $lte: now } }] },
      { $or: [{ effectiveTo: null }, { effectiveTo: { $gt: now } }] },
    ],
  };
  if (afterId) filter._id = { $gt: afterId };

  return KnowledgeChunk.find(filter).sort({ _id: 1 }).limit(CANDIDATE_PAGE_SIZE);
}

/**
 * Deterministic ordering, applied again on the Node side even though
 * Python already sorts: retrievalScore, then similarityScore, then scope
 * specificity, all descending; chunkId ascending breaks any remaining tie.
 * Matches ai-service/app/routers/retrieval.py's sort exactly.
 */
function compareResults(a, b) {
  if (b.retrievalScore !== a.retrievalScore) return b.retrievalScore - a.retrievalScore;
  if (b.similarityScore !== a.similarityScore) return b.similarityScore - a.similarityScore;
  const specificityDiff = SCOPE_SPECIFICITY[b.scope] - SCOPE_SPECIFICITY[a.scope];
  if (specificityDiff !== 0) return specificityDiff;
  return a.chunkId < b.chunkId ? -1 : a.chunkId > b.chunkId ? 1 : 0;
}

/**
 * Never trusts Python's response at face value. Every result is checked
 * against the eligible-chunk map Node itself built (from its own,
 * already-tenant-scoped, already-eligibility-filtered MongoDB query) -
 * not a second MongoDB round trip, but the same authoritative data,
 * checked independently rather than assumed. A chunkId Python returns
 * that doesn't match anything Node actually sent could only mean a
 * corrupted or malformed response; it is dropped, never trusted.
 *
 * Phase 25: when `queryModel` (the model that embedded the query, as Python reported it) is given, a result whose chunk
 * was embedded by ANY OTHER model is dropped too - Python already refuses to compare those, this is Node's own check.
 *
 * Exported for direct unit testing of this exact defense-in-depth
 * behavior (see validate-knowledge-retrieval.mjs) - constructing a
 * genuinely malicious/corrupted Python response requires a compromised
 * Python process, which isn't something a test can safely simulate over
 * HTTP; calling this function directly with a fabricated response proves
 * the same guarantee.
 *
 * Includes each chunk's own `text` (Phase 6H) - the standalone retrieval
 * endpoint already returning the full verified chunk record is a small,
 * purely additive, backward-compatible extension (no existing consumer
 * asserts a closed/exact result shape), and it is what lets
 * the generation flow reuse this exact result as Python's grounding
 * input with zero remapping.
 */
export function verifyAndBuildResults(pythonResults, eligibleChunksById, { queryModel } = {}) {
  const verified = [];

  for (const result of pythonResults || []) {
    const chunk = eligibleChunksById.get(String(result?.chunkId));
    if (!chunk) continue; // not one of the candidates Node actually sent - reject silently
    if (typeof result.similarityScore !== "number" || !Number.isFinite(result.similarityScore)) continue;
    if (typeof result.retrievalScore !== "number" || !Number.isFinite(result.retrievalScore)) continue;
    if (queryModel !== undefined && chunk.embeddingModel !== queryModel) continue; // never trust a cross-model score

    const expectedScope = scopeLabelForChunk(chunk);
    if (result.scope !== expectedScope) continue; // never trust Python's echoed scope over the fact itself

    verified.push({
      chunkId: String(chunk._id),
      knowledgeDocumentId: String(chunk.documentId),
      version: chunk.version,
      scope: expectedScope,
      section: chunk.section,
      sectionPath: Array.isArray(chunk.sectionPath) ? [...chunk.sectionPath] : [],
      visibility: chunk.visibility,
      chunkIndex: chunk.chunkIndex,
      text: chunk.text,
      similarityScore: result.similarityScore,
      retrievalScore: result.retrievalScore,
    });
  }

  verified.sort(compareResults);
  return verified;
}

/**
 * The final selection (Phase 25), pure and deterministic:
 *   verified candidates -> drop similarity < minSimilarity (RAW cosine, boundary inclusive)
 *   -> de-duplicate by chunkId -> stable descending order (compareResults) -> first `topK`.
 * The relevance floor uses the raw cosine, not the scope-boosted score, so the scope preference can break ties between
 * relevant chunks but can never lift an irrelevant one over the floor. Identical chunk TEXT under different chunk ids is
 * deliberately NOT collapsed: the same guidance authored at unit, property and workspace scope is distinct, scope-labelled evidence.
 *
 * @returns {{ selected: object[], belowThreshold: number }}
 */
export function selectRelevantResults(verified, { minSimilarity, topK = TOP_K }) {
  const seen = new Set();
  const relevant = [];
  let belowThreshold = 0;
  for (const result of verified) {
    if (seen.has(result.chunkId)) continue;
    seen.add(result.chunkId);
    if (!(result.similarityScore >= minSimilarity)) {
      belowThreshold += 1;
      continue;
    }
    relevant.push(result);
  }
  relevant.sort(compareResults);
  return { selected: relevant.slice(0, topK), belowThreshold };
}

/**
 * Retrieves the top-K knowledge chunks relevant to an already-assembled,
 * already-trusted operational context. Read-only: nothing is persisted, no
 * Intelligence document is created, no operational fact is touched.
 * Degrades gracefully when context is incomplete (no property/unit/guest/
 * stay) - it retrieves from whatever scopes are legitimately available
 * rather than fabricating missing context.
 *
 * Takes `context` rather than assembling it itself so a caller that has
 * already called assembleSignalContext (the generation flow, grounding the
 * same request) never triggers a second, redundant Signal lookup.
 * retrieveKnowledgeForSignal below is the entry point for callers (the
 * standalone retrieval endpoint) that only have a signalId.
 *
 * `status` says WHY `results` is what it is, so "nothing relevant" is explicit and never fabricated:
 *   "ok"                    at least one chunk passed the relevance floor
 *   "no_eligible_knowledge" no chunk was eligible for this workspace/scope/visibility (nothing to compare)
 *   "no_relevant_knowledge" candidates were compared, none reached the relevance floor
 * If candidates were eligible but NONE has an embedding compatible with the query embedding (another model or dimension),
 * nothing could be compared at all: that is a retrieval FAILURE (thrown), never reported as "no relevant knowledge".
 */
export async function retrieveKnowledgeForContext(context, workspaceId, authorizedLevel, { deadlineAt } = {}) {
  const minSimilarity = getRetrievalMinSimilarity();
  // Phase 35.1: every request-path retrieval has a TIME BUDGET. The analysis flow passes the deadline derived from the start of its
  // request; any other caller (the standalone retrieval endpoint) gets the same budget measured from now.
  const scored = await scoreKnowledgeForContext(context, workspaceId, authorizedLevel, { deadlineAt: deadlineAt ?? Date.now() + getAnalysisTimeBudget().retrievalBudgetMs });
  const base = scored.base;

  if (scored.scanned === 0) {
    return { ...base, model: null, results: [], status: "no_eligible_knowledge", diagnostics: { eligibleCandidates: 0, evaluatedCandidates: 0, incompatibleCandidates: 0, belowThreshold: 0, minSimilarity, topK: TOP_K } };
  }

  const { selected, belowThreshold } = selectRelevantResults(scored.verified, { minSimilarity, topK: TOP_K });

  return {
    ...base,
    model: scored.model,
    results: selected,
    status: selected.length > 0 ? "ok" : "no_relevant_knowledge",
    diagnostics: { eligibleCandidates: scored.scanned, evaluatedCandidates: scored.evaluated, incompatibleCandidates: scored.incompatible, belowThreshold, minSimilarity, topK: TOP_K },
  };
}

/**
 * Steps 1-3 of retrieveKnowledgeForContext: every eligible chunk (workspace/visibility/scope-filtered, paged), scored by the AI service and
 * re-verified by Node - and NOTHING else: no relevance floor and no top-K. Extracted in Phase 26 (a pure refactor, behavior unchanged) so the
 * OFFLINE evaluation harness can run the real candidate selection, embedding compatibility and scoring ONCE per query and then apply the SAME
 * production selection function (selectRelevantResults) under different floors / K, instead of re-implementing retrieval. No request path
 * calls this directly; the HTTP surface still goes through retrieveKnowledgeForContext with the server-side floor and top-K.
 *
 * @returns {{ base: object, verified: object[], model: string|null, scanned: number, evaluated: number, incompatible: number }}
 * Throws (fail closed) exactly as retrieveKnowledgeForContext always did: ceiling exceeded, or nothing comparable.
 */
export async function scoreKnowledgeForContext(context, workspaceId, authorizedLevel, { deadlineAt } = {}) {
  // Fail closed: a missing/invalid level is the lowest one ("guest").
  const level = normalizeCallerLevel(authorizedLevel);
  const propertyId = context.signal.propertyId || null;
  const unitId = context.signal.unitId || null;
  const retrievedAt = new Date().toISOString();
  const base = { signalId: context.signal.id, workspaceId: String(workspaceId), retrievedAt };
  const queryText = buildRetrievalQueryText(context);

  const verifiedAll = [];
  let scanned = 0;
  let evaluated = 0;
  let incompatible = 0;
  let model = null;
  let afterId = null;

  for (;;) {
    const page = await selectCandidatePage(workspaceId, propertyId, unitId, level, afterId);
    if (page.length === 0) break;
    if (scanned >= MAX_ELIGIBLE_CANDIDATES) {
      // More eligible knowledge than the ceiling: refuse rather than silently score only part of it.
      throw new AppError("The eligible knowledge exceeds the retrieval ceiling; retrieval cannot score all of it.", 502);
    }
    scanned += page.length;
    afterId = page[page.length - 1]._id;

    const eligibleChunksById = new Map(page.map((chunk) => [String(chunk._id), chunk]));
    const candidatesForPython = page.map((chunk) => ({
      chunkId: String(chunk._id),
      embedding: chunk.embedding,
      scope: scopeLabelForChunk(chunk),
      visibility: chunk.visibility,
      embeddingModel: chunk.embeddingModel || UNLABELED_EMBEDDING_MODEL,
    }));

    // Phase 35.1: each AI-service call gets min(base timeout, time left in the retrieval budget). When the budget is spent, retrieval FAILS
    // CLOSED (the analysis is never attempted and nothing is persisted) - the same policy as a corpus that cannot be fully scored - so the
    // request as a whole can never knowingly outlive its deadline. No deadline (the offline evaluation harness) means no cap, as before.
    let callTimeoutMs;
    if (deadlineAt !== undefined) {
      callTimeoutMs = nextRetrievalCallTimeoutMs({ now: Date.now(), deadlineAt, baseMs: getAiTimeoutMs() });
      if (callTimeoutMs === null) {
        throw new AppError("Knowledge retrieval exceeded its time budget; intelligence was not generated.", 504, { code: RETRIEVAL_BUDGET_EXHAUSTED });
      }
    }
    const response = await requestKnowledgeRetrievalFromAiService(queryText, candidatesForPython, level, { timeoutMs: callTimeoutMs });
    model = response.model || model;
    evaluated += Number.isInteger(response.evaluatedCandidates) ? response.evaluatedCandidates : page.length;
    incompatible += Number.isInteger(response.incompatibleCandidates) ? response.incompatibleCandidates : 0;
    verifiedAll.push(...verifyAndBuildResults(response.results, eligibleChunksById, { queryModel: response.model }));

    if (page.length < CANDIDATE_PAGE_SIZE) break;
  }

  if (scanned > 0 && evaluated > 0 && incompatible >= evaluated) {
    throw new AppError("None of the eligible knowledge has an embedding compatible with the query embedding model.", 502);
  }
  if (incompatible > 0) {
    console.warn(`[KOI API] Knowledge retrieval skipped ${incompatible} embedding(s) incompatible with the query embedding model.`);
  }

  return { base, verified: verifiedAll, model, scanned, evaluated, incompatible };
}

/**
 * Original Phase 6G entry point, unchanged in behavior: assembles the
 * Signal's trusted operational context itself, then delegates to
 * retrieveKnowledgeForContext above. Used by the standalone
 * GET /:id/knowledge-retrieval development/validation endpoint, which has
 * only a signalId and no already-assembled context to reuse.
 */
export async function retrieveKnowledgeForSignal(signalId, workspaceId, authorizedLevel) {
  const context = await assembleSignalContext(signalId, workspaceId);
  return retrieveKnowledgeForContext(context, workspaceId, authorizedLevel);
}
