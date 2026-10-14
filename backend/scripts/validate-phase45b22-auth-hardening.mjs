/**
 * Phase 45B.2.2 validation - the two defects Phase 45B.2.1 confirmed, and that nothing around them regressed.
 *
 *   node backend/scripts/validate-phase45b22-auth-hardening.mjs
 *
 *   DEFECT 1  the Sign out button is icon-only at <= 480px and had no accessible name
 *   DEFECT 2  a provider that accepts the connection and never answers left the app waiting forever on a blank page
 *
 * Every sign-in below runs against a LOCAL loopback test provider (scripts/lib/localOidcProvider.mjs). It proves the provider-neutral code
 * behaves; it says nothing about any real identity provider. No database, no backend, no model call.
 *
 *   A  Sign out accessible name
 *   B  discovery timeout (provider accepts and never answers)
 *   C  token-endpoint timeout (and discovery hanging during the callback)
 *   D  bootstrap notice ("Signing you in…") and its ordering in main.jsx
 *   E  unchanged: success with the DEFAULT timeout, deep link, immediate refusal, callback failure, logout, expiry / re-authentication
 *   F  static: every provider request is bounded, no automatic retry, no speculative reload / pageshow behaviour
 *   G  production build: no development token, the notice ships, nothing provider-specific
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(here, "..");
const FRONTEND = path.join(BACKEND, "..", "frontend");
const read = (p) => fs.readFileSync(p, "utf8");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, "$1");
let passed = 0; let failed = 0;
const check = (name, ok, detail = "") => { if (ok) { passed += 1; console.log(`PASS  ${name}${detail ? ` - ${detail}` : ""}`); } else { failed += 1; console.error(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const timed = async (fn) => { const t0 = performance.now(); const value = await fn(); return { value, ms: Math.round(performance.now() - t0) }; };

const { startLocalOidcProvider } = await import("./lib/localOidcProvider.mjs");
const idp = await startLocalOidcProvider({ audience: "eoi-api-45b22", clientId: "local-test-client" });
process.env.VITE_OIDC_AUTHORITY = idp.issuer;
process.env.VITE_OIDC_CLIENT_ID = "local-test-client";
delete process.env.VITE_DEV_ACCESS_TOKEN;
const tmpDirs = [];
let vite = null;
try {
  const { createServer } = await import(pathToFileURL(path.join(FRONTEND, "node_modules", "vite", "dist", "node", "index.js")).href);
  vite = await createServer({ root: FRONTEND, configFile: path.join(FRONTEND, "vite.config.js"), server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom", logLevel: "silent", optimizeDeps: { noDiscovery: true, include: [] } });
  const sess = await vite.ssrLoadModule("/src/services/auth/authSession.js");
  const tokenMod = await vite.ssrLoadModule("/src/services/auth/accessToken.js");
  const oidcMod = await vite.ssrLoadModule("/src/services/auth/oidc/oidcSession.js");
  const boot = await vite.ssrLoadModule("/src/services/auth/bootstrapNotice.js");
  const feRequire = createRequire(path.join(FRONTEND, "package.json"));
  const React = feRequire("react");
  const { renderToString } = feRequire("react-dom/server");
  const h = React.createElement;
  const SignOutButton = (await vite.ssrLoadModule("/src/components/auth/SignOutButton.jsx")).default;
  const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

  const ORIGIN = "http://localhost:5174";
  const makeWindow = (href = `${ORIGIN}/`, store = new Map()) => {
    const w = { assigned: [], replaced: [], store, location: {}, history: {}, sessionStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) } };
    const setHref = (hr) => { const u = new URL(hr, ORIGIN); Object.assign(w.location, { origin: u.origin, pathname: u.pathname, search: u.search, hash: u.hash, href: u.href }); };
    w.location.assign = (url) => { w.assigned.push(url); };
    w.history.replaceState = (_s, _t, url) => { w.replaced.push(String(url)); setHref(String(url)); };
    setHref(href);
    return w;
  };
  const baseSettings = { authority: idp.issuer, clientId: "local-test-client", redirectUri: "", scope: "openid profile email", audience: "" };
  const mk = (win, opts = {}) => oidcMod.createOidcSession({ settings: { ...baseSettings, ...(opts.settings || {}) }, production: false, win, ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}), ...(opts.now ? { now: opts.now } : {}) });
  const reset = () => { sess.resetAuthSession(); tokenMod.setAccessTokenSource(() => null); Object.assign(idp.config, { authorize: "ok", tokenMode: "ok", discoveryMode: "ok", sub: "user-1", ttlSeconds: 3600, extraClaims: {} }); };
  const hop = async (win) => { const r = await fetch(win.assigned.at(-1), { redirect: "manual" }); return r.status === 302 ? r.headers.get("location") : null; };
  const settle = (p, ms = 500) => Promise.race([p.then(() => "settled"), sleep(ms).then(() => "pending")]);
  const FORBIDDEN = /127\.0\.0\.1|localhost|:\d{4,5}|local-test-client|openid-configuration|timed out|timeout|abort|ECONN|fetch|VITE_|OIDC|Bearer|eyJ|code=|state=/i;

  // ======================================================================================================= A. Sign out accessible name
  console.log("\n# A. Sign out keeps an accessible name when its text is hidden");
  sess.resetAuthSession(); sess.configureAuthLifecycle({ tokenRequired: true, signInAvailable: true });
  const html = renderToString(h(SignOutButton));
  const button = /<button\b[^>]*>/.exec(html)?.[0] ?? "";
  check("A1 the Sign out button carries aria-label=\"Sign out\" (not a title, not hidden text)", /aria-label="Sign out"/.test(button) && !/\btitle=/.test(button), button);
  check("A2 the visible text is the same words, and the icon stays decorative (aria-hidden)", text(html) === "Sign out" && /aria-hidden="true"/.test(html));
  const css = read(path.join(FRONTEND, "src", "styles", "auth.css"));
  check("A3 the text is hidden only inside the <= 480px rule (the labelled presentation at 768 / 1280 is untouched)", /@media \(max-width: 480px\)\s*\{[^}]*\.signout-button span\s*\{\s*display:\s*none/.test(css) && (css.match(/\.signout-button span/g) || []).length === 1);
  check("A4 the control still renders only when sign-in is in use and the app is not on a sign-in screen", renderToString(h(SignOutButton)) !== "" && (sess.blockApp("signedOut"), renderToString(h(SignOutButton)) === ""));
  sess.resetAuthSession();

  // ======================================================================================================= B. discovery timeout
  console.log("\n# B. a provider that accepts the connection and never answers discovery");
  reset(); idp.config.discoveryMode = "hang"; idp.stats.discovery = 0; idp.stats.hung = 0; idp.stats.aborted = 0;
  let w = makeWindow(`${ORIGIN}/operations/signals?x=1`); let s = mk(w, { timeoutMs: 400 });
  const b1 = await timed(() => s.initOidcAuth());
  check("B1 the first load gives up within the timeout (400 ms test setting) instead of waiting forever", b1.ms >= 350 && b1.ms < 2000, `${b1.ms} ms`);
  check("B2 the user gets the visible 'Sign-in is unavailable' state (not a blank, not signed in)", sess.getAuthState().status === "blocked" && sess.getAuthState().reason === "signInUnavailable" && sess.authTitle("signInUnavailable") === "Sign-in is unavailable" && sess.authDetail("signInUnavailable") === "Please try again in a moment.");
  check("B3 no redirect was started, and no transaction or credential was stored", w.assigned.length === 0 && w.store.size === 0 && tokenMod.getAccessToken() === null);
  await sleep(300);
  check("B4 the underlying request was ABORTED (the provider saw the connection close), and it was made exactly once", idp.stats.discovery === 1 && idp.stats.aborted === 1, `${idp.stats.discovery} request / ${idp.stats.aborted} aborted`);
  await sleep(900);
  check("B5 no automatic retry: still one request a second after the failure, and still no redirect", idp.stats.discovery === 1 && w.assigned.length === 0);
  check("B6 the wording has no URL, port, client id, setting name or timeout detail", !FORBIDDEN.test([sess.authTitle("signInUnavailable"), sess.authDetail("signInUnavailable"), sess.authMessage("signInUnavailable")].join(" ")));
  const retry1 = await timed(() => s.signIn());
  check("B7 an explicit retry (the user's own click) is available, is bounded the same way and does not start a loop", retry1.ms < 2000 && idp.stats.discovery === 2 && sess.getAuthState().reason === "networkFailed" && w.assigned.length === 0, `${retry1.ms} ms`);
  idp.config.discoveryMode = "ok";
  await settle(s.signIn());
  check("B8 once the provider answers, the same explicit retry succeeds (one redirect, nothing sticky)", w.assigned.length === 1);

  // ======================================================================================================= C. token timeout
  console.log("\n# C. the token endpoint (and discovery during the callback) never answers");
  reset();
  w = makeWindow(`${ORIGIN}/operations/signals/abc/intelligence`); s = mk(w); await settle(s.initOidcAuth());
  const cb = await hop(w);
  idp.config.tokenMode = "hang"; idp.stats.token = 0; idp.stats.hung = 0; idp.stats.aborted = 0; idp.stats.authorize = 0;
  const wc = makeWindow(cb, w.store); const sc = mk(wc, { timeoutMs: 400 });
  const c1 = await timed(() => sc.initOidcAuth());
  check("C1 a hanging token endpoint ends the callback within the timeout", c1.ms >= 350 && c1.ms < 2000, `${c1.ms} ms`);
  check("C2 a token endpoint that never answers gives the explicit 'we couldn't reach EOI' screen state (the no-connection wording), not a hang", sess.getAuthState().status === "blocked" && sess.getAuthState().reason === "networkFailed" && sess.authMessage("networkFailed") === "We couldn't reach EOI. Check your connection and try again.");
  check("C3 no token was kept anywhere: not in memory, not for the API layer, not in storage, not in the URL or history", sc.getMemoryToken() === null && tokenMod.getAccessToken() === null && ![...wc.store.values()].some((v) => /eyJ/.test(v)) && wc.replaced.every((u) => !/code=|state=|eyJ/.test(u)) && !wc.store.has("koi.oidc.transaction"));
  await sleep(300);
  check("C4 the token request was aborted, made once, and there is no redirect and no automatic retry", idp.stats.token === 1 && idp.stats.aborted === 1 && wc.assigned.length === 0 && idp.stats.authorize === 0, `${idp.stats.token} request / ${idp.stats.aborted} aborted`);
  await sleep(900);
  check("C5 a second later nothing further happened (no retry, no loop)", idp.stats.token === 1 && wc.assigned.length === 0);
  check("C6 the failure wording shows no URL, token, code, state or timeout detail", !FORBIDDEN.test([sess.authTitle("callbackFailed"), sess.authDetail("callbackFailed"), sess.authMessage("callbackFailed")].join(" ")));
  reset();
  w = makeWindow(`${ORIGIN}/ops`); s = mk(w); await settle(s.initOidcAuth());
  const cb2 = await hop(w);
  idp.config.discoveryMode = "hang";
  const wd = makeWindow(cb2, w.store); const sd = mk(wd, { timeoutMs: 400 });
  const c7 = await timed(() => sd.initOidcAuth());
  check("C7 discovery hanging while handling the callback also ends in the callback-failure state within the timeout, with no token", c7.ms < 2000 && sess.getAuthState().reason === "networkFailed" && sd.getMemoryToken() === null && wd.assigned.length === 0, `${c7.ms} ms`);

  // ======================================================================================================= D. bootstrap notice
  console.log("\n# D. the pre-React 'Signing you in…' notice");
  const fakeDoc = { createElement: (tag) => ({ tag, className: "", textContent: "", attrs: {}, children: [], setAttribute(k, v) { this.attrs[k] = v; }, append(...c) { this.children.push(...c); } }) };
  const container = { children: ["previous"], replaceChildren(...c) { this.children = c; } };
  boot.showSigningIn(container, fakeDoc);
  const flat = (n) => (typeof n === "string" ? n : [n.textContent, ...(n.children || []).map(flat)].join(" "));
  const shown = container.children.map(flat).join(" ").replace(/\s+/g, " ").trim();
  check("D1 the notice says 'Signing you in…', announces itself as a status, and replaces whatever was in the root", /Signing you in…/.test(shown) && boot.SIGNING_IN_TEXT === "Signing you in…" && JSON.stringify(container).includes('"role":"status"') && !container.children.includes("previous"));
  check("D2 it contains no provider address, setting name, identifier or token information", !FORBIDDEN.test(shown));
  const mainSrc = strip(read(path.join(FRONTEND, "src", "main.jsx")));
  check("D3 main.jsx shows the notice only when sign-in is configured, BEFORE waiting for sign-in, and still renders React only after sign-in settles", mainSrc.indexOf("showSigningIn(") > -1 && /if \(isAuthEnabled\) showSigningIn\(/.test(mainSrc) && mainSrc.indexOf("showSigningIn(document") < mainSrc.indexOf("initOidcAuth()") && mainSrc.indexOf("initOidcAuth()") < mainSrc.indexOf("createRoot("));
  check("D4 the notice is built with DOM calls and textContent (no innerHTML)", !/innerHTML|insertAdjacentHTML|document\.write/.test(strip(read(path.join(FRONTEND, "src", "services", "auth", "bootstrapNotice.js")))));
  check("D5 the wait it covers is bounded: the longest first-load path (discovery) is one request deadline of at most 15 s", oidcMod.DEFAULT_REQUEST_TIMEOUT_MS >= 3000 && oidcMod.DEFAULT_REQUEST_TIMEOUT_MS <= 15000, `${oidcMod.DEFAULT_REQUEST_TIMEOUT_MS} ms`);

  // ======================================================================================================= E. unchanged behaviour (DEFAULT timeout)
  console.log("\n# E. unchanged behaviour with the production default timeout");
  reset();
  const deep = "/operations/signals/6ac494995352eda1be0e08a9/intelligence";
  w = makeWindow(`${ORIGIN}${deep}?tab=x#evidence`); s = mk(w); await settle(s.initOidcAuth());
  const cbOk = await hop(w);
  const wOk = makeWindow(cbOk, w.store); const sOk = mk(wOk);
  const e1 = await timed(() => sOk.initOidcAuth());
  check("E1 a normal local sign-in still works with the default timeout and is quick", sess.getAuthState().status === "ready" && Boolean(sOk.getMemoryToken()) && e1.ms < 3000, `${e1.ms} ms`);
  check("E2 deep-link restoration still works (path, query and hash)", wOk.location.pathname + wOk.location.search + wOk.location.hash === `${deep}?tab=x#evidence` && wOk.replaced.every((u) => !/code=|state=/.test(u)));
  check("E3 no token in storage or history after sign-in", ![...wOk.store.values()].some((v) => v.includes(sOk.getMemoryToken())) && ![...wOk.replaced].some((u) => u.includes(sOk.getMemoryToken())));
  sOk.signOut();
  check("E4 logout still clears the token and shows the signed-out state", sOk.getMemoryToken() === null && tokenMod.getAccessToken() === null && sess.getAuthState().reason === "signedOut");
  reset();
  const dead = mk(makeWindow(`${ORIGIN}/`), { settings: { authority: "http://127.0.0.1:1" } });
  const e5 = await timed(() => dead.initOidcAuth());
  check("E5 immediate provider refusal is still immediate (well under the timeout) and ends in 'unavailable'", e5.ms < 3000 && sess.getAuthState().reason === "signInUnavailable", `${e5.ms} ms`);
  reset(); idp.config.authorize = "error"; idp.stats.authorize = 0;
  w = makeWindow(`${ORIGIN}/ops`); s = mk(w); await settle(s.initOidcAuth());
  const errCb = await hop(w); const authBefore = idp.stats.authorize;
  const wf = makeWindow(errCb, w.store); const sf = mk(wf); await sf.initOidcAuth();
  check("E6 a provider error is still an explicit, friendly state (cancelled) with no second redirect and a clean URL", sess.getAuthState().reason === "cancelled" && wf.assigned.length === 0 && idp.stats.authorize === authBefore && wf.replaced.every((u) => !/error|code=|state=/.test(u)));
  reset();
  let clock = Date.now();
  w = makeWindow(`${ORIGIN}/ops`); s = mk(w, { now: () => clock }); await settle(s.initOidcAuth());
  const wx = makeWindow(await hop(w), w.store); const sx = mk(wx, { now: () => clock }); idp.config.ttlSeconds = 60; await sx.initOidcAuth();
  const live = tokenMod.getAccessToken();
  clock += 3600 * 1000;
  check("E7 expiry still works: after the token's lifetime the API layer is offered no token", Boolean(live) && tokenMod.getAccessToken() === null);
  const wr = makeWindow(`${ORIGIN}/ops`, new Map()); const sr = mk(wr);
  await settle(sr.signIn());
  check("E8 re-authentication ('Sign in again') still starts the normal flow", wr.assigned.length === 1);
  reset();

  // ======================================================================================================= F. static
  console.log("\n# F. static checks");
  const oidcSrc = strip(read(path.join(FRONTEND, "src", "services", "auth", "oidc", "oidcSession.js")));
  const fetchCalls = oidcSrc.match(/fetchImpl\(/g) || [];
  check("F1 every provider request goes through the bounded() deadline helper with an abort signal (discovery, token exchange and - unified session - the refresh; the only call without a deadline is the fire-and-forget logout (keepalive), which the page never waits for)", fetchCalls.length === 4 && /bounded\(async \(signal\) =>/.test(oidcSrc) && /bounded\(\(signal\) =>/.test(oidcSrc) && oidcSrc.split(/\r?\n/).filter((l) => /fetchImpl\(/.test(l)).every((l) => /signal|keepalive: true/.test(l)) && !/[^.]\bfetch\(/.test(oidcSrc.replace(/globalThis\.fetch\(/g, "")));
  check("F2 the deadline aborts the underlying request (AbortController.abort) and rejects; it never retries", /controller\.abort\(\)/.test(oidcSrc) && !/for \(|while \(|retry|attempts/i.test(oidcSrc.replace(/Try again|retries|retry/g, (m) => (m === "Try again" ? m : ""))));
  const all = ["main.jsx", "services/auth/oidc/oidcSession.js", "services/auth/bootstrapNotice.js", "services/auth/authSession.js", "hooks/useAuthSession.js", "components/auth/AuthScreen.jsx"].map((f) => strip(read(path.join(FRONTEND, "src", f)))).join("\n");
  check("F3 no speculative bfcache handling was added: no pageshow handler, no location.reload, no history-driven navigation (the bfcache hypothesis remains UNVERIFIED)", !/pageshow|location\.reload|bfcache|persisted/.test(all));
  check("F4 the user-facing failure wording is unchanged and fixed (no timeout text reaches the UI)", sess.authMessage("signInUnavailable") === "Sign-in is unavailable. Please try again." || sess.authMessage("signInUnavailable") === "Sign-in is temporarily unavailable. Please try again.");

  // ======================================================================================================= G. production build
  console.log("\n# G. production build");
  const viteBin = path.join(FRONTEND, "node_modules", "vite", "bin", "vite.js");
  const build = (label, extraEnv) => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), `eoi-p45b22-${label}-`)); tmpDirs.push(out);
    const env = { ...process.env, ...extraEnv, NODE_ENV: "production" };
    for (const k of ["VITE_OIDC_AUTHORITY", "VITE_OIDC_CLIENT_ID", "VITE_DEV_ACCESS_TOKEN"]) if (!(k in extraEnv)) delete env[k];
    const r = spawnSync(process.execPath, [viteBin, "build", "--outDir", out, "--emptyOutDir"], { cwd: FRONTEND, env, encoding: "utf8" });
    const dir = path.join(out, "assets");
    const js = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => read(path.join(dir, f))).join("\n") : "";
    return { ok: r.status === 0, js };
  };
  const SENTINEL = "dev-token-sentinel-6b1d9e4a2c";
  const cfg = build("cfg", { VITE_OIDC_AUTHORITY: "https://issuer.example.test", VITE_OIDC_CLIENT_ID: "public-client-id-for-test", VITE_DEV_ACCESS_TOKEN: SENTINEL });
  const bare = build("bare", { VITE_DEV_ACCESS_TOKEN: SENTINEL });
  check("G1 production builds succeed with and without sign-in configuration", cfg.ok && bare.ok);
  check("G2 neither bundle contains the development token (a sentinel set at build time is absent) or its variable name", !cfg.js.includes(SENTINEL) && !bare.js.includes(SENTINEL) && !/VITE_DEV_ACCESS_TOKEN/.test(cfg.js + bare.js));
  check("G3 the configured bundle carries the 'Signing you in…' notice, the timeout and the Sign out accessible name; the bare one still shows 'Authentication is not configured'", /Signing you in…/.test(cfg.js) && /aria-label[^,}]{0,20}Sign out/.test(cfg.js) && /AbortController/.test(cfg.js) && /Authentication is not configured/.test(bare.js));
  check("G4 no client secret, private key, token, development hint or hard-coded provider in either bundle", ![cfg.js, bare.js].some((js) => /client_secret|BEGIN [A-Z ]*PRIVATE KEY|eyJ[A-Za-z0-9_-]{15,}\.|Configure a development|Development build: no sign-in|auth0\.com|okta\.com|keycloak|login\.microsoftonline|cognito-idp|accounts\.google\.com/i.test(js)));
  check("G5 `import.meta.env` is still only read by name (an aliased env object would ship the development token)", (() => { const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])).filter((f) => /\.jsx?$/.test(f)); return walk(path.join(FRONTEND, "src")).every((f) => !/import\.meta\.env(?![.\w])/.test(strip(read(f)))); })());
} finally {
  if (vite) await vite.close();
  await idp.close();
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
}

console.log(`\nPhase 45B.2.2 auth hardening validation: ${passed} passed, ${failed} failed (local test provider - no real identity provider was contacted; no database used)`);
process.exit(failed === 0 ? 0 : 1);
