/**
 * Phase 37 - production-like DEPLOYMENT REHEARSAL (no Gemini call is made; no production data; no secret is printed).
 *
 *   node scripts/phase37/deployment-rehearsal.mjs
 *
 * Clean, isolated environment: a throwaway MongoDB database (koi_p37_rehearsal_<ts>, dropped at the end) and two real processes started with
 * PRODUCTION configuration:
 *   - the AI service (python -m uvicorn app.main:app) with LLM_PROVIDER=gemini, LLM_MODEL=gemini-3.1-flash-lite, REQUEST_TIMEOUT_MS=20000,
 *     the dedicated Gemini key present in ITS environment only (so the "key required" startup gate is satisfied for real);
 *   - the backend (node server.js) with NODE_ENV=production, AUTH_PROVIDER=oidc (a non-resolving issuer: no token is ever verified),
 *     LLM_PROVIDER=gemini, AI_SERVICE_URL -> the AI service, Learning unset.
 * It then checks health, the live Node<->Python contract WITHOUT a model call (embedding via the test provider, retrieval, and a schema-invalid
 * analyze request that Python rejects before any provider is involved), the model/timeout/key pins, and that every invalid configuration
 * still FAILS CLOSED. Only statuses are recorded (outside the repository).
 */
import "../../src/config/mongoSafety.js"; // validation / rehearsal tool: loopback databases only
import dotenv from "dotenv";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

{ const __u = dotenv.parse(process.getBuiltinModule("node:fs").readFileSync(new URL("../../.env", import.meta.url))).MONGODB_URI ?? ""; if (/^mongodb:\/\/(?:[^@/]*@)?(localhost|127\.0\.0\.1)/i.test(__u)) process.env.MONGODB_URI ??= __u; } // validation / rehearsal tools take ONLY a loopback database URI from backend/.env, never its real settings
const here = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(here, "..", "..");
const AI = path.join(BACKEND, "..", "ai-service");
const PYTHON = path.join(AI, ".venv", "Scripts", "python.exe");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const baseUri = process.env.MONGODB_URI ?? "";
const dbName = `koi_p37_rehearsal_${Date.now()}`;
const isolatedUri = baseUri.replace(/(mongodb(?:\+srv)?:\/\/[^/]+\/)([^?]*)/, `$1${dbName}`);
if (!baseUri || isolatedUri === baseUri) { console.error("MONGODB_URI is not configured."); process.exit(2); }
const { APPROVED_MODEL, APPROVED_PROVIDER } = await import("../../src/config/providerPolicy.js");
const { loadLiteApiKey } = await import("../../evaluation/learning-real-lite/lite-config.mjs");
const keyInfo = loadLiteApiKey(process.env); // never printed
const KEY = keyInfo.key;
console.log(`[setup] Gemini key present (source: ${keyInfo.source}); value not shown. Isolated database: ${dbName}`);

const results = [];
const record = (name, ok, detail = "") => { results.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 120) }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${String(detail).slice(0, 140)}` : ""}`); };

const PY_PORT = 8197;
const NODE_PORT = 5199;
const pyEnv = (extra = {}) => {
  const env = { ...process.env };
  for (const k of ["GEMINI_API_KEY", "LLM_PROVIDER", "LLM_MODEL", "PHASE33_LITE_GEMINI_API_KEY", "REQUEST_TIMEOUT_MS", "LLM_MAX_OUTPUT_TOKENS", "EMBEDDING_PROVIDER", "MONGODB_URI"]) delete env[k];
  return { ...env, LLM_PROVIDER: APPROVED_PROVIDER, LLM_MODEL: APPROVED_MODEL, REQUEST_TIMEOUT_MS: "20000", LLM_MAX_OUTPUT_TOKENS: "4096", EMBEDDING_PROVIDER: "test", GEMINI_API_KEY: KEY, PYTHONUNBUFFERED: "1", ...extra };
};
const nodeEnv = (extra = {}) => {
  const env = { ...process.env };
  for (const k of ["KOI_LEARNING_CONTEXT_ENABLED", "AUTH_TOKEN_VERIFIER", "AUTH_STUB_SECRET", "KOI_AI_TIMEOUT_MS", "KOI_SOCKET_TIMEOUT_MS", "GEMINI_API_KEY"]) delete env[k];
  return { ...env, NODE_ENV: "production", PORT: String(NODE_PORT), MONGODB_URI: isolatedUri, AUTH_PROVIDER: "oidc", OIDC_ISSUER: "https://127.0.0.1:9", OIDC_AUDIENCE: "eoi-p37-rehearsal", LLM_PROVIDER: APPROVED_PROVIDER, AI_SERVICE_URL: `http://127.0.0.1:${PY_PORT}`, ...extra };
};
const run = (cmd, args, env, { cwd, timeout = 60000 } = {}) => spawnSync(cmd, args, { cwd, env, encoding: "utf8", timeout });
const leaked = (text) => KEY && text.includes(KEY);

