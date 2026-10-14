/**
 * Phase 46 - unified authentication: email + password AND Google, ONE EOI session. Backend contract, security and isolation.
 *
 * REAL spawned backends (AUTH_PROVIDER=eoi) on an ISOLATED throwaway database, the development email outbox, and a local Google-like identity provider for the
 * Google paths (no real Google account is used here; the real-Google regression is a separate browser run).
 *
 *   A  configuration, hashing, password policy
 *   B  email + password: sign-up, verification, sign-in, enumeration safety
 *   C  the EOI session: token contents, forgery, refresh rotation, reuse, logout, disabled user, user-to-user isolation
 *   D  forgot / reset password
 *   E  Google under the unified session: new user, existing user, restricted, linking, adoption, no Google bearer
 *   F  authorization: cross-user, cross-workspace, forged role / workspace / user id
 *   G  rate limiting (a second backend with limits ON and tiny maxima)
 *   H  no secret / password / token / hash in any response or log
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(here, "..");
const read = (p) => fs.readFileSync(p, "utf8");
let passed = 0; let failed = 0;
const check = (name, ok, detail = "") => { if (ok) { passed += 1; console.log(`PASS  ${name}${detail ? ` - ${detail}` : ""}`); } else { failed += 1; console.error(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

{ const __u = dotenv.parse(process.getBuiltinModule("node:fs").readFileSync(new URL("../.env", import.meta.url))).MONGODB_URI ?? ""; if (/^mongodb:\/\/(?:[^@/]*@)?(localhost|127\.0\.0\.1)/i.test(__u)) process.env.MONGODB_URI ??= __u; } // validation / rehearsal tools take ONLY a loopback database URI from backend/.env, never its real settings
const baseUri = process.env.MONGODB_URI;
const stamp = Date.now();
const DB_NAME = `koi_p46_${stamp}`;
if (!baseUri || /^mongodb\+srv:|@/.test(baseUri) || !/^mongodb:\/\/(localhost|127\.0\.0\.1)/.test(baseUri)) { console.error("refusing: the configured MongoDB is not a plain loopback instance"); process.exit(2); }
process.env.MONGODB_URI = baseUri.replace(/(mongodb:\/\/[^/]+\/)([^?]*)/, `$1${DB_NAME}`);
process.env.NODE_ENV = "test";
for (const k of ["AUTH_STUB_SECRET", "AUTH_TOKEN_VERIFIER", "AUTH_PROVIDER", "KOI_SESSION_SECRET", "OIDC_ISSUER", "OIDC_AUDIENCE", "OIDC_EXCHANGE_CLIENT_ID", "OIDC_EXCHANGE_CLIENT_SECRET", "OIDC_EXCHANGE_REDIRECT_URIS", "KOI_SELF_REGISTRATION", "KOI_EMAIL_TRANSPORT"]) delete process.env[k];

const mongoose = (await import("mongoose")).default;
const { connectDatabase } = await import("../src/config/database.js");
const { User, Workspace, WorkspaceMembership, AuthSession, AuthToken, AuthIdentity } = await import("../src/models/index.js");
await connectDatabase();
if (mongoose.connection.db.databaseName !== DB_NAME) { console.error("refusing: not connected to the isolated database"); process.exit(2); }
const { startLocalOidcProvider } = await import("./lib/localOidcProvider.mjs");
const { resolveAuthConfig } = await import("../src/auth/authConfig.js");
const hasher = await import("../src/auth/passwordHasher.js");

const CLIENT_ID = "790571179268-p46-test.apps.googleusercontent.com";
const GOOGLE_SECRET = "p46-test-client-secret-not-real-77aa";
const SESSION_SECRET = crypto.randomBytes(36).toString("base64url");
const ORIGIN = "http://localhost:5176";
const REDIRECT = `${ORIGIN}/`;
const idp = await startLocalOidcProvider({ audience: CLIENT_ID, clientId: CLIENT_ID });
Object.assign(idp.config, { googleMode: true, clientSecret: GOOGLE_SECRET });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eoi-p46-"));
const OUTBOX = path.join(tmp, "outbox.jsonl");
const children = []; const logs = { on: "", limited: "" };

function startBackend(port, extra = {}, logKey = "on") {
  const env = { ...process.env, PORT: String(port), NODE_ENV: "test", CLIENT_URL: ORIGIN, LLM_PROVIDER: "test-python", AI_SERVICE_URL: "http://localhost:5399", AUTH_PROVIDER: "eoi", KOI_SESSION_SECRET: SESSION_SECRET,
    KOI_PASSWORD_SCRYPT_LOG_N: "12", KOI_EMAIL_TRANSPORT: "outbox", KOI_EMAIL_OUTBOX_FILE: OUTBOX, OIDC_ISSUER: idp.issuer, OIDC_AUDIENCE: CLIENT_ID, OIDC_EXCHANGE_CLIENT_ID: CLIENT_ID,
    OIDC_EXCHANGE_CLIENT_SECRET: GOOGLE_SECRET, OIDC_EXCHANGE_REDIRECT_URIS: REDIRECT, KOI_SELF_REGISTRATION: "true", KOI_RATE_LIMIT_ENABLED: "false", ...extra };
  const child = spawn(process.execPath, [path.join(BACKEND, "server.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => { logs[logKey] += d; }); child.stderr.on("data", (d) => { logs[logKey] += d; });
  children.push(child);
  return child;
}
const PORT = 5711; const PORT_OFF = 5712; const PORT_LIM = 5713;
const API = `http://localhost:${PORT}/api`; const API_OFF = `http://localhost:${PORT_OFF}/api`; const API_LIM = `http://localhost:${PORT_LIM}/api`;

/** A tiny "browser": it keeps its own cookie jar and its own access token. */
function browser(api = API) {
  const b = { api, cookie: "", access: "" };
  b.call = async (method, route, { body, headers = {}, auth = true, cookie = true, trusted = false, rawBody } = {}) => {
    const h = { ...headers };
    if (body !== undefined || rawBody !== undefined) h["content-type"] = "application/json";
    if (auth && b.access) h.authorization = `Bearer ${b.access}`;
    if (cookie && b.cookie) h.cookie = b.cookie;
    if (trusted) { h["x-koi-request"] = "1"; h.origin = ORIGIN; }
    const res = await fetch(`${b.api}${route}`, { method, headers: h, body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)) });
    const setCookie = res.headers.getSetCookie?.() ?? [];
    for (const c of setCookie) {
      const [pair] = c.split(";");
      if (pair.startsWith("koi_rt=")) b.cookie = /koi_rt=$/.test(pair) || /Max-Age=0/i.test(c) ? "" : pair;
    }
    let json = null; const text = await res.text(); try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: json, text, setCookie, headers: res.headers };
  };
  b.adopt = (r) => { if (r.body?.data?.access_token) b.access = r.body.data.access_token; return r; };
  return b;
}
const outbox = () => (fs.existsSync(OUTBOX) ? read(OUTBOX).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const lastMail = (to, kind) => outbox().filter((m) => m.to === to && (!kind || m.kind === kind)).at(-1);
const tokenOf = (mail) => new URL(mail.link).searchParams.get("token");
const decodeJwt = (t) => ({ header: JSON.parse(Buffer.from(t.split(".")[0], "base64url")), payload: JSON.parse(Buffer.from(t.split(".")[1], "base64url")) });
const STRONG = "Correct-Horse-Battery-9!";
const mkAccount = async (b, email, name = "Test Person", password = STRONG) => {
  await b.call("POST", "/auth/signup", { body: { name, email, password, passwordConfirm: password }, auth: false });
  const mail = lastMail(email, "verify_email");
  if (mail) await b.call("POST", "/auth/verify-email", { body: { token: tokenOf(mail) }, auth: false });
  return mail;
};
const signedIn = async (email, password = STRONG, api = API) => { const b = browser(api); const r = await b.call("POST", "/auth/signin", { body: { email, password }, auth: false }); b.adopt(r); return { b, r }; };
const wait = async (cond, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await cond()) return true; await sleep(100); } return false; };
const health = async (api) => { for (let i = 0; i < 100; i += 1) { try { if ((await fetch(`${api}/health`)).ok) return true; } catch { /* starting */ } await sleep(200); } return false; };

