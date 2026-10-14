import { DEFAULT_RETRIEVAL_MIN_SIMILARITY } from "../../config/runtimeConfig.js";
import { BUSINESS_KNOWLEDGE, CURRENT_OPERATIONAL_FACT } from "./evidenceEnvelope.js";

/**
 * Server-owned confidence ceiling (Phase 34D).
 *
 * `confidence` is the model's own statement of how well the evidence supports its analysis ("high" | "medium" | "low" - the
 * project's existing evidence-quality CLASS, never a probability). Phase 34C.1 observed Gemini 3.1 Flash-Lite answering "high"
 * on 18 of 18 responses, 9 of them with "no documented guidance was found". A model must not be the authority on how much it
 * should be believed, so Node derives the HIGHEST confidence the evidence admits and the final confidence is
 *
 *     final = min(model's confidence, server ceiling)
 *
 * The model may always be MORE conservative than the ceiling; it can never be less. Nothing here can raise a confidence.
 *
 * CAP, NOT REJECT. Confidence is not a safety property (the safety minimum is enforced separately and unconditionally, in
 * safetyPolicy.js, whatever the confidence says), the API field is a closed three-value enum that already means "evidence
 * quality", and rejecting an otherwise admissible analysis for being overconfident would turn a calibration defect into an
 * availability defect. So the stored value is lowered, additively: no new level, no new field in the public contract.
 *
 * The ceiling follows the semantics the project already states (the grounding prompt's HIGH / MEDIUM / LOW definitions) and
 * uses only deterministic evidence metadata - claim types, the source CLASS of each cited reference, and the resolved context:
 *
 *   LOW     the analysis states no FACT resting on a CURRENT_OPERATIONAL_FACT, or no RECOMMENDATION resting on a current fact
 *           or on business knowledge: the current situation is not established by current evidence.
 *   MEDIUM  a current-fact FACT AND a supported RECOMMENDATION exist, but at least one of these holds:
 *             - no RECOMMENDATION cites BUSINESS_KNOWLEDGE (nothing documented grounds the recommended step);
 *             - neither the property nor the unit of the Signal was resolved (the location is unknown);
 *             - the analysis itself reports a contradiction between sources.
 *   HIGH    a current-fact FACT, a RECOMMENDATION that cites business knowledge, a resolved property or unit, and no reported
 *           contradiction.
 *
 * History, Learning and the Signal's free text are never counted as support, so none of them can raise the ceiling. There is
 * no regular-expression or language model involved: this reads claim types and reference classes, nothing else.
 *
 * Phase 35 - KNOWLEDGE RELEVANCE. "A chunk was retrieved" is not by itself "the recommendation is knowledge-backed". A chunk
 * grounds a recommendation here only when its OWN retrieval metadata says it is relevant: a finite raw-cosine `similarityScore`
 * that meets the relevance floor. The floor is the server's retrieval floor but NEVER below the default (a deliberately disabled
 * retrieval floor, which test harnesses use, cannot inflate a confidence). No new threshold and no judge is introduced - this
 * re-applies the existing floor to the metadata Node already holds. HONEST LIMIT (docs/REAL_EMBEDDING_EVALUATION_PHASE26_5.md):
 * with the real embedding model the 0.25 floor is inert, so in production every retrieved chunk passes and this rule is a
 * defence in depth against missing or sub-floor metadata, not a relevance classifier. Calibration is a separate, measured task.
 * A knowledge item without `similarityScore` metadata never grounds anything (fail closed).
 */
export const CONFIDENCE_LEVELS = Object.freeze(["low", "medium", "high"]);

const rank = (level) => CONFIDENCE_LEVELS.indexOf(level);

/**
 * @param {object} input
 * @param {unknown} input.claims          the analysis' claims (already validated in the production path)
 * @param {object} input.envelope         the request's evidence envelope (classOf)
 * @param {object} input.context          the bounded operational context
 * @param {unknown} [input.contradictions]
 * @param {boolean} [input.strict]        false only for the deterministic test provider in development/test with NO claims
 * @returns {{ceiling: ("low"|"medium"|"high"|null), reasons: string[], support: object}}
 *   ceiling null = "no cap applies" (compatibility mode only: nothing was claimed, so nothing can be assessed)
 */
