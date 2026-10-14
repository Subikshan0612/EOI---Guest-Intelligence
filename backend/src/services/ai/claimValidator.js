import { AppError } from "../../utils/AppError.js";
import {
  BUSINESS_KNOWLEDGE, CURRENT_OPERATIONAL_FACT, LEARNING_CONTEXT, OPERATIONAL_HISTORY, UNTRUSTED_SIGNAL,
} from "./evidenceEnvelope.js";

/**
 * Claim-level admissibility (Phase 34C) - the "Node validates admissibility" half.
 *
 * The model returns `claims`: each {claimType, text, sourceRefs}. This module decides, deterministically and without
 * reading the text for meaning, whether each claim rests on sources a claim of that type is ALLOWED to rest on. It is not a
 * hallucination detector: it does not judge whether a claim is true, only whether the pairing of claim type and supplied
 * evidence class is admissible under the hierarchy in evidenceEnvelope.js.
 *
 *   FACT                  >= 1 CURRENT_OPERATIONAL_FACT; may also cite the UNTRUSTED_SIGNAL reference (the Signal's recorded
 *                         text); may NOT rest on history, Learning or knowledge, alone or alongside current facts.
 *   HISTORICAL_PATTERN    >= 1 OPERATIONAL_HISTORY; may also cite current facts (to compare); never Learning.
 *   BUSINESS_GUIDANCE     >= 1 BUSINESS_KNOWLEDGE; may also cite current facts.
 *   LEARNING_OBSERVATION  LEARNING_CONTEXT only (so it exists only when the Learning flag put Learning in the envelope).
 *   RECOMMENDATION        >= 1 CURRENT_OPERATIONAL_FACT or BUSINESS_KNOWLEDGE; any other class may ACCOMPANY it, but history,
 *                         Learning and untrusted text alone can never justify a recommendation.
 *
 * Rejected, always for the WHOLE analysis (nothing partial is stored): unknown claim types, extra or missing claim fields,
 * unknown or foreign references, references of a class the claim type may not use, a claim with no admissible support, a
 * response with no RECOMMENDATION claim, and a workspace mismatch between the envelope and the request. Messages name a path
 * and a rule, never the model's content.
 */
export const MAX_CLAIMS = 12;
export const MAX_CLAIM_TEXT_CHARS = 500;
export const MAX_CLAIM_SOURCE_REFS = 8;
export const MAX_SOURCE_REF_CHARS = 128;

export const CLAIM_RULES = Object.freeze({
  FACT: Object.freeze({ requiresAnyOf: [CURRENT_OPERATIONAL_FACT], allowed: [CURRENT_OPERATIONAL_FACT, UNTRUSTED_SIGNAL] }),
  HISTORICAL_PATTERN: Object.freeze({ requiresAnyOf: [OPERATIONAL_HISTORY], allowed: [OPERATIONAL_HISTORY, CURRENT_OPERATIONAL_FACT] }),
  BUSINESS_GUIDANCE: Object.freeze({ requiresAnyOf: [BUSINESS_KNOWLEDGE], allowed: [BUSINESS_KNOWLEDGE, CURRENT_OPERATIONAL_FACT] }),
  LEARNING_OBSERVATION: Object.freeze({ requiresAnyOf: [LEARNING_CONTEXT], allowed: [LEARNING_CONTEXT] }),
  RECOMMENDATION: Object.freeze({
    requiresAnyOf: [CURRENT_OPERATIONAL_FACT, BUSINESS_KNOWLEDGE],
    allowed: [CURRENT_OPERATIONAL_FACT, BUSINESS_KNOWLEDGE, OPERATIONAL_HISTORY, LEARNING_CONTEXT, UNTRUSTED_SIGNAL],
  }),
});
export const CLAIM_TYPES = Object.freeze(Object.keys(CLAIM_RULES));

export const CLAIM_VALIDATION_FAILED = "CLAIM_VALIDATION_FAILED";

