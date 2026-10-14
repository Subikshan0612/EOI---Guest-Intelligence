/**
 * Workstream 5B - the user-facing lifecycle of an analysis attempt (frontend), proven against the Workstream 5A backend.
 *
 *   A  pure: the attempt-state mapping and the fixed wording (closed, no provider detail, no promise of time, nothing implying failure while running)
 *   B  the page-side state machine (frontend/src/features/assistant/analysisAttemptController.js, loaded through Vite SSR) driven with a FAKE clock and FAKE APIs: fast success,
 *      202 in progress, in progress -> succeeded / failed, refresh and re-entry, "Try again" in every state, polling schedule, no overlapping reads, stop on terminal / release /
 *      dispose, a browser-side timeout is never shown as a failed attempt, stall and unreadable-state backstops
 *   C  the real component (AssessmentSection, CaseProgress) rendered to markup for every state, including the safety-classified report
 *   D  the REAL controller against the REAL backend (isolated local database, the deterministic test AI service behind a scripted proxy, spawned backend with a short response window):
 *      the 202 answer, polling, refresh while running, re-entry after success and after failure, repeated "Try again", explicit retry after a terminal failure, provider-call counts,
 *      Decision / Action unavailable while running and unchanged after success, the server-classified hazard reaching the page, workspace isolation
 *
 * LOCAL ONLY: zero Gemini calls, zero external network, an isolated database that is dropped, no Atlas. No change to any provider setting is made or needed.
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
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
const DB_NAME = `koi_hybrid5b_${Date.now()}`;
process.env.MONGODB_URI = `mongodb://127.0.0.1:27017/${DB_NAME}`; // isolated local database; never Atlas
const { createActor } = await import("./lib/authFixtures.mjs");
delete process.env.KOI_LEARNING_CONTEXT_ENABLED;
delete process.env.KOI_ANALYSIS_RESPONSE_WINDOW_MS;
const mongoose = (await import("mongoose")).default;
const { connectDatabase } = await import("../src/config/database.js");
const M = await import("../src/models/index.js");

let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => { if (ok) { passed += 1; console.log(`PASS  ${name}`); } else { failed += 1; console.error(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 30000, step = 100) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step); } };
const children = [];
const kill = (c) => { try { c.kill("SIGKILL"); } catch { /* gone */ } };

