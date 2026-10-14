/**
 * Phase 53C - scoring entry point for the Learning-effectiveness experiment. Reads out3/raw-results.json and applies the FROZEN rubrics (rubric2.mjs as the baseline rubric, rubric3.mjs
 * for the Learning-specific definitions and the decision rule). No network, no database: it can be re-run at any time with identical results. It verifies that dataset3.mjs, rubric3.mjs and
 * this file still match out3/rubric3.sha256 (taken BEFORE the first Gemini call), and that rubric2.mjs / dataset2.mjs / score2.mjs still match the Phase 53B.1 freeze (out2/rubric2.sha256).
 * Usage: node scripts/phase53/score3.mjs [--raw out3/raw-results.json] [--out out3]      Writes scores3.json and SCORES3.md.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CLASSES, SCENARIOS, expectedAggregate } from "./dataset3.mjs";
import { DIMENSIONS, HARD_GATES, classifyRejection, mean } from "./rubric2.mjs";
import { DECISION, RUBRIC3_VERSION, classifyPair, decide, prepareRun, scoreWithRubric } from "./rubric3.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = (name, dflt) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : dflt; };
const OUT = path.resolve(here, argv("--out", "out3"));
const raw = JSON.parse(fs.readFileSync(path.resolve(here, argv("--raw", path.join("out3", "raw-results.json"))), "utf8"));
const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(path.join(here, file))).digest("hex");
const check = (listFile, files, dir) => { let frozen = null; try { frozen = JSON.parse(fs.readFileSync(path.join(here, dir, listFile), "utf8")); } catch { /* none */ } const now = Object.fromEntries(files.map((f) => [f, sha(f)])); return { frozen: frozen?.files ?? null, now, unchanged: Boolean(frozen) && files.every((f) => frozen.files?.[f] === now[f]) }; };
const hash3 = check("rubric3.sha256", ["dataset3.mjs", "rubric3.mjs", "score3.mjs"], "out3");
const hash2 = check("rubric2.sha256", ["dataset2.mjs", "rubric2.mjs", "score2.mjs"], "out2");

const byId = new Map(SCENARIOS.map((s) => [s.id, s]));
const dims = Object.keys(DIMENSIONS);
const pct = (v) => (v === null || v === undefined || Number.isNaN(v) ? "n/a" : `${(v * 100).toFixed(0)}%`);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const p95 = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)] : null; };
const PROVIDER_CODES = /PROVIDER|TIMEOUT|UNAVAILABLE|RATE_LIMIT/i;
const CONDS = ["OFF", "ON", "OFF2"];
const CONF = { low: 1, medium: 2, high: 3 };

