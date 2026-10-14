/**
 * Phase 35 validation - auditability, provider reliability, human governance, knowledge relevance, test hygiene.
 *
 *   node backend/scripts/validate-phase35-audit-governance.mjs
 *
 * Real MongoDB (the local dev database; own throwaway workspaces, removed by id), a real spawned backend for the HTTP governance checks
 * (stub authentication, test-python route, no AI service behind it), and a DETERMINISTIC in-process stub AI service for the analysis
 * audit checks. It never calls Gemini and never needs a key. The stub reports the APPROVED identity (gemini / gemini-3.1-flash-lite) so the
 * strict Phase 34 validation runs - it does not invent a provenance the contract would not accept.
 *
 * Nothing is wiped: every record is created with a unique stamp and deleted by id, and pre-existing collections are counted before and after.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
// authFixtures first: it declares NODE_ENV=test and the stub verifier for everything below.
import { cleanupAuthFixtures, createActor, sweepOrphanAdmissions, sweepStaleAuthFixtures } from "./lib/authFixtures.mjs";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { STUB_ISSUER } from "../src/auth/stubTokenVerifier.js";
import { ROLE_PERMISSIONS } from "../src/auth/roles.js";
import { AnalysisAdmission, Action, Decision, Intelligence, KnowledgeChunk, Signal, User, Workspace, WorkspaceMembership } from "../src/models/index.js";
import { APPROVED_MODEL, APPROVED_PROVIDER, assertApprovedProvenance } from "../src/config/providerPolicy.js";
import { AI_ANALYSIS_DEADLINE_CEILING_MS, AI_PROVIDER_TIMEOUT_CEILING_MS, RETRIEVAL_MAX_PAGES, getAnalysisTimeBudget, getLearningContextEnabled, nextRetrievalCallTimeoutMs } from "../src/config/runtimeConfig.js";
import { timeoutBudgetProblems } from "../src/config/startupChecks.js";
import { requestAnalysisFromAiService, mapAiServiceError } from "../src/services/ai/aiServiceClient.js";
import { FAILURE_CLASSES, KNOWN_FAILURE_CODES, classifyFailureCode } from "../src/services/ai/analysisFailureTaxonomy.js";
import { buildEvidenceEnvelope } from "../src/services/ai/evidenceEnvelope.js";
import { deriveConfidenceCeiling } from "../src/services/ai/confidencePolicy.js";
import { CANDIDATE_PAGE_SIZE, MAX_ELIGIBLE_CANDIDATES, RETRIEVAL_BUDGET_EXHAUSTED, scoreKnowledgeForContext } from "../src/services/knowledgeRetrievalService.js";
import { getAdmissionAuditFailureCount, getAnalysisAdmissionByAttempt, listAnalysisAdmissions, resetAdmissionAuditFailureCount } from "../src/services/analysisAdmissionService.js";
import { WORKSPACE_DELETION_ORDER, countWorkspaceData } from "../src/services/workspaceLifecycleService.js";
import { analyzeSignal, validateAndVerifyAnalysis } from "../src/services/intelligenceAnalysisService.js";
import { GOVERNANCE_VERSION, assertReviewerIsNotProposer } from "../src/services/governance.js";
import { proposeDecision } from "../src/services/decisionService.js";
import { proposeAction } from "../src/services/actionService.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(here, "..");
const REPO = path.join(BACKEND, "..");
const read = (p) => fs.readFileSync(p, "utf8");
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) { passed += 1; console.log(`PASS  ${name}${detail ? ` - ${detail}` : ""}`); } else { failed += 1; console.error(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`); }
};
const realConsoleError = console.error;
let mutedDepth = 0;
// Re-entrant: concurrent callers share one mute and the REAL console.error is restored when the last one finishes.
const quietly = async (fn) => { mutedDepth += 1; console.error = () => {}; try { return await fn(); } finally { mutedDepth -= 1; if (mutedDepth === 0) console.error = realConsoleError; } };
const caught = async (fn) => quietly(async () => { try { await fn(); return null; } catch (e) { return e; } });
const withEnv = async (patch, fn) => {
  const saved = Object.fromEntries(Object.keys(patch).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};

// The real provider route, taken from the policy constant: the Phase 33 static guard forbids a literal `LLM_PROVIDER: "..."` for it under backend/scripts.
const REAL_ROUTE = APPROVED_PROVIDER;
const stamp = Date.now();
const FIX = JSON.parse(read(path.join(REPO, "ai-service", "tests", "fixtures", "evidence_catalog_parity.json")));

// ====================================================================================================== A. PROVIDER RELIABILITY (no DB)
console.log("\n# A. provider reliability");
const NINE = ["configuration", "authentication", "invalid_request", "provider_unavailable", "provider_timeout", "rate_limit", "malformed_response", "validation_failure", "internal"];
check("A1 the failure taxonomy is a closed set that contains every class operations must tell apart", NINE.every((c) => FAILURE_CLASSES.includes(c)) && FAILURE_CLASSES.includes("safety_block"));
const providerCodes = ["PROVIDER_NOT_CONFIGURED", "PROVIDER_MODEL_NOT_APPROVED", "PROVIDER_AUTHENTICATION_FAILED", "PROVIDER_FORBIDDEN", "PROVIDER_RATE_LIMITED", "PROVIDER_TIMEOUT", "PROVIDER_UNAVAILABLE", "PROVIDER_ERROR", "PROVIDER_BAD_REQUEST", "PROVIDER_IDENTITY_MISMATCH", "PROVIDER_SAFETY_BLOCK", "MALFORMED_RESPONSE"];
check("A2 every code the AI service can return maps to exactly one class, and none silently falls to 'internal' except an unknown provider error",
  providerCodes.every((code) => KNOWN_FAILURE_CODES.includes(code) && classifyFailureCode(code) !== "internal") && classifyFailureCode("PROVIDER_UNKNOWN_ERROR") === "internal");
check("A3 the classes are the ones operations need: config / auth / invalid request / unavailable / timeout / rate limit / malformed / validation / internal",
  classifyFailureCode("PROVIDER_NOT_CONFIGURED") === "configuration" && classifyFailureCode("PROVIDER_AUTHENTICATION_FAILED") === "authentication" && classifyFailureCode("PROVIDER_BAD_REQUEST") === "invalid_request" &&
  classifyFailureCode("PROVIDER_UNAVAILABLE") === "provider_unavailable" && classifyFailureCode("PROVIDER_TIMEOUT") === "provider_timeout" && classifyFailureCode("PROVIDER_RATE_LIMITED") === "rate_limit" &&
  classifyFailureCode("MALFORMED_RESPONSE") === "malformed_response" && classifyFailureCode("CLAIM_VALIDATION_FAILED") === "validation_failure" && classifyFailureCode("ANALYSIS_SCHEMA_INVALID") === "validation_failure" && classifyFailureCode("NOT_A_CODE") === "internal");
check("A4 the Node-side mapping keeps each AI-service code distinct and gives it a class (no collapse into one generic error)",
  providerCodes.filter((c) => c !== "PROVIDER_IDENTITY_MISMATCH" || true).every((code) => { const e = mapAiServiceError({ error: { code } }, 502); return e.details?.code === code && classifyFailureCode(e.details.code) !== undefined; }) &&
  new Set(providerCodes.map((c) => classifyFailureCode(c))).size >= 8);
let e = await caught(() => withEnv({ AI_SERVICE_URL: "" }, () => requestAnalysisFromAiService(FIX.input.context, [], "staff")));
check("A5 a missing AI_SERVICE_URL is a classified configuration error (503 AI_SERVICE_NOT_CONFIGURED)", e?.statusCode === 503 && e.details?.code === "AI_SERVICE_NOT_CONFIGURED" && classifyFailureCode(e.details.code) === "configuration");

// ----- the deterministic stub AI service used by A6-A8 and the audit checks
const fake = { mode: "ok", calls: 0, last: null, hung: new Set(), retrievalCalls: 0, retrievalDelayMs: 0, analyzeCalls: 0 };
const stub = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* not JSON */ }
    fake.calls += 1; fake.last = body;
    const send = (status, payload) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(typeof payload === "string" ? payload : JSON.stringify(payload)); };
    if (req.url.endsWith("/v1/knowledge-retrieval")) {
      fake.retrievalCalls += 1;
      return setTimeout(() => send(200, { results: [], model: "stub-model", evaluatedCandidates: (body.candidates || []).length, incompatibleCandidates: 0 }), fake.retrievalDelayMs);
    }
    if (!req.url.endsWith("/v1/intelligence/analyze")) return send(404, { error: { code: "MALFORMED_RESPONSE", message: "unexpected" } });
    fake.analyzeCalls += 1;
    if (fake.mode === "ratelimit") return send(429, { error: { code: "PROVIDER_RATE_LIMITED", message: "slow down" } });
    if (fake.mode === "garbage") return send(200, "this is not json");
    if (fake.mode === "hang") { fake.hung.add(res); return; }
    const sid = body?.context?.signal?.id;
    const good = {
      situation: "S", evidence: ["E"], impact: "I", recommendation: "Have the unit checked and keep the guest informed. P35-REC-MARKER", confidence: "high", usedKnowledgeChunkIds: [],
      provenance: { provider: APPROVED_PROVIDER, model: APPROVED_MODEL }, evidenceRefs: [], contradictions: [], urgency: "prompt", recommendedActionType: "inspection",
      claims: [{ claimType: "FACT", text: "The Signal is recorded.", sourceRefs: [`current:signal:${sid}`] }, { claimType: "RECOMMENDATION", text: "Have the unit checked.", sourceRefs: [`current:signal:${sid}`] }],
    };
    if (fake.mode === "mismatch") good.provenance = { provider: APPROVED_PROVIDER, model: "gemini-3.6-flash" };
    if (fake.mode === "unsafe") good.urgency = "routine";
    if (fake.mode === "badschema") delete good.situation;
    return send(200, good);
  });
});
await new Promise((resolve) => stub.listen(5079, resolve));
process.env.AI_SERVICE_URL = "http://localhost:5079";
process.env.LLM_PROVIDER = "test-python";
delete process.env.KOI_LEARNING_CONTEXT_ENABLED;

