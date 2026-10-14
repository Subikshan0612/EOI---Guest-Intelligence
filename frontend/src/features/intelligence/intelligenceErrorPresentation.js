/**
 * Phase 43D - how a FAILED analysis generation is presented to a person.
 *
 * The server rejects an analysis with a deterministic, stable reason (`details.code`, and for admissibility failures `details.rule`) and an HTTP status. Those are
 * for engineering, audit and tests - they stay on the server side (logs, the admission audit row) and on the wire as data. A person gets a plain sentence instead.
 *
 * This module is a CLOSED, deterministic mapping:
 *   - its input is ONLY the structured fields of the error: `status`, `code`, `rule` (never `message`, which can carry raw violation codes or reference-like text);
 *   - every output is a constant sentence written here - nothing from the server is ever echoed;
 *   - a code or rule it does not know falls back to a fixed generic sentence chosen by HTTP status; the unknown value itself is never shown;
 *   - there is no pattern matching and no text scanning: lookups are exact, own-property checks.
 * Presentation only. It does not decide whether an analysis is acceptable (the server did), and it never makes a rejected analysis look accepted.
 *
 * validate-phase43d-error-presentation.mjs ties these tables to the backend's own inventories (analysisFailureTaxonomy.js KNOWN_FAILURE_CODES and claimValidator.js
 * CLAIM_RULE_CODES), so a new reachable code that has no mapping fails the test instead of silently reaching users as a generic message.
 */
const TITLE_FAILED = "Analysis couldn't be completed";

const M = Object.freeze({
  generic: "The AI analysis could not be verified. No analysis was saved.",
  evidenceMissing: "The AI response did not provide enough supporting evidence to complete the analysis. No analysis was saved.",
  unverifiable: "The AI response could not be verified against the available information. No analysis was saved.",
  unknownReference: "The AI response referenced information that could not be verified. No analysis was saved.",
  safetyCriteria: "The AI response did not meet the required safety criteria. No analysis was saved.",
  inconsistent: "The AI response was inconsistent and could not be verified. No analysis was saved.",
  declined: "The AI service declined to analyse this content. No analysis was saved.",
  unavailable: "The AI analysis service is temporarily unavailable. Please try again.",
  network: "Cannot reach the EOI service. Check your connection and try again.",
  timeout: "The AI analysis took too long to complete. Please try again.",
  busy: "The analysis service is busy. Please wait a moment and try again.",
  badRequest: "The analysis request could not be processed. Please try again.",
  internal: "The AI analysis could not be completed. No analysis was saved.",
  interrupted: "The analysis was interrupted before it finished. No analysis was saved. Please try again.",
  notAvailable: "AI analysis isn't available right now. Please contact your administrator.",
  unauthenticated: "Your session has expired. Please sign in again.",
  forbidden: "You are not authorized to perform this action.",
  request: "The request could not be completed. No analysis was saved.",
});

// retryable: a later explicit click may succeed (a model answer can differ, a service can recover). It is a possibility, never a promise.
const entry = (message, { retryable = true, title = TITLE_FAILED } = {}) => Object.freeze({ title, message, retryable });
const E = Object.freeze({
  generic: entry(M.generic),
  evidenceMissing: entry(M.evidenceMissing),
  unverifiable: entry(M.unverifiable),
  unknownReference: entry(M.unknownReference),
  safetyCriteria: entry(M.safetyCriteria),
  inconsistent: entry(M.inconsistent),
  declined: entry(M.declined),
  unavailable: entry(M.unavailable),
  network: entry(M.network),
  timeout: entry(M.timeout),
  busy: entry(M.busy),
  badRequest: entry(M.badRequest),
  internal: entry(M.internal),
  interrupted: entry(M.interrupted),
  notAvailable: entry(M.notAvailable, { retryable: false, title: "Analysis unavailable" }),
  unauthenticated: entry(M.unauthenticated, { retryable: false, title: "Session expired" }),
  forbidden: entry(M.forbidden, { retryable: false, title: "Not authorized" }),
  request: entry(M.request),
});

// Admissibility rule codes (claimValidator.js CLAIM_RULE_CODES; the AI service can send the same constants) -> how to say it.
const BY_RULE = Object.freeze({
  CLAIM_MISSING_SOURCE_REFS: E.evidenceMissing,
  CLAIM_MISSING_REQUIRED_EVIDENCE: E.evidenceMissing,
  CLAIM_NO_RECOMMENDATION: E.evidenceMissing,
  CLAIM_INVALID_FACT_SUPPORT: E.unverifiable,
  CLAIM_INVALID_HISTORICAL_PATTERN: E.unverifiable,
  CLAIM_INVALID_BUSINESS_GUIDANCE: E.unverifiable,
  CLAIM_INVALID_LEARNING_OBSERVATION: E.unverifiable,
  CLAIM_UNSUPPORTED_RECOMMENDATION: E.unverifiable,
  CLAIM_EVIDENCE_TYPE_MISMATCH: E.unverifiable,
  CLAIM_UNKNOWN_REF: E.unknownReference,
  CLAIM_FOREIGN_REF: E.unknownReference,
  CLAIM_DUPLICATE_REF: E.unknownReference,
  CLAIM_MALFORMED: E.generic,
  CLAIM_TOO_MANY: E.generic,
  CLAIM_UNKNOWN_TYPE: E.generic,
});

