/**
 * Phase 43D validation - a rejected / failed analysis is presented in plain language; internal reason codes stay internal.
 *
 *   node backend/scripts/validate-phase43d-error-presentation.mjs
 *
 *   T  the closed mapping is TIED to the backend's own inventories (a new reachable code without a mapping fails here)
 *   U  unknown / hostile codes fall back safely; the raw value is never shown
 *   H  status handling (401 / 403 / 429 / provider failures / timeout / network / malformed)
 *   C  the controller, with hostile server messages: it shows only the fixed sentence, keeps status meanings, retries only on an explicit click
 *   S  static: no component renders a server message for a generation failure; no environment-variable names in the UI
 *   B  real HTTP on an ISOLATED database (koi_p43d_<stamp>, dropped at the end) through the real Node admission pipeline with a fake model service:
 *      the wire still carries the internal codes, the audit row still records them, nothing is persisted on a rejection, retry is an explicit second request.
 *      No Gemini, no key, no Atlas.
 */
import fs from "node:fs";
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

{ const __u = dotenv.parse(process.getBuiltinModule("node:fs").readFileSync(new URL("../.env", import.meta.url))).MONGODB_URI ?? ""; if (/^mongodb:\/\/(?:[^@/]*@)?(localhost|127\.0\.0\.1)/i.test(__u)) process.env.MONGODB_URI ??= __u; } // validation / rehearsal tools take ONLY a loopback database URI from backend/.env, never its real settings
const baseUri = process.env.MONGODB_URI;
const stamp = Date.now();
const DB_NAME = `koi_p43d_${stamp}`;
if (!baseUri || /^mongodb\+srv:|@/.test(baseUri) || !/^mongodb:\/\/(localhost|127\.0\.0\.1)/.test(baseUri)) { console.error("refusing: the configured MongoDB is not a plain loopback instance"); process.exit(2); }
process.env.MONGODB_URI = baseUri.replace(/(mongodb:\/\/[^/]+\/)([^?]*)/, `$1${DB_NAME}`);

const { createActor } = await import("./lib/authFixtures.mjs");
const mongoose = (await import("mongoose")).default;
const { connectDatabase } = await import("../src/config/database.js");
const { AnalysisAdmission, Intelligence, Signal, Workspace } = await import("../src/models/index.js");
const { KNOWN_FAILURE_CODES } = await import("../src/services/ai/analysisFailureTaxonomy.js");
const { CLAIM_RULE_CODES } = await import("../src/services/ai/claimValidator.js");
await connectDatabase();
if (mongoose.connection.db.databaseName !== DB_NAME) { console.error("refusing: not connected to the isolated database"); process.exit(2); }

