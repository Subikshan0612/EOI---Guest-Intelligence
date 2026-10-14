/**
 * Server-side prose / reference boundary (Phase 53D).
 *
 * WHY: the model repeats the evidence references it was given inside its own sentences ("... (current:stay:<id>)", "per knowledge:<id>", "chunkId <id>", a bare 24-hex record id). Those are
 * INTERNAL implementation identifiers: Node mints them to validate the output, assign trust classes and build provenance. Phase 53B.1 / 53C measured them in the STORED prose of about
 * 60% of real analyses. The frontend presentation layer already removes them for display; this module moves the stronger guarantee to the server, so the identifiers never become persisted,
 * API-visible human-readable text.
 *
 *   AI response -> structured validation (analysisSchema, claims, safety, prose, output guard, identity)  -> THIS sanitizer (prose fields only) -> persisted Intelligence -> API -> presentation
 *
 * WHAT IT TOUCHES: only the human-readable prose of an already-ADMITTED analysis (situation, evidence[], impact, recommendation, and a contradiction's description). Nothing the validators read
 * is changed: it runs AFTER them, and the structured evidence (evidenceRefs, contradictions[].evidenceRefs, knowledge provenance, claims in the admission audit) is never passed through it.
 *
 * WHAT IT RECOGNISES - not a global scrub:
 *   1. the CLOSED reference grammar Node mints (evidenceEnvelope.js):
 *        current:{signal|property|unit|guest|stay}:<id>  untrusted:signal:<id>  history:{signal|analysis|decision}:<id>  knowledge:<chunkId>  learning:<actionType>
 *   2. "chunkId <24-hex>" (the chunk label some answers write);
 *   3. a bare 24-hex token. The output guard (outputGuard.js) already defines a 24-hex token in these exact prose fields as a RECORD IDENTIFIER: the model is only ever shown 24-hex values as
 *      record ids, and an analysis naming one that was not supplied is refused before persistence. So after admission every such token in these fields is positively an internal id.
 * Dates, room / unit numbers, money, counts, times, ordinary words and shorter hex-looking text are never matched (a token must be exactly 24 hex characters on both-side word boundaries).
 *
 * HOW (identical rules to frontend/src/features/intelligence/presentation.js presentText, so the two layers agree and the second finds nothing to do): (1) a bracketed citation made only
 * of references is removed with its leading space; (2) a reference inside a sentence becomes a phrase for its evidence CLASS ("the recorded stay"), or the stored section title when the
 * chunk is in this analysis's own provenance; (3) a bare id is removed; (4) whitespace / punctuation around the edit is tidied. No fact is added; text with nothing to remove is returned
 * UNCHANGED (same string), and the function is idempotent.
 */

const OBJECT_ID = "[0-9a-fA-F]{24}";
// An id Node can mint: 8-64 safe characters, never ending in '.' or '-' (so sentence punctuation is not swallowed).
const ID_BODY = "[A-Za-z0-9](?:[A-Za-z0-9_]|[.-](?=[A-Za-z0-9_])){7,63}";

export const INTERNAL_REF_KINDS = Object.freeze([
  "current:signal", "current:property", "current:unit", "current:guest", "current:stay",
  "untrusted:signal",
  "history:signal", "history:analysis", "history:decision",
  "knowledge",
]);
export const LEARNING_ACTION_TYPES = Object.freeze(["maintenance_dispatch", "guest_communication", "escalation", "inspection", "other"]);

const REF = `(?:${INTERNAL_REF_KINDS.join("|")}):${ID_BODY}|learning:(?:${LEARNING_ACTION_TYPES.join("|")})`;
const CHUNK = `chunk[ _-]?id\\s*[:=]?\\s*${OBJECT_ID}`;
const OID = `(?<![0-9A-Za-z])${OBJECT_ID}(?![0-9A-Za-z])`;
const BOUND_START = "(?<![A-Za-z0-9_:])";
const BOUND_END = "(?![A-Za-z0-9_])";
const LEAD = "(?:see|per|ref|refs|source|sources|evidence|chunks?|id)\\s*[:=]?\\s*";
const UNIT = `(?:${LEAD})?(?:${BOUND_START}(?:${REF})${BOUND_END}|${CHUNK}|${OID})`;

const bracketed = () => new RegExp(`\\s*[(\\[]\\s*${UNIT}(?:\\s*(?:[,;]|and)\\s*${UNIT})*\\s*[)\\]]`, "gi");
const bareRef = () => new RegExp(`${BOUND_START}(?:${REF})${BOUND_END}`, "gi");
const bareChunk = () => new RegExp(CHUNK, "gi");
const bareObjectId = () => new RegExp(`[ \\t]?${OID}`, "g");
const anyInternal = () => new RegExp(`${BOUND_START}(?:${REF})${BOUND_END}|${CHUNK}|${OID}`, "i");

