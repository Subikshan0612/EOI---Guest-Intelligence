/**
 * Learning L1.4 - the COLLECTOR of the structured case-based Learning effectiveness experiment. It drives the real pipeline pieces and records raw observations; it contains NO scoring logic
 * (rubric4.mjs / score4.mjs, frozen first).
 *
 * PIPELINE (per run; the same functions the production analysis uses, in the same order, minus retrieval and persistence):
 *   buildOperationalContext (real context + history)  ->  requestAnalysisFromAiService (REAL AI service, REAL Gemini)  ->  validateAndVerifyAnalysis (the full production validator chain, with the
 *   Learning context in its evidence envelope when - and only when - arm B supplied one)  ->  sanitizeAnalysisProse (the production persistence/read boundary)  ->  the user-facing view.
 *
 * ARMS (identical facts; one difference only):  A = no Learning   B = the L1.2 case-learning observation, delivered through the EXISTING `learning-v1` shape (lib.toLearningContext), and only
 * when the server found similar cases   A2 = a second independent no-Learning sample (the A/A noise control, never a retry).
 * The AI service's own Learning contract is closed (learning-v1); no production source is changed; the production flag is not set (this process never reads it).
 *
 * ISOLATION. A throwaway loopback database (refuses anything else); a counting HTTP proxy in front of the AI service (captures each request body and model output); the live Atlas database and the
 * repo .env files are never touched. RAG: no knowledge is retrieved in any arm. RETRIES: one analysis attempt per run, EXCEPT a content-independent provider failure (HTTP 5xx / timeout from the
 * provider) gets ONE re-attempt after a short pause, recorded as attempt 2 (pre-declared in out/freeze.json; validator rejections are never re-attempted).
 *
 * Usage: node scripts/l14/run-l14-collector.mjs [--dry] [--repeats N] [--only L4-S1,L4-G1]   (--dry: seed, retrieve and build every request; NO model call)
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(here, "..", ".."); const REPO = path.join(BACKEND, "..");
const OUT = path.join(here, "out"); fs.mkdirSync(path.join(OUT, "model-outputs"), { recursive: true });
const DRY = process.argv.includes("--dry");
const arg = (name) => { const i = process.argv.findIndex((a) => a === name || a.startsWith(`${name}=`)); if (i < 0) return null; return process.argv[i].includes("=") ? process.argv[i].split("=")[1] : process.argv[i + 1]; };
const REPEATS = Number(arg("--repeats") ?? 3);
const ONLY = arg("--only") ? new Set(arg("--only").split(",")) : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the database: loopback throwaway only
{ const __u = dotenv.parse(fs.readFileSync(path.join(BACKEND, ".env"), "utf8")).MONGODB_URI ?? ""; if (/^mongodb:\/\/(?:[^@/]*@)?(localhost|127\.0\.0\.1)/i.test(__u)) process.env.MONGODB_URI ??= __u; }
const baseUri = process.env.MONGODB_URI;
if (!baseUri || /^mongodb\+srv:|@/.test(baseUri) || !/^mongodb:\/\/(localhost|127\.0\.0\.1)/.test(baseUri)) { console.error("refusing: the configured MongoDB is not a plain loopback instance"); process.exit(2); }
const DB_NAME = `koi_l14_${Date.now()}`;
process.env.MONGODB_URI = baseUri.replace(/(mongodb:\/\/[^/]+\/)([^?]*)/, `$1${DB_NAME}`);
delete process.env.KOI_LEARNING_CONTEXT_ENABLED; // production Learning stays OFF in this process (and is never read by anything below)
delete process.env.KOI_RETRIEVAL_MIN_SIMILARITY;
const AI_BASE = "http://127.0.0.1:8000"; const PROXY_PORT = 8064;
process.env.AI_SERVICE_URL = `http://127.0.0.1:${PROXY_PORT}`; // the backend client talks to the counting proxy; the token comes from backend/.env exactly as in production
process.env.LLM_PROVIDER = "gemini";

const D = await import("./dataset4.mjs");
const L = await import("./lib.mjs");
const S = await L.loadStack();
if (S.mongoose.connection.db.databaseName !== DB_NAME) { console.error("refusing: not connected to the isolated database"); process.exit(2); }
const { requestAnalysisFromAiService } = await import("../../src/services/ai/aiServiceClient.js");
const { validateAndVerifyAnalysis } = await import("../../src/services/intelligenceAnalysisService.js");
const { sanitizeAnalysisProse } = await import("../../src/services/ai/proseReferenceSanitizer.js");
const { toSafetyView } = await import("../../src/services/intelligenceService.js");
const crypto = await import("node:crypto");

// ---- counting proxy (forwards to the real AI service; records request bodies and outputs; never stores credentials)
const gemini = { calls: [], analyzeLog: [] }; let proxyServer = null;
proxyServer = http.createServer((req, res) => {
  const chunks = []; req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const raw = Buffer.concat(chunks); const started = Date.now(); const p = req.url;
    const kind = p.endsWith("/v1/intelligence/analyze") ? "analyze" : "other";
    let body = null; try { body = JSON.parse(raw.toString("utf8")); } catch { /* not json */ }
    const entry = { kind, path: p, method: req.method, startedAt: new Date(started).toISOString() };
    try {
      const headers = {}; for (const [k, v] of Object.entries(req.headers)) if (!["host", "content-length", "connection"].includes(k)) headers[k] = v;
      const upstream = await fetch(`${AI_BASE}${p}`, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : raw, signal: AbortSignal.timeout(180000) });
      const buf = Buffer.from(await upstream.arrayBuffer()); entry.status = upstream.status; entry.ms = Date.now() - started;
      if (kind === "analyze") { let resp = null; try { resp = JSON.parse(buf.toString("utf8")); } catch { /* not json */ } gemini.analyzeLog.push({ at: entry.startedAt, status: upstream.status, ms: entry.ms, signalId: body?.context?.signal?.id ?? null, requestBody: body, responseBody: resp }); }
      res.statusCode = upstream.status; res.setHeader("content-type", upstream.headers.get("content-type") ?? "application/json"); res.end(buf);
    } catch (error) { entry.status = 0; entry.ms = Date.now() - started; entry.error = String(error?.name ?? error); res.statusCode = 502; res.end("{}"); }
    gemini.calls.push(entry);
  });
});
if (!DRY) await new Promise((r) => proxyServer.listen(PROXY_PORT, "127.0.0.1", r));
const cleanup = async () => { try { proxyServer?.close(); } catch { /* gone */ } try { await S.mongoose.connection.dropDatabase(); } catch { /* best effort */ } try { await S.mongoose.disconnect(); } catch { /* best effort */ } };

