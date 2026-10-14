/**
 * Phase 45B.4 validation - Google as the OIDC provider, through the EXISTING Authorization Code + PKCE architecture.
 *
 *   node backend/scripts/validate-phase45b4-google-oidc.mjs
 *
 * WHAT THIS PROVES AND WHAT IT DOES NOT. Sections A-E run against a LOCAL loopback provider that behaves like a Google "web" client (token endpoint
 * requires the client secret; opaque access token + ID token with aud = client id). They prove the integration logic. Section F talks to the REAL
 * Google, WITHOUT credentials and without signing anyone in: its public discovery document, its token endpoint's secret requirement, its JWKS
 * through the real verifier, and that it accepts this client's authorization request. NO Google account signs in here; a real browser sign-in
 * (a person entering their own Google credentials) is NOT performed by this suite.
 *
 *   A  the code exchange endpoint (real backend, isolated DB, local Google-like provider)
 *   B  authorization with Google-shaped ID tokens: identity = issuer + subject; membership; RBAC; claims ignored
 *   C  the SPA flow through the exchange (fake browser window, real backend): callback, deep link, failures, timeouts, sign-out, expiry
 *   D  rendered UI: "Sign in with Google"
 *   E  configuration contract (unit)
 *   F  the real Google, no credentials
 *   G  secrets: repository scan, git-ignore, production bundle
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
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
const timed = async (fn) => { const t0 = performance.now(); const value = await fn(); return { value, ms: Math.round(performance.now() - t0) }; };

// ---- isolated database (derived from the loopback URI BEFORE anything reads it; never printed)
{ const __u = dotenv.parse(process.getBuiltinModule("node:fs").readFileSync(new URL("../.env", import.meta.url))).MONGODB_URI ?? ""; if (/^mongodb:\/\/(?:[^@/]*@)?(localhost|127\.0\.0\.1)/i.test(__u)) process.env.MONGODB_URI ??= __u; } // validation / rehearsal tools take ONLY a loopback database URI from backend/.env, never its real settings
const baseUri = process.env.MONGODB_URI;
const stamp = Date.now();
const DB_NAME = `koi_p45b4_${stamp}`;
if (!baseUri || /^mongodb\+srv:|@/.test(baseUri) || !/^mongodb:\/\/(localhost|127\.0\.0\.1)/.test(baseUri)) { console.error("refusing: the configured MongoDB is not a plain loopback instance"); process.exit(2); }
process.env.MONGODB_URI = baseUri.replace(/(mongodb:\/\/[^/]+\/)([^?]*)/, `$1${DB_NAME}`);
process.env.NODE_ENV = "test";
for (const k of ["AUTH_STUB_SECRET", "AUTH_TOKEN_VERIFIER", "AUTH_PROVIDER", "OIDC_EXCHANGE_CLIENT_ID", "OIDC_EXCHANGE_CLIENT_SECRET", "OIDC_EXCHANGE_REDIRECT_URIS"]) delete process.env[k];

const mongoose = (await import("mongoose")).default;
const { connectDatabase } = await import("../src/config/database.js");
const { User, Workspace, WorkspaceMembership, Signal } = await import("../src/models/index.js");
await connectDatabase();
if (mongoose.connection.db.databaseName !== DB_NAME) { console.error("refusing: not connected to the isolated database"); process.exit(2); }

const { startLocalOidcProvider } = await import("./lib/localOidcProvider.mjs");
const { resolveExchangeConfig } = await import("../src/auth/oidcExchangeConfig.js");
const { createOidcTokenVerifier } = await import("../src/auth/oidcTokenVerifier.js");

const CLIENT_ID = "790571179268-test-client.apps.googleusercontent.com"; // a TEST value; the real client id is only read in section F
const TEST_SECRET = "test-client-secret-not-real-7f3a91c2";
const ORIGIN = "http://localhost:5175";
const REDIRECT = `${ORIGIN}/`;
const idp = await startLocalOidcProvider({ audience: CLIENT_ID, clientId: CLIENT_ID });
Object.assign(idp.config, { googleMode: true, clientSecret: TEST_SECRET });

const children = []; const servers = []; const tmpDirs = [];
const logs = { backend: "" };
let vite = null;
const PORT = 5481; const PORT_OFF = 5482;
const API = `http://localhost:${PORT}/api`;
try {
  const spawnBackend = (port, env) => {
    const child = spawn(process.execPath, [path.join(BACKEND, "server.js")], { env: { ...process.env, PORT: String(port), NODE_ENV: "test", CLIENT_URL: ORIGIN, KOI_RATE_LIMIT_ENABLED: "false", LLM_PROVIDER: "test-python", AI_SERVICE_URL: "http://localhost:5399", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (d) => { logs.backend += d.toString(); }); child.stderr.on("data", (d) => { logs.backend += d.toString(); });
    children.push(child);
    return child;
  };
  const waitUp = async (port) => { for (let i = 0; i < 100; i += 1) { try { if ((await fetch(`http://localhost:${port}/api/health`)).ok) return; } catch { /* starting */ } await sleep(200); } };
  spawnBackend(PORT, { AUTH_PROVIDER: "oidc", OIDC_ISSUER: idp.issuer, OIDC_AUDIENCE: CLIENT_ID, OIDC_EXCHANGE_CLIENT_ID: CLIENT_ID, OIDC_EXCHANGE_CLIENT_SECRET: TEST_SECRET, OIDC_EXCHANGE_REDIRECT_URIS: REDIRECT, OIDC_HTTP_TIMEOUT_MS: "1500" });
  spawnBackend(PORT_OFF, { AUTH_PROVIDER: "oidc", OIDC_ISSUER: idp.issuer, OIDC_AUDIENCE: CLIENT_ID });
  await waitUp(PORT); await waitUp(PORT_OFF);

  // ---- fixtures
  const wsA = await Workspace.create({ name: `P45B4 a ${stamp}`, slug: `p45b4-a-${stamp}`, status: "active" });
  const wsB = await Workspace.create({ name: `P45B4 b ${stamp}`, slug: `p45b4-b-${stamp}`, status: "active" });
  const A = String(wsA._id); const B = String(wsB._id);
  const mkUser = async (sub, role, ws, extra = {}) => { const user = await User.create({ issuer: extra.issuer ?? idp.issuer, subject: sub, status: extra.status ?? "active" }); if (role) await WorkspaceMembership.create({ userId: user._id, workspaceId: ws._id, role }); return user; };
  await mkUser("111111111111111111111", "admin", wsA);      // Google-style numeric subjects
  await mkUser("222222222222222222222", "viewer", wsA);
  await mkUser("333333333333333333333", "operator", wsB);
  await mkUser("444444444444444444444", null, null);       // known, no membership
  await mkUser("555555555555555555555", "operator", wsA, { status: "disabled" });
  await mkUser("666666666666666666666", "admin", wsA, { issuer: `${idp.issuer}/` }); // same subject type, DIFFERENT issuer string
  const S = { admin: "111111111111111111111", viewer: "222222222222222222222", opB: "333333333333333333333", noMember: "444444444444444444444", disabled: "555555555555555555555", unknown: "999999999999999999999", otherIssuer: "666666666666666666666" };
  const sigB = await Signal.create({ workspaceId: wsB._id, type: "maintenance", severity: "low", title: "B signal", description: "In B." });
  await Signal.create({ workspaceId: wsA._id, type: "maintenance", severity: "low", title: "A signal", description: "In A." });

  // ---- helpers: a PKCE pair, the provider's authorize hop, the exchange endpoint, and a bearer for a subject (the REAL path: authorize -> exchange)
  const pkce = () => { const v = crypto.randomBytes(48).toString("base64url"); return { v, c: crypto.createHash("sha256").update(v).digest("base64url") }; };
  const authorizeCode = async (challenge, redirect = REDIRECT) => {
    const u = new URL(`${idp.issuer}/authorize`);
    for (const [k, v] of Object.entries({ response_type: "code", client_id: CLIENT_ID, redirect_uri: redirect, scope: "openid profile email", state: "s-test", code_challenge: challenge, code_challenge_method: "S256" })) u.searchParams.set(k, v);
    const r = await fetch(u, { redirect: "manual" });
    return new URL(r.headers.get("location")).searchParams.get("code");
  };
  const seen = []; // every response the exchange endpoint produced (headers + body text): scanned for the secret
  const exchange = async (body, { port = PORT, raw, contentType = "application/json", headers = {} } = {}) => {
    const r = await fetch(`http://localhost:${port}/api/auth/oidc/token`, { method: "POST", headers: { "content-type": contentType, ...headers }, body: raw ?? JSON.stringify(body) });
    const text = await r.text(); seen.push(`${JSON.stringify([...r.headers])}${text}`);
    let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, json, text, headers: r.headers };
  };
  const reset = () => Object.assign(idp.config, { authorize: "ok", tokenMode: "ok", discoveryMode: "ok", idTokenMode: "ok", googleMode: true, clientSecret: TEST_SECRET, extraClaims: {}, email: undefined, ttlSeconds: 3600 });
  const bearerFor = async (sub, { email, claims } = {}) => {
    reset(); idp.config.sub = sub; idp.config.email = email; idp.config.extraClaims = claims ?? {};
    const { v, c } = pkce(); const code = await authorizeCode(c);
    const r = await exchange({ code, code_verifier: v, redirect_uri: REDIRECT });
    return r.json?.data?.access_token;
  };
  const call = async (method, url, token, body, port = PORT) => { const r = await fetch(`http://localhost:${port}/api${url}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }); let json = null; try { json = await r.json(); } catch { /* none */ } return { status: r.status, json, code: json?.details?.code, message: json?.message }; };

  // ======================================================================================================== A. the exchange endpoint
  console.log("\n# A. the server-side code exchange (real backend, isolated DB, local Google-like provider)");
  reset(); idp.config.sub = S.admin;
  let p = pkce(); let code = await authorizeCode(p.c);
  idp.stats.token = 0; idp.stats.tokenWithSecret = 0; idp.stats.tokenWithoutSecret = 0;
  const ok = await exchange({ code, code_verifier: p.v, redirect_uri: REDIRECT });
  check("A1 [AUTH-02] a valid code + PKCE verifier is exchanged for a Bearer token that expires in about an hour", ok.status === 200 && ok.json?.success === true && ok.json.data.token_type === "Bearer" && ok.json.data.expires_in > 3000 && ok.json.data.expires_in <= 3600 && ok.json.data.access_token.split(".").length === 3, `HTTP ${ok.status}, expires_in ${ok.json?.data?.expires_in}`);
  check("A2 the response carries ONLY access_token / token_type / expires_in: no opaque Google access token, no refresh token, no profile, no secret", JSON.stringify(Object.keys(ok.json?.data ?? {}).sort()) === JSON.stringify(["access_token", "expires_in", "token_type"]) && !ok.text.includes("ya29") && !ok.text.includes(TEST_SECRET) && !/refresh_token|client_secret|email_verified|picture/.test(ok.text) && ok.headers.get("cache-control") === "no-store");
  check("A3 the provider was contacted ONCE, by the backend, WITH the client secret (never without it)", idp.stats.token === 1 && idp.stats.tokenWithSecret === 1 && idp.stats.tokenWithoutSecret === 0);
  const idToken = ok.json.data.access_token;
  const claims = JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString());
  check("A4 the token returned is the provider's ID token: issuer and audience are the configured issuer and the OAuth client id", claims.iss === idp.issuer && claims.aud === CLIENT_ID && claims.sub === S.admin && typeof claims.email === "string");
  const me = await call("GET", `/signals?workspaceId=${A}`, idToken);
  check("A5 [AUTH-10] that token authenticates against the real API for a registered identity with an active membership", me.status === 200);
  const replay = await exchange({ code, code_verifier: p.v, redirect_uri: REDIRECT });
  check("A6 a code cannot be replayed (second use fails with the one generic answer)", replay.status === 400 && replay.json?.message === "Sign-in could not be completed" && replay.json?.details?.code === "SIGNIN_EXCHANGE_FAILED");
  p = pkce(); code = await authorizeCode(p.c);
  const wrongVerifier = await exchange({ code, code_verifier: pkce().v, redirect_uri: REDIRECT });
  check("A7 a wrong PKCE verifier is refused (the provider checks it), and the provider's wording is not echoed", wrongVerifier.status === 400 && !/invalid_grant|verifier|PKCE/i.test(wrongVerifier.text));
  idp.stats.token = 0;
  const wrongRedirect = await exchange({ code: "abc", code_verifier: p.v, redirect_uri: "http://localhost:6666/" });
  const wrongRedirect2 = await exchange({ code: "abc", code_verifier: p.v, redirect_uri: `${ORIGIN}/evil` });
  check("A8 a redirect URI outside the server's EXACT allow-list is refused BEFORE the provider is contacted", wrongRedirect.status === 400 && wrongRedirect2.status === 400 && idp.stats.token === 0);
  const bad = [{}, { code: 1, code_verifier: p.v, redirect_uri: REDIRECT }, { code: "a b", code_verifier: p.v, redirect_uri: REDIRECT }, { code: "x".repeat(3000), code_verifier: p.v, redirect_uri: REDIRECT }, { code: "abc", code_verifier: "short", redirect_uri: REDIRECT }, { code: "abc", code_verifier: p.v }, { code: "abc", code_verifier: "!".repeat(64), redirect_uri: REDIRECT }];
  const badResults = await Promise.all(bad.map((b) => exchange(b)));
  check("A9 missing, mistyped, malformed and oversized fields are all the same generic 400, and none reaches the provider", badResults.every((r) => r.status === 400 && r.json?.details?.code === "SIGNIN_EXCHANGE_FAILED") && idp.stats.token === 0);
  const nonJson = await exchange(null, { raw: "code=abc", contentType: "application/x-www-form-urlencoded" });
  const huge = await exchange(null, { raw: JSON.stringify({ code: "a".repeat(6000), code_verifier: p.v, redirect_uri: REDIRECT }) });
  const malformed = await exchange(null, { raw: "{not json" });
  check("A10 a non-JSON body is refused, an oversized body (> 4 KB) is 413, malformed JSON is 400", nonJson.status === 400 && huge.status === 413 && malformed.status === 400, `${nonJson.status}/${huge.status}/${malformed.status}`);

  for (const [mode, label, auth] of [["wrong-iss", "[AUTH-04] a wrong issuer", "AUTH-04"], ["wrong-aud", "[AUTH-05] a wrong audience", "AUTH-05"], ["expired", "[AUTH-06] an expired token", "AUTH-06"], ["bad-sig", "[AUTH-07] a tampered / foreign-signed token", "AUTH-07"], ["no-id-token", "a response with no ID token (opaque access token only)", ""]]) {
    reset(); idp.config.sub = S.admin; idp.config.idTokenMode = mode;
    const q = pkce(); const c2 = await authorizeCode(q.c);
    const r = await exchange({ code: c2, code_verifier: q.v, redirect_uri: REDIRECT });
    check(`A11 ${label} in the provider's answer is NEVER handed to the browser (the backend verifies the ID token first)`, r.status === 400 && !r.text.includes("eyJ") && !r.text.includes("access_token") && r.json?.details?.code === "SIGNIN_EXCHANGE_FAILED", `${mode}: HTTP ${r.status}`);
  }
  reset(); idp.config.sub = S.admin; idp.config.clientSecret = "a-different-secret";
  let q = pkce(); let c3 = await authorizeCode(q.c);
  const wrongSecret = await exchange({ code: c3, code_verifier: q.v, redirect_uri: REDIRECT });
  check("A12 when the provider rejects the CLIENT (wrong secret configured) the answer is still the one generic failure: no provider text, no secret", wrongSecret.status === 400 && !/invalid_client|Unauthorized|secret/i.test(wrongSecret.text));
  reset(); idp.config.tokenMode = "hang"; idp.stats.aborted = 0;
  q = pkce(); c3 = await authorizeCode(q.c);
  const slow = await timed(() => exchange({ code: c3, code_verifier: q.v, redirect_uri: REDIRECT }));
  await sleep(200);
  check("A13 [AUTH-18] a provider that never answers the token request is bounded (OIDC_HTTP_TIMEOUT_MS = 1.5 s here): a generic 503, the request aborted", slow.value.status === 503 && slow.value.json?.details?.code === "AUTH_PROVIDER_UNAVAILABLE" && slow.ms >= 1300 && slow.ms < 4000 && idp.stats.aborted >= 1, `${slow.ms} ms, HTTP ${slow.value.status}`);
  reset();
  const off = await exchange({ code: "abc", code_verifier: p.v, redirect_uri: REDIRECT }, { port: PORT_OFF });
  check("A14 with no exchange configuration the endpoint is disabled (503) and the public-client flow is unaffected", off.status === 503 && off.json?.details?.code === "SIGNIN_EXCHANGE_NOT_CONFIGURED");
  const pre = await fetch(`http://localhost:${PORT}/api/auth/oidc/token`, { method: "OPTIONS", headers: { origin: ORIGIN, "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
  const preEvil = await fetch(`http://localhost:${PORT}/api/auth/oidc/token`, { method: "OPTIONS", headers: { origin: "http://evil.example", "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
  check("A15 CORS: the browser is only ever told the configured frontend origin is allowed (never the requesting foreign origin)", pre.headers.get("access-control-allow-origin") === ORIGIN && preEvil.headers.get("access-control-allow-origin") !== "http://evil.example");
  const get = await fetch(`http://localhost:${PORT}/api/auth/oidc/token`);
  check("A16 the endpoint accepts POST only", get.status === 404 || get.status === 405, `HTTP ${get.status}`);

  // ======================================================================================================== B. authorization
  console.log("\n# B. authorization with Google-shaped ID tokens (issuer + subject; membership; RBAC)");
  const tAdmin = await bearerFor(S.admin); const tViewer = await bearerFor(S.viewer); const tOpB = await bearerFor(S.opB); const tNoMember = await bearerFor(S.noMember); const tDisabled = await bearerFor(S.disabled); const tUnknown = await bearerFor(S.unknown);
  const none = await call("GET", `/signals?workspaceId=${A}`, null);
  const garbage = await call("GET", `/signals?workspaceId=${A}`, "not.a.token");
  check("B1 [AUTH-01] an unauthenticated request is 401 MISSING_CREDENTIAL, a garbage token is 401", none.status === 401 && none.code === "MISSING_CREDENTIAL" && garbage.status === 401);
  const flip = (t) => { const [h, pl, s] = t.split("."); return `${h}.${pl}.${s.slice(0, -4)}${s.slice(-4) === "AAAA" ? "BBBB" : "AAAA"}`; };
  const tampered = await call("GET", `/signals?workspaceId=${A}`, flip(tAdmin));
  const payload = JSON.parse(Buffer.from(tAdmin.split(".")[1], "base64url").toString()); payload.sub = S.viewer;
  const forgedPayload = await call("GET", `/signals?workspaceId=${A}`, `${tAdmin.split(".")[0]}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${tAdmin.split(".")[2]}`);
  const hs = (() => { const h = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"); const b = Buffer.from(JSON.stringify({ iss: idp.issuer, aud: CLIENT_ID, sub: S.admin, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 })).toString("base64url"); return `${h}.${b}.${crypto.createHmac("sha256", "x").update(`${h}.${b}`).digest("base64url")}`; })();
  const noneAlg = (() => { const h = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"); const b = Buffer.from(JSON.stringify({ iss: idp.issuer, aud: CLIENT_ID, sub: S.admin, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 })).toString("base64url"); return `${h}.${b}.`; })();
  const byAlg = await Promise.all([hs, noneAlg].map((t) => call("GET", `/signals?workspaceId=${A}`, t)));
  check("B2 [AUTH-07] a tampered signature, a re-written payload, an HS256 token and an alg=none token are all 401", [tampered, forgedPayload, ...byAlg].every((r) => r.status === 401 && r.code === "INVALID_TOKEN"), [tampered, forgedPayload, ...byAlg].map((r) => `${r.status}:${r.code}`).join(" "));
  const direct = async (opts) => call("GET", `/signals?workspaceId=${A}`, await idp.mintToken({ sub: S.admin, aud: CLIENT_ID, ...opts }));
  const wrongIss = await direct({ iss: "https://accounts.attacker.example" }); const wrongAud = await direct({ aud: "some-other-client.apps.googleusercontent.com" }); const expired = await direct({ issuedAt: Math.floor(Date.now() / 1000) - 7200, ttlSeconds: 3600 });
  const noAudAtAll = await direct({ aud: ["unrelated"] });
  check("B3 [AUTH-04/05/06] a wrong issuer, a wrong audience (including another Google client) and an expired token are refused by the API itself", wrongIss.status === 401 && wrongAud.status === 401 && noAudAtAll.status === 401 && expired.status === 401 && expired.code === "TOKEN_EXPIRED", `${wrongIss.status}/${wrongAud.status}/${expired.status}:${expired.code}`);
  const unknown = await call("GET", `/signals?workspaceId=${A}`, tUnknown);
  check("B4 [AUTH-08] a VALID Google identity with no EOI user is authenticated but gets nothing: 403 IDENTITY_NOT_REGISTERED", unknown.status === 403 && unknown.code === "IDENTITY_NOT_REGISTERED");
  const noMember = await call("GET", `/signals?workspaceId=${A}`, tNoMember);
  check("B5 [AUTH-09] a known user with NO membership in the workspace gets the safe 404 (the workspace is not revealed)", noMember.status === 404 && noMember.message === "Workspace not found");
  const adminOk = await call("GET", `/signals?workspaceId=${A}`, tAdmin);
  check("B6 [AUTH-10] a known user with an active membership is allowed", adminOk.status === 200 && Array.isArray(adminOk.json?.data));
  const dis = await call("GET", `/signals?workspaceId=${A}`, tDisabled);
  check("B7 [AUTH-11] a disabled user is refused: 403 USER_DISABLED", dis.status === 403 && dis.code === "USER_DISABLED");
  const hostile = { role: "admin", roles: ["admin"], groups: ["admins"], permissions: ["workspace:admin"], workspaceId: B, workspace_id: B, hd: "example.invalid", email_verified: true, "https://eoi.example/role": "admin" };
  const tHostile = await bearerFor(S.viewer, { claims: hostile });
  const h1 = await call("GET", `/signals?workspaceId=${B}`, tHostile); const h2 = await call("POST", "/signals", tHostile, { workspaceId: A, type: "maintenance", severity: "low", title: "claims must not elevate" });
  check("B8 [AUTH-12] role / group / permission / workspace claims inside a Google token cannot override EOI: the viewer reaches no other workspace and cannot write", h1.status === 404 && h2.status === 403 && h2.code === "FORBIDDEN", `${h1.status}/${h2.status}`);
  const tEmail = await bearerFor(S.unknown, { email: "someone@example.invalid" }); // another sub, but claiming the admin's address
  const emailClaim = await call("GET", `/signals?workspaceId=${A}`, await bearerFor(S.unknown, { email: `${S.admin}@example.invalid` }));
  const sameSubOtherEmail = await call("GET", `/signals?workspaceId=${A}`, await bearerFor(S.admin, { email: "totally-different@example.invalid" }));
  check("B9 email is NOT the identity: another subject claiming the admin's email is unregistered (403), while the admin's own subject with a different email still resolves", emailClaim.status === 403 && emailClaim.code === "IDENTITY_NOT_REGISTERED" && sameSubOtherEmail.status === 200 && Boolean(tEmail));
  const otherIssuer = await call("GET", `/signals?workspaceId=${A}`, await bearerFor(S.otherIssuer));
  check("B10 the identity key is the EXACT issuer + subject: a user stored under a different issuer string is not matched", otherIssuer.status === 403 && otherIssuer.code === "IDENTITY_NOT_REGISTERED");
  const cross = await call("GET", `/signals?workspaceId=${B}`, tAdmin); const crossGet = await call("GET", `/signals/${sigB._id}?workspaceId=${A}`, tAdmin); const crossB = await call("GET", `/signals?workspaceId=${A}`, tOpB);
  check("B11 [AUTH-23] cross-workspace access fails safely in both directions (list and by id): 404, no information", cross.status === 404 && crossGet.status === 404 && crossB.status === 404);
  const vGet = await call("GET", `/signals?workspaceId=${A}`, tViewer); const vPost = await call("POST", "/signals", tViewer, { workspaceId: A, type: "maintenance", severity: "low", title: "viewer" });
  const aPost = await call("POST", "/signals", tAdmin, { workspaceId: A, type: "maintenance", severity: "low", title: "admin write" });
  check("B12 [AUTH-24] RBAC is unchanged: viewer reads (200) but cannot write (403); admin writes (201)", vGet.status === 200 && vPost.status === 403 && aPost.status === 201, `${vGet.status}/${vPost.status}/${aPost.status}`);
  const rh = await call("GET", "/health", null);
  const unauthed = await Promise.all(["/signals", "/properties", "/guests", "/dashboard/signals", "/intelligence", "/decisions", "/learning"].map((x) => call("GET", `${x}?workspaceId=${A}`, null)));
  check("B13 every sampled data route still requires a credential; only /health and the exchange are reachable without one", rh.status === 200 && unauthed.every((r) => r.status === 401));
  check("B14 the development hint names the unregistered subject (so an operator can provision it) and never a token or the secret", /no EOI user yet \(subject 999999999999999999999\)/.test(logs.backend) && !/eyJ/.test(logs.backend.split("no EOI user yet")[1]?.split("\n")[0] ?? "") && !logs.backend.includes(TEST_SECRET));

  // ======================================================================================================== C. the SPA flow through the exchange
  console.log("\n# C. the SPA sign-in flow through the exchange (fake browser window, real backend)");
  process.env.VITE_API_BASE_URL = API;
  process.env.VITE_OIDC_AUTHORITY = idp.issuer; process.env.VITE_OIDC_CLIENT_ID = CLIENT_ID; process.env.VITE_OIDC_PROVIDER_LABEL = "Google"; process.env.VITE_OIDC_TOKEN_EXCHANGE_URL = `${API}/auth/oidc/token`;
  delete process.env.VITE_DEV_ACCESS_TOKEN;
  const { createServer } = await import(pathToFileURL(path.join(FRONTEND, "node_modules", "vite", "dist", "node", "index.js")).href);
  vite = await createServer({ root: FRONTEND, configFile: path.join(FRONTEND, "vite.config.js"), server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom", logLevel: "silent", optimizeDeps: { noDiscovery: true, include: [] } });
  const sess = await vite.ssrLoadModule("/src/services/auth/authSession.js");
  const tokenMod = await vite.ssrLoadModule("/src/services/auth/accessToken.js");
  const oidcMod = await vite.ssrLoadModule("/src/services/auth/oidc/oidcSession.js");
  const flowMod = await vite.ssrLoadModule("/src/services/auth/oidc/oidcFlow.js");
  const apiMod = await vite.ssrLoadModule("/src/services/api.js");
  const makeWindow = (href = `${ORIGIN}/`, store = new Map()) => {
    const w = { assigned: [], replaced: [], store, location: {}, history: {}, sessionStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) } };
    const setHref = (hr) => { const u = new URL(hr, ORIGIN); Object.assign(w.location, { origin: u.origin, pathname: u.pathname, search: u.search, hash: u.hash, href: u.href }); };
    w.location.assign = (url) => { w.assigned.push(url); };
    w.history.replaceState = (_s, _t, url) => { w.replaced.push(String(url)); setHref(String(url)); };
    setHref(href); return w;
  };
  const settings = (over = {}) => ({ authority: idp.issuer, clientId: CLIENT_ID, redirectUri: "", scope: "openid profile email", audience: "", tokenExchangeUrl: `${API}/auth/oidc/token`, providerLabel: "Google", ...over });
  const sent = []; // every request the SPA made, with its body (to prove it never sends a secret)
  const recordingFetch = (...args) => { sent.push({ url: String(args[0]), body: args[1]?.body ? String(args[1].body) : "" }); return fetch(...args); };
  const mk = (win, o = {}) => oidcMod.createOidcSession({ settings: settings(o.settings), production: false, win, fetchImpl: o.fetchImpl ?? recordingFetch, ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}), ...(o.now ? { now: o.now } : {}) });
  const hop = async (win) => { const r = await fetch(win.assigned.at(-1), { redirect: "manual" }); return r.status === 302 ? r.headers.get("location") : null; };
  const settle = (pr, ms = 600) => Promise.race([pr.then(() => "settled"), sleep(ms).then(() => "pending")]);
  const resetSpa = () => { sess.resetAuthSession(); tokenMod.setAccessTokenSource(() => null); reset(); sent.length = 0; };

  resetSpa(); idp.config.sub = S.admin;
  const deep = "/operations/signals/6ac494995352eda1be0e08a9/intelligence";
  let w = makeWindow(`${ORIGIN}${deep}?tab=x#e`); let s = mk(w); await settle(s.initOidcAuth());
  const authUrl = new URL(w.assigned[0]);
  check("C1 the authorization request goes to the provider with code + S256 PKCE, the PUBLIC client id, the registered redirect URI, and NO secret", authUrl.searchParams.get("client_id") === CLIENT_ID && authUrl.searchParams.get("response_type") === "code" && authUrl.searchParams.get("code_challenge_method") === "S256" && authUrl.searchParams.get("redirect_uri") === REDIRECT && authUrl.searchParams.get("scope") === "openid profile email" && ![...authUrl.searchParams.keys()].some((k) => /secret/i.test(k)) && !authUrl.search.includes(TEST_SECRET));
  const back = await hop(w);
  idp.stats.token = 0; idp.stats.tokenWithoutSecret = 0; idp.stats.tokenWithSecret = 0; sent.length = 0;
  const wb = makeWindow(back, w.store); const sb = mk(wb); await sb.initOidcAuth();
  check("C2 [AUTH-02] the callback completes through the backend exchange: signed in, the app is ready, a Bearer token is in memory", sess.getAuthState().status === "ready" && Boolean(sb.getMemoryToken()) && sb.getMemoryToken().split(".").length === 3);
  const exchangeCalls = sent.filter((r) => r.url.endsWith("/auth/oidc/token"));
  check("C3 the SPA's ONLY token request went to the EOI backend with just { code, code_verifier, redirect_uri }: no secret, no client id, and the provider's token endpoint was reached only by the backend (with the secret)", exchangeCalls.length === 1 && JSON.stringify(Object.keys(JSON.parse(exchangeCalls[0].body)).sort()) === JSON.stringify(["code", "code_verifier", "redirect_uri"]) && !exchangeCalls[0].body.includes(TEST_SECRET) && !sent.some((r) => r.url.startsWith(`${idp.issuer}/token`)) && idp.stats.token === 1 && idp.stats.tokenWithoutSecret === 0);
  check("C4 [AUTH-20] deep-link restoration still works (path, query and hash), and the callback parameters are removed from the URL", wb.location.pathname + wb.location.search + wb.location.hash === `${deep}?tab=x#e` && wb.replaced.every((u) => !/code=|state=/.test(u)));
  check("C5 [AUTH-22] the token is in memory only: in no storage value, no URL and no history entry", ![...wb.store.values()].some((v) => v.includes(sb.getMemoryToken())) && ![...wb.replaced, ...wb.assigned].some((u) => u.includes(sb.getMemoryToken())) && [...wb.store.keys()].every((k) => k.startsWith("koi.oidc.")) && [...wb.store.entries()].every(([k, v]) => k === "koi.oidc.session" && v === "1"));
  const liveApi = await (async () => { try { return await apiMod.listSignals(A); } catch (e) { return { error: e }; } })();
  check("C6 the SPA's API client authenticates with it (a registered admin sees workspace A's data)", Array.isArray(liveApi.items) && liveApi.items.length >= 1, liveApi.error?.message);
  const unregSession = await (async () => { resetSpa(); idp.config.sub = S.unknown; const win = makeWindow(`${ORIGIN}/`); const ss = mk(win); await settle(ss.initOidcAuth()); const win2 = makeWindow(await hop(win), win.store); const s2 = mk(win2); await s2.initOidcAuth(); try { await apiMod.listSignals(A); return null; } catch (e) { return e; } })();
  check("C7 [AUTH-08] an unregistered Google account signs in but the app says the plain 'doesn't have access' wording (403) and the session is not treated as ended", unregSession?.status === 403 && unregSession.message === "Your account doesn't have access to this yet. Please contact your administrator." && sess.getAuthState().status === "ready" && !/IDENTITY|NOT_REGISTERED/.test(unregSession.message));
  resetSpa(); idp.config.sub = S.admin;

  // failures
  const attempt = async (mutate, o = {}) => {
    reset(); idp.config.sub = S.admin; sess.resetAuthSession(); sent.length = 0;
    const win = makeWindow(`${ORIGIN}/ops`); const ss = mk(win); await settle(ss.initOidcAuth());
    mutate?.();
    const cb = await hop(win); const authBefore = idp.stats.authorize;
    const win2 = makeWindow(cb, win.store); const s2 = mk(win2, o);
    const t = await timed(() => s2.initOidcAuth());
    return { win: win2, session: s2, ms: t.ms, authBefore, state: sess.getAuthState() };
  };
  let r = await attempt(() => { idp.config.authorize = "error"; });
  check("C8 [AUTH-19] the user denies consent / the provider returns an OAuth error: the explicit, friendly 'Sign-in cancelled' state, no second redirect, a clean URL, the provider's text nowhere", r.state.reason === "cancelled" && r.win.assigned.length === 0 && r.win.replaced.every((u) => !/error|code=|state=|the-provider-said-no/.test(u)) && !/the-provider-said-no|access_denied/.test(sess.authMessage(r.state.reason) + sess.authDetail(r.state.reason)));
  r = await attempt(() => { idp.config.idTokenMode = "wrong-aud"; });
  check("C9 an ID token the backend refuses (wrong audience) ends in the same explicit failure state with no token and no redirect", r.state.reason === "callbackFailed" && r.session.getMemoryToken() === null && r.win.assigned.length === 0);
  r = await attempt(() => { idp.config.clientSecret = "something-else"; });
  check("C10 a token-exchange failure at the provider is the same explicit failure (no secret text, no loop)", r.state.reason === "callbackFailed" && r.win.assigned.length === 0);
  { reset(); idp.config.sub = S.admin; sess.resetAuthSession(); const win = makeWindow(`${ORIGIN}/ops`); const ss = mk(win); await settle(ss.initOidcAuth()); const cb = await hop(win); const forged = new URL(cb); forged.searchParams.set("state", "forged"); idp.stats.token = 0; const win2 = makeWindow(forged.toString(), win.store); const s2 = mk(win2); await s2.initOidcAuth(); const miss = makeWindow(`${ORIGIN}/?code=stolen&state=x`); const s3 = mk(miss); sess.resetAuthSession(); await s3.initOidcAuth(); const nocode = makeWindow(`${ORIGIN}/?state=abc`, win.store); sess.resetAuthSession(); const s4 = mk(nocode); await settle(s4.initOidcAuth());
    check("C11 an invalid state, a callback with no stored transaction and a callback with no code are refused without contacting the backend or the provider", idp.stats.token === 0 && sess.getAuthState().reason !== undefined && s2.getMemoryToken() === null && s3.getMemoryToken() === null); }
  r = await attempt(null, { timeoutMs: 400, settings: { tokenExchangeUrl: await (async () => { const srv = http.createServer(() => {}); servers.push(srv); await new Promise((res) => srv.listen(0, "127.0.0.1", res)); return `http://127.0.0.1:${srv.address().port}/hang`; })() } });
  check("C12 [AUTH-18] an exchange endpoint that never answers is bounded by the SPA's own deadline: the failure state within the timeout ('no connection' wording), no token, no retry, no redirect", r.state.reason === "networkFailed" && r.ms >= 350 && r.ms < 2500 && r.session.getMemoryToken() === null && r.win.assigned.length === 0, `${r.ms} ms`);
  reset(); idp.config.discoveryMode = "hang"; idp.stats.discovery = 0;
  { sess.resetAuthSession(); const win = makeWindow(`${ORIGIN}/`); const ss = mk(win, { timeoutMs: 400 }); const t = await timed(() => ss.initOidcAuth()); await sleep(900);
    check("C13 [AUTH-17] a provider that never answers discovery is bounded: 'Sign-in is unavailable' within the timeout, one aborted request, no redirect, no automatic retry", sess.getAuthState().reason === "signInUnavailable" && t.ms < 2500 && win.assigned.length === 0 && idp.stats.discovery === 1, `${t.ms} ms`); }
  reset();
  // sign-out, reload, expiry, loop
  resetSpa(); idp.config.sub = S.admin;
  let clock = Date.now();
  w = makeWindow(`${ORIGIN}/ops`); s = mk(w, { now: () => clock }); await settle(s.initOidcAuth());
  const wi = makeWindow(await hop(w), w.store); const si = mk(wi, { now: () => clock }); await si.initOidcAuth();
  const liveToken = tokenMod.getAccessToken();
  clock += 3600 * 1000 + 10_000;
  check("C14 [AUTH-15] after the token's lifetime (expires_in from the backend) the API layer is offered no token, so the user gets the 'sign in again' path", Boolean(liveToken) && tokenMod.getAccessToken() === null);
  const apiAfter = await (async () => { try { await apiMod.listSignals(A); return null; } catch (e) { return e; } })();
  check("C15 the expired session fails locally with the friendly message and no request", apiAfter?.status === 401 && apiAfter.message === "Your session has expired. Please sign in again to continue." && sess.getAuthState().status === "sessionEnded");
  resetSpa(); idp.config.sub = S.admin; clock = Date.now();
  w = makeWindow(`${ORIGIN}/ops`); s = mk(w); await settle(s.initOidcAuth());
  const wo = makeWindow(await hop(w), w.store); const so = mk(wo); await so.initOidcAuth(); so.signOut();
  const afterOut = await (async () => { try { await apiMod.listSignals(A); return null; } catch (e) { return e; } })();
  check("C16 [AUTH-13] sign-out clears the in-memory token and the session; authenticated calls then fail locally", so.getMemoryToken() === null && tokenMod.getAccessToken() === null && sess.getAuthState().reason === "signedOut" && afterOut?.status === 401);
  const wre = makeWindow(`${ORIGIN}/`, wo.store); const sre = mk(wre); sess.resetAuthSession(); await sre.initOidcAuth();
  check("C17 [AUTH-14] a reload after sign-out stays signed out (no silent sign-in, no redirect)", sess.getAuthState().reason === "signedOut" && wre.assigned.length === 0);
  { sess.resetAuthSession(); idp.config.authorize = "noresponse"; const win = makeWindow(`${ORIGIN}/ops`); const ss = mk(win); await settle(ss.initOidcAuth()); const bk = await hop(win); const authN = idp.stats.authorize; const win2 = makeWindow(bk, win.store); const s2 = mk(win2); await s2.initOidcAuth();
    check("C18 [AUTH-16] no redirect loop: a provider that sends the user back without a response ends in the explicit failure state, not another redirect", win2.assigned.length === 0 && idp.stats.authorize === authN && sess.getAuthState().reason === "callbackFailed"); }
  { sess.resetAuthSession(); reset(); idp.stats.authorize = 0;
    const win = makeWindow(`${ORIGIN}${deep}?tab=x`); const ss = mk(win, { settings: { autoRedirect: false } }); const t = await timed(() => ss.initOidcAuth());
    check("C19 with VITE_OIDC_AUTO_REDIRECT=false a FRESH visit shows the 'Welcome back' screen (no redirect, nothing contacted) and the app is blocked behind it", sess.getAuthState().status === "blocked" && sess.getAuthState().reason === "welcome" && win.assigned.length === 0 && idp.stats.authorize === 0 && idp.stats.discovery >= 0 && t.ms < 500);
    await settle(ss.signIn());
    check("C20 pressing the sign-in button then starts the normal flow once, remembering the page the user asked for", win.assigned.length === 1 && JSON.parse(win.store.get("koi.oidc.transaction")).returnTo === `${deep}?tab=x`); }
  { sess.resetAuthSession(); idp.stats.authorize = 0; const win = makeWindow(`${ORIGIN}/x`); const ss = mk(win); await settle(ss.initOidcAuth());
    check("C21 by default (option unset) a fresh visit still redirects to the provider once, exactly as before", win.assigned.length === 1 && idp.stats.authorize >= 0); }
  reset();

  // ======================================================================================================== D. UI
  console.log("\n# D. rendered UI");
  const feRequire = createRequire(path.join(FRONTEND, "package.json"));
  const React = feRequire("react"); const { renderToString } = feRequire("react-dom/server"); const h = React.createElement;
  const AuthScreen = (await vite.ssrLoadModule("/src/components/auth/AuthScreen.jsx")).default;
  const SignOutButton = (await vite.ssrLoadModule("/src/components/auth/SignOutButton.jsx")).default;
  const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
  sess.resetAuthSession(); sess.configureAuthLifecycle({ tokenRequired: true, signInAvailable: true }); sess.blockApp("signedOut");
  const so1 = text(renderToString(h(AuthScreen)));
  sess.blockApp("callbackFailed"); const cf = text(renderToString(h(AuthScreen)));
  sess.blockApp("welcome"); const fresh = text(renderToString(h(AuthScreen)));
  sess.resetAuthSession(); sess.configureAuthLifecycle({ tokenRequired: true, signInAvailable: true });
  const outBtn = renderToString(h(SignOutButton));
  const FORBIDDEN = /GOCSPX|client_secret|client[_ ]id|accounts\.google|googleusercontent|127\.0\.0\.1|localhost|code=|state=|eyJ|VITE_|OIDC|invalid_grant|access_denied/i;
  check("D1 the signed-out screen offers 'Continue with Google'", /You have signed out/.test(so1) && /Continue with Google/.test(so1) && !FORBIDDEN.test(so1), so1);
  check("D2 the failure screen keeps its human recovery path ('Sign-in was not completed' + 'Try sign in again') and shows nothing technical", /Sign-in was not completed/.test(cf) && /Try sign in again/.test(cf) && !FORBIDDEN.test(cf), cf);
  check("D4 the fresh-visit screen (auto-redirect off) reads \"Welcome to EOI\" with a \"Continue with Google\" button and the new-to-EOI hint, and shows nothing technical", /Welcome to EOI/.test(fresh) && /Continue with Google/.test(fresh) && /New to EOI\?/.test(fresh) && !FORBIDDEN.test(fresh), fresh);
  check("D3 the Sign out control keeps aria-label=\"Sign out\" (also at mobile widths, where only the icon shows)", /aria-label="Sign out"/.test(outBtn));
  sess.resetAuthSession();

  // ======================================================================================================== E. configuration contract
  console.log("\n# E. configuration contract");
  const auth = { provider: "oidc", oidc: { issuer: "https://accounts.google.com", audience: [CLIENT_ID], httpTimeoutMs: 5000 } };
  const cfgOf = (env, a = auth) => resolveExchangeConfig(env, a);
  const good = { OIDC_EXCHANGE_CLIENT_ID: CLIENT_ID, OIDC_EXCHANGE_CLIENT_SECRET: "s3cret-value-123", OIDC_EXCHANGE_REDIRECT_URIS: "http://localhost:5175/" };
  const g = cfgOf(good);
  check("E1 nothing set = disabled with no problems; all three set (loopback http, development/test) = enabled", cfgOf({}).enabled === false && cfgOf({}).problems.length === 0 && g.enabled === true);
  check("E2 the secret cannot be printed by accident: it is not enumerable, so JSON.stringify / spread / console.log of the config never include it", !JSON.stringify(g.config).includes("s3cret-value-123") && !Object.keys(g.config).includes("clientSecret") && !JSON.stringify({ ...g.config }).includes("s3cret-value-123") && g.config.clientSecret === "s3cret-value-123");
  check("E3 a partly configured exchange is a problem (and disabled)", [{ OIDC_EXCHANGE_CLIENT_ID: CLIENT_ID }, { OIDC_EXCHANGE_CLIENT_SECRET: "x" }, { OIDC_EXCHANGE_REDIRECT_URIS: "http://localhost:5175/" }, { ...good, OIDC_EXCHANGE_CLIENT_SECRET: "" }].every((e) => { const c = cfgOf(e); return c.enabled === false && c.problems.length > 0; }));
  check("E4 the exchange client id must be one of OIDC_AUDIENCE (so the token it returns can pass the verifier), and it needs a valid OIDC provider", !cfgOf({ ...good, OIDC_EXCHANGE_CLIENT_ID: "other-client" }).enabled && !cfgOf(good, { provider: "stub", oidc: null }).enabled);
  const prev = process.env.NODE_ENV; process.env.NODE_ENV = "production";
  const prodHttp = cfgOf(good); const prodHttps = cfgOf({ ...good, OIDC_EXCHANGE_REDIRECT_URIS: "https://eoi.example.test/" });
  process.env.NODE_ENV = prev;
  check("E5 redirect URIs are exact URLs without query or fragment; plain http is refused in production, https is accepted", !prodHttp.enabled && prodHttps.enabled && !cfgOf({ ...good, OIDC_EXCHANGE_REDIRECT_URIS: "http://localhost:5175/?x=1" }).enabled && !cfgOf({ ...good, OIDC_EXCHANGE_REDIRECT_URIS: "not a url" }).enabled);
  const svc = strip(read(path.join(BACKEND, "src", "services", "oidcExchangeService.js")));
  check("E6 the exchange service never logs or returns the secret or any token: its only log line is the development provisioning hint (subject only), guarded to development/test", (svc.match(/logger\.\w+\(/g) || []).length === 1 && /isDevelopmentOrTestMode\(\)/.test(svc) && !/console\./.test(svc) && !/clientSecret[^,)\n]*logger|logger[^\n]*clientSecret|idToken[^\n]*logger|logger[^\n]*idToken/.test(svc));
  check("E7 the exchange sends the secret only to the provider's token endpoint taken from DISCOVERY (issuer must match; https), with a deadline, and never follows a redirect", /redirect: "error"/.test(svc) && /AbortSignal\.timeout/.test(svc) && /document\.issuer !== config\.issuer/.test(svc) && /token endpoint is not https/.test(svc));
  const route = strip(read(path.join(BACKEND, "src", "routes", "authRoutes.js")));
  check("E8 the public route has the dedicated rate limit BEFORE the body parser, a 4 KB strict JSON limit, and POST only", /oidcExchangeLimiter, smallJson\(\)/.test(route) && /const smallJson = \(\) => express\.json\(\{ limit: "4kb", strict: true \}\)/.test(route) && /authRoutes\.post\(\s*"\/oidc\/token"/.test(route) && !/authRoutes\.(get|put|patch|delete)\(\s*"\/oidc/.test(route));

  // ======================================================================================================== F. the REAL Google (no credentials; nobody signs in)
  console.log("\n# F. the real Google - public endpoints only, NO credentials, nobody signs in");
  const feEnvFile = path.join(FRONTEND, ".env"); // the single frontend runtime file (the former .env.google was merged into it)
  const realClientId = fs.existsSync(feEnvFile) ? dotenv.parse(read(feEnvFile)).VITE_OIDC_CLIENT_ID : "";
  const net = async (fn) => { try { return await fn(); } catch (e) { return { netError: String(e?.message ?? e).slice(0, 60) }; } };
  const disc = await net(async () => (await fetch("https://accounts.google.com/.well-known/openid-configuration", { signal: AbortSignal.timeout(10000) })).json());
  if (disc.netError) { info(`F skipped: Google is not reachable from here (${disc.netError})`); } else {
    check("F1 Google's real discovery document: issuer is exactly https://accounts.google.com; authorization / token / JWKS endpoints are https; ID tokens are RS256; PKCE S256 is supported; there is NO end-session endpoint", disc.issuer === "https://accounts.google.com" && [disc.authorization_endpoint, disc.token_endpoint, disc.jwks_uri].every((u) => typeof u === "string" && u.startsWith("https://")) && disc.id_token_signing_alg_values_supported.includes("RS256") && disc.code_challenge_methods_supported.includes("S256") && disc.end_session_endpoint === undefined);
    check("F2 Google's token endpoint offers only client_secret_post / client_secret_basic (no 'none'): a client SECRET is required, which is why the exchange is server side", JSON.stringify([...disc.token_endpoint_auth_methods_supported].sort()) === JSON.stringify(["client_secret_basic", "client_secret_post"]));
    if (realClientId) {
      const tok = await net(async () => { const r = await fetch(disc.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: realClientId, redirect_uri: REDIRECT, code: "bogus", code_verifier: "a".repeat(64) }), signal: AbortSignal.timeout(10000) }); return { status: r.status, body: await r.json() }; });
      check("F3 the real token endpoint refuses a browser-style exchange WITHOUT the secret ('client_secret is missing') for THIS client - proof that the SPA alone cannot complete Google's flow", tok.status === 400 && /client_secret is missing/i.test(tok.body?.error_description ?? ""), tok.netError ?? `HTTP ${tok.status}`);
      const authz = new URL(disc.authorization_endpoint);
      for (const [k, v] of Object.entries({ response_type: "code", client_id: realClientId, redirect_uri: REDIRECT, scope: "openid profile email", state: "validation-state", code_challenge: crypto.createHash("sha256").update("a".repeat(64)).digest("base64url"), code_challenge_method: "S256" })) authz.searchParams.set(k, v);
      const page = await net(async () => { const r = await fetch(authz, { redirect: "manual", signal: AbortSignal.timeout(10000) }); return { status: r.status, location: r.headers.get("location") ?? "", body: r.status === 200 ? (await r.text()).slice(0, 200000) : "" }; });
      const rejected = /redirect_uri_mismatch|invalid_request|invalid_client|origin_mismatch|Error 400|Error 401|deleted_client/i.test(page.body + page.location);
      check("F4 Google ACCEPTS this client's authorization request (client id + redirect URI + S256 PKCE): it sends the browser to its sign-in page instead of an error", !page.netError && !rejected && (page.status === 200 || (page.status >= 300 && page.status < 400 && /accounts\.google\.com/.test(page.location))), page.netError ?? `HTTP ${page.status}${page.location ? ` -> ${new URL(page.location, "https://accounts.google.com").pathname}` : ""}`);
      const realVerifier = createOidcTokenVerifier({ issuer: "https://accounts.google.com", audience: [realClientId], algorithms: ["RS256"], clockToleranceSeconds: 60, jwksCooldownMs: 30000, jwksCacheMaxAgeMs: 600000, httpTimeoutMs: 8000 });
      const foreign = await (async () => { const { generateKeyPair, SignJWT } = await import("jose"); const { privateKey } = await generateKeyPair("RS256"); const now = Math.floor(Date.now() / 1000); return new SignJWT({}).setProtectedHeader({ alg: "RS256", kid: "not-a-google-key" }).setIssuer("https://accounts.google.com").setAudience(realClientId).setSubject("1").setIssuedAt(now).setExpirationTime(now + 600).sign(privateKey); })();
      const verdict = await realVerifier(foreign).then(() => "ACCEPTED", (e) => `${e?.statusCode}:${e?.code}`);
      check("F5 the REAL verifier reaches Google's real discovery + JWKS and REFUSES a correctly-shaped token signed by a key Google never published (401 INVALID_TOKEN, not 503 and not accepted)", verdict === "401:INVALID_TOKEN", verdict);
    } else info("F3-F5 skipped: frontend/.env has no Google client id to test");
  }

  // ======================================================================================================== G. secrets
  console.log("\n# G. secrets: repository, git-ignore, production bundle");
  const jsonPath = process.env.GOOGLE_CLIENT_JSON ?? (() => { const dir = path.join(os.homedir(), "Downloads"); try { const f = fs.readdirSync(dir).find((n) => /^client_secret_.+\.apps\.googleusercontent\.com\.json$/.test(n)); return path.join(dir, f ?? "client_secret.json"); } catch { return path.join(dir, "client_secret.json"); } })();
  const realSecret = fs.existsSync(jsonPath) ? (JSON.parse(read(jsonPath)).web?.client_secret ?? "") : "";
  const gitFiles = spawnSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).stdout.split(/\r?\n/).filter(Boolean);
  const textFile = (f) => !/\.(png|jpg|jpeg|gif|ico|woff2?|ttf|pdf|zip|gz|svg)$/i.test(f) && !/(^|\/)(node_modules|\.venv|dist)\//.test(f);
  const hits = []; const prefixHits = [];
  for (const f of gitFiles.filter(textFile)) { let t; try { const full = path.join(REPO, f); if (fs.statSync(full).size > 8_000_000) continue; t = read(full); } catch { continue; } if (realSecret && t.includes(realSecret)) hits.push(f); if (/GOCSPX-[A-Za-z0-9_-]{20,}/.test(t)) prefixHits.push(f); }
  check("G1 the Google client secret is in NO tracked or un-ignored file in the repository (and no Google-secret-shaped value either)", gitFiles.length > 300 && hits.length === 0 && prefixHits.length === 0, `${gitFiles.length} files scanned${realSecret ? "" : " (the downloaded JSON was not available: only the GOCSPX- pattern was checked)"}${hits.length ? `; HIT in ${hits.join(",")}` : ""}`);
  const ign = (f) => spawnSync("git", ["check-ignore", "-q", f], { cwd: REPO }).status === 0;
  const tracked = (f) => spawnSync("git", ["ls-files", "--error-unmatch", f], { cwd: REPO, stdio: "ignore" }).status === 0;
  check("G2 the local Google profiles and any downloaded client_secret*.json are git-ignored and untracked", ["backend/.env.google", "frontend/.env.google", "client_secret_x.json", "a/b/client_secret_1.apps.googleusercontent.com.json"].every(ign) && !tracked("backend/.env.google") && !tracked("frontend/.env.google"));
  if (fs.existsSync(feEnvFile)) {
    const fe = dotenv.parse(read(feEnvFile));
    check("G3 the frontend Google profile has only PUBLIC VITE_ values: no variable named like a secret, no secret value", Object.keys(fe).every((k) => k.startsWith("VITE_") && !/SECRET|PRIVATE|PASSWORD|TOKEN_VALUE/i.test(k)) && (!realSecret || !Object.values(fe).some((v) => v.includes(realSecret))));
  }
  const viteBin = path.join(FRONTEND, "node_modules", "vite", "bin", "vite.js");
  const build = (label, args, extraEnv) => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), `eoi-p45b4-${label}-`)); tmpDirs.push(out);
    const env = { ...process.env, ...extraEnv, NODE_ENV: "production" };
    for (const k of Object.keys(env)) if (/^VITE_/.test(k) && !(k in extraEnv)) delete env[k];
    const r = spawnSync(process.execPath, [viteBin, "build", ...args, "--outDir", out, "--emptyOutDir"], { cwd: FRONTEND, env, encoding: "utf8" });
    const dir = path.join(out, "assets");
    return { ok: r.status === 0, js: fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => read(path.join(dir, f))).join("\n") : "", html: fs.existsSync(path.join(out, "index.html")) ? read(path.join(out, "index.html")) : "" };
  };
  const SENT = "sentinel-secret-5d2c8e1a"; const SENT_TOKEN = "dev-token-sentinel-9a7b3c4d";
  const gb = build("google", ["--mode", "google"], { OIDC_EXCHANGE_CLIENT_SECRET: SENT, GOOGLE_CLIENT_SECRET: SENT, VITE_DEV_ACCESS_TOKEN: SENT_TOKEN });
  check("G4 a production build in Google mode succeeds and carries the sign-in flow, the exchange URL and the 'Continue with' button text", gb.ok && /code_challenge/.test(gb.js) && /auth\/oidc\/token/.test(gb.js) && /Continue with/.test(gb.js));
  check("G5 the production bundle contains the PUBLIC client id (it must: the browser sends it to Google)", fs.existsSync(feEnvFile) ? gb.js.includes(realClientId) : true);
  check("G6 no secret, token or credential of any kind is in the production bundle or its index.html", !(realSecret && (gb.js + gb.html).includes(realSecret)) && !/GOCSPX|client_secret|\"web\":\{\"client_id|BEGIN [A-Z ]*PRIVATE KEY|eyJ[A-Za-z0-9_-]{15,}\.|ya29\.|refresh_token/.test(gb.js + gb.html) && !(gb.js + gb.html).includes(SENT) && !(gb.js + gb.html).includes(SENT_TOKEN) && !/VITE_DEV_ACCESS_TOKEN|OIDC_EXCHANGE|GOOGLE_CLIENT/.test(gb.js));
  const srcFiles = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? srcFiles(path.join(d, e.name)) : [path.join(d, e.name)])).filter((f) => /\.jsx?$/.test(f));
  check("G7 the frontend source has no variable or string for a client secret (the only secret-related text is comments saying there is none)", srcFiles(path.join(FRONTEND, "src")).every((f) => !/VITE_[A-Z0-9_]*SECRET|GOCSPX|client_secret/i.test(strip(read(f)))));
  check("G8 `import.meta.env` is only ever read by name (an aliased env object would ship every build-time variable)", srcFiles(path.join(FRONTEND, "src")).every((f) => !/import\.meta\.env(?![.\w])/.test(strip(read(f)))));
} finally {
  if (vite) await vite.close();
  for (const c of children) c.kill();
  for (const sv of servers) sv.close();
  await idp.close();
  try { await mongoose.connection.dropDatabase(); } catch { /* best effort */ }
  await mongoose.disconnect();
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
}

console.log(`\nPhase 45B.4 Google OIDC validation: ${passed} passed, ${failed} failed (isolated database ${DB_NAME} dropped; sections A-E use a local Google-like provider; section F contacted the real Google without credentials; nobody signed in)`);
process.exit(failed === 0 ? 0 : 1);