/**
 * STABLE, NON-SENSITIVE REASON CODES (Phase 38). Every rejection above carries exactly one of these in `details.rule` (next to the unchanged
 * `details.code = CLAIM_VALIDATION_FAILED`, status 502 and message), so an operator can tell WHICH admissibility rule failed - for the audit
 * row, the event stream and a support ticket - without a prompt, a model output, a claim or evidence text, or any reference id. A code is a
 * fixed constant chosen from the structure of the failure only; the same failure always yields the same code. Nothing is repaired, relaxed
 * or invented: a rejected analysis is rejected exactly as before.
 *
 *   CLAIM_FOREIGN_REF                    the evidence envelope / an item in it belongs to another workspace (tenant boundary)
 *   CLAIM_MALFORMED                      the claim list or a claim is not the agreed shape (not an array/object, wrong keys, bad text, bad ref string)
 *   CLAIM_TOO_MANY                       more claims than allowed
 *   CLAIM_MISSING_REQUIRED_EVIDENCE      no claims at all where claims are required
 *   CLAIM_UNKNOWN_TYPE                   a claimType that does not exist
 *   CLAIM_MISSING_SOURCE_REFS            a claim with no source reference (the sourceless-claim case), or too many
 *   CLAIM_DUPLICATE_REF                  the same reference repeated within one claim
 *   CLAIM_UNKNOWN_REF                    a reference that is not in THIS request's evidence envelope (invented, malformed, or another tenant's - indistinguishable by design)
 *   CLAIM_EVIDENCE_TYPE_MISMATCH         a reference of an evidence class this claim type may not rest on
 *   CLAIM_INVALID_FACT_SUPPORT           a FACT with no current operational fact behind it
 *   CLAIM_INVALID_HISTORICAL_PATTERN     a HISTORICAL_PATTERN with no operational history behind it
 *   CLAIM_INVALID_BUSINESS_GUIDANCE      a BUSINESS_GUIDANCE with no business knowledge behind it
 *   CLAIM_INVALID_LEARNING_OBSERVATION   a LEARNING_OBSERVATION with no Learning context behind it
 *   CLAIM_UNSUPPORTED_RECOMMENDATION     a RECOMMENDATION with neither a current fact nor business knowledge behind it
 *   CLAIM_NO_RECOMMENDATION              no RECOMMENDATION claim among the claims
 */
export const CLAIM_RULE_CODES = Object.freeze([
  "CLAIM_FOREIGN_REF", "CLAIM_MALFORMED", "CLAIM_TOO_MANY", "CLAIM_MISSING_REQUIRED_EVIDENCE", "CLAIM_UNKNOWN_TYPE", "CLAIM_MISSING_SOURCE_REFS",
  "CLAIM_DUPLICATE_REF", "CLAIM_UNKNOWN_REF", "CLAIM_EVIDENCE_TYPE_MISMATCH", "CLAIM_INVALID_FACT_SUPPORT", "CLAIM_INVALID_HISTORICAL_PATTERN",
  "CLAIM_INVALID_BUSINESS_GUIDANCE", "CLAIM_INVALID_LEARNING_OBSERVATION", "CLAIM_UNSUPPORTED_RECOMMENDATION", "CLAIM_NO_RECOMMENDATION",
]);
const UNSUPPORTED_BY_TYPE = Object.freeze({
  FACT: "CLAIM_INVALID_FACT_SUPPORT", HISTORICAL_PATTERN: "CLAIM_INVALID_HISTORICAL_PATTERN", BUSINESS_GUIDANCE: "CLAIM_INVALID_BUSINESS_GUIDANCE",
  LEARNING_OBSERVATION: "CLAIM_INVALID_LEARNING_OBSERVATION", RECOMMENDATION: "CLAIM_UNSUPPORTED_RECOMMENDATION",
});

function reject(reason, rule) {
  console.error("[KOI API] Claim validation rejected the analysis: rule=%s reason=%s", rule, reason);
  throw new AppError(`AI service returned an invalid analysis (${reason}).`, 502, { code: CLAIM_VALIDATION_FAILED, rule });
}

const CLAIM_KEYS = ["claimType", "sourceRefs", "text"];

/**
 * @param {unknown} claims the model's claims (already known to be an array or undefined by analysisSchema.js)
 * @param {object} envelope from buildEvidenceEnvelope - the ONLY authority on which references exist
 * @param {{workspaceId: string, strict?: boolean}} options
 *   strict (default true): claims are REQUIRED and a RECOMMENDATION claim must be among them. strict=false is a
 *   compatibility shim for the deterministic TEST identity in development/test only (see intelligenceAnalysisService.js):
 *   an empty/absent claim list is tolerated there, but any claim that IS present is validated in full.
 * @returns the normalized claims
 */