e = await caught(() => withEnv({ KOI_AI_ANALYSIS_TIMEOUT_MS: "80" }, async () => { fake.mode = "hang"; try { return await requestAnalysisFromAiService(FIX.input.context, [], "staff"); } finally { for (const r of fake.hung) r.destroy(); fake.hung.clear(); fake.mode = "ok"; } }));
check("A6 a provider that does not answer in time is a classified timeout (504 AI_SERVICE_TIMEOUT -> provider_timeout)", e?.statusCode === 504 && e.details?.code === "AI_SERVICE_TIMEOUT" && classifyFailureCode(e.details.code) === "provider_timeout");
fake.mode = "garbage";
e = await caught(() => requestAnalysisFromAiService(FIX.input.context, [], "staff"));
fake.mode = "ok";
check("A7 a body that is not JSON is a classified malformed response (502 AI_SERVICE_MALFORMED_RESPONSE)", e?.statusCode === 502 && e.details?.code === "AI_SERVICE_MALFORMED_RESPONSE" && classifyFailureCode(e.details.code) === "malformed_response");
e = await caught(() => withEnv({ AI_SERVICE_URL: "http://localhost:59" }, () => requestAnalysisFromAiService(FIX.input.context, [], "staff")));
check("A8 an unreachable AI service is classified provider_unavailable (502 AI_SERVICE_UNREACHABLE)", e?.statusCode === 502 && e.details?.code === "AI_SERVICE_UNREACHABLE" && classifyFailureCode(e.details.code) === "provider_unavailable");
const rawGood = { situation: "S", evidence: ["E"], impact: "I", recommendation: "r", confidence: "low", usedKnowledgeChunkIds: [], provenance: { provider: APPROVED_PROVIDER, model: APPROVED_MODEL }, evidenceRefs: [], contradictions: [] };
const ctxFor = { context: FIX.input.context, operationalHistory: FIX.input.operationalHistory, knowledge: FIX.input.knowledge, learning: undefined, workspaceId: FIX.workspaceId };
e = await caught(() => validateAndVerifyAnalysis({ ...rawGood, situation: undefined }, ctxFor));
check("A9 a response that fails the schema is a classified validation failure (502 ANALYSIS_SCHEMA_INVALID), and the trace says the SCHEMA stage decided it",
  e?.statusCode === 502 && e.details?.code === "ANALYSIS_SCHEMA_INVALID" && classifyFailureCode(e.details.code) === "validation_failure" && e.admissionTrace?.decidedAt === "schema" && e.admissionTrace.stages.schema === "failed" && e.admissionTrace.stages.identity === "not_run");
check("A10 the admission trace is not enumerable: it never reaches a client or a JSON serialisation of the error", !Object.keys(e).includes("admissionTrace") && !JSON.stringify(e).includes("admissionTrace"));
const wrongIdentities = ["gemini-3.6-flash", "gemini-3.1-flash-lite-preview", "gemini-flash-latest", "models/gemini-3.1-flash-lite", "Gemini-3.1-Flash-Lite", "gemini-3.1-flash-lite ", "gemini-3.1-flash"];
const identityResults = await Promise.all(wrongIdentities.map((model) => caught(() => assertApprovedProvenance({ provider: APPROVED_PROVIDER, model }, { developmentOrTest: false }))));
check("A11 EXACT MODEL: only gemini / gemini-3.1-flash-lite is accepted - no alias, preview, latest, 3.6, other casing or whitespace", APPROVED_MODEL === "gemini-3.1-flash-lite" && identityResults.every((r) => r?.details?.code === "PROVIDER_IDENTITY_MISMATCH") &&
  (await caught(() => assertApprovedProvenance({ provider: APPROVED_PROVIDER, model: APPROVED_MODEL }, { developmentOrTest: false }))) === null);
const clientSrc = stripComments(read(path.join(BACKEND, "src", "services", "ai", "aiServiceClient.js")));
const pyClient = read(path.join(REPO, "ai-service", "app", "services", "gemini_analysis_client.py"));
check("A12 NO RETRY and NO FALLBACK: one fetch per call, no retry/backoff/fallback in the Node client, and the Gemini SDK is configured with attempts=1",
  (clientSrc.match(/\bfetch\(/g) || []).length === 1 && !/retry|backoff|fallback|circuit/i.test(clientSrc) && /attempts=1/.test(pyClient) && !/fallback_model|fallback/i.test(stripComments(read(path.join(BACKEND, "src", "config", "providerPolicy.js")))));
const defaults = await withEnv({ KOI_AI_TIMEOUT_MS: undefined, KOI_AI_ANALYSIS_TIMEOUT_MS: undefined, KOI_SOCKET_TIMEOUT_MS: undefined, LLM_PROVIDER: REAL_ROUTE }, () => timeoutBudgetProblems());
check("A13 TIMEOUT BUDGET: the shipped defaults start (also on the real gemini route) with NO warning, and the guaranteed maximum equals the request deadline: socket 120 s -> deadline 110 s = retrieval 45 s + analysis 65 s (Workstream 5C: the analysis wait is the 60 s analysis ceiling + 5 s, independent of the 20 s retrieval call timeout)",
  defaults.fatal.length === 0 && defaults.warnings.length === 0 && defaults.budget.socketMs === 120000 && defaults.budget.deadlineMs === 110000 && defaults.budget.analysisMs === 65000 && defaults.budget.retrievalBudgetMs === 45000 && defaults.budget.baseMs === 20000 &&
  defaults.budget.guaranteedMaxMs === 110000 && defaults.budget.guaranteedMaxMs <= defaults.budget.deadlineMs && defaults.budget.deadlineMs < defaults.budget.socketMs);
const tooBig = await withEnv({ KOI_AI_TIMEOUT_MS: "60000" }, () => timeoutBudgetProblems());
const analysisAboveSocket = await withEnv({ KOI_SOCKET_TIMEOUT_MS: "20000" }, () => timeoutBudgetProblems());
check("A14 TIMEOUT BUDGET: a configuration whose retrieval budget cannot fit even ONE retrieval call, or whose analysis timeout does not fit the deadline, is FATAL", tooBig.fatal.length === 1 && /cannot fit one retrieval call/.test(tooBig.fatal[0]) && analysisAboveSocket.fatal.length === 1 && /does not fit inside the request deadline/.test(analysisAboveSocket.fatal[0]));
const ceilingFatal = await withEnv({ KOI_AI_ANALYSIS_TIMEOUT_MS: "50000" }, async () => ({ real: timeoutBudgetProblems({ LLM_PROVIDER: REAL_ROUTE }), test: timeoutBudgetProblems({ LLM_PROVIDER: "test-python" }) }));
check("A14b CROSS-SERVICE CONTRACT (Node side, Workstream 5C): on the real gemini route the analysis timeout must EXCEED the AI service's ANALYSIS deadline ceiling (60 s) - 50 s is FATAL; the test routes, which run tiny timeouts on purpose, are not governed; the 20 s retrieval/embedding ceiling is a separate number",
  AI_ANALYSIS_DEADLINE_CEILING_MS === 60000 && AI_PROVIDER_TIMEOUT_CEILING_MS === 20000 && ceilingFatal.real.fatal.length === 1 && /must exceed the AI service's analysis deadline ceiling/.test(ceilingFatal.real.fatal[0]) && ceilingFatal.test.fatal.length === 0 && getAnalysisTimeBudget().analysisMs > AI_ANALYSIS_DEADLINE_CEILING_MS);
const pyPolicySrc = read(path.join(REPO, "ai-service", "app", "provider_policy.py"));
check("A14c CROSS-SERVICE CONTRACT (Python side, Workstream 5C): the AI service validates its OWN timeouts against the same two ceilings at startup and again before each analysis call (proved by ai-service/tests/test_provider_policy.py and test_analysis_deadline_5c.py); the copies of both numbers are equal",
  Number(/^PROVIDER_TIMEOUT_CEILING_MS = (\d+)/m.exec(pyPolicySrc)?.[1]) === AI_PROVIDER_TIMEOUT_CEILING_MS && Number(/^ANALYSIS_DEADLINE_CEILING_MS = (\d+)/m.exec(pyPolicySrc)?.[1]) === AI_ANALYSIS_DEADLINE_CEILING_MS &&
  /validate_startup_configuration\(settings\.llm_provider, settings\.llm_model, settings\.request_timeout_ms, settings\.embedding_provider, settings\.llm_analysis_timeout_ms\)/.test(read(path.join(REPO, "ai-service", "app", "main.py"))) &&
  /require_bounded_analysis_deadline\(settings\.llm_analysis_timeout_ms\)/.test(read(path.join(REPO, "ai-service", "app", "services", "gemini_analysis_client.py"))));
check("A15 the retrieval fan-out constant used by the budget equals ceil(MAX_ELIGIBLE_CANDIDATES / page size)", RETRIEVAL_MAX_PAGES === Math.ceil(MAX_ELIGIBLE_CANDIDATES / CANDIDATE_PAGE_SIZE));
const refused = await new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(BACKEND, "server.js")], { env: { ...process.env, PORT: "5080", KOI_AI_TIMEOUT_MS: "60000", AI_SERVICE_URL: "http://localhost:5079", LLM_PROVIDER: "test-python" }, stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  child.stderr.on("data", (d) => { err += d; });
  const timer = setTimeout(() => { child.kill(); resolve({ code: "timeout", err }); }, 25000);
  child.on("exit", (code) => { clearTimeout(timer); resolve({ code, err }); });
});
check("A16 the server REFUSES TO START with an impossible timeout budget (exit 1, reason names the timeouts, no secret)", refused.code === 1 && /Refusing to start: invalid timeout configuration/.test(refused.err) && !/AIza|apiKey/i.test(refused.err));

