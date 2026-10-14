/**
 * Phase 39 - production ENVIRONMENT PREFLIGHT. An operator tool: it judges a configuration WITHOUT starting anything and WITHOUT ever printing a value.
 *
 *   node scripts/phase39/env-preflight.mjs --backend <file> [--ai <file>] [--frontend <file>] [--bundle <dir>]
 *   node scripts/phase39/env-preflight.mjs                       # judges the CURRENT process environment as the backend configuration
 *
 * Each <file> is a dotenv-format file (the environment that will be given to that process by the hosting platform, exported to a file, or a deployment
 * template). The script never reads a real secret store and never contacts anything. It reuses the backend's own start-up checks (the same functions server.js
 * calls), so "preflight PASS" means "this backend configuration would not be refused at start-up", plus the contract rules the code cannot enforce.
 *
 * OUTPUT: per variable NAME only: PRESENT / ABSENT / SECRET PRESENT / SECRET MISSING, and fixed finding messages. Values are never printed.
 * EXIT: 0 = no FAIL; 1 = at least one FAIL. NOT PROVIDED (a file you did not give) is reported, never silently passed.
 * SCOPE: this checks CONFIGURATION. It cannot see the hosting platform (replica count, network exposure, TLS termination, backups, log shipping, alerts).
 */
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const arg = (flag) => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : undefined; };
const files = { backend: arg("--backend"), ai: arg("--ai"), frontend: arg("--frontend") };
const bundleDir = arg("--bundle");
const parseFile = (p) => dotenv.parse(fs.readFileSync(p, "utf8"));
const backendEnv = files.backend ? parseFile(files.backend) : { ...process.env };
const aiEnv = files.ai ? parseFile(files.ai) : null;
const feEnv = files.frontend ? parseFile(files.frontend) : null;

// The backend's own start-up functions read process.env: evaluate them against ONLY the backend configuration (nothing from this shell leaks in).
const savedEnv = { ...process.env };
for (const k of Object.keys(process.env)) delete process.env[k];
Object.assign(process.env, backendEnv);
const { clientUrlProblems, mongoConfigProblems, productionAiConfigProblems, timeoutBudgetProblems, runtimeWarnings, trustProxyProblems } = await import("../../src/config/startupChecks.js");
const { authStartupProblems } = await import("../../src/auth/authConfig.js");
const { getRuntimeMode } = await import("../../src/config/runtimeMode.js");
const { APPROVED_MODEL, APPROVED_PROVIDER } = await import("../../src/config/providerPolicy.js");

const rows = [];
const add = (area, item, status, note = "") => rows.push({ area, item, status, note });
const SECRETISH = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL)/i;
const isPublicEndpointName = (name) => /_URL$|_URI$|_LABEL$/.test(name); // e.g. VITE_OIDC_TOKEN_EXCHANGE_URL: an address, not a credential
const BUNDLE_SECRETISH = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|MONGODB_URI)/i; // a database URI carries credentials
const has = (env, k) => typeof env[k] === "string" && env[k].trim() !== "";
const isLoopback = (url) => { try { return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(url).hostname.toLowerCase()); } catch { return false; } };
const httpsNonLoopback = (url) => { try { const u = new URL(url); return u.protocol === "https:" && !isLoopback(url); } catch { return false; } };
const classify = (env, name, secret = false) => (has(env, name) ? (secret ? "SECRET PRESENT" : "PRESENT") : (secret ? "SECRET MISSING" : "ABSENT"));

