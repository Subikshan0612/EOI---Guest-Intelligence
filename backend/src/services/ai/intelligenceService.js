import { AppError } from "../../utils/AppError.js";
import { requireObjectId } from "../../utils/objectId.js";
import { assembleSignalContext } from "../signalContextService.js";
import { buildIntelligencePrompt } from "./intelligencePrompt.js";
import { getActiveProviderInfo, isAiConfigured, requestStructuredIntelligence } from "./llmProvider.js";
import { validateIntelligenceResult } from "./intelligenceSchema.js";

/**
 * Signal → deterministic Operational Context (Phase 3D, reused as-is) → AI
 * interpretation (Phase 4). This module owns none of that context assembly —
 * it only prompts, calls the provider, and validates what comes back.
 *
 * Nothing here is persisted: every call re-generates a fresh interpretation
 * from the current operational facts. Ephemeral by design for this phase.
 */
export async function generateSignalIntelligence(signalId, workspaceId, { testScenario } = {}) {
  const scope = requireObjectId(workspaceId, "workspaceId");
  const id = requireObjectId(signalId, "id");

  // Throws 404 for a missing/cross-tenant Signal before any AI call is made.
  const context = await assembleSignalContext(id, scope);

  if (!isAiConfigured()) {
    throw new AppError("AI intelligence service is not configured.", 503);
  }

  const { systemPrompt, userPrompt } = buildIntelligencePrompt(context);
  const { raw, model } = await requestStructuredIntelligence({ systemPrompt, userPrompt, testScenario });
  const intelligence = validateIntelligenceResult(raw);
  const { provider } = getActiveProviderInfo();

  return {
    ...intelligence,
    provenance: { provider, model },
  };
}
