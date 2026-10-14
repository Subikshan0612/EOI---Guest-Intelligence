import { AppError } from "../../utils/AppError.js";
import { RETRIEVAL_BUDGET_EXHAUSTED, retrieveKnowledgeForContext } from "../knowledgeRetrievalService.js";

/**
 * Shared building blocks of the ONE intelligence-generation path,
 * services/intelligenceAnalysisService.js (POST /api/intelligence/analyze/:signalId).
 *
 * Phase 24: the legacy generator that used to live here (POST /api/signals/:id/intelligence, which sent
 * the unsanitized context - guest name, email, phone - to the model and had its own Node-level provider
 * branches) is retired. Only the two pieces the canonical flow still shares remain.
 */

/**
 * Node provider values that delegate generation to the Python AI service (ai-service/). Grounded,
 * knowledge-carrying generation exists only on that path, so any other value makes the analysis route
 * answer 503 rather than fall back to an ungrounded generator.
 *
 * - "gemini"      - the real route. Python's OWN LLM_PROVIDER decides whether the call is real (`gemini`)
 *                   or a deterministic stub (`test`, its safe default).
 * - "test-python" - an explicit, secondary trigger for the identical delegation (deterministic Node->Python
 *                   integration testing).
 */
export const PYTHON_ROUTED_PROVIDERS = new Set(["gemini", "test-python"]);

/**
 * Retrieval SUCCEEDING with zero eligible chunks and retrieval FAILING are different states and must never
 * collapse into one.
 *
 * - Zero results (retrieveKnowledgeForContext resolves normally with an empty `results` array) is a
 *   successful check that found nothing: generation continues, ungrounded.
 * - A failure (Python unreachable, a timeout, a malformed/rejected response, any unexpected internal error)
 *   is NEVER treated as "nothing was found": that would let an analysis look as if the knowledge layer had
 *   been checked when it had not. It is re-thrown as a controlled, clearly tagged AppError.
 *
 * The original status code is preserved when it is already a classified AppError (504 timeout, 503 not
 * configured); anything else defaults to 502. The raw underlying error message is never forwarded.
 */
const RETRIEVAL_TIMEOUT_CODES = new Set([RETRIEVAL_BUDGET_EXHAUSTED, "AI_SERVICE_TIMEOUT"]);

export async function retrieveKnowledgeOrThrow(context, workspaceId, authorizedLevel, options = {}) {
  try {
    const retrieval = await retrieveKnowledgeForContext(context, workspaceId, authorizedLevel, options);
    return retrieval.results;
  } catch (error) {
    console.error(
      "[KOI API] Knowledge retrieval failed - intelligence was not generated:",
      error?.name || "Error",
    );
    const statusCode = error instanceof AppError ? error.statusCode : 502;
    // Phase 35.1: the two timeout codes are kept through the re-wrap, so a spent retrieval budget (or a call cut short by it) is classified (not "internal").
    throw new AppError(
      "Knowledge retrieval failed (KNOWLEDGE_RETRIEVAL_UNAVAILABLE). Intelligence was not generated.",
      statusCode,
      RETRIEVAL_TIMEOUT_CODES.has(error?.details?.code) ? { code: error.details.code } : undefined,
    );
  }
}
