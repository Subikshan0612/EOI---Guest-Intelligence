/**
 * Starts the local TEST stack with the AI providers FORCED to the deterministic test providers (Phase 21 test-provider isolation).
 *
 *   node backend/scripts/start-test-stack.mjs            # ai-service :8010, backend :5002 (test-python), backend :5057 (test)
 *
 * WHY: ai-service/.env may configure REAL providers and a real API key, and a service started from that directory picks them up.
 * Running a test suite against such a service can spend real provider calls. This launcher never relies on any .env default:
 *   - ai-service gets LLM_PROVIDER=test, EMBEDDING_PROVIDER=test and an EMPTY GEMINI_API_KEY in the PROCESS environment (which
 *     takes precedence over .env);
 *   - the backends get NODE_ENV=test (which makes them REFUSE to start with a non-loopback AI_SERVICE_URL or openai + key),
 *     AI_SERVICE_URL pointing only at the local test ai-service, and rate limiting off for the high-volume legacy suites.
 * No key or secret is printed. Stop with Ctrl+C.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const backend = path.join(here, "..");
const aiService = path.join(backend, "..", "ai-service");
const python = process.platform === "win32" ? path.join(aiService, ".venv", "Scripts", "python.exe") : path.join(aiService, ".venv", "bin", "python");

const AI_PORT = Number(process.env.TEST_AI_PORT || 8010);
const forced = { LLM_PROVIDER: "test", EMBEDDING_PROVIDER: "test", GEMINI_API_KEY: "" };
const secret = process.env.AUTH_STUB_SECRET || "eoi-suite-stub-secret-not-real-0123456789";
const backendEnv = (port, provider) => ({
  ...process.env,
  PORT: String(port),
  NODE_ENV: "test",
  LLM_PROVIDER: provider,
  AI_SERVICE_URL: `http://localhost:${AI_PORT}`,
  KOI_RATE_LIMIT_ENABLED: process.env.KOI_RATE_LIMIT_ENABLED ?? "false",
  // Phase 25: hash-based test embeddings carry no meaning, so the legacy suites run with the relevance floor disabled (see lib/authFixtures.mjs).
  KOI_RETRIEVAL_MIN_SIMILARITY: process.env.KOI_RETRIEVAL_MIN_SIMILARITY ?? "-1",
  KNOWLEDGE_DEV_AUTHORIZED_LEVEL: process.env.KNOWLEDGE_DEV_AUTHORIZED_LEVEL ?? "restricted",
  AUTH_TOKEN_VERIFIER: "stub",
  AUTH_STUB_SECRET: secret,
});

const procs = [
  spawn(python, ["-m", "uvicorn", "app.main:app", "--port", String(AI_PORT)], { cwd: aiService, env: { ...process.env, ...forced }, stdio: "inherit" }),
  spawn(process.execPath, ["server.js"], { cwd: backend, env: backendEnv(5002, "test-python"), stdio: "inherit" }),
  spawn(process.execPath, ["server.js"], { cwd: backend, env: backendEnv(5057, "test"), stdio: "inherit" }),
];
console.log(`[test-stack] ai-service :${AI_PORT} (LLM/EMBEDDING = test, key emptied), backend :5002 (test-python), backend :5057 (test). Ctrl+C to stop.`);
const stop = () => {
  for (const p of procs) p.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
