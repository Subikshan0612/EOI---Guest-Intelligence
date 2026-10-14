/**
 * Phase 33-Lite validation - LOCAL/STATIC ONLY. Zero Gemini calls, zero network requests, zero database access.
 * Checks that the separate `gemini-3.1-flash-lite` evaluation is wired exactly as specified: only the model differs,
 * the Phase 33 dataset/methodology are reused unchanged, results are namespaced separately, provider-failure
 * handling/durability/scheduling mirror the hardened Phase 33 runner, production Learning stays OFF, and no
 * database/Action/Outcome write path is reachable from the Lite harness.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CASES, DATASET_VERSION, ADVERSARIAL_CASE_IDS } from "../evaluation/learning-real/dataset.mjs";
import { scanForSensitiveData } from "../evaluation/learning-real/syntheticGuard.mjs";
import { buildCandidateQueue, buildSlotUniverse, deadlineExceededCount, emptyAttempts, isAttemptsStore, isDeferred, recordAttempt } from "../evaluation/learning-real-lite/lite-slotState.mjs";
import { LITE_ENV_FILE, LITE_KEY_ENV_VAR, LITE_MODEL, LITE_PORT, LITE_PROVIDER, LITE_RESULTS_DIR, PHASE33_RESULTS_DIR, REPETITIONS, assertLiteConfig, defaultProjectKeys, liteSpawnEnv, loadLiteApiKey } from "../evaluation/learning-real-lite/lite-config.mjs";
import { datasetSha256, evaluationIdentity } from "../evaluation/learning-real-lite/lite-identity.mjs";
import { getLearningContextEnabled } from "../src/config/runtimeConfig.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(here, "..");
const LITE_DIR = path.join(BACKEND, "evaluation", "learning-real-lite");
const P33_DIR = path.join(BACKEND, "evaluation", "learning-real");
const read = (p) => fs.readFileSync(p, "utf8");
const liteRunner = read(path.join(LITE_DIR, "run-lite-evaluation.mjs"));
const p33Runner = read(path.join(P33_DIR, "run-real-evaluation.mjs"));
const liteFiles = fs.readdirSync(LITE_DIR).filter((f) => f.endsWith(".mjs"));

let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) { passed += 1; console.log(`PASS  ${name}`); } else { failed += 1; console.error(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`); }
};
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(String(e.message)); } };
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// Pulls a top-level construct out of a runner so the two runners can be compared character for character.
const grab = (src, re) => (src.match(re) || [null])[0];
const SAME = {
  "PROVIDER_ERROR_LINE regex": /const PROVIDER_ERROR_LINE = [^\n]+\n/,
  "buildBody()": /function buildBody\(testCase, withLearning\) \{[\s\S]*?\n\}\n/,
  "hard-gate failure filter": /const hardGateFailures = [^\n]+\n/,
  "stop-on-first-new-failure line": /if \(outcome\.result\.status !== 200\) break;/,
  "persist() immutability+atomic block": /const persist = \(\) => \{[\s\S]*?\n    \};/,
  "metrics pairing by run": /const paired = alignByRun\(a, b\);\n[\s\S]*?rows\.forEach\(\(row, i\) => \{ row\.run = paired\.a\[i\]\.run; \}\);/,
  "slot-universe accounting": /const missingSlots = [^\n]+\n[\s\S]*?const isComplete = [^\n]+\n/,
  "authorizedLevel (identical for both arms)": /authorizedLevel: "staff"/,
};

// ------------------------------------------------------------------ 1. exact model + only-the-model-differs
check("model constant is EXACTLY gemini-3.1-flash-lite", LITE_MODEL === "gemini-3.1-flash-lite");
check("provider is gemini (same provider as Phase 33; only the model differs)", LITE_PROVIDER === "gemini");
const env = liteSpawnEnv({ A: "1", [LITE_KEY_ENV_VAR]: "x" }, "TEST_ONLY_FAKE_KEY");
check("spawned-service env forces LLM_MODEL=gemini-3.1-flash-lite, LLM_PROVIDER, the dedicated key and the usage-log opt-in; nothing else changes", env.LLM_MODEL === LITE_MODEL && env.LLM_PROVIDER === LITE_PROVIDER && env.GEMINI_API_KEY === "TEST_ONLY_FAKE_KEY" && env.PHASE33_LOG_USAGE === "true" && env.A === "1" && !(LITE_KEY_ENV_VAR in env) && Object.keys(env).length === 5);
check("the Phase 33 runner's own spawn env sets no LLM_MODEL (its model still comes from ai-service/.env, untouched)", (() => { const m = p33Runner.match(/env: { ...process.env,[^}]*}/); return Boolean(m) && !/LLM_MODEL/.test(m[0]); })());
check("the Lite model ID appears as a literal only in lite-config.mjs (single source of truth)", liteFiles.filter((f) => f !== "lite-config.mjs").every((f) => !read(path.join(LITE_DIR, f)).includes('"gemini-3.1-flash-lite"')));
check("no Lite file can write ANY .env file: the only file-write call anywhere in the Lite harness is writeJsonAtomic aimed at the Lite results namespace; the .env files are only READ (readFileSync)", liteFiles.every((f) => { const code = stripComments(read(path.join(LITE_DIR, f))); return !/writeFileSync|appendFileSync|createWriteStream|renameSync|copyFileSync/.test(code); }) && read(path.join(LITE_DIR, "lite-config.mjs")).includes("readFileSync"));

// ------------------------------------------------------------------ 2. separate results namespace
check("Lite results directory names the model", path.basename(LITE_RESULTS_DIR) === "phase33-lite-gemini-3.1-flash-lite");
check("Lite results directory is not, and is not inside, the Phase 33 results directory", path.resolve(LITE_RESULTS_DIR) !== path.resolve(PHASE33_RESULTS_DIR) && !path.resolve(LITE_RESULTS_DIR).startsWith(path.resolve(PHASE33_RESULTS_DIR) + path.sep));
check("Lite port differs from the Phase 33 runner's port", LITE_PORT !== Number((p33Runner.match(/const PORT = (\d+)/) || [])[1]) && LITE_PORT === 7411);
check("the Lite runner never imports or references the Phase 33 results directory; the preflight uses it ONLY in a path-inequality assertion and has no filesystem access at all", !/PHASE33_RESULTS_DIR|results["',s]+["']?phase33["']/.test(stripComments(liteRunner)) && !/node:fs/.test(read(path.join(LITE_DIR, "preflight-config.mjs"))) && (read(path.join(LITE_DIR, "preflight-config.mjs")).match(/PHASE33_RESULTS_DIR/g) || []).length === 2);
check("every file write in the Lite runner targets OUT_DIR/ATTEMPTS_FILE (the Lite namespace)", (stripComments(liteRunner).match(/writeJsonAtomic\(([^,]+),/g) || []).every((m) => /OUT_DIR|ATTEMPTS_FILE/.test(m)));
check("Lite results namespace holds only Lite artifacts (or does not exist yet)", !fs.existsSync(LITE_RESULTS_DIR) || fs.readdirSync(LITE_RESULTS_DIR).every((f) => /^(results-arm-[ab]|slot-attempts|comparison|security-results|manifest|summary)\.json$/.test(f)));

// ------------------------------------------------------------------ 3. dataset: the existing Phase 33 synthetic dataset, unchanged
check("dataset version is phase33-real-learning-eval-v1", DATASET_VERSION === "phase33-real-learning-eval-v1");
check("24 cases x 2 arms x 3 runs = 144 slots", CASES.length === 24 && REPETITIONS === 3 && buildSlotUniverse(CASES, REPETITIONS).length === 144);
check("dataset is synthetic-only (guard scan clean)", scanForSensitiveData(CASES).ok);
check("adversarial cases preserved (>= 5; Phase 33 has 6)", ADVERSARIAL_CASE_IDS.length === 6);
check("dataset hash is reproducible and recorded in the Lite identity block", /^[0-9a-f]{64}$/.test(datasetSha256()) && evaluationIdentity().datasetSha256 === datasetSha256());
check("the Lite harness contains NO dataset of its own (no case literals; it imports ../learning-real/dataset.mjs)", liteFiles.every((f) => !/caseId:\s*"/.test(read(path.join(LITE_DIR, f)))) && /from "\.\.\/learning-real\/dataset\.mjs"/.test(liteRunner));
check("metrics, grounding and syntheticGuard are imported from learning-real/ - no Lite copies exist", ["metrics", "grounding", "syntheticGuard"].every((m) => !liteFiles.includes(m + ".mjs") && liteRunner.includes("from \"../learning-real/" + m + ".mjs\"")));
check("evidence/grounding validator is Phase 28's production one (grounding.mjs unchanged import of src/services/ai)", /src\/services\/ai\/analysisSchema\.js/.test(read(path.join(P33_DIR, "grounding.mjs"))));

// ------------------------------------------------------------------ 4. mirrored logic has not drifted from the hardened Phase 33 runner
for (const [label, re] of Object.entries(SAME)) {
  const a = grab(liteRunner, re);
  const b = grab(p33Runner, re);
  check(`mirrored logic identical to the hardened Phase 33 runner: ${label}`, a !== null && b !== null && a === b, a === null || b === null ? "snippet not found" : "text differs");
}

// ------------------------------------------------------------------ 5. provider-failure handling / budget / no retries
const lr = stripComments(liteRunner);
check("no retry machinery in the Lite runner (no MAX_RETRIES / backoff / retry loop)", !/MAX_RETRIES|RETRY_BACKOFF|retry|backoff/i.test(lr));
check("exactly one HTTP call site (single attempt per slot)", (lr.match(/\bfetch\(/g) || []).length === 2 && (lr.match(/postAnalyze\(/g) || []).length === 2); // 1 health probe + 1 analyze; definition + 1 caller
check("daily budget is enforced BEFORE a call is made", lr.indexOf("newCalls >= DAILY_CALL_BUDGET") !== -1 && lr.indexOf("newCalls >= DAILY_CALL_BUDGET") < lr.indexOf("await postAnalyze(body)"));
check("default daily budget is 8 and default spacing is 6000 ms", /DEFAULT_DAILY_CALL_BUDGET = 8/.test(read(path.join(LITE_DIR, "lite-config.mjs"))) && /DEFAULT_CALL_SPACING_MS = 6000/.test(read(path.join(LITE_DIR, "lite-config.mjs"))));
check("a model-mismatch guard refuses to record any response whose provenance is not the Lite model", /provider !== LITE_PROVIDER \|\| model !== LITE_MODEL/.test(lr) && /model_mismatch/.test(lr));
check("429, 503 and 504 all feed deferral through the Lite slot-state extension (isDeferred is used by the runner)", read(path.join(LITE_DIR, "lite-slotState.mjs")).includes("provider_deadline_exceeded") && read(path.join(LITE_DIR, "lite-slotState.mjs")).includes("provider_rate_limited") && lr.includes("isDeferred") && lr.includes("from \"./lite-slotState.mjs\""));
check("durable persistence: strict loaders + atomic writer + immutable rows are used, and there is no direct fs write", /loadJsonStrict/.test(lr) && /writeJsonAtomic/.test(lr) && /assertSuccessImmutable/.test(lr) && /setRowImmutable/.test(lr) && !/node:fs|writeFileSync/.test(lr));
{
  const fresh = buildCandidateQueue({ universe: buildSlotUniverse(CASES, REPETITIONS), stores: { A: {}, B: {} }, attempts: emptyAttempts() });
  check("a fresh Lite namespace queues all 144 slots, none deferred, none pre-filled; first slot is A/A/0", fresh.queue.length === 144 && fresh.deferred.length === 0 && fresh.successCount === 0 && fresh.queue[0].key === "A/A/0");
}

// ------------------------------------------------------------------ 5b. dedicated Lite API key handling (value never printed)
const liteKey = loadLiteApiKey();
const defaults = defaultProjectKeys();
check("a dedicated Lite key resolves (from the gitignored Lite env file or the dedicated env var)", Boolean(liteKey.key) && (liteKey.source.includes(".env.lite") || liteKey.source.includes(LITE_KEY_ENV_VAR)));
check("the Lite key is different from the default Gemini 3.6 Flash key", defaults.length > 0 && defaults.every((k) => k !== liteKey.key));
check("the Lite runner refuses to use a Lite key identical to the default key", defaults.length > 0 && throws(() => loadLiteApiKey({ [LITE_KEY_ENV_VAR]: defaults[0] }), /identical to the default/));
check("the dedicated env var takes precedence over the file", loadLiteApiKey({ [LITE_KEY_ENV_VAR]: "precedence-test-value" }).key === "precedence-test-value");
check("no silent fallback to the default key: the spawn env cannot be built without a Lite key", throws(() => liteSpawnEnv(process.env), /without the dedicated Lite API key/) && throws(() => liteSpawnEnv(process.env, ""), /without the dedicated Lite API key/));
check("the runner passes ONLY the dedicated key to the spawned service, resolved before anything is spawned", liteRunner.includes("const liteKey = loadLiteApiKey();") && liteRunner.includes("liteSpawnEnv(process.env, liteKey.key)") && liteRunner.indexOf("loadLiteApiKey()") < liteRunner.indexOf("spawn(PYTHON"));
check("the key value is referenced exactly once in the runner (the spawn env) and never in any log line", liteRunner.split("liteKey.key").length - 1 === 1 && !liteRunner.split(String.fromCharCode(10)).some((l) => /console[.](log|error|warn)/.test(l) && l.includes("liteKey.key")));
check("the Lite key file is IGNORED by git (matched by an existing .gitignore rule)", (() => { try { execFileSync("git", ["check-ignore", "-q", LITE_ENV_FILE], { cwd: BACKEND }); return true; } catch { return false; } })());
check("the Lite key file is NOT tracked by git", (() => { try { execFileSync("git", ["ls-files", "--error-unmatch", LITE_ENV_FILE], { cwd: BACKEND, stdio: "ignore" }); return false; } catch { return true; } })());
{
  // The key must appear in exactly one file in the whole repository: the ignored env file. Scans source, docs, results, artifacts.
  const SKIP_DIRS = new Set(["node_modules", ".venv", ".git", "__pycache__", ".pytest_cache", "dist", ".vite"]);
  const repoRoot = path.join(BACKEND, "..");
  const hits = [];
  let scanned = 0;
  const scan = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) scan(full); continue; }
      if (path.resolve(full) === path.resolve(LITE_ENV_FILE)) continue;
      let st; try { st = fs.statSync(full); } catch { continue; }
      if (st.size > 8 * 1024 * 1024) continue;
      scanned += 1;
      if (fs.readFileSync(full).includes(liteKey.key)) hits.push(path.relative(repoRoot, full));
    }
  };
  scan(repoRoot);
  check(`the Lite key appears in NO other file in the repository (source, docs, results, artifacts, logs; ${scanned} files scanned)`, hits.length === 0, hits.join(", "));
}
check("the Lite key file contains only the key assignment (no model/other secrets)", read(LITE_ENV_FILE).split(String.fromCharCode(10)).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).every((l) => l.startsWith("GEMINI_API_KEY=")));
check("the Lite harness never writes ai-service/.env (default Gemini 3.6 configuration is read-only here)", liteFiles.every((f) => { const src = read(path.join(LITE_DIR, f)); return !src.includes("writeFileSync") && !src.split(String.fromCharCode(10)).some((l) => l.includes("writeJsonAtomic") && l.includes("ai-service") && l.includes(".env")); }));

// ------------------------------------------------------------------ 6. production Learning stays OFF
delete process.env.KOI_LEARNING_CONTEXT_ENABLED;
check("production KOI_LEARNING_CONTEXT_ENABLED resolves to false", getLearningContextEnabled() === false);
check("the Lite harness refuses to run if production Learning is enabled in the environment", throws(() => assertLiteConfig({ KOI_LEARNING_CONTEXT_ENABLED: "true" }), /Production Learning must remain OFF/));
check("no Lite file sets KOI_LEARNING_CONTEXT_ENABLED to true", liteFiles.every((f) => !/KOI_LEARNING_CONTEXT_ENABLED["']?\s*[:=]\s*["']true["']/.test(read(path.join(LITE_DIR, f)))));
check("no Lite request body can enable Learning for production: arm B only attaches the case's own synthetic `learning` payload", /if \(withLearning && testCase\.learning\) body\.learning = testCase\.learning;/.test(liteRunner));

// ------------------------------------------------------------------ 7. no database / Action / Outcome write path reachable
const reached = new Map(); // abs path -> source
const bare = new Set();
const resolveImport = (from, spec) => {
  const base = path.resolve(path.dirname(from), spec);
  for (const cand of [base, `${base}.js`, `${base}.mjs`, path.join(base, "index.js")]) if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
  return null;
};
const walk = (file) => {
  if (reached.has(file)) return;
  const src = read(file);
  reached.set(file, src);
  for (const m of src.matchAll(/(?:import\s[^"']*?from\s*|import\()\s*["']([^"']+)["']/g)) {
    const spec = m[1];
    if (spec.startsWith(".")) { const r = resolveImport(file, spec); if (r) walk(r); } else bare.add(spec);
  }
};
for (const f of liteFiles) walk(path.join(LITE_DIR, f));
const reachedRel = [...reached.keys()].map((p) => path.relative(BACKEND, p).split(path.sep).join("/")).sort();
console.log(`      (modules reachable from the Lite harness: ${reachedRel.length}; bare imports: ${[...bare].sort().join(", ")})`);
check("no module reachable from the Lite harness imports the database connection layer", reachedRel.every((r) => !/config\/database\.js$/.test(r)) && [...reached.values()].every((s) => !/connectDatabase|mongoose\.connect|createConnection|MongoClient/.test(stripComments(s))));
check("no Action / Outcome / Decision / Learning / Signal / Workspace / Guest / Stay model module is reachable", reachedRel.every((r) => !/models\/(Action|Outcome|Decision|Signal|Workspace|WorkspaceMembership|Guest|Stay|Property|Unit|Conversation|Message|Knowledge\w*|ImportBatch|User)\.js$/.test(r)));
check("the only model module reachable is the Intelligence schema DEFINITION (via Phase 28's analysisSchema constant) - never connected, never used", reachedRel.filter((r) => /models\//.test(r)).every((r) => r === "src/models/Intelligence.js"));
check("no Lite-owned file contains a database write call (create/insert/update/delete/save/bulkWrite)", liteFiles.every((f) => !/\.(create|insertMany|insertOne|updateOne|updateMany|deleteOne|deleteMany|findOneAndUpdate|bulkWrite|save)\(/.test(stripComments(read(path.join(LITE_DIR, f))))));
check("no Lite-owned file imports mongoose or any src/ service other than runtimeConfig (read-only flag check) and the Phase 28 validators via grounding.mjs", liteFiles.every((f) => !/from "mongoose"|src\/services|src\/models/.test(stripComments(read(path.join(LITE_DIR, f))).replace(/from "\.\.\/\.\.\/src\/config\/runtimeConfig\.js"/g, ""))));
check("no execution/notification code in the Lite harness (only the ai-service process spawn)", liteFiles.every((f) => !/nodemailer|twilio|sendgrid|smtp|webhook|amqp|kafka|action:execute|approveAction|executeAction/i.test(read(path.join(LITE_DIR, f)))));
check("no embeddings: the Lite harness never calls an embedding endpoint", liteFiles.every((f) => !/embedding/i.test(stripComments(read(path.join(LITE_DIR, f)))) || /embeddingCalls: 0/.test(read(path.join(LITE_DIR, f)))));
check("no Lite file lives under backend/src or ai-service/app (production code untouched by Lite)", reachedRel.every((r) => !/lite/i.test(r) || r.startsWith("evaluation/") || r.startsWith("scripts/")));


// ------------------------------------------------------------------ 8. HTTP 504 / DEADLINE_EXCEEDED is a transient class (Lite only)
{
  const mk = (slots) => ({ schemaVersion: 1, note: "t", slots });
  const mini = buildSlotUniverse([{ caseId: "X" }], 1);
  const one = (att) => buildCandidateQueue({ universe: mini, stores: { A: {}, B: {} }, attempts: att });
  const liteSlot = read(path.join(LITE_DIR, "lite-slotState.mjs"));
  const NLX = String.fromCharCode(10);
  const fnText = (src, name) => { const a = src.indexOf("function " + name + "("); if (a < 0) return null; const b = src.indexOf(NLX + "}" + NLX, a); return src.slice(a, b + 2); };
  const stripped = (fn) => fn.split(NLX).filter((l) => !l.includes("provider_deadline_exceeded")).join(NLX);
  check("classifyFailure: Lite differs from the Phase 33 runner ONLY by the added 504/DEADLINE_EXCEEDED line(s)", fnText(liteRunner, "classifyFailure") !== null && fnText(liteRunner, "classifyFailure") !== fnText(p33Runner, "classifyFailure") && stripped(fnText(liteRunner, "classifyFailure")) === fnText(p33Runner, "classifyFailure"));
  check("the Phase 33 runner does NOT classify 504 (its behavior is unchanged)", !p33Runner.includes("provider_deadline_exceeded"));
  check("the shared learning-real/slotState.mjs was NOT modified for Lite (no 504/deadline logic there)", !read(path.join(P33_DIR, "slotState.mjs")).includes("deadline"));
  check("the Lite extension builds on the shared module (imports and re-exports it; defines no copy of the loaders/writer)", liteSlot.includes("from \"../learning-real/slotState.mjs\"") && !liteSlot.includes("function writeJsonAtomic") && !liteSlot.includes("function loadJsonStrict") && !liteSlot.includes("function setRowImmutable"));
  check("the runner takes its slot logic from the Lite extension, not from the shared module directly", !liteRunner.includes("learning-real/slotState.mjs") && liteRunner.includes("from \"./lite-slotState.mjs\""));
  check("a 504 stops the invocation exactly like any other provider failure (same single break on a non-200)", lr.includes("if (outcome.result.status !== 200) break;") && lr.includes("classified.kind === \"unknown_error\" && result.status === 504"));
  check("no retry was introduced for 504", !/retry|backoff/i.test(lr));
  check("1x 504 does NOT defer", one(mk({ "A/X/0": { consecutiveUnavailable: 0, consecutiveDeadlineExceeded: 1 } })).deferred.length === 0);
  check("2x 504 DEFERS the slot to the END of the queue (same threshold as 429/503), without dropping it", (() => { const r = one(mk({ "A/X/0": { consecutiveUnavailable: 0, consecutiveDeadlineExceeded: 2 } })); return r.deferred.map((s) => s.key).join() === "A/X/0" && r.queue[r.queue.length - 1].key === "A/X/0" && r.queue.length === 2; })());
  check("the 504 threshold equals the 429/503 threshold (DEFERRAL_THRESHOLD = 2)", read(path.join(P33_DIR, "slotState.mjs")).includes("DEFERRAL_THRESHOLD = 2") && isDeferred(mk({ s: { consecutiveUnavailable: 0, consecutiveDeadlineExceeded: 2 } }), "s") && !isDeferred(mk({ s: { consecutiveUnavailable: 0, consecutiveDeadlineExceeded: 1 } }), "s"));
  check("2x 503 and 2x 429 still defer (existing behaviour preserved)", one(mk({ "A/X/0": { consecutiveUnavailable: 2 } })).deferred.length === 1 && one(mk({ "A/X/0": { consecutiveUnavailable: 0, consecutiveRateLimited: 2 } })).deferred.length === 1);
  check("one failure of each class (503 + 429 + 504) does NOT defer - each class is counted separately", one(mk({ "A/X/0": { consecutiveUnavailable: 1, consecutiveRateLimited: 1, consecutiveDeadlineExceeded: 1 } })).deferred.length === 0);
  check("a deferred slot that already has a status-200 row is never queued", (() => { const r = buildCandidateQueue({ universe: mini, stores: { A: { X: [{ run: 0, status: 200 }] }, B: {} }, attempts: mk({ "A/X/0": { consecutiveUnavailable: 0, consecutiveDeadlineExceeded: 9 } }) }); return r.queue.every((s) => s.key !== "A/X/0") && r.deferred.length === 0 && r.successCount === 1; })());
  check("legacy attempt entries (no consecutiveDeadlineExceeded) load, validate and count as 0; bad values are rejected", isAttemptsStore(mk({ s: { consecutiveUnavailable: 1 } })) && deadlineExceededCount(mk({ s: { consecutiveUnavailable: 1 } }), "s") === 0 && !isAttemptsStore(mk({ s: { consecutiveUnavailable: 0, consecutiveDeadlineExceeded: -1 } })) && !isAttemptsStore(mk({ s: { consecutiveUnavailable: 0, consecutiveDeadlineExceeded: "2" } })));
  const h = emptyAttempts();
  recordAttempt(h, "A/X/0", { ok: false, kind: "provider_deadline_exceeded", code: "504" }, "t1");
  recordAttempt(h, "A/X/0", { ok: false, kind: "provider_deadline_exceeded", code: "504" }, "t2");
  check("recordAttempt: two 504s => consecutiveDeadlineExceeded 2 (503/429 counters untouched), deferred", h.slots["A/X/0"].consecutiveDeadlineExceeded === 2 && h.slots["A/X/0"].consecutiveUnavailable === 0 && h.slots["A/X/0"].consecutiveRateLimited === 0 && h.slots["A/X/0"].lastProviderCode === "504" && isDeferred(h, "A/X/0"));
  recordAttempt(h, "A/X/0", { ok: false, kind: "provider_unavailable", code: "503" }, "t3");
  recordAttempt(h, "A/X/0", { ok: false, kind: "unknown_error", code: null }, "t4");
  check("recordAttempt: a 503 or an unknown failure does not change the 504 counter", h.slots["A/X/0"].consecutiveDeadlineExceeded === 2 && h.slots["A/X/0"].consecutiveUnavailable === 1);
  recordAttempt(h, "A/X/0", { ok: true }, "t5");
  check("recordAttempt: a SUCCESS resets the 504, 503 and 429 counters and the slot is no longer deferred", h.slots["A/X/0"].consecutiveDeadlineExceeded === 0 && h.slots["A/X/0"].consecutiveUnavailable === 0 && h.slots["A/X/0"].consecutiveRateLimited === 0 && !isDeferred(h, "A/X/0") && h.slots["A/X/0"].lastFailureKind === null);
  check("recordAttempt keeps an audit note already on the entry", (() => { const g = mk({ s: { consecutiveUnavailable: 0, seededFromHistory: "note" } }); recordAttempt(g, "s", { ok: false, kind: "provider_deadline_exceeded", code: "504" }, "t"); return g.slots.s.seededFromHistory === "note" && g.slots.s.consecutiveDeadlineExceeded === 1; })());
}

console.log(`\nPhase 33-Lite local/static validation: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
