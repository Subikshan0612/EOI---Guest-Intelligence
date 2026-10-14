/**
 * Phase 34D - small controlled REAL-provider validation of the confidence ceiling, historical-evidence handling and
 * field/prose consistency, on the production model (provider gemini, model gemini-3.1-flash-lite).
 *
 * Same method as the Phase 34C.1 harness, same guarantees:
 *   - the existing production path only: the real Node client -> the real ai-service app -> its existing Gemini path, observed
 *     passively (../phase34c1/real_gemini_observer.py) for the exact outbound model, model_version, finish reason, usage and
 *     latency. No second Gemini client, no fallback model, NO RETRIES (one call per run).
 *   - the verdict is validateAndVerifyAnalysis run in NODE_ENV=production (strict mode, exact provider identity, claims,
 *     structured safety minimum, prose consistency, identifier guard, confidence ceiling). Per-stage results only EXPLAIN a
 *     rejection and must agree with that function.
 *   - synthetic fixtures only (./cases.mjs); nothing is persisted; no database connection is opened (asserted); Learning is off.
 *   - the API key (existing dedicated Phase 33-Lite key file) goes only into the spawned service's environment; never printed
 *     or written.
 *
 * Usage:  node backend/scripts/phase34d/verify-real-gemini-34d.mjs --real [--runs 3] [--out <dir>]
 *         node backend/scripts/phase34d/verify-real-gemini-34d.mjs --dry   (stub provider: plumbing only, no Gemini call, no key)
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const REAL = args.includes("--real");
const DRY = args.includes("--dry");
if (REAL === DRY) { console.error("Choose exactly one of --real or --dry."); process.exit(2); }
const argValue = (flag, fallback) => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
const RUNS = Number(argValue("--runs", "3"));
// Phase 34D.1: optional single-case selection (e.g. --case F --runs 1 for ONE fresh call). Default: the whole A-F matrix.
const ONLY_CASE = argValue("--case", null);
const CALL_SPACING_MS = Number(argValue("--spacing-ms", "6000"));
const PORT = Number(argValue("--port", "7433"));
process.env.NODE_ENV = REAL ? "production" : "test";

const here = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(here, "..", "..");
const REPO = path.join(BACKEND, "..");
const AI_SERVICE = path.join(REPO, "ai-service");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const { APPROVED_MODEL, APPROVED_PROVIDER, assertApprovedProvenance } = await import("../../src/config/providerPolicy.js");
const { requestAnalysisFromAiService } = await import("../../src/services/ai/aiServiceClient.js");
const { validateAnalysisResult } = await import("../../src/services/ai/analysisSchema.js");
const { buildEvidenceReferenceIndex } = await import("../../src/services/ai/evidenceReferenceIndex.js");
const { buildEvidenceEnvelope } = await import("../../src/services/ai/evidenceEnvelope.js");
const { validateClaims } = await import("../../src/services/ai/claimValidator.js");
const { deriveSafetyPolicy, evaluateSafetyPolicy, URGENCY_LEVELS } = await import("../../src/services/ai/safetyPolicy.js");
const { findProseContradictions } = await import("../../src/services/ai/proseConsistency.js");
const { deriveConfidenceCeiling, applyConfidenceCeiling } = await import("../../src/services/ai/confidencePolicy.js");
const { findForeignIdentifiers } = await import("../../src/services/ai/outputGuard.js");
const { validateAndVerifyAnalysis } = await import("../../src/services/intelligenceAnalysisService.js");
const { ACTION_TYPES } = await import("../../src/models/Action.js");
const { CASES_34D, LEGACY_CASES, WORKSPACE_ID, payloadOf } = await import("./cases.mjs");
const mongoose = (await import("mongoose")).default;

// ------------------------------------------------------------------------------------------------ output folder (outside the repo)
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const OUT = argValue("--out", path.join("C:\\Users\\Subikshan\\Desktop\\EOI_CHECKPOINTS", "phase34d-real-gemini", `${REAL ? "real" : "dry"}-${stamp}`));
if (OUT.toLowerCase().includes(`${path.sep}evaluation${path.sep}`) || OUT.toLowerCase().includes("phase33")) throw new Error("Refusing to write inside an evaluation or Phase 33 results location.");
fs.mkdirSync(OUT, { recursive: true });
const OBSERVER_LOG = path.join(OUT, "observer.jsonl");
const readObserver = () => (fs.existsSync(OBSERVER_LOG) ? fs.readFileSync(OBSERVER_LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

// ------------------------------------------------------------------------------------------------ start the real service
const childEnv = { ...process.env };
for (const name of ["GEMINI_API_KEY", "LLM_PROVIDER", "LLM_MODEL", "PHASE33_LITE_GEMINI_API_KEY", "PHASE33_LOG_USAGE"]) delete childEnv[name];
const E = (name, value) => { childEnv[name] = value; };
E("LLM_PROVIDER", REAL ? APPROVED_PROVIDER : "test");
E("LLM_MODEL", APPROVED_MODEL);
E("EMBEDDING_PROVIDER", "test");
E("P34C1_OBSERVER_LOG", OBSERVER_LOG);
E("P34C1_PORT", String(PORT));
E("PYTHONUNBUFFERED", "1");
if (REAL) {
  const { loadLiteApiKey } = await import("../../evaluation/learning-real-lite/lite-config.mjs");
  const keyInfo = loadLiteApiKey(process.env);
  E("GEMINI_API_KEY", keyInfo.key); // only into the child's environment; never printed or written
  console.log(`[setup] dedicated API key detected (source: ${keyInfo.source}); value not shown.`);
} else {
  E("GEMINI_API_KEY", "");
}
process.env.AI_SERVICE_URL = `http://127.0.0.1:${PORT}`;

const python = path.join(AI_SERVICE, ".venv", "Scripts", "python.exe");
const child = spawn(python, ["-u", path.join(here, "..", "phase34c1", "real_gemini_observer.py")], { cwd: AI_SERVICE, env: childEnv, stdio: ["ignore", "ignore", "pipe"] });
let childStderr = "";
child.stderr.on("data", (d) => { childStderr += d.toString(); if (childStderr.length > 4000) childStderr = childStderr.slice(-4000); });
let childExited = false;
child.on("exit", () => { childExited = true; });
const stopChild = () => { if (!childExited) child.kill(); };
process.on("exit", stopChild);
for (let i = 0; ; i += 1) {
  if (childExited) throw new Error(`The ai-service exited during startup. stderr tail: ${childStderr.replace(/\s+/g, " ").slice(-400)}`);
  try { const r = await fetch(`http://127.0.0.1:${PORT}/v1/health`); if (r.ok) break; } catch { /* not up yet */ }
  if (i > 60) throw new Error("The ai-service did not become healthy in 30 s.");
  await sleep(500);
}

