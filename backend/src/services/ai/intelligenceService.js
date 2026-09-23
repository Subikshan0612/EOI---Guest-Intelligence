import { AppError } from "../../utils/AppError.js";
import { requireObjectId } from "../../utils/objectId.js";
import { assembleSignalContext } from "../signalContextService.js";
import { retrieveKnowledgeForContext } from "../knowledgeRetrievalService.js";
import { buildIntelligencePrompt } from "./intelligencePrompt.js";
import { getActiveProviderInfo, isAiConfigured, requestStructuredIntelligence } from "./llmProvider.js";
import { requestIntelligenceFromAiService } from "./aiServiceClient.js";
import { validateIntelligenceResult } from "./intelligenceSchema.js";
import { createGeneratedIntelligence } from "../intelligenceService.js";

/**
 * Node provider values that delegate generation to the Python AI service
 * (ai-service/) rather than calling a provider directly from Node.
 *
 * - "gemini"      — the real, production/default route to Gemini. Node
 *                    delegates to Python, and Python's OWN LLM_PROVIDER
 *                    decides whether that call is real (its `gemini` value,
 *                    via gemini_client.py) or a deterministic stub (its
 *                    `test` value, the safe default). As of Phase 5 Step 5,
 *                    llmProvider.js no longer contains a Gemini branch at
 *                    all — Gemini execution lives exclusively in Python.
 * - "test-python" — kept as an explicit, secondary way to reach the same
 *                    Python delegation path (useful for deterministic
 *                    Node→Python integration testing without relying on
 *                    "gemini" also being the value under test). "gemini" is
 *                    no longer the only value that stays off Python, and
 *                    "test-python" is no longer the only value that reaches
 *                    it — both now do the identical thing.
 */
const PYTHON_ROUTED_PROVIDERS = new Set(["gemini", "test-python"]);

/**
 * Signal → deterministic Operational Context (Phase 3D, reused as-is) →
 * knowledge retrieval (Phase 6G, reused as-is) → AI interpretation
 * (Phase 4/5/6H) → durable persistence (Phase 7F-C). This module owns none
 * of the context assembly or retrieval logic — it only gathers what those
 * modules already produced, calls the provider, validates what comes back,
 * and persists the final trusted result via persistAndRespond below.
 *
 * Every call still re-generates a fresh interpretation from the current
 * operational facts (and, for the Python-routed path, current knowledge) —
 * generation itself is not cached or deduplicated (see the Phase 7F-C
 * duplicate/idempotency analysis in the implementation report). What
 * changed in Phase 7F-C is that the trusted result of each generation is
 * now saved as its own Intelligence record, not that repeated generation
 * requests are collapsed into one.
 *
 * `LLM_PROVIDER=openai` and `LLM_PROVIDER=test` still flow through
 * llmProvider.js, which as of Phase 5 Step 5 owns only those two providers
 * (its Gemini branch was removed as dead code once `gemini` started routing
 * to Python) — this path is NOT knowledge-grounded (see
 * intelligencePrompt.js's own note on why). `gemini` and `test-python`
 * route to Python and, as of Phase 6H, carry retrieved knowledge with
 * them; Node relays whatever provenance Python honestly reports rather
 * than assuming either one, since Python — not Node — knows which of its
 * own code paths it ran.
 */
/**
 * Phase 7F-C — persists the final, already-trusted intelligence result and
 * shapes the HTTP response. Called only after every validation/provenance-
 * trust step for the calling branch has already completed — this function
 * never receives raw Python/Gemini output. Persistence failure is never
 * swallowed: if createGeneratedIntelligence throws, this function throws
 * too, and the caller (signalController.js's asyncHandler) surfaces it as a
 * server error — the endpoint must never return a 200 with an intelligence
 * body that was not actually saved.
 *
 * The response keeps the exact flat contract this endpoint already returned
 * before this phase (summary/findings/risk/decision/action/outcome/
 * confidence/knowledgeProvenance/provenance) and only adds `_id`/
 * `createdAt` — the persisted record's durable identity — so existing
 * callers/tests that only assert the pre-existing fields are unaffected.
 */
async function persistAndRespond(scope, context, intelligence, provenance) {
  const guestId = context.guest?.available ? context.guest.id : undefined;
  const stayId = context.stay?.available ? context.stay.id : undefined;

  const saved = await createGeneratedIntelligence({
    workspaceId: scope,
    signalId: context.signal.id,
    guestId,
    stayId,
    signal: {
      summary: context.signal.title,
      type: context.signal.type,
      severity: context.signal.severity,
    },
    result: intelligence,
    provider: provenance.provider,
    model: provenance.model,
  });

  return {
    ...intelligence,
    _id: saved._id,
    createdAt: saved.createdAt,
    provenance,
  };
}