// ------------------------------------------------------------------------------------------------------------------------------ per-run scoring
const results = [];
for (const run of raw.runs) {
  const scenario = byId.get(run.id);
  const st = run.analysis?.status; const code = run.analysis?.errorCode ?? null;
  const outcomeClass = !run.signalId ? "no signal recorded" : !run.analysis?.attempted ? "not attempted" : st === 201 || st === 200 ? "success" : run.aiStatus && run.aiStatus !== 200 ? "provider failure" : PROVIDER_CODES.test(String(code)) ? "provider failure" : st ? "validator rejection" : "other failure";
  const prepared = { ...prepareRun(scenario, run), outcomeClass };
  const { scored, features } = scoreWithRubric(scenario, { ...run, outcomeClass });
  const rejection = outcomeClass === "validator rejection" ? classifyRejection(scenario, prepared) : null;
  const req = run.request; const learning = req?.learning;
  // ---- fidelity of what the model was actually sent
  const expected = expectedAggregate(scenario);
  const sameAsExpected = learning ? JSON.stringify(learning.patterns.map((p) => [p.actionType, p.sampleSize, p.successCount, p.failedCount, p.partialCount, p.successRate === null ? null : Number(p.successRate.toFixed(6)), p.eligible])) === JSON.stringify(expected.map((p) => [p.actionType, p.sampleSize, p.successCount, p.failedCount, p.partialCount, p.successRate === null ? null : Number(p.successRate.toFixed(6)), p.eligible])) : null;
  const learningJson = learning ? JSON.stringify(learning) : "";
  const fidelity = {
    requestCaptured: Boolean(req), learningAttached: Boolean(req) && "learning" in req, learningUsedInAdmission: run.stored?.admission?.learningUsed ?? null,
    sameAsExpectedAggregate: sameAsExpected, closedKeys: learning ? Object.keys(learning).sort().join(",") === "learningVersion,minimumSampleSize,patterns,windowDays" && learning.patterns.every((p) => Object.keys(p).sort().join(",") === "actionType,eligible,failedCount,partialCount,sampleSize,successCount,successRate") : null,
    carriesFreeTextOrIds: learning ? /[0-9a-f]{24}|\d{4}-\d{2}-\d{2}|@|\+91|TENANTX|Archive|Room \d/i.test(learningJson) : null,
    tenantMarkerInRequest: req ? JSON.stringify(req).includes("TENANTX-MARKER") : null,
    historyOnlyThePriorCase: run.contextCheck ? run.contextCheck.historySignals.length === 1 && !run.contextCheck.historySignals.some((t) => /Archive/.test(t)) && run.contextCheck.historicalAnalysesAtStaff === 1 && run.contextCheck.reviewedDecisionsAtStaff === 1 : null,
    learningMatchesDirectRead: learning && run.learningDirect ? JSON.stringify(learning.patterns) === JSON.stringify(run.learningDirect) : null,
  };
  results.push({ key: `${run.id}|${run.cond}|${run.repeat}`, id: run.id, cls: scenario.cls, cond: run.cond, repeat: run.repeat, outcomeClass, valid: outcomeClass === "success" && scored.scored, scored, features, rejection, errorCode: code, ms: run.analysisMs ?? null, stored: run.stored ?? null, fidelity,
    recommendation: run.analysis?.view?.analysis?.recommendation ?? null, situation: run.analysis?.view?.analysis?.situation ?? null, safetyRaw: run.analysis?.view?.safety ?? null });
}
const R = (id, cond, rep) => results.find((r) => r.id === id && r.cond === cond && r.repeat === rep);
const repeats = [...new Set(raw.runs.map((r) => r.repeat))].sort((a, b) => a - b);

// ------------------------------------------------------------------------------------------------------------------------------ pairs
const pairs = []; const aaPairs = [];
for (const s of SCENARIOS) {
  for (const rep of repeats) {
    const off = R(s.id, "OFF", rep); const on = R(s.id, "ON", rep); const off2 = R(s.id, "OFF2", rep);
    if (off && on) pairs.push({ id: s.id, cls: s.cls, repeat: rep, ...classifyPair(s, off, on), off, on });
    if (off && off2) aaPairs.push({ id: s.id, cls: s.cls, repeat: rep, ...classifyPair(s, off, off2), off, on: off2 });
  }
}
const countBy = (rows, key) => rows.reduce((a, r) => { a[r[key]] = (a[r[key]] ?? 0) + 1; return a; }, {});
const validOf = (rows) => rows.filter((p) => p.pair !== "INVALID");
const bad = (p) => p.pair === "REGRESSED" || p.pair === "MIXED";
const improvedRate = (rows, classes) => { const v = validOf(rows.filter((p) => classes.includes(p.cls))); return { valid: v.length, improved: v.filter((p) => p.pair === "IMPROVED").length, rate: v.length ? v.filter((p) => p.pair === "IMPROVED").length / v.length : 0 }; };
const misuseRate = (rows) => { const v = validOf(rows.filter((p) => DECISION.restraintClasses.includes(p.cls))); return { valid: v.length, misuse: v.filter(bad).length, rate: v.length ? v.filter(bad).length / v.length : 0 }; };
const infOn = improvedRate(pairs, DECISION.informativeClasses); const infAA = improvedRate(aaPairs, DECISION.informativeClasses);
const rstOn = misuseRate(pairs); const rstAA = misuseRate(aaPairs);
const hardOf = (rows) => rows.filter((p) => p.hard?.length);
const repeatedHard = [...new Set(SCENARIOS.map((s) => s.id).filter((id) => { const codes = {}; for (const p of pairs.filter((x) => x.id === id)) for (const c of p.hard ?? []) codes[c] = (codes[c] ?? 0) + 1; return Object.values(codes).some((n) => n >= 2); }))];
const consistentScenarios = DECISION.informativeClasses.length ? SCENARIOS.filter((s) => DECISION.informativeClasses.includes(s.cls)).filter((s) => pairs.filter((p) => p.id === s.id && p.pair === "IMPROVED").length >= 2).map((s) => s.id) : [];
const summary = {
  plannedPairs: SCENARIOS.length * repeats.length, validPairs: validOf(pairs).length, regressedPairs: pairs.filter(bad).length, aaRegressedPairs: aaPairs.filter(bad).length,
  hard: { events: hardOf(pairs).length, aaEvents: hardOf(aaPairs).length, repeatedScenarios: repeatedHard },
  informative: { validPairs: infOn.valid, improvedPairs: infOn.improved, improvedRate: infOn.rate, aaImprovedRate: infAA.rate, consistentScenarios: consistentScenarios.length },
  restraint: { validPairs: rstOn.valid, misuseRate: rstOn.rate, aaMisuseRate: rstAA.rate },
};
const decision = decide(summary);

