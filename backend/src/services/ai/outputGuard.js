import { AppError } from "../../utils/AppError.js";

/**
 * Deterministic output security guard (Phase 34C): identifiers only. It is deliberately NOT a hallucination detector and it
 * does not read the text for meaning.
 *
 * The model is shown a fixed set of 24-hex record identifiers (see evidenceEnvelope.js `suppliedIds`). If its prose contains
 * a 24-hex identifier that was NOT among them, that identifier came from outside this request - another record, another
 * workspace, or something it made up - and the analysis is refused. The request's own workspace id is never sent to the
 * model, so it is refused even if a data quirk ever put the same token in the supplied set.
 *
 * The structured parts (evidence references, claim references) are already checked against the envelope; this closes the
 * remaining channel, free text.
 */
export const OUTPUT_GUARD_VIOLATION = "OUTPUT_GUARD_VIOLATION";

const OBJECT_ID_TOKEN = /\b[0-9a-f]{24}\b/gi;

function proseOf(analysis) {
  return [
    analysis?.situation,
    analysis?.impact,
    analysis?.recommendation,
    ...(Array.isArray(analysis?.evidence) ? analysis.evidence : []),
    ...(Array.isArray(analysis?.claims) ? analysis.claims.map((claim) => claim?.text) : []),
  ].filter((part) => typeof part === "string");
}

/** @returns {string[]} violation codes (empty when clean) */
export function findForeignIdentifiers(analysis, envelope) {
  const violations = new Set();
  const workspace = String(envelope.workspaceId).toLowerCase();
  for (const text of proseOf(analysis)) {
    for (const token of text.match(OBJECT_ID_TOKEN) || []) {
      const id = token.toLowerCase();
      if (id === workspace) violations.add("TENANT_IDENTIFIER_IN_OUTPUT");
      else if (!envelope.suppliedIds.has(id)) violations.add("IDENTIFIER_NOT_SUPPLIED");
    }
  }
  return [...violations];
}

/** Throws (the caller must not persist) when the analysis names an identifier that was never supplied for this request. */
export function assertNoForeignIdentifiers(analysis, envelope) {
  const violations = findForeignIdentifiers(analysis, envelope);
  if (violations.length === 0) return;
  console.error("[KOI API] Output guard rejected the analysis:", violations.join(","));
  throw new AppError(`AI analysis names an identifier that was not supplied for this request (${violations.join(", ")}). Intelligence was not generated.`, 502, {
    code: OUTPUT_GUARD_VIOLATION,
  });
}
