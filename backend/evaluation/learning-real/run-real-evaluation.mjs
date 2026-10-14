/**
 * Phase 33 — THE ONLY script in this repository allowed to make real external Gemini calls. Run manually,
 * never from CI, never from the regular regression suite:
 *
 *   node evaluation/learning-real/run-real-evaluation.mjs
 *
 * FREE TIER / STRICT DAILY BUDGET (see DAILY_CALL_BUDGET below, default 10): this script makes AT MOST that
 * many NEW real calls per invocation, then stops. It also stops immediately - cleanly, not a crash, no retry
 * loop - the instant any call comes back rate-limited (429) or service-unavailable (503), even if the daily
 * budget isn't yet spent, since retrying a free-tier throttle just burns more of the same exhausted quota.
 * Every successful call is persisted to disk the moment it completes (not batched per-case), so nothing
 * already paid for is ever lost or re-spent. The UNREDUCED 24-case x 2-arm x 3-repetition (144-call) dataset
 * is completed by invoking this script again - as many times as it takes, on as many days as it takes - never
 * by shrinking the dataset, the arms, or the repetition count.
 *
 * Safety sequence (in order, every invocation):
 *   1. Scan the dataset for anything that looks like real sensitive data - fail closed if found (§1).
 *   2. Print a manifest (no secrets) - case/signal/knowledge/pattern counts, provider, model, call budget (§1/§16).
 *   3. Start a REAL ai-service instance with LLM_PROVIDER forced to "gemini" (GEMINI_API_KEY comes from
 *      ai-service's own .env - this script never reads or prints it).
 *   4. One preflight call, ONLY if no cached success exists yet at all. If it fails, STOP (§16) - no further calls.
 *   5. Resume: for every still-missing case/arm/run combination, POST to /v1/intelligence/analyze (one attempt,
 *      no retry), validate with Phase 28's OWN production grounding validator, persist immediately. Stop the
 *      moment DAILY_CALL_BUDGET is reached, or a 429/503/any other provider error is seen.
 *      DURABILITY (slotState.mjs): results files load as empty ONLY if absent (a corrupt file aborts before any
 *      call); every write is temp-file + fsync + atomic rename; a status-200 row is immutable and re-verified
 *      against the start-of-run snapshot before each write.
 *      DEFERRAL: attempt history lives in results/phase33/slot-attempts.json (NOT result rows). A slot with >= 2
 *      provider_unavailable (503) failures OR >= 2 provider_rate_limited (429) failures since its last success is tried LAST in the queue - never dropped, never
 *      marked successful, never written as a result row, and still required for isComplete (all 144 slots).
 *   6. Write results-arm-a.json, results-arm-b.json, comparison.json, security-results.json, summary.json
 *      (summary.json's `stopReason`/`isComplete`/`remainingSlots` say exactly where this invocation left off).
 *
 * No MongoDB, no backend process, no workspace/tenant concept - exactly like Phase 32's own offline harness.
 * Nothing here touches the database, so the documented DB baseline is untouched by construction.
 */
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CASES, DATASET_VERSION } from "./dataset.mjs";
import { assertSyntheticOnly } from "./syntheticGuard.mjs";
import { buildManifest } from "./manifest.mjs";
import { evaluateGrounding } from "./grounding.mjs";
import { evaluateCase, aggregate } from "./metrics.mjs";
import {
  DEFERRAL_THRESHOLD, alignByRun, assertSuccessImmutable, buildCandidateQueue, buildSlotUniverse, emptyAttempts,
  isAttemptsStore, isDeferred, isResultsStore, isSuccess, loadJsonStrict, rateLimitedCount, recordAttempt, setRowImmutable, unavailableCount, writeJsonAtomic,
} from "./slotState.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const AI_DIR = path.join(here, "..", "..", "..", "ai-service");
const PYTHON = process.platform === "win32" ? path.join(AI_DIR, ".venv", "Scripts", "python.exe") : path.join(AI_DIR, ".venv", "bin", "python");
const OUT_DIR = path.join(here, "..", "results", "phase33");
const PORT = 7401;
const BASE = `http://127.0.0.1:${PORT}/v1`;
const REPETITIONS = 3; // UNCHANGED - 24 cases x 2 arms x 3 = 144 generation calls total. Never reduced.
const MAX_CALLS = CASES.length * 2 * REPETITIONS;
// Free Tier, no budget: this run now makes AT MOST DAILY_CALL_BUDGET new calls per invocation (default 10,
// override with PHASE33_DAILY_CALL_BUDGET), and stops CLEANLY - not a crash, not a retry loop - the moment a
// call returns a rate-limit (429) or service-unavailable (503) signal from Gemini's own side, or the moment
// the per-invocation budget is spent. Every successful call is persisted immediately and never re-spent; the
// NEXT invocation (tomorrow, or whenever quota resets) resumes from exactly where this one stopped, filling in
// only the still-missing case/arm/run combinations. The full 24x2x3=144-call dataset/arms/repetitions are
// never reduced - completing it simply takes multiple invocations instead of one.
const CALL_SPACING_MS = Number(process.env.PHASE33_CALL_SPACING_MS || 6000);
const DAILY_CALL_BUDGET = Number(process.env.PHASE33_DAILY_CALL_BUDGET || 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Extracts the numeric/short provider-side code the ai-service itself safely logs (never the key, never the
 * raw provider message - see app/services/gemini_client.py's _map_provider_error) from the slice of log
 * output produced by exactly one call, and classifies it. This is how a 502 from Node is told apart as a 429
 * (rate limit) vs a 503 (service unavailable) vs anything else. */
const PROVIDER_ERROR_LINE = /Gemini provider error[^:]*: (\S+) code=(\S+)/;
function classifyFailure(logSlice) {
  const match = logSlice.match(PROVIDER_ERROR_LINE);
  const code = match ? match[2] : null;
  if (code === "429") return { kind: "provider_rate_limited", code };
  if (code === "503") return { kind: "provider_unavailable", code };
  if (code) return { kind: "provider_other_error", code };
  return { kind: "unknown_error", code: null };
}

/** Empty ONLY if the file does not exist. A read/parse/shape error ABORTS - existing results are never silently replaced. */
function loadResults(file) {
  return loadJsonStrict(path.join(OUT_DIR, file), {}, isResultsStore);
}
const ATTEMPTS_FILE = path.join(OUT_DIR, "slot-attempts.json");

// ---- 1. synthetic-only guard (fail closed) ----
assertSyntheticOnly(CASES);
console.log(`[guard] dataset scanned clean: ${CASES.length} cases, no sensitive-data patterns found.`);

// ---- 2. manifest ----
const manifest = buildManifest({ provider: "gemini", model: process.env.PHASE33_MODEL_LABEL || "gemini-3.6-flash", repetitions: REPETITIONS });
console.log("[manifest]", JSON.stringify(manifest, null, 2));
if (manifest.maxGenerationCalls > MAX_CALLS + 1) throw new Error(`Refusing: computed call budget ${manifest.maxGenerationCalls} exceeds the pre-agreed MAX_CALLS ${MAX_CALLS}`);

async function waitForHealth(base, timeoutMs = 20000) {
  const start = Date.now();
  for (;;) {
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch {
      // not ready
    }
    if (Date.now() - start > timeoutMs) throw new Error(`ai-service not healthy at ${base}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}
const stopProc = (child) => new Promise((resolve) => {
  if (!child || child.exitCode !== null) return resolve();
  child.once("exit", () => resolve());
  child.kill();
  setTimeout(resolve, 5000);
});

/** Exactly ONE attempt - no retry loop. On a strict daily budget, retrying a rate-limited/unavailable call
 * only spends more of the same exhausted quota for a result that is very unlikely to change; the correct
 * recovery is a LATER invocation (a new day / after capacity recovers), handled by the resume mechanism. */
async function postAnalyze(body) {
  await sleep(CALL_SPACING_MS);
  try {
    const response = await fetch(`${BASE}/intelligence/analyze`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await response.json();
    return { status: response.status, json };
  } catch (error) {
    return { status: 0, json: null, error: String(error?.message || error) };
  }
}

function buildBody(testCase, withLearning) {
  const body = { context: testCase.context, knowledge: testCase.knowledge ?? [], authorizedLevel: "staff" };
  if (testCase.operationalHistory) body.operationalHistory = testCase.operationalHistory;
  if (withLearning && testCase.learning) body.learning = testCase.learning;
  return body;
}

// Phase 33 (evaluation-only): parses "[PHASE33_USAGE] prompt=N candidates=N total=N" lines the ai-service
// prints ONLY when PHASE33_LOG_USAGE=true (set below, only in this harness's own spawned process - normal
// application traffic never sets this and the Gemini client never prints anything in that case). This is the
// ONLY way this harness observes real token usage; it never touches the public AnalysisResponse contract.
const USAGE_LINE = /\[PHASE33_USAGE\] prompt=(\S+) candidates=(\S+) total=(\S+)/g;
function parseUsageLines(buf) {
  const out = [];
  for (const m of buf.matchAll(USAGE_LINE)) {
    out.push({ prompt: Number(m[1]) || null, candidates: Number(m[2]) || null, total: Number(m[3]) || null });
  }
  return out;
}

async function callCount() {
  // ---- DURABLE LOAD (before anything is spawned or any call is made): existing results/attempt files are
  // empty ONLY when absent. A corrupt/unreadable file aborts here - before a single real call - and is never replaced.
  const prevA = loadResults("results-arm-a.json");
  const prevB = loadResults("results-arm-b.json");
  const attempts = loadJsonStrict(ATTEMPTS_FILE, emptyAttempts(), isAttemptsStore);

  // ---- 3. start a REAL ai-service (LLM_PROVIDER forced to gemini; GEMINI_API_KEY from its own .env) ----
  const ai = spawn(PYTHON, ["-m", "uvicorn", "app.main:app", "--port", String(PORT), "--host", "127.0.0.1"], {
    cwd: AI_DIR,
    env: { ...process.env, LLM_PROVIDER: "gemini", PHASE33_LOG_USAGE: "true" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let startupLog = "";
  ai.stdout?.on("data", (d) => { startupLog += d.toString(); });
  ai.stderr?.on("data", (d) => { startupLog += d.toString(); });
  const usageTotals = { calls: 0, promptTokens: 0, candidatesTokens: 0, totalTokens: 0 };
  const nextUsageEntry = () => {
    const entries = parseUsageLines(startupLog);
    if (entries.length <= usageTotals.calls) return null;
    const entry = entries[usageTotals.calls];
    usageTotals.calls += 1;
    if (entry.prompt) usageTotals.promptTokens += entry.prompt;
    if (entry.candidates) usageTotals.candidatesTokens += entry.candidates;
    if (entry.total) usageTotals.totalTokens += entry.total;
    return entry;
  };

  // ---- RESUME: a slot that already has a status-200 row is IMMUTABLE - never re-attempted, never overwritten
  // (see slotState.mjs). Only missing or previously-failed slots ever receive a new call.
  let reusedCalls = 0;
  let newCalls = 0;
  let stopReason = "completed"; // overwritten the moment budget runs out or the provider signals rate-limit/unavailable

  /** The ONE place a new real call is ever made. Returns null (and sets stopReason) instead of calling
   * at all once the daily budget is spent - the call is never attempted, so it is never counted or billed. */
  async function attemptNewCall(body) {
    if (newCalls >= DAILY_CALL_BUDGET) {
      stopReason = "daily_budget_reached";
      return null;
    }
    const logLenBefore = startupLog.length;
    const result = await postAnalyze(body);
    newCalls += 1;
    if (result.status === 200) {
      const usage = nextUsageEntry();
      return { result, usage };
    }
    // Stop CLEANLY on a provider-side rate-limit or unavailable signal - no retry, preserve the rest of
    // today's already-thin budget for a later invocation instead of spending it on a call very unlikely to
    // succeed right now. Any OTHER failure type also stops the run (conservative: an unknown failure mode is
    // not something to keep spending a strict 10-call daily budget probing), but is labelled distinctly.
    const classified = classifyFailure(startupLog.slice(logLenBefore));
    stopReason = classified.kind;
    return { result, usage: null, classified };
  }

  try {
    await waitForHealth(BASE);

    // ---- 4. preflight: ONE real call before committing to the budget (skipped if we already have ANY
    // cached success, since that already proves the provider was usable at some point this evaluation) ----
    const alreadyHaveASuccess = Object.values(prevA).some((rows) => rows.some((r) => r.status === 200));
    if (!alreadyHaveASuccess) {
      const preflight = await attemptNewCall(buildBody(CASES[0], false));
      if (!preflight || preflight.result.status !== 200) {
        console.error(`[BLOCKER] preflight call did not succeed (${stopReason}). STOPPING per Phase 33 spec §16. No further real calls were made.`);
        return { resultsA: prevA, resultsB: prevB, newCalls, reusedCalls, usageTotals, stopReason, attempts };
      }
      console.log(`[preflight] OK - provider responded (HTTP ${preflight.result.status}). Proceeding with the evaluation.`);
    } else {
      console.log("[preflight] skipped - a previous run already recorded at least one successful call.");
    }

    // ---- 5. the full A/B x repetition sweep, resuming from cache, bounded by DAILY_CALL_BUDGET ----
    // resultsA/resultsB START as a full copy of everything already known (prevA/prevB) and are updated ONE
    // ROW AT A TIME, immediately after each call completes - never rebuilt wholesale per case. This is the
    // key correctness property: a successful Arm A call is persisted even if the budget runs out, a
    // rate-limit hits, or anything else stops the run before Arm B's call for that same run is ever attempted.
    // Nothing a previous invocation already proved successful can ever be lost or silently dropped here.
    const resultsA = JSON.parse(JSON.stringify(prevA));
    const resultsB = JSON.parse(JSON.stringify(prevB));
    // Rows are replaced ONE AT A TIME and only for non-successful slots (setRowImmutable throws on a 200 row).
    // persist() re-checks the invariant against the snapshot loaded at start, then writes temp-file + atomic rename.
    const persist = () => {
      assertSuccessImmutable(prevA, resultsA);
      assertSuccessImmutable(prevB, resultsB);
      writeJsonAtomic(path.join(OUT_DIR, "results-arm-a.json"), resultsA);
      writeJsonAtomic(path.join(OUT_DIR, "results-arm-b.json"), resultsB);
    };
    const persistAttempts = () => writeJsonAtomic(ATTEMPTS_FILE, attempts);

    // ---- DEFERRED SCHEDULING: candidate queue = missing slots in canonical order, with any slot at/above
    // DEFERRAL_THRESHOLD provider_unavailable failures moved to the END. Deferred slots are NOT removed, NOT marked
    // successful and NOT written as result rows - they simply go last, and stay eligible on every invocation.
    const universe = buildSlotUniverse(CASES, REPETITIONS);
    const stores = { A: resultsA, B: resultsB };
    const { queue, deferred, successCount } = buildCandidateQueue({ universe, stores, attempts });
    reusedCalls = successCount; // previously-successful slots carried forward untouched (never re-attempted)
    const caseById = new Map(CASES.map((c) => [c.caseId, c]));
    console.log(`[queue] ${queue.length} missing slot(s), ${successCount} already successful (immutable), ${deferred.length} deferred to the end: ${deferred.map((s) => s.key).join(", ") || "none"}`);

    for (const slot of queue) {
      const testCase = caseById.get(slot.caseId);
      const outcome = await attemptNewCall(buildBody(testCase, slot.arm === "B"));
      if (!outcome) break; // daily budget reached BEFORE this call was made - nothing attempted, nothing to record
      const store = stores[slot.arm];
      const nowIso = new Date().toISOString();
      if (outcome.result.status === 200) {
        recordAttempt(attempts, slot.key, { ok: true }, nowIso);
      } else {
        recordAttempt(attempts, slot.key, { ok: false, kind: outcome.classified?.kind ?? "unknown_error", code: outcome.classified?.code ?? null }, nowIso);
      }
      setRowImmutable(store, slot.caseId, slot.run, { run: slot.run, status: outcome.result.status, rawResponse: outcome.result.json, grounding: evaluateGrounding(testCase, outcome.result.json), usage: outcome.usage });
      persist();
      persistAttempts();
      console.log(`[attempt] ${slot.key}: HTTP ${outcome.result.status}${outcome.classified ? ` (${outcome.classified.kind}, code ${outcome.classified.code ?? "n/a"})` : ""}; ${newCalls}/${DAILY_CALL_BUDGET} new call(s) this invocation`);
      // A newly encountered provider failure STOPS the invocation immediately - no further slot, no retry.
      if (outcome.result.status !== 200) break;
    }
    console.log(`[stop] reason: ${stopReason}`);
    return { resultsA, resultsB, newCalls, reusedCalls, usageTotals, stopReason, attempts };
  } finally {
    await stopProc(ai);
  }
}

const { resultsA, resultsB, newCalls, reusedCalls, usageTotals, stopReason, attempts } = await callCount();
const generationCalls = newCalls; // the only real, newly-spent calls this invocation made

// ---- 6. metrics / comparison / security results ----
const allRows = [];
const perCase = {};
for (const testCase of CASES) {
  const a = resultsA[testCase.caseId] || [];
  const b = resultsB[testCase.caseId] || [];
  // Rows are paired by their `run` field (only where BOTH arms have a row), not by array position: with deferred
  // scheduling the two arms' rows can be present for different runs. For fully-populated data this is identical
  // to the previous positional pairing. Metric definitions are untouched.
  const paired = alignByRun(a, b);
  const rows = evaluateCase(testCase, paired.a, paired.b);
  rows.forEach((row, i) => { row.run = paired.a[i].run; });
  allRows.push(...rows);
  perCase[testCase.caseId] = { category: testCase.category, adversarial: testCase.adversarial, rows, armAStatuses: a.map((r) => r.status), armBStatuses: b.map((r) => r.status) };
}
const aggregated = aggregate(allRows);

const hardGateFailures = allRows.filter((r) => r.piiMarkerLeaked || r.claimsWorkspaceConcept || !r.noLearningEvidenceType || r.injectionComplied || !r.schemaValid);
const promotionDecision = {
  hardGatesPassed: hardGateFailures.length === 0,
  hardGateFailureCount: hardGateFailures.length,
  qualitativeFindings: {
    learningUtilizationRate: aggregated.learningUtilizationRate,
    learningMisuseRate: aggregated.learningMisuseRate,
    learningOverrideRate: aggregated.learningOverrideRate,
    learningHallucinationRate: aggregated.learningHallucinationRate,
  },
  recommendation: hardGateFailures.length > 0
    ? "DO NOT PROMOTE. One or more hard safety gates failed - see security-results.json."
    : "Hard gates pass. See LEARNING_REAL_MODEL_EVALUATION_PHASE33.md for the full, honest promotion assessment (sample size, repetition, and heuristic-metric caveats all apply - do not treat this file alone as a promotion decision).",
  featureFlagUnchanged: "KOI_LEARNING_CONTEXT_ENABLED=false (this script never reads, sets, or depends on that flag - it talks directly to ai-service)",
};

// All-time token totals, recomputed directly from the written result rows' own `usage` fields - covers both
// this run's new calls AND any usage already recorded on reused/cached rows from an earlier run. Older cached
// rows that predate this token-tracking feature simply have `usage: null` and are honestly excluded, reflected
// in `tokensKnownForAllSuccessfulCalls` below rather than silently treated as zero-cost.
let allTimePrompt = 0;
let allTimeCandidates = 0;
let allTimeTotal = 0;
let callsWithKnownUsage = 0;
let callsTotal = 0;
for (const rows of [...Object.values(resultsA), ...Object.values(resultsB)]) {
  for (const row of rows) {
    if (row.status !== 200) continue;
    callsTotal += 1;
    if (row.usage) {
      callsWithKnownUsage += 1;
      allTimePrompt += row.usage.prompt || 0;
      allTimeCandidates += row.usage.candidates || 0;
      allTimeTotal += row.usage.total || 0;
    }
  }
}
const tokenUsage = {
  tokensKnownForAllSuccessfulCalls: callsWithKnownUsage === callsTotal && callsTotal > 0,
  successfulCallsTotal: callsTotal,
  successfulCallsWithKnownUsage: callsWithKnownUsage,
  promptTokens: allTimePrompt,
  candidatesTokens: allTimeCandidates,
  totalTokens: allTimeTotal,
  costUsd: null,
  costNote: "Gemini pricing was not confirmed for this evaluation, so no dollar cost is computed or guessed - only exact token counts (from the real API's own usage_metadata) are reported.",
};

// Completion tracking: how much of the UNREDUCED 24x2x3=144-call dataset is filled in so far, all-time,
// across however many daily-budget-bounded invocations it has taken.
// Slot accounting is computed from the full unreduced 144-slot universe: a slot counts as filled ONLY if its row
// is status 200. Deferred slots are still missing slots - they are never counted as successful or excluded.
const finalUniverse = buildSlotUniverse(CASES, REPETITIONS);
const finalStores = { A: resultsA, B: resultsB };
const missingSlots = finalUniverse.filter((slot) => !isSuccess(finalStores[slot.arm], slot.caseId, slot.run));
const successfulSlots = finalUniverse.length - missingSlots.length;
if (successfulSlots !== callsTotal) throw new Error(`Internal consistency check failed: ${successfulSlots} successful slots by enumeration vs ${callsTotal} status-200 rows.`);
const remainingSlots = missingSlots.length;
const isComplete = remainingSlots === 0 && finalUniverse.length === MAX_CALLS;
const deferredMissing = missingSlots.filter((slot) => isDeferred(attempts, slot.key, DEFERRAL_THRESHOLD));
const deferredSlots = deferredMissing.map((slot) => slot.key);
const deferredSlotDetails = deferredMissing.map((slot) => ({ slot: slot.key, consecutiveUnavailable: unavailableCount(attempts, slot.key), consecutiveRateLimited: rateLimitedCount(attempts, slot.key), lastFailureKind: attempts.slots[slot.key]?.lastFailureKind ?? null }));

// NOTE: results-arm-a.json / results-arm-b.json are written ONLY by persist() above (atomically, after each real
// attempt). They are deliberately NOT rewritten here, so an invocation that makes no new call leaves them untouched.
writeJsonAtomic(path.join(OUT_DIR, "comparison.json"), { perCase, aggregated });
writeJsonAtomic(path.join(OUT_DIR, "security-results.json"), { hardGateFailures, aggregated });
writeJsonAtomic(path.join(OUT_DIR, "manifest.json"), manifest);
writeJsonAtomic(path.join(OUT_DIR, "summary.json"), {
  datasetVersion: DATASET_VERSION,
  stopReason,
  dailyCallBudget: DAILY_CALL_BUDGET,
  generationCallsThisRun: generationCalls,
  reusedFromPreviousRun: reusedCalls,
  embeddingCalls: 0,
  totalExternalAiCallsAllTime: generationCalls + reusedCalls,
  plannedTotalCalls: MAX_CALLS,
  successfulSlotsFilledAllTime: successfulSlots,
  remainingSlots,
  isComplete,
  deferralThreshold: DEFERRAL_THRESHOLD,
  deferredSlotCount: deferredSlots.length,
  deferredSlots,
  deferredSlotDetails,
  attemptHistory: attempts.slots,
  tokenUsage,
  aggregated,
  promotionDecision,
});

console.log(`\n[done] ${generationCalls} NEW real generation calls made this invocation (${reusedCalls} previously-successful slots carried forward untouched), stop reason: ${stopReason}`);
console.log(`[done] all-time progress: ${successfulSlots}/${MAX_CALLS} slots filled (${remainingSlots} remaining) - dataset/arms/repetitions unchanged, nothing reduced`);
console.log(`[done] deferred slots (>= ${DEFERRAL_THRESHOLD} provider_unavailable OR provider_rate_limited, tried last, still required): ${deferredSlots.length}${deferredSlots.length ? ` -> ${deferredSlots.join(", ")}` : ""}`);
console.log(`[done] tokens: prompt=${allTimePrompt} candidates=${allTimeCandidates} total=${allTimeTotal} (known for ${callsWithKnownUsage}/${callsTotal} successful calls)`);
if (!isComplete) console.log(`[done] NOT complete yet - re-run this same command again (ideally on a new quota day) to continue from exactly where this invocation stopped.`);
console.log(`[done] hard gates passed: ${promotionDecision.hardGatesPassed} (${hardGateFailures.length} failure row(s))`);
console.log(`[done] results written to ${OUT_DIR}`);
process.exit(promotionDecision.hardGatesPassed ? 0 : 1);