/** True when the text contains any internal reference or record id. */
export function containsInternalReference(text) {
  return typeof text === "string" && anyInternal().test(text);
}

const CLASS_PHRASE = Object.freeze({
  "current:signal": "the recorded report",
  "current:property": "the recorded property",
  "current:unit": "the recorded unit",
  "current:guest": "the recorded guest information",
  "current:stay": "the recorded stay",
  "untrusted:signal": "the reported wording",
  "history:signal": "a related earlier report",
  "history:analysis": "an earlier analysis",
  "history:decision": "an earlier decision",
});
const GENERIC_GUIDANCE = "the available business guidance";

function guidancePhrase(chunkId, titles) {
  const title = titles && chunkId ? titles.get(String(chunkId).toLowerCase()) : undefined;
  return title ? `the "${title}" guidance` : GENERIC_GUIDANCE;
}

function phraseForRef(token, titles) {
  const lower = token.toLowerCase();
  if (lower.startsWith("learning:")) return "the learning context";
  if (lower.startsWith("knowledge:")) return guidancePhrase(token.slice("knowledge:".length), titles);
  const kind = INTERNAL_REF_KINDS.find((k) => k !== "knowledge" && lower.startsWith(`${k}:`));
  return kind ? CLASS_PHRASE[kind] : "the recorded information";
}

const startsSentence = (text, offset) => offset === 0 || /[.!?]\s*$/.test(text.slice(0, offset));
const capitalise = (s) => s.charAt(0).toUpperCase() + s.slice(1);
/** Places a phrase where a reference was: no doubled article ("the the ..."), and a capital letter at the start of a sentence. */
function fit(phrase, whole, offset) {
  const before = whole.slice(0, offset);
  const text = /\b(?:the|a|an)\s+$/i.test(before) ? phrase.replace(/^(?:the|a|an)\s+/i, "") : phrase;
  return startsSentence(whole, offset) ? capitalise(text) : text;
}

/**
 * @param {unknown} text
 * @param {{ titles?: Map<string, string> }} [options] titles: knowledge chunkId (lower-case) -> the section title stored in THIS analysis's provenance
 * @returns {unknown} the same value when it is not a string or holds no internal reference; otherwise the prose without them
 */
export function sanitizeProse(text, options = {}) {
  if (typeof text !== "string" || !containsInternalReference(text)) return text;
  const titles = options.titles;
  let out = text.replace(bracketed(), "");
  out = out.replace(bareRef(), (match, offset, whole) => fit(phraseForRef(match, titles), whole, offset));
  out = out.replace(bareChunk(), (match, offset, whole) => fit(guidancePhrase((match.match(new RegExp(OBJECT_ID)) || [""])[0], titles), whole, offset));
  out = out.replace(bareObjectId(), "");
  return out
    .replace(/\(\s*\)|\[\s*\]/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([,.;:!?])/g, "$1")
    .replace(/^[ \t]+|[ \t]+$/gm, "");
}

/** chunkId (lower-case) -> section title, from the provenance stored with the analysis. Only titles that are really stored are used. */
export function knowledgeTitles(provenance) {
  const titles = new Map();
  for (const p of Array.isArray(provenance) ? provenance : []) {
    if (p && typeof p.chunkId === "string" && typeof p.section === "string" && p.section.trim()) titles.set(p.chunkId.toLowerCase(), p.section.trim());
  }
  return titles;
}

/**
 * The four prose fields of an analysis, sanitised. Every other field (confidence, claims, usedKnowledgeChunkIds, urgency, recommendedActionType, evidenceRefs, provenance, ...) is carried over
 * untouched, by reference. Returns a NEW object; the input is not mutated.
 */
export function sanitizeAnalysisProse(analysis, provenance) {
  if (!analysis || typeof analysis !== "object") return analysis;
  const options = { titles: knowledgeTitles(provenance) };
  return {
    ...analysis,
    situation: sanitizeProse(analysis.situation, options),
    evidence: Array.isArray(analysis.evidence) ? analysis.evidence.map((item) => sanitizeProse(item, options)) : analysis.evidence,
    impact: sanitizeProse(analysis.impact, options),
    recommendation: sanitizeProse(analysis.recommendation, options),
  };
}

/** Contradictions as stored: only each `description` is prose; `type` and the structured `evidenceRefs` are carried over untouched. */
export function sanitizeContradictions(contradictions, provenance) {
  if (!Array.isArray(contradictions)) return contradictions;
  const options = { titles: knowledgeTitles(provenance) };
  return contradictions.map((c) => (c && typeof c === "object" ? { ...c, description: sanitizeProse(c.description, options) } : c));
}
