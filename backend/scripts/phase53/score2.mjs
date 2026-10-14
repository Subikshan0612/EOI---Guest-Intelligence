/**
 * Phase 53B.1 - scoring entry point for the repeated runs. Reads out2/raw-results.json and applies the FROZEN rubric v2 (rubric2.mjs). No network, no database: it can be
 * re-run at any time with identical results. Also verifies that dataset2.mjs, rubric2.mjs and this file still match out2/rubric2.sha256 (taken BEFORE the run).
 * Usage: node scripts/phase53/score2.mjs      Writes out2/scores2.json and out2/SCORES2.md.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CATEGORY_NAMES, KNOWLEDGE_DOCS, SCENARIOS } from "./dataset2.mjs";
import { DIMENSIONS, HARD_GATES, classifyRejection, directiveCount, mean, scoreRun } from "./rubric2.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, "out2");
const raw = JSON.parse(fs.readFileSync(path.join(OUT, "raw-results.json"), "utf8"));
const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(path.join(here, file))).digest("hex");
const nowHashes = Object.fromEntries(["dataset2.mjs", "rubric2.mjs", "score2.mjs"].map((f) => [f, sha(f)]));
let frozen = null; try { frozen = JSON.parse(fs.readFileSync(path.join(OUT, "rubric2.sha256"), "utf8")); } catch { /* none */ }
const rubricUnchanged = Boolean(frozen) && Object.keys(nowHashes).every((f) => frozen.files?.[f] === nowHashes[f]);

const byId = new Map(SCENARIOS.map((s) => [s.id, s]));
const dims = Object.keys(DIMENSIONS);
const pct = (v) => (v === null || v === undefined ? "n/a" : `${(v * 100).toFixed(0)}%`);
const pctOf = (n, d) => (d ? `${n}/${d} (${((n / d) * 100).toFixed(0)}%)` : `${n}/0`);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const p95 = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)] : null; };
const CONF = { low: 1, medium: 2, high: 3 };
const PROVIDER_CODES = /PROVIDER|TIMEOUT|UNAVAILABLE|RATE_LIMIT/i;

const results = [];
for (const run of raw.runs) {
  const scenario = byId.get(run.id);
  const doc = scenario.expect?.guidance ? KNOWLEDGE_DOCS.find((d) => d.key === scenario.expect.guidance.doc) : null;
  const prepared = { ...run, guidanceConcepts: doc?.concepts ?? [], distractorMarkers: doc ? KNOWLEDGE_DOCS.filter((d) => d.key !== doc.key).flatMap((d) => d.distinctive) : [] };
  const st = run.analysis?.status; const code = run.analysis?.errorCode ?? null;
  const outcomeClass = !run.signalId ? "no signal recorded" : !run.analysis?.attempted ? "not attempted" : st === 201 || st === 200 ? "success" : run.aiStatus && run.aiStatus !== 200 ? "provider failure" : PROVIDER_CODES.test(String(code)) ? "provider failure" : st ? "validator rejection" : "other failure";
  prepared.outcomeClass = outcomeClass;
  const scored = scoreRun(scenario, prepared);
  const rejection = outcomeClass === "validator rejection" ? classifyRejection(scenario, prepared) : null;
  results.push({ runKey: `${run.id}#${run.round}`, id: run.id, round: run.round, cat: scenario.cat, ws: scenario.ws, outcomeClass, ...scored, rejection, stored: run.stored ?? null, errorCode: code, ms: run.analysisMs ?? null, learningSensitive: Boolean(scenario.learningSensitive),
    directives: run.analysis?.view?.analysis ? directiveCount(run.analysis.view.analysis.recommendation) : null, safetyRaw: run.analysis?.view?.safety ?? null });
}

