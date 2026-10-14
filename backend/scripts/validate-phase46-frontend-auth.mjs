/**
 * Phase 46 - unified authentication: the FRONTEND session lifecycle and pages, against a REAL backend (AUTH_PROVIDER=eoi) on an isolated throwaway database, with a
 * local Google-like provider for the Google paths. The real frontend modules run (Vite SSR + a fake browser window + a cookie-jar fetch that behaves like the browser's
 * credentialed fetch). No real Google account is used.
 *
 *   A  the credential client (eoiAuthApi): fixed wording, no raw server text
 *   B  the session: sign-in, silent refresh, expiry, single-flight, one retry, logout, reload, revoked session, no loops
 *   C  Google in the unified session: link required -> password -> one account; restricted
 *   D  the pages: labels, field semantics, wording, no technical terms, no storage
 *   E  source and bundle: no credential in browser storage, no secret in the bundle
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

{ const __u = dotenv.parse(process.getBuiltinModule("node:fs").readFileSync(new URL("../.env", import.meta.url))).MONGODB_URI ?? ""; if (/^mongodb:\/\/(?:[^@/]*@)?(localhost|127\.0\.0\.1)/i.test(__u)) process.env.MONGODB_URI ??= __u; } // validation / rehearsal tools take ONLY a loopback database URI from backend/.env, never its real settings
const baseUri = process.env.MONGODB_URI;
const stamp = Date.now();
const DB_NAME = `koi_p46fe_${stamp}`;
if (!baseUri || /^mongodb\+srv:|@/.test(baseUri) || !/^mongodb:\/\/(localhost|127\.0\.0\.1)/.test(baseUri)) { console.error("refusing: the configured MongoDB is not a plain loopback instance"); process.exit(2); }
process.env.MONGODB_URI = baseUri.replace(/(mongodb:\/\/[^/]+\/)([^?]*)/, `$1${DB_NAME}`);
process.env.NODE_ENV = "test";
for (const k of ["AUTH_STUB_SECRET", "AUTH_PROVIDER", "KOI_SESSION_SECRET", "OIDC_ISSUER", "OIDC_AUDIENCE", "OIDC_EXCHANGE_CLIENT_ID", "OIDC_EXCHANGE_CLIENT_SECRET", "OIDC_EXCHANGE_REDIRECT_URIS", "VITE_OIDC_AUTHORITY", "VITE_OIDC_CLIENT_ID", "VITE_DEV_ACCESS_TOKEN", "VITE_KOI_AUTH", "KOI_SELF_REGISTRATION"]) delete process.env[k];

const mongoose = (await import("mongoose")).default;
const { connectDatabase } = await import("../src/config/database.js");
const { User, AuthSession, AuthIdentity } = await import("../src/models/index.js");
await connectDatabase();
if (mongoose.connection.db.databaseName !== DB_NAME) { console.error("refusing: not connected to the isolated database"); process.exit(2); }
const { startLocalOidcProvider } = await import("./lib/localOidcProvider.mjs");

const CLIENT_ID = "790571179268-p46fe-test.apps.googleusercontent.com";
const GOOGLE_SECRET = "p46fe-test-client-secret-not-real-91bc";
const SESSION_SECRET = crypto.randomBytes(36).toString("base64url");
const ORIGIN = "http://localhost:5176";
const REDIRECT = `${ORIGIN}/`;
const idp = await startLocalOidcProvider({ audience: CLIENT_ID, clientId: CLIENT_ID });
Object.assign(idp.config, { googleMode: true, clientSecret: GOOGLE_SECRET });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eoi-p46fe-"));
const OUTBOX = path.join(tmp, "outbox.jsonl");
const PORT = 5721; const API = `http://localhost:${PORT}/api`;
const children = []; let vite = null; const tmpDirs = [tmp];
const outbox = () => (fs.existsSync(OUTBOX) ? read(OUTBOX).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const lastMail = (to, kind) => outbox().filter((m) => m.to === to && (!kind || m.kind === kind)).at(-1);
const tokenOf = (mail) => new URL(mail.link).searchParams.get("token");
const STRONG = "Correct-Horse-Battery-9!";

/** A browser-like credentialed fetch: it keeps the refresh cookie the server sets and sends it when the request says credentials: "include". */
function jarFetch(stats = { calls: [] }) {
  let cookie = "";
  const f = async (url, init = {}) => {
    stats.calls.push(`${init.method ?? "GET"} ${String(url).replace(API, "")}`);
    (stats.inits ??= []).push({ url: String(url), keepalive: init.keepalive === true, credentials: init.credentials, method: init.method });
    const headers = { ...(init.headers ?? {}) };
    if (cookie && init.credentials === "include") headers.cookie = cookie;
    const res = await fetch(url, { ...init, headers });
    for (const c of res.headers.getSetCookie?.() ?? []) { const [pair] = c.split(";"); if (pair.startsWith("koi_rt=")) cookie = /Max-Age=0/i.test(c) || pair === "koi_rt=" ? "" : pair; }
    return res;
  };
  f.jar = () => cookie; f.stats = stats; f.clear = () => { cookie = ""; };
  return f;
}
const makeWindow = (href = `${ORIGIN}/`, store = new Map()) => {
  const w = { assigned: [], replaced: [], store, location: {}, history: {}, sessionStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) } };
  const setHref = (hr) => { const u = new URL(hr, ORIGIN); Object.assign(w.location, { origin: u.origin, pathname: u.pathname, search: u.search, hash: u.hash, href: u.href }); };
  w.location.assign = (url) => { w.assigned.push(url); };
  w.history.replaceState = (_s, _t, url) => { w.replaced.push(String(url)); setHref(String(url)); };
  setHref(href); return w;
};