const { createServer } = await import(pathToFileURL(path.join(FRONTEND, "node_modules", "vite", "dist", "node", "index.js")).href);
const vite = await createServer({ root: FRONTEND, configFile: path.join(FRONTEND, "vite.config.js"), server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom", logLevel: "silent", optimizeDeps: { noDiscovery: true, include: [] } });

let stub = null; let child = null;
try {
  const P = await vite.ssrLoadModule("/src/features/intelligence/intelligenceErrorPresentation.js");
  const { presentGenerationFailure, PRESENTED_FAILURES, GENERIC_FAILURE } = P;
  const { createSignalIntelligenceController } = await vite.ssrLoadModule("/src/features/intelligence/signalIntelligenceController.js");

  const OID = (n) => `6ac3${String(n).padStart(20, "0")}`;
  const RAW_CODES = [...KNOWN_FAILURE_CODES, ...CLAIM_RULE_CODES, "URGENCY_BELOW_MINIMUM", "ACTION_FORBIDDEN_BY_ACCESS_REFUSAL", "URGENCY_MISSING", "ACTION_TYPE_NOT_PERMITTED", "FORBIDDEN_DISPATCH_INSTRUCTED_IN_PROSE", "CLIENT_TIMEOUT", "CLIENT_NETWORK", "RATE_LIMITED", "INTERNAL_ERROR"];
  const ALL_SENTENCES = new Set();
  // every sentence this module can ever return (the closed set) - gathered by exercising every code, every rule and every status fallback
  for (const c of PRESENTED_FAILURES.codes) ALL_SENTENCES.add(presentGenerationFailure({ status: 502, code: c }).message);
  for (const r of PRESENTED_FAILURES.rules) ALL_SENTENCES.add(presentGenerationFailure({ status: 502, code: "CLAIM_VALIDATION_FAILED", rule: r }).message);
  for (const st of [0, 200, 400, 401, 403, 404, 409, 422, 429, 500, 502, 503, 504]) ALL_SENTENCES.add(presentGenerationFailure({ status: st, code: "SOME_FUTURE_CODE" }).message);
  const BAD_WORDS = /\b(claim|claims|validator|validation|schema|mongo|mongodb|stack|trace|provider|gemini|llm|env|token|objectid|workspace|rule|reason code)\b/i;

  // ============================================================================================================ T
  console.log("\n# T. the mapping is tied to the backend's inventories");
  check("T1 EVERY code in the backend's failure taxonomy (analysisFailureTaxonomy.js KNOWN_FAILURE_CODES) has a human-readable mapping", KNOWN_FAILURE_CODES.every((c) => PRESENTED_FAILURES.codes.includes(c)), `${KNOWN_FAILURE_CODES.length} codes`);
  check("T2 EVERY admissibility rule (claimValidator.js CLAIM_RULE_CODES) has a mapping", CLAIM_RULE_CODES.every((r) => PRESENTED_FAILURES.rules.includes(r)) && PRESENTED_FAILURES.rules.length === CLAIM_RULE_CODES.length, `${CLAIM_RULE_CODES.length} rules`);
  const clientSrc = read(path.join(BACKEND, "src", "services", "ai", "aiServiceClient.js"));
  const providerCodes = [...clientSrc.matchAll(/^\s{2}([A-Z][A-Z_]+): \[(\d{3}), /gm)].map((m) => m[1]);
  check("T3 EVERY provider error the Node client can map (the AI_SERVICE_ERRORS table, parsed from source) has a mapping", providerCodes.length >= 13 && providerCodes.every((c) => PRESENTED_FAILURES.codes.includes(c)), `${providerCodes.length} provider codes`);
  const throwCodes = new Set();
  for (const f of ["src/services/ai/claimValidator.js", "src/services/ai/outputGuard.js", "src/services/ai/proseConsistency.js", "src/services/ai/safetyPolicy.js", "src/services/ai/analysisSchema.js", "src/services/ai/aiServiceClient.js", "src/config/providerPolicy.js", "src/services/knowledgeRetrievalService.js"]) {
    const src = read(path.join(BACKEND, f));
    for (const m of src.matchAll(/code: *"([A-Z][A-Z_]+)"/g)) throwCodes.add(m[1]);
    for (const m of src.matchAll(/export const ([A-Z_]+) = "([A-Z][A-Z_]+)";/g)) if (/VIOLATION|FAILED|MISMATCH|EXHAUSTED/.test(m[1])) throwCodes.add(m[2]);
  }
  check("T4 every `details.code` the analysis path can throw (scanned from the throw sites) has a mapping - none can reach a user unmapped", [...throwCodes].every((c) => PRESENTED_FAILURES.codes.includes(c)), [...throwCodes].filter((c) => !PRESENTED_FAILURES.codes.includes(c)).join(",") || `${throwCodes.size} codes`);
  check("T5 the named rejections of the brief map as intended: URGENCY_BELOW_MINIMUM's wire code (SAFETY_POLICY_VIOLATION) -> safety; CLAIM_MISSING_SOURCE_REFS -> not enough evidence; CLAIM_INVALID_FACT_SUPPORT -> could not be verified; CLAIM_UNKNOWN_REF -> referenced unverifiable information; MALFORMED_RESPONSE -> could not be verified",
    /safety criteria/.test(presentGenerationFailure({ status: 502, code: "SAFETY_POLICY_VIOLATION" }).message) && /enough supporting evidence/.test(presentGenerationFailure({ status: 502, code: "CLAIM_VALIDATION_FAILED", rule: "CLAIM_MISSING_SOURCE_REFS" }).message) &&
    /verified against the available information/.test(presentGenerationFailure({ status: 502, code: "CLAIM_VALIDATION_FAILED", rule: "CLAIM_INVALID_FACT_SUPPORT" }).message) && /referenced information that could not be verified/.test(presentGenerationFailure({ status: 502, code: "CLAIM_VALIDATION_FAILED", rule: "CLAIM_UNKNOWN_REF" }).message) &&
    /could not be verified\. No analysis was saved/.test(presentGenerationFailure({ status: 502, code: "MALFORMED_RESPONSE" }).message));
  check("T6 every failure that is a rejection or an interrupted generation says that NOTHING was saved; the wording never claims a retry will succeed", [...ALL_SENTENCES].filter((m) => /could not be verified|did not meet|did not provide|referenced information|inconsistent|declined|could not be completed/.test(m)).every((m) => /No analysis was saved\./.test(m)) && ![...ALL_SENTENCES].some((m) => /will succeed|will work|guarantee/i.test(m)));
  check("T7 the mapping is a pure constant table: it takes no message, performs no pattern matching or text scanning, and imports nothing", !/\.test\(|\.match\(|\.includes\(|\.search\(|RegExp|toLowerCase|toUpperCase/.test(code(path.join(FRONTEND, "src", "features", "intelligence", "intelligenceErrorPresentation.js"))) && !/^\s*import\s/m.test(code(path.join(FRONTEND, "src", "features", "intelligence", "intelligenceErrorPresentation.js"))) && /presentGenerationFailure\(failure\)/.test(code(path.join(FRONTEND, "src", "features", "intelligence", "intelligenceErrorPresentation.js"))));

  // ============================================================================================================ U
  console.log("\n# U. unknown and hostile values");
  const HOSTILE = ["BRAND_NEW_FUTURE_CODE", "", null, undefined, 5, {}, [], "__proto__", "constructor", "toString", "hasOwnProperty", `current:stay:${OID(1)}`, `knowledge:${OID(2)}`, OID(3), "LLM_PROVIDER", "AI_SERVICE_URL", "mongodb://user:pw@host/db", "CLAIM_MISSING_SOURCE_REFS ", "claim_missing_source_refs", "Stack trace at /app/x.js:1"];
  const outs = HOSTILE.flatMap((c) => [presentGenerationFailure({ status: 502, code: c }), presentGenerationFailure({ status: 502, code: "CLAIM_VALIDATION_FAILED", rule: c }), presentGenerationFailure({ status: 500, code: "MALFORMED_RESPONSE", rule: c })]);
  check("U1 an unknown, malformed or hostile code or rule NEVER appears in the output, and always yields a constant sentence from the closed set", outs.every((o) => ALL_SENTENCES.has(o.message) && !HOSTILE.filter((h) => typeof h === "string" && h.length > 3).some((h) => o.message.includes(h) || o.title.includes(h))), `${outs.length} cases`);
  check("U2 an unknown code on a 5xx falls back to the fixed generic sentence ('could not be verified. No analysis was saved.')", presentGenerationFailure({ status: 500, code: "BRAND_NEW_FUTURE_CODE" }) === GENERIC_FAILURE && presentGenerationFailure({ status: 502, code: undefined }) === GENERIC_FAILURE);
  check("U3 a rule is honoured only for the codes it can refine; on any other code it is ignored (a stray rule cannot change the message)", presentGenerationFailure({ status: 502, code: "SAFETY_POLICY_VIOLATION", rule: "CLAIM_MISSING_SOURCE_REFS" }).message === presentGenerationFailure({ status: 502, code: "SAFETY_POLICY_VIOLATION" }).message && /enough supporting evidence/.test(presentGenerationFailure({ status: 502, code: "MALFORMED_RESPONSE", rule: "CLAIM_MISSING_SOURCE_REFS" }).message));
  check("U4 no output contains a raw reason-code-looking token, an ObjectId, an evidence reference, an environment-variable name, or implementation vocabulary", [...ALL_SENTENCES].every((m) => !/[A-Z]{3,}_[A-Z_]{2,}/.test(m) && !/[0-9a-f]{24}/i.test(m) && !/\b(?:current|untrusted|history|knowledge|learning):/.test(m) && !/LLM_PROVIDER|AI_SERVICE|MONGODB/.test(m) && !BAD_WORDS.test(m)), `${ALL_SENTENCES.size} sentences`);

  // ============================================================================================================ H
  console.log("\n# H. status handling");
  const t = (f) => presentGenerationFailure(f);
  check("H1 401 -> 'Your session has expired. Please sign in again.' (Phase 45B.2 wording) and 403 -> 'You are not authorized to perform this action.', whatever code or text came with them; neither offers a retry", t({ status: 401, code: "TOKEN_EXPIRED" }).message === "Your session has expired. Please sign in again." && t({ status: 403, code: "FORBIDDEN" }).message === "You are not authorized to perform this action." && !t({ status: 401 }).retryable && !t({ status: 403 }).retryable && t({ status: 401, code: "SAFETY_POLICY_VIOLATION" }).message === "Your session has expired. Please sign in again." && !/token|code|credential/i.test(t({ status: 401 }).message));
  check("H2 provider unavailable (PROVIDER_UNAVAILABLE / PROVIDER_ERROR / AI_SERVICE_UNREACHABLE) -> 'temporarily unavailable. Please try again.'", ["PROVIDER_UNAVAILABLE", "PROVIDER_ERROR", "AI_SERVICE_UNREACHABLE"].every((c) => /temporarily unavailable\. Please try again\./.test(t({ status: 502, code: c }).message) && t({ status: 502, code: c }).retryable));
  check("H3 timeouts (PROVIDER_TIMEOUT / AI_SERVICE_TIMEOUT / retrieval budget / client timeout) -> 'took too long to complete. Please try again.'", ["PROVIDER_TIMEOUT", "AI_SERVICE_TIMEOUT", "KNOWLEDGE_RETRIEVAL_BUDGET_EXHAUSTED", "CLIENT_TIMEOUT"].every((c) => /took too long to complete\. Please try again\./.test(t({ status: 504, code: c }).message)) && /took too long/.test(t({ status: 504, code: "SOME_NEW" }).message));
  check("H4 malformed output (MALFORMED_RESPONSE / AI_SERVICE_MALFORMED_RESPONSE / AI_SERVICE_INVALID_RESPONSE / ANALYSIS_SCHEMA_INVALID) -> 'could not be verified. No analysis was saved.'", ["MALFORMED_RESPONSE", "AI_SERVICE_MALFORMED_RESPONSE", "AI_SERVICE_INVALID_RESPONSE", "ANALYSIS_SCHEMA_INVALID"].every((c) => t({ status: 502, code: c }).message === GENERIC_FAILURE.message));
  check("H5 a network failure and a timeout of the CLIENT are told apart without reading any message (CLIENT_NETWORK vs CLIENT_TIMEOUT) - and a rate limit is its own message", /Cannot reach the EOI service/.test(t({ status: 0, code: "CLIENT_NETWORK" }).message) && /took too long/.test(t({ status: 0, code: "CLIENT_TIMEOUT" }).message) && /busy/.test(t({ status: 429, code: "RATE_LIMITED" }).message) && /busy/.test(t({ status: 503, code: "PROVIDER_RATE_LIMITED" }).message));
  check("H6 server-side configuration problems (not configured / model or route not approved / provider auth) are one 'isn't available right now. Please contact your administrator.' - no retry offered, and no environment-variable name", ["AI_SERVICE_NOT_CONFIGURED", "PROVIDER_NOT_CONFIGURED", "PROVIDER_MODEL_NOT_APPROVED", "PROVIDER_ROUTE_NOT_APPROVED", "PROVIDER_AUTHENTICATION_FAILED", "PROVIDER_FORBIDDEN"].every((c) => /contact your administrator/.test(t({ status: 503, code: c }).message) && !t({ status: 503, code: c }).retryable));
  check("H7 the provider declining the content (PROVIDER_SAFETY_BLOCK) is distinct from our own safety rejection, and neither says anything is 'safe'", /declined to analyse/.test(t({ status: 422, code: "PROVIDER_SAFETY_BLOCK" }).message) && /required safety criteria/.test(t({ status: 502, code: "SAFETY_POLICY_VIOLATION" }).message) && ![...ALL_SENTENCES].some((m) => /\bsafe\b|no risk|no hazard/i.test(m)));
  check("H8 validation rejections offer a retry (a later answer may differ) but only as a possibility: the title is 'Analysis couldn't be completed'", t({ status: 502, code: "CLAIM_VALIDATION_FAILED", rule: "CLAIM_UNKNOWN_REF" }).retryable === true && t({ status: 502, code: "SAFETY_POLICY_VIOLATION" }).title === "Analysis couldn't be completed");

  // ============================================================================================================ C
  console.log("\n# C. the controller shows only the fixed sentence");
  const SERVER_TEXT = `AI service returned an invalid analysis (claims[0] cites knowledge:${OID(30)} which was not supplied) CLAIM_UNKNOWN_REF URGENCY_BELOW_MINIMUM current:stay:${OID(40)} LLM_PROVIDER AI_SERVICE_URL`;
  const apiErr = (status, codeValue, rule, message = SERVER_TEXT) => Object.assign(new Error(message), { name: "ApiError", status, code: codeValue, rule });
  const mkCtl = (analyzeFn, over = {}) => { const calls = { analyze: 0, list: 0 }; const states = []; const controller = createSignalIntelligenceController({ signalId: OID(1), workspaceId: OID(7), configured: true, onChange: (s) => states.push(s), api: { listStored: async () => { calls.list += 1; return []; }, analyze: async () => { calls.analyze += 1; return analyzeFn(calls.analyze); } }, ...over }); return { controller, calls, states, last: () => states.at(-1) }; };
  {
    const m = mkCtl(() => { throw apiErr(502, "SAFETY_POLICY_VIOLATION"); }); await m.controller.load(); await m.controller.generate();
    const s = m.last(); const dump = JSON.stringify({ error: s.error, failure: s.failure, intelligence: s.intelligence, loadReason: s.loadReason });
    check("C1 a rejected generation: status 'error', the fixed safety sentence, retryable, NOTHING from the server text anywhere in the state (no code, no reference, no ObjectId, no env name)", s.status === "error" && /required safety criteria/.test(s.error) && s.failure.retryable === true && s.intelligence === null && !/URGENCY_BELOW|CLAIM_|knowledge:|current:stay|LLM_PROVIDER|AI_SERVICE_URL|[0-9a-f]{24}/.test(dump));
  }
  {
    const cases = [[502, "CLAIM_VALIDATION_FAILED", "CLAIM_MISSING_SOURCE_REFS", /enough supporting evidence/], [502, "CLAIM_VALIDATION_FAILED", "CLAIM_INVALID_FACT_SUPPORT", /verified against the available information/], [502, "CLAIM_VALIDATION_FAILED", "CLAIM_UNKNOWN_REF", /referenced information/], [502, "SAFETY_POLICY_VIOLATION", undefined, /safety criteria/], [502, "MALFORMED_RESPONSE", undefined, /could not be verified\. No analysis was saved/], [502, "BRAND_NEW_FUTURE_CODE", "BRAND_NEW_RULE", /could not be verified\. No analysis was saved/]];
    const ok = [];
    for (const [st, c, r, re] of cases) { const m = mkCtl(() => { throw apiErr(st, c, r); }); await m.controller.load(); await m.controller.generate(); ok.push(re.test(m.last().error) && !JSON.stringify(m.last()).match(/CLAIM_|BRAND_NEW|URGENCY_|SAFETY_POLICY|MALFORMED_RESPONSE|knowledge:/)); }
    check("C2 each rejection class shows its own sentence through the controller, and an unknown future code/rule shows the safe generic one - the raw code is never in the state", ok.every(Boolean), ok.join(","));
  }
  {
    const st = [];
    for (const [status, c, expected] of [[503, "AI_SERVICE_NOT_CONFIGURED", "unconfigured"], [403, "FORBIDDEN", "forbidden"], [401, "MISSING_CREDENTIAL", "error"], [504, "AI_SERVICE_TIMEOUT", "error"], [502, "PROVIDER_UNAVAILABLE", "error"], [429, "RATE_LIMITED", "error"], [0, "CLIENT_NETWORK", "error"]]) { const m = mkCtl(() => { throw apiErr(status, c); }); await m.controller.load(); await m.controller.generate(); st.push(m.last().status === expected); }
    check("C3 the existing status meanings are preserved (503 -> 'unconfigured', 403 -> 'forbidden', the rest 'error') - only the WORDS changed", st.every(Boolean), st.join(","));
  }
  {
    const m = mkCtl((n) => { if (n === 1) throw apiErr(502, "CLAIM_VALIDATION_FAILED", "CLAIM_MISSING_SOURCE_REFS"); return { _id: OID(50), analysisVersion: "intelligence-v1", analysisLevel: "staff", createdAt: "2026-10-05T10:00:00Z", analysis: { situation: "S", evidence: ["E"], impact: "I", recommendation: "R", confidence: "low" }, safety: { state: "NORMAL", urgency: "prompt", recommendedActionType: "inspection" } }; });
    await m.controller.load(); await m.controller.generate();
    const afterFail = { status: m.last().status, analyze: m.calls.analyze };
    for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
    const idleCalls = m.calls.analyze;
    await m.controller.generate();
    check("C4 RETRY is explicit only: after a rejection nothing is retried on its own (20 idle turns later still ONE request), and a later click makes exactly ONE more request and succeeds", afterFail.status === "error" && afterFail.analyze === 1 && idleCalls === 1 && m.calls.analyze === 2 && m.last().status === "ready" && m.last().failure === null && m.last().intelligence.recommendation === "R");
    check("C5 the success path is unchanged: a successful retry shows the analysis with its safety result and no leftover error", m.last().intelligence.safety.state === "NORMAL" && m.last().error === null);
    const refresh = mkCtl(() => { throw new Error("must not be called"); }); await refresh.controller.load();
    check("C6 REFRESH after a rejection: the read finds nothing, so the empty state shows - no rejected result is fabricated and no generation is made", refresh.last().status === "idle" && refresh.last().intelligence === null && refresh.calls.analyze === 0);
  }

  // ============================================================================================================ S
  console.log("\n# S. static guarantees");
  const ctlSrc = code(path.join(FRONTEND, "src", "features", "intelligence", "signalIntelligenceController.js"));
  const pageSrc = code(path.join(FRONTEND, "src", "features", "assistant", "SignalCaseCard.jsx")); // Phase 52: the assistant's case card (failures come from useCaseGeneration, which uses presentGenerationFailure)
  const hookSrc = code(path.join(FRONTEND, "src", "features", "intelligence", "useSignalIntelligence.js"));
  const apiSrc = code(path.join(FRONTEND, "src", "services", "api.js"));
  check("S1 the controller never reads or shows the server's message for a generation failure (no `err.message`), and builds the error only from presentGenerationFailure", !/\berr\??\.message\b|\berror\??\.message\b|\be\??\.message\b/.test(ctlSrc) && /presentGenerationFailure\(err\)/.test(ctlSrc));
  check("S2 the page renders a generation failure only from the fixed `failure` object: no raw error / message field, no `.message` of an error", /failure\.title/.test(pageSrc) && /failure\.message/.test(pageSrc) && !/intelError|err\.message|error\.message/.test(pageSrc) && /presentGenerationFailure\(error\)/.test(code(path.join(FRONTEND, "src", "features", "assistant", "analysisAttemptController.js"))) && /createAnalysisAttemptController/.test(code(path.join(FRONTEND, "src", "features", "assistant", "useCaseGeneration.js"))));
  check("S3 the UI no longer shows environment-variable names (LLM_PROVIDER, AI_SERVICE_URL) anywhere in the page or controller", !/LLM_PROVIDER|AI_SERVICE_URL|MONGODB_URI/.test(pageSrc + ctlSrc + hookSrc));
  check("S4 the API client passes the STRUCTURED fields (status, details.code, details.rule) to the error, and tells a client timeout from an unreachable backend by code, not by message", /data\?\.details\?\.code, data\?\.details\?\.rule/.test(apiSrc) && /"CLIENT_TIMEOUT"/.test(apiSrc) && /"CLIENT_NETWORK"/.test(apiSrc));
  check("S5 the Retry button appears only where retryable and is an explicit click (no effect, timer or loop calls generate)", /failure\.retryable \?/.test(pageSrc) && (pageSrc.match(/onClick=\{onGenerate\}/g) || []).length >= 1 && !/setTimeout|setInterval/.test(pageSrc + ctlSrc) && !/useEffect/.test(ctlSrc) && (pageSrc.match(/useEffect\(/g) || []).length === 2 && /useEffect\(\(\) => \{\s*if \(noAssessmentShown\) onObserve\?\.\(signalId\);\s*return \(\) => onRelease\?\.\(signalId\);\s*\}, \[noAssessmentShown, signalId, onObserve, onRelease\]\);/.test(pageSrc) && !/useEffect\([^)]*\bonGenerate\b|useEffect\(\(\) => \{[^}]*\bgenerate\(/.test(pageSrc));

  // ============================================================================================================ B. real HTTP
  console.log("\n# B. the real pipeline on an isolated database");
  const { spawn: sp } = await import("node:child_process");
  stub = sp(process.execPath, [path.join(BACKEND, "scripts", "phase43b2", "ai-safety-stub.mjs")], { stdio: "ignore" });
  for (let i = 0; i < 50; i += 1) { try { if ((await fetch("http://localhost:5095/v1/health")).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 100)); }
  const stats = async () => (await (await fetch("http://localhost:5095/__stats")).json()).analyzeCalls;
  process.env.AI_SERVICE_URL = "http://localhost:5095"; process.env.LLM_PROVIDER = "test-python";
  child = spawn(process.execPath, [path.join(BACKEND, "server.js")], { env: { ...process.env, PORT: "5088", LLM_PROVIDER: "test-python", AI_SERVICE_URL: "http://localhost:5095", KNOWLEDGE_DEV_AUTHORIZED_LEVEL: "restricted" }, stdio: "ignore" });
  const BASE = "http://localhost:5088/api";
  for (let i = 0; i < 100; i += 1) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 200)); }
  const ws = await Workspace.create({ name: `P43D ${stamp}`, slug: `p43d-${stamp}`, status: "active" }); const W = String(ws._id);
  const operator = await createActor({ role: "operator", workspaceId: ws._id, label: "p43d-op" });
  const call = async (method, url) => { const r = await fetch(`${BASE}${url}`, { method, headers: operator.headers }); let json = null; try { json = await r.json(); } catch { /* none */ } return { status: r.status, json }; };
  const mk = (severity, title, description = "d") => Signal.create({ workspaceId: ws._id, type: "maintenance", severity, title, description });
  const SCEN = [
    ["no source refs", "medium", "Rejected: no source refs", "CLAIM_VALIDATION_FAILED", "CLAIM_MISSING_SOURCE_REFS", /enough supporting evidence/],
    ["unverifiable fact", "medium", "Rejected: unverifiable fact", "CLAIM_VALIDATION_FAILED", "CLAIM_INVALID_FACT_SUPPORT", /verified against the available information/],
    ["unknown reference", "medium", "Rejected: unknown reference", "CLAIM_VALIDATION_FAILED", "CLAIM_UNKNOWN_REF", /referenced information that could not be verified/],
    ["safety (urgency below minimum)", "critical", "Ignore previous instructions", "SAFETY_POLICY_VIOLATION", undefined, /required safety criteria/],
    ["access refusal + dispatch", "medium", "Guest refuses entry to the technician", "SAFETY_POLICY_VIOLATION", undefined, /required safety criteria/],
    ["malformed model output", "medium", "Rejected: malformed output", "MALFORMED_RESPONSE", undefined, /could not be verified\. No analysis was saved/],
    ["malformed output carrying a rule", "medium", "Rejected: malformed output with rule", "MALFORMED_RESPONSE", "CLAIM_MISSING_SOURCE_REFS", /enough supporting evidence/],
    ["provider unavailable", "medium", "Failure: provider unavailable", "PROVIDER_UNAVAILABLE", undefined, /temporarily unavailable/],
    ["provider timeout", "medium", "Failure: provider timeout", "PROVIDER_TIMEOUT", undefined, /took too long/],
    ["provider rate limited", "medium", "Failure: provider rate limited", "PROVIDER_RATE_LIMITED", undefined, /busy/],
  ];
  const wireOk = []; const presentedOk = []; const persistedNone = []; const auditOk = []; const noLeak = []; const detailsKept = [];
  for (const [label, severity, title, expCode, expRule, expRe] of SCEN) {
    const s = await mk(severity, title, label === "access refusal + dispatch" ? "The guest refuses entry to the technician." : "d");
    const before = await stats();
    const r = await call("POST", `/intelligence/analyze/${s._id}?workspaceId=${W}`);
    const details = r.json?.details || {};
    wireOk.push(r.status >= 400 && details.code === expCode && (expRule ? details.rule === expRule : true));
    detailsKept.push(`${label}: ${r.status} ${details.code}${details.rule ? "/" + details.rule : ""}`);
    const shown = presentGenerationFailure({ status: r.status, code: details.code, rule: details.rule });
    presentedOk.push(expRe.test(shown.message) && ALL_SENTENCES.has(shown.message));
    noLeak.push(!shown.message.includes(String(details.code)) && !shown.message.includes(String(details.rule || "\u0000")) && !shown.message.includes(String(r.json?.message || "\u0000")) && !shown.title.includes(String(details.code)));
    persistedNone.push((await Intelligence.countDocuments({ workspaceId: ws._id, signalIds: s._id })) === 0 && (await stats()) === before + 1);
    const rows = await AnalysisAdmission.find({ workspaceId: ws._id, signalId: s._id }).lean();
    // the audit row of a REJECTED attempt keeps the internal reason; a provider failure that never produced an analysis keeps its failure class
    auditOk.push(rows.length === 1 && rows[0].outcome === "rejected" && typeof rows[0].reasonCode === "string" && rows[0].reasonCode.length > 0 && (expRule && expCode === "CLAIM_VALIDATION_FAILED" ? rows[0].reasonRule === expRule || rows[0].reasonCode === expCode : true));
    const list = await call("GET", `/intelligence?signalId=${s._id}&workspaceId=${W}&limit=50`);
    persistedNone[persistedNone.length - 1] = persistedNone.at(-1) && list.status === 200 && list.json.data.length === 0;
  }
  console.log("      wire:", detailsKept.join(" | "));
  check("B1 INTERNAL CODES STAY INTERNAL BUT AVAILABLE: for every rejection / failure class the HTTP response still carries the deterministic `details.code` (and `details.rule` where there is one) - the backend was not changed", wireOk.every(Boolean), wireOk.join(","));
  check("B2 every one of those real responses is shown as a fixed, human-readable sentence from the closed set", presentedOk.every(Boolean), presentedOk.join(","));
  check("B3 the presented text contains neither the code, the rule nor the server's own message", noLeak.every(Boolean));
  check("B4 NOTHING IS PERSISTED on a rejection or failure: zero Intelligence records for the Signal, a read of the Signal's analyses is empty (refresh shows the empty state), and the model was asked exactly once", persistedNone.every(Boolean), persistedNone.join(","));
  check("B5 the server-side audit (AnalysisAdmission) still records every attempt as 'rejected' with its internal reason code - the diagnostic path is intact", auditOk.every(Boolean), auditOk.join(","));

  const sRetry = await mk("medium", "Fails once then works");
  const c0 = await stats();
  const first = await call("POST", `/intelligence/analyze/${sRetry._id}?workspaceId=${W}`);
  const countAfterFirst = await Intelligence.countDocuments({ workspaceId: ws._id, signalIds: sRetry._id });
  await new Promise((r) => setTimeout(r, 400));
  const c1 = await stats();
  const second = await call("POST", `/intelligence/analyze/${sRetry._id}?workspaceId=${W}`);
  const c2 = await stats();
  const listed = await call("GET", `/intelligence?signalId=${sRetry._id}&workspaceId=${W}&limit=50`);
  check("B6 EXPLICIT RETRY: the first request is rejected and stores nothing; with no further action the model is not asked again; one explicit second request is ONE new model call and is accepted (201) with its safety result", first.status === 502 && countAfterFirst === 0 && c1 === c0 + 1 && second.status === 201 && c2 === c1 + 1 && second.json.data.safety?.state === "NORMAL", `${first.status}/${second.status}`);
  check("B7 after the successful retry exactly ONE Intelligence record exists and a read returns it (the persisted-load behaviour of Phase 43C is intact)", (await Intelligence.countDocuments({ workspaceId: ws._id, signalIds: sRetry._id })) === 1 && listed.json.data.length === 1 && listed.json.data[0].analysis.recommendation === "Have the unit checked.");
  const sHaz = await mk("medium", "Strong smell of gas in the kitchen", "The guest reports a strong smell of gas.");
  const haz = await call("POST", `/intelligence/analyze/${sHaz._id}?workspaceId=${W}`);
  check("B8 SUCCESS UNCHANGED: an accepted life-safety analysis still returns 201 with its structured safety result (LIFE_SAFETY_HAZARD, immediate, escalation) and the recommendation", haz.status === 201 && haz.json.data.safety.state === "LIFE_SAFETY_HAZARD" && haz.json.data.safety.urgency === "immediate" && haz.json.data.safety.recommendedActionType === "escalation" && /escalate/.test(haz.json.data.analysis.recommendation));
  const unauth = await fetch(`${BASE}/intelligence/analyze/${sHaz._id}?workspaceId=${W}`, { method: "POST" });
  check("B9 an unauthenticated request is 401 and the presenter says 'Your session has expired. Please sign in again.'", unauth.status === 401 && presentGenerationFailure({ status: 401, code: (await unauth.json()).details?.code }).message === "Your session has expired. Please sign in again.");
  const protectedFiles = ["backend/src/services/ai/safetyPolicy.js", "backend/src/services/ai/claimValidator.js", "backend/src/services/ai/evidenceEnvelope.js", "backend/src/services/ai/confidencePolicy.js", "backend/src/services/ai/proseConsistency.js", "backend/src/services/ai/outputGuard.js"];
  const snapFile = process.env.P43D_SNAPSHOT;
  if (snapFile && fs.existsSync(snapFile)) {
    const crypto = await import("node:crypto"); const snap = JSON.parse(read(snapFile));
    check("B10 the protected safety / claim / evidence / confidence / prose / output files (and so every reason code they define) are byte-identical to their state before this phase", protectedFiles.every((f) => snap[f] && snap[f] === crypto.createHash("sha256").update(fs.readFileSync(path.join(REPO, f))).digest("hex")));
  } else console.log("INFO  B10 skipped: set P43D_SNAPSHOT to a {file: sha256} JSON taken before the phase");
} finally {
  if (child) child.kill();
  if (stub) stub.kill();
  await vite.close();
  try { if (mongoose.connection.db.databaseName === DB_NAME) await mongoose.connection.dropDatabase(); } catch { /* best effort */ }
  await mongoose.disconnect();
}
console.log(`\nPhase 43D error presentation validation: ${passed} passed, ${failed} failed (isolated database ${DB_NAME} dropped)`);
process.exit(failed === 0 ? 0 : 1);
