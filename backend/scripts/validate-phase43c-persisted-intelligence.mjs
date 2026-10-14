/**
 * Phase 43C validation - a stored Intelligence analysis is shown when the page opens / refreshes / is revisited, with ZERO generation calls.
 *
 *   node backend/scripts/validate-phase43c-persisted-intelligence.mjs
 *
 *   S  selection: the stored analysis the page chooses is the one the dashboard read model chooses (differential test against the backend's own pickVisibleAnalysis)
 *   C  the load / generate state machine (signalIntelligenceController.js, loaded through Vite SSR) driven with COUNTED fake APIs
 *   W  static guarantees: where a POST /analyze can be issued from at all
 *   H  real HTTP on an ISOLATED throwaway database (koi_p43c_<stamp>, dropped at the end): the real GET payload feeds the controller; tenant isolation;
 *      reads cost zero model calls. No Gemini, no key, no Atlas; the stub AI service reports the approved identity so strict validation runs.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import dotenv from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(here, "..");
const REPO = path.join(BACKEND, "..");
const FRONTEND = path.join(REPO, "frontend");
const read = (p) => fs.readFileSync(p, "utf8");
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
let passed = 0; let failed = 0;
const check = (name, ok, detail = "") => { if (ok) { passed += 1; console.log(`PASS  ${name}${detail ? ` - ${detail}` : ""}`); } else { failed += 1; console.error(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`); } };

// ---- isolated database, derived from the local loopback URI BEFORE anything reads it (never printed)
{ const __u = dotenv.parse(process.getBuiltinModule("node:fs").readFileSync(new URL("../.env", import.meta.url))).MONGODB_URI ?? ""; if (/^mongodb:\/\/(?:[^@/]*@)?(localhost|127\.0\.0\.1)/i.test(__u)) process.env.MONGODB_URI ??= __u; } // validation / rehearsal tools take ONLY a loopback database URI from backend/.env, never its real settings
const baseUri = process.env.MONGODB_URI;
const stamp = Date.now();
const DB_NAME = `koi_p43c_${stamp}`;
if (!baseUri || /^mongodb\+srv:|@/.test(baseUri) || !/^mongodb:\/\/(localhost|127\.0\.0\.1)/.test(baseUri)) { console.error("refusing: the configured MongoDB is not a plain loopback instance"); process.exit(2); }
process.env.MONGODB_URI = baseUri.replace(/(mongodb:\/\/[^/]+\/)([^?]*)/, `$1${DB_NAME}`);

const { createActor } = await import("./lib/authFixtures.mjs");
const mongoose = (await import("mongoose")).default;
const { connectDatabase } = await import("../src/config/database.js");
const { Intelligence, Signal, Workspace } = await import("../src/models/index.js");
const { APPROVED_MODEL, APPROVED_PROVIDER } = await import("../src/config/providerPolicy.js");
const { analyzeSignal } = await import("../src/services/intelligenceAnalysisService.js");
const { pickVisibleAnalysis } = await import("../src/services/dashboardService.js");
const { VISIBILITY_LEVELS, visibilityRank } = await import("../src/services/knowledge/visibility.js");
await connectDatabase();
if (mongoose.connection.db.databaseName !== DB_NAME) { console.error("refusing: not connected to the isolated database"); process.exit(2); }

const { createServer } = await import(pathToFileURL(path.join(FRONTEND, "node_modules", "vite", "dist", "node", "index.js")).href);
const vite = await createServer({ root: FRONTEND, configFile: path.join(FRONTEND, "vite.config.js"), server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom", logLevel: "silent", optimizeDeps: { noDiscovery: true, include: [] } });

// ---- the stub AI service (approved identity => strict validation); counts model calls
const fake = { analyzeCalls: 0, build: null };
const stub = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* not JSON */ }
    const send = (status, payload) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(payload)); };
    if (req.url.endsWith("/v1/knowledge-retrieval")) return send(200, { results: [], model: "stub-model", evaluatedCandidates: (body.candidates || []).length, incompatibleCandidates: 0 });
    if (!req.url.endsWith("/v1/intelligence/analyze")) return send(404, { error: { code: "MALFORMED_RESPONSE", message: "unexpected" } });
    fake.analyzeCalls += 1;
    const sid = body?.context?.signal?.id;
    const good = {
      situation: "S", evidence: ["E"], impact: "I", recommendation: "Have the unit checked and keep the guest informed.", confidence: "high", usedKnowledgeChunkIds: [],
      provenance: { provider: APPROVED_PROVIDER, model: APPROVED_MODEL }, evidenceRefs: [], contradictions: [], urgency: "prompt", recommendedActionType: "inspection",
      claims: [{ claimType: "FACT", text: "The Signal is recorded.", sourceRefs: [`current:signal:${sid}`] }, { claimType: "RECOMMENDATION", text: "Act on the recorded Signal.", sourceRefs: [`current:signal:${sid}`] }],
    };
    return send(200, fake.build ? fake.build(good, sid) : good);
  });
});
await new Promise((resolve) => stub.listen(5086, resolve));
process.env.AI_SERVICE_URL = "http://localhost:5086";
process.env.LLM_PROVIDER = "test-python";
delete process.env.KOI_LEARNING_CONTEXT_ENABLED;