export function validateClaims(claims, envelope, { workspaceId, strict = true } = {}) {
  if (!envelope || typeof envelope.has !== "function") throw new TypeError("validateClaims requires an evidence envelope");
  // Tenant boundary: an envelope belongs to exactly one workspace. Using it for another workspace's request is refused.
  if (String(workspaceId) !== envelope.workspaceId) reject("the evidence envelope belongs to a different workspace", "CLAIM_FOREIGN_REF");
  for (const item of envelope.items.values()) {
    if (item.workspaceId !== envelope.workspaceId) reject("an evidence item belongs to a different workspace", "CLAIM_FOREIGN_REF");
  }

  const list = claims === undefined || claims === null ? [] : claims;
  if (!Array.isArray(list)) reject("claims must be an array", "CLAIM_MALFORMED");
  if (list.length === 0) {
    if (strict) reject("claims are required", "CLAIM_MISSING_REQUIRED_EVIDENCE");
    return [];
  }
  if (list.length > MAX_CLAIMS) reject(`claims must have at most ${MAX_CLAIMS} items`, "CLAIM_TOO_MANY");

  let recommendations = 0;
  const normalized = list.map((claim, i) => {
    const path = `claims[${i}]`;
    if (claim === null || typeof claim !== "object" || Array.isArray(claim)) reject(`${path} must be an object`, "CLAIM_MALFORMED");
    const keys = Object.keys(claim).sort();
    if (keys.length !== CLAIM_KEYS.length || keys.some((key, k) => key !== CLAIM_KEYS[k])) reject(`${path} must carry exactly claimType, text and sourceRefs`, "CLAIM_MALFORMED");

    if (typeof claim.claimType !== "string" || !Object.prototype.hasOwnProperty.call(CLAIM_RULES, claim.claimType)) reject(`${path}.claimType is not a recognized claim type`, "CLAIM_UNKNOWN_TYPE");
    if (typeof claim.text !== "string" || claim.text.trim().length === 0) reject(`${path}.text must be a non-empty string`, "CLAIM_MALFORMED");
    if (claim.text.length > MAX_CLAIM_TEXT_CHARS) reject(`${path}.text is too long`, "CLAIM_MALFORMED");
    if (!Array.isArray(claim.sourceRefs) || claim.sourceRefs.length === 0 || claim.sourceRefs.length > MAX_CLAIM_SOURCE_REFS) {
      reject(`${path}.sourceRefs must have 1-${MAX_CLAIM_SOURCE_REFS} references`, "CLAIM_MISSING_SOURCE_REFS");
    }
    if (new Set(claim.sourceRefs).size !== claim.sourceRefs.length) reject(`${path}.sourceRefs must not repeat a reference`, "CLAIM_DUPLICATE_REF");

    const rule = CLAIM_RULES[claim.claimType];
    const classes = new Set();
    for (const [j, ref] of claim.sourceRefs.entries()) {
      if (typeof ref !== "string" || ref.trim() === "" || ref.length > MAX_SOURCE_REF_CHARS) reject(`${path}.sourceRefs[${j}] must be a bounded non-empty string`, "CLAIM_MALFORMED");
      // The ONLY test of existence: membership in this request's envelope. A foreign-workspace, invented, or malformed
      // reference is not in it. (The model cannot mint a reference; it can only repeat one it was shown.)
      if (!envelope.has(ref)) reject(`${path}.sourceRefs[${j}] is not an evidence reference supplied for this request`, "CLAIM_UNKNOWN_REF");
      const evidenceClass = envelope.classOf(ref);
      if (!rule.allowed.includes(evidenceClass)) reject(`${path} (${claim.claimType}) may not rest on a ${evidenceClass} source`, "CLAIM_EVIDENCE_TYPE_MISMATCH");
      classes.add(evidenceClass);
    }
    if (!rule.requiresAnyOf.some((required) => classes.has(required))) {
      reject(`${path} (${claim.claimType}) has no admissible supporting source (needs ${rule.requiresAnyOf.join(" or ")})`, UNSUPPORTED_BY_TYPE[claim.claimType]);
    }
    if (claim.claimType === "RECOMMENDATION") recommendations += 1;
    return { claimType: claim.claimType, text: claim.text.trim(), sourceRefs: [...claim.sourceRefs] };
  });

  if (recommendations === 0) reject("claims must include a RECOMMENDATION claim", "CLAIM_NO_RECOMMENDATION");
  return normalized;
}
