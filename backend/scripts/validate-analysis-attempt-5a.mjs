/**
 * Workstream 5A - analysis ATTEMPT lifecycle (backend). The Python side of the single 503 retry is ai-service/tests/test_provider_observability.py; this suite proves the
 * Node lifecycle that wraps the unchanged analysis pipeline:
 *
 *   one durable attempt per (workspace, Signal, level); the HTTP response window is separate from the attempt's lifetime; an analysis still running when the window ends is
 *   answered "in progress" (202), not failed, and finishes on its own; concurrent requests converge on ONE attempt and ONE provider call; a completed analysis is reused;
 *   restart / kill behaviour is exactly what the code can guarantee (no recovery is invented); failures persist as state only; tenants are isolated; Decisions and Actions stay
 *   gated on a stored Intelligence.
 *
 * LOCAL ONLY: an isolated local MongoDB database (dropped at the end; the Atlas URI is never used), the deterministic TEST AI service (needs ai-service/.venv), a scripted
 * loopback proxy in front of it that can delay, fail or hang the analysis call and counts every provider call, and backends spawned as child processes. Zero Gemini calls,
 * zero external network.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(here, "..");
const REPO = path.join(BACKEND, "..");
const AI_SERVICE = path.join(REPO, "ai-service");
const DB_NAME = `koi_attempt5a_${Date.now()}`;
process.env.MONGODB_URI = `mongodb://127.0.0.1:27017/${DB_NAME}`; // isolated local database; never Atlas
const { createActor } = await import("./lib/authFixtures.mjs"); // NODE_ENV=test + the stub verifier + a suite secret (children inherit them)
delete process.env.KOI_LEARNING_CONTEXT_ENABLED;
delete process.env.KOI_ANALYSIS_RESPONSE_WINDOW_MS;
const mongoose = (await import("mongoose")).default;
const { connectDatabase } = await import("../src/config/database.js");
const M = await import("../src/models/index.js");
const { getAnalysisAttemptStaleAfterMs, getAnalysisResponseWindowMs, getAiAnalysisTimeoutMs, getAiTimeoutMs, AI_ANALYSIS_DEADLINE_CEILING_MS, AI_PROVIDER_TIMEOUT_CEILING_MS, ANALYSIS_RESPONSE_WINDOW_DEFAULT_MS } = await import("../src/config/runtimeConfig.js");
const attempts = await import("../src/services/analysisAttemptService.js");
const lifecycle = await import("../src/services/intelligenceAnalysisService.js");

let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) { passed += 1; console.log(`PASS  ${name}`); } else { failed += 1; console.error(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 20000, step = 100) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step); } };
const children = [];
const kill = (c) => { try { c.kill("SIGKILL"); } catch { /* gone */ } };

// ---- the scripted AI-service proxy ----------------------------------------------------------------------------------------------------------------------
const proxy = { analyzeCalls: 0, completed: 0, headers: [], script: [] };
// script items, consumed one per analysis request: { delay } then forward to the test AI service | { status, code } an AI-service error body | { hang: true } never answers
const AI_PORT = 8097; const PROXY_PORT = 8098;
const proxyServer = http.createServer((req, res) => {
  const chunks = []; req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const raw = Buffer.concat(chunks);
    const isAnalyze = req.url.endsWith("/v1/intelligence/analyze");
    const step = isAnalyze ? (proxy.script.shift() ?? {}) : {};
    if (isAnalyze) { proxy.analyzeCalls += 1; proxy.headers.push({ ...req.headers }); }
    if (step.hang) return; // the connection is left open
    if (step.delay) await sleep(step.delay);
    if (step.status) { res.writeHead(step.status, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { code: step.code, message: "scripted" } })); if (isAnalyze) proxy.completed += 1; return; }
    try {
      const up = await fetch(`http://127.0.0.1:${AI_PORT}${req.url}`, { method: req.method, headers: { "content-type": req.headers["content-type"] ?? "application/json" }, body: ["GET", "HEAD"].includes(req.method) ? undefined : raw });
      const body = Buffer.from(await up.arrayBuffer());
      if (isAnalyze) proxy.completed += 1;
      res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "application/json" }); res.end(body);
    } catch { try { res.writeHead(502); res.end("{}"); } catch { /* client gone */ } }
  });
});
const resetProxy = () => { proxy.analyzeCalls = 0; proxy.completed = 0; proxy.headers = []; proxy.script = []; };

