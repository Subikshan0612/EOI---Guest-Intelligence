import { AppError } from "../../utils/AppError.js";

/**
 * The strict, structured Signal Intelligence contract (Phase 4).
 *
 * This is the ONLY shape the AI intelligence pipeline is allowed to return.
 * The LLM interprets the operational context it is given — it never
 * originates operational facts — so nothing here is treated as trustworthy
 * until it passes this validation.
 */
export const RISK_LEVELS = ["low", "medium", "high", "critical"];
export const ACTION_PRIORITIES = ["low", "medium", "high"];
export const KNOWLEDGE_SCOPES = ["unit", "property", "workspace"];

/**
 * JSON Schema handed to the provider's structured-output mode. Used only
 * by the direct Node->OpenAI path in llmProvider.js — the Python-delegated
 * path (LLM_PROVIDER=gemini/test-python, KOI's production route) has its
 * own separate, knowledge-grounding-aware schema
 * (ai-service/app/services/gemini_client.py's GEMINI_RESPONSE_SCHEMA).
 * This one is deliberately NOT extended with knowledge fields in Phase
 * 6H — see intelligenceService.js and CLAUDE.md's AI/RAG boundaries
 * section for why grounding lives only on the Python-delegated path.
 */
export const INTELLIGENCE_JSON_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    findings: { type: "array", items: { type: "string" } },
    risk: {
      type: "object",
      properties: {
        level: { type: "string", enum: RISK_LEVELS },
        reason: { type: "string" },
      },
      required: ["level", "reason"],
      additionalProperties: false,
    },
    decision: {
      type: "object",
      properties: {
        recommendation: { type: "string" },
        rationale: { type: "string" },
      },
      required: ["recommendation", "rationale"],
      additionalProperties: false,
    },
    action: {
      type: "object",
      properties: {
        label: { type: "string" },
        recommended: {
          type: "array",
          items: {
            type: "object",
            properties: {
              step: { type: "string" },
              priority: { type: "string", enum: ACTION_PRIORITIES },
            },
            required: ["step", "priority"],
            additionalProperties: false,
          },
        },
      },
      required: ["label", "recommended"],
      additionalProperties: false,
    },
    outcome: {
      type: "object",
      properties: {
        expected: { type: "string" },
      },
      required: ["expected"],
      additionalProperties: false,
    },
    confidence: { type: "number" },
  },
  required: ["summary", "findings", "risk", "decision", "action", "outcome", "confidence"],
  additionalProperties: false,
};

function fail(reason) {
  throw new AppError(`AI intelligence service returned an invalid response (${reason}).`, 502);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Phase 6H — one item of `raw.knowledgeProvenance`. This is Python's own
 * (already cross-checked against what it was actually supplied — see
 * ai-service/app/services/gemini_client.py's _build_knowledge_provenance)
 * report of which retrieved knowledge materially influenced the result.
 * Node still validates every field's shape here — the same "never trust
 * the raw response until it passes this validation" rule as every other
 * field — and, one layer further out, intelligenceService.js independently
 * re-checks each chunkId against its own Phase 6G retrieval result before
 * this ever reaches a caller (provenance cannot escape the retrieved
 * result set for THIS request, not just "was validly shaped").
 */
function isValidKnowledgeProvenanceItem(item) {
  return (
    item !== null &&
    typeof item === "object" &&
    isNonEmptyString(item.chunkId) &&
    isNonEmptyString(item.knowledgeDocumentId) &&
    Number.isInteger(item.version) &&
    item.version >= 1 &&
    KNOWLEDGE_SCOPES.includes(item.scope) &&
    typeof item.section === "string" &&
    Number.isInteger(item.chunkIndex) &&
    item.chunkIndex >= 0 &&
    typeof item.similarityScore === "number" &&
    Number.isFinite(item.similarityScore) &&
    typeof item.retrievalScore === "number" &&
    Number.isFinite(item.retrievalScore)
  );
}

/**
 * Validates and normalizes a parsed AI response against the contract above.
 * Rejects (rather than silently coercing) anything out of range — an
 * out-of-scale confidence value or an unrecognized risk level is treated as
 * a malformed response, not "close enough".
 */
export function validateIntelligenceResult(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("not an object");

  if (!isNonEmptyString(raw.summary)) fail("missing summary");

  if (!Array.isArray(raw.findings) || !raw.findings.every((item) => typeof item === "string")) {
    fail("invalid findings");
  }

  if (!raw.risk || typeof raw.risk !== "object") fail("missing risk");
  if (!RISK_LEVELS.includes(raw.risk.level)) fail("invalid risk level");
  if (!isNonEmptyString(raw.risk.reason)) fail("missing risk reason");

  if (!raw.decision || typeof raw.decision !== "object") fail("missing decision");
  if (!isNonEmptyString(raw.decision.recommendation)) fail("missing decision recommendation");
  if (typeof raw.decision.rationale !== "string") fail("invalid decision rationale");

  if (!raw.action || typeof raw.action !== "object") fail("missing action");
  if (!isNonEmptyString(raw.action.label)) fail("missing action label");
  if (!Array.isArray(raw.action.recommended)) fail("invalid action.recommended");
  for (const step of raw.action.recommended) {
    if (
      !step ||
      typeof step !== "object" ||
      !isNonEmptyString(step.step) ||
      !ACTION_PRIORITIES.includes(step.priority)
    ) {
      fail("invalid action step");
    }
  }

  if (!raw.outcome || typeof raw.outcome !== "object" || typeof raw.outcome.expected !== "string") {
    fail("missing outcome");
  }

  if (
    typeof raw.confidence !== "number" ||
    !Number.isFinite(raw.confidence) ||
    raw.confidence < 0 ||
    raw.confidence > 1
  ) {
    fail("invalid confidence");
  }

  // Phase 6H — optional and absent for every pre-6H caller/fixture
  // (openai/test never populate it at all). Present-but-malformed is
  // still rejected outright, same as every other field here.
  let knowledgeProvenance = [];
  if (raw.knowledgeProvenance !== undefined) {
    if (!Array.isArray(raw.knowledgeProvenance) || !raw.knowledgeProvenance.every(isValidKnowledgeProvenanceItem)) {
      fail("invalid knowledgeProvenance");
    }
    knowledgeProvenance = raw.knowledgeProvenance;
  }

  return {
    summary: raw.summary.trim(),
    findings: raw.findings.map((item) => item.trim()).filter(Boolean),
    risk: { level: raw.risk.level, reason: raw.risk.reason.trim() },
    decision: {
      recommendation: raw.decision.recommendation.trim(),
      rationale: raw.decision.rationale.trim(),
    },
    action: {
      label: raw.action.label.trim(),
      recommended: raw.action.recommended.map((item) => ({
        step: item.step.trim(),
        priority: item.priority,
      })),
    },
    outcome: { expected: raw.outcome.expected.trim() },
    confidence: raw.confidence,
    knowledgeProvenance: knowledgeProvenance.map((item) => ({
      chunkId: item.chunkId,
      knowledgeDocumentId: item.knowledgeDocumentId,
      version: item.version,
      scope: item.scope,
      section: item.section,
      chunkIndex: item.chunkIndex,
      similarityScore: item.similarityScore,
      retrievalScore: item.retrievalScore,
    })),
  };
}
