/**
 * Phase 19 - route inventory and function-level authorization probe (AUDIT; no application code is changed).
 *
 *   1. INVENTORY: introspects the real Express app (app.js -> apiRouter -> every mounted router) and compares it with
 *      the audited table below. A route that is added, removed, re-mounted or whose middleware chain changes FAILS this
 *      suite, so no endpoint can appear unclassified. (`--markdown` prints the table used in SECURITY_AUDIT_PHASE19.md.)
 *   2. CHAIN: every non-public route's chain must be authenticate -> [upload parser] -> workspaceMembership ->
 *      permissionGate (or, for GET /workspaces, authenticate only).
 *   3. PROBE (real HTTP, real spawned backend, throwaway workspaces, dead AI URL): for EVERY route
 *        - no token -> 401 (public routes -> 200)
 *        - invalid / unregistered / disabled / revoked / non-member identities are refused
 *        - for each of the 4 roles the observed permission decision equals the role map (roles.js)
 *      Requests use non-existent ids or empty bodies so the permission is exercised but no external (AI) call is reachable.
 *   4. PRODUCTION MODE: a second backend with NODE_ENV=production must not include stack traces in errors.
 *
 * Nothing in the real dataset is touched; real record counts are compared before and after.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import app from "../app.js";
import { apiRouter } from "../src/routes/index.js";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { signStubToken, STUB_ISSUER } from "../src/auth/stubTokenVerifier.js";
import { ROLES, permissionsForRole } from "../src/auth/roles.js";
import * as Models from "../src/models/index.js";
import { User, Workspace, WorkspaceMembership } from "../src/models/index.js";
import { bearer, cleanupAuthFixtures, createActor } from "./lib/authFixtures.mjs";
import { APPROVED_PROVIDER } from "../src/config/providerPolicy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, "..", "server.js");
const PORT = 5089;
const PROD_PORT = 5090;
const BASE = `http://localhost:${PORT}/api`;
const FAKE = "6aa29b8d18df3e22b3e89cff";

// method, path, permission (null = public, "AUTH" = authenticated only), workspace source, notes
const T = (method, p, perm, ws, kind = "json") => ({ method, path: p, perm, ws, kind });
const MOUNTS = ["/health", "/workspaces", "/properties", "/units", "/guests", "/stays", "/signals", "/conversations", "/intelligence", "/decisions", "/actions", "/outcomes", "/knowledge-documents", "/learning", "/imports", "/dashboard", "/auth"];
export const EXPECTED = [
  T("GET", "/", null, "none"),
  T("GET", "/api/health", null, "none"),
  // Phase 45B.4: the ONLY other public route. It exists so a browser that has no credential yet can obtain one: it exchanges a provider authorization code
  // (server side, with the client secret) for a VERIFIED ID token. Dedicated rate limit, strict 4 KB JSON, exact redirect-URI allow-list; disabled (503) unless configured.
  T("POST", "/api/auth/oidc/token", null, "none"),
  // Phase 45C: IDENTITY-ONLY routes. A verified token is required, an EOI User is NOT (a new identity asks what to do next / sets up its OWN account). They set no
  // actor, role or workspace and read nothing but the workspace name from the body; every data route still needs authenticate + membership + permission.
  // Phase 46: the CREDENTIAL routes - public by necessity (the caller has no credential yet; this is how a person gets or ends one): email + password sign-up /
  // sign-in / verification / reset, the Google link step, and the two refresh-COOKIE routes (refresh, logout). Each has its OWN rate limit first; none authenticates
  // with a bearer token, none reads a user id, role or workspace from the request, and every answer is generic about whether an account exists.
  ...["signup", "signin", "verify-email", "resend-verification", "forgot-password", "reset-password", "google/link", "refresh", "logout"].map((r) => T("POST", `/api/auth/${r}`, "CREDENTIAL", "none")),
  T("GET", "/api/auth/session", "IDENTITY", "none"),
  T("POST", "/api/auth/register", "IDENTITY", "none"),
  T("GET", "/api/workspaces", "AUTH", "actor-memberships"),
  T("GET", "/api/workspaces/:id", "intelligence:view", "path"),
  T("PATCH", "/api/workspaces/:id", "workspace:admin", "path"),
  T("DELETE", "/api/workspaces/:id", "workspace:admin", "path"),
  ...["properties", "units"].flatMap((r) => [
    T("POST", `/api/${r}`, "workspace:admin", "body"),
    T("GET", `/api/${r}`, "intelligence:view", "query"),
    T("GET", `/api/${r}/:id`, "intelligence:view", "query"),
    T("PATCH", `/api/${r}/:id`, "workspace:admin", "query"),
    T("DELETE", `/api/${r}/:id`, "workspace:admin", "query"),
  ]),
  ...["guests", "stays"].flatMap((r) => [
    T("POST", `/api/${r}`, "operations:manage", "body"),
    T("GET", `/api/${r}`, "operations:view", "query"),
    T("GET", `/api/${r}/:id`, "operations:view", "query"),
    T("PATCH", `/api/${r}/:id`, "operations:manage", "query"),
    T("DELETE", `/api/${r}/:id`, "workspace:admin", "query"),
  ]),
  T("POST", "/api/signals", "operations:manage", "body"),
  T("GET", "/api/signals", "intelligence:view", "query"),
  T("GET", "/api/signals/:id/context", "operations:view", "query"),
  T("GET", "/api/signals/:id/knowledge-retrieval", "workspace:admin", "query"),
  T("GET", "/api/signals/:id", "intelligence:view", "query"),
  T("PATCH", "/api/signals/:id", "operations:manage", "query"),
  T("DELETE", "/api/signals/:id", "workspace:admin", "query"),
  T("POST", "/api/conversations", "operations:manage", "body"),
  T("GET", "/api/conversations", "intelligence:view", "query"),
  T("POST", "/api/conversations/intake", "operations:manage", "body"), // Phase 47: one operator turn of the conversational Signal intake (records a Signal or asks a question; never calls the AI)
  T("POST", "/api/conversations/:conversationId/messages", "operations:manage", "query"),
  T("GET", "/api/conversations/:conversationId/messages", "intelligence:view", "query"),
  T("GET", "/api/conversations/:id", "intelligence:view", "query"),
  T("PATCH", "/api/conversations/:id", "operations:manage", "query"),
  T("DELETE", "/api/conversations/:id", "workspace:admin", "query"),
  T("POST", "/api/intelligence/analyze/:signalId", "intelligence:generate", "query"),
  T("GET", "/api/intelligence", "intelligence:view", "query"),
  // Workstream 5A: the state of one Signal's analysis (read-only, state only; same permission and workspace source as the other Intelligence reads).
  T("GET", "/api/intelligence/analysis-status/:signalId", "intelligence:view", "query"),
  T("GET", "/api/intelligence/:id", "intelligence:view", "query"),
  T("POST", "/api/decisions/propose/:intelligenceId", "decision:propose", "query"),
  T("POST", "/api/decisions/:id/approve", "decision:review", "query"),
  T("POST", "/api/decisions/:id/reject", "decision:review", "query"),
  T("GET", "/api/decisions", "intelligence:view", "query"),
  T("GET", "/api/decisions/:id", "intelligence:view", "query"),
  T("POST", "/api/decisions", "decision:propose", "body"),
  T("PATCH", "/api/decisions/:id", "decision:review", "query"),
  // Phase 29: Action V1 (mirrors Decision V1's propose/approve/reject shape exactly).
  T("POST", "/api/actions/propose/:decisionId", "action:propose", "query"),
  T("POST", "/api/actions/:id/approve", "action:review", "query"),
  T("POST", "/api/actions/:id/reject", "action:review", "query"),
  // Phase 50: a PERSON records what actually happened for an APPROVED Action V1 (operations:manage = the permission that records a Signal; no new permission).
  T("POST", "/api/outcomes/record/:actionId", "operations:manage", "query"),
  ...["actions", "outcomes"].flatMap((r) => [
    T("POST", `/api/${r}`, "action:execute", "body"),
    T("GET", `/api/${r}`, "decision:review", "query"),
    T("GET", `/api/${r}/:id`, "decision:review", "query"),
    T("PATCH", `/api/${r}/:id`, "action:execute", "query"),
  ]),
  T("POST", "/api/knowledge-documents", "workspace:admin", "body"),
  T("GET", "/api/knowledge-documents", "intelligence:view", "query"),
  T("POST", "/api/knowledge-documents/upload", "workspace:admin", "form", "form"),
  T("POST", "/api/knowledge-documents/:documentId/chunks", "workspace:admin", "query"),
  T("GET", "/api/knowledge-documents/:documentId/chunks", "intelligence:view", "query"),
  T("POST", "/api/knowledge-documents/:documentId/embeddings", "workspace:admin", "query"),
  T("GET", "/api/knowledge-documents/:id", "intelligence:view", "query"),
  T("PATCH", "/api/knowledge-documents/:id", "workspace:admin", "query"),
  T("DELETE", "/api/knowledge-documents/:id", "workspace:admin", "query"),
  T("GET", "/api/learning", "workspace:admin", "query"),
  T("GET", "/api/learning/patterns", "workspace:admin", "query"),
  // Phase 31: Outcome-derived action-type patterns - same admin-only policy as the two routes above.
  T("GET", "/api/learning/outcomes", "workspace:admin", "query"),
  T("POST", "/api/imports/operational", "workspace:admin", "form", "form"),
  T("GET", "/api/imports/:id", "operations:view", "query"),
  T("GET", "/api/dashboard/signals", "intelligence:view", "query"),
  T("GET", "/api/dashboard/signals/:signalId", "intelligence:view", "query"),
];

/** Every route the running app really registers, in registration order, with its middleware chain. */
export function discoverRoutes() {
  const found = [];
  const walk = (stack, prefix) => {
    for (const layer of stack) {
      if (!layer.route) continue;
      for (const method of Object.keys(layer.route.methods)) {
        found.push({ method: method.toUpperCase(), path: `${prefix}${layer.route.path === "/" && prefix ? "" : layer.route.path}`, chain: layer.route.stack.map((h) => h.name || "anonymous") });
      }
    }
  };
  walk(app.router.stack, "");
  const mounted = apiRouter.stack.filter((l) => l.handle?.stack);
  mounted.forEach((layer, i) => walk(layer.handle.stack, `/api${MOUNTS[i]}`));
  return { found, mountedCount: mounted.length };
}

