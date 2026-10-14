/**
 * The durable state of one analysis attempt, as the backend reports it (Workstream 5A: `GET /api/intelligence/analysis-status/:signalId`, and the body of the HTTP 202 answer
 * of `POST /api/intelligence/analyze/:signalId`). Pure and closed: it carries the server's state to the page and decides nothing.
 *
 *   not_started   nothing has been attempted for this report
 *   in_progress   an attempt is running (it carries on whatever the browser does)
 *   succeeded     the analysis is stored; the page reads it through the existing read (it is never carried in this payload)
 *   failed        the attempt ended without an analysis; `failure` = { code, class, httpStatus } - the already-public failure vocabulary, never a message
 *
 * A payload that is not one of these is an ERROR (never silently "not started" or "in progress"): a state the page cannot name must not be guessed.
 */
export const ATTEMPT_STATUS = Object.freeze({ NOT_STARTED: "not_started", IN_PROGRESS: "in_progress", SUCCEEDED: "succeeded", FAILED: "failed" });
const VALUES = new Set(Object.values(ATTEMPT_STATUS));
const CODE = /^[A-Z0-9_]{1,64}$/;

/** @returns {{ status: string, failure: {code: string, httpStatus: number} | null }} */
export function mapAttemptState(payload) {
  if (!payload || typeof payload !== "object" || typeof payload.status !== "string" || !VALUES.has(payload.status)) {
    throw new Error("The server returned an unexpected analysis state.");
  }
  if (payload.status !== ATTEMPT_STATUS.FAILED) return { status: payload.status, failure: null };
  const failure = payload.failure && typeof payload.failure === "object" ? payload.failure : {};
  return {
    status: ATTEMPT_STATUS.FAILED,
    failure: { code: typeof failure.code === "string" && CODE.test(failure.code) ? failure.code : "INTERNAL_ERROR", httpStatus: Number.isInteger(failure.httpStatus) ? failure.httpStatus : 0 },
  };
}
