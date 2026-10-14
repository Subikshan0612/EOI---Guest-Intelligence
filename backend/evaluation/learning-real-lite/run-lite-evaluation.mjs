/**
 * Phase 33-Lite — resumable real-model evaluation on `gemini-3.1-flash-lite`. A COMPLETELY SEPARATE evaluation from
 * Phase 33 (Gemini 3.6 Flash): it never reads, writes, resumes from, or reinterprets Phase 33's results. Only the
 * LLM model differs; dataset, prompts, context construction, evidence/grounding rules, metrics, safety gates and the
 * hardened provider-failure handling are the same (the shared pieces are imported from ../learning-real/ unchanged;
 * the orchestration below mirrors the hardened Phase 33 runner, and validate-phase33-lite-evaluation.mjs checks the
 * mirrored logic has not drifted).
 *
 *   node evaluation/learning-real-lite/run-lite-evaluation.mjs
 *
 * Makes AT MOST DAILY_CALL_BUDGET (default 8) NEW real calls per invocation, one attempt each, no retries. Stops
 * immediately on the first new provider failure (429, 503, 504/DEADLINE_EXCEEDED or any other). Every success is
 * persisted immediately (temp file + fsync + atomic rename) and is immutable. Slots with >= 2 provider_unavailable
 * (503) OR >= 2 provider_rate_limited (429) OR >= 2 provider_deadline_exceeded (504) failures since their last
 * success are tried LAST (never dropped, never marked successful). Results, attempt history
 * and summaries live ONLY under results/phase33-lite-gemini-3.1-flash-lite/.
 *
 * No MongoDB, no backend process, no workspace concept, no Action/Outcome/Decision writes, no embeddings.
 * Production KOI_LEARNING_CONTEXT_ENABLED is never read for behavior and is refused if set to true.
 */
import path from "node:path";
import { spawn } from "node:child_process";
import { CASES, DATASET_VERSION } from "../learning-real/dataset.mjs";
import { assertSyntheticOnly } from "../learning-real/syntheticGuard.mjs";
import { evaluateGrounding } from "../learning-real/grounding.mjs";
import { evaluateCase, aggregate } from "../learning-real/metrics.mjs";
import {
  DEFERRAL_THRESHOLD, alignByRun, assertSuccessImmutable, buildCandidateQueue, buildSlotUniverse, emptyAttempts,
  deadlineExceededCount, isAttemptsStore, isDeferred, isResultsStore, isSuccess, loadJsonStrict, rateLimitedCount, recordAttempt, setRowImmutable, unavailableCount, writeJsonAtomic,
} from "./lite-slotState.mjs";
import {
  AI_DIR, DEFAULT_CALL_SPACING_MS, DEFAULT_DAILY_CALL_BUDGET, EVALUATION_ID, LITE_MODEL, LITE_PORT, LITE_PROVIDER, LITE_RESULTS_DIR, REPETITIONS, assertLiteConfig, liteSpawnEnv, loadLiteApiKey,
} from "./lite-config.mjs";
import { liteManifest } from "./lite-identity.mjs";

assertLiteConfig();

const PYTHON = process.platform === "win32" ? path.join(AI_DIR, ".venv", "Scripts", "python.exe") : path.join(AI_DIR, ".venv", "bin", "python");
const OUT_DIR = LITE_RESULTS_DIR;
const BASE = `http://127.0.0.1:${LITE_PORT}/v1`;
const MAX_CALLS = CASES.length * 2 * REPETITIONS;
const CALL_SPACING_MS = Number(process.env.PHASE33_LITE_CALL_SPACING_MS || DEFAULT_CALL_SPACING_MS);
const DAILY_CALL_BUDGET = Number(process.env.PHASE33_LITE_DAILY_CALL_BUDGET || DEFAULT_DAILY_CALL_BUDGET);
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
  if (code === "504") return { kind: "provider_deadline_exceeded", code };
  if (code) return { kind: "provider_other_error", code };
  if (logSlice.includes("DEADLINE_EXCEEDED")) return { kind: "provider_deadline_exceeded", code: "504" };
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

