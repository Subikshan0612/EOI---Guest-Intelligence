/**
 * Phase 39 validation - the deployment PREFLIGHT tooling (deterministic; no Gemini; no network; synthetic placeholder values only).
 *
 *   node backend/scripts/validate-phase39-preflight.mjs
 *
 *   A  env-preflight.mjs      a correct synthetic production configuration passes; every rule is proved by a MUTATION that must FAIL on exactly that rule;
 *                             no value (secret or otherwise) is ever printed; the built-bundle scan finds a planted secret
 *   B  restore rehearsal      the isolated logical backup/restore rehearsal passes end to end (it proves the data model restores, NOT any real backup provider)
 *   C  honesty of the record  the Phase 39 documents state that nothing external was verified, the decision follows from the table, and no tool here deploys,
 *                             contacts an external host or modifies anything but throwaway databases
 *
 * No real database is read or written by section A. Section B uses throwaway databases only (koi_p39_*).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(here, "..");
const REPO = path.join(BACKEND, "..");
const read = (p) => fs.readFileSync(p, "utf8");
let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) { passed += 1; console.log(`PASS  ${name}${detail ? ` - ${detail}` : ""}`); } else { failed += 1; console.error(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`); }
};
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "koi-p39-suite-"));
const SECRETS = { mongo: "placeholder-pw-0000-mongo", gemini: "placeholder-gemini-key-not-real-0000", stub: "placeholder-stub-secret-0000", openai: "placeholder-openai-key-0000", client: "placeholder-oidc-client-secret-0000" };

const GOOD_BACKEND = {
  NODE_ENV: "production", PORT: "8080", CLIENT_URL: "https://app.example.invalid",
  MONGODB_URI: `mongodb+srv://placeholder-user:${SECRETS.mongo}@cluster.example.invalid/koi_prod?retryWrites=true`,
  AUTH_PROVIDER: "oidc", OIDC_ISSUER: "https://idp.example.invalid", OIDC_AUDIENCE: "koi-api", LLM_PROVIDER: "gemini", AI_SERVICE_URL: "http://ai.internal.example.invalid:8000", KOI_TRUST_PROXY: "1",
  AI_SERVICE_TOKEN: "placeholder-service-token-0123456789-abcdef", // a release requirement of the preflight (the runtime only warns)
};
const GOOD_AI = { LLM_PROVIDER: "gemini", LLM_MODEL: "gemini-3.1-flash-lite", GEMINI_API_KEY: SECRETS.gemini, EMBEDDING_PROVIDER: "gemini", EMBEDDING_MODEL: "gemini-embedding-001", REQUEST_TIMEOUT_MS: "20000", AI_SERVICE_TOKEN: GOOD_BACKEND.AI_SERVICE_TOKEN };
const GOOD_FE = { VITE_API_BASE_URL: "https://api.example.invalid", VITE_OIDC_AUTHORITY: "https://idp.example.invalid", VITE_OIDC_CLIENT_ID: "placeholder-public-client", VITE_KOI_WORKSPACE_ID: "000000000000000000000000" };
const toEnvFile = (obj) => Object.entries(obj).map(([k, v]) => `${k}=${v}`).join("\n");
let n = 0;
function preflight({ backend = GOOD_BACKEND, ai = GOOD_AI, fe = GOOD_FE, bundle } = {}) {
  n += 1;
  const dir = path.join(TMP, `c${n}`); fs.mkdirSync(dir);
  const files = { backend: path.join(dir, "backend.env"), ai: path.join(dir, "ai.env"), fe: path.join(dir, "fe.env") };
  fs.writeFileSync(files.backend, toEnvFile(backend)); fs.writeFileSync(files.ai, toEnvFile(ai)); fs.writeFileSync(files.fe, toEnvFile(fe));
  const args = [path.join(here, "phase39", "env-preflight.mjs"), "--backend", files.backend, "--ai", files.ai, "--frontend", files.fe];
  if (bundle) args.push("--bundle", bundle);
  const r = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 60000, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } });
  const out = `${r.stdout}${r.stderr}`;
  const lines = out.split(/\r?\n/).filter((l) => /^ {2}(PASS|FAIL|WARN|NOTE|NOT PROVIDED|SECRET)/.test(l));
  return { status: r.status, out, lines, failing: lines.filter((l) => /^ {2}FAIL/.test(l)).map((l) => l.trim()) };
}
const without = (obj, ...keys) => Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)));

console.log("\n# A. environment preflight");
const good = preflight();
check("A1 a correct synthetic production configuration (backend + AI service + frontend) passes with exit 0 and zero FAIL", good.status === 0 && good.failing.length === 0 && /0 FAIL/.test(good.out), good.out.match(/Preflight: .*/)?.[0]);
check("A2 NO VALUE IS EVER PRINTED: none of the synthetic secrets, the database password, the host names or the client id appears in the output (names and fixed messages only)",
  !Object.values(SECRETS).some((s) => good.out.includes(s)) && !/example\.invalid|placeholder-|koi_prod|cluster\./.test(good.out));
