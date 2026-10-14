/**
 * Phase 33 — durable storage + slot scheduling helpers for run-real-evaluation.mjs. Pure/local: no network, no
 * database, no Gemini. Kept in its own module so the durability and scheduling rules can be checked without ever
 * running the real-model runner.
 *
 * Three guarantees live here:
 *   1. DURABLE I/O: a results/attempt file is treated as empty ONLY when it does not exist. Any read or JSON
 *      parse error aborts - a corrupt file is never silently replaced. Writes go to a temp file, are fsync'd, then
 *      atomically renamed into place, so a crash mid-write cannot truncate an existing results file.
 *   2. IMMUTABLE SUCCESSES: a status-200 row can never be re-attempted, overwritten or regenerated.
 *   3. DEFERRED SCHEDULING: a slot with >= DEFERRAL_THRESHOLD provider_unavailable (Gemini 503) failures OR
 *      >= DEFERRAL_THRESHOLD provider_rate_limited (Gemini 429) failures since its last success is moved to the
 *      END of the candidate queue. It is never removed, never marked successful and never
 *      written as a result row - it stays a missing slot, eligible on every future invocation.
 */
import fs from "node:fs";
import path from "node:path";

export const ARMS = ["A", "B"];
export const DEFERRAL_THRESHOLD = 2;
export const slotKey = (arm, caseId, run) => `${arm}/${caseId}/${run}`;

/** Missing file => `emptyValue`. Anything else wrong (unreadable, not valid JSON, wrong shape) => throw. */
export function loadJsonStrict(filePath, emptyValue, validate = () => true) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return emptyValue;
    throw new Error(`Refusing to continue: cannot read ${path.basename(filePath)} (${error?.code || error?.message}). Existing results are never replaced.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Refusing to continue: ${path.basename(filePath)} exists but is not valid JSON. It is NOT being replaced - restore or inspect it manually.`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || !validate(parsed)) {
    throw new Error(`Refusing to continue: ${path.basename(filePath)} exists but does not have the expected structure. It is NOT being replaced.`);
  }
  return parsed;
}

/** temp file -> fsync -> rename over the target. The target is either the old content or the new, never partial. */
export function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  const data = `${JSON.stringify(value, null, 2)}\n`;
  try {
    const fd = fs.openSync(tmp, "w");
    try {
      fs.writeSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, filePath);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw error;
  }
}

/** A results file: { [caseId]: [ {run, status, ...}, ... ] } */
export const isResultsStore = (value) => Object.values(value).every((rows) => Array.isArray(rows) && rows.every((r) => r && typeof r === "object" && Number.isInteger(r.run) && Number.isInteger(r.status)));

export const emptyAttempts = () => ({
  schemaVersion: 1,
  note: "Attempt history ONLY - these are NOT evaluation result rows and are never read by the metrics. Keyed by arm/caseId/run.",
  slots: {},
});

// consecutiveRateLimited is OPTIONAL on read (entries written before 429 deferral existed lack it => 0).
export const isAttemptsStore = (value) => value.schemaVersion === 1 && value.slots && typeof value.slots === "object" && !Array.isArray(value.slots)
  && Object.values(value.slots).every((s) => s && Number.isInteger(s.consecutiveUnavailable) && s.consecutiveUnavailable >= 0
    && (s.consecutiveRateLimited === undefined || (Number.isInteger(s.consecutiveRateLimited) && s.consecutiveRateLimited >= 0)));

export const unavailableCount = (attempts, key) => attempts.slots[key]?.consecutiveUnavailable ?? 0;
export const rateLimitedCount = (attempts, key) => attempts.slots[key]?.consecutiveRateLimited ?? 0;

/** Deferred = 2+ provider_unavailable (503) OR 2+ provider_rate_limited (429) failures since the slot's last success. */
export const isDeferred = (attempts, key, threshold = DEFERRAL_THRESHOLD) => unavailableCount(attempts, key) >= threshold || rateLimitedCount(attempts, key) >= threshold;

