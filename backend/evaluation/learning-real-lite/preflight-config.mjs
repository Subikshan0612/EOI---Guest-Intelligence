/**
 * Phase 33-Lite — configuration/preflight validation. Makes NO Gemini call of any kind: no generation, no
 * embedding, no model-list request, no HTTP request at all. It only resolves local configuration.
 *
 *   node evaluation/learning-real-lite/preflight-config.mjs
 *
 * Verifies: the exact Lite model/provider the spawned ai-service will resolve (via the service's own settings
 * loader, with the Lite environment applied), that the DEFAULT model is untouched, the synthetic-only Phase 33
 * dataset (version, hash, 24 cases, 144 slots), that production Learning is OFF, and the separate results namespace.
 * The API key is reported only as present/absent - its value is never read into output.
 *
 * Note: the model ID's existence at Google cannot be proven without a network call; the first real slot (and its
 * response provenance, which the runner checks) is the first point at which that is confirmed.
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { CASES, DATASET_VERSION } from "../learning-real/dataset.mjs";
import { assertSyntheticOnly } from "../learning-real/syntheticGuard.mjs";
import { getLearningContextEnabled } from "../../src/config/runtimeConfig.js";
import { AI_DIR, LITE_MODEL, LITE_PROVIDER, LITE_RESULTS_DIR, PHASE33_RESULTS_DIR, REPETITIONS, assertLiteConfig, defaultProjectKeys, liteSpawnEnv, loadLiteApiKey } from "./lite-config.mjs";
import { evaluationIdentity } from "./lite-identity.mjs";

const PYTHON = process.platform === "win32" ? path.join(AI_DIR, ".venv", "Scripts", "python.exe") : path.join(AI_DIR, ".venv", "bin", "python");
const PROBE = "import json; from app.config import settings as s; import hashlib; print(json.dumps({'provider': s.llm_provider, 'model': s.llm_model, 'keyPresent': bool(s.gemini_api_key), 'keySha256': hashlib.sha256((s.gemini_api_key or '').encode()).hexdigest()}))";
const resolveSettings = (env) => JSON.parse(execFileSync(PYTHON, ["-c", PROBE], { cwd: AI_DIR, env, encoding: "utf8" }).trim().split("\n").pop());

let failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`PASS  ${name}`);
  else { failed += 1; console.error(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`); }
};

assertLiteConfig();
check("Lite config is internally consistent (exact model id, separate results namespace, production Learning not enabled in env)", true);

const sha = (v) => crypto.createHash("sha256").update(v).digest("hex");
const liteKey = loadLiteApiKey(); // throws if absent or identical to the default key; the value is never printed
check(`a dedicated Lite API key is detected (source: ${liteKey.source}); value not shown`, Boolean(liteKey.key));
const lite = resolveSettings(liteSpawnEnv(process.env, liteKey.key));
check(`spawned ai-service resolves provider=${LITE_PROVIDER}`, lite.provider === LITE_PROVIDER, JSON.stringify(lite));
check(`spawned ai-service resolves the EXACT model "${LITE_MODEL}"`, lite.model === LITE_MODEL, JSON.stringify(lite));
check("the spawned ai-service resolves a key", lite.keyPresent === true);
check("the key the spawned ai-service resolves IS the dedicated Lite key (compared by hash; value never printed)", lite.keySha256 === sha(liteKey.key));
check("the Lite key is DIFFERENT from the default project (Gemini 3.6 Flash) key", defaultProjectKeys().every((k) => sha(k) !== sha(liteKey.key)));

// The default (what every other phase / production uses) must be unaffected: no Lite env => the .env default.
const { LLM_MODEL: _m, LLM_PROVIDER: _p, ...envWithoutOverride } = process.env;
const normal = resolveSettings(envWithoutOverride);
check("the DEFAULT model resolved without the Lite override is NOT the Lite model (override is spawn-only; .env untouched)", normal.model !== LITE_MODEL, `default=${normal.model}`);
check("the default provider is still the non-real 'test' provider (normal traffic never reaches Gemini)", normal.provider === "test", `default=${normal.provider}`);
check("without the Lite override the service still resolves the DEFAULT key from ai-service/.env, not the Lite key (default configuration untouched)", normal.keySha256 !== sha(liteKey.key) && defaultProjectKeys().some((k) => sha(k) === normal.keySha256));

assertSyntheticOnly(CASES);
check("dataset is the existing synthetic-only Phase 33 dataset (guard scan clean)", true);
const identity = evaluationIdentity();
check(`dataset version is ${DATASET_VERSION}`, identity.datasetVersion === "phase33-real-learning-eval-v1");
check("24 cases, 2 arms, 3 runs => 144 slots", CASES.length === 24 && identity.totalSlots === 144 && REPETITIONS === 3);

delete process.env.KOI_LEARNING_CONTEXT_ENABLED;
check("production KOI_LEARNING_CONTEXT_ENABLED resolves to false", getLearningContextEnabled() === false);
check("Lite results namespace is separate from Phase 33 and names the model", path.resolve(LITE_RESULTS_DIR) !== path.resolve(PHASE33_RESULTS_DIR) && path.basename(LITE_RESULTS_DIR).includes(LITE_MODEL));

console.log(JSON.stringify({ model: lite.model, provider: lite.provider, defaultModel: normal.model, resultsDir: LITE_RESULTS_DIR, datasetVersion: identity.datasetVersion, datasetSha256: identity.datasetSha256, cases: identity.cases, totalSlots: identity.totalSlots }, null, 2));
console.log(`\nPhase 33-Lite config preflight: ${failed === 0 ? "ALL CHECKS PASSED" : `${failed} FAILED`} (no Gemini call was made)`);
process.exit(failed === 0 ? 0 : 1);
