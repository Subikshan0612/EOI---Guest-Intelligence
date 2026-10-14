/**
 * Phase 45C - clean authentication & account onboarding: the FRONTEND + end-to-end flow.
 *
 * Complements validate-phase45c-account-onboarding.mjs (the backend contract). Here the real frontend modules run (Vite SSR with a fake browser window) against
 * REAL spawned backends on an isolated throwaway database, with a local Google-like identity provider. No real Google account is used.
 *
 *   A  screens and wording: Welcome back / Create your account / onboarding / restricted / disabled; nothing technical is ever shown; accessibility basics
 *   B  the account step with a real backend (self-registration ON): new Google user -> onboarding -> own workspace -> app; existing user straight in; isolation
 *   C  the account step with a real backend (self-registration OFF): a new person is told an administrator must grant access, and NOTHING is created
 *   D  sign-out / session end clears the account state
 *   E  the production bundle: no secret, new wording present, old technical wording absent; the operator tool is kept but not part of the normal journey
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
const DB_NAME = `koi_p45cfe_${stamp}`;
if (!baseUri || /^mongodb\+srv:|@/.test(baseUri) || !/^mongodb:\/\/(localhost|127\.0\.0\.1)/.test(baseUri)) { console.error("refusing: the configured MongoDB is not a plain loopback instance"); process.exit(2); }
process.env.MONGODB_URI = baseUri.replace(/(mongodb:\/\/[^/]+\/)([^?]*)/, `$1${DB_NAME}`);
process.env.NODE_ENV = "test";
for (const k of ["AUTH_STUB_SECRET", "AUTH_TOKEN_VERIFIER", "AUTH_PROVIDER", "OIDC_EXCHANGE_CLIENT_ID", "OIDC_EXCHANGE_CLIENT_SECRET", "OIDC_EXCHANGE_REDIRECT_URIS", "VITE_OIDC_AUTHORITY", "VITE_OIDC_CLIENT_ID", "VITE_DEV_ACCESS_TOKEN", "KOI_SELF_REGISTRATION"]) delete process.env[k];

const mongoose = (await import("mongoose")).default;
const { connectDatabase } = await import("../src/config/database.js");
const { User, Workspace, WorkspaceMembership } = await import("../src/models/index.js");
await connectDatabase();
if (mongoose.connection.db.databaseName !== DB_NAME) { console.error("refusing: not connected to the isolated database"); process.exit(2); }
const { startLocalOidcProvider } = await import("./lib/localOidcProvider.mjs");

const CLIENT_ID = "790571179268-test-client.apps.googleusercontent.com";
const TEST_SECRET = "test-client-secret-not-real-5be21d90";
const ORIGIN = "http://localhost:5175";
const REDIRECT = `${ORIGIN}/`;
const idp = await startLocalOidcProvider({ audience: CLIENT_ID, clientId: CLIENT_ID });
Object.assign(idp.config, { googleMode: true, clientSecret: TEST_SECRET });
const PORT_ON = 5492; const PORT_OFF = 5493;
const API_ON = `http://localhost:${PORT_ON}/api`; const API_OFF = `http://localhost:${PORT_OFF}/api`;
const children = []; const tmpDirs = []; let vite = null;
const backendEnv = (port, selfReg) => ({ ...process.env, PORT: String(port), NODE_ENV: "test", CLIENT_URL: ORIGIN, KOI_RATE_LIMIT_ENABLED: "false", LLM_PROVIDER: "test-python", AI_SERVICE_URL: "http://localhost:5399", AUTH_PROVIDER: "oidc", OIDC_ISSUER: idp.issuer, OIDC_AUDIENCE: CLIENT_ID, OIDC_EXCHANGE_CLIENT_ID: CLIENT_ID, OIDC_EXCHANGE_CLIENT_SECRET: TEST_SECRET, OIDC_EXCHANGE_REDIRECT_URIS: REDIRECT, ...(selfReg ? { KOI_SELF_REGISTRATION: "true" } : {}) });
try {
  for (const [port, selfReg, api] of [[PORT_ON, true, API_ON], [PORT_OFF, false, API_OFF]]) {
    const be = spawn(process.execPath, [path.join(BACKEND, "server.js")], { env: backendEnv(port, selfReg), stdio: "ignore" });
    children.push(be);
    for (let i = 0; i < 100; i += 1) { try { if ((await fetch(`${api}/health`)).ok) break; } catch { /* starting */ } await sleep(200); }
  }

  const wsA = await Workspace.create({ name: `P45C a ${stamp}`, slug: `p45c-a-${stamp}`, status: "active" });
  const A = String(wsA._id);
  const mkUser = async (sub, role, ws, status = "active") => { const user = await User.create({ issuer: idp.issuer, subject: sub, status }); if (role) await WorkspaceMembership.create({ userId: user._id, workspaceId: ws._id, role }); return user; };
  const S = { existing: "111111111111111111111", fresh1: "222222222222222222222", fresh2: "333333333333333333333", fresh3: "444444444444444444444", disabled: "555555555555555555555", restricted: "666666666666666666666", hostile: "777777777777777777777" };
  await mkUser(S.existing, "operator", wsA); await mkUser(S.disabled, "operator", wsA, "disabled");

  // ======================================================================================================== A. screens and wording
  console.log("\n# A. screens and wording");
  process.env.VITE_API_BASE_URL = API_ON; process.env.VITE_OIDC_AUTHORITY = idp.issuer; process.env.VITE_OIDC_CLIENT_ID = CLIENT_ID; process.env.VITE_OIDC_PROVIDER_LABEL = "Google"; process.env.VITE_OIDC_TOKEN_EXCHANGE_URL = `${API_ON}/auth/oidc/token`;
  const { createServer } = await import(pathToFileURL(path.join(FRONTEND, "node_modules", "vite", "dist", "node", "index.js")).href);
  vite = await createServer({ root: FRONTEND, configFile: path.join(FRONTEND, "vite.config.js"), server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom", logLevel: "silent", optimizeDeps: { noDiscovery: true, include: [] } });
  const sess = await vite.ssrLoadModule("/src/services/auth/authSession.js");
  const tokenMod = await vite.ssrLoadModule("/src/services/auth/accessToken.js");
  const oidcMod = await vite.ssrLoadModule("/src/services/auth/oidc/oidcSession.js");
  const apiMod = await vite.ssrLoadModule("/src/services/api.js");
  const accountMod = await vite.ssrLoadModule("/src/features/auth/accountSession.js");
  const wsMod = await vite.ssrLoadModule("/src/config/workspace.js");
  const feRequire = createRequire(path.join(FRONTEND, "package.json"));
  const React = feRequire("react"); const { renderToString } = feRequire("react-dom/server"); const h = React.createElement;
  const AuthScreen = (await vite.ssrLoadModule("/src/components/auth/AuthScreen.jsx")).default;
  const OnboardingScreen = (await vite.ssrLoadModule("/src/components/auth/OnboardingScreen.jsx")).default;
  const PendingScreen = (await vite.ssrLoadModule("/src/components/auth/PendingScreen.jsx")).default;
  const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ").replace(/\s+([,.?!])/g, "$1").trim();
  const FORBIDDEN = /not registered|google subject|subject|workspace id|issuer|OIDC|provision|membership|JWT|bearer|eyJ|provider configuration|invalid_grant|IDENTITY_NOT_REGISTERED|USER_DISABLED|SELF_REGISTRATION|VITE_|localhost|127\.0\.0\.1|[0-9a-f]{24}|stack|mongo|client[_ ]secret|GOCSPX/i;
  const screen = (reason) => { sess.resetAuthSession(); sess.configureAuthLifecycle({ tokenRequired: true, signInAvailable: true }); sess.blockApp(reason); const html = renderToString(h(AuthScreen)); return { html, text: text(html) }; };

  const reasons = Object.values(sess.AUTH_REASON);
  const rendered = reasons.map((r) => [r, screen(r).text]);
  check("A1 [no technical wording] EVERY authentication screen, for every reason, shows only plain product language (no subject, issuer, OIDC, provisioning, membership, JWT, ids, addresses, error codes)", rendered.every(([, t]) => !FORBIDDEN.test(t)), rendered.filter(([, t]) => FORBIDDEN.test(t)).map(([r]) => r).join(","));
  const welcome = screen("welcome");
  check("A2 the signed-out entry screen is 'Welcome to EOI' with ONE primary action 'Continue with Google' and the hint 'New to EOI? Continue with Google and we'll help you set up your workspace'", /^EOI Welcome to EOI/.test(welcome.text) && (welcome.html.match(/<button/g) || []).length === 1 && /Continue with Google/.test(welcome.text) && /New to EOI\? Continue with Google and we'll help you set up your workspace\./.test(welcome.text), welcome.text);
  const bundleSrc = strip(read(path.join(FRONTEND, "src/components/auth/AuthScreen.jsx")));
  check("A3 there is no second sign-up screen and no password anywhere (EOI has no passwords of its own): one entry point, no email/password field on any screen", !/Create your account|Already have an account/.test(bundleSrc) && !/type="password"|password|type="email"/i.test(["AuthScreen", "OnboardingScreen", "PendingScreen"].map((n) => strip(read(path.join(FRONTEND, `src/components/auth/${n}.jsx`)))).join("\n")));
  const restricted = screen("accessRestricted"); const disabled = screen("accountDisabled"); const expired = screen("expired");
  check("A4 [restricted] a new person on a deployment without self-service sees 'an administrator must grant you access' with Sign out, not a sign-in loop, and no 'not registered' wording", /administrator to grant you access/.test(restricted.text) && /Sign out/.test(restricted.text) && !/Continue with Google/.test(restricted.text) && !/not registered/i.test(restricted.text), restricted.text);
  check("A5 a disabled account sees 'Account unavailable' + 'Your EOI account is currently unavailable. Please contact your administrator.' with Sign out; an ended session sees 'Your session has expired. Please sign in again to continue.' with a Sign in again action - no 401 / token / issuer wording", /Account unavailable/.test(disabled.text) && /Your EOI account is currently unavailable\. Please contact your administrator\./.test(disabled.text) && /Sign out/.test(disabled.text) && /Your session has expired\. Please sign in again to continue\./.test(expired.text) && /Sign in again/.test(expired.text) && !/401|token|JWT/i.test(expired.text), `${disabled.text} | ${expired.text}`);
  const onboarding = renderToString(h(OnboardingScreen, { onSubmit: async () => ({ ok: true }), busy: false, onSignOut: () => {} })); const onboardingText = text(onboarding);
  check("A6 [onboarding] the setup screen asks only for a workspace name, explains they will administer THEIR OWN new workspace, offers Sign out, and shows nothing technical", /Welcome to EOI/.test(onboardingText) && /Workspace name/.test(onboardingText) && /Create workspace/.test(onboardingText) && /Sign out/.test(onboardingText) && /This will be your EOI workspace\. You'll be its administrator\./.test(onboardingText) && (onboarding.match(/<input/g) || []).length === 1 && !FORBIDDEN.test(onboardingText), onboardingText);
  check("A7 [accessibility] the onboarding field has a real <label for>, an accessible description, autocomplete and a maximum length; errors use role=alert; every control is a text button (no icon-only control); the screen heading takes focus", /<label[^>]*for="workspace-name"/.test(onboarding) && /id="workspace-name"/.test(onboarding) && /aria-describedby="workspace-hint"/.test(onboarding) && /autoComplete="organization"|autocomplete="organization"/i.test(onboarding) && /maxLength="120"|maxlength="120"/i.test(onboarding) && /role=\{?"alert"/.test(strip(read(path.join(FRONTEND, "src/components/auth/OnboardingScreen.jsx")))) && /heading\.current\?\.focus\(\)/.test(read(path.join(FRONTEND, "src/components/auth/OnboardingScreen.jsx"))) && /heading\.current\?\.focus\(\)/.test(read(path.join(FRONTEND, "src/components/auth/AuthScreen.jsx"))));
  const pending = text(renderToString(h(PendingScreen, { text: "We couldn't load your account.", onAction: () => {}, secondaryLabel: "Sign out", onSecondary: () => {} })));
  check("A8 the account-load failure screen is a plain retry screen ('Try again' + Sign out) with no technical wording", /Try again/.test(pending) && /Sign out/.test(pending) && !FORBIDDEN.test(pending), pending);
  const routesSrc = strip(read(path.join(FRONTEND, "src/app/routes.jsx")));
  check("A9 deep links are preserved: no /signin /signup /onboarding routes were added (the screens are gates, so the page the person asked for is restored after sign-in)", !/signin|signup|onboarding/i.test(routesSrc));
  check("A10 the live workspace binding accepts only a 24-hex id, can be cleared, and no api/ provider code reads a build-time constant any more", (() => { wsMod.setActiveWorkspace("not-an-id"); const bad = wsMod.KOI_WORKSPACE_ID; wsMod.setActiveWorkspace(A); const good = wsMod.KOI_WORKSPACE_ID === A && wsMod.isWorkspaceConfigured === true; wsMod.setActiveWorkspace(""); const cleared = wsMod.KOI_WORKSPACE_ID === "" && wsMod.isWorkspaceConfigured === false; return bad === "" && good && cleared; })());
  check("A11 the only browser-held values are the in-memory token, the transient sign-in transaction and the signed-out flag: onboarding adds NO localStorage/sessionStorage use", !/localStorage|sessionStorage/.test(["OnboardingScreen.jsx", "AuthScreen.jsx", "PendingScreen.jsx"].map((f) => strip(read(path.join(FRONTEND, "src/components/auth", f)))).join("\n") + strip(read(path.join(FRONTEND, "src/hooks/useAccountSession.js"))) + strip(read(path.join(FRONTEND, "src/features/auth/accountSession.js")))));

  // ======================================================================================================== helpers for the flows
  const makeWindow = (href = `${ORIGIN}/`, store = new Map()) => {
    const w = { assigned: [], replaced: [], store, location: {}, history: {}, sessionStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) } };
    const setHref = (hr) => { const u = new URL(hr, ORIGIN); Object.assign(w.location, { origin: u.origin, pathname: u.pathname, search: u.search, hash: u.hash, href: u.href }); };
    w.location.assign = (url) => { w.assigned.push(url); };
    w.history.replaceState = (_s, _t, url) => { w.replaced.push(String(url)); setHref(String(url)); };
    setHref(href); return w;
  };
  const settle = (p, ms = 600) => Promise.race([p.then(() => "settled"), sleep(ms).then(() => "pending")]);
  const hop = async (win) => { const r = await fetch(win.assigned.at(-1), { redirect: "manual" }); return r.status === 302 ? r.headers.get("location") : null; };
  const reset = () => { sess.resetAuthSession(); tokenMod.setAccessTokenSource(() => null); wsMod.setActiveWorkspace(""); Object.assign(idp.config, { authorize: "ok", tokenMode: "ok", discoveryMode: "ok", idTokenMode: "ok", googleMode: true, clientSecret: TEST_SECRET, extraClaims: {}, email: undefined, ttlSeconds: 3600 }); };
  const mk = (win, api, o = {}) => oidcMod.createOidcSession({ settings: { authority: idp.issuer, clientId: CLIENT_ID, redirectUri: "", scope: "openid profile email", audience: "", tokenExchangeUrl: `${api}/auth/oidc/token`, providerLabel: "Google", autoRedirect: o.autoRedirect ?? false }, production: false, win, fetchImpl: fetch });
  /** A full sign-in as `sub` through the real flow against the backend at `api`. */
  const signedIn = async (sub, api = API_ON) => {
    reset(); idp.config.sub = sub;
    const w1 = makeWindow(`${ORIGIN}/`); const s1 = mk(w1, api, { autoRedirect: true }); await settle(s1.initOidcAuth());
    const w2 = makeWindow(await hop(w1), w1.store); const s2 = mk(w2, api); await s2.initOidcAuth();
    return { win: w2, session: s2 };
  };
  const authed = (api, p, init = {}) => fetch(`${api}${p}`, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${tokenMod.getAccessToken()}`, "content-type": "application/json" } });
  const counts = async () => ({ users: await User.countDocuments(), workspaces: await Workspace.countDocuments(), memberships: await WorkspaceMembership.countDocuments() });

  // ======================================================================================================== B. self-service ON
  console.log("\n# B. a real backend with self-service setup ON: new Google user -> onboarding -> own workspace -> app");
  await signedIn(S.fresh1);
  check("B1 [real Google-style sign-in, brand-new person] the identity authenticates and EOI has no account for them yet", sess.getAuthState().status === "ready" && (await User.countDocuments({ subject: S.fresh1 })) === 0);
  const before = await counts();
  const r1 = await accountMod.resolveAccount({ getAccountSession: apiMod.getAccountSession, preferredId: A });
  check("B2 the account step answers 'needsSetup' (the short onboarding), not 'not registered' and not 'access denied', and the check itself creates NOTHING", r1.kind === "needsSetup" && JSON.stringify(await counts()) === JSON.stringify(before));
  const bad = await accountMod.setUpAccount({ registerAccount: apiMod.registerAccount, workspaceName: "x", preferredId: A });
  check("B3 an invalid workspace name is refused with a plain sentence from the server's own validation, and nothing is created", bad.ok === false && /name|character/i.test(bad.message) && JSON.stringify(await counts()) === JSON.stringify(before), bad.message);
  const setup = await accountMod.setUpAccount({ registerAccount: apiMod.registerAccount, workspaceName: "Harbour View Apartments", preferredId: A });
  const fresh1User = await User.findOne({ subject: S.fresh1 }).lean();
  const fresh1Members = fresh1User ? await WorkspaceMembership.find({ userId: fresh1User._id }).lean() : [];
  check("B4 [new user onboarding] setup creates the person's User, ONE new workspace and ONE admin membership in THAT workspace only - and the app is told to open it ('ready')", setup.ok && setup.result.kind === "ready" && setup.result.workspaceId !== A && fresh1Members.length === 1 && String(fresh1Members[0].workspaceId) === setup.result.workspaceId && fresh1Members[0].role === "admin", JSON.stringify(setup.result));
  wsMod.setActiveWorkspace(setup.result.workspaceId);
  const own = await authed(API_ON, `/properties?workspaceId=${wsMod.KOI_WORKSPACE_ID}`); const foreign = await authed(API_ON, `/properties?workspaceId=${A}`);
  check("B5 [workspace authorization] the new workspace works for its administrator (200), while the pre-existing workspace is a safe 404 for them: a new account never receives access to anyone else's workspace", own.status === 200 && foreign.status === 404, `own ${own.status}, existing ${foreign.status}`);
  const again = await accountMod.setUpAccount({ registerAccount: apiMod.registerAccount, workspaceName: "Second try", preferredId: A });
  check("B6 setting up twice never creates a second workspace: the server answers 'conflict' and nothing more is created", again.ok === false && again.conflict === true && (await WorkspaceMembership.countDocuments({ userId: fresh1User._id })) === 1 && (await Workspace.countDocuments({ name: "Second try" })) === 0, again.message);
  const reload = await signedIn(S.fresh1); const r2 = await accountMod.resolveAccount({ getAccountSession: apiMod.getAccountSession, preferredId: A });
  check("B7 [returning new user] after a reload and a fresh sign-in the SAME person goes straight in (ready, their own workspace) with no second onboarding", r2.kind === "ready" && r2.workspaceId === setup.result.workspaceId && [...reload.win.store.entries()].every(([k, v]) => k === "koi.oidc.session" && v === "1"));
  await signedIn(S.existing); const r3 = await accountMod.resolveAccount({ getAccountSession: apiMod.getAccountSession, preferredId: A }); const before3 = await counts();
  check("B8 [existing user] a person an administrator already added goes straight in as the role they were given (their configured workspace), with no onboarding and no new workspace", r3.kind === "ready" && r3.workspaceId === A && JSON.stringify(await counts()) === JSON.stringify(before3));
  const sOps = await (await authed(API_ON, "/auth/session")).json();
  check("B9 [role comes from the server] the operator's session reports role 'operator' (never admin, never what the browser might claim)", sOps.data?.workspaces?.length === 1 && sOps.data.workspaces[0].role === "operator");
  await signedIn(S.fresh2); const setup2 = await accountMod.setUpAccount({ registerAccount: apiMod.registerAccount, workspaceName: "Second Owner Ltd", preferredId: setup.result.workspaceId });
  check("B10 [no cross-person access] a second new person gets their OWN workspace; their 'preferred' workspace (the first person's) is ignored and never opened", setup2.ok && setup2.result.kind === "ready" && setup2.result.workspaceId !== setup.result.workspaceId && setup2.result.workspaceId !== A);
  wsMod.setActiveWorkspace(setup2.result.workspaceId);
  const crossA = await authed(API_ON, `/properties?workspaceId=${setup.result.workspaceId}`); const crossB = await authed(API_ON, `/properties?workspaceId=${A}`);
  check("B11 the second person cannot read the first person's workspace or the existing one (safe 404 for both)", crossA.status === 404 && crossB.status === 404);
  await signedIn(S.hostile);
  const hostile = await authed(API_ON, "/auth/register", { method: "POST", body: JSON.stringify({ workspaceName: "Hostile Corp", role: "admin", workspaceId: A, userId: String(fresh1User._id), status: "active", issuer: "https://evil.example", subject: S.existing }) });
  const hostileBody = await hostile.json(); const hostileUser = await User.findOne({ subject: S.hostile }).lean(); const hostileMembers = hostileUser ? await WorkspaceMembership.find({ userId: hostileUser._id }).lean() : [];
  check("B12 [no client-controlled escalation] a hand-crafted registration naming another workspace, a role, a user id or another identity is created ONLY for the verified identity: one new workspace, admin there, nothing in the existing workspace", hostile.status === 201 && hostileMembers.length === 1 && String(hostileMembers[0].workspaceId) !== A && hostileUser.subject === S.hostile && hostileBody.data?.workspaces?.length === 1 && hostileBody.data.workspaces[0].id !== A);
  check("B13 the existing workspace's membership list is exactly what the administrator set up (two users added directly); registration never added anyone to it", (await WorkspaceMembership.countDocuments({ workspaceId: wsA._id })) === 2);
  await signedIn(S.disabled); const rDis = await accountMod.resolveAccount({ getAccountSession: apiMod.getAccountSession, preferredId: A });
  check("B14 a disabled account resolves to 'disabled' (Account unavailable) even though self-service is ON - it can neither enter nor re-register", rDis.kind === "disabled");
  const disReg = await accountMod.setUpAccount({ registerAccount: apiMod.registerAccount, workspaceName: "Sneaky Workspace", preferredId: A });
  check("B15 and a disabled account's registration attempt is refused", disReg.ok === false && disReg.disabled === true);

  // ======================================================================================================== C. self-service OFF
  console.log("\n# C. a real backend with self-service setup OFF: administrator-controlled access stays intact");
  await signedIn(S.restricted, API_OFF); const beforeC = await counts();
  const rawOff = await (await authed(API_OFF, "/auth/session")).json();
  const offResult = accountMod.interpretSession(rawOff.data, A);
  check("C1 a brand-new Google person on a deployment without self-service gets 'restricted' (an administrator must grant access) - and the session check created NOTHING", offResult.kind === "restricted" && JSON.stringify(await counts()) === JSON.stringify(beforeC));
  const offReg = await authed(API_OFF, "/auth/register", { method: "POST", body: JSON.stringify({ workspaceName: "Try Anyway" }) });
  check("C2 registering anyway is refused by the SERVER (403), nothing is created: the boundary is not a client-side choice", offReg.status === 403 && JSON.stringify(await counts()) === JSON.stringify(beforeC));
  await signedIn(S.existing, API_OFF); const offExisting = accountMod.interpretSession((await (await authed(API_OFF, "/auth/session")).json()).data, A);
  check("C3 an administrator-provisioned user still signs in normally on the same deployment (existing behaviour intact)", offExisting.kind === "ready" && offExisting.workspaceId === A);

  // ======================================================================================================== D. sign out
  console.log("\n# D. sign-out and session end");
  const so = await signedIn(S.existing); const tokenBefore = tokenMod.getAccessToken();
  so.session.signOut();
  const afterOut = await (async () => { try { await apiMod.getAccountSession(); return null; } catch (e) { return e; } })();
  check("D1 sign-out clears the in-memory token and the session; the account call then fails locally (401) without contacting the server; the page returns to the signed-out screen", Boolean(tokenBefore) && so.session.getMemoryToken() === null && tokenMod.getAccessToken() === null && sess.getAuthState().reason === "signedOut" && afterOut?.status === 401);
  const hookSrc = strip(read(path.join(FRONTEND, "src/hooks/useAccountSession.js")));
  check("D2 leaving the signed-in state clears the active workspace (the hook's cleanup), so a second person on the same browser can never inherit the first person's workspace", /setActiveWorkspace\(""\)/.test(hookSrc) && /return \(\) => \{[\s\S]*cancelled = true;[\s\S]*setActiveWorkspace\(""\)/.test(hookSrc));
  check("D3 after sign-out only the signed-out flag is stored (the signed-in marker is removed) (no token, no account data) and signing in again is possible", [...so.win.store.keys()].every((k) => ["koi.oidc.signedOut"].includes(k)) && ![...so.win.store.values()].some((v) => /eyJ/.test(v)));


  // ======================================================================================================== F. Phase 45D: journey states, wording, idempotency
  console.log("\n# F. the journey state machine, friendly failures and safe-to-repeat setup");
  const journeyMod = await vite.ssrLoadModule("/src/features/auth/authJourney.js");
  const { deriveJourney, JOURNEY } = journeyMod;
  const A_ = (status, reason = null, signingIn = false) => ({ status, reason, signingIn });
  const C_ = (state, busy = false) => ({ state, busy });
  check("F1 every named journey state is reachable", new Set([
    deriveJourney(A_("blocked", "signedOut"), C_("ready")), deriveJourney(A_("blocked", "welcome", true), C_("ready")), deriveJourney(A_("ready"), C_("checking")),
    deriveJourney(A_("ready"), C_("needsSetup")), deriveJourney(A_("ready"), C_("needsSetup", true)), deriveJourney(A_("ready"), C_("ready")),
    deriveJourney(A_("blocked", "cancelled"), C_("ready")), deriveJourney(A_("blocked", "accountDisabled"), C_("ready")), deriveJourney(A_("blocked", "linkRequired"), C_("ready")), deriveJourney(A_("sessionEnded", "expired"), C_("ready")),
  ]).size === Object.keys(JOURNEY).length);
  // exhaustive: no combination of the two stores can draw the application together with a sign-in / onboarding screen
  const statuses = ["ready", "sessionEnded", "blocked"]; const allReasons = [null, "expired", "rejected", "missing", "signedOut", "callbackFailed", "cancelled", "networkFailed", "signInUnavailable", "notConfigured", "welcome", "accessRestricted", "accountDisabled", "accountCheckFailed"];
  let contradictions = 0; let combos = 0;
  for (const st of statuses) for (const rs of allReasons) for (const si of [false, true]) for (const as of ["checking", "ready", "needsSetup", "failed"]) for (const busy of [false, true]) {
    combos += 1; const j = deriveJourney(A_(st, rs, si), C_(as, busy));
    if (j === JOURNEY.AUTHENTICATED && (st !== "ready" || as !== "ready")) contradictions += 1; // the app only with a ready sign-in AND a ready account
    if ((j === JOURNEY.ONBOARDING || j === JOURNEY.CREATING_WORKSPACE) && (st !== "ready" || as !== "needsSetup")) contradictions += 1;
    if (st !== "ready" && [JOURNEY.CHECKING_ACCOUNT, JOURNEY.ONBOARDING, JOURNEY.CREATING_WORKSPACE, JOURNEY.AUTHENTICATED].includes(j)) contradictions += 1; // signed out / expired never shows account screens
  }
  check("F2 [no contradictory screens] over every combination of sign-in status, reason, 'starting' flag and account state, the app / onboarding / account-check screens are never chosen while signed out, expired or blocked", contradictions === 0 && combos > 500, `${combos} combinations`);
  check("F3 an expired / rejected session is the SESSION_EXPIRED screen (the app is replaced, not left half-working) and the sign-in click while starting is AUTHENTICATING", deriveJourney(A_("sessionEnded", "expired"), C_("ready")) === JOURNEY.SESSION_EXPIRED && deriveJourney(A_("sessionEnded", "rejected"), C_("ready")) === JOURNEY.SESSION_EXPIRED && deriveJourney(A_("blocked", "signedOut", true), C_("ready")) === JOURNEY.AUTHENTICATING);

  // wording: every state's text is plain product language and the user's own examples are present
  const wordingFor = (reason) => `${sess.authTitle(reason)} ${sess.authDetail(reason)}`;
  check("F4 the cancelled / failed / no-connection / unavailable / expired sentences are the plain ones the product promises", sess.authMessage("cancelled") === "Sign-in was cancelled. You can try again whenever you're ready." && sess.authMessage("callbackFailed") === "We couldn't complete sign-in. Please try again." && sess.authMessage("networkFailed") === "We couldn't reach EOI. Check your connection and try again." && sess.authMessage("accountDisabled") === "Your EOI account is currently unavailable. Please contact your administrator." && sess.authMessage("expired") === "Your session has expired. Please sign in again to continue." && Object.values(sess.AUTH_REASON).every((r) => !FORBIDDEN.test(wordingFor(r))));

  // cancel / failure classification through the REAL session code
  const cbWin = (query, store) => makeWindow(`${ORIGIN}/${query}`, store);
  const txStore = () => new Map([["koi.oidc.transaction", JSON.stringify({ state: "STATE123", verifier: "v".repeat(50), returnTo: "/operations/signals", at: Date.now() })]]);
  const settle2 = async (query, fetchImpl) => { reset(); const w = cbWin(query, txStore()); const sx = oidcMod.createOidcSession({ settings: { authority: idp.issuer, clientId: CLIENT_ID, redirectUri: "", scope: "openid profile email", audience: "", tokenExchangeUrl: `${API_ON}/auth/oidc/token`, providerLabel: "Google", autoRedirect: false }, production: false, win: w, fetchImpl: fetchImpl ?? fetch, timeoutMs: 800 }); await sx.initOidcAuth(); return { w, state: sess.getAuthState() }; };
  const cancelled = await settle2("?error=access_denied&state=STATE123");
  check("F5 [Google cancelled] the provider's 'access_denied' is the friendly cancelled state: no redirect, no token, the address bar cleaned, the provider's word nowhere on screen", cancelled.state.reason === "cancelled" && cancelled.w.assigned.length === 0 && cancelled.w.replaced.every((u) => !/error|state=/.test(u)) && !/access_denied/.test(wordingFor("cancelled")));
  const otherErr = await settle2("?error=server_error&state=STATE123");
  check("F6 any other provider error is the general 'we couldn't complete sign-in' state (not 'cancelled')", otherErr.state.reason === "callbackFailed");
  const offline = await settle2("?code=abc&state=STATE123", async () => { throw new TypeError("Failed to fetch"); });
  check("F7 [network failure] a connection failure during the code exchange is the 'we couldn't reach EOI' state, with no token and no second redirect, and the address returns to the page the person was on (so 'Try again' comes back to it)", offline.state.reason === "networkFailed" && offline.w.assigned.length === 0 && offline.w.replaced.at(-1) === "/operations/signals" && offline.w.replaced.every((u) => !/code=|state=/.test(u)));
  const rejectedExchange = await settle2("?code=abc&state=STATE123", async () => new Response(JSON.stringify({ success: false }), { status: 502, headers: { "content-type": "application/json" } }));
  check("F8 an exchange the server refuses is the general failure state (an answer is not a connection problem)", rejectedExchange.state.reason === "callbackFailed");
  const forged = await settle2("?code=abc&state=SOMETHING-ELSE");
  check("F9 a callback whose state does not match is refused (general failure) and nothing is exchanged", forged.state.reason === "callbackFailed");

  // signing-in busy state
  reset(); { const w = makeWindow(`${ORIGIN}/`); const sx = mk(w, API_ON); sess.configureAuthLifecycle({ tokenRequired: true, signInAvailable: true }); const before = sess.getAuthState().signingIn; const p = sx.signIn(); await sleep(30); const during = sess.getAuthState().signingIn; await settle(p, 400);
    check("F10 pressing 'Continue with Google' marks the screen busy at once (so the click is never silent) and the button is disabled while busy", before === false && during === true && /disabled=\{signingIn\}/.test(strip(read(path.join(FRONTEND, "src/components/auth/SignInButton.jsx")))) && /aria-busy/.test(read(path.join(FRONTEND, "src/components/auth/SignInButton.jsx")))); }
  reset();

  // workspace-name validation (client rule mirrors the server's; the server is the authority)
  const { workspaceNameProblem } = await vite.ssrLoadModule("/src/components/auth/OnboardingScreen.jsx");
  check("F11 workspace name: empty, whitespace-only, one character, over-long and angle-bracket names each get a plain inline sentence; a normal name passes", ["", "   \t ", "a", "x".repeat(81), "<script>alert(1)</script>"].every((n) => workspaceNameProblem(n) !== "") && workspaceNameProblem("Harbour View Apartments") === "" && workspaceNameProblem("  Two   Spaces  ") === "");

  // --- idempotency against the real backend (self-service ON): concurrency, retries, lost responses
  await signedIn("888888888888888888881");
  const reg = (body) => authed(API_ON, "/auth/register", { method: "POST", body: JSON.stringify(body) });
  const beforeIdem = await counts();
  const burst = await Promise.all(Array.from({ length: 8 }, () => reg({ workspaceName: "Burst Workspace" })));
  const statuses2 = burst.map((r) => r.status).sort();
  const u8 = await User.findOne({ subject: "888888888888888888881" }).lean();
  const afterIdem = await counts();
  check("F12 [double click / 8 simultaneous requests] exactly ONE succeeds; the rest are conflicts; exactly one user, one workspace and one admin membership exist", statuses2.filter((c) => c === 201).length === 1 && statuses2.filter((c) => c === 409).length === 7 && afterIdem.users - beforeIdem.users === 1 && afterIdem.workspaces - beforeIdem.workspaces === 1 && afterIdem.memberships - beforeIdem.memberships === 1 && (await WorkspaceMembership.countDocuments({ userId: u8._id, role: "admin" })) === 1, statuses2.join(","));
  const retryAfterLostResponse = await accountMod.completeSetUp({ registerAccount: apiMod.registerAccount, getAccountSession: apiMod.getAccountSession, workspaceName: "Burst Workspace", preferredId: "", wait: async () => {} });
  check("F13 [retry after a lost response / refresh during creation] repeating the setup enters the EXISTING workspace (ok, ready) and creates nothing more", retryAfterLostResponse.ok === true && retryAfterLostResponse.result.kind === "ready" && JSON.stringify(await counts()) === JSON.stringify(afterIdem));
  const sessionNow = await (await authed(API_ON, "/auth/session")).json();
  check("F14 the person has exactly one workspace and is its admin; the session endpoint reports it (role from the server)", sessionNow.data.workspaces.length === 1 && sessionNow.data.workspaces[0].role === "admin" && sessionNow.data.workspaces[0].id === retryAfterLostResponse.result.workspaceId);
  await signedIn("888888888888888888882");
  const badNames = await Promise.all(["", "   ", "x", "y".repeat(500), "<b>x</b>", 12345, null, { $gt: "" }].map((n) => reg({ workspaceName: n })));
  check("F15 [server-side validation] empty, whitespace-only, one-character, 500-character, markup, numeric, null and operator-object names are all refused with 400 and nothing is created", badNames.every((r) => r.status === 400) && (await User.countDocuments({ subject: "888888888888888888882" })) === 0);
  const hostile2 = await reg({ workspaceName: "Hostile Two", role: "admin", workspaceId: A, userId: String(u8._id), subject: S.existing, issuer: "https://evil.example", status: "active", membership: { role: "admin", workspaceId: A } });
  const h2 = await User.findOne({ subject: "888888888888888888882" }).lean();
  const h2Members = await WorkspaceMembership.find({ userId: h2._id }).lean();
  check("F16 [browser cannot choose role / identity / another workspace] extra fields naming admin, another workspace, another user or another identity are ignored: the caller gets ONE new workspace as admin and nothing in the existing one", hostile2.status === 201 && h2Members.length === 1 && String(h2Members[0].workspaceId) !== A && h2.subject === "888888888888888888882" && (await WorkspaceMembership.countDocuments({ workspaceId: wsA._id })) === 2);


  // --- reload / restore (Phase 45D): a reload of a tab that was signed in restores the session; a fresh visit and a signed-out tab do not
  const inTab = await signedIn(S.existing); // signs in through the real flow; the tab now carries the non-credential marker
  const reloadWin = makeWindow(`${ORIGIN}/operations/signals`, inTab.win.store); reset(); const reloaded = mk(reloadWin, API_ON); await settle(reloaded.initOidcAuth(), 700);
  const restoreAuthUrl = reloadWin.assigned[0] ? new URL(reloadWin.assigned[0]) : null;
  check("F17 [reload restores the session] reloading a signed-in tab makes the ONE redirect to the provider (no welcome screen), remembering the page it was on; the marker is consumed", reloadWin.assigned.length === 1 && restoreAuthUrl?.pathname === "/authorize" && JSON.parse(reloadWin.store.get("koi.oidc.transaction")).returnTo === "/operations/signals" && !reloadWin.store.has("koi.oidc.session") && sess.getAuthState().signingIn !== true);
  reset(); const freshWin = makeWindow(`${ORIGIN}/`); const freshSession = mk(freshWin, API_ON); await freshSession.initOidcAuth();
  check("F18 a fresh visit (a new tab: no marker) is still the welcome screen with nothing contacted", sess.getAuthState().reason === "welcome" && freshWin.assigned.length === 0);
  reset(); const outTab = await signedIn(S.existing); outTab.session.signOut();
  const afterOutWin = makeWindow(`${ORIGIN}/`, outTab.win.store); reset(); await mk(afterOutWin, API_ON).initOidcAuth();
  check("F19 sign-out removes the marker: reloading after sign-out stays on the signed-out screen with no redirect (the provider's own session is never used to sign the person back in behind their back)", sess.getAuthState().reason === "signedOut" && afterOutWin.assigned.length === 0 && !afterOutWin.store.has("koi.oidc.session"));
  // a restore that fails does not repeat on its own: the next reload is a plain welcome screen
  reset(); idp.config.sub = S.existing; idp.config.authorize = "ok"; const loopTab = await signedIn(S.existing);
  reset(); idp.config.authorize = "error"; const restoreWin = makeWindow(`${ORIGIN}/`, loopTab.win.store); const restoring = mk(restoreWin, API_ON); await settle(restoring.initOidcAuth(), 700);
  const errCallback = await hop(restoreWin); const cbWin2 = makeWindow(errCallback, restoreWin.store); reset(); await mk(cbWin2, API_ON).initOidcAuth(); const afterFailed = sess.getAuthState().reason;
  const nextReload = makeWindow(`${ORIGIN}/`, cbWin2.store); reset(); await mk(nextReload, API_ON).initOidcAuth();
  check("F20 [no loop] a restore that ends in a provider error shows the friendly state, and the NEXT reload is the plain welcome screen (no automatic redirect again)", afterFailed === "cancelled" && sess.getAuthState().reason === "welcome" && nextReload.assigned.length === 0);
  reset();

  // ======================================================================================================== E. production bundle and the operator tool
  console.log("\n# E. production bundle and the operator tool");
  const jsonPath = (() => { const dir = path.join(os.homedir(), "Downloads"); try { const f = fs.readdirSync(dir).find((n) => /^client_secret_.+\.apps\.googleusercontent\.com\.json$/.test(n)); return path.join(dir, f ?? "client_secret.json"); } catch { return path.join(dir, "client_secret.json"); } })();
  const realSecret = fs.existsSync(jsonPath) ? (JSON.parse(read(jsonPath)).web?.client_secret ?? "") : "";
  const viteBin = path.join(FRONTEND, "node_modules", "vite", "bin", "vite.js");
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "eoi-p45cfe-")); tmpDirs.push(out);
  const SENT = "sentinel-secret-9d41ce07";
  const env = { ...process.env, OIDC_EXCHANGE_CLIENT_SECRET: SENT, VITE_DEV_ACCESS_TOKEN: SENT, NODE_ENV: "production" };
  const b = spawnSync(process.execPath, [viteBin, "build", "--mode", "google", "--outDir", out, "--emptyOutDir"], { cwd: FRONTEND, env, encoding: "utf8" });
  const dir = path.join(out, "assets"); const js = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => read(path.join(dir, f))).join("\n") : "";
  check("E1 a production build in Google mode succeeds", b.status === 0 && js.length > 1000);
  check("E2 the bundle carries the new journey wording (Welcome to EOI, New to EOI, Workspace name, Continue with, Loading your account, cancelled / connection / unavailable / expired sentences)", /Welcome to EOI/.test(js) && /New to EOI/.test(js) && /Workspace name/.test(js) && /Continue with/.test(js) && /Loading your account/.test(js) && /Sign-in was cancelled\. You can try again whenever you're ready\./.test(js) && /We couldn't reach EOI\. Check your connection and try again\./.test(js) && /Your EOI account is currently unavailable\. Please contact your administrator\./.test(js) && /Your session has expired\. Please sign in again to continue\./.test(js));
  check("E3 the bundle contains none of the old technical wording ('Account not registered', 'not registered for this workspace', 'No access to this workspace', 'Checking your access', 'does not create accounts itself')", !/Account not registered|not registered for this workspace|No access to this workspace|Checking your access|does not create accounts itself/.test(js));
  check("E4 [no secret in the frontend] neither the real client secret, a GOCSPX value, the injected sentinel, an OAuth JSON nor a token appears in the production bundle", !(realSecret && js.includes(realSecret)) && !js.includes(SENT) && !/GOCSPX|client_secret|"web":\{"client_id|eyJ[A-Za-z0-9_-]{10,}\./.test(js));
  const provision = path.join(here, "provision-user.mjs"); const doc = read(path.join(BACKEND, "docs", "GOOGLE_OIDC_PHASE45B4.md"));
  check("E5 the operator provisioning tool still exists (administrators / deployment / testing) and the guide says it is NOT part of the normal user journey", fs.existsSync(provision) && /operator|administrator/i.test(doc) && /not (required|part of)/i.test(doc) && /provision-user/.test(doc));
  const cfgSrc = strip(read(path.join(FRONTEND, "src/services/api.js")));
  check("E6 the account endpoints send the verified Bearer token only; the registration body is exactly { workspaceName } (no role, no workspace, no identity is ever sent by the browser)", /registerAccount\(workspaceName\)[\s\S]{0,200}\{ workspaceName \}/.test(cfgSrc) && !/role|workspaceId/.test(cfgSrc.slice(cfgSrc.indexOf("export function registerAccount"), cfgSrc.indexOf("export function listProperties"))));
} finally {
  if (vite) await vite.close();
  for (const c of children) c.kill();
  await idp.close();
  try { await mongoose.connection.dropDatabase(); } catch { /* best effort */ }
  await mongoose.disconnect();
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
}
console.log(`\nPhase 45C frontend onboarding validation: ${passed} passed, ${failed} failed (isolated database ${DB_NAME} dropped; local Google-like provider - no real Google account was used)`);
process.exit(failed === 0 ? 0 : 1);
