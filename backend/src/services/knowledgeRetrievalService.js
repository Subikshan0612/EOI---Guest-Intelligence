import { KnowledgeChunk } from "../models/KnowledgeChunk.js";
import { assembleSignalContext } from "./signalContextService.js";
import { requestKnowledgeRetrievalFromAiService } from "./ai/aiServiceClient.js";

/**
 * Phase 6G — the first real knowledge retrieval pipeline:
 *
 *   Signal -> trusted operational context (Node, existing Phase 3D code)
 *   -> MongoDB candidate selection (Node, this file)
 *   -> query embedding + similarity + scope ranking (Python, Phase 6E/6F/6G)
 *   -> independent re-verification (Node, this file)
 *   -> top-K retrieval result (returned, never persisted)
 *
 * This is retrieval only — nothing here touches Gemini intelligence
 * generation, prompts, or the Intelligence collection. That is Phase 6H.
 *
 * Node remains the sole MongoDB owner and tenant authority throughout:
 * Python receives only opaque chunk ids, embeddings, and a scope label
 * Node already computed — never a workspaceId, never a MongoDB query of
 * its own, and its ranking is never trusted at face value (see
 * verifyAndBuildResults below).
 */

// Phase 6A/6F boundary: MongoDB candidate selection is capped at 200
// before Python ever sees anything — in-memory cosine similarity over a
// small, tenant-scoped set, not a vector database. Independent of Python's
// own `settings.similarity_max_candidates` (Node cannot read Python's env;
// the two are deliberately separate constants that happen to agree).
const MAX_CANDIDATES = 200;

// Initial configurable top-K, per the Phase 6G brief. A plain, documented
// constant — consistent with how EMBEDDING_BATCH_SIZE/RETRIEVAL constants
// elsewhere in this codebase are chosen (see knowledgeEmbeddingService.js).
const TOP_K = 5;

/**
 * Deterministic, LLM-free retrieval query text — derived only from fields
 * the trusted operational context already carries (never client-supplied).
 * Intentionally simple: this is a query for cosine similarity, not a
 * prompt for a model.
 */
function buildRetrievalQueryText(context) {
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
 * Every eligible scope tier for this Signal's own property/unit — never
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
 * MongoDB candidate selection — the only place tenant/eligibility rules
 * are decided. Enforces, in one query: current workspace, eligible
 * property/unit scope, active status, in-force effective-date window, and
 * "has an embedding at all" (never send an un-embedded chunk to Python).
 */
async function selectCandidateChunks(workspaceId, propertyId, unitId) {
  const now = new Date();

  return KnowledgeChunk.find({
    workspaceId,
    status: "active",
    embedding: { $exists: true, $ne: null },
    $and: [
      { $or: buildScopeFilter(workspaceId, propertyId, unitId) },
      { $or: [{ effectiveFrom: null }, { effectiveFrom: { $lte: now } }] },
      { $or: [{ effectiveTo: null }, { effectiveTo: { $gt: now } }] },
    ],
  })
    .sort({ _id: 1 }) // deterministic cap order — ranking happens after, this just bounds the set
    .limit(MAX_CANDIDATES);
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
 * already-tenant-scoped, already-eligibility-filtered MongoDB query) —
 * not a second MongoDB round trip, but the same authoritative data,
 * checked independently rather than assumed. A chunkId Python returns
 * that doesn't match anything Node actually sent could only mean a
 * corrupted or malformed response; it is dropped, never trusted.
 *
 * Exported for direct unit testing of this exact defense-in-depth
 * behavior (see validate-knowledge-retrieval.mjs) — constructing a
 * genuinely malicious/corrupted Python response requires a compromised
 * Python process, which isn't something a test can safely simulate over
 * HTTP; calling this function directly with a fabricated response proves
 * the same guarantee.
 *
 * Includes each chunk's own `text` (Phase 6H) — the standalone retrieval
 * endpoint already returning the full verified chunk record is a small,
 * purely additive, backward-compatible extension (no existing consumer
 * asserts a closed/exact result shape), and it is what lets
 * intelligenceService.js reuse this exact result as Python's grounding
 * input with zero remapping.
 */
export function verifyAndBuildResults(pythonResults, eligibleChunksById) {
  const verified = [];

  for (const result of pythonResults || []) {
    const chunk = eligibleChunksById.get(String(result?.chunkId));
    if (!chunk) continue; // not one of the candidates Node actually sent — reject silently
    if (typeof result.similarityScore !== "number" || !Number.isFinite(result.similarityScore)) continue;
    if (typeof result.retrievalScore !== "number" || !Number.isFinite(result.retrievalScore)) continue;

    const expectedScope = scopeLabelForChunk(chunk);
    if (result.scope !== expectedScope) continue; // never trust Python's echoed scope over the fact itself

    verified.push({
      chunkId: String(chunk._id),
      knowledgeDocumentId: String(chunk.documentId),
      version: chunk.version,
      scope: expectedScope,
      section: chunk.section,
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
 * Retrieves the top-K knowledge chunks relevant to an already-assembled,
 * already-trusted operational context. Read-only: nothing is persisted, no
 * Intelligence document is created, no operational fact is touched.
 * Degrades gracefully when context is incomplete (no property/unit/guest/
 * stay) — it retrieves from whatever scopes are legitimately available
 * rather than fabricating missing context.
 *
 * Takes `context` rather than assembling it itself so a caller that has
 * already called assembleSignalContext (Phase 6H's intelligenceService.js,
 * grounding the same generation request) never triggers a second,
 * redundant Signal lookup. retrieveKnowledgeForSignal below is the
 * original, still-unchanged entry point for callers (the standalone
 * retrieval endpoint) that only have a signalId.
 */
export async function retrieveKnowledgeForContext(context, workspaceId) {
  const propertyId = context.signal.propertyId || null;
  const unitId = context.signal.unitId || null;

  const chunks = await selectCandidateChunks(workspaceId, propertyId, unitId);

  const retrievedAt = new Date().toISOString();

  if (chunks.length === 0) {
    return { signalId: context.signal.id, workspaceId: String(workspaceId), retrievedAt, model: null, results: [] };
  }

  const eligibleChunksById = new Map(chunks.map((chunk) => [String(chunk._id), chunk]));
  const candidatesForPython = chunks.map((chunk) => ({
    chunkId: String(chunk._id),
    embedding: chunk.embedding,
    scope: scopeLabelForChunk(chunk),
  }));

  const queryText = buildRetrievalQueryText(context);
  const { results, model } = await requestKnowledgeRetrievalFromAiService(queryText, candidatesForPython);

  const verified = verifyAndBuildResults(results, eligibleChunksById);

  return {
    signalId: context.signal.id,
    workspaceId: String(workspaceId),
    retrievedAt,
    model: model || null,
    results: verified.slice(0, TOP_K),
  };
}

/**
 * Original Phase 6G entry point, unchanged in behavior: assembles the
 * Signal's trusted operational context itself, then delegates to
 * retrieveKnowledgeForContext above. Used by the standalone
 * GET /:id/knowledge-retrieval development/validation endpoint, which has
 * only a signalId and no already-assembled context to reuse.
 */
export async function retrieveKnowledgeForSignal(signalId, workspaceId) {
  const context = await assembleSignalContext(signalId, workspaceId);
  return retrieveKnowledgeForContext(context, workspaceId);
}