const must = (name, label, opts, expectedItem) => { const r = preflight(opts); check(`A.${name} ${label}`, r.status === 1 && r.failing.some((f) => f.includes(expectedItem)), `failing: ${r.failing.join(" | ") || "none"}`); return r; };
must("env", "NODE_ENV not production -> FAIL", { backend: { ...GOOD_BACKEND, NODE_ENV: "development" } }, "NODE_ENV");
must("envunset", "NODE_ENV unset -> FAIL", { backend: without(GOOD_BACKEND, "NODE_ENV") }, "NODE_ENV");
must("mongo-nodb", "a production MONGODB_URI with no database name -> FAIL", { backend: { ...GOOD_BACKEND, MONGODB_URI: `mongodb+srv://placeholder-user:${SECRETS.mongo}@cluster.example.invalid/?retryWrites=true` } }, "MONGODB_URI start-up check");
must("mongo-local", "a loopback MONGODB_URI -> FAIL", { backend: { ...GOOD_BACKEND, MONGODB_URI: "mongodb://localhost:27017/koi_prod" } }, "MONGODB_URI target");
must("mongo-missing", "a missing MONGODB_URI -> FAIL", { backend: without(GOOD_BACKEND, "MONGODB_URI") }, "MONGODB_URI start-up check");
must("auth-none", "no authentication configuration -> FAIL", { backend: without(GOOD_BACKEND, "AUTH_PROVIDER", "OIDC_ISSUER", "OIDC_AUDIENCE") }, "AUTH_PROVIDER");
must("auth-http", "an http OIDC issuer -> FAIL", { backend: { ...GOOD_BACKEND, OIDC_ISSUER: "http://idp.example.invalid" } }, "AUTH_PROVIDER");
must("auth-stub", "the development stub verifier -> FAIL (and the forbidden variable is named)", { backend: { ...GOOD_BACKEND, AUTH_PROVIDER: "stub", AUTH_STUB_SECRET: SECRETS.stub } }, "AUTH_PROVIDER");
must("provider-test", "LLM_PROVIDER=test-python -> FAIL", { backend: { ...GOOD_BACKEND, LLM_PROVIDER: "test-python" } }, "LLM_PROVIDER / AI_SERVICE_URL");
must("provider-typo", "an unrecognised LLM_PROVIDER -> FAIL", { backend: { ...GOOD_BACKEND, LLM_PROVIDER: "gemni" } }, "LLM_PROVIDER / AI_SERVICE_URL");
must("ai-url", "a missing AI_SERVICE_URL -> FAIL", { backend: without(GOOD_BACKEND, "AI_SERVICE_URL") }, "LLM_PROVIDER / AI_SERVICE_URL");
must("client-dev", "CLIENT_URL left at the development origin -> FAIL", { backend: { ...GOOD_BACKEND, CLIENT_URL: "http://localhost:5173" } }, "CLIENT_URL");
must("client-http", "an http CLIENT_URL -> FAIL", { backend: { ...GOOD_BACKEND, CLIENT_URL: "http://app.example.invalid" } }, "CLIENT_URL");
must("timeout", "an impossible timeout budget -> FAIL", { backend: { ...GOOD_BACKEND, KOI_AI_TIMEOUT_MS: "20000", KOI_SOCKET_TIMEOUT_MS: "1000" } }, "timeout budget");
const forb = must("forbidden", "forbidden-in-production variables (KNOWLEDGE_DEV_AUTHORIZED_LEVEL, KOI_EXPOSE_ERROR_DETAILS) -> FAIL, naming them", { backend: { ...GOOD_BACKEND, KNOWLEDGE_DEV_AUTHORIZED_LEVEL: "restricted", KOI_EXPOSE_ERROR_DETAILS: "true" } }, "forbidden-in-production");
check("A.forbidden-names the finding names the variables (not their values)", /KNOWLEDGE_DEV_AUTHORIZED_LEVEL/.test(forb.out) && !/restricted/.test(forb.out));
must("learning", "Learning enabled -> FAIL", { backend: { ...GOOD_BACKEND, KOI_LEARNING_CONTEXT_ENABLED: "true" } }, "KOI_LEARNING_CONTEXT_ENABLED");
must("ratelimit", "rate limiting disabled -> FAIL", { backend: { ...GOOD_BACKEND, KOI_RATE_LIMIT_ENABLED: "false" } }, "KOI_RATE_LIMIT_ENABLED");
const gk = must("gemini-in-node", "a Gemini key in the BACKEND environment -> FAIL (Node never uses it: least privilege)", { backend: { ...GOOD_BACKEND, GEMINI_API_KEY: SECRETS.gemini } }, "GEMINI_API_KEY in the backend");
check("A.gemini-in-node-secret the key itself is not printed", !gk.out.includes(SECRETS.gemini));
must("openai", "an OpenAI key in the backend environment -> FAIL", { backend: { ...GOOD_BACKEND, OPENAI_API_KEY: SECRETS.openai } }, "OPENAI_API_KEY");
for (const [label, model] of [["a stale model (gemini-3.6-flash)", "gemini-3.6-flash"], ["`latest`", "gemini-3.1-flash-lite-latest"], ["a preview model", "gemini-3.1-flash-lite-preview"], ["wrong casing", "Gemini-3.1-Flash-Lite"], ["a blank model", ""]]) {
  must(`model-${model || "blank"}`, `AI service LLM_MODEL = ${label} -> FAIL`, { ai: { ...GOOD_AI, LLM_MODEL: model } }, "LLM_MODEL");
}
must("ai-provider", "AI service LLM_PROVIDER=test -> FAIL", { ai: { ...GOOD_AI, LLM_PROVIDER: "test" } }, "LLM_PROVIDER");
must("ai-key", "AI service without a Gemini key -> FAIL", { ai: without(GOOD_AI, "GEMINI_API_KEY") }, "GEMINI_API_KEY");
must("ai-embedding", "AI service EMBEDDING_PROVIDER=test -> FAIL", { ai: { ...GOOD_AI, EMBEDDING_PROVIDER: "test" } }, "EMBEDDING_PROVIDER");
must("ai-timeout", "AI service REQUEST_TIMEOUT_MS above the 20 s ceiling -> FAIL", { ai: { ...GOOD_AI, REQUEST_TIMEOUT_MS: "60000" } }, "REQUEST_TIMEOUT_MS");
must("ai-analysis-deadline", "AI service LLM_ANALYSIS_TIMEOUT_MS above the 60 s analysis ceiling -> FAIL (Workstream 5C)", { ai: { ...GOOD_AI, LLM_ANALYSIS_TIMEOUT_MS: "60001" } }, "LLM_ANALYSIS_TIMEOUT_MS");
must("ai-tokens", "AI service LLM_MAX_OUTPUT_TOKENS unbounded -> FAIL", { ai: { ...GOOD_AI, LLM_MAX_OUTPUT_TOKENS: "999999" } }, "LLM_MAX_OUTPUT_TOKENS");
must("ai-eval", "evaluation-only variables in the AI service -> FAIL", { ai: { ...GOOD_AI, PHASE33_LOG_USAGE: "1" } }, "evaluation-only");
must("fe-loopback", "a frontend API base URL at loopback -> FAIL", { fe: { ...GOOD_FE, VITE_API_BASE_URL: "http://localhost:5000" } }, "VITE_API_BASE_URL");
must("fe-http", "an http frontend API base URL -> FAIL", { fe: { ...GOOD_FE, VITE_API_BASE_URL: "http://api.example.invalid" } }, "VITE_API_BASE_URL");
must("fe-oidc", "no frontend OIDC configuration -> FAIL", { fe: without(GOOD_FE, "VITE_OIDC_AUTHORITY", "VITE_OIDC_CLIENT_ID") }, "VITE_OIDC_AUTHORITY");
must("fe-devtoken", "VITE_DEV_ACCESS_TOKEN present -> FAIL", { fe: { ...GOOD_FE, VITE_DEV_ACCESS_TOKEN: "placeholder-dev-token-0000" } }, "VITE_DEV_ACCESS_TOKEN");
const leak = must("fe-secretvar", "a secret-shaped PUBLIC variable (VITE_GEMINI_API_KEY) -> FAIL", { fe: { ...GOOD_FE, VITE_GEMINI_API_KEY: SECRETS.gemini } }, "secret-shaped public variables");
check("A.fe-secretvar-name the finding names the variable, never its value", /VITE_GEMINI_API_KEY/.test(leak.out) && !leak.out.includes(SECRETS.gemini));
const notProvided = spawnSync(process.execPath, [path.join(here, "phase39", "env-preflight.mjs"), "--backend", path.join(TMP, "c1", "backend.env")], { encoding: "utf8", timeout: 60000, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } });
check("A.notprovided a file that was not given is reported NOT PROVIDED, never silently passed", /NOT PROVIDED\s+configuration file/.test(notProvided.stdout) && /NOT PROVIDED\s+bundle directory/.test(notProvided.stdout) && (notProvided.stdout.match(/NOT PROVIDED/g) ?? []).length >= 3);

