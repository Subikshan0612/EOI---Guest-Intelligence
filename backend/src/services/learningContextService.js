import { ACTION_TYPES } from "../models/Action.js";
import { getOutcomeLearningPatterns, LEARNING_VERSION, MINIMUM_SAMPLE_SIZE } from "./outcomeLearningService.js";
import { LEARNING_CONTEXT_CONTRACT_VERSION, validateLearningPayload } from "./learningContextContract.js";

/**
 * Phase 32 - the ONLY bridge between Phase 31's read-only Learning V1 aggregate and the canonical
 * Intelligence pipeline. Used EXCLUSIVELY by intelligenceAnalysisService.js, and only when
 * `KOI_LEARNING_CONTEXT_ENABLED=true` (runtimeConfig.js) - a server-side-only flag, never client-controlled,
 * default false (see backend/docs/LEARNING_INTELLIGENCE_PHASE32.md).
 *
 * Trust boundary (never the other direction):
 *   Outcome (V1, immutable) -> Action (V1) -> Learning V1 (outcomeLearningService.js, Phase 31)
 *     -> Learning CONTEXT (this file, bounded/validated) -> Intelligence prompt
 * A newly generated Intelligence record, Decision, or Action proposal/approval never feeds back into this
 * function or into Phase 31's aggregate - only a recorded, trusted Outcome can ever change what this
 * returns. This module makes no write of any kind.
 *
 * Selection is deterministic and entirely server-controlled: it always asks Phase 31 for the complete closed
 * ACTION_TYPES set (exactly 5 rows, always in the same order, Phase 29's own tiny allowlist) rather than
 * attempting any relevance judgment - there is no mechanism by which a client or the model could influence
 * which patterns are included (Phase 32 spec §17).
 */
export async function buildLearningContext(workspaceId) {
  const report = await getOutcomeLearningPatterns({ workspaceId });

  const patterns = ACTION_TYPES.map((actionType) => {
    const row = report.patterns.find((p) => p.actionType === actionType);
    // Defensive: Phase 31 always returns one row per ACTION_TYPES value, but this function never trusts that
    // invariant blindly - a missing row becomes an honest all-zero pattern rather than a thrown error.
    const counts = row?.outcomeCounts ?? { success: 0, failed: 0, partial: 0, unknown: 0 };
    return {
      actionType,
      sampleSize: row?.determinedOutcomeCount ?? 0,
      successCount: counts.success,
      failedCount: counts.failed,
      partialCount: counts.partial,
      successRate: row?.successRate ?? null,
      eligible: row?.eligible ?? false,
    };
  });

  const learning = {
    learningVersion: LEARNING_CONTEXT_CONTRACT_VERSION,
    minimumSampleSize: MINIMUM_SAMPLE_SIZE,
    windowDays: Math.round((new Date(report.window.to).getTime() - new Date(report.window.from).getTime()) / (24 * 60 * 60 * 1000)),
    patterns,
  };

  // Fail closed (operationalContextContract.js's exact convention): a contract violation here means no AI
  // request is ever sent with partial/uncertain Learning data (Phase 32 spec §21).
  return validateLearningPayload(learning);
}

// Re-exported only so callers/tests can assert this module's own Learning version tracks Phase 31's,
// without importing outcomeLearningService.js twice for the same constant.
export { LEARNING_VERSION as PHASE31_LEARNING_VERSION };
