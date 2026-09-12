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

/** JSON Schema handed to the provider's structured-output mode. */
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
  };
}