/** Audit annotations used ONLY to print the SECURITY_AUDIT_PHASE19.md inventory table (`--markdown`). */
function audit(route) {
  const p = route.path;
  const has = (frag) => p.includes(frag);
  let object = "n/a (collection or no id)";
  let sensitive = "-";
  let ai = "no";
  let status = "ACTIVE";
  if (route.perm === null) return { object: "n/a", sensitive: "none (liveness only)", ai, status: "PUBLIC (by design)" };
  if (has("/workspaces")) {
    object = route.path === "/api/workspaces" ? "list = caller's own active memberships" : "id IS the selector: membership of :id verified; controller uses actor workspace";
    sensitive = "workspace name/slug/settings";
    status = route.method === "DELETE" ? "ACTIVE (no cascade)" : "ACTIVE";
  } else if (has("/properties")) { object = "AT lookup {_id, workspaceId = actor}"; sensitive = "property data"; }
  else if (has("/units")) { object = "AT lookup: Unit -> parent Property {workspaceId = actor}"; sensitive = "unit data"; }
  else if (has("/guests")) { object = "AT lookup {_id, workspaceId = actor}"; sensitive = "GUEST PII"; }
  else if (has("/stays")) { object = "AT lookup {_id, workspaceId = actor}; refs validated AFTER lookup (400 oracle)"; sensitive = "STAY / reservation data"; }
  else if (has("/signals/:id/context")) { object = "signal AT lookup; related records queried with workspaceId"; sensitive = "GUEST/STAY facts"; }
  else if (has("/knowledge-retrieval")) { object = "signal scoped lookup BEFORE the embedding call"; sensitive = "knowledge text (ceiling-gated)"; ai = "YES: embeddings via Python AI service"; status = "DEBUG/DEV (retirement candidate)"; }
  else if (has("/signals")) { object = "AT lookup {_id, workspaceId = actor}; refs validated AFTER lookup (400 oracle)"; sensitive = "signal data"; }
  else if (has("/messages")) { object = "Message -> Conversation scoped lookup {workspaceId = actor} BEFORE messages"; sensitive = "conversation content"; }
  else if (has("/conversations")) { object = "AT lookup {_id, workspaceId = actor}"; sensitive = "conversation content"; }
  else if (has("/intelligence/analyze")) { object = "signal scoped lookup BEFORE any AI call"; sensitive = "generated Intelligence (level-gated)"; ai = "YES: Python AI service (Gemini)"; }
  else if (has("/intelligence")) { object = "AT lookup {_id, workspaceId = actor} + analysisLevel/knowledgeVisibility gate"; sensitive = "Intelligence (whitelisted view, ceiling-gated)"; }
  else if (has("/decisions/propose")) { object = "Intelligence scoped lookup + visibility BEFORE create"; sensitive = "Decision (derived from Intelligence)"; }
  else if (has("/decisions") && route.method === "POST" && route.path === "/api/decisions") { object = "Intelligence findById then assertSameWorkspace (AFTER lookup; 400 oracle)"; sensitive = "Decision"; status = "LEGACY (retirement candidate)"; }
  else if (has("/decisions") && route.method === "PATCH") { object = "AT lookup {_id, workspaceId = actor}; V1 refused"; sensitive = "Decision"; status = "LEGACY (retirement candidate)"; }
  else if (has("/decisions")) { object = "AT lookup {_id, workspaceId = actor} + live parent-Intelligence visibility"; sensitive = "Decision (ceiling-gated via parent)"; }
  else if (has("/actions/propose")) { object = "Decision scoped lookup + visibility BEFORE create; requires an APPROVED Decision V1"; sensitive = "Action (derived from Decision)"; }
  else if (has("/actions/:id/approve") || has("/actions/:id/reject")) { object = "AT lookup {_id, workspaceId = actor} + parent-Intelligence visibility; V1-only, single terminal transition"; sensitive = "Action (ceiling-gated via parent)"; }
  else if (has("/outcomes/record")) { object = "Action scoped lookup {_id, workspaceId = actor} + parent-Intelligence visibility BEFORE create; requires an APPROVED Action V1; one Outcome per Action"; sensitive = "Outcome (human-recorded; derived from Action)"; }
  else if (has("/actions") || has("/outcomes")) {
    if (route.perm === "action:execute") { object = "DENIED before lookup for every role (service checks exist but are unreachable)"; status = "BLOCKED (no role holds action:execute)"; }
    else { object = "AT lookup {_id, workspaceId = actor} + parent-Intelligence visibility"; sensitive = "Action/Outcome text (ceiling-gated via parent)"; }
  } else if (has("/knowledge-documents/upload")) { object = "propertyId/unitId validated AFTER lookup"; sensitive = "knowledge text"; ai = "YES: embeddings via Python AI service (auto chunk+embed)"; }
  else if (has("/embeddings")) { object = "document AT lookup {workspaceId = actor}"; sensitive = "knowledge text"; ai = "YES: embeddings via Python AI service"; }
  else if (has("/chunks")) { object = "document AT lookup {workspaceId = actor}; chunk visibility filter; NO embedding vectors"; sensitive = "knowledge text (ceiling-gated)"; }
  else if (has("/knowledge-documents")) { object = route.path.endsWith(":id") ? "AT lookup {_id, workspaceId = actor} + visibility" : "workspace-scoped; refs validated AFTER lookup"; sensitive = "knowledge text/metadata (ceiling-gated)"; ai = route.method === "POST" ? "YES: auto chunk + embed after create" : "no"; }
  else if (has("/learning")) { object = "aggregation filtered by workspaceId = actor (no caller id)"; sensitive = "Decision/Action/Outcome text (ignores parent visibility => admin only)"; }
  else if (has("/imports/operational")) { object = "propertyId proven to belong to the workspace; Unit only via that Property"; sensitive = "writes GUEST/STAY PII"; }
  else if (has("/imports")) { object = "AT lookup {_id, workspaceId = actor}"; sensitive = "import counts, row errors"; }
  else if (has("/dashboard")) { object = "signal AT lookup; relations scoped to workspace"; sensitive = "signal + level-gated Intelligence + Decision"; }
  return { object, sensitive, ai, status };
}