let child = null;
try {
  const { createSignalIntelligenceController } = await vite.ssrLoadModule("/src/features/intelligence/signalIntelligenceController.js");
  const { selectStoredAnalysis, mapIntelligenceAnalysis } = await vite.ssrLoadModule("/src/features/intelligence/intelligenceMapping.js");

  const OID = (n) => `6ac3${String(n).padStart(20, "0")}`;
  const SIG = OID(1); const WS = OID(7);
  const tick = () => new Promise((r) => setImmediate(r));
  const deferred = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
  const apiErr = (status, message = "RAW_SERVER_REASON_CODE_X: internal detail") => Object.assign(new Error(message), { name: "ApiError", status });
  /** a counted fake API: listStored / analyze, with programmable results */
  const mkApi = ({ stored = [], storedFn, analyzeFn } = {}) => {
    const calls = { list: 0, analyze: 0, listArgs: [] };
    return {
      calls,
      listStored: async (signalId, workspaceId) => { calls.list += 1; calls.listArgs.push([signalId, workspaceId]); return storedFn ? storedFn() : stored; },
      analyze: async (signalId, workspaceId) => { calls.analyze += 1; if (!analyzeFn) throw new Error("analyze must not be called here"); return analyzeFn(signalId, workspaceId); },
    };
  };
  /** mount = what the hook's effect does: create a controller, load; returns the emitted states */
  const mount = (api, over = {}) => {
    const states = [];
    const controller = createSignalIntelligenceController({ signalId: SIG, workspaceId: WS, configured: true, api, onChange: (s) => states.push(s), ...over });
    return { states, controller, last: () => states.at(-1), statuses: () => states.map((s) => s.status) };
  };

  const view = (over = {}) => ({
    _id: OID(20), workspaceId: WS, signalIds: [SIG], analysisVersion: "intelligence-v1", analysisLevel: "staff", createdAt: "2026-10-05T10:00:00.000Z",
    analysis: { situation: "A situation.", evidence: ["Evidence one.", "Evidence two."], impact: "Some impact.", recommendation: "Do the thing.", confidence: "medium" },
    knowledgeProvenance: [{ chunkId: OID(30), section: "Gas Smell and Smoke - Emergency Procedure", sectionPath: ["Emergency"], visibility: "staff", retrievalScore: 0.62 }],
    safety: { state: "LIFE_SAFETY_HAZARD", urgency: "immediate", recommendedActionType: "escalation" }, ...over,
  });

  // ============================================================================================================ S. selection
  console.log("\n# S. which stored analysis is shown");
  check("S1 the level table is the backend's: same levels, same order as visibility.js", JSON.stringify(Object.keys({ guest: 0, staff: 1, restricted: 2 })) === JSON.stringify(VISIBILITY_LEVELS) && VISIBILITY_LEVELS.every((l, i) => visibilityRank(l) === i));
  let seed = 43; const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  let disagreements = 0; let nonEmpty = 0;
  for (let n = 0; n < 400; n += 1) {
    const records = Array.from({ length: Math.floor(rnd() * 6) }, (_, i) => ({
      _id: OID(100 + Math.floor(rnd() * 30)), createdAt: new Date(1790000000000 + Math.floor(rnd() * 5) * 86400000).toISOString(),
      analysisVersion: rnd() < 0.85 ? "intelligence-v1" : (rnd() < 0.5 ? undefined : "legacy"), analysisLevel: ["guest", "staff", "restricted", undefined, "bogus"][Math.floor(rnd() * 5)],
      knowledgeVisibility: undefined, analysis: { situation: String(i) },
    }));
    const mine = selectStoredAnalysis(JSON.parse(JSON.stringify(records)));
    const theirs = pickVisibleAnalysis(records, "restricted");
    const same = (mine === null && theirs === null) || (mine && theirs && mine._id === theirs._id && mine.createdAt === theirs.createdAt && mine.analysisLevel === theirs.analysisLevel && mine.analysis.situation === theirs.analysis.situation);
    if (theirs) nonEmpty += 1;
    if (!same) disagreements += 1;
  }
  check("S2 DIFFERENTIAL: for 400 random sets of records (mixed levels, dates, ids, legacy and malformed levels) the page picks exactly the analysis the dashboard read model picks - highest level, then newest, then larger id", disagreements === 0 && nonEmpty > 100, `${disagreements} disagreements, ${nonEmpty} non-empty`);
  check("S3 pre-V1 / legacy records and records with an unknown level are not analyses: ignored; an empty list is 'none'", selectStoredAnalysis([]) === null && selectStoredAnalysis([{ _id: "a", analysisVersion: "legacy", analysisLevel: "staff" }, { _id: "b", analysisVersion: "intelligence-v1", analysisLevel: "bogus" }, null, "x", 5]) === null);
  let threw = 0; for (const bad of [null, undefined, {}, "x", 5]) { try { selectStoredAnalysis(bad); } catch { threw += 1; } }
  check("S4 a body that is not a list is an ERROR (never 'none')", threw === 5);

  // ============================================================================================================ C. controller
  console.log("\n# C. the load / generate state machine (counted fake APIs)");
  {
    const api = mkApi({ stored: [view()] });
    const m = mount(api); await m.controller.load(); await tick();
    check("C1 a stored analysis is shown: checking -> ready, ONE read, ZERO generation calls", JSON.stringify(m.statuses()) === '["checking","ready"]' && api.calls.list === 1 && api.calls.analyze === 0 && m.last().intelligence.recommendation === "Do the thing.");
    check("C1b ...the read is scoped to this Signal and workspace", JSON.stringify(api.calls.listArgs) === JSON.stringify([[SIG, WS]]));
  }
  {
    const gate = deferred(); const api = mkApi({ storedFn: () => gate.promise });
    const m = mount(api); const loading = m.controller.load(); await tick();
    check("C2 LOADING is not 'no analysis': while the read is pending the state is 'checking' - 'idle' (the empty state and Generate control) has NOT been shown", m.last().status === "checking" && !m.statuses().includes("idle") && api.calls.analyze === 0);
    gate.resolve([]); await loading;
    check("C2b only after the read CONFIRMS there is none does the empty state appear", m.last().status === "idle" && m.last().intelligence === null && JSON.stringify(m.statuses()) === '["checking","idle"]' && api.calls.analyze === 0);
  }
  {
    const api = mkApi({ stored: [view({ safety: { state: "LIFE_SAFETY_HAZARD", urgency: "immediate", recommendedActionType: "escalation" } })] });
    const m = mount(api); await m.controller.load();
    const i = m.last().intelligence;
    check("C3 SAFETY survives: state, urgency and action type are carried unchanged from the stored record (LIFE_SAFETY_HAZARD + immediate + escalation)", JSON.stringify(i.safety) === '{"state":"LIFE_SAFETY_HAZARD","urgency":"immediate","recommendedActionType":"escalation"}');
    check("C4 EVIDENCE / PROVENANCE / CONFIDENCE survive: the evidence list, the provenance (section title, path, visibility, score), the confidence and the id", i.evidence.length === 2 && i.provenance.length === 1 && i.provenance[0].section === "Gas Smell and Smoke - Emergency Procedure" && i.provenance[0].retrievalScore === 0.62 && i.confidence === "medium" && i.id === OID(20));
    const older = mount(mkApi({ stored: [view({ safety: undefined })] })); await older.controller.load();
    check("C5 an OLDER record (no safety) stays 'not recorded' (null) - never NORMAL, never safe", older.last().status === "ready" && older.last().intelligence.safety === null);
  }
  {
    const refs = view({ analysis: { situation: `Gas reported (untrusted:signal:${SIG}).`, evidence: [`Per knowledge:${OID(30)} (current:stay:${OID(40)}).`], impact: "I", recommendation: `Escalate per knowledge:${OID(30)}; chunkId ${OID(30)}.`, confidence: "low" } });
    const m = mount(mkApi({ stored: [refs] })); await m.controller.load();
    const text = JSON.stringify(m.last().intelligence.evidence) + m.last().intelligence.recommendation + m.last().intelligence.situation;
    check("C6 PHASE 43A: a STORED analysis goes through the same mapping as a generated one - evidence references and ObjectIds in its prose are removed", !/\b(?:current|untrusted|history|knowledge|learning):[A-Za-z0-9_.-]+/.test(text) && !/[0-9a-f]{24}/i.test(text) && /Escalate per the "Gas Smell and Smoke - Emergency Procedure" guidance/.test(text));
    const gen = mount(mkApi({ stored: [], analyzeFn: async () => refs })); await gen.controller.load(); await gen.controller.generate();
    const same = mapIntelligenceAnalysis(refs);
    check("C6b ...and it is IDENTICAL to what the same record produces when generated (one mapping path)", JSON.stringify(gen.last().intelligence) === JSON.stringify(same) && JSON.stringify(m.last().intelligence) === JSON.stringify(same));
  }
  {
    // refresh / navigate away and back / back-forward = a new mount each time
    let list = 0; let analyze = 0; const results = [];
    for (let i = 0; i < 6; i += 1) {
      const api = mkApi({ stored: [view()] }); const m = mount(api); await m.controller.load(); m.controller.dispose();
      list += api.calls.list; analyze += api.calls.analyze; results.push(JSON.stringify(m.last().intelligence));
    }
    check("C7 REFRESH / navigate away and back / browser back-forward = a fresh mount each time: six mounts = six reads, ZERO generation calls, the same analysis every time", list === 6 && analyze === 0 && new Set(results).size === 1 && !results[0].includes("null"));
  }
  {
    // React StrictMode in development: mount, cleanup, mount again
    const apiA = mkApi({ stored: [view()] }); const apiB = mkApi({ stored: [view()] });
    const gateA = deferred(); apiA.listStored = async () => { apiA.calls.list += 1; return gateA.promise; };
    const a = mount(apiA); const pa = a.controller.load(); await tick();
    a.controller.dispose(); // StrictMode cleanup of the first mount
    const b = mount(apiB); await b.controller.load();
    gateA.resolve([view({ _id: OID(99), analysis: { situation: "STALE", evidence: [], impact: "", recommendation: "STALE", confidence: "low" } })]); await pa; await tick();
    check("C8 STRICT MODE: the double mount makes at most two harmless READS and ZERO generation calls; the disposed mount's late response never overwrites the live one", apiA.calls.list + apiB.calls.list === 2 && apiA.calls.analyze === 0 && apiB.calls.analyze === 0 && b.last().intelligence.recommendation === "Do the thing." && a.states.every((s) => s.status === "checking"));
  }
  {
    const api = mkApi({ stored: [], analyzeFn: async () => view({ safety: { state: "NORMAL", urgency: "prompt", recommendedActionType: "inspection" } }) });
    const m = mount(api); await m.controller.load();
    check("C9 no stored analysis: nothing is generated automatically (still zero generation calls after the read)", m.last().status === "idle" && api.calls.analyze === 0);
    await m.controller.generate();
    check("C9b GENERATE (user action) still works: loading -> ready, exactly ONE generation call, and a NORMAL safety result is shown", JSON.stringify(m.statuses()) === '["checking","idle","loading","ready"]' && api.calls.analyze === 1 && m.last().intelligence.safety.state === "NORMAL");
  }
  {
    // generate when the server returns the stored one (idempotent) - the page still makes exactly one POST, and no second read follows it
    const api = mkApi({ stored: [], analyzeFn: async () => view() });
    const m = mount(api); await m.controller.load(); await m.controller.generate();
    check("C10 after a generation no extra read or generation follows (no polling, no retry)", api.calls.list === 1 && api.calls.analyze === 1);
  }
  {
    const cases = [[401, "unauthenticated"], [403, "forbidden"], [500, "error"], [502, "error"], [0, "error"], [429, "error"]];
    const okCases = [];
    for (const [status, reason] of cases) {
      const api = mkApi({ storedFn: () => { throw apiErr(status); } });
      const m = mount(api); await m.controller.load();
      const s = m.last();
      okCases.push(s.status === "loadError" && s.loadReason === reason && s.intelligence === null && s.error === null && !JSON.stringify(s).includes("RAW_SERVER_REASON_CODE_X") && api.calls.analyze === 0 && api.calls.list === 1);
    }
    check("C11 a failed READ (401 / 403 / 500 / 502 / network / 429) is a load error with a fixed reason - NEVER 'no analysis', no server text or reason code in the state, no generation call, no retry", okCases.every(Boolean), okCases.join(","));
    const nf = mount(mkApi({ storedFn: () => { throw apiErr(404); } })); await nf.controller.load();
    check("C12 404 = nothing stored: the empty state", nf.last().status === "idle" && nf.last().loadReason === null);
    const tmo = mount(mkApi({ storedFn: () => { throw Object.assign(new Error("The EOI backend took too long to respond."), { status: 0 }); } })); await tmo.controller.load();
    check("C12b a timeout is a load error, shown with a retry (a second read), still no generation", tmo.last().status === "loadError" && tmo.last().loadReason === "error");
    const retryApi = mkApi({ storedFn: () => { if (retryApi.calls.list === 1) throw apiErr(503); return [view()]; } });
    const rm = mount(retryApi); await rm.controller.load(); const first = rm.last().status; await rm.controller.load();
    check("C12c 'Try again' is another READ: it recovers to the stored analysis without any generation call", first === "loadError" && rm.last().status === "ready" && retryApi.calls.list === 2 && retryApi.calls.analyze === 0);
  }
  {
    const bad = [
      { label: "body is not a list", fn: () => ({ data: "oops" }) },
      { label: "body is null", fn: () => null },
      { label: "a V1 record with no analysis", fn: () => [view({ analysis: undefined })] },
      { label: "a V1 record whose analysis is not an object", fn: () => [view({ analysis: "text" })] },
    ];
    const outcomes = [];
    for (const b of bad) { const api = mkApi({ storedFn: b.fn }); const m = mount(api); await m.controller.load(); outcomes.push(m.last().status === "loadError" && m.last().intelligence === null && api.calls.analyze === 0); }
    check("C13 a MALFORMED read (not a list / null / a V1 record without a usable analysis) is a load error: it is not treated as 'no analysis' and nothing is fabricated", outcomes.every(Boolean), outcomes.join(","));
  }
  {
    const gate = deferred(); const api = mkApi({ storedFn: () => gate.promise, analyzeFn: async () => view({ analysis: { situation: "GENERATED", evidence: [], impact: "", recommendation: "GENERATED", confidence: "low" } }) });
    const m = mount(api); const reading = m.controller.load(); await tick();
    await m.controller.generate(); // the user clicks while a read is still in flight
    gate.resolve([view({ analysis: { situation: "STORED", evidence: [], impact: "", recommendation: "STORED", confidence: "low" } })]); await reading; await tick();
    check("C14 a read still in flight when the user generates cannot overwrite the generated result (and vice versa) - the latest request wins", m.last().intelligence.recommendation === "GENERATED" && api.calls.analyze === 1);
    const gate2 = deferred(); const api2 = mkApi({ storedFn: () => gate2.promise }); const m2 = mount(api2); const p2 = m2.controller.load(); await tick(); m2.controller.dispose(); gate2.resolve([view()]); await p2; await tick();
    check("C14b a disposed controller (the Signal changed / the page closed) never emits again", m2.states.length === 1 && m2.states[0].status === "checking");
  }
  {
    const api = mkApi({ stored: [view()] }); const un = mount(api, { configured: false }); await un.controller.load(); await un.controller.generate();
    check("C15 with no workspace configured nothing is read or generated", api.calls.list === 0 && api.calls.analyze === 0 && un.last().status === "idle");
  }
  {
    const e502 = mkApi({ stored: [], analyzeFn: async () => { throw apiErr(502, `AI analysis was rejected by the server safety policy (ACTION_FORBIDDEN_BY_ACCESS_REFUSAL) for current:stay:${OID(40)}. Intelligence was not generated.`); } });
    const m = mount(e502); await m.controller.load(); await m.controller.generate();
    check("C16 a REJECTED generation keeps the existing behaviour: error state with the (Phase 43A cleaned) message, and nothing is shown as an analysis", m.last().status === "error" && m.last().intelligence === null && !/current:stay|[0-9a-f]{24}/.test(m.last().error));
    const refresh = mount(mkApi({ stored: [] })); await refresh.controller.load();
    check("C17 REFRESH after a rejected generation: nothing was stored, so the page shows the empty state - it does not fabricate a previous successful analysis", refresh.last().status === "idle" && refresh.last().intelligence === null);
    for (const [status, expected] of [[503, "unconfigured"], [403, "forbidden"]]) {
      const x = mount(mkApi({ stored: [], analyzeFn: async () => { throw apiErr(status, "x"); } })); await x.controller.load(); await x.controller.generate();
      check(`C18 generation failure ${status} keeps its existing status '${expected}'`, x.last().status === expected);
    }
  }

  // ============================================================================================================ W. static guarantees
  console.log("\n# W. where a generation request can come from");
  const hookSrc = code(path.join(FRONTEND, "src", "features", "intelligence", "useSignalIntelligence.js"));
  const ctlSrc = code(path.join(FRONTEND, "src", "features", "intelligence", "signalIntelligenceController.js"));
  const pageSrc = code(path.join(FRONTEND, "src", "features", "assistant", "SignalCaseCard.jsx")); // Phase 52: the assistant's case card (generation is requested by the page through useCaseGeneration)
  const apiSrc = code(path.join(FRONTEND, "src", "services", "api.js"));
  const loadFn = ctlSrc.slice(ctlSrc.indexOf("const load = async"), ctlSrc.indexOf("const generate = async"));
  check("W1 the READ path (load) never references the generation function: `api.analyze` appears only inside generate()", !/analyze/.test(loadFn) && /api\.listStored/.test(loadFn) && (ctlSrc.match(/api\.analyze\(/g) || []).length === 1 && ctlSrc.indexOf("api.analyze(") > ctlSrc.indexOf("const generate = async"));
  check("W2 the hook's effect calls load() only; generate is exposed as a callback for a click handler and is not invoked by the hook", /controller\.load\(\)/.test(hookSrc) && !/controller\.generate\(\)\s*;?\s*\n\s*return/.test(hookSrc) && (hookSrc.match(/generate\(\)/g) || []).length === 1 && /useCallback\(\(\) => controllerRef\.current\?\.generate\(\)/.test(hookSrc));
  check("W3 the page calls generate only from the button's onClick - nowhere else (Workstream 5B: its two effects are the stored-analysis read and the state read/release, neither starts an analysis)", (pageSrc.match(/onClick=\{onGenerate\}/g) || []).length >= 1 && !/\bgenerate\(/.test(pageSrc) && (pageSrc.match(/useEffect\(/g) || []).length === 2 && /reloadIntelligence\(\)/.test(pageSrc) && /useEffect\(\(\) => \{\s*if \(noAssessmentShown\) onObserve\?\.\(signalId\);\s*return \(\) => onRelease\?\.\(signalId\);\s*\}, \[noAssessmentShown, signalId, onObserve, onRelease\]\);/.test(pageSrc) && !/useEffect\([^)]*\bonGenerate\b|useEffect\(\(\) => \{[^}]*\bgenerate\(/.test(pageSrc));
  check("W4 the API read function uses GET on the intelligence collection with the Signal id, and never the analyze endpoint; a non-list body is an error, not []", /export async function listSignalIntelligence[\s\S]*api\.get\(koiEndpoints\.intelligence/.test(apiSrc) && !/listSignalIntelligence[\s\S]{0,400}intelligenceAnalyze/.test(apiSrc) && /Array\.isArray\(items\)\) throw new ApiError/.test(apiSrc));
  check("W5 no polling, timer, retry loop or background refetch in the load path (no setInterval / setTimeout / while / retry)", ![hookSrc, ctlSrc].some((s) => /setInterval|setTimeout|requestAnimationFrame|while\s*\(|retry|polling/i.test(s)));
  check("W6 React StrictMode is still on (nothing was disabled to make this pass)", /<StrictMode>/.test(read(path.join(FRONTEND, "src", "main.jsx"))));
  check("W7 the case card renders 'checking' BEFORE the empty state (the final fallthrough), the empty-state wording appears once, and the load-error branch shows fixed text (no server message)", pageSrc.indexOf('status === "checking"') < pageSrc.indexOf("There is no assessment for this report yet") && (pageSrc.match(/There is no assessment for this report yet/g) || []).length === 1 && pageSrc.indexOf('status === "loadError"') > 0 && !/error\.message|err\.message/.test(pageSrc.slice(pageSrc.indexOf('status === "loadError"'), pageSrc.indexOf("There is no assessment for this report yet"))));
  check("W8 the stored analysis uses the existing mapping modules: the controller maps through mapIntelligenceAnalysis (which carries safetyMapping and the Phase 43A presenter), and the page has no mapping or safety logic of its own", /mapIntelligenceAnalysis\(stored\)/.test(ctlSrc) && !/presentSafety|presentText|mapSafety|LIFE_SAFETY/.test(pageSrc));

  // ============================================================================================================ H. real HTTP, isolated DB
  console.log("\n# H. the real API on an isolated database");
  const wsA = await Workspace.create({ name: `P43C a ${stamp}`, slug: `p43c-a-${stamp}`, status: "active" });
  const wsB = await Workspace.create({ name: `P43C b ${stamp}`, slug: `p43c-b-${stamp}`, status: "active" });
  const A = String(wsA._id); const B = String(wsB._id);
  const mkSignal = (severity, title, description) => Signal.create({ workspaceId: wsA._id, type: "maintenance", severity, title, description });
  const sHaz = await mkSignal("medium", "Strong smell of gas in the kitchen", "The guest reports a strong smell of gas in the kitchen.");
  const sNone = await mkSignal("medium", "Lamp is dim", "A lamp is dim.");
  fake.build = (good) => ({ ...good, urgency: "immediate", recommendedActionType: "escalation", recommendation: "Evacuate the guest and escalate to the emergency services now." });
  const made = await analyzeSignal(String(sHaz._id), A, { authorizedLevel: "staff" });
  fake.build = null;
  const sGuest = await mkSignal("medium", "Towels requested", "The guest asks for extra towels.");
  await analyzeSignal(String(sGuest._id), A, { authorizedLevel: "guest" });
  const callsAfterGeneration = fake.analyzeCalls;
  child = spawn(process.execPath, [path.join(BACKEND, "server.js")], { env: { ...process.env, PORT: "5087", LLM_PROVIDER: "test-python", AI_SERVICE_URL: "http://localhost:5086", KNOWLEDGE_DEV_AUTHORIZED_LEVEL: "restricted" }, stdio: "ignore" });
  const BASE = "http://localhost:5087/api";
  for (let i = 0; i < 100; i += 1) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 200)); }
  const call = async (method, url, who) => { const r = await fetch(`${BASE}${url}`, { method, headers: who ? who.headers : {} }); let json = null; try { json = await r.json(); } catch { /* none */ } return { status: r.status, json }; };
  const viewerA = await createActor({ role: "viewer", workspaceId: wsA._id, label: "p43c-viewer" });
  const operatorA = await createActor({ role: "operator", workspaceId: wsA._id, label: "p43c-op" });
  const adminB = await createActor({ role: "admin", workspaceId: wsB._id, label: "p43c-adminb" });

  const got = await call("GET", `/intelligence?signalId=${sHaz._id}&workspaceId=${A}&limit=50`, operatorA);
  check("H1 GET /intelligence?signalId= returns the stored analysis of the Signal with its structured safety result", got.status === 200 && Array.isArray(got.json.data) && got.json.data.length === 1 && got.json.data[0].safety?.state === "LIFE_SAFETY_HAZARD" && got.json.data[0].safety.urgency === "immediate" && got.json.data[0].safety.recommendedActionType === "escalation");
  const ctl = mount(mkApi({ stored: got.json.data })); await ctl.controller.load();
  const posted = await call("POST", `/intelligence/analyze/${sHaz._id}?workspaceId=${A}`, operatorA);
  check("H2 the REAL payload is shown by the controller (ready, safety carried unchanged, stored recommendation present) and is IDENTICAL to what the real POST /analyze response for the same Signal maps to - which the server answers from storage (200, not 201) without a model call", ctl.last().status === "ready" && ctl.last().intelligence.safety.state === "LIFE_SAFETY_HAZARD" && /escalate to the emergency services/.test(ctl.last().intelligence.recommendation) && posted.status === 200 && JSON.stringify(ctl.last().intelligence) === JSON.stringify(mapIntelligenceAnalysis(posted.json.data)) && fake.analyzeCalls === callsAfterGeneration);
  const before = fake.analyzeCalls;
  for (let i = 0; i < 5; i += 1) await call("GET", `/intelligence?signalId=${sHaz._id}&workspaceId=${A}&limit=50`, operatorA);
  check("H3 opening / refreshing / revisiting (five more reads) costs ZERO model calls: the AI service was not contacted", fake.analyzeCalls === before && fake.analyzeCalls === callsAfterGeneration, `${fake.analyzeCalls} model calls in total (all from the set-up generations)`);
  const none = await call("GET", `/intelligence?signalId=${sNone._id}&workspaceId=${A}&limit=50`, operatorA);
  check("H4 a Signal with no analysis returns an empty list (the empty state) and generates nothing", none.status === 200 && Array.isArray(none.json.data) && none.json.data.length === 0 && fake.analyzeCalls === callsAfterGeneration);
  const viewerStaff = await call("GET", `/intelligence?signalId=${sHaz._id}&workspaceId=${A}&limit=50`, viewerA);
  const viewerGuest = await call("GET", `/intelligence?signalId=${sGuest._id}&workspaceId=${A}&limit=50`, viewerA);
  check("H5 a VIEWER (intelligence:view, no generate right) can READ a stored analysis at their own knowledge level; an analysis produced at a HIGHER level is hidden from them exactly as for the dashboard (an empty list, indistinguishable from none) - the existing visibility rule, unchanged", viewerGuest.status === 200 && viewerGuest.json.data.length === 1 && viewerStaff.status === 200 && viewerStaff.json.data.length === 0);
  const unauth = await call("GET", `/intelligence?signalId=${sHaz._id}&workspaceId=${A}&limit=50`, null);
  check("H6 no token -> 401 (the page shows 'Authentication required', not an empty state)", unauth.status === 401);
  const xOwn = await call("GET", `/intelligence?signalId=${sHaz._id}&workspaceId=${B}&limit=50`, adminB);
  const xOur = await call("GET", `/intelligence?signalId=${sHaz._id}&workspaceId=${A}&limit=50`, adminB);
  const leaked = JSON.stringify([xOwn.json, xOur.json]);
  check("H7 TENANT ISOLATION: another workspace's admin gets an empty list naming their own workspace and is refused naming ours - never our analysis or safety result", xOwn.status === 200 && xOwn.json.data.length === 0 && [403, 404].includes(xOur.status) && !/LIFE_SAFETY_HAZARD|escalat/i.test(leaked), `${xOwn.status}/${xOur.status}`);
  const noPost = fake.analyzeCalls;
  const wrongMethod = await call("POST", `/intelligence?signalId=${sHaz._id}&workspaceId=${A}`, operatorA);
  check("H8 the read endpoint cannot generate: POST to the collection is not a route (404/405), and the model was not called", [404, 405].includes(wrongMethod.status) && fake.analyzeCalls === noPost);
  const recordsForSignal = await Intelligence.countDocuments({ workspaceId: wsA._id, signalIds: sHaz._id });
  check("H9 reading did not create or change anything: still exactly one stored analysis for the Signal", recordsForSignal === 1);
  const payload = JSON.stringify(got.json);
  check("H10 the payload carries no secret, prompt, raw model output, provider/model name or guest/stay id", !/AIza|sk-[A-Za-z0-9]{20}|bearer|mongodb(\+srv)?:\/\/|"(?:prompt|rawResponse|provider|model|guestId|stayId|claims|sourceRefs|admission|safetyRules)"\s*:/i.test(payload));
  const protectedFiles = ["backend/src/services/ai/safetyPolicy.js", "backend/src/services/ai/claimValidator.js", "backend/src/services/ai/evidenceEnvelope.js", "backend/src/services/ai/confidencePolicy.js", "backend/src/services/ai/proseConsistency.js", "backend/src/services/ai/outputGuard.js"];
  const snapFile = process.env.P43C_SNAPSHOT;
  if (snapFile && fs.existsSync(snapFile)) {
    const crypto = await import("node:crypto"); const snap = JSON.parse(read(snapFile));
    check("H11 the protected safety / claim / evidence / confidence / prose / output files are byte-identical to their state before this phase", protectedFiles.every((f) => snap[f] && snap[f] === crypto.createHash("sha256").update(fs.readFileSync(path.join(REPO, f))).digest("hex")));
  } else console.log("INFO  H11 skipped: set P43C_SNAPSHOT to a {file: sha256} JSON taken before the phase");
} finally {
  if (child) child.kill();
  await vite.close();
  await new Promise((r) => stub.close(r));
  try { if (mongoose.connection.db.databaseName === DB_NAME) await mongoose.connection.dropDatabase(); } catch { /* best effort */ }
  await mongoose.disconnect();
}
console.log(`\nPhase 43C persisted-intelligence validation: ${passed} passed, ${failed} failed (isolated database ${DB_NAME} dropped)`);
process.exit(failed === 0 ? 0 : 1);
