/**
 * Safety posture + context quality hardening (P2-A / P2-B of the Core Acceptance Test). LOCAL ONLY: an isolated database (dropped), the DETERMINISTIC test AI service behind a scripted
 * loopback proxy (zero Gemini calls, zero external network), spawned backends, the real frontend modules through Vite SSR. Nothing here changes the safety policy, a prompt, the model,
 * a timeout, retrieval or Learning; it proves the two behaviours added on top of them.
 *
 *   A  the EXISTING safety policy and the rule-code list the model stores (and the one open policy question: vague hazard wording, case H - pinned, not decided)
 *   B  RECURRENCE rule, pure (cases A-E and the gates)
 *   C  the real backend: recurrence through GET /signals/:id/context (cases A-E), tenant isolation, role-gated outcome evidence, no ids leaked
 *   D  SAFETY propagation to the Action stage (cases F, G), unchanged hazard behaviour, legacy records
 *   E  AI in progress / failed (cases I, J): the server-derived classification stays available; Decision / Action stay unavailable
 *   F  full lifecycle regression (recurrence case, normal case, hazard + access refusal case): no duplicates, no extra provider call on reload, history and safety persist
 *   G  the page: refusal restriction and recurrence wording, from the server's structured answers only
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
const DB_NAME = `koi_safetyctx_${Date.now()}`;
process.env.MONGODB_URI = `mongodb://127.0.0.1:27017/${DB_NAME}`; // isolated local database; never Atlas
const { createActor, tokenFor, bearer } = await import("./lib/authFixtures.mjs");
for (const k of ["KOI_LEARNING_CONTEXT_ENABLED", "KOI_ANALYSIS_RESPONSE_WINDOW_MS", "KOI_AI_ANALYSIS_TIMEOUT_MS", "KOI_AI_TIMEOUT_MS", "KOI_SOCKET_TIMEOUT_MS"]) delete process.env[k];
const mongoose = (await import("mongoose")).default;
const { connectDatabase } = await import("../src/config/database.js");
const M = await import("../src/models/index.js");
const { SAFETY_RULE_CODES, SAFETY_STATES } = await import("../src/models/Intelligence.js");
const { deriveSafetyPolicy } = await import("../src/services/ai/safetyPolicy.js");
const { extractStructuredIssue } = await import("../src/services/structuredIssue.js");
const { deriveRecurrence, compareIssues } = await import("../src/services/recurrence.js");

let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => { if (ok) { passed += 1; console.log(`PASS  ${name}`); } else { failed += 1; console.error(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 30000, step = 150) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step); } };
const read = (p) => fs.readFileSync(p, "utf8");
const children = [];
const kill = (c) => { try { c.kill("SIGKILL"); } catch { /* gone */ } };

