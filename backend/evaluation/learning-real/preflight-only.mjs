/**
 * Phase 33 — STANDALONE one-call preflight. Verifies a newly-configured Gemini key/model works before any
 * commitment to the full evaluation sweep. Deliberately separate from run-real-evaluation.mjs, whose own
 * preflight step is SKIPPED once any cached successful call exists (by design, to avoid re-spending quota on
 * re-verifying something already proven) - exactly the behavior that must NOT run right now.
 *
 * This script:
 *   - makes EXACTLY ONE real Gemini generation call, using synthetic content only;
 *   - never reads or writes results-arm-a.json / results-arm-b.json (the cached 12 attempted / 5 successful
 *     calls from prior runs are completely untouched - not even opened);
 *   - never touches MongoDB (no import of any Mongoose model or database config);
 *   - never reads or sets KOI_LEARNING_CONTEXT_ENABLED;
 *   - never enables Learning context on this call (the body it sends has no `learning` key);
 *   - does not loop, retry, or proceed to any further case - exactly one request, then stops.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const AI_DIR = path.join(here, "..", "..", "..", "ai-service");
const PYTHON = process.platform === "win32" ? path.join(AI_DIR, ".venv", "Scripts", "python.exe") : path.join(AI_DIR, ".venv", "bin", "python");
const PORT = 7405; // distinct from run-real-evaluation.mjs's own 7401, so the two can never collide
const BASE = `http://127.0.0.1:${PORT}/v1`;

const SYNTHETIC_BODY = {
  context: {
    signal: { id: "preflight-syn-1", type: "maintenance", source: "system", severity: "low", status: "new", title: "Preflight check signal", description: "Synthetic preflight content only - no production or sensitive data." },
    history: { signals: [] },
  },
  knowledge: [],
  authorizedLevel: "staff",
  // deliberately no `learning` key - this preflight never touches Learning at all
};

async function waitForHealth(base, timeoutMs = 20000) {
  const start = Date.now();
  for (;;) {
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch {
      // not ready
    }
    if (Date.now() - start > timeoutMs) throw new Error(`ai-service not healthy at ${base}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}
const stopProc = (child) => new Promise((resolve) => {
  if (!child || child.exitCode !== null) return resolve();
  child.once("exit", () => resolve());
  child.kill();
  setTimeout(resolve, 5000);
});

const USAGE_LINE = /\[PHASE33_USAGE\] prompt=(\S+) candidates=(\S+) total=(\S+)/;
// Safe: the ai-service's own error logging NEVER includes the key or the raw provider message, only the
// exception type name and a numeric/short code (see app/services/gemini_client.py's _map_provider_error) -
// surfacing it here means a single failed preflight is self-diagnosing without needing a follow-up call.
const PROVIDER_ERROR_LINE = /Gemini provider error[^:]*: (\S+) code=(\S+)/;

const ai = spawn(PYTHON, ["-m", "uvicorn", "app.main:app", "--port", String(PORT), "--host", "127.0.0.1"], {
  cwd: AI_DIR,
  env: { ...process.env, LLM_PROVIDER: "gemini", PHASE33_LOG_USAGE: "true" },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
ai.stdout?.on("data", (d) => { log += d.toString(); });
ai.stderr?.on("data", (d) => { log += d.toString(); });

let result;
try {
  await waitForHealth(BASE);
  const response = await fetch(`${BASE}/intelligence/analyze`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(SYNTHETIC_BODY) });
  const json = await response.json();
  const usageMatch = log.match(USAGE_LINE);
  const providerErrorMatch = log.match(PROVIDER_ERROR_LINE);
  result = {
    status: response.status,
    ok: response.status === 200,
    provider: json?.provenance?.provider ?? null,
    model: json?.provenance?.model ?? null,
    errorCode: json?.error?.code ?? null,
    errorMessage: json?.error?.message ?? null,
    providerSideErrorType: providerErrorMatch ? providerErrorMatch[1] : null,
    providerSideErrorCode: providerErrorMatch ? providerErrorMatch[2] : null,
    usage: usageMatch ? { prompt: Number(usageMatch[1]) || null, candidates: Number(usageMatch[2]) || null, total: Number(usageMatch[3]) || null } : null,
  };
} finally {
  await stopProc(ai);
}

console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