export async function generateSignalIntelligence(signalId, workspaceId, { testScenario } = {}) {
  const scope = requireObjectId(workspaceId, "workspaceId");
  const id = requireObjectId(signalId, "id");

  // Throws 404 for a missing/cross-tenant Signal before any AI call is made —
  // this happens before either Node's own providers or the Python service is
  // ever reached, so the tenant boundary is enforced identically either way.
  const context = await assembleSignalContext(id, scope);

  const provider = (process.env.LLM_PROVIDER || "").trim().toLowerCase();

  if (PYTHON_ROUTED_PROVIDERS.has(provider)) {
    const knowledge = await retrieveKnowledgeOrThrow(context, scope);
    const eligibleChunkIds = new Set(knowledge.map((item) => item.chunkId));

    const { raw, provider: pyProvider, model } = await requestIntelligenceFromAiService(context, knowledge);
    const intelligence = validateIntelligenceResult(raw);

    // Provenance cannot escape the retrieved result set for THIS request.
    // Python already cross-checks the model's own claim against what it
    // was actually supplied (ai-service/app/services/gemini_client.py's
    // _build_knowledge_provenance) — this is Node's own, independent
    // re-check against the trusted Phase 6G result it holds. Node is the
    // tenant/security authority; it never trusts Python's pass-through of
    // a model's claim at face value, only its own retrieval result.
    const trustedKnowledgeProvenance = intelligence.knowledgeProvenance.filter((item) =>
      eligibleChunkIds.has(item.chunkId),
    );

    return persistAndRespond(
      scope,
      context,
      { ...intelligence, knowledgeProvenance: trustedKnowledgeProvenance },
      { provider: pyProvider || "python", model: model || "unknown" },
    );
  }

  if (!isAiConfigured()) {
    throw new AppError("AI intelligence service is not configured.", 503);
  }

  const { systemPrompt, userPrompt } = buildIntelligencePrompt(context);
  const { raw, model } = await requestStructuredIntelligence({ systemPrompt, userPrompt, testScenario });
  const intelligence = validateIntelligenceResult(raw);
  const { provider: activeProvider } = getActiveProviderInfo();

  return persistAndRespond(scope, context, intelligence, { provider: activeProvider, model });
}

/**
 * Phase 6H correction: retrieval SUCCEEDING with zero eligible/relevant
 * chunks and retrieval FAILING are two materially different states, and
 * must never collapse into the same downstream behavior.
 *
 * - Zero results (retrieveKnowledgeForContext resolves normally with an
 *   empty `results` array) is a successful check that found nothing —
 *   intelligence generation continues, ungrounded, exactly as before.
 * - A failure (Python unreachable, a timeout, a malformed/rejected
 *   response, or any unexpected internal error — MongoDB included) must
 *   NEVER be silently treated as "nothing was found." Doing so would let
 *   an intelligence result look like the knowledge layer was checked when
 *   it never actually was — KOI is an operational intelligence system,
 *   and that distinction has to stay observable at the application
 *   boundary, not just in a server log. So this re-throws a controlled,
 *   clearly-tagged AppError instead of returning an empty list — the same
 *   "reject rather than silently coerce" discipline intelligenceSchema.js
 *   already applies to a malformed AI response.
 *
 * The original error's own status code is preserved when it's already a
 * classified AppError (e.g. 504 from a genuine timeout, 503 from
 * AI_SERVICE_URL not being configured) — only the message changes, to
 * carry the KNOWLEDGE_RETRIEVAL_UNAVAILABLE marker so this failure is
 * distinguishable from an intelligence-generation failure with the same
 * status code. Anything not already a classified AppError (e.g. a raw
 * MongoDB error) defaults to 502, matching how every other Python-
 * communication failure in this codebase is classified, and never leaks
 * the raw underlying error's own message.
 */
async function retrieveKnowledgeOrThrow(context, workspaceId) {
  try {
    const retrieval = await retrieveKnowledgeForContext(context, workspaceId);
    return retrieval.results;
  } catch (error) {
    console.error(
      "[KOI API] Knowledge retrieval failed — intelligence was not generated:",
      error?.name || "Error",
    );
    const statusCode = error instanceof AppError ? error.statusCode : 502;
    throw new AppError(
      "Knowledge retrieval failed (KNOWLEDGE_RETRIEVAL_UNAVAILABLE). Intelligence was not generated.",
      statusCode,
    );
  }
}
