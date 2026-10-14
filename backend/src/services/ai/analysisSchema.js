import { AppError } from "../../utils/AppError.js";
import { ANALYSIS_CONFIDENCE_LEVELS } from "../../models/Intelligence.js";
import { evidenceRefIsAuthorized } from "./evidenceReferenceIndex.js";

/**
 * Intelligence V1 - strict validation of the AI service's analysis response.
 * The response is never trusted: it is checked field by field here before
 * anything is persisted, and any violation rejects the WHOLE analysis
 * (nothing partial is stored). Node is the authority, even though Python
 * validated the same contract on its side.
 *
 * Strategy for unexpected fields: REJECT. The contract is closed - there is no
 * field through which an action, a tool call, a message or any other
 * operation could be carried - so an extra key means the service or the
 * contract has drifted, and the response is refused rather than "safely
 * ignored". (Python, which sees raw model output, does the opposite and
 * ignores unknown model keys; see ai-service/app/services/gemini_analysis_client.py.)
 *
 * Confidence must be exactly "high" | "medium" | "low". A number, a
 * percentage, a differently-cased or unknown word is rejected; no confidence
 * value is ever invented or coerced here. This is also why "confidence must
 * be numeric and finite" (a Phase 28 requirement) is already satisfied: a
 * number, NaN or Infinity all fail the `typeof === "string"` check below
 * before they could ever reach a numeric range check. Confidence remains a
 * documented evidence-quality CLASS, never a probability - converting it to
 * a number was considered and rejected (see backend/docs/PHASE28_EVIDENCE_HARDENING.md).
 *
 * Phase 28 (evidence contract): `evidenceRefs` and `contradictions` are new,
 * OPTIONAL, additive fields (default `[]` when absent, so every pre-Phase-28
 * fixture/response keeps validating unchanged). Each reference is checked in
 * two steps, both fail-closed and rejecting the WHOLE analysis:
 *   1. SHAPE: exactly the fields its `type` allows, nothing else, within bounds.
 *   2. PROVENANCE (see evidenceReferenceIndex.js): the identifier it names was
 *      actually present in the context/operationalHistory/knowledge THIS
 *      request supplied - never a database lookup, never "close enough".
 * A reference that fails either check means the whole response is refused,
 * exactly like a usedKnowledgeChunkIds violation below - never silently dropped.
 */

export const MAX_EVIDENCE_ITEMS = 12;
export const MAX_TEXT_CHARS = 2000;
export const MAX_EVIDENCE_CHARS = 1000;
export const MAX_EVIDENCE_REFS = 20;
export const MAX_CONTRADICTIONS = 5;
export const MAX_CONTRADICTION_DESCRIPTION_CHARS = 300;
export const MIN_CONTRADICTION_REFS = 2;
export const MAX_CONTRADICTION_REFS = 6;
export const MAX_REF_ID_CHARS = 64;

const ALLOWED_KEYS = new Set([
  "situation",
  "evidence",
  "impact",
  "recommendation",
  "confidence",
  "usedKnowledgeChunkIds",
  "provenance",
  "evidenceRefs",
  "contradictions",
  // Phase 34C: claim-level provenance and the two structured fields the server safety policy checks. Passed through
  // here as plain values; claimValidator.js / safetyPolicy.js decide admissibility (analysisSchema stays shape-only).
  "claims",
  "urgency",
  "recommendedActionType",
]);

const OPERATIONAL_FIELDS = new Set(["signal", "property", "unit", "guest", "stay", "historySignal"]);
const HISTORICAL_KINDS = new Set(["prior_ai_analysis", "human_reviewed_decision"]);
const CONTRADICTION_TYPES = new Set([
  "signal_vs_historical",
  "operational_vs_historical",
  "knowledge_vs_operational",
  "historical_vs_historical",
]);
// Exactly the fields each evidence type may carry - never a mix, never an extra.
const REF_FIELDS_BY_TYPE = {
  operational: ["field", "refId"],
  historical: ["kind", "signalId"],
  knowledge: ["chunkId"],
};
const ALL_REF_FIELDS = new Set(["type", "field", "refId", "kind", "signalId", "chunkId"]);

function reject(reason) {
  // A fixed, safe message: never echoes the model's content.
  throw new AppError(`AI service returned an invalid analysis (${reason}).`, 502, { code: "ANALYSIS_SCHEMA_INVALID" });
}