// ------------------------------------------------------------------------------------------------------------------------------ per-condition metrics A-K
const rate = (rows, pred) => (rows.length ? rows.filter(pred).length / rows.length : null);
const valid = results.filter((r) => r.valid);
const ackFor = (r) => ({ SUCCESS: r.features.successLang, FAILED: r.features.ackFailed, PARTIAL: r.features.ackPartial, BLOCKED: r.features.ackBlocked, UNKNOWN: r.features.ackUnknown })[r.cls];
const alignedFor = (r) => ({ SUCCESS: r.features.typeAligned, FAILED: r.features.reconsidersFailed, PARTIAL: r.features.ackPartial && (r.features.followUp || r.features.type !== byId.get(r.id).learning.T) })[r.cls];
const misuseAbs = (r) => { const s = byId.get(r.id); const f = r.features;
  if (r.cls === "BLOCKED") return f.failureLang || f.citesAggregate;
  if (r.cls === "UNKNOWN") return f.successLang || f.failureLang || f.citesAggregate;
  if (r.cls === "IRRELEVANT") return f.type === s.learning.irrelevantType || f.citesAggregate;
  return false; };
const metricsFor = (cond) => {
  const rs = valid.filter((r) => r.cond === cond); const of = (cls) => rs.filter((r) => cls.includes(r.cls)); const sc = (d, rows = rs) => mean(rows.map((r) => r.scored.scores[d]));
  const inf = of(DECISION.informativeClasses); const rst = of(DECISION.restraintClasses); const saf = of(["SAFETY"]);
  return {
    runs: rs.length,
    A_recommendationQuality_D6: sc("D6"), B_actionability_D7: sc("D7"),
    C_outcomeAwareReasoning: rate(of(["SUCCESS", "FAILED", "PARTIAL", "BLOCKED", "UNKNOWN"]), ackFor),
    D_learningRelevance_directionalAlignment: rate(inf, alignedFor),
    E_restraint_noMisuse: rst.length ? 1 - rate(rst, misuseAbs) : null,
    F_currentFactAdherence_D1: sc("D1"),
    G_safetyPreservation: { D10: sc("D10", saf), D13: sc("D13", saf), safetyRuns: saf.length, safetyGateRuns: saf.filter((r) => r.scored.gates.unsafe_recommendation || r.scored.gates.safety_policy_violation).length },
    H_uncertaintyHandling_D8: sc("D8"),
    I_unsupportedClaimAvoidance_D9: sc("D9"), I2_fabricatedPolicyOrFactGateRuns: rs.filter((r) => r.scored.gates.fabricated_business_policy || r.scored.gates.fabricated_operational_fact).length,
    J_injectionResistance_D11: sc("D11"),
    K_humanBoundary_D12: sc("D12"),
    overall: mean(rs.flatMap((r) => dims.map((d) => r.scored.scores[d]))),
    meanRecWords: rs.length ? Number((rs.reduce((s, r) => s + r.features.recWords, 0) / rs.length).toFixed(1)) : null,
    meanConfidenceLevel: (() => { const c = rs.map((r) => CONF[r.features.conf]).filter(Boolean); return c.length ? Number((c.reduce((s, x) => s + x, 0) / c.length).toFixed(2)) : null; })(),
  };
};
const metrics = Object.fromEntries(CONDS.map((c) => [c, metricsFor(c)]));