/** Every (arm, case, run) slot of the UNREDUCED dataset, in canonical order: case, run, then arm A before arm B. */
export function buildSlotUniverse(cases, repetitions) {
  const universe = [];
  for (const testCase of cases) {
    for (let run = 0; run < repetitions; run += 1) {
      for (const arm of ARMS) universe.push({ arm, caseId: testCase.caseId, run, key: slotKey(arm, testCase.caseId, run) });
    }
  }
  return universe;
}

export const rowFor = (store, caseId, run) => (store[caseId] || []).find((r) => r.run === run) || null;
export const isSuccess = (store, caseId, run) => rowFor(store, caseId, run)?.status === 200;
const storeFor = (arm, stores) => (arm === "A" ? stores.A : stores.B);

/** Missing slots split into the normal queue and the deferred tail; deferred slots go LAST, still eligible. */
export function buildCandidateQueue({ universe, stores, attempts, threshold = DEFERRAL_THRESHOLD }) {
  const missing = universe.filter((slot) => !isSuccess(storeFor(slot.arm, stores), slot.caseId, slot.run));
  const deferred = missing.filter((slot) => isDeferred(attempts, slot.key, threshold));
  const deferredKeys = new Set(deferred.map((s) => s.key));
  const normal = missing.filter((slot) => !deferredKeys.has(slot.key));
  return { queue: [...normal, ...deferred], deferred, missing, successCount: universe.length - missing.length };
}

/** Updates attempt history for one real attempt. A success is the ONLY thing that resets the counters. Each failure
 * class has its own counter (503 => consecutiveUnavailable, 429 => consecutiveRateLimited); a failure of the other
 * class, or any other kind, leaves the counter untouched (counts are "since the slot's last success"). */
export function recordAttempt(attempts, key, outcome, nowIso) {
  const prior = attempts.slots[key] || { consecutiveUnavailable: 0, consecutiveRateLimited: 0, lastFailureKind: null, lastProviderCode: null, lastAttemptAt: null };
  if (outcome.ok) {
    attempts.slots[key] = { consecutiveUnavailable: 0, consecutiveRateLimited: 0, lastFailureKind: null, lastProviderCode: null, lastAttemptAt: nowIso };
    return;
  }
  attempts.slots[key] = {
    consecutiveUnavailable: prior.consecutiveUnavailable + (outcome.kind === "provider_unavailable" ? 1 : 0),
    consecutiveRateLimited: (prior.consecutiveRateLimited ?? 0) + (outcome.kind === "provider_rate_limited" ? 1 : 0),
    lastFailureKind: outcome.kind,
    lastProviderCode: outcome.code ?? null,
    lastAttemptAt: nowIso,
  };
}

/** Throws unless every status-200 row of `prevStore` is still present and byte-identical (as JSON) in `currentStore`. */
export function assertSuccessImmutable(prevStore, currentStore) {
  for (const [caseId, rows] of Object.entries(prevStore)) {
    for (const row of rows) {
      if (row.status !== 200) continue;
      const now = rowFor(currentStore, caseId, row.run);
      if (!now || JSON.stringify(now) !== JSON.stringify(row)) {
        throw new Error(`Invariant violated: previously successful slot ${caseId}/run${row.run} changed or disappeared. Aborting before writing.`);
      }
    }
  }
}

/** Insert/replace ONE row by run index. Refuses to touch a status-200 row. Keeps each case's rows ordered by run. */
export function setRowImmutable(store, caseId, run, row) {
  store[caseId] = store[caseId] || [];
  const idx = store[caseId].findIndex((r) => r.run === run);
  if (idx >= 0) {
    if (store[caseId][idx].status === 200) throw new Error(`Refusing to overwrite successful slot ${caseId}/run${run}.`);
    store[caseId][idx] = row;
  } else {
    store[caseId].push(row);
  }
  store[caseId].sort((x, y) => x.run - y.run);
}

/** Pairs Arm A / Arm B rows by their `run` field (not array position), only where BOTH arms have a row. */
export function alignByRun(aRows = [], bRows = []) {
  const bByRun = new Map(bRows.map((r) => [r.run, r]));
  const pairs = aRows.filter((r) => bByRun.has(r.run)).sort((x, y) => x.run - y.run);
  return { a: pairs, b: pairs.map((r) => bByRun.get(r.run)) };
}
