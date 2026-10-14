/**
 * Phase 45C validation - account onboarding (BACKEND): GET /api/auth/session and POST /api/auth/register.
 *
 *   node backend/scripts/validate-phase45c-account-onboarding.mjs
 *
 * Real backends (self-registration ON, and a second with it OFF) on an ISOLATED database, a local Google-like provider supplying identities, and every
 * token obtained through the REAL path (authorize -> server-side code exchange). The model under test: Identity (issuer + subject, from the VERIFIED
 * token) -> User -> WorkspaceMembership -> role -> permissions. Authentication says who; registering creates only the person's OWN new workspace.
 *
 *   A  the session: read-only, correct for new / existing / disabled / revoked identities, no leakage
 *   B  registering: creates exactly User + Workspace + one admin Membership in THAT workspace; ignores anything but the workspace name
 *   C  what a new account can and cannot do: nothing in anyone else's workspace; existing members unaffected; RBAC unchanged
 *   D  hostile input, replay, concurrency, disabled self-registration
 *   E  authentication on these routes: no token / bad token / wrong issuer / audience / expired
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(here, "..");
const read = (p) => fs.readFileSync(p, "utf8");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, "$1");
let passed = 0; let failed = 0;
const check = (name, ok, detail = "") => { if (ok) { passed += 1; console.log(`PASS  ${name}${detail ? ` - ${detail}` : ""}`); } else { failed += 1; console.error(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

{ const __u = dotenv.parse(process.getBuiltinModule("node:fs").readFileSync(new URL("../.env", import.meta.url))).MONGODB_URI ?? ""; if (/^mongodb:\/\/(?:[^@/]*@)?(localhost|127\.0\.0\.1)/i.test(__u)) process.env.MONGODB_URI ??= __u; } // validation / rehearsal tools take ONLY a loopback database URI from backend/.env, never its real settings
const baseUri = process.env.MONGODB_URI;
const stamp = Date.now();
const DB_NAME = `koi_p45c_${stamp}`;
if (!baseUri || /^mongodb\+srv:|@/.test(baseUri) || !/^mongodb:\/\/(localhost|127\.0\.0\.1)/.test(baseUri)) { console.error("refusing: the configured MongoDB is not a plain loopback instance"); process.exit(2); }
process.env.MONGODB_URI = baseUri.replace(/(mongodb:\/\/[^/]+\/)([^?]*)/, `$1${DB_NAME}`);
process.env.NODE_ENV = "test";
for (const k of ["AUTH_STUB_SECRET", "AUTH_TOKEN_VERIFIER", "AUTH_PROVIDER", "OIDC_EXCHANGE_CLIENT_ID", "OIDC_EXCHANGE_CLIENT_SECRET", "OIDC_EXCHANGE_REDIRECT_URIS", "KOI_SELF_REGISTRATION"]) delete process.env[k];

const mongoose = (await import("mongoose")).default;
const { connectDatabase } = await import("../src/config/database.js");
const { User, Workspace, WorkspaceMembership, Signal } = await import("../src/models/index.js");
await connectDatabase();
if (mongoose.connection.db.databaseName !== DB_NAME) { console.error("refusing: not connected to the isolated database"); process.exit(2); }
const { startLocalOidcProvider } = await import("./lib/localOidcProvider.mjs");

const CLIENT_ID = "790571179268-test-client.apps.googleusercontent.com";
const SECRET = "test-client-secret-not-real-91ac03d7";
const ORIGIN = "http://localhost:5175"; const REDIRECT = `${ORIGIN}/`;
const idp = await startLocalOidcProvider({ audience: CLIENT_ID, clientId: CLIENT_ID });
Object.assign(idp.config, { googleMode: true, clientSecret: SECRET });
const ON = 5501; const OFF = 5502;
const children = [];
let logs = "";
try {
  const spawnBackend = (port, selfReg) => {
    const c = spawn(process.execPath, [path.join(BACKEND, "server.js")], { env: { ...process.env, PORT: String(port), NODE_ENV: "test", CLIENT_URL: ORIGIN, KOI_RATE_LIMIT_ENABLED: "false", LLM_PROVIDER: "test-python", AI_SERVICE_URL: "http://localhost:5399", AUTH_PROVIDER: "oidc", OIDC_ISSUER: idp.issuer, OIDC_AUDIENCE: CLIENT_ID, OIDC_EXCHANGE_CLIENT_ID: CLIENT_ID, OIDC_EXCHANGE_CLIENT_SECRET: SECRET, OIDC_EXCHANGE_REDIRECT_URIS: REDIRECT, KOI_SELF_REGISTRATION: selfReg ? "true" : "false" }, stdio: ["ignore", "pipe", "pipe"] });
    c.stdout.on("data", (d) => { logs += d.toString(); }); c.stderr.on("data", (d) => { logs += d.toString(); });
    children.push(c);
  };
  spawnBackend(ON, true); spawnBackend(OFF, false);
  for (const port of [ON, OFF]) for (let i = 0; i < 100; i += 1) { try { if ((await fetch(`http://localhost:${port}/api/health`)).ok) break; } catch { /* starting */ } await sleep(200); }

  const api = (port) => `http://localhost:${port}/api`;
  const pkce = () => { const v = crypto.randomBytes(48).toString("base64url"); return { v, c: crypto.createHash("sha256").update(v).digest("base64url") }; };
  const reset = () => Object.assign(idp.config, { authorize: "ok", tokenMode: "ok", discoveryMode: "ok", idTokenMode: "ok", googleMode: true, clientSecret: SECRET, extraClaims: {}, email: undefined, ttlSeconds: 3600 });
  /** A real bearer for `sub`: authorize at the provider, then the server-side code exchange. */
  const bearerFor = async (sub, { email, claims, port = ON } = {}) => {
    reset(); idp.config.sub = sub; idp.config.email = email; idp.config.extraClaims = claims ?? {};
    const { v, c } = pkce(); const u = new URL(`${idp.issuer}/authorize`);
    for (const [k, val] of Object.entries({ response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT, scope: "openid profile email", state: "s", code_challenge: c, code_challenge_method: "S256" })) u.searchParams.set(k, val);
    const r = await fetch(u, { redirect: "manual" }); const code = new URL(r.headers.get("location")).searchParams.get("code");
    const x = await fetch(`${api(port)}/auth/oidc/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, code_verifier: v, redirect_uri: REDIRECT }) });
    return (await x.json())?.data?.access_token;
  };
  const call = async (method, url, token, body, port = ON, headers = {}) => { const r = await fetch(`${api(port)}${url}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, body: body !== undefined ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined }); const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* none */ } return { status: r.status, json, text, code: json?.details?.code, data: json?.data }; };
  const counts = async () => ({ users: await User.countDocuments(), workspaces: await Workspace.countDocuments(), memberships: await WorkspaceMembership.countDocuments() });

  // ---- fixtures: an EXISTING organisation with an admin and a viewer; a disabled user; a revoked member
  const org = await Workspace.create({ name: "Existing Org", slug: `existing-${stamp}`, status: "active" });
  const mk = async (sub, role, ws, extra = {}) => { const u = await User.create({ issuer: idp.issuer, subject: sub, email: extra.email, status: extra.status ?? "active" }); if (role) await WorkspaceMembership.create({ userId: u._id, workspaceId: ws._id, role, status: extra.mStatus ?? "active" }); return u; };
  const S = { admin: "100000000000000000001", viewer: "100000000000000000002", disabled: "100000000000000000003", revoked: "100000000000000000004", fresh1: "200000000000000000001", fresh2: "200000000000000000002", fresh3: "200000000000000000003", fresh4: "200000000000000000004", hostile: "200000000000000000005", race: "200000000000000000006", off: "200000000000000000007", other: "200000000000000000008" };
  await mk(S.admin, "admin", org, { email: "admin@example.invalid" }); await mk(S.viewer, "viewer", org); await mk(S.disabled, "operator", org, { status: "disabled" }); await mk(S.revoked, "operator", org, { mStatus: "revoked" });
  await Signal.create({ workspaceId: org._id, type: "maintenance", severity: "low", title: "Org signal", description: "Belongs to the existing organisation." });
  const ORG = String(org._id);

  // ======================================================================================================== A. the session
  console.log("\n# A. GET /api/auth/session (read-only)");
  const tFresh = await bearerFor(S.fresh1, { email: "Fresh.One@Example.invalid" });
  const before = await counts();
  const s1 = await call("GET", "/auth/session", tFresh);
  const after = await counts();
  check("A1 a brand-new identity (no EOI account) is told 'needs_setup' (self-registration on): authenticated, NOT rejected with 403", s1.status === 200 && s1.data.state === "needs_setup" && s1.data.selfRegistration === true && Array.isArray(s1.data.workspaces) && s1.data.workspaces.length === 0);
  check("A2 reading the session creates NOTHING (no user, no workspace, no membership) - it is strictly read-only, also when called repeatedly", JSON.stringify(before) === JSON.stringify(after) && (await call("GET", "/auth/session", tFresh)).data.state === "needs_setup" && JSON.stringify(await counts()) === JSON.stringify(before));
  const sAdmin = await call("GET", "/auth/session", await bearerFor(S.admin));
  check("A3 an existing member is 'member' and sees ONLY their own workspaces, with their role", sAdmin.data.state === "member" && sAdmin.data.workspaces.length === 1 && sAdmin.data.workspaces[0].id === ORG && sAdmin.data.workspaces[0].role === "admin" && sAdmin.data.workspaces[0].name === "Existing Org");
  const sViewer = await call("GET", "/auth/session", await bearerFor(S.viewer));
  check("A4 the role reported is the membership's role (viewer stays viewer): the session shows, it does not grant", sViewer.data.workspaces[0].role === "viewer");
  const sDis = await call("GET", "/auth/session", await bearerFor(S.disabled));
  check("A5 a disabled user is refused (403 USER_DISABLED), not offered account setup", sDis.status === 403 && sDis.code === "USER_DISABLED");
  const sRev = await call("GET", "/auth/session", await bearerFor(S.revoked));
  check("A6 a user whose only membership was revoked sees no workspaces and is offered setup of their own (never the revoked one back)", sRev.data.state === "needs_setup" && sRev.data.workspaces.length === 0);
  check("A7 the session carries only { state, selfRegistration, workspaces[{id,name,role}] }: no issuer, subject, email, token, secret or other users", JSON.stringify(Object.keys(s1.data).sort()) === JSON.stringify(["selfRegistration", "state", "workspaces"]) && sAdmin.data.workspaces.every((w) => JSON.stringify(Object.keys(w).sort()) === JSON.stringify(["id", "name", "role"])) && !/issuer|subject|email|@|accounts\.|127\.0\.0\.1|GOCSPX|eyJ/.test(sAdmin.text) && !sAdmin.text.includes(SECRET));
  const sOff = await call("GET", "/auth/session", await bearerFor(S.off, { port: OFF }), undefined, OFF);
  check("A8 with self-registration OFF a new identity is 'access_restricted' (an administrator must grant access); a member is still a member", sOff.status === 200 && sOff.data.state === "access_restricted" && sOff.data.selfRegistration === false && (await call("GET", "/auth/session", await bearerFor(S.admin, { port: OFF }), undefined, OFF)).data.state === "member");

  // ======================================================================================================== B. registering
  console.log("\n# B. POST /api/auth/register");
  const hostileBody = { workspaceName: "  Harbour   View  Apartments ", role: "admin", workspaceId: ORG, userId: "000000000000000000000001", issuer: "https://evil.example", subject: S.admin, status: "active", memberships: [{ workspaceId: ORG, role: "admin" }], slug: "existing-org" };
  const c0 = await counts();
  const reg = await call("POST", "/auth/register", tFresh, hostileBody);
  const c1 = await counts();
  check("B1 registering creates exactly ONE user, ONE workspace and ONE membership, and answers 201 with the new account state ('member', one workspace, role admin)", reg.status === 201 && c1.users === c0.users + 1 && c1.workspaces === c0.workspaces + 1 && c1.memberships === c0.memberships + 1 && reg.data.state === "member" && reg.data.workspaces.length === 1 && reg.data.workspaces[0].role === "admin", `${reg.status}`);
  const newWs = reg.data.workspaces[0];
  const newUser = await User.findOne({ issuer: idp.issuer, subject: S.fresh1 }).lean();
  const mem = await WorkspaceMembership.find({ userId: newUser._id }).lean();
  check("B2 the identity is the VERIFIED token's (issuer + subject), never the body's: the user is stored under the token's subject; the body's issuer / subject / userId / status were ignored", Boolean(newUser) && newUser.issuer === idp.issuer && !(await User.findOne({ issuer: "https://evil.example" })) && (await User.countDocuments({ subject: S.admin })) === 1);
  check("B3 the membership is ADMIN of the NEW workspace only; the body's role / workspaceId / memberships / slug did not give access to the existing organisation", mem.length === 1 && String(mem[0].workspaceId) === newWs.id && newWs.id !== ORG && mem[0].role === "admin" && (await WorkspaceMembership.countDocuments({ workspaceId: org._id })) === 4);
  const wsDoc = await Workspace.findById(newWs.id).lean();
  check("B4 the workspace is the person's: its name is the cleaned name ('Harbour View Apartments'), it is active, and its slug is generated (the body's slug 'existing-org' was ignored; unique)", wsDoc.name === "Harbour View Apartments" && wsDoc.status === "active" && /^harbour-view-apartments-[0-9a-f]{8}$/.test(wsDoc.slug) && wsDoc.slug !== org.slug);
  check("B5 email is stored lower-cased from the token as a DISPLAY attribute (it is never used to find or match a user)", newUser.email === "fresh.one@example.invalid");
  const again = await call("POST", "/auth/register", tFresh, { workspaceName: "Second workspace" });
  check("B6 a second registration is refused (409): no second workspace, no duplicate user; the first account is untouched", again.status === 409 && again.code === "ALREADY_SET_UP" && (await counts()).workspaces === c1.workspaces && (await Workspace.countDocuments({ name: "Second workspace" })) === 0);
  const afterSession = await call("GET", "/auth/session", tFresh);
  check("B7 the session now says 'member' with exactly that workspace", afterSession.data.state === "member" && afterSession.data.workspaces.length === 1 && afterSession.data.workspaces[0].id === newWs.id);
  const sameName = await call("POST", "/auth/register", await bearerFor(S.fresh2), { workspaceName: "Harbour View Apartments" });
  check("B8 two people may use the same workspace name: each gets their OWN workspace with a distinct slug and no shared membership", sameName.status === 201 && sameName.data.workspaces[0].id !== newWs.id && (await Workspace.countDocuments({ name: "Harbour View Apartments" })) === 2 && new Set((await Workspace.find({ name: "Harbour View Apartments" }).lean()).map((w) => w.slug)).size === 2);
  const revokedReg = await call("POST", "/auth/register", await bearerFor(S.revoked), { workspaceName: "Fresh start" });
  check("B9 a user whose membership was revoked can set up their OWN workspace, but the revoked membership in the old organisation stays revoked", revokedReg.status === 201 && (await WorkspaceMembership.findOne({ userId: (await User.findOne({ subject: S.revoked }))._id, workspaceId: org._id })).status === "revoked");

  // ======================================================================================================== C. what a new account can do
  console.log("\n# C. what a new account can and cannot do");
  const tNew = tFresh;
  const own = await call("GET", `/signals?workspaceId=${newWs.id}`, tNew); const mkSig = await call("POST", "/signals", tNew, { workspaceId: newWs.id, type: "maintenance", severity: "low", title: "My first signal" }); const props = await call("POST", "/properties", tNew, { workspaceId: newWs.id, name: "Demo", code: "D1" });
  check("C1 the new admin can use THEIR workspace: read, create a signal, create a property (workspace:admin in their own tenant)", own.status === 200 && mkSig.status === 201 && props.status === 201, `${own.status}/${mkSig.status}/${props.status}`);
  const inOrg = await Promise.all([call("GET", `/signals?workspaceId=${ORG}`, tNew), call("POST", "/signals", tNew, { workspaceId: ORG, type: "maintenance", severity: "low", title: "intrusion" }), call("GET", `/properties?workspaceId=${ORG}`, tNew), call("GET", `/workspaces/${ORG}`, tNew)]);
  check("C2 [no access to anyone else's workspace] the new account gets the safe 404 for the existing organisation's data - read and write - and no data", inOrg.every((r) => r.status === 404) && (await Signal.countDocuments({ workspaceId: org._id })) === 1);
  const list = await call("GET", "/workspaces", tNew);
  check("C3 GET /workspaces lists only the person's own workspace", list.status === 200 && list.data.length === 1 && String(list.data[0]._id) === newWs.id);
  const adminAfter = await call("GET", `/signals?workspaceId=${ORG}`, await bearerFor(S.admin)); const viewerWrite = await call("POST", "/signals", await bearerFor(S.viewer), { workspaceId: ORG, type: "maintenance", severity: "low", title: "viewer" });
  const theirs = await call("GET", `/signals?workspaceId=${newWs.id}`, await bearerFor(S.admin));
  check("C4 existing members are unaffected and RBAC is unchanged: the org admin still reads the org; a viewer still cannot write (403); and the org admin cannot see the new tenant (404)", adminAfter.status === 200 && viewerWrite.status === 403 && theirs.status === 404);
  const hostileTok = await bearerFor(S.hostile, { claims: { role: "admin", roles: ["admin"], groups: ["admins"], workspaceId: ORG, workspace_id: ORG, permissions: ["workspace:admin"], hd: "example.invalid", "https://eoi.example/role": "admin" } });
  const hs = await call("GET", "/auth/session", hostileTok); const hSig = await call("GET", `/signals?workspaceId=${ORG}`, hostileTok); const hReg = await call("POST", "/auth/register", hostileTok, { workspaceName: "Claims Co" });
  check("C5 [role / workspace claims in the Google token] are ignored everywhere: the identity is still 'needs_setup', gets no access to the organisation (403 not registered, because it has no account yet), and registers only its OWN workspace as admin", hs.data.state === "needs_setup" && hSig.status === 403 && hSig.code === "IDENTITY_NOT_REGISTERED" && hReg.status === 201 && hReg.data.workspaces.length === 1 && hReg.data.workspaces[0].id !== ORG);
  check("C6 data routes still reject an identity that has no account: a new identity gets 403 IDENTITY_NOT_REGISTERED on every data route until it registers (authenticating is not authorisation)", (await Promise.all(["/signals", "/properties", "/guests", "/dashboard/signals"].map((p) => call("GET", `${p}?workspaceId=${ORG}`, tFresh.replace(/.$/, "A"))))).every((r) => r.status === 401) && (await call("GET", `/signals?workspaceId=${ORG}`, await bearerFor(S.other))).code === "IDENTITY_NOT_REGISTERED");
  const sameEmailUser = await bearerFor(S.other, { email: "admin@example.invalid" });
  const emailTry = await call("GET", "/auth/session", sameEmailUser);
  check("C7 email is not identity: a different subject using the org admin's email address is a different, new identity (needs_setup) with no access to that admin's workspace", emailTry.data.state === "needs_setup" && (await call("GET", `/signals?workspaceId=${ORG}`, sameEmailUser)).status === 403);

  // ======================================================================================================== D. hostile input, replay, concurrency, off
  console.log("\n# D. hostile input, concurrency, self-registration off");
  const base = await counts(); const t3 = await bearerFor(S.fresh3);
  const bad = [undefined, {}, { workspaceName: "" }, { workspaceName: "A" }, { workspaceName: "x".repeat(81) }, { workspaceName: 42 }, { workspaceName: { $ne: "" } }, { workspaceName: ["a", "b"] }, { workspaceName: "bad\u0000name" }, { workspaceName: "<script>alert(1)</script>" }, { workspaceName: "   " }, "not json at all {"];
  const badRes = [];
  for (const b of bad) badRes.push(await call("POST", "/auth/register", t3, b === undefined ? "{}" : b));
  check("D1 empty, too short / long, non-string, operator-injection, control-character and markup names are all 400 with a plain message - and create NOTHING", badRes.every((r) => r.status === 400) && JSON.stringify(await counts()) === JSON.stringify(base) && badRes.every((r) => !/\$ne|CastError|stack|at \w+\.\w+ \(/.test(r.text)), badRes.map((r) => r.status).join(","));
  const bigBody = await call("POST", "/auth/register", t3, { workspaceName: "a".repeat(8000) });
  check("D2 an oversized body is 413 and creates nothing", bigBody.status === 413 && JSON.stringify(await counts()) === JSON.stringify(base));
  const emoji = await call("POST", "/auth/register", t3, { workspaceName: "Café Düsseldorf ☕" });
  check("D3 an ordinary international name is accepted and slugged safely", emoji.status === 201 && /^caf-d-sseldorf-[0-9a-f]{8}$|^cafe-dusseldorf-[0-9a-f]{8}$|^caf[a-z-]*-[0-9a-f]{8}$/.test((await Workspace.findById(emoji.data.workspaces[0].id).lean()).slug));
  const tRace = await bearerFor(S.race); const bRace = await counts();
  const race = await Promise.all(Array.from({ length: 6 }, (_, i) => call("POST", "/auth/register", tRace, { workspaceName: `Racing ${i}` })));
  const aRace = await counts(); const raceUser = await User.findOne({ subject: S.race }).lean();
  check("D4 [concurrency] six parallel registrations by one identity create exactly ONE workspace and ONE membership; the rest are refused (409) - never duplicate tenants", race.filter((r) => r.status === 201).length === 1 && race.filter((r) => r.status === 409).length === 5 && aRace.workspaces === bRace.workspaces + 1 && (await WorkspaceMembership.countDocuments({ userId: raceUser._id })) === 1 && (await User.countDocuments({ subject: S.race })) === 1, race.map((r) => r.status).join(","));
  const cOff = await counts(); const tOff = await bearerFor(S.off, { port: OFF });
  const regOff = await call("POST", "/auth/register", tOff, { workspaceName: "Nope Inc" }, OFF);
  check("D5 with self-registration OFF, registering is refused (403 SELF_REGISTRATION_DISABLED) and creates nothing: access stays an administrator's decision", regOff.status === 403 && regOff.code === "SELF_REGISTRATION_DISABLED" && JSON.stringify(await counts()) === JSON.stringify(cOff));
  const regDis = await call("POST", "/auth/register", await bearerFor(S.disabled), { workspaceName: "Disabled Co" });
  check("D6 a disabled user cannot register (403 USER_DISABLED) and nothing is created", regDis.status === 403 && regDis.code === "USER_DISABLED" && (await Workspace.countDocuments({ name: "Disabled Co" })) === 0);
  const svc = strip(read(path.join(BACKEND, "src", "services", "accountService.js")));
  check("D7 the service reads only `workspaceName` from the request body, hard-codes the role to 'admin' of the NEW workspace, and never takes a user id, role or workspace from the request", (svc.match(/body\??\.\w+/g) || []).join() === "body?.workspaceName" && /role: "admin"/.test(svc) && !/req\./.test(svc) && !/workspaceId: (body|identity|req)/.test(svc));
  const noExisting = !/WorkspaceMembership\.(updateOne|updateMany|findOneAndUpdate|create)\([^)]*workspaceId: (?!workspace\._id)/.test(svc);
  check("D8 the only membership it can create is in the workspace it has just created; there is no code path that adds or changes a membership in an existing workspace", noExisting && (svc.match(/WorkspaceMembership\.create\(/g) || []).length === 1 && /workspaceId: workspace\._id/.test(svc));

  // ======================================================================================================== E. authentication on these routes
  console.log("\n# E. authentication on the account routes");
  const noTok = await call("GET", "/auth/session", null); const noTokP = await call("POST", "/auth/register", null, { workspaceName: "No Token Co" });
  const garbage = await call("GET", "/auth/session", "not.a.token"); const tampered = await call("GET", "/auth/session", tFresh.slice(0, -4) + "AAAA");
  const wrongAud = await call("GET", "/auth/session", await idp.mintToken({ sub: S.fresh4, aud: "someone-else.apps.googleusercontent.com" })); const wrongIss = await call("GET", "/auth/session", await idp.mintToken({ sub: S.fresh4, aud: CLIENT_ID, iss: "https://accounts.attacker.example" })); const expired = await call("GET", "/auth/session", await idp.mintToken({ sub: S.fresh4, aud: CLIENT_ID, issuedAt: Math.floor(Date.now() / 1000) - 7200, ttlSeconds: 3600 }));
  check("E1 no token -> 401 MISSING_CREDENTIAL (session and register); a garbage, tampered, wrong-audience, wrong-issuer or expired token -> 401: nothing is created", noTok.status === 401 && noTok.code === "MISSING_CREDENTIAL" && noTokP.status === 401 && [garbage, tampered, wrongAud, wrongIss, expired].every((r) => r.status === 401) && (await Workspace.countDocuments({ name: "No Token Co" })) === 0);
  const t = await call("OPTIONS", "/auth/register", null, undefined, ON, { origin: ORIGIN, "access-control-request-method": "POST", "access-control-request-headers": "content-type,authorization" });
  check("E2 the account routes accept only the configured frontend origin (CORS) and the methods they define (GET session, POST register)", t.status === 204 && (await call("PUT", "/auth/register", tFresh, { workspaceName: "x" })).status === 404 && (await call("POST", "/auth/session", tFresh, {})).status === 404);
  const route = strip(read(path.join(BACKEND, "src", "routes", "authRoutes.js")));
  check("E3 both routes use the identity-only middleware first, then their rate limit, and the body is parsed only AFTER authentication", /"\/session", authenticateIdentity, accountSessionLimiter/.test(route) && /"\/register", authenticateIdentity, accountRegisterLimiter, smallJson\(\)/.test(route) && /const smallJson = \(\) => express\.json\(\{ limit: "4kb", strict: true \}\)/.test(route));
  check("E4 the secret and tokens appear in no response and in no backend log", !logs.includes(SECRET) && !/eyJ[A-Za-z0-9_-]{20,}\./.test(logs));
  check("E5 the setup message for a new identity (development hint) says the person can set up in the app when self-registration is on, and never prints a token", /has no EOI account yet; the person can set one up in the app/.test(logs) && !/eyJ/.test(logs));
} finally {
  for (const c of children) c.kill();
  await idp.close();
  try { await mongoose.connection.dropDatabase(); } catch { /* best effort */ }
  await mongoose.disconnect();
}

console.log(`\nPhase 45C account onboarding validation: ${passed} passed, ${failed} failed (isolated database ${DB_NAME} dropped)`);
process.exit(failed === 0 ? 0 : 1);