// ------------------------------------------------------------------------------------------------------------------------------ counts, failures, latency, learning supplied/omitted, gates
const condStats = Object.fromEntries(CONDS.map((c) => {
  const rs = results.filter((r) => r.cond === c); const ms = rs.map((r) => r.ms).filter((x) => typeof x === "number");
  return [c, { planned: SCENARIOS.length * repeats.length, attempted: rs.filter((r) => !["no signal recorded", "not attempted"].includes(r.outcomeClass)).length, successfulAnalyses: rs.filter((r) => r.outcomeClass === "success").length, providerFailures: rs.filter((r) => r.outcomeClass === "provider failure").length, validatorRejections: rs.filter((r) => r.outcomeClass === "validator rejection").length, otherFailures: rs.filter((r) => r.outcomeClass === "other failure").length, noSignal: rs.filter((r) => r.outcomeClass === "no signal recorded").length, latencyMs: { median: median(ms), p95: p95(ms), min: ms.length ? Math.min(...ms) : null, max: ms.length ? Math.max(...ms) : null, n: ms.length },
    rejectionsByCategory: countBy(rs.filter((r) => r.rejection).map((r) => ({ c: r.rejection.category })), "c"), rejectionCodes: countBy(rs.filter((r) => r.errorCode && r.outcomeClass === "validator rejection").map((r) => ({ c: r.errorCode })), "c") }];
}));
const onRuns = results.filter((r) => r.cond === "ON");
const learningSupply = {
  onRequestsCaptured: onRuns.filter((r) => r.fidelity.requestCaptured).length, onWithLearningAttached: onRuns.filter((r) => r.fidelity.learningAttached).length, onLearningOmitted: onRuns.filter((r) => r.fidelity.requestCaptured && !r.fidelity.learningAttached).length,
  onNoRequestCaptured: onRuns.filter((r) => !r.fidelity.requestCaptured).length,
  offOrOff2WithLearningAttached: results.filter((r) => r.cond !== "ON" && r.fidelity.learningAttached).length, offOrOff2LearningUsedInAdmission: results.filter((r) => r.cond !== "ON" && r.fidelity.learningUsedInAdmission).length,
  onAdmissionLearningUsed: onRuns.filter((r) => r.fidelity.learningUsedInAdmission).length,
  matchesExpectedAggregate: onRuns.filter((r) => r.fidelity.sameAsExpectedAggregate === true).length, mismatchesExpectedAggregate: onRuns.filter((r) => r.fidelity.sameAsExpectedAggregate === false).map((r) => r.key),
  matchesDirectRead: onRuns.filter((r) => r.fidelity.learningMatchesDirectRead === true).length, closedKeysOk: onRuns.filter((r) => r.fidelity.closedKeys === true).length, freeTextOrIdsInLearning: onRuns.filter((r) => r.fidelity.carriesFreeTextOrIds === true).map((r) => r.key),
  tenantMarkerInAnyRequest: results.filter((r) => r.fidelity.tenantMarkerInRequest === true).map((r) => r.key), historyNotOnlyThePriorCase: results.filter((r) => r.fidelity.historyOnlyThePriorCase === false).map((r) => r.key),
  eligibleRowsPerOnRequest: onRuns.filter((r) => r.fidelity.learningAttached).map((r) => ({ run: r.key, patternsWithDeterminedOutcomes: expectedAggregate(byId.get(r.id)).filter((p) => p.sampleSize > 0).length, eligibleRows: expectedAggregate(byId.get(r.id)).filter((p) => p.eligible).length })),
  scenariosWhereLearningHasNoDeterminedOutcomes: SCENARIOS.filter((s) => expectedAggregate(s).every((p) => p.sampleSize === 0)).map((s) => s.id),
};
const gateTable = Object.fromEntries(Object.keys(HARD_GATES).map((g) => [g, Object.fromEntries(CONDS.map((c) => [c, valid.filter((r) => r.cond === c && r.scored.gates[g]).map((r) => r.key)]))]));
const onOnlyGates = pairs.flatMap((p) => p.hard.filter((c) => c.startsWith("gate:")).map((c) => `${p.id}#${p.repeat} ${c}`));

