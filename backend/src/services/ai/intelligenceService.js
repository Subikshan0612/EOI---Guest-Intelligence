import { AppError } from "../../utils/AppError.js";
import { requireObjectId } from "../../utils/objectId.js";
import { assembleSignalContext } from "../signalContextService.js";
import { buildIntelligencePrompt } from "./intelligencePrompt.js";
import { getActiveProviderInfo, isAiConfigured, requestStructuredIntelligence } from "./llmProvider.js";
import { requestIntelligenceFromAiService } from "./aiServiceClient.js";
import { validateIntelligenceResult } from "./intelligenceSchema.js";

const PYTHON_TEST_PROVIDER = "test-python";

/**
 * Signal → deterministic Operational Context (Phase 3D, reused as-is) → AI
 * interpretation (Phase 4/5). This module owns none of that context
 * assembly — it only prompts, calls the provider, and validates what comes
 * back.
 *
 * Nothing here is persisted: every call re-generates a fresh interpretation
 * from the current operational facts. Ephemeral by design for this phase.
 *
 * `LLM_PROVIDER=test-python` (Phase 5 Step 3) is a separate, explicitly-opt-in
 * branch that routes to the Python AI service's deterministic stub instead
 * of llmProvider.js's gemini/openai/test paths. It is intentionally handled
 * here rather than inside llmProvider.js, which stays completely unmodified —
 * the existing gemini/openai/test modes are unaffected by this addition.
 */
export async function generateSignalIntelligence(signalId, workspaceId, { testScenario } = {}) {
  const scope = requireObjectId(workspaceId, "workspaceId");
  const id = requireObjectId(signalId, "id");

  // Throws 404 for a missing/cross-tenant Signal before any AI call is made —
  // this happens before either the Node providers or the Python service is
  // ever reached, so the tenant boundary is enforced identically either way.
  const context = await assembleSignalContext(id, scope);

  const provider = (process.env.LLM_PROVIDER || "").trim().toLowerCase();

  if (provider === PYTHON_TEST_PROVIDER) {
    const { raw, model } = await requestIntelligenceFromAiService(context);
    const intelligence = validateIntelligenceResult(raw);

    return {
      ...intelligence,
      provenance: { provider: PYTHON_TEST_PROVIDER, model: model || "unknown" },
    };
  }

  if (!isAiConfigured()) {
    throw new AppError("AI intelligence service is not configured.", 503);
  }

  const { systemPrompt, userPrompt } = buildIntelligencePrompt(context);
  const { raw, model } = await requestStructuredIntelligence({ systemPrompt, userPrompt, testScenario });
  const intelligence = validateIntelligenceResult(raw);
  const { provider: activeProvider } = getActiveProviderInfo();

  return {
    ...intelligence,
    provenance: { provider: activeProvider, model },
  };
}