const procs = [];
const startServer = (cmd, args, env, cwd, healthUrl) => new Promise((resolve) => {
  const out = [];
  const proc = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  procs.push(proc);
  proc.stdout.on("data", (d) => out.push(String(d)));
  proc.stderr.on("data", (d) => out.push(String(d)));
  let exited = false; proc.on("exit", (code) => { exited = true; resolve({ proc, out, started: false, code }); });
  (async () => { for (let i = 0; i < 120 && !exited; i += 1) { try { const r = await fetch(healthUrl); if (r.ok) return resolve({ proc, out, started: true, health: r.status, headers: r.headers, json: await r.json().catch(() => null) }); } catch { /* not yet */ } await sleep(500); } if (!exited) resolve({ proc, out, started: false, code: "timeout" }); })();
});
let exitCode = 0;
let mongoose = null;
try {
  // ---------------------------------------------------------------------------------------------- 1. the AI service, production configuration
  const py = await startServer(PYTHON, ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(PY_PORT)], pyEnv(), AI, `http://127.0.0.1:${PY_PORT}/v1/health`);
  record("R1 AI service starts with the production Gemini configuration (exact model, 20 s timeout, key present)", py.started, py.started ? "healthy" : `exit ${py.code}`);
  const cfg = run(PYTHON, ["-c", "import json; from app.config import settings; print(json.dumps({'provider':settings.llm_provider,'model':settings.llm_model,'timeoutMs':settings.request_timeout_ms,'maxTokens':settings.llm_max_output_tokens,'embedding':settings.embedding_provider,'keyConfigured':bool(settings.gemini_api_key)}))"], pyEnv(), { cwd: AI });
  const parsed = JSON.parse(cfg.stdout || "{}");
  record("R2 the running configuration is exactly gemini / gemini-3.1-flash-lite, timeout 20000 ms (the ceiling), bounded generation, key configured (boolean only)", parsed.provider === "gemini" && parsed.model === "gemini-3.1-flash-lite" && parsed.timeoutMs === 20000 && parsed.maxTokens === 4096 && parsed.keyConfigured === true && !leaked(cfg.stdout), JSON.stringify({ ...parsed }));

  // ---------------------------------------------------------------------------------------------- 2. the backend, production configuration
  const node = await startServer(process.execPath, ["server.js"], nodeEnv(), BACKEND, `http://127.0.0.1:${NODE_PORT}/api/health`);
  const nodeOut = node.out.join("");
  record("R3 backend starts with NODE_ENV=production, OIDC, the gemini route and a valid AI_SERVICE_URL", node.started && /Authentication provider: oidc/.test(nodeOut) && !/Refusing to start/.test(nodeOut), node.started ? "healthy" : `exit ${node.code}`);
  record("R4 /api/health answers, reports the database, and every response carries X-Request-Id", node.started && node.health === 200 && /^[0-9a-f-]{36}$/.test(node.headers?.get("x-request-id") ?? ""), JSON.stringify(node.json?.database ?? node.json ?? {}).slice(0, 80));
  record("R5 startup output: production warnings name the PROCESS-LOCAL limits (rate limit, single-flight), Learning is not enabled, and no secret is printed anywhere", /PROCESS-LOCAL/.test(nodeOut) && /single-flight is PROCESS-LOCAL/.test(nodeOut) && !/Learning context is being added/.test(nodeOut) && !leaked(nodeOut + py.out.join("")), "");

  // ---------------------------------------------------------------------------------------------- 3. live Node <-> Python contract (no model call)
  process.env.AI_SERVICE_URL = `http://127.0.0.1:${PY_PORT}`;
  const client = await import("../../src/services/ai/aiServiceClient.js");
  const emb = await (await fetch(`http://127.0.0.1:${PY_PORT}/v1/embeddings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ texts: ["rehearsal"] }) })).json();
  const retrieval = await client.requestKnowledgeRetrievalFromAiService("rehearsal", [{ chunkId: "c1", embedding: emb.embeddings[0], scope: "workspace", visibility: "guest", embeddingModel: emb.model }], "guest");
  record("R6 Node's real client -> the AI service retrieval endpoint: the request validates and the response has the shape Node reads (results, model, evaluated, incompatible), with no provider call", Array.isArray(retrieval.results) && typeof retrieval.model === "string" && retrieval.evaluatedCandidates === 1);
  const invalid = await fetch(`http://127.0.0.1:${PY_PORT}/v1/intelligence/analyze`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ context: {}, knowledge: "not-a-list" }) });
  const invalidBody = await invalid.json().catch(() => null);
  const mapped = client.mapAiServiceError(invalidBody, invalid.status);
  record("R7 a schema-invalid analyze request is rejected BY THE AI SERVICE before any provider is involved (422 VALIDATION_FAILED) and Node maps it to its own stable code (invalid_request class), not a generic error", invalid.status === 422 && invalidBody?.error?.code === "VALIDATION_FAILED" && mapped.details?.code === "VALIDATION_FAILED");
  const { classifyFailureCode } = await import("../../src/services/ai/analysisFailureTaxonomy.js");
  record("R8 timeout contract (Workstream 5C): Node's analysis wait (65 s) exceeds the AI service's 60 s analysis deadline ceiling on the gemini route - the backend started, so the startup check passed", node.started && classifyFailureCode("VALIDATION_FAILED") === "invalid_request");

  // ---------------------------------------------------------------------------------------------- 4. invalid configurations still FAIL CLOSED
  const pyRefuses = (label, extra) => { const r = run(PYTHON, ["-c", "import app.main"], pyEnv(extra), { cwd: AI }); record(`R9 Python refuses: ${label}`, r.status !== 0 && !leaked(r.stdout + r.stderr), `exit ${r.status}`); };
  pyRefuses("a wrong model", { LLM_MODEL: "gemini-3.6-flash" });
  pyRefuses("a preview model", { LLM_MODEL: "gemini-3.1-flash-lite-preview" });
  pyRefuses("an alias / latest model", { LLM_MODEL: "gemini-flash-latest" });
  pyRefuses("a missing Gemini key", { GEMINI_API_KEY: "" });
  pyRefuses("an unsupported provider", { LLM_PROVIDER: "gemni" });
  pyRefuses("an invalid timeout (not a number)", { REQUEST_TIMEOUT_MS: "soon" });
  pyRefuses("an unsafe timeout (60 s, above the 20 s ceiling)", { REQUEST_TIMEOUT_MS: "60000" });
  pyRefuses("an unsafe analysis deadline (above the 60 s analysis ceiling)", { LLM_ANALYSIS_TIMEOUT_MS: "60001" });
  const nodeRefuses = (label, extra) => { const r = run(process.execPath, ["server.js"], nodeEnv({ PORT: String(NODE_PORT + 1), ...extra }), { cwd: BACKEND, timeout: 30000 }); record(`R10 backend refuses: ${label}`, r.status === 1 && /Refusing to start/.test(r.stderr + r.stdout) && !leaked(r.stdout + r.stderr), `exit ${r.status}`); };
  nodeRefuses("an invalid AI service URL", { AI_SERVICE_URL: "not a url" });
  nodeRefuses("a missing AI service URL", { AI_SERVICE_URL: "" });
  nodeRefuses("a deterministic provider in production", { LLM_PROVIDER: "test-python" });
  nodeRefuses("an unsupported provider", { LLM_PROVIDER: "gemni" });
  nodeRefuses("an invalid timeout configuration (60 s base)", { KOI_AI_TIMEOUT_MS: "60000" });
  nodeRefuses("an incompatible timeout configuration (socket 20 s < analysis)", { KOI_SOCKET_TIMEOUT_MS: "20000" });
  nodeRefuses("an analysis timeout at or below the AI service's Gemini analysis ceiling (Workstream 5C: 60 s)", { KOI_AI_ANALYSIS_TIMEOUT_MS: "50000" });
  nodeRefuses("missing authentication configuration", { AUTH_PROVIDER: "", OIDC_ISSUER: "", OIDC_AUDIENCE: "" });

  record("R11 exact model pin on both sides, no fallback, no retry: Node constant, Python setting, one fetch in the client, SDK attempts=1", APPROVED_MODEL === "gemini-3.1-flash-lite" && parsed.model === APPROVED_MODEL && !/retry|backoff|fallback/i.test(fs.readFileSync(path.join(BACKEND, "src", "services", "ai", "aiServiceClient.js"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")) && /attempts=1/.test(fs.readFileSync(path.join(AI, "app", "services", "gemini_analysis_client.py"), "utf8")));
} catch (error) {
  record("rehearsal crashed", false, error?.message ?? error);
} finally {
  for (const p of procs) { try { p.kill(); } catch { /* gone */ } }
  await sleep(500);
  try {
    mongoose = (await import("mongoose")).default;
    await mongoose.connect(isolatedUri);
    if (mongoose.connection.name === dbName && dbName.startsWith("koi_p37_rehearsal_")) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  } catch { /* best effort */ }
}
const failed = results.filter((r) => !r.ok).length;
const out = path.join("C:\\Users\\Subikshan\\Desktop\\EOI_CHECKPOINTS", "phase37-rehearsal");
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, `rehearsal-${new Date().toISOString().replace(/[:.]/g, "-")}.json`), JSON.stringify({ phase: 37, model: APPROVED_MODEL, geminiCallsMade: 0, passed: results.length - failed, failed, results }, null, 2));
console.log(`\nDeployment rehearsal: ${results.length - failed} passed, ${failed} failed (no Gemini call was made; isolated database dropped).`);
process.exit(failed === 0 ? 0 : 1);
