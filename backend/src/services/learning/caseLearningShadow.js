import { buildCurrentCaseProfile, loadCompletedCases } from "./completedCaseService.js";
import { selectSimilarCases } from "./caseSimilarity.js";
import { buildLearningObservation } from "./caseLearningObservation.js";

/**
 * Case-based Learning L1 - the SHADOW path. An isolated, internal, READ-ONLY evaluation entry point that produces the Learning Observation for a Signal so that it can be
 * evaluated (L1 tests, and later offline evaluation) WITHOUT feeding it into anything.
 *
 * It is deliberately NOT part of the production Intelligence path:
 *   - no route, controller or other service imports this module; intelligenceAnalysisService.js does not know it exists (validate-learning-l1 proves this statically);
 *   - it reads KOI_LEARNING_CONTEXT_ENABLED nowhere and does not change what that flag does: the existing aggregate Learning (Phases 31/32) stays exactly as it was, OFF;
 *   - it writes nothing (no Intelligence field, no AnalysisAdmission field, no log of case content) and has no parameter for a model output;
 *   - its result is returned to the caller and goes nowhere else: it is never persisted, never sent to the AI service, and never shown to an operator.
 * Wiring an observation into the model request would be a separate, reviewed phase (the evidence envelope already has a LEARNING_CONTEXT class for it).
 *
 * @param {{ workspaceId: string, signalId: string }} args both validated as ObjectIds; the Signal must belong to the workspace (404 otherwise)
 * @returns {Promise<{ observation: object, selection: object, derivation: object }>}
 *   observation  the closed-shape, deep-frozen server-derived summary (caseLearningObservation.js)
 *   selection    evaluation metadata: how many cases were compared, why each excluded one was excluded (counts), and the selected cases as { caseKey, score, relevance, matched }
 *                (caseKey is an opaque hash, not a database id)
 *   derivation   how many Outcomes were considered and why some chains were not completed cases (counts by fixed reason)
 */
export async function deriveShadowLearningObservation({ workspaceId, signalId }) {
  const { profile, signalId: currentSignalId } = await buildCurrentCaseProfile(workspaceId, signalId);
  const { cases, considered, rejected } = await loadCompletedCases(workspaceId, { excludeSignalId: currentSignalId });
  const selection = selectSimilarCases(profile, cases, { currentSignalId });
  const observation = buildLearningObservation(selection, { safetyCondition: profile.safety.state });
  return {
    observation,
    selection: {
      similarityVersion: selection.similarityVersion, evaluated: selection.evaluated, excluded: selection.excluded, weakMatchCount: selection.weakMatchCount,
      selected: selection.selected.map((s) => ({ caseKey: s.case.internal.caseKey, score: s.score, relevance: s.relevance, matched: s.matched })),
    },
    derivation: { outcomesConsidered: considered, completedCases: cases.length, rejected },
  };
}