// ------------------------------------------------------------------------------------------------ PRE-FLIGHT
const startup = readObserver().find((r) => r.kind === "startup");
const preflightOk = REAL ? startup?.configuredProvider === APPROVED_PROVIDER && startup?.configuredModel === APPROVED_MODEL && startup?.policyApprovesConfiguredModel === true && startup?.keyConfigured === true : true;
if (!preflightOk) { stopChild(); throw new Error(`PRE-FLIGHT FAILED: the service is not configured for exactly ${APPROVED_PROVIDER}/${APPROVED_MODEL}. Nothing was sent.`); }
console.log(`[preflight] service configured for ${startup.configuredProvider}/${startup.configuredModel}; policy approves: ${startup.policyApprovesConfiguredModel}; key configured: ${startup.keyConfigured}`);

// ------------------------------------------------------------------------------------------------ per-run evaluation
function evaluate(payload, raw) {
  const knowledge = payload.knowledge;
  const referenceIndex = buildEvidenceReferenceIndex(payload.context, payload.operationalHistory, knowledge.map((k) => k.chunkId));
  const envelope = buildEvidenceEnvelope({ workspaceId: WORKSPACE_ID, context: payload.context, operationalHistory: payload.operationalHistory, knowledge, learning: undefined });
  const policy = deriveSafetyPolicy(payload.context);
  const stages = {};
  const run = (name, fn) => { try { fn(); stages[name] = { ok: true }; } catch (e) { stages[name] = { ok: false, code: e?.details?.code ?? null, reason: String(e?.message ?? e).slice(0, 300) }; } };
  let analysis = null;
  run("schema", () => { analysis = validateAnalysisResult(raw, new Set(knowledge.map((k) => k.chunkId)), referenceIndex); });
  if (analysis) {
    run("identity", () => assertApprovedProvenance(analysis.provenance));
    run("claims", () => validateClaims(analysis.claims, envelope, { workspaceId: WORKSPACE_ID, strict: true }));
    run("safety", () => { const v = evaluateSafetyPolicy(policy, analysis, { strict: true }); if (v.length) { const e = new Error(v.join(",")); e.details = { code: "SAFETY_POLICY_VIOLATION" }; throw e; } });
    run("prose", () => { const v = findProseContradictions(policy, analysis); if (v.length) { const e = new Error(v.join(",")); e.details = { code: "PROSE_CONSISTENCY_VIOLATION" }; throw e; } });
    run("identifiers", () => { const v = findForeignIdentifiers(analysis, envelope); if (v.length) { const e = new Error(v.join(",")); e.details = { code: "OUTPUT_GUARD_VIOLATION" }; throw e; } });
  }
  // AUTHORITATIVE verdict: the function analyzeSignal calls before persistence.
  let final = null;
  let finalError = null;
  try { final = validateAndVerifyAnalysis(raw, { context: payload.context, operationalHistory: payload.operationalHistory, knowledge, learning: undefined, workspaceId: WORKSPACE_ID }); }
  catch (e) { finalError = { code: e?.details?.code ?? null, message: String(e?.message ?? e).slice(0, 300) }; }

  const claims = Array.isArray(raw?.claims) ? raw.claims : [];
  const refs = claims.flatMap((c) => (Array.isArray(c?.sourceRefs) ? c.sourceRefs : []));
  // The ceiling is also computed here, on its own, so a REJECTED response still shows what the ceiling would have been.
  let ceilingInfo = null;
  if (analysis) ceilingInfo = deriveConfidenceCeiling({ claims: analysis.claims, envelope, context: payload.context, contradictions: analysis.contradictions, strict: true, knowledge: payload.knowledge, minSimilarity: 0.25 });
  const calibrated = analysis ? applyConfidenceCeiling(analysis.confidence, ceilingInfo) : null;
  const allStagesOk = Object.keys(stages).length === 6 && Object.values(stages).every((x) => x.ok);
  return {
    policy: { state: policy.state, rules: [...policy.rules], minimumUrgency: policy.minimumUrgency, requiredActionTypes: policy.requiredActionTypes ? [...policy.requiredActionTypes] : null, forbiddenActionTypes: [...policy.forbiddenActionTypes] },
    stages, finalAccepted: final !== null, finalError, consistent: (final !== null) === allStagesOk,
    confidence: { model: raw?.confidence ?? null, ceiling: ceilingInfo?.ceiling ?? null, ceilingReasons: ceilingInfo?.reasons ?? [], final: final?.confidence ?? null, capped: final?.admission?.confidenceCapped ?? null, finalNeverAboveCeiling: final ? CONFIDENCE_RANK(final.confidence) <= CONFIDENCE_RANK(ceilingInfo?.ceiling ?? "high") : null, recomputedFinal: calibrated?.confidence ?? null },
    structured: { schemaValid: stages.schema?.ok === true, claimCount: claims.length, claimTypes: claims.map((c) => c?.claimType), urgency: raw?.urgency ?? null, recommendedActionType: raw?.recommendedActionType ?? null, urgencyValid: URGENCY_LEVELS.includes(raw?.urgency), actionTypeValid: ACTION_TYPES.includes(raw?.recommendedActionType) },
    provenance: { refsCited: refs.length, refsUnknown: refs.filter((r) => !envelope.has(r)).length, byClass: refs.reduce((m, r) => { const k = envelope.classOf(r) ?? "UNKNOWN"; m[k] = (m[k] || 0) + 1; return m; }, {}), historyCited: refs.filter((r) => r.startsWith("history:")).length, historicalPatternClaims: claims.filter((c) => c?.claimType === "HISTORICAL_PATTERN").length },
    prose: { violations: stages.prose?.ok === false ? stages.prose.reason.split(",") : [], recommendation: String(raw?.recommendation ?? "").slice(0, 400) },
  };
}
const CONFIDENCE_RANK = (c) => ["low", "medium", "high"].indexOf(c);