function requireText(value, name, max = MAX_TEXT_CHARS) {
  if (typeof value !== "string" || value.trim().length === 0) reject(`${name} must be a non-empty string`);
  if (value.length > max) reject(`${name} is too long`);
  return value.trim();
}

function requireId(value, name) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_REF_ID_CHARS) {
    reject(`${name} must be a non-empty id`);
  }
  return value;
}

/** Shape-only: exactly the fields `ref.type` allows, all present, nothing else. Does not check authorization. */
function validateEvidenceRefShape(ref, path) {
  if (ref === null || typeof ref !== "object" || Array.isArray(ref)) reject(`${path} must be an object`);
  for (const key of Object.keys(ref)) {
    if (!ALL_REF_FIELDS.has(key)) reject(`${path}.${key} is not a recognized evidence field`);
  }
  if (typeof ref.type !== "string" || !REF_FIELDS_BY_TYPE[ref.type]) {
    reject(`${path}.type must be one of operational, historical, knowledge`);
  }
  const allowed = REF_FIELDS_BY_TYPE[ref.type];
  // A field the JSON serializer included with an explicit `null` (every optional EvidenceRef field the
  // service's OWN type doesn't use) is treated as ABSENT, not "present but empty" - only a key with an
  // actual value counts, so this check depends on values, never on which keys the serializer happened to emit.
  const present = Object.keys(ref).filter((k) => k !== "type" && ref[k] !== null && ref[k] !== undefined);
  if (present.length !== allowed.length || !allowed.every((k) => present.includes(k))) {
    reject(`${path} must carry exactly {type, ${allowed.join(", ")}} for type "${ref.type}"`);
  }
  if (ref.type === "operational") {
    if (!OPERATIONAL_FIELDS.has(ref.field)) reject(`${path}.field is not a recognized operational field`);
    requireId(ref.refId, `${path}.refId`);
    return { type: "operational", field: ref.field, refId: ref.refId };
  }
  if (ref.type === "historical") {
    if (!HISTORICAL_KINDS.has(ref.kind)) reject(`${path}.kind is not a recognized historical kind`);
    requireId(ref.signalId, `${path}.signalId`);
    return { type: "historical", kind: ref.kind, signalId: ref.signalId };
  }
  requireId(ref.chunkId, `${path}.chunkId`);
  return { type: "knowledge", chunkId: ref.chunkId };
}

function validateEvidenceRefAuthorized(ref, path, referenceIndex) {
  if (!referenceIndex) return; // no index supplied (e.g. a unit test of shape only) - authorization is the caller's job
  if (!evidenceRefIsAuthorized(ref, referenceIndex)) {
    reject(`${path} cites a record that was not supplied in the authorized context`);
  }
}

function validateEvidenceRefsArray(raw, referenceIndex) {
  const list = raw.evidenceRefs ?? [];
  if (!Array.isArray(list) || list.length > MAX_EVIDENCE_REFS) {
    reject(`evidenceRefs must be an array of at most ${MAX_EVIDENCE_REFS} items`);
  }
  const shaped = list.map((ref, i) => validateEvidenceRefShape(ref, `evidenceRefs[${i}]`));
  const seen = new Set();
  for (const [i, ref] of shaped.entries()) {
    const key = `${ref.type}:${ref.field ?? ref.kind ?? ""}:${ref.refId ?? ref.signalId ?? ref.chunkId}`;
    if (seen.has(key)) reject(`evidenceRefs[${i}] duplicates an earlier reference`);
    seen.add(key);
    validateEvidenceRefAuthorized(ref, `evidenceRefs[${i}]`, referenceIndex);
  }
  return shaped;
}