const { createServer } = await import(pathToFileURL(path.join(FRONTEND, "node_modules", "vite", "dist", "node", "index.js")).href);
const vite = await createServer({ root: FRONTEND, configFile: path.join(FRONTEND, "vite.config.js"), server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom", logLevel: "silent", optimizeDeps: { noDiscovery: true, include: [] } });

try {
  const issue = (title, description = title, severity = "medium") => extractStructuredIssue({ title, description, severity });
  const ISSUE = (equipment, problemFamily, condition) => ({ version: 1, equipment, problemFamily, condition, source: "SERVER_DERIVED" });

  // ============================================================================================================ A. the existing policy and the stored rule codes
  const pAccess = deriveSafetyPolicy({ signal: { title: "Room 204: the guest refuses entry to the room.", severity: "medium" } });
  const pGasAccess = deriveSafetyPolicy({ signal: { title: "Room 204: the guest reports a gas smell but refuses to let staff enter the room.", severity: "medium" } });
  const pCritical = deriveSafetyPolicy({ signal: { title: "Room 204: the AC is not cooling", severity: "critical" } });
  const pVague = deriveSafetyPolicy({ signal: { title: "Room 165: the guest refuses entry to the room, and there is a suspected hazardous condition.", severity: "medium" } });
  const pVagueAlone = deriveSafetyPolicy({ signal: { title: "Room 165: there is a suspected hazardous condition in the room.", severity: "medium" } });
  const allRules = new Set([...pAccess.rules, ...pGasAccess.rules, ...pCritical.rules]);
  check("A1 the stored rule-code list equals the codes the EXISTING policy can emit, and the stored states equal its states", [...allRules, "SAFETY_REVIEW_REQUIRED"].sort().join() === [...SAFETY_RULE_CODES].sort().join() && JSON.stringify(SAFETY_STATES) === JSON.stringify(["NORMAL", "CRITICAL", "SAFETY_REVIEW_REQUIRED", "LIFE_SAFETY_HAZARD"]), [...allRules].join());
  check("A2 EXISTING policy, unchanged: access refusal ALONE is not a hazard (state NORMAL, rule ACCESS_REFUSED, dispatch and inspection forbidden, escalation / guest communication / other not forbidden)", pAccess.state === "NORMAL" && pAccess.rules.join() === "ACCESS_REFUSED" && pAccess.forbiddenActionTypes.join() === "maintenance_dispatch,inspection" && pAccess.requiredActionTypes === null);
  check("A3 EXISTING policy, unchanged: an established hazard + access refusal permits ONLY escalation and still forbids dispatch / inspection", pGasAccess.state === "LIFE_SAFETY_HAZARD" && pGasAccess.requiredActionTypes.join() === "escalation" && pGasAccess.forbiddenActionTypes.join() === "maintenance_dispatch,inspection" && pGasAccess.minimumUrgency === "immediate");
  check("A4 CASE H (since decided - see validate-safety-review-required.mjs): without the opt-in the three-state result is unchanged (\"suspected hazardous condition\" is NORMAL for every caller that does not ask for SAFETY_REVIEW_REQUIRED, e.g. Learning); the approved cue list applies only to the analysis pipeline", pVague.state === "NORMAL" && pVague.rules.join() === "ACCESS_REFUSED" && pVagueAlone.state === "NORMAL" && pVagueAlone.rules.length === 0);
  const policySrc = read(path.join(BACKEND, "src", "services", "ai", "safetyPolicy.js"));
  check("A5 no safety policy code was changed by this workstream (the policy still documents its closed word lists and contains the same rules)", /HONEST LIMITS/.test(policySrc) && /HAZARD_PATTERNS = Object\.freeze/.test(policySrc) && /ACCESS_REFUSAL_PATTERN/.test(policySrc));

  // ============================================================================================================ B. recurrence rule (pure)
  const now = Date.parse("2026-10-14T10:00:00Z");
  const cur = (over = {}) => ({ id: "cur", unitId: "u204", createdAt: new Date(now), issue: ISSUE("air_conditioner", "temperature_fault", "not_cooling"), ...over });
  const old = (over = {}) => ({ id: "old", unitId: "u204", createdAt: new Date(now - 3600_000), issue: ISSUE("air_conditioner", "temperature_fault", "not_cooling"), ...over });
  const d = (c, e) => deriveRecurrence(c, e);
  check("B1 CASE A: no earlier report -> no recurrence", d(cur(), []).detected === false && d(cur(), undefined).detected === false);
  check("B2 CASE B: same equipment, same problem, same condition, same room, earlier -> recurrence (condition 'same')", d(cur(), [old()]).detected === true && d(cur(), [old()]).matches[0].condition === "same");
  check("B3 CASE C: the same equipment and problem in ANOTHER room -> no room-specific recurrence", d(cur(), [old({ unitId: "u312" })]).detected === false && d(cur(), [old({ unitId: null })]).detected === false);
  check("B4 CASE D: similar wording but a different structured issue -> no recurrence (different problem, different equipment, different family)", d(cur(), [old({ issue: ISSUE("air_conditioner", "water_leak", "UNKNOWN") })]).detected === false && d(cur(), [old({ issue: ISSUE("refrigerator", "temperature_fault", "not_cooling") })]).detected === false);
  check("B5 CASE E: insufficient structured information -> no claim (legacy record with no issue, untrusted issue, UNKNOWN / AMBIGUOUS equipment or problem on either side)",
    [old({ issue: undefined }), old({ issue: { ...old().issue, source: "CLIENT" } }), old({ issue: ISSUE("UNKNOWN", "temperature_fault", "not_cooling") }), old({ issue: ISSUE("air_conditioner", "UNKNOWN", "not_cooling") }), old({ issue: ISSUE("AMBIGUOUS", "temperature_fault", "not_cooling") })].every((o) => d(cur(), [o]).detected === false) &&
    [cur({ issue: ISSUE("UNKNOWN", "temperature_fault", "not_cooling") }), cur({ issue: ISSUE("AMBIGUOUS", "temperature_fault", "not_cooling") }), cur({ issue: ISSUE("air_conditioner", "UNKNOWN", "UNKNOWN") }), cur({ issue: undefined })].every((c) => d(c, [old()]).detected === false));
  check("B6 condition: two different KNOWN conditions (not cooling vs not heating) and AMBIGUOUS conditions -> no claim; a condition missing on one side -> a match reported as 'not_recorded' (never as the same condition)",
    d(cur(), [old({ issue: ISSUE("air_conditioner", "temperature_fault", "not_heating") })]).detected === false && d(cur(), [old({ issue: ISSUE("air_conditioner", "temperature_fault", "AMBIGUOUS") })]).detected === false &&
    d(cur({ issue: ISSUE("air_conditioner", "temperature_fault", "UNKNOWN") }), [old()]).matches[0]?.condition === "not_recorded" && compareIssues(ISSUE("air_conditioner", "temperature_fault", "UNKNOWN"), ISSUE("air_conditioner", "temperature_fault", "UNKNOWN")).condition === "not_recorded");
  check("B7 the earlier report must be strictly earlier and a different Signal; newest first; at most three; shared words are never evidence (only the structured issue is read)",
    d(cur(), [old({ createdAt: new Date(now) })]).detected === false && d(cur(), [old({ createdAt: new Date(now + 1000) })]).detected === false && d(cur(), [old({ id: "cur" })]).detected === false &&
    d(cur(), [1, 2, 3, 4, 5].map((i) => old({ id: `o${i}`, createdAt: new Date(now - i * 1000) }))).matches.map((m) => m.id).join() === "o1,o2,o3" && !/title|description|text|match\(|RegExp|test\(/.test(read(path.join(BACKEND, "src", "services", "recurrence.js")).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")));
  const recSrc = read(path.join(BACKEND, "src", "services", "recurrence.js")); const svcSrc = read(path.join(BACKEND, "src", "services", "signalRecurrenceService.js"));
  check("B8 the rule is deterministic and model-free: no AI client, no embedding, no Learning import (only the structured-issue vocabulary), no network", !/aiServiceClient|requestEmbeddings|fetch\(|axios|genai|learning\/(?!caseFacets)/.test(recSrc + svcSrc.replace(/\/\*[\s\S]*?\*\//g, "")) && /isTrustedIssue/.test(recSrc));

  // ============================================================================================================ the rig: deterministic AI service behind a scripted proxy + real backends
  await connectDatabase();
  if (mongoose.connection.db.databaseName !== DB_NAME) throw new Error("refusing to run: not the isolated database");
  for (const Model of [M.AnalysisAttempt, M.Intelligence, M.AnalysisAdmission]) await Model.init();
  const proxy = { analyzeCalls: 0, script: [] };
  const AI_PORT = 8187; const PROXY_PORT = 8188;
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
  const startBackend = async (port, extra = {}) => {
    const c = spawn(process.execPath, [path.join(BACKEND, "server.js")], { env: { ...process.env, PORT: String(port), LLM_PROVIDER: "test-python", AI_SERVICE_URL: `http://127.0.0.1:${PROXY_PORT}`, KOI_RATE_LIMIT_ENABLED: "false", CLIENT_URL: "http://localhost:5199", ...extra }, stdio: "ignore" });
    children.push(c); const base = `http://localhost:${port}/api`;
    for (let i = 0; i < 160; i += 1) { try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* starting */ } await sleep(250); }
    return base;
  };
  const BASE = await startBackend(5460);
  const BASE_SHORT = await startBackend(5461, { KOI_ANALYSIS_RESPONSE_WINDOW_MS: "1200" });

  const wsA = await M.Workspace.create({ name: "SC a", slug: `sc-a-${Date.now()}`, status: "active" });
  const wsB = await M.Workspace.create({ name: "SC b", slug: `sc-b-${Date.now()}`, status: "active" });
  const A = String(wsA._id); const B = String(wsB._id);
  const op = await createActor({ role: "operator", workspaceId: wsA._id, label: "sc-op" });
  const rev = await createActor({ role: "reviewer", workspaceId: wsA._id, label: "sc-rev" });
  const adm = await createActor({ role: "admin", workspaceId: wsA._id, label: "sc-adm" });
  const viewer = await createActor({ role: "viewer", workspaceId: wsA._id, label: "sc-view" });
  const admB = await createActor({ role: "admin", workspaceId: wsB._id, label: "sc-admb" });
  const opB = await createActor({ role: "operator", workspaceId: wsB._id, label: "sc-opb" });
  const api = async (who, method, url, body, base = BASE) => {
    const res = await fetch(`${base}${url}`, { method, headers: { ...bearer(tokenFor(who.user)), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await res.text(); let json = null; try { json = JSON.parse(t); } catch { /* none */ }
    return { status: res.status, json, data: json?.data, code: json?.details?.code, raw: t };
  };
  const mkProperty = async (ws, rooms) => {
    const prop = await M.Property.create({ workspaceId: ws._id, name: `SC Residence ${String(ws._id).slice(-4)}`, code: `SC${String(ws._id).slice(-4)}`.toUpperCase(), timezone: "UTC" });
    const units = {};
    for (const room of rooms) {
      const unit = await M.Unit.create({ propertyId: prop._id, unitNumber: room, status: "occupied" });
      const guest = await M.Guest.create({ workspaceId: ws._id, firstName: "Synthfirst", lastName: `Synthlast${room}`, email: `s${room}@example.invalid` });
      await M.Stay.create({ workspaceId: ws._id, guestId: guest._id, propertyId: prop._id, unitId: unit._id, status: "checked_in", checkIn: new Date(Date.now() - 86400000), checkOut: new Date(Date.now() + 3 * 86400000) });
      units[room] = unit;
    }
    return { prop, units };
  };
  const R = await mkProperty(wsA, ["204", "312", "118", "151", "161", "165"]);
  const RB = await mkProperty(wsB, ["204"]);
  const intake = async (who, ws, text, base = BASE) => { const r = await api(who, "POST", "/conversations/intake", { workspaceId: ws, content: text }, base); await sleep(15); return r.data?.signal; };
  const ctx = (who, ws, id, base = BASE) => api(who, "GET", `/signals/${id}/context?workspaceId=${ws}`, undefined, base);

  // ============================================================================================================ C. recurrence through the real backend (cases A-E)
  const s1 = await intake(op, A, "Room 204 AC is not cooling properly.");
  const c1 = (await ctx(op, A, s1._id)).data;
  check("C1 CASE A (real backend): the first AC report in room 204 has NO recurrence; the context response is unchanged otherwise (signal / guest / stay / property / unit / history) and gains only `recurrence`", c1.recurrence?.detected === false && c1.recurrence?.matches?.length === 0 && ["signal", "guest", "stay", "property", "unit", "history", "recurrence"].every((k) => k in c1));
  // the earlier case runs its whole lifecycle with a recorded outcome (deterministic provider)
  const an1 = await api(op, "POST", `/intelligence/analyze/${s1._id}?workspaceId=${A}`);
  const dec1 = await api(op, "POST", `/decisions/propose/${an1.data?._id}?workspaceId=${A}`);
  await api(rev, "POST", `/decisions/${dec1.data?._id}/approve?workspaceId=${A}`, {});
  const act1 = await api(op, "POST", `/actions/propose/${dec1.data?._id}?workspaceId=${A}`);
  await api(rev, "POST", `/actions/${act1.data?._id}/approve?workspaceId=${A}`, {});
  const out1 = await api(op, "POST", `/outcomes/record/${act1.data?._id}?workspaceId=${A}`, { status: "success", result: { summary: "Breaker reset by the technician; room cooled within the hour." } });
  check("C2 the earlier case completed (analysis, Decision, Action, Outcome recorded by a person)", an1.status === 201 && dec1.status === 201 && act1.status === 201 && out1.status === 201);
  const s2 = await intake(op, A, "Room 204: the AC is not cooling again.");
  const forOperator = (await ctx(op, A, s2._id)).data; const forAdmin = (await ctx(adm, A, s2._id)).data; const forViewer = await ctx(viewer, A, s2._id);
  check("C3 CASE B (real backend): the second AC report in the SAME room IS a recurrence of the first (scope unit, condition 'same', the earlier report's date); no cause, no recommendation, no id in the answer",
    forOperator.recurrence.detected === true && forOperator.recurrence.scope === "unit" && forOperator.recurrence.matches.length === 1 && forOperator.recurrence.matches[0].condition === "same" && forOperator.recurrence.matches[0].issue.equipment === "air_conditioner" && forOperator.recurrence.matches[0].issue.problem === "temperature_fault" && Date.parse(forOperator.recurrence.matches[0].reportedAt) < Date.parse(forOperator.signal.createdAt) &&
    !JSON.stringify(forOperator.recurrence).includes(String(s1._id)) && !/signalId|_id|"id"/.test(JSON.stringify(forOperator.recurrence)));
  check("C4 historical OUTCOME evidence is role-gated: a reviewer / admin (who may already read Outcomes) sees what the person recorded for the earlier report; an operator and a viewer do not", forAdmin.recurrence.matches[0].outcome?.status === "success" && /Breaker reset/.test(forAdmin.recurrence.matches[0].outcome.summary) && forOperator.recurrence.matches[0].outcome === undefined && (forViewer.status !== 200 || forViewer.data.recurrence.matches[0].outcome === undefined), JSON.stringify({ admin: forAdmin.recurrence.matches[0], operator: forOperator.recurrence.matches[0], viewerStatus: forViewer.status }));
  const s3 = await intake(op, A, "Room 312 AC is not cooling properly.");
  const c3 = (await ctx(adm, A, s3._id)).data;
  check("C5 CASE C (real backend): the same equipment and problem in ANOTHER room (312) is NOT a recurrence for 312, even though room 204 has such a case", c3.recurrence.detected === false);
  const s4 = await intake(op, A, "Room 204 AC is leaking water onto the floor.");
  const s5 = await intake(op, A, "Room 204 refrigerator is not cooling.");
  const c4 = (await ctx(adm, A, s4._id)).data; const c5 = (await ctx(adm, A, s5._id)).data;
  check("C6 CASE D (real backend): similar wording but a different structured issue is NOT a recurrence (AC leaking water vs AC not cooling; refrigerator vs AC) - and the AC-not-cooling case does not turn the leak into a repeat", c4.recurrence.detected === false && c5.recurrence.detected === false && (await api(adm, "GET", `/signals/${s4._id}?workspaceId=${A}`)).data.issue.problemFamily === "water_leak");
  const legacy = await M.Signal.collection.insertOne({ workspaceId: wsA._id, propertyId: R.prop._id, unitId: R.units["118"]._id, type: "maintenance", severity: "medium", status: "new", source: "staff", title: "Room 118 AC is not cooling properly.", description: "Room 118 AC is not cooling properly.", createdAt: new Date(Date.now() - 600000), updatedAt: new Date(), __v: 0 });
  const s6 = await intake(op, A, "Room 118 AC is not cooling properly.");
  const unknownEarlier = await intake(op, A, "Room 151: something is not working.");
  const s7 = await intake(op, A, "Room 151: the AC and the refrigerator are both not cooling.");
  const c6 = (await ctx(adm, A, s6._id)).data; const c7 = (await ctx(adm, A, s7._id)).data;
  check("C7 CASE E (real backend): a prior case with insufficient structured information (a legacy Signal with no structured issue; an UNKNOWN-equipment report) gives NO recurrence claim; an AMBIGUOUS current report (two devices) gives none", c6.recurrence.detected === false && c7.recurrence.detected === false && (await api(adm, "GET", `/signals/${s7._id}?workspaceId=${A}`)).data.issue.equipment === "AMBIGUOUS");
  const again = (await ctx(adm, A, s2._id)).data;
  check("C8 the answer is recomputed from the stored records and is stable: reading it again returns the identical recurrence (it persists across reload) and a LATER report never becomes evidence for an earlier one", JSON.stringify(again.recurrence) === JSON.stringify(forAdmin.recurrence) && (await ctx(adm, A, s1._id)).data.recurrence.detected === false);
  const foreign = await intake(opB, B, "Room 204 AC is not cooling properly.", BASE);
  const cf = await ctx(admB, B, foreign._id);
  check("C9 TENANT ISOLATION: another workspace's identical room number and AC report never counts; another workspace cannot read this one's context (404)", cf.data.recurrence.detected === false && (await ctx(admB, B, s2._id)).status === 404);

  // ============================================================================================================ D. safety propagation to the Action stage (cases F, G)
  const analyseAndApprove = async (text, { approve = true } = {}) => {
    const sg = await intake(op, A, text); const an = await api(op, "POST", `/intelligence/analyze/${sg._id}?workspaceId=${A}`);
    const dec = await api(op, "POST", `/decisions/propose/${an.data?._id}?workspaceId=${A}`);
    if (approve) await api(rev, "POST", `/decisions/${dec.data?._id}/approve?workspaceId=${A}`, {});
    return { sg, an, dec };
  };
  const refusalA = await analyseAndApprove("Room 118: the AC is not cooling and the guest refuses entry.");
  check("D1 CASE F: access refusal WITHOUT a hazard is stored as NORMAL with the rule ACCESS_REFUSED (the rule code is now part of the stored, server-derived safety result); it is not turned into a hazard", refusalA.an.status === 201 && refusalA.an.data.safety?.state === "NORMAL" && refusalA.an.data.safety.rules?.join() === "ACCESS_REFUSED" && refusalA.sg.issue.problemFamily !== "safety_hazard", JSON.stringify(refusalA.an.data?.safety));
  const stored = await M.Intelligence.findOne({ _id: refusalA.an.data._id }).lean();
  check("D2 the stored record carries the rules (model field) and the AnalysisAdmission audit still carries them too", stored.safety.rules.join() === "ACCESS_REFUSED" && (await M.AnalysisAdmission.findOne({ workspaceId: wsA._id, signalId: refusalA.sg._id }).lean())?.safetyRules?.includes("ACCESS_REFUSED") === true);
  const tryType = async (text, requested) => { const x = await analyseAndApprove(text); const r = await api(op, "POST", `/actions/propose/${x.dec.data?._id}?workspaceId=${A}`, requested ? { actionType: requested } : undefined); return { r, x }; };
  const dispatchRefused = await tryType("Room 118: the AC is not cooling, the guest refuses entry, send someone later.", "maintenance_dispatch");
  const inspectRefused = await tryType("Room 118: the AC is not cooling and the guest refuses access to the unit.", "inspection");
  check("D3 CASE F: for a refused-access case with NO hazard the existing restriction now reaches the Action stage: maintenance_dispatch and inspection are refused (409 ACTION_TYPE_CONFLICTS_WITH_SAFETY); nothing is created", dispatchRefused.r.status === 409 && dispatchRefused.r.code === "ACTION_TYPE_CONFLICTS_WITH_SAFETY" && inspectRefused.r.status === 409 && inspectRefused.r.code === "ACTION_TYPE_CONFLICTS_WITH_SAFETY" && (await M.Action.countDocuments({ decisionId: dispatchRefused.x.dec.data._id })) === 0);
  const commOk = await tryType("Room 118: the AC is not cooling and the guest declines staff entry for now.", "guest_communication");
  const escOk = await tryType("Room 118: the AC is not cooling and the guest denies maintenance access.", "escalation");
  const defaultOk = await tryType("Room 118: the AC is not cooling and the guest will not allow staff to enter.");
  check("D4 CASE F: no invented prohibition - guest_communication, escalation and the default Action are still allowed for refusal without hazard (201), and none of them is a critical / hazard record", [commOk, escOk, defaultOk].every((x) => x.r.status === 201 && x.r.data.riskLevel !== "critical") && commOk.r.data.actionType === "guest_communication" && escOk.r.data.actionType === "escalation");
  const rejectNoReason = await analyseAndApprove("Room 118: the AC is not cooling and the guest refuses entry again.", { approve: false });
  const rj = await api(rev, "POST", `/decisions/${rejectNoReason.dec.data?._id}/reject?workspaceId=${A}`, {});
  check("D5 CASE F: access refusal alone does not add hazard gating - rejecting such a Decision still needs no recorded reason (it is not a safety assessment)", rj.status === 200 && rj.data?.status === "rejected", `${rj.status} ${rj.code}`);
  const hazRefusal1 = await tryType("Room 161: the guest reports a gas smell but refuses to let staff enter the room.", "maintenance_dispatch");
  const hazRefusal2 = await tryType("Room 161: strong gas smell, and the guest refuses entry.", "inspection");
  const hazRefusalOk = await tryType("Room 161: gas smell reported and the guest refuses entry to staff.", "escalation");
  const hazRefusalDefault = await tryType("Room 161: I smell gas and the guest will not allow entry.");
  check("D6 CASE G: an established hazard + access refusal is stored with BOTH rules (LIFE_SAFETY_HAZARD, ACCESS_REFUSED) and state LIFE_SAFETY_HAZARD", hazRefusal1.x.an.data.safety.state === "LIFE_SAFETY_HAZARD" && ["ACCESS_REFUSED", "LIFE_SAFETY_HAZARD"].every((r) => hazRefusal1.x.an.data.safety.rules.includes(r)), JSON.stringify(hazRefusal1.x.an.data.safety));
  check("D7 CASE G: the existing safety posture now SURVIVES into Action eligibility even when the analysis recorded no action type (deterministic provider): dispatch and inspection are refused, ONLY escalation is accepted (default = escalation, risk critical, urgency per the analysis)",
    hazRefusal1.r.status === 409 && hazRefusal2.r.status === 409 && hazRefusalOk.r.status === 201 && hazRefusalOk.r.data.actionType === "escalation" && hazRefusalOk.r.data.riskLevel === "critical" && hazRefusalDefault.r.status === 201 && hazRefusalDefault.r.data.actionType === "escalation");
  const hazOnly = await tryType("Room 161: a strong gas smell in the kitchen.", "maintenance_dispatch");
  check("D8 UNCHANGED: a hazard WITHOUT a refusal still permits escalation or maintenance_dispatch (existing behaviour), risk critical", hazOnly.x.an.data.safety.rules.join() === "LIFE_SAFETY_HAZARD" && hazOnly.r.status === 201 && hazOnly.r.data.actionType === "maintenance_dispatch" && hazOnly.r.data.riskLevel === "critical");
  const hazPending = await analyseAndApprove("Room 161: gas smell in the corridor outside.", { approve: false });
  const rej0 = await api(rev, "POST", `/decisions/${hazPending.dec.data?._id}/reject?workspaceId=${A}`, {}); const rej1 = await api(rev, "POST", `/decisions/${hazPending.dec.data?._id}/reject?workspaceId=${A}`, { note: "x" });
  check("D9 UNCHANGED: rejecting a life-safety Decision still requires a reason and then an alternative", rej0.code === "DECISION_REASON_REQUIRED" && rej1.code === "DECISION_ALTERNATIVE_REQUIRED", `${rej0.code} ${rej1.code}`);
  const legacyAnalysis = await analyseAndApprove("Room 118: the AC is not cooling and the guest refuses entry again today.");
  await M.Intelligence.updateOne({ _id: legacyAnalysis.an.data._id }, { $unset: { "safety.rules": "" } }); // a record from before the field existed
  const legacyAct = await api(op, "POST", `/actions/propose/${legacyAnalysis.dec.data?._id}?workspaceId=${A}`, { actionType: "maintenance_dispatch" });
  const legacyView = (await api(adm, "GET", `/intelligence/${legacyAnalysis.an.data._id}?workspaceId=${A}`)).data;
  check("D10 LEGACY: a record with no stored rules (absent = 'not recorded', never 'no rule applied') behaves exactly as before and its view carries no `rules`", legacyAct.status === 201 && legacyView.safety.rules === undefined && legacyView.safety.state === "NORMAL");

  // ============================================================================================================ E. AI in progress / failed (cases I, J)
  const gas = await intake(op, A, "Room 161: there is a strong gas smell in the room, the guest refuses entry.", BASE_SHORT);
  const gasBefore = (await api(op, "GET", `/signals/${gas._id}?workspaceId=${A}`)).data;
  proxy.analyzeCalls = 0; proxy.script = [{ delay: 3500 }];
  const inProg = await api(op, "POST", `/intelligence/analyze/${gas._id}?workspaceId=${A}`, undefined, BASE_SHORT);
  const stDuring = (await api(op, "GET", `/intelligence/analysis-status/${gas._id}?workspaceId=${A}`, undefined, BASE_SHORT)).data;
  const gasDuring = (await api(op, "GET", `/signals/${gas._id}?workspaceId=${A}`, undefined, BASE_SHORT)).data;
  const decDuring = await api(op, "POST", `/decisions/propose/${(await M.AnalysisAttempt.findOne({ signalId: gas._id }).lean())?._id}?workspaceId=${A}`, undefined, BASE_SHORT);
  const polDuring = deriveSafetyPolicy({ signal: { title: gasDuring.title, description: gasDuring.description, severity: gasDuring.severity } });
  check("D-J CASE J (AI IN PROGRESS, hazard + refusal): HTTP 202 / in_progress; the server-derived classification is the same before and during (structured issue 'safety_hazard', unchanged); the deterministic policy still returns LIFE_SAFETY_HAZARD + ACCESS_REFUSED from the Signal alone; no Decision / Action can exist",
    inProg.status === 202 && stDuring?.status === "in_progress" && gasBefore.issue.problemFamily === "safety_hazard" && JSON.stringify(gasDuring.issue) === JSON.stringify(gasBefore.issue) && polDuring.state === "LIFE_SAFETY_HAZARD" && polDuring.rules.includes("ACCESS_REFUSED") && [400, 404].includes(decDuring.status) && (await M.Decision.countDocuments({ signalId: gas._id })) === 0);
  await waitFor(async () => (await api(op, "GET", `/intelligence/analysis-status/${gas._id}?workspaceId=${A}`, undefined, BASE_SHORT)).data?.status === "succeeded", 30000, 400);
  const gasStored = await M.Intelligence.findOne({ signalIds: gas._id }).lean();
  check("D-J2 once the same attempt succeeds the stored result carries state LIFE_SAFETY_HAZARD and both rules, and exactly ONE provider call was made", gasStored?.safety?.state === "LIFE_SAFETY_HAZARD" && gasStored.safety.rules.includes("ACCESS_REFUSED") && proxy.analyzeCalls === 1);
  const gas2 = await intake(op, A, "Room 161: there is a gas smell and smoke, the guest refuses entry to staff.", BASE_SHORT);
  proxy.analyzeCalls = 0; proxy.script = [{ delay: 2500, status: 503, code: "PROVIDER_UNAVAILABLE" }];
  await api(op, "POST", `/intelligence/analyze/${gas2._id}?workspaceId=${A}`, undefined, BASE_SHORT);
  const failed = await waitFor(async () => { const s = (await api(op, "GET", `/intelligence/analysis-status/${gas2._id}?workspaceId=${A}`, undefined, BASE_SHORT)).data; return s?.status === "failed" ? s : null; }, 30000, 400);
  const gas2After = (await api(op, "GET", `/signals/${gas2._id}?workspaceId=${A}`, undefined, BASE_SHORT)).data;
  check("D-I CASE I (AI FAILED, hazard + refusal): the attempt is terminal 'failed' (one provider call, nothing stored); the classification is unchanged and still readable; the deterministic policy still says LIFE_SAFETY_HAZARD; no Decision / Action; the explicit retry then works and stores the hazard state + rules",
    Boolean(failed) && proxy.analyzeCalls === 1 && (await M.Intelligence.countDocuments({ signalIds: gas2._id })) === 0 && gas2After.issue.problemFamily === "safety_hazard" && deriveSafetyPolicy({ signal: { title: gas2After.title, description: gas2After.description } }).state === "LIFE_SAFETY_HAZARD" && (await M.Decision.countDocuments({ signalId: gas2._id })) === 0);
  const retry = await api(op, "POST", `/intelligence/analyze/${gas2._id}?workspaceId=${A}`, undefined, BASE_SHORT);
  check("D-I2 after the failure the operator's explicit retry succeeds with the safety posture intact (state LIFE_SAFETY_HAZARD, both rules)", retry.status === 201 && retry.data.safety.state === "LIFE_SAFETY_HAZARD" && retry.data.safety.rules.includes("ACCESS_REFUSED"));

  // ============================================================================================================ F. lifecycle regression
  const lifecycle = async (text, { outcome = true } = {}) => {
    const before = { intel: await M.Intelligence.countDocuments({}), dec: await M.Decision.countDocuments({}), act: await M.Action.countDocuments({}), out: await M.Outcome.countDocuments({}) };
    const sg = await intake(op, A, text); proxy.analyzeCalls = 0; proxy.script = [];
    const an = await api(op, "POST", `/intelligence/analyze/${sg._id}?workspaceId=${A}`);
    const dec = await api(op, "POST", `/decisions/propose/${an.data?._id}?workspaceId=${A}`);
    const dr = await api(rev, "POST", `/decisions/${dec.data?._id}/approve?workspaceId=${A}`, {});
    const act = await api(op, "POST", `/actions/propose/${dec.data?._id}?workspaceId=${A}`);
    const ar = await api(rev, "POST", `/actions/${act.data?._id}/approve?workspaceId=${A}`, {});
    const oc = outcome ? await api(op, "POST", `/outcomes/record/${act.data?._id}?workspaceId=${A}`, { status: "success", result: { summary: "Done and checked by the technician." } }) : null;
    const callsBefore = proxy.analyzeCalls;
    const sg2 = await api(op, "GET", `/signals/${sg._id}?workspaceId=${A}`); const an2 = await api(op, "POST", `/intelligence/analyze/${sg._id}?workspaceId=${A}`); const dec2 = await api(op, "POST", `/decisions/propose/${an.data?._id}?workspaceId=${A}`);
    const act2 = await api(op, "POST", `/actions/propose/${dec.data?._id}?workspaceId=${A}`);
    const ctx2 = (await ctx(adm, A, sg._id)).data; const view = (await api(adm, "GET", `/intelligence/${an.data._id}?workspaceId=${A}`)).data;
    return { sg, an, dec, act, oc, sg2, an2, dec2, act2, ctx2, view, ok: an.status === 201 && dr.status === 200 && ar.status === 200 && (!outcome || oc.status === 201), extra: { intel: (await M.Intelligence.countDocuments({})) - before.intel, dec: (await M.Decision.countDocuments({})) - before.dec, act: (await M.Action.countDocuments({})) - before.act, out: (await M.Outcome.countDocuments({})) - before.out }, reloadCalls: proxy.analyzeCalls - callsBefore, calls: proxy.analyzeCalls };
  };
  const L1 = await lifecycle("Room 204: the AC is not cooling yet again.");
  check("F1 RECURRENCE case, full lifecycle: Signal -> Intelligence -> Decision -> Action -> Outcome -> reload; exactly one record of each, ONE provider call, no provider call on reload, the repeat note and its historical evidence persist across reload, the analysis is unchanged by it", L1.ok && L1.extra.intel === 1 && L1.extra.dec === 1 && L1.extra.act === 1 && L1.extra.out === 1 && L1.calls === 1 && L1.reloadCalls === 0 && L1.an2.status === 200 && L1.dec2.data._id === L1.dec.data._id && L1.act2.data._id === L1.act.data._id && L1.ctx2.recurrence.detected === true && L1.ctx2.recurrence.matches.length >= 2 && L1.ctx2.recurrence.matches.some((m) => m.outcome?.status === "success") && L1.view._id === L1.an.data._id);
  const L2 = await lifecycle("Room 312: the television remote is not working.");
  check("F2 NORMAL case (a different room, no recurrence), full lifecycle: one record of each, one provider call, none on reload, no recurrence claim, NORMAL safety persisted without rules", L2.ok && L2.extra.intel === 1 && L2.extra.dec === 1 && L2.extra.act === 1 && L2.extra.out === 1 && L2.calls === 1 && L2.reloadCalls === 0 && L2.ctx2.recurrence.detected === false && L2.view.safety.state === "NORMAL" && L2.view.safety.rules === undefined);
  const L3 = await lifecycle("Room 165: gas smell and the guest refuses to let staff enter.", { outcome: true });
  check("F3 HAZARD + ACCESS REFUSAL case, full lifecycle (Action type = escalation, risk critical): one record of each, one provider call, none on reload; the safety state and both rules persist and read back unchanged; the Action stays 'not executed' (proposal approved, nothing sent)",
    L3.ok && L3.extra.intel === 1 && L3.extra.dec === 1 && L3.extra.act === 1 && L3.extra.out === 1 && L3.calls === 1 && L3.reloadCalls === 0 && L3.act.data.actionType === "escalation" && L3.act.data.riskLevel === "critical" && L3.view.safety.state === "LIFE_SAFETY_HAZARD" && L3.view.safety.rules.includes("ACCESS_REFUSED") && !/execut|sent|dispatched/i.test(JSON.stringify(Object.keys(L3.act.data))));
  check("F4 Learning stayed OFF and the model was never given the new fields: the flag is unset, no admission used Learning, and the analysis pipeline sources (prompt, AI client, context contract) were not touched by this workstream",
    process.env.KOI_LEARNING_CONTEXT_ENABLED === undefined && (await M.AnalysisAdmission.countDocuments({ learningUsed: true })) === 0 && !/recurrence/i.test(read(path.join(BACKEND, "src", "services", "operationalContextContract.js")) + read(path.join(BACKEND, "src", "services", "ai", "aiServiceClient.js")) + read(path.join(AI_SERVICE, "app", "services", "analysis_prompt.py"))));

  // ============================================================================================================ G. the page
  const feRequire = createRequire(path.join(FRONTEND, "package.json"));
  const React = feRequire("react"); const { renderToStaticMarkup } = feRequire("react-dom/server"); const h = React.createElement;
  const text = (m) => m.replace(/<[^>]*>/g, " ").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
  const SafetyAssessment = (await vite.ssrLoadModule("/src/features/intelligence/SafetyAssessment.jsx")).default;
  const { mapSafety } = await vite.ssrLoadModule("/src/features/intelligence/safetyMapping.js");
  const { describeRecurrence } = await vite.ssrLoadModule("/src/features/assistant/recurrencePresentation.js");
  const { describeContext } = await vite.ssrLoadModule("/src/features/assistant/assistantMapping.js");
  const renderSafety = (s) => text(renderToStaticMarkup(h(SafetyAssessment, { safety: mapSafety(s) })));
  const apiSafety = (await api(adm, "GET", `/intelligence/${refusalA.an.data._id}?workspaceId=${A}`)).data.safety;
  const apiSafetyHaz = (await api(adm, "GET", `/intelligence/${L3.an.data._id}?workspaceId=${A}`)).data.safety;
  const tNormal = renderSafety(apiSafety); const tHaz = renderSafety(apiSafetyHaz); const tPlain = renderSafety({ state: "NORMAL", urgency: "prompt", recommendedActionType: "maintenance_dispatch" });
  check("G1 the page states the EXISTING refusal restriction from the server's stored rule code: for a refusal without hazard 'maintenance dispatch and inspection (which need entry) are not permitted'; for hazard + refusal 'the only permitted action type is escalation' (with the hazard alert and flags); nothing is shown when the server sent no rule; no procedure, contact, role or deadline appears",
    /Access was refused in this report\. Under the safety rules, maintenance dispatch and inspection \(which need entry\) are not permitted\./.test(tNormal) && !/LIFE-SAFETY/.test(tNormal) && /Access was refused in this report\. Under the safety rules, the only permitted action type is escalation\./.test(tHaz) && /LIFE-SAFETY HAZARD/.test(tHaz) && !/refused/i.test(tPlain) && !/\b(call|contact|notify|within|minutes?|supervisor|manager|emergency services|evacuat)\w*/i.test(tNormal + tHaz));
  check("G2 mapSafety carries the rule codes unchanged and leaves the old shape untouched when none were sent (no key at all)", JSON.stringify(mapSafety({ state: "NORMAL", urgency: "prompt" })) === JSON.stringify({ state: "NORMAL", urgency: "prompt", recommendedActionType: null }) && mapSafety({ state: "NORMAL", rules: ["ACCESS_REFUSED", 3, ""] }).rules.join() === "ACCESS_REFUSED");
  const dr = describeRecurrence(forAdmin.recurrence); const drOp = describeRecurrence(forOperator.recurrence);
  const said = dr ? [dr.headline, ...dr.lines, dr.caveat].join(" ") : "";
  check("G3 the repeat note states ONLY a record match: the kind of problem, the earlier report's date, what a person recorded (for a role that may read Outcomes) and the caveat 'a match between records only'; it never claims a cause, 'always', a best action, a policy or Learning",
    Boolean(dr) && /air conditioner · temperature fault · not cooling/.test(said) && /earlier report about the same kind of problem .* is on record for this room/.test(said) && /What a person recorded for the earlier report of .*: Success\. Breaker reset/.test(said) && /match between records only/.test(said) && !/because|caus|always|usually|proven|best|should|recommend|learn|policy|standard/i.test(said) && Boolean(drOp) && !/What a person recorded/.test([drOp.headline, ...drOp.lines].join(" ")));
  check("G4 nothing is stated when the server found no recurrence, an unknown value, or an answer this view does not recognise", describeRecurrence(c3.recurrence) === null && describeRecurrence(null) === null && describeRecurrence({ detected: true, matches: [{ issue: { equipment: "made_up", problem: "water_leak" } }] }) === null && describeRecurrence({ detected: true, matches: [] }) === null);
  const viewC = describeContext({ context: { ...forAdmin, history: { signals: [] } }, contextStatus: "ready", intelligence: null });
  check("G5 the case card describes the context with the repeat note under 'Earlier reports' and without any id or implementation detail", Boolean(viewC.recurrence) && !/[0-9a-f]{24}/.test(JSON.stringify(viewC.recurrence)) && /recurrence/.test(read(path.join(FRONTEND, "src", "features", "assistant", "SignalCaseCard.jsx"))) && !/recurrenceMatch|signalId/.test(JSON.stringify(viewC.recurrence)));
  const lintGuard = ["safetyMapping.js", "safetyPresentation.js"].map((f) => read(path.join(FRONTEND, "src", "features", "intelligence", f))).join("") + read(path.join(FRONTEND, "src", "features", "assistant", "recurrencePresentation.js"));
  check("G6 the page adds no safety logic of its own: exact-match on the server's rule code, no keyword test over report text, no fetch, no localStorage; and the L1.3 field-name guard still holds (the frontend names no structured-issue field outside the one mapping boundary)", !/\.test\(|RegExp|match\(|localStorage|fetch\(/.test(lintGuard.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")) && !/problemFamily|SERVER_DERIVED|structuredIssue/.test(read(path.join(FRONTEND, "src", "features", "assistant", "recurrencePresentation.js"))));
} catch (error) {
  failed += 1;
  console.error("FAIL  suite crashed -", error?.stack ?? error);
} finally {
  for (const c of children) kill(c);
  try { await vite.close(); } catch { /* best effort */ }
  try { await mongoose.connection.dropDatabase(); } catch { /* best effort */ }
  try { await mongoose.disconnect(); } catch { /* best effort */ }
}
console.log(`\nSafety posture + context quality hardening validation: ${passed} passed, ${failed} failed (isolated database ${DB_NAME} dropped; no Gemini call; no external network)`);
process.exit(failed === 0 ? 0 : 1);
