/**
 * Workstream 5C - the separated timeout chain, proven end to end WITHOUT the real provider.
 *
 *   A  the configuration chain (runtime values, independence of the retrieval timeout, start-up checks, ceilings shared by Node and Python, retry budget arithmetic)
 *   B  provider FAULT INJECTION through the REAL Node backend -> the REAL AI service (real SDK, real timeouts, real classification, real 503 retry) -> a LOCAL fake Gemini
 *      (GOOGLE_GEMINI_BASE_URL): 503 -> success, 503 -> 503, 504, timeout, 400, 401, 429: exact provider-call counts, never a third attempt
 *   C  the SLOW PATH with the shipped defaults (25 s response window, 65 s Node wait, 60 s analysis ceiling): a call that takes longer than the window answers HTTP 202, the
 *      SAME attempt keeps running (no second provider call) and persists, the status read discovers it; a 503 followed by a slow success; Decision / Action stay gated
 *   D  the SAFETY-CRITICAL slow path: gas, smoke, fire, carbon monoxide, access refusal + hazard - the deterministic classification is available before and independent of
 *      the analysis, the in-progress and failed states keep the hazard posture, the existing safety enforcement is unchanged, nothing is invented
 *
 * LOCAL ONLY: no real Gemini call, no external network, an isolated database that is dropped. The fake provider is only a script that answers like the Gemini REST API.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(here, "..");
const REPO = path.join(BACKEND, "..");
const FRONTEND = path.join(REPO, "frontend");
const AI_SERVICE = path.join(REPO, "ai-service");
const read = (p) => fs.readFileSync(p, "utf8");
const DB_NAME = `koi_hybrid5c_${Date.now()}`;
process.env.MONGODB_URI = `mongodb://127.0.0.1:27017/${DB_NAME}`; // isolated local database; never Atlas
const { createActor } = await import("./lib/authFixtures.mjs");
for (const k of ["KOI_LEARNING_CONTEXT_ENABLED", "KOI_ANALYSIS_RESPONSE_WINDOW_MS", "KOI_AI_ANALYSIS_TIMEOUT_MS", "KOI_AI_TIMEOUT_MS", "KOI_SOCKET_TIMEOUT_MS"]) delete process.env[k];
const mongoose = (await import("mongoose")).default;
const { connectDatabase } = await import("../src/config/database.js");
const M = await import("../src/models/index.js");
const R = await import("../src/config/runtimeConfig.js");
const { timeoutBudgetProblems } = await import("../src/config/startupChecks.js");
const { deriveSafetyPolicy } = await import("../src/services/ai/safetyPolicy.js");

let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => { if (ok) { passed += 1; console.log(`PASS  ${name}`); } else { failed += 1; console.error(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 60000, step = 200) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step); } };
const withEnv = (vars, fn) => { const old = {}; for (const [k, v] of Object.entries(vars)) { old[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; } try { return fn(); } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } } };
const children = [];
const kill = (c) => { try { c.kill("SIGKILL"); } catch { /* gone */ } };