// ----- A17-A20: the request deadline is ENFORCED (Phase 35.1)
check("A17 the next retrieval call gets min(base timeout, time left); with no time left it gets null (the caller fails closed)",
  nextRetrievalCallTimeoutMs({ now: 0, deadlineAt: 85000, baseMs: 20000 }) === 20000 && nextRetrievalCallTimeoutMs({ now: 70000, deadlineAt: 85000, baseMs: 20000 }) === 15000 && nextRetrievalCallTimeoutMs({ now: 84999, deadlineAt: 85000, baseMs: 20000 }) === 1 &&
  nextRetrievalCallTimeoutMs({ now: 85000, deadlineAt: 85000, baseMs: 20000 }) === null && nextRetrievalCallTimeoutMs({ now: 90000, deadlineAt: 85000, baseMs: 20000 }) === null);
const simulate = (env) => withEnv(env, () => {
  const b = getAnalysisTimeBudget();
  // WORST CASE: every retrieval call uses its full allowed timeout, for as many pages as exist, then the analysis call uses all of its own.
  let clock = 0;
  let calls = 0;
  for (let page = 0; page < RETRIEVAL_MAX_PAGES; page += 1) {
    const timeout = nextRetrievalCallTimeoutMs({ now: clock, deadlineAt: b.retrievalBudgetMs, baseMs: b.baseMs });
    if (timeout === null) break;
    clock += timeout; calls += 1;
  }
  return { b, retrieval: clock, calls, total: clock + b.analysisMs, problems: timeoutBudgetProblems({ LLM_PROVIDER: "test-python" }) };
});
const configs = [{}, { KOI_AI_TIMEOUT_MS: "5000" }, { KOI_AI_TIMEOUT_MS: "30000" }, { KOI_AI_TIMEOUT_MS: "20000", KOI_SOCKET_TIMEOUT_MS: "90000", KOI_AI_ANALYSIS_TIMEOUT_MS: "25000" }, { KOI_AI_TIMEOUT_MS: "1000", KOI_SOCKET_TIMEOUT_MS: "8000", KOI_AI_ANALYSIS_TIMEOUT_MS: "1250" }, { KOI_AI_TIMEOUT_MS: "50", KOI_SOCKET_TIMEOUT_MS: "1000", KOI_AI_ANALYSIS_TIMEOUT_MS: "62" }, { KOI_AI_TIMEOUT_MS: "15000", KOI_SOCKET_TIMEOUT_MS: "900000" }, { KOI_SOCKET_TIMEOUT_MS: "90000" }];
const sims = [];
for (const env of configs) sims.push(await simulate({ KOI_AI_TIMEOUT_MS: undefined, KOI_AI_ANALYSIS_TIMEOUT_MS: undefined, KOI_SOCKET_TIMEOUT_MS: undefined, ...env }));
check("A18 WORST-CASE PROOF: for every configuration that passes the startup check, retrieval time + analysis time can NEVER exceed the request deadline, and the deadline is always below the socket timeout (all-pages-at-full-timeout simulation)",
  sims.every((r) => r.problems.fatal.length > 0 || (r.total <= r.b.deadlineMs && r.retrieval <= r.b.retrievalBudgetMs && r.b.deadlineMs < r.b.socketMs)) && sims.filter((r) => r.problems.fatal.length === 0).length >= 5,
  sims.map((r) => `${r.problems.fatal.length ? "FATAL" : `${r.total}<=${r.b.deadlineMs}`}`).join(" "));
check("A19 at the defaults the fan-out is CUT to the budget (Workstream 5C: 45 s after the 65 s analysis wait is reserved): 2 full 20 s calls, a 3rd shortened to the 5 s that remain, nothing after - retrieval is capped at 45 s, not 200 s; each retrieval call is still bounded by the 20 s per-call timeout, never by the analysis deadline",
  sims[0].calls === 3 && sims[0].retrieval === 45000 && sims[0].total === 110000 && sims[0].b.baseMs === 20000 && RETRIEVAL_MAX_PAGES * 20000 > 45000);

// the real loop (DB candidates + a slow stub AI service): 450 eligible chunks = 3 pages
const wsC = await (async () => { await connectDatabase(); return Workspace.create({ name: `P35 c ${stamp}`, slug: `p35-c-${stamp}`, status: "active" }); })();
const mongooseLib = (await import("mongoose")).default;
const chunkDocs = Array.from({ length: 450 }, (_, i) => ({ documentId: new mongooseLib.Types.ObjectId(), version: 1, workspaceId: wsC._id, status: "active", chunkIndex: i, section: "S", text: `p35 chunk ${i}`, visibility: "guest", embedding: [0.1, 0.2, 0.3, 0.4], embeddingModel: "stub-model", embeddingInputVersion: 1 }));
await KnowledgeChunk.collection.insertMany(chunkDocs);
const retrievalContext = { signal: { id: "64b0000000000000000000c1", type: "maintenance", title: "p35 retrieval", description: "d" } };
const timed = async (fn) => { const t0 = Date.now(); const err = await caught(fn); return { err, ms: Date.now() - t0 }; };
fake.retrievalDelayMs = 600; fake.retrievalCalls = 0;
const slow = await withEnv({ KOI_AI_TIMEOUT_MS: "1000" }, () => timed(() => scoreKnowledgeForContext(retrievalContext, wsC._id, "guest", { deadlineAt: Date.now() + 1450 })));
check("A20 INTEGRATION: the real retrieval loop over 3 pages with a slow AI service is CUT at the budget (the last call is shortened to the time left and aborted), fails closed with a classified timeout, and never runs past the deadline",
  slow.err?.statusCode === 504 && slow.err.details?.code === "AI_SERVICE_TIMEOUT" && fake.retrievalCalls === 3 && slow.ms < 1450 + 400, `calls=${fake.retrievalCalls} elapsed=${slow.ms}ms`);
fake.retrievalCalls = 0;
const spent = await timed(() => scoreKnowledgeForContext(retrievalContext, wsC._id, "guest", { deadlineAt: Date.now() - 1 }));
check("A21 INTEGRATION: when the budget is already spent, retrieval fails closed BEFORE any AI-service call (504 KNOWLEDGE_RETRIEVAL_BUDGET_EXHAUSTED -> class provider_timeout)",
  spent.err?.statusCode === 504 && spent.err.details?.code === RETRIEVAL_BUDGET_EXHAUSTED && fake.retrievalCalls === 0 && classifyFailureCode(RETRIEVAL_BUDGET_EXHAUSTED) === "provider_timeout");
fake.retrievalDelayMs = 20; fake.retrievalCalls = 0;
const ample = await timed(() => scoreKnowledgeForContext(retrievalContext, wsC._id, "guest", { deadlineAt: Date.now() + 30000 }));
check("A22 INTEGRATION: with ample budget all 3 pages are scored exactly as before (no behaviour change when the budget is not the limit)", ample.err === null && fake.retrievalCalls === 3);
fake.retrievalCalls = 0;
const uncapped = await timed(() => scoreKnowledgeForContext(retrievalContext, wsC._id, "guest"));
check("A23 no deadline (the offline evaluation harness) means no cap, exactly as before", uncapped.err === null && fake.retrievalCalls === 3);
// end to end through analyzeSignal: the spent budget is audited as a RETRIEVAL-stage rejection, the model is never called, nothing is stored
const sC = await Signal.create({ workspaceId: wsC._id, type: "maintenance", severity: "medium", title: "P35 budget signal", description: "d" });
fake.retrievalDelayMs = 600; fake.retrievalCalls = 0; const analyzeCallsBefore = fake.analyzeCalls;
const endToEnd = await withEnv({ KOI_AI_TIMEOUT_MS: "1000", KOI_AI_ANALYSIS_TIMEOUT_MS: "1250", KOI_SOCKET_TIMEOUT_MS: "3000" }, () => timed(() => analyzeSignal(String(sC._id), String(wsC._id), { authorizedLevel: "staff" })));
const rowsC = await AnalysisAdmission.find({ workspaceId: wsC._id, signalId: sC._id }).lean();
check("A24 END TO END: analyzeSignal under a tight budget (socket 3 s -> deadline 2.7 s, analysis 1.25 s, retrieval 1.45 s) fails closed in RETRIEVAL within the deadline, makes no model call, stores no Intelligence, and audits the rejection with a timeout class",
  endToEnd.err?.statusCode === 504 && fake.analyzeCalls === analyzeCallsBefore && endToEnd.ms < 2700 && (await Intelligence.countDocuments({ workspaceId: wsC._id })) === 0 && rowsC.length === 1 && rowsC[0].decidedAt === "retrieval" && rowsC[0].failureClass === "provider_timeout" && rowsC[0].stages.provider === "not_run",
  `elapsed=${endToEnd.ms}ms reason=${rowsC[0]?.reasonCode}`);