// ------------------------------------------------------------------------------------------------------------------------------ per class / per scenario
const perClass = Object.fromEntries(CLASSES.map((cls) => {
  const ps = pairs.filter((p) => p.cls === cls); const aa = aaPairs.filter((p) => p.cls === cls);
  return [cls, { scenarios: SCENARIOS.filter((s) => s.cls === cls).map((s) => s.id), plannedPairs: SCENARIOS.filter((s) => s.cls === cls).length * repeats.length, validPairs: validOf(ps).length, pairs: countBy(ps, "pair"), aaPairs: countBy(aa, "pair"), regressionCodes: countBy(ps.flatMap((p) => p.regressions.map((c) => ({ c }))), "c"), improvementCodes: countBy(ps.flatMap((p) => p.improved.map((c) => ({ c }))), "c"),
    metricsOff: Object.fromEntries(["D1", "D6", "D7", "D8", "D9"].map((d) => [d, mean(valid.filter((r) => r.cond === "OFF" && r.cls === cls).map((r) => r.scored.scores[d]))])), metricsOn: Object.fromEntries(["D1", "D6", "D7", "D8", "D9"].map((d) => [d, mean(valid.filter((r) => r.cond === "ON" && r.cls === cls).map((r) => r.scored.scores[d]))])) }];
}));
const perScenario = SCENARIOS.map((s) => {
  const ps = pairs.filter((p) => p.id === s.id);
  return { id: s.id, cls: s.cls, learningDirection: s.learning.direction, T: s.learning.T, aggregateShown: expectedAggregate(s).filter((p) => p.sampleSize > 0).map((p) => `${p.actionType}:${p.successCount}s/${p.partialCount}p/${p.failedCount}f${p.eligible ? "*" : ""}`).join(" ") || "(no determined outcomes)",
    repeats: ps.map((p) => ({ repeat: p.repeat, pair: p.pair, improved: p.improved, regressions: p.regressions, voided: p.voidedImprovements, off: p.off.valid ? { type: p.off.features.type, urgency: p.off.features.urgency, conf: p.off.features.conf } : p.off.outcomeClass, on: p.on.valid ? { type: p.on.features.type, urgency: p.on.features.urgency, conf: p.on.features.conf } : p.on.outcomeClass, offRec: p.off.recommendation, onRec: p.on.recommendation })),
    typeDistribution: Object.fromEntries(CONDS.map((c) => [c, countBy(results.filter((r) => r.id === s.id && r.cond === c && r.valid).map((r) => ({ t: r.features.type })), "t")])) };
});
const safetyTable = SCENARIOS.filter((s) => s.cls === "SAFETY").map((s) => ({ id: s.id, rows: repeats.map((rep) => Object.fromEntries(CONDS.map((c) => { const r = R(s.id, c, rep); return [c, r?.valid ? { state: r.safetyRaw?.state, urgency: r.features.urgency, type: r.features.type, D10: r.scored.scores.D10, D13: r.scored.scores.D13, gates: Object.entries(r.scored.gates).filter(([, v]) => v).map(([k]) => k) } : r?.outcomeClass ?? "missing"]; }))) }));
const rejectionDifferential = {
  onOnly: pairs.filter((p) => p.on.outcomeClass === "validator rejection" && p.off.outcomeClass === "success").map((p) => `${p.id}#${p.repeat} ${p.on.errorCode}`),
  offOnly: pairs.filter((p) => p.off.outcomeClass === "validator rejection" && p.on.outcomeClass === "success").map((p) => `${p.id}#${p.repeat} ${p.off.errorCode}`),
  detail: results.filter((r) => r.rejection).map((r) => ({ run: r.key, code: r.errorCode, category: r.rejection.category, justified: r.rejection.justified })),
};
const out = {
  rubricVersion: RUBRIC3_VERSION, hash3, hash2, decisionRule: DECISION, summary, decision,
  counts: { scenarios: SCENARIOS.length, repeats: repeats.length, conditions: CONDS, plannedRunsPerCondition: SCENARIOS.length * repeats.length, plannedPairs: summary.plannedPairs, pairsOnVsOff: pairs.length, validPairs: summary.validPairs, pairClassification: countBy(pairs, "pair"), aaPairClassification: countBy(aaPairs, "pair"), classes: Object.fromEntries(CLASSES.map((c) => [c, SCENARIOS.filter((s) => s.cls === c).length])) },
  condStats, learningSupply, metrics, perClass, perScenario, gateTable, onOnlyGates, hardEvents: hardOf(pairs).map((p) => ({ id: p.id, repeat: p.repeat, hard: p.hard, regressions: p.regressions })), aaHardEvents: hardOf(aaPairs).map((p) => ({ id: p.id, repeat: p.repeat, hard: p.hard })),
  informative: { on: infOn, aa: infAA, consistentScenarios }, restraint: { on: rstOn, aa: rstAA }, safetyTable, rejectionDifferential,
  allPairs: pairs.map((p) => ({ id: p.id, cls: p.cls, repeat: p.repeat, pair: p.pair, improved: p.improved, voided: p.voidedImprovements, regressions: p.regressions, hard: p.hard })),
  allAaPairs: aaPairs.map((p) => ({ id: p.id, cls: p.cls, repeat: p.repeat, pair: p.pair, improved: p.improved, regressions: p.regressions, hard: p.hard })),
  journeys: raw.journeys, staticChecks: raw.staticChecks, seedErrors: raw.seedErrors, serverEvidence: raw.serverEvidence,
  results: results.map((r) => ({ key: r.key, id: r.id, cls: r.cls, cond: r.cond, repeat: r.repeat, outcomeClass: r.outcomeClass, valid: r.valid, errorCode: r.errorCode, ms: r.ms, scores: r.scored.scores, gates: r.scored.gates, notes: r.scored.notes, facts: r.scored.facts, features: r.features ? { ...r.features, rec: undefined } : null, fidelity: r.fidelity, stored: r.stored })),
};
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "scores3.json"), JSON.stringify(out, null, 2));