const scoredRuns = results.filter((r) => r.scored);
const aggregate = (rs) => ({ runs: rs.length, scored: rs.filter((r) => r.scored).length, overall: mean(rs.filter((r) => r.scored).flatMap((r) => dims.map((d) => r.scores[d]))), byDimension: Object.fromEntries(dims.map((d) => [d, mean(rs.filter((r) => r.scored).map((r) => r.scores[d]))])) });
const perCategory = Object.fromEntries(Object.keys(CATEGORY_NAMES).map((c) => [c, { name: CATEGORY_NAMES[c], scenarios: SCENARIOS.filter((s) => s.cat === c).length, ...aggregate(results.filter((r) => r.cat === c)) }]));
const perDimension = Object.fromEntries(dims.map((d) => [d, { name: DIMENSIONS[d], mean: mean(scoredRuns.map((r) => r.scores[d])), applicableRuns: scoredRuns.filter((r) => typeof r.scores[d] === "number").length, zeroOrPartialRuns: scoredRuns.filter((r) => typeof r.scores[d] === "number" && r.scores[d] < 2).length }]));

// ---- per scenario (repeats)
const perScenario = SCENARIOS.map((s) => {
  const rs = results.filter((r) => r.id === s.id); const sc = rs.filter((r) => r.scored);
  const sameSet = (key) => new Set(sc.map((r) => JSON.stringify(key(r)))).size <= 1;
  return { id: s.id, cat: s.cat, runs: rs.length, scored: sc.length, outcomes: rs.map((r) => r.outcomeClass), meanByDimension: Object.fromEntries(dims.map((d) => [d, mean(sc.map((r) => r.scores[d]))])), overall: mean(sc.flatMap((r) => dims.map((d) => r.scores[d]))),
    consistent: { urgency: sc.length > 1 ? sameSet((r) => r.facts.urgency) : null, actionType: sc.length > 1 ? sameSet((r) => r.facts.actionType) : null, gates: sc.length > 1 ? sameSet((r) => Object.entries(r.gates).filter(([, v]) => v).map(([k]) => k)) : null, scoresIdentical: sc.length > 1 ? sameSet((r) => r.scores) : null },
    gatesAnyRun: Object.keys(HARD_GATES).filter((g) => sc.some((r) => r.gates[g])), notes: [...new Set(sc.flatMap((r) => r.notes))] };
});

// ---- hard gates (per run and per scenario; never averaged)
const gateTable = Object.fromEntries(Object.keys(HARD_GATES).map((g) => [g, { description: HARD_GATES[g], failingRuns: results.filter((r) => r.scored && r.gates[g]).map((r) => r.runKey), scoredRuns: scoredRuns.length, scenariosWithAFailingRun: [...new Set(results.filter((r) => r.scored && r.gates[g]).map((r) => r.id))] }]));
// gates that depend only on what was SENT (cross-tenant, PII, human boundary) are also evaluated for runs with no analysis
const gatesWithoutAnalysis = ["cross_workspace_data", "pii_leakage", "autonomous_action_execution"].map((g) => [g, results.filter((r) => !r.scored && r.gates[g]).map((r) => r.runKey)]);

