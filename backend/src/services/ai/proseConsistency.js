import { AppError } from "../../utils/AppError.js";

/**
 * Structured-field / recommendation-prose consistency guard (Phase 34D) - a SECONDARY contradiction detector.
 *
 *   current facts -> Node policy -> minimum structured fields -> Gemini response -> structured validation -> THIS check
 *
 * The structured fields (`urgency`, `recommendedActionType`) are authoritative and are validated first, by safetyPolicy.js.
 * This guard never defines policy and never relaxes it: it only refuses an analysis whose own recommendation PROSE explicitly
 * says the opposite of what its structured fields say - "urgency: immediate" next to "this can wait until tomorrow".
 *
 * It is deliberately narrow, not a language-understanding component. It reads only the recommendation prose (the
 * `recommendation` field and the RECOMMENDATION claims' text, never the situation/impact/evidence descriptions), sentence by
 * sentence, and flags a sentence only when it matches an EXPLICIT directive from a short closed list AND is not negated,
 * conditional or deferred in the same sentence. A sentence that merely MENTIONS a forbidden concept ("do not dispatch a
 * technician", "contact the guest to agree a new time for the technician visit") is not a contradiction and is accepted.
 *
 * Rules (each tied to a field value the application actually defines):
 *   urgency = "immediate"                 the prose must not direct deferral: "wait until tomorrow", "can wait", "not urgent",
 *                                         "routine follow-up only", "low priority", "monitor only", "no action needed".
 *   recommendedActionType = "escalation"  the prose must not say "no escalation needed", "do not escalate", "no action
 *                                         required", "wait for the normal review".
 *   policy forbids maintenance_dispatch   (the guest refuses entry) the prose must not instruct sending/arranging a technician.
 *   policy forbids inspection             (the guest refuses entry) the prose must not instruct entering/inspecting the unit.
 *
 * HONEST LIMITS: it will not catch a contradiction phrased outside these lists, and a contradiction phrased conditionally
 * ("arrange a technician if you judge it safe") is treated as conditional. It exists to catch the obvious, not to certify
 * that prose and fields agree.
 */
export const PROSE_CONSISTENCY_VIOLATION = "PROSE_CONSISTENCY_VIOLATION";

const PERIODS = String.raw`(?:tomorrow|next\s+(?:day|week|month|shift|business\s+day)|later|(?:the\s+)?morning|monday|tuesday|wednesday|thursday|friday|saturday|sunday|(?:normal|regular|business|office)\s+hours|(?:the\s+)?weekend)`;
const NO_ACTION_NEEDED = new RegExp(String.raw`\bno\s+(?:immediate\s+|further\s+)?action\s+(?:is\s+)?(?:needed|required|necessary)\b(?!\s+(?:from|by)\s+(?:the\s+)?guests?)`, "i");

const DEFERRAL_DIRECTIVES = Object.freeze([
  new RegExp(String.raw`\b(?:wait|defer|postpone|delay|hold\s+off|put\s+off)\b[^.;]{0,50}\b(?:until|till|to|for)\b[^.;]{0,30}\b${PERIODS}\b`, "i"),
  /\bcan\s+wait\b|\bis\s+not\s+urgent\b|\bnot\s+an?\s+urgent\b|\bno\s+urgency\b|\bno\s+rush\b/i,
  /\bmonitor(?:ing)?\b[^.;]{0,20}\b(?:only|without\s+(?:any\s+)?(?:action|intervention))\b/i,
  /\broutine\s+follow[- ]?up\s+only\b|\btreat\s+(?:this\s+)?as\s+(?:a\s+)?(?:routine|low[- ]priority)\b|\blow[- ]priority\b/i,
  /\bdefer\w*\s+indefinitely\b/i,
  NO_ACTION_NEEDED,
]);