// ------------------------------------------------------------------------------------------------ matrix
const rows = [];
let aborted = null;
let seen = readObserver().length;
let first = true;
// Phase 36: --case may also name a legacy 34C.1 case (e.g. C5, the untrusted-instruction injection) for the small production-like smoke run; the default is still the A-F matrix.
const SELECTED = (ONLY_CASE === null ? CASES_34D : [...CASES_34D, ...LEGACY_CASES]).filter((c) => ONLY_CASE === null || c.id === ONLY_CASE);
if (SELECTED.length === 0) { stopChild(); throw new Error(`Unknown case: ${ONLY_CASE}`); }
outer: for (const testCase of SELECTED) {
  const payload = payloadOf(testCase);
  for (let run = 1; run <= RUNS; run += 1) {
    if (!first) await sleep(CALL_SPACING_MS);
    first = false;
    const row = { caseId: testCase.id, caseName: testCase.name, run };
    const started = Date.now();
    let raw = null;
    try { raw = await requestAnalysisFromAiService(payload.context, payload.knowledge, "staff", payload.operationalHistory, undefined); row.http = { status: 200, providerSuccess: true }; }
    catch (e) { row.http = { status: e?.statusCode ?? null, providerSuccess: false, errorCode: e?.details?.code ?? null, message: String(e?.message ?? e).slice(0, 200) }; }
    row.clientMs = Date.now() - started;
    const fresh = readObserver().slice(seen);
    seen += fresh.length;
    const obs = fresh.find((r) => r.kind === "call");
    row.observer = obs ? { modelArg: obs.modelArg, modelArgIsApproved: obs.modelArg === APPROVED_MODEL, modelVersionReported: obs.modelVersion ?? null, finishReason: obs.finishReason ?? null, sdkMs: obs.sdkMs, usage: obs.usage ?? null, sdkError: obs.error ?? null } : null;
    if (raw) Object.assign(row, evaluate(payload, raw));
    else { row.finalAccepted = false; row.structured = { schemaValid: false, claimCount: 0, claimTypes: [], urgency: null, recommendedActionType: null }; row.confidence = {}; }
    rows.push(row);
    const verdict = row.finalAccepted ? "ACCEPTED" : row.http.providerSuccess ? `REJECTED (${row.finalError?.code ?? "?"})` : `PROVIDER FAILURE (${row.http.status} ${row.http.errorCode})`;
    console.log(`[${testCase.id} run ${run}] ${verdict} | ${row.clientMs} ms | conf model ${row.confidence.model} ceiling ${row.confidence.ceiling} final ${row.confidence.final} | ${row.structured.claimTypes.join("/")} | ${row.structured.urgency}/${row.structured.recommendedActionType} | prose ${row.prose?.violations?.length ? row.prose.violations.join(",") : "ok"}`);
    if (row.observer && !row.observer.modelArgIsApproved) { aborted = `observer saw an outbound model other than the approved one (${row.observer.modelArg})`; break outer; }
    if (!row.http.providerSuccess && ["PROVIDER_AUTHENTICATION_FAILED", "PROVIDER_FORBIDDEN", "PROVIDER_NOT_CONFIGURED", "PROVIDER_MODEL_NOT_APPROVED"].includes(row.http.errorCode)) { aborted = `configuration error ${row.http.errorCode}`; break outer; }
  }
}
stopChild();