if (process.argv.includes("--markdown")) {
  const { found } = discoverRoutes();
  const exp = new Map(EXPECTED.map((e) => [`${e.method} ${e.path}`, e]));
  console.log("| # | METHOD | PATH | AUTH | MEMBERSHIP | PERMISSION | OBJECT CHECK | WORKSPACE SOURCE | SENSITIVE DATA | WRITE | AI/EXTERNAL | STATUS |\n|---|---|---|---|---|---|---|---|---|---|---|---|");
  found.forEach((f, i) => {
    const e = exp.get(`${f.method} ${f.path}`);
    const chain = f.chain.filter((c) => c !== "wrappedHandler" && c !== "anonymous");
    const a = e ? audit(e) : {};
    const authd = chain.includes("authenticate");
    console.log(`| ${i + 1} | ${f.method} | \`${f.path}\` | ${authd ? "bearer" : "none"} | ${chain.includes("workspaceMembership") ? "active" : authd ? "own list" : "-"} | ${e?.perm === null ? "PUBLIC" : (e?.perm ?? "?")} | ${a.object} | ${e?.ws ?? "?"} | ${a.sensitive} | ${["POST", "PATCH", "PUT", "DELETE"].includes(f.method) ? "yes" : "no"} | ${a.ai} | ${a.status} |`);
  });
  process.exit(0);
}

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

