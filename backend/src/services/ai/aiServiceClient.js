import { AppError } from "../../utils/AppError.js";

import { getAiAnalysisTimeoutMs, getAiTimeoutMs } from "../../config/runtimeConfig.js";

// Upstream AI call timeout: 20 s by default (KOI_AI_TIMEOUT_MS), evaluated per call.
const aiTimeout = () => getAiTimeoutMs();

/**
 * Thin HTTP client to the Python AI service. Its only job is to POST a
 * request and translate the service's response — or its failure — into the
 * same safe application errors used everywhere else in this codebase. Shared by every endpoint this service exposes: intelligence
 * generation (Phase 5, knowledge-grounded as of Phase 6H), embedding
 * generation (Phase 6E), and knowledge retrieval (Phase 6G).
 *
 * This module never assembles operational context, never touches MongoDB,
 * never resolves tenancy, and never contains any provider-specific (Gemini)
 * logic — all provider execution lives entirely in the Python service;
 * Node has no Gemini or embedding-provider client of its own.
 */
// Observability only: the request id Node's own middleware generated is forwarded to the AI service so one analysis can be followed in both log streams. It is
// sent only when it is a canonical uuid (anything else is dropped), carries no workspace/user/Signal identifier, and is never an authorization input on either side.
const REQUEST_ID_HEADER = "X-KOI-Request-Id";
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function postToAiService(path, payload, timeoutMs = aiTimeout(), { requestId } = {}) {
  const baseUrl = (process.env.AI_SERVICE_URL || "").trim();
  if (!baseUrl) {
    throw new AppError("AI intelligence service is not configured.", 503, { code: "AI_SERVICE_NOT_CONFIGURED" });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
      method: "POST",
      // Phase 51: the optional service credential (server configuration only; never logged, never sent anywhere but this one URL).
      headers: {
        "Content-Type": "application/json",
        ...(process.env.AI_SERVICE_TOKEN ? { "X-KOI-Service-Token": process.env.AI_SERVICE_TOKEN } : {}),
        ...(typeof requestId === "string" && CANONICAL_UUID.test(requestId) ? { [REQUEST_ID_HEADER]: requestId.toLowerCase() } : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new AppError("AI intelligence service timed out. Try again.", 504, { code: "AI_SERVICE_TIMEOUT" });
    }
    console.error("[KOI API] AI service unreachable:", error?.name || "Error");
    throw new AppError("AI intelligence service is temporarily unavailable.", 502, { code: "AI_SERVICE_UNREACHABLE" });
  } finally {
    clearTimeout(timer);
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new AppError("AI intelligence service returned a malformed response.", 502, { code: "AI_SERVICE_MALFORMED_RESPONSE" });
  }

  if (!response.ok) {
    throw mapAiServiceError(body, response.status);
  }

  return body;
}

/**
 * Phase 6E — requests embedding vectors for already-chunked KnowledgeChunk
 * text. Sends only `texts`: no workspaceId, no MongoDB identifiers, no
 * tenant concept of any kind travels to Python (see knowledgeEmbeddingService.js
 * for where tenant scoping and persistence actually happen — both on the
 * Node side, never in Python).
 */
export async function requestEmbeddingsFromAiService(texts) {
  const body = await postToAiService("/v1/embeddings", { texts });
  return { embeddings: body?.embeddings, model: body?.model };
}

/**
 * Phase 6G — requests a ranked list of already-selected, already-tenant-
 * scoped candidates against a fresh embedding of `queryText`. Sends only
 * `queryText` and each candidate's `{chunkId, embedding, scope}`: no
 * workspaceId, no document/property/unit identifiers, no MongoDB data of
 * any kind travels to Python (see knowledgeRetrievalService.js for where
 * candidate selection, tenant scoping, and result re-verification actually
 * happen — all on the Node side, never in Python).
 */
export async function requestKnowledgeRetrievalFromAiService(queryText, candidates, authorizedLevel, { timeoutMs } = {}) {
  // authorizedLevel + each candidate's visibility let Python defensively ignore
  // anything above the caller's level; Node has ALREADY filtered before this
  // call and remains the authoritative enforcement point.
  // Phase 35.1: `timeoutMs` is the time LEFT in the request's retrieval budget (never more than the base timeout); undefined keeps the base timeout.
  const body = await postToAiService("/v1/knowledge-retrieval", { queryText, candidates, authorizedLevel }, timeoutMs);
  return {
    results: body?.results,
    model: body?.model,
    evaluatedCandidates: body?.evaluatedCandidates,
    incompatibleCandidates: body?.incompatibleCandidates,
  };
}

/**
 * Intelligence V1 - requests a structured analysis. Same trusted inputs as
 * requestIntelligenceFromAiService (Node-assembled context, Node-retrieved and
 * Node-authorized knowledge, the level Node enforced), a different, closed
 * response contract (see ai-service/app/models/analysis.py). The caller must
 * still validate the response (ai/analysisSchema.js): it is never trusted.
 */
export async function requestAnalysisFromAiService(context, knowledge = [], authorizedLevel, operationalHistory, learning, { requestId } = {}) {
  // Phase 27: `operationalHistory` is optional so the request stays backward compatible; when present it is
  // the contract-validated historical context (operationalContextContract.js). Phase 32: `learning` is the
  // same kind of optional, contract-validated addition (learningContextContract.js) - omitted entirely
  // (not even as `null`) unless intelligenceAnalysisService.js's feature flag is on, so a disabled-flag
  // request is byte-for-byte identical to the pre-Phase-32 body. Nothing else is sent.
  const body = { context, knowledge, authorizedLevel };
  if (operationalHistory !== undefined) body.operationalHistory = operationalHistory;
  if (learning !== undefined) body.learning = learning;
  // Phase 34A-B: the analysis call waits slightly LONGER than the AI service's own provider timeout, so a slow provider is
  // reported by the AI service as PROVIDER_TIMEOUT instead of being cut off by this client at the same instant.
  return postToAiService("/v1/intelligence/analyze", body, getAiAnalysisTimeoutMs(), { requestId });
}

/**
 * Maps the AI service's own error contract ({error:{code,message}}) to a safe Node-facing AppError. Never forwards the
 * service's raw message verbatim, and never logs anything beyond the code/status - the same no-leakage discipline as the
 * rest of this codebase.
 *
 * Phase 34A-B taxonomy. Each distinguishable provider failure keeps its own stable `details.code` and a sensible HTTP
 * status; no retry, backoff or circuit breaker is implied by any of them:
 *   not configured / model not approved / authentication failed / forbidden  -> 503 (server configuration, not the caller)
 *   rate limited                                                             -> 503 (the PROVIDER is limiting us; this
 *                                                                               deliberately is not this API's own 429,
 *                                                                               which means "you are sending too much")
 *   timeout                                                                  -> 504
 *   unavailable / bad request / unknown / malformed / identity mismatch      -> 502
 *   safety block                                                             -> 422 (the content was declined)
 * An unrecognised code (for example from an older AI service) is a 502 "invalid response", exactly as before.
 */
const AI_SERVICE_ERRORS = Object.freeze({
  PROVIDER_NOT_CONFIGURED: [503, "AI intelligence service is not configured."],
  PROVIDER_MODEL_NOT_APPROVED: [503, "AI intelligence service is not configured with the approved model."],
  PROVIDER_AUTHENTICATION_FAILED: [503, "AI intelligence service is not configured correctly."],
  PROVIDER_FORBIDDEN: [503, "AI intelligence service is not configured correctly."],
  PROVIDER_RATE_LIMITED: [503, "AI intelligence service is rate-limited by its provider. Try again later."],
  PROVIDER_TIMEOUT: [504, "AI intelligence service timed out. Try again."],
  PROVIDER_UNAVAILABLE: [502, "AI intelligence service is temporarily unavailable."],
  PROVIDER_ERROR: [502, "AI intelligence service is temporarily unavailable."],
  PROVIDER_UNKNOWN_ERROR: [502, "AI intelligence service failed for an unrecognised reason."],
  PROVIDER_BAD_REQUEST: [502, "AI intelligence service rejected the request."],
  // Phase 36 (found by the Node<->Python contract test): the AI service answers a request that violates ITS schema with VALIDATION_FAILED.
  // That is a fault on this side (a Node bug or contract drift), reported as such - not as a generic "invalid response".
  VALIDATION_FAILED: [502, "AI intelligence service rejected the request."],
  PROVIDER_IDENTITY_MISMATCH: [502, "AI service reported an unapproved provider identity. Intelligence was not generated."],
  PROVIDER_SAFETY_BLOCK: [422, "The AI provider declined to analyse this content."],
  MALFORMED_RESPONSE: [502, "AI intelligence service returned an invalid response."],
});

export function mapAiServiceError(body, status) {
  const code = body?.error?.code;
  console.error("[KOI API] AI service error:", code || "unknown", status);

  const entry = Object.prototype.hasOwnProperty.call(AI_SERVICE_ERRORS, code) ? AI_SERVICE_ERRORS[code] : null;
  if (!entry) return new AppError("AI intelligence service returned an invalid response.", 502, { code: "AI_SERVICE_INVALID_RESPONSE" });
  // Phase 38: the AI service may add a stable, non-sensitive `rule` (e.g. CLAIM_MISSING_SOURCE_REFS) saying which structural rule rejected the model's
  // output; only a well-formed constant is passed on, never any free text.
  const rule = typeof body?.error?.rule === "string" && /^[A-Z][A-Z_]{2,47}$/.test(body.error.rule) ? body.error.rule : undefined;
  return new AppError(entry[1], entry[0], rule ? { code, rule } : { code });
}
