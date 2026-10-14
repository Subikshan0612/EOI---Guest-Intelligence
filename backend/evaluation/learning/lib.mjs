import crypto from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AI_DIR = path.join(__dirname, "..", "..", "..", "ai-service");
const PYTHON = process.platform === "win32" ? path.join(AI_DIR, ".venv", "Scripts", "python.exe") : path.join(AI_DIR, ".venv", "bin", "python");

/** Refuses to run against a real provider, exactly like evaluation/retrieval/lib.mjs's own guard. */
export function assertOfflineEnvironment(env) {
  if ((env.LLM_PROVIDER || "").trim().toLowerCase() === "gemini") throw new Error("Refusing: LLM_PROVIDER=gemini in the launching environment.");
  if ((env.GEMINI_API_KEY || "").trim() !== "") throw new Error("Refusing: a real GEMINI_API_KEY is set in the launching environment.");
}

async function waitForHealth(base, timeoutMs = 20000) {
  const start = Date.now();
  for (;;) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) return;
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

/** Starts a forced-test ai-service (LLM_PROVIDER=test, no key), runs `fn({ base })`, always stops it after. */
export async function withTestAiService(fn, { port = 7301 } = {}) {
  const ai = spawn(PYTHON, ["-m", "uvicorn", "app.main:app", "--port", String(port), "--host", "127.0.0.1"], {
    cwd: AI_DIR,
    env: { ...process.env, LLM_PROVIDER: "test", EMBEDDING_PROVIDER: "test", GEMINI_API_KEY: "" },
    stdio: "ignore",
  });
  const base = `http://127.0.0.1:${port}/v1`;
  try {
    await waitForHealth(base);
    return await fn({ base });
  } finally {
    await stopProc(ai);
  }
}

export async function postAnalyze(base, body) {
  const response = await fetch(`${base}/intelligence/analyze`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await response.json();
  return { status: response.status, json };
}

/** A fixed, canonical hash over deterministic content only - mirrors evaluation/retrieval/lib.mjs's resultsHash. */
export function resultsHash(result) {
  return crypto.createHash("sha256").update(JSON.stringify(result)).digest("hex");
}
