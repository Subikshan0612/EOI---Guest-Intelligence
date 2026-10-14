/**
 * Phase 33 — finalizes the evaluation artifacts from whatever partial real-model data was actually collected,
 * WITHOUT making any further network/real-model calls. Used because the configured Gemini key hit a
 * sustained rate-limit/quota block (see LEARNING_REAL_MODEL_EVALUATION_PHASE33.md) after only 12 of the
 * planned 145 calls succeeded. The resulting summary.json is explicitly marked INCONCLUSIVE - this is not a
 * safety or quality finding, it is an honest statement that too little real-model data exists to draw one.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CASES, DATASET_VERSION } from "./dataset.mjs";
import { evaluateCase, aggregate } from "./metrics.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(here, "..", "results", "phase33");

const resultsA = JSON.parse(fs.readFileSync(path.join(OUT_DIR, "results-arm-a.json"), "utf8"));
const resultsB = JSON.parse(fs.readFileSync(path.join(OUT_DIR, "results-arm-b.json"), "utf8"));

const allRows = [];
const perCase = {};
let successfulPairs = 0;
let attemptedPairs = 0;
for (const testCase of CASES) {
  const a = resultsA[testCase.caseId] || [];
  const b = resultsB[testCase.caseId] || [];
  attemptedPairs += Math.max(a.length, b.length);
  successfulPairs += a.filter((r, i) => r.status === 200 && b[i]?.status === 200).length;
  const rows = evaluateCase(testCase, a, b).filter((_, i) => a[i]?.status === 200 && b[i]?.status === 200);
  allRows.push(...rows);
  perCase[testCase.caseId] = { category: testCase.category, adversarial: testCase.adversarial, rows, armAStatuses: a.map((r) => r.status), armBStatuses: b.map((r) => r.status) };
}
const aggregated = allRows.length ? aggregate(allRows) : null;

let aOk = 0, aTotal = 0, bOk = 0, bTotal = 0;
for (const k of Object.keys(resultsA)) for (const r of resultsA[k]) { aTotal += 1; if (r.status === 200) aOk += 1; }
for (const k of Object.keys(resultsB)) for (const r of resultsB[k]) { bTotal += 1; if (r.status === 200) bOk += 1; }

let promptTokens = 0, candidatesTokens = 0, totalTokens = 0, callsWithKnownUsage = 0, callsTotal = 0;
for (const rows of [...Object.values(resultsA), ...Object.values(resultsB)]) {
  for (const row of rows) {
    if (row.status !== 200) continue;
    callsTotal += 1;
    if (row.usage) { callsWithKnownUsage += 1; promptTokens += row.usage.prompt || 0; candidatesTokens += row.usage.candidates || 0; totalTokens += row.usage.total || 0; }
  }
}
const tokenUsage = { tokensKnownForAllSuccessfulCalls: callsWithKnownUsage === callsTotal && callsTotal > 0, successfulCallsTotal: callsTotal, successfulCallsWithKnownUsage: callsWithKnownUsage, promptTokens, candidatesTokens, totalTokens, costUsd: null, costNote: "Gemini pricing was not confirmed for this evaluation, so no dollar cost is computed or guessed." };

const summary = {
  status: "INCONCLUSIVE",
  reason: "Gemini provider quota/rate-limit exhaustion. Two attempts (an initial full sweep plus a paced, backed-off resume) together produced only a small fraction of the planned 144 calls as HTTP 200 successes; a 10+ minute backoff window produced zero further successes, indicating a sustained (likely daily) quota block rather than a brief per-minute throttle.",
  datasetVersion: DATASET_VERSION,
  plannedCalls: CASES.length * 2 * 3,
  attemptedCallsArmA: aTotal,
  successfulCallsArmA: aOk,
  attemptedCallsArmB: bTotal,
  successfulCallsArmB: bOk,
  totalExternalAiCallsAllTime: aTotal + bTotal,
  successfulPairsUsableForComparison: successfulPairs,
  casesWithAnyData: Object.keys(resultsA).filter((k) => (resultsA[k] || []).length > 0),
  embeddingCalls: 0,
  tokenUsage,
  aggregatedOverPartialData: aggregated,
  promotionDecision: {
    hardGatesPassed: "not_determinable_from_this_sample_size",
    recommendation: "INCONCLUSIVE — insufficient evidence to enable Learning. Do not treat the small partial sample as representative. KOI_LEARNING_CONTEXT_ENABLED remains false.",
    featureFlagUnchanged: "KOI_LEARNING_CONTEXT_ENABLED=false (unchanged; this harness never reads or sets it)",
  },
};

fs.writeFileSync(path.join(OUT_DIR, "comparison.json"), `${JSON.stringify({ perCase, aggregated }, null, 2)}\n`);
fs.writeFileSync(path.join(OUT_DIR, "security-results.json"), `${JSON.stringify({ hardGateFailures: [], aggregated, note: "Insufficient successful pairs to compute meaningful hard-gate statistics; see summary.json's INCONCLUSIVE status." }, null, 2)}\n`);
fs.writeFileSync(path.join(OUT_DIR, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
