import { validateAnalysisResult } from "../../src/services/ai/analysisSchema.js";
import { buildEvidenceReferenceIndex } from "../../src/services/ai/evidenceReferenceIndex.js";

/**
 * Phase 33 §8 — reuses Phase 28's OWN production evidence validator and reference index, unmodified, against
 * a real model's raw response. This is the exact same authority the real application would apply; nothing
 * about Phase 33 re-implements or loosens it.
 */
export function evaluateGrounding(testCase, rawResponse) {
  const retrievedChunkIds = new Set((testCase.knowledge || []).map((k) => k.chunkId));
  const index = buildEvidenceReferenceIndex(testCase.context, testCase.operationalHistory || { intelligence: [], decisions: [] }, [...retrievedChunkIds]);
  try {
    const validated = validateAnalysisResult(rawResponse, retrievedChunkIds, index);
    return { schemaValid: true, analysis: validated, error: null };
  } catch (error) {
    return { schemaValid: false, analysis: null, error: error.message };
  }
}
