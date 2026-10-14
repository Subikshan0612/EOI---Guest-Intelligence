/**
 * Structured operational events (Phase 36). One JSON line per event, prefixed `[KOI EVENT]`, built so that free text CANNOT enter it.
 *
 * WHY: operators need to tell apart "analysis succeeded", "provider failed", "retrieval timed out", "schema/evidence/safety rejected",
 * "governance refused", "audit write failed" without reading prompts or Signal content. The audit row (AnalysisAdmission) answers that
 * durably; these events answer it in the log stream, correlated by `attemptId` (the audit row's own random id) and `requestId`.
 *
 * HOW IT STAYS SAFE (structure, not discipline):
 *   - only the FIELD NAMES in ALLOWED_FIELDS can be logged; anything else is dropped, never serialised;
 *   - a string value must match SAFE_TOKEN (letters, digits and `_ . : / -`, at most 80 characters, no `..`) - so a sentence, a Signal title, a
 *     model output, an email, a bearer token or a JSON blob does not fit and is dropped; numbers must be finite; booleans pass;
 *   - there is deliberately NO field for a user id, workspace id, Signal id, prompt, output, header or key. `route` is the request path
 *     with every 24-hex / uuid segment replaced by `:id`; a path that still does not fit SAFE_TOKEN is dropped.
 *   - the correlation ids are random uuids: they contain no workspace id, user id or content.
 * It never throws: a logging problem must not change a request's outcome.
 */
const ALLOWED_FIELDS = Object.freeze([
  "requestId", "attemptId", "outcome", "decidedAt", "stage", "code", "reasonCode", "ruleCode", "failureClass", "httpStatus", "provider", "model",
  "latencyMs", "modelConfidence", "confidenceCeiling", "finalConfidence", "confidenceCapped", "learningUsed", "evidenceSetId",
  "method", "route", "permission", "resource", "errorClass",
]);
const ALLOWED = new Set(ALLOWED_FIELDS);
const SAFE_TOKEN = /^(?!.*\.\.)[A-Za-z0-9_.:/-]{1,80}$/; // (no ".." sequence: nothing legitimate has one, and tools that treat a value as a path must not be handed a traversal)
const EVENT_NAME = /^[a-z][a-z0-9_.]{2,47}$/;

let sink = (line) => console.log(line);

/** Test hook: replace (or restore with no argument) the destination of event lines. */
export function setLogEventSink(fn) {
  sink = typeof fn === "function" ? fn : (line) => console.log(line);
}

/** The request path with identifiers redacted, e.g. `/api/decisions/:id/approve`. Query strings are dropped. */
export function redactRoute(path) {
  if (typeof path !== "string") return undefined;
  const clean = path.split("?")[0].replace(/[0-9a-fA-F]{24}/g, ":id").replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, ":id");
  return SAFE_TOKEN.test(clean) ? clean : undefined;
}

/** Emits one structured event. Returns the object that was logged (for tests), or null if the event name was invalid. */
export function logEvent(event, fields = {}) {
  try {
    if (typeof event !== "string" || !EVENT_NAME.test(event)) return null;
    const out = { event, ts: new Date().toISOString() };
    for (const [key, value] of Object.entries(fields ?? {})) {
      if (!ALLOWED.has(key) || value === undefined || value === null) continue;
      if (typeof value === "number" ? Number.isFinite(value) : typeof value === "boolean" ? true : typeof value === "string" && SAFE_TOKEN.test(value)) out[key] = value;
    }
    sink(`[KOI EVENT] ${JSON.stringify(out)}`);
    return out;
  } catch {
    return null;
  }
}

export { ALLOWED_FIELDS };
