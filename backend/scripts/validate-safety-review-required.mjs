/**
 * SAFETY_REVIEW_REQUIRED (owner-approved Option C of EOI_VAGUE_HAZARD_POLICY_DECISION.md). LOCAL ONLY: an isolated database (dropped), the DETERMINISTIC test AI service behind a scripted
 * loopback proxy (zero Gemini calls, zero external network), spawned backends, the real frontend modules through Vite SSR. Nothing here touches a prompt, the model, a timeout, retrieval
 * or Learning; it proves the one new server-derived state and that it adds no restriction beyond the existing ones.
 *
 *   A  the policy itself (pure): the closed five-phrase cue list, normalisation, precedence, the opt-in, and that Learning's inputs are unchanged
 *   B  the real backend: classification, persistence, Decision / Action behaviour (nothing new is restricted), legacy records, reload, tenancy, spoofing, audit
 *   C  AI in progress / failed: the classification stays available and ACCESS_REFUSED stays enforced
 *   D  the five full-lifecycle scenarios (A-E of the task)
 *   E  the page: calm wording, no alarm, hazard / refusal presentation unchanged
 *   F  boundaries: no prompt / AI-service / Learning / timeout change
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
const DB_NAME = `koi_srr_${Date.now()}`;
process.env.MONGODB_URI = `mongodb://127.0.0.1:27017/${DB_NAME}`; // isolated local database; never Atlas
const { createActor, tokenFor, bearer } = await import("./lib/authFixtures.mjs");
for (const k of ["KOI_LEARNING_CONTEXT_ENABLED", "KOI_ANALYSIS_RESPONSE_WINDOW_MS", "KOI_AI_ANALYSIS_TIMEOUT_MS", "KOI_AI_TIMEOUT_MS", "KOI_SOCKET_TIMEOUT_MS"]) delete process.env[k];
const mongoose = (await import("mongoose")).default;
const { connectDatabase } = await import("../src/config/database.js");
const M = await import("../src/models/index.js");
const { SAFETY_RULE_CODES, SAFETY_STATES } = await import("../src/models/Intelligence.js");
const { deriveSafetyPolicy, SAFETY_REVIEW_REQUIRED } = await import("../src/services/ai/safetyPolicy.js");
const { profileOfSignal, normalizeCompletedCase, REJECTION } = await import("../src/services/learning/completedCase.js");

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
  // ============================================================================================================ A. the policy (pure)
  const pol = (description, { review = true, severity = "medium", title = "Report" } = {}) => deriveSafetyPolicy({ signal: { title, description, severity } }, review ? { includeReviewRequired: true } : undefined);
  const CUES = ["suspected hazardous condition", "possible hazardous condition", "potentially hazardous condition", "suspected danger", "possible danger"];
  const ordinary = pol("The television remote is not working.");
  check("A1 [1] an ordinary report is NORMAL with no rule", ordinary.state === "NORMAL" && ordinary.rules.length === 0 && ordinary.minimumUrgency === null && ordinary.requiredActionTypes === null && ordinary.forbiddenActionTypes.length === 0);
  const cueStates = CUES.map((c) => pol(`The guest reports a ${c} in the bathroom.`));
  check("A2 [2-6] each of the FIVE approved phrases alone gives SAFETY_REVIEW_REQUIRED with the single rule SAFETY_REVIEW_REQUIRED", cueStates.every((p) => p.state === "SAFETY_REVIEW_REQUIRED" && p.rules.join() === "SAFETY_REVIEW_REQUIRED"), cueStates.map((p) => p.state).join());
  check("A3 the state requires and forbids NOTHING: no minimum urgency, no required action type, no forbidden action type (human review is the control, not a new restriction)", cueStates.every((p) => p.minimumUrgency === null && p.requiredActionTypes === null && p.forbiddenActionTypes.length === 0));
  const variants = ["SUSPECTED HAZARDOUS CONDITION", "Suspected   Hazardous   Condition", "suspected\thazardous condition", "Possible-Danger", "possible danger!", "(possible danger)", "\"Suspected Danger\"", "Potentially hazardous condition.", "possible danger", "possible‑danger"];
  check("A4 [7, 8] case, extra whitespace, a hyphen between the words and surrounding punctuation do not change the result", variants.every((v) => pol(`Guest note: ${v} reported`).state === "SAFETY_REVIEW_REQUIRED"), variants.filter((v) => pol(`Guest note: ${v} reported`).state !== "SAFETY_REVIEW_REQUIRED").join(" | "));
  const NOT_CUES = ["The balcony step is dangerous.", "a dangerous situation", "possible dangers on the stairs", "suspected hazardous conditions", "unsuspected danger", "possibly dangerous", "danger", "hazardous", "the condition is hazardous", "suspected. Hazardous condition", "possible; danger", "suspect danger", "potentially dangerous", "suspected hazard", "possible hazardous", "very dangerous wiring", "sparks from the socket", "burning smell", "exposed wiring"];
  check("A5 [9] anything that is not exactly an approved phrase is NOT a cue: 'dangerous', plurals, other stems, other word orders, a sentence boundary between the words, and the vocabulary the policy refuses to add (sparks, burning smell, exposed wiring)", NOT_CUES.every((v) => pol(v).state === "NORMAL"), NOT_CUES.filter((v) => pol(v).state !== "NORMAL").join(" | "));
  const hz = { gas: pol("A strong gas smell in the room."), smoke: pol("Smoke is coming from the vent."), fire: pol("A small fire started in the kitchenette."), co: pol("The carbon monoxide alarm is sounding.") };
  check("A6 [10-13] gas smell, smoke, fire and carbon monoxide are LIFE_SAFETY_HAZARD exactly as before (immediate; escalation or dispatch)", Object.values(hz).every((p) => p.state === "LIFE_SAFETY_HAZARD" && p.minimumUrgency === "immediate" && p.requiredActionTypes.join() === "escalation,maintenance_dispatch" && p.rules.join() === "LIFE_SAFETY_HAZARD"));
  const refusalOnly = pol("The AC is not cooling and the guest refuses entry.");
  check("A7 [14] access refusal alone is NOT a hazard and NOT SAFETY_REVIEW_REQUIRED (state NORMAL, rule ACCESS_REFUSED only)", refusalOnly.state === "NORMAL" && refusalOnly.rules.join() === "ACCESS_REFUSED" && refusalOnly.forbiddenActionTypes.join() === "maintenance_dispatch,inspection");
  const refusalCue = pol("The guest refuses entry and there is a suspected hazardous condition.");
  check("A8 [15] access refusal + a cue is SAFETY_REVIEW_REQUIRED + ACCESS_REFUSED (independent rules); the existing refusal restriction is unchanged; nothing is required", refusalCue.state === "SAFETY_REVIEW_REQUIRED" && refusalCue.rules.join() === "SAFETY_REVIEW_REQUIRED,ACCESS_REFUSED" && refusalCue.forbiddenActionTypes.join() === "maintenance_dispatch,inspection" && refusalCue.requiredActionTypes === null && refusalCue.minimumUrgency === null);
  const hazCue = pol("A gas smell and a possible danger in the room.");
  const hazCueAlone = pol("A gas smell in the room.");
  check("A9 [16] a confirmed hazard + a cue stays LIFE_SAFETY_HAZARD, never downgraded, and records no review rule beside it; the result is identical to the hazard without the cue", hazCue.state === "LIFE_SAFETY_HAZARD" && hazCue.rules.join() === "LIFE_SAFETY_HAZARD" && JSON.stringify(hazCue) === JSON.stringify(hazCueAlone));
  const hazRefCue = pol("Gas smell, the guest refuses entry, and there is a suspected danger.");
  const hazRef = pol("Gas smell and the guest refuses entry.");
  check("A10 [17] hazard + refusal (+ a cue) keeps the existing posture exactly: escalation only, dispatch / inspection forbidden, immediate", hazRefCue.state === "LIFE_SAFETY_HAZARD" && hazRefCue.requiredActionTypes.join() === "escalation" && hazRefCue.forbiddenActionTypes.join() === "maintenance_dispatch,inspection" && hazRefCue.minimumUrgency === "immediate" && JSON.stringify(hazRefCue) === JSON.stringify(hazRef));
  const critCue = pol("The guest reports a suspected danger.", { severity: "critical" });
  const critOnly = pol("Guest locked out of the room.", { severity: "critical" });
  check("A11 CRITICAL (Signal severity) is not repurposed and not replaced: severity critical + a cue stays CRITICAL with the same requirements as CRITICAL alone; the cue is merely recorded as a rule", critCue.state === "CRITICAL" && critOnly.state === "CRITICAL" && critCue.minimumUrgency === critOnly.minimumUrgency && critCue.requiredActionTypes === critOnly.requiredActionTypes && critCue.rules.join() === "SEVERITY_CRITICAL,SAFETY_REVIEW_REQUIRED" && critOnly.rules.join() === "SEVERITY_CRITICAL");
  const noOptIn = pol("The guest reports a suspected hazardous condition.", { review: false });
  check("A12 OPT-IN: a caller that does not ask (Learning, structured intake, the older scripts) gets the three-state result it always had - the cue is invisible to it", noOptIn.state === "NORMAL" && noOptIn.rules.length === 0 && deriveSafetyPolicy({ signal: { title: "x", description: "suspected danger", severity: "medium" } }).state === "NORMAL");
  check("A13 the persisted state / rule vocabularies are the policy's own outputs: four states, four rule codes, in a fixed order", JSON.stringify(SAFETY_STATES) === JSON.stringify(["NORMAL", "CRITICAL", "SAFETY_REVIEW_REQUIRED", "LIFE_SAFETY_HAZARD"]) && SAFETY_STATES.includes(SAFETY_REVIEW_REQUIRED) && JSON.stringify(SAFETY_RULE_CODES) === JSON.stringify(["SEVERITY_CRITICAL", "LIFE_SAFETY_HAZARD", "ACCESS_REFUSED", "SAFETY_REVIEW_REQUIRED"]));
  const policySrc = read(path.join(BACKEND, "src", "services", "ai", "safetyPolicy.js"));
  check("A14 the cue list is closed and deterministic: exactly five phrases in one anchored pattern, no model / history / Learning / network input, and the existing hazard and refusal lists are present and untouched", /REVIEW_CUE_PATTERN = new RegExp/.test(policySrc) && (policySrc.match(/suspected\|possible\|potentially|suspected\|possible/g) ?? []).length === 2 && /HAZARD_PATTERNS = Object\.freeze/.test(policySrc) && /ACCESS_REFUSAL_PATTERN/.test(policySrc) && !/fetch\(|require\(|gemini|embedding|learning/i.test(policySrc.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")));
  check("A15 Learning's inputs are unchanged: a Signal with a cue gets the SAME three-state profile as before (NORMAL, no review rule), because Learning never opts in; and no Learning source names the new state, the rule or the option", profileOfSignal({ title: "Report", description: "The guest reports a suspected hazardous condition.", severity: "medium" }, null).safety.state === "NORMAL" && profileOfSignal({ title: "Report", description: "suspected danger", severity: "medium" }, null).safety.rules.length === 0
    && fs.readdirSync(path.join(BACKEND, "src", "services", "learning")).filter((f) => f.endsWith(".js")).every((f) => !/SAFETY_REVIEW_REQUIRED|includeReviewRequired/.test(read(path.join(BACKEND, "src", "services", "learning", f)))) && !/SAFETY_REVIEW_REQUIRED|includeReviewRequired/.test(read(path.join(BACKEND, "src", "services", "structuredIssue.js"))));

  // ============================================================================================================ the rig: deterministic AI service behind a scripted proxy + real backends
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
  const startBackend = async (port, extra = {}) => {
    const c = spawn(process.execPath, [path.join(BACKEND, "server.js")], { env: { ...process.env, PORT: String(port), LLM_PROVIDER: "test-python", AI_SERVICE_URL: `http://127.0.0.1:${PROXY_PORT}`, KOI_RATE_LIMIT_ENABLED: "false", CLIENT_URL: "http://localhost:5199", ...extra }, stdio: "ignore" });
    children.push(c); const base = `http://localhost:${port}/api`;
    for (let i = 0; i < 160; i += 1) { try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* starting */ } await sleep(250); }
    return base;
  };
  const BASE = await startBackend(5470);
  const BASE_SHORT = await startBackend(5471, { KOI_ANALYSIS_RESPONSE_WINDOW_MS: "1200" });

  const wsA = await M.Workspace.create({ name: "SRR a", slug: `srr-a-${Date.now()}`, status: "active" });
  const wsB = await M.Workspace.create({ name: "SRR b", slug: `srr-b-${Date.now()}`, status: "active" });
  const A = String(wsA._id); const B = String(wsB._id);
  const op = await createActor({ role: "operator", workspaceId: wsA._id, label: "srr-op" });
  const rev = await createActor({ role: "reviewer", workspaceId: wsA._id, label: "srr-rev" });
  const adm = await createActor({ role: "admin", workspaceId: wsA._id, label: "srr-adm" });
  const viewer = await createActor({ role: "viewer", workspaceId: wsA._id, label: "srr-view" });
  const admB = await createActor({ role: "admin", workspaceId: wsB._id, label: "srr-admb" });
  const api = async (who, method, url, body, base = BASE) => {
    const res = await fetch(`${base}${url}`, { method, headers: { ...bearer(tokenFor(who.user)), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await res.text(); let json = null; try { json = JSON.parse(t); } catch { /* none */ }
    return { status: res.status, json, data: json?.data, code: json?.details?.code, raw: t };
  };
  const prop = await M.Property.create({ workspaceId: wsA._id, name: "SRR Residence", code: "SRRA", timezone: "UTC" });
  for (const room of ["204", "312", "118", "151", "161", "165"]) {
    const unit = await M.Unit.create({ propertyId: prop._id, unitNumber: room, status: "occupied" });
    const guest = await M.Guest.create({ workspaceId: wsA._id, firstName: "Synthfirst", lastName: `Synthlast${room}`, email: `s${room}@example.invalid` });
    await M.Stay.create({ workspaceId: wsA._id, guestId: guest._id, propertyId: prop._id, unitId: unit._id, status: "checked_in", checkIn: new Date(Date.now() - 86400000), checkOut: new Date(Date.now() + 3 * 86400000) });
  }
  const intake = async (text, base = BASE, who = op) => { const r = await api(who, "POST", "/conversations/intake", { workspaceId: A, content: text }, base); await sleep(15); return r.data?.signal; };
  const analyse = async (text, body) => { const sg = await intake(text); const an = await api(op, "POST", `/intelligence/analyze/${sg._id}?workspaceId=${A}`, body); return { sg, an, safety: an.data?.safety }; };
  const analyseAndApprove = async (text) => { const x = await analyse(text); const dec = await api(op, "POST", `/decisions/propose/${x.an.data?._id}?workspaceId=${A}`); await api(rev, "POST", `/decisions/${dec.data?._id}/approve?workspaceId=${A}`, {}); return { ...x, dec }; };
  const propose = async (x, type) => api(op, "POST", `/actions/propose/${x.dec.data?._id}?workspaceId=${A}`, type ? { actionType: type } : undefined);

  // ============================================================================================================ B. classification, persistence, behaviour
  const ord = await analyse("Room 312: the television remote is not working.");
  check("B1 [1] ordinary report, real pipeline: stored NORMAL, no rules", ord.an.status === 201 && ord.safety.state === "NORMAL" && ord.safety.rules === undefined, JSON.stringify(ord.safety));
  const cueTexts = CUES.map((c, i) => `Room 151: the guest reports a ${c} near the wardrobe (note ${i}).`);
  const cueRuns = []; for (const t of cueTexts) cueRuns.push(await analyse(t));
  check("B2 [2-6] each approved phrase, real pipeline: stored SAFETY_REVIEW_REQUIRED with the rule SAFETY_REVIEW_REQUIRED; the assessment is generated; no hazard claim", cueRuns.every((x) => x.an.status === 201 && x.safety.state === "SAFETY_REVIEW_REQUIRED" && x.safety.rules.join() === "SAFETY_REVIEW_REQUIRED"), cueRuns.map((x) => x.safety?.state).join());
  const stored = await M.Intelligence.findOne({ _id: cueRuns[0].an.data._id }).lean();
  const adminRec = await M.AnalysisAdmission.findOne({ workspaceId: wsA._id, signalId: cueRuns[0].sg._id }).lean();
  check("B3 the SERVER wrote it: the model document and the admission audit both carry the state and the rule; the audit holds codes only - no Signal text", stored.safety.state === "SAFETY_REVIEW_REQUIRED" && stored.safety.rules.join() === "SAFETY_REVIEW_REQUIRED" && adminRec?.safetyState === "SAFETY_REVIEW_REQUIRED" && adminRec.safetyRules.join() === "SAFETY_REVIEW_REQUIRED" && !/suspected|hazardous|wardrobe|danger/i.test(JSON.stringify(adminRec)), JSON.stringify(adminRec)?.slice(0, 200));
  const variantRuns = []; for (const [i, v] of ["SUSPECTED   HAZARDOUS CONDITION", "Possible-Danger!"].entries()) variantRuns.push(await analyse(`Room 151: the guest says: ${v} in the closet (variant ${i}).`));
  check("B4 [7, 8] case / whitespace / punctuation variants give the same stored result through the real pipeline", variantRuns.every((x) => x.safety?.state === "SAFETY_REVIEW_REQUIRED"));
  const dang = await analyse("Room 151: the guest says the loose balcony step is dangerous.");
  check("B5 [9] arbitrary 'dangerous' wording is NOT SAFETY_REVIEW_REQUIRED (stored NORMAL)", dang.safety?.state === "NORMAL" && dang.safety.rules === undefined);
  const hzRuns = {}; for (const [k, t] of Object.entries({ gas: "Room 161: there is a strong gas smell in the room.", smoke: "Room 161: smoke is coming from the vent.", fire: "Room 161: a small fire started in the kitchenette.", co: "Room 161: the carbon monoxide alarm is sounding in the hallway." })) hzRuns[k] = await analyse(t);
  check("B6 [10-13] gas smell, smoke, fire and CO through the real pipeline: LIFE_SAFETY_HAZARD with rule LIFE_SAFETY_HAZARD only (existing behaviour)", Object.values(hzRuns).every((x) => x.safety?.state === "LIFE_SAFETY_HAZARD" && x.safety.rules.join() === "LIFE_SAFETY_HAZARD"), Object.values(hzRuns).map((x) => x.safety?.state).join());
  const refOnly = await analyseAndApprove("Room 118: the AC is not cooling and the guest refuses entry.");
  check("B7 [14] access refusal alone: stored NORMAL + ACCESS_REFUSED, never SAFETY_REVIEW_REQUIRED, never a hazard", refOnly.safety.state === "NORMAL" && refOnly.safety.rules.join() === "ACCESS_REFUSED");
  const refCue = await analyseAndApprove("Room 118: the AC is not cooling, the guest refuses entry, and there is a suspected hazardous condition.");
  check("B8 [15] refusal + cue: stored SAFETY_REVIEW_REQUIRED with BOTH rules", refCue.safety.state === "SAFETY_REVIEW_REQUIRED" && refCue.safety.rules.includes("ACCESS_REFUSED") && refCue.safety.rules.includes("SAFETY_REVIEW_REQUIRED"), JSON.stringify(refCue.safety));
  const hazCueRun = await analyse("Room 161: gas smell and a possible danger in the room.");
  check("B9 [16] hazard + cue through the real pipeline: stays LIFE_SAFETY_HAZARD with only the hazard rule", hazCueRun.safety.state === "LIFE_SAFETY_HAZARD" && hazCueRun.safety.rules.join() === "LIFE_SAFETY_HAZARD");
  const d = (x) => x.r.status;
  const trial = async (text, type) => { const x = await analyseAndApprove(text); return { x, r: await propose(x, type) }; };
  const rDispatch = await trial("Room 118: the AC is not cooling, the guest refuses entry, and there is a possible danger (dispatch try).", "maintenance_dispatch");
  const rInspect = await trial("Room 118: the AC is not cooling, the guest refuses access, and there is a suspected danger (inspection try).", "inspection");
  const rComm = await trial("Room 118: the AC is not cooling, the guest declines staff entry, and there is a possible danger (communication try).", "guest_communication");
  const rEsc = await trial("Room 118: the AC is not cooling, the guest denies maintenance access, and there is a suspected danger (escalation try).", "escalation");
  const rDefault = await trial("Room 118: the AC is not cooling, the guest will not allow staff to enter, and there is a possible danger (default try).");
  check("B10 [18, 19] dispatch and inspection under ACCESS_REFUSED are refused exactly as before (409 ACTION_TYPE_CONFLICTS_WITH_SAFETY), also when SAFETY_REVIEW_REQUIRED is present", d(rDispatch) === 409 && rDispatch.r.code === "ACTION_TYPE_CONFLICTS_WITH_SAFETY" && d(rInspect) === 409 && rInspect.r.code === "ACTION_TYPE_CONFLICTS_WITH_SAFETY" && rDispatch.x.safety.state === "SAFETY_REVIEW_REQUIRED");
  check("B11 [20] guest_communication under ACCESS_REFUSED is unchanged (201); escalation is ALLOWED but not forced (201 as requested, and the default Action is not escalation)", d(rComm) === 201 && rComm.r.data.actionType === "guest_communication" && d(rEsc) === 201 && rEsc.r.data.actionType === "escalation" && d(rDefault) === 201 && rDefault.r.data.actionType !== "escalation", `${d(rComm)} ${d(rEsc)} ${d(rDefault)} ${rDefault.r.data?.actionType}`);
  check("B12 NO new restriction for the state itself: with NO refusal, dispatch and inspection are accepted; the Action risk is NOT raised to critical/high; the Decision priority is NOT forced to critical; rejecting the Decision needs no reason", await (async () => {
    const a = await trial("Room 204: the guest reports a suspected hazardous condition near the desk (dispatch try).", "maintenance_dispatch");
    const b = await trial("Room 204: the guest reports a possible danger near the desk (inspection try).", "inspection");
    const c = await analyse("Room 204: the guest reports a potentially hazardous condition near the desk (reject try).");
    const dec = await api(op, "POST", `/decisions/propose/${c.an.data._id}?workspaceId=${A}`); const rj = await api(rev, "POST", `/decisions/${dec.data._id}/reject?workspaceId=${A}`, {});
    return a.x.safety.state === "SAFETY_REVIEW_REQUIRED" && d(a) === 201 && a.r.data.actionType === "maintenance_dispatch" && !["critical", "high"].includes(a.r.data.riskLevel) && d(b) === 201 && b.r.data.actionType === "inspection" && a.x.dec.data.priority !== "critical" && rj.status === 200 && rj.data?.status === "rejected";
  })());
  const hrDisp = await trial("Room 161: gas smell, the guest refuses entry, and there is a suspected danger (dispatch try).", "maintenance_dispatch");
  const hrEsc = await trial("Room 161: gas smell, the guest refuses entry, and there is a possible danger (escalation try).", "escalation");
  check("B13 [17] confirmed hazard + refusal (+ cue): the existing escalation-only posture is unchanged - dispatch 409, escalation 201, risk critical", hrDisp.x.safety.state === "LIFE_SAFETY_HAZARD" && d(hrDisp) === 409 && d(hrEsc) === 201 && hrEsc.r.data.actionType === "escalation" && hrEsc.r.data.riskLevel === "critical");
  const legacyRun = await analyse("Room 151: the guest reports a suspected danger behind the bed (legacy try).");
  await M.Intelligence.updateOne({ _id: legacyRun.an.data._id }, { $set: { "safety.state": "NORMAL" }, $unset: { "safety.rules": "" } }); // a record stored before this state existed
  const legacyView = await api(adm, "GET", `/intelligence/${legacyRun.an.data._id}?workspaceId=${A}`);
  const reAnalysed = await api(op, "POST", `/intelligence/analyze/${legacyRun.sg._id}?workspaceId=${A}`);
  const legacyAfter = await M.Intelligence.findOne({ _id: legacyRun.an.data._id }).lean();
  const legacyAction = await (async () => { const dec = await api(op, "POST", `/decisions/propose/${legacyRun.an.data._id}?workspaceId=${A}`); await api(rev, "POST", `/decisions/${dec.data._id}/approve?workspaceId=${A}`, {}); return api(op, "POST", `/actions/propose/${dec.data._id}?workspaceId=${A}`); })();
  check("B14 [21] a historical record keeps the state it was stored with: it reads back NORMAL with no rules, re-analysing returns the SAME record unchanged (nothing is rewritten or backfilled), and its Decision / Action behave as before", legacyView.data.safety.state === "NORMAL" && legacyView.data.safety.rules === undefined && reAnalysed.status === 200 && reAnalysed.data._id === legacyRun.an.data._id && legacyAfter.safety.state === "NORMAL" && legacyAfter.safety.rules === undefined && legacyAction.status === 201);
  const callsBefore = proxy.analyzeCalls; const intelCount = await M.Intelligence.countDocuments({});
  const reload1 = await api(adm, "GET", `/intelligence/${cueRuns[0].an.data._id}?workspaceId=${A}`); const reload2 = await api(op, "POST", `/intelligence/analyze/${cueRuns[0].sg._id}?workspaceId=${A}`);
  check("B15 [22] reload / API read / re-entry: the stored state and rule read back unchanged, re-analysing returns the existing record (200, same id), NO second analysis, NO provider call, NO new record", reload1.data.safety.state === "SAFETY_REVIEW_REQUIRED" && reload1.data.safety.rules.join() === "SAFETY_REVIEW_REQUIRED" && reload2.status === 200 && reload2.data._id === cueRuns[0].an.data._id && proxy.analyzeCalls === callsBefore && (await M.Intelligence.countDocuments({})) === intelCount);
  const foreignRead = await api(admB, "GET", `/intelligence/${cueRuns[0].an.data._id}?workspaceId=${B}`);
  const foreignAnalyse = await api(admB, "POST", `/intelligence/analyze/${cueRuns[0].sg._id}?workspaceId=${B}`);
  const foreignAsA = await api(admB, "GET", `/intelligence/${cueRuns[0].an.data._id}?workspaceId=${A}`);
  check("B16 [25] cross-workspace: another workspace cannot read the record, analyse the Signal, or name this workspace - and no safety state leaks in any response", [foreignRead, foreignAnalyse, foreignAsA].every((r) => r.status >= 400 && !/SAFETY_REVIEW_REQUIRED|safety/.test(r.raw)), [foreignRead.status, foreignAnalyse.status, foreignAsA.status].join());
  const viewerAnalyse = await api(viewer, "POST", `/intelligence/analyze/${cueRuns[1].sg._id}?workspaceId=${A}`); const viewerRead = await api(viewer, "GET", `/intelligence/${cueRuns[1].an.data._id}?workspaceId=${A}`);
  check("B17 role permissions are unchanged: a viewer cannot start an analysis (403) and, as before, cannot read an analysis made at a higher visibility level (404 - fail closed, no safety state in the response)", viewerAnalyse.status === 403 && viewerRead.status === 404 && !/SAFETY_REVIEW_REQUIRED|"safety"/.test(viewerRead.raw), `analyse ${viewerAnalyse.status} read ${viewerRead.status} ${viewerRead.raw?.slice(0, 120)}`);
  const spoofOrd = await analyse("Room 312: the television remote battery is dead (spoof try).", { safety: { state: "SAFETY_REVIEW_REQUIRED", rules: ["SAFETY_REVIEW_REQUIRED", "ACCESS_REFUSED"] }, safetyState: "SAFETY_REVIEW_REQUIRED", safetyRules: ["ACCESS_REFUSED"], rules: ["LIFE_SAFETY_HAZARD"], state: "LIFE_SAFETY_HAZARD", urgency: "immediate" });
  const spoofCue = await analyse("Room 151: the guest reports a suspected danger under the sink (spoof try).", { safety: { state: "NORMAL", rules: [] }, safetyState: "NORMAL", state: "NORMAL" });
  const patchTry = await api(adm, "PATCH", `/intelligence/${spoofCue.an.data._id}?workspaceId=${A}`, { safety: { state: "NORMAL" } }); const postTry = await api(adm, "POST", `/intelligence?workspaceId=${A}`, { workspaceId: A, safety: { state: "SAFETY_REVIEW_REQUIRED" } });
  const spoofCueAfter = await M.Intelligence.findOne({ _id: spoofCue.an.data._id }).lean();
  check("B18 [26] a client-supplied state / rule codes are ignored: an ordinary Signal stays NORMAL with no rules whatever the body says; a cue Signal stays SAFETY_REVIEW_REQUIRED whatever the body says; there is no HTTP route that creates or patches Intelligence", spoofOrd.safety.state === "NORMAL" && spoofOrd.safety.rules === undefined && spoofCue.safety.state === "SAFETY_REVIEW_REQUIRED" && [404, 405].includes(patchTry.status) && [404, 405].includes(postTry.status) && spoofCueAfter.safety.state === "SAFETY_REVIEW_REQUIRED", `${spoofOrd.safety?.state} ${spoofCue.safety?.state} ${patchTry.status} ${postTry.status}`);
  check("B19 Learning stayed OFF: the flag is unset and no admission used Learning", process.env.KOI_LEARNING_CONTEXT_ENABLED === undefined && (await M.AnalysisAdmission.countDocuments({ learningUsed: true })) === 0);
  const bogus = new M.Intelligence({ workspaceId: wsA._id, safety: { state: "SAFETY_REVIEW", rules: ["BOGUS"] } });
  check("B20 the model enum stays closed: an unknown state or rule code is a validation error", Boolean(bogus.validateSync()?.errors?.["safety.state"]) && Boolean(bogus.validateSync()?.errors?.["safety.rules.0"]));

  // ============================================================================================================ C. AI in progress / failed
  const cueSig = await intake("Room 165: the guest refuses entry to the room, and there is a suspected hazardous condition.", BASE_SHORT);
  const issueBefore = (await api(op, "GET", `/signals/${cueSig._id}?workspaceId=${A}`, undefined, BASE_SHORT)).data;
  proxy.analyzeCalls = 0; proxy.script = [{ delay: 3500 }];
  const inProg = await api(op, "POST", `/intelligence/analyze/${cueSig._id}?workspaceId=${A}`, undefined, BASE_SHORT);
  const stDuring = (await api(op, "GET", `/intelligence/analysis-status/${cueSig._id}?workspaceId=${A}`, undefined, BASE_SHORT)).data;
  const sigDuring = (await api(op, "GET", `/signals/${cueSig._id}?workspaceId=${A}`, undefined, BASE_SHORT)).data;
  const polDuring = deriveSafetyPolicy({ signal: { title: sigDuring.title, description: sigDuring.description, severity: sigDuring.severity } }, { includeReviewRequired: true });
  check("C1 [24] AI IN PROGRESS: 202 / in_progress; the Signal and its server-derived classification are unchanged; the deterministic policy still gives SAFETY_REVIEW_REQUIRED + ACCESS_REFUSED from the Signal alone; no Decision / Action exists", inProg.status === 202 && stDuring?.status === "in_progress" && JSON.stringify(sigDuring.issue) === JSON.stringify(issueBefore.issue) && polDuring.state === "SAFETY_REVIEW_REQUIRED" && polDuring.rules.includes("ACCESS_REFUSED") && (await M.Decision.countDocuments({ signalId: cueSig._id })) === 0 && (await M.Action.countDocuments({ signalId: cueSig._id })) === 0);
  await waitFor(async () => (await api(op, "GET", `/intelligence/analysis-status/${cueSig._id}?workspaceId=${A}`, undefined, BASE_SHORT)).data?.status === "succeeded", 30000, 400);
  const cueStored = await M.Intelligence.findOne({ signalIds: cueSig._id }).lean();
  check("C2 once the same attempt succeeds the stored result carries SAFETY_REVIEW_REQUIRED + ACCESS_REFUSED and exactly ONE provider call was made (in-progress did not erase or recompute it)", cueStored?.safety?.state === "SAFETY_REVIEW_REQUIRED" && cueStored.safety.rules.includes("ACCESS_REFUSED") && cueStored.safety.rules.includes("SAFETY_REVIEW_REQUIRED") && proxy.analyzeCalls === 1);
  const failSig = await intake("Room 165: the guest declines staff entry, and there is a possible danger.", BASE_SHORT);
  proxy.analyzeCalls = 0; proxy.script = [{ delay: 2500, status: 503, code: "PROVIDER_UNAVAILABLE" }];
  await api(op, "POST", `/intelligence/analyze/${failSig._id}?workspaceId=${A}`, undefined, BASE_SHORT);
  const failedSt = await waitFor(async () => { const s = (await api(op, "GET", `/intelligence/analysis-status/${failSig._id}?workspaceId=${A}`, undefined, BASE_SHORT)).data; return s?.status === "failed" ? s : null; }, 30000, 400);
  const failSigAfter = (await api(op, "GET", `/signals/${failSig._id}?workspaceId=${A}`, undefined, BASE_SHORT)).data;
  check("C3 [23] AI FAILED: terminal 'failed', one provider call, nothing stored, no Decision / Action; the Signal is unchanged and the deterministic policy still says SAFETY_REVIEW_REQUIRED + ACCESS_REFUSED", Boolean(failedSt) && proxy.analyzeCalls === 1 && (await M.Intelligence.countDocuments({ signalIds: failSig._id })) === 0 && (await M.Decision.countDocuments({ signalId: failSig._id })) === 0 && deriveSafetyPolicy({ signal: { title: failSigAfter.title, description: failSigAfter.description, severity: failSigAfter.severity } }, { includeReviewRequired: true }).state === "SAFETY_REVIEW_REQUIRED");
  const retry = await api(op, "POST", `/intelligence/analyze/${failSig._id}?workspaceId=${A}`, undefined, BASE_SHORT);
  const retryDec = await api(op, "POST", `/decisions/propose/${retry.data?._id}?workspaceId=${A}`); await api(rev, "POST", `/decisions/${retryDec.data?._id}/approve?workspaceId=${A}`, {});
  const retryDispatch = await api(op, "POST", `/actions/propose/${retryDec.data?._id}?workspaceId=${A}`, { actionType: "maintenance_dispatch" });
  check("C4 the operator's explicit retry succeeds with the classification intact (SAFETY_REVIEW_REQUIRED + ACCESS_REFUSED), and ACCESS_REFUSED is still enforced afterwards (dispatch 409)", retry.status === 201 && retry.data.safety.state === "SAFETY_REVIEW_REQUIRED" && retry.data.safety.rules.includes("ACCESS_REFUSED") && retryDispatch.status === 409);
  const hazSig = await intake("Room 161: there is a gas smell and smoke, the guest refuses entry to staff, and a suspected danger.", BASE_SHORT);
  proxy.analyzeCalls = 0; proxy.script = [{ delay: 2500, status: 503, code: "PROVIDER_UNAVAILABLE" }];
  await api(op, "POST", `/intelligence/analyze/${hazSig._id}?workspaceId=${A}`, undefined, BASE_SHORT);
  await waitFor(async () => (await api(op, "GET", `/intelligence/analysis-status/${hazSig._id}?workspaceId=${A}`, undefined, BASE_SHORT)).data?.status === "failed", 30000, 400);
  const hazRetry = await api(op, "POST", `/intelligence/analyze/${hazSig._id}?workspaceId=${A}`, undefined, BASE_SHORT);
  check("C5 confirmed-hazard behaviour is unchanged across a failure and retry: LIFE_SAFETY_HAZARD with the hazard + refusal rules, no review rule", hazRetry.status === 201 && hazRetry.data.safety.state === "LIFE_SAFETY_HAZARD" && hazRetry.data.safety.rules.includes("ACCESS_REFUSED") && !hazRetry.data.safety.rules.includes("SAFETY_REVIEW_REQUIRED"));

  // ============================================================================================================ D. full lifecycle scenarios (A-E)
  const lifecycle = async (text, { actionType } = {}) => {
    const before = { intel: await M.Intelligence.countDocuments({}), dec: await M.Decision.countDocuments({}), act: await M.Action.countDocuments({}), out: await M.Outcome.countDocuments({}) };
    const sg = await intake(text); proxy.analyzeCalls = 0; proxy.script = [];
    const an = await api(op, "POST", `/intelligence/analyze/${sg._id}?workspaceId=${A}`);
    const dec = await api(op, "POST", `/decisions/propose/${an.data?._id}?workspaceId=${A}`);
    const dr = await api(rev, "POST", `/decisions/${dec.data?._id}/approve?workspaceId=${A}`, {});
    const act = await api(op, "POST", `/actions/propose/${dec.data?._id}?workspaceId=${A}`, actionType ? { actionType } : undefined);
    const ar = act.status === 201 ? await api(rev, "POST", `/actions/${act.data._id}/approve?workspaceId=${A}`, {}) : null;
    const oc = act.status === 201 ? await api(op, "POST", `/outcomes/record/${act.data._id}?workspaceId=${A}`, { status: "success", result: { summary: "Done and checked by the technician." } }) : null;
    const callsBefore = proxy.analyzeCalls;
    const an2 = await api(op, "POST", `/intelligence/analyze/${sg._id}?workspaceId=${A}`); const dec2 = await api(op, "POST", `/decisions/propose/${an.data?._id}?workspaceId=${A}`);
    const view = (await api(adm, "GET", `/intelligence/${an.data._id}?workspaceId=${A}`)).data;
    return { sg, an, dec, act, ar, oc, an2, dec2, view, ok: an.status === 201 && dr.status === 200 && (act.status !== 201 || (ar.status === 200 && oc.status === 201)), extra: { intel: (await M.Intelligence.countDocuments({})) - before.intel, dec: (await M.Decision.countDocuments({})) - before.dec, act: (await M.Action.countDocuments({})) - before.act, out: (await M.Outcome.countDocuments({})) - before.out }, reloadCalls: proxy.analyzeCalls - callsBefore, calls: proxy.analyzeCalls };
  };
  const LA = await lifecycle("Room 204 has an issue; guest reports a suspected hazardous condition.");
  check("D1 SCENARIO A (vague wording): SAFETY_REVIEW_REQUIRED; no hazard claim; the assessment is generated; Decision priority not forced critical; the Action is not escalation and not critical; one record of each, one provider call, none on reload; the state persists", LA.ok && LA.view.safety.state === "SAFETY_REVIEW_REQUIRED" && LA.dec.data.priority !== "critical" && LA.act.data.actionType !== "escalation" && LA.act.data.riskLevel !== "critical" && LA.extra.intel === 1 && LA.extra.dec === 1 && LA.extra.act === 1 && LA.extra.out === 1 && LA.calls === 1 && LA.reloadCalls === 0 && LA.an2.status === 200 && LA.dec2.data._id === LA.dec.data._id && !/life-safety|hazard confirmed/i.test(JSON.stringify(LA.view.analysis ?? {})), JSON.stringify([LA.view.safety, LA.dec.data?.priority, LA.act.data?.actionType]));
  const LB = await lifecycle("Room 161: there is a strong gas smell near the cooker.", { actionType: "escalation" });
  check("D2 SCENARIO B (confirmed hazard): LIFE_SAFETY_HAZARD, decision priority critical, Action risk critical, escalation; everything else as before; state persists", LB.ok && LB.view.safety.state === "LIFE_SAFETY_HAZARD" && LB.view.safety.rules.join() === "LIFE_SAFETY_HAZARD" && LB.dec.data.priority === "critical" && LB.act.data.riskLevel === "critical" && LB.extra.intel === 1 && LB.calls === 1 && LB.reloadCalls === 0);
  const LC = await lifecycle("Room 118: the AC is not cooling, the guest refuses entry, and there is a suspected hazardous condition.");
  const LCdisp = await trial("Room 118: the AC is not cooling, the guest refuses entry, and there is a suspected hazardous condition (scenario C dispatch).", "maintenance_dispatch"); const LCinsp = await trial("Room 118: the AC is not cooling, the guest refuses access, and there is a suspected hazardous condition (scenario C inspection).", "inspection");
  check("D3 SCENARIO C (refusal + vague wording): SAFETY_REVIEW_REQUIRED + ACCESS_REFUSED; dispatch blocked; inspection blocked; the default Action is not escalation (no new automatic escalation rule); state persists", LC.ok && LC.view.safety.state === "SAFETY_REVIEW_REQUIRED" && LC.view.safety.rules.includes("ACCESS_REFUSED") && LCdisp.r.status === 409 && LCinsp.r.status === 409 && LC.act.data.actionType !== "escalation" && LC.calls === 1 && LC.reloadCalls === 0);
  const LD = await lifecycle("Room 165: gas smell and the guest refuses to let staff enter.", { actionType: "escalation" });
  const LDdisp = await trial("Room 165: gas smell and the guest refuses to let staff enter (scenario D dispatch).", "maintenance_dispatch");
  check("D4 SCENARIO D (refusal + confirmed hazard): LIFE_SAFETY_HAZARD + ACCESS_REFUSED; escalation only (dispatch 409); risk critical; existing behaviour exactly", LD.ok && LD.view.safety.state === "LIFE_SAFETY_HAZARD" && LD.view.safety.rules.includes("ACCESS_REFUSED") && LD.act.data.actionType === "escalation" && LD.act.data.riskLevel === "critical" && LDdisp.r.status === 409 && LD.calls === 1 && LD.reloadCalls === 0);
  const LE = await lifecycle("Room 312: the hairdryer is not working.");
  check("D5 SCENARIO E (ordinary): NORMAL, no rules, no false review state, one record of each, one provider call, none on reload", LE.ok && LE.view.safety.state === "NORMAL" && LE.view.safety.rules === undefined && LE.extra.intel === 1 && LE.calls === 1 && LE.reloadCalls === 0);
  // Learning: the completed-case normaliser compares the stored state with what Learning's (unchanged, three-state) policy derives; a review-state case therefore cannot enter Learning
  const parts = async (x) => { const sg = await M.Signal.findOne({ _id: x.sg._id }).lean(); return { outcome: await M.Outcome.findOne({ signalId: x.sg._id }).lean(), action: await M.Action.findOne({ _id: x.act.data._id }).lean(), decision: await M.Decision.findOne({ _id: x.dec.data._id }).lean(), intelligence: await M.Intelligence.findOne({ _id: x.an.data._id }).lean(), signal: sg, unit: await M.Unit.findOne({ _id: sg.unitId }).lean() }; };
  const nReview = normalizeCompletedCase(await parts(LA), A); const nOrdinary = normalizeCompletedCase(await parts(LE), A);
  check("D6 SAFETY_REVIEW_REQUIRED does not become Learning: a completed case stored with that state is REJECTED by the existing Learning normaliser (SAFETY_INCONSISTENT - fail closed), while an ordinary completed case is accepted unchanged", nReview.ok === false && nReview.reason === REJECTION.SAFETY_INCONSISTENT && nOrdinary.ok === true, JSON.stringify([nReview.reason, nOrdinary.reason]));

  // ============================================================================================================ E. the page
  const feRequire = createRequire(path.join(FRONTEND, "package.json"));
  const React = feRequire("react"); const { renderToStaticMarkup } = feRequire("react-dom/server"); const h = React.createElement;
  const text = (m) => m.replace(/<[^>]*>/g, " ").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
  const SafetyAssessment = (await vite.ssrLoadModule("/src/features/intelligence/SafetyAssessment.jsx")).default;
  const { mapSafety } = await vite.ssrLoadModule("/src/features/intelligence/safetyMapping.js");
  const { presentSafety, rejectionRequirements, PRESENTED_VOCABULARY } = await vite.ssrLoadModule("/src/features/intelligence/safetyPresentation.js");
  const html = (s) => renderToStaticMarkup(h(SafetyAssessment, { safety: mapSafety(s) }));
  const apiReview = (await api(adm, "GET", `/intelligence/${LA.an.data._id}?workspaceId=${A}`)).data.safety; const apiReviewRefusal = (await api(adm, "GET", `/intelligence/${LC.an.data._id}?workspaceId=${A}`)).data.safety;
  const apiHazard = (await api(adm, "GET", `/intelligence/${LB.an.data._id}?workspaceId=${A}`)).data.safety; const apiHazardRefusal = (await api(adm, "GET", `/intelligence/${LD.an.data._id}?workspaceId=${A}`)).data.safety; const apiNormal = (await api(adm, "GET", `/intelligence/${LE.an.data._id}?workspaceId=${A}`)).data.safety;
  const hReview = html(apiReview); const tReview = text(hReview); const tReviewRefusal = text(html(apiReviewRefusal)); const hHazard = html(apiHazard); const tHazard = text(hHazard); const tHazardRefusal = text(html(apiHazardRefusal)); const tNormal = text(html(apiNormal));
  check("E1 [frontend] the state is shown clearly but calmly: 'Safety review required' and the approved sentence, in the quiet (non-alert) block - no alarm role, no hazard / critical / emergency / escalation wording", /Safety review required/.test(tReview) && /The report contains wording that indicates a possible safety concern\. The concern has not been established as a confirmed hazard\./.test(tReview) && !/role="alert"/.test(hReview) && !/hazard confirmed|danger confirmed|critical|emergency|escalate immediately|LIFE-SAFETY|IMMEDIATE ACTION|ESCALATION REQUIRED/i.test(tReview.replace("Safety review required", "").replace("has not been established as a confirmed hazard", "")), tReview);
  check("E2 review + refusal shows BOTH notes cleanly (review concern, then the refusal restriction); the refusal wording itself is unchanged", /Safety review required/.test(tReviewRefusal) && /possible safety concern/.test(tReviewRefusal) && /Access was refused in this report\. Under the safety rules, maintenance dispatch and inspection \(which need entry\) are not permitted\./.test(tReviewRefusal));
  check("E3 the LIFE_SAFETY_HAZARD presentation is unchanged: the alert, the flags and the escalation-only refusal line; and NO review note beside a hazard", /role="alert"/.test(hHazard) && /LIFE-SAFETY HAZARD/.test(tHazard) && !/review required|possible safety concern/i.test(tHazard + tHazardRefusal) && /the only permitted action type is escalation/.test(tHazardRefusal));
  check("E4 an ordinary result shows no review note and no refusal note; CRITICAL keeps its alert and, only if the server recorded the rule, adds the calm review sentence under it; an unknown state is still 'unrecognised' (never mapped to the new one)", !/review required|possible safety concern|refused/i.test(tNormal) && /Quiet|Normal/.test(tNormal) && (() => { const c = html({ state: "CRITICAL", urgency: "immediate", recommendedActionType: "escalation", rules: ["SEVERITY_CRITICAL", "SAFETY_REVIEW_REQUIRED"] }); return /role="alert"/.test(c) && /CRITICAL SAFETY CONDITION/.test(c) && /possible safety concern/.test(text(c)); })() && presentSafety({ state: "SAFETY_REVIEW" }).status === "unrecognised" && presentSafety(null).status === "not_recorded");
  check("E5 the state adds no rejection requirement on the page (matching the server): none, like NORMAL; the page's vocabulary equals the backend's persisted states", JSON.stringify(rejectionRequirements({ state: "SAFETY_REVIEW_REQUIRED" })) === JSON.stringify(rejectionRequirements({ state: "NORMAL" })) && JSON.stringify([...PRESENTED_VOCABULARY.states].sort()) === JSON.stringify([...SAFETY_STATES].sort()));
  const feSrc = ["safetyMapping.js", "safetyPresentation.js"].map((f) => read(path.join(FRONTEND, "src", "features", "intelligence", f))).join("") + read(path.join(FRONTEND, "src", "features", "intelligence", "SafetyAssessment.jsx"));
  check("E6 the page adds no safety logic: exact-match on the server's state / rule code only, no keyword or pattern test over report text, no fetch, no localStorage; no internal id or Mongo field in any rendered safety text", !/\.test\(|RegExp|match\(|localStorage|fetch\(/.test(feSrc.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")) && ![tReview, tReviewRefusal, tHazard, tNormal].some((t) => /[0-9a-f]{24}|_id|workspaceId/.test(t)));

  // ============================================================================================================ F. boundaries
  const py = read(path.join(AI_SERVICE, "app", "services", "analysis_prompt.py"));
  const aiFiles = fs.readdirSync(path.join(AI_SERVICE, "app"), { recursive: true }).filter((f) => String(f).endsWith(".py")).map((f) => read(path.join(AI_SERVICE, "app", String(f)))).join("\n");
  check("F1 the model is not authoritative and not told: no prompt, AI-service source, AI client or context contract names the new state, the rule, the cue phrases or the option", !/SAFETY_REVIEW_REQUIRED|includeReviewRequired|suspected hazardous|possible danger|suspected danger/i.test(py + aiFiles + read(path.join(BACKEND, "src", "services", "ai", "aiServiceClient.js")) + read(path.join(BACKEND, "src", "services", "operationalContextContract.js"))));
  const decSrc = read(path.join(BACKEND, "src", "services", "decisionService.js")); const actSrc = read(path.join(BACKEND, "src", "services", "actionService.js"));
  check("F2 Decision and Action enforcement code does not name the new state (no implicit restriction): the constrained-state sets and rejection rules are exactly the existing ones", !/SAFETY_REVIEW_REQUIRED/.test(decSrc + actSrc) && /SAFETY_CONSTRAINED_STATES = new Set\(\["CRITICAL", "LIFE_SAFETY_HAZARD"\]\)/.test(actSrc));
  check("F3 the recurrence implementation is untouched by this feature: neither recurrence source mentions the safety state, and recurrence is not used to infer a safety state", !/SAFETY_REVIEW_REQUIRED|deriveSafetyPolicy/.test(read(path.join(BACKEND, "src", "services", "recurrence.js")) + read(path.join(BACKEND, "src", "services", "signalRecurrenceService.js"))));
  const envFiles = read(path.join(BACKEND, "src", "config", "env.js"));
  check("F4 no timeout / provider / model setting references the new state (configuration is untouched)", !/SAFETY_REVIEW/.test(envFiles + read(path.join(BACKEND, "src", "config", "providerPolicy.js"))));
} catch (error) {
  failed += 1;
  console.error("FAIL  suite crashed -", error?.stack ?? error);
} finally {
  for (const c of children) kill(c);
  try { await vite.close(); } catch { /* best effort */ }
  try { await mongoose.connection.dropDatabase(); } catch { /* best effort */ }
  try { await mongoose.disconnect(); } catch { /* best effort */ }
}
console.log(`\nSAFETY_REVIEW_REQUIRED validation: ${passed} passed, ${failed} failed (isolated database ${DB_NAME} dropped; no Gemini call; no external network)`);
process.exit(failed ? 1 : 0);