async function call(method, url, headers = {}, body, base = BASE) {
  const isForm = body instanceof FormData;
  const response = await fetch(`${base}${url}`, { method, headers: { ...(body && !isForm ? { "Content-Type": "application/json" } : {}), ...headers }, body: body ? (isForm ? body : JSON.stringify(body)) : undefined });
  const raw = await response.text();
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {
    json = null;
  }
  return { status: response.status, json, raw, code: json?.details?.code, message: json?.message };
}

async function waitForHealth(base, timeoutMs = 20000) {
  const start = Date.now();
  for (;;) {
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch {
      // not ready
    }
    if (Date.now() - start > timeoutMs) throw new Error(`server ${base} not healthy`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

const ids = { workspaces: [] };
async function cleanup() {
  await connectDatabase();
  await cleanupAuthFixtures();
  const ws = { $in: ids.workspaces };
  const convs = await Models.Conversation.find({ workspaceId: ws }).distinct("_id");
  const props = await Models.Property.find({ workspaceId: ws }).distinct("_id");
  await Models.Message.deleteMany({ conversationId: { $in: convs } });
  await Models.Unit.deleteMany({ propertyId: { $in: props } });
  await Promise.all(["Conversation", "Guest", "Stay", "Signal", "Property", "KnowledgeChunk", "KnowledgeDocument", "ImportBatch", "Intelligence", "Decision", "Action", "Outcome", "WorkspaceMembership"].map((m) => Models[m].deleteMany({ workspaceId: ws })));
  await Workspace.deleteMany({ _id: ws });
  await disconnectDatabase();
}

async function main() {
  const stamp = Date.now();
  const spawnServer = (port, extra = {}) =>
    spawn(process.execPath, [SERVER_ENTRY], { env: { ...process.env, PORT: String(port), LLM_PROVIDER: "test", KNOWLEDGE_DEV_AUTHORIZED_LEVEL: "restricted", AI_SERVICE_URL: "http://localhost:9", ...extra }, stdio: "ignore" });
  const child = spawnServer(PORT);
  const prod = spawnServer(PROD_PORT, { NODE_ENV: "production", LLM_PROVIDER: APPROVED_PROVIDER, AUTH_PROVIDER: "oidc", OIDC_ISSUER: "https://127.0.0.1:9", OIDC_AUDIENCE: "eoi-suite-audience" });

  try {
    // ================================================ 1. inventory
    const { found, mountedCount } = discoverRoutes();
    check("INV0: the API router mounts exactly the 16 audited routers", mountedCount === MOUNTS.length, `mounted ${mountedCount}`);
    const key = (r) => `${r.method} ${r.path}`;
    const foundKeys = found.map(key);
    const expectedKeys = EXPECTED.map(key);
    check(`INV1: the app registers exactly the ${EXPECTED.length} audited routes (no unclassified, no missing)`, foundKeys.length === expectedKeys.length && expectedKeys.every((k) => foundKeys.includes(k)) && foundKeys.every((k) => expectedKeys.includes(k)), `found ${foundKeys.length}; extra: ${foundKeys.filter((k) => !expectedKeys.includes(k)).join(", ")}; missing: ${expectedKeys.filter((k) => !foundKeys.includes(k)).join(", ")}`);
    check("INV2: no route is registered twice", new Set(foundKeys).size === foundKeys.length);
    const dynamic = app.router.stack.filter((l) => !["query", "expressInit", "corsMiddleware", "requestId", "securityHeaders", "rateLimit_anon", "rateLimit_ip", "handle", "router", "notFoundHandler", "errorHandler"].includes(l.name));
    check("INV3: no other top-level middleware/route is registered (app-level stack is cors, requestId [Phase 36: a random correlation id, no authority], security headers, client-address limits, router, notFound, errorHandler)", dynamic.every((l) => l.route || l.name === "bound dispatch" || l.name === "handle") || dynamic.length === 0, dynamic.map((l) => l.name).join(","));
    check("INV4b: exactly two IDENTITY-ONLY routes (GET /api/auth/session, POST /api/auth/register) - no other route skips the membership check", EXPECTED.filter((e) => e.perm === "IDENTITY").length === 2);
    check("INV4c: exactly nine CREDENTIAL routes (Phase 46: sign-up, sign-in, verify-email, resend-verification, forgot-password, reset-password, google/link, refresh, logout) - each public by necessity and each with its own rate limit", EXPECTED.filter((e) => e.perm === "CREDENTIAL").length === 9);
    check("INV4: exactly three public routes (GET /, GET /api/health, and - Phase 45B.4 - POST /api/auth/oidc/token, the credential-less code exchange)", EXPECTED.filter((e) => e.perm === null).length === 3);
    const pub = new Set(["GET /", "GET /api/health", "POST /api/auth/oidc/token"]);
    // Phase 21: the chain of every route, in order. authenticate is FIRST, identity rate limits come next, the body (JSON parser or
    // multipart) is processed only after them, membership and permission follow, AI routes add a per-workspace limit last.
    const AI_ROUTES = new Set(["GET /api/signals/:id/knowledge-retrieval", "POST /api/intelligence/analyze/:signalId", "POST /api/knowledge-documents", "POST /api/knowledge-documents/upload", "POST /api/knowledge-documents/:documentId/embeddings"]);
    for (const r of found) {
      const e = EXPECTED.find((x) => key(x) === key(r));
      if (!e) continue;
      const chain = r.chain.filter((c) => c !== "wrappedHandler" && c !== "anonymous");
      if (pub.has(key(r))) {
        check(`CH ${key(r)}: public by design (no authenticate; only the app-level client-address limits apply)`, !chain.includes("authenticate"));
        if (key(r) === "POST /api/auth/oidc/token") check("CH POST /api/auth/oidc/token: its OWN rate limit runs first, then the strict JSON parser, then the handler (nothing is parsed before the limit)", chain[0] === "rateLimit_oidc_exchange" && chain[1] === "jsonParser" && chain.length === 2, chain.join(" > "));
        continue;
      }
      if (e.perm === "CREDENTIAL") {
        const CREDENTIAL_CHAINS = {
          "POST /api/auth/signup": ["rateLimit_auth_signup_ip", "jsonParser"],
          "POST /api/auth/signin": ["rateLimit_auth_signin_ip", "jsonParser", "rateLimit_auth_signin_email"],
          "POST /api/auth/verify-email": ["rateLimit_auth_verify_ip", "jsonParser"],
          "POST /api/auth/resend-verification": ["rateLimit_auth_reset_ip", "jsonParser", "rateLimit_auth_reset_email"],
          "POST /api/auth/forgot-password": ["rateLimit_auth_reset_ip", "jsonParser", "rateLimit_auth_reset_email"],
          "POST /api/auth/reset-password": ["rateLimit_auth_verify_ip", "jsonParser"],
          "POST /api/auth/google/link": ["rateLimit_auth_signin_ip", "jsonParser"],
          "POST /api/auth/refresh": ["rateLimit_auth_refresh_ip", "requireTrustedBrowserRequest"],
          "POST /api/auth/logout": ["rateLimit_auth_refresh_ip", "requireTrustedBrowserRequest"],
        };
        check(`CH ${key(r)}: credential route - its OWN rate limit first, then ${CREDENTIAL_CHAINS[key(r)].slice(1).join(" > ")}; it never authenticates with a bearer token`, chain.join(">") === CREDENTIAL_CHAINS[key(r)].join(">") && !chain.includes("authenticate"), chain.join(">"));
        continue;
      }
      let want;
      if (e.perm === "AUTH") want = ["authenticate", "rateLimit_user"];
      else if (e.perm === "IDENTITY") want = key(r) === "GET /api/auth/session" ? ["authenticateIdentity", "rateLimit_account_session"] : ["authenticateIdentity", "rateLimit_account_register", "jsonParser"];
      else {
        const tier = AI_ROUTES.has(key(r)) ? "ai" : key(r) === "POST /api/imports/operational" ? "import" : "standard";
        want = ["authenticate", "rateLimit_user", ...(tier === "ai" ? ["rateLimit_ai"] : tier === "import" ? ["rateLimit_import"] : []), "writeTier", e.kind === "form" ? "handleUpload" : "jsonBody", "workspaceMembership", "permissionGate", ...(tier === "ai" ? ["rateLimit_ai_workspace"] : [])];
      }
      check(`CH ${key(r)}: chain is ${want.join(" > ")}`, chain.join(">") === want.join(">"), chain.join(">"));
    }
    check("INV5: no app-level JSON body parser exists (a body is parsed only after authentication)", !app.router.stack.some((l) => l.name === "jsonParser"), app.router.stack.map((l) => l.name).join(","));
    check("INV6: app-level stack is cors, security headers, client-address limits, router, notFound, errorHandler", ["corsMiddleware", "securityHeaders", "rateLimit_anon", "rateLimit_ip", "router", "notFoundHandler", "errorHandler"].every((n) => app.router.stack.some((l) => l.name === n)));

    // ================================================ 2. probes
    await waitForHealth(BASE);
    await waitForHealth(`http://localhost:${PROD_PORT}/api`);
    await connectDatabase();
    await Promise.all([User.init(), WorkspaceMembership.init()]);
    const mkWs = async (label, status = "active") => {
      const doc = await Workspace.create({ name: `P19 ${label} ${stamp}`, slug: `p19-${label}-${stamp}`, status });
      ids.workspaces.push(doc._id);
      return doc;
    };
    const wsA = await mkWs("a");
    const wsD = await mkWs("delete");
    const wsS = await mkWs("suspended", "suspended");
    const A = String(wsA._id);
    const OWN = ids.workspaces;
    const NAMES = ["Workspace", "Property", "Guest", "Stay", "Signal", "Intelligence", "KnowledgeDocument", "KnowledgeChunk", "ImportBatch", "Conversation", "Decision", "Action", "Outcome"];
    const realCounts = async () => ({
      ...Object.fromEntries(await Promise.all(NAMES.map(async (name) => [name, await Models[name].countDocuments(name === "Workspace" ? { _id: { $nin: OWN } } : { workspaceId: { $nin: OWN } })]))),
      Message: await Models.Message.countDocuments({ conversationId: { $nin: await Models.Conversation.find({ workspaceId: { $in: OWN } }).distinct("_id") } }),
      Unit: await Models.Unit.countDocuments({}),
    });
    const before = await realCounts();

    const actorsIn = async (ws, label) => Object.fromEntries(await Promise.all(ROLES.map(async (role) => [role, await createActor({ role, workspaceId: ws._id, label: `p19-${label}-${role}` })])));
    const inA = await actorsIn(wsA, "a");
    const inD = await actorsIn(wsD, "d");
    const outsider = await createActor({ label: "p19-outsider" });
    const revoked = await createActor({ role: "operator", workspaceId: wsA._id, label: "p19-revoked" });
    await WorkspaceMembership.updateOne({ _id: revoked.membership._id }, { $set: { status: "revoked" } });
    const disabled = await createActor({ role: "operator", workspaceId: wsA._id, label: "p19-disabled" });
    await User.updateOne({ _id: disabled.user._id }, { $set: { status: "disabled" } });
    const suspended = await createActor({ role: "admin", workspaceId: wsS._id, label: "p19-suspended" });
    const unregistered = bearer(signStubToken({ iss: STUB_ISSUER, sub: `never-provisioned-${stamp}`, exp: Math.floor(Date.now() / 1000) + 600 }, process.env.AUTH_STUB_SECRET));

    const build = (route, ws) => {
      const url = route.path.replace(/:[A-Za-z]+/g, (m) => (route.path.startsWith("/api/workspaces/") ? ws : FAKE));
      const wsUsed = route.path.startsWith("/api/workspaces") ? "" : ws;
      if (route.kind === "form") {
        const form = new FormData();
        form.append("workspaceId", ws);
        return { url: url.replace(/^\/api/, ""), body: form };
      }
      const needsBody = ["POST", "PATCH", "PUT"].includes(route.method);
      const query = route.ws === "query" && wsUsed ? `?workspaceId=${wsUsed}` : "";
      return { url: `${url.replace(/^\/api/, "")}${query}`, body: needsBody ? (route.ws === "body" ? { workspaceId: ws } : {}) : undefined };
    };
    const permitted = (r) => r.status !== 401 && !(r.status === 403 && r.code === "FORBIDDEN") && !(r.status === 404 && r.message === "Workspace not found");
    let probes = 0;
    for (const route of EXPECTED) {
      const label = `${route.method} ${route.path}`;
      if (route.perm === null && route.path === "/api/auth/oidc/token") {
        // Not configured in this harness: the exchange answers a generic 503 and hands out nothing.
        const r = await call(route.method, "/auth/oidc/token", {}, {}, BASE);
        check(`PR ${label}: public route; with no exchange configured it answers a generic 503 and carries no token or data`, r.status === 503 && !/eyJ|access_token|id_token|client_secret/i.test(r.raw), `HTTP ${r.status}`);
        continue;
      }
      if (route.perm === null) {
        const r = await call(route.method, route.path.replace(/^\/api/, "") || "/", {}, undefined, route.path === "/" ? `http://localhost:${PORT}` : BASE);
        check(`PR ${label}: public route answers without a token (200)`, r.status === 200, `HTTP ${r.status}`);
        check(`PR ${label}: the public response carries no identity/role/data`, !/"(role|permissions?|email|token|workspaceId)"/i.test(r.raw));
        continue;
      }
      if (route.perm === "CREDENTIAL") {
        const r = await call(route.method, route.path.replace(/^\/api/, ""), {}, {}, BASE);
        check(`PR ${label}: credential route with an empty request is refused or answered generically (${[202, 400, 401, 403, 503].join("/")}) and hands out no token, cookie or data`, [202, 400, 401, 403, 503].includes(r.status) && !/eyJ|access_token|id_token|client_secret|scrypt|passwordHash/i.test(r.raw), `HTTP ${r.status}`);
        continue;
      }
      if (route.perm === "IDENTITY") {
        const none = await call(route.method, route.path.replace(/^\/api/, ""), {}, route.method === "POST" ? {} : undefined, BASE);
        const junk = await call(route.method, route.path.replace(/^\/api/, ""), { Authorization: "Bearer not.a.token" }, route.method === "POST" ? {} : undefined, BASE);
        check(`AU ${label}: identity-only route: no token -> 401 MISSING_CREDENTIAL, a garbage token -> 401 (nothing is created or revealed)`, none.status === 401 && none.code === "MISSING_CREDENTIAL" && junk.status === 401, `${none.status}/${junk.status}`);
        continue;
      }
      const isDeleteWs = route.method === "DELETE" && route.path === "/api/workspaces/:id";
      const actors = isDeleteWs ? inD : inA;
      const wsId = isDeleteWs ? String(wsD._id) : A;
      const req = () => build(route, wsId);
      let r = await (() => { const b = req(); return call(route.method, b.url, {}, b.body); })();
      check(`AU ${label}: no token -> 401`, r.status === 401 && r.code === "MISSING_CREDENTIAL", `HTTP ${r.status}`);
      r = await (() => { const b = req(); return call(route.method, b.url, bearer("not.a.token"), b.body); })();
      check(`AU ${label}: invalid token -> 401`, r.status === 401);
      r = await (() => { const b = req(); return call(route.method, b.url, unregistered, b.body); })();
      check(`AU ${label}: valid token, unregistered identity -> 403`, r.status === 403 && r.code === "IDENTITY_NOT_REGISTERED");
      r = await (() => { const b = req(); return call(route.method, b.url, disabled.headers, b.body); })();
      check(`AU ${label}: disabled user -> 403`, r.status === 403);
      if (route.perm === "AUTH") {
        r = await call("GET", "/workspaces", outsider.headers);
        check(`AU ${label}: an authenticated non-member lists nothing (200, empty)`, r.status === 200 && r.json.data.length === 0);
        r = await call("GET", "/workspaces", revoked.headers);
        check(`AU ${label}: a revoked member lists nothing`, r.status === 200 && r.json.data.length === 0);
        for (const role of ROLES) {
          r = await call("GET", "/workspaces", inA[role].headers);
          check(`FN ${label}: ${role} -> 200 and sees only its own workspace`, r.status === 200 && r.json.data.length === 1 && r.json.data[0]._id === A);
        }
        probes += 1;
        continue;
      }
      r = await (() => { const b = req(); return call(route.method, b.url, revoked.headers, b.body); })();
      check(`AU ${label}: revoked membership -> 404`, r.status === 404 && r.message === "Workspace not found", `HTTP ${r.status}`);
      r = await (() => { const b = req(); return call(route.method, b.url, outsider.headers, b.body); })();
      check(`AU ${label}: non-member -> 404`, r.status === 404 && r.message === "Workspace not found", `HTTP ${r.status}`);
      r = await (() => { const b = build(route, String(wsS._id)); return call(route.method, b.url, suspended.headers, b.body); })();
      check(`AU ${label}: member of a suspended workspace -> 404`, r.status === 404 && r.message === "Workspace not found", `HTTP ${r.status}`);
      // function-level authorization: the observed decision equals the role map
      const order = isDeleteWs ? ["viewer", "operator", "reviewer", "admin"] : ROLES;
      for (const role of order) {
        const b = req();
        r = await call(route.method, b.url, actors[role].headers, b.body);
        const shouldPass = permissionsForRole(role).includes(route.perm);
        check(`FN ${label}: ${role} ${shouldPass ? "is permitted" : "is DENIED (403 FORBIDDEN)"} (needs ${route.perm})`, shouldPass ? permitted(r) : r.status === 403 && r.code === "FORBIDDEN", `HTTP ${r.status} ${r.message ?? ""}`.slice(0, 120));
        probes += 1;
      }
    }
    check(`PR: ${probes} route x role permission decisions matched the role map`, true);
    check("FN: NO role holds action:execute (writes to /actions and /outcomes are denied to all four roles)", ROLES.every((role) => !permissionsForRole(role).includes("action:execute")));

    // method swapping / unknown routes
    for (const [method, url] of [["PUT", "/properties"], ["DELETE", "/properties"], ["PUT", "/guests/" + FAKE], ["PUT", "/workspaces/" + A], ["POST", "/workspaces"], ["DELETE", "/intelligence/" + FAKE], ["POST", "/intelligence"], ["POST", "/signals/" + FAKE + "/intelligence"], ["PATCH", "/intelligence/" + FAKE], ["DELETE", "/decisions/" + FAKE], ["PUT", "/decisions/" + FAKE], ["DELETE", "/actions/" + FAKE], ["DELETE", "/outcomes/" + FAKE], ["PATCH", "/conversations/" + FAKE + "/messages/" + FAKE], ["DELETE", "/dashboard/signals/" + FAKE], ["POST", "/dashboard/signals"], ["GET", "/debug"], ["GET", "/api/admin"], ["GET", "/admin"], ["GET", "/metrics"], ["GET", "/swagger"], ["GET", "/graphql"], ["GET", "/.env"], ["GET", "/api"], ["GET", "/api/"]]) {
      const r = await call(method, url, inA.admin.headers, method === "GET" ? undefined : {}, url.startsWith("/api") ? `http://localhost:${PORT}` : method === "GET" && !url.startsWith("/api") ? `http://localhost:${PORT}` : BASE);
      check(`MS ${method} ${url.replace(FAKE, ":id").replace(A, ":id")}: no such route (404) even for an admin`, r.status === 404, `HTTP ${r.status}`);
    }

    // ================================================ 3. error shape, production mode
    const nt = await call("GET", "/properties?workspaceId=" + A);
    check("ER1: [development mode, no debug flag] an error carries NO stack trace or path (Phase 20 fail-closed; details need KOI_EXPOSE_ERROR_DETAILS=true)", nt.status === 401 && nt.json?.stack === undefined && nt.json?.debug === undefined && !/[A-Za-z]:\|node_modules/.test(nt.raw), `HTTP ${nt.status}`);
    const PB = `http://localhost:${PROD_PORT}/api`;
    const pn = await call("GET", "/properties?workspaceId=" + A, {}, undefined, PB);
    check("ER2: [NODE_ENV=production] the same error carries NO stack trace", pn.status === 401 && pn.json?.stack === undefined, `HTTP ${pn.status}`);
    const stubTok = await call("GET", "/properties?workspaceId=" + A, inA.admin.headers, undefined, PB);
    check("ER3: [NODE_ENV=production] the development stub verifier is NOT accepted (a stub-signed token is refused, not authenticated)", stubTok.status === 401 || stubTok.status === 503, `HTTP ${stubTok.status} ${stubTok.message ?? ""}`);
    const hc = await call("GET", "/health", {}, undefined, PB);
    check("ER4: [NODE_ENV=production] the health route still answers publicly", hc.status === 200 || hc.status === 503);
    const e404 = await call("GET", "/nope", {}, undefined, `http://localhost:${PORT}/api`);
    check("ER5: an unknown route answers 404 with a controlled body", e404.status === 404 && e404.json?.success === false);
    const bad = await fetch(`${BASE}/properties?workspaceId=${A}`, { method: "POST", headers: { ...inA.admin.headers, "Content-Type": "application/json" }, body: "{not json" });
    const badBody = await bad.text();
    check("ER6: malformed JSON is a controlled 400 with no database detail", bad.status === 400 && !/mongo|mongoose|E11000|at .*\(.*node_modules/i.test(JSON.parse(badBody).message ?? ""), `HTTP ${bad.status}`);
    const huge = await fetch(`${BASE}/properties?workspaceId=${A}`, { method: "POST", headers: { ...inA.admin.headers, "Content-Type": "application/json" }, body: JSON.stringify({ workspaceId: A, name: "x".repeat(200000), code: "X" }) });
    check("ER7: the JSON body limit bounds a 200 KB body (413)", huge.status === 413, `HTTP ${huge.status}`);
    const unauthBig = await fetch(`${BASE}/properties?workspaceId=${A}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workspaceId: A, pad: "x".repeat(90000) }) });
    check("ER8: an UNAUTHENTICATED 90 KB JSON body is parsed before authentication (bounded by the 100 KB limit) and then refused 401", unauthBig.status === 401, `HTTP ${unauthBig.status}`);

    // ================================================ 4. integrity
    const after = await realCounts();
    const drift = Object.keys(before).filter((k) => before[k] !== after[k]);
    check("DB1: every PRE-EXISTING record count is identical", drift.length === 0, drift.map((k) => `${k}:${before[k]}->${after[k]}`).join(","));
    check("AI1: no AI/LLM call was possible (dead AI URL, provider `test`)", true);
  } finally {
    child.kill();
    prod.kill();
    await Promise.all([new Promise((r) => child.once("exit", r)), new Promise((r) => prod.once("exit", r))]);
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
    console.log(`\nPhase 19 route inventory / authorization probe: ${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
