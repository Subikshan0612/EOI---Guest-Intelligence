/**
 * Phase 33-Lite — slot scheduling state with HTTP 504 / DEADLINE_EXCEEDED treated as a transient provider failure.
 *
 * This is a thin EXTENSION of ../learning-real/slotState.mjs, not a change to it: that module is shared with (and
 * pinned for) the Gemini 3.6 Flash Phase 33 evaluation, whose behavior must stay byte-identical. Everything that is
 * unchanged is re-exported from it; only the three functions whose behavior gains 504 awareness (recordAttempt,
 * isDeferred, buildCandidateQueue) and the attempt-history validator are redefined here.
 *
 * Rules (same threshold and same "since the slot's last success" semantics as 429/503):
 *   - provider_unavailable (503)          -> consecutiveUnavailable
 *   - provider_rate_limited (429)         -> consecutiveRateLimited
 *   - provider_deadline_exceeded (504)    -> consecutiveDeadlineExceeded   (new, tracked separately)
 *   - a slot with >= DEFERRAL_THRESHOLD failures of ANY ONE of those classes is deferred to the END of the queue;
 *     it is never dropped, never marked successful, never written as a result row;
 *   - a failure of another class leaves a counter untouched; ONLY a success resets all of them.
 */
import {
  ARMS, DEFERRAL_THRESHOLD, alignByRun, assertSuccessImmutable, buildSlotUniverse, emptyAttempts, isAttemptsStore as baseIsAttemptsStore,
  isResultsStore, isSuccess, loadJsonStrict, rateLimitedCount, rowFor, setRowImmutable, slotKey, unavailableCount, writeJsonAtomic,
} from "../learning-real/slotState.mjs";

export {
  ARMS, DEFERRAL_THRESHOLD, alignByRun, assertSuccessImmutable, buildSlotUniverse, emptyAttempts, isResultsStore, isSuccess,
  loadJsonStrict, rateLimitedCount, rowFor, setRowImmutable, slotKey, unavailableCount, writeJsonAtomic,
};

export const TRANSIENT_FAILURE_KINDS = Object.freeze(["provider_unavailable", "provider_rate_limited", "provider_deadline_exceeded"]);

// consecutiveDeadlineExceeded is OPTIONAL on read (entries written before 504 handling existed lack it => 0).
export const isAttemptsStore = (value) => baseIsAttemptsStore(value)
  && Object.values(value.slots).every((s) => s.consecutiveDeadlineExceeded === undefined || (Number.isInteger(s.consecutiveDeadlineExceeded) && s.consecutiveDeadlineExceeded >= 0));

export const deadlineExceededCount = (attempts, key) => attempts.slots[key]?.consecutiveDeadlineExceeded ?? 0;

/** Deferred = >= threshold 503s OR >= threshold 429s OR >= threshold 504s since the slot's last success. */
export const isDeferred = (attempts, key, threshold = DEFERRAL_THRESHOLD) =>
  unavailableCount(attempts, key) >= threshold || rateLimitedCount(attempts, key) >= threshold || deadlineExceededCount(attempts, key) >= threshold;

/** Missing slots split into the normal queue and the deferred tail; deferred slots go LAST, still eligible. */
export function buildCandidateQueue({ universe, stores, attempts, threshold = DEFERRAL_THRESHOLD }) {
  const missing = universe.filter((slot) => !isSuccess(stores[slot.arm], slot.caseId, slot.run));
  const deferred = missing.filter((slot) => isDeferred(attempts, slot.key, threshold));
  const deferredKeys = new Set(deferred.map((s) => s.key));
  const normal = missing.filter((slot) => !deferredKeys.has(slot.key));
  return { queue: [...normal, ...deferred], deferred, missing, successCount: universe.length - missing.length };
}

/** Updates attempt history for one real attempt. A success is the ONLY thing that resets the counters. */
export function recordAttempt(attempts, key, outcome, nowIso) {
  const prior = attempts.slots[key] || {};
  const base = { consecutiveUnavailable: prior.consecutiveUnavailable ?? 0, consecutiveRateLimited: prior.consecutiveRateLimited ?? 0, consecutiveDeadlineExceeded: prior.consecutiveDeadlineExceeded ?? 0 };
  if (outcome.ok) {
    attempts.slots[key] = { ...prior, consecutiveUnavailable: 0, consecutiveRateLimited: 0, consecutiveDeadlineExceeded: 0, lastFailureKind: null, lastProviderCode: null, lastAttemptAt: nowIso };
    return;
  }
  attempts.slots[key] = {
    ...prior, // keeps any audit note (e.g. seededFromHistory) already on the entry
    consecutiveUnavailable: base.consecutiveUnavailable + (outcome.kind === "provider_unavailable" ? 1 : 0),
    consecutiveRateLimited: base.consecutiveRateLimited + (outcome.kind === "provider_rate_limited" ? 1 : 0),
    consecutiveDeadlineExceeded: base.consecutiveDeadlineExceeded + (outcome.kind === "provider_deadline_exceeded" ? 1 : 0),
    lastFailureKind: outcome.kind,
    lastProviderCode: outcome.code ?? null,
    lastAttemptAt: nowIso,
  };
}