const SECRETISH = /token|secret|authorization|password|api[-_]?key|credential|cookie/i;
function sanitize(value, pii = []) {
  if (Array.isArray(value)) return value.map((v) => sanitize(v, pii));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([k]) => !SECRETISH.test(k)).map(([k, v]) => [k, sanitize(v, pii)]));
  if (typeof value === "string") return pii.reduce((s, p) => (p ? s.split(p).join("[pii]") : s), value);
  return value;
}
const hash = (v) => crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16);
const HEX24 = /\b[0-9a-f]{24}\b/i;

try {
  const health = { aiService: DRY ? "not contacted (dry run)" : await fetch(`${AI_BASE}/v1/health`).then((r) => r.json()).catch(() => null), mongo: S.mongoose.connection.db.databaseName };
  if (!DRY && health.aiService?.status !== "healthy") throw new Error("the AI service is not healthy");
  console.log("health:", JSON.stringify(health));

  const picked = ONLY ? D.SCENARIOS.filter((s) => ONLY.has(s.id)) : D.SCENARIOS;
  const tenantX = await L.seedTenantX(S);
  const world = new Map(); let idx = 0;
  for (const sc of picked) { idx += 1; world.set(sc.id, await L.seedScenario(S, sc, idx)); }
  const audits = new Map(); const contexts = new Map();
  for (const sc of picked) {
    const w = world.get(sc.id); const a = await L.retrieval(S, w); audits.set(sc.id, a);
    const learning = L.toLearningContext(a.observation); if (learning) S.validateLearningPayload(learning);
    const { context, operationalHistory } = await S.buildOperationalContext(w.targetSignalId, w.wsId, { authorizedLevel: "staff" });
    contexts.set(sc.id, { learning, contextHash: hash({ context, operationalHistory }), historySignals: context.history.signals.length, historicalAnalyses: operationalHistory.intelligence.length, reviewedDecisions: operationalHistory.decisions.length });
  }
  const seedSummary = picked.map((sc) => { const a = audits.get(sc.id); const c = contexts.get(sc.id); return { id: sc.id, cls: sc.cls, targetIssue: world.get(sc.id).targetIssue, evaluated: a.evaluated, selected: a.selectedCount, selectedSimilar: a.selectedSimilar, irrelevantRetrieved: a.irrelevantRetrieved, similarMissed: a.similarMissed, weakMatches: a.weakMatchCount, excluded: a.excluded, safetyIncompatibleRetrieved: a.safetyIncompatibleRetrieved,
    observation: a.observation, learningAttachedInArmB: Boolean(c.learning), historySignalsInContext: c.historySignals, historicalAnalysesInContext: c.historicalAnalyses, reviewedDecisionsInContext: c.reviewedDecisions }; });
  console.log(`seeded ${picked.length} scenario workspaces + tenant X (${tenantX.caseCount} cases); arm B attaches learning in ${seedSummary.filter((s) => s.learningAttachedInArmB).length} scenarios`);

  const CONDS = ["A", "B", "A2"];
  const reps = Array.from({ length: REPEATS }, (_, i) => i + 1);
  const runs = []; let scIdx = -1;
  const orderFor = (rep, i) => { const rot = (rep + i) % CONDS.length; return [...CONDS.slice(rot), ...CONDS.slice(0, rot)]; }; // counterbalanced order fixed by (repeat, scenario)
  for (const rep of reps) {
    scIdx = -1;
    for (const sc of picked) {
      scIdx += 1; const w = world.get(sc.id); const c = contexts.get(sc.id);
      for (const cond of orderFor(rep, scIdx)) {
        const run = { id: sc.id, cls: sc.cls, cond, repeat: rep, ws: "NK", room: sc.room, reportText: sc.text, pii: w.pii, tenantMarkers: [D.TENANT_MARKER], variant: "primary", signalId: w.targetSignalId, analysis: { attempted: false }, request: null, modelOutput: null, stored: null, counts: { decisions: 0, actions: 0, outcomes: 0, executedActions: 0 }, attempts: [], learningSupplied: false, contextHash: null };
        const { context, operationalHistory } = await S.buildOperationalContext(w.targetSignalId, w.wsId, { authorizedLevel: "staff" });
        run.contextHash = hash({ context, operationalHistory });
        const learning = cond === "B" ? c.learning : undefined; run.learningSupplied = learning !== undefined;
        if (learning) S.validateLearningPayload(learning);
        if (DRY) { run.analysis = { attempted: false, note: "dry run: no model call" }; run.request = { context, operationalHistory, knowledge: [], authorizedLevel: "staff", ...(learning ? { learning } : {}) }; runs.push(run); continue; }
        run.analysis = { attempted: true };
        let raw = null; let providerError = null;
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          const t0 = Date.now(); providerError = null;
          try { raw = await requestAnalysisFromAiService(context, [], "staff", operationalHistory, learning); } catch (e) { providerError = { status: e?.statusCode ?? null, code: e?.details?.code ?? null }; }
          const logged = [...gemini.analyzeLog].reverse().find((b) => b.signalId === w.targetSignalId);
          run.attempts.push({ attempt, ms: Date.now() - t0, aiStatus: logged?.status ?? null, providerError });
          run.request = logged?.requestBody ?? run.request; run.aiStatus = logged?.status ?? null;
          if (!providerError) break;
          if (attempt === 1) await sleep(4000); // one content-independent re-attempt of a PROVIDER failure only
        }
        run.analysisMs = run.attempts.reduce((s, a) => s + a.ms, 0);
        const logged = [...gemini.analyzeLog].reverse().find((b) => b.signalId === w.targetSignalId && b.status === 200);
        run.modelOutput = logged ? sanitize(logged.responseBody, w.pii) : null;
        if (providerError) { run.analysis = { attempted: true, status: providerError.status ?? 502, errorCode: providerError.code ?? "PROVIDER_ERROR", message: "provider failure" }; }
        else {
          try {
            const analysis = validateAndVerifyAnalysis(raw, { context, operationalHistory, knowledge: [], learning, workspaceId: w.wsId });
            const rawProse = { situation: analysis.situation, evidence: [...(analysis.evidence ?? [])], impact: analysis.impact, recommendation: analysis.recommendation };
            const clean = sanitizeAnalysisProse(rawProse, []);
            run.rawProseHadHex24 = HEX24.test(JSON.stringify(rawProse)); // before the production sanitizer
            const view = { analysis: { ...clean, confidence: analysis.confidence }, safety: toSafetyView({ state: analysis.admission.safetyState, urgency: analysis.urgency, recommendedActionType: analysis.recommendedActionType }), knowledgeProvenance: [], evidenceRefs: analysis.evidenceRefs, contradictions: analysis.contradictions };
            run.analysis = { attempted: true, status: 201, view };
            run.stored = { admission: { outcome: "accepted", finalConfidence: analysis.confidence, modelConfidence: analysis.admission.modelConfidence, confidenceCeiling: analysis.admission.confidenceCeiling, confidenceCapped: analysis.admission.confidenceCapped, ceilingReasons: analysis.admission.ceilingReasons, safetyState: analysis.admission.safetyState, learningUsed: learning !== undefined, claimTypeCounts: analysis.admission.claimTypeCounts } };
          } catch (e) {
            run.analysis = { attempted: true, status: e?.statusCode ?? 502, errorCode: e?.details?.code ?? "VALIDATION_FAILED", message: String(e?.message ?? "").slice(0, 200) };
          }
        }
        if (run.modelOutput) fs.writeFileSync(path.join(OUT, "model-outputs", `${sc.id}-${cond}-r${rep}.json`), JSON.stringify({ scenario: sc.id, cond, repeat: rep, node: { status: run.analysis.status, errorCode: run.analysis.errorCode ?? null }, modelOutput: run.modelOutput }, null, 2));
        console.log(`${sc.id}#${rep} ${cond}: node=${run.analysis.status}${run.analysis.errorCode ? ` ${run.analysis.errorCode}` : ""} attempts=${run.attempts.length} ai=${run.aiStatus ?? "-"} learning=${run.learningSupplied ? "attached" : "absent"} ${run.analysisMs}ms`);
        runs.push(run);
        fs.writeFileSync(path.join(OUT, "progress.json"), JSON.stringify({ done: runs.length, of: reps.length * picked.length * CONDS.length, last: `${sc.id}|${cond}|${rep}`, at: new Date().toISOString() }));
        await sleep(1500);
      }
    }
  }
  const aiService = fs.readdirSync(path.join(REPO, "ai-service", "app", "routers")).filter((f) => f.endsWith(".py"));
  const raw = {
    meta: { startedAt: new Date().toISOString(), db: DB_NAME, dry: DRY, repeats: reps.length, only: arg("--only"), conditions: CONDS, model: "the AI service's configured Gemini model", rag: "no knowledge retrieved in any arm (RAG miss, identical for A, B and A2)",
      learningDelivery: "arm B: the L1.2 observation mapped to the EXISTING learning-v1 shape (lib.toLearningContext); no production source changed; the production flag is never read or set", productionFlagInThisProcess: process.env.KOI_LEARNING_CONTEXT_ENABLED ?? null },
    health, tenantX: { caseCount: tenantX.caseCount }, seedSummary, runs, gemini: { calls: gemini.calls.map(({ kind, status, ms }) => ({ kind, status, ms })) }, aiServiceRouters: aiService,
    contextHashByScenario: Object.fromEntries([...contexts].map(([id, c]) => [id, c.contextHash])),
  };
  fs.writeFileSync(path.join(OUT, DRY ? "dry-results.json" : "raw-results.json"), JSON.stringify(raw, null, 2));
  console.log(`done: ${runs.length} runs; AI-service requests: ${JSON.stringify(gemini.calls.reduce((a, c) => { const k = `${c.kind}:${c.status}`; a[k] = (a[k] ?? 0) + 1; return a; }, {}))}`);
} catch (error) {
  console.error("collector failed:", error?.stack ?? error);
  process.exitCode = 1;
} finally {
  await cleanup();
}