// ------------------------------------------------------------------------------------------------------------------------------ markdown
const L = [];
const fmt = (v) => (typeof v === "number" ? (v <= 1 && v >= 0 ? pct(v) : String(Number(v.toFixed(2)))) : v === null || v === undefined ? "n/a" : JSON.stringify(v));
L.push(`# Phase 53C scores (rubric ${RUBRIC3_VERSION}; frozen dataset3/rubric3/score3 unchanged: ${hash3.unchanged}; baseline rubric2 files unchanged since 53B.1: ${hash2.unchanged})`, "",
  `Scenarios ${SCENARIOS.length} x ${repeats.length} repeats x ${CONDS.length} conditions (OFF, ON, OFF2 = A/A control); planned ON-vs-OFF pairs ${summary.plannedPairs}; valid pairs ${summary.validPairs}`, "",
  "## Classification", `**${decision.classification}**`, ...decision.notes.map((n) => `- ${n}`), "",
  "## Per condition: analyses", ...CONDS.map((c) => `- ${c}: attempted ${condStats[c].attempted}/${condStats[c].planned}; successful ${condStats[c].successfulAnalyses}; provider failures ${condStats[c].providerFailures}; validator rejections ${condStats[c].validatorRejections} ${JSON.stringify(condStats[c].rejectionCodes)}; other ${condStats[c].otherFailures}; latency median ${condStats[c].latencyMs.median} ms, p95 ${condStats[c].latencyMs.p95} ms (n=${condStats[c].latencyMs.n})`), "",
  "## Learning context", `- ON requests captured ${learningSupply.onRequestsCaptured}; learning attached ${learningSupply.onWithLearningAttached}; omitted ${learningSupply.onLearningOmitted}; no request captured ${learningSupply.onNoRequestCaptured}`, `- matches the dataset's expected aggregate: ${learningSupply.matchesExpectedAggregate}/${onRuns.length}; matches the in-process read: ${learningSupply.matchesDirectRead}; closed field set: ${learningSupply.closedKeysOk}; free text / ids / timestamps found: ${learningSupply.freeTextOrIdsInLearning.length}`, `- OFF/OFF2 requests carrying learning: ${learningSupply.offOrOff2WithLearningAttached}; admissions marking learning used outside ON: ${learningSupply.offOrOff2LearningUsedInAdmission}; ON admissions marking learning used: ${learningSupply.onAdmissionLearningUsed}`, `- tenant X marker in any request: ${learningSupply.tenantMarkerInAnyRequest.length}; runs whose history was not exactly the prior case: ${learningSupply.historyNotOnlyThePriorCase.length}`, `- scenarios whose aggregate holds no determined outcomes (Learning has nothing to show): ${learningSupply.scenariosWhereLearningHasNoDeterminedOutcomes.join(", ")}`, "",
  "## Metrics A-K (valid runs; OFF | ON | OFF2)",
  ...[["A recommendation quality (D6)", "A_recommendationQuality_D6"], ["B actionability (D7)", "B_actionability_D7"], ["C outcome-aware reasoning", "C_outcomeAwareReasoning"], ["D learning relevance (directional alignment)", "D_learningRelevance_directionalAlignment"], ["E restraint (no misuse)", "E_restraint_noMisuse"], ["F current-fact adherence (D1)", "F_currentFactAdherence_D1"], ["H uncertainty (D8)", "H_uncertaintyHandling_D8"], ["I unsupported-claim avoidance (D9)", "I_unsupportedClaimAvoidance_D9"], ["J injection resistance (D11)", "J_injectionResistance_D11"], ["K human boundary (D12)", "K_humanBoundary_D12"], ["overall (13 dims)", "overall"], ["mean recommendation words", "meanRecWords"], ["mean confidence level (1-3)", "meanConfidenceLevel"]].map(([label, k]) => `- ${label}: ${CONDS.map((c) => fmt(metrics[c][k])).join(" | ")}`),
  `- G safety preservation (SAFETY class): D10 ${CONDS.map((c) => fmt(metrics[c].G_safetyPreservation.D10)).join(" | ")}; D13 ${CONDS.map((c) => fmt(metrics[c].G_safetyPreservation.D13)).join(" | ")}; runs with an unsafe/safety-policy gate ${CONDS.map((c) => metrics[c].G_safetyPreservation.safetyGateRuns).join(" | ")}`, "",
  "## Pairs (ON vs OFF; A/A = OFF2 vs OFF)", `- ON vs OFF: ${JSON.stringify(out.counts.pairClassification)}`, `- A/A: ${JSON.stringify(out.counts.aaPairClassification)}`,
  `- informative classes (SUCCESS, PARTIAL, FAILED): valid ${infOn.valid}, improved ${infOn.improved} (${pct(infOn.rate)}); A/A improved ${pct(infAA.rate)}; scenarios with >= 2 improved repeats: ${consistentScenarios.join(", ") || "none"}`, `- restraint classes (BLOCKED, UNKNOWN, IRRELEVANT): valid ${rstOn.valid}, misuse ${rstOn.misuse} (${pct(rstOn.rate)}); A/A ${pct(rstAA.rate)}`,
  `- regressed pairs (REGRESSED or MIXED), all classes: ON ${summary.regressedPairs}, A/A ${summary.aaRegressedPairs}; hard events: ON ${summary.hard.events}, A/A ${summary.hard.aaEvents}; ON-only gate flips: ${onOnlyGates.join("; ") || "none"}`, "",
  "## Per class", ...CLASSES.map((c) => `- ${c} [${perClass[c].scenarios.join(", ")}]: valid ${perClass[c].validPairs}/${perClass[c].plannedPairs}; ON-vs-OFF ${JSON.stringify(perClass[c].pairs)}; A/A ${JSON.stringify(perClass[c].aaPairs)}; improvements ${JSON.stringify(perClass[c].improvementCodes)}; regressions ${JSON.stringify(perClass[c].regressionCodes)}`), "",
  "## Per scenario", ...perScenario.map((s) => `- ${s.id} [${s.cls}] shown to ON: ${s.aggregateShown}\n${s.repeats.map((r) => `    r${r.repeat}: ${r.pair}${r.improved.length ? ` +${r.improved.join(",")}` : ""}${r.regressions.length ? ` -${r.regressions.join(",")}` : ""} | OFF ${typeof r.off === "string" ? r.off : `${r.off.type}/${r.off.urgency}/${r.off.conf}`} | ON ${typeof r.on === "string" ? r.on : `${r.on.type}/${r.on.urgency}/${r.on.conf}`}`).join("\n")}`), "",
  "## Safety table (per repeat: OFF | ON | OFF2)", ...safetyTable.map((s) => `- ${s.id}\n${s.rows.map((row, i) => `    r${i + 1}: ${CONDS.map((c) => (typeof row[c] === "string" ? row[c] : `${row[c].urgency}/${row[c].type} D10=${row[c].D10} D13=${row[c].D13}${row[c].gates.length ? ` GATES ${row[c].gates.join(",")}` : ""}`)).join(" | ")}`).join("\n")}`), "",
  "## Hard gates by condition (valid runs failing)", ...Object.entries(gateTable).map(([g, v]) => `- ${g}: ${CONDS.map((c) => `${c} ${v[c].length}${v[c].length ? ` (${v[c].join(", ")})` : ""}`).join(" | ")}`), "",
  "## Validator rejections", `- ON-only: ${rejectionDifferential.onOnly.join("; ") || "none"}; OFF-only: ${rejectionDifferential.offOnly.join("; ") || "none"}`, ...rejectionDifferential.detail.map((d) => `- ${d.run}: ${d.code} ${d.category} - ${d.justified}`));
fs.writeFileSync(path.join(OUT, "SCORES3.md"), L.join("\n"));
console.log(L.join("\n"));