// ---- baseline metrics
const attempted = results.filter((r) => r.outcomeClass !== "no signal recorded" && r.outcomeClass !== "not attempted");
const successes = results.filter((r) => r.outcomeClass === "success");
const providerFailures = results.filter((r) => r.outcomeClass === "provider failure");
const rejections = results.filter((r) => r.outcomeClass === "validator rejection");
const analyzeCalls = raw.gemini.calls.filter((c) => c.kind === "analyze");
const ms = analyzeCalls.map((c) => c.ms);
const rate = (pred) => scoredRuns.filter(pred).length;
const metrics = {
  scenarios: SCENARIOS.length, runsPerScenario: raw.meta.rounds, plannedRuns: SCENARIOS.length * raw.meta.rounds, attemptedAnalyses: attempted.length, successfulAnalyses: successes.length,
  providerFailures: providerFailures.length, validatorRejections: rejections.length, validatorRejectionsByCategory: Object.fromEntries([...new Set(rejections.map((r) => r.rejection?.category))].map((c) => [c, rejections.filter((r) => r.rejection?.category === c).length])),
  otherFailures: results.filter((r) => r.outcomeClass === "other failure").length, noSignal: results.filter((r) => r.outcomeClass === "no signal recorded").length,
  persistedIntelligenceRows: successes.reduce((s, r) => s + (r.stored?.intelCount ?? 0), 0), persistedAfterFailedCalls: [...providerFailures, ...rejections].reduce((s, r) => s + (r.stored?.intelCount ?? 0), 0),
  latencyMs: { median: median(ms), p95: p95(ms), min: Math.min(...ms), max: Math.max(...ms), n: ms.length },
  dimensionMeans: Object.fromEntries(dims.map((d) => [d, perDimension[d].mean])),
  fabricatedPolicyRate: { runs: rate((r) => r.gates.fabricated_business_policy), of: scoredRuns.length }, fabricatedFactRate: { runs: rate((r) => r.gates.fabricated_operational_fact), of: scoredRuns.length },
  internalRefsInStoredProse: { runsWithRefs: rate((r) => r.facts.refsStored > 0), of: scoredRuns.length, totalRefs: scoredRuns.reduce((s, r) => s + r.facts.refsStored, 0), byField: ["situation", "evidence", "impact", "recommendation"].map((f) => [f, scoredRuns.reduce((s, r) => s + (r.facts.refsStoredByField?.[f] ?? 0), 0)]) },
  internalRefsAfterPresentation: { runsWithRefs: rate((r) => (r.facts.refsPresented ?? 0) > 0), of: scoredRuns.length, totalRefs: scoredRuns.reduce((s, r) => s + (r.facts.refsPresented ?? 0), 0) },
  softPolicyImplications: { runs: rate((r) => r.facts.policySoft > 0), of: scoredRuns.length }, hardPolicyClaims: { runs: rate((r) => r.facts.policyHard > 0), of: scoredRuns.length },
};

// ---- confidence by RAG hit / miss
const confOf = (r) => r.stored?.admission?.finalConfidence;
const confSummary = (rs) => { const c = rs.map(confOf).filter(Boolean); return { runs: c.length, distribution: Object.fromEntries(["low", "medium", "high"].map((k) => [k, c.filter((x) => x === k).length])), meanLevel: c.length ? Number((c.reduce((s, x) => s + CONF[x], 0) / c.length).toFixed(2)) : null, modelCappedRuns: rs.filter((r) => r.stored?.admission?.confidenceCapped).length, ceilingReasons: Object.fromEntries([...new Set(rs.flatMap((r) => r.stored?.admission?.ceilingReasons ?? []))].map((k) => [k, rs.filter((r) => (r.stored?.admission?.ceilingReasons ?? []).includes(k)).length])) }; };
const accepted = (r) => r.scored && r.stored?.admission?.outcome === "accepted";
const confidence = { ragHit: confSummary(results.filter((r) => r.cat === "E" && accepted(r))), ragMiss: confSummary(results.filter((r) => r.ws === "NK" && accepted(r))), ragMissMatchedF: confSummary(results.filter((r) => r.cat === "F" && accepted(r))) };

// ---- RAG hit vs miss (matched pairs, per round)
const pairRows = [];
for (const e of SCENARIOS.filter((s) => s.cat === "E")) {
  for (let round = 1; round <= raw.meta.rounds; round += 1) {
    const hit = results.find((r) => r.id === e.id && r.round === round); const miss = results.find((r) => r.id === e.pair && r.round === round);
    if (!hit || !miss) continue;
    pairRows.push({ pair: `${e.id}/${e.pair}`, round, both: hit.scored && miss.scored, hitOutcome: hit.outcomeClass, missOutcome: miss.outcomeClass, hit: hit.scored ? { D1: hit.scores.D1, D6: hit.scores.D6, D7: hit.scores.D7, D8: hit.scores.D8, D9: hit.scores.D9, D4: hit.scores.D4, conf: confOf(hit), urgency: hit.facts.urgency, type: hit.facts.actionType, directives: hit.directives, words: hit.facts.recWords, gates: Object.entries(hit.gates).filter(([, v]) => v).map(([k]) => k) } : null, miss: miss.scored ? { D1: miss.scores.D1, D6: miss.scores.D6, D7: miss.scores.D7, D8: miss.scores.D8, D9: miss.scores.D9, D4: miss.scores.D4, conf: confOf(miss), urgency: miss.facts.urgency, type: miss.facts.actionType, directives: miss.directives, words: miss.facts.recWords, gates: Object.entries(miss.gates).filter(([, v]) => v).map(([k]) => k) } : null });
  }
}
const bothRows = pairRows.filter((p) => p.both);
const avg = (rows, side, key) => { const v = rows.map((r) => r[side][key]).filter((x) => typeof x === "number"); return v.length ? Number((v.reduce((s, x) => s + x, 0) / v.length).toFixed(2)) : null; };
const ragComparison = { pairsAttempted: pairRows.length, pairsBothScored: bothRows.length, means: Object.fromEntries(["D1", "D6", "D7", "D8", "D9", "directives", "words"].map((k) => [k, { hit: avg(bothRows, "hit", k), miss: avg(bothRows, "miss", k) }])), confidence: { hit: avg(bothRows.map((r) => ({ ...r, hit: { c: CONF[r.hit.conf] }, miss: { c: CONF[r.miss.conf] } })), "hit", "c"), miss: avg(bothRows.map((r) => ({ ...r, hit: { c: CONF[r.hit.conf] }, miss: { c: CONF[r.miss.conf] } })), "miss", "c") }, rows: pairRows };

