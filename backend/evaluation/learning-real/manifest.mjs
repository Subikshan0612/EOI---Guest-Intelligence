import { CASES, DATASET_VERSION, EVALUATION_CUTOFF } from "./dataset.mjs";

/** Phase 33 §1 - printed/written before any real model call. Never includes a key or secret. */
export function buildManifest({ provider, model, repetitions }) {
  const knowledgeChunks = CASES.reduce((n, c) => n + (c.knowledge?.length || 0), 0);
  const learningPatterns = CASES.reduce((n, c) => n + (c.learning?.patterns?.length || 0), 0);
  const totalChars = CASES.reduce((n, c) => n + JSON.stringify(c.context).length + JSON.stringify(c.knowledge || []).length + JSON.stringify(c.operationalHistory || {}).length + JSON.stringify(c.learning || {}).length, 0);
  return {
    evaluationVersion: DATASET_VERSION,
    evaluationCutoff: EVALUATION_CUTOFF,
    generatedAt: new Date().toISOString(),
    cases: CASES.length,
    adversarialCases: CASES.filter((c) => c.adversarial).length,
    signals: CASES.length, // exactly one Signal per case
    knowledgeChunks,
    learningPatterns,
    approxTotalCharacters: totalChars,
    provider,
    model,
    repetitionsPerArm: repetitions,
    armsPerCase: 2,
    maxGenerationCalls: CASES.length * 2 * repetitions,
    embeddingCalls: 0, // this harness never embeds anything - every KnowledgeItem is already a pre-scored, hand-authored synthetic chunk
  };
}