try {
  const be = spawn(process.execPath, [path.join(BACKEND, "server.js")], { env: { ...process.env, PORT: String(PORT), NODE_ENV: "test", CLIENT_URL: ORIGIN, KOI_RATE_LIMIT_ENABLED: "false", LLM_PROVIDER: "test-python", AI_SERVICE_URL: "http://localhost:5399", AUTH_PROVIDER: "eoi", KOI_SESSION_SECRET: SESSION_SECRET, KOI_PASSWORD_SCRYPT_LOG_N: "12", KOI_EMAIL_TRANSPORT: "outbox", KOI_EMAIL_OUTBOX_FILE: OUTBOX, OIDC_ISSUER: idp.issuer, OIDC_AUDIENCE: CLIENT_ID, OIDC_EXCHANGE_CLIENT_ID: CLIENT_ID, OIDC_EXCHANGE_CLIENT_SECRET: GOOGLE_SECRET, OIDC_EXCHANGE_REDIRECT_URIS: REDIRECT, KOI_SELF_REGISTRATION: "true", KOI_ACCESS_TOKEN_TTL_SECONDS: "60" }, stdio: "ignore" });
  children.push(be);
  for (let i = 0; i < 100; i += 1) { try { if ((await fetch(`${API}/health`)).ok) break; } catch { /* starting */ } await sleep(200); }

  process.env.VITE_API_BASE_URL = API; process.env.VITE_KOI_AUTH = "eoi"; process.env.VITE_OIDC_AUTHORITY = idp.issuer; process.env.VITE_OIDC_CLIENT_ID = CLIENT_ID; process.env.VITE_OIDC_PROVIDER_LABEL = "Google"; process.env.VITE_OIDC_TOKEN_EXCHANGE_URL = `${API}/auth/oidc/token`;
  const { createServer } = await import(pathToFileURL(path.join(FRONTEND, "node_modules", "vite", "dist", "node", "index.js")).href);
  vite = await createServer({ root: FRONTEND, configFile: path.join(FRONTEND, "vite.config.js"), server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom", logLevel: "silent", optimizeDeps: { noDiscovery: true, include: [] } });
  const sess = await vite.ssrLoadModule("/src/services/auth/authSession.js");
  const tokenMod = await vite.ssrLoadModule("/src/services/auth/accessToken.js");
  const oidcMod = await vite.ssrLoadModule("/src/services/auth/oidc/oidcSession.js");
  const apiMod = await vite.ssrLoadModule("/src/services/api.js");
  const { createEoiAuthApi } = await vite.ssrLoadModule("/src/services/auth/eoiAuthApi.js");
  const feRequire = createRequire(path.join(FRONTEND, "package.json"));
  const React = feRequire("react"); const { renderToString } = feRequire("react-dom/server"); const { MemoryRouter } = feRequire("react-router-dom"); const h = React.createElement;

  const settings = (over = {}) => ({ authority: idp.issuer, clientId: CLIENT_ID, redirectUri: "", scope: "openid profile email", audience: "", tokenExchangeUrl: `${API}/auth/oidc/token`, providerLabel: "Google", autoRedirect: false, eoiAuth: true, apiBase: API, ...over });
  const reset = () => { sess.resetAuthSession(); tokenMod.setAccessTokenSource(() => null); tokenMod.setTokenRefresher(null); };
  const newSession = (jar, { win = makeWindow(), now, over } = {}) => oidcMod.createOidcSession({ settings: settings(over), production: false, win, fetchImpl: jar, ...(now ? { now } : {}), timeoutMs: 3000 });
  const mkVerified = async (email, name = "Test Person", password = STRONG) => {
    const api = createEoiAuthApi({ apiBase: API });
    await api.signUp({ name, email, password, passwordConfirm: password });
    await api.verifyEmail(tokenOf(lastMail(email, "verify_email")));
    return api;
  };

  // ======================================================================================================== A
  console.log("\n# A. the credential client");
  const raw = createEoiAuthApi({ apiBase: API });
  const su = await raw.signUp({ name: "Alice Example", email: "alice.fe@example.com", password: STRONG, passwordConfirm: STRONG });
  const weak = await raw.signUp({ name: "Weak Person", email: "weak.fe@example.com", password: "short", passwordConfirm: "short" });
  const mismatch = await raw.signUp({ name: "Mismatch Person", email: "mm.fe@example.com", password: STRONG, passwordConfirm: "nope" });
  const unverified = await raw.signIn({ email: "alice.fe@example.com", password: STRONG });
  const wrong = await raw.signIn({ email: "alice.fe@example.com", password: "wrong-password-123" });
  const unknown = await raw.signIn({ email: "ghost.fe@example.com", password: "wrong-password-123" });
  check("A1 sign-up resolves ok; a weak password and a mismatched confirmation come back as { ok:false } with the server's plain validation sentence and the FIELD it concerns", su.ok === true && weak.ok === false && weak.field === "password" && /at least 10 characters/.test(weak.message) && mismatch.ok === false && mismatch.field === "passwordConfirm" && /do not match/.test(mismatch.message));
  check("A2 the right password on an unverified account is a fixed sentence with a stable code; a wrong password and an unknown address give the IDENTICAL result (no account enumeration in the client either)", unverified.code === "EMAIL_NOT_VERIFIED" && /verify your email/i.test(unverified.message) && wrong.message === "Invalid email or password." && wrong.message === unknown.message && wrong.code === unknown.code);
  const offline = await createEoiAuthApi({ apiBase: API, fetchImpl: async () => { throw new TypeError("Failed to fetch"); } }).signIn({ email: "a@b.co", password: "x" });
  const serverError = await createEoiAuthApi({ apiBase: API, fetchImpl: async () => new Response(JSON.stringify({ success: false, message: "Internal stack trace at foo.js:12", details: { code: "SOMETHING_INTERNAL" } }), { status: 500, headers: { "content-type": "application/json" } }) }).signIn({ email: "a@b.co", password: "x" });
  const limited = await createEoiAuthApi({ apiBase: API, fetchImpl: async () => new Response("{}", { status: 429, headers: { "content-type": "application/json" } }) }).signIn({ email: "a@b.co", password: "x" });
  check("A3 a network failure, an internal server error and a 429 each become ONE fixed friendly sentence - never the server's text, a status, a code or a stack trace", offline.message === "We couldn't reach EOI. Check your connection and try again." && serverError.message === "Something went wrong. Please try again." && !/stack|foo\.js|INTERNAL|500/.test(serverError.message) && /Too many attempts/.test(limited.message));
  const verifyMail = lastMail("alice.fe@example.com", "verify_email");
  const v = await raw.verifyEmail(tokenOf(verifyMail)); const vAgain = await raw.verifyEmail(tokenOf(verifyMail));
  const si = await raw.signIn({ email: "ALICE.FE@example.com", password: STRONG });
  check("A4 a verification link works once ('This link is invalid or has expired.' the second time) and sign-in then returns a GRANT { accessToken, expiresInSeconds } - and nothing else (no refresh token reaches JavaScript)", v.ok && vAgain.ok === false && vAgain.message === "This link is invalid or has expired." && si.ok && typeof si.grant.accessToken === "string" && si.grant.expiresInSeconds === 60 && Object.keys(si.grant).sort().join() === "accessToken,expiresInSeconds");

  // ======================================================================================================== B
  console.log("\n# B. the session lifecycle");
  reset();
  let clock = Date.now();
  const jar = jarFetch(); const win = makeWindow();
  const s1 = newSession(jar, { win, now: () => clock });
  await s1.initOidcAuth();
  check("B1 a fresh visit with NO refresh cookie shows the sign-in pages (welcome state), contacts only the refresh endpoint once, and does NOT redirect to Google", sess.getAuthState().reason === "welcome" && win.assigned.length === 0 && jar.stats.calls.join() === "POST /auth/refresh");
  const pw = createEoiAuthApi({ apiBase: API, fetchImpl: jar });
  const signed = await pw.signIn({ email: "alice.fe@example.com", password: STRONG });
  s1.adoptSession(signed.grant); sess.markReady();
  check("B2 after a password sign-in the page holds the access token IN MEMORY only; the refresh token is in the cookie jar (HttpOnly in a real browser) and in no store the page can read", s1.getMemoryToken() === signed.grant.accessToken && jar.jar().startsWith("koi_rt=") && ![...win.store.values()].some((v2) => v2.includes(signed.grant.accessToken) || v2.includes(jar.jar().split("=")[1])) && win.store.size === 0);
  const acct = await apiMod.getAccountSession();
  check("B3 an authenticated API request carries the EOI access token and is answered for THIS user", acct.state === "needs_setup" || acct.state === "member");
  // expiry -> silent refresh
  jar.stats.calls.length = 0; clock += 61_000; // the 60 s token has ended (and the 5 s margin)
  const afterExpiry = await apiMod.getAccountSession();
  check("B4 [silent renewal] when the short access token has ended, the NEXT request renews it through the cookie exactly once and then succeeds - the person is not asked to sign in", afterExpiry.state && jar.stats.calls.filter((c) => c === "POST /auth/refresh").length === 1 && sess.getAuthState().status === "ready" && s1.getMemoryToken() !== signed.grant.accessToken);
  jar.stats.calls.length = 0; clock += 61_000;
  const parallel = await Promise.all([apiMod.getAccountSession(), apiMod.getAccountSession(), apiMod.getAccountSession()]);
  check("B5 [single flight] three requests made at the same moment after expiry share ONE refresh (the cookie is rotated once, not three times)", parallel.every((p) => p.state) && jar.stats.calls.filter((c) => c === "POST /auth/refresh").length === 1);
  // a 401 from the server mid-session: one renewal attempt, one retry, then the session ends
  reset(); sess.configureAuthLifecycle({ tokenRequired: true, signInAvailable: true }); sess.markReady();
  const refresherCalls = []; tokenMod.setAccessTokenSource(() => "garbage.token.value"); tokenMod.setTokenRefresher(async () => { refresherCalls.push("refresher"); return null; });
  let before401 = 0; try { await apiMod.getAccountSession(); before401 = 1; } catch (e) { before401 = e.status; }
  const callsAfterEnd = refresherCalls.length; let localFailure = 0; try { await apiMod.getAccountSession(); } catch (e) { localFailure = e.status; }
  check("B6 a 401 from the server triggers exactly ONE renewal attempt; when renewal fails the session ENDS (no loop), and the next authenticated call fails locally with no further attempt", before401 === 401 && callsAfterEnd === 1 && sess.getAuthState().status === "sessionEnded" && localFailure === 401 && refresherCalls.length === 1);

  // reload restores / logout / revoked
  reset();
  const jar2 = jarFetch(); const w2 = makeWindow(); const sa = newSession(jar2, { win: w2 });
  await sa.initOidcAuth();
  const login = await createEoiAuthApi({ apiBase: API, fetchImpl: jar2 }).signIn({ email: "alice.fe@example.com", password: STRONG });
  sa.adoptSession(login.grant); sess.markReady();
  reset(); const w3 = makeWindow(`${ORIGIN}/operations/signals`, w2.store); const sb = newSession(jar2, { win: w3 }); await sb.initOidcAuth();
  check("B7 [reload] a new page load with the cookie restores the session silently (ready, no redirect, no welcome screen) and the same page stays", sess.getAuthState().status === "ready" && w3.assigned.length === 0 && sb.getMemoryToken() && w3.location.pathname === "/operations/signals");
  const tokenBeforeLogout = sb.getMemoryToken();
  const closing = sb.signOut(); const duringLogout = sess.getAuthState().reason; await closing;
  check("B8a [logout, honest wording] while the server is being asked the person sees 'signing out' - NOT 'you have signed out' - and only the confirmed result says 'signed out'", duringLogout === "signingOut" && sess.getAuthState().reason === "signedOut");
  const afterLogoutApi = await (async () => { try { await apiMod.getAccountSession(); return "ok"; } catch (e) { return e.status; } })();
  const oldTokenOnServer = await fetch(`${API}/auth/session`, { headers: { authorization: `Bearer ${tokenBeforeLogout}` } });
  check("B8 [logout] sign-out forgets the token at once (API calls fail locally), the server REVOKES the session (the old access token is refused with 401) and the cookie is cleared", sess.getAuthState().reason === "signedOut" && afterLogoutApi === 401 && oldTokenOnServer.status === 401 && jar2.jar() === "" && w3.store.has("koi.oidc.signedOut"));
  reset(); const w4 = makeWindow(`${ORIGIN}/`, w3.store); const sc = newSession(jar2, { win: w4 }); await sc.initOidcAuth();
  check("B9 after sign-out a reload stays signed out (the cookie is gone and the signed-out flag is set): no refresh attempt, no redirect to Google", sess.getAuthState().reason === "signedOut" && w4.assigned.length === 0 && !jar2.stats.calls.slice(-1)[0]?.endsWith("/auth/refresh"));
  // another browser's logout revokes this one
  reset(); const jar3 = jarFetch(); const w5 = makeWindow(); const sd = newSession(jar3, { win: w5 }); await sd.initOidcAuth();
  const l3 = await createEoiAuthApi({ apiBase: API, fetchImpl: jar3 }).signIn({ email: "alice.fe@example.com", password: STRONG }); sd.adoptSession(l3.grant); sess.markReady();
  await AuthSession.updateMany({ userId: (await User.findOne({ emailNormalized: "alice.fe@example.com" }).lean())._id }, { $set: { revokedAt: new Date(), revokedReason: "admin" } });
  jar3.stats.calls.length = 0; let nowShift = Date.now() + 120_000; const sdx = newSession(jar3, { win: w5, now: () => nowShift }); reset(); sdx.adoptSession(l3.grant);
  nowShift += 61_000; sess.markReady();
  let revokedOutcome; try { await apiMod.getAccountSession(); revokedOutcome = "ok"; } catch (e) { revokedOutcome = e.status; }
  check("B10 a REVOKED session cannot be renewed: the request fails, the session ends ('expired'), and exactly one refresh was tried", revokedOutcome === 401 && sess.getAuthState().status === "sessionEnded" && jar3.stats.calls.filter((c) => c === "POST /auth/refresh").length === 1);
  const refreshAfter = [];
  for (let i = 0; i < 3; i += 1) { try { await apiMod.getAccountSession(); } catch { /* ended locally */ } refreshAfter.push(jar3.stats.calls.filter((c) => c === "POST /auth/refresh").length); }
  check("B11 [no loop] after the session has ended, further requests fail locally: still exactly one refresh was ever sent", refreshAfter.every((n) => n === 1));
  // Phase 46.2: a rate-limited (429) or failing (5xx) server says nothing about the session, so the start-up restore reports "couldn't reach EOI" (retryable), never "signed out".
  const transient = [];
  for (const status of [429, 503]) {
    reset(); const wT = makeWindow(); let calls = 0;
    const sT = newSession(async () => { calls += 1; return new Response("{}", { status, headers: { "content-type": "application/json" } }); }, { win: wT });
    await sT.initOidcAuth();
    transient.push(sess.getAuthState().reason === "networkFailed" && wT.assigned.length === 0 && calls === 1);
  }
  // ---- Phase 46.3: logout failure semantics. "You have signed out" may be said ONLY after the server confirmed the revocation.
  const flaky = (jar, mode) => async (url, init) => {
    if (String(url).endsWith("/auth/logout") && mode.value) {
      if (mode.value === "network") throw new TypeError("Failed to fetch");
      if (mode.value === "hang") return new Promise(() => {});
      return new Response(JSON.stringify({ success: false, message: "Internal stack trace at secret.js:9" }), { status: mode.value, headers: { "content-type": "application/json" } });
    }
    return jar(url, init);
  };
  const localCall = async () => { try { await apiMod.getAccountSession(); return "ok"; } catch (e) { return e.status; } };
  const serverSaysToken = async (t) => (await fetch(`${API}/auth/session`, { headers: { authorization: `Bearer ${t}` } })).status;
  const outcomes = [];
  for (const mode of ["network", 503, 403, "hang"]) {
    const jarF = jarFetch(); const ref = { value: mode }; const wF = makeWindow();
    reset(); const sF = newSession(flaky(jarF, ref), { win: wF }); await sF.initOidcAuth();
    const g = await createEoiAuthApi({ apiBase: API, fetchImpl: jarF }).signIn({ email: "alice.fe@example.com", password: STRONG });
    sF.adoptSession(g.grant); sess.markReady();
    const p = sF.signOut(); const during = sess.getAuthState().reason; await p;
    const o = { mode, during, state: sess.getAuthState().reason, marker: wF.store.has("koi.oidc.signedOut"), serverStillValid: (await serverSaysToken(g.grant.accessToken)) === 200, cookieStill: jarF.jar().startsWith("koi_rt="), local: await localCall(), text: `${sess.authMessage(sess.getAuthState().reason)}` };
    if (mode === "network") {
      reset(); const wR = makeWindow(`${ORIGIN}/`, wF.store); const sR = newSession(jarF, { win: wR }); await sR.initOidcAuth();
      o.reloadRestores = sess.getAuthState().status === "ready" && Boolean(sR.getMemoryToken());
    }
    ref.value = null; // the problem is gone: "Try signing out again"
    await sF.signOut();
    Object.assign(o, { retryState: sess.getAuthState().reason, retryMarker: wF.store.has("koi.oidc.signedOut"), retryServerRevoked: (await serverSaysToken(g.grant.accessToken)) === 401, retryCookieCleared: jarF.jar() === "" });
    outcomes.push(o);
  }
  check("B13 [logout fails: network error / 503 / 403 / timeout] the person is told 'sign-out not confirmed' (never 'you have signed out'), the signed-out marker is NOT set, the page already refuses to send requests (401 locally), and the SERVER session + cookie really are still valid - so the screen is not misleading", outcomes.every((o) => o.during === "signingOut" && o.state === "signOutFailed" && o.marker === false && o.serverStillValid && o.cookieStill && o.local === 401));
  check("B13b the failure wording is fixed text: no status code, no server message, no stack trace", outcomes.every((o) => /couldn't confirm/.test(o.text) && !/503|403|stack|secret\.js|Failed to fetch/i.test(o.text)));
  check("B14 after a failed sign-out a reload honestly restores the session the server still holds (not a false 'signed out')", outcomes.find((o) => o.mode === "network")?.reloadRestores === true);
  check("B15 'Try signing out again' succeeds once the problem is gone: now it says 'signed out', the marker is set, the server REVOKED the session (old access token 401) and the cookie is cleared", outcomes.every((o) => o.retryState === "signedOut" && o.retryMarker && o.retryServerRevoked && o.retryCookieCleared));
  // another browser of the same user is not affected
  reset(); const jarA = jarFetch(); const jarB = jarFetch();
  const apiOf = (j) => createEoiAuthApi({ apiBase: API, fetchImpl: j });
  const gA = await apiOf(jarA).signIn({ email: "alice.fe@example.com", password: STRONG }); const gB = await apiOf(jarB).signIn({ email: "alice.fe@example.com", password: STRONG });
  const sA = newSession(jarA, { win: makeWindow() }); sA.adoptSession(gA.grant); sess.markReady();
  await sA.signOut();
  const sB = newSession(jarB, { win: makeWindow() }); const refreshedB = await sB.refreshSession();
  check("B16 signing out in ONE browser revokes only that session: the user's other browser still refreshes and works", sess.getAuthState().reason === "signedOut" && (await serverSaysToken(gA.grant.accessToken)) === 401 && refreshedB === "ok" && (await serverSaysToken(sB.getMemoryToken())) === 200);
  const gC = await apiOf(jarFetch()).signIn({ email: "alice.fe@example.com", password: STRONG }); const jarC = jarFetch();
  const cookieC = (await fetch(`${API}/auth/signin`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "alice.fe@example.com", password: STRONG }) })).headers.getSetCookie().find((c) => c.startsWith("koi_rt=")).split(";")[0];
  const noHeader = await fetch(`${API}/auth/logout`, { method: "POST", headers: { cookie: cookieC } });
  const foreign = await fetch(`${API}/auth/logout`, { method: "POST", headers: { cookie: cookieC, "x-koi-request": "1", origin: "https://evil.example" } });
  const stillThere = await fetch(`${API}/auth/refresh`, { method: "POST", headers: { cookie: cookieC, "x-koi-request": "1", origin: ORIGIN } });
  check("B17 [CSRF unchanged] logout without the custom header, or from a foreign Origin, is refused 403 and does NOT end the session", noHeader.status === 403 && foreign.status === 403 && stillThere.status === 200 && Boolean(gC.grant));
  const refreshInits = jar.stats.inits.filter((i) => i.url.endsWith("/auth/refresh"));
  check("B18 [lost response, Phase 52] every refresh the page sends is a credentialed POST with keepalive: a page unloaded while the refresh is in flight can no longer lose the rotated cookie (the server rotates on acceptance; a lost Set-Cookie leaves the browser with the old cookie, whose reuse AFTER the grace window is - correctly - revoked: C7). Rotation, grace and reuse detection are unchanged", refreshInits.length >= 3 && refreshInits.every((i) => i.keepalive === true && i.credentials === "include" && i.method === "POST"));
  check("B12 [429 / 5xx on the restore refresh] shows the retryable 'couldn't reach EOI' state (not the sign-in welcome), makes exactly one request and never redirects to Google", transient.length === 2 && transient.every(Boolean));

  // ======================================================================================================== C
  console.log("\n# C. Google inside the unified session");
  idp.config.authorize = "ok";
  const googleVia = async (sub, email, { emailVerified = true, jar: j = jarFetch() } = {}) => {
    reset(); idp.config.sub = sub; idp.config.email = email; idp.config.extraClaims = { email_verified: emailVerified };
    const w1 = makeWindow(`${ORIGIN}/operations/signals`); const s = newSession(j, { win: w1, over: { autoRedirect: true } });
    // start sign-in -> provider -> back with a code (the stored transaction is on w1.store)
    s.signIn().catch(() => {}); await sleep(400);
    const auth = await fetch(w1.assigned.at(-1), { redirect: "manual" });
    const back = auth.headers.get("location");
    const w2 = makeWindow(back, w1.store); const s2 = newSession(j, { win: w2 }); await s2.initOidcAuth();
    return { s: s2, win: w2, jar: j };
  };
  const gNew = await googleVia("1100000000000000000001", "greta.fe@example.com");
  check("C1 [new Google person] the unified exchange gives an EOI session: signed in (ready), the access token is in memory, the page returns to where it was, nothing in storage but the signed-in marker", sess.getAuthState().status === "ready" && Boolean(gNew.s.getMemoryToken()) && gNew.win.location.pathname === "/operations/signals" && [...gNew.win.store.keys()].every((k) => k === "koi.oidc.session"));
  const tokenParts = JSON.parse(Buffer.from(gNew.s.getMemoryToken().split(".")[1], "base64url").toString());
  check("C2 the bearer is EOI's own token (iss eoi), not Google's", tokenParts.iss === "eoi" && tokenParts.aud === "eoi-api");
  await mkVerified("heidi.fe@example.com", "Heidi Example");
  const gLink = await googleVia("1100000000000000000002", "heidi.fe@example.com");
  check("C3 [link required] a Google sign-in whose verified email belongs to a password account does NOT sign in: the state is 'linkRequired', a ticket is held in memory only, no token, and no second user exists", sess.getAuthState().reason === "linkRequired" && Boolean(gLink.s.getLinkTicket()) && !gLink.s.getMemoryToken() && (await User.countDocuments({ subject: "1100000000000000000002" })) === 0 && [...gLink.win.store.values()].every((v2) => !v2.includes(gLink.s.getLinkTicket())));
  const linkApi = createEoiAuthApi({ apiBase: API, fetchImpl: gLink.jar });
  const badLink = await linkApi.linkGoogle({ linkTicket: gLink.s.getLinkTicket(), password: "wrong-password-123" });
  const goodLink = await linkApi.linkGoogle({ linkTicket: gLink.s.getLinkTicket(), password: STRONG });
  gLink.s.adoptSession(goodLink.grant); sess.markReady();
  check("C4 the wrong password gives the fixed sentence and links nothing; the right password connects Google to the EXISTING account (one user, one linked identity) and opens a session", badLink.ok === false && /couldn't connect your Google account/i.test(badLink.message) && goodLink.ok && sess.getAuthState().status === "ready" && (await User.countDocuments({ emailNormalized: "heidi.fe@example.com" })) === 1 && (await AuthIdentity.countDocuments({ subject: "1100000000000000000002" })) === 1);

  // ======================================================================================================== D
  console.log("\n# D. the pages");
  const Pages = {};
  for (const n of ["SignInPage", "SignUpPage", "ForgotPasswordPage", "ResetPasswordPage", "VerifyEmailPage", "LinkGoogleScreen"]) Pages[n] = (await vite.ssrLoadModule(`/src/components/auth/${n}.jsx`)).default;
  reset(); sess.configureAuthLifecycle({ tokenRequired: true, signInAvailable: true }); sess.blockApp("welcome");
  const render = (C) => renderToString(h(MemoryRouter, null, h(C)));
  const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ").trim();
  const FORBIDDEN = /OIDC|PKCE|JWT|issuer|JWKS|workspace id|membership|provision|subject|invalid_grant|access_denied|[0-9a-f]{24}|stack|VITE_|localhost|127\.0\.0\.1|client secret/i;
  const pages = Object.fromEntries(Object.entries(Pages).map(([n, C]) => [n, render(C)]));
  check("D1 no page uses a technical term (OIDC, PKCE, JWT, issuer, JWKS, workspace id, membership, provisioning, ids, addresses)", Object.entries(pages).every(([, html]) => !FORBIDDEN.test(text(html))), Object.entries(pages).filter(([, html]) => FORBIDDEN.test(text(html))).map(([n]) => n).join(","));
  const signin = pages.SignInPage; const signup = pages.SignUpPage;
  check("D2 /signin: 'Welcome back', Email + Password (type=password, autocomplete username / current-password), 'Sign in', 'Forgot password?', 'Continue with Google', 'Don't have an account? Create account'", /Welcome back/.test(text(signin)) && /<label[^>]*for="signin-email"/.test(signin) && /<label[^>]*for="signin-password"/.test(signin) && /type="password"/.test(signin) && /autoComplete="current-password"|autocomplete="current-password"/i.test(signin) && /autocomplete="username"/i.test(signin) && />Sign in</.test(signin) && /Forgot password\?/.test(signin) && /Continue with Google/.test(signin) && /Don&#x27;t have an account\?/.test(signin) && /Create account/.test(signin));
  check("D3 /signup: 'Create your EOI account', Full name, Email, Password, Confirm password (new-password), 'Create account', Google, 'Already have an account? Sign in'", /Create your EOI account/.test(text(signup)) && ["signup-name", "signup-email", "signup-password", "signup-confirm"].every((id) => new RegExp(`<label[^>]*for="${id}"`).test(signup)) && (signup.match(/autocomplete="new-password"/gi) || []).length === 2 && /Continue with Google/.test(signup) && /Already have an account\?/.test(signup));
  check("D4 every password input has a Show/Hide button with an accessible name and aria-pressed (no icon-only control), and every field is tied to its label", (signup.match(/aria-label="Show (password|confirm password)"/g) || []).length === 2 && (signup.match(/aria-pressed="false"/g) || []).length === 2 && [signin, signup].every((html) => (html.match(/<input/g) || []).length === (html.match(/<label/g) || []).length));
  check("D5 the forgot-password page asks only for an email and promises nothing about whether an account exists; the reset page without a token says the link is not valid", /Reset your password/.test(text(pages.ForgotPasswordPage)) && (pages.ForgotPasswordPage.match(/<input/g) || []).length === 1 && /This link is invalid or has expired\./.test(text(pages.ResetPasswordPage)) && /Link not valid/.test(text(pages.VerifyEmailPage)));
  check("D6 the Google-link screen without a ticket says the step timed out and offers 'Back to sign in' (it never shows a password field it cannot use)", /This step has timed out/.test(text(pages.LinkGoogleScreen)) && !/type="password"/.test(pages.LinkGoogleScreen));
  const pageSrc = ["SignInPage", "SignUpPage", "ForgotPasswordPage", "ResetPasswordPage", "VerifyEmailPage", "LinkGoogleScreen", "AuthField", "GoogleButton", "AuthRoutes"].map((n) => strip(read(path.join(FRONTEND, `src/components/auth/${n}.jsx`)))).join("\n");
  check("D7 [no browser storage] none of the sign-in pages touches localStorage, sessionStorage or document.cookie, and none writes a token anywhere", !/localStorage|sessionStorage|document\.cookie|indexedDB/.test(pageSrc + strip(read(path.join(FRONTEND, "src/services/auth/eoiAuthApi.js"))) + strip(read(path.join(FRONTEND, "src/features/auth/intendedPath.js"))) + strip(read(path.join(FRONTEND, "src/features/auth/oneTimeToken.js")))));
  const appSrc = strip(read(path.join(FRONTEND, "src/app/App.jsx"))); const routesSrc = strip(read(path.join(FRONTEND, "src/components/auth/AuthRoutes.jsx")));
  check("D8 the routes exist: /signin, /signup, /forgot-password (signed out; any other address redirects to /signin and is remembered for after sign-in), /verify-email and /reset-password (public, signed in or out)", ["/signin", "/signup", "/forgot-password"].every((r) => routesSrc.includes(`path="${r}"`)) && /Navigate to="\/signin" replace/.test(routesSrc) && /pathname === "\/verify-email"/.test(appSrc) && /pathname === "\/reset-password"/.test(appSrc));
  const { rememberIntendedPath, consumeIntendedPath } = await vite.ssrLoadModule("/src/features/auth/intendedPath.js");
  rememberIntendedPath("https://evil.example/x", ORIGIN); rememberIntendedPath("//evil.example", ORIGIN); const hostile = consumeIntendedPath();
  rememberIntendedPath("/operations/guests?tab=x", ORIGIN); rememberIntendedPath("/signin", ORIGIN); const good = consumeIntendedPath();
  check("D9 [open redirect] the remembered return path is only ever a same-origin internal path: a hostile address becomes '/', a normal page is kept (and a sign-in page is never remembered as a destination)", hostile === "/" && good === "/operations/guests?tab=x");
  const { takeOneTimeToken } = await vite.ssrLoadModule("/src/features/auth/oneTimeToken.js");
  const wt = makeWindow(`${ORIGIN}/reset-password?token=${"A".repeat(43)}`); const t1 = takeOneTimeToken("reset", wt); const t2 = takeOneTimeToken("reset", wt);
  check("D10 [email token hygiene] the one-time token is read from the address once, the address is cleaned at once (token not left in the bar or history), and a second (StrictMode) read still finds it in memory", t1 === "A".repeat(43) && t2 === t1 && wt.replaced.at(-1) === "/reset-password" && !wt.location.search);

  // ======================================================================================================== E
  console.log("\n# E. bundle and source");
  const viteBin = path.join(FRONTEND, "node_modules", "vite", "bin", "vite.js");
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "eoi-p46fe-build-")); tmpDirs.push(out);
  const SENT = "sentinel-secret-p46-41ac";
  const env = { ...process.env, NODE_ENV: "production", KOI_SESSION_SECRET: SENT, OIDC_EXCHANGE_CLIENT_SECRET: SENT, VITE_KOI_AUTH: "eoi", VITE_API_BASE_URL: "https://api.example.invalid/api", VITE_DEV_ACCESS_TOKEN: SENT };
  delete env.VITE_OIDC_AUTHORITY; delete env.VITE_OIDC_CLIENT_ID;
  const b = spawnSync(process.execPath, [viteBin, "build", "--outDir", out, "--emptyOutDir"], { cwd: FRONTEND, env, encoding: "utf8" });
  const dir = path.join(out, "assets"); const js = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => read(path.join(dir, f))).join("\n") : "";
  check("E1 a production build with the unified session succeeds and carries the new screens' wording", b.status === 0 && /Create your EOI account/.test(js) && /Welcome back/.test(js) && /Forgot password\?/.test(js) && /Connect your Google account/.test(js));
  check("E2 [no secret in the frontend] neither the session secret, the client secret, the injected sentinel nor any token / hash appears in the production bundle", !js.includes(SENT) && !js.includes(SESSION_SECRET) && !js.includes(GOOGLE_SECRET) && !/GOCSPX|client_secret|scrypt\$|eyJ[A-Za-z0-9_-]{10,}\./.test(js));
  check("E3 the bundle contains no 'refresh token' handling in JavaScript (the refresh credential is an HttpOnly cookie the page cannot read)", !/refresh_token|refreshToken/.test(js));
} finally {
  if (vite) await vite.close();
  for (const c of children) c.kill();
  await idp.close();
  try { await mongoose.connection.dropDatabase(); } catch { /* best effort */ }
  await mongoose.disconnect();
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
}
console.log(`\nPhase 46 frontend authentication validation: ${passed} passed, ${failed} failed (isolated database ${DB_NAME} dropped; local Google-like provider - no real Google account was used)`);
process.exit(failed === 0 ? 0 : 1);
