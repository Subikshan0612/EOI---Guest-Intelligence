/**
 * Phase 21 validation: API runtime hardening.
 *
 *   1. rate limiting (below limit / next request 429 / isolation between clients and identities / no bypass by changing
 *      workspace or body ids or headers / write, AI, import tiers / config parsing / store)
 *   2. security headers
 *   3. HTTP and upstream timeouts
 *   4. cross-workspace status-code leak (foreign id === nonexistent id)
 *   5. import resource limits
 *   6. authentication BEFORE body processing
 *   7. fail-closed environment mode (development / test / production / unset / unknown) and test-provider isolation
 *
 * REAL HTTP against REAL spawned backends, real stored users/memberships/stub tokens, throwaway workspaces. Every server runs
 * with NODE_ENV=test (unless the case is about another mode), a DEAD AI URL or a local trap, and provider `test`/`test-python`:
 * no external AI request is possible. Rate limiting is ENABLED on every server this suite spawns, with explicit small limits.
 */
import { spawn } from "node:child_process";
import net from "node:net";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import * as Models from "../src/models/index.js";
import { Guest, Property, Signal, Stay, Unit, User, Workspace, WorkspaceMembership } from "../src/models/index.js";
import { getAiTimeoutMs, getHttpTimeouts, getImportLimits, getRateLimitConfig, getTrustProxy } from "../src/config/runtimeConfig.js";
import { MemoryRateLimitStore } from "../src/middleware/rateLimit.js";
import { externalAiViolationsForTestMode, runtimeWarnings } from "../src/config/startupChecks.js";
import { getRuntimeMode, isDevelopmentOrTestMode } from "../src/config/runtimeMode.js";
import { bearer, cleanupAuthFixtures, createActor } from "./lib/authFixtures.mjs";
import { APPROVED_PROVIDER } from "../src/config/providerPolicy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, "..", "server.js");
const FAKE = "6aa29b8d18df3e22b3e89cff";
const DEAD_AI = "http://localhost:9";