export function deriveConfidenceCeiling({ claims, envelope, context, contradictions, strict = true, knowledge, minSimilarity }) {
  const list = Array.isArray(claims) ? claims : [];
  const floor = Math.max(DEFAULT_RETRIEVAL_MIN_SIMILARITY, Number.isFinite(minSimilarity) ? minSimilarity : DEFAULT_RETRIEVAL_MIN_SIMILARITY);
  // References of the retrieved chunks whose own metadata says they are relevant. A missing `knowledge` list means none is.
  const relevantKnowledge = new Set(
    (Array.isArray(knowledge) ? knowledge : [])
      .filter((chunk) => typeof chunk?.chunkId === "string" && Number.isFinite(chunk.similarityScore) && chunk.similarityScore >= floor)
      .map((chunk) => `knowledge:${chunk.chunkId}`),
  );
  const classOfRef = (ref) => {
    const evidenceClass = envelope.classOf(ref);
    // A retrieved chunk that is not demonstrably relevant carries no evidential weight for confidence.
    return evidenceClass === BUSINESS_KNOWLEDGE && !relevantKnowledge.has(ref) ? undefined : evidenceClass;
  };
  const classesOf = (claim) => (Array.isArray(claim?.sourceRefs) ? claim.sourceRefs : []).map(classOfRef).filter(Boolean);

  const currentFactClaim = list.some((c) => c?.claimType === "FACT" && classesOf(c).includes(CURRENT_OPERATIONAL_FACT));
  const supportedRecommendation = list.some((c) => c?.claimType === "RECOMMENDATION" && classesOf(c).some((k) => k === CURRENT_OPERATIONAL_FACT || k === BUSINESS_KNOWLEDGE));
  const knowledgeGroundedRecommendation = list.some((c) => c?.claimType === "RECOMMENDATION" && classesOf(c).includes(BUSINESS_KNOWLEDGE));
  const locationResolved = Boolean(context?.property?.available || context?.unit?.available);
  const contradictionsReported = Array.isArray(contradictions) && contradictions.length > 0;
  const support = { currentFactClaim, supportedRecommendation, knowledgeGroundedRecommendation, locationResolved, contradictionsReported };

  if (list.length === 0) {
    return strict
      ? { ceiling: "low", reasons: ["NO_CLAIMS"], support }
      : { ceiling: null, reasons: ["NO_CLAIMS_COMPATIBILITY_MODE"], support };
  }

  const reasons = [];
  if (!currentFactClaim) reasons.push("NO_CURRENT_FACT_CLAIM");
  if (!supportedRecommendation) reasons.push("RECOMMENDATION_UNSUPPORTED");
  if (reasons.length > 0) return { ceiling: "low", reasons, support };

  if (!knowledgeGroundedRecommendation) reasons.push("NO_KNOWLEDGE_GROUNDED_RECOMMENDATION");
  if (!locationResolved) reasons.push("LOCATION_UNRESOLVED");
  if (contradictionsReported) reasons.push("CONTRADICTIONS_REPORTED");
  return { ceiling: reasons.length > 0 ? "medium" : "high", reasons, support };
}

/**
 * final = min(model, ceiling). An unrecognized model value is treated as the lowest level (the schema already rejects it
 * upstream; this keeps the function total and fail-closed on its own). A null ceiling applies no cap.
 * @returns {{confidence: string, modelConfidence: string, ceiling: (string|null), capped: boolean}}
 */
export function applyConfidenceCeiling(modelConfidence, ceilingInfo) {
  const model = CONFIDENCE_LEVELS.includes(modelConfidence) ? modelConfidence : "low";
  const ceiling = ceilingInfo?.ceiling ?? null;
  if (ceiling === null) return { confidence: model, modelConfidence: model, ceiling: null, capped: false };
  const confidence = rank(model) <= rank(ceiling) ? model : ceiling;
  return { confidence, modelConfidence: model, ceiling, capped: confidence !== model };
}
