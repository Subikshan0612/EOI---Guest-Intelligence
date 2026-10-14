/**
 * Audit aid for Intelligence V1: finds text that CLAIMS a stay state which the
 * recorded operational context does not establish.
 *
 * The rule it checks is the one the grounding prompt states: an operational
 * state ("checked in", "checked out", "arrived", "departed", "in-house",
 * "occupied", ...) may only be asserted when a supplied field explicitly
 * records it. Inferring it from dates, or from the plausibility of a
 * situation, is not allowed. Here the only field that can record such a state
 * is the linked stay's `status` ("checked_in", "checked_out", ...).
 *
 * This is a HEURISTIC over free text, on purpose conservative in one
 * direction: it looks for affirmative wording and ignores negated,
 * conditional and "not established" mentions, and it never treats an SOP
 * procedure name such as "Check-in" as a state claim. It flags for review; it
 * does not reject, rewrite or persist anything, and the production validator
 * (analysisSchema.js) is unchanged. It is used by the test suite and by the
 * real-model verification runs, not as an enforcement gate - wiring it in as
 * one would be a separate decision.
 */

// state -> wording that asserts it
const STATE_PATTERNS = {
  checked_in: [
    /\bchecked[- ]in\b/i,
    /\bin[- ]house\b/i,
    /\bactive stay\b/i,
    /\bcurrently staying\b/i,
    /\b(?:has|have|had) arrived\b/i,
    /\b(?:is|are|was|were) (?:currently |now |already )?(?:occupied|in residence)\b/i,
  ],
  checked_out: [
    /\bchecked[- ]out\b/i,
    /\b(?:has|have|had|already) departed\b/i,
    /\bdeparted\b/i,
    /\b(?:has|have|had) (?:left|vacated) the (?:property|room)\b/i,
    /\b(?:was|were|been|has been) vacated\b/i,
  ],
};

// Words shortly before a match that make it negated, conditional or an admission of not knowing.
const HEDGE_BEFORE = /\b(?:not|never|no|n't|until|unless|if|whether|when|once|after|before|yet|unavailable|unknown|unestablished|established)\b/i;
const HEDGE_WINDOW_CHARS = 45;

// "Check-in" / "Check-out" as a procedure or section name is not a claim about a guest's state.
const PROCEDURE_NAME = /\b(?:check[- ]in|check[- ]out)\b(?: \/ | & |\s+(?:workflow|procedure|sop|section|status))/i;

function establishedStates(context) {
  const stay = context?.stay;
  const status = stay && stay.available !== false && typeof stay.status === "string" ? stay.status.trim() : "";
  const states = new Set();
  if (status === "checked_in") states.add("checked_in");
  if (status === "checked_out") states.add("checked_out");
  return states;
}

/**
 * @param {object} context the analysis context that was sent to the model
 * @param {string[]} texts generated texts to check (situation, evidence items, impact, recommendation)
 * @returns {Array<{ textIndex: number, state: string, match: string }>} unsupported state claims
 */
export function findUnsupportedStatusClaims(context, texts) {
  const established = establishedStates(context);
  const findings = [];

  texts.forEach((text, textIndex) => {
    if (typeof text !== "string") return;
    for (const [state, patterns] of Object.entries(STATE_PATTERNS)) {
      if (established.has(state)) continue;
      for (const pattern of patterns) {
        const match = pattern.exec(text);
        if (!match) continue;

        const before = text.slice(Math.max(0, match.index - HEDGE_WINDOW_CHARS), match.index);
        if (HEDGE_BEFORE.test(before)) continue;

        // A section/procedure name ("Check-in workflow", "Check-out & Post Check-out") is not a state claim.
        const around = text.slice(Math.max(0, match.index - 1), match.index + match[0].length + 20);
        if (PROCEDURE_NAME.test(around) && !/\b(?:is|are|was|were|has|have|had|already|currently)\s+$/i.test(before)) continue;

        findings.push({ textIndex, state, match: match[0] });
        break;
      }
    }
  });

  return findings;
}