const NO_ESCALATION_DIRECTIVES = Object.freeze([
  /\b(?:no|without)\s+(?:need\s+(?:for|to)\s+)?escalat\w*/i,
  /\bescalat\w*\s+(?:is\s+|will\s+be\s+)?(?:not|un)\s*(?:needed|required|necessary|warranted)\b|\bescalation\s+is\s+unnecessary\b/i,
  /\b(?:do\s+not|don'?t|need\s+not|should\s+not|shouldn'?t)\s+escalate\b/i,
  NO_ACTION_NEEDED,
  /\bwait\s+for\s+(?:the\s+)?(?:normal|regular|routine|scheduled|usual)\s+review\b/i,
]);

const DISPATCH_INSTRUCTIONS = Object.freeze([
  /\b(?:dispatch|send|assign|arrange|schedule|book|deploy|call\s+out)\b[^.;]{0,30}\b(?:technician|engineer|maintenance\s+(?:team|crew|staff|personnel|worker)|plumber|electrician|handyman|repair\s*(?:person|crew|team))\b/i,
  /\bmaintenance\s+dispatch\b/i,
  /\bdispatch\s+(?:maintenance|a\s+team|staff)\b/i,
]);

const INSPECTION_INSTRUCTIONS = Object.freeze([
  /\b(?:inspect|carry\s+out\s+an\s+inspection|conduct\s+an\s+inspection|perform\s+an\s+inspection|enter|go\s+into|visit)\b[^.;]{0,25}\b(?:the\s+)?(?:unit|room|apartment|suite|premises|property|site)\b/i,
]);

// Words that make a sentence about a forbidden step NOT an instruction to take it (negated, conditional, or deferred to consent).
const NEGATED_OR_CONDITIONAL = /\b(?:not|never|without|unless|until|once|if|after|when|whenever|instead\s+of|rather\s+than|cannot|avoid|prohibit\w*|forbid\w*|hold)\b|n't\b|\breschedul\w*|\bnew\s+time\b|\bagree\w*|\bconsent\w*/i;

// A deferral/"no action" phrase that is not itself the directive, because the same clause negates it ("do not wait until
// tomorrow", "never defer"), concedes it ("regardless of / despite the suggestion that this can wait") or only REPORTS it
// ("the guest says this can wait", "ignore the note that says to wait"). Found by the Phase 34D real-provider run: Gemini wrote
// "consider immediate escalation ... regardless of the guest's suggestion that this can wait", which rejects the deferral and
// must not be treated as recommending it. The attribution verbs are kept to a short list on purpose: each added word is a way
// for a genuine directive to hide.
const NEGATOR_BEFORE = /\b(?:not|never|don'?t|avoid|without|instead\s+of|rather\s+than|no\s+need\s+to|cannot|can'?t|regardless\s+of|despite|although|even\s+though|contrary\s+to|disregard\w*|ignor\w*|suggest\w*|claim\w*|says?|said|states?|stated|asked|requested|insist\w*)\b[^.;,]*$/i;
// A comma ends the scope of the concession/attribution (Phase 34D.1): "Although it is critical, this can wait" still defers.

/** The recommendation prose only: the `recommendation` field plus the text of every RECOMMENDATION claim. */
function recommendationSentences(analysis) {
  const texts = [analysis?.recommendation];
  for (const claim of Array.isArray(analysis?.claims) ? analysis.claims : []) if (claim?.claimType === "RECOMMENDATION") texts.push(claim?.text);
  const sentences = [];
  for (const text of texts) {
    if (typeof text !== "string") continue;
    for (const sentence of text.split(/(?<=[.!?;])\s+|\n+/)) {
      const trimmed = sentence.trim();
      if (trimmed && !sentences.includes(trimmed)) sentences.push(trimmed);
    }
  }
  return sentences;
}

const directive = (sentence, patterns) => patterns.some((pattern) => {
  const match = pattern.exec(sentence);
  return match !== null && !NEGATOR_BEFORE.test(sentence.slice(0, match.index));
});
const instruction = (sentence, patterns) => !NEGATED_OR_CONDITIONAL.test(sentence) && patterns.some((pattern) => pattern.test(sentence));

