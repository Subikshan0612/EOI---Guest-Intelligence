/**
 * Phase 45B.4.1 validation - the Google sign-in controls and runtime profile.
 *
 *   node backend/scripts/validate-phase45b41-google-ui-runtime.mjs
 *
 * THE REPORTED PROBLEM: "on the frontend I can't sign out, sign up, or sign in anything". ROOT CAUSE (found by inspecting the running stack): the running
 * frontend was the NORMAL profile (5174 -> backend 5000, real sign-in intentionally not configured, so no Sign in / Sign out exists there); the Google profile
 * (5175 -> backend 5001) was not running, nothing launches it, and the normal profile gave no hint. These checks cover the fix and the behaviours around it.
 *
 *   A  the Google profile: launch scripts, file consistency, wrong port / missing configuration is CAUGHT
 *   B  rendered UI: Continue with Google, create-account switch, the access-restricted screen, Sign out, the development-profile notice
 *   C  the flow against a real backend (isolated DB, local Google-like provider): sign-in begins correctly, post-sign-in access check, sign-out, reload, storage
 *   D  the REAL Google (no credentials; nobody signs in): the SPA's own code builds an authorization request Google accepts
 *   E  secrets and production bundle
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
const info = (m) => console.log(`INFO  ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

{ const __u = dotenv.parse(process.getBuiltinModule("node:fs").readFileSync(new URL("../.env", import.meta.url))).MONGODB_URI ?? ""; if (/^mongodb:\/\/(?:[^@/]*@)?(localhost|127\.0\.0\.1)/i.test(__u)) process.env.MONGODB_URI ??= __u; } // validation / rehearsal tools take ONLY a loopback database URI from backend/.env, never its real settings
const baseUri = process.env.MONGODB_URI;
const stamp = Date.now();
const DB_NAME = `koi_p45b41_${stamp}`;
if (!baseUri || /^mongodb\+srv:|@/.test(baseUri) || !/^mongodb:\/\/(localhost|127\.0\.0\.1)/.test(baseUri)) { console.error("refusing: the configured MongoDB is not a plain loopback instance"); process.exit(2); }
process.env.MONGODB_URI = baseUri.replace(/(mongodb:\/\/[^/]+\/)([^?]*)/, `$1${DB_NAME}`);
process.env.NODE_ENV = "test";
for (const k of ["AUTH_STUB_SECRET", "AUTH_TOKEN_VERIFIER", "AUTH_PROVIDER", "OIDC_EXCHANGE_CLIENT_ID", "OIDC_EXCHANGE_CLIENT_SECRET", "OIDC_EXCHANGE_REDIRECT_URIS", "VITE_OIDC_AUTHORITY", "VITE_OIDC_CLIENT_ID", "VITE_DEV_ACCESS_TOKEN"]) delete process.env[k];

const mongoose = (await import("mongoose")).default;
const { connectDatabase } = await import("../src/config/database.js");
const { User, Workspace, WorkspaceMembership } = await import("../src/models/index.js");
await connectDatabase();
if (mongoose.connection.db.databaseName !== DB_NAME) { console.error("refusing: not connected to the isolated database"); process.exit(2); }
const { startLocalOidcProvider } = await import("./lib/localOidcProvider.mjs");
const { checkGoogleProfile } = await import("./lib/googleProfile.mjs");

const CLIENT_ID = "790571179268-test-client.apps.googleusercontent.com";
const TEST_SECRET = "test-client-secret-not-real-5be21d90";
const ORIGIN = "http://localhost:5175";
const REDIRECT = `${ORIGIN}/`;
const idp = await startLocalOidcProvider({ audience: CLIENT_ID, clientId: CLIENT_ID });
Object.assign(idp.config, { googleMode: true, clientSecret: TEST_SECRET });
const PORT = 5491;
const API = `http://localhost:${PORT}/api`;
const children = []; const tmpDirs = []; let vite = null; let viteBare = null;
try {
  const be = spawn(process.execPath, [path.join(BACKEND, "server.js")], { env: { ...process.env, PORT: String(PORT), NODE_ENV: "test", CLIENT_URL: ORIGIN, KOI_RATE_LIMIT_ENABLED: "false", LLM_PROVIDER: "test-python", AI_SERVICE_URL: "http://localhost:5399", AUTH_PROVIDER: "oidc", OIDC_ISSUER: idp.issuer, OIDC_AUDIENCE: CLIENT_ID, OIDC_EXCHANGE_CLIENT_ID: CLIENT_ID, OIDC_EXCHANGE_CLIENT_SECRET: TEST_SECRET, OIDC_EXCHANGE_REDIRECT_URIS: REDIRECT }, stdio: "ignore" });
  children.push(be);
  for (let i = 0; i < 100; i += 1) { try { if ((await fetch(`${API}/health`)).ok) break; } catch { /* starting */ } await sleep(200); }

  const wsA = await Workspace.create({ name: `P45B41 a ${stamp}`, slug: `p45b41-a-${stamp}`, status: "active" });
  const wsB = await Workspace.create({ name: `P45B41 b ${stamp}`, slug: `p45b41-b-${stamp}`, status: "active" });
  const A = String(wsA._id); const B = String(wsB._id);
  const mkUser = async (sub, role, ws, status = "active") => { const user = await User.create({ issuer: idp.issuer, subject: sub, status }); if (role) await WorkspaceMembership.create({ userId: user._id, workspaceId: ws._id, role }); };
  const S = { admin: "111111111111111111111", inB: "333333333333333333333", noMember: "444444444444444444444", disabled: "555555555555555555555", unknown: "999999999999999999999" };
  await mkUser(S.admin, "admin", wsA); await mkUser(S.inB, "operator", wsB); await mkUser(S.noMember, null, null); await mkUser(S.disabled, "operator", wsA, "disabled");

  // ======================================================================================================== A. the Google profile
  console.log("\n# A. the Google profile: launch scripts, consistency, wrong port / missing configuration");
  const fePkg = JSON.parse(read(path.join(FRONTEND, "package.json"))); const bePkg = JSON.parse(read(path.join(BACKEND, "package.json")));
  check("A1 each side has a ONE-COMMAND Google launcher: `npm run dev:google` (frontend: Vite on 5175, strict port, reading frontend/.env; backend: the Google launcher, reading backend/.env)", fePkg.scripts["dev:google"] === "vite --port 5175 --strictPort" && bePkg.scripts["dev:google"] === "node scripts/start-google-dev.mjs" && fePkg.scripts.dev === "vite" && bePkg.scripts.dev === "nodemon server.js");
  const GOOD_B = { PORT: "5001", CLIENT_URL: ORIGIN, AUTH_PROVIDER: "oidc", OIDC_ISSUER: "https://accounts.google.com", OIDC_AUDIENCE: "cid", OIDC_EXCHANGE_CLIENT_ID: "cid", OIDC_EXCHANGE_CLIENT_SECRET: "s", OIDC_EXCHANGE_REDIRECT_URIS: REDIRECT };
  const GOOD_F = { VITE_API_BASE_URL: "http://localhost:5001/api", VITE_OIDC_AUTHORITY: "https://accounts.google.com", VITE_OIDC_CLIENT_ID: "cid", VITE_OIDC_REDIRECT_URI: REDIRECT, VITE_OIDC_TOKEN_EXCHANGE_URL: "http://localhost:5001/api/auth/oidc/token" };
  check("A2 a consistent Google profile has no problems", checkGoogleProfile(GOOD_B, GOOD_F).length === 0);
  const wrongPort = checkGoogleProfile(GOOD_B, { ...GOOD_F, VITE_API_BASE_URL: "http://localhost:5000/api", VITE_OIDC_TOKEN_EXCHANGE_URL: "http://localhost:5000/api/auth/oidc/token" });
  check("A3 [wrong backend port] a frontend profile pointing at the NORMAL backend (5000) while the Google backend is on 5001 is CAUGHT, with a message that names the ports", wrongPort.some((p) => /port 5000/.test(p) && /5001/.test(p)));
  const { VITE_OIDC_CLIENT_ID: _drop, ...noClient } = GOOD_F;
  const missing = [checkGoogleProfile(GOOD_B, noClient), checkGoogleProfile({ ...GOOD_B, OIDC_EXCHANGE_CLIENT_SECRET: "" }, GOOD_F), checkGoogleProfile({}, {})];
  check("A4 [missing Google configuration] a missing client id, secret or whole profile is a CLEAR error naming the missing variable (never a silent half-working app)", /VITE_OIDC_CLIENT_ID/.test(missing[0].join()) && /OIDC_EXCHANGE_CLIENT_SECRET/.test(missing[1].join()) && missing[2].length >= 10);
  check("A5 a redirect-URI / CORS-origin / client-id / issuer mismatch, a shared normal-profile port, and a secret-looking frontend variable are each caught", checkGoogleProfile(GOOD_B, { ...GOOD_F, VITE_OIDC_REDIRECT_URI: "http://localhost:5174/" }).length >= 2 && checkGoogleProfile(GOOD_B, { ...GOOD_F, VITE_OIDC_CLIENT_ID: "other" }).some((p) => /client id/.test(p)) && checkGoogleProfile(GOOD_B, { ...GOOD_F, VITE_OIDC_AUTHORITY: "https://issuer.example" }).some((p) => /issuer/.test(p)) && checkGoogleProfile({ ...GOOD_B, PORT: "5000" }, GOOD_F).some((p) => /5000/.test(p)) && checkGoogleProfile(GOOD_B, { ...GOOD_F, VITE_OIDC_CLIENT_SECRET: "x" }).some((p) => /public values only/.test(p)));
  const launcher = strip(read(path.join(here, "start-google-dev.mjs")));
  check("A6 the backend launcher refuses to start an inconsistent profile (exit 1, listing every problem) before the server is imported", /checkGoogleProfile\(/.test(launcher) && launcher.indexOf("process.exit(1)") > -1 && launcher.indexOf("checkGoogleProfile(") < launcher.indexOf('await import("../server.js")'));
  const feFile = path.join(FRONTEND, ".env"); const beFile = path.join(BACKEND, ".env"); // one runtime file per service (the former .env.google files were merged into them)
  if (fs.existsSync(feFile) && fs.existsSync(beFile)) {
    const fe = dotenv.parse(read(feFile)); const bk = dotenv.parse(read(beFile));
    const real = checkGoogleProfile(bk, fe);
    check("A7 the REAL local Google profile files agree with each other: frontend 5175 -> backend 5001, same issuer / client id / redirect URI / CORS origin, exchange URL on the Google backend", real.length === 0, real.join("; "));
    check("A8 the Google frontend never targets the normal backend (5000) or the normal frontend port (5174), and its redirect URI is exactly http://localhost:5175/", !/:5000\b/.test(fe.VITE_API_BASE_URL + fe.VITE_OIDC_TOKEN_EXCHANGE_URL) && fe.VITE_OIDC_REDIRECT_URI === "http://localhost:5175/" && bk.CLIENT_URL === "http://localhost:5175" && bk.PORT === "5001");
    check("A9 the frontend profile holds only the allowed PUBLIC variables", Object.keys(fe).every((k) => ["VITE_API_BASE_URL", "VITE_OIDC_AUTHORITY", "VITE_OIDC_CLIENT_ID", "VITE_OIDC_REDIRECT_URI", "VITE_OIDC_SCOPE", "VITE_OIDC_TOKEN_EXCHANGE_URL", "VITE_OIDC_PROVIDER_LABEL", "VITE_OIDC_AUTO_REDIRECT", "VITE_KOI_AUTH"].includes(k)) && fe.VITE_OIDC_PROVIDER_LABEL === "Google" && fe.VITE_OIDC_AUTO_REDIRECT === "false");
  } else info("A7-A9 skipped: the local Google profile files are not present");

  // ======================================================================================================== B. rendered UI
  console.log("\n# B. rendered UI (React server render)");
  process.env.VITE_API_BASE_URL = API; process.env.VITE_OIDC_AUTHORITY = idp.issuer; process.env.VITE_OIDC_CLIENT_ID = CLIENT_ID; process.env.VITE_OIDC_PROVIDER_LABEL = "Google"; process.env.VITE_OIDC_TOKEN_EXCHANGE_URL = `${API}/auth/oidc/token`;
  const { createServer } = await import(pathToFileURL(path.join(FRONTEND, "node_modules", "vite", "dist", "node", "index.js")).href);
  const mkVite = () => createServer({ root: FRONTEND, envDir: path.join(process.getBuiltinModule("node:os").tmpdir(), "koi-no-vite-env"), configFile: path.join(FRONTEND, "vite.config.js"), server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom", logLevel: "silent", optimizeDeps: { noDiscovery: true, include: [] } });
  vite = await mkVite();
  const sess = await vite.ssrLoadModule("/src/services/auth/authSession.js");
  const tokenMod = await vite.ssrLoadModule("/src/services/auth/accessToken.js");
  const oidcMod = await vite.ssrLoadModule("/src/services/auth/oidc/oidcSession.js");
  const flowMod = await vite.ssrLoadModule("/src/services/auth/oidc/oidcFlow.js");
  const apiMod = await vite.ssrLoadModule("/src/services/api.js");
  const accountMod = await vite.ssrLoadModule("/src/features/auth/accountSession.js");
  const feRequire = createRequire(path.join(FRONTEND, "package.json"));
  const React = feRequire("react"); const { renderToString } = feRequire("react-dom/server"); const h = React.createElement;
  const AuthScreen = (await vite.ssrLoadModule("/src/components/auth/AuthScreen.jsx")).default;
  const SignOutButton = (await vite.ssrLoadModule("/src/components/auth/SignOutButton.jsx")).default;
  const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").replace(/\s+([,.?!])/g, "$1").trim();
  const screen = (reason) => { sess.resetAuthSession(); sess.configureAuthLifecycle({ tokenRequired: true, signInAvailable: true }); sess.blockApp(reason); const html = renderToString(h(AuthScreen)); return { html, text: text(html) }; };
  const FORBIDDEN = /GOCSPX|client_secret|googleusercontent|accounts\.google|127\.0\.0\.1|localhost|code=|state=|eyJ|VITE_|OIDC|invalid_grant|access_denied|IDENTITY_NOT_REGISTERED|[0-9a-f]{24}/i;
  const fresh = screen("welcome");
  check("B1 [button renders + enabled] the fresh-visit screen shows a visible, ENABLED 'Continue with Google' button under 'Welcome to EOI'", /Welcome to EOI/.test(fresh.text) && /Continue with Google/.test(fresh.text) && /<button[^>]*class="primary-button"/.test(fresh.html) && !/<button[^>]*\sdisabled/.test(fresh.html) && !FORBIDDEN.test(fresh.text), fresh.text);
  check("B2 it tells a new person how to get started from the same screen ('New to EOI? Continue with Google and we'll help you set up your workspace') and mentions no terminal / provisioning step", /New to EOI\? Continue with Google and we'll help you set up your workspace\./.test(fresh.text) && !/provision|terminal|npm run|subject/i.test(fresh.text), fresh.text);
  const out = screen("signedOut");
  check("B3 the signed-out screen offers 'Continue with Google' and the new-to-EOI hint", /You have signed out/.test(out.text) && /Continue with Google/.test(out.text) && /New to EOI\?/.test(out.text) && !FORBIDDEN.test(out.text), out.text);
  const nr = screen("accessRestricted"); const na = screen("accountDisabled");
  check("B4 [new person, self-service off] the screen says an administrator must grant access, offers SIGN OUT (not a retry), and shows nothing technical (no 'not registered', no identifiers)", /administrator to grant you access/.test(nr.text) && /Sign out/.test(nr.text) && !/Continue with Google/.test(nr.text) && !/not registered|subject|membership|workspace id/i.test(nr.text) && !FORBIDDEN.test(nr.text), nr.text);
  check("B5 the 'account unavailable' screen has the same shape (a plain sentence, Sign out, nothing technical)", /Account unavailable/.test(na.text) && /Sign out/.test(na.text) && !FORBIDDEN.test(na.text), na.text);
  sess.resetAuthSession(); sess.configureAuthLifecycle({ tokenRequired: true, signInAvailable: true });
  const outReady = renderToString(h(SignOutButton)); sess.blockApp("signedOut"); const outBlocked = renderToString(h(SignOutButton));
  check("B6 [sign-out renders when authenticated] the header Sign out control renders with aria-label=\"Sign out\" while signed in, and not on a sign-in screen", /<button[^>]*aria-label="Sign out"/.test(outReady) && outBlocked === "");
  sess.resetAuthSession();
  // the development-profile notice: only when sign-in is NOT configured, only in development builds
  for (const k of ["VITE_OIDC_AUTHORITY", "VITE_OIDC_CLIENT_ID", "VITE_OIDC_TOKEN_EXCHANGE_URL", "VITE_OIDC_PROVIDER_LABEL"]) delete process.env[k];
  viteBare = await mkVite();
  const DevNoticeBare = (await viteBare.ssrLoadModule("/src/components/auth/DevProfileNotice.jsx")).default;
  const DevNoticeConfigured = (await vite.ssrLoadModule("/src/components/auth/DevProfileNotice.jsx")).default;
  const bareText = text(renderToString(h(DevNoticeBare)));
  check("B7 the plain development profile (sign-in not configured) EXPLAINS itself: no Sign in / Sign out here, and `npm run dev:google` + http://localhost:5175 for Google", /Development profile/.test(bareText) && /no Sign in or Sign out/.test(bareText) && /npm run dev:google/.test(bareText) && /http:\/\/localhost:5175/.test(bareText), bareText);
  check("B8 the notice is absent when sign-in IS configured (the Google profile), and its body is behind import.meta.env.DEV", renderToString(h(DevNoticeConfigured)) === "" && /import\.meta\.env\.DEV/.test(strip(read(path.join(FRONTEND, "src/components/auth/DevProfileNotice.jsx")))));

  // ======================================================================================================== C. the flow against a real backend
  console.log("\n# C. the flow (real backend, isolated DB, local Google-like provider)");
  const makeWindow = (href = `${ORIGIN}/`, store = new Map()) => {
    const w = { assigned: [], replaced: [], store, location: {}, history: {}, sessionStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) } };
    const setHref = (hr) => { const u = new URL(hr, ORIGIN); Object.assign(w.location, { origin: u.origin, pathname: u.pathname, search: u.search, hash: u.hash, href: u.href }); };
    w.location.assign = (url) => { w.assigned.push(url); };
    w.history.replaceState = (_s, _t, url) => { w.replaced.push(String(url)); setHref(String(url)); };
    setHref(href); return w;
  };
  const sent = [];
  const recording = (...args) => { sent.push({ url: String(args[0]), body: args[1]?.body ? String(args[1].body) : "" }); return fetch(...args); };
  const settings = (over = {}) => ({ authority: idp.issuer, clientId: CLIENT_ID, redirectUri: "", scope: "openid profile email", audience: "", tokenExchangeUrl: `${API}/auth/oidc/token`, providerLabel: "Google", autoRedirect: false, ...over });
  const mk = (win, o = {}) => oidcMod.createOidcSession({ settings: settings(o.settings), production: false, win, fetchImpl: recording, ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}) });
  const settle = (p, ms = 600) => Promise.race([p.then(() => "settled"), sleep(ms).then(() => "pending")]);
  const hop = async (win) => { const r = await fetch(win.assigned.at(-1), { redirect: "manual" }); return r.status === 302 ? r.headers.get("location") : null; };
  const reset = () => { sess.resetAuthSession(); tokenMod.setAccessTokenSource(() => null); Object.assign(idp.config, { authorize: "ok", tokenMode: "ok", discoveryMode: "ok", idTokenMode: "ok", googleMode: true, clientSecret: TEST_SECRET, extraClaims: {}, email: undefined, ttlSeconds: 3600 }); sent.length = 0; };
  /** A full sign-in as `sub` through the real flow: returns the fake window of the signed-in page and its session. */
  const signedIn = async (sub, deep = "/") => {
    reset(); idp.config.sub = sub;
    const w1 = makeWindow(`${ORIGIN}${deep}`); const s1 = mk(w1, { settings: { autoRedirect: true } }); await settle(s1.initOidcAuth());
    const w2 = makeWindow(await hop(w1), w1.store); const s2 = mk(w2); await s2.initOidcAuth();
    return { win: w2, session: s2 };
  };

  reset();
  const w0 = makeWindow(`${ORIGIN}/operations/signals?tab=x`); const s0 = mk(w0);
  await s0.initOidcAuth();
  check("C1 [fresh visit] with auto-redirect off the app waits on the 'Welcome back' screen: nothing is contacted, no redirect, no blank", sess.getAuthState().status === "blocked" && sess.getAuthState().reason === "welcome" && w0.assigned.length === 0 && sent.length === 0);
  await settle(s0.signIn());
  const au = new URL(w0.assigned[0]);
  check("C2 [clicking Sign in with Google begins the OIDC flow] ONE redirect to the provider's authorization endpoint with the correct authority, client id, EXACT redirect URI, code + S256 PKCE, state and scope", w0.assigned.length === 1 && au.origin === idp.issuer && au.pathname === "/authorize" && au.searchParams.get("client_id") === CLIENT_ID && au.searchParams.get("redirect_uri") === "http://localhost:5175/" && au.searchParams.get("response_type") === "code" && au.searchParams.get("code_challenge_method") === "S256" && au.searchParams.get("code_challenge")?.length >= 43 && au.searchParams.get("state")?.length >= 20 && au.searchParams.get("scope") === "openid profile email");
  check("C3 the first sign-in does not force the account chooser, the secret/verifier are not in the URL, and the page the user asked for is remembered", !au.searchParams.has("prompt") && ![...au.searchParams.keys()].some((k) => /secret|verifier/i.test(k)) && JSON.parse(w0.store.get("koi.oidc.transaction")).returnTo === "/operations/signals?tab=x");
  const w0b = makeWindow(`${ORIGIN}/`); const s0b = mk(w0b); await settle(s0b.signIn({ prompt: "select_account" }));
  check("C4 after sign-out (or for an account without access) sign-in asks the provider for its ACCOUNT CHOOSER (prompt=select_account), so another account can be used", new URL(w0b.assigned[0]).searchParams.get("prompt") === "select_account" && flowMod.buildAuthorizationUrl({ authorizationEndpoint: `${idp.issuer}/authorize`, clientId: "c", redirectUri: "http://localhost:5175/", scope: "openid", state: "s", challenge: "c", prompt: "bogus" }).includes("prompt=") === false);
  const hookSrc = strip(read(path.join(FRONTEND, "src/hooks/useAuthSession.js")));
  check("C5 the hook requests the account chooser exactly for signed-out / access-restricted / account-disabled, and returns to '/' for them", /switchAccount = reason === "signedOut" \|\| reason === "accessRestricted" \|\| reason === "accountDisabled"/.test(hookSrc) && /prompt: switchAccount \? "select_account" : undefined/.test(hookSrc));

  // sign in for real and look at what the browser sent
  const adm = await signedIn(S.admin, "/operations/signals?tab=x");
  const exch = sent.filter((r) => r.url.endsWith("/auth/oidc/token"));
  check("C6 [token exchange URL points at the Google-profile backend] the callback is exchanged through POST /api/auth/oidc/token on the configured backend with only { code, code_verifier, redirect_uri } - no client_secret", exch.length === 1 && exch[0].url === `${API}/auth/oidc/token` && JSON.stringify(Object.keys(JSON.parse(exch[0].body)).sort()) === JSON.stringify(["code", "code_verifier", "redirect_uri"]) && !exch[0].body.includes(TEST_SECRET) && !/client_secret/.test(exch[0].body));
  check("C7 signed in: the app is ready, the user lands on the page they asked for, the callback parameters are gone", sess.getAuthState().status === "ready" && adm.win.location.pathname + adm.win.location.search === "/operations/signals?tab=x" && adm.win.replaced.every((u) => !/code=|state=/.test(u)));
  check("C8 [no token in localStorage] and in sessionStorage there is only the non-credential signed-in marker after sign-in (the transaction is deleted), nothing in the URL or history", [...adm.win.store.entries()].every(([k, v]) => k === "koi.oidc.session" && v === "1") && ![...adm.win.replaced, ...adm.win.assigned].some((u) => u.includes(adm.session.getMemoryToken())));

  // post-sign-in account step (Phase 45C: GET /api/auth/session replaced the old workspace-list access check)
  const resolveFor = async (sub, preferredId = "") => { await signedIn(sub); return accountMod.resolveAccount({ getAccountSession: apiMod.getAccountSession, preferredId }); };
  const rOk = await resolveFor(S.admin, A); const rPref = await resolveFor(S.admin, B); const rUnknown = await resolveFor(S.unknown, A); const rDisabled = await resolveFor(S.disabled, A); const rNoMember = await resolveFor(S.noMember, A); const rOtherWs = await resolveFor(S.inB, A); const rLocal = await resolveFor(S.admin, "");
  check("C9 [existing member allowed] a registered identity with an active membership resolves to 'ready' in ONE OF THEIR OWN workspaces (their configured one if they belong to it)", rOk.kind === "ready" && rOk.workspaceId === A && rLocal.kind === "ready" && rLocal.workspaceId === A);
  check("C10 [unprovisioned Google user, self-service off] an identity EOI does not know -> 'restricted' (an administrator must grant access), and a disabled user -> 'disabled'", rUnknown.kind === "restricted" && rDisabled.kind === "disabled");
  check("C11 a registered identity with NO membership -> 'restricted'; a member of ANOTHER workspace only ever gets THEIR workspace, never the configured one; a preference for a workspace they are not in is ignored (no cross-workspace leakage)", rNoMember.kind === "restricted" && rOtherWs.kind === "ready" && rOtherWs.workspaceId === B && rPref.kind === "ready" && rPref.workspaceId === A);
  const fail = (status, code) => async () => { const e = new Error("x"); e.status = status; e.code = code; throw e; };
  const odd = await Promise.all([accountMod.resolveAccount({ getAccountSession: fail(0, "CLIENT_NETWORK") }), accountMod.resolveAccount({ getAccountSession: fail(503, "AUTH_PROVIDER_UNAVAILABLE") }), accountMod.resolveAccount({ getAccountSession: fail(403, "FORBIDDEN") }), accountMod.resolveAccount({ getAccountSession: async () => ({ state: "bogus" }) }), accountMod.resolveAccount({ getAccountSession: fail(401, "INVALID_TOKEN") })]);
  check("C12 an inconclusive answer (network, 5xx, an unexpected 403, a malformed answer) never guesses: 'failed' (a retry screen; the server still enforces everything), and an ended session is left to the sign-in-again path", odd[0].kind === "unreachable" && odd.slice(1, 4).every((r) => r.kind === "failed") && odd[4].kind === "ended");
  const appSrc = strip(read(path.join(FRONTEND, "src/app/App.jsx"))); const hookAccess = strip(read(path.join(FRONTEND, "src/hooks/useAccountSession.js")));
  check("C13 the gate shows 'Loading your account…' while the step runs, then the app / the short setup / a retry screen, and the step runs only when real sign-in is configured and the session is ready", /case JOURNEY\.CHECKING_ACCOUNT:\s*return <PendingScreen text="Loading your account…"/.test(appSrc) && /case JOURNEY\.ONBOARDING:/.test(appSrc) && /isAuthEnabled && status === AUTH_STATUS\.READY/.test(hookAccess) && !/blockApp\("unknown"\)/.test(hookAccess));
  check("C14 the account step is read-only (GET /auth/session with the caller's own token) and only the explicit setup action writes", /api\.get\(koiEndpoints\.accountSession, \{ authenticated: true/.test(strip(read(path.join(FRONTEND, "src/services/api.js")))) && !/registerAccount\(/.test(strip(read(path.join(FRONTEND, "src/features/auth/accountSession.js"))).replace(/export async function setUpAccount[\s\S]*$/, "")));

  // sign-out + reload
  const so = await signedIn(S.admin, "/ops"); const tokenBefore = tokenMod.getAccessToken();
  so.session.signOut();
  const afterOut = await (async () => { try { await apiMod.getAccountSession(); return null; } catch (e) { return e; } })();
  check("C15 [sign-out clears the session] the in-memory token is gone, the auth state is signed-out, and authenticated calls fail locally", Boolean(tokenBefore) && so.session.getMemoryToken() === null && tokenMod.getAccessToken() === null && sess.getAuthState().reason === "signedOut" && afterOut?.status === 401);
  const wr = makeWindow(`${ORIGIN}/`, so.win.store); const sr = mk(wr); sess.resetAuthSession(); await sr.initOidcAuth();
  check("C16 [reload after sign-out stays signed out] the signed-out screen again, no redirect, no loop, nothing contacted", sess.getAuthState().reason === "signedOut" && wr.assigned.length === 0 && [...wr.store.keys()].join() === "koi.oidc.signedOut");
  const wr2 = makeWindow(`${ORIGIN}/`, wr.store); const sr2 = mk(wr2); await settle(sr2.signIn({ prompt: "select_account", returnTo: "/" }));
  check("C17 [sign in can be started again] from the signed-out state: one redirect (with the account chooser), the signed-out flag cleared", wr2.assigned.length === 1 && !wr2.store.has("koi.oidc.signedOut") && new URL(wr2.assigned[0]).searchParams.get("prompt") === "select_account");
  check("C18 only the allowed non-credential keys were ever written to sessionStorage (koi.oidc.transaction, koi.oidc.signedOut, koi.oidc.session): never a token", [...wr2.store.keys()].every((k) => ["koi.oidc.transaction", "koi.oidc.signedOut", "koi.oidc.session"].includes(k)) && ![...wr2.store.values()].some((v) => /eyJ/.test(v)));
  reset(); idp.config.authorize = "error";
  { const w1 = makeWindow(`${ORIGIN}/ops`); const s1 = mk(w1, { settings: { autoRedirect: true } }); await settle(s1.initOidcAuth()); const cb = await hop(w1); const w2 = makeWindow(cb, w1.store); const s2 = mk(w2); await s2.initOidcAuth();
    check("C19 a provider error returns to a clear, friendly 'Sign-in cancelled' screen with no second redirect (existing hardening intact)", sess.getAuthState().reason === "cancelled" && w2.assigned.length === 0 && w2.replaced.every((u) => !/error|code=|state=/.test(u))); }
  reset();

  // ======================================================================================================== D. the REAL Google, no credentials
  console.log("\n# D. the real Google: the SPA's own code builds a request Google accepts (no credentials, nobody signs in)");
  const realId = fs.existsSync(feFile) ? dotenv.parse(read(feFile)).VITE_OIDC_CLIENT_ID : "";
  if (!realId) info("D skipped: frontend/.env has no Google client id"); else {
    const net = async (fn) => { try { return await fn(); } catch (e) { return { netError: String(e?.message ?? e).slice(0, 60) }; } };
    const go = async (extra) => {
      const win = makeWindow(`${ORIGIN}/operations/signals`); const ss = oidcMod.createOidcSession({ settings: { authority: "https://accounts.google.com", clientId: realId, redirectUri: "", scope: "openid profile email", audience: "", tokenExchangeUrl: "http://localhost:5001/api/auth/oidc/token", providerLabel: "Google", autoRedirect: false }, production: false, win, fetchImpl: fetch });
      await settle(ss.signIn(extra), 8000);
      if (win.assigned.length !== 1) return { win, none: true };
      const r = await net(async () => { const x = await fetch(win.assigned[0], { redirect: "manual", signal: AbortSignal.timeout(10000) }); return { status: x.status, location: x.headers.get("location") ?? "", body: x.status === 200 ? (await x.text()).slice(0, 100000) : "" }; });
      return { win, url: new URL(win.assigned[0]), r };
    };
    const g1 = await go({}); const g2 = await go({ prompt: "select_account" });
    if (g1.none || g1.r?.netError) info(`D skipped: Google not reachable (${g1.r?.netError ?? "no redirect"})`); else {
      const rejected = (g) => /redirect_uri_mismatch|invalid_request|invalid_client|origin_mismatch|Error 400|Error 401|deleted_client/i.test(g.r.body + g.r.location);
      check("D1 the SPA (real session code, Google settings) redirects to https://accounts.google.com with the REAL client id, redirect URI exactly http://localhost:5175/, S256 PKCE, state and scope 'openid profile email'", g1.url.origin === "https://accounts.google.com" && g1.url.searchParams.get("client_id") === realId && g1.url.searchParams.get("redirect_uri") === "http://localhost:5175/" && g1.url.searchParams.get("code_challenge_method") === "S256" && g1.url.searchParams.get("scope") === "openid profile email" && g1.url.searchParams.get("state")?.length >= 20 && !g1.url.search.includes("secret"));
      check("D2 Google ACCEPTS that request: it sends the browser to its sign-in page, not an error page", !rejected(g1) && (g1.r.status === 200 || (g1.r.status >= 300 && g1.r.status < 400 && /accounts\.google\.com/.test(g1.r.location))), `HTTP ${g1.r.status}${g1.r.location ? ` -> ${new URL(g1.r.location, "https://accounts.google.com").pathname}` : ""}`);
      check("D3 Google also accepts the request with prompt=select_account (the account chooser used after sign-out)", g2.url.searchParams.get("prompt") === "select_account" && !rejected(g2) && (g2.r.status === 200 || (g2.r.status >= 300 && g2.r.status < 400)), `HTTP ${g2.r.status}`);
    }
  }

  // ======================================================================================================== E. secrets and the production bundle
  console.log("\n# E. secrets and the production bundle");
  const jsonPath = (() => { const dir = path.join(os.homedir(), "Downloads"); try { const f = fs.readdirSync(dir).find((n) => /^client_secret_.+\.apps\.googleusercontent\.com\.json$/.test(n)); return path.join(dir, f ?? "client_secret.json"); } catch { return path.join(dir, "client_secret.json"); } })();
  const realSecret = fs.existsSync(jsonPath) ? (JSON.parse(read(jsonPath)).web?.client_secret ?? "") : "";
  const viteBin = path.join(FRONTEND, "node_modules", "vite", "bin", "vite.js");
  const build = (label, args, extraEnv) => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), `eoi-p45b41-${label}-`)); tmpDirs.push(out);
    const env = { ...process.env, ...extraEnv, NODE_ENV: "production" }; for (const k of Object.keys(env)) if (/^VITE_/.test(k) && !(k in extraEnv)) delete env[k];
    const r = spawnSync(process.execPath, [viteBin, "build", ...args, "--outDir", out, "--emptyOutDir"], { cwd: FRONTEND, env, encoding: "utf8" });
    const dir = path.join(out, "assets");
    return { ok: r.status === 0, js: fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => read(path.join(dir, f))).join("\n") : "" };
  };
  const SENT = "sentinel-secret-7c1e44ab";
  const gb = build("google", ["--mode", "google"], { OIDC_EXCHANGE_CLIENT_SECRET: SENT, VITE_DEV_ACCESS_TOKEN: SENT });
  const nb = build("plain", [], {});
  check("E1 production builds succeed in Google mode and in the plain profile", gb.ok && nb.ok);
  check("E2 [no client secret in the frontend bundle] neither the real secret, a GOCSPX- value, an injected sentinel, an OAuth JSON, nor any token/credential appears; the development token is absent", [gb.js, nb.js].every((js) => !(realSecret && js.includes(realSecret)) && !/GOCSPX|client_secret|\"web\":\{\"client_id|eyJ[A-Za-z0-9_-]{15,}\.|ya29\.|refresh_token|VITE_DEV_ACCESS_TOKEN|OIDC_EXCHANGE|GOOGLE_CLIENT/.test(js) && !js.includes(SENT)));
  check("E3 the Google bundle carries the sign-in button text, the account-step and create-account wording and the exchange URL; the development-profile notice is NOT in either production bundle", /Continue with/.test(gb.js) && /Loading your account/.test(gb.js) && /New to EOI/.test(gb.js) && /auth\/oidc\/token/.test(gb.js) && ![gb.js, nb.js].some((js) => /npm run dev:google|Development profile: sign-in is not configured/.test(js)));
  const srcFiles = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? srcFiles(path.join(d, e.name)) : [path.join(d, e.name)])).filter((f) => /\.jsx?$/.test(f));
  check("E4 the frontend source has no secret variable or string, and `import.meta.env` is only read by name", srcFiles(path.join(FRONTEND, "src")).every((f) => { const c = strip(read(f)); return !/VITE_[A-Z0-9_]*SECRET|GOCSPX|client_secret/i.test(c) && !/import\.meta\.env(?![.\w])/.test(c); }));
  const files = spawnSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).stdout.split(/\r?\n/).filter(Boolean).filter((f) => !/\.(png|jpg|gif|ico|woff2?|pdf|zip|svg)$/i.test(f) && !/(^|\/)(node_modules|\.venv|dist)\//.test(f));
  const leaks = files.filter((f) => { try { const t = read(path.join(REPO, f)); return (realSecret && t.includes(realSecret)) || /GOCSPX-[A-Za-z0-9_-]{20,}/.test(t); } catch { return false; } });
  check("E5 the Google client secret is in no tracked or un-ignored repository file", files.length > 300 && leaks.length === 0, `${files.length} files scanned${leaks.length ? `; HIT ${leaks.join(",")}` : ""}`);
} finally {
  if (vite) await vite.close();
  if (viteBare) await viteBare.close();
  for (const c of children) c.kill();
  await idp.close();
  try { await mongoose.connection.dropDatabase(); } catch { /* best effort */ }
  await mongoose.disconnect();
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
}

console.log(`\nPhase 45B.4.1 Google UI / runtime validation: ${passed} passed, ${failed} failed (isolated database ${DB_NAME} dropped; sections A-C use a local Google-like provider; section D contacted the real Google without credentials; nobody signed in)`);
process.exit(failed === 0 ? 0 : 1);