// ---- learning / history / human boundary / pipeline checks (observations the collector made)
const analysed = results.filter((r) => raw.runs.find((x) => x.id === r.id && x.round === r.round)?.request);
const reqOf = (r) => raw.runs.find((x) => x.id === r.id && x.round === r.round)?.request;
const pipeline = {
  learningKeyInAnyRequest: analysed.filter((r) => "learning" in reqOf(r)).length, learningUsedInAnyAdmission: results.filter((r) => r.stored?.admission?.learningUsed).length, learningFlagInCollectorEnv: raw.staticChecks.learningFlagInEnv,
  historyScenarios: ["A5", "D1", "D2", "D3", "D4", ...SCENARIOS.filter((s) => s.learningSensitive).map((s) => s.id)].map((id) => ({ id, runsAnalysed: analysed.filter((r) => r.id === id).length, withHistoricalAnalysesSupplied: analysed.filter((r) => r.id === id && (reqOf(r).operationalHistory?.intelligence ?? []).length > 0).length, withReviewedDecisionsSupplied: analysed.filter((r) => r.id === id && (reqOf(r).operationalHistory?.decisions ?? []).length > 0).length, expectsAnalyses: (byId.get(id).history ?? []).some((h) => h.relevant && h.analysis) })),
  tenantMarkerInAnyRequest: analysed.filter((r) => JSON.stringify(reqOf(r)).includes("TENANTX-MARKER")).length, tenantMarkerInRetrievedKnowledge: analysed.filter((r) => JSON.stringify(reqOf(r).knowledge ?? []).includes("TENANTX")).length,
  piiInAnyRequest: analysed.filter((r) => raw.runs.find((x) => x.id === r.id && x.round === r.round).pii.some((p) => JSON.stringify(reqOf(r)).toLowerCase().includes(p.toLowerCase()))).length,
  everyRequestHadPropertyUnitStayGuestAndReport: analysed.every((r) => { const c = reqOf(r).context; return c.property?.available && c.unit?.available && c.stay?.available && c.guest?.available && c.signal?.description; }),
  conflictCheckSent: analysed.filter((r) => (reqOf(r).context.reportChecks ?? []).length).map((r) => r.runKey),
  ragMissStillProducedIntelligence: results.filter((r) => r.cat === "F" && r.outcomeClass === "success").length, ragHitSuppliedAndCited: results.filter((r) => r.cat === "E" && r.scored).map((r) => ({ run: r.runKey, retrieved: r.facts.retrieved, cited: r.facts.cited })),
};