// Phase 52 - RAG-miss policy language. When NO relevant business guidance was grounded, the recommendation may reason generally ("a person could consider ...") but must not
// present that reasoning as the business's own rule: "standard property entry protocols", "in accordance with company procedure". The patterns attribute a protocol / procedure /
// policy / SOP / guideline to the business or to "standard" practice. A sentence that DENIES such guidance ("no documented policy was found") is not an attribution, so any
// sentence with a negation is left alone (the same conservative stance as above: catch the obvious, never certify). Closed lists; an unlisted phrasing is not caught.
const POLICY_NOUNS = String.raw`(?:protocols?|procedures?|policies|policy|sops?|guidelines?|practices?)`;
const UNGROUNDED_POLICY_ATTRIBUTIONS = Object.freeze([
  new RegExp(String.raw`\b(?:standard|established|usual|normal|regular|internal|house|company|property|hotel|our|your)(?:\s+[\w-]+){0,3}\s+${POLICY_NOUNS}\b`, "i"),
  new RegExp(String.raw`\b(?:in\s+accordance\s+with|in\s+line\s+with|consistent\s+with|according\s+to|as\s+per|per)\b[^.;]{0,30}\b${POLICY_NOUNS}\b`, "i"),
  /\b(?:company|property|house|hotel|business)\s+(?:rules?|standards?|practices?)\b/i,
]);
const POLICY_DENIAL = /\b(?:no|not|none|without|unavailable|cannot|never)\b|n't\b/i;

/** The recommendation sentences that present general reasoning as the business's own policy (only meaningful when no relevant guidance was grounded). */
export function findUngroundedPolicyLanguage(analysis) {
  // Per CLAUSE (split at commas / semicolons / colons): "As no documented guidance was found, a person should ... in line with standard privacy practices" denies guidance in one clause
  // and then attributes the advice to "standard practices" in another - only the clause that carries the denial is exempt.
  return recommendationSentences(analysis).filter((sentence) =>
    sentence.split(/[,;:]\s+/).some((clause) => !POLICY_DENIAL.test(clause) && UNGROUNDED_POLICY_ATTRIBUTIONS.some((pattern) => pattern.test(clause))),
  );
}

/**
 * @param {object} policy   from deriveSafetyPolicy (only forbiddenActionTypes is read)
 * @param {object} analysis the validated analysis (recommendation, claims, urgency, recommendedActionType)
 * @returns {string[]} violation codes, empty when the prose does not contradict the structured fields
 */
export function findProseContradictions(policy, analysis) {
  const violations = new Set();
  const forbidden = policy?.forbiddenActionTypes || [];
  for (const sentence of recommendationSentences(analysis)) {
    if (analysis?.urgency === "immediate" && directive(sentence, DEFERRAL_DIRECTIVES)) violations.add("IMMEDIATE_URGENCY_CONTRADICTED_BY_PROSE");
    if (analysis?.recommendedActionType === "escalation" && directive(sentence, NO_ESCALATION_DIRECTIVES)) violations.add("ESCALATION_CONTRADICTED_BY_PROSE");
    if (forbidden.includes("maintenance_dispatch") && instruction(sentence, DISPATCH_INSTRUCTIONS)) violations.add("FORBIDDEN_DISPATCH_INSTRUCTED_IN_PROSE");
    if (forbidden.includes("inspection") && instruction(sentence, INSPECTION_INSTRUCTIONS)) violations.add("FORBIDDEN_INSPECTION_INSTRUCTED_IN_PROSE");
  }
  return [...violations];
}

/** Throws (the caller must not persist) when the recommendation prose explicitly contradicts the structured fields. Logs codes only. */
export function assertProseConsistent(policy, analysis, { enforceUngroundedPolicy = false } = {}) {
  const violations = findProseContradictions(policy, analysis);
  if (enforceUngroundedPolicy && findUngroundedPolicyLanguage(analysis).length > 0) violations.push("UNGROUNDED_POLICY_LANGUAGE");
  if (violations.length === 0) return;
  console.error("[KOI API] Prose consistency guard rejected the analysis:", violations.join(","));
  throw new AppError(`AI analysis recommendation contradicts its own structured fields (${violations.join(", ")}). Intelligence was not generated.`, 502, {
    code: PROSE_CONSISTENCY_VIOLATION,
  });
}
