import { AppError } from "../../utils/AppError.js";
import { requireObjectId } from "../../utils/objectId.js";
import { assembleSignalContext } from "../signalContextService.js";
import { buildIntelligencePrompt } from "./intelligencePrompt.js";
import { getActiveProviderInfo, isAiConfigured, requestStructuredIntelligence } from "./llmProvider.js";
import { requestIntelligenceFromAiService } from "./aiServiceClient.js";
import { validateIntelligenceResult } from "./intelligenceSchema.js";

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
 * Signal → deterministic Operational Context (Phase 3D, reused as-is) → AI
 * interpretation (Phase 4/5). This module owns none of that context
 * assembly — it only prompts, calls the provider, and validates what comes
 * back.
 *
 * Nothing here is persisted: every call re-generates a fresh interpretation
 * from the current operational facts. Ephemeral by design for this phase.
 *
 * `LLM_PROVIDER=openai` and `LLM_PROVIDER=test` still flow through
 * llmProvider.js, which as of Phase 5 Step 5 owns only those two providers
 * (its Gemini branch was removed as dead code once `gemini` started routing
 * to Python). `gemini` and `test-python` route to Python; Node relays
 * whatever provenance Python honestly reports rather than assuming either
 * one, since Python — not Node — knows which of its own code paths it ran.
 */
export async function generateSignalIntelligence(signalId, workspaceId, { testScenario } = {}) {
  const scope = requireObjectId(workspaceId, "workspaceId");
  const id = requireObjectId(signalId, "id");

  // Throws 404 for a missing/cross-tenant Signal before any AI call is made —
  // this happens before either Node's own providers or the Python service is
  // ever reached, so the tenant boundary is enforced identically either way.
  const context = await assembleSignalContext(id, scope);

  const provider = (process.env.LLM_PROVIDER || "").trim().toLowerCase();

  if (PYTHON_ROUTED_PROVIDERS.has(provider)) {
    const { raw, provider: pyProvider, model } = await requestIntelligenceFromAiService(context);
    const intelligence = validateIntelligenceResult(raw);

    return {
      ...intelligence,
      provenance: { provider: pyProvider || "python", model: model || "unknown" },
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
