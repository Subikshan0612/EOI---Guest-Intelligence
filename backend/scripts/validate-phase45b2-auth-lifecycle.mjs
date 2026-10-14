/**
 * Phase 45B.2 validation - OIDC session lifecycle + production authentication UX (provider-neutral).
 *
 *   node backend/scripts/validate-phase45b2-auth-lifecycle.mjs
 *
 * WHAT THIS IS NOT: verification of a real identity provider. Every sign-in below runs against a LOCAL, loopback-only test provider
 * (scripts/lib/localOidcProvider.mjs). It proves the provider-neutral code behaves; it proves nothing about any real issuer, client
 * registration, audience, redirect URI, end-session endpoint or refresh behaviour.
 *
 *   A  return-path sanitiser (open-redirect table)
 *   B  the SPA sign-in session against the local provider, with a fake browser window: callback success / failure / no loop / URL cleaning /
 *      deep link / forged callback / sign-out / signed-out reload / not-configured (production) / storage never holds a token
 *   C  the API layer against a REAL backend in OIDC mode on an ISOLATED database (counting proxy): authenticated request, missing / expired /
 *      invalid token, 401 -> "sign in again" with no further network calls, re-auth clears the rejected state, logout stops requests,
 *      403 / 404 / tenant behaviour unchanged, role / workspace / email claims in a token ignored
 *   D  rendered UI (React server render): wording, no codes / state / tokens / issuer / client id / env names, sign-in / sign-out controls
 *   E  production builds: no development token, no secret, "not configured" guard present, sign-in code present only when configured
 *   F  static: storage use, no external redirect target, no development-token wording, backend auth files untouched by this phase
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import dotenv from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(here, "..");
const REPO = path.join(BACKEND, "..");
const FRONTEND = path.join(REPO, "frontend");
const read = (p) => fs.readFileSync(p, "utf8");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, "$1");
let passed = 0; let failed = 0;
const check = (name, ok, detail = "") => { if (ok) { passed += 1; console.log(`PASS  ${name}${detail ? ` - ${detail}` : ""}`); } else { failed += 1; console.error(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`); } };

// ---- isolated database (derived from the loopback URI BEFORE anything reads it; never printed)
{ const __u = dotenv.parse(process.getBuiltinModule("node:fs").readFileSync(new URL("../.env", import.meta.url))).MONGODB_URI ?? ""; if (/^mongodb:\/\/(?:[^@/]*@)?(localhost|127\.0\.0\.1)/i.test(__u)) process.env.MONGODB_URI ??= __u; } // validation / rehearsal tools take ONLY a loopback database URI from backend/.env, never its real settings
const baseUri = process.env.MONGODB_URI;
const stamp = Date.now();
const DB_NAME = `koi_p45b2_${stamp}`;
if (!baseUri || /^mongodb\+srv:|@/.test(baseUri) || !/^mongodb:\/\/(localhost|127\.0\.0\.1)/.test(baseUri)) { console.error("refusing: the configured MongoDB is not a plain loopback instance"); process.exit(2); }
process.env.MONGODB_URI = baseUri.replace(/(mongodb:\/\/[^/]+\/)([^?]*)/, `$1${DB_NAME}`);
process.env.NODE_ENV = "test";
for (const k of ["AUTH_STUB_SECRET", "AUTH_TOKEN_VERIFIER", "AUTH_PROVIDER"]) delete process.env[k];

const mongoose = (await import("mongoose")).default;
const { connectDatabase } = await import("../src/config/database.js");
const { User, Workspace, WorkspaceMembership, Signal } = await import("../src/models/index.js");
await connectDatabase();
if (mongoose.connection.db.databaseName !== DB_NAME) { console.error("refusing: not connected to the isolated database"); process.exit(2); }

const { startLocalOidcProvider } = await import("./lib/localOidcProvider.mjs");
const AUDIENCE = "eoi-api-45b2";
const CLIENT_ID = "local-test-client";
const idp = await startLocalOidcProvider({ audience: AUDIENCE, clientId: CLIENT_ID });

let backend = null; let proxy = null; let vite = null;
const proxyHits = { count: 0, withAuth: 0 };
const tmpDirs = [];
try {
  // ---- a real backend in OIDC mode (loopback issuer, test mode), isolated DB, behind a counting proxy
  const BACKEND_PORT = 5391; const PROXY_PORT = 5392;
  backend = spawn(process.execPath, [path.join(BACKEND, "server.js")], {
    env: { ...process.env, PORT: String(BACKEND_PORT), NODE_ENV: "test", AUTH_PROVIDER: "oidc", OIDC_ISSUER: idp.issuer, OIDC_AUDIENCE: AUDIENCE, CLIENT_URL: "http://localhost:5174", KOI_RATE_LIMIT_ENABLED: "false", LLM_PROVIDER: "test-python", AI_SERVICE_URL: "http://localhost:5399" },
    stdio: "ignore",
  });
  for (let i = 0; i < 100; i += 1) { try { if ((await fetch(`http://localhost:${BACKEND_PORT}/api/health`)).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 200)); }
  proxy = http.createServer((req, res) => {
    proxyHits.count += 1; if (req.headers.authorization) proxyHits.withAuth += 1;
    const up = http.request({ host: "localhost", port: BACKEND_PORT, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on("error", () => { res.statusCode = 502; res.end(); });
    req.pipe(up);
  });
  await new Promise((r) => proxy.listen(PROXY_PORT, "127.0.0.1", r));
  const API = `http://localhost:${PROXY_PORT}`;
  const call = async (method, url, token, body) => { const r = await fetch(`http://localhost:${BACKEND_PORT}/api${url}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }); let json = null; try { json = await r.json(); } catch { /* none */ } return { status: r.status, json, code: json?.details?.code }; };

  // ---- fixtures: two workspaces, users keyed by (issuer, subject)
  const wsA = await Workspace.create({ name: `P45B2 a ${stamp}`, slug: `p45b2-a-${stamp}`, status: "active" });
  const wsB = await Workspace.create({ name: `P45B2 b ${stamp}`, slug: `p45b2-b-${stamp}`, status: "active" });
  const A = String(wsA._id); const B = String(wsB._id);
  const mkUser = async (sub, role, ws, extra = {}) => { const user = await User.create({ issuer: idp.issuer, subject: sub, email: extra.email, status: extra.status ?? "active" }); if (role) await WorkspaceMembership.create({ userId: user._id, workspaceId: ws._id, role }); return user; };
  await mkUser("admin-a", "admin", wsA, { email: "admin-a@example.invalid" });
  await mkUser("viewer-a", "viewer", wsA);
  await mkUser("operator-b", "operator", wsB);
  await mkUser("nomember", null, null);
  await mkUser("disabled-a", "operator", wsA, { status: "disabled" });
  const sigA = await Signal.create({ workspaceId: wsA._id, type: "maintenance", severity: "low", title: "A signal", description: "In workspace A." });
  const sigB = await Signal.create({ workspaceId: wsB._id, type: "maintenance", severity: "low", title: "B signal", description: "In workspace B." });
  const tokenFor = (sub, options = {}) => idp.mintToken({ sub, ...options });

  // ---- the frontend modules, loaded through Vite SSR; the API layer points at the counting proxy, sign-in at the local provider
  process.env.VITE_API_BASE_URL = `${API}/api`;
  process.env.VITE_OIDC_AUTHORITY = idp.issuer;
  process.env.VITE_OIDC_CLIENT_ID = CLIENT_ID;
  delete process.env.VITE_DEV_ACCESS_TOKEN;
  const { createServer } = await import(pathToFileURL(path.join(FRONTEND, "node_modules", "vite", "dist", "node", "index.js")).href);
  vite = await createServer({ root: FRONTEND, configFile: path.join(FRONTEND, "vite.config.js"), server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom", logLevel: "silent", optimizeDeps: { noDiscovery: true, include: [] } });
  const flow = await vite.ssrLoadModule("/src/services/auth/oidc/oidcFlow.js");
  const sess = await vite.ssrLoadModule("/src/services/auth/authSession.js");
  const tokenMod = await vite.ssrLoadModule("/src/services/auth/accessToken.js");
  const oidcMod = await vite.ssrLoadModule("/src/services/auth/oidc/oidcSession.js");
  const api = await vite.ssrLoadModule("/src/services/api.js");

  // ======================================================================================================================== A. return path
  console.log("\n# A. the return-path sanitiser");
  const ORIGIN = "http://localhost:5174";
  const S = (p) => flow.sanitizeReturnPath(p, ORIGIN);
  const deep = "/operations/signals/6ac494995352eda1be0e08a9/intelligence";
  check("A1 a plain internal path is kept, with its query and hash", S(deep) === deep && S("/intelligence?severity=high#top") === "/intelligence?severity=high#top");
  const evil = ["https://evil.example/x", "http://localhost:5174/ok", "//evil.example", "///evil.example", "/\\evil.example", "\\\\evil.example", "javascript:alert(1)", "data:text/html,x", "/.//evil.example", "/path\nLocation: x", "/pa\tth", "evil.example", "", null, undefined, 42, {}, "/x?code=1", "/x?state=abc", "/?error=access_denied", "/" + "a".repeat(3000)];
  check("A2 every external / protocol-relative / scheme / control-character / callback-parameter / oversize input becomes \"/\"", evil.every((p) => S(p) === "/"), evil.filter((p) => S(p) !== "/").join(" | "));
  check("A3 an encoded double slash stays a path on THIS origin (it is not a protocol-relative URL)", (() => { const r = S("/%2F%2Fevil.example"); return r.startsWith("/") && !r.startsWith("//") && new URL(r, ORIGIN).origin === ORIGIN; })());
  check("A4 whatever is returned always resolves to the same origin", [deep, ...evil, "/%5Cevil.example", "/a/../../b"].every((p) => new URL(S(p), ORIGIN).origin === ORIGIN));

  // ======================================================================================================================== B. SPA session vs local provider
  console.log("\n# B. the SPA sign-in session against the local test provider (fake browser window)");
  const makeWindow = (href = `${ORIGIN}/`, store = new Map()) => {
    const w = { assigned: [], replaced: [], store, location: {}, history: {}, sessionStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) } };
    const setHref = (h) => { const u = new URL(h, ORIGIN); Object.assign(w.location, { origin: u.origin, pathname: u.pathname, search: u.search, hash: u.hash, href: u.href }); };
    w.location.assign = (url) => { w.assigned.push(url); };
    w.history.replaceState = (_s, _t, url) => { w.replaced.push(String(url)); setHref(String(url)); };
    w.setHref = setHref; setHref(href);
    return w;
  };
  const settings = { authority: idp.issuer, clientId: CLIENT_ID, redirectUri: "", scope: "openid profile email", audience: "" };
  const mk = (win, opts = {}) => oidcMod.createOidcSession({ settings: { ...settings, ...(opts.settings || {}) }, production: Boolean(opts.production), win, now: opts.now, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) });
  const reset = () => { sess.resetAuthSession(); tokenMod.setAccessTokenSource(() => null); idp.config.authorize = "ok"; idp.config.tokenMode = "ok"; idp.config.sub = "admin-a"; idp.config.extraClaims = {}; };
  /** What the browser does at the provider: follow /authorize and return the URL the provider redirects back to (or null for a page that does not redirect). */
  const hop = async (win) => { const r = await fetch(win.assigned.at(-1), { redirect: "manual" }); return r.status === 302 ? r.headers.get("location") : null; };
  const settle = (p) => Promise.race([p.then(() => "settled"), new Promise((r) => setTimeout(() => r("pending"), 400))]);

  reset();
  let w = makeWindow(`${ORIGIN}${deep}?tab=x#evidence`);
  let s = mk(w);
  const first = settle(s.initOidcAuth());
  await new Promise((r) => setTimeout(r, 300));
  check("B1 a first load with no session redirects to the provider ONCE (PKCE S256, state, public client id, no secret)", w.assigned.length === 1 && /code_challenge_method=S256/.test(w.assigned[0]) && /state=/.test(w.assigned[0]) && new URL(w.assigned[0]).searchParams.get("client_id") === CLIENT_ID && !/secret/i.test(w.assigned[0]), `${w.assigned.length} redirect`);
  const tx = JSON.parse(w.store.get("koi.oidc.transaction") || "null");
  check("B2 the application records where the user was (a sanitised internal path) in the transaction, beside state and the verifier", tx?.returnTo === `${deep}?tab=x#evidence` && typeof tx.state === "string" && typeof tx.verifier === "string" && typeof tx.at === "number");
  check("B3 the address bar / history is not touched before the redirect and nothing but the transaction is stored", w.replaced.length === 0 && [...w.store.keys()].join() === "koi.oidc.transaction");
  const callbackUrl = await hop(w);
  check("B4 the provider redirects back to this origin with a code and the same state", Boolean(callbackUrl) && new URL(callbackUrl).origin === ORIGIN && new URL(callbackUrl).searchParams.get("state") === tx.state && new URL(callbackUrl).searchParams.has("code"));
  // the browser loads the callback URL: a fresh page, a fresh session object, the same sessionStorage
  const w2 = makeWindow(callbackUrl, w.store);
  const s2 = mk(w2);
  idp.stats.token = 0;
  await s2.initOidcAuth();
  check("B5 callback success: signed in, the app is ready", sess.getAuthState().status === "ready" && Boolean(s2.getMemoryToken()) && idp.stats.token === 1);
  check("B6 the callback parameters are removed from the address bar (code and state never stay in the URL)", w2.replaced.length >= 1 && !/code=|state=|error=/.test(w2.replaced[0]) && !/code=|state=/.test(w2.location.href));
  check("B7 deep-link restoration: the user lands on the page they asked for, with its query and hash", w2.location.pathname + w2.location.search + w2.location.hash === `${deep}?tab=x#evidence`);
  check("B8 the transaction is single-use (deleted after the callback)", !w2.store.has("koi.oidc.transaction"));
  check("B9 the access token is in memory only: it is in NO storage value, NO URL and NO history entry", (() => { const t = s2.getMemoryToken(); return ![...w2.store.values()].some((v) => v.includes(t)) && !w2.replaced.some((u) => u.includes(t)) && !w2.assigned.some((u) => u.includes(t)) && !w2.location.href.includes(t); })());
  check("B10 getAccessToken() hands the token to the API layer", tokenMod.getAccessToken() === s2.getMemoryToken());

  // forged / replayed callbacks
  reset();
  w = makeWindow(`${ORIGIN}/ops`); s = mk(w); settle(s.initOidcAuth()); await new Promise((r) => setTimeout(r, 300));
  const good = await hop(w);
  const forgedState = new URL(good); forgedState.searchParams.set("state", "attacker-state");
  idp.stats.token = 0;
  let wf = makeWindow(forgedState.toString(), w.store); let sf = mk(wf); await sf.initOidcAuth();
  check("B11 a callback with the wrong state is refused: no token exchange, no token, explicit failure screen", idp.stats.token === 0 && !sf.getMemoryToken() && sess.getAuthState().status === "blocked" && sess.getAuthState().reason === "callbackFailed");
  reset();
  wf = makeWindow(`${ORIGIN}/?code=stolen&state=whatever`); sf = mk(wf); idp.stats.token = 0; await sf.initOidcAuth();
  check("B12 a callback with NO stored transaction (replay / foreign link) is refused without contacting the token endpoint", idp.stats.token === 0 && sess.getAuthState().reason === "callbackFailed");

  // provider error: explicit failure, no redirect, no loop
  reset(); idp.config.authorize = "error";
  w = makeWindow(`${ORIGIN}${deep}`); s = mk(w); settle(s.initOidcAuth()); await new Promise((r) => setTimeout(r, 300));
  const errUrl = await hop(w);
  const authorizeBefore = idp.stats.authorize;
  wf = makeWindow(errUrl, w.store); sf = mk(wf);
  await sf.initOidcAuth();
  const st = sess.getAuthState();
  check("B13 a provider error (the person declined / cancelled) ends in an explicit, friendly 'Sign-in cancelled' state", st.status === "blocked" && st.reason === "cancelled" && sess.authMessage(st.reason) === "Sign-in was cancelled. You can try again whenever you're ready.");
  check("B14 callback failure does NOT start another sign-in (no redirect, the provider is not asked again)", wf.assigned.length === 0 && idp.stats.authorize === authorizeBefore);
  check("B15 the failed callback's parameters are removed from the URL, and the provider's error text is nowhere in the UI wording", wf.replaced.length >= 1 && !/error|code=|state=|the-provider-said-no/.test(wf.replaced[0]) && !/the-provider-said-no|access_denied/.test(sess.authMessage(st.reason) + sess.authTitle(st.reason)));
  // repeated reloads of the failed state never redirect
  let redirects = 0;
  for (let i = 0; i < 5; i += 1) { const wr = makeWindow(`${ORIGIN}/`, wf.store); const sr = mk(wr); sess.resetAuthSession(); await settle(sr.initOidcAuth()); redirects += wr.assigned.length; }
  check("B16 (no loop, part 1) five reloads after a failed callback make five sign-in starts at most - each is the single first-load redirect, never a chain", redirects <= 5);
  // the real loop risk: a provider that sends the browser back with no response at all
  reset(); idp.config.authorize = "noresponse";
  w = makeWindow(`${ORIGIN}${deep}`); s = mk(w); settle(s.initOidcAuth()); await new Promise((r) => setTimeout(r, 300));
  const back = await hop(w);
  const wn = makeWindow(back, w.store); const sn = mk(wn);
  idp.stats.authorize = 0;
  await sn.initOidcAuth();
  check("B17 (no loop, part 2) a provider that sends the user back WITHOUT a response ends in the explicit failure state, not a second redirect", wn.assigned.length === 0 && idp.stats.authorize === 0 && sess.getAuthState().reason === "callbackFailed" && !wn.store.has("koi.oidc.transaction"));
  // token endpoint failing
  reset(); idp.config.tokenMode = "fail";
  w = makeWindow(`${ORIGIN}/`); s = mk(w); settle(s.initOidcAuth()); await new Promise((r) => setTimeout(r, 300));
  const okCb = await hop(w); const wt = makeWindow(okCb, w.store); const stt = mk(wt); idp.stats.authorize = 0; await stt.initOidcAuth();
  check("B18 a failed code exchange is an explicit failure with no token and no re-redirect", sess.getAuthState().reason === "callbackFailed" && !stt.getMemoryToken() && wt.assigned.length === 0 && idp.stats.authorize === 0);
  // provider unreachable on a first load
  reset();
  const down = () => Promise.reject(new Error("ECONNREFUSED"));
  w = makeWindow(`${ORIGIN}/`); s = mk(w, { fetchImpl: down }); await s.initOidcAuth();
  check("B19 an unreachable provider shows 'Sign-in is unavailable' (no redirect, no loop)", sess.getAuthState().reason === "signInUnavailable" && w.assigned.length === 0);
  await s.signIn();
  check("B20 the user's own retry that fails again stays on the same screen and still does not redirect", sess.getAuthState().reason === "signInUnavailable" && w.assigned.length === 0);

  // sign out
  reset();
  w = makeWindow(`${ORIGIN}${deep}`); s = mk(w); settle(s.initOidcAuth()); await new Promise((r) => setTimeout(r, 300));
  const wi = makeWindow(await hop(w), w.store); const si = mk(wi); await si.initOidcAuth();
  const tokenBefore = si.getMemoryToken();
  si.signOut();
  check("B21 sign-out clears the in-memory token, the API layer's token and returns to the signed-out state", si.getMemoryToken() === null && tokenMod.getAccessToken() === null && sess.getAuthState().status === "blocked" && sess.getAuthState().reason === "signedOut" && Boolean(tokenBefore));
  check("B22 sign-out leaves no token anywhere in browser storage and no transaction", ![...wi.store.values()].some((v) => v.includes(tokenBefore)) && !wi.store.has("koi.oidc.transaction"));
  const wr2 = makeWindow(`${ORIGIN}/`, wi.store); const sr2 = mk(wr2); sess.resetAuthSession();
  await sr2.initOidcAuth();
  check("B23 a reload after sign-out stays signed out (no silent re-sign-in through the provider's session)", sess.getAuthState().reason === "signedOut" && wr2.assigned.length === 0);
  await settle(sr2.signIn({ returnTo: "/" })); // never resolves by design: the page is navigating away
  check("B24 'Sign in' after sign-out starts the normal flow and returns to the landing page; the signed-out flag is cleared", wr2.assigned.length === 1 && !wr2.store.has("koi.oidc.signedOut") && JSON.parse(wr2.store.get("koi.oidc.transaction")).returnTo === "/");

  // return-path attacks through storage and the URL
  reset();
  w = makeWindow(`${ORIGIN}${deep}`); s = mk(w); settle(s.initOidcAuth()); await new Promise((r) => setTimeout(r, 300));
  const cb = await hop(w);
  for (const bad of ["https://evil.example/steal", "//evil.example", "javascript:alert(1)", "/\\evil.example"]) {
    // the code is single-use at the provider; mint a fresh authorize for each attempt
    const wfresh = makeWindow(`${ORIGIN}/start`); const sfresh = mk(wfresh); settle(sfresh.initOidcAuth()); await new Promise((r) => setTimeout(r, 250));
    const cb2 = await hop(wfresh); const t3 = JSON.parse(wfresh.store.get("koi.oidc.transaction")); t3.returnTo = bad; wfresh.store.set("koi.oidc.transaction", JSON.stringify(t3));
    sess.resetAuthSession();
    const wz = makeWindow(cb2, wfresh.store); const sz = mk(wz); await sz.initOidcAuth();
    check(`B25 a tampered stored return path (${bad.slice(0, 22)}) never becomes a redirect target: the user lands on "/"`, sess.getAuthState().status === "ready" && wz.location.pathname === "/" && wz.location.origin === ORIGIN && wz.replaced.every((u) => !/evil/.test(u)));
  }
  reset();
  const wq = makeWindow(`${ORIGIN}/start`); const sq = mk(wq); settle(sq.initOidcAuth()); await new Promise((r) => setTimeout(r, 250));
  const cq = new URL(await hop(wq)); cq.searchParams.set("returnTo", "https://evil.example/x"); cq.searchParams.set("redirect", "//evil.example"); cq.searchParams.set("next", "https://evil.example");
  const wqq = makeWindow(cq.toString(), wq.store); const sqq = mk(wqq); sess.resetAuthSession(); await sqq.initOidcAuth();
  check("B26 a return URL supplied in the callback's query string is ignored: only the path the application stored is used", sess.getAuthState().status === "ready" && wqq.location.pathname === "/start" && wqq.replaced.every((u) => !/evil/.test(u)));

  // configuration guard
  reset();
  let fetchCalls = 0; const spyFetch = (...a) => { fetchCalls += 1; return fetch(...a); };
  const unconfigured = { settings: { authority: "", clientId: "", redirectUri: "", scope: "openid", audience: "" } };
  w = makeWindow(`${ORIGIN}/`); s = mk(w, { ...unconfigured, production: true, fetchImpl: spyFetch }); await s.initOidcAuth();
  check("B27 production + sign-in not configured: the app is blocked with 'Authentication is not configured' (it never looks signed in), with no network call and no redirect", sess.getAuthState().status === "blocked" && sess.getAuthState().reason === "notConfigured" && fetchCalls === 0 && w.assigned.length === 0 && sess.authTitle("notConfigured") === "Authentication is not configured");
  check("B28 the not-configured wording offers no development-token instruction, setting name or address", !/token|VITE_|OIDC|http|env/i.test(sess.authMessage("notConfigured") + sess.authTitle("notConfigured")) && sess.canSignIn() === false);
  reset();
  w = makeWindow(`${ORIGIN}/`); s = mk(w, { ...unconfigured, production: false }); await s.initOidcAuth();
  check("B29 development/test + not configured: unchanged - the app is ready and keeps its explicit development token", sess.getAuthState().status === "ready" && sess.isTokenRequired() === false && w.assigned.length === 0);

  // ======================================================================================================================== C. API layer vs a real backend (OIDC mode)
  console.log("\n# C. the API layer against a real backend in OIDC mode (isolated database, counting proxy)");
  const attempt = async (fn) => { try { return { value: await fn() }; } catch (error) { return { error }; } };
  const signedInSession = async (sub, opts = {}) => {
    reset(); idp.config.sub = sub; if (opts.ttlSeconds) idp.config.ttlSeconds = opts.ttlSeconds; if (opts.extraClaims) idp.config.extraClaims = opts.extraClaims;
    const win = makeWindow(`${ORIGIN}/ops`); const ss = mk(win, { now: opts.now }); settle(ss.initOidcAuth()); await new Promise((r) => setTimeout(r, 250));
    const win2 = makeWindow(await hop(win), win.store); const s2b = mk(win2, { now: opts.now }); await s2b.initOidcAuth();
    idp.config.ttlSeconds = 3600; idp.config.extraClaims = {};
    return { session: s2b, win: win2 };
  };

  let { session: live } = await signedInSession("admin-a");
  proxyHits.count = 0; proxyHits.withAuth = 0;
  const ok = await attempt(() => api.listSignals(A));
  check("C1 an authenticated request with a token from the local provider is accepted by the real backend (workspace-scoped)", Array.isArray(ok.value?.items) && ok.value.items.length === 1 && proxyHits.withAuth === 1, `${ok.error?.status} ${ok.error?.message} hits=${proxyHits.count}/${proxyHits.withAuth} len=${ok.value?.items?.length}`);

  // expired in memory
  let clock = Date.now();
  ({ session: live } = await signedInSession("admin-a", { ttlSeconds: 120, now: () => clock }));
  proxyHits.count = 0;
  clock += 200 * 1000; // past expiry
  const ex = await attempt(() => api.listSignals(A));
  check("C2 an expired token is detected before sending: 'Your session has expired. Please sign in again to continue.', and NO request is made", ex.error?.status === 401 && ex.error.message === "Your session has expired. Please sign in again to continue." && proxyHits.count === 0 && sess.getAuthState().status === "sessionEnded" && sess.getAuthState().reason === "expired");
  const again = await attempt(() => api.listSignals(A));
  check("C3 'Try again' on an ended session fails locally at once - the same unauthenticated request is NOT re-sent", again.error?.status === 401 && proxyHits.count === 0);
  idp.stats.authorize = 0;
  const winAgain = makeWindow(`${ORIGIN}${deep}`, new Map());
  const sAgain = mk(winAgain);
  await Promise.race([sAgain.signIn(), new Promise((r) => setTimeout(r, 300))]);
  check("C4 'Sign in again' starts the EXISTING sign-in flow (one redirect, returning to the page the user was on)", winAgain.assigned.length === 1 && JSON.parse(winAgain.store.get("koi.oidc.transaction")).returnTo === deep);
  const winBack = makeWindow(await hop(winAgain), winAgain.store); const sBack = mk(winBack); idp.config.sub = "admin-a";
  await sBack.initOidcAuth();
  const recovered = await attempt(() => api.listSignals(A));
  check("C5 after a successful new sign-in the ended/rejected state is cleared and requests work again - no manual page refresh", sess.getAuthState().status === "ready" && Array.isArray(recovered.value?.items), `${recovered.error?.status} ${recovered.error?.message} state=${sess.getAuthState().status}`);

  // missing token (OIDC configured, nothing signed in)
  reset(); sess.configureAuthLifecycle({ tokenRequired: true, signInAvailable: true });
  proxyHits.count = 0;
  const miss = await attempt(() => api.listSignals(A));
  check("C6 a missing token (sign-in configured) fails locally with no request, and puts the app in the sign-in-again state", miss.error?.status === 401 && proxyHits.count === 0 && sess.getAuthState().status === "sessionEnded");
  // server-side rejection: garbage token (token rules are the backend's)
  reset(); tokenMod.setAccessToken("aaa.bbb.ccc"); proxyHits.count = 0;
  const bad = await attempt(() => api.listSignals(A));
  check("C7 an invalid token is rejected by the backend (401): 'Your session has expired. Please sign in again to continue.' (no INVALID_TOKEN text, no token terminology)", bad.error?.status === 401 && bad.error.message === "Your session has expired. Please sign in again to continue." && !/token|INVALID/i.test(bad.error.message) && proxyHits.count === 1 && sess.getAuthState().reason === "rejected");
  const bad2 = await attempt(() => api.listSignals(A));
  check("C8 after the 401 the request is not sent again (the rejected token is not re-offered and the call fails locally)", bad2.error?.status === 401 && proxyHits.count === 1);
  // server says expired
  reset(); tokenMod.setAccessToken(await tokenFor("admin-a", { issuedAt: Math.floor(Date.now() / 1000) - 7200, ttlSeconds: 3600 })); proxyHits.count = 0;
  const srvExp = await attempt(() => api.listSignals(A));
  check("C9 a token the SERVER finds expired (TOKEN_EXPIRED) shows the session-expired wording and ends the session", srvExp.error?.status === 401 && srvExp.error.message === "Your session has expired. Please sign in again to continue." && sess.getAuthState().reason === "expired");
  reset(); proxyHits.count = 0; proxyHits.withAuth = 0;
  const noHdr = await attempt(() => api.listSignals(A)); // dev-style: not required, no token -> sent without Authorization -> backend 401 MISSING_CREDENTIAL
  check("C10 with sign-in NOT configured (development) a missing token is still the server's decision: sent, 401 MISSING_CREDENTIAL -> 'Please sign in to continue.'", noHdr.error?.status === 401 && noHdr.error.message === "Please sign in to continue." && proxyHits.withAuth === 0 && proxyHits.count === 1, `${noHdr.error?.status} ${noHdr.error?.message} hits=${proxyHits.count}/${proxyHits.withAuth}`);

  // logout stops requests
  ({ session: live } = await signedInSession("admin-a"));
  const before = await attempt(() => api.listSignals(A));
  proxyHits.count = 0; live.signOut();
  const afterOut = await attempt(() => api.listSignals(A));
  const afterOut2 = await attempt(() => api.createSignal({ workspaceId: A, type: "maintenance", severity: "low", title: "x" }));
  check("C11 logout clears the session and PREVENTS authenticated API calls (reads and writes fail locally, nothing reaches the network)", Array.isArray(before.value?.items) && afterOut.error?.status === 401 && afterOut2.error?.status === 401 && proxyHits.count === 0 && tokenMod.getAccessToken() === null, `${before.error?.message} | ${afterOut.error?.status} ${afterOut2.error?.status} hits=${proxyHits.count}`);

  // authorization behaviour unchanged (the backend decides; the SPA only words it)
  ({ session: live } = await signedInSession("nomember"));
  const noMember = await attempt(() => api.listSignals(A));
  check("C12 an identity with no membership still gets the existing 404 'Workspace not found' (membership checks unchanged)", noMember.error?.status === 404 && noMember.error.message === "Workspace not found" && sess.getAuthState().status === "ready", noMember.error?.message);
  ({ session: live } = await signedInSession("brand-new-subject"));
  const unreg = await attempt(() => api.listSignals(A));
  check("C13 an unregistered identity gets 403 with the plain wording the plain 'doesn't have access' wording and the session is NOT treated as ended", unreg.error?.status === 403 && unreg.error.message === "Your account doesn't have access to this yet. Please contact your administrator." && !/IDENTITY|NOT_REGISTERED/.test(unreg.error.message) && sess.getAuthState().status === "ready");
  ({ session: live } = await signedInSession("disabled-a"));
  const dis = await attempt(() => api.listSignals(A));
  check("C14 a disabled user gets 403 'This account is not active. Please contact your administrator.'", dis.error?.status === 403 && /not active/.test(dis.error.message) && !/USER_DISABLED/.test(dis.error.message));
  ({ session: live } = await signedInSession("viewer-a"));
  const viewerWrite = await attempt(() => api.createSignal({ workspaceId: A, type: "maintenance", severity: "low", title: "viewer cannot" }));
  check("C15 a viewer's write is still 403 with the backend's own permission wording (RBAC unchanged)", viewerWrite.error?.status === 403 && viewerWrite.error.message === "You do not have permission to do this", viewerWrite.error?.message);
  ({ session: live } = await signedInSession("admin-a"));
  const cross = await attempt(() => api.listSignals(B));
  const crossGet = await attempt(() => api.getSignal(String(sigB._id), A));
  check("C16 cross-tenant isolation is unchanged: A's admin gets 404 for workspace B and for B's signal through A", cross.error?.status === 404 && crossGet.error?.status === 404);

  // raw backend semantics with provider tokens (the architecture the SPA feeds)
  const T = (sub, opts) => tokenFor(sub, opts);
  const r1 = await call("GET", `/signals?workspaceId=${A}`, await T("admin-a"));
  check("C17 backend: a valid provider token -> issuer + subject -> existing User -> ACTIVE membership -> 200", r1.status === 200);
  const rClaims = await call("GET", `/signals?workspaceId=${B}`, await T("viewer-a", { extra: { role: "admin", roles: ["admin"], groups: ["admins"], workspaceId: B, workspace_id: B, "https://eoi.example/role": "admin", permissions: ["workspace:admin"], knowledgeLevel: "restricted" } }));
  const rWrite = await call("POST", "/signals", await T("viewer-a", { extra: { role: "admin", roles: ["admin"], groups: ["admins"], permissions: ["operations:manage", "workspace:admin"] } }), { workspaceId: A, type: "maintenance", severity: "low", title: "claims must not elevate" });
  check("C18 backend: role / group / permission / workspace / knowledge-level CLAIMS in a token are ignored - the viewer gets no access to B and cannot write in A", rClaims.status === 404 && rWrite.status === 403, `${rClaims.status}/${rWrite.status}`);
  const rEmail = await call("GET", `/signals?workspaceId=${A}`, await T("someone-else", { email: "admin-a@example.invalid" }));
  check("C19 backend: email is not identity - a token with an existing user's email but another subject is 'not registered' (403), never matched by email", rEmail.status === 403 && rEmail.code === "IDENTITY_NOT_REGISTERED");
  const rNone = await call("GET", `/signals?workspaceId=${A}`, null);
  const rExp = await call("GET", `/signals?workspaceId=${A}`, await T("admin-a", { issuedAt: Math.floor(Date.now() / 1000) - 7200, ttlSeconds: 3600 }));
  const wrongKey = (await import("jose")).generateKeyPair; const { privateKey: otherKey } = await wrongKey("RS256");
  const rSig = await call("GET", `/signals?workspaceId=${A}`, await T("admin-a", { key: otherKey }));
  const rAud = await call("GET", `/signals?workspaceId=${A}`, await T("admin-a", { aud: "someone-elses-api" }));
  const rIss = await call("GET", `/signals?workspaceId=${A}`, await T("admin-a", { iss: "http://127.0.0.1:1" }));
  check("C20 backend: missing / expired / wrong-signature / wrong-audience / wrong-issuer tokens are all 401 (the verifier is unchanged)", rNone.status === 401 && rNone.code === "MISSING_CREDENTIAL" && rExp.status === 401 && rExp.code === "TOKEN_EXPIRED" && [rSig, rAud, rIss].every((r) => r.status === 401 && r.code === "INVALID_TOKEN"), [rNone, rExp, rSig, rAud, rIss].map((r) => `${r.status}:${r.code}`).join(" "));
  const rHealth = await call("GET", "/health", null);
  check("C21 backend: /health stays public; every other route in the sampled set requires a credential", rHealth.status === 200 && (await Promise.all(["/signals", "/properties", "/guests", "/dashboard/signals", "/intelligence", "/decisions", "/learning"].map((p) => call("GET", `${p}?workspaceId=${A}`, null)))).every((r) => r.status === 401));

  // ======================================================================================================================== D. rendered UI
  console.log("\n# D. rendered UI (React server render)");
  const { createRequire } = await import("node:module");
  const feRequire = createRequire(path.join(FRONTEND, "package.json"));
  const React = feRequire("react");
  const { renderToString } = feRequire("react-dom/server");
  const h = React.createElement;
  const AuthScreen = (await vite.ssrLoadModule("/src/components/auth/AuthScreen.jsx")).default;
  const SessionNotice = (await vite.ssrLoadModule("/src/components/auth/SessionNotice.jsx")).default;
  const SignOutButton = (await vite.ssrLoadModule("/src/components/auth/SignOutButton.jsx")).default;
  const DecisionBlock = (await vite.ssrLoadModule("/src/features/dashboard/DecisionBlock.jsx")).default;
  const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ").trim();
  const FORBIDDEN_UI = /code=|state=|error=|access_denied|the-provider-said-no|Bearer|eyJ|127\.0\.0\.1|localhost|local-test-client|VITE_|OIDC|AUTH_|MONGODB|INVALID_TOKEN|TOKEN_EXPIRED|MISSING_CREDENTIAL|IDENTITY_NOT_REGISTERED|[0-9a-f]{24}|issuer|client id|development access token|Configure a development/i;
  const screen = (status, reason, canSignIn = true) => { sess.resetAuthSession(); sess.configureAuthLifecycle({ tokenRequired: true, signInAvailable: canSignIn }); if (status === "blocked") sess.blockApp(reason); else sess.markSessionEnded(reason); return text(renderToString(h(status === "blocked" ? AuthScreen : SessionNotice))); };
  const cbf = screen("blocked", "callbackFailed");
  check("D1 callback failure screen: 'Sign-in was not completed' + 'Please try again.' + a 'Try sign in again' action, nothing sensitive", /Sign-in was not completed/.test(cbf) && /Please try again\./.test(cbf) && /Try sign in again/.test(cbf) && !FORBIDDEN_UI.test(cbf), cbf);
  const so = screen("blocked", "signedOut");
  check("D2 signed-out screen: 'You have signed out' with a 'Sign in' action", /You have signed out/.test(so) && /Sign in/.test(so) && !FORBIDDEN_UI.test(so), so);
  const nc = screen("blocked", "notConfigured", false);
  check("D3 not-configured screen: 'Authentication is not configured', administrator wording, NO sign-in button, no setting names / values", /Authentication is not configured/.test(nc) && /contact your administrator/.test(nc) && !/Sign in|Try sign in/.test(nc.replace(/Sign-in isn't available/, "")) && !FORBIDDEN_UI.test(nc), nc);
  const ex2 = screen("sessionEnded", "expired");
  check("D4 expired session: 'Your session has expired. Please sign in again to continue.' + a 'Sign in again' action", /Your session has expired\. Please sign in again to continue\./.test(ex2) && /Sign in again/.test(ex2) && !FORBIDDEN_UI.test(ex2), ex2);
  const mi = screen("sessionEnded", "missing");
  check("D5 unauthenticated: 'Please sign in to continue.' + 'Sign in again'", /Please sign in to continue\./.test(mi) && /Sign in again/.test(mi) && !FORBIDDEN_UI.test(mi), mi);
  const rj = screen("sessionEnded", "rejected");
  check("D6 rejected session wording has no token terminology and no codes", /Your session has expired\. Please sign in again to continue\./.test(rj) && !FORBIDDEN_UI.test(rj) && !/token/i.test(rj), rj);
  const noSignIn = screen("sessionEnded", "expired", false);
  check("D7 a build without sign-in shows the message but never an action that cannot work; the development hint exists only under import.meta.env.DEV", !/Sign in again<\/button>/.test(noSignIn) && !FORBIDDEN_UI.test(noSignIn.replace(/Development build:.*$/, "")));
  const DecisionOut = text(renderToString(h(DecisionBlock, { resolved: { state: "unavailable", reason: "unauthenticated" }, onRetry: () => {} })));
  sess.resetAuthSession(); sess.configureAuthLifecycle({ tokenRequired: true, signInAvailable: true });
  const DecisionIn = text(renderToString(h(DecisionBlock, { resolved: { state: "unavailable", reason: "unauthenticated" }, onRetry: () => {} })));
  check("D8 the Decision block no longer says 'Configure a development access token and reload the page'; it offers the same sign-in action", !/development|access token|reload the page|Configure/i.test(DecisionOut + DecisionIn) && /Sign in required/.test(DecisionIn) && /Sign in again/.test(DecisionIn), DecisionIn);
  sess.resetAuthSession(); sess.configureAuthLifecycle({ tokenRequired: true, signInAvailable: true });
  const outReady = renderToString(h(SignOutButton));
  sess.blockApp("signedOut"); const outBlocked = renderToString(h(SignOutButton));
  check("D9 the Sign out control is visible in the authenticated app (sign-in configured) and not on the signed-out screen", /Sign out/.test(outReady) && outBlocked === "" , `${outReady.length}/${outBlocked.length}`);
  const pres = await vite.ssrLoadModule("/src/features/intelligence/intelligenceErrorPresentation.js");
  const u401 = pres.presentGenerationFailure({ status: 401, code: "TOKEN_EXPIRED" });
  check("D10 a generation attempt that fails with 401 reads 'Your session has expired. Please sign in again.' (no 'Authentication required', no code) and offers no blind retry", u401.message === "Your session has expired. Please sign in again." && u401.retryable === false && !/Authentication required/.test(u401.title + u401.message));
  const RetryButton = (await vite.ssrLoadModule("/src/components/auth/RetryButton.jsx")).default;
  sess.resetAuthSession(); sess.configureAuthLifecycle({ tokenRequired: true, signInAvailable: true });
  const retryReady = text(renderToString(h(RetryButton, { onClick: () => {} })));
  sess.markSessionEnded("expired");
  const retryEnded = text(renderToString(h(RetryButton, { onClick: () => {} })));
  check("D11 an error block's 'Try again' becomes 'Sign in again' once the session has ended (a retry could only fail), and stays 'Try again' otherwise", retryReady === "Try again" && retryEnded === "Sign in again", `${retryReady} / ${retryEnded}`);
  check("D12 every page-level 'Try again' goes through that button (no raw retry button is left beside an authentication failure)", (() => { const out = []; const walkJsx = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => { const f = path.join(d, e.name); if (e.isDirectory()) walkJsx(f); else if (/\.jsx$/.test(f) && !/RetryButton\.jsx$/.test(f) && /Try again/.test(read(f)) && !/<RetryButton/.test(read(f))) out.push(f); }); walkJsx(path.join(FRONTEND, "src")); return out.length === 0; })());
  sess.resetAuthSession();

  // ======================================================================================================================== E. production builds
  console.log("\n# E. production builds");
  const viteBin = path.join(FRONTEND, "node_modules", "vite", "bin", "vite.js");
  const build = (label, extraEnv) => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), `eoi-p45b2-${label}-`)); tmpDirs.push(out);
    const env = { ...process.env, ...extraEnv, NODE_ENV: "production" }; // a real production build; the suite itself runs with NODE_ENV=test, which would make Vite emit a DEV bundle for (const k of ["VITE_OIDC_AUTHORITY", "VITE_OIDC_CLIENT_ID", "VITE_DEV_ACCESS_TOKEN", "VITE_OIDC_REDIRECT_URI", "VITE_OIDC_AUDIENCE", "VITE_OIDC_SCOPE"]) if (!(k in extraEnv)) delete env[k];
    const r = spawnSync(process.execPath, [viteBin, "build", "--outDir", out, "--emptyOutDir"], { cwd: FRONTEND, env, encoding: "utf8" });
    const dir = path.join(out, "assets");
    const js = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => read(path.join(dir, f))).join("\n") : "";
    return { ok: r.status === 0, js, out };
  };
  const SENTINEL = "dev-token-sentinel-4f9a1c2e7b";
  const SECRET = "stub-secret-sentinel-8d3e5f6a";
  const noOidc = build("nooidc", { VITE_DEV_ACCESS_TOKEN: SENTINEL, VITE_AUTH_STUB_SECRET_X: SECRET });
  check("E1 a production build WITHOUT sign-in configuration builds, and contains the 'Authentication is not configured' guard", noOidc.ok && /Authentication is not configured/.test(noOidc.js));
  check("E2 the development access token is NOT in the production bundle (a sentinel supplied at build time is absent)", noOidc.ok && !noOidc.js.includes(SENTINEL) && !/VITE_DEV_ACCESS_TOKEN/.test(noOidc.js));
  check("E3 no development-auth wording ships: no 'Configure a development access token', no stub secret name, no development-build hint", !/Configure a development|AUTH_STUB_SECRET|eoi-suite-stub|issue-dev-token|Development build: no sign-in/.test(noOidc.js));
  const withOidc = build("oidc", { VITE_OIDC_AUTHORITY: "https://issuer.example.test", VITE_OIDC_CLIENT_ID: "public-client-id-for-test", VITE_DEV_ACCESS_TOKEN: SENTINEL });
  check("E4 a production build WITH sign-in configuration carries the sign-in flow (PKCE, discovery) and the sign-out / sign-in-again wording", withOidc.ok && /code_challenge/.test(withOidc.js) && /openid-configuration/.test(withOidc.js) && /Sign out/.test(withOidc.js) && /Sign in again/.test(withOidc.js));
  check("E5 even when configured, the production bundle has no development token, no client secret, no private key, no token and no provider payload", !withOidc.js.includes(SENTINEL) && !/client_secret|BEGIN [A-Z ]*PRIVATE KEY|eyJ[A-Za-z0-9_-]{15,}\.|AIza[0-9A-Za-z_-]{20,}|sk-[A-Za-z0-9]{20,}/.test(withOidc.js));
  check("E6 the only sign-in values in a configured bundle are the PUBLIC ones that were supplied (authority, client id)", withOidc.js.includes("https://issuer.example.test") && withOidc.js.includes("public-client-id-for-test"));
  check("E7 both production builds keep the sign-in code free of any hard-coded provider (no Auth0 / Okta / Keycloak / Entra / Cognito / Google sign-in strings)", ![noOidc.js, withOidc.js].some((js) => /auth0\.com|okta\.com|keycloak|login\.microsoftonline|cognito-idp|accounts\.google\.com/i.test(js)));
  const guardWorks = (() => { const mod = oidcMod; return typeof mod.createOidcSession === "function"; })();
  check("E8 the guard is decided by the build mode (import.meta.env.PROD) and the presence of the two public settings only", guardWorks && /production: Boolean\(import\.meta\.env\.PROD\)/.test(read(path.join(FRONTEND, "src/services/auth/oidc/oidcSession.js"))));

  // ======================================================================================================================== F. static
  console.log("\n# F. static checks");
  const src = (rel) => read(path.join(FRONTEND, "src", rel));
  const oidcSrc = strip(src("services/auth/oidc/oidcSession.js"));
  check("F1 sessionStorage is used only for the transaction, the signed-out flag and the non-credential 'this tab is signed in' marker; localStorage and cookies are not used for authentication", !/localStorage|document\.cookie/.test(oidcSrc + strip(src("services/auth/authSession.js")) + strip(src("services/auth/accessToken.js"))) && (oidcSrc.match(/storage\.set\(/g) || []).length === 3 && /storage\.set\(SESSION_KEY, "1"\)/.test(oidcSrc));
  check("F2 the sign-in code never navigates to an address it did not build from the discovered authorization endpoint (the only assign() is the authorization URL)", (oidcSrc.match(/location\.assign\(/g) || []).length === 1 && /location\.assign\(buildAuthorizationUrl\(/.test(oidcSrc));
  check("F3 the post-sign-in navigation is history.replaceState with a sanitised path only", /replaceState\(\{\}, "", sanitizeReturnPath\(/.test(oidcSrc) && !/location\.href\s*=|location\.replace\(/.test(oidcSrc));
  check("F4 refresh tokens are not implemented in this phase (no refresh_token / offline_access anywhere in the frontend)", !/refresh_token|offline_access/.test(strip(src("services/auth/oidc/oidcFlow.js")) + oidcSrc));
  check("F5 no provider-specific end-session endpoint is invented or called", !/end_session|logout\?|post_logout/.test(oidcSrc));
  const uiSrc = ["components/auth/AuthScreen.jsx", "components/auth/SessionNotice.jsx", "components/auth/SignInButton.jsx", "components/auth/SignOutButton.jsx", "hooks/useAuthSession.js"].map(src).join("\n");
  check("F6 the sign-in UI renders only fixed wording: no server message, error code, query parameter or environment value is displayed", !/\.message\b.*(error|err)|searchParams|location\.search|import\.meta\.env\.VITE_/.test(strip(uiSrc).replace(/import\.meta\.env\.DEV/g, "")));
  check("F7 the API layer still sends only 'Authorization: Bearer' (no role / permission / workspace / knowledge header) and keeps the 401 -> clear-token semantics", /Authorization/.test(src("services/api.js")) && !/["']X-(Role|Permission|Workspace|Knowledge)/i.test(src("services/api.js")) && /clearAccessToken\(\);/.test(src("services/api.js")));
  check("F8 the shell shows the sign-in-again notice and the Sign out control; the app is gated while blocked", /SessionNotice/.test(src("components/layout/AppShell.jsx")) && /SignOutButton/.test(src("components/layout/Header.jsx")) && /AuthGate/.test(src("app/App.jsx")) && /deriveJourney\(/.test(src("app/App.jsx")) && /default:[\s\S]*return <AuthScreen \/>;/.test(src("app/App.jsx")));
  const walkSrc = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walkSrc(path.join(d, e.name)) : [path.join(d, e.name)])).filter((f) => /\.jsx?$/.test(f));
  const aliased = walkSrc(path.join(FRONTEND, "src")).filter((f) => /import\.meta\.env(?![.\w])/.test(strip(read(f))));
  check("F10 `import.meta.env` is only ever read by NAME (never aliased or spread): an aliased env object is emitted WHOLE into a production bundle, development token included", aliased.length === 0, aliased.join(","));
  check("F9 no backend or AI-service source was touched by this phase (auth middleware, verifier, membership, roles byte-compared when P45B2_MANIFEST is given)", (() => {
    const m = process.env.P45B2_MANIFEST; if (!m || !fs.existsSync(m)) { console.log("INFO  F9 skipped: set P45B2_MANIFEST to the Phase 45A manifest-before.json to compare byte-for-byte"); return true; }
    const man = JSON.parse(read(m)).source; const files = Object.keys(man).filter((k) => /^(backend\\src|ai-service)/.test(k));
    const changed = files.filter((k) => !fs.existsSync(path.join(REPO, k)) || crypto.createHash("sha256").update(fs.readFileSync(path.join(REPO, k))).digest("hex") !== man[k]);
    return changed.length === 0 && files.length > 50;
  })());
} finally {
  if (vite) await vite.close();
  if (proxy) proxy.close();
  if (backend) backend.kill();
  await idp.close();
  try { await mongoose.connection.dropDatabase(); } catch { /* best effort */ }
  await mongoose.disconnect();
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
}

console.log(`\nPhase 45B.2 auth lifecycle validation: ${passed} passed, ${failed} failed (isolated database ${DB_NAME} dropped; local test provider - no real identity provider was contacted)`);
process.exit(failed === 0 ? 0 : 1);
