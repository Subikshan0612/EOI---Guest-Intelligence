/**
 * Failure taxonomy for the analysis pipeline (Phase 35). PURE: a lookup table, no I/O, no environment.
 *
 * Every way an analysis attempt can fail already carries a stable `details.code` (aiServiceClient.js, analysisSchema.js, claimValidator.js,
 * safetyPolicy.js, proseConsistency.js, outputGuard.js, providerPolicy.js). Those codes are precise but numerous; operations and alerting
 * need a SMALL, closed set of CLASSES that call for different responses, so this maps each code to exactly one class:
 *
 *   configuration         the server is mis-configured (no AI service URL, no key, unapproved model/route): fix the deployment
 *   authentication        the provider rejected our credentials or permissions: rotate/fix the key
 *   invalid_request       the provider rejected the request itself: a bug on our side
 *   rate_limit            the provider is limiting us: back off, check quota
 *   provider_unavailable  the provider or the AI service cannot be reached / answered with a server fault: transient, check status pages
 *   provider_timeout      the provider (or the AI service) did not answer within its budget
 *   malformed_response    the provider/AI service answered, but not in the agreed format
 *   validation_failure    Node judged the answer INADMISSIBLE (schema, identity, claims, safety, prose, identifier): a model-quality or
 *                         policy signal, never an outage
 *   safety_block          the provider declined the content
 *   internal              anything else, including this application's own faults (database, bugs)
 *
 * An unrecognised code is "internal", never silently a nicer class: an operator should look at it.
 * It never reads a message, so it cannot be steered by text the model or a caller produced.
 */
export const FAILURE_CLASSES = Object.freeze([
  "configuration",
  "authentication",
  "invalid_request",
  "rate_limit",
  "provider_unavailable",
  "provider_timeout",
  "malformed_response",
  "validation_failure",
  "safety_block",
  "internal",
]);

const CLASS_BY_CODE = Object.freeze({
  // AI service -> Node (aiServiceClient.js) and Node's own transport codes
  AI_SERVICE_NOT_CONFIGURED: "configuration",
  PROVIDER_NOT_CONFIGURED: "configuration",
  PROVIDER_MODEL_NOT_APPROVED: "configuration",
  PROVIDER_ROUTE_NOT_APPROVED: "configuration",
  PROVIDER_AUTHENTICATION_FAILED: "authentication",
  PROVIDER_FORBIDDEN: "authentication",
  PROVIDER_BAD_REQUEST: "invalid_request",
  VALIDATION_FAILED: "invalid_request",
  PROVIDER_RATE_LIMITED: "rate_limit",
  PROVIDER_UNAVAILABLE: "provider_unavailable",
  PROVIDER_ERROR: "provider_unavailable",
  AI_SERVICE_UNREACHABLE: "provider_unavailable",
  PROVIDER_TIMEOUT: "provider_timeout",
  KNOWLEDGE_RETRIEVAL_BUDGET_EXHAUSTED: "provider_timeout",
  AI_SERVICE_TIMEOUT: "provider_timeout",
  MALFORMED_RESPONSE: "malformed_response",
  AI_SERVICE_MALFORMED_RESPONSE: "malformed_response",
  AI_SERVICE_INVALID_RESPONSE: "malformed_response",
  PROVIDER_SAFETY_BLOCK: "safety_block",
  PROVIDER_UNKNOWN_ERROR: "internal",
  // Node-side admissibility (Phase 28 / 34A-B / 34C / 34D)
  ANALYSIS_SCHEMA_INVALID: "validation_failure",
  PROVIDER_IDENTITY_MISMATCH: "validation_failure",
  CLAIM_VALIDATION_FAILED: "validation_failure",
  SAFETY_POLICY_VIOLATION: "validation_failure",
  PROSE_CONSISTENCY_VIOLATION: "validation_failure",
  OUTPUT_GUARD_VIOLATION: "validation_failure",
});

/** The failure class for a stable code. Unknown / missing -> "internal". */
export function classifyFailureCode(code) {
  return typeof code === "string" && Object.prototype.hasOwnProperty.call(CLASS_BY_CODE, code) ? CLASS_BY_CODE[code] : "internal";
}

/** The failure class of a thrown error (reads only `details.code`). */
export function classifyFailure(error) {
  return classifyFailureCode(error?.details?.code);
}

export const KNOWN_FAILURE_CODES = Object.freeze(Object.keys(CLASS_BY_CODE));