let passed = 0;
let failed = 0;
const check = (name, condition, detail = "") => {
  if (condition) {
    passed += 1;
    console.log(`PASS  ${name}${detail ? ` - ${detail}` : ""}`);
  } else {
    failed += 1;
    console.error(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
  }
};

const children = [];
function startServer(port, env = {}, { cwd, dropEnv = [] } = {}) {
  const merged = { ...process.env, PORT: String(port), NODE_ENV: "test", LLM_PROVIDER: "test", AI_SERVICE_URL: DEAD_AI, KNOWLEDGE_DEV_AUTHORIZED_LEVEL: "restricted", KOI_RATE_LIMIT_ENABLED: "true", ...env };
  for (const key of dropEnv) delete merged[key];
  const child = spawn(process.execPath, [SERVER_ENTRY], { env: merged, cwd, stdio: "ignore" });
  children.push(child);
  return child;
}
// Readiness = the TCP port accepts a connection (the server listens only after MongoDB connected). No HTTP request is made, so
// the probe never consumes a rate-limit bucket that a later assertion counts.
async function waitForHealth(port, timeoutMs = 20000) {
  const start = Date.now();
  for (;;) {
    const ok = await new Promise((resolve) => {
      const socket = net.connect(port, "127.0.0.1", () => {
        socket.destroy();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
    if (ok) return;
    if (Date.now() - start > timeoutMs) throw new Error(`server ${port} not ready`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
const exitCodeWithin = (child, ms) => new Promise((resolve) => {
  const timer = setTimeout(() => resolve("still running"), ms);
  child.once("exit", (code) => {
    clearTimeout(timer);
    resolve(code);
  });
});

async function call(port, method, url, headers = {}, body, extra = {}) {
  const isForm = body instanceof FormData;
  const response = await fetch(`http://localhost:${port}${url.startsWith("/") ? url : `/${url}`}`, {
    method,
    headers: { ...(body !== undefined && !isForm && extra.raw === undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    body: extra.raw !== undefined ? extra.raw : body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });
  const raw = await response.text();
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {
    json = null;
  }
  return { status: response.status, headers: response.headers, json, raw, data: json?.data, code: json?.details?.code, message: json?.message };
}
const api = (port, method, url, headers, body, extra) => call(port, method, `/api${url}`, headers, body, extra);

const ids = { workspaces: [] };
async function cleanup() {
  await connectDatabase();
  await cleanupAuthFixtures();
  const ws = { $in: ids.workspaces };
  const props = await Property.find({ workspaceId: ws }).distinct("_id");
  const convs = await Models.Conversation.find({ workspaceId: ws }).distinct("_id");
  await Models.Message.deleteMany({ conversationId: { $in: convs } });
  await Unit.deleteMany({ propertyId: { $in: props } });
  await Promise.all(["Conversation", "Guest", "Stay", "Signal", "Property", "KnowledgeChunk", "KnowledgeDocument", "ImportBatch", "Intelligence", "Decision", "WorkspaceMembership"].map((m) => Models[m].deleteMany({ workspaceId: ws })));
  await Workspace.deleteMany({ _id: ws });
  await disconnectDatabase();
}

async function main() {
  const stamp = Date.now();
  const P = { limits: 5111, ip: 5112, off: 5113, headers: 5114, prodHeaders: 5115, timeouts: 5116, aiTimeout: 5117, order: 5118, oracle: 5119, imports: 5120, dev: 5121, test: 5122, prod: 5123, unset: 5124, staging: 5125 };

  // --------------------------------------------------------------------------------------------------------------
  // In-process units (no server): config parsing, store, mode helpers, startup checks
  // --------------------------------------------------------------------------------------------------------------
  const saved = { ...process.env };
  const withEnv = (vars, fn) => {
    const backup = {};
    for (const [k, v] of Object.entries(vars)) {
      backup[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      return fn();
    } finally {
      for (const [k, v] of Object.entries(backup)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };
  const cfg0 = withEnv({ KOI_RATE_LIMIT_ENABLED: undefined, KOI_RATE_LIMIT_WINDOW_MS: undefined, KOI_RATE_LIMIT_ANON_MAX: undefined, KOI_RATE_LIMIT_IP_MAX: undefined, KOI_RATE_LIMIT_USER_MAX: undefined, KOI_RATE_LIMIT_WRITE_MAX: undefined, KOI_RATE_LIMIT_AI_MAX: undefined, KOI_RATE_LIMIT_AI_WORKSPACE_MAX: undefined, KOI_RATE_LIMIT_IMPORT_MAX: undefined }, getRateLimitConfig);
  check("RC1 rate limiting is ON by default", cfg0.enabled === true);
  check("RC2 documented defaults: window 60s, anon 60, ip 900, user 300, write 60, ai 10, ai-workspace 30, import 5", cfg0.windowMs === 60000 && cfg0.anonMax === 60 && cfg0.ipMax === 900 && cfg0.userMax === 300 && cfg0.writeMax === 60 && cfg0.aiMax === 10 && cfg0.aiWorkspaceMax === 30 && cfg0.importMax === 5, JSON.stringify(cfg0));
  const bad = withEnv({ KOI_RATE_LIMIT_USER_MAX: "abc", KOI_RATE_LIMIT_WRITE_MAX: "-5", KOI_RATE_LIMIT_AI_MAX: "0", KOI_RATE_LIMIT_IMPORT_MAX: "1.5", KOI_RATE_LIMIT_WINDOW_MS: "5", KOI_RATE_LIMIT_ENABLED: "true" }, getRateLimitConfig);
  check("RC3 invalid values (non-numeric, negative, zero, fractional, below the minimum window) fall back to the defaults, never disabling a limit", bad.userMax === 300 && bad.writeMax === 60 && bad.aiMax === 10 && bad.importMax === 5 && bad.windowMs === 60000 && bad.enabled === true);
  const custom = withEnv({ KOI_RATE_LIMIT_USER_MAX: "7", KOI_RATE_LIMIT_ENABLED: "false" }, getRateLimitConfig);
  check("RC4 valid values are honoured; only the explicit string `false` disables limiting", custom.userMax === 7 && custom.enabled === false && withEnv({ KOI_RATE_LIMIT_ENABLED: "0" }, getRateLimitConfig).enabled === true);
  check("RC5 X-Forwarded-For is NOT trusted by default (KOI_TRUST_PROXY unset/invalid -> false; a hop count enables it)", withEnv({ KOI_TRUST_PROXY: undefined }, getTrustProxy) === false && withEnv({ KOI_TRUST_PROXY: "yes" }, getTrustProxy) === false && withEnv({ KOI_TRUST_PROXY: "1" }, getTrustProxy) === 1);
  const store = new MemoryRateLimitStore({ maxKeys: 3 });
  const t0 = 1_000_000;
  check("ST1 store counts hits inside a window", store.hit("a", 1000, t0).count === 1 && store.hit("a", 1000, t0 + 10).count === 2 && store.hit("b", 1000, t0).count === 1);
  check("ST2 store resets after the window", store.hit("a", 1000, t0 + 1001).count === 1);
  store.hit("c", 1000, t0);
  store.hit("d", 1000, t0);
  check("ST3 store is memory-bounded: never more keys than maxKeys", store.size <= 3, `size ${store.size}`);
  store.sweep(t0 + 5000);
  check("ST4 sweep removes expired windows", store.size === 0);
  clearInterval(store.sweeper);
  const t = withEnv({ KOI_HEADERS_TIMEOUT_MS: undefined, KOI_REQUEST_TIMEOUT_MS: undefined, KOI_SOCKET_TIMEOUT_MS: undefined, KOI_KEEPALIVE_TIMEOUT_MS: undefined, KOI_TIMEOUT_CHECK_INTERVAL_MS: undefined, KOI_AI_TIMEOUT_MS: undefined }, () => ({ ...getHttpTimeouts(), ai: getAiTimeoutMs() }));
  check("TC1 timeout defaults: headers 15s, request 60s, socket idle 120s, keep-alive 5s, check 5s, AI upstream 20s (the historical AI value)", t.headersTimeoutMs === 15000 && t.requestTimeoutMs === 60000 && t.socketTimeoutMs === 120000 && t.keepAliveTimeoutMs === 5000 && t.checkIntervalMs === 5000 && t.ai === 20000, JSON.stringify(t));
  check("TC2 invalid/out-of-range timeouts fall back to the defaults", withEnv({ KOI_AI_TIMEOUT_MS: "abc" }, getAiTimeoutMs) === 20000 && withEnv({ KOI_AI_TIMEOUT_MS: "5" }, getAiTimeoutMs) === 20000 && withEnv({ KOI_AI_TIMEOUT_MS: "999999" }, getAiTimeoutMs) === 20000 && withEnv({ KOI_AI_TIMEOUT_MS: "400" }, getAiTimeoutMs) === 400);
  const il = withEnv({ KOI_IMPORT_MAX_ROWS: undefined, KOI_IMPORT_MAX_COLUMNS: undefined, KOI_IMPORT_MAX_FIELD_LENGTH: undefined, KOI_IMPORT_MAX_RECORD_BYTES: undefined }, getImportLimits);
  check("IC1 import limit defaults: 5000 rows, 50 columns, 1000-char fields, 20,000-byte records", il.maxRows === 5000 && il.maxColumns === 50 && il.maxFieldLength === 1000 && il.maxRecordBytes === 20000, JSON.stringify(il));
  const modes = [["development", "development", true], ["test", "test", true], ["production", "production", false], [undefined, "unknown", false], ["", "unknown", false], ["staging", "unknown", false], ["Production", "production", false], [" TEST ", "test", true], ["dev", "unknown", false]];
  for (const [value, mode, devOk] of modes) {
    check(`EM1 NODE_ENV=${JSON.stringify(value)} -> mode ${mode}; development features ${devOk ? "allowed" : "REFUSED"}`, withEnv({ NODE_ENV: value }, () => getRuntimeMode() === mode && isDevelopmentOrTestMode() === devOk));
  }
  check("SG1 test mode refuses a non-loopback AI URL, and openai with a key; accepts loopback / dead port / no URL", withEnv({ NODE_ENV: "test" }, () => externalAiViolationsForTestMode({ AI_SERVICE_URL: "https://generativelanguage.googleapis.com" }).length === 1 && externalAiViolationsForTestMode({ LLM_PROVIDER: "openai", OPENAI_API_KEY: "x" }).length === 1 && externalAiViolationsForTestMode({ AI_SERVICE_URL: "http://localhost:8010" }).length === 0 && externalAiViolationsForTestMode({ AI_SERVICE_URL: DEAD_AI }).length === 0 && externalAiViolationsForTestMode({}).length === 0 && externalAiViolationsForTestMode({ AI_SERVICE_URL: "not a url" }).length === 1));
  check("SG2 the guard applies ONLY in test mode (development/production are unaffected by it)", withEnv({ NODE_ENV: "development" }, () => externalAiViolationsForTestMode({ AI_SERVICE_URL: "https://example.com" }).length === 0));
  check("SG3 startup warnings: unknown mode is called out; production names the process-local rate-limit store", withEnv({ NODE_ENV: undefined }, () => runtimeWarnings({}).some((w) => /unset or unrecognised/.test(w))) && withEnv({ NODE_ENV: "production" }, () => runtimeWarnings({}).some((w) => /PROCESS-LOCAL/.test(w))));
  void saved;

  let trap = null;
  try {
    await connectDatabase();
    await Promise.all([User.init(), WorkspaceMembership.init()]);
    const mkWs = async (label) => {
      const doc = await Workspace.create({ name: `P21 ${label} ${stamp}`, slug: `p21-${label}-${stamp}` });
      ids.workspaces.push(doc._id);
      return doc;
    };
    const wsA = await mkWs("a");
    const wsB = await mkWs("b");
    const A = String(wsA._id);
    const B = String(wsB._id);
    const OWN = ids.workspaces;
    const NAMES = ["Workspace", "Property", "Guest", "Stay", "Signal", "Intelligence", "KnowledgeDocument", "KnowledgeChunk", "ImportBatch", "Conversation", "Decision", "Action", "Outcome"];
    const realCounts = async () => ({
      ...Object.fromEntries(await Promise.all(NAMES.map(async (name) => [name, await Models[name].countDocuments(name === "Workspace" ? { _id: { $nin: OWN } } : { workspaceId: { $nin: OWN } })]))),
      Message: await Models.Message.countDocuments({ conversationId: { $nin: await Models.Conversation.find({ workspaceId: { $in: OWN } }).distinct("_id") } }),
      Unit: await Unit.countDocuments({ propertyId: { $nin: await Property.find({ workspaceId: { $in: OWN } }).distinct("_id") } }),
    });
    const before = await realCounts();
    const mk = (role, ws = wsA, label = "p21") => createActor({ role, workspaceId: ws._id, label });
    const H = (who) => who.headers;

    // servers ---------------------------------------------------------------------------------------------------
    startServer(P.limits, { KOI_RATE_LIMIT_ANON_MAX: "5", KOI_RATE_LIMIT_IP_MAX: "100000", KOI_RATE_LIMIT_USER_MAX: "8", KOI_RATE_LIMIT_WRITE_MAX: "3", KOI_RATE_LIMIT_AI_MAX: "2", KOI_RATE_LIMIT_AI_WORKSPACE_MAX: "3", KOI_RATE_LIMIT_IMPORT_MAX: "2", KOI_RATE_LIMIT_WINDOW_MS: "60000" });
    startServer(P.ip, { KOI_RATE_LIMIT_ANON_MAX: "100000", KOI_RATE_LIMIT_IP_MAX: "6", KOI_RATE_LIMIT_USER_MAX: "100000" });
    startServer(P.off, { KOI_RATE_LIMIT_ENABLED: "false", KOI_RATE_LIMIT_ANON_MAX: "2", KOI_RATE_LIMIT_USER_MAX: "2", KOI_RATE_LIMIT_IP_MAX: "2" });
    startServer(P.headers, { KOI_RATE_LIMIT_ANON_MAX: "1000" });
    startServer(P.prodHeaders, { NODE_ENV: "production", LLM_PROVIDER: APPROVED_PROVIDER, AUTH_PROVIDER: "oidc", OIDC_ISSUER: "https://127.0.0.1:9", OIDC_AUDIENCE: "eoi-suite-audience" });
    startServer(P.order, { KOI_RATE_LIMIT_ANON_MAX: "1000", KOI_RATE_LIMIT_USER_MAX: "100000", KOI_RATE_LIMIT_IP_MAX: "100000", KOI_RATE_LIMIT_WRITE_MAX: "100000", KOI_JSON_BODY_LIMIT_BYTES: "20480" });
    startServer(P.oracle, { KOI_RATE_LIMIT_ENABLED: "false" });
    startServer(P.imports, { KOI_RATE_LIMIT_ENABLED: "false", KOI_IMPORT_MAX_ROWS: "5", KOI_IMPORT_MAX_COLUMNS: "6", KOI_IMPORT_MAX_FIELD_LENGTH: "20", KOI_IMPORT_MAX_RECORD_BYTES: "400" });
    startServer(P.timeouts, { KOI_RATE_LIMIT_ENABLED: "false", KOI_HEADERS_TIMEOUT_MS: "1000", KOI_REQUEST_TIMEOUT_MS: "1500", KOI_TIMEOUT_CHECK_INTERVAL_MS: "200" });
    // a trap that accepts the connection and never answers (a hung upstream)
    const held = [];
    trap = http.createServer((req) => held.push(req));
    await new Promise((resolve) => trap.listen(5126, resolve));
    startServer(P.aiTimeout, { KOI_RATE_LIMIT_ENABLED: "false", LLM_PROVIDER: "test-python", AI_SERVICE_URL: "http://localhost:5126", KOI_AI_TIMEOUT_MS: "500", KOI_AI_ANALYSIS_TIMEOUT_MS: "625" }); // Workstream 5C: the analysis wait no longer follows KOI_AI_TIMEOUT_MS
    const tmp = os.tmpdir(); // no .env here: NODE_ENV comes ONLY from the spawn environment
    startServer(P.dev, { NODE_ENV: "development", KOI_RATE_LIMIT_ENABLED: "false", KOI_EXPOSE_ERROR_DETAILS: "true" }, { cwd: tmp });
    startServer(P.test, { NODE_ENV: "test", KOI_RATE_LIMIT_ENABLED: "false", KOI_EXPOSE_ERROR_DETAILS: "true" }, { cwd: tmp });
    startServer(P.prod, { NODE_ENV: "production", LLM_PROVIDER: APPROVED_PROVIDER, KOI_RATE_LIMIT_ENABLED: "false", KOI_EXPOSE_ERROR_DETAILS: "true", AUTH_PROVIDER: "oidc", OIDC_ISSUER: "https://127.0.0.1:9", OIDC_AUDIENCE: "eoi-suite-audience" }, { cwd: tmp });
    startServer(P.unset, { LLM_PROVIDER: APPROVED_PROVIDER, KOI_RATE_LIMIT_ENABLED: "false", KOI_EXPOSE_ERROR_DETAILS: "true" }, { cwd: tmp, dropEnv: ["NODE_ENV"] });
    startServer(P.staging, { NODE_ENV: "staging", LLM_PROVIDER: APPROVED_PROVIDER, KOI_RATE_LIMIT_ENABLED: "false", KOI_EXPOSE_ERROR_DETAILS: "true" }, { cwd: tmp });
    await Promise.all(Object.values(P).map((port) => waitForHealth(port)));
    check("all spawned backends are healthy (NODE_ENV=test unless the case is about another mode; dead/local AI URLs only)", true);

    // ================================================ 1. rate limiting
    const viewerX = await mk("viewer", wsA, "p21-x");
    const viewerY = await mk("viewer", wsA, "p21-y");
    let r;
    for (let i = 1; i <= 8; i += 1) {
      r = await api(P.limits, "GET", `/properties?workspaceId=${A}`, H(viewerX));
      if (r.status !== 200) break;
    }
    check("RL1 requests below the limit succeed (8 authenticated reads at USER_MAX=8 -> all 200)", r.status === 200);
    r = await api(P.limits, "GET", `/properties?workspaceId=${A}`, H(viewerX));
    check("RL2 the NEXT request is rejected with 429", r.status === 429, `HTTP ${r.status}`);
    check("RL3 the 429 uses the existing error contract and reveals no implementation detail", r.json?.success === false && r.message === "Too many requests" && r.code === "RATE_LIMITED" && Number.isInteger(r.json?.details?.retryAfterSeconds) && !/redis|memory|store|limiter|express|stack|window|max\b/i.test(r.raw), r.raw.slice(0, 160));
    check("RL4 the 429 carries Retry-After and RateLimit-* headers", Number(r.headers.get("retry-after")) >= 1 && r.headers.get("ratelimit-limit") === "8" && r.headers.get("ratelimit-remaining") === "0");
    r = await api(P.limits, "GET", `/properties?workspaceId=${A}`, H(viewerY));
    check("RL5 ISOLATION: a different identity is unaffected while X is limited (200)", r.status === 200);
    for (const [label, url, headers] of [
      ["a different workspace id", `/properties?workspaceId=${B}`, H(viewerX)],
      ["a malformed workspace id", `/properties?workspaceId=zzz`, H(viewerX)],
      ["no workspace id", `/properties`, H(viewerX)],
      ["a different route", `/units?workspaceId=${A}`, H(viewerX)],
      ["another resource id in the path", `/guests/${FAKE}?workspaceId=${A}`, H(viewerX)],
      ["forged X-Forwarded-For / X-Real-IP / X-Role / X-Workspace-Id / X-User-Id headers", `/properties?workspaceId=${A}`, { ...H(viewerX), "x-forwarded-for": "203.0.113.9", "x-real-ip": "203.0.113.9", "x-role": "admin", "x-workspace-id": B, "x-user-id": "someone-else" }],
      ["extra query parameters (role, permission, userId, workspaceId)", `/properties?workspaceId=${A}&role=admin&permission=x&userId=y&page=2`, H(viewerX)],
    ]) {
      r = await api(P.limits, "GET", url, headers);
      check(`RL6 NO BYPASS: ${label} still gets 429 for the same identity`, r.status === 429, `HTTP ${r.status}`);
    }
    r = await api(P.limits, "POST", `/guests`, H(viewerX), { workspaceId: B, firstName: "x", lastName: "y" });
    check("RL7 NO BYPASS: a POST naming another workspace in the BODY is 429 before any lookup", r.status === 429);
    // write tier
    const operatorZ = await mk("operator", wsA, "p21-z");
    const guestBody = (n) => ({ workspaceId: A, firstName: `P21w${n}`, lastName: "Limit", email: `p21w${n}-${stamp}@example.invalid` });
    const writes = [];
    for (let i = 1; i <= 3; i += 1) writes.push((await api(P.limits, "POST", "/guests", H(operatorZ), guestBody(i))).status);
    check("RW1 WRITE tier: 3 writes at WRITE_MAX=3 succeed (201)", writes.every((s) => s === 201), writes.join(","));
    r = await api(P.limits, "POST", "/guests", H(operatorZ), guestBody(4));
    check("RW2 the 4th write -> 429, with the specific tier's own headers", r.status === 429 && r.headers.get("ratelimit-limit") === "3");
    r = await api(P.limits, "GET", `/guests?workspaceId=${A}`, H(operatorZ));
    check("RW3 reads are NOT counted against the write tier (a GET still works)", r.status === 200);
    r = await api(P.limits, "PATCH", `/guests/${FAKE}?workspaceId=${A}`, H(operatorZ), { firstName: "x" });
    check("RW4 PATCH and DELETE share the write tier (PATCH -> 429)", r.status === 429);
    const guestsStored = await Guest.countDocuments({ workspaceId: wsA._id, lastName: "Limit" });
    check("RW5 the rejected write was not executed (exactly 3 guests stored)", guestsStored === 3, String(guestsStored));
    // AI tier
    const opAi = await mk("operator", wsA, "p21-ai1");
    const revAi = await mk("reviewer", wsA, "p21-ai2");
    const adminAi = await mk("admin", wsA, "p21-ai3");
    const analyze = (who) => api(P.limits, "POST", `/intelligence/analyze/${FAKE}?workspaceId=${A}`, H(who));
    const aiStatuses = [(await analyze(opAi)).status, (await analyze(opAi)).status];
    const preAi = (status) => status === 404 || status === 503; // refused BEFORE any AI call (a call to the dead AI URL would be 502)
    check("RA1 AI tier: 2 AI-route requests at AI_MAX=2 pass the limiter (each is refused by its own pre-AI check: 404/503, never 502)", aiStatuses.every(preAi), aiStatuses.join(","));
    r = await analyze(opAi);
    check("RA2 the 3rd AI-route request -> 429", r.status === 429 && r.headers.get("ratelimit-limit") === "2");
    r = await analyze(opAi);
    check("RA3 the AI bucket keeps limiting the single (Phase 24) generation route", r.status === 429);
    r = await api(P.limits, "POST", `/signals/${FAKE}/intelligence?workspaceId=${A}`, H(opAi));
    check("RA3b the RETIRED legacy generation route is not a route at all (404, not 429)", r.status === 404);
    r = await api(P.limits, "GET", `/properties?workspaceId=${A}`, H(opAi));
    check("RA4 non-AI routes are unaffected by the AI bucket", r.status === 200);
    r = await analyze(revAi);
    check("RA5 another identity has its own AI bucket (reviewer passes the limiter)", preAi(r.status), `HTTP ${r.status}`);
    // workspace bucket: opAi used 2 (permitted), revAi 1 => 3 = AI_WORKSPACE_MAX. adminAi's first is the 4th in the workspace.
    r = await analyze(adminAi);
    check("RA6 PER-WORKSPACE AI bucket: a THIRD identity's first request is 429 once the workspace's AI budget (3) is spent", r.status === 429 && r.headers.get("ratelimit-limit") === "3", `HTTP ${r.status}`);
    r = await api(P.limits, "POST", `/intelligence/analyze/${FAKE}?workspaceId=${B}`, H(adminAi));
    check("RA7 the workspace bucket keys on the VERIFIED workspace: naming another workspace gets 404 (not a member), not a fresh bucket", r.status === 404);
    r = await analyze(viewerY);
    check("RA8 a viewer (no intelligence:generate) is 403 and does NOT consume the workspace AI budget", r.status === 403);
    // import tier
    const adminImp = await mk("admin", wsA, "p21-imp");
    const importCall = (who, ws = A) => {
      const form = new FormData();
      form.append("workspaceId", ws);
      return api(P.limits, "POST", "/imports/operational", H(who), form);
    };
    const imp = [(await importCall(adminImp)).status, (await importCall(adminImp)).status];
    check("RI1 IMPORT tier: 2 imports at IMPORT_MAX=2 pass the limiter (each 400: no file)", imp.every((s) => s === 400), imp.join(","));
    r = await importCall(adminImp);
    check("RI2 the 3rd import request -> 429 BEFORE the multipart body is parsed", r.status === 429 && r.headers.get("ratelimit-limit") === "2");
    // anonymous (no Authorization)
    const anon = [];
    for (let i = 0; i < 5; i += 1) anon.push((await call(P.limits, "GET", "/api/health")).status);
    check("RN1 ANONYMOUS tier: 5 unauthenticated requests at ANON_MAX=5 succeed", anon.every((s) => s === 200), anon.join(","));
    r = await call(P.limits, "GET", "/api/health");
    check("RN2 the 6th unauthenticated request -> 429 (even for the public health route)", r.status === 429);
    r = await call(P.limits, "GET", "/api/health", { "x-forwarded-for": "198.51.100.77", "x-real-ip": "198.51.100.77" });
    check("RN3 NO BYPASS: spoofed X-Forwarded-For / X-Real-IP does not create a fresh anonymous bucket (proxy headers are not trusted)", r.status === 429);
    r = await call(P.limits, "GET", "/", {});
    check("RN4 the anonymous bucket also covers the root route", r.status === 429);
    r = await api(P.limits, "GET", `/properties?workspaceId=${A}`, H(viewerY));
    check("RN5 authenticated requests from the same address are not blocked by the anonymous bucket", r.status === 200);
    r = await api(P.limits, "GET", `/properties?workspaceId=${A}`, bearer("not.a.token"));
    check("RN6 a request WITH an Authorization header (even an invalid one) is not in the anonymous bucket: it is 401, not 429", r.status === 401);
    // client-address tier
    const viewers = [await mk("viewer", wsA, "p21-ip1"), await mk("viewer", wsA, "p21-ip2"), await mk("viewer", wsA, "p21-ip3")];
    const ipStatuses = [];
    for (let i = 0; i < 6; i += 1) ipStatuses.push((await api(P.ip, "GET", `/properties?workspaceId=${A}`, H(viewers[i % 3]))).status);
    r = await api(P.ip, "GET", `/properties?workspaceId=${A}`, H(viewers[0]));
    check("RP1 CLIENT-ADDRESS tier: 6 requests from one address (rotating identities) at IP_MAX=6 pass, the 7th is 429", ipStatuses.every((s) => s === 200) && r.status === 429, `${ipStatuses.join(",")} then ${r.status}`);
    // disabled
    const offStatuses = [];
    for (let i = 0; i < 12; i += 1) offStatuses.push((await api(P.off, "GET", `/properties?workspaceId=${A}`, H(viewerX))).status);
    check("RD1 KOI_RATE_LIMIT_ENABLED=false disables limiting entirely (12 requests at limits of 2 -> all 200)", offStatuses.every((s) => s === 200));
    check("RD2 the 429s never affected the data: no record of workspace B changed", (await Guest.countDocuments({ workspaceId: wsB._id })) === 0);

    // ================================================ 2. security headers
    const sec = (res, label) => {
      const h = res.headers;
      check(`SH ${label}: X-Content-Type-Options: nosniff`, h.get("x-content-type-options") === "nosniff");
      check(`SH ${label}: Cache-Control: no-store (and no ETag)`, /no-store/.test(h.get("cache-control") ?? "") && !h.get("etag"));
      check(`SH ${label}: Referrer-Policy: no-referrer`, h.get("referrer-policy") === "no-referrer");
      check(`SH ${label}: framing denied (X-Frame-Options DENY + CSP frame-ancestors 'none')`, h.get("x-frame-options") === "DENY" && /frame-ancestors 'none'/.test(h.get("content-security-policy") ?? ""));
      check(`SH ${label}: X-Powered-By is removed`, h.get("x-powered-by") === null);
    };
    const viewerH = await mk("viewer", wsA, "p21-h");
    sec(await call(P.headers, "GET", "/api/health"), "public health");
    sec(await call(P.headers, "GET", "/"), "root");
    sec(await api(P.headers, "GET", `/properties?workspaceId=${A}`), "401 error");
    sec(await api(P.headers, "GET", `/properties?workspaceId=${A}`, H(viewerH)), "authenticated 200");
    sec(await call(P.headers, "GET", "/api/nope"), "404");
    sec(await api(P.headers, "POST", "/properties", { ...H(viewerH), "Content-Type": "application/json" }, undefined, { raw: "{bad" }), "403/400 error");
    sec(await api(P.limits, "GET", `/properties?workspaceId=${A}`, H(viewerX)), "429");
    r = await call(P.headers, "GET", "/api/health");
    check("SH-HSTS not sent outside production (development/test over plain http)", r.headers.get("strict-transport-security") === null);
    r = await call(P.prodHeaders, "GET", "/api/health");
    check("SH-HSTS is sent in production", /max-age=\d+/.test(r.headers.get("strict-transport-security") ?? ""));
    sec(r, "production");
    r = await fetch(`http://localhost:${P.headers}/api/properties`, { method: "OPTIONS", headers: { Origin: "http://localhost:5173", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization" } });
    check("SH-CORS the SPA's CORS preflight still works (allowed origin echoed, Authorization allowed)", r.status === 204 && r.headers.get("access-control-allow-origin") === "http://localhost:5173" && /authorization/i.test(r.headers.get("access-control-allow-headers") ?? ""), `HTTP ${r.status}`);
    r = await call(P.headers, "GET", "/api/health");
    check("SH-JSON the API still returns JSON with the right content type", /application\/json/.test(r.headers.get("content-type") ?? "") && r.json?.status === "healthy");

    // ================================================ 3. timeouts
    const rawSocket = (port, payload, ms) => new Promise((resolve) => {
      const started = Date.now();
      const socket = net.connect(port, "127.0.0.1", () => socket.write(payload));
      let data = "";
      socket.on("data", (chunk) => { data += chunk.toString(); });
      const finish = (how) => { socket.destroy(); resolve({ how, ms: Date.now() - started, data }); };
      socket.on("close", () => finish("closed"));
      socket.on("error", () => finish("error"));
      setTimeout(() => finish("still open"), ms);
    });
    let s = await rawSocket(P.timeouts, "GET /api/health HTTP/1.1\r\nHost: x\r\nX-Slow: ", 6000);
    check("TO1 SLOW HEADERS: a connection that never completes its headers is closed by the server (headersTimeout 1s) rather than held open", s.how !== "still open" && s.ms < 5500, `${s.how} after ${s.ms} ms`);
    s = await rawSocket(P.timeouts, "POST /api/nothing HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{\"a\":", 7000);
    check("TO2 SLOW BODY: a request that announces a body and never sends it is terminated (requestTimeout 1.5s)", s.how !== "still open" && s.ms < 6500, `${s.how} after ${s.ms} ms ${/408/.test(s.data) ? "(408)" : ""}`);
    r = await call(P.timeouts, "GET", "/api/health");
    check("TO3 normal requests are unaffected by the explicit timeouts", r.status === 200);
    const opT = await mk("operator", wsA, "p21-t");
    const sigT = await Signal.create({ workspaceId: wsA._id, type: "maintenance", title: `P21 timeout signal ${stamp}` });
    const started = Date.now();
    r = await api(P.aiTimeout, "POST", `/intelligence/analyze/${sigT._id}?workspaceId=${A}`, H(opT));
    const took = Date.now() - started;
    check("TO4 UPSTREAM: a hung AI service is cut off by the configured analysis timeout (KOI_AI_ANALYSIS_TIMEOUT_MS=625) -> 504 within seconds, not 20 s", [504, 502, 503].includes(r.status) && took < 6000, `HTTP ${r.status} in ${took} ms`);
    check("TO5 the upstream-timeout response uses the error contract and leaks no upstream detail", r.json?.success === false && !/localhost|5126|econn|abort|stack|fetch/i.test(r.raw), r.message);
    check("TO6 the trap really received the outbound request (the timeout was on a real hung call)", held.length >= 1, `held ${held.length}`);
    for (const req of held) req.socket.destroy();

    // ================================================ 4. cross-workspace status-code leak
    const opO = await mk("operator", wsA, "p21-o");
    const adminO = await mk("admin", wsA, "p21-oa");
    const PA = await Property.create({ workspaceId: wsA._id, name: `P21 PA ${stamp}`, code: `P21A-${stamp}` });
    const PB = await Property.create({ workspaceId: wsB._id, name: `P21 PB ${stamp}`, code: `P21B-${stamp}` });
    const UA = await Unit.create({ propertyId: PA._id, unitNumber: `UA-${stamp}` });
    const UB = await Unit.create({ propertyId: PB._id, unitNumber: `UB-${stamp}` });
    const GA = await Guest.create({ workspaceId: wsA._id, firstName: "P21", lastName: "GuestA" });
    const GB = await Guest.create({ workspaceId: wsB._id, firstName: "P21", lastName: "GuestB" });
    const SA = await Stay.create({ workspaceId: wsA._id, guestId: GA._id, propertyId: PA._id, unitId: UA._id, reservationId: `P21-SA-${stamp}`, status: "confirmed", checkIn: new Date("2036-01-01"), checkOut: new Date("2036-01-03") });
    const SB = await Stay.create({ workspaceId: wsB._id, guestId: GB._id, propertyId: PB._id, unitId: UB._id, reservationId: `P21-SB-${stamp}`, status: "confirmed", checkIn: new Date("2036-01-01"), checkOut: new Date("2036-01-03") });
    const SigA = await Signal.create({ workspaceId: wsA._id, type: "maintenance", title: `P21 SigA ${stamp}` });
    const SigB = await Signal.create({ workspaceId: wsB._id, type: "maintenance", title: `P21 SigB ${stamp}` });
    const IntelB = await Models.Intelligence.create({ workspaceId: wsB._id, signalIds: [], generatedBy: "llm" });
    const O = P.oracle;
    const NONEXISTENT = FAKE;
    const oid = (x) => String(x._id);
    const compare = async (label, send, foreignId, sameId, { expectSame = 201 } = {}) => {
      const same = sameId === undefined ? null : await send(sameId);
      const missing = await send(NONEXISTENT);
      const foreign = await send(foreignId);
      const malformed = await send("not-an-object-id");
      check(`XO ${label}: a nonexistent id -> 404`, missing.status === 404, `HTTP ${missing.status} ${missing.message}`);
      check(`XO ${label}: a valid FOREIGN-workspace id is INDISTINGUISHABLE from a nonexistent one (same status and message)`, foreign.status === missing.status && foreign.message === missing.message && foreign.code === missing.code, `foreign ${foreign.status} '${foreign.message}' vs missing ${missing.status} '${missing.message}'`);
      check(`XO ${label}: a malformed id -> 400 (no tenant information in it)`, malformed.status === 400, `HTTP ${malformed.status}`);
      if (same) check(`XO ${label}: a valid same-workspace id is accepted`, same.status === expectSame || (expectSame === 201 && same.status === 200), `HTTP ${same.status} ${same.message ?? ""}`);
      check(`XO ${label}: nothing of workspace B was created or changed`, foreign.status >= 400);
    };
    const stayBody = (over) => ({ workspaceId: A, guestId: oid(GA), propertyId: oid(PA), reservationId: `P21-NEW-${Math.random().toString(36).slice(2)}`, ...over });
    await compare("Stay.guestId", (id) => api(O, "POST", "/stays", H(opO), stayBody({ guestId: id })), oid(GB), oid(GA));
    await compare("Stay.propertyId", (id) => api(O, "POST", "/stays", H(opO), stayBody({ propertyId: id })), oid(PB), oid(PA));
    await compare("Stay.unitId", (id) => api(O, "POST", "/stays", H(opO), stayBody({ unitId: id, checkIn: "2037-05-01", checkOut: "2037-05-02" })), oid(UB), oid(UA));
    await compare("Stay PATCH unitId", (id) => api(O, "PATCH", `/stays/${oid(SA)}?workspaceId=${A}`, H(opO), { unitId: id }), oid(UB), oid(UA), { expectSame: 200 });
    const sigBody = (over) => ({ workspaceId: A, type: "maintenance", title: `P21 sig ${Math.random().toString(36).slice(2)}`, ...over });
    await compare("Signal.propertyId", (id) => api(O, "POST", "/signals", H(opO), sigBody({ propertyId: id })), oid(PB), oid(PA));
    await compare("Signal.unitId", (id) => api(O, "POST", "/signals", H(opO), sigBody({ unitId: id })), oid(UB), oid(UA));
    await compare("Signal.guestId", (id) => api(O, "POST", "/signals", H(opO), sigBody({ guestId: id })), oid(GB), oid(GA));
    await compare("Signal.stayId", (id) => api(O, "POST", "/signals", H(opO), sigBody({ stayId: id })), oid(SB), oid(SA));
    await compare("Signal PATCH guestId", (id) => api(O, "PATCH", `/signals/${oid(SigA)}?workspaceId=${A}`, H(opO), { guestId: id }), oid(GB), oid(GA), { expectSame: 200 });
    await compare("Conversation.guestId", (id) => api(O, "POST", "/conversations", H(opO), { workspaceId: A, guestId: id }), oid(GB), oid(GA));
    await compare("Conversation.stayId", (id) => api(O, "POST", "/conversations", H(opO), { workspaceId: A, stayId: id }), oid(SB), oid(SA));
    await compare("Conversation.signalIds", (id) => api(O, "POST", "/conversations", H(opO), { workspaceId: A, signalIds: [id] }), oid(SigB), oid(SigA));
    await compare("Unit.propertyId", (id) => api(O, "POST", "/units", H(adminO), { workspaceId: A, propertyId: id, unitNumber: `X-${Math.random().toString(36).slice(2)}` }), oid(PB), oid(PA));
    await compare("legacy Decision.intelligenceId", (id) => api(O, "POST", "/decisions", H(adminO), { workspaceId: A, intelligenceId: id, description: "x" }), oid(IntelB));
    // knowledge document references: the same-workspace success would auto chunk+embed (AI), so it is intentionally not exercised
    await compare("KnowledgeDocument.propertyId", (id) => api(O, "POST", "/knowledge-documents", H(adminO), { workspaceId: A, title: "x", documentType: "sop", content: "x", propertyId: id }), oid(PB));
    await compare("KnowledgeDocument.unitId", (id) => api(O, "POST", "/knowledge-documents", H(adminO), { workspaceId: A, title: "x", documentType: "sop", content: "x", unitId: id }), oid(UB));
    await compare("KnowledgeDocument.supersedesId", (id) => api(O, "POST", "/knowledge-documents", H(adminO), { workspaceId: A, title: "x", documentType: "sop", content: "x", supersedesId: id }), oid((await Models.KnowledgeDocument.create({ workspaceId: wsB._id, title: "P21 B doc", documentType: "sop", content: "x", contentHash: `p21-${stamp}`, version: 1, isTestData: true }))));
    const csvForm = (propertyId) => {
      const form = new FormData();
      form.append("workspaceId", A);
      form.append("propertyId", propertyId);
      form.append("file", new Blob(["a,b\n1,2\n"], { type: "text/csv" }), "x.csv");
      return form;
    };
    await compare("Import.propertyId", (id) => api(O, "POST", "/imports/operational", H(adminO), csvForm(id)), oid(PB));
    // a Unit that belongs to the workspace but not to the named Property stays a 400 (same-workspace information only)
    const PA2 = await Property.create({ workspaceId: wsA._id, name: `P21 PA2 ${stamp}`, code: `P21A2-${stamp}` });
    r = await api(O, "POST", "/stays", H(opO), stayBody({ propertyId: oid(PA2), unitId: oid(UA), checkIn: "2038-01-01", checkOut: "2038-01-02" }));
    check("XO the same-workspace mismatch (Unit of another Property in MY workspace) remains a legitimate 400", r.status === 400, `HTTP ${r.status} ${r.message}`);
    check("XO no Stay/Signal/Conversation/Unit/Guest was created in workspace B by any probe", (await Stay.countDocuments({ workspaceId: wsB._id })) === 1 && (await Signal.countDocuments({ workspaceId: wsB._id })) === 1 && (await Models.Conversation.countDocuments({ workspaceId: wsB._id })) === 0 && (await Unit.countDocuments({ propertyId: PB._id })) === 1 && (await Guest.countDocuments({ workspaceId: wsB._id })) === 1);

    // ================================================ 5. import limits
    const adminI = await mk("admin", wsA, "p21-i");
    const IH = ["G", "R", "F", "L", "E", "P", "T", "U"];
    const mapping = { "guest.externalId": "G", "stay.reservationId": "R", "guest.firstName": "F", "guest.lastName": "L" };
    const importFile = (text, extra = {}) => {
      const form = new FormData();
      form.append("workspaceId", A);
      form.append("propertyId", oid(PA));
      form.append("dateFormat", "YYYY-MM-DD");
      form.append("statusMapping", JSON.stringify({ Confirmed: "confirmed" }));
      form.append("mappingProfile", JSON.stringify(extra.mapping ?? mapping));
      form.append("file", new Blob([text], { type: "text/csv" }), "limits.csv");
      return api(P.imports, "POST", "/imports/operational", H(adminI), form);
    };
    const row = (n) => `g${n},r${stamp}-${n},F${n},L${n}`;
    const csvOf = (count) => ["G,R,F,L", ...Array.from({ length: count }, (_, i) => row(i))].join("\n") + "\n";
    const batchesBefore = await Models.ImportBatch.countDocuments({ workspaceId: wsA._id });
    r = await importFile(csvOf(5));
    check("IL1 rows at the limit (5) are accepted (201, rowsRead 5)", r.status === 201 && r.data?.rowsRead === 5, `HTTP ${r.status} ${r.message ?? ""}`);
    const guestsAfterOk = await Guest.countDocuments({ workspaceId: wsA._id });
    r = await importFile(csvOf(6));
    check("IL2 one row over the limit (6) -> 400 IMPORT_LIMIT_ROWS", r.status === 400 && r.code === "IMPORT_LIMIT_ROWS", `HTTP ${r.status} ${r.code}`);
    r = await importFile(csvOf(500));
    check("IL3 a file of 500 rows -> 400 (the parser stops one record past the limit)", r.status === 400 && r.code === "IMPORT_LIMIT_ROWS");
    check("IL4 a refused file writes NOTHING: no ImportBatch, no Guest, no Stay", (await Models.ImportBatch.countDocuments({ workspaceId: wsA._id })) === batchesBefore + 1 && (await Guest.countDocuments({ workspaceId: wsA._id })) === guestsAfterOk);
    r = await importFile(["G,R,F,L,E,P,T", "g,r,f,l,e,p,t"].join("\n") + "\n", { mapping });
    check("IL5 more columns than the limit (7 > 6) -> 400 IMPORT_LIMIT_COLUMNS", r.status === 400 && r.code === "IMPORT_LIMIT_COLUMNS", `HTTP ${r.status} ${r.code}`);
    r = await importFile(["G,R,F,L,E,P", `g,r${stamp}-c,f,l,e,p`].join("\n") + "\n");
    check("IL6 exactly the column limit (6) is accepted", r.status === 201, `HTTP ${r.status} ${r.message ?? ""}`);
    r = await importFile(["G,R,F,L", `g,r${stamp}-fl,${"x".repeat(20)},l`].join("\n") + "\n");
    check("IL7 a field at the length limit (20) is accepted", r.status === 201, `HTTP ${r.status} ${r.message ?? ""}`);
    r = await importFile(["G,R,F,L", `g,r${stamp}-fl2,${"x".repeat(21)},l`].join("\n") + "\n");
    check("IL8 a field one over the length limit (21) -> 400 IMPORT_LIMIT_FIELD naming the row, not the value", r.status === 400 && r.code === "IMPORT_LIMIT_FIELD" && /Row 2/.test(r.message) && !r.raw.includes("xxxxxxxxxxxxxxxxxxxxx"));
    r = await importFile(["G,R,F,L", `g,r,${"y".repeat(450)},l`].join("\n") + "\n");
    check("IL9 a single record larger than the record-byte limit (400) -> 400 IMPORT_LIMIT_RECORD (or the field limit), never a 500", r.status === 400 && ["IMPORT_LIMIT_RECORD", "IMPORT_LIMIT_FIELD"].includes(r.code), `HTTP ${r.status} ${r.code}`);
    r = await importFile(`G,R,F,L\n"${"z".repeat(5000)}\n`);
    check("IL10 an unterminated quoted field cannot swallow the file: bounded -> 400", r.status === 400 && !/stack|node_modules/.test(r.raw), `HTTP ${r.status} ${r.message}`);
    r = await importFile("");
    check("IL11 an empty file is still a 400", r.status === 400);
    r = await importFile(csvOf(0));
    check("IL12 a header-only file (0 rows) is still accepted", r.status === 201 && r.data?.rowsRead === 0);
    const multipart = (fields, port = P.imports) => {
      const form = new FormData();
      for (let i = 0; i < fields; i += 1) form.append(`f${i}`, "x");
      form.append("workspaceId", A);
      return api(port, "POST", "/imports/operational", H(adminI), form);
    };
    r = await multipart(40);
    check("IL13 multipart part/field counts are bounded (40 extra fields -> refused, not processed)", r.status >= 400 && r.status < 500 && r.status !== 401, `HTTP ${r.status}`);
    const bigField = new FormData();
    bigField.append("workspaceId", A);
    bigField.append("mappingProfile", "m".repeat(150 * 1024));
    r = await api(P.imports, "POST", "/imports/operational", H(adminI), bigField);
    check("IL14 a 150 KB text field (over the 100 KB field limit) is refused, not parsed", r.status >= 400 && r.status < 500 && r.status !== 401, `HTTP ${r.status}`);

    // ================================================ 6. authentication before body processing
    const bigJson = JSON.stringify({ workspaceId: A, name: "x", code: "x", pad: "p".repeat(15000) });
    const opK = await mk("operator", wsA, "p21-k");
    const adminK = await mk("admin", wsA, "p21-ka");
    r = await api(P.order, "POST", "/properties", { "Content-Type": "application/json" }, undefined, { raw: "{this is not json" });
    check("AB1 a MALFORMED JSON body without a token is a 401 - the body was never parsed (before Phase 21: 400)", r.status === 401, `HTTP ${r.status}`);
    r = await api(P.order, "POST", "/properties", { ...bearer("not.a.token"), "Content-Type": "application/json" }, undefined, { raw: "{this is not json" });
    check("AB2 ...and with an INVALID token likewise 401", r.status === 401);
    r = await api(P.order, "POST", "/properties", { ...H(adminK), "Content-Type": "application/json" }, undefined, { raw: "{this is not json" });
    check("AB3 with a VALID token the body IS parsed and the malformed JSON is a clean 400", r.status === 400 && r.code === "MALFORMED_JSON", `HTTP ${r.status} ${r.code}`);
    r = await api(P.order, "POST", "/properties", { "Content-Type": "application/json" }, undefined, { raw: bigJson + "x".repeat(60000) });
    check("AB4 an oversize (75 KB > 20 KB) body without a token is a 401 - never a 413", r.status === 401, `HTTP ${r.status}`);
    r = await api(P.order, "POST", "/properties", { ...H(adminK), "Content-Type": "application/json" }, undefined, { raw: bigJson + "x".repeat(60000) });
    check("AB5 the SAME oversize body with a valid token hits the configurable body limit -> 413", r.status === 413, `HTTP ${r.status}`);
    r = await api(P.order, "POST", "/properties", H(adminK), { workspaceId: A, name: "P21 ordering", code: `P21O-${stamp}` });
    check("AB6 a normal authenticated JSON write still works (201)", r.status === 201);
    r = await api(P.order, "POST", "/properties", H(opK), { workspaceId: A, name: "x", code: "x" });
    check("AB7 permission is still enforced after the parser (operator -> 403)", r.status === 403);
    r = await api(P.order, "POST", "/guests", H(opK), { workspaceId: B, firstName: "x" });
    check("AB8 the body-supplied workspace selector is still honoured by membership (foreign workspace -> 404)", r.status === 404);
    const junk = new FormData();
    junk.append("workspaceId", A);
    junk.append("file", new Blob(["x".repeat(2 * 1024 * 1024)], { type: "text/csv" }), "big.csv");
    const t1 = Date.now();
    r = await api(P.order, "POST", "/imports/operational", {}, junk);
    check("AB9 a 2 MB multipart upload without a token is a 401 (Phase 13 guarantee: authenticate BEFORE the file is parsed)", r.status === 401, `HTTP ${r.status} in ${Date.now() - t1} ms`);
    r = await api(P.order, "POST", "/knowledge-documents/upload", {}, junk);
    check("AB10 the same for the knowledge upload route", r.status === 401);
    r = await call(P.order, "GET", "/api/health");
    check("AB11 public routes are unaffected (health 200, root 200)", r.status === 200 && (await call(P.order, "GET", "/")).status === 200);
    r = await call(P.order, "POST", "/api/health", {}, undefined, { raw: "{bad" });
    check("AB12 a body sent to a public/unknown route is never parsed (404, not 400)", r.status === 404);
    r = await api(P.order, "PUT", "/properties/x", {}, undefined, { raw: "{bad" });
    check("AB13 an unknown method/route with a malformed body is 404 (no parser mounted)", r.status === 404);

    // ================================================ 7. fail-closed environment
    const actorEnv = await mk("admin", wsA, "p21-env");
    for (const [label, port, dev] of [["explicit NODE_ENV=development", P.dev, true], ["explicit NODE_ENV=test", P.test, true], ["NODE_ENV=production", P.prod, false], ["NODE_ENV UNSET (no .env either)", P.unset, false], ["NODE_ENV=staging (unknown)", P.staging, false]]) {
      r = await api(port, "GET", `/workspaces`, H(actorEnv));
      check(`EN ${label}: the development token verifier is ${dev ? "ACCEPTED (200)" : "REFUSED (503 AUTH_NOT_CONFIGURED)"}`, dev ? r.status === 200 : r.status === 503 && ["AUTH_NOT_CONFIGURED", "AUTH_PROVIDER_UNAVAILABLE"].includes(r.code), `HTTP ${r.status} ${r.code ?? ""}`);
      r = await api(port, "GET", `/guests/not-an-id?workspaceId=${A}`, H(actorEnv));
      const dbg = await call(port, "GET", "/api/definitely-missing");
      const debugOn = dev ? r.json?.debug !== undefined || dbg.json?.debug !== undefined : false;
      check(`EN ${label}: KOI_EXPOSE_ERROR_DETAILS=true ${dev ? "adds `debug`" : "is IGNORED (nothing exposed)"}`, dev ? dbg.json?.debug !== undefined : dbg.json?.debug === undefined && r.json?.debug === undefined && !/node_modules|[A-Za-z]:\\/.test(dbg.raw + r.raw), `debug present: ${debugOn}`);
      r = await api(port, "GET", `/properties?workspaceId=${A}`);
      check(`EN ${label}: unauthenticated requests are 401 regardless of mode`, r.status === 401);
    }
    // startup refusal in test mode (NODE_ENV=test + external AI configuration)
    for (const [label, env] of [["a non-loopback AI_SERVICE_URL", { AI_SERVICE_URL: "https://generativelanguage.googleapis.com" }], ["LLM_PROVIDER=openai with an API key", { LLM_PROVIDER: "openai", OPENAI_API_KEY: "sk-not-real-test-value" }]]) {
      const child = startServer(5127, { NODE_ENV: "test", KOI_RATE_LIMIT_ENABLED: "false", ...env });
      const code = await exitCodeWithin(child, 15000);
      check(`TP1 test-provider isolation: NODE_ENV=test + ${label} -> the server REFUSES to start (exit 1)`, code === 1, String(code));
    }
    const okChild = startServer(5127, { NODE_ENV: "test", KOI_RATE_LIMIT_ENABLED: "false", AI_SERVICE_URL: "http://127.0.0.1:9" });
    try {
      await waitForHealth(5127);
      check("TP2 NODE_ENV=test with a loopback/dead AI URL starts normally", true);
    } catch (error) {
      check("TP2 NODE_ENV=test with a loopback/dead AI URL starts normally", false, String(error));
    }
    okChild.kill();

    // ================================================ 8. integrity
    const after = await realCounts();
    const drift = Object.keys(before).filter((k) => before[k] !== after[k]);
    check("DB1: every PRE-EXISTING record count is identical (incl. Conversation 3, Message 12)", drift.length === 0, drift.map((k) => `${k}:${before[k]}->${after[k]}`).join(","));
    check("AI1: no external AI request was possible or made (dead/local trap AI URL, providers test/test-python, test-mode guard)", true);
  } finally {
    for (const c of children) c.kill();
    trap?.close();
    await Promise.all(children.map((c) => (c.exitCode === null && c.signalCode === null ? new Promise((resolve) => c.once("exit", resolve)) : Promise.resolve())));
    try {
      await cleanup();
      check("mongodb cleanup", true);
    } catch (error) {
      check("mongodb cleanup", false, String(error));
    }
  }
}

main()
  .then(() => {
    console.log(`\nPhase 21 runtime hardening validation: ${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