// The only codes a rule may refine (a rule attached to anything else is ignored).
const RULE_REFINES = Object.freeze(["CLAIM_VALIDATION_FAILED", "MALFORMED_RESPONSE", "AI_SERVICE_MALFORMED_RESPONSE", "AI_SERVICE_INVALID_RESPONSE"]);

// `details.code` -> how to say it (analysisFailureTaxonomy.js KNOWN_FAILURE_CODES, plus the HTTP-layer and client codes a generation request can meet).
const BY_CODE = Object.freeze({
  // admission / validation on the server
  CLAIM_VALIDATION_FAILED: E.unverifiable,
  SAFETY_POLICY_VIOLATION: E.safetyCriteria,
  PROSE_CONSISTENCY_VIOLATION: E.inconsistent,
  OUTPUT_GUARD_VIOLATION: E.unknownReference,
  ANALYSIS_SCHEMA_INVALID: E.generic,
  PROVIDER_IDENTITY_MISMATCH: E.generic,
  // malformed model / service output
  MALFORMED_RESPONSE: E.generic,
  AI_SERVICE_MALFORMED_RESPONSE: E.generic,
  AI_SERVICE_INVALID_RESPONSE: E.generic,
  // the provider declined the content
  PROVIDER_SAFETY_BLOCK: E.declined,
  // availability
  PROVIDER_UNAVAILABLE: E.unavailable,
  PROVIDER_ERROR: E.unavailable,
  AI_SERVICE_UNREACHABLE: E.unavailable,
  CLIENT_NETWORK: E.network,
  // time
  PROVIDER_TIMEOUT: E.timeout,
  AI_SERVICE_TIMEOUT: E.timeout,
  KNOWLEDGE_RETRIEVAL_BUDGET_EXHAUSTED: E.timeout,
  CLIENT_TIMEOUT: E.timeout,
  // rate limits
  PROVIDER_RATE_LIMITED: E.busy,
  RATE_LIMITED: E.busy,
  // server-side configuration: nothing a user can fix by retrying
  AI_SERVICE_NOT_CONFIGURED: E.notAvailable,
  PROVIDER_NOT_CONFIGURED: E.notAvailable,
  PROVIDER_MODEL_NOT_APPROVED: E.notAvailable,
  PROVIDER_ROUTE_NOT_APPROVED: E.notAvailable,
  PROVIDER_AUTHENTICATION_FAILED: E.notAvailable,
  PROVIDER_FORBIDDEN: E.notAvailable,
  // a fault on our side of the contract
  PROVIDER_BAD_REQUEST: E.badRequest,
  VALIDATION_FAILED: E.badRequest,
  PROVIDER_UNKNOWN_ERROR: E.internal,
  INTERNAL_ERROR: E.internal,
  // Workstream 5B: the attempt's process ended before it finished (a restart or crash); a person may ask again
  ATTEMPT_INTERRUPTED: E.interrupted,
});

const known = (table, key) => typeof key === "string" && Object.prototype.hasOwnProperty.call(table, key);

/**
 * @param {{status?: number, code?: string, rule?: string} | null | undefined} failure the structured fields of an ApiError (only these are read)
 * @returns {{title: string, message: string, retryable: boolean}} constants only
 */
export function presentGenerationFailure(failure) {
  const status = Number(failure?.status) || 0;
  const code = failure?.code;
  const rule = failure?.rule;

  // Who-you-are failures come first and are decided by the HTTP status (the server's own decision), whatever code or text came with them.
  if (status === 401) return E.unauthenticated;
  if (status === 403) return E.forbidden;

  if (known(RULE_REFINES_SET, code) && known(BY_RULE, rule)) return BY_RULE[rule];
  if (known(BY_CODE, code)) return BY_CODE[code];

  // Unknown or absent code: a generic sentence chosen by status only. The unknown code itself is never shown.
  if (status === 0) return E.network;
  if (status === 429) return E.busy;
  if (status === 503) return E.unavailable;
  if (status === 504) return E.timeout;
  if (status === 422) return E.declined;
  if (status >= 500) return E.generic;
  if (status >= 400) return E.request;
  return E.generic;
}

const RULE_REFINES_SET = Object.freeze(Object.fromEntries(RULE_REFINES.map((c) => [c, true])));

// Exposed for validate-phase43d-error-presentation.mjs (the tie to the backend inventories). Not used by any component.
export const PRESENTED_FAILURES = Object.freeze({ codes: Object.freeze(Object.keys(BY_CODE)), rules: Object.freeze(Object.keys(BY_RULE)) });
export const GENERIC_FAILURE = E.generic;