try {
  // ============================================================================================================ A. the configuration chain
  const B = withEnv({ KOI_AI_TIMEOUT_MS: undefined, KOI_AI_ANALYSIS_TIMEOUT_MS: undefined, KOI_SOCKET_TIMEOUT_MS: undefined, KOI_ANALYSIS_RESPONSE_WINDOW_MS: undefined }, () => R.getAnalysisTimeBudget());
  const apiSrc = read(path.join(FRONTEND, "src", "services", "api.js"));
  const browserMs = Number(/analyzeSignal[\s\S]{0,400}?timeout:\s*([0-9_]+)/.exec(apiSrc)?.[1]?.replace(/_/g, ""));
  const window = withEnv({ KOI_ANALYSIS_RESPONSE_WINDOW_MS: undefined, KOI_SOCKET_TIMEOUT_MS: undefined }, () => R.getAnalysisResponseWindowMs());
  check("A1 the five boundaries have five separate values: browser 30 s > response window 25 s; Node wait 65 s; per-call retrieval 20 s; analysis ceiling 60 s; attempt lifetime bounded by the 110 s deadline",
    browserMs === 30000 && window === 25000 && window < browserMs && R.getAiAnalysisTimeoutMs() === 65000 && B.baseMs === 20000 && R.AI_ANALYSIS_DEADLINE_CEILING_MS === 60000 && B.deadlineMs === 110000 && R.getAnalysisAttemptStaleAfterMs() === 140000, `browser ${browserMs} window ${window}`);
  check("A2 the Node wait exceeds the analysis ceiling by the documented 5 s margin, and the worst 503-retry case (3 s + 1 s + ceiling) fits with 1 s of headroom",
    R.getAiAnalysisTimeoutMs() === R.AI_ANALYSIS_DEADLINE_CEILING_MS + R.ANALYSIS_TIMEOUT_MARGIN_MS && 3000 + 1000 + R.AI_ANALYSIS_DEADLINE_CEILING_MS <= R.getAiAnalysisTimeoutMs() - 1000);
  const retrievalSame = withEnv({ KOI_AI_TIMEOUT_MS: "7000", KOI_AI_ANALYSIS_TIMEOUT_MS: undefined }, () => ({ analysis: R.getAiAnalysisTimeoutMs(), base: R.getAiTimeoutMs() }));
  const analysisOnly = withEnv({ KOI_AI_TIMEOUT_MS: undefined, KOI_AI_ANALYSIS_TIMEOUT_MS: "61000" }, () => ({ analysis: R.getAiAnalysisTimeoutMs(), base: R.getAiTimeoutMs() }));
  check("A3 INDEPENDENCE: changing the retrieval/embedding per-call timeout does not move the analysis wait, and changing the analysis wait does not move the retrieval per-call timeout",
    retrievalSame.analysis === 65000 && retrievalSame.base === 7000 && analysisOnly.analysis === 61000 && analysisOnly.base === 20000);
  const sources = { retrieval: read(path.join(BACKEND, "src", "services", "knowledgeRetrievalService.js")), client: read(path.join(BACKEND, "src", "services", "ai", "aiServiceClient.js")) };
  check("A4 each retrieval call is bounded by min(per-call base timeout, time left in the retrieval budget) and the analysis call by getAiAnalysisTimeoutMs(): the two never share a setting",
    /baseMs:\s*getAiTimeoutMs\(\)/.test(sources.retrieval) && !/getAiAnalysisTimeoutMs/.test(sources.retrieval) && /getAiAnalysisTimeoutMs\(\)/.test(sources.client) && R.nextRetrievalCallTimeoutMs({ now: 0, deadlineAt: B.retrievalBudgetMs, baseMs: B.baseMs }) === 20000);
  check("A5 the retrieval budget is bounded and independent of the Gemini deadline: 110 s deadline - 65 s analysis wait = 45 s total for ALL retrieval calls; retrieval + analysis can never exceed the request deadline",
    B.retrievalBudgetMs === 45000 && B.guaranteedMaxMs === 110000 && B.guaranteedMaxMs <= B.deadlineMs && B.deadlineMs < B.socketMs && B.retrievalBudgetMs >= B.baseMs);
  const realRoute = withEnv({ KOI_AI_ANALYSIS_TIMEOUT_MS: undefined }, () => timeoutBudgetProblems({ LLM_PROVIDER: "gemini" }));
  const tooShort = withEnv({ KOI_AI_ANALYSIS_TIMEOUT_MS: "60000" }, () => timeoutBudgetProblems({ LLM_PROVIDER: "gemini" }));
  const tooLong = withEnv({ KOI_AI_ANALYSIS_TIMEOUT_MS: "105000" }, () => timeoutBudgetProblems({ LLM_PROVIDER: "gemini" }));
  check("A6 START-UP CHECKS: the shipped defaults are valid on the real route; an analysis wait at or below the 60 s ceiling is FATAL there; an analysis wait that leaves no room for one retrieval call is FATAL",
    realRoute.fatal.length === 0 && tooShort.fatal.length === 1 && /analysis deadline ceiling/.test(tooShort.fatal[0]) && tooLong.fatal.length === 1 && /cannot fit one retrieval call/.test(tooLong.fatal[0]));
  const pyPolicy = read(path.join(AI_SERVICE, "app", "provider_policy.py")); const pyConfig = read(path.join(AI_SERVICE, "app", "config.py"));
  check("A7 the Python side owns a separate analysis deadline (LLM_ANALYSIS_TIMEOUT_MS) with its own ceiling equal to Node's; REQUEST_TIMEOUT_MS keeps its 20 s ceiling for embedding",
    Number(/^ANALYSIS_DEADLINE_CEILING_MS = (\d+)/m.exec(pyPolicy)?.[1]) === R.AI_ANALYSIS_DEADLINE_CEILING_MS && Number(/^PROVIDER_TIMEOUT_CEILING_MS = (\d+)/m.exec(pyPolicy)?.[1]) === R.AI_PROVIDER_TIMEOUT_CEILING_MS && /llm_analysis_timeout_ms: int = \d+/.test(pyConfig) && /request_timeout_ms: int = 20000/.test(pyConfig));
  const defaultDeadline = Number(/llm_analysis_timeout_ms: int = (\d+)/.exec(pyConfig)?.[1]);
  check("A8 the configured default analysis deadline is inside its ceiling and strictly below Node's wait (so the AI service's classified timeout fires first)", defaultDeadline >= 1 && defaultDeadline <= R.AI_ANALYSIS_DEADLINE_CEILING_MS && defaultDeadline < R.getAiAnalysisTimeoutMs(), `default ${defaultDeadline}`);

  // ============================================================================================================ the rig: fake Gemini + real AI service + real Node backends
  await connectDatabase();
  if (mongoose.connection.db.databaseName !== DB_NAME) throw new Error("refusing to run: not the isolated database");
  for (const Model of [M.AnalysisAttempt, M.Intelligence, M.AnalysisAdmission]) await Model.init();
  const fake = { calls: 0, script: [], log: [] };
  const GEMINI_PORT = 8122;
  const REF = /current:signal:([0-9a-f]{24})/;
  const gemini = http.createServer((req, res) => {
    const chunks = []; req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const body = Buffer.concat(chunks).toString("utf8"); const sid = REF.exec(body)?.[1];
      fake.calls += 1; const step = fake.script.shift() ?? {}; fake.log.push({ at: Date.now(), n: fake.calls, serverTimeout: req.headers["x-server-timeout"] ?? null, step: { ...step, text: undefined } });
      if (step.delay) await sleep(step.delay);
      const errors = { 400: "INVALID_ARGUMENT", 401: "UNAUTHENTICATED", 403: "PERMISSION_DENIED", 429: "RESOURCE_EXHAUSTED", 500: "INTERNAL", 503: "UNAVAILABLE", 504: "DEADLINE_EXCEEDED" };
      if (step.status) { res.writeHead(step.status, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: { code: step.status, message: "scripted provider error", status: errors[step.status] ?? "UNKNOWN" } })); }
      const out = {
        situation: "S", evidence: ["E"], impact: "I", recommendation: "Have the unit checked and keep the guest informed. P5C-REC-MARKER", confidence: "high", usedKnowledgeChunkIds: [],
        evidenceRefs: [], contradictions: [], urgency: step.urgency ?? "immediate", recommendedActionType: step.action ?? "escalation",
        claims: [{ claimType: "FACT", text: "The Signal is recorded.", sourceRefs: [`current:signal:${sid}`] }, { claimType: "RECOMMENDATION", text: "Have the unit checked.", sourceRefs: [`current:signal:${sid}`] }],
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify(out) }] }, finishReason: "STOP", index: 0 }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 80, totalTokenCount: 180 }, modelVersion: "gemini-3.1-flash-lite" }));
    });
  });
  await new Promise((r) => gemini.listen(GEMINI_PORT, "127.0.0.1", r));
  const python = process.platform === "win32" ? path.join(AI_SERVICE, ".venv", "Scripts", "python.exe") : path.join(AI_SERVICE, ".venv", "bin", "python");
  const startAi = (port, analysisMs) => {
    const c = spawn(python, ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(port), "--log-level", "warning"], {
      cwd: AI_SERVICE, stdio: "ignore",
      env: { ...process.env, LLM_PROVIDER: "gemini", LLM_MODEL: "gemini-3.1-flash-lite", GEMINI_API_KEY: "fake-key-for-this-suite-only", EMBEDDING_PROVIDER: "test", AI_SERVICE_TOKEN: "", KOI_NO_DOTENV: "1", KOI_NO_DOTENV_REASON: "validation", GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${GEMINI_PORT}`, LLM_ANALYSIS_TIMEOUT_MS: String(analysisMs), REQUEST_TIMEOUT_MS: "20000" },
    });
    children.push(c); return c;
  };
  startAi(8120, 60000); // the LONGEST permitted deadline
  startAi(8121, 1500); // a tiny deadline, to exercise the provider timeout classification quickly
  for (const p of [8120, 8121]) { let up = false; for (let i = 0; i < 120 && !up; i += 1) { try { up = (await fetch(`http://127.0.0.1:${p}/v1/health`)).ok; } catch { await sleep(500); } } if (!up) throw new Error(`the AI service on ${p} did not start (ai-service/.venv is required)`); }
  const startNode = (port, aiPort, extra = {}) => {
    const c = spawn(process.execPath, [path.join(BACKEND, "server.js")], { stdio: "ignore", env: { ...process.env, PORT: String(port), LLM_PROVIDER: "gemini", AI_SERVICE_URL: `http://127.0.0.1:${aiPort}`, AI_SERVICE_TOKEN: "", KOI_RATE_LIMIT_ENABLED: "false", CLIENT_URL: "http://localhost:5199", ...extra } });
    children.push(c); return `http://localhost:${port}/api`;
  };
  const NODE_DEFAULT = startNode(5470, 8120); // shipped defaults: 25 s window, 65 s wait
  const NODE_SHORT = startNode(5471, 8120, { KOI_ANALYSIS_RESPONSE_WINDOW_MS: "1500" }); // a short window only so the 202 path is quick to reach in the safety cases
  const NODE_TINY = startNode(5472, 8121); // the AI service whose analysis deadline is 1.5 s
  for (const b of [NODE_DEFAULT, NODE_SHORT, NODE_TINY]) { let up = false; for (let i = 0; i < 160 && !up; i += 1) { try { up = (await fetch(`${b}/health`)).ok; } catch { await sleep(250); } } if (!up) throw new Error(`a backend did not start: ${b}`); }

  const ws = await M.Workspace.create({ name: "H5C", slug: `h5c-${Date.now()}`, status: "active" });
  const WS = String(ws._id);
  const me = await createActor({ role: "admin", workspaceId: ws._id, label: "h5c-admin" });
  const call = async (base, method, url, body) => {
    const res = await fetch(`${base}${url}`, { method, headers: { ...me.headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await res.text(); let json = null; try { json = JSON.parse(t); } catch { /* none */ }
    return { status: res.status, json, data: json?.data, code: json?.details?.code };
  };
  let n = 0;
  const mkSignal = async (description) => (await call(NODE_DEFAULT, "POST", "/signals", { workspaceId: WS, type: "maintenance", title: `H5C report ${(n += 1)}`, description: description ?? `Room ${n}: the air conditioning is not cooling (synthetic).` })).data?._id;
  const analyze = (base, s) => call(base, "POST", `/intelligence/analyze/${s}?workspaceId=${WS}`);
  const statusOf = async (base, s) => (await call(base, "GET", `/intelligence/analysis-status/${s}?workspaceId=${WS}`)).data;
  const stored = (s) => M.Intelligence.countDocuments({ workspaceId: ws._id, signalIds: s });
  const attemptRows = (s) => M.AnalysisAttempt.find({ workspaceId: ws._id, signalId: s }).sort({ createdAt: 1 }).lean();
  const reset = (script = []) => { fake.calls = 0; fake.script = [...script]; fake.log = []; };

  // ============================================================================================================ B. provider fault injection (real Node -> real Python -> fake Gemini)
  reset([{ status: 503 }, {}]); let s = await mkSignal(); let r = await analyze(NODE_DEFAULT, s);
  check("B1 503 -> success: EXACTLY TWO provider calls; the analysis is persisted (HTTP 201); the attempt succeeded", r.status === 201 && fake.calls === 2 && fake.script.length === 0 && (await stored(s)) === 1 && (await attemptRows(s))[0]?.status === "succeeded", `status ${r.status} calls ${fake.calls}`);
  check("B1b the SDK carries the configured analysis deadline to the provider on EVERY attempt (X-Server-Timeout = 60 s, so Gemini enforces the same deadline the AI service waits for), not the 20 s embedding timeout", fake.log.length === 2 && fake.log.every((l) => l.serverTimeout === "60"), JSON.stringify(fake.log.map((l) => l.serverTimeout)));
  reset([{ status: 503 }, { status: 503 }, {}]); s = await mkSignal(); r = await analyze(NODE_DEFAULT, s); await sleep(500);
  check("B2 503 -> 503: EXACTLY TWO provider calls, then the existing safe failure; NO third attempt (the spare success is never consumed); nothing persisted", r.status >= 500 && fake.calls === 2 && fake.script.length === 1 && (await stored(s)) === 0 && (await attemptRows(s))[0]?.status === "failed", `status ${r.status} ${r.code} calls ${fake.calls}`);
  reset([{ status: 504 }, {}]); s = await mkSignal(); r = await analyze(NODE_DEFAULT, s); await sleep(500);
  check("B3 504: ONE provider call, no retry, the classified timeout failure; nothing persisted", r.status === 504 && fake.calls === 1 && fake.script.length === 1 && (await stored(s)) === 0, `status ${r.status} ${r.code} calls ${fake.calls}`);
  reset([{ delay: 6000 }, {}]); s = await mkSignal(); const t0 = Date.now(); r = await analyze(NODE_TINY, s); const tinyMs = Date.now() - t0; await sleep(6500);
  check("B4 PROVIDER TIMEOUT (the AI service's 1.5 s deadline against a provider that takes 6 s): ONE provider call, no retry, classified 504; the late answer is never used; nothing persisted", r.status === 504 && fake.calls === 1 && fake.script.length === 1 && (await stored(s)) === 0 && tinyMs < 5000, `status ${r.status} ${r.code} calls ${fake.calls} ${tinyMs}ms`);
  for (const status of [400, 401, 403, 429]) {
    reset([{ status }, {}]); s = await mkSignal(); r = await analyze(NODE_DEFAULT, s);
    check(`B5.${status} provider ${status}: ONE provider call, no retry, a safe failure; nothing persisted`, r.status >= 400 && fake.calls === 1 && fake.script.length === 1 && (await stored(s)) === 0, `status ${r.status} ${r.code} calls ${fake.calls}`);
  }

  // ============================================================================================================ C. the slow path with the shipped defaults
  reset([{ delay: 40000 }]); s = await mkSignal();
  const startedAt = Date.now(); r = await analyze(NODE_DEFAULT, s); const windowMs = Date.now() - startedAt;
  const inProgress = await statusOf(NODE_DEFAULT, s);
  const decisionDuring = await call(NODE_DEFAULT, "POST", `/decisions/propose/${(await attemptRows(s))[0]?._id}?workspaceId=${WS}`);
  check("C1 SLOW PATH (the provider takes 40 s; the shipped 25 s window): HTTP 202 after about the window, the status read says in_progress, ONE provider call so far", r.status === 202 && windowMs >= 24000 && windowMs < 30000 && inProgress?.status === "in_progress" && fake.calls === 1, `status ${r.status} after ${windowMs} ms; ${inProgress?.status}`);
  check("C2 Decision / Action are unavailable while the attempt is in progress (a proposal is refused; nothing exists to propose from)", [400, 404].includes(decisionDuring.status) && (await M.Decision.countDocuments({ workspaceId: ws._id })) === 0 && (await M.Action.countDocuments({ workspaceId: ws._id })) === 0, `decision ${decisionDuring.status}`);
  const done = await waitFor(async () => { const st = await statusOf(NODE_DEFAULT, s); return st?.status === "succeeded" ? st : null; }, 60000, 1000);
  const total = Date.now() - startedAt;
  check("C3 the SAME attempt keeps running after the 202 and persists: the status read reaches 'succeeded' after about 40 s (Node did NOT cut the call at 25 s), still exactly ONE provider call, ONE analysis, ONE attempt row", Boolean(done) && total >= 39000 && fake.calls === 1 && (await stored(s)) === 1 && (await attemptRows(s)).length === 1, `${total} ms calls ${fake.calls}`);
  const rerun = await analyze(NODE_DEFAULT, s);
  check("C4 a later request for the same report returns the stored analysis and makes NO provider call", rerun.status === 200 && fake.calls === 1, `status ${rerun.status} calls ${fake.calls}`);
  const intelId = (await M.Intelligence.findOne({ workspaceId: ws._id, signalIds: s }).lean())?._id;
  const dp = await call(NODE_DEFAULT, "POST", `/decisions/propose/${intelId}?workspaceId=${WS}`);
  check("C5 once the analysis is persisted the existing Decision flow is available (a proposal is created, nothing is approved or executed)", dp.status === 201 && (await M.Action.countDocuments({ workspaceId: ws._id })) === 0);

  reset([{ status: 503 }, { delay: 28000 }]); s = await mkSignal();
  const t1 = Date.now(); r = await analyze(NODE_DEFAULT, s); const w2 = Date.now() - t1;
  const done2 = await waitFor(async () => { const st = await statusOf(NODE_DEFAULT, s); return st?.status === "succeeded" ? st : null; }, 40000, 1000);
  check("C6 503 followed by a SLOW success (28 s): the one retry fits inside Node's wait; HTTP 202 at the window, then persisted; EXACTLY TWO provider calls; one attempt row", r.status === 202 && w2 >= 24000 && Boolean(done2) && fake.calls === 2 && (await stored(s)) === 1 && (await attemptRows(s)).length === 1, `status ${r.status} ${w2} ms calls ${fake.calls}`);

  // ============================================================================================================ D. the safety-critical slow path
  const { createServer } = await import(pathToFileURL(path.join(FRONTEND, "node_modules", "vite", "dist", "node", "index.js")).href);
  const vite = await createServer({ root: FRONTEND, configFile: path.join(FRONTEND, "vite.config.js"), server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom", logLevel: "silent", optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const feRequire = createRequire(path.join(FRONTEND, "package.json"));
    const React = feRequire("react"); const { renderToStaticMarkup } = feRequire("react-dom/server"); const h = React.createElement;
    const text = (m) => m.replace(/<[^>]*>/g, " ").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
    const { AssessmentSection } = await vite.ssrLoadModule("/src/features/assistant/SignalCaseCard.jsx");
    const { mapSignalFromApi } = await vite.ssrLoadModule("/src/features/operations/operationsMapping.js");
    const { presentGenerationFailure } = await vite.ssrLoadModule("/src/features/intelligence/intelligenceErrorPresentation.js");
    const Words = await vite.ssrLoadModule("/src/features/assistant/analysisAttemptPresentation.js");
    const gen = (over = {}) => ({ phase: "idle", busy: false, checking: false, inProgress: false, stalled: false, statusUnavailable: false, failure: null, version: 0, ...over });
    const idle = { status: "idle", intelligence: null, loadReason: null, reload() {} };
    const render = (generation, hazard) => text(renderToStaticMarkup(h(AssessmentSection, { intel: idle, generation, onGenerate() {}, onRefresh() {}, hazard, signalId: "s" })));
    const CASES = [
      ["gas", "Room 161: the guest reports a strong gas smell in the kitchen."],
      ["smoke", "Room 162: the guest reports smoke coming from the bathroom vent."],
      ["fire", "Room 163: the guest reports a small fire in the wastebasket by the bed."],
      ["carbon monoxide", "Room 164: the carbon monoxide alarm is sounding in the corridor."],
      ["access refusal + hazard", "Room 165: the guest reports a gas smell but refuses entry to staff and maintenance."],
    ];
    const classification = {};
    for (const [label, description] of CASES) {
      const sig = await mkSignal(description);
      const doc = (await call(NODE_SHORT, "GET", `/signals/${sig}?workspaceId=${WS}`)).data;
      const policy = deriveSafetyPolicy({ signal: { title: doc.title, description: doc.description, severity: doc.severity } });
      const view = mapSignalFromApi(doc);
      classification[label] = { policy: policy.state, issue: `${doc.issue?.equipment}/${doc.issue?.problemFamily}`, serverHazard: view.serverHazard };
      // (a) the classification exists BEFORE any analysis and independent of it
      const before = await attemptRows(sig);
      check(`D1 ${label}: the deterministic safety policy classifies the report as a LIFE-SAFETY HAZARD from the Signal alone (no model, no analysis, no attempt yet) with the minimum urgency 'immediate'`, policy.state === "LIFE_SAFETY_HAZARD" && policy.minimumUrgency === "immediate" && before.length === 0 && (await stored(sig)) === 0);
      // (b) slow path: 202, in progress
      reset([{ delay: 5000 }]);
      r = await analyze(NODE_SHORT, sig);
      const stDuring = await statusOf(NODE_SHORT, sig);
      const docDuring = (await call(NODE_SHORT, "GET", `/signals/${sig}?workspaceId=${WS}`)).data;
      const decRefused = await call(NODE_SHORT, "POST", `/decisions/propose/${(await attemptRows(sig))[0]?._id}?workspaceId=${WS}`);
      const rendered = render(gen({ phase: "in_progress", inProgress: true }), view.serverHazard);
      check(`D2 ${label} SLOW: HTTP 202 / in_progress; the classification is still readable and unchanged while the analysis runs; Decision / Action refused; the page keeps the hazard posture (hazard sentence shown iff the server classified the report) and never says the hazard can wait`,
        r.status === 202 && stDuring?.status === "in_progress" && docDuring?.issue?.problemFamily === doc.issue?.problemFamily && [400, 404].includes(decRefused.status) && rendered.includes("Still preparing this assessment") && (rendered.includes(Words.HAZARD_NOTE) === view.serverHazard) && !/can wait|not urgent|no rush|later/i.test(rendered), `${r.status} ${stDuring?.status} hazardUi=${view.serverHazard}`);
      const finished = await waitFor(async () => { const st = await statusOf(NODE_SHORT, sig); return st?.status === "succeeded" ? st : null; }, 20000, 500);
      const stored1 = await M.Intelligence.findOne({ workspaceId: ws._id, signalIds: sig }).lean();
      check(`D3 ${label}: the SAME attempt finishes (one provider call); the stored analysis meets the existing minimum (urgency immediate, an allowed action type) - nothing added or relaxed by the slow path`,
        Boolean(finished) && fake.calls === 1 && stored1?.safety?.urgency === "immediate" && !(label.startsWith("access") && ["maintenance_dispatch", "inspection"].includes(stored1?.safety?.recommendedActionType)), `calls ${fake.calls} ${stored1?.safety?.urgency}/${stored1?.safety?.recommendedActionType}`);
      // (c) the failed branch
      const sig2 = await mkSignal(description);
      const view2 = mapSignalFromApi((await call(NODE_SHORT, "GET", `/signals/${sig2}?workspaceId=${WS}`)).data);
      reset([{ delay: 4000, status: 504 }]);
      const r2 = await analyze(NODE_SHORT, sig2);
      const failed2 = await waitFor(async () => { const st = await statusOf(NODE_SHORT, sig2); return st?.status === "failed" ? st : null; }, 20000, 500);
      const fail = presentGenerationFailure({ status: failed2?.failure?.httpStatus, code: failed2?.failure?.code });
      const renderedFail = render(gen({ phase: "failed", failure: fail }), view2.serverHazard);
      check(`D4 ${label} FAILED (provider 504 after the window): the attempt is terminal 'failed' (one provider call, nothing stored, no Decision / Action); the page shows the existing failure wording AND keeps the hazard posture (hazard sentence iff server-classified) with the explicit retry offered`,
        r2.status === 202 && failed2?.status === "failed" && fake.calls === 1 && (await stored(sig2)) === 0 && renderedFail.includes(fail.message) && /Try again/i.test(renderedFail) && (renderedFail.includes(Words.HAZARD_NOTE) === view2.serverHazard), `${r2.status} ${failed2?.status} hazardUi=${view2.serverHazard}`);
    }
    console.log(`INFO  classification per category (policy / structured issue / serverHazard shown to the page): ${JSON.stringify(classification)}`);
    check("D5 every one of the five categories is a LIFE_SAFETY_HAZARD for the deterministic policy; the page's hazard sentence follows the SERVER-derived structured issue exactly (it is shown for a category only when the server stored a safety_hazard issue)", Object.values(classification).every((c) => c.policy === "LIFE_SAFETY_HAZARD") && Object.values(classification).every((c) => c.serverHazard === (c.issue.endsWith("/safety_hazard"))), JSON.stringify(classification));
    // (d) existing safety ENFORCEMENT unchanged on the slow path: a model answer below the minimum is rejected, never stored
    const gasText = CASES[0][1];
    const sigU = await mkSignal(gasText);
    reset([{ delay: 4000, urgency: "routine", action: "other" }]);
    const rU = await analyze(NODE_SHORT, sigU);
    const failedU = await waitFor(async () => { const st = await statusOf(NODE_SHORT, sigU); return st?.status === "failed" ? st : null; }, 20000, 500);
    check("D6 the existing safety enforcement is unchanged on the slow path: a model answer below the minimum for a gas report (urgency 'routine') is REJECTED by the unchanged policy after the 202; nothing stored; ONE provider call; no model-free recommendation is invented",
      rU.status === 202 && failedU?.status === "failed" && /SAFETY/i.test(`${failedU.failure?.code} ${failedU.failure?.class}`) && (await stored(sigU)) === 0 && fake.calls === 1, JSON.stringify(failedU?.failure));
  } finally { try { await vite.close(); } catch { /* best effort */ } }
  check("D7 no real provider and no Learning: every provider call went to the local fake, the Learning flag is unset and no admission used Learning", process.env.KOI_LEARNING_CONTEXT_ENABLED === undefined && (await M.AnalysisAdmission.countDocuments({ learningUsed: true })) === 0);
} catch (error) {
  failed += 1;
  console.error("FAIL  suite crashed -", error?.stack ?? error);
} finally {
  for (const c of children) kill(c);
  try { await mongoose.connection.dropDatabase(); } catch { /* best effort */ }
  try { await mongoose.disconnect(); } catch { /* best effort */ }
}
console.log(`\nWorkstream 5C timeout chain / slow-path validation: ${passed} passed, ${failed} failed (isolated database ${DB_NAME} dropped; no real provider; no external network)`);
process.exit(failed === 0 ? 0 : 1);