// the bundle scan: a clean bundle passes; a planted secret / planted connection string / absent API origin fails
const cleanBundle = path.join(TMP, "bundle-clean"); fs.mkdirSync(path.join(cleanBundle, "assets"), { recursive: true });
fs.writeFileSync(path.join(cleanBundle, "assets", "index.js"), `const api="https://api.example.invalid";console.warn("hello");`);
check("A.bundle-clean a clean bundle that contains the intended API origin passes", preflight({ bundle: cleanBundle }).status === 0);
const dirty = (name, content) => { const d = path.join(TMP, name); fs.mkdirSync(path.join(d, "assets"), { recursive: true }); fs.writeFileSync(path.join(d, "assets", "index.js"), content); return d; };
const planted = preflight({ bundle: dirty("bundle-secret", `const api="https://api.example.invalid";const k="${SECRETS.gemini}";`) });
check("A.bundle-secret a bundle that contains a secret VALUE from any provided environment FAILS, naming the variable and not the value", planted.status === 1 && planted.failing.some((f) => f.includes("provided secret values")) && /GEMINI_API_KEY/.test(planted.out) && !planted.out.includes(SECRETS.gemini));
const pw = preflight({ bundle: dirty("bundle-mongo", `const api="https://api.example.invalid";const u="${GOOD_BACKEND.MONGODB_URI}";`) });
check("A.bundle-mongo a bundle containing the database connection string FAILS (value withheld)", pw.status === 1 && pw.failing.some((f) => f.includes("provided secret values") || f.includes("credential-shaped")) && !pw.out.includes(SECRETS.mongo));
const wrongOrigin = preflight({ bundle: dirty("bundle-localhost", `const api="http://localhost:5000";`) });
check("A.bundle-origin a bundle that does NOT contain the intended production API origin (a development build) FAILS", wrongOrigin.status === 1 && wrongOrigin.failing.some((f) => f.includes("configured API origin")));
const shape = preflight({ bundle: dirty("bundle-shape", `const api="https://api.example.invalid";const k="AIza${"A".repeat(35)}";`) });
check("A.bundle-shape a credential-SHAPED string in a bundle FAILS even when it is not one of the provided secrets", shape.status === 1 && shape.failing.some((f) => f.includes("credential-shaped")));
const src = read(path.join(here, "phase39", "env-preflight.mjs"));
check("A.static the tool cannot print a value: it prints only variable names, classifications and fixed messages (no console output interpolates an environment value), and it contacts nothing", !/fetch\(|http\.request|https\.request|net\.connect|spawn\(|exec\(/.test(src) && !/console\.(log|error)\([^)]*(backendEnv|aiEnv|feEnv)\[/.test(src));

console.log("\n# B. isolated backup/restore rehearsal");
const restore = spawnSync(process.execPath, [path.join(here, "phase39", "restore-rehearsal.mjs")], { encoding: "utf8", timeout: 240000 });
const restoreOut = `${restore.stdout}${restore.stderr}`;
check("B1 the logical backup/restore rehearsal passes end to end on throwaway databases: backup created, source dropped, restore identical (hash per collection), indexes rebuilt with no migration, uniqueness enforced, a backend healthy on the restored database, nothing left behind",
  restore.status === 0 && /8 passed, 0 failed/.test(restoreOut) && /R1 RESTORE SUCCESSFUL/.test(restoreOut) && /R4 /.test(restoreOut), restoreOut.match(/\d+ passed, \d+ failed/)?.[0]);
check("B2 the rehearsal states what it does NOT prove: it is a data-model restore test, and says no real backup provider was verified", /does NOT verify any real backup provider/.test(restoreOut) && /WHAT IT DOES NOT PROVE/.test(read(path.join(here, "phase39", "restore-rehearsal.mjs"))));
const restoreSrc = read(path.join(here, "phase39", "restore-rehearsal.mjs"));
check("B3 it can only drop its own databases: every drop is guarded by the koi_p39_ prefix, and it never reads or writes the configured database", /name\.startsWith\("koi_p39_"\)/.test(restoreSrc) && !/\.dropDatabase\(\)/.test(restoreSrc.replace(/async function dropIfMine[\s\S]*?\n\}/, "")));

console.log("\n# C. the record");
const docs = path.join(BACKEND, "docs");
const pre = fs.existsSync(path.join(docs, "DEPLOYMENT_PREFLIGHT_PHASE39.md")) ? read(path.join(docs, "DEPLOYMENT_PREFLIGHT_PHASE39.md")) : "";
const gng = read(path.join(docs, "PRODUCTION_GO_NO_GO.md"));
check("C1 the preflight document states the finding that no deployment target is configured in the repository, with the five target verdicts (frontend, Node, Python, MongoDB, OIDC) all UNKNOWN",
  /NO DEPLOYMENT TARGET CONFIGURED IN REPOSITORY/.test(pre) && ["FRONTEND TARGET", "NODE TARGET", "PYTHON TARGET", "MONGODB TARGET", "OIDC TARGET"].every((t) => new RegExp(`${t}: UNKNOWN`).test(pre)));
check("C2 every external control is labelled with exactly one of CODE VERIFIED / DEPLOYMENT VERIFIED / OPERATIONS VERIFIED / NOT VERIFIED, and NOTHING external is labelled DEPLOYMENT VERIFIED or OPERATIONS VERIFIED (no deployment or operations environment was reachable)",
  /NOT VERIFIED/.test(pre) && !/(^|\|)\s*(DEPLOYMENT|OPERATIONS) VERIFIED\s*(\||$)/m.test(pre.split("\n").filter((l) => /^\|/.test(l)).join("\n")) && /Operator actions still required/.test(pre));
check("C3 the Phase 38 evidence is preserved and a Phase 39 section was ADDED to the go/no-go document (nothing erased)", /## Section A - CODE READY/.test(gng) && /## Section B - DEPLOYMENT READY/.test(gng) && /## Section C - OPERATIONS READY/.test(gng) && /## Phase 39/.test(gng) && /Decision: CONDITIONAL GO/.test(gng));
const p39 = (/## Phase 39[\s\S]*$/.exec(gng) ?? [""])[0];
const rows = p39.split(/\r?\n/).filter((l) => /^\| P39-/.test(l)).map((l) => l.split("|").slice(1, -1).map((c) => c.trim()));
const CLASSES = ["CODE VERIFIED", "DEPLOYMENT VERIFIED", "OPERATIONS VERIFIED", "NOT VERIFIED", "BLOCKER"];
check("C4 every Phase 39 row has an id, an item, one verification class from the vocabulary, a blocking flag and evidence; no OPERATIONS item is verified",
  rows.length >= 20 && rows.every((r) => r.length === 5 && CLASSES.some((c) => r[2].startsWith(c)) && /^(YES|NO)$/.test(r[3]) && r[4].length > 3) && rows.filter((r) => /OPERATIONS/.test(r[0] + r[1])).every((r) => !r[2].startsWith("OPERATIONS VERIFIED")), `${rows.length} rows`);
const unmet = rows.filter((r) => r[3] === "YES" && !r[2].startsWith("CODE VERIFIED"));
const decision = (/\*\*Phase 39 decision: ([A-Z -]+)\*\*/.exec(gng) ?? [])[1];
const hardFail = rows.some((r) => r[2].startsWith("BLOCKER") && /\(violated\)/.test(r[2]));
const expected = hardFail ? "NO-GO" : unmet.length > 0 ? "CONDITIONAL GO" : "GO";
check("C5 THE PHASE 39 DECISION FOLLOWS FROM THE TABLE: a violated security invariant -> NO-GO; code safe but external blockers unverified -> CONDITIONAL GO; every blocker verified -> GO", decision === expected, `stated ${decision}, rules give ${expected} (${unmet.length} unverified blockers)`);
check("C6 no document or tool of this phase contains a secret, a real URI with credentials, or an absolute personal path", [pre, p39, src, restoreSrc].every((t) => !/(AIza[0-9A-Za-z_-]{20}|sk-[A-Za-z0-9]{20}|BEGIN (RSA |EC )?PRIVATE KEY|mongodb(\+srv)?:\/\/[^\s`"']+:[^\s`"']+@|C:\\Users)/.test(t)));
const phase39Files = fs.readdirSync(path.join(here, "phase39")).map((f) => read(path.join(here, "phase39", f)));
check("C7 nothing in the Phase 39 tooling deploys, commits, pushes, rotates, changes DNS or contacts a hosting API", phase39Files.every((t) => !/git (commit|push)|vercel|render\.com|railway|heroku|kubectl|docker (push|run)|terraform|aws |gcloud|az |dns/i.test(t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""))));

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\nPhase 39 preflight tooling validation: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
