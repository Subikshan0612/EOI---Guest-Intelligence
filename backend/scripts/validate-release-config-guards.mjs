/**
 * Release-candidate configuration guards (deterministic; no database; no Gemini; no network; synthetic placeholder values only).
 *
 *   A  CLIENT_URL must be an EXACT ORIGIN: the trailing-slash trap found by the deployment readiness audit (a value that passes every other check yet fails the browser's CORS comparison)
 *   B  KOI_TRUST_PROXY must be unset or a hop count 1-10
 *   C  the real server process refuses to start on either (before it connects to any database), and still gets past them with a good value
 *   D  the operator preflight tool reports both, and treats the AI service credential as a release requirement
 *   E  coverage: the other production traps named by the audit each have a fail-closed guard (this proves they are still there; it adds none)
 *
 * Nothing here starts a database or contacts an external host. The spawned servers exit (or fail to reach the placeholder host) without ever serving a request.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(here, "..");
let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => { if (ok) { passed += 1; console.log(`PASS  ${name}`); } else { failed += 1; console.error(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`); } };
const withMode = (mode, fn) => { const saved = process.env.NODE_ENV; if (mode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = mode; try { return fn(); } finally { if (saved === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved; } };

const { clientUrlProblems, trustProxyProblems, mongoConfigProblems, productionAiConfigProblems, timeoutBudgetProblems, runtimeWarnings } = await import("../src/config/startupChecks.js");
const { emailStartupProblems, resolveEmailConfig } = await import("../src/config/emailConfig.js");
const { authStartupProblems } = await import("../src/auth/authConfig.js");

// ============================================================================================================ A. CLIENT_URL
const GOOD_ORIGINS = ["https://example.com", "https://app.example.com", "https://app.example.com:8443", "http://localhost:5175", "http://localhost:5173", "http://127.0.0.1:5175"];
const BAD_ORIGINS = {
  "https://example.com/": "trailing slash (the audited trap)",
  "http://localhost:5175/": "trailing slash on a development origin",
  "https://example.com//": "double slash",
  "https://example.com/app": "a path",
  "https://example.com?x=1": "a query",
  "https://example.com#top": "a fragment",
  "https://user:pw@example.com": "embedded credentials",
  "https://EXAMPLE.com": "upper-case host (the browser sends lower case)",
  "HTTPS://example.com": "upper-case scheme",
  "https://example.com:443": "the default port written out",
  "http://example.com:80": "the default port written out (http)",
  " https://example.com": "leading whitespace",
  "https://example.com ": "trailing whitespace",
  "ftp://example.com": "a non-http scheme",
  "example.com": "no scheme",
  "//example.com": "a scheme-relative URL",
  "": "empty",
  "https://": "no host",
  "null": "the literal null origin",
};
withMode("production", () => {
  check("A1 production: every exact origin (https, a non-default port, and the development origins) is accepted by this check", GOOD_ORIGINS.every((u) => clientUrlProblems(u).fatal.length === 0 && clientUrlProblems(u).warnings.length === 0), GOOD_ORIGINS.filter((u) => clientUrlProblems(u).fatal.length).join(" | "));
  const wrong = Object.keys(BAD_ORIGINS).filter((u) => clientUrlProblems(u).fatal.length !== 1);
  check("A2 production: every inexact form is FATAL (trailing slash, path, query, fragment, credentials, case, default port, whitespace, wrong scheme, empty, null)", wrong.length === 0, wrong.map((u) => `[${u}] ${BAD_ORIGINS[u]}`).join(" | "));
  check("A3 production: a missing/non-string CLIENT_URL is fatal, not a crash", clientUrlProblems(undefined).fatal.length === 1 && clientUrlProblems(null).fatal.length === 1 && clientUrlProblems(42).fatal.length === 1);
  check("A4 the message never echoes the configured value", ["https://marker-host-7391.invalid/", "https://marker-host-7391.invalid/path", "https://user:marker-pw-7391@marker-host-7391.invalid", "marker-host-7391.invalid"].every((u) => { const m = clientUrlProblems(u).fatal.join(" "); return m.length > 0 && !m.includes("7391"); }));
  check("A5 the HTTPS requirement is NOT weakened: an exact http origin passes THIS check (exactness only) but a deployment that sends e-mail still refuses it in emailStartupProblems, and a trailing slash is refused there too only through this check", emailStartupProblems({ clientUrl: "http://example.com", environment: { NODE_ENV: "production", AUTH_PROVIDER: "eoi" } }).fatal.some((m) => /https/.test(m)) && emailStartupProblems({ clientUrl: "http://localhost:5175", environment: { NODE_ENV: "production" } }).fatal.some((m) => /localhost|https/.test(m)));
});
withMode("unknown", () => check("A6 an unset/unknown NODE_ENV is treated like production (fatal), never as development", clientUrlProblems("https://example.com/").fatal.length === 1));
withMode("development", () => check("A7 development: the same inexact values are only warnings (the dev server would fail the same way), exact ones are silent", clientUrlProblems("http://localhost:5175/").fatal.length === 0 && clientUrlProblems("http://localhost:5175/").warnings.length === 1 && clientUrlProblems("http://localhost:5175").warnings.length === 0));
withMode("test", () => check("A8 test: warnings only", clientUrlProblems("https://example.com/").fatal.length === 0 && clientUrlProblems("https://example.com/").warnings.length === 1));

// ============================================================================================================ B. KOI_TRUST_PROXY
withMode("production", () => {
  const good = [undefined, "", "1", "2", "9", "10"];
  const bad = ["0", "11", "01", "1.5", "-1", "true", "false", "yes", "one", " 1", "1 ", "100", "1,2", "0x1"];
  check("B1 production: unset, empty and a hop count 1-10 are accepted", good.every((v) => { const r = trustProxyProblems({ KOI_TRUST_PROXY: v }); return r.fatal.length === 0 && r.warnings.length === 0; }));
  check("B2 production: anything that cannot be a hop count is FATAL (it would be silently ignored, leaving every user on one rate-limit key)", bad.every((v) => trustProxyProblems({ KOI_TRUST_PROXY: v }).fatal.length === 1), bad.filter((v) => trustProxyProblems({ KOI_TRUST_PROXY: v }).fatal.length !== 1).join(" | "));
});
withMode("development", () => check("B3 development: a bad value is a warning only", trustProxyProblems({ KOI_TRUST_PROXY: "true" }).fatal.length === 0 && trustProxyProblems({ KOI_TRUST_PROXY: "true" }).warnings.length === 1));

// ============================================================================================================ C. the real server process
// A synthetic, never-resolvable connection string, assembled at run time so no credential-shaped URI literal sits in this file (the secret-hygiene suites scan source files for that shape).
const placeholderDb = (name) => ["mongodb+srv:", "//placeholder-user:placeholder-pw-0000@", "cluster.example.invalid/", name, "?retryWrites=true"].join("");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "koi-rc-guards-"));
const baseEnv = (extra) => ({
  PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP,
  KOI_NO_DOTENV: "1", KOI_NO_DOTENV_REASON: "validation", // never read the real backend/.env
  NODE_ENV: "production", PORT: "0", MONGODB_URI: placeholderDb("koi_rc"),
  LLM_PROVIDER: "gemini", AI_SERVICE_URL: "http://ai.internal.example.invalid:8000", ...extra,
});
const runServer = (extra) => { const r = spawnSync(process.execPath, [path.join(BACKEND, "server.js")], { env: baseEnv(extra), encoding: "utf8", timeout: 60000 }); return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` }; };
const slash = runServer({ CLIENT_URL: "https://app.example.com/" });
check("C1 the server REFUSES to start (exit 1) on a trailing-slash CLIENT_URL, naming the rule and never the value", slash.code === 1 && /Refusing to start: invalid deployment configuration/.test(slash.out) && /exact origin/.test(slash.out) && !slash.out.includes("app.example.com"), `${slash.code} ${slash.out.slice(0, 200)}`);
const nothing = runServer({ CLIENT_URL: "https://app.example.com" });
check("C2 with an exact origin it gets PAST this check (it then fails later on the placeholder database host, which is the point: no deployment-configuration refusal)", !/invalid deployment configuration/.test(nothing.out), nothing.out.slice(0, 200));
const proxy = runServer({ CLIENT_URL: "https://app.example.com", KOI_TRUST_PROXY: "true" });
check("C3 the server refuses to start on KOI_TRUST_PROXY=true in production", proxy.code === 1 && /invalid deployment configuration/.test(proxy.out) && /KOI_TRUST_PROXY/.test(proxy.out), `${proxy.code} ${proxy.out.slice(0, 200)}`);
const proxyGood = runServer({ CLIENT_URL: "https://app.example.com", KOI_TRUST_PROXY: "1" });
check("C4 a valid hop count gets past the check", !/invalid deployment configuration/.test(proxyGood.out), proxyGood.out.slice(0, 200));
const both = runServer({ CLIENT_URL: "https://app.example.com/", KOI_TRUST_PROXY: "0" });
check("C5 both problems are reported together", both.code === 1 && /exact origin/.test(both.out) && /KOI_TRUST_PROXY/.test(both.out));
const dev = spawnSync(process.execPath, [path.join(BACKEND, "server.js")], { env: baseEnv({ NODE_ENV: "development", CLIENT_URL: "http://localhost:5175/", MONGODB_URI: "mongodb://127.0.0.1:1/koi_rc_none", AUTH_PROVIDER: "" }), encoding: "utf8", timeout: 60000 });
check("C6 in development the same value is a WARNING, not a refusal", /WARNING: CLIENT_URL must be an exact origin/.test(`${dev.stdout}${dev.stderr}`) && !/invalid deployment configuration/.test(`${dev.stdout}${dev.stderr}`));

// ============================================================================================================ D. the operator preflight
const GOOD_BACKEND = {
  NODE_ENV: "production", PORT: "8080", CLIENT_URL: "https://app.example.invalid",
  MONGODB_URI: placeholderDb("koi_prod"),
  AUTH_PROVIDER: "oidc", OIDC_ISSUER: "https://idp.example.invalid", OIDC_AUDIENCE: "koi-api", LLM_PROVIDER: "gemini", AI_SERVICE_URL: "http://ai.internal.example.invalid:8000", KOI_TRUST_PROXY: "1",
  AI_SERVICE_TOKEN: "placeholder-service-token-0123456789-abcdef",
};
const GOOD_AI = { LLM_PROVIDER: "gemini", LLM_MODEL: "gemini-3.1-flash-lite", GEMINI_API_KEY: "placeholder-gemini-key-not-real-0000", EMBEDDING_PROVIDER: "gemini", REQUEST_TIMEOUT_MS: "20000", AI_SERVICE_TOKEN: GOOD_BACKEND.AI_SERVICE_TOKEN };
const GOOD_FE = { VITE_API_BASE_URL: "https://api.example.invalid", VITE_OIDC_AUTHORITY: "https://idp.example.invalid", VITE_OIDC_CLIENT_ID: "placeholder-public-client" };
const without = (o, ...ks) => Object.fromEntries(Object.entries(o).filter(([k]) => !ks.includes(k)));
let n = 0;
const preflight = ({ backend = GOOD_BACKEND, ai = GOOD_AI, fe = GOOD_FE } = {}) => {
  n += 1; const dir = path.join(TMP, `p${n}`); fs.mkdirSync(dir);
  const file = (name, obj) => { const p = path.join(dir, name); fs.writeFileSync(p, Object.entries(obj).map(([k, v]) => `${k}=${v}`).join("\n")); return p; };
  const r = spawnSync(process.execPath, [path.join(here, "phase39", "env-preflight.mjs"), "--backend", file("b.env", backend), "--ai", file("a.env", ai), "--frontend", file("f.env", fe)], { encoding: "utf8", timeout: 60000, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } });
  const out = `${r.stdout}${r.stderr}`;
  return { status: r.status, out, failing: out.split(/\r?\n/).filter((l) => /^\s*FAIL\b/.test(l)) };
};
const ok = preflight();
check("D1 a correct synthetic production set passes the preflight (no FAIL)", ok.status === 0 && ok.failing.length === 0, ok.failing.join(" | "));
for (const [label, backend, item] of [
  ["a trailing-slash CLIENT_URL", { ...GOOD_BACKEND, CLIENT_URL: "https://app.example.invalid/" }, "CLIENT_URL"],
  ["a CLIENT_URL with a path", { ...GOOD_BACKEND, CLIENT_URL: "https://app.example.invalid/app" }, "CLIENT_URL"],
  ["KOI_TRUST_PROXY=true", { ...GOOD_BACKEND, KOI_TRUST_PROXY: "true" }, "KOI_TRUST_PROXY"],
  ["KOI_TRUST_PROXY=0", { ...GOOD_BACKEND, KOI_TRUST_PROXY: "0" }, "KOI_TRUST_PROXY"],
  ["no AI_SERVICE_TOKEN on the backend", without(GOOD_BACKEND, "AI_SERVICE_TOKEN"), "AI_SERVICE_TOKEN"],
  ["a short AI_SERVICE_TOKEN", { ...GOOD_BACKEND, AI_SERVICE_TOKEN: "short" }, "AI_SERVICE_TOKEN"],
]) {
  const r = preflight({ backend, ai: label.includes("AI_SERVICE_TOKEN") && backend.AI_SERVICE_TOKEN !== undefined ? { ...GOOD_AI, AI_SERVICE_TOKEN: backend.AI_SERVICE_TOKEN } : GOOD_AI });
  check(`D2 preflight FAILS on ${label}`, r.status === 1 && r.failing.some((l) => l.includes(item)), r.failing.join(" | ") || "no failure");
}
check("D3 the preflight output never prints the token or any configured value", !ok.out.includes(GOOD_BACKEND.AI_SERVICE_TOKEN) && !ok.out.includes("placeholder-pw-0000") && !ok.out.includes("placeholder-gemini-key"));

// ============================================================================================================ E. coverage of the other production traps (the guards already exist; this proves they still do)
const prod = { NODE_ENV: "production" };
withMode("production", () => {
  const eoi = { ...prod, AUTH_PROVIDER: "eoi" };
  check("E1 production HTTPS: an http (or localhost) CLIENT_URL is fatal when e-mail is needed", emailStartupProblems({ clientUrl: "http://app.example.com", environment: eoi }).fatal.some((m) => /https/.test(m)) && emailStartupProblems({ clientUrl: "https://localhost", environment: eoi }).fatal.some((m) => /localhost/.test(m)));
  check("E2 required SMTP: AUTH_PROVIDER=eoi in production without a complete SMTP configuration is fatal", emailStartupProblems({ clientUrl: "https://app.example.com", environment: eoi }).fatal.length > 0 && emailStartupProblems({ clientUrl: "https://app.example.com", environment: { ...eoi, SMTP_HOST: "smtp.example.invalid", SMTP_PORT: "587", SMTP_USER: "u", SMTP_PASSWORD: "p", MAIL_FROM: "EOI <no-reply@example.invalid>" } }).fatal.length === 0);
  check("E3 forbidden outbox transport: refused in production, never a fallback for missing SMTP", emailStartupProblems({ clientUrl: "https://app.example.com", environment: { ...eoi, KOI_EMAIL_TRANSPORT: "outbox" } }).fatal.length > 0 && resolveEmailConfig({ ...eoi, KOI_EMAIL_TRANSPORT: "outbox" }).transport === "none");
  check("E4 forbidden development auth: the stub verifier is refused in production", authStartupProblems({ ...prod, AUTH_PROVIDER: "stub", AUTH_STUB_SECRET: "placeholder-stub-0000-0000-0000-0000-0000" }).fatal.length > 0);
  check("E5 production AI URL: required on the gemini route, plain http(s), no credentials", productionAiConfigProblems({ LLM_PROVIDER: "gemini" }).fatal.length > 0 && productionAiConfigProblems({ LLM_PROVIDER: "gemini", AI_SERVICE_URL: "ftp://x.example" }).fatal.length > 0 && productionAiConfigProblems({ LLM_PROVIDER: "gemini", AI_SERVICE_URL: "http://u:p@ai.example:8000" }).fatal.length > 0 && productionAiConfigProblems({ LLM_PROVIDER: "gemini", AI_SERVICE_URL: "http://ai.example:8000" }).fatal.length === 0);
  check("E6 forbidden test providers: test and test-python are fatal in production, and a typo is fatal", ["test", "test-python", "gemni"].every((p) => productionAiConfigProblems({ LLM_PROVIDER: p, AI_SERVICE_URL: "http://ai.example:8000" }).fatal.length > 0));
  check("E7 AI service credential: absent is reported at start-up (warning) and the AI service itself refuses callers without it when it is set", productionAiConfigProblems({ LLM_PROVIDER: "gemini", AI_SERVICE_URL: "http://ai.example:8000" }).warnings.some((m) => /AI_SERVICE_TOKEN/.test(m)) && productionAiConfigProblems({ LLM_PROVIDER: "gemini", AI_SERVICE_URL: "http://ai.example:8000", AI_SERVICE_TOKEN: "x".repeat(32) }).warnings.length === 0 && /compare_digest/.test(fs.readFileSync(path.join(BACKEND, "..", "ai-service", "app", "main.py"), "utf8")));
  check("E8 Learning disabled: enabling it is reported at start-up (and the preflight FAILs it, section D of the Phase 39 suite)", productionAiConfigProblems({ LLM_PROVIDER: "gemini", AI_SERVICE_URL: "http://ai.example:8000", KOI_LEARNING_CONTEXT_ENABLED: "true" }).warnings.some((m) => /Learning/.test(m)) || (() => { const saved = process.env.KOI_LEARNING_CONTEXT_ENABLED; process.env.KOI_LEARNING_CONTEXT_ENABLED = "true"; try { return productionAiConfigProblems({ LLM_PROVIDER: "gemini", AI_SERVICE_URL: "http://ai.example:8000" }).warnings.some((m) => /Learning/.test(m)); } finally { if (saved === undefined) delete process.env.KOI_LEARNING_CONTEXT_ENABLED; else process.env.KOI_LEARNING_CONTEXT_ENABLED = saved; } })());
  check("E9 database name: a MONGODB_URI without one is fatal in production", mongoConfigProblems("mongodb+srv://u:p@cluster.example.invalid/?retryWrites=true").fatal.length > 0 && mongoConfigProblems("mongodb+srv://u:p@cluster.example.invalid/koi_prod?retryWrites=true").fatal.length === 0);
  const savedT = { a: process.env.KOI_AI_TIMEOUT_MS, s: process.env.KOI_SOCKET_TIMEOUT_MS, p: process.env.LLM_PROVIDER, an: process.env.KOI_AI_ANALYSIS_TIMEOUT_MS };
  try {
    process.env.LLM_PROVIDER = "gemini"; process.env.KOI_AI_TIMEOUT_MS = "20000"; process.env.KOI_SOCKET_TIMEOUT_MS = "1000"; delete process.env.KOI_AI_ANALYSIS_TIMEOUT_MS;
    const impossible = timeoutBudgetProblems().fatal.length;
    process.env.KOI_SOCKET_TIMEOUT_MS = "120000"; process.env.KOI_AI_ANALYSIS_TIMEOUT_MS = "60000";
    const belowCeiling = timeoutBudgetProblems().fatal.length;
    delete process.env.KOI_AI_TIMEOUT_MS; delete process.env.KOI_SOCKET_TIMEOUT_MS; delete process.env.KOI_AI_ANALYSIS_TIMEOUT_MS;
    const defaults = timeoutBudgetProblems().fatal.length;
    check("E10 invalid timeout combinations are fatal (socket too small for the budget; Gemini route analysis wait not above the 60 s ceiling); the shipped defaults are valid", impossible > 0 && belowCeiling > 0 && defaults === 0, `${impossible} ${belowCeiling} ${defaults}`);
  } finally { for (const [k, v] of [["KOI_AI_TIMEOUT_MS", savedT.a], ["KOI_SOCKET_TIMEOUT_MS", savedT.s], ["LLM_PROVIDER", savedT.p], ["KOI_AI_ANALYSIS_TIMEOUT_MS", savedT.an]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
  check("E11 the single-instance / process-local rate-limit warnings are still emitted in production", runtimeWarnings({}).some((m) => /PROCESS-LOCAL/.test(m)));
});
const pf = fs.readFileSync(path.join(here, "phase39", "env-preflight.mjs"), "utf8");
check("E12 the preflight carries the Gemini-key-absent-from-Node rule (tested by the Phase 39 suite)", /GEMINI_API_KEY in the backend environment/.test(pf));

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
console.log(`\nRelease-candidate configuration guards validation: ${passed} passed, ${failed} failed (no database, no Gemini, no external network)`);
process.exit(failed ? 1 : 0);