function validateContradictionsArray(raw, referenceIndex) {
  const list = raw.contradictions ?? [];
  if (!Array.isArray(list) || list.length > MAX_CONTRADICTIONS) {
    reject(`contradictions must be an array of at most ${MAX_CONTRADICTIONS} items`);
  }
  return list.map((c, i) => {
    const path = `contradictions[${i}]`;
    if (c === null || typeof c !== "object" || Array.isArray(c)) reject(`${path} must be an object`);
    for (const key of Object.keys(c)) {
      if (key !== "type" && key !== "description" && key !== "evidenceRefs") reject(`${path}.${key} is not a recognized field`);
    }
    if (typeof c.type !== "string" || !CONTRADICTION_TYPES.has(c.type)) reject(`${path}.type is not a recognized contradiction type`);
    const description = requireText(c.description, `${path}.description`, MAX_CONTRADICTION_DESCRIPTION_CHARS);
    if (!Array.isArray(c.evidenceRefs) || c.evidenceRefs.length < MIN_CONTRADICTION_REFS || c.evidenceRefs.length > MAX_CONTRADICTION_REFS) {
      reject(`${path}.evidenceRefs must have ${MIN_CONTRADICTION_REFS}-${MAX_CONTRADICTION_REFS} items`);
    }
    const evidenceRefs = c.evidenceRefs.map((ref, j) => {
      const shaped = validateEvidenceRefShape(ref, `${path}.evidenceRefs[${j}]`);
      validateEvidenceRefAuthorized(shaped, `${path}.evidenceRefs[${j}]`, referenceIndex);
      return shaped;
    });
    return { type: c.type, description, evidenceRefs };
  });
}

/**
 * @param {unknown} raw the parsed response body
 * @param {Set<string>} retrievedChunkIds the chunk ids Node itself retrieved for THIS request
 * @param {{operational: Map, historical: object, knowledge: Set}} [referenceIndex] built by
 *   evidenceReferenceIndex.js from the SAME context/operationalHistory/knowledge as this request. Omit only
 *   for isolated shape-only unit tests; every production call site supplies it.
 * @returns the validated, normalized analysis
 */
export function validateAnalysisResult(raw, retrievedChunkIds, referenceIndex) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) reject("not an object");

  for (const key of Object.keys(raw)) {
    if (!ALLOWED_KEYS.has(key)) reject(`unexpected field "${key}"`);
  }

  const situation = requireText(raw.situation, "situation");
  const impact = requireText(raw.impact, "impact");
  const recommendation = requireText(raw.recommendation, "recommendation");

  if (!Array.isArray(raw.evidence) || raw.evidence.length === 0 || raw.evidence.length > MAX_EVIDENCE_ITEMS) {
    reject(`evidence must be 1-${MAX_EVIDENCE_ITEMS} items`);
  }
  const evidence = raw.evidence.map((item) => requireText(item, "an evidence item", MAX_EVIDENCE_CHARS));

  if (typeof raw.confidence !== "string" || !ANALYSIS_CONFIDENCE_LEVELS.includes(raw.confidence)) {
    reject("confidence must be one of high, medium, low");
  }

  const used = raw.usedKnowledgeChunkIds ?? [];
  if (!Array.isArray(used) || used.some((id) => typeof id !== "string" || id.length === 0)) {
    reject("usedKnowledgeChunkIds must be an array of strings");
  }
  if (new Set(used).size !== used.length) reject("usedKnowledgeChunkIds contains duplicates");
  // Provenance can only ever point at a chunk Node itself retrieved for this
  // request. A cited id outside that set is a grounding violation, not a typo.
  for (const id of used) {
    if (!retrievedChunkIds.has(id)) reject("usedKnowledgeChunkIds cites a chunk that was not retrieved");
  }

  const provenance = raw.provenance;
  if (
    provenance === null || typeof provenance !== "object" || Array.isArray(provenance) ||
    Object.keys(provenance).some((key) => key !== "provider" && key !== "model") ||
    typeof provenance.provider !== "string" || provenance.provider.trim() === "" ||
    typeof provenance.model !== "string" || provenance.model.trim() === ""
  ) {
    reject("provenance must be { provider, model }");
  }

  const evidenceRefs = validateEvidenceRefsArray(raw, referenceIndex);
  const contradictions = validateContradictionsArray(raw, referenceIndex);

  // Phase 34C. null is "not stated" (the AI service serializes an absent optional field as null). Only keys that were
  // actually stated are returned, so a response that states none normalizes exactly as it did before this phase.
  const stated = {};
  if (raw.claims !== undefined && raw.claims !== null) {
    if (!Array.isArray(raw.claims)) reject("claims must be an array");
    stated.claims = raw.claims;
  }
  for (const key of ["urgency", "recommendedActionType"]) {
    if (raw[key] === undefined || raw[key] === null) continue;
    if (typeof raw[key] !== "string") reject(`${key} must be a string`);
    stated[key] = raw[key];
  }

  return {
    ...stated,
    situation,
    evidence,
    impact,
    recommendation,
    confidence: raw.confidence,
    usedKnowledgeChunkIds: [...used],
    provenance: { provider: provenance.provider, model: provenance.model },
    evidenceRefs,
    contradictions,
  };
}
