/**
 * Identity foundation validation (Phase 7).
 *
 * Proves, in-process against real MongoDB, with NO spawned server, NO AI service,
 * NO network and NO LLM:
 *
 *   - bearer parsing and the provider-agnostic verifier seam
 *   - the verified-identity contract (issuer + subject; email only an attribute)
 *   - user resolution (unknown identity, disabled user) and NO auto-provisioning
 *   - workspace membership resolution (revoked, cross-workspace, invalid role)
 *   - req.actor construction, and that it is never taken from headers, query,
 *     body or token claims (role / workspace / knowledge level / permissions)
 *   - the role map (exact permissions; nobody holds action:execute) and the
 *     role-derived knowledge ceiling behind getAuthorizedKnowledgeLevel
 *   - the production boundary: the dev fallback and the stub verifier are inert
 *     when NODE_ENV=production
 *
 * A tiny Express app is built HERE around the new middleware; the real API is
 * not touched. All fixtures are synthetic, use the fixed stub issuer, and are
 * removed at the end. Existing operational collections are counted before and
 * after and must be identical.
 */
import http from "node:http";
import express from "express";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import * as Models from "../src/models/index.js";
import { User, Workspace, WorkspaceMembership } from "../src/models/index.js";
import { authenticate, optionalAuthenticate } from "../src/auth/authenticate.js";
import { requireWorkspaceMembership, resolveWorkspaceActor } from "../src/auth/membership.js";
import { ROLES, PERMISSIONS, ROLE_PERMISSIONS, ROLE_KNOWLEDGE_CEILING, hasPermission, isValidRole, knowledgeCeilingForRole, permissionsForRole } from "../src/auth/roles.js";
import { AuthError, normalizeVerifiedIdentity } from "../src/auth/tokenContract.js";
import { STUB_ISSUER, createStubTokenVerifier, signStubToken } from "../src/auth/stubTokenVerifier.js";
import { configureTokenVerifier, getTokenVerifier } from "../src/auth/tokenVerifier.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { getAuthorizedKnowledgeLevel } from "../src/middleware/knowledgeAccess.js";

const SECRET = "identity-suite-secret-not-real-0123456789";
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

const stamp = Date.now();
const fixtures = { users: [], workspaces: [], memberships: [] };
const OPERATIONAL = ["Guest", "Stay", "ImportBatch", "Workspace", "Property", "Unit", "Signal", "KnowledgeDocument", "KnowledgeChunk", "Intelligence", "Decision", "Action", "Outcome", "Conversation", "Message"];
// This suite's own throwaway workspaces are excluded: only PRE-EXISTING records are compared.
const counts = async () =>
  Object.fromEntries(
    await Promise.all(OPERATIONAL.map(async (name) => [name, await Models[name].countDocuments(name === "Workspace" ? { _id: { $nin: fixtures.workspaces } } : {})])),
  );

function buildApp() {
  const app = express();
  app.use(express.json());
  const echo = (req, res) => res.json({ actor: req.actor ?? null, level: getAuthorizedKnowledgeLevel(req) });
  app.get("/strict", authenticate, echo);
  app.get("/optional", optionalAuthenticate, echo);
  app.get("/workspace", authenticate, requireWorkspaceMembership(), echo);
  app.get("/level", echo); // no middleware at all: the existing, unauthenticated path
  app.use(errorHandler);
  return app;
}