await Promise.all([KnowledgeChunk.deleteMany({ workspaceId: wsC._id }), AnalysisAdmission.deleteMany({ workspaceId: wsC._id }), Intelligence.deleteMany({ workspaceId: wsC._id }), Signal.deleteMany({ workspaceId: wsC._id })]);
await Workspace.deleteMany({ _id: wsC._id });
fake.retrievalDelayMs = 0;

// ====================================================================================================== B. KNOWLEDGE RELEVANCE (pure)
console.log("\n# B. knowledge relevance and confidence");
const claim = (claimType, text, ...sourceRefs) => ({ claimType, text, sourceRefs });
const SIG = "current:signal:64b0000000000000000000a1";
const UNT = "untrusted:signal:64b0000000000000000000a1";
const HAN = "history:analysis:64b0000000000000000000f1";
const KNW = "knowledge:64b0000000000000000000k1";
const LRN = "learning:maintenance_dispatch";
const baseKnowledge = FIX.input.knowledge;
const withSim = (value) => baseKnowledge.map((k, i) => (i === 0 ? { ...k, similarityScore: value } : k));
const ENV = buildEvidenceEnvelope({ workspaceId: FIX.workspaceId, ...FIX.input });
const ctx = FIX.input.context;
const ceil = (claims, over = {}) => deriveConfidenceCeiling({ claims, envelope: ENV, context: ctx, contradictions: [], strict: true, knowledge: baseKnowledge, minSimilarity: 0.25, ...over });
const GROUNDED = [claim("FACT", "f", SIG, UNT), claim("RECOMMENDATION", "r", SIG, KNW)];
const FACTONLY_REC = [claim("FACT", "f", SIG), claim("RECOMMENDATION", "r", SIG)];
check("B1 relevant knowledge (similarity 0.80, above the floor) may ground a recommendation -> HIGH is possible", ceil(GROUNDED).ceiling === "high");
check("B2 STRONG knowledge (0.95) grounds exactly like relevant knowledge: the policy has ONE tier (the floor), not an invented 'strong' tier", ceil(GROUNDED, { knowledge: withSim(0.95) }).ceiling === "high");
check("B3 knowledge exactly AT the floor (0.25, boundary inclusive, as retrieval defines it) still counts; just below it does not", ceil(GROUNDED, { knowledge: withSim(0.25) }).ceiling === "high" && ceil(GROUNDED, { knowledge: withSim(0.2499) }).ceiling === "medium");
check("B4 BELOW-FLOOR knowledge cannot ground: a current fact + a recommendation citing only a below-floor chunk is capped at MEDIUM", ceil(GROUNDED, { knowledge: withSim(0.1) }).ceiling === "medium" && ceil(GROUNDED, { knowledge: withSim(0.1) }).reasons.includes("NO_KNOWLEDGE_GROUNDED_RECOMMENDATION"));
check("B5 a recommendation resting ONLY on below-floor knowledge (no current fact) is unsupported -> LOW", ceil([claim("FACT", "f", SIG), claim("RECOMMENDATION", "r", KNW)], { knowledge: withSim(0.1) }).ceiling === "low");
check("B6 MISSING / non-numeric similarity metadata can never ground (fail closed)", [undefined, null, NaN, "0.9", Infinity].every((v) => ceil(GROUNDED, { knowledge: baseKnowledge.map((k, i) => (i === 0 ? { ...k, similarityScore: v } : k)) }).ceiling === "medium") && ceil(GROUNDED, { knowledge: [] }).ceiling === "medium" && ceil(GROUNDED, { knowledge: undefined }).ceiling === "medium");
check("B7 a disabled retrieval floor (-1, used only by test harnesses) cannot lower the confidence floor: 0.1 still does not ground", ceil(GROUNDED, { knowledge: withSim(0.1), minSimilarity: -1 }).ceiling === "medium");
check("B8 no knowledge -> MEDIUM at best; knowledge that EXISTS but is not cited by the recommendation does not produce HIGH", ceil(FACTONLY_REC, { knowledge: [] }).ceiling === "medium" && ceil(FACTONLY_REC).ceiling === "medium" && ceil(FACTONLY_REC).reasons.includes("NO_KNOWLEDGE_GROUNDED_RECOMMENDATION"));
check("B9 current fact + RELEVANT knowledge -> HIGH; current fact + IRRELEVANT knowledge -> MEDIUM", ceil(GROUNDED).ceiling === "high" && ceil(GROUNDED, { knowledge: withSim(0.05) }).ceiling === "medium");
check("B10 a recommendation citing only HISTORY -> LOW; only LEARNING -> LOW; only the UNTRUSTED Signal text -> LOW",
  ceil([claim("FACT", "f", SIG), claim("RECOMMENDATION", "r", HAN)]).ceiling === "low" && ceil([claim("FACT", "f", SIG), claim("RECOMMENDATION", "r", LRN)]).ceiling === "low" && ceil([claim("FACT", "f", SIG), claim("RECOMMENDATION", "r", UNT)]).ceiling === "low");
check("B11 Learning, history and untrusted text can never RAISE the ceiling: adding them to a MEDIUM analysis leaves it MEDIUM",
  ceil([...FACTONLY_REC, claim("LEARNING_OBSERVATION", "l", LRN), claim("HISTORICAL_PATTERN", "h", HAN)]).ceiling === "medium" && ceil([claim("FACT", "f", SIG), claim("RECOMMENDATION", "r", SIG, LRN, HAN, UNT)]).ceiling === "medium");
