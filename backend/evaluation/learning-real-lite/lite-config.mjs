/**
 * Phase 33-Lite — configuration for a COMPLETELY SEPARATE real-model evaluation using `gemini-3.1-flash-lite`.
 *
 * Phase 33-Lite is NOT a continuation, replacement, rerun or reinterpretation of the Phase 33 Gemini 3.6 Flash
 * evaluation. Only the LLM model differs. It reuses, unchanged and by import, everything else from
 * ../learning-real/: the dataset (24 synthetic cases), syntheticGuard, manifest builder, grounding (Phase 28's
 * production validator), metrics, and the slotState durability/scheduling helpers. Results live in their own
 * namespace and never touch the Phase 33 results directory.
 *
 * The model AND the dedicated Lite API key are supplied ONLY in the environment of the ai-service process this
 * evaluation spawns (environment variables take precedence over ai-service/.env). ai-service/.env (the default
 * Gemini 3.6 Flash configuration and key), production code, and the default model are never modified.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const BACKEND_DIR = path.join(here, "..", "..");
export const AI_DIR = path.join(BACKEND_DIR, "..", "ai-service");

export const EVALUATION_ID = "phase33-lite";
export const LITE_PROVIDER = "gemini";
export const LITE_MODEL = "gemini-3.1-flash-lite";
export const REPETITIONS = 3; // same as Phase 33: 24 cases x 2 arms x 3 runs = 144 slots

export const RESULTS_DIR_NAME = `phase33-lite-${LITE_MODEL}`;
export const LITE_RESULTS_DIR = path.join(BACKEND_DIR, "evaluation", "results", RESULTS_DIR_NAME);
export const PHASE33_RESULTS_DIR = path.join(BACKEND_DIR, "evaluation", "results", "phase33");

// Distinct from Phase 33's runner (7401) and every earlier phase's harness ports.
export const LITE_PORT = 7411;

export const DEFAULT_DAILY_CALL_BUDGET = 8;
export const DEFAULT_CALL_SPACING_MS = 6000;

// ---- Dedicated Lite API key (separate Google AI Studio project) -----------------------------------------------
// The key lives ONLY in a gitignored file next to the Lite runner (or in the PHASE33_LITE_GEMINI_API_KEY environment
// variable, which takes precedence). It is passed ONLY to the ai-service process this evaluation spawns, as that
// process's GEMINI_API_KEY (an environment variable outranks ai-service/.env). ai-service/.env - which holds the
// Gemini 3.6 Flash key - is never written; it is only READ here to refuse a Lite key identical to it.
export const LITE_ENV_FILE = path.join(here, ".env.lite");
export const LITE_KEY_ENV_VAR = "PHASE33_LITE_GEMINI_API_KEY";
const DEFAULT_AI_ENV_FILE = path.join(AI_DIR, ".env");

function parseEnvKey(text, name) {
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(new RegExp(`^\\s*${name}\\s*=\\s*(.*)$`));
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  }
  return "";
}
function readKeyFromFile(file, name) {
  try {
    return parseEnvKey(fs.readFileSync(file, "utf8"), name);
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw new Error(`Refusing: cannot read ${path.basename(file)} (${error?.code || "error"}).`);
  }
}

/** The Gemini 3.6 Flash key the rest of the project uses (ai-service/.env, or an inherited GEMINI_API_KEY). Read-only. */
export function defaultProjectKeys(env = process.env) {
  return [readKeyFromFile(DEFAULT_AI_ENV_FILE, "GEMINI_API_KEY"), (env.GEMINI_API_KEY ?? "").trim()].filter(Boolean);
}

/**
 * Resolves the dedicated Lite key. NEVER falls back to the default project key: a missing Lite key is an error,
 * and a Lite key identical to the default key is refused. Returns { key, source } - `source` names where it came
 * from (never the value); callers must not log `key`.
 */
export function loadLiteApiKey(env = process.env) {
  const fromEnv = (env[LITE_KEY_ENV_VAR] ?? "").trim();
  const fromFile = fromEnv ? "" : readKeyFromFile(LITE_ENV_FILE, "GEMINI_API_KEY");
  const key = fromEnv || fromFile;
  if (!key) throw new Error(`Refusing: no dedicated Phase 33-Lite API key. Provide ${LITE_KEY_ENV_VAR} or GEMINI_API_KEY in ${path.basename(LITE_ENV_FILE)}. It will NOT fall back to the default (Gemini 3.6 Flash) key.`);
  if (defaultProjectKeys(env).includes(key)) throw new Error("Refusing: the Lite API key is identical to the default project's key. Phase 33-Lite requires its own dedicated key.");
  return { key, source: fromEnv ? `environment variable ${LITE_KEY_ENV_VAR}` : `file backend/evaluation/learning-real-lite/${path.basename(LITE_ENV_FILE)}` };
}

/** Env for the spawned ai-service: the Lite model, the dedicated Lite key, and the usage-log opt-in - nothing else is changed. */
export function liteSpawnEnv(baseEnv = process.env, apiKey) {
  if (!apiKey) throw new Error("Refusing to build the Lite spawn environment without the dedicated Lite API key (no fallback to the default key).");
  const env = { ...baseEnv, LLM_PROVIDER: LITE_PROVIDER, LLM_MODEL: LITE_MODEL, GEMINI_API_KEY: apiKey, PHASE33_LOG_USAGE: "true" };
  delete env[LITE_KEY_ENV_VAR]; // the spawned service needs only GEMINI_API_KEY
  return env;
}

/** Fails closed on any configuration that could blur Lite with Phase 33 or enable production Learning. */
export function assertLiteConfig(env = process.env) {
  if (LITE_MODEL !== "gemini-3.1-flash-lite") throw new Error(`Refusing: LITE_MODEL must be exactly "gemini-3.1-flash-lite", got "${LITE_MODEL}".`);
  if (path.resolve(LITE_RESULTS_DIR) === path.resolve(PHASE33_RESULTS_DIR)) throw new Error("Refusing: Lite results directory equals the Phase 33 results directory.");
  if (!path.basename(LITE_RESULTS_DIR).includes(LITE_MODEL)) throw new Error("Refusing: Lite results directory name must identify the model.");
  if (path.resolve(LITE_RESULTS_DIR).startsWith(path.resolve(PHASE33_RESULTS_DIR) + path.sep)) throw new Error("Refusing: Lite results directory is nested inside the Phase 33 results directory.");
  if ((env.KOI_LEARNING_CONTEXT_ENABLED ?? "").trim().toLowerCase() === "true") throw new Error("Refusing: KOI_LEARNING_CONTEXT_ENABLED is true in this environment. Production Learning must remain OFF for evaluation runs.");
  if ((env.LLM_MODEL ?? LITE_MODEL) !== LITE_MODEL) console.warn(`[lite] note: LLM_MODEL="${env.LLM_MODEL}" in the launching environment is IGNORED; the spawned service is forced to ${LITE_MODEL}.`);
}