// ------------------------------------------------------------------------------------------------ summary
const pct = (n, d) => (d === 0 ? null : Math.round((n / d) * 1000) / 10);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
const dist = (xs) => xs.reduce((m, x) => { const k = String(x); m[k] = (m[k] || 0) + 1; return m; }, {});
const calls = rows.length;
const ok = rows.filter((r) => r.http.providerSuccess);
const accepted = rows.filter((r) => r.finalAccepted);
const lat = rows.map((r) => r.clientMs);
const sdk = rows.map((r) => r.observer?.sdkMs).filter((x) => typeof x === "number");
const sum = (key) => rows.reduce((t, r) => t + (r.observer?.usage?.[key] ?? 0), 0);
const failureReasons = {};
for (const r of rows) {
  if (r.finalAccepted) continue;
  const key = !r.http.providerSuccess ? `provider:${r.http.status}:${r.http.errorCode}` : Object.entries(r.stages || {}).filter(([, s]) => !s.ok).map(([n, s]) => `${n}:${s.code ?? "?"}:${s.reason}`).join(" | ");
  failureReasons[key] = (failureReasons[key] || 0) + 1;
}
const summary = {
  generatedAt: new Date().toISOString(), mode: REAL ? "real" : "dry-stub", aborted, approvedProvider: APPROVED_PROVIDER, approvedModel: APPROVED_MODEL, nodeEnvForVerdicts: process.env.NODE_ENV,
  outboundModelsObserved: [...new Set(rows.map((r) => r.observer?.modelArg).filter(Boolean))], modelVersionsReported: [...new Set(rows.map((r) => r.observer?.modelVersionReported ?? "(absent)"))],
  calls, providerSuccess: ok.length, accepted: accepted.length, acceptedRate: pct(accepted.length, calls),
  stageFailures: ["schema", "identity", "claims", "safety", "prose", "identifiers"].reduce((m, s) => { m[s] = rows.filter((r) => r.stages?.[s] && !r.stages[s].ok).length; return m; }, {}),
  confidence: {
    modelDistribution: dist(ok.map((r) => r.confidence.model)), ceilingDistribution: dist(ok.map((r) => r.confidence.ceiling)), finalDistributionAmongAccepted: dist(accepted.map((r) => r.confidence.final)),
    cappedCount: accepted.filter((r) => r.confidence.capped).length, finalNeverAboveCeilingOnAllAccepted: accepted.every((r) => r.confidence.finalNeverAboveCeiling === true),
    modelAtOrAboveCeilingAndCapped: accepted.filter((r) => r.confidence.model !== r.confidence.final).length,
    ceilingReasons: dist(ok.flatMap((r) => r.confidence.ceilingReasons || [])),
  },
  claimUtilization: { claimTypes: dist(ok.flatMap((r) => r.structured.claimTypes)), historicalPatternClaims: ok.reduce((t, r) => t + (r.provenance?.historicalPatternClaims ?? 0), 0), historyRefsCited: ok.reduce((t, r) => t + (r.provenance?.historyCited ?? 0), 0), unknownRefs: ok.reduce((t, r) => t + (r.provenance?.refsUnknown ?? 0), 0), refsByClass: ok.reduce((m, r) => { for (const [k, v] of Object.entries(r.provenance?.byClass ?? {})) m[k] = (m[k] || 0) + v; return m; }, {}) },
  proseConsistencyViolations: rows.filter((r) => r.prose?.violations?.length).length,
  latencyMs: { clientMin: lat.length ? Math.min(...lat) : null, clientMedian: median(lat), clientMax: lat.length ? Math.max(...lat) : null, sdkMin: sdk.length ? Math.min(...sdk) : null, sdkMedian: median(sdk), sdkMax: sdk.length ? Math.max(...sdk) : null },
  tokens: { prompt: sum("promptTokens"), output: sum("candidateTokens"), total: sum("totalTokens"), thoughts: sum("thoughtsTokens") },
  finishReasons: dist(rows.map((r) => r.observer?.finishReason ?? "(none)")),
  failureReasons,
  perCase: SELECTED.map((c) => { const rs = rows.filter((r) => r.caseId === c.id); return { caseId: c.id, caseName: c.name, calls: rs.length, accepted: rs.filter((r) => r.finalAccepted).length, policy: rs[0]?.policy?.rules ?? [], modelConfidence: rs.map((r) => r.confidence.model), ceiling: rs.map((r) => r.confidence.ceiling), finalConfidence: rs.map((r) => r.confidence.final), urgency: rs.map((r) => r.structured.urgency), actionType: rs.map((r) => r.structured.recommendedActionType), claimTypes: rs.map((r) => r.structured.claimTypes.join("/")) }; }),
  stageDecisionConsistentWithProductionFunction: rows.every((r) => r.consistent !== false),
  databaseConnectionOpened: mongoose.connection.readyState !== 0, retriesPerformed: 0, fallbackModelUsed: false, learningEnabled: false,
};
fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify({ summary, rows }, null, 2));
console.log("\n==== SUMMARY ====");
console.log(JSON.stringify({ ...summary, perCase: undefined, failureReasons: undefined }, null, 1));
console.log("failureReasons:", JSON.stringify(failureReasons, null, 1));
console.log("perCase:");
for (const c of summary.perCase) console.log(" ", JSON.stringify(c));
console.log(`\nartifacts: ${OUT}`);
process.exit(0);