try {
  // ======================================================================================================== A
  console.log("\n# A. configuration, hashing, password policy");
  const env = (over) => ({ NODE_ENV: "test", AUTH_PROVIDER: "eoi", KOI_SESSION_SECRET: SESSION_SECRET, ...over });
  const okCfg = resolveAuthConfig(env());
  check("A1 AUTH_PROVIDER=eoi resolves with a session secret and sensible defaults (10 min access, 14 day refresh, Lax cookie), and the secret is not enumerable", okCfg.provider === "eoi" && okCfg.problems.length === 0 && okCfg.eoi.accessTtlSeconds === 600 && okCfg.eoi.refreshTtlDays === 14 && okCfg.eoi.sameSite === "lax" && !JSON.stringify(okCfg).includes(SESSION_SECRET));
  check("A2 a missing or short session secret is a configuration problem (no session can be issued)", resolveAuthConfig(env({ KOI_SESSION_SECRET: "" })).problems.some((p) => /KOI_SESSION_SECRET/.test(p)) && resolveAuthConfig(env({ KOI_SESSION_SECRET: "short" })).eoi === null);
  const asMode = (mode, fn) => { const before = process.env.NODE_ENV; process.env.NODE_ENV = mode; try { return fn(); } finally { process.env.NODE_ENV = before; } };
  const prod = asMode("production", () => resolveAuthConfig({ AUTH_PROVIDER: "eoi", KOI_SESSION_SECRET: SESSION_SECRET, KOI_COOKIE_SECURE: "false" }));
  const prodOk = asMode("production", () => resolveAuthConfig({ AUTH_PROVIDER: "eoi", KOI_SESSION_SECRET: SESSION_SECRET }));
  check("A3 production requires secure cookies and refuses KOI_COOKIE_SECURE=false (secure is the default there); SameSite=None without Secure is refused; the stub is refused in production", prod.problems.some((p) => /secure/i.test(p)) && prodOk.problems.length === 0 && prodOk.eoi.secure === true && resolveAuthConfig(env({ KOI_COOKIE_SAMESITE: "none" })).problems.some((p) => /none/.test(p)) && asMode("production", () => resolveAuthConfig({ AUTH_PROVIDER: "stub" })).problems.length > 0);
  const asProd = (fn) => { const before = process.env.NODE_ENV; const lowered = process.env.KOI_PASSWORD_SCRYPT_LOG_N; process.env.NODE_ENV = "production"; process.env.KOI_PASSWORD_SCRYPT_LOG_N = "10"; try { return fn(); } finally { process.env.NODE_ENV = before; if (lowered === undefined) delete process.env.KOI_PASSWORD_SCRYPT_LOG_N; else process.env.KOI_PASSWORD_SCRYPT_LOG_N = lowered; } };
  const h1 = await hasher.hashPassword(STRONG); const h2 = await hasher.hashPassword(STRONG);
  check("A4 passwords are stored as scrypt with a random salt (two hashes of one password differ), the plaintext is not in the hash, and verification is exact", /^scrypt\$\d+\$8\$1\$[\w-]+\$[\w-]+$/.test(h1) && h1 !== h2 && !h1.includes(STRONG) && (await hasher.verifyPassword(STRONG, h1)) && !(await hasher.verifyPassword(`${STRONG}x`, h1)) && !(await hasher.verifyPassword("", h1)) && !(await hasher.verifyPassword(STRONG, "garbage")));
  check("A5 the cost can be raised later: a hash made with a lower cost reports needsRehash; production never goes below 2^15", hasher.needsRehash(h1.replace(`$${hasher.getScryptLogN()}$`, "$10$")) === true && hasher.needsRehash(h1) === false && asProd(() => hasher.getScryptLogN()) >= 15);
  const policy = (p, o) => hasher.checkPasswordPolicy(p, o);
  check("A6 weak passwords are refused with plain sentences: too short, common, all digits, repeated, containing the email, over-long; a strong passphrase passes", !policy("Ab1!").ok && !policy("password1234").ok && !policy("1234567890123").ok && !policy("aaaaaaaaaaaa").ok && !policy("jane.doe-2024!", { email: "jane.doe@example.com" }).ok && !policy("x".repeat(200)).ok && !policy("password12345").ok && !policy("P@ssw0rd2024!").ok && !policy("Welcome2024!!").ok && !policy("qwerty123456").ok && policy(STRONG).ok && policy("a long passphrase of words").ok);

  // ======================================================================================================== B
  console.log("\n# B. email + password");
  fs.writeFileSync(OUTBOX, "");
  startBackend(PORT, {}, "on"); startBackend(PORT_OFF, { KOI_SELF_REGISTRATION: "false", KOI_EMAIL_TRANSPORT: "" }, "on");
  if (!(await health(API)) || !(await health(API_OFF))) { console.error("backends did not start"); console.error(logs.on.slice(-1500)); process.exit(2); }

  const alice = browser(); const aliceEmail = "alice.p46@example.com";
  const su = await alice.call("POST", "/auth/signup", { body: { name: "Alice Example", email: "  Alice.P46@Example.com ", password: STRONG, passwordConfirm: STRONG }, auth: false });
  const aliceUser = await User.findOne({ emailNormalized: aliceEmail }).select("+passwordHash").lean();
  check("B1 sign-up answers 'check your email' (202), creates ONE account with a NORMALISED address, an unverified email and a scrypt hash - and the response contains no hash, no id and no token", su.status === 202 && su.body?.data?.status === "verification_sent" && Boolean(aliceUser) && aliceUser.emailVerified === false && aliceUser.email === aliceEmail && /^scrypt\$/.test(aliceUser.passwordHash) && !/scrypt|passwordHash|_id|token/i.test(su.text));
  check("B2 the stored record holds no plaintext password anywhere", !JSON.stringify(aliceUser).includes(STRONG));
  const mail1 = lastMail(aliceEmail, "verify_email");
  check("B3 a verification email was handed to the (development outbox) transport with a one-time link; only the HASH of the token is stored", Boolean(mail1) && /\/verify-email\?token=/.test(mail1.link) && (await AuthToken.countDocuments({ userId: aliceUser._id, purpose: "verify_email", tokenHash: crypto.createHash("sha256").update(tokenOf(mail1)).digest("hex") })) === 1 && (await AuthToken.countDocuments({ tokenHash: tokenOf(mail1) })) === 0);

  const badPw = await alice.call("POST", "/auth/signin", { body: { email: aliceEmail, password: "wrong-password-123" }, auth: false });
  const noUser = await alice.call("POST", "/auth/signin", { body: { email: "nobody.p46@example.com", password: "wrong-password-123" }, auth: false });
  check("B4 [no account enumeration] a wrong password for a real address and any password for an unknown address get the IDENTICAL 401 answer", badPw.status === 401 && noUser.status === 401 && badPw.text === noUser.text && /Invalid email or password/.test(badPw.text));
  const unverified = await alice.call("POST", "/auth/signin", { body: { email: aliceEmail, password: STRONG }, auth: false });
  check("B5 the RIGHT password on an unverified account is refused (403, no session, no cookie) until the address is verified", unverified.status === 403 && unverified.body?.details?.code === "EMAIL_NOT_VERIFIED" && unverified.setCookie.length === 0 && !unverified.text.includes("access_token"));

  const dup = await browser().call("POST", "/auth/signup", { body: { name: "Mallory", email: aliceEmail, password: "Different-Pass-77!", passwordConfirm: "Different-Pass-77!" }, auth: false });
  check("B6 [no account enumeration] signing up with an address that already has an account gets the SAME answer, creates no second user, leaves the password unchanged - and the owner is told by email", dup.status === 202 && dup.text === su.text && (await User.countDocuments({ emailNormalized: aliceEmail })) === 1 && Boolean(lastMail(aliceEmail, "account_exists")) && (await hasher.verifyPassword(STRONG, (await User.findOne({ emailNormalized: aliceEmail }).select("+passwordHash").lean()).passwordHash)));

  const bad = await Promise.all([
    { name: "", email: "x1@example.com", password: STRONG }, { name: "Bad Email", email: "not-an-email", password: STRONG }, { name: "Weak", email: "weak@example.com", password: "short1!" },
    { name: "Mismatch", email: "mm@example.com", password: STRONG, passwordConfirm: `${STRONG}z` }, { name: "<b>x</b>", email: "x2@example.com", password: STRONG }, { name: 12, email: "x3@example.com", password: STRONG },
  ].map((body) => browser().call("POST", "/auth/signup", { body, auth: false })));
  check("B7 invalid name / invalid email / weak password / mismatched confirmation / markup / non-string are each refused with 400 and plain wording, and create nothing", bad.every((r) => r.status === 400 && r.body?.details?.code === "INVALID_FIELD") && (await User.countDocuments({ emailNormalized: /^(x1|x2|x3|weak|mm)@/ })) === 0 && !bad.some((r) => /scrypt|stack|at \w+\.js/i.test(r.text)));

  // verification
  const expiredUser = await mkAccount(browser(), "expired.p46@example.com");
  await browser().call("POST", "/auth/signup", { body: { name: "Late Person", email: "late.p46@example.com", password: STRONG, passwordConfirm: STRONG }, auth: false });
  const lateMail = lastMail("late.p46@example.com", "verify_email");
  await AuthToken.updateOne({ tokenHash: crypto.createHash("sha256").update(tokenOf(lateMail)).digest("hex") }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  const lateTry = await browser().call("POST", "/auth/verify-email", { body: { token: tokenOf(lateMail) }, auth: false });
  check("B8 an EXPIRED verification link is refused with one generic answer and verifies nothing", lateTry.status === 400 && lateTry.body?.details?.code === "INVALID_LINK" && (await User.findOne({ emailNormalized: "late.p46@example.com" }).lean()).emailVerified === false);
  const v1 = await browser().call("POST", "/auth/verify-email", { body: { token: tokenOf(mail1) }, auth: false });
  const v2 = await browser().call("POST", "/auth/verify-email", { body: { token: tokenOf(mail1) }, auth: false });
  const vJunk = await browser().call("POST", "/auth/verify-email", { body: { token: "x".repeat(43) }, auth: false });
  check("B9 a verification link works ONCE (the second use and a made-up token get the same generic refusal) and then the address is verified", v1.status === 200 && v2.status === 400 && vJunk.status === 400 && v2.text === vJunk.text && (await User.findOne({ emailNormalized: aliceEmail }).lean()).emailVerified === true);

  // sign in
  const si = await alice.call("POST", "/auth/signin", { body: { email: "ALICE.P46@example.com ", password: STRONG }, auth: false });
  alice.adopt(si);
  const cookieAttrs = si.setCookie.find((c) => c.startsWith("koi_rt="));
  check("B10 sign-in with the right password gives an EOI access token in the body and the refresh token ONLY in an HttpOnly, SameSite=Lax, Path=/api/auth cookie (not in the body)", si.status === 200 && si.body?.data?.token_type === "Bearer" && si.body.data.expires_in === 600 && /HttpOnly/i.test(cookieAttrs) && /SameSite=Lax/i.test(cookieAttrs) && /Path=\/api\/auth/.test(cookieAttrs) && /Max-Age=\d+/.test(cookieAttrs) && !si.text.includes(alice.cookie.split("=")[1]) && !/refresh/i.test(Object.keys(si.body.data).join()));
  check("B11 no response of sign-up / sign-in contains a password hash, the password or an internal id", ![su.text, si.text, unverified.text].some((t) => /scrypt\$|passwordHash|Correct-Horse|"_id"/.test(t)));
  const sess = await alice.call("GET", "/auth/session");
  check("B12 the EOI access token authenticates: the account step answers for THIS user (no workspace yet -> needs_setup because self-service is on)", sess.status === 200 && sess.body?.data?.state === "needs_setup" && sess.body.data.workspaces.length === 0);
  const disabledPw = await mkAccount(browser(), "disabled.p46@example.com");
  await User.updateOne({ emailNormalized: "disabled.p46@example.com" }, { $set: { status: "disabled" } });
  const dis = await browser().call("POST", "/auth/signin", { body: { email: "disabled.p46@example.com", password: STRONG }, auth: false });
  check("B13 a disabled account cannot sign in (403, no session, no cookie)", dis.status === 403 && dis.body?.details?.code === "USER_DISABLED" && dis.setCookie.length === 0);

  // ======================================================================================================== C
  console.log("\n# C. the EOI session");
  const { header, payload } = decodeJwt(alice.access);
  check("C1 the access token is HS256, typ at+jwt, with iss eoi, aud eoi-api, sub = the EOI user id, sid, jti, iat, exp (10 min) and NOTHING else - no email, role, permission or workspace", header.alg === "HS256" && header.typ === "at+jwt" && payload.iss === "eoi" && payload.aud === "eoi-api" && payload.sub === String(aliceUser._id) && Object.keys(payload).sort().join() === "aud,exp,iat,iss,jti,sid,sub" && payload.exp - payload.iat === 600);
  const forge = (hdr, pl, key) => { const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url"); const data = `${enc(hdr)}.${enc(pl)}`; return key === null ? `${data}.` : `${data}.${crypto.createHmac("sha256", key).update(data).digest("base64url")}`; };
  const now = Math.floor(Date.now() / 1000);
  const good = { iss: "eoi", aud: "eoi-api", sub: payload.sub, sid: payload.sid, jti: "abcdefabcdefabcdefab", iat: now, exp: now + 300 };
  const forged = {
    none: forge({ alg: "none", typ: "at+jwt" }, good, null),
    wrongKey: forge({ alg: "HS256", typ: "at+jwt" }, good, "not-the-secret-not-the-secret-12345"),
    expired: forge({ alg: "HS256", typ: "at+jwt" }, { ...good, iat: now - 700, exp: now - 100 }, crypto.createHmac("sha256", SESSION_SECRET).update("eoi/access").digest()),
    wrongAud: forge({ alg: "HS256", typ: "at+jwt" }, { ...good, aud: "eoi-link" }, crypto.createHmac("sha256", SESSION_SECRET).update("eoi/access").digest()),
    tampered: `${alice.access.split(".")[0]}.${Buffer.from(JSON.stringify({ ...payload, sub: String(new mongoose.Types.ObjectId()) })).toString("base64url")}.${alice.access.split(".")[2]}`,
    otherSession: forge({ alg: "HS256", typ: "at+jwt" }, { ...good, sid: String(new mongoose.Types.ObjectId()) }, crypto.createHmac("sha256", SESSION_SECRET).update("eoi/access").digest()),
  };
  const forgedResults = await Promise.all(Object.entries(forged).map(async ([k, t]) => [k, (await browser().call("GET", "/auth/session", { headers: { authorization: `Bearer ${t}` }, auth: false, cookie: false })).status]));
  check("C2 forged tokens - alg none, wrong key, expired, wrong audience, tampered subject, a session id that does not exist - are all rejected with 401", forgedResults.every(([, s]) => s === 401), JSON.stringify(Object.fromEntries(forgedResults)));
  const withRole = forge({ alg: "HS256", typ: "at+jwt" }, { ...good, role: "admin", workspaceId: String(new mongoose.Types.ObjectId()), permissions: ["workspace:admin"] }, crypto.createHmac("sha256", SESSION_SECRET).update("eoi/access").digest());
  const roleTry = await browser().call("GET", "/auth/session", { headers: { authorization: `Bearer ${withRole}` }, auth: false, cookie: false });
  check("C3 a genuinely signed token that CARRIES role / workspace / permission claims has them ignored: the answer is exactly what the database says (this user has no workspace)", roleTry.status === 200 && roleTry.body.data.workspaces.length === 0 && roleTry.body.data.state === "needs_setup");

  // refresh
  const r0 = alice.cookie;
  const noHeader = await alice.call("POST", "/auth/refresh");
  const wrongOrigin = await alice.call("POST", "/auth/refresh", { headers: { "x-koi-request": "1", origin: "http://evil.example" } });
  check("C4 [CSRF] the cookie-authenticated refresh refuses a request without the custom header and one from another Origin (403) - and does not rotate or revoke", noHeader.status === 403 && wrongOrigin.status === 403 && alice.cookie === r0 && (await AuthSession.countDocuments({ userId: aliceUser._id, revokedAt: { $exists: true } })) === 0);
  const ref = await alice.call("POST", "/auth/refresh", { trusted: true });
  const rotatedCookie = alice.cookie;
  check("C5 refresh with the cookie gives a NEW access token and a ROTATED cookie (different value, same attributes); the access token is not in a cookie", ref.status === 200 && ref.body.data.access_token && ref.body.data.access_token !== alice.access && rotatedCookie !== r0 && /HttpOnly/i.test(ref.setCookie[0]));
  alice.adopt(ref);
  const oldCookieBrowser = browser(); oldCookieBrowser.cookie = r0;
  const grace = await oldCookieBrowser.call("POST", "/auth/refresh", { trusted: true });
  check("C6 [two tabs] the previous refresh token used again within the short grace window yields only an access token (no new cookie) and does NOT revoke the session", grace.status === 200 && grace.setCookie.length === 0 && (await AuthSession.countDocuments({ userId: aliceUser._id, revokedAt: { $exists: true } })) === 0);
  await AuthSession.updateOne({ userId: aliceUser._id }, { $set: { rotatedAt: new Date(Date.now() - 60_000) } });
  const reuse = await oldCookieBrowser.call("POST", "/auth/refresh", { trusted: true });
  const afterReuse = await alice.call("GET", "/auth/session");
  const afterReuseRefresh = await alice.call("POST", "/auth/refresh", { trusted: true });
  check("C7 [theft detection] an OLD refresh token presented after the grace window revokes the WHOLE session: that refresh fails, the current cookie fails, and the access token already issued stops working", reuse.status === 401 && afterReuseRefresh.status === 401 && afterReuse.status === 401 && (await AuthSession.findOne({ userId: aliceUser._id }).lean()).revokedReason === "reuse_detected");
  check("C8 a failed refresh clears the cookie and answers with ONE generic message that does not say why", afterReuseRefresh.setCookie.some((c) => /^koi_rt=;/.test(c) && /Max-Age=0/.test(c)) && /no longer valid/i.test(afterReuseRefresh.text) && !/reuse|revoked|theft/i.test(afterReuseRefresh.text));
  const noCookie = await browser().call("POST", "/auth/refresh", { trusted: true });
  const junkCookie = browser(); junkCookie.cookie = "koi_rt=0123456789abcdef01234567.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  check("C9 no cookie and a made-up cookie get the same 401", noCookie.status === 401 && (await junkCookie.call("POST", "/auth/refresh", { trusted: true })).status === 401);

  // two users, isolation, logout
  const A = (await signedIn(aliceEmail)).b; await mkAccount(browser(), "bob.p46@example.com", "Bob Example"); const B = (await signedIn("bob.p46@example.com")).b;
  const aSess = decodeJwt(A.access).payload; const bSess = decodeJwt(B.access).payload;
  check("C10 [multi-user] two browsers get two DIFFERENT users and two DIFFERENT sessions; each token names only its own user", aSess.sub !== bSess.sub && aSess.sid !== bSess.sid && A.cookie !== B.cookie);
  const aWs = await A.call("POST", "/auth/register", { body: { workspaceName: "Alice Workspace" } });
  const bWs = await B.call("POST", "/auth/register", { body: { workspaceName: "Bob Workspace" } });
  const aId = aWs.body.data.workspaces[0].id; const bId = bWs.body.data.workspaces[0].id;
  check("C11 each person's own workspace is created once, as ADMIN, and the session endpoint lists only their own", aWs.status === 201 && bWs.status === 201 && aId !== bId && aWs.body.data.workspaces.length === 1 && aWs.body.data.workspaces[0].role === "admin" && (await WorkspaceMembership.countDocuments({ role: "admin" })) >= 2);
  const out = await A.call("POST", "/auth/logout", { trusted: true });
  const aAfter = await A.call("GET", "/auth/session"); const aRefreshAfter = await A.call("POST", "/auth/refresh", { trusted: true }); const bStill = await B.call("GET", "/auth/session");
  check("C12 logout revokes the session on the server: the access token already issued fails, refresh fails, the cookie is cleared - and the OTHER person's session is untouched", out.status === 200 && out.setCookie.some((c) => /Max-Age=0/.test(c)) && aAfter.status === 401 && aRefreshAfter.status === 401 && bStill.status === 200 && bStill.body.data.workspaces[0].id === bId);
  check("C13 logout again (or with no cookie) is harmless and idempotent", (await A.call("POST", "/auth/logout", { trusted: true })).status === 200 && (await browser().call("POST", "/auth/logout", { trusted: true })).status === 200);
  const dUser = await mkAccount(browser(), "carol.p46@example.com", "Carol Example"); const Cb = (await signedIn("carol.p46@example.com")).b;
  await User.updateOne({ emailNormalized: "carol.p46@example.com" }, { $set: { status: "disabled" } });
  const dSession = await Cb.call("GET", "/auth/session"); const dRefresh = await Cb.call("POST", "/auth/refresh", { trusted: true });
  check("C14 disabling a user takes effect at once: the existing access token and the refresh both fail", dSession.status === 403 && dRefresh.status === 401);
  check("C15 only the session id and hashes are stored for sessions: no refresh secret and no access token in the database", !JSON.stringify(await AuthSession.find().lean()).includes(rotatedCookie.split(".")[1]) && (await AuthSession.find().lean()).every((s) => /^[0-9a-f]{64}$/.test(s.currentHash)));

  // ======================================================================================================== D
  console.log("\n# D. forgot / reset password");
  const f1 = await browser().call("POST", "/auth/forgot-password", { body: { email: aliceEmail }, auth: false });
  const f2 = await browser().call("POST", "/auth/forgot-password", { body: { email: "ghost.p46@example.com" }, auth: false });
  const f3 = await browser().call("POST", "/auth/forgot-password", { body: { email: "not an email" }, auth: false });
  check("D1 [no account enumeration] forgot-password answers the IDENTICAL generic 202 for a real address, an unknown address and garbage; nothing is mailed to a stranger", f1.status === 202 && f1.text === f2.text && f2.text === f3.text && !lastMail("ghost.p46@example.com") && Boolean(lastMail(aliceEmail, "reset_password")));
  const resetMail = lastMail(aliceEmail, "reset_password"); const resetToken = tokenOf(resetMail);
  const rWeak = await browser().call("POST", "/auth/reset-password", { body: { token: resetToken, password: "short", passwordConfirm: "short" }, auth: false });
  const rMismatch = await browser().call("POST", "/auth/reset-password", { body: { token: resetToken, password: "A-new-Strong-Pass-55!", passwordConfirm: "different" }, auth: false });
  check("D2 a weak or mismatched new password is refused and does NOT use up the link", rWeak.status === 400 && rMismatch.status === 400 && (await AuthToken.findOne({ purpose: "reset_password", tokenHash: crypto.createHash("sha256").update(resetToken).digest("hex") }).lean()).usedAt === undefined);
  const A2 = (await signedIn(aliceEmail)).b; // a second signed-in browser that the reset must sign out
  const NEWPW = "A-new-Strong-Pass-55!";
  const rOk = await browser().call("POST", "/auth/reset-password", { body: { token: resetToken, password: NEWPW, passwordConfirm: NEWPW }, auth: false });
  const rAgain = await browser().call("POST", "/auth/reset-password", { body: { token: resetToken, password: "Another-Strong-Pass-66!", passwordConfirm: "Another-Strong-Pass-66!" }, auth: false });
  check("D3 the reset link works ONCE: the password changes, the second use is the generic refusal", rOk.status === 200 && rAgain.status === 400 && rAgain.body.details.code === "INVALID_LINK");
  check("D4 after a reset every existing session is revoked (the other browser is signed out), the OLD password no longer works and the NEW one does", (await A2.call("GET", "/auth/session")).status === 401 && (await A2.call("POST", "/auth/refresh", { trusted: true })).status === 401 && (await signedIn(aliceEmail, STRONG)).r.status === 401 && (await signedIn(aliceEmail, NEWPW)).r.status === 200);
  await AuthToken.updateOne({ purpose: "reset_password" }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  await browser().call("POST", "/auth/forgot-password", { body: { email: aliceEmail }, auth: false });
  const expiredReset = lastMail(aliceEmail, "reset_password");
  await AuthToken.updateMany({ purpose: "reset_password" }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  check("D5 an expired reset link is refused with the same generic answer", (await browser().call("POST", "/auth/reset-password", { body: { token: tokenOf(expiredReset), password: "Yet-Another-Pass-77!", passwordConfirm: "Yet-Another-Pass-77!" }, auth: false })).status === 400);

  // ======================================================================================================== E
  console.log("\n# E. Google under the unified session (local Google-like provider; no real Google account)");
  const googleSignIn = async (api, sub, email, { emailVerified = true } = {}) => {
    idp.config.sub = sub; idp.config.email = email; idp.config.extraClaims = { email_verified: emailVerified };
    const verifier = crypto.randomBytes(48).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    const authorize = await fetch(`${idp.issuer}/authorize?${new URLSearchParams({ response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT, scope: "openid profile email", state: "s", code_challenge: challenge, code_challenge_method: "S256" })}`, { redirect: "manual" });
    const code = new URL(authorize.headers.get("location")).searchParams.get("code");
    const b = browser(api);
    const r = await b.call("POST", "/auth/oidc/token", { body: { code, code_verifier: verifier, redirect_uri: REDIRECT }, auth: false });
    b.adopt(r); return { b, r, code, verifier };
  };
  const g1 = await googleSignIn(API, "109000000000000000001", "gina.p46@example.com");
  const gUser = await User.findOne({ subject: "109000000000000000001" }).lean();
  check("E1 [new Google user] the code exchange returns an EOI SESSION (access token + HttpOnly cookie), not Google's token; a user is created with the provider's verified email", g1.r.status === 200 && g1.r.body.data.status === "signed_in" && decodeJwt(g1.b.access).payload.iss === "eoi" && decodeJwt(g1.b.access).payload.sub === String(gUser._id) && /HttpOnly/i.test(g1.r.setCookie[0]) && gUser.emailVerified === true && gUser.email === "gina.p46@example.com");
  check("E2 the response carries no Google token, id token, client secret or provider profile", !/id_token|ya29|GOCSPX|p46-test-client-secret|picture|Test Person/.test(g1.r.text));
  const gSess = await g1.b.call("GET", "/auth/session");
  check("E3 the Google user is in the SAME contract as a password user: the account step says needs_setup, then setting up creates their own workspace as admin (one user, one workspace, one membership)", gSess.body.data.state === "needs_setup" && (await g1.b.call("POST", "/auth/register", { body: { workspaceName: "Gina Group" } })).status === 201 && (await WorkspaceMembership.countDocuments({ userId: gUser._id })) === 1);
  const g2 = await googleSignIn(API, "109000000000000000001", "gina.p46@example.com");
  check("E4 [existing Google user] signing in again resolves to the SAME user (no duplicate user, no second workspace) with a new, separate session", g2.r.body.data.status === "signed_in" && decodeJwt(g2.b.access).payload.sub === String(gUser._id) && decodeJwt(g2.b.access).payload.sid !== decodeJwt(g1.b.access).payload.sid && (await User.countDocuments({ subject: "109000000000000000001" })) === 1 && (await g2.b.call("GET", "/auth/session")).body.data.state === "member");
  const replay = await fetch(`${API}/auth/oidc/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: g2.code, code_verifier: g2.verifier, redirect_uri: REDIRECT }) });
  const wrongRedirect = await fetch(`${API}/auth/oidc/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: g2.code, code_verifier: g2.verifier, redirect_uri: "http://evil.example/" }) });
  check("E5 [exchange stays protected] a replayed authorization code and a redirect URI that is not on the server's list are refused", replay.status === 400 && wrongRedirect.status === 400);
  const googleStyleToken = await idp.mintToken({ sub: "109000000000000000001", aud: CLIENT_ID, email: "gina.p46@example.com" });
  const asBearer = await browser().call("GET", "/auth/session", { headers: { authorization: `Bearer ${googleStyleToken}` }, auth: false, cookie: false });
  check("E6 under AUTH_PROVIDER=eoi a genuine, correctly signed provider (Google-style) token is never accepted as an API bearer", asBearer.status === 401);
  const restricted = await googleSignIn(API_OFF, "109000000000000000002", "nina.p46@example.com");
  check("E7 [self-service off] an unknown Google identity gets 'access_restricted' with NO session, NO cookie and NO user created", restricted.r.body.data.status === "access_restricted" && restricted.r.setCookie.length === 0 && !restricted.r.text.includes("access_token") && (await User.countDocuments({ subject: "109000000000000000002" })) === 0);
  // provisioned (operator) user
  await User.create({ issuer: idp.issuer, subject: "109000000000000000003", email: "olga.p46@example.com", status: "active" });
  const op = await googleSignIn(API_OFF, "109000000000000000003", "olga.p46@example.com");
  check("E8 an operator-provisioned Google user (existing record) signs in even with self-service off, and the session is an EOI session", op.r.body.data.status === "signed_in" && decodeJwt(op.b.access).payload.iss === "eoi");

  // account linking
  await mkAccount(browser(), "pat.p46@example.com", "Pat Example");
  const link1 = await googleSignIn(API, "109000000000000000004", "pat.p46@example.com");
  check("E9 [linking] a Google sign-in whose VERIFIED email matches an existing verified PASSWORD account is NOT merged: it returns link_required with a ticket and NO session, and no user or identity is created", link1.r.body.data.status === "link_required" && Boolean(link1.r.body.data.link_ticket) && link1.r.setCookie.length === 0 && !link1.r.text.includes("access_token") && (await User.countDocuments({ subject: "109000000000000000004" })) === 0 && (await AuthIdentity.countDocuments({ subject: "109000000000000000004" })) === 0);
  const ticket = link1.r.body.data.link_ticket;
  const linkWrong = await browser().call("POST", "/auth/google/link", { body: { linkTicket: ticket, password: "wrong-password-123" }, auth: false });
  const linkForged = await browser().call("POST", "/auth/google/link", { body: { linkTicket: `${ticket.slice(0, -4)}AAAA`, password: STRONG }, auth: false });
  const linkAsAccess = await browser().call("POST", "/auth/google/link", { body: { linkTicket: (await signedIn("pat.p46@example.com")).b.access, password: STRONG }, auth: false });
  check("E10 linking needs BOTH proofs: a wrong password, a forged ticket and an ACCESS token used as a ticket all fail with the same generic 401 and link nothing", [linkWrong, linkForged, linkAsAccess].every((r) => r.status === 401 && r.body.details.code === "LINK_FAILED") && linkWrong.text === linkForged.text && (await AuthIdentity.countDocuments({ subject: "109000000000000000004" })) === 0);
  const linked = await browser().call("POST", "/auth/google/link", { body: { linkTicket: ticket, password: STRONG }, auth: false });
  const patUser = await User.findOne({ emailNormalized: "pat.p46@example.com" }).lean();
  check("E11 with the ticket AND the right password the Google identity is linked to the EXISTING user (still one user) and a session is issued", linked.status === 200 && linked.body.data.status === "signed_in" && decodeJwt(linked.body.data.access_token).payload.sub === String(patUser._id) && (await User.countDocuments({ emailNormalized: "pat.p46@example.com" })) === 1 && (await AuthIdentity.countDocuments({ userId: patUser._id, subject: "109000000000000000004" })) === 1);
  const link2 = await googleSignIn(API, "109000000000000000004", "pat.p46@example.com");
  check("E12 afterwards Google sign-in goes straight to the SAME user (no link step, no duplicate), and the password still works too - one account, two ways in", link2.r.body.data.status === "signed_in" && decodeJwt(link2.b.access).payload.sub === String(patUser._id) && (await signedIn("pat.p46@example.com")).r.status === 200);
  // unverified password account + Google verified email -> adopt
  await browser().call("POST", "/auth/signup", { body: { name: "Victim Person", email: "victim.p46@example.com", password: "Attacker-Chosen-Pass-1!", passwordConfirm: "Attacker-Chosen-Pass-1!" }, auth: false });
  const victim = await googleSignIn(API, "109000000000000000005", "victim.p46@example.com");
  const victimUser = await User.findOne({ emailNormalized: "victim.p46@example.com" }).select("+passwordHash").lean();
  check("E13 [pre-registration attack] an UNVERIFIED password account for an address does not block its real owner: Google (which proved the address) signs in, the unproven password is REMOVED, and the attacker's password no longer works", victim.r.body.data.status === "signed_in" && decodeJwt(victim.b.access).payload.sub === String(victimUser._id) && victimUser.passwordHash === undefined && victimUser.emailVerified === true && (await User.countDocuments({ emailNormalized: "victim.p46@example.com" })) === 1 && (await signedIn("victim.p46@example.com", "Attacker-Chosen-Pass-1!")).r.status === 401);
  // google email NOT verified -> never used for linking
  await mkAccount(browser(), "quinn.p46@example.com", "Quinn Example");
  const unv = await googleSignIn(API, "109000000000000000006", "quinn.p46@example.com", { emailVerified: false });
  const unvUser = await User.findOne({ subject: "109000000000000000006" }).lean();
  check("E14 a Google identity whose email is NOT verified by Google is never matched to a password account: it becomes its own (unverified-email) user", unv.r.body.data.status === "signed_in" && unvUser && unvUser.emailVerified === false && String(unvUser._id) !== String((await User.findOne({ emailNormalized: "quinn.p46@example.com" }).lean())._id));
  // a Google-only user can set a password through reset (email proof)
  await browser().call("POST", "/auth/forgot-password", { body: { email: "gina.p46@example.com" }, auth: false });
  const ginaReset = lastMail("gina.p46@example.com", "reset_password");
  check("E15 a Google-created user may add a password through the emailed reset link (email ownership), without creating a second account", Boolean(ginaReset) && (await browser().call("POST", "/auth/reset-password", { body: { token: tokenOf(ginaReset), password: "Gina-New-Strong-Pass-1!", passwordConfirm: "Gina-New-Strong-Pass-1!" }, auth: false })).status === 200 && (await signedIn("gina.p46@example.com", "Gina-New-Strong-Pass-1!")).r.status === 200 && (await User.countDocuments({ emailNormalized: "gina.p46@example.com" })) === 1);

  // ======================================================================================================== F
  console.log("\n# F. authorization");
  const PA = (await signedIn(aliceEmail, NEWPW)).b; const PB = B;
  const aliceWs = (await PA.call("GET", "/auth/session")).body.data;
  const aliceWsId = aliceWs.workspaces[0]?.id ?? (await PA.call("POST", "/auth/register", { body: { workspaceName: "Alice Again" } })).body.data.workspaces[0].id;
  const bobWsId = bId;
  const own = await PA.call("GET", `/properties?workspaceId=${aliceWsId}`);
  const foreign = await PA.call("GET", `/properties?workspaceId=${bobWsId}`);
  const foreignBob = await PB.call("GET", `/properties?workspaceId=${aliceWsId}`);
  check("F1 [cross-workspace] each person reads their own workspace (200) and gets the SAME safe 404 for the other's, in both directions", own.status === 200 && foreign.status === 404 && foreignBob.status === 404 && foreign.text === foreignBob.text);
  const forgedCreate = await PA.call("POST", "/properties", { body: { workspaceId: bobWsId, name: "Hijack", code: "HJ1" } });
  const forgedHeader = await PA.call("GET", `/properties?workspaceId=${aliceWsId}`, { headers: { "x-workspace-id": bobWsId, "x-role": "admin", "x-user-id": String(patUser._id) } });
  check("F2 [forged workspace / role / user id] a write naming another workspace is refused, and extra role / user / workspace headers change nothing", forgedCreate.status === 404 && forgedHeader.status === 200 && (await Workspace.countDocuments({ _id: bobWsId })) === 1 && (await mongoose.connection.db.collection("properties").countDocuments({ workspaceId: new mongoose.Types.ObjectId(bobWsId) })) === 0);
  const reg2 = await PA.call("POST", "/auth/register", { body: { workspaceName: "Second Attempt", role: "admin", workspaceId: bobWsId, userId: String(patUser._id) } });
  check("F3 a person who already has a workspace cannot create another through the setup call, and cannot pass a role / workspace / user id into it (409, nothing created)", reg2.status === 409 && (await WorkspaceMembership.countDocuments({ userId: decodeJwt(PA.access).payload.sub })) === 1);
  const newcomer = browser(); await mkAccount(newcomer, "dana.p46@example.com", "Dana Example"); newcomer.adopt((await newcomer.call("POST", "/auth/signin", { body: { email: "dana.p46@example.com", password: STRONG }, auth: false })));
  const danaReg = await newcomer.call("POST", "/auth/register", { body: { workspaceName: "Dana Co", role: "viewer", workspaceId: aliceWsId, userId: decodeJwt(PA.access).payload.sub, subject: "x", issuer: "evil" } });
  const danaMembers = await WorkspaceMembership.find({ userId: decodeJwt(newcomer.access).payload.sub }).lean();
  check("F4 [no escalation at sign-up] a new person who sends a role, another workspace id and another user id gets ONE new workspace as admin, and no membership in anyone else's workspace", danaReg.status === 201 && danaMembers.length === 1 && danaMembers[0].role === "admin" && String(danaMembers[0].workspaceId) !== aliceWsId && (await WorkspaceMembership.countDocuments({ workspaceId: aliceWsId })) === 1);
  const noMember = browser(); await mkAccount(noMember, "erin.p46@example.com", "Erin Example"); noMember.adopt(await noMember.call("POST", "/auth/signin", { body: { email: "erin.p46@example.com", password: STRONG }, auth: false }));
  const noMemberRead = await noMember.call("GET", `/properties?workspaceId=${aliceWsId}`);
  check("F5 [missing membership] an authenticated person with NO membership gets the same 404 for an existing workspace as for a missing one", noMemberRead.status === 404 && noMemberRead.text === foreign.text);
  const sameSession = await PA.call("GET", "/auth/session");
  check("F6 the role comes from the database: the admin's own session says admin; the account step never returns another person's data", sameSession.body.data.workspaces.every((w) => w.role === "admin") && !sameSession.text.includes(bobWsId));

  // ======================================================================================================== G
  console.log("\n# G. rate limiting (limits ON, tiny maxima)");
  startBackend(PORT_LIM, { KOI_RATE_LIMIT_ENABLED: "true", KOI_AUTH_SIGNIN_EMAIL_MAX: "3", KOI_AUTH_SIGNIN_IP_MAX: "12", KOI_AUTH_SIGNUP_IP_MAX: "3", KOI_AUTH_RESET_EMAIL_MAX: "2", KOI_AUTH_RESET_IP_MAX: "5", KOI_AUTH_REFRESH_IP_MAX: "4", KOI_AUTH_VERIFY_IP_MAX: "3", KOI_RATE_LIMIT_ANON_MAX: "500", KOI_RATE_LIMIT_IP_MAX: "5000" }, "limited");
  if (!(await health(API_LIM))) { console.error("limited backend did not start"); process.exit(2); }
  const lim = browser(API_LIM);
  const attempts = []; for (let i = 0; i < 5; i += 1) attempts.push((await lim.call("POST", "/auth/signin", { body: { email: aliceEmail, password: `wrong-${i}-password!` }, auth: false })).status);
  const otherEmail = await lim.call("POST", "/auth/signin", { body: { email: "someone.else.p46@example.com", password: "wrong-password-123" }, auth: false });
  check("G1 [brute force] repeated wrong passwords for ONE address are limited (401, 401, 401, then 429) by the server, while another address from the same client is still answered normally", JSON.stringify(attempts) === JSON.stringify([401, 401, 401, 429, 429]) && otherEmail.status === 401);
  const limited = await lim.call("POST", "/auth/signin", { body: { email: aliceEmail, password: NEWPW }, auth: false });
  check("G2 the limit also stops the RIGHT password for the limited address, and a 429 reveals nothing about the account (same body for a real and an unknown address)", limited.status === 429 && !limited.text.includes("access_token") && (await lim.call("POST", "/auth/signin", { body: { email: "ghost2.p46@example.com", password: "x".repeat(12) }, auth: false })).status === 401 && (await (async () => { for (let i = 0; i < 4; i += 1) await lim.call("POST", "/auth/signin", { body: { email: "ghost3.p46@example.com", password: "x".repeat(12) }, auth: false }); return (await lim.call("POST", "/auth/signin", { body: { email: "ghost3.p46@example.com", password: "x".repeat(12) }, auth: false })).text; })()) === limited.text);
  const signups = []; for (let i = 0; i < 5; i += 1) signups.push((await lim.call("POST", "/auth/signup", { body: { name: "Burst Person", email: `burst${i}.p46@example.com`, password: STRONG, passwordConfirm: STRONG }, auth: false })).status);
  check("G3 sign-up is limited per client address (202, 202, 202, then 429)", signups.slice(0, 3).every((s) => s === 202) && signups.slice(3).every((s) => s === 429), JSON.stringify(signups));
  const resets = []; for (let i = 0; i < 4; i += 1) resets.push((await lim.call("POST", "/auth/forgot-password", { body: { email: "reset.target.p46@example.com" }, auth: false })).status);
  check("G4 forgot-password is limited per address (202, 202, then 429) - and the 429 is not a signal of whether the address exists", resets.join() === "202,202,429,429");
  const refreshes = []; for (let i = 0; i < 6; i += 1) refreshes.push((await lim.call("POST", "/auth/refresh", { trusted: true })).status);
  check("G5 the refresh endpoint is limited per client address", refreshes.filter((s) => s === 429).length >= 2, refreshes.join());
  const verifies = []; for (let i = 0; i < 5; i += 1) verifies.push((await lim.call("POST", "/auth/verify-email", { body: { token: "x".repeat(43) }, auth: false })).status);
  check("G6 verification-token guessing is limited per client address", verifies.filter((s) => s === 429).length >= 2, verifies.join());

  // ======================================================================================================== H
  console.log("\n# H. nothing sensitive in responses or logs");
  const allLogs = `${logs.on}\n${logs.limited}`;
  const sensitive = [STRONG, NEWPW, SESSION_SECRET, GOOGLE_SECRET, "Attacker-Chosen-Pass-1!", "Gina-New-Strong-Pass-1!", ...[...outbox()].flatMap((m) => [tokenOf(m)].filter(Boolean)), ...[aliceUser.passwordHash]];
  check("H1 the server's console / structured logs contain no password, no password hash, no session secret, no Google client secret and no email token or link", sensitive.every((s) => s && !allLogs.includes(s)) && !/passwordHash|koi_rt=/.test(allLogs));
  check("H2 the development outbox is outside the repository's tracked files (git-ignored) and the client secret never appears in it", /\.dev-outbox\//.test(read(path.join(BACKEND, ".gitignore"))) && !read(OUTBOX).includes(GOOGLE_SECRET));
} finally {
  for (const c of children) c.kill();
  await idp.close();
  try { await mongoose.connection.dropDatabase(); } catch { /* best effort */ }
  await mongoose.disconnect();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`\nPhase 46 unified authentication validation: ${passed} passed, ${failed} failed (isolated database ${DB_NAME} dropped; local Google-like provider - no real Google account was used)`);
process.exit(failed === 0 ? 0 : 1);