// ---------------------------------------------------------------- Node backend
const B = "Node backend";
add(B, "NODE_ENV", getRuntimeMode() === "production" ? "PASS" : "FAIL", `${classify(backendEnv, "NODE_ENV")}; must be exactly production (current mode: ${getRuntimeMode()})`);
add(B, "MONGODB_URI", classify(backendEnv, "MONGODB_URI", true), "");
const mongo = mongoConfigProblems(backendEnv.MONGODB_URI);
if (!has(backendEnv, "MONGODB_URI")) add(B, "MONGODB_URI start-up check", "FAIL", "missing: the server refuses to start");
else if (getRuntimeMode() !== "production") add(B, "MONGODB_URI start-up check", "FAIL", "NODE_ENV is not production, so the production database rules were not applied");
else { for (const f of mongo.fatal) add(B, "MONGODB_URI start-up check", "FAIL", f); for (const w of mongo.warnings) add(B, "MONGODB_URI start-up check", "WARN", w); if (!mongo.fatal.length && !mongo.warnings.length) add(B, "MONGODB_URI start-up check", "PASS", "database named; credentials and TLS present"); }
if (/^mongodb:\/\/(localhost|127\.0\.0\.1)/i.test(backendEnv.MONGODB_URI ?? "")) add(B, "MONGODB_URI target", "FAIL", "points at a loopback database (a development instance)");
const auth = authStartupProblems(backendEnv);
add(B, "AUTH_PROVIDER / OIDC_*", auth.fatal.length === 0 && ["oidc", "eoi"].includes(auth.config.provider) ? "PASS" : "FAIL", `${classify(backendEnv, "AUTH_PROVIDER")}; OIDC_ISSUER ${classify(backendEnv, "OIDC_ISSUER")}; OIDC_AUDIENCE ${classify(backendEnv, "OIDC_AUDIENCE")}`);
for (const p of auth.fatal) add(B, "authentication start-up check", "FAIL", p);
{
  const { emailStartupProblems } = await import("../../src/config/emailConfig.js");
  if (getRuntimeMode() === "production" && backendEnv.AUTH_PROVIDER === "eoi") {
    const mail = emailStartupProblems({ clientUrl: backendEnv.CLIENT_URL, environment: backendEnv });
    const problems = Array.isArray(mail) ? mail : [...(mail?.fatal ?? []), ...(mail?.problems ?? [])];
    add(B, "SMTP / MAIL_FROM / CLIENT_URL start-up check", problems.length === 0 ? "PASS" : "FAIL", problems.length === 0 ? "complete and valid (verification and password-reset e-mail can be sent)" : problems.join("; "));
  }
  // Release rule (the runtime itself only warns): for the Vercel -> Render -> private AI service topology the service credential is REQUIRED, so its absence or a short value is a FAIL here.
  add(B, "AI_SERVICE_TOKEN (service-to-service credential)", has(backendEnv, "AI_SERVICE_TOKEN") && String(backendEnv.AI_SERVICE_TOKEN).length >= 24 ? "PASS" : "FAIL", `${classify(backendEnv, "AI_SERVICE_TOKEN", true)}; at least 24 characters, identical on the AI service - without it the AI service is protected only by network isolation`);
}
const ai = productionAiConfigProblems(backendEnv);
add(B, "LLM_PROVIDER / AI_SERVICE_URL", getRuntimeMode() === "production" && ai.fatal.length === 0 && has(backendEnv, "AI_SERVICE_URL") && (backendEnv.LLM_PROVIDER ?? "").trim().toLowerCase() === APPROVED_PROVIDER ? "PASS" : "FAIL", `LLM_PROVIDER ${classify(backendEnv, "LLM_PROVIDER")}; AI_SERVICE_URL ${classify(backendEnv, "AI_SERVICE_URL")}; must be ${APPROVED_PROVIDER}`);
for (const f of ai.fatal) add(B, "AI configuration start-up check", "FAIL", f);
for (const w of ai.warnings) add(B, "AI configuration start-up check", "WARN", w);
if (has(backendEnv, "AI_SERVICE_URL")) {
  if (isLoopback(backendEnv.AI_SERVICE_URL)) add(B, "AI_SERVICE_URL target", "NOTE", "loopback: correct only if the AI service runs on the same host; otherwise it must be a PRIVATE address");
  else if (/^http:\/\//i.test(backendEnv.AI_SERVICE_URL)) add(B, "AI_SERVICE_URL transport", "WARN", "plain http to a non-loopback host: acceptable only on a private network the platform isolates");
}
const budget = timeoutBudgetProblems(backendEnv);
add(B, "timeout budget (KOI_*_TIMEOUT_MS)", budget.fatal.length === 0 ? "PASS" : "FAIL", budget.fatal.join("; ") || "analysis timeout fits inside the request deadline");
{
  const exact = clientUrlProblems(backendEnv.CLIENT_URL ?? "");
  const exactProblems = [...exact.fatal, ...exact.warnings];
  add(B, "CLIENT_URL", httpsNonLoopback(backendEnv.CLIENT_URL ?? "") && exactProblems.length === 0 ? "PASS" : "FAIL", `${classify(backendEnv, "CLIENT_URL")}; must be the real https frontend origin, written exactly as the browser sends it (no trailing slash, path or default port)${exactProblems.length ? `; ${exactProblems.join("; ")}` : ""}`);
}
const forbidden = ["AUTH_TOKEN_VERIFIER", "AUTH_STUB_SECRET", "KNOWLEDGE_DEV_AUTHORIZED_LEVEL", "KOI_EXPOSE_ERROR_DETAILS"].filter((k) => has(backendEnv, k));
add(B, "forbidden-in-production variables", forbidden.length === 0 ? "PASS" : "FAIL", forbidden.length ? `present: ${forbidden.join(", ")}` : "none present");
add(B, "KOI_LEARNING_CONTEXT_ENABLED", (backendEnv.KOI_LEARNING_CONTEXT_ENABLED ?? "").trim().toLowerCase() === "true" ? "FAIL" : "PASS", "must be unset or false (Learning stays OFF)");
add(B, "KOI_RATE_LIMIT_ENABLED", (backendEnv.KOI_RATE_LIMIT_ENABLED ?? "true").trim().toLowerCase() === "false" ? "FAIL" : "PASS", "rate limiting must not be disabled");
{
  const tp = trustProxyProblems(backendEnv);
  for (const f of [...tp.fatal, ...tp.warnings]) add(B, "KOI_TRUST_PROXY", "FAIL", f);
}
add(B, "KOI_TRUST_PROXY", has(backendEnv, "KOI_TRUST_PROXY") ? "NOTE" : "NOTE", has(backendEnv, "KOI_TRUST_PROXY") ? "set: it must equal the EXACT number of trusted proxy hops in front of Node; a wrong value lets a client choose its own rate-limit key" : "unset: correct only if Node is reached directly; behind a proxy every client then shares the proxy's address (set the real hop count)");
add(B, "GEMINI_API_KEY in the backend environment", has(backendEnv, "GEMINI_API_KEY") ? "FAIL" : "PASS", has(backendEnv, "GEMINI_API_KEY") ? "SECRET PRESENT but Node never uses it (only the AI service calls Gemini): remove it (least privilege)" : "absent, as it should be");
add(B, "OPENAI_API_KEY in the backend environment", has(backendEnv, "OPENAI_API_KEY") ? "FAIL" : "PASS", has(backendEnv, "OPENAI_API_KEY") ? "SECRET PRESENT: not used on the gemini route; remove it" : "absent");
if (has(backendEnv, "LLM_MODEL") && backendEnv.LLM_MODEL.trim() !== APPROVED_MODEL) add(B, "LLM_MODEL in the backend environment", "WARN", "set to something other than the approved model; Node does not read it (the model is a code constant) - remove it to avoid confusion");
for (const w of runtimeWarnings(backendEnv)) add(B, "production warning (expected)", "NOTE", w);

// ---------------------------------------------------------------- Python AI service
const P = "AI service";
if (!aiEnv) add(P, "configuration file", "NOT PROVIDED", "pass --ai <file> to judge the AI service environment");
else {
  const llm = (aiEnv.LLM_PROVIDER ?? "").trim().toLowerCase(); const emb = (aiEnv.EMBEDDING_PROVIDER ?? "").trim().toLowerCase();
  add(P, "LLM_PROVIDER", llm === "gemini" ? "PASS" : "FAIL", `${classify(aiEnv, "LLM_PROVIDER")}; must be gemini`);
  add(P, "LLM_MODEL", (aiEnv.LLM_MODEL ?? "").trim() === APPROVED_MODEL ? "PASS" : "FAIL", `${classify(aiEnv, "LLM_MODEL")}; must be exactly the approved model (no preview, no alias, no latest)`);
  add(P, "GEMINI_API_KEY", has(aiEnv, "GEMINI_API_KEY") ? "PASS" : "FAIL", classify(aiEnv, "GEMINI_API_KEY", true));
  add(P, "EMBEDDING_PROVIDER", emb === "gemini" ? "PASS" : "FAIL", `${classify(aiEnv, "EMBEDDING_PROVIDER")}; must be gemini in production (the AI service cannot tell production from development)`);
  const t = Number(aiEnv.REQUEST_TIMEOUT_MS ?? 20000);
  add(P, "REQUEST_TIMEOUT_MS", Number.isInteger(t) && t >= 1 && t <= 20000 ? "PASS" : "FAIL", `${classify(aiEnv, "REQUEST_TIMEOUT_MS")}; integer 1..20000`);
  // Workstream 5C: the Gemini ANALYSIS deadline is its own setting with its own ceiling (60 s); Node's analysis wait (its own default, 65 s) must exceed it.
  const ta = Number(aiEnv.LLM_ANALYSIS_TIMEOUT_MS ?? 20000);
  add(P, "LLM_ANALYSIS_TIMEOUT_MS", Number.isInteger(ta) && ta >= 1 && ta <= 60000 ? "PASS" : "FAIL", `${classify(aiEnv, "LLM_ANALYSIS_TIMEOUT_MS")}; integer 1..60000 (the Gemini analysis deadline; separate from REQUEST_TIMEOUT_MS)`);
  const m = Number(aiEnv.LLM_MAX_OUTPUT_TOKENS ?? 4096);
  add(P, "LLM_MAX_OUTPUT_TOKENS", Number.isInteger(m) && m >= 1 && m <= 8192 ? "PASS" : "FAIL", `${classify(aiEnv, "LLM_MAX_OUTPUT_TOKENS")}; integer 1..8192`);
  const evalOnly = Object.keys(aiEnv).filter((k) => /^(PHASE33_|P34C1_|P34D_)/.test(k));
  add(P, "AI_SERVICE_TOKEN matches the backend's", has(aiEnv, "AI_SERVICE_TOKEN") && aiEnv.AI_SERVICE_TOKEN === backendEnv.AI_SERVICE_TOKEN ? "PASS" : has(aiEnv, "AI_SERVICE_TOKEN") || has(backendEnv, "AI_SERVICE_TOKEN") ? "FAIL" : "WARN", `${classify(aiEnv, "AI_SERVICE_TOKEN", true)}; must be present and identical on both sides, or absent on both (then only the network protects the service)`);
  add(P, "evaluation-only variables",evalOnly.length === 0 ? "PASS" : "FAIL", evalOnly.length ? `present: ${evalOnly.join(", ")}` : "none present");
  if (has(aiEnv, "AI_SERVICE_PORT")) add(P, "AI_SERVICE_PORT", "NOTE", "present but not read by the code: the port is set on the uvicorn command line");
}

// ---------------------------------------------------------------- Frontend (public values only)
const F = "Frontend";
if (!feEnv) add(F, "configuration file", "NOT PROVIDED", "pass --frontend <file> to judge the build-time environment");
else {
  add(F, "VITE_API_BASE_URL", httpsNonLoopback(feEnv.VITE_API_BASE_URL ?? "") ? "PASS" : "FAIL", `${classify(feEnv, "VITE_API_BASE_URL")}; must be the real https backend origin (a development build points at loopback)`);
  add(F, "VITE_OIDC_AUTHORITY / VITE_OIDC_CLIENT_ID", httpsNonLoopback(feEnv.VITE_OIDC_AUTHORITY ?? "") && has(feEnv, "VITE_OIDC_CLIENT_ID") ? "PASS" : "FAIL", `authority ${classify(feEnv, "VITE_OIDC_AUTHORITY")} (https, not loopback); client id ${classify(feEnv, "VITE_OIDC_CLIENT_ID")}`);
  add(F, "VITE_DEV_ACCESS_TOKEN", has(feEnv, "VITE_DEV_ACCESS_TOKEN") ? "FAIL" : "PASS", has(feEnv, "VITE_DEV_ACCESS_TOKEN") ? "present: a development token must never be part of a production build" : "absent");
  const leaked = Object.keys(feEnv).filter((k) => k.startsWith("VITE_") && SECRETISH.test(k) && !isPublicEndpointName(k) && k !== "VITE_OIDC_CLIENT_ID");
  add(F, "secret-shaped public variables", leaked.length === 0 ? "PASS" : "FAIL", leaked.length ? `VITE_ variables are PUBLIC (inlined into the bundle): ${leaked.join(", ")}` : "none");
  const nonVite = Object.keys(feEnv).filter((k) => !k.startsWith("VITE_"));
  add(F, "non-VITE variables in the frontend file", nonVite.length === 0 ? "PASS" : "WARN", nonVite.length ? `not exposed to the bundle but do not belong here: ${nonVite.join(", ")}` : "none");
  add(F, "VITE_KOI_WORKSPACE_ID", has(feEnv, "VITE_KOI_WORKSPACE_ID") ? "NOTE" : (has(feEnv, "VITE_KOI_AUTH") || has(feEnv, "VITE_OIDC_AUTHORITY")) ? "PASS" : "WARN", has(feEnv, "VITE_KOI_WORKSPACE_ID") ? "present (public by design; it is not an access credential - membership is enforced on the server; with real sign-in it is not needed and should be absent in production)" : (has(feEnv, "VITE_KOI_AUTH") || has(feEnv, "VITE_OIDC_AUTHORITY")) ? "absent: correct with real sign-in (the workspace is the signed-in person's own, reported by the server)" : "absent and no sign-in configured: the app runs in LOCAL (browser-storage) mode with no backend persistence");
}

// ---------------------------------------------------------------- Built bundle
const BN = "Built bundle";
if (!bundleDir) add(BN, "bundle directory", "NOT PROVIDED", "pass --bundle <dir> (the output of `npm run build`) to scan it");
else if (!fs.existsSync(bundleDir)) add(BN, "bundle directory", "FAIL", "does not exist");
else {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const blob = Buffer.concat(walk(bundleDir).map((f) => fs.readFileSync(f))); const text = blob.toString("latin1");
  const secrets = [backendEnv, aiEnv ?? {}, feEnv ?? {}].flatMap((env) => Object.entries(env).filter(([k, v]) => BUNDLE_SECRETISH.test(k) && !isPublicEndpointName(k) && !k.startsWith("VITE_OIDC_CLIENT") && typeof v === "string" && v.length >= 8).map(([k]) => [k, env[k]]));
  const found = secrets.filter(([, v]) => blob.includes(Buffer.from(v))).map(([k]) => k);
  add(BN, "provided secret values inside the bundle", found.length === 0 ? "PASS" : "FAIL", found.length ? `secret values of ${[...new Set(found)].join(", ")} are in the bundle` : `${secrets.length} secret values checked; none found`);
  const shapes = [/AIza[0-9A-Za-z_-]{30,}/, /sk-[A-Za-z0-9]{20,}/, /BEGIN (RSA |EC )?PRIVATE KEY/, /mongodb(\+srv)?:\/\//, /client_secret/i].filter((r) => r.test(text));
  add(BN, "credential-shaped strings", shapes.length === 0 ? "PASS" : "FAIL", shapes.length ? `${shapes.length} credential-shaped pattern(s) found` : "none");
  const apiUrl = feEnv?.VITE_API_BASE_URL;
  if (apiUrl) add(BN, "configured API origin is baked in", text.includes(apiUrl.replace(/\/+$/, "")) ? "PASS" : "FAIL", "the bundle must contain the intended backend origin");
  add(BN, "development token / test-provider wiring", /VITE_DEV_ACCESS_TOKEN\b[^"']{0,3}\s*[:=]\s*["'][A-Za-z0-9._-]{20,}/.test(text) ? "FAIL" : "PASS", "no token value inlined");
}

// ---------------------------------------------------------------- report (names and fixed messages only)
const order = ["FAIL", "WARN", "NOT PROVIDED", "NOTE", "PASS"];
const W = Math.max(...rows.map((r) => r.item.length));
let lastArea = "";
for (const r of rows) {
  if (r.area !== lastArea) { console.log(`\n== ${r.area}`); lastArea = r.area; }
  console.log(`  ${r.status.padEnd(14)} ${r.item.padEnd(W)}  ${r.note}`);
}
const count = (s) => rows.filter((r) => r.status === s).length;
console.log(`\nPreflight: ${count("PASS")} PASS, ${count("FAIL")} FAIL, ${count("WARN")} WARN, ${count("NOT PROVIDED")} NOT PROVIDED, ${count("NOTE")} NOTE.`);
console.log("This is a CONFIGURATION check only. It does not verify hosting, replica count, network exposure, TLS, backups, log shipping or alerts (see docs/DEPLOYMENT_PREFLIGHT_PHASE39.md).");
Object.assign(process.env, savedEnv);
void order;
process.exit(count("FAIL") === 0 ? 0 : 1);