check("B12 the ceiling reads claim types, source classes and retrieval METADATA only - no text of the analysis and no model call", !/\.text|recommendation|situation|RegExp|\.test\(|\.match\(|fetch\(/.test(stripComments(read(path.join(BACKEND, "src", "services", "ai", "confidencePolicy.js")))));
const runAdmission = (over, knowledge = baseKnowledge) => validateAndVerifyAnalysis({ ...rawGood, confidence: "high", urgency: "prompt", recommendedActionType: "inspection", claims: GROUNDED, ...over }, { ...ctxFor, knowledge });
let out = runAdmission({}, withSim(0.8));
check("B13 end to end: a model-reported HIGH with relevant knowledge stays HIGH and the audit metadata says one relevant chunk grounded it", out.confidence === "high" && out.admission.knowledgeRelevant >= 1);
out = runAdmission({}, withSim(0.1));
check("B14 end to end: the SAME response with below-floor knowledge is capped to MEDIUM (cap, not reject), and the cap is recorded", out.confidence === "medium" && out.admission.confidenceCapped === true && out.admission.modelConfidence === "high" && out.admission.confidenceCeiling === "medium");
check("B15 final confidence is NEVER above the ceiling, whatever the model says (every model value x every similarity)",
  ["low", "medium", "high"].every((model) => [0.8, 0.25, 0.1, undefined].every((sim) => { const r = runAdmission({ confidence: model }, withSim(sim)); const order = ["low", "medium", "high"]; return order.indexOf(r.confidence) <= order.indexOf(r.admission.confidenceCeiling) && order.indexOf(r.confidence) <= order.indexOf(model); })));

// ====================================================================================================== C. AUDIT (DB-backed)
console.log("\n# C. audit / admission record");
await connectDatabase();
await Promise.all([AnalysisAdmission.init(), Decision.init(), Action.init(), User.init(), WorkspaceMembership.init()]);
const ids = { workspaces: [], signals: [], intelligences: [], usersExtra: [] };
const baselineCounts = async () => ({
  AnalysisAdmission: await AnalysisAdmission.countDocuments({ workspaceId: { $nin: ids.workspaces } }),
  Decision: await Decision.countDocuments({ workspaceId: { $nin: ids.workspaces } }),
  Action: await Action.countDocuments({ workspaceId: { $nin: ids.workspaces } }),
  Intelligence: await Intelligence.countDocuments({ workspaceId: { $nin: ids.workspaces } }),
  Signal: await Signal.countDocuments({ workspaceId: { $nin: ids.workspaces } }),
  Workspace: await Workspace.countDocuments({ _id: { $nin: ids.workspaces } }),
  User: await User.countDocuments({}),
  WorkspaceMembership: await WorkspaceMembership.countDocuments({}),
});
const mkWs = async (label) => { const w = await Workspace.create({ name: `P35 ${label} ${stamp}`, slug: `p35-${label}-${stamp}`, status: "active" }); ids.workspaces.push(w._id); return w; };
const wsA = await mkWs("a");
const wsB = await mkWs("b");
const A = String(wsA._id);
const B = String(wsB._id);
await sweepOrphanAdmissions(); // audit rows left by older suites whose throwaway workspaces are already gone
const before = await baselineCounts();
let sigN = 0;
const mkSignal = async (severity = "medium") => { sigN += 1; const s = await Signal.create({ workspaceId: wsA._id, type: "maintenance", severity, title: `P35-TITLE-MARKER ${sigN}`, description: "P35-DESC-MARKER guest reports a fault" }); ids.signals.push(s._id); return s; };
const rowsFor = (workspaceId, signalId) => AnalysisAdmission.find({ workspaceId, signalId }).lean();

const s1 = await mkSignal("medium");
resetAdmissionAuditFailureCount();
let result = await analyzeSignal(String(s1._id), A, { authorizedLevel: "staff" });
let rows = await rowsFor(wsA._id, s1._id);
const accepted = rows[0];
check("C1 an ACCEPTED analysis creates exactly ONE admission record, correlated to the stored Intelligence", result.created === true && rows.length === 1 && accepted.outcome === "accepted" && String(accepted.intelligenceId) === String(result.record._id) && /^[0-9a-f-]{36}$/.test(accepted.attemptId));
ids.intelligences.push(result.record._id);
check("C2 the record carries the EXACT model identity, the evidence-set id and every stage result (all passed)", accepted.provider === APPROVED_PROVIDER && accepted.model === APPROVED_MODEL && /^[0-9a-f]{64}$/.test(accepted.evidenceSetId) && accepted.decidedAt === "admitted" &&
  Object.values(accepted.stages).every((v) => v === "passed") && accepted.stages.provider === "passed" && accepted.latencyMs >= 0);
check("C3 confidence is captured as model / ceiling / final, with the cap and the reason; final is never above the ceiling and equals what Intelligence stored",
  accepted.modelConfidence === "high" && accepted.confidenceCeiling === "medium" && accepted.finalConfidence === "medium" && accepted.confidenceCapped === true && accepted.ceilingReasons.includes("NO_KNOWLEDGE_GROUNDED_RECOMMENDATION") && result.record.analysis.confidence === accepted.finalConfidence);
check("C4 claim types, cited evidence classes, safety state and the guard results are recorded as counts / codes only",
  accepted.claimTypeCounts.FACT === 1 && accepted.claimTypeCounts.RECOMMENDATION === 1 && accepted.citedClassCounts.CURRENT_OPERATIONAL_FACT === 2 && typeof accepted.safetyState === "string" && Array.isArray(accepted.safetyRules || []));
check("C5 Learning is absent: flag off, the attempt says it was not used", getLearningContextEnabled() === false && accepted.learningUsed === false && !JSON.stringify(fake.last).includes("learning"));
const storedText = JSON.stringify(accepted);
check("C6 PRIVACY: the record contains no prompt, no model output text, no Signal text, no secret, no header and no evidence reference ids",
  !/P35-TITLE-MARKER|P35-DESC-MARKER|P35-REC-MARKER|Have the unit checked/.test(storedText) && !/AIza|sk-[A-Za-z0-9]{20}|authorization|bearer/i.test(storedText) && !/current:signal|untrusted:signal|knowledge:64b/.test(storedText) && !storedText.includes(String(s1._id).slice(0, 0) + "current:"));
const forbiddenPath = /prompt|output|raw|text|situation|recommendation|impact|description|title|claims$|evidenceRefs|sourceRefs|apiKey|authorization|header|secret/i;
check("C7 PRIVACY (structure): the schema has no field that could hold a prompt, output, signal text, claim text or reference list", Object.keys(AnalysisAdmission.schema.paths).every((p) => !forbiddenPath.test(p)),
  Object.keys(AnalysisAdmission.schema.paths).filter((p) => forbiddenPath.test(p)).join(","));
const countBefore = fake.calls;
const again = await analyzeSignal(String(s1._id), A, { authorizedLevel: "staff" });
check("C8 an idempotent repeat returns the stored analysis, makes no model call and writes no second admission record (one row per attempt that reached the model)", again.created === false && fake.calls === countBefore && (await rowsFor(wsA._id, s1._id)).length === 1);

const s2 = await mkSignal("critical");
fake.mode = "unsafe";
e = await caught(() => analyzeSignal(String(s2._id), A, { authorizedLevel: "staff" }));
rows = await rowsFor(wsA._id, s2._id);
check("C9 a REJECTED analysis (safety minimum not met) creates exactly ONE rejected record and NO Intelligence", e?.details?.code === "SAFETY_POLICY_VIOLATION" && rows.length === 1 && rows[0].outcome === "rejected" && !rows[0].intelligenceId && (await Intelligence.countDocuments({ workspaceId: wsA._id, signalIds: s2._id })) === 0);
check("C10 the rejection is deterministic: decided at SAFETY, reason code + class + status, earlier stages passed, later stages not run, model identity and model confidence captured",
  rows[0].decidedAt === "safety" && rows[0].reasonCode === "SAFETY_POLICY_VIOLATION" && rows[0].failureClass === "validation_failure" && rows[0].httpStatus === 502 &&
  rows[0].stages.provider === "passed" && rows[0].stages.schema === "passed" && rows[0].stages.identity === "passed" && rows[0].stages.claims === "passed" && rows[0].stages.safety === "failed" && rows[0].stages.prose === "not_run" && rows[0].stages.identifier === "not_run" &&
  rows[0].model === APPROVED_MODEL && rows[0].modelConfidence === "high" && rows[0].claimTypeCounts.FACT === 1);
const s3 = await mkSignal("medium");
fake.mode = "mismatch";
e = await caught(() => analyzeSignal(String(s3._id), A, { authorizedLevel: "staff" }));
rows = await rowsFor(wsA._id, s3._id);
check("C11 EXACT MODEL at admission: an unapproved model (gemini-3.6-flash) is rejected at IDENTITY, recorded as such with the reported identity, and nothing is stored as Intelligence",
  e?.details?.code === "PROVIDER_IDENTITY_MISMATCH" && rows.length === 1 && rows[0].decidedAt === "identity" && rows[0].model === "gemini-3.6-flash" && rows[0].stages.identity === "failed" && rows[0].stages.claims === "not_run" && (await Intelligence.countDocuments({ workspaceId: wsA._id, signalIds: s3._id })) === 0);
const s4 = await mkSignal("medium");
fake.mode = "badschema";
e = await caught(() => analyzeSignal(String(s4._id), A, { authorizedLevel: "staff" }));
rows = await rowsFor(wsA._id, s4._id);
check("C12 a schema failure is recorded as such (decided at SCHEMA, ANALYSIS_SCHEMA_INVALID)", rows.length === 1 && rows[0].decidedAt === "schema" && rows[0].reasonCode === "ANALYSIS_SCHEMA_INVALID" && rows[0].stages.schema === "failed");
const s5 = await mkSignal("medium");
fake.mode = "ratelimit";
e = await caught(() => analyzeSignal(String(s5._id), A, { authorizedLevel: "staff" }));
rows = await rowsFor(wsA._id, s5._id);
check("C13 a PROVIDER failure is recorded with its class: rate limit -> decided at PROVIDER, PROVIDER_RATE_LIMITED, class rate_limit, status 503, no model identity (none was reported)",
  e?.details?.code === "PROVIDER_RATE_LIMITED" && rows.length === 1 && rows[0].decidedAt === "provider" && rows[0].reasonCode === "PROVIDER_RATE_LIMITED" && rows[0].failureClass === "rate_limit" && rows[0].httpStatus === 503 && rows[0].stages.provider === "failed" && !rows[0].model && rows[0].latencyMs >= 0);
const s6 = await mkSignal("medium");
fake.mode = "garbage";
e = await caught(() => analyzeSignal(String(s6._id), A, { authorizedLevel: "staff" }));
rows = await rowsFor(wsA._id, s6._id);
check("C14 a malformed provider response is recorded (AI_SERVICE_MALFORMED_RESPONSE, class malformed_response)", rows.length === 1 && rows[0].reasonCode === "AI_SERVICE_MALFORMED_RESPONSE" && rows[0].failureClass === "malformed_response");
fake.mode = "ok";

// workspace isolation
const listedA = await listAnalysisAdmissions(A);
const listedB = await listAnalysisAdmissions(B);
const probe = await caught(() => getAnalysisAdmissionByAttempt(B, accepted.attemptId));
const probeOwn = await getAnalysisAdmissionByAttempt(A, accepted.attemptId);
check("C15 WORKSPACE ISOLATION: workspace A's records are listed for A only; B sees none; A's attempt id is a 404 in B and readable in A",
  listedA.length === 6 && listedA.every((r) => r.workspaceId === A) && listedB.length === 0 && probe?.statusCode === 404 && probeOwn.attemptId === accepted.attemptId && probeOwn.workspaceId === A);
const noScope = await Promise.all([undefined, null, "", "not-an-id", { $ne: null }].map((w) => caught(() => listAnalysisAdmissions(w))));
check("C16 a missing / malformed / operator-shaped workspace is a 400 - never 'all workspaces'", noScope.every((x) => x?.statusCode === 400));
const bSignal = await Signal.create({ workspaceId: wsB._id, type: "maintenance", severity: "medium", title: "P35 B signal" });
ids.signals.push(bSignal._id);
e = await caught(() => analyzeSignal(String(s1._id), B, { authorizedLevel: "staff" }));
check("C17 analysing A's Signal as workspace B is a 404 and writes no audit row in either workspace (the attempt never started)", e?.statusCode === 404 && (await AnalysisAdmission.countDocuments({ workspaceId: wsB._id })) === 0 && (await AnalysisAdmission.countDocuments({ workspaceId: wsA._id })) === 6);
check("C18 list filters stay inside the workspace: by outcome and by signal", (await listAnalysisAdmissions(A, { outcome: "rejected" })).length === 5 && (await listAnalysisAdmissions(A, { outcome: "accepted" })).length === 1 && (await listAnalysisAdmissions(A, { signalId: String(s2._id) })).length === 1 && (await listAnalysisAdmissions(B, { signalId: String(s2._id) })).length === 0);

// audit persistence failure
const s7 = await mkSignal("medium");
resetAdmissionAuditFailureCount();
const realCreate = AnalysisAdmission.create.bind(AnalysisAdmission);
AnalysisAdmission.create = async () => { throw new Error("simulated audit store outage"); };
let okResult;
try {
  okResult = await quietly(() => analyzeSignal(String(s7._id), A, { authorizedLevel: "staff" }));
} finally { AnalysisAdmission.create = realCreate; }
ids.intelligences.push(okResult?.record?._id);
check("C19 AUDIT FAILURE does not turn a validated, stored analysis into a failure: the caller gets the analysis, it is persisted once, and no spurious 'rejected' row exists",
  okResult?.created === true && (await Intelligence.countDocuments({ workspaceId: wsA._id, signalIds: s7._id })) === 1 && (await AnalysisAdmission.countDocuments({ workspaceId: wsA._id, signalId: s7._id })) === 0);
check("C20 ...and the failure is NOT silent: it is counted (and logged by class only)", getAdmissionAuditFailureCount() === 1);
const s8 = await mkSignal("critical");
fake.mode = "unsafe";
AnalysisAdmission.create = async () => { throw new Error("simulated audit store outage"); };
try { e = await caught(() => analyzeSignal(String(s8._id), A, { authorizedLevel: "staff" })); } finally { AnalysisAdmission.create = realCreate; fake.mode = "ok"; }
check("C21 AUDIT FAILURE on a rejection keeps the ORIGINAL error (SAFETY_POLICY_VIOLATION), not an audit error", e?.details?.code === "SAFETY_POLICY_VIOLATION" && getAdmissionAuditFailureCount() === 2);
const svcSrc = stripComments(read(path.join(BACKEND, "src", "services", "analysisAdmissionService.js")));
check("C22 recordAnalysisAdmission cannot throw: its whole body is inside a catch-all, and it never re-throws", /export async function recordAnalysisAdmission[\s\S]*?try \{[\s\S]*?catch \(error\) \{[\s\S]*?return null;/.test(svcSrc) && !/throw error/.test(svcSrc.slice(svcSrc.indexOf("export async function recordAnalysisAdmission"), svcSrc.indexOf("const mapToObject"))));
const allStored = await AnalysisAdmission.find({ workspaceId: { $in: ids.workspaces } }).lean();
check("C23 every stored row, accepted or rejected: final confidence <= ceiling, learningUsed false, no stored string longer than 64 characters (the longest are the 64-hex evidence-set id and 36-char attempt id), workspace is one of ours",
  allStored.every((r) => (!r.finalConfidence || ["low", "medium", "high"].indexOf(r.finalConfidence) <= ["low", "medium", "high"].indexOf(r.confidenceCeiling)) && r.learningUsed === false && ids.workspaces.some((w) => String(w) === String(r.workspaceId))) &&
  JSON.stringify(allStored).match(/"[^"]{65,}"/) === null);

// ====================================================================================================== D. GOVERNANCE (HTTP, spawned backend)
console.log("\n# D. proposer / reviewer separation");
const PORT = 5077;
const BASE = `http://localhost:${PORT}/api`;
// Phase 49: this suite pins the STRICT four-eyes rule for Actions; the default (single-user) policy is covered by validate-phase49-decision-action.mjs.
process.env.KOI_ACTION_REVIEW_REQUIRES_SECOND_PERSON = "true";
const child = spawn(process.execPath, [path.join(BACKEND, "server.js")], { env: { ...process.env, PORT: String(PORT), LLM_PROVIDER: "test-python", AI_SERVICE_URL: "http://localhost:5078", KNOWLEDGE_DEV_AUTHORIZED_LEVEL: "restricted" }, stdio: "ignore" });
const call = async (method, url, { headers = {}, body } = {}) => {
  const response = await fetch(`${BASE}${url}`, { method, headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await response.json(); } catch { json = null; }
  return { status: response.status, json, data: json?.data, code: json?.details?.code };
};
try {
  for (let i = 0; i < 100; i += 1) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 200)); }
  const mk = (role, ws, label) => createActor({ role, workspaceId: ws._id, label });
  const operator = await mk("operator", wsA, "p35-operator");
  const reviewerR = await mk("reviewer", wsA, "p35-reviewer-r");
  const reviewerR2 = await mk("reviewer", wsA, "p35-reviewer-r2");
  const admin = await mk("admin", wsA, "p35-admin");
  const viewer = await mk("viewer", wsA, "p35-viewer");
  const adminB = await mk("admin", wsB, "p35-admin-b");
  const H = (who) => who.headers;
  const property = null;
  void property;
  const newIntel = async (severity = "medium") => {
    const signal = await mkSignal(severity);
    const intel = await Intelligence.create({ workspaceId: wsA._id, signalIds: [signal._id], generatedBy: "llm", provider: "p", model: "m", risk: { level: severity },
      analysis: { situation: "s", evidence: ["e"], impact: "i", recommendation: "Consider the documented guidance. Recommendation only.", confidence: "medium" }, analysisVersion: "intelligence-v1", analysisLevel: "guest" });
    ids.intelligences.push(intel._id);
    return intel;
  };
  const propose = (intel, who, extra = "", body) => call("POST", `/decisions/propose/${intel._id}?workspaceId=${A}${extra}`, { headers: H(who), body });
  const decide = (id, verb, who, body = {}, ws = A) => call("POST", `/decisions/${id}/${verb}?workspaceId=${ws}`, { headers: H(who), body });

  const d1 = await propose(await newIntel(), operator);
  const d1doc = await Decision.findById(d1.data._id).lean();
  check("D1 a NEW Decision stores proposedBy = the authenticated actor and the governance marker", d1.status === 201 && String(d1doc.proposedBy) === String(operator.user._id) && d1doc.governanceVersion === GOVERNANCE_VERSION);
  const d2 = await propose(await newIntel(), reviewerR);
  check("D2 a reviewer who proposes is recorded as the proposer", String((await Decision.findById(d2.data._id).lean()).proposedBy) === String(reviewerR.user._id));
  let r = await decide(d2.data._id, "approve", reviewerR);
  // Phase 48.1: for a DECISION the separation rule is relaxed (GOVERNANCE_POLICY.Decision.selfReviewAllowed). The proposer is still stored and the reviewer is still
  // the authenticated actor, stored separately; an ACTION proposal keeps the strict rule (D18-D19 below).
  const d2doc = await Decision.findById(d2.data._id).lean();
  check("D3 the proposer who holds decision:review MAY approve their own Decision (Phase 48.1): 200, approved; proposer and reviewer are both recorded (the same user)", r.status === 200 && r.data.status === "approved" && String(d2doc.proposedBy) === String(reviewerR.user._id) && String(d2doc.review.reviewedBy) === String(reviewerR.user._id));
  const d2b = await propose(await newIntel(), reviewerR);
  r = await decide(d2b.data._id, "reject", reviewerR, { note: "own decision" });
  check("D4 ...and may reject their own Decision (200)", r.status === 200 && r.data.status === "rejected");
  const d2c = await propose(await newIntel(), operator);
  r = await decide(d2c.data._id, "approve", reviewerR2, { note: "second pair of eyes" });
  const d2after = await Decision.findById(d2c.data._id).lean();
  check("D5 a DIFFERENT authorized reviewer still approves (200); reviewedBy is that reviewer and proposedBy is unchanged", r.status === 200 && r.data.status === "approved" && String(d2after.review.reviewedBy) === String(reviewerR2.user._id) && String(d2after.proposedBy) === String(operator.user._id));
  r = await decide(d2.data._id, "approve", reviewerR);
  check("D6 the idempotent 'already approved' answer is 200 with no second transition", r.status === 200 && (await Decision.findById(d2.data._id).lean()).transitions.length === 1);
  r = await decide(d1.data._id, "approve", operator);
  const rV = await decide(d1.data._id, "approve", viewer);
  check("D7 ROLE: an operator (no decision:review) and a viewer are refused (403 FORBIDDEN) - authorization is checked before and independent of separation", r.status === 403 && r.code === "FORBIDDEN" && rV.status === 403 && rV.code === "FORBIDDEN");
  r = await decide(d1.data._id, "approve", adminB, {}, B);
  const rB2 = await decide(d1.data._id, "approve", adminB, {}, A);
  check("D8 WORKSPACE: an admin of B cannot review A's Decision by selecting B (404) or A (404, not a member)", r.status === 404 && rB2.status === 404 && (await Decision.findById(d1.data._id).lean()).status === "proposed");
  const spoofIntel = await newIntel();
  let sp = await propose(spoofIntel, operator, "", { proposedBy: String(admin.user._id) });
  const sp2 = await propose(spoofIntel, operator, `&proposedBy=${admin.user._id}&userId=${admin.user._id}`);
  const sp3 = await call("POST", `/decisions/propose/${(await newIntel())._id}?workspaceId=${A}`, { headers: { ...H(operator), "x-user-id": String(admin.user._id), "x-proposed-by": String(admin.user._id) } });
  check("D9 SPOOFING: a body proposedBy is refused (400); a query/header proposedBy or user id is ignored - the stored proposer is always the token's user",
    sp.status === 400 && sp2.status === 201 && String((await Decision.findById(sp2.data._id).lean()).proposedBy) === String(operator.user._id) && sp3.status === 201 && String((await Decision.findById(sp3.data._id).lean()).proposedBy) === String(operator.user._id));
  r = await decide(d1.data._id, "approve", reviewerR, { reviewedBy: String(admin.user._id) });
  check("D10 SPOOFING: a reviewedBy in the review body is refused (400) and a forged x-user-id header does not change who reviews",
    r.status === 400 && (await call("POST", `/decisions/${d1.data._id}/approve?workspaceId=${A}`, { headers: { ...H(reviewerR), "x-user-id": String(admin.user._id) }, body: {} })).status === 200 && String((await Decision.findById(d1.data._id).lean()).review.reviewedBy) === String(reviewerR.user._id));
  // legacy / integrity
  const noProposer = await caught(() => Decision.create({ workspaceId: wsA._id, intelligenceId: d1doc.intelligenceId, description: "x", decisionVersion: "decision-v1", governanceVersion: GOVERNANCE_VERSION, status: "proposed" }));
  const svcNoActor = await caught(() => proposeDecision(String(d1doc.intelligenceId), A, undefined, { authorizedLevel: "staff" }));
  const svcNoActorA = await caught(() => proposeAction(String(d1.data._id), A, { actionType: "inspection" }, { authorizedLevel: "staff" }));
  const svcBadActor = await caught(() => proposeDecision(String(d1doc.intelligenceId), A, undefined, { authorizedLevel: "staff", actorUserId: "not-an-id" }));
  check("D11 a NEW governed record WITHOUT a proposer is impossible: the schema refuses it, and the services refuse a missing or malformed actor (401)",
    noProposer?.name === "ValidationError" && svcNoActor?.statusCode === 401 && svcNoActorA?.statusCode === 401 && svcBadActor?.statusCode === 401);
  const legacyIntel = await newIntel();
  const legacyDoc = await Decision.create({ workspaceId: wsA._id, intelligenceId: legacyIntel._id, signalId: legacyIntel.signalIds[0], description: "legacy V1 record", priority: "medium", status: "proposed", decisionVersion: "decision-v1", analysisVersion: "intelligence-v1", analysisLevel: "guest" });
  r = await decide(legacyDoc._id, "approve", reviewerR);
  const legacyAfter = await Decision.findById(legacyDoc._id).lean();
  check("D12 LEGACY records (no governance marker, no recorded proposer) stay reviewable exactly as before, and the review still records WHO reviewed; they cannot be created through the API",
    r.status === 200 && !legacyAfter.proposedBy && !legacyAfter.governanceVersion && String(legacyAfter.review.reviewedBy) === String(reviewerR.user._id));
  const brokenIntel = await newIntel();
  const brokenDecision = await propose(brokenIntel, operator);
  await Decision.collection.updateOne({ _id: new (await import("mongoose")).default.Types.ObjectId(brokenDecision.data._id) }, { $unset: { proposedBy: "" } });
  r = await decide(brokenDecision.data._id, "approve", reviewerR);
  check("D13 FAIL CLOSED: a governed record whose proposer is missing (corruption) is refused (409 PROPOSER_UNKNOWN) - a missing proposer is never a bypass", r.status === 409 && r.code === "PROPOSER_UNKNOWN");
  const gen = await call("POST", `/decisions?workspaceId=${A}`, { headers: H(admin), body: { workspaceId: A, intelligenceId: String(legacyIntel._id), description: "x", proposedBy: String(admin.user._id) } });
  const gen2 = await call("POST", `/decisions?workspaceId=${A}`, { headers: H(admin), body: { workspaceId: A, intelligenceId: String(legacyIntel._id), description: "x", governanceVersion: GOVERNANCE_VERSION } });
  check("D14 DIRECT API BYPASS: the generic Decision endpoint refuses proposedBy / governanceVersion in a body (400)", gen.status === 400 && gen2.status === 400);
  const patchTry = await call("PATCH", `/decisions/${d1.data._id}?workspaceId=${A}`, { headers: H(admin), body: { status: "approved", proposedBy: String(admin.user._id) } });
  check("D15 DIRECT API BYPASS: a Decision V1 cannot be changed through the generic PATCH (409)", patchTry.status === 409);
  const view = d1.data;
  check("D16 the public Decision view still exposes no actor identity (proposer / reviewer ids are stored, not published)", !/proposedBy|reviewedBy|governanceVersion|userId/i.test(JSON.stringify(view)) && !/proposedBy|reviewedBy/i.test(JSON.stringify((await decide(d2.data._id, "approve", reviewerR2)).data)));

  // actions
  const approvedForAction = await decide((await propose(await newIntel(), operator)).data._id, "approve", reviewerR);
  const decisionId = approvedForAction.data._id;
  const a1 = await call("POST", `/actions/propose/${decisionId}?workspaceId=${A}`, { headers: H(reviewerR), body: { actionType: "inspection" } });
  const a1doc = await Action.findById(a1.data._id).lean();
  check("D17 a NEW Action proposal stores proposedBy = the authenticated actor and the governance marker", a1.status === 201 && String(a1doc.proposedBy) === String(reviewerR.user._id) && a1doc.governanceVersion === GOVERNANCE_VERSION);
  r = await call("POST", `/actions/${a1.data._id}/approve?workspaceId=${A}`, { headers: H(reviewerR), body: {} });
  const r2 = await call("POST", `/actions/${a1.data._id}/reject?workspaceId=${A}`, { headers: H(reviewerR), body: {} });
  check("D18 SAME USER cannot approve or reject their own Action proposal (403 SEPARATION_OF_DUTIES)", r.status === 403 && r.code === "SEPARATION_OF_DUTIES" && r2.status === 403 && (await Action.findById(a1.data._id).lean()).status === "proposed");
  const rOp = await call("POST", `/actions/${a1.data._id}/approve?workspaceId=${A}`, { headers: H(operator), body: {} });
  const rAdminB = await call("POST", `/actions/${a1.data._id}/approve?workspaceId=${B}`, { headers: H(adminB), body: {} });
  check("D19 ROLE and WORKSPACE for Actions: an operator is refused (403), an admin of another workspace gets 404", rOp.status === 403 && rAdminB.status === 404);
  r = await call("POST", `/actions/${a1.data._id}/approve?workspaceId=${A}`, { headers: H(reviewerR2), body: { note: "ok" } });
  const a1after = await Action.findById(a1.data._id).lean();
  check("D20 a DIFFERENT authorized reviewer approves the Action (200); reviewedBy recorded, proposedBy unchanged", r.status === 200 && r.data.status === "approved" && String(a1after.review.reviewedBy) === String(reviewerR2.user._id) && String(a1after.proposedBy) === String(reviewerR.user._id));
  const spoofA = await call("POST", `/actions/propose/${(await (async () => { const d = await decide((await propose(await newIntel(), operator)).data._id, "approve", reviewerR); return d; })()).data._id}?workspaceId=${A}`, { headers: H(operator), body: { actionType: "inspection", proposedBy: String(admin.user._id) } });
  check("D21 SPOOFING on an Action proposal: a body proposedBy is refused (400)", spoofA.status === 400);
  const execTry = await call("POST", `/actions?workspaceId=${A}`, { headers: H(admin), body: { workspaceId: A, intelligenceId: String(legacyIntel._id), description: "x" } });
  check("D22 NO ACTION EXECUTION: no role holds action:execute, and the create/execute endpoint is refused even for an admin (403)", !Object.values(ROLE_PERMISSIONS).some((list) => list.includes("action:execute")) && execTry.status === 403);
  // a legacy (non-V1) Intelligence lets the generic endpoint create a legacy Decision; that Decision can never feed an Action proposal
  const plainSignal = await mkSignal("low");
  const plainIntel = await Intelligence.create({ workspaceId: wsA._id, signalIds: [plainSignal._id], generatedBy: "system", risk: { level: "low" } });
  ids.intelligences.push(plainIntel._id);
  const legacyOnlyDecision = await call("POST", "/decisions", { headers: H(admin), body: { workspaceId: A, intelligenceId: String(plainIntel._id), description: "legacy generic" } });
  const fromLegacy = await call("POST", `/actions/propose/${legacyOnlyDecision.data?._id}?workspaceId=${A}`, { headers: H(operator), body: { actionType: "inspection" } });
  check("D23 a legacy generic Decision can never lead to an Action: it is created (201) but an Action can only be proposed from a Decision V1 (422)", legacyOnlyDecision.status === 201 && fromLegacy.status === 422);
  const ctrlSrc = stripComments(read(path.join(BACKEND, "src", "controllers", "decisionController.js")) + read(path.join(BACKEND, "src", "controllers", "actionController.js")));
  check("D24 (static) the controllers take the proposer/reviewer ONLY from req.actor.userId - never from req.body / req.query / req.headers", (ctrlSrc.match(/actorUserId: req\.actor\.userId/g) || []).length === 6 && !/req\.(body|query|headers)(\?)?(\.|\[)\s*["']?(proposedBy|reviewedBy|actorUserId|userId|x-user-id)/.test(ctrlSrc));
  const sepErr = await caught(() => assertReviewerIsNotProposer({ governanceVersion: GOVERNANCE_VERSION, proposedBy: reviewerR.user._id }, String(reviewerR.user._id), "Action"));
  const sepOk = await caught(() => assertReviewerIsNotProposer({ governanceVersion: GOVERNANCE_VERSION, proposedBy: reviewerR.user._id }, String(reviewerR2.user._id), "Decision"));
  const sepErrDecision = await caught(() => assertReviewerIsNotProposer({ governanceVersion: GOVERNANCE_VERSION, proposedBy: reviewerR.user._id }, String(reviewerR.user._id), "Decision"));
  check("D25 the rule itself, in isolation: ACTION same user -> 403, different user -> allowed; DECISION same user -> allowed (Phase 48.1 policy); legacy -> allowed, governed-without-proposer -> 409, missing reviewer -> 401",
    sepErr?.statusCode === 403 && sepErrDecision === null && sepOk === null && (await caught(() => assertReviewerIsNotProposer({}, String(reviewerR.user._id), "Decision"))) === null &&
    (await caught(() => assertReviewerIsNotProposer({ governanceVersion: GOVERNANCE_VERSION }, String(reviewerR.user._id), "Decision")))?.statusCode === 409 && (await caught(() => assertReviewerIsNotProposer({}, undefined, "Decision")))?.statusCode === 401);
} finally {
  child.kill();
}

// ====================================================================================================== E. HYGIENE
console.log("\n# E. test / database hygiene");
const mkFixtureUser = async (subject) => { const u = await User.create({ issuer: STUB_ISSUER, subject, email: `${subject}@example.invalid` }); const m = await WorkspaceMembership.create({ userId: u._id, workspaceId: wsA._id, role: "viewer" }); return { u, m }; };
const synthetic = await mkFixtureUser(`authfetch-p35-${stamp}`);
const synthetic2 = await mkFixtureUser(`vis-nonadmin-p35-${stamp}`);
const control = await mkFixtureUser(`p35-control-not-swept-${stamp}`);
ids.usersExtra.push(control.u._id);
const swept = await sweepStaleAuthFixtures(0);
check("E1 the sweep removes the synthetic 'authfetch-' and 'vis-nonadmin-' fixtures (and ONLY their memberships)", !(await User.exists({ _id: synthetic.u._id })) && !(await User.exists({ _id: synthetic2.u._id })) && !(await WorkspaceMembership.exists({ _id: synthetic.m._id })) && !(await WorkspaceMembership.exists({ _id: synthetic2.m._id })) && swept.users >= 2);
check("E2 a user that does not carry a synthetic prefix is NOT touched, nor is their membership (no broad deletion)", Boolean(await User.exists({ _id: control.u._id })) && Boolean(await WorkspaceMembership.exists({ _id: control.m._id })));
const real = await User.countDocuments({ issuer: STUB_ISSUER, subject: /^eoi-dev-/ });
check("E3 the provisioned development identity (eoi-dev-*) is not a sweep target", real >= 0 && !/eoi-dev/.test(read(path.join(here, "lib", "authFixtures.mjs")).match(/SWEEPABLE_SUBJECT_PREFIXES = \[[^\]]*\]/)[0]));
const s27 = read(path.join(here, "validate-phase27-operational-context.mjs"));
const s32 = read(path.join(here, "validate-phase32-learning-integration.mjs"));
check("E4 Phase 27 and Phase 32 sweep the synthetic fixtures BEFORE they take their exact baseline", s27.indexOf("await sweepStaleAuthFixtures(0)") > 0 && s27.indexOf("await sweepStaleAuthFixtures(0)") < s27.indexOf("const before = await counts()") && s32.indexOf("await sweepStaleAuthFixtures(0)") > 0 && s32.indexOf("await sweepStaleAuthFixtures(0)") < s32.indexOf("const before = await counts()"));

const inventory = await countWorkspaceData(A);
check("E5 WORKSPACE DELETION covers the audit collection: AnalysisAdmission is in the deletion order and in the per-workspace inventory (a deleted tenant leaves no admission metadata behind)", WORKSPACE_DELETION_ORDER.includes("AnalysisAdmission") && inventory.AnalysisAdmission === (await AnalysisAdmission.countDocuments({ workspaceId: wsA._id })) && inventory.AnalysisAdmission > 0);

const ghostWorkspace = new (await import("mongoose")).default.Types.ObjectId();
await AnalysisAdmission.create({ workspaceId: ghostWorkspace, signalId: new (await import("mongoose")).default.Types.ObjectId(), attemptId: "00000000-0000-4000-8000-0000000000aa", outcome: "rejected", decidedAt: "provider", learningUsed: false });
const liveBefore = await AnalysisAdmission.countDocuments({ workspaceId: wsA._id });
const swept2 = await sweepOrphanAdmissions();
check("E6 the orphan sweep removes audit rows whose workspace no longer exists, and ONLY those: a live workspace's rows are untouched", swept2 === 1 && (await AnalysisAdmission.countDocuments({ workspaceId: ghostWorkspace })) === 0 && (await AnalysisAdmission.countDocuments({ workspaceId: wsA._id })) === liveBefore && liveBefore > 0);

// ====================================================================================================== F. INVARIANTS (static)
console.log("\n# F. invariants");
const pyPolicy = read(path.join(REPO, "ai-service", "app", "provider_policy.py"));
check("F1 the approved model is pinned identically in Node and the AI service: gemini-3.1-flash-lite, no 3.6, no preview, no latest, no fallback", /APPROVED_MODEL\s*=\s*"gemini-3\.1-flash-lite"/.test(pyPolicy) && APPROVED_MODEL === "gemini-3.1-flash-lite" && !/3\.6|preview|latest|fallback/i.test(stripComments(read(path.join(BACKEND, "src", "config", "providerPolicy.js"))).replace(/gemini-3\.1-flash-lite/g, "")));
check("F2 Learning is OFF by default in this process and in the audit trail", getLearningContextEnabled() === false && allStored.every((x) => x.learningUsed === false));
check("F3 the audit read path is service-level only: no route exposes AnalysisAdmission", !/AnalysisAdmission|analysisAdmission/.test(fs.readdirSync(path.join(BACKEND, "src", "routes")).map((f) => read(path.join(BACKEND, "src", "routes", f))).join("")) && !/AnalysisAdmission|analysisAdmission/.test(fs.readdirSync(path.join(BACKEND, "src", "controllers")).map((f) => read(path.join(BACKEND, "src", "controllers", f))).join("")));
check("F4 the documentation exists", fs.existsSync(path.join(BACKEND, "docs", "PRODUCTION_HARDENING_PHASE35.md")));
check("F5 no API-key-shaped string in the files this phase added", ["admissionMetadata.js", "analysisFailureTaxonomy.js"].every((f) => !/AIza[0-9A-Za-z_-]{20,}|sk-[A-Za-z0-9]{20,}/.test(read(path.join(BACKEND, "src", "services", "ai", f)))) && ["analysisAdmissionService.js", "governance.js"].every((f) => !/AIza[0-9A-Za-z_-]{20,}|sk-[A-Za-z0-9]{20,}/.test(read(path.join(BACKEND, "src", "services", f)))));

// ====================================================================================================== cleanup + baseline
const ws = { $in: ids.workspaces };
await Promise.all([AnalysisAdmission.deleteMany({ workspaceId: ws }), Action.deleteMany({ workspaceId: ws }), Decision.deleteMany({ workspaceId: ws })]);
await Promise.all([Intelligence.deleteMany({ workspaceId: ws }), Signal.deleteMany({ workspaceId: ws })]);
await cleanupAuthFixtures();
await WorkspaceMembership.deleteMany({ workspaceId: ws });
await User.deleteMany({ _id: { $in: ids.usersExtra } });
await Workspace.deleteMany({ _id: ws });
const after = await baselineCounts();
check("Z1 nothing was wiped and nothing leaked: every pre-existing collection count equals its pre-run value", JSON.stringify(after) === JSON.stringify(before), JSON.stringify({ before, after }));
await disconnectDatabase();
for (const r of fake.hung) r.destroy();
stub.close();
console.log(`\nPhase 35 audit / governance / hardening validation: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