const { createServer } = await import(pathToFileURL(path.join(FRONTEND, "node_modules", "vite", "dist", "node", "index.js")).href);
const vite = await createServer({ root: FRONTEND, configFile: path.join(FRONTEND, "vite.config.js"), server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom", logLevel: "silent", optimizeDeps: { noDiscovery: true, include: [] } });

try {
  const feRequire = createRequire(path.join(FRONTEND, "package.json"));
  const React = feRequire("react");
  const { renderToStaticMarkup } = feRequire("react-dom/server");
  const h = React.createElement;
  const text = (m) => m.replace(/<[^>]*>/g, " ").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
  const Mapping = await vite.ssrLoadModule("/src/features/assistant/analysisAttemptMapping.js");
  const Words = await vite.ssrLoadModule("/src/features/assistant/analysisAttemptPresentation.js");
  const Ctl = await vite.ssrLoadModule("/src/features/assistant/analysisAttemptController.js");
  const { presentGenerationFailure } = await vite.ssrLoadModule("/src/features/intelligence/intelligenceErrorPresentation.js");
  const { caseStages } = await vite.ssrLoadModule("/src/features/assistant/decisionMapping.js");
  const { mapSignalFromApi } = await vite.ssrLoadModule("/src/features/operations/operationsMapping.js");
  const { PHASE, POLL_SCHEDULE_MS, POLL_STEADY_MS, STALL_AFTER_MS, MAX_STATUS_ERRORS, createAnalysisAttemptController } = Ctl;

  // ============================================================================================================ A. mapping and wording
  const M_ = Mapping.mapAttemptState;
  check("A1 the state mapping accepts exactly the four server states and nothing else", ["not_started", "in_progress", "succeeded"].every((s) => M_({ status: s }).status === s) && M_({ status: "failed", failure: { code: "PROVIDER_TIMEOUT", httpStatus: 504 } }).status === "failed");
  check("A2 an unknown, missing or malformed state is an ERROR (never guessed as 'not started' or 'in progress')", [null, undefined, {}, { status: "running" }, { status: 3 }, "in_progress"].every((v) => { try { M_(v); return false; } catch { return true; } }));
  check("A3 a failed state carries only the stable code and HTTP status; a hostile or free-text code is replaced, never carried", M_({ status: "failed", failure: { code: "bad code with spaces <script>", httpStatus: 502 } }).failure.code === "INTERNAL_ERROR" && M_({ status: "failed", failure: { code: "PROVIDER_UNAVAILABLE", httpStatus: 502, message: "secret provider text" } }).failure && !("message" in M_({ status: "failed", failure: { code: "PROVIDER_UNAVAILABLE", message: "x" } }).failure));
  const running = [Words.IN_PROGRESS_TITLE, Words.IN_PROGRESS_BODY, Words.STALLED_BODY, Words.STATUS_UNAVAILABLE_BODY].join(" ");
  check("A4 the in-progress wording never says or implies failure and never names a provider or model", !/\b(fail|failed|failure|error|couldn't be completed|unable|gemini|google|openai|model|provider|llm)\b/i.test(running));
  check("A5 no percentage, no countdown, no estimate: no digit, '%', 'minute', 'second' or promise of a time in any in-progress wording", !/\d|%|\bminutes?\b|\bseconds?\b|\bsoon\b|\bshortly\b|\bestimate/i.test(running.replace("as soon as it is ready", "")));
  check("A6 the in-progress wording says the request is still being worked on and need not be sent again", /still being worked on/.test(Words.IN_PROGRESS_BODY) && /don't need to send it again/.test(Words.IN_PROGRESS_BODY));
  const decisionPanelSrc = read(path.join(FRONTEND, "src", "features", "assistant", "DecisionPanel.jsx"));
  check("A7 SAFETY WORDING reuses the page's existing hazard posture (the phrase 'needs immediate attention either way' already stated by the Decision panel) and invents no procedure, role, deadline, contact or escalation path", /needs immediate attention either way/.test(Words.HAZARD_NOTE) && /needs immediate attention either way/.test(decisionPanelSrc) && !/\b(call|contact|notify|evacuate|supervisor|manager|emergency services|within|minutes?|seconds?|escalat\w*|dispatch|procedure|policy)\b/i.test(Words.HAZARD_NOTE));
  check("A8 the hazard flag is the SERVER's classification only: the mapped Signal is hazardous only for a server-derived safety_hazard issue, never for text", mapSignalFromApi({ _id: "s", title: "gas gas gas", description: "gas smoke fire carbon monoxide" }).serverHazard === false && mapSignalFromApi({ _id: "s", issue: { source: "SERVER_DERIVED", problemFamily: "safety_hazard" } }).serverHazard === true && mapSignalFromApi({ _id: "s", issue: { source: "CLIENT", problemFamily: "safety_hazard" } }).serverHazard === false && mapSignalFromApi({ _id: "s", issue: { source: "SERVER_DERIVED", problemFamily: "temperature_fault" } }).serverHazard === false && Words.isServerHazard({ serverHazard: true }) && !Words.isServerHazard({ title: "gas leak" }));
  check("A9 an interrupted attempt has fixed wording of its own (a restart or crash ended it) and no code or internal detail is shown", presentGenerationFailure({ status: 0, code: "ATTEMPT_INTERRUPTED" }).message.startsWith("The analysis was interrupted") && presentGenerationFailure({ status: 0, code: "ATTEMPT_INTERRUPTED" }).retryable === true);

  // ============================================================================================================ B. the state machine (fake clock, fake API)
  const makeClock = () => {
    const c = { t: 0, q: [], n: 0 };
    c.timers = { setTimeout: (fn, ms) => { c.n += 1; c.q.push({ id: c.n, at: c.t + ms, fn }); return c.n; }, clearTimeout: (id) => { c.q = c.q.filter((x) => x.id !== id); } };
    c.flush = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };
    c.advance = async (ms) => { const end = c.t + ms; for (;;) { c.q.sort((a, b) => a.at - b.at); const next = c.q[0]; if (!next || next.at > end) break; c.t = next.at; c.q.shift(); next.fn(); await c.flush(); } c.t = end; await c.flush(); };
    return c;
  };
  const rig = (script = {}) => {
    const clock = makeClock();
    const calls = { start: 0, status: 0, concurrentStatus: 0, maxConcurrentStatus: 0 };
    const states = [];
    const api = {
      start: async (id) => { calls.start += 1; return (script.start ?? (() => ({ kind: "analysis" })))(id, calls.start); },
      status: async (id) => { calls.status += 1; calls.concurrentStatus += 1; calls.maxConcurrentStatus = Math.max(calls.maxConcurrentStatus, calls.concurrentStatus); try { return await (script.status ?? (() => ({ status: "not_started" })))(id, calls.status); } finally { calls.concurrentStatus -= 1; } },
    };
    const ctl = createAnalysisAttemptController({ api, onChange: (id, snap) => states.push({ id, ...snap }), now: () => clock.t, timers: clock.timers });
    return { ctl, calls, clock, states, last: () => states.at(-1) };
  };
  const apiErr = (status, code) => Object.assign(new Error("server text that must never be shown"), { status, code });
  const inProg = { kind: "in_progress", attempt: { status: "in_progress", attemptId: "a", startedAt: "2026-10-13T00:00:00Z" } };

  // A / J: fast success, one POST, nothing polled
  { const r = rig(); const ok = await r.ctl.start("s1"); await r.clock.advance(60000);
    check("B1 A - FAST SUCCESS: one POST, phase 'succeeded', the page told to READ the stored analysis (version bumped), no state read, no timer left", ok === true && r.calls.start === 1 && r.calls.status === 0 && r.last().phase === PHASE.SUCCEEDED && r.last().version === 1 && r.clock.q.length === 0); }
  // B: 202
  { const r = rig({ start: () => inProg, status: () => ({ status: "in_progress" }) }); await r.ctl.start("s1");
    check("B2 B - 202: phase 'in_progress' (never 'failed'), no failure object, the first state read is scheduled (not started now)", r.last().phase === PHASE.IN_PROGRESS && r.last().failure === null && r.last().inProgress === true && r.calls.status === 0 && r.clock.q.length === 1);
    r.ctl.dispose(); }
  // C: in progress -> succeeded, with the polling schedule
  { const r = rig({ start: () => inProg, status: (id, n) => (n < 5 ? { status: "in_progress" } : { status: "succeeded" }) }); await r.ctl.start("s1");
    const at = []; for (let t = 0; t <= 40000; t += 500) { const before = r.calls.status; await r.clock.advance(500); if (r.calls.status > before) at.push(r.clock.t); }
    const gaps = at.slice(1).map((x, i) => x - at[i]);
    check("B3 C - IN PROGRESS -> SUCCEEDED: polls on the documented schedule (first read after 2 s, then 3 s, 3 s, then every 5 s), stops at once on 'succeeded', exactly 5 reads, ONE POST, version bumped, no timer left", at[0] === POLL_SCHEDULE_MS[0] && JSON.stringify(gaps.slice(0, 2)) === JSON.stringify([POLL_SCHEDULE_MS[1], POLL_SCHEDULE_MS[2]]) && gaps.slice(2).every((g) => g === POLL_STEADY_MS) && r.calls.status === 5 && r.calls.start === 1 && r.last().phase === PHASE.SUCCEEDED && r.last().version === 1 && r.clock.q.length === 0, JSON.stringify(at)); }
  // D: in progress -> failed
  { const r = rig({ start: () => inProg, status: (id, n) => (n < 2 ? { status: "in_progress" } : { status: "failed", failure: { code: "PROVIDER_UNAVAILABLE", class: "provider_unavailable", httpStatus: 502 } }) }); await r.ctl.start("s1"); await r.clock.advance(30000);
    const f = r.last().failure;
    check("B4 D - IN PROGRESS -> FAILED: polling stops at once, the failure is shown in the existing fixed wording (title / message / retryable), nothing else (no code, no status, no provider text), no timer left", r.last().phase === PHASE.FAILED && f?.retryable === true && f.message === presentGenerationFailure({ status: 502, code: "PROVIDER_UNAVAILABLE" }).message && !JSON.stringify(f).includes("PROVIDER_UNAVAILABLE") && r.calls.status === 2 && r.clock.q.length === 0); }
  // E: refresh while in progress (a new controller = a new page): reads, never starts
  { const r = rig({ status: (id, n) => (n < 3 ? { status: "in_progress" } : { status: "succeeded" }) }); await r.ctl.observe("s1");
    check("B5 E - PAGE REFRESH DURING IN PROGRESS: one state read, phase 'in_progress', NO POST", r.calls.status === 1 && r.calls.start === 0 && r.last().phase === PHASE.IN_PROGRESS);
    await r.clock.advance(30000);
    check("B6 ...it follows the running attempt to the end and shows the stored result, still NO POST", r.last().phase === PHASE.SUCCEEDED && r.calls.start === 0 && r.clock.q.length === 0); }
  // F / G: re-entry after success and after failure
  { const r = rig({ status: () => ({ status: "succeeded" }) }); await r.ctl.observe("s1");
    check("B7 F - RE-ENTRY AFTER SUCCESS: one read, phase 'succeeded' (the page then reads the stored analysis), NO POST, no polling", r.calls.status === 1 && r.calls.start === 0 && r.last().phase === PHASE.SUCCEEDED && r.last().version === 1 && r.clock.q.length === 0); }
  { const r = rig({ status: () => ({ status: "failed", failure: { code: "PROVIDER_TIMEOUT", httpStatus: 504 } }), start: () => ({ kind: "analysis" }) }); await r.ctl.observe("s1");
    check("B8 G - RE-ENTRY AFTER FAILURE: one read, phase 'failed' with the fixed wording and the retry offered, NO POST", r.last().phase === PHASE.FAILED && r.last().failure?.retryable === true && r.calls.start === 0 && r.calls.status === 1);
    await r.ctl.start("s1");
    check("B9 I - EXPLICIT RETRY AFTER A TERMINAL FAILURE: exactly one new POST, and the failure is cleared while it runs", r.calls.start === 1 && r.last().phase === PHASE.SUCCEEDED && r.last().failure === null); }
  // not started -> normal request
  { const r = rig({ status: () => ({ status: "not_started" }) }); await r.ctl.observe("s1");
    check("B10 D - NOTHING ATTEMPTED: one read, phase back to 'idle' (the page shows its normal 'Assess this'), NO POST, no polling", r.last().phase === PHASE.IDLE && r.calls.start === 0 && r.clock.q.length === 0); }
  // H: repeated Try Again while in progress
  { let release; const gate = new Promise((res) => { release = res; });
    const r = rig({ start: async () => { await gate; return inProg; }, status: () => ({ status: "in_progress" }) });
    const first = r.ctl.start("s1"); const doubles = await Promise.all([r.ctl.start("s1"), r.ctl.start("s1"), r.ctl.start("s1")]); release(); await first; await r.clock.flush();
    check("B11 H - REPEATED 'TRY AGAIN' while the first request is still being sent: one POST only", r.calls.start === 1 && doubles.every((d) => d === false));
    const before = r.calls.start; for (let i = 0; i < 5; i += 1) await r.ctl.start("s1"); await r.clock.advance(1000);
    check("B12 H - REPEATED 'TRY AGAIN' while the attempt is in progress: NO new POST (the running attempt is kept and followed); at most a state read", r.calls.start === before && r.last().phase === PHASE.IN_PROGRESS && r.calls.maxConcurrentStatus <= 1);
    r.ctl.dispose(); }
  // P / Q: polling stops
  { const r = rig({ start: () => inProg, status: () => ({ status: "in_progress" }) }); await r.ctl.start("s1"); await r.clock.advance(7000); const n = r.calls.status; r.ctl.release("s1"); await r.clock.advance(120000);
    check("B13 Q - NAVIGATING AWAY (the report leaves the screen): polling stops at once; no read after release; no timer left; the backend attempt is not touched (no call of any kind is made to cancel)", n >= 2 && r.calls.status === n && r.calls.start === 1 && r.clock.q.length === 0);
    await r.ctl.observe("s1");
    check("B14 Q - COMING BACK: the state is read again (one read) and polling resumes; NO new POST", r.calls.start === 1 && r.calls.status === n + 1 && r.last().phase === PHASE.IN_PROGRESS);
    r.ctl.dispose(); }
  { const r = rig({ start: () => inProg, status: () => ({ status: "in_progress" }) }); await r.ctl.start("s1"); await r.clock.advance(4000); const n = r.calls.status; r.ctl.dispose(); await r.clock.advance(120000);
    check("B15 Q - THE PAGE IS GONE (unmount): every timer is cleared and nothing in flight can change state afterwards", r.calls.status === n && r.clock.q.length === 0); }
  { let hold; const slow = new Promise((res) => { hold = res; }); const r = rig({ start: () => inProg, status: async (id, n) => (n === 1 ? (await slow, { status: "succeeded" }) : { status: "in_progress" }) });
    await r.ctl.start("s1"); await r.clock.advance(2000); const changes = r.states.length; r.ctl.release("s1"); hold(); await r.clock.flush();
    check("B16 Q - a read that finishes AFTER the report was released changes nothing (a stale answer is discarded)", r.states.length === changes + 1 /* the release itself */ && r.last().phase === PHASE.IDLE); }
  { let hold; const slow = new Promise((res) => { hold = res; }); const r = rig({ start: () => inProg, status: async () => { await slow; return { status: "in_progress" }; } }); await r.ctl.start("s1"); await r.clock.advance(60000);
    check("B17 P - NO OVERLAPPING READS: a read that has not returned is never joined by another, however long it takes", r.calls.status === 1 && r.calls.maxConcurrentStatus === 1); hold(); r.ctl.dispose(); }
  { const r = rig({ start: () => inProg, status: () => { throw apiErr(500, "X"); } }); await r.ctl.start("s1"); await r.clock.advance(60000);
    check("B18 P - an unreadable state does not hammer: after the allowed consecutive failed reads the page stops reading, says the state could not be checked (still NOT a failure), and offers 'check again'", r.calls.status === MAX_STATUS_ERRORS && r.last().phase === PHASE.IN_PROGRESS && r.last().statusUnavailable === true && r.last().failure === null && r.clock.q.length === 0); }
  { const r = rig({ start: () => inProg, status: () => ({ status: "in_progress" }) }); await r.ctl.start("s1"); await r.clock.advance(STALL_AFTER_MS + 20000);
    check("B19 P - a backstop for a state that never ends: after the stall limit polling stops and the page says it is taking longer than expected (still NOT a failure)", r.last().phase === PHASE.STALLED && r.last().failure === null && r.clock.q.length === 0);
    const reads = r.calls.status; await r.ctl.refresh("s1"); check("B20 ...'check again' is ONE state read and never a POST", r.calls.status === reads + 1 && r.calls.start === 1); }
  // the browser stopping to wait is not the attempt failing
  { const r = rig({ start: () => { throw apiErr(0, "CLIENT_TIMEOUT"); }, status: () => ({ status: "in_progress" }) }); await r.ctl.start("s1");
    check("B21 THE BROWSER'S OWN TIMEOUT IS NOT A FAILED ATTEMPT: the state is read; a running attempt is shown as in progress, never as 'took too long'", r.last().phase === PHASE.IN_PROGRESS && r.last().failure === null && r.calls.status === 1 && r.calls.start === 1); r.ctl.dispose(); }
  { const r = rig({ start: () => { throw apiErr(0, "CLIENT_NETWORK"); }, status: () => ({ status: "succeeded" }) }); await r.ctl.start("s1");
    check("B22 a lost connection after the request was sent, with the analysis finished meanwhile, shows the analysis (never a failure)", r.last().phase === PHASE.SUCCEEDED && r.last().failure === null); }
  { const r = rig({ start: () => { throw apiErr(0, "CLIENT_TIMEOUT"); }, status: () => ({ status: "not_started" }) }); await r.ctl.start("s1");
    check("B23 ...and only when the server says nothing was started is the timeout shown, in the fixed wording, with a retry", r.last().phase === PHASE.FAILED && r.last().failure?.retryable === true && r.last().failure.message === presentGenerationFailure({ status: 0, code: "CLIENT_TIMEOUT" }).message); }
  { const r = rig({ start: () => { throw apiErr(502, "PROVIDER_UNAVAILABLE"); } }); await r.ctl.start("s1");
    check("B24 an ordinary server error is shown exactly as before (fixed wording only, nothing from the server) and nothing is polled", r.last().phase === PHASE.FAILED && r.last().failure.message === presentGenerationFailure({ status: 502, code: "PROVIDER_UNAVAILABLE" }).message && !JSON.stringify(r.last()).includes("must never be shown") && r.calls.status === 0 && r.clock.q.length === 0); }
  { const r = rig({ status: () => ({ status: "failed", failure: { code: "ATTEMPT_INTERRUPTED", httpStatus: 0 } }) }); await r.ctl.observe("s1");
    check("B25 an attempt the server marked interrupted is shown with its own fixed wording and a retry", r.last().phase === PHASE.FAILED && /interrupted/.test(r.last().failure.message) && r.last().failure.retryable === true); }
  { const r = rig({ status: () => { throw apiErr(403, "FORBIDDEN"); } }); await r.ctl.observe("s1");
    check("B26 if the state cannot be read on re-entry the page behaves exactly as before this feature (idle, nothing started, nothing invented)", r.last().phase === PHASE.IDLE && r.calls.start === 0); }
  { let hold; const gate = new Promise((res) => { hold = res; }); const r = rig({ status: async () => { await gate; return { status: "not_started" }; }, start: () => ({ kind: "analysis" }) });
    const obs = r.ctl.observe("s1"); await r.ctl.start("s1"); hold(); await obs; await r.clock.flush();
    check("B27 a person's request that overtakes the re-entry read wins: the late 'not started' answer is discarded and the request's result stands", r.last().phase === PHASE.SUCCEEDED && r.calls.start === 1); }
  { const r = rig({ start: () => inProg, status: () => ({ status: "in_progress" }) }); const p = r.ctl.start("s1"); r.ctl.release("s1"); await p; await r.clock.advance(60000);
    check("B28 a request still being sent when the report leaves the screen: its '202' is not followed for a report nobody is looking at (no polling), and nothing is cancelled", r.calls.status === 0 && r.clock.q.length === 0); }
  { const ctlSrc = code(path.join(FRONTEND, "src", "features", "assistant", "analysisAttemptController.js"));
    check("B29 the controller never starts an analysis from a read or a timer: `api.start` appears exactly once, inside start(), and never in tick / observe / refresh", (ctlSrc.match(/api\.start\(/g) || []).length === 1 && ctlSrc.indexOf("api.start(") > ctlSrc.indexOf("const start = async") && ctlSrc.indexOf("api.start(") < ctlSrc.indexOf("const observe = async")); }

  // ============================================================================================================ C. the real component, every state
  const { AssessmentSection } = await vite.ssrLoadModule("/src/features/assistant/SignalCaseCard.jsx");
  const CaseProgress = (await vite.ssrLoadModule("/src/features/assistant/CaseProgress.jsx")).default;
  const gen = (over = {}) => ({ phase: "idle", busy: false, checking: false, inProgress: false, stalled: false, statusUnavailable: false, failure: null, version: 0, ...over });
  const intelIdle = { status: "idle", intelligence: null, loadReason: null, reload() {} };
  const render = (generation, { hazard = false, intel = intelIdle } = {}) => text(renderToStaticMarkup(h(AssessmentSection, { intel, generation, onGenerate() {}, onRefresh() {}, hazard, signalId: "sig1" })));
  const rProg = render(gen({ phase: "in_progress", inProgress: true }));
  check("C1 N/B - IN PROGRESS: the restrained state is shown ('Still preparing this assessment', that it need not be sent again), with NO 'Try again', no 'Assess this' and no failure wording", /Still preparing this assessment/.test(rProg) && /don't need to send it again/.test(rProg) && !/Try again|Assess this|couldn't be completed|failed|took too long/i.test(rProg), rProg);
  check("C2 ...no percentage, no countdown, no provider, no model, no id", !/\d|%|gemini|provider|model|\bid\b/i.test(rProg));
  const hProg = render(gen({ phase: "in_progress", inProgress: true }), { hazard: true });
  check("C3 N - SAFETY-CLASSIFIED report, in progress: the same state plus the existing-posture sentence, so waiting for the assessment is not read as waiting to deal with the hazard", hProg.includes(Words.HAZARD_NOTE) && /Still preparing this assessment/.test(hProg) && !/Try again/.test(hProg));
  check("C4 a report that is NOT safety-classified never gets that sentence", !rProg.includes("safety hazard"));
  const fail502 = presentGenerationFailure({ status: 502, code: "PROVIDER_UNAVAILABLE" });
  const rFail = render(gen({ phase: "failed", failure: fail502 }));
  check("C5 FAILED: the existing failure block with the existing retry action, fixed wording only", rFail.includes(fail502.title) && rFail.includes(fail502.message) && /Try again/i.test(rFail) && !rFail.includes("safety hazard"));
  const hFail = render(gen({ phase: "failed", failure: fail502 }), { hazard: true });
  check("C6 O - SAFETY-CLASSIFIED report, failed: the existing failure wording is kept and the hazard sentence is added, so a missing assessment never reads as 'nothing to do'; retry still offered", hFail.includes(fail502.message) && hFail.includes(Words.HAZARD_NOTE) && /Try again/i.test(hFail));
  const rStall = render(gen({ phase: "stalled", stalled: true }));
  const rUnavail = render(gen({ phase: "in_progress", inProgress: true, statusUnavailable: true }));
  check("C7 STALLED / UNREADABLE: still not a failure; 'Check again' (a read) is offered, 'Try again' is not", /taking longer than expected/.test(rStall) && /Check again/.test(rStall) && !/Try again|failed/i.test(rStall) && /couldn't be checked/.test(rUnavail) && /Check again/.test(rUnavail) && !/Try again/i.test(rUnavail));
  check("C8 re-entry read pending: 'Checking for a saved assessment…', not the 'Assess this' button (no flash of an action that may not apply)", /Checking for a saved assessment/.test(render(gen({ phase: "checking", checking: true }))) && !/Assess this/.test(render(gen({ phase: "checking", checking: true }))));
  check("C9 nothing attempted and nothing stored: the normal 'Assess this' (the one explicit request)", /Assess this/.test(render(gen())) && /There is no assessment for this report yet/.test(render(gen())));
  check("C10 request being sent: the existing 'Assessing this…' line", /Assessing this against your records and guidance/.test(render(gen({ phase: "starting", busy: true }))));
  const analysis = { id: "i1", situation: "Situation text.", evidence: ["Evidence line."], impact: "Impact text.", recommendation: "Recommendation text.", confidence: "medium", safety: { state: "NORMAL", urgency: "prompt", recommendedActionType: "maintenance_dispatch" }, createdAt: "2026-10-13T00:00:00Z", provenance: [] };
  const rReady = render(gen({ phase: "succeeded" }), { hazard: true, intel: { status: "ready", intelligence: analysis, loadReason: null, reload() {} } });
  check("C11 SUCCEEDED: the normal stored assessment is rendered as before (safety state, evidence, confidence, recommendation) and no in-progress, failure or hazard-wait wording is left over", /Validated safety assessment: Normal/.test(rReady) && /Situation text\./.test(rReady) && /Recommendation text\./.test(rReady) && /Medium/i.test(rReady) && !/Still preparing|Try again|safety hazard\./.test(rReady));
  const stageText = (s) => text(renderToStaticMarkup(h(CaseProgress, { stages: s })));
  const working = stageText(caseStages({ intelligenceReady: false, assessing: true }));
  check("C12 the case progress names the running assessment 'In progress' (in words, not colour alone); Decision / Action / Outcome stay 'Later' / 'Next' and inert", /Assessment\s+In progress/.test(working) && /Decision\s+Later/.test(working) && /Action\s+Later/.test(working) && /Outcome\s+Later/.test(working) && /Assessment\s+Done/.test(stageText(caseStages({ intelligenceReady: true }))));
  const cardSrc = code(path.join(FRONTEND, "src", "features", "assistant", "SignalCaseCard.jsx"));
  check("C13 K/L - DECISION AND ACTION CONTROLS: the card renders the Decision, Action and Outcome sections only inside `intel.status === \"ready\" && intel.intelligence`, so none exists while the analysis is in progress, failed or not started; no role, flag or state of the attempt can open them", (cardSrc.match(/<DecisionPanel/g) || []).length === 1 && (cardSrc.match(/<ActionPanel/g) || []).length === 1 && (cardSrc.match(/<OutcomePanel/g) || []).length === 1 && cardSrc.indexOf("<DecisionPanel") > cardSrc.indexOf('intel.status === "ready" && intel.intelligence ? (') && !/generation[?.]*(inProgress|phase|stalled)[^;\n]*(DecisionPanel|ActionPanel|OutcomePanel)/.test(cardSrc) && /useCaseDecision\(intel\.status === "ready" \? intel\.intelligence\?\.id : null\)/.test(cardSrc));
  const apiSrc = code(path.join(FRONTEND, "src", "services", "api.js"));
  check("C14 the API client reads the two backend contracts: the state read is a GET on /intelligence/analysis-status/:signalId, and HTTP 202 is the in-progress answer (a 202 without that state is a malformed-response error, never an analysis)", /intelligenceAnalysisStatus: \(signalId\) => `\/intelligence\/analysis-status\/\$\{signalId\}`/.test(apiSrc) && /response\?\.status === 202/.test(apiSrc) && /data\.status !== "in_progress"/.test(apiSrc) && /api\.get\(koiEndpoints\.intelligenceAnalysisStatus/.test(apiSrc));
  check("C15 no frontend-only authorization and no second de-duplication: the controller and hook hold no role, permission or record of analyses; the only local guard is the pre-existing one-POST-in-flight check", !/role|permission|mayPropose|mayReview/i.test(code(path.join(FRONTEND, "src", "features", "assistant", "analysisAttemptController.js"))) && !/localStorage|sessionStorage/.test(code(path.join(FRONTEND, "src", "features", "assistant", "analysisAttemptController.js")) + code(path.join(FRONTEND, "src", "features", "assistant", "useCaseGeneration.js"))));
  const hookSrc = code(path.join(FRONTEND, "src", "features", "assistant", "useCaseGeneration.js"));
  check("C16 the hook clears every timer when the page is gone (dispose on unmount) and exposes release for a report that leaves the screen", /return \(\) => controller\.dispose\(\)/.test(hookSrc) && /controllerRef\.current\.release\(signalId\)/.test(hookSrc) && !/setInterval/.test(hookSrc + code(path.join(FRONTEND, "src", "features", "assistant", "analysisAttemptController.js"))));
  const providerWords = /gemini|google|openai|llm|provider|model|stack|exception|mongo|workspaceId|requestId|attemptId/i;
  check("C17 the new UI code names no provider, model, stack trace, database, workspace id, request id or attempt id in anything it can display", !providerWords.test(Object.values(Words).filter((v) => typeof v === "string").join(" ")) && !/attemptId|requestId|workspaceId/.test(rProg + rFail + rStall + rUnavail));

  // ============================================================================================================ D. the real controller against the real backend
  await connectDatabase();
  if (mongoose.connection.db.databaseName !== DB_NAME) throw new Error("refusing to run: not the isolated database");
  for (const Model of [M.AnalysisAttempt, M.Intelligence, M.AnalysisAdmission]) await Model.init();
  const proxy = { analyzeCalls: 0, script: [] };
  const AI_PORT = 8197; const PROXY_PORT = 8198;
  const proxyServer = http.createServer((req, res) => {
    const chunks = []; req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const isAnalyze = req.url.endsWith("/v1/intelligence/analyze");
      const step = isAnalyze ? (proxy.script.shift() ?? {}) : {};
      if (isAnalyze) proxy.analyzeCalls += 1;
      if (step.delay) await sleep(step.delay);
      if (step.status) { res.writeHead(step.status, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { code: step.code, message: "scripted" } })); return; }
      try { const up = await fetch(`http://127.0.0.1:${AI_PORT}${req.url}`, { method: req.method, headers: { "content-type": req.headers["content-type"] ?? "application/json" }, body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks) }); res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "application/json" }); res.end(Buffer.from(await up.arrayBuffer())); } catch { try { res.writeHead(502); res.end("{}"); } catch { /* gone */ } }
    });
  });
  const python = process.platform === "win32" ? path.join(AI_SERVICE, ".venv", "Scripts", "python.exe") : path.join(AI_SERVICE, ".venv", "bin", "python");
  const ai = spawn(python, ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(AI_PORT), "--log-level", "warning"], { cwd: AI_SERVICE, env: { ...process.env, LLM_PROVIDER: "test", EMBEDDING_PROVIDER: "test", GEMINI_API_KEY: "", AI_SERVICE_TOKEN: "", KOI_NO_DOTENV: "1", KOI_NO_DOTENV_REASON: "validation" }, stdio: "ignore" });
  children.push(ai);
  let aiUp = false; for (let i = 0; i < 120 && !aiUp; i += 1) { try { aiUp = (await fetch(`http://127.0.0.1:${AI_PORT}/v1/health`)).ok; } catch { await sleep(500); } }
  if (!aiUp) throw new Error("the test AI service did not start (ai-service/.venv is required)");
  await new Promise((r) => proxyServer.listen(PROXY_PORT, "127.0.0.1", r));
  const API_PORT = 5440; const BASE = `http://localhost:${API_PORT}/api`;
  const be = spawn(process.execPath, [path.join(BACKEND, "server.js")], { env: { ...process.env, PORT: String(API_PORT), LLM_PROVIDER: "test-python", AI_SERVICE_URL: `http://127.0.0.1:${PROXY_PORT}`, KOI_RATE_LIMIT_ENABLED: "false", KOI_ANALYSIS_RESPONSE_WINDOW_MS: "1200", CLIENT_URL: "http://localhost:5199" }, stdio: "ignore" });
  children.push(be);
  for (let i = 0; i < 160; i += 1) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch { /* starting */ } await sleep(250); }

  const wsA = await M.Workspace.create({ name: "H5 a", slug: `h5-a-${Date.now()}`, status: "active" });
  const wsB = await M.Workspace.create({ name: "H5 b", slug: `h5-b-${Date.now()}`, status: "active" });
  const A = String(wsA._id); const B = String(wsB._id);
  const me = await createActor({ role: "admin", workspaceId: wsA._id, label: "h5-me" });
  const adminB = await createActor({ role: "admin", workspaceId: wsB._id, label: "h5-adminb" });
  const call = async (method, url, who, body) => {
    const res = await fetch(`${BASE}${url}`, { method, headers: { ...who.headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await res.text(); let json = null; try { json = JSON.parse(t); } catch { /* none */ } return { status: res.status, json, data: json?.data };
  };
  // the page's two API calls, with the contract of services/api.js (HTTP 202 -> in progress; an error carries status / code / rule only)
  const pageApi = (who, ws) => ({
    start: async (id) => { const r = await call("POST", `/intelligence/analyze/${id}?workspaceId=${ws}`, who); if (r.status === 202) return { kind: "in_progress", attempt: r.data }; if (r.status === 200 || r.status === 201) return { kind: "analysis" }; throw Object.assign(new Error(r.json?.message ?? "x"), { status: r.status, code: r.json?.details?.code, rule: r.json?.details?.rule }); },
    status: async (id) => { const r = await call("GET", `/intelligence/analysis-status/${id}?workspaceId=${ws}`, who); if (r.status !== 200) throw Object.assign(new Error("x"), { status: r.status }); return r.data; },
  });
  const newPage = (who = me, ws = A) => { const states = []; const ctl = createAnalysisAttemptController({ api: pageApi(who, ws), onChange: (id, s) => states.push(s) }); return { ctl, states, last: () => states.at(-1) }; };
  let n = 0;
  const mkSignal = async (description, who = me, ws = A) => (await call("POST", "/signals", who, { workspaceId: ws, type: "maintenance", title: `Report ${(n += 1)}`, description: description ?? `Room ${n}: the air conditioning is not cooling (synthetic).` })).data?._id;
  const storedCount = (s) => M.Intelligence.countDocuments({ workspaceId: wsA._id, signalIds: s });
  const phaseIs = (page, p) => waitFor(async () => (page.last()?.phase === p ? true : null), 40000, 150);

  // A / J: a fast analysis
  proxy.analyzeCalls = 0; proxy.script = [];
  let s = await mkSignal(); let page = newPage();
  await page.ctl.start(s);
  check("D1 A - FAST SUCCESS against the real backend: the request answers within the window, the page reaches 'succeeded' with ONE provider call and the analysis stored", page.last().phase === "succeeded" && proxy.analyzeCalls === 1 && (await storedCount(s)) === 1);

  // B / C: 202 then success, polled
  proxy.analyzeCalls = 0; proxy.script = [{ delay: 3500 }];
  s = await mkSignal(); page = newPage();
  const t0 = Date.now(); await page.ctl.start(s);
  check("D2 B - 202: the backend's window ended while the analysis was running; the page is 'in progress' (not failed) after about the window", page.last().phase === "in_progress" && page.last().failure === null && Date.now() - t0 < 3300, `${Date.now() - t0} ms`);
  const reached = await phaseIs(page, "succeeded");
  check("D3 C - IN PROGRESS -> SUCCEEDED by reading the state: the page reaches 'succeeded' on its own, ONE provider call in total, ONE analysis, no new attempt created by the reads", Boolean(reached) && proxy.analyzeCalls === 1 && (await storedCount(s)) === 1 && (await M.AnalysisAttempt.countDocuments({ signalId: s })) === 1);

  // D: 202 then failure
  proxy.analyzeCalls = 0; proxy.script = [{ delay: 2500, status: 503, code: "PROVIDER_UNAVAILABLE" }];
  s = await mkSignal(); page = newPage(); await page.ctl.start(s);
  const inP = page.last().phase === "in_progress";
  const failedReached = await phaseIs(page, "failed");
  const fail = page.last().failure;
  check("D4 D - IN PROGRESS -> FAILED: shown as in progress first (never as a failure because the response ended), then as the attempt's real outcome in the existing fixed wording; ONE provider call; nothing stored", inP && Boolean(failedReached) && fail?.message === presentGenerationFailure({ status: 502, code: "PROVIDER_UNAVAILABLE" }).message && !JSON.stringify(fail).includes("scripted") && proxy.analyzeCalls === 1 && (await storedCount(s)) === 0);
  // G / I: re-entry after failure, then an explicit retry
  const reentry = newPage(); await reentry.ctl.observe(s);
  check("D5 G - RE-ENTRY AFTER FAILURE (a fresh page): the failed state is read, the same fixed wording, NO provider call", reentry.last().phase === "failed" && reentry.last().failure?.message === fail.message && proxy.analyzeCalls === 1);
  await reentry.ctl.start(s);
  check("D6 I - EXPLICIT RETRY AFTER THE TERMINAL FAILURE: a NEW attempt (2 attempt rows: the failed one stays), 2 provider calls in total, the analysis is stored and the page reaches 'succeeded'", reentry.last().phase === "succeeded" && proxy.analyzeCalls === 2 && (await M.AnalysisAttempt.countDocuments({ signalId: s })) === 2 && (await storedCount(s)) === 1);
  // F: re-entry after success
  const again = newPage(); await again.ctl.observe(s);
  check("D7 F - RE-ENTRY AFTER SUCCESS (a fresh page): 'succeeded' from the read, NO provider call, no new attempt", again.last().phase === "succeeded" && proxy.analyzeCalls === 2 && (await M.AnalysisAttempt.countDocuments({ signalId: s })) === 2);

  // E / H: refresh and repeated Try Again while running
  proxy.analyzeCalls = 0; proxy.script = [{ delay: 5000 }];
  s = await mkSignal(); page = newPage(); await page.ctl.start(s);
  const refreshed = newPage(); await refreshed.ctl.observe(s);
  for (let i = 0; i < 4; i += 1) await refreshed.ctl.start(s); // "Try again" pressed repeatedly while the attempt runs (the page offers no button; a programmatic call must not start another)
  const hammer = await Promise.all([pageApi(me, A).start(s), pageApi(me, A).start(s), pageApi(me, A).start(s)]); // the backend alone, hit directly: still one attempt
  check("D8 E/H - PAGE REFRESH WHILE RUNNING + repeated 'Try again': the fresh page shows 'in progress'; every further request converged on the SAME attempt: ONE provider call, ONE attempt row", refreshed.last().phase === "in_progress" && hammer.every((x) => x.kind === "in_progress") && proxy.analyzeCalls === 1 && (await M.AnalysisAttempt.countDocuments({ signalId: s })) === 1);
  const refreshedDone = await phaseIs(refreshed, "succeeded"); const originalDone = await phaseIs(page, "succeeded");
  check("D9 both pages (the original and the refreshed one) reach 'succeeded' from the one attempt: still ONE provider call, ONE analysis", Boolean(refreshedDone) && Boolean(originalDone) && proxy.analyzeCalls === 1 && (await storedCount(s)) === 1);

  // K / L / M: Decision and Action while running, and unchanged after success
  proxy.analyzeCalls = 0; proxy.script = [{ delay: 3000 }];
  s = await mkSignal(); page = newPage(); await page.ctl.start(s);
  const attemptDoc = await M.AnalysisAttempt.findOne({ signalId: s }).lean();
  const decTries = []; for (const id of [String(attemptDoc._id), attemptDoc.attemptId, "6aa29b8d18df3e22b3e89cff"]) decTries.push((await call("POST", `/decisions/propose/${id}?workspaceId=${A}`, me)).status);
  const actTry = (await call("POST", `/actions/propose/6aa29b8d18df3e22b3e89cff?workspaceId=${A}`, me)).status;
  check("D10 K/L - WHILE IN PROGRESS the backend offers no path to a Decision or Action: proposing from the attempt's ids or any non-existent analysis is refused; no Decision, Action or Outcome exists", page.last().phase === "in_progress" && decTries.every((x) => [400, 404].includes(x)) && [400, 404].includes(actTry) && (await M.Decision.countDocuments({ workspaceId: wsA._id })) === 0 && (await M.Action.countDocuments({ workspaceId: wsA._id })) === 0 && (await M.Outcome.countDocuments({ workspaceId: wsA._id })) === 0, JSON.stringify(decTries));
  await phaseIs(page, "succeeded");
  const intel = await M.Intelligence.findOne({ workspaceId: wsA._id, signalIds: s }).lean();
  const dp = await call("POST", `/decisions/propose/${intel._id}?workspaceId=${A}`, me);
  const da = await call("POST", `/decisions/${dp.data?._id}/approve?workspaceId=${A}`, me, {});
  const ap = await call("POST", `/actions/propose/${dp.data?._id}?workspaceId=${A}`, me);
  const aa = await call("POST", `/actions/${ap.data?._id}/approve?workspaceId=${A}`, me, { note: "approved by a person (suite)" });
  const oc = await call("POST", `/outcomes/record/${ap.data?._id}?workspaceId=${A}`, me, { status: "success", result: { summary: "recorded by a person (suite)" } });
  check("D11 M - AFTER SUCCESS the existing Decision -> Action -> Outcome flow is unchanged: 201, 200, 201, 200, 201, one record each, still ONE provider call", [dp.status, da.status, ap.status, aa.status, oc.status].join() === "201,200,201,200,201" && (await M.Decision.countDocuments({ workspaceId: wsA._id })) === 1 && (await M.Action.countDocuments({ workspaceId: wsA._id })) === 1 && (await M.Outcome.countDocuments({ workspaceId: wsA._id })) === 1 && proxy.analyzeCalls === 1);

  // N / O: the SERVER's hazard classification reaches the page; the wording is added only for it
  const gasSignal = await mkSignal("Room 161: the guest reports a strong gas smell in the kitchen.");
  const acSignal = await mkSignal("Room 101: the guest says the air conditioning is not cooling and the room is getting warm.");
  const gasDoc = (await call("GET", `/signals/${gasSignal}?workspaceId=${A}`, me)).data; const acDoc = (await call("GET", `/signals/${acSignal}?workspaceId=${A}`, me)).data;
  const gasView = mapSignalFromApi(gasDoc); const acView = mapSignalFromApi(acDoc);
  check("D12 N - the REAL server classification reaches the page: a gas report carries the server-derived safety_hazard issue (serverHazard true); an air-conditioning report does not", gasDoc?.issue?.problemFamily === "safety_hazard" && gasView.serverHazard === true && acView.serverHazard === false && Words.isServerHazard(gasView) && !Words.isServerHazard(acView));
  proxy.analyzeCalls = 0; proxy.script = [{ delay: 2500 }];
  page = newPage(); await page.ctl.start(gasSignal);
  const gasInProgress = render(page.last(), { hazard: gasView.serverHazard });
  const acInProgress = render(gen({ phase: "in_progress", inProgress: true }), { hazard: acView.serverHazard });
  check("D13 N - SAFETY-CRITICAL IN PROGRESS (real gas report, real in-progress state): the in-progress state AND the hazard sentence are shown; the air-conditioning report gets the in-progress state only", page.last().phase === "in_progress" && gasInProgress.includes(Words.HAZARD_NOTE) && /Still preparing this assessment/.test(gasInProgress) && !acInProgress.includes(Words.HAZARD_NOTE) && /Still preparing this assessment/.test(acInProgress));
  await phaseIs(page, "succeeded");
  proxy.script = [{ status: 503, code: "PROVIDER_UNAVAILABLE" }];
  const gasFail = await mkSignal("Room 162: the guest reports smoke coming from the bathroom vent.");
  const gasFailView = mapSignalFromApi((await call("GET", `/signals/${gasFail}?workspaceId=${A}`, me)).data);
  page = newPage(); await page.ctl.start(gasFail);
  const gasFailed = render(page.last(), { hazard: gasFailView.serverHazard });
  check("D14 O - SAFETY-CRITICAL FAILURE (real smoke report, real failed attempt): the existing failure wording, the hazard sentence and the retry are shown", page.last().phase === "failed" && gasFailView.serverHazard === true && gasFailed.includes(Words.HAZARD_NOTE) && gasFailed.includes(page.last().failure.message) && /Try again/i.test(gasFailed));

  // R: workspace isolation
  proxy.analyzeCalls = 0; proxy.script = [];
  const foreign = newPage(adminB, B);
  await foreign.ctl.observe(s);
  check("D15 R - WORKSPACE ISOLATION (read): workspace B's page, given workspace A's report, learns nothing: the state read is refused and the page stays 'idle'", foreign.last().phase === "idle");
  await foreign.ctl.start(s);
  check("D16 R - WORKSPACE ISOLATION (start): workspace B cannot cause or attach to an analysis of A's report: refused, shown in fixed wording only, ZERO provider calls, no attempt row for B", foreign.last().phase === "failed" && !JSON.stringify(foreign.last().failure).includes(String(s)) && proxy.analyzeCalls === 0 && (await M.AnalysisAttempt.countDocuments({ workspaceId: wsB._id })) === 0);

  // the whole run
  check("D17 Learning stayed OFF and nothing used a real provider: the flag is unset, no admission used Learning, every provider call went to the deterministic test AI service", process.env.KOI_LEARNING_CONTEXT_ENABLED === undefined && (await M.AnalysisAdmission.countDocuments({ learningUsed: true })) === 0);
} catch (error) {
  failed += 1;
  console.error("FAIL  suite crashed -", error?.stack ?? error);
} finally {
  for (const c of children) kill(c);
  try { await vite.close(); } catch { /* best effort */ }
  try { await mongoose.connection.dropDatabase(); } catch { /* best effort */ }
  try { await mongoose.disconnect(); } catch { /* best effort */ }
}
console.log(`\nWorkstream 5B hybrid analysis status and UX validation: ${passed} passed, ${failed} failed (isolated database ${DB_NAME} dropped; no Gemini call; no external network)`);
process.exit(failed === 0 ? 0 : 1);
