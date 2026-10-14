/**
 * Phase 34A-B validation - approved provider/model policy, provider identity verification and the provider error
 * taxonomy (Node side; the Python side is ai-service/tests/test_provider_policy.py).
 *
 * LOCAL ONLY: zero Gemini calls, zero external network (a loopback HTTP server stands in for the AI service), zero database
 * access (no connection is ever opened - asserted at the end), no API key required.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import {
  APPROVED_MODEL, APPROVED_PROVIDER, TEST_PROVENANCE, acceptedProvenances, assertApprovedProvenance, assertProviderRouteAllowed, isApprovedProvenance,
} from "../src/config/providerPolicy.js";
import { getAiAnalysisTimeoutMs, getAiTimeoutMs } from "../src/config/runtimeConfig.js";
import { mapAiServiceError, requestAnalysisFromAiService } from "../src/services/ai/aiServiceClient.js";
import { validateAndVerifyAnalysis } from "../src/services/intelligenceAnalysisService.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(here, "..");
const REPO = path.join(BACKEND, "..");
const read = (p) => fs.readFileSync(p, "utf8");
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) { passed += 1; console.log(`PASS  ${name}`); } else { failed += 1; console.error(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`); }
};
const throwsApp = (fn) => { try { fn(); return null; } catch (e) { return e; } };
const withEnv = (patch, fn) => {
  const before = {};
  for (const [k, v] of Object.entries(patch)) { before[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return fn(); } finally { for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};
const quietly = (fn) => { const orig = console.error; const lines = []; console.error = (...a) => lines.push(a.join(" ")); try { return { value: fn(), lines }; } finally { console.error = orig; } };

const PROD = { developmentOrTest: false };
const DEV = { developmentOrTest: true };

// ---------------------------------------------------------------------------------------------------- 1. policy constants
check("1.1 approved provider/model are exactly gemini / gemini-3.1-flash-lite", APPROVED_PROVIDER === "gemini" && APPROVED_MODEL === "gemini-3.1-flash-lite");
const pyPolicy = read(path.join(REPO, "ai-service", "app", "provider_policy.py"));
check("1.2 Node and Python approved constants are identical (two processes, one policy)",
  pyPolicy.match(/^APPROVED_PROVIDER = "([^"]+)"/m)?.[1] === APPROVED_PROVIDER && pyPolicy.match(/^APPROVED_MODEL = "([^"]+)"/m)?.[1] === APPROVED_MODEL);
const pyStub = read(path.join(REPO, "ai-service", "app", "services", "deterministic_analysis.py"));
check("1.3 Node's accepted test identity equals the deterministic stub's real provenance",
  pyStub.includes(`Provenance(provider="${TEST_PROVENANCE.provider}", model="${TEST_PROVENANCE.model}")`));

const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".venv", "__pycache__", ".git"].includes(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out); else if (/\.(js|py)$/.test(e.name)) out.push(full);
  }
  return out;
};
const nodeSrc = walk(path.join(BACKEND, "src"));
const pySrc = walk(path.join(REPO, "ai-service", "app"));
const mentions = (files, needle) => files.filter((f) => read(f).includes(needle)).map((f) => path.relative(REPO, f).replace(/\\/g, "/"));
check("1.4 the approved model id has ONE authoritative location per process (not scattered)",
  JSON.stringify(mentions(nodeSrc, APPROVED_MODEL)) === JSON.stringify(["backend/src/config/providerPolicy.js"]) &&
  JSON.stringify(mentions(pySrc, APPROVED_MODEL)) === JSON.stringify(["ai-service/app/provider_policy.py"]),
  JSON.stringify([mentions(nodeSrc, APPROVED_MODEL), mentions(pySrc, APPROVED_MODEL)]));
check("1.5 no production source names gemini-3.6, a -preview id or a -latest alias as a model",
  [...nodeSrc, ...pySrc].every((f) => !/gemini-3\.6|gemini-3\.5|flash-lite-preview|flash-latest|flash-lite-latest/.test(stripComments(read(f)))));
check("1.6 the Python default model is the approved constant, not a literal 3.6", /llm_model: str = APPROVED_MODEL/.test(read(path.join(REPO, "ai-service", "app", "config.py"))));
check("1.7 ai-service/.env.example no longer teaches the 3.6 model", !/^LLM_MODEL=gemini-3\.6/m.test(read(path.join(REPO, "ai-service", ".env.example"))) && /^LLM_MODEL=gemini-3\.1-flash-lite$/m.test(read(path.join(REPO, "ai-service", ".env.example"))));

// ---------------------------------------------------------------------------------------------------- 2. identity checks
const good = { provider: APPROVED_PROVIDER, model: APPROVED_MODEL };
check("2.1 approved provider+model is accepted (production and dev/test)", isApprovedProvenance(good, PROD) && isApprovedProvenance(good, DEV));
check("2.2 the deterministic test identity is accepted ONLY in development/test, never in production",
  isApprovedProvenance(TEST_PROVENANCE, DEV) && !isApprovedProvenance(TEST_PROVENANCE, PROD));
check("2.3 production accepts exactly one identity; dev/test exactly two", acceptedProvenances(PROD).length === 1 && acceptedProvenances(DEV).length === 2);
const badModels = ["gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.1-flash-lite-preview", "gemini-flash-latest", "gemini-flash-lite-latest", "gemini-3.1-flash-lite-001", "GEMINI-3.1-FLASH-LITE", " gemini-3.1-flash-lite", "gemini-3.1-flash-lite ", "models/gemini-3.1-flash-lite", "gpt-4o-mini", "m", ""];
check("2.4 every non-approved model is rejected (3.6, preview, latest aliases, revisions, case/whitespace, arbitrary, empty)",
  badModels.every((model) => !isApprovedProvenance({ provider: APPROVED_PROVIDER, model }, DEV)), badModels.filter((m) => isApprovedProvenance({ provider: APPROVED_PROVIDER, model: m }, DEV)).join(","));
check("2.5 a mismatched provider is rejected even with the approved model",
  ["openai", "Gemini", "gemini ", "test", "", "google"].every((provider) => !isApprovedProvenance({ provider, model: APPROVED_MODEL }, PROD)));
check("2.6 malformed provenance is rejected (null, array, string, missing/non-string members)",
  [null, undefined, [], [good], "gemini", 7, {}, { provider: APPROVED_PROVIDER }, { model: APPROVED_MODEL }, { provider: 1, model: APPROVED_MODEL }, { provider: APPROVED_PROVIDER, model: ["x"] }, { provider: null, model: null }]
    .every((p) => !isApprovedProvenance(p, DEV)));

const mismatch = quietly(() => throwsApp(() => assertApprovedProvenance({ provider: APPROVED_PROVIDER, model: "gemini-3.6-flash" }, PROD)));
check("2.7 a mismatch throws a deterministic 502 PROVIDER_IDENTITY_MISMATCH whose client message names no model",
  mismatch.value?.statusCode === 502 && mismatch.value?.details?.code === "PROVIDER_IDENTITY_MISMATCH" && !/gemini|3\.6|flash/i.test(mismatch.value.message));
check("2.8 the log line carries only bounded printable metadata (hostile/oversized identity values are truncated and sanitized)", (() => {
  const hostile = quietly(() => throwsApp(() => assertApprovedProvenance({ provider: "x\u001b[31m\nINJECT", model: "m".repeat(5000) }, PROD)));
  const line = hostile.lines.join("\n");
  return hostile.value?.statusCode === 502 && line.length < 400 && !/[\u001b\n]INJECT/.test(line) && !line.includes("m".repeat(100));
})());
check("2.9 an approved identity does not throw and logs nothing", (() => { const r = quietly(() => throwsApp(() => assertApprovedProvenance(good, PROD))); return r.value === null && r.lines.length === 0; })());

check("2.10 production/unknown NODE_ENV: only the real `gemini` route is allowed; `test-python` is development/test only",
  throwsApp(() => assertProviderRouteAllowed("gemini", PROD)) === null &&
  throwsApp(() => assertProviderRouteAllowed("test-python", PROD))?.statusCode === 503 &&
  throwsApp(() => assertProviderRouteAllowed("test-python", DEV)) === null &&
  ["openai", "", "GEMINI", undefined].every((p) => throwsApp(() => assertProviderRouteAllowed(p, DEV))?.statusCode === 503));

// ---------------------------------------------------------------------------------------------------- 3. before persistence
const context = { signal: { id: "sig-1" }, history: { signals: [] } };
const history = { intelligence: [], decisions: [] };
// Phase 34C: validateAndVerifyAnalysis now also checks claim admissibility and the server safety minimum, so a "valid
// analysis" fixture carries a supported RECOMMENDATION claim plus urgency/action type. These checks are about PROVENANCE
// (identity), so every fixture here is otherwise fully admissible; the new guards have their own suite
// (validate-phase34c-evidence-guardrails.mjs).
const WORKSPACE = "64b0000000000000000000ff";
const GOOD_RAW = (provenance) => ({
  situation: "S", evidence: ["E"], impact: "I", recommendation: "R", confidence: "low", usedKnowledgeChunkIds: [], provenance,
  evidenceRefs: [{ type: "operational", field: "signal", refId: "sig-1" }], contradictions: [],
  claims: [{ claimType: "RECOMMENDATION", text: "R", sourceRefs: ["current:signal:sig-1"] }], urgency: "routine", recommendedActionType: "inspection",
});
const verify = (raw) => validateAndVerifyAnalysis(raw, { context, operationalHistory: history, knowledge: [], workspaceId: WORKSPACE });
withEnv({ NODE_ENV: "production" }, () => {
  check("3.1 production: approved identity passes validation + verification", (() => { try { return verify(GOOD_RAW(good)).provenance.model === APPROVED_MODEL; } catch { return false; } })());
  const r = quietly(() => throwsApp(() => verify(GOOD_RAW({ provider: APPROVED_PROVIDER, model: "gemini-3.6-flash" }))));
  check("3.2 production: a structurally VALID analysis with the wrong model is still rejected (non-empty strings are not enough)", r.value?.details?.code === "PROVIDER_IDENTITY_MISMATCH");
  check("3.3 production: the deterministic test provider's analysis is rejected", quietly(() => throwsApp(() => verify(GOOD_RAW({ ...TEST_PROVENANCE })))).value?.statusCode === 502);
});
withEnv({ NODE_ENV: "test" }, () => {
  check("3.4 test mode: the deterministic stub identity still works (existing harnesses unaffected)", (() => { try { return verify(GOOD_RAW({ ...TEST_PROVENANCE })).provenance.provider === "test"; } catch { return false; } })());
  check("3.5 test mode: any OTHER identity is still rejected", ["m", "gemini-3.6-flash"].every((model) => quietly(() => throwsApp(() => verify(GOOD_RAW({ provider: "test", model })))).value?.statusCode === 502));
});
withEnv({ NODE_ENV: undefined }, () => {
  check("3.6 an UNSET NODE_ENV is treated like production (test identity rejected)", quietly(() => throwsApp(() => verify(GOOD_RAW({ ...TEST_PROVENANCE })))).value?.statusCode === 502);
});
check("3.7 malformed provenance is rejected by the validator before the identity check (extra key, missing member, wrong type)",
  [{ provider: APPROVED_PROVIDER, model: APPROVED_MODEL, apiKey: "x" }, { provider: APPROVED_PROVIDER }, { model: APPROVED_MODEL }, "gemini", null, [], { provider: 1, model: 2 }]
    .every((p) => quietly(() => throwsApp(() => verify(GOOD_RAW(p)))).value?.statusCode === 502));

const svc = read(path.join(BACKEND, "src", "services", "intelligenceAnalysisService.js"));
const body = svc.slice(svc.indexOf("export async function analyzeSignal"));
const iVerify = body.indexOf("validateAndVerifyAnalysis(");
const iPersist = body.indexOf("createAnalysisIntelligence(");
check("3.8 persistence is reachable only AFTER verification: validateAndVerifyAnalysis precedes createAnalysisIntelligence, and no raw model value reaches persistence",
  iVerify > 0 && iPersist > iVerify && !/validateAnalysisResult\(/.test(body) && /provider: analysis\.provenance\.provider/.test(body));
check("3.9 analyzeSignal applies the request-time route policy before any retrieval or model call",
  body.indexOf("assertProviderRouteAllowed(provider)") > 0 && body.indexOf("assertProviderRouteAllowed(provider)") < body.indexOf("findInWorkspaceOr404(Signal"));
check("3.10 Learning stays OFF by default and was not touched by this step", !/getLearningContextEnabled\(\) \? .*true/.test(svc) && withEnv({ KOI_LEARNING_CONTEXT_ENABLED: undefined }, () => !read(path.join(BACKEND, "src", "config", "runtimeConfig.js")).includes("KOI_LEARNING_CONTEXT_ENABLED ?? \"true\"")));

// ---------------------------------------------------------------------------------------------------- 4. client cannot choose
const controller = stripComments(read(path.join(BACKEND, "src", "controllers", "intelligenceController.js")));
const analyzeHandler = controller.slice(controller.indexOf("export const analyzeSignal"));
check("4.1 the analyze controller reads only the signal id (path), the verified workspace and the role-derived level - never req.body/req.query",
  /req\.params\.signalId, req\.actor\.workspaceId/.test(analyzeHandler) && !/req\.(body|query)/.test(analyzeHandler));
const frontend = walk2(path.join(REPO, "frontend", "src"));
function walk2(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk2(full, out); else if (/\.(js|jsx)$/.test(e.name)) out.push(full);
  }
  return out;
}
const frontendCode = frontend.map((f) => stripComments(read(f))).join("\n");
check("4.2 the frontend names no model id, sends no provider/model field, and has no model selector",
  !/gemini-\d|flash-lite|llm_model|llmModel|modelSelector|selectedModel|fallbackModel/i.test(frontendCode) && !/analyzeSignal[^]*?(model|provider)\s*:/i.test(read(path.join(REPO, "frontend", "src", "services", "api.js")).slice(read(path.join(REPO, "frontend", "src", "services", "api.js")).indexOf("export function analyzeSignal"), read(path.join(REPO, "frontend", "src", "services", "api.js")).indexOf("export function analyzeSignal") + 400)));

// ---------------------------------------------------------------------------------------------------- 5. outbound body + taxonomy + timeouts (loopback)
let capture = null;
let respond = () => ({ status: 200, json: {} });
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    capture = { url: req.url, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") };
    const r = respond();
    if (r.hang) { return; }
    res.writeHead(r.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(r.json));
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
process.env.AI_SERVICE_URL = `http://127.0.0.1:${port}`;

const callAnalyze = async (env = {}) => withEnv({ AI_SERVICE_URL: process.env.AI_SERVICE_URL, ...env }, async () => {
  const before = Date.now();
  try { await requestAnalysisFromAiService({ signal: { id: "s" } }, [], "guest", { intelligence: [], decisions: [] }, undefined); return { ok: true, ms: Date.now() - before }; }
  catch (e) { return { ok: false, error: e, ms: Date.now() - before }; }
});

respond = () => ({ status: 200, json: { situation: "x" } });
const okCall = await callAnalyze();
check("5.1 the outbound analysis request carries ONLY {context, knowledge, authorizedLevel, operationalHistory} - no provider, no model, no learning when off",
  okCall.ok && JSON.stringify(Object.keys(capture.body).sort()) === JSON.stringify(["authorizedLevel", "context", "knowledge", "operationalHistory"]) && capture.url === "/v1/intelligence/analyze");

const TABLE = {
  PROVIDER_NOT_CONFIGURED: [503], PROVIDER_MODEL_NOT_APPROVED: [503], PROVIDER_AUTHENTICATION_FAILED: [503], PROVIDER_FORBIDDEN: [503],
  PROVIDER_RATE_LIMITED: [503], PROVIDER_TIMEOUT: [504], PROVIDER_UNAVAILABLE: [502], PROVIDER_ERROR: [502], PROVIDER_UNKNOWN_ERROR: [502],
  PROVIDER_BAD_REQUEST: [502], PROVIDER_IDENTITY_MISMATCH: [502], PROVIDER_SAFETY_BLOCK: [422], MALFORMED_RESPONSE: [502],
};
const mapped = {};
for (const [code, [expected]] of Object.entries(TABLE)) {
  respond = () => ({ status: 502, json: { error: { code, message: "SECRET-PROVIDER-DETAIL sk-123 gemini-3.6-flash" } } });
  const r = quietly(() => null); void r;
  const orig = console.error; console.error = () => {};
  const call = await callAnalyze();
  console.error = orig;
  mapped[code] = call.error;
  check(`5.2 ${code} -> HTTP ${expected} with details.code preserved and no provider detail leaked`,
    call.error?.statusCode === expected && call.error?.details?.code === code && !/SECRET|sk-123|3\.6|flash/i.test(call.error.message), `${call.error?.statusCode} ${call.error?.details?.code}`);
}
check("5.3 provider timeout (504), rate limit (503) and unavailable (502) are three distinct outcomes",
  new Set([mapped.PROVIDER_TIMEOUT, mapped.PROVIDER_RATE_LIMITED, mapped.PROVIDER_UNAVAILABLE].map((e) => `${e.statusCode}:${e.details.code}`)).size === 3);
check("5.4 all 13 taxonomy codes produce distinct details.code values", new Set(Object.values(mapped).map((e) => e.details.code)).size === 13);
respond = () => ({ status: 502, json: { error: { code: "SOMETHING_NEW" } } });
{ const orig = console.error; console.error = () => {}; const c = await callAnalyze(); console.error = orig;
  check("5.5 an unrecognised AI-service code is still a 502 invalid-response (unchanged fallback)", c.error?.statusCode === 502 && c.error?.details?.code === "AI_SERVICE_INVALID_RESPONSE"); }
respond = () => ({ status: 200, json: {} });
{ const origFetch = globalThis.fetch; globalThis.fetch = async () => ({ ok: true, json: async () => { throw new SyntaxError("bad json"); } });
  const c = await callAnalyze(); globalThis.fetch = origFetch;
  check("5.6 a non-JSON AI-service body is a 502 malformed response", c.error?.statusCode === 502); }
check("5.7 direct mapAiServiceError: missing/empty body and prototype-polluting codes fall back safely",
  [undefined, null, {}, { error: {} }, { error: { code: "__proto__" } }, { error: { code: "constructor" } }].every((b) => { const o = console.error; console.error = () => {}; const e = mapAiServiceError(b, 500); console.error = o; return e.statusCode === 502 && e.details.code === "AI_SERVICE_INVALID_RESPONSE"; }));

respond = () => ({ hang: true });
const base = getAiTimeoutMs();
check("5.8 timeout hierarchy (Workstream 5C): the analysis call waits LONGER than the deadline it must outlive (default = the 60 s analysis ceiling + 5 s = 65000), and no longer follows KOI_AI_TIMEOUT_MS (the per-call retrieval/embedding timeout); KOI_AI_ANALYSIS_TIMEOUT_MS sets it explicitly",
  withEnv({ KOI_AI_TIMEOUT_MS: undefined, KOI_AI_ANALYSIS_TIMEOUT_MS: undefined }, () => getAiAnalysisTimeoutMs() === 65000) && withEnv({ KOI_AI_TIMEOUT_MS: "500", KOI_AI_ANALYSIS_TIMEOUT_MS: undefined }, () => getAiAnalysisTimeoutMs() === 65000 && getAiTimeoutMs() === 500) &&
  withEnv({ KOI_AI_TIMEOUT_MS: "120000", KOI_AI_ANALYSIS_TIMEOUT_MS: undefined }, () => getAiAnalysisTimeoutMs() === 65000) && withEnv({ KOI_AI_ANALYSIS_TIMEOUT_MS: "250" }, () => getAiAnalysisTimeoutMs() === 250) && base === 20000);
{ const o = console.error; console.error = () => {};
  const hung = await callAnalyze({ KOI_AI_ANALYSIS_TIMEOUT_MS: "250" });
  console.error = o;
  check("5.9 a hung AI service is cut off at the analysis timeout (200 -> 250 ms) as a classified 504, not left open", hung.error?.statusCode === 504 && hung.error?.details?.code === "AI_SERVICE_TIMEOUT" && hung.ms >= 240 && hung.ms < 3000, `${hung.error?.statusCode} ${hung.ms}ms`); }
server.closeAllConnections?.();
server.close();

const client = stripComments(read(path.join(BACKEND, "src", "services", "ai", "aiServiceClient.js")));
check("5.10 no retry, backoff or circuit breaker was introduced: one fetch call site and no loop around it",
  (client.match(/fetch\(/g) || []).length === 1 && !/\b(for|while)\s*\(/.test(client.slice(client.indexOf("async function postToAiService"), client.indexOf("export async function requestEmbeddingsFromAiService"))) && !/backoff|circuit|retries|attempt/i.test(client));

// ---------------------------------------------------------------------------------------------------- 6. security
const touched = [
  path.join(BACKEND, "src", "config", "providerPolicy.js"), path.join(BACKEND, "src", "services", "ai", "aiServiceClient.js"), path.join(BACKEND, "src", "services", "intelligenceAnalysisService.js"),
  path.join(REPO, "ai-service", "app", "provider_policy.py"), path.join(REPO, "ai-service", "app", "services", "provider_errors.py"), path.join(REPO, "ai-service", "app", "services", "gemini_analysis_client.py"),
  path.join(REPO, "ai-service", "tests", "test_provider_policy.py"), path.join(REPO, "ai-service", ".env.example"), path.join(BACKEND, "scripts", "validate-phase34-provider-policy.mjs"),
];
check("6.1 no API-key-shaped string in any file this step created or changed", touched.every((f) => !/AIza[0-9A-Za-z_-]{20,}|sk-[A-Za-z0-9]{20,}/.test(read(f))));
check("6.2 the new code never reads an env file or logs a key", touched.filter((f) => /providerPolicy\.js|[\\/]provider_policy\.py|provider_errors\.py|aiServiceClient\.js/.test(f)).every((f) => !/readFileSync\([^)]*\.env|dotenv|GEMINI_API_KEY|api_key/i.test(stripComments(read(f)).replace(/settings\.gemini_api_key/g, ""))));
check("6.3 no tool, agent or execution capability was added (no child_process / exec / spawn in the new Node modules)",
  touched.filter((f) => f.endsWith(".js")).every((f) => !/child_process|\bexec\(|spawn\(/.test(stripComments(read(f)))));
check("6.4 no database connection was opened by this suite (readyState 0) and no model code path was exercised against one", mongoose.connection.readyState === 0);

console.log(`\nPhase 34A-B provider policy validation: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
