/**
 * Presentation of AI-authored prose (Phase 43A).
 *
 * WHY: the model repeats the evidence references it was given inside its own sentences ("... (current:stay:<id>)", "per knowledge:<id>", "chunkId: <id>").
 * Those references are INTERNAL: Node uses them to validate the model output, trust classes and provenance, and keeps them in the stored analysis. A person
 * reading the page must see natural language, never a database id or a reference string.
 *
 * WHAT THIS IS: a pure, deterministic PRESENTATION step applied by the mapping layer AFTER Node has validated and stored the analysis. It never runs in the
 * backend, never touches a claim, a ref, a validator, a confidence ceiling or the stored text, and the API still returns the text exactly as stored.
 *
 * WHAT THIS IS NOT: a global scrub. It recognises ONLY the closed grammar of references Node mints (backend/src/services/ai/evidenceEnvelope.js):
 *   current:{signal|property|unit|guest|stay}:<id>   untrusted:signal:<id>   history:{signal|analysis|decision}:<id>   knowledge:<chunkId>   learning:<actionType>
 * plus the two other ways an internal id shows up in prose: "chunkId <objectId>" and a bare 24-hex ObjectId. Text that contains none of them is returned
 * UNCHANGED (same string). The test suite proves every reference Node can mint is covered, so a new reference class cannot be added without this module.
 *
 * HOW: (1) a bracketed citation made only of references is removed, with its leading space; (2) a reference inside a sentence is replaced by a phrase for
 * its evidence CLASS ("the recorded stay", "the available business guidance"), or by the stored section title when the same knowledge chunk is in the
 * analysis's own provenance; (3) a bare ObjectId is removed; (4) whitespace and punctuation around the edit are tidied. No fact is added.
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

/** True when the text still contains any internal reference or object id (used by tests and as a development safeguard). */
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
 * @returns {unknown} the same value when it is not a string or contains nothing to present; otherwise user-facing prose
 */
export function presentText(text, options = {}) {
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

/** The four prose fields of an analysis, ready to display. `evidence` items that are not strings are left as they are. */
export function presentAnalysisProse({ situation, evidence, impact, recommendation }, provenance) {
  const options = { titles: knowledgeTitles(provenance) };
  return {
    situation: presentUserText(situation, options),
    evidence: Array.isArray(evidence) ? evidence.map((item) => presentUserText(item, options)) : evidence,
    impact: presentUserText(impact, options),
    recommendation: presentUserText(recommendation, options),
  };
}

// ---- Phase 52: user-facing WORDING --------------------------------------------------------------------------------------------------------------------------------
// The model sometimes writes in EOI's own internal vocabulary: the object it is analysing is "the signal" ("a maintenance signal reports ...", "the signal input"), and it can name
// the field Node uses to hand it a report-versus-record conflict ("the reportChecks mismatch"). A person reading the page needs neither. This is PRESENTATION only, applied by the
// mapping layer after Node has validated and stored the analysis: the stored text, every claim, reference, validator and the API response are untouched, and no internal name
// (model, route, field, collection) is renamed. Closed, deterministic rules; ordinary text with none of these words is returned UNCHANGED, and the step is idempotent.
/** The replacement, capitalised when the text it replaces started with a capital letter (a sentence start). */
const likeOriginal = (original, replacement) => (/^[A-Z]/.test(original) ? capitalise(replacement) : replacement);

// "signal" in its everyday sense (a wifi / network / phone / radio signal, a weak signal, signal strength) is not the internal object and is left alone.
const SIGNAL_EVERYDAY_BEFORE = /(?:wi-?fi|network|cellular|mobile|phone|radio|tv|gps|cell|weak|strong|poor|good|no)\s+$/i;
const SIGNAL_EVERYDAY_AFTER = /^\s*(?:strength|quality|loss|bars|booster|interference|drop)/i;

/** @returns {unknown} the same value when it is not a string; otherwise the text with EOI's internal vocabulary rephrased for a person. */
export function presentWording(text) {
  if (typeof text !== "string") return text;
  let out = text;
  // the internal field name for a report-versus-record conflict
  out = out.replace(/\b(?:the\s+)?reportChecks?\s+(?:mismatch|conflict|discrepancy)\s+(?:regarding|about|on|for|in|over)\s+the\s+(check-?out|check-?in)\s+date\b/gi, (match, kind) =>
    likeOriginal(match, `the report and the recorded ${kind.replace("-", "").toLowerCase()} date do not match`),
  );
  out = out.replace(/\b(?:the\s+)?reportChecks?\s+(?:mismatch|conflict|discrepancy)\b/gi, (match) => likeOriginal(match, "the mismatch between the report and the record"));
  out = out.replace(/\b(?:the\s+)?reportChecks?\b/gi, (match) => likeOriginal(match, "the check of the report against the record"));
  // the internal word for a reported event
  out = out.replace(/\s*\(\s*signals?\s*\)/gi, "");
  out = out.replace(/\bsignal\s+reports\b/gi, (match) => likeOriginal(match, "report says"));
  out = out.replace(/\bsignal\s+inputs?\b/gi, (match) => likeOriginal(match, "report"));
  out = out.replace(/\bsignals?\b/gi, (match, offset, whole) => {
    if (SIGNAL_EVERYDAY_BEFORE.test(whole.slice(Math.max(0, offset - 12), offset)) || SIGNAL_EVERYDAY_AFTER.test(whole.slice(offset + match.length, offset + match.length + 14))) return match;
    return likeOriginal(match, /s$/i.test(match) ? "reports" : "report");
  });
  return out;
}

/** References removed (presentText) and EOI's internal vocabulary rephrased (presentWording): what a person reads in AI-authored prose. */
export const presentUserText = (text, options) => presentWording(presentText(text, options));