async function call(base, path, { headers = {}, method = "GET", body } = {}) {
  const response = await fetch(`${base}${path}`, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  return { status: response.status, json, code: json?.details?.code, wwwAuth: response.headers.get("www-authenticate") };
}

const nowSec = () => Math.floor(Date.now() / 1000);
const token = (claims = {}, secret = SECRET) => signStubToken({ iss: STUB_ISSUER, exp: nowSec() + 600, ...claims }, secret);
const bearer = (t) => ({ authorization: `Bearer ${t}` });

async function main() {
  process.env.NODE_ENV = "test";
  delete process.env.KNOWLEDGE_DEV_AUTHORIZED_LEVEL;
  delete process.env.AUTH_TOKEN_VERIFIER;
  delete process.env.AUTH_STUB_SECRET;

  await connectDatabase();
  await Promise.all([User.init(), WorkspaceMembership.init()]);
  const before = await counts();

  const server = http.createServer(buildApp());
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${server.address().port}`;

  try {
    // ------------------------------------------------ roles (pure)
    check("R1: exactly the four roles", JSON.stringify(ROLES) === JSON.stringify(["viewer", "operator", "reviewer", "admin"]));
    // Phase 29: action:propose/action:review were added, granted to the same roles as their decision:*
    // counterparts (see auth/roles.js) - these three assertions are updated to the new closed set; R2 and
    // R7 still fail on any OTHER/unexpected permission, and action:execute is still assigned to no role.
    check("R2: exactly the ten permissions (action:execute is assigned to no role; outcome:record does not exist)", JSON.stringify(PERMISSIONS) === JSON.stringify(["intelligence:view", "intelligence:generate", "operations:view", "operations:manage", "decision:propose", "decision:review", "action:propose", "action:review", "action:execute", "workspace:admin"]) && !PERMISSIONS.includes("outcome:record"));
    check("R3: viewer permissions", JSON.stringify(ROLE_PERMISSIONS.viewer) === JSON.stringify(["intelligence:view"]));
    check("R4: operator permissions", JSON.stringify(ROLE_PERMISSIONS.operator) === JSON.stringify(["intelligence:view", "intelligence:generate", "operations:view", "operations:manage", "decision:propose", "action:propose"]));
    check("R5: reviewer permissions (operator + decision:review + action:review)", JSON.stringify(ROLE_PERMISSIONS.reviewer) === JSON.stringify([...ROLE_PERMISSIONS.operator, "decision:review", "action:review"]));
    check("R6: admin permissions (reviewer + workspace:admin)", JSON.stringify(ROLE_PERMISSIONS.admin) === JSON.stringify([...ROLE_PERMISSIONS.reviewer, "workspace:admin"]));
    check("R7: NO role holds action:execute", ROLES.every((role) => !hasPermission(role, "action:execute")));
    check("R8: only reviewer and admin may review", ROLES.filter((role) => hasPermission(role, "decision:review")).join(",") === "reviewer,admin");
    check("R9: only admin administers", ROLES.filter((role) => hasPermission(role, "workspace:admin")).join(",") === "admin");
    check("R10: knowledge ceilings viewer/operator/reviewer/admin", ["viewer", "operator", "reviewer", "admin"].map((r) => ROLE_KNOWLEDGE_CEILING[r]).join(",") === "guest,staff,staff,restricted");
    check("R11: unknown role -> no permissions, lowest ceiling, invalid", permissionsForRole("root").length === 0 && knowledgeCeilingForRole("root") === "guest" && knowledgeCeilingForRole(undefined) === "guest" && !isValidRole("root") && !isValidRole("__proto__") && !isValidRole(undefined));
    check("R12: the role map is frozen", Object.isFrozen(ROLE_PERMISSIONS) && Object.isFrozen(ROLE_PERMISSIONS.admin));

    // ------------------------------------------------ token contract (pure)
    const okId = normalizeVerifiedIdentity({ issuer: " iss ", subject: " sub ", email: " A@B.Example ", expiresAt: nowSec() * 1000 + 5000, role: "admin", workspaceId: "x", permissions: ["*"], knowledgeLevel: "restricted" });
    check("C1: contract keeps only issuer, subject, email, expiresAt", JSON.stringify(Object.keys(okId).sort()) === JSON.stringify(["email", "expiresAt", "issuer", "subject"]));
    check("C2: values are trimmed; email lower-cased", okId.issuer === "iss" && okId.subject === "sub" && okId.email === "a@b.example");
    const bad = [null, "x", {}, { issuer: "i" }, { subject: "s" }, { issuer: "", subject: "s", expiresAt: 1 }, { issuer: "i", subject: "s" }, { issuer: "i", subject: "s", expiresAt: "nope" }, { issuer: 5, subject: "s", expiresAt: 1 }];
    check("C3: malformed verifier output is rejected (401)", bad.every((raw) => {
      try {
        normalizeVerifiedIdentity(raw);
        return false;
      } catch (error) {
        return error instanceof AuthError && error.statusCode === 401;
      }
    }));
    check("C4: email is optional", normalizeVerifiedIdentity({ issuer: "i", subject: "s", expiresAt: Date.now() + 1000 }).email === undefined);

    // ------------------------------------------------ stub verifier (pure)
    const verify = createStubTokenVerifier({ secret: SECRET });
    const good = await verify(token({ sub: "pure-1", email: "P@Example.test" }));
    check("V1: valid token verifies to the contract", good.issuer === STUB_ISSUER && good.subject === "pure-1" && good.email === "P@Example.test" && good.expiresAt instanceof Date);
    const rejects = async (t) => {
      try {
        await verify(t);
        return false;
      } catch (error) {
        return error instanceof AuthError && error.statusCode === 401;
      }
    };
    check("V2: wrong secret rejected", await rejects(token({ sub: "x" }, "another-secret-not-real-9876543210")));
    const [h, p, s] = token({ sub: "victim" }).split(".");
    const tampered = `${h}.${Buffer.from(JSON.stringify({ iss: STUB_ISSUER, sub: "attacker", exp: nowSec() + 600 })).toString("base64url")}.${s}`;
    check("V3: tampered payload rejected", await rejects(tampered));
    const noneHeader = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    check("V4: alg=none rejected", (await rejects(`${noneHeader}.${p}.`)) && (await rejects(`${noneHeader}.${p}.${s}`)));
    check("V5: another issuer rejected", await rejects(signStubToken({ iss: "https://real-idp.example", sub: "x", exp: nowSec() + 600 }, SECRET)));
    check("V6: expired token rejected", await rejects(signStubToken({ iss: STUB_ISSUER, sub: "x", exp: nowSec() - 5 }, SECRET)));
    check("V7: missing / non-numeric exp rejected", (await rejects(signStubToken({ iss: STUB_ISSUER, sub: "x" }, SECRET))) && (await rejects(signStubToken({ iss: STUB_ISSUER, sub: "x", exp: "9999999999" }, SECRET))));
    check("V8: missing sub rejected", await rejects(signStubToken({ iss: STUB_ISSUER, exp: nowSec() + 600 }, SECRET)));
    check("V9: garbage tokens rejected", (await rejects("")) && (await rejects("abc")) && (await rejects("a.b")) && (await rejects("a.b.c")) && (await rejects(undefined)));
    let refused = 0;
    for (const bad of ["", "short"]) {
      try {
        createStubTokenVerifier({ secret: bad });
      } catch {
        refused += 1;
      }
    }
    check("V10: a missing / short secret is refused", refused === 2);

    // ------------------------------------------------ production boundary (pure)
    process.env.NODE_ENV = "production";
    let stubRefused = false;
    try {
      createStubTokenVerifier({ secret: SECRET });
    } catch {
      stubRefused = true;
    }
    let signRefused = false;
    try {
      signStubToken({}, SECRET);
    } catch {
      signRefused = true;
    }
    process.env.AUTH_TOKEN_VERIFIER = "stub";
    process.env.AUTH_STUB_SECRET = SECRET;
    check("P1: the stub verifier cannot be built or signed in production", stubRefused && signRefused);
    check("P2: the environment cannot switch the stub on in production", getTokenVerifier() === null);
    process.env.KNOWLEDGE_DEV_AUTHORIZED_LEVEL = "restricted";
    check("P3: the dev knowledge-level fallback is ignored in production", getAuthorizedKnowledgeLevel({}) === "guest");
    check("P4: an authenticated actor's role still drives the level in production", getAuthorizedKnowledgeLevel({ actor: { role: "admin" } }) === "restricted");
    process.env.NODE_ENV = "test";
    check("P5: outside production the fallback still works (existing behaviour)", getAuthorizedKnowledgeLevel({}) === "restricted");
    process.env.KNOWLEDGE_DEV_AUTHORIZED_LEVEL = "not-a-level";
    check("P6: an invalid fallback value fails closed to guest", getAuthorizedKnowledgeLevel({}) === "guest");
    delete process.env.KNOWLEDGE_DEV_AUTHORIZED_LEVEL;
    check("P7: unset fallback -> guest", getAuthorizedKnowledgeLevel({}) === "guest" && getAuthorizedKnowledgeLevel(undefined) === "guest");
    process.env.AUTH_TOKEN_VERIFIER = "stub";
    process.env.AUTH_STUB_SECRET = SECRET;
    check("P8: outside production AUTH_TOKEN_VERIFIER=stub yields the dev verifier", typeof getTokenVerifier() === "function");
    process.env.AUTH_STUB_SECRET = "short";
    check("P9: a bad stub secret in the environment yields NO verifier (fail closed)", getTokenVerifier() === null);
    delete process.env.AUTH_TOKEN_VERIFIER;
    delete process.env.AUTH_STUB_SECRET;
    check("P10: nothing configured -> no verifier", getTokenVerifier() === null);

    // ------------------------------------------------ fixtures
    const mkWorkspace = async (label, status = "active") => {
      const ws = await Workspace.create({ name: `Identity ${label} ${stamp}`, slug: `identity-${label}-${stamp}`, status });
      fixtures.workspaces.push(ws._id);
      return ws;
    };
    const mkUser = async (subject, extra = {}) => {
      const user = await User.create({ issuer: STUB_ISSUER, subject: `${subject}-${stamp}`, ...extra });
      fixtures.users.push(user._id);
      return user;
    };
    const mkMember = async (user, workspace, role, status = "active") => {
      const membership = await WorkspaceMembership.create({ userId: user._id, workspaceId: workspace._id, role, status });
      fixtures.memberships.push(membership._id);
      return membership;
    };
    const wsA = await mkWorkspace("a");
    const wsB = await mkWorkspace("b");
    const wsSuspended = await mkWorkspace("suspended", "suspended");
    const wsC = await mkWorkspace("c");
    const alice = await mkUser("alice", { email: "Alice@Example.test" });
    const bob = await mkUser("bob");
    const carol = await mkUser("carol", { status: "disabled" });
    const dave = await mkUser("dave");
    await mkMember(alice, wsA, "reviewer");
    await mkMember(alice, wsB, "viewer"); // one user, two workspaces, two roles
    await mkMember(bob, wsA, "admin");
    await mkMember(bob, wsSuspended, "admin");
    await mkMember(carol, wsA, "operator");
    const daveRevoked = await mkMember(dave, wsA, "reviewer", "revoked");
    const erin = await mkUser("erin");
    await mkMember(erin, wsA, "operator");
    const frank = await mkUser("frank");
    await mkMember(frank, wsA, "viewer");
    const gina = await mkUser("gina");
    const brokenRole = await mkMember(gina, wsA, "viewer");
    await WorkspaceMembership.collection.updateOne({ _id: brokenRole._id }, { $set: { role: "superuser" } }); // bypass the schema on purpose
    const tok = (user, claims = {}) => token({ sub: user.subject, email: user.email, ...claims });

    // ------------------------------------------------ models
    let dupUser = false;
    try {
      await User.create({ issuer: STUB_ISSUER, subject: alice.subject });
    } catch (error) {
      dupUser = error?.code === 11000;
    }
    check("M1: issuer + subject is unique", dupUser);
    const sameEmail = await mkUser("alice-twin", { email: "alice@example.test" });
    check("M2: email is NOT the identity key (same email, other subject, is allowed)", Boolean(sameEmail._id));
    const sameSubjectOtherIssuer = await User.create({ issuer: "eoi-dev-stub-other", subject: alice.subject });
    fixtures.users.push(sameSubjectOtherIssuer._id);
    check("M3: the same subject under another issuer is a different user", String(sameSubjectOtherIssuer._id) !== String(alice._id));
    let dupMembership = false;
    try {
      await WorkspaceMembership.create({ userId: alice._id, workspaceId: wsA._id, role: "viewer" });
    } catch (error) {
      dupMembership = error?.code === 11000;
    }
    check("M4: user + workspace membership is unique", dupMembership);
    let enumRejected = 0;
    for (const doc of [new WorkspaceMembership({ userId: alice._id, workspaceId: wsC._id, role: "owner" }), new WorkspaceMembership({ userId: alice._id, workspaceId: wsC._id, role: "viewer", status: "pending" }), new User({ issuer: "i", subject: "s", status: "banned" })]) {
      try {
        await doc.validate();
      } catch {
        enumRejected += 1;
      }
    }
    check("M5: schema rejects unknown role / membership status / user status", enumRejected === 3);
    // Phase 46: a User may now carry a PASSWORD HASH (email + password sign-in) - and nothing else credential-like. It is `select: false` (never loaded by a normal query), there is
    // no plaintext/reversible field, and still no phone / avatar / role / workspace on the user (those live on the membership).
    check("M6: the User model holds a password HASH only (select:false) - no plaintext password, no phone / avatar / role / workspace", User.schema.path("passwordHash")?.options.select === false && !["password", "plainPassword", "passwordPlain", "phone", "avatar", "role", "workspaceId", "refreshToken", "token"].some((field) => User.schema.path(field)));
    check("M7: a stored email is lower-cased", (await User.findById(alice._id).lean()).email === "alice@example.test");

    // ------------------------------------------------ middleware: no verifier configured
    configureTokenVerifier(null);
    let r = await call(base, "/strict", { headers: bearer(tok(alice)) });
    check("A1: no verifier configured -> a bearer request fails closed (503)", r.status === 503 && r.code === "AUTH_NOT_CONFIGURED");
    r = await call(base, "/strict");
    check("A2: ...and a missing credential is still 401", r.status === 401);

    configureTokenVerifier(createStubTokenVerifier({ secret: SECRET }));

    // ------------------------------------------------ middleware: credentials
    r = await call(base, "/strict");
    check("A3: missing token -> 401 MISSING_CREDENTIAL with WWW-Authenticate", r.status === 401 && r.code === "MISSING_CREDENTIAL" && r.wwwAuth === "Bearer");
    for (const [name, header] of [["Basic scheme", "Basic abc"], ["no token", "Bearer"], ["no token, trailing space", "Bearer "], ["two tokens", "Bearer a b"], ["wrong scheme", "Token abc"], ["bare token", tok(alice)], ["empty", ""]]) {
      r = await call(base, "/strict", { headers: { authorization: header } });
      check(`A4: malformed Authorization (${name}) -> 401`, r.status === 401, `HTTP ${r.status} ${r.code ?? ""}`);
    }
    r = await call(base, "/strict", { headers: { authorization: `bearer ${tok(alice)}` } });
    check("A5: the scheme is case-insensitive", r.status === 200);
    r = await call(base, "/strict", { headers: bearer("not.a.token") });
    check("A6: invalid token -> 401 INVALID_TOKEN", r.status === 401 && r.code === "INVALID_TOKEN");
    r = await call(base, "/strict", { headers: bearer(token({ sub: alice.subject }, "another-secret-not-real-9876543210")) });
    check("A7: wrong signature -> 401", r.status === 401);
    r = await call(base, "/strict", { headers: bearer(signStubToken({ iss: STUB_ISSUER, sub: alice.subject, exp: nowSec() - 30 }, SECRET)) });
    check("A8: expired token -> 401 TOKEN_EXPIRED", r.status === 401 && r.code === "TOKEN_EXPIRED");
    r = await call(base, "/strict", { headers: bearer(signStubToken({ iss: "https://real-idp.example", sub: alice.subject, exp: nowSec() + 600 }, SECRET)) });
    check("A9: token from another issuer -> 401", r.status === 401);
    check("A10: error bodies never echo the token", !JSON.stringify(r.json).includes(tok(alice)));

    // an expired verifier result must be caught by the middleware too (defence in depth)
    configureTokenVerifier(async () => ({ issuer: STUB_ISSUER, subject: alice.subject, expiresAt: new Date(Date.now() - 1000) }));
    r = await call(base, "/strict", { headers: bearer("anything") });
    check("A11: the middleware re-checks expiry even if a verifier does not", r.status === 401 && r.code === "TOKEN_EXPIRED");
    configureTokenVerifier(async () => {
      throw new Error("internal verifier failure with a secret: hunter2");
    });
    r = await call(base, "/strict", { headers: bearer("anything") });
    check("A12: an unexpected verifier error is a 401 that leaks nothing", r.status === 401 && !JSON.stringify(r.json).includes("hunter2"));
    configureTokenVerifier(createStubTokenVerifier({ secret: SECRET }));

    // ------------------------------------------------ user resolution
    r = await call(base, "/strict", { headers: bearer(tok(alice)) });
    const actor = r.json?.actor;
    check("U1: valid token + registered user -> 200", r.status === 200);
    check("U2: req.actor has exactly the specified shape", JSON.stringify(Object.keys(actor).sort()) === JSON.stringify(["email", "issuer", "role", "subject", "userId", "workspaceId"]));
    check("U3: actor values come from the stored user", actor.userId === String(alice._id) && actor.issuer === STUB_ISSUER && actor.subject === alice.subject && actor.email === "alice@example.test");
    check("U4: without a membership the actor carries no workspace and no role", actor.workspaceId === null && actor.role === null);
    check("U5: an identity-only actor gets the lowest knowledge level", r.json.level === "guest");
    const stored = await User.countDocuments({ subject: { $regex: `${stamp}$` } });
    r = await call(base, "/strict", { headers: bearer(token({ sub: `unknown-${stamp}` })) });
    check("U6: unknown issuer+subject -> 403 IDENTITY_NOT_REGISTERED", r.status === 403 && r.code === "IDENTITY_NOT_REGISTERED");
    check("U7: ...and NO user was auto-created", (await User.countDocuments({ subject: `unknown-${stamp}` })) === 0 && (await User.countDocuments({ subject: { $regex: `${stamp}$` } })) === stored);
    r = await call(base, "/strict", { headers: bearer(tok(carol)) });
    check("U8: disabled user -> 403 USER_DISABLED", r.status === 403 && r.code === "USER_DISABLED");
    r = await call(base, "/strict", { headers: bearer(token({ sub: alice.subject, email: "someone-else@example.test" })) });
    check("U9: a token's email does not change who the user is or what is stored", r.json?.actor?.userId === String(alice._id) && r.json.actor.email === "alice@example.test");
    r = await call(base, "/strict", { headers: bearer(token({ sub: `other-${stamp}`, email: "alice@example.test" })) });
    check("U10: a matching EMAIL never resolves to a user (issuer+subject only)", r.status === 403 && r.code === "IDENTITY_NOT_REGISTERED");
    const stillDisabled = await mkUser("erin-later");
    r = await call(base, "/strict", { headers: bearer(tok(stillDisabled)) });
    const disabledNow = r.status === 200;
    await User.updateOne({ _id: stillDisabled._id }, { $set: { status: "disabled" } });
    r = await call(base, "/strict", { headers: bearer(tok(stillDisabled)) });
    check("U11: disabling a user takes effect on the very next request", disabledNow && r.status === 403 && r.code === "USER_DISABLED");

    // ------------------------------------------------ optional authentication
    r = await call(base, "/optional");
    check("O1: optional route, no credential -> no actor, existing fallback level", r.status === 200 && r.json.actor === null && r.json.level === "guest");
    r = await call(base, "/optional", { headers: bearer("garbage") });
    check("O2: optional route, a SUPPLIED bad credential is still rejected", r.status === 401);
    r = await call(base, "/optional", { headers: bearer(tok(alice)) });
    check("O3: optional route, valid credential -> actor", r.status === 200 && r.json.actor?.userId === String(alice._id));

    // ------------------------------------------------ membership / workspace resolution
    const ws = (id, headers) => call(base, `/workspace?workspaceId=${id}`, { headers });
    r = await ws(wsA._id, bearer(tok(alice)));
    check("W1: active membership -> workspace actor with the stored role", r.status === 200 && r.json.actor.workspaceId === String(wsA._id) && r.json.actor.role === "reviewer");
    check("W2: the level is the role's ceiling (reviewer -> staff)", r.json.level === "staff");
    r = await ws(wsB._id, bearer(tok(alice)));
    check("W3: the same user in another workspace has THAT workspace's role (viewer -> guest)", r.json?.actor?.role === "viewer" && r.json.level === "guest");
    r = await ws(wsC._id, bearer(tok(alice)));
    check("W4: cross-workspace: not a member -> 404 (same as a missing workspace)", r.status === 404);
    r = await ws("64b64c4f2f1c2e0012345678", bearer(tok(alice)));
    check("W5: a non-existent workspace looks identical (404)", r.status === 404 && r.json.message === "Workspace not found");
    r = await ws(wsA._id, bearer(tok(dave)));
    check("W6: revoked membership -> 404", r.status === 404);
    r = await ws(wsSuspended._id, bearer(tok(bob)));
    check("W7: a suspended workspace is not resolvable (404)", r.status === 404);
    r = await ws(wsA._id, bearer(tok(gina)));
    check("W8: an invalid stored role fails closed (403 INVALID_ROLE)", r.status === 403 && r.code === "INVALID_ROLE");
    r = await ws(wsA._id, bearer(tok(carol)));
    check("W9: a disabled user never reaches membership (403)", r.status === 403);
    r = await call(base, "/workspace", { headers: bearer(tok(alice)) });
    check("W10: missing workspaceId -> 400", r.status === 400);
    r = await call(base, "/workspace?workspaceId=not-an-id", { headers: bearer(tok(alice)) });
    check("W11: malformed workspaceId -> 400", r.status === 400);
    r = await call(base, `/workspace?workspaceId=${wsA._id}`);
    check("W12: no credential -> 401 before any membership lookup", r.status === 401);
    for (const [user, role, level] of [[frank, "viewer", "guest"], [erin, "operator", "staff"], [alice, "reviewer", "staff"], [bob, "admin", "restricted"]]) {
      r = await ws(wsA._id, bearer(tok(user)));
      check(`W13: ${role} -> ceiling ${level}`, r.json?.actor?.role === role && r.json.level === level);
    }
    const direct = await resolveWorkspaceActor({ ...actor }, wsA._id);
    check("W14: resolveWorkspaceActor returns a frozen, complete actor", Object.isFrozen(direct) && direct.role === "reviewer" && direct.workspaceId === String(wsA._id) && direct.userId === String(alice._id));
    let noActor = 0;
    for (const bad of [undefined, null, {}]) {
      try {
        await resolveWorkspaceActor(bad, wsA._id);
      } catch (error) {
        if (error.statusCode === 401) noActor += 1;
      }
    }
    check("W15: resolveWorkspaceActor without an authenticated actor -> 401", noActor === 3);
    await WorkspaceMembership.updateOne({ _id: daveRevoked._id }, { $set: { status: "active" } });
    r = await ws(wsA._id, bearer(tok(dave)));
    const reinstated = r.status === 200;
    await WorkspaceMembership.updateOne({ _id: daveRevoked._id }, { $set: { status: "revoked" } });
    r = await ws(wsA._id, bearer(tok(dave)));
    check("W16: revoking a membership takes effect on the very next request", reinstated && r.status === 404);

    // ------------------------------------------------ forged inputs never define the actor
    const forged = { "x-user-id": String(bob._id), "x-role": "admin", "x-knowledge-level": "restricted", "x-workspace-id": String(wsB._id), "x-permissions": "action:execute,workspace:admin", "x-user-email": "root@example.test" };
    r = await ws(wsA._id, { ...bearer(tok(frank)), ...forged });
    check("F1: forged role / user-id / level / workspace / permission headers change nothing", r.status === 200 && r.json.actor.userId === String(frank._id) && r.json.actor.role === "viewer" && r.json.actor.workspaceId === String(wsA._id) && r.json.actor.email === null && r.json.level === "guest");
    r = await call(base, "/strict", { headers: forged });
    check("F2: forged headers WITHOUT a token do not authenticate (401)", r.status === 401);
    r = await call(base, "/optional", { headers: forged });
    check("F3: forged headers on an optional route: no actor, and the level is not taken from them", r.status === 200 && r.json.actor === null && r.json.level === "guest");
    r = await call(base, "/level", { headers: forged });
    check("F4: forged knowledge-level header on an unauthenticated route is ignored", r.json.level === "guest");
    r = await call(base, `/workspace?workspaceId=${wsA._id}&role=admin&userId=${bob._id}&level=restricted&knowledgeLevel=restricted`, { headers: bearer(tok(frank)) });
    check("F5: forged query parameters change nothing", r.json?.actor?.role === "viewer" && r.json.actor.userId === String(frank._id) && r.json.level === "guest");
    r = await call(base, `/workspace?workspaceId=${wsA._id}`, { method: "GET", headers: { ...bearer(tok(frank)), "content-type": "application/json" } });
    check("F6: a GET with a JSON content-type is unaffected", r.status === 200);
    r = await ws(wsA._id, bearer(tok(frank, { role: "admin", roles: ["admin"], workspaceId: String(wsB._id), workspace_id: String(wsB._id), permissions: ["action:execute", "workspace:admin"], knowledgeLevel: "restricted", knowledge_level: "restricted", scope: "admin", userId: String(bob._id) })));
    check("F7: role / workspace / permission / level CLAIMS inside a valid token are ignored", r.status === 200 && r.json.actor.role === "viewer" && r.json.actor.workspaceId === String(wsA._id) && r.json.actor.userId === String(frank._id) && r.json.level === "guest" && !("permissions" in r.json.actor));
    r = await ws(wsB._id, bearer(tok(frank, { workspaceId: String(wsA._id), role: "admin" })));
    check("F8: a token claiming workspace A does not make a non-member a member of B (404)", r.status === 404);
    r = await call(base, "/strict", { method: "GET", headers: { ...bearer(tok(frank)), "x-forwarded-user": "bob", "x-auth-request-user": "bob" } });
    check("F9: proxy-style identity headers are not trusted", r.json?.actor?.userId === String(frank._id));

    // ------------------------------------------------ the existing unauthenticated path is unchanged
    process.env.KNOWLEDGE_DEV_AUTHORIZED_LEVEL = "staff";
    r = await call(base, "/level");
    check("E1: with NO middleware, the dev fallback still yields its level (existing behaviour)", r.json.level === "staff");
    r = await ws(wsA._id, bearer(tok(frank)));
    check("E2: an authenticated actor OVERRIDES the fallback (viewer stays guest even at fallback=staff)", r.json.level === "guest");
    process.env.KNOWLEDGE_DEV_AUTHORIZED_LEVEL = "guest";
    r = await ws(wsA._id, bearer(tok(bob)));
    check("E3: ...and an admin is restricted even when the fallback is guest", r.json.level === "restricted");
    delete process.env.KNOWLEDGE_DEV_AUTHORIZED_LEVEL;
    check("E4: actor with an unknown role -> guest", getAuthorizedKnowledgeLevel({ actor: { role: "root" } }) === "guest" && getAuthorizedKnowledgeLevel({ actor: {} }) === "guest");

    // ------------------------------------------------ no operational data touched
    const after = await counts();
    const changed = OPERATIONAL.filter((name) => before[name] !== after[name]);
    check("D1: existing operational collections are untouched (counts identical)", changed.length === 0, changed.join(","));
  } finally {
    configureTokenVerifier(null);
    server.close();
    await WorkspaceMembership.deleteMany({ _id: { $in: fixtures.memberships } });
    await User.deleteMany({ _id: { $in: fixtures.users } });
    await Workspace.deleteMany({ _id: { $in: fixtures.workspaces } });
    const left = (await User.countDocuments({ subject: { $regex: `${stamp}$` } })) + (await WorkspaceMembership.countDocuments({ workspaceId: { $in: fixtures.workspaces } })) + (await Workspace.countDocuments({ slug: { $regex: `-${stamp}$` } }));
    check("D2: every fixture was removed", left === 0);
    await disconnectDatabase();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