// ---- backends ------------------------------------------------------------------------------------------------------------------------------------------
let portSeq = 5420;
async function startBackend(extraEnv = {}) {
  const port = portSeq += 1;
  const child = spawn(process.execPath, [path.join(BACKEND, "server.js")], { env: { ...process.env, PORT: String(port), LLM_PROVIDER: "test-python", AI_SERVICE_URL: `http://127.0.0.1:${PROXY_PORT}`, KOI_RATE_LIMIT_ENABLED: "false", CLIENT_URL: "http://localhost:5199", ...extraEnv }, stdio: "ignore" });
  children.push(child);
  const base = `http://localhost:${port}/api`;
  for (let i = 0; i < 160; i += 1) { try { if ((await fetch(`${base}/health`)).ok) return { child, base }; } catch { /* starting */ } await sleep(250); }
  throw new Error("backend did not start");
}
const call = async (base, method, url, who, body, signal) => {
  const res = await fetch(`${base}${url}`, { method, headers: { ...(who ? who.headers : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* none */ }
  return { status: res.status, json, data: json?.data, code: json?.details?.code, text };
};

try {
  await connectDatabase();
  if (mongoose.connection.db.databaseName !== DB_NAME) throw new Error("refusing to run: not the isolated database");
  for (const Model of [M.AnalysisAttempt, M.Intelligence, M.AnalysisAdmission]) await Model.init(); // indexes (the partial unique index in particular) exist before any test
  const python = process.platform === "win32" ? path.join(AI_SERVICE, ".venv", "Scripts", "python.exe") : path.join(AI_SERVICE, ".venv", "bin", "python");
  const ai = spawn(python, ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(AI_PORT), "--log-level", "warning"], { cwd: AI_SERVICE, env: { ...process.env, LLM_PROVIDER: "test", EMBEDDING_PROVIDER: "test", GEMINI_API_KEY: "", AI_SERVICE_TOKEN: "", KOI_NO_DOTENV: "1", KOI_NO_DOTENV_REASON: "validation" }, stdio: "ignore" });
  children.push(ai);
  let aiUp = false; for (let i = 0; i < 120 && !aiUp; i += 1) { try { aiUp = (await fetch(`http://127.0.0.1:${AI_PORT}/v1/health`)).ok; } catch { await sleep(500); } }
  if (!aiUp) throw new Error("the test AI service did not start (ai-service/.venv is required)");
  await new Promise((r) => proxyServer.listen(PROXY_PORT, "127.0.0.1", r));
  process.env.LLM_PROVIDER = "test-python"; process.env.AI_SERVICE_URL = `http://127.0.0.1:${PROXY_PORT}`; // for the one in-process attempt of test 7.6 (children are given theirs explicitly)

  const wsA = await M.Workspace.create({ name: "A5 a", slug: `a5-a-${Date.now()}`, status: "active" });
  const wsB = await M.Workspace.create({ name: "A5 b", slug: `a5-b-${Date.now()}`, status: "active" });
  const A = String(wsA._id); const B = String(wsB._id);
  const me = await createActor({ role: "admin", workspaceId: wsA._id, label: "a5-me" }); // the product's normal single user
  const viewer = await createActor({ role: "viewer", workspaceId: wsA._id, label: "a5-viewer" });
  const adminB = await createActor({ role: "admin", workspaceId: wsB._id, label: "a5-adminb" });
  let n = 0;
  const mkSignal = async (ws = A, who = me, base) => (await call(base, "POST", "/signals", who, { workspaceId: ws, type: "maintenance", title: `Attempt case ${(n += 1)}`, description: `Room ${n}: the air conditioning is not cooling (synthetic).` })).data?._id;
  const analyze = (base, signal, who = me, ws = A, abortSignal) => call(base, "POST", `/intelligence/analyze/${signal}?workspaceId=${ws}`, who, undefined, abortSignal);
  const status = (base, signal, who = me, ws = A) => call(base, "GET", `/intelligence/analysis-status/${signal}?workspaceId=${ws}`, who);
  const intelCount = (signal) => M.Intelligence.countDocuments({ workspaceId: wsA._id, signalIds: signal });
  const attemptRows = (signal) => M.AnalysisAttempt.find({ workspaceId: wsA._id, signalId: signal }).sort({ startedAt: 1 }).lean();
  // the attempt marker is updated just AFTER the analysis is stored: wait for it to leave "in_progress" before comparing rows
  const settled = (signal) => waitFor(async () => { const rows = await attemptRows(signal); return rows.length && rows.every((r) => r.status !== "in_progress") ? rows : null; }, 15000);

  // ============================================================================================================ 0. the three boundaries (configuration)
  const W = getAnalysisResponseWindowMs();
  check("0.1 the boundaries are explicit and separate (Workstream 5C): response window 25 s (below the browser's 30 s), Node -> AI-service analysis wait 65 s (the 60 s analysis ceiling + 5 s), retrieval/embedding ceiling 20 s, per-call base 20 s", W === 25000 && ANALYSIS_RESPONSE_WINDOW_DEFAULT_MS === 25000 && W < 30000 && getAiAnalysisTimeoutMs() === 65000 && AI_ANALYSIS_DEADLINE_CEILING_MS === 60000 && AI_PROVIDER_TIMEOUT_CEILING_MS === 20000 && getAiTimeoutMs() === 20000, `window ${W}`);
  check("0.2 the staleness horizon is the request deadline plus 30 s (140 s by default): the pipeline is bounded by the deadline, so an older in-progress marker belongs to a dead process", getAnalysisAttemptStaleAfterMs() === 140000);
  const pySrc = fs.readFileSync(path.join(AI_SERVICE, "app", "provider_observability.py"), "utf8");
  const pyCfg = fs.readFileSync(path.join(AI_SERVICE, "app", "config.py"), "utf8");
  check("0.3 the provider deadline and the 503 retry are untouched: 20,000 ms default, MAX_PROVIDER_ATTEMPTS = 2, retry only PROVIDER_503, delay 1 s, first attempt <= 3,000 ms", /request_timeout_ms: int = 20000/.test(pyCfg) && /MAX_PROVIDER_ATTEMPTS = 2/.test(pySrc) && /RETRY_DELAY_SECONDS = 1\.0/.test(pySrc) && /RETRY_FIRST_ATTEMPT_MAX_MS = 3000/.test(pySrc) && /category != PROVIDER_503/.test(pySrc));

  // ============================================================================================================ main backend: a SHORT response window so "in progress" is reachable
  const main = await startBackend({ KOI_ANALYSIS_RESPONSE_WINDOW_MS: "1200" });
  let base = main.base;

  // ---- 1. attempt creation, success, completed-result reuse
  resetProxy();
  let s = await mkSignal(A, me, base);
  const st0 = await status(base, s);
  check("1.1 a Signal nobody analysed is 'not_started'", st0.status === 200 && st0.data?.status === "not_started");
  const r1 = await analyze(base, s);
  check("1.2 a fast analysis answers within the window exactly as before: HTTP 201 with the analysis", r1.status === 201 && Boolean(r1.data?._id) && proxy.analyzeCalls === 1);
  const rows1 = await attemptRows(s);
  check("1.3 one durable attempt was created and finished 'succeeded', pointing at the stored analysis (an id, never content)", rows1.length === 1 && rows1[0].status === "succeeded" && String(rows1[0].intelligenceId) === r1.data._id && Boolean(rows1[0].finishedAt));
  const calls1 = proxy.analyzeCalls;
  const r1b = await analyze(base, s);
  const st1 = await status(base, s);
  check("1.4 COMPLETED-RESULT REUSE: asking again returns the stored analysis (HTTP 200) with NO provider call, and creates no new attempt", r1b.status === 200 && r1b.data?._id === r1.data._id && proxy.analyzeCalls === calls1 && (await attemptRows(s)).length === 1);
  check("1.5 polling the status of a completed analysis makes no provider call and reports 'succeeded' with the analysis id", st1.data?.status === "succeeded" && st1.data?.intelligenceId === r1.data._id && proxy.analyzeCalls === calls1);

  // ---- 2. in-progress response, same-attempt coalescing, persistence after the response ended
  resetProxy(); proxy.script.push({ delay: 3500 });
  s = await mkSignal(A, me, base);
  const t0 = Date.now();
  const first = await analyze(base, s);
  const waited = Date.now() - t0;
  check("2.1 an analysis still running when the response window ends answers HTTP 202 'in_progress' (not an error, no recommendation) at the window, not at the end of the analysis", first.status === 202 && first.data?.status === "in_progress" && waited >= 1000 && waited < 3200, `${first.status} after ${waited} ms`);
  check("2.2 the in-progress body carries only the attempt state: id, status, start time (no analysis content, no failure)", JSON.stringify(Object.keys(first.data).sort()) === JSON.stringify(["attemptId", "startedAt", "status"]));
  const second = await analyze(base, s);
  const stMid = await status(base, s);
  check("2.3 SAME-ATTEMPT COALESCING: a second request while the first is in progress starts no provider call and reports the SAME attempt", second.status === 202 && second.data?.attemptId === first.data.attemptId && proxy.analyzeCalls === 1 && stMid.data?.status === "in_progress" && stMid.data?.attemptId === first.data.attemptId);
  const done = await waitFor(async () => (await status(base, s)).data?.status === "succeeded" ? true : null, 15000);
  const rows2 = (await settled(s)) ?? [];
  check("2.4 the attempt finished on its own AFTER the HTTP responses had ended: the analysis was stored, the attempt is 'succeeded', still exactly ONE provider call and ONE attempt", Boolean(done) && (await intelCount(s)) === 1 && rows2.length === 1 && rows2[0].status === "succeeded" && proxy.analyzeCalls === 1);

  // ---- 3. concurrency: one attempt, one provider call, one analysis
  resetProxy(); proxy.script.push({ delay: 2500 });
  s = await mkSignal(A, me, base);
  const burst = await Promise.all(Array.from({ length: 12 }, () => analyze(base, s)));
  await waitFor(async () => (await intelCount(s)) === 1 ? true : null, 15000);
  const rows3 = (await settled(s)) ?? [];
  const attemptIds = new Set(burst.map((r) => r.data?.attemptId).filter(Boolean));
  check("3.1 12 concurrent requests for one Signal: ONE durable attempt, ONE provider call, ONE final analysis", rows3.length === 1 && proxy.analyzeCalls === 1 && (await intelCount(s)) === 1 && (await M.AnalysisAdmission.countDocuments({ workspaceId: wsA._id, signalId: s })) === 1, `attempts=${rows3.length} calls=${proxy.analyzeCalls}`);
  check("3.2 every concurrent request got a deterministic answer (202 in progress or the finished analysis) and all in-progress answers name the same attempt", burst.every((r) => [200, 201, 202].includes(r.status)) && attemptIds.size <= 1);
  // the same through two independent backend processes (the cross-process guard is the durable marker)
  resetProxy(); proxy.script.push({ delay: 2500 });
  const second2 = await startBackend({ KOI_ANALYSIS_RESPONSE_WINDOW_MS: "1200" });
  s = await mkSignal(A, me, base);
  const cross = await Promise.all([analyze(base, s), analyze(second2.base, s), analyze(base, s), analyze(second2.base, s)]);
  await waitFor(async () => (await intelCount(s)) === 1 ? true : null, 15000);
  check("3.3 TWO BACKEND PROCESSES, simultaneous requests: still ONE attempt, ONE provider call, ONE analysis (the partial unique index is the cross-process single-flight)", (await attemptRows(s)).length === 1 && proxy.analyzeCalls === 1 && (await intelCount(s)) === 1 && cross.every((r) => [200, 201, 202].includes(r.status)), `calls=${proxy.analyzeCalls}`);
  kill(second2.child);
  // direct claim race on the model service
  const raceSignal = await mkSignal(A, me, base);
  const claims = await Promise.all(Array.from({ length: 25 }, (_, i) => attempts.claimAttempt({ workspaceId: A, signalId: raceSignal, level: "restricted", attemptId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}` })));
  check("3.4 25 simultaneous claims of the same key: exactly ONE succeeds, the rest are told who holds it", claims.filter((c) => c.claimed).length === 1 && claims.filter((c) => !c.claimed && c.attempt?.status === "in_progress").length === 24);
  await M.AnalysisAttempt.deleteMany({ signalId: raceSignal });

  // ---- 4. A. browser disconnect while Node continues
  resetProxy(); proxy.script.push({ delay: 2500 });
  s = await mkSignal(A, me, base);
  const ac = new AbortController(); const pending = analyze(base, s, me, A, ac.signal).then(() => "completed", (e) => `aborted:${e.name}`);
  await sleep(400); ac.abort(); const disconnect = await pending;
  const finished = await waitFor(async () => (await intelCount(s)) === 1 ? true : null, 15000);
  const rows4 = (await settled(s)) ?? [];
  check("4.1 BROWSER DISCONNECT: the client left 0.4 s in; Node carried the SAME attempt to its end and stored the analysis (one provider call, one attempt, 'succeeded')", disconnect.startsWith("aborted") && Boolean(finished) && rows4.length === 1 && rows4[0].status === "succeeded" && proxy.analyzeCalls === 1);
  const again = await analyze(base, s);
  check("4.2 after the disconnect a later request or poll is served from the stored result: HTTP 200, no new provider call", again.status === 200 && proxy.analyzeCalls === 1);

  // ---- 5. failures: persistence of failed state, one provider call, no Node retry, taxonomy unchanged
  const failCases = [
    ["5.1 provider 503 (the Python layer's final answer after its single retry)", { status: 503, code: "PROVIDER_UNAVAILABLE" }, 502, "PROVIDER_UNAVAILABLE", "provider_unavailable"],
    ["5.2 provider 504 / deadline", { status: 504, code: "PROVIDER_TIMEOUT" }, 504, "PROVIDER_TIMEOUT", "provider_timeout"],
    ["5.3 a 4xx-class provider answer", { status: 502, code: "PROVIDER_BAD_REQUEST" }, 502, "PROVIDER_BAD_REQUEST", "invalid_request"],
  ];
  for (const [label, step, httpStatus, code, klass] of failCases) {
    resetProxy(); proxy.script.push(step);
    s = await mkSignal(A, me, base);
    const r = await analyze(base, s); const row = (await attemptRows(s))[0]; const stf = await status(base, s);
    check(`${label}: the public error is unchanged (HTTP ${httpStatus} ${code}), exactly ONE AI-service request (Node never retries), the attempt is persisted 'failed' with the stable code and class only`,
      r.status === httpStatus && r.code === code && proxy.analyzeCalls === 1 && row?.status === "failed" && row.failureCode === code && row.failureClass === klass && !row.intelligenceId && (await intelCount(s)) === 0);
    check(`${label}: the status read reports 'failed' with code/class (no message, no provider text)`, stf.data?.status === "failed" && stf.data?.failure?.code === code && stf.data?.failure?.class === klass && !JSON.stringify(stf.data).includes("scripted"));
  }
  // a failure that happens AFTER the response window ended is persisted as state, not lost
  resetProxy(); proxy.script.push({ delay: 2500, status: 503, code: "PROVIDER_UNAVAILABLE" });
  s = await mkSignal(A, me, base);
  const lateFirst = await analyze(base, s);
  const lateFailed = await waitFor(async () => { const x = await status(base, s); return x.data?.status === "failed" ? x : null; }, 15000);
  check("5.4 a failure AFTER the response window: the request was answered 202 'in progress', the attempt then ended 'failed' (PROVIDER_UNAVAILABLE) and that state is readable; one provider call; nothing stored", lateFirst.status === 202 && lateFailed?.data?.failure?.code === "PROVIDER_UNAVAILABLE" && proxy.analyzeCalls === 1 && (await intelCount(s)) === 0);
  const retryAfterFail = await analyze(base, s);
  check("5.5 an EXPLICIT new request after a failed attempt starts a new attempt (a new row; the failed one stays as history); nothing re-runs by itself", retryAfterFail.status === 201 && (await attemptRows(s)).length === 2 && (await attemptRows(s))[0].status === "failed" && proxy.analyzeCalls === 2);

  // ---- 6. provider timeout at the Node -> AI-service boundary (the AI service never answers)
  const timeoutBackend = await startBackend({ KOI_AI_ANALYSIS_TIMEOUT_MS: "500" }); // the Node -> AI-service analysis wait is 500 ms (Workstream 5C: its own setting; the window default stays larger)
  resetProxy(); proxy.script.push({ hang: true });
  s = await mkSignal(A, me, timeoutBackend.base);
  const hung = await analyze(timeoutBackend.base, s); const rowT = (await attemptRows(s))[0];
  check("6.1 PROVIDER TIMEOUT (no answer): the unchanged public error (HTTP 504 AI_SERVICE_TIMEOUT), ONE request, no retry, the attempt persisted 'failed' with class provider_timeout", hung.status === 504 && hung.code === "AI_SERVICE_TIMEOUT" && proxy.analyzeCalls === 1 && rowT?.status === "failed" && rowT.failureClass === "provider_timeout" && (await intelCount(s)) === 0);
  kill(timeoutBackend.child);

  // ---- 7. restart and kill (D, E): what the code guarantees, nothing more
  resetProxy(); proxy.script.push({ delay: 4000 });
  const victim = await startBackend({ KOI_ANALYSIS_RESPONSE_WINDOW_MS: "1200" });
  s = await mkSignal(A, me, victim.base);
  const killedFirst = analyze(victim.base, s).catch(() => null);
  await sleep(600);
  const marker = await M.AnalysisAttempt.findOne({ workspaceId: wsA._id, signalId: s }).lean();
  kill(victim.child); await killedFirst;
  check("7.1 the in-flight attempt had a durable 'in_progress' marker before the process was killed (SIGKILL: no handler runs)", marker?.status === "in_progress");
  await sleep(4500); // the provider call (still running at the proxy / test AI service) finishes while Node is dead
  check("7.2 E - PROCESS TERMINATION WHILE PROVIDER WORK RUNS: the provider call completed with nobody to persist it: NO analysis was stored, no partial record, the marker is still 'in_progress'; one provider call was spent", proxy.completed === 1 && (await intelCount(s)) === 0 && (await M.AnalysisAdmission.countDocuments({ signalId: s })) === 0 && (await attemptRows(s))[0].status === "in_progress");
  const restarted = await startBackend({ KOI_ANALYSIS_RESPONSE_WINDOW_MS: "1200" });
  const stR = await status(restarted.base, s); const callsBefore = proxy.analyzeCalls;
  const postR = await analyze(restarted.base, s);
  check("7.3 D - NODE RESTART: while the dead process's marker is still fresh, the new process reports 'in_progress' and starts NO second provider call (the call may still be running somewhere); nothing is silently re-run", stR.data?.status === "in_progress" && postR.status === 202 && proxy.analyzeCalls === callsBefore && (await attemptRows(s)).length === 1);
  await M.AnalysisAttempt.updateOne({ workspaceId: wsA._id, signalId: s }, { $set: { startedAt: new Date(Date.now() - getAnalysisAttemptStaleAfterMs() - 1000) } });
  const stStale = await status(restarted.base, s);
  check("7.4 once the marker is older than the staleness horizon the state is 'failed' / ATTEMPT_INTERRUPTED (read-only: a GET writes nothing)", stStale.data?.status === "failed" && stStale.data?.failure?.code === "ATTEMPT_INTERRUPTED" && (await attemptRows(s))[0].status === "in_progress");
  const rerun = await analyze(restarted.base, s);
  const rowsR = await attemptRows(s);
  check("7.5 an EXPLICIT new request then expires the stale marker (compare-and-set) and starts exactly one new attempt, which completes: 2 attempt rows (interrupted + succeeded), 2 provider calls in total, one analysis", rerun.status === 201 && rowsR.length === 2 && rowsR[0].status === "failed" && rowsR[0].failureCode === "ATTEMPT_INTERRUPTED" && rowsR[1].status === "succeeded" && proxy.analyzeCalls === 2 && (await intelCount(s)) === 1);
  // graceful shutdown path (a signal cannot be delivered gracefully on every platform, so the function the shutdown handler calls is exercised directly)
  const abandonKey = await mkSignal(A, me, restarted.base);
  resetProxy(); proxy.script.push({ delay: 2000 });
  const inFlight = lifecycle.analyzeSignal(abandonKey, A, { authorizedLevel: "restricted" });
  await sleep(500);
  const abandoned = await lifecycle.abandonInFlightAnalyses();
  const rowAb = (await attemptRows(abandonKey))[0];
  check("7.6 GRACEFUL SHUTDOWN: the attempts the process owns are marked interrupted at once (not left in progress), and the shutdown hook is wired into server.js", abandoned >= 1 && rowAb?.status === "failed" && rowAb.failureCode === "ATTEMPT_INTERRUPTED" && /abandonInFlightAnalyses/.test(fs.readFileSync(path.join(BACKEND, "server.js"), "utf8")));
  await inFlight.catch(() => null);
  kill(restarted.child);

  // ---- 8. a marker held by ANOTHER process is respected without a provider call
  resetProxy();
  s = await mkSignal(A, me, base);
  await M.AnalysisAttempt.create({ workspaceId: wsA._id, signalId: s, analysisLevel: "restricted", attemptId: "11111111-2222-4333-8444-555555555555", status: "in_progress", startedAt: new Date() });
  const held = await analyze(base, s);
  check("8.1 a fresh in-progress marker owned elsewhere: the request answers 202 with THAT attempt immediately and makes no provider call", held.status === 202 && held.data?.attemptId === "11111111-2222-4333-8444-555555555555" && proxy.analyzeCalls === 0);

  // ---- 9. tenant isolation
  resetProxy();
  s = await mkSignal(A, me, base);
  const calls9 = proxy.analyzeCalls;
  const readForeign = await status(base, s, adminB, B);
  const readForged = await status(base, s, adminB, A);
  const runForeign = await analyze(base, s, adminB, B);
  const runForged = await analyze(base, s, adminB, A);
  check("9.1 workspace B cannot read workspace A's attempt state (own workspaceId or a forged one): 404 / refused, never 200", [readForeign.status, readForged.status].every((x) => [403, 404].includes(x)));
  check("9.2 workspace B cannot attach to or cause an analysis in workspace A: refused, ZERO provider calls, no attempt row, no analysis", [runForeign.status, runForged.status].every((x) => [403, 404].includes(x)) && proxy.analyzeCalls === calls9 && (await attemptRows(s)).length === 0 && (await M.AnalysisAttempt.countDocuments({ workspaceId: wsB._id })) === 0);
  const own = await analyze(base, s);
  const foreignAfter = await status(base, s, adminB, B);
  check("9.3 after A's analysis finishes B still gets nothing; every attempt row carries A's workspace only", own.status === 201 && [403, 404].includes(foreignAfter.status) && (await M.AnalysisAttempt.countDocuments({ workspaceId: wsB._id })) === 0);
  const viewerStatus = await status(base, s, viewer, A);
  const viewerRun = await analyze(base, s, viewer, A);
  check("9.4 authorization is unchanged: a viewer may read the state (intelligence:view) but not start an analysis (403); no token -> 401", viewerStatus.status === 200 && viewerRun.status === 403 && (await fetch(`${base}/intelligence/analysis-status/${s}?workspaceId=${A}`)).status === 401);
  const bad = await status(base, "not-an-id", me, A);
  check("9.5 an invalid Signal id is a clean 400, an unknown one 404", bad.status === 400 && (await status(base, "6aa29b8d18df3e22b3e89cff", me, A)).status === 404);

  // ---- 10. Decision / Action gating
  resetProxy(); proxy.script.push({ delay: 2500 });
  s = await mkSignal(A, me, base);
  const inProg = await analyze(base, s);
  const failedSignal = await (async () => { proxy.script.push({ status: 503, code: "PROVIDER_UNAVAILABLE" }); const f = await mkSignal(A, me, base); await analyze(base, f); return f; })();
  const attemptDoc = (await attemptRows(s))[0]; const failedDoc = (await attemptRows(failedSignal))[0];
  const tries = [];
  for (const id of [String(attemptDoc._id), String(failedDoc._id), attemptDoc.attemptId]) tries.push((await call(base, "POST", `/decisions/propose/${id}?workspaceId=${A}`, me)).status);
  check("10.1 while an analysis is in progress or has failed there is nothing to decide on: proposing a Decision from the attempt ids (or any non-existent analysis) is refused (404 / 400); no Decision, Action or Outcome exists", inProg.status === 202 && tries.every((x) => [400, 404].includes(x)) && (await M.Decision.countDocuments({ workspaceId: wsA._id })) === 0 && (await M.Action.countDocuments({ workspaceId: wsA._id })) === 0 && (await M.Outcome.countDocuments({ workspaceId: wsA._id })) === 0, JSON.stringify(tries));
  check("10.2 the generic Action / Outcome creation routes stay closed (nobody holds action:execute): no way around the gate", (await call(base, "POST", "/actions", me, { workspaceId: A, decisionId: String(attemptDoc._id) })).status === 403 && (await call(base, "POST", "/outcomes", me, { workspaceId: A, actionId: String(attemptDoc._id), status: "success" })).status === 403);
  await waitFor(async () => (await intelCount(s)) === 1 ? true : null, 15000);
  const intel = await M.Intelligence.findOne({ workspaceId: wsA._id, signalIds: s }).lean();
  const dp = await call(base, "POST", `/decisions/propose/${intel._id}?workspaceId=${A}`, me);
  const da = dp.data?._id ? await call(base, "POST", `/decisions/${dp.data._id}/approve?workspaceId=${A}`, me, {}) : null;
  const ap = da?.status === 200 ? await call(base, "POST", `/actions/propose/${dp.data._id}?workspaceId=${A}`, me) : null;
  const aa = ap?.data?._id ? await call(base, "POST", `/actions/${ap.data._id}/approve?workspaceId=${A}`, me, { note: "approved by a person (suite)" }) : null;
  const oc = aa?.status === 200 ? await call(base, "POST", `/outcomes/record/${ap.data._id}?workspaceId=${A}`, me, { status: "success", result: { summary: "recorded by a person (suite)" } }) : null;
  const again10 = await analyze(base, s); // the finished attempt must not duplicate anything downstream
  check("10.3 once the analysis is STORED the existing flow works unchanged, with exactly one record each and nothing duplicated by the attempt lifecycle: Decision 201 -> approved -> Action 201 -> approved -> Outcome 201", [dp.status, da?.status, ap?.status, aa?.status, oc?.status].join() === "201,200,201,200,201" && again10.status === 200 && (await M.Decision.countDocuments({ workspaceId: wsA._id })) === 1 && (await M.Action.countDocuments({ workspaceId: wsA._id })) === 1 && (await M.Outcome.countDocuments({ workspaceId: wsA._id })) === 1, [dp.status, da?.status, ap?.status, aa?.status, oc?.status].join());

  // ---- 11. the marker holds nothing sensitive; nothing else changed
  const everything = JSON.stringify(await M.AnalysisAttempt.find({}).lean());
  const fields = new Set((await M.AnalysisAttempt.find({}).lean()).flatMap((d) => Object.keys(d)));
  check("11.1 attempt records hold only lifecycle fields (ids, status, times, failure code/class/status): no prompt, output, Signal text, guest data or message", [...fields].every((f) => ["_id", "workspaceId", "signalId", "analysisLevel", "attemptId", "requestId", "status", "startedAt", "finishedAt", "intelligenceId", "failureCode", "failureClass", "httpStatus", "createdAt", "updatedAt", "__v"].includes(f)) && !/air conditioning|Attempt case|scripted|synthetic/.test(everything));
  const requestIds = proxy.headers; // (the last scenario's calls)
  check("11.2 the Workstream 1 correlation id still reaches the AI service on every analysis call (the attempt lifecycle did not disturb it)", (await M.AnalysisAttempt.countDocuments({ requestId: { $exists: true } })) > 0 && requestIds.every((h) => /^[0-9a-f-]{36}$/.test(h["x-koi-request-id"] ?? "")));
  check("11.3 Learning stays OFF: the flag is unset and no admission row used it", process.env.KOI_LEARNING_CONTEXT_ENABLED === undefined && (await M.AnalysisAdmission.countDocuments({ learningUsed: true })) === 0);
  check("11.4 an attempt marker is removed with its workspace (lifecycle cascade): counted and deleted by the workspace lifecycle", (await import("../src/services/workspaceLifecycleService.js")).WORKSPACE_DELETION_ORDER.includes("AnalysisAttempt"));
} catch (error) {
  failed += 1;
  console.error("FAIL  suite crashed -", error?.stack ?? error);
} finally {
  for (const c of children) kill(c);
  try { proxyServer.close(); } catch { /* not started */ }
  try { await mongoose.connection.dropDatabase(); } catch { /* best effort */ }
  try { await mongoose.disconnect(); } catch { /* best effort */ }
}
console.log(`\nWorkstream 5A analysis attempt lifecycle validation: ${passed} passed, ${failed} failed (isolated database ${DB_NAME} dropped; no Gemini call; no external network)`);
process.exit(failed === 0 ? 0 : 1);