const out = { rubricVersion: "phase53-rubric-2", rubricUnchanged, frozenHashes: frozen?.files ?? null, currentHashes: nowHashes, metrics, overall: mean(scoredRuns.flatMap((r) => dims.map((d) => r.scores[d]))), perDimension, perCategory, perScenario, gates: gateTable, gatesWithoutAnalysis, hardGateScenarios: [...new Set(results.filter((r) => Object.values(r.gates).some(Boolean)).map((r) => r.id))], confidence, ragComparison, rejections: rejections.map((r) => ({ run: r.runKey, ...r.rejection })), pipeline, journeys: raw.journeys, staticChecks: raw.staticChecks, results };
fs.writeFileSync(path.join(OUT, "scores2.json"), JSON.stringify(out, null, 2));

const L = [];
L.push(`# Phase 53B.1 scores (rubric ${out.rubricVersion}; unchanged since frozen: ${rubricUnchanged})`, "",
  `Scenarios ${metrics.scenarios} x ${metrics.runsPerScenario} runs = ${metrics.plannedRuns} planned; attempted ${metrics.attemptedAnalyses}; successful ${metrics.successfulAnalyses}; provider failures ${metrics.providerFailures}; validator rejections ${metrics.validatorRejections} ${JSON.stringify(metrics.validatorRejectionsByCategory)}; other ${metrics.otherFailures}; no signal ${metrics.noSignal}`,
  `Persisted Intelligence rows ${metrics.persistedIntelligenceRows} (after failed calls: ${metrics.persistedAfterFailedCalls}); latency median ${metrics.latencyMs.median} ms, p95 ${metrics.latencyMs.p95} ms (n=${metrics.latencyMs.n})`,
  `Overall (mean of applicable scores over ${scoredRuns.length} scored runs, % of maximum): ${pct(out.overall)}`, "", "## By dimension", ...dims.map((d) => `- ${d} ${DIMENSIONS[d]}: ${pct(perDimension[d].mean)} (runs n=${perDimension[d].applicableRuns}, not-fully-correct ${perDimension[d].zeroOrPartialRuns})`),
  "", "## By category", ...Object.entries(perCategory).map(([c, v]) => `- ${c} ${v.name}: ${pct(v.overall)} (scored ${v.scored}/${v.runs} runs)`),
  "", "## Hard gates (runs failing / scored runs)", ...Object.entries(gateTable).map(([g, v]) => `- ${g}: ${v.failingRuns.length}/${v.scoredRuns}${v.failingRuns.length ? ` in ${v.failingRuns.join(", ")}` : ""}`),
  "", "## Rates", `- fabricated business policy: ${pctOf(metrics.fabricatedPolicyRate.runs, metrics.fabricatedPolicyRate.of)}`, `- fabricated operational fact: ${pctOf(metrics.fabricatedFactRate.runs, metrics.fabricatedFactRate.of)}`, `- internal refs in STORED prose: ${pctOf(metrics.internalRefsInStoredProse.runsWithRefs, metrics.internalRefsInStoredProse.of)} (${metrics.internalRefsInStoredProse.totalRefs} tokens; ${JSON.stringify(metrics.internalRefsInStoredProse.byField)})`, `- internal refs after PRESENTATION: ${pctOf(metrics.internalRefsAfterPresentation.runsWithRefs, metrics.internalRefsAfterPresentation.of)}`, `- implied-authority (soft) wording: ${pctOf(metrics.softPolicyImplications.runs, metrics.softPolicyImplications.of)}; property-policy (hard) claims: ${pctOf(metrics.hardPolicyClaims.runs, metrics.hardPolicyClaims.of)}`,
  "", "## Confidence", `- RAG hit: ${JSON.stringify(confidence.ragHit)}`, `- RAG miss (all NK): ${JSON.stringify(confidence.ragMiss)}`, `- RAG miss (matched F): ${JSON.stringify(confidence.ragMissMatchedF)}`,
  "", "## Per scenario", ...perScenario.map((s) => `- ${s.id} [${s.cat}] runs ${s.scored}/${s.runs} (${s.outcomes.join(", ")}) overall ${pct(s.overall)}${s.gatesAnyRun.length ? `  GATES(any run): ${s.gatesAnyRun.join(",")}` : ""}${s.notes.length ? `\n    ${s.notes.join("\n    ")}` : ""}`));
fs.writeFileSync(path.join(OUT, "SCORES2.md"), L.join("\n"));
console.log(L.join("\n"));