// ---- 2. manifest (same builder as Phase 33, Lite model, plus identity block) ----
const manifest = liteManifest();
console.log("[manifest]", JSON.stringify(manifest, null, 2));
if (manifest.maxGenerationCalls !== MAX_CALLS) throw new Error(`Refusing: computed call budget ${manifest.maxGenerationCalls} != ${MAX_CALLS}`);
console.log(`[lite] model=${LITE_MODEL} provider=${LITE_PROVIDER} namespace=${path.basename(OUT_DIR)} dailyBudget=${DAILY_CALL_BUDGET}`);

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

/** Exactly ONE attempt - no retry loop. */
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

// Parses "[PHASE33_USAGE] prompt=N candidates=N total=N" lines the ai-service prints ONLY when PHASE33_LOG_USAGE=true
// (set in this harness's own spawned process only). Never touches the public AnalysisResponse contract.
const USAGE_LINE = /\[PHASE33_USAGE\] prompt=(\S+) candidates=(\S+) total=(\S+)/g;
function parseUsageLines(buf) {
  const out = [];
  for (const m of buf.matchAll(USAGE_LINE)) {
    out.push({ prompt: Number(m[1]) || null, candidates: Number(m[2]) || null, total: Number(m[3]) || null });
  }
  return out;
}

async function callCount() {
  // ---- DURABLE LOAD (before anything is spawned or any call is made) ----
  const prevA = loadResults("results-arm-a.json");
  const prevB = loadResults("results-arm-b.json");
  const attempts = loadJsonStrict(ATTEMPTS_FILE, emptyAttempts(), isAttemptsStore);

  // ---- dedicated Lite API key: resolved BEFORE anything is spawned; a missing key (or one identical to the default
  // Gemini 3.6 key) aborts here. The key value is never logged, written, or placed in any artifact. ----
  const liteKey = loadLiteApiKey();
  console.log(`[lite] dedicated Lite API key detected (source: ${liteKey.source}); value not shown.`);

  // ---- 3. start a REAL ai-service: LLM_PROVIDER=gemini, LLM_MODEL=gemini-3.1-flash-lite, GEMINI_API_KEY=<Lite key> (spawned env only) ----
  const ai = spawn(PYTHON, ["-m", "uvicorn", "app.main:app", "--port", String(LITE_PORT), "--host", "127.0.0.1"], {
    cwd: AI_DIR,
    env: liteSpawnEnv(process.env, liteKey.key),
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

  let reusedCalls = 0;
  let newCalls = 0;
  let stopReason = "completed"; // overwritten the moment budget runs out or the provider signals a failure

  /** The ONE place a new real call is ever made. Returns null (and sets stopReason) instead of calling at all once
   * the daily budget is spent - the call is never attempted, so it is never counted or billed. */
  async function attemptNewCall(body) {
    if (newCalls >= DAILY_CALL_BUDGET) {
      stopReason = "daily_budget_reached";
      return null;
    }
    const logLenBefore = startupLog.length;
    const result = await postAnalyze(body);
    newCalls += 1;
    if (result.status === 200) {
      // Lite-only safety: refuse to record a "Lite" result unless the response itself says it came from the Lite model.
      const provider = result.json?.provenance?.provider;
      const model = result.json?.provenance?.model;
      if (provider !== LITE_PROVIDER || model !== LITE_MODEL) {
        stopReason = "model_mismatch";
        throw new Error(`Refusing to record a result: response provenance is ${provider}/${model}, expected ${LITE_PROVIDER}/${LITE_MODEL}. Nothing was written for this call.`);
      }
      const usage = nextUsageEntry();
      return { result, usage };
    }
    // Stop on ANY new provider failure - no retry. The failure class is recorded for deferral scheduling.
    let classified = classifyFailure(startupLog.slice(logLenBefore));
    if (classified.kind === "unknown_error" && result.status === 504) classified = { kind: "provider_deadline_exceeded", code: "504" };
    stopReason = classified.kind;
    return { result, usage: null, classified };
  }

  try {
    await waitForHealth(BASE);

    // ---- 4. no separate real preflight call: the first queued slot is itself the probe, and any failure stops the
    // invocation before a second call, so a dedicated preflight call would only spend quota. (Configuration is
    // validated WITHOUT a generation call by preflight-config.mjs.) ----

    // ---- 5. resume sweep, bounded by DAILY_CALL_BUDGET ----
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

// ---- 6. metrics / comparison / security results (identical methodology to Phase 33) ----
const allRows = [];
const perCase = {};
for (const testCase of CASES) {
  const a = resultsA[testCase.caseId] || [];
  const b = resultsB[testCase.caseId] || [];
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
    : "Hard gates pass on gemini-3.1-flash-lite. This is a SEPARATE evaluation from Phase 33 (Gemini 3.6 Flash); neither result substitutes for the other. Sample size, repetition and heuristic-metric caveats apply - do not treat this file alone as a promotion decision.",
  featureFlagUnchanged: "KOI_LEARNING_CONTEXT_ENABLED=false (this script never enables it and refuses to run if it is true - it talks directly to ai-service)",
};

// All-time token totals, recomputed from the written rows' own `usage` fields.
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
  costNote: "Pricing was not confirmed for this evaluation, so no dollar cost is computed or guessed - only exact token counts (from the real API's own usage_metadata) are reported.",
};

// Slot accounting over the full unreduced 144-slot universe: a slot is filled ONLY if its row is status 200.
const finalUniverse = buildSlotUniverse(CASES, REPETITIONS);
const finalStores = { A: resultsA, B: resultsB };
const missingSlots = finalUniverse.filter((slot) => !isSuccess(finalStores[slot.arm], slot.caseId, slot.run));
const successfulSlots = finalUniverse.length - missingSlots.length;
if (successfulSlots !== callsTotal) throw new Error(`Internal consistency check failed: ${successfulSlots} successful slots by enumeration vs ${callsTotal} status-200 rows.`);
const remainingSlots = missingSlots.length;
const isComplete = remainingSlots === 0 && finalUniverse.length === MAX_CALLS;
const deferredMissing = missingSlots.filter((slot) => isDeferred(attempts, slot.key, DEFERRAL_THRESHOLD));
const deferredSlots = deferredMissing.map((slot) => slot.key);
const deferredSlotDetails = deferredMissing.map((slot) => ({ slot: slot.key, consecutiveUnavailable: unavailableCount(attempts, slot.key), consecutiveRateLimited: rateLimitedCount(attempts, slot.key), consecutiveDeadlineExceeded: deadlineExceededCount(attempts, slot.key), lastFailureKind: attempts.slots[slot.key]?.lastFailureKind ?? null }));

// results-arm-a.json / results-arm-b.json are written ONLY by persist() above, so an invocation that makes no new
// call leaves them untouched.
writeJsonAtomic(path.join(OUT_DIR, "comparison.json"), { evaluationId: EVALUATION_ID, model: LITE_MODEL, perCase, aggregated });
writeJsonAtomic(path.join(OUT_DIR, "security-results.json"), { evaluationId: EVALUATION_ID, model: LITE_MODEL, hardGateFailures, aggregated });
writeJsonAtomic(path.join(OUT_DIR, "manifest.json"), manifest);
writeJsonAtomic(path.join(OUT_DIR, "summary.json"), {
  evaluationId: EVALUATION_ID,
  separateFromPhase33: true,
  provider: LITE_PROVIDER,
  model: LITE_MODEL,
  datasetVersion: DATASET_VERSION,
  datasetSha256: manifest.identity.datasetSha256,
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

console.log(`\n[done] ${generationCalls} NEW real generation calls made this invocation on ${LITE_MODEL} (${reusedCalls} previously-successful Lite slots carried forward untouched), stop reason: ${stopReason}`);
console.log(`[done] all-time Lite progress: ${successfulSlots}/${MAX_CALLS} slots filled (${remainingSlots} remaining) - dataset/arms/repetitions unchanged, nothing reduced`);
console.log(`[done] deferred slots (>= ${DEFERRAL_THRESHOLD} provider_unavailable OR provider_rate_limited OR provider_deadline_exceeded, tried last, still required): ${deferredSlots.length}${deferredSlots.length ? ` -> ${deferredSlots.join(", ")}` : ""}`);
console.log(`[done] tokens: prompt=${allTimePrompt} candidates=${allTimeCandidates} total=${allTimeTotal} (known for ${callsWithKnownUsage}/${callsTotal} successful calls)`);
if (!isComplete) console.log(`[done] NOT complete yet - re-run this same command again to continue from exactly where this invocation stopped.`);
console.log(`[done] hard gates passed: ${promotionDecision.hardGatesPassed} (${hardGateFailures.length} failure row(s))`);
console.log(`[done] results written to ${OUT_DIR}`);
process.exit(promotionDecision.hardGatesPassed ? 0 : 1);
