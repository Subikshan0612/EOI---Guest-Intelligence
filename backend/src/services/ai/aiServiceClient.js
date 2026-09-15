import { AppError } from "../../utils/AppError.js";

const REQUEST_TIMEOUT_MS = 20000;

/**
 * Thin HTTP client to the Python AI service. Its only job is to POST a
 * request and translate the service's response — or its failure — into the
 * same safe application errors the OpenAI path in llmProvider.js already
 * produces. Shared by every endpoint this service exposes: intelligence
 * generation (Phase 5, knowledge-grounded as of Phase 6H), embedding
 * generation (Phase 6E), and knowledge retrieval (Phase 6G).
 *
 * This module never assembles operational context, never touches MongoDB,
 * never resolves tenancy, and never contains any provider-specific (Gemini)
 * logic — all provider execution lives entirely in the Python service;
 * Node has no Gemini or embedding-provider client of its own.
 */
async function postToAiService(path, payload) {
  const baseUrl = (process.env.AI_SERVICE_URL || "").trim();
  if (!baseUrl) {
    throw new AppError("AI intelligence service is not configured.", 503);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new AppError("AI intelligence service timed out. Try again.", 504);
    }
    console.error("[KOI API] AI service unreachable:", error?.name || "Error");
    throw new AppError("AI intelligence service is temporarily unavailable.", 502);
  } finally {
    clearTimeout(timer);
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new AppError("AI intelligence service returned a malformed response.", 502);
  }

  if (!response.ok) {
    throw mapAiServiceError(body, response.status);
  }

  return body;
}

/**
 * `knowledge` (Phase 6H, optional, defaults to none) is the exact,
 * already-tenant-verified result of knowledgeRetrievalService.js's own
 * MongoDB candidate selection — never arbitrary client-supplied data. See
 * intelligenceService.js for where retrieval happens and where the
 * response's `knowledgeProvenance` gets independently re-verified against
 * that same trusted result before it is ever returned to a caller.
 */
export async function requestIntelligenceFromAiService(context, knowledge = []) {
  const body = await postToAiService("/v1/intelligence/signal", { context, knowledge });

  // Python's own provenance is trusted here (unlike a raw LLM's own JSON
  // output): it is Python's honest self-report of which internal path it
  // just executed (its deterministic stub vs. its real Gemini client),
  // attached by Python's own trusted code, not by whatever came back from
  // an external model.
  // `body.knowledgeProvenance` (Phase 6H) travels inside `raw` — no need to
  // extract it separately, validateIntelligenceResult reads it from there.
  return { raw: body, provider: body?.provenance?.provider, model: body?.provenance?.model };
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
export async function requestKnowledgeRetrievalFromAiService(queryText, candidates) {
  const body = await postToAiService("/v1/knowledge-retrieval", { queryText, candidates });
  return { results: body?.results, model: body?.model };
}

/**
 * Maps the AI service's own error contract ({error:{code,message}}) to a
 * safe Node-facing AppError. Never forwards the service's raw message
 * verbatim, and never logs anything beyond the code/status — the same
 * no-leakage discipline as mapOpenAiError in llmProvider.js.
 */
function mapAiServiceError(body, status) {
  const code = body?.error?.code;
  console.error("[KOI API] AI service error:", code || "unknown", status);

  switch (code) {
    case "PROVIDER_NOT_CONFIGURED":
      return new AppError("AI intelligence service is not configured.", 503);
    case "PROVIDER_TIMEOUT":
      return new AppError("AI intelligence service timed out. Try again.", 504);
    case "PROVIDER_ERROR":
      return new AppError("AI intelligence service is temporarily unavailable.", 502);
    case "MALFORMED_RESPONSE":
    case "VALIDATION_FAILED":
    default:
      return new AppError("AI intelligence service returned an invalid response.", 502);
  }
}
