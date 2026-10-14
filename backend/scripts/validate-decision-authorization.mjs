/**
 * Decision V1 authorization validation (Phase 8).
 *
 * Real HTTP against a REAL spawned backend, real MongoDB, real middleware:
 * authenticate -> active workspace membership -> permission -> the existing
 * Decision V1 operation. Every actor is a stored User with a stored
 * WorkspaceMembership and a token signed by the DEVELOPMENT stub verifier; no
 * header, query parameter, body field or environment level is used to bypass
 * authentication.
 *
 * The server's KNOWLEDGE_DEV_AUTHORIZED_LEVEL is deliberately set to the
 * HIGHEST level, to prove the development fallback never elevates (or replaces) an
 * authenticated actor. AI_SERVICE_URL points at a TRAP server: any request to it
 * fails the suite (no LLM call from the Decision layer).
 *
 * All fixtures are synthetic, live in their own workspaces, and are removed at the
 * end. Pre-existing operational records are counted before and after.
 */
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { signStubToken, STUB_ISSUER } from "../src/auth/stubTokenVerifier.js";
import * as Models from "../src/models/index.js";
import { Action, Decision, Guest, Intelligence, Outcome, Property, Signal, Stay, User, Workspace, WorkspaceMembership } from "../src/models/index.js";
import { bearer, cleanupAuthFixtures, createActor, tokenFor } from "./lib/authFixtures.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, "..", "server.js");
const PORT = 5075;
const TRAP_PORT = 5076;
const BASE = `http://localhost:${PORT}/api`;

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

async function call(method, url, { headers = {}, body } = {}) {
  const response = await fetch(`${BASE}${url}`, {
    method,
    headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  return { status: response.status, json, data: json?.data, code: json?.details?.code };
}

function waitForHealth(timeoutMs = 20000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = async () => {
      try {
        if ((await fetch(`${BASE}/health`)).ok) return resolve();
      } catch {
        // not ready
      }
      if (Date.now() - start > timeoutMs) return reject(new Error("server not healthy"));
      setTimeout(attempt, 200);
    };
    attempt();
  });
}

const SECRET_MARKERS = { first: "Zyxwvu", last: "Qponmlk", email: "zyxwvu.qponmlk@example.invalid", reservation: "RSV-AUTHZ-SECRET-5512", provider: "provider-authz-secret", model: "model-authz-secret" };
const leaks = (json) => Object.values(SECRET_MARKERS).filter((marker) => JSON.stringify(json).toLowerCase().includes(marker.toLowerCase())).concat(/knowledgeProvenance|embedding|apiKey/i.test(JSON.stringify(json)) ? ["structure"] : []);

const ids = { workspaces: [], properties: [], signals: [], guests: [], stays: [], intelligences: [] };
const PRE_EXISTING = ["Guest", "Stay", "Signal", "Intelligence", "Decision", "Action", "Outcome", "Property", "Unit", "Workspace", "KnowledgeDocument", "KnowledgeChunk", "ImportBatch", "Conversation", "Message"];
let ownWorkspaceIds = [];
const globalCounts = async () =>
  Object.fromEntries(
    await Promise.all(
      PRE_EXISTING.map(async (name) => {
        const model = Models[name];
        const filter = name === "Workspace" ? { _id: { $nin: ownWorkspaceIds } } : name === "Property" ? { _id: { $nin: ids.properties } } : name === "Signal" ? { _id: { $nin: ids.signals } } : name === "Intelligence" ? { _id: { $nin: ids.intelligences } } : name === "Guest" ? { _id: { $nin: ids.guests } } : name === "Stay" ? { _id: { $nin: ids.stays } } : name === "Decision" || name === "Action" || name === "Outcome" ? { workspaceId: { $nin: ownWorkspaceIds } } : {};
        return [name, await model.countDocuments(filter)];
      }),
    ),
  );

async function cleanup() {
  await connectDatabase();
  await cleanupAuthFixtures();
  const ws = { $in: ids.workspaces };
  await Promise.all([Outcome.deleteMany({ workspaceId: ws }), Action.deleteMany({ workspaceId: ws }), Decision.deleteMany({ workspaceId: ws })]);
  await Promise.all([
    Intelligence.deleteMany({ workspaceId: ws }),
    Signal.deleteMany({ workspaceId: ws }),
    Stay.deleteMany({ workspaceId: ws }),
    Guest.deleteMany({ workspaceId: ws }),
    Property.deleteMany({ workspaceId: ws }),
    WorkspaceMembership.deleteMany({ workspaceId: ws }),
  ]);
  await Workspace.deleteMany({ _id: ws });
  await disconnectDatabase();
}

async function main() {
  const stamp = Date.now();
  const trapHits = [];
  const trap = http.createServer((req, res) => {
    trapHits.push(`${req.method} ${req.url}`);
    res.statusCode = 500;
    res.end("{}");
  });
  await new Promise((resolve) => trap.listen(TRAP_PORT, resolve));

  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, PORT: String(PORT), LLM_PROVIDER: "test-python", AI_SERVICE_URL: `http://localhost:${TRAP_PORT}`, KNOWLEDGE_DEV_AUTHORIZED_LEVEL: "restricted" },
    stdio: "ignore",
  });

  try {
    await waitForHealth();
    ok("ephemeral backend healthy (stub authentication; dev fallback level deliberately RESTRICTED)");
    await connectDatabase();
    await Promise.all([User.init(), WorkspaceMembership.init(), Decision.init()]);

    // ------------------------------------------------ fixtures
    const mkWs = async (label, status = "active") => {
      const doc = await Workspace.create({ name: `Authz ${label} ${stamp}`, slug: `authz-${label}-${stamp}`, status });
      ids.workspaces.push(doc._id);
      return doc;
    };
    const wsA = await mkWs("a");
    const wsB = await mkWs("b");
    const wsS = await mkWs("suspended", "suspended");
    ownWorkspaceIds = ids.workspaces;
    const A = String(wsA._id);
    const B = String(wsB._id);
    const S = String(wsS._id);
    const before = await globalCounts();

    const property = await Property.create({ workspaceId: wsA._id, name: `Authz Property ${stamp}`, code: `AZ-${stamp}` });
    ids.properties.push(property._id);
    const guest = await Guest.create({ workspaceId: wsA._id, firstName: SECRET_MARKERS.first, lastName: SECRET_MARKERS.last, email: SECRET_MARKERS.email });
    ids.guests.push(guest._id);
    const stay = await Stay.create({ workspaceId: wsA._id, guestId: guest._id, propertyId: property._id, reservationId: SECRET_MARKERS.reservation, checkIn: new Date("2030-01-01"), checkOut: new Date("2030-01-03") });
    ids.stays.push(stay._id);

    const newIntel = async (workspace, { level = "guest", severity = "medium", knowledgeVisibility } = {}) => {
      const signal = await Signal.create({ workspaceId: workspace._id, type: "maintenance", severity, title: `Authz ${level} ${severity} ${Math.random().toString(36).slice(2, 7)}` });
      ids.signals.push(signal._id);
      const intel = await Intelligence.create({
        workspaceId: workspace._id,
        signalIds: [signal._id],
        propertyId: workspace === wsA ? property._id : undefined,
        guestId: workspace === wsA ? guest._id : undefined,
        stayId: workspace === wsA ? stay._id : undefined,
        generatedBy: "llm",
        provider: SECRET_MARKERS.provider,
        model: SECRET_MARKERS.model,
        risk: { level: severity },
        analysis: { situation: "s", evidence: ["e"], impact: "i", recommendation: "Consider the documented guidance. Recommendation only.", confidence: "medium" },
        analysisVersion: "intelligence-v1",
        analysisLevel: level,
        knowledgeVisibility,
      });
      ids.intelligences.push(intel._id);
      return intel;
    };

    const actor = async (role, workspace = wsA, label = "authz") => createActor({ role, workspaceId: workspace._id, label });
    const viewer = await actor("viewer");
    const operator = await actor("operator");
    const reviewer = await actor("reviewer");
    const admin = await actor("admin");
    // Phase 35 (proposer != reviewer): fixtures are PROPOSED by a dedicated seeding user, so the reviewer/admin under test are never the proposer
    // of the record they review. A second admin proposes restricted-level fixtures (an operator's ceiling cannot see them).
    const seeder = await actor("operator", wsA, "authz-seeder");
    const admin2 = await actor("admin", wsA, "authz-admin2");
    const outsider = await createActor({ label: "authz-outsider" }); // registered, no membership anywhere
    const adminB = await actor("admin", wsB); // a member of B only
    const multi = await createActor({ role: "viewer", workspaceId: wsA._id, label: "authz-multi" }); // viewer in A ...
    const multiB = await WorkspaceMembership.create({ userId: multi.user._id, workspaceId: wsB._id, role: "admin" }); // ... admin in B
    const revoked = await actor("reviewer", wsA, "authz-revoked");
    await WorkspaceMembership.updateOne({ _id: revoked.membership._id }, { $set: { status: "revoked" } });
    const disabled = await actor("reviewer", wsA, "authz-disabled");
    await User.updateOne({ _id: disabled.user._id }, { $set: { status: "disabled" } });
    const suspendedAdmin = await createActor({ role: "admin", workspaceId: wsS._id, label: "authz-suspended" });
    const unregistered = { headers: bearer(signStubToken({ iss: STUB_ISSUER, sub: `never-provisioned-${stamp}`, exp: Math.floor(Date.now() / 1000) + 600 }, process.env.AUTH_STUB_SECRET)) };
    const H = (who) => who.headers;

    const iGuest = await newIntel(wsA, { level: "guest", severity: "high" });
    const iStaff = await newIntel(wsA, { level: "staff", knowledgeVisibility: "staff" });
    const iRestricted = await newIntel(wsA, { level: "restricted", knowledgeVisibility: "restricted" });
    const iB = await newIntel(wsB);
    const counts0 = { actions: await Action.countDocuments({ workspaceId: { $in: ids.workspaces } }), outcomes: await Outcome.countDocuments({ workspaceId: { $in: ids.workspaces } }) };

    const propose = (intel, who, ws = A, extra = "") => call("POST", `/decisions/propose/${intel._id}?workspaceId=${ws}${extra}`, { headers: who ? H(who) : {} });
    const make = async (level = "guest", severity = "medium") => {
      const intel = await newIntel(wsA, { level, severity, knowledgeVisibility: level === "guest" ? undefined : level });
      const r = await propose(intel, seeder);
      return { intel, id: r.data?._id, r };
    };

    // ------------------------------------------------ 1. authentication
    const endpoints = [
      ["propose", (h) => call("POST", `/decisions/propose/${iGuest._id}?workspaceId=${A}`, { headers: h })],
      ["approve", (h) => call("POST", `/decisions/64b64c4f2f1c2e0012345678/approve?workspaceId=${A}`, { headers: h, body: {} })],
      ["reject", (h) => call("POST", `/decisions/64b64c4f2f1c2e0012345678/reject?workspaceId=${A}`, { headers: h, body: {} })],
      ["list", (h) => call("GET", `/decisions?workspaceId=${A}`, { headers: h })],
      ["detail", (h) => call("GET", `/decisions/64b64c4f2f1c2e0012345678?workspaceId=${A}`, { headers: h })],
    ];
    for (const [name, run] of endpoints) {
      let r = await run({});
      check(`AU1: ${name}: missing token -> 401`, r.status === 401 && r.code === "MISSING_CREDENTIAL");
      r = await run({ authorization: "Basic abc" });
      check(`AU2: ${name}: malformed Authorization -> 401`, r.status === 401);
      r = await run({ authorization: "Bearer" });
      check(`AU3: ${name}: bearer without a token -> 401`, r.status === 401);
      r = await run(bearer("not.a.token"));
      check(`AU4: ${name}: invalid token -> 401`, r.status === 401 && r.code === "INVALID_TOKEN");
      r = await run(bearer(signStubToken({ iss: STUB_ISSUER, sub: viewer.user.subject, exp: Math.floor(Date.now() / 1000) - 30 }, process.env.AUTH_STUB_SECRET)));
      check(`AU5: ${name}: expired token -> 401`, r.status === 401 && r.code === "TOKEN_EXPIRED");
      r = await run(bearer(signStubToken({ iss: STUB_ISSUER, sub: viewer.user.subject, exp: Math.floor(Date.now() / 1000) + 600 }, "a-different-secret-not-real-0123456789")));
      check(`AU6: ${name}: wrong signature -> 401`, r.status === 401);
      r = await run(H(unregistered));
      check(`AU7: ${name}: valid token, unregistered identity -> 403`, r.status === 403 && r.code === "IDENTITY_NOT_REGISTERED");
    }
    let r = await call("GET", `/decisions?workspaceId=${A}`, { headers: H(viewer) });
    check("AU8: a valid token authenticates", r.status === 200);
    check("AU9: nothing was auto-provisioned for the unregistered identity", (await User.countDocuments({ subject: `never-provisioned-${stamp}` })) === 0);

    // ------------------------------------------------ 2. workspace membership
    r = await call("GET", `/decisions?workspaceId=${A}`, { headers: H(reviewer) });
    check("WS1: active membership -> 200", r.status === 200);
    r = await call("GET", `/decisions?workspaceId=${A}`, { headers: H(revoked) });
    check("WS2: revoked membership -> 404", r.status === 404);
    r = await call("GET", `/decisions?workspaceId=${B}`, { headers: H(reviewer) });
    check("WS3: wrong workspace (member of A only) -> 404", r.status === 404);
    r = await call("GET", `/decisions?workspaceId=${A}`, { headers: H(disabled) });
    check("WS4: disabled user -> 403", r.status === 403 && r.code === "USER_DISABLED");
    r = await call("GET", `/decisions?workspaceId=${S}`, { headers: H(suspendedAdmin) });
    check("WS5: suspended workspace -> 404 even for its admin", r.status === 404);
    r = await call("GET", `/decisions?workspaceId=${A}`, { headers: H(outsider) });
    check("WS6: registered user with no membership -> 404", r.status === 404);
    r = await call("GET", `/decisions?workspaceId=${A}`, { headers: H(adminB) });
    check("WS7: an admin of workspace B has no authority in A -> 404", r.status === 404);
    r = await call("GET", `/decisions?workspaceId=64b64c4f2f1c2e0012345678`, { headers: H(reviewer) });
    check("WS8: a non-existent workspace looks identical -> 404 'Workspace not found'", r.status === 404 && r.json.message === "Workspace not found");
    r = await call("GET", `/decisions`, { headers: H(reviewer) });
    check("WS9: missing workspaceId -> 400", r.status === 400);
    r = await call("GET", `/decisions?workspaceId=not-an-id`, { headers: H(reviewer) });
    check("WS10: malformed workspaceId -> 400", r.status === 400);
    r = await call("GET", `/decisions?workspaceId=${A}&workspaceId=${B}`, { headers: H(viewer) });
    check("WS11: a duplicated workspaceId parameter grants nothing", r.status === 400 || r.status === 404, `HTTP ${r.status}`);
    r = await call("POST", `/decisions/propose/${iB._id}?workspaceId=${A}`, { headers: H(operator) });
    check("WS12: cross-workspace Intelligence cannot produce a Decision (404)", r.status === 404);
    r = await call("GET", `/decisions?workspaceId=${A}`, { headers: H(multi) });
    const multiRoleA = r.status;
    const multiPropose = await call("POST", `/decisions/propose/${iGuest._id}?workspaceId=${A}`, { headers: H(multi) });
    const multiProposeB = await call("POST", `/decisions/propose/${iB._id}?workspaceId=${B}`, { headers: H(multi) });
    check("WS13: one user, two workspaces: viewer in A cannot propose, admin in B can", multiRoleA === 200 && multiPropose.status === 403 && multiProposeB.status === 201, `${multiPropose.status}/${multiProposeB.status}`);
    void multiB;

    // ------------------------------------------------ 3. permission matrix
    const matrix = { viewer: [200, 403, 403, 403], operator: [200, 201, 403, 403], reviewer: [200, 201, 200, 200], admin: [200, 201, 200, 200] };
    const whom = { viewer, operator, reviewer, admin };
    for (const [role, [read, prop, approve, reject]] of Object.entries(matrix)) {
      const who = whom[role];
      const list = await call("GET", `/decisions?workspaceId=${A}`, { headers: H(who) });
      const seed = await make("guest", "low");
      const detail = await call("GET", `/decisions/${seed.id}?workspaceId=${A}`, { headers: H(who) });
      check(`PM1: ${role} can read (list + detail)`, list.status === read && detail.status === read);
      const own = await newIntel(wsA, { level: "guest", severity: "low" });
      const proposed = await propose(own, who);
      check(`PM2: ${role} propose -> ${prop}`, proposed.status === prop, `HTTP ${proposed.status}`);
      const a = await make("guest", "medium");
      const ar = await call("POST", `/decisions/${a.id}/approve?workspaceId=${A}`, { headers: H(who), body: { note: `by ${role}` } });
      check(`PM3: ${role} approve -> ${approve}`, ar.status === approve, `HTTP ${ar.status}`);
      const b = await make("guest", "medium");
      const rr = await call("POST", `/decisions/${b.id}/reject?workspaceId=${A}`, { headers: H(who), body: { note: `by ${role}` } });
      check(`PM4: ${role} reject -> ${reject}`, rr.status === reject, `HTTP ${rr.status}`);
      const wantApproved = approve === 200 ? "approved" : "proposed";
      const wantRejected = reject === 200 ? "rejected" : "proposed";
      check(`PM5: ${role}: stored states match (a denial changes nothing)`, (await Decision.findById(a.id).lean()).status === wantApproved && (await Decision.findById(b.id).lean()).status === wantRejected);
      if (prop === 403) check(`PM6: ${role}: a denied proposal created no Decision`, (await Decision.countDocuments({ intelligenceId: own._id })) === 0);
    }
    check("PM7: no role holds action:execute", !Object.values(await import("../src/auth/roles.js").then((m) => m.ROLE_PERMISSIONS)).some((list) => list.includes("action:execute")));

    // ------------------------------------------------ 4. knowledge ceiling
    const dGuest = await make("guest", "low");
    const dStaff = await make("staff", "medium");
    const dRestricted = (await (async () => {
      const intel = await newIntel(wsA, { level: "restricted", knowledgeVisibility: "restricted" });
      const p = await propose(intel, admin2);
      return { intel, id: p.data?._id, p };
    })());
    const seen = async (who) => {
      const list = await call("GET", `/decisions?workspaceId=${A}&limit=100`, { headers: H(who) });
      const detail = async (id) => (await call("GET", `/decisions/${id}?workspaceId=${A}`, { headers: H(who) })).status;
      return { ids: new Set((list.data ?? []).map((x) => x._id)), guest: await detail(dGuest.id), staff: await detail(dStaff.id), restricted: await detail(dRestricted.id) };
    };
    const sv = await seen(viewer);
    check("KC1: viewer (ceiling guest) sees only the guest-derived Decision", sv.guest === 200 && sv.staff === 404 && sv.restricted === 404 && sv.ids.has(dGuest.id) && !sv.ids.has(dStaff.id) && !sv.ids.has(dRestricted.id));
    const so = await seen(operator);
    check("KC2: operator (ceiling staff) sees guest + staff, not restricted", so.guest === 200 && so.staff === 200 && so.restricted === 404 && !so.ids.has(dRestricted.id));
    const sr = await seen(reviewer);
    check("KC3: reviewer (ceiling staff) sees guest + staff, not restricted", sr.guest === 200 && sr.staff === 200 && sr.restricted === 404 && !sr.ids.has(dRestricted.id));
    const sa = await seen(admin);
    check("KC4: admin (ceiling restricted) sees all three", sa.guest === 200 && sa.staff === 200 && sa.restricted === 200 && sa.ids.has(dRestricted.id));
    check("KC5: the dev fallback (restricted) did NOT elevate the viewer", sv.restricted === 404);
    const totals = await call("GET", `/decisions?workspaceId=${A}&limit=100`, { headers: H(viewer) });
    check("KC6: a hidden Decision is also absent from the pagination total", totals.json.pagination.total === totals.data.length && totals.data.every((x) => x.knowledgeVisibility !== "staff" && x.knowledgeVisibility !== "restricted"));
    const opStaff = await propose(iStaff, operator);
    const opRestricted = await propose(iRestricted, operator);
    const revRestricted = await propose(iRestricted, reviewer);
    const adminRestricted = await propose(iRestricted, admin);
    check("KC7: operator can propose from staff-level, not restricted-level, Intelligence", opStaff.status === 201 && opRestricted.status === 404 && revRestricted.status === 404 && adminRestricted.status === 201, `${opStaff.status}/${opRestricted.status}/${revRestricted.status}/${adminRestricted.status}`);
    r = await call("POST", `/decisions/${dRestricted.id}/approve?workspaceId=${A}`, { headers: H(reviewer), body: {} });
    check("KC8: a reviewer cannot approve a Decision whose parent is hidden from them (404)", r.status === 404);
    r = await call("POST", `/decisions/${dRestricted.id}/approve?workspaceId=${A}`, { headers: H(admin), body: {} });
    check("KC9: the admin can", r.status === 200);
    r = await call("POST", `/decisions/${dStaff.id}/approve?workspaceId=${A}`, { headers: H(viewer), body: {} });
    check("KC10: a viewer attempting a staff-only Decision is refused (403)", r.status === 403);

    // ------------------------------------------------ 5. elevation attacks
    const target = await make("guest", "high");
    const forgedHeaders = { ...H(viewer), "x-role": "admin", "x-permissions": "decision:review,action:execute", "x-permission": "decision:review", "x-knowledge-level": "restricted", "x-user-id": String(admin.user._id), "x-workspace-id": B, "x-forwarded-user": "admin" };
    r = await call("POST", `/decisions/${target.id}/approve?workspaceId=${A}`, { headers: forgedHeaders, body: {} });
    check("EL1: forged role / permission / user-id headers cannot approve (403)", r.status === 403);
    r = await call("GET", `/decisions/${dStaff.id}?workspaceId=${A}`, { headers: forgedHeaders });
    check("EL2: a forged knowledge-level header cannot reveal a staff-derived Decision (404)", r.status === 404);
    r = await call("POST", `/decisions/${target.id}/approve?workspaceId=${A}&role=admin&permission=decision:review&permissions=decision:review&level=restricted&knowledgeLevel=restricted&userId=${admin.user._id}`, { headers: H(viewer), body: {} });
    check("EL3: role / permission / level / user-id QUERY parameters change nothing (403)", r.status === 403);
    r = await call("POST", `/decisions/${target.id}/approve?workspaceId=${A}`, { headers: H(viewer), body: { role: "admin", permissions: ["decision:review"], level: "restricted", userId: String(admin.user._id) } });
    check("EL4: role / permission / level / user-id in the BODY change nothing (403)", r.status === 403);
    r = await call("POST", `/decisions/${target.id}/approve?workspaceId=${A}`, { headers: bearer(tokenFor(viewer.user, { role: "admin", roles: ["admin"], permissions: ["decision:review"], knowledgeLevel: "restricted", workspaceId: A, scope: "admin" })), body: {} });
    check("EL5: role / permission / level / workspace CLAIMS inside a valid token change nothing (403)", r.status === 403);
    r = await call("GET", `/decisions?workspaceId=${A}`, { headers: { "x-role": "admin", "x-user-id": String(admin.user._id), "x-knowledge-level": "restricted" } });
    check("EL6: forged identity headers WITHOUT a token do not authenticate (401)", r.status === 401);
    r = await call("POST", `/decisions/${target.id}/approve?workspaceId=${B}`, { headers: H(viewer), body: {} });
    check("EL7: workspace manipulation (a workspace the viewer is not in) -> 404", r.status === 404);
    r = await call("POST", `/decisions/${target.id}/approve?workspaceId=${B}`, { headers: H(multi), body: {} });
    check("EL8: an admin of B cannot approve A's Decision by selecting B (404)", r.status === 404);
    r = await call("POST", `/decisions/${target.id}/approve?workspaceId=${A}`, { headers: H(multi), body: {} });
    check("EL9: ...nor by selecting A, where they are only a viewer (403)", r.status === 403);
    r = await call("POST", `/decisions/${target.id}/approve?workspaceId=${A}`, { headers: H(reviewer), body: { workspaceId: B } });
    check("EL10: a workspaceId in the body is not accepted as authority (400)", r.status === 400);
    check("EL11: none of the forged attempts changed the Decision", (await Decision.findById(target.id).lean()).status === "proposed");

    // ------------------------------------------------ 6. lifecycle
    const ok1 = await make("guest", "high");
    check("LC1: an authorized proposal creates a proposed Decision", ok1.r.status === 201 && ok1.r.data.status === "proposed" && ok1.r.data.priority === "high");
    const opP = await propose(await newIntel(wsA, { level: "guest", severity: "low" }), operator);
    check("LC2: an operator's proposal is authorized (201)", opP.status === 201);
    const deny = await propose(await newIntel(wsA), viewer);
    check("LC3: an unauthorized proposal (viewer) is refused (403)", deny.status === 403);
    r = await call("POST", `/decisions/${ok1.id}/approve?workspaceId=${A}`, { headers: H(operator), body: {} });
    check("LC4: an unauthorized approval (operator) is refused (403)", r.status === 403);
    r = await call("POST", `/decisions/${ok1.id}/reject?workspaceId=${A}`, { headers: H(viewer), body: {} });
    check("LC5: an unauthorized rejection (viewer) is refused (403)", r.status === 403);
    check("LC6: the refusals changed nothing", (await Decision.findById(ok1.id).lean()).status === "proposed");
    r = await call("POST", `/decisions/${ok1.id}/approve?workspaceId=${A}`, { headers: H(reviewer), body: { note: "authorized" } });
    check("LC7: an authorized approval succeeds", r.status === 200 && r.data.status === "approved" && r.data.transitions.length === 1);
    // Phase 35 made the proposer unable to review their own proposal; Phase 48.1 (a single-user product) relaxes that for a DECISION only: the proposer who
    // holds decision:review may confirm their own Decision (both identities are recorded). The permission itself is still required (LC3-LC5 above).
    const selfIntel = await newIntel(wsA, { level: "guest", severity: "medium" });
    const selfProposed = await propose(selfIntel, reviewer);
    r = await call("POST", `/decisions/${selfProposed.data._id}/approve?workspaceId=${A}`, { headers: H(reviewer), body: {} });
    const selfDoc = await Decision.findById(selfProposed.data._id).lean();
    check("LC8: SELF-APPROVAL is ALLOWED for a Decision (Phase 48.1): the reviewer who proposed it approves it (200); the proposer and the reviewer are both recorded", r.status === 200 && r.data.status === "approved" && selfDoc.status === "approved" && String(selfDoc.proposedBy) === String(selfDoc.review.reviewedBy));
    const selfIntel2 = await newIntel(wsA, { level: "guest", severity: "medium" });
    const selfProposed2 = await propose(selfIntel2, reviewer);
    r = await call("POST", `/decisions/${selfProposed2.data._id}/reject?workspaceId=${A}`, { headers: H(reviewer), body: {} });
    check("LC8b: ...and may reject their own Decision (200)", r.status === 200 && r.data.status === "rejected");
    r = await call("POST", `/decisions/${selfProposed2.data._id}/approve?workspaceId=${A}`, { headers: H(admin), body: {} });
    check("LC8c: once decided, the Decision is terminal for everyone (an approval after the rejection is refused, 409)", r.status === 409);
    r = await call("POST", `/decisions/${ok1.id}/approve?workspaceId=${A}`, { headers: H(reviewer), body: {} });
    r = await call("POST", `/decisions/${ok1.id}/reject?workspaceId=${A}`, { headers: H(admin), body: {} });
    check("LC9: approved is terminal (reject -> 409)", r.status === 409);
    const ok2 = await make("guest", "medium");
    r = await call("POST", `/decisions/${ok2.id}/reject?workspaceId=${A}`, { headers: H(admin), body: { note: "no" } });
    check("LC10: an authorized rejection succeeds", r.status === 200 && r.data.status === "rejected");
    r = await call("POST", `/decisions/${ok2.id}/approve?workspaceId=${A}`, { headers: H(reviewer), body: {} });
    check("LC11: rejected is terminal (approve -> 409)", r.status === 409);
    r = await call("POST", `/decisions/${ok1.id}/approve?workspaceId=${A}`, { headers: H(admin), body: {} });
    check("LC12: re-approving is an idempotent no-op with no second transition", r.status === 200 && r.data.transitions.length === 1);
    r = await call("POST", `/decisions/${ok1.id}/approve?workspaceId=${B}`, { headers: H(adminB), body: {} });
    check("LC13: cross-workspace approval by B's admin -> 404", r.status === 404);
    r = await call("POST", `/decisions/${ok1.id}/reject?workspaceId=${B}`, { headers: H(adminB), body: {} });
    check("LC14: cross-workspace rejection by B's admin -> 404", r.status === 404);
    r = await call("GET", `/decisions/${ok1.id}?workspaceId=${B}`, { headers: H(adminB) });
    check("LC15: cross-workspace read by B's admin -> 404", r.status === 404);
    const dup1 = await propose(ok1.intel, operator);
    const dup2 = await propose(ok1.intel, reviewer);
    check("LC16: a duplicate proposal is idempotent (200, same Decision, from any authorized role)", dup1.status === 200 && dup2.status === 200 && dup1.data._id === ok1.id && dup2.data._id === ok1.id && (await Decision.countDocuments({ intelligenceId: ok1.intel._id })) === 1);
    const raceIntel = await newIntel(wsA);
    const race = await Promise.all(Array.from({ length: 8 }, (_, i) => propose(raceIntel, i % 2 ? operator : admin)));
    check("LC17: concurrent proposals -> exactly one 201, one stored Decision", race.filter((x) => x.status === 201).length === 1 && race.filter((x) => x.status === 200).length === 7 && (await Decision.countDocuments({ intelligenceId: raceIntel._id })) === 1);
    r = await call("POST", `/decisions/propose/${iGuest._id}?workspaceId=${A}`, { headers: H(operator), body: { description: "client text", priority: "low" } });
    check("LC18: proposal still refuses client-supplied content (400)", r.status === 400);
    r = await call("POST", `/decisions/${ok2.id}/approve?workspaceId=${A}`, { headers: H(reviewer), body: { reviewer: "somebody", reviewedAt: "2000-01-01" } });
    check("LC19: approval still refuses a reviewer name and a client timestamp (400)", r.status === 400);
    const view = (await call("GET", `/decisions/${ok1.id}?workspaceId=${A}`, { headers: H(viewer) })).data;
    check("LC20: no actor attribution was added (no reviewer/actor fields)", !/reviewer|approvedBy|rejectedBy|actor|userId/i.test(JSON.stringify(view)) && Object.keys(view).length === 18);
    const proposed1 = (await Decision.findById(ok1.id).lean());
    check("LC21: the stored description is the stored recommendation (deterministic, no LLM)", proposed1.description === "Consider the documented guidance. Recommendation only.");

    // ------------------------------------------------ 7. legacy endpoints (authenticated since Phase 16; the V1 protections hold for an ADMIN too)
    r = await call("POST", `/decisions`, { headers: H(admin), body: { workspaceId: A, intelligenceId: String(iGuest._id), description: "bypass", status: "approved" } });
    check("LG1: an admin's generic POST on an Intelligence V1 is still refused (409)", r.status === 409);
    r = await call("POST", `/decisions`, { headers: H(admin), body: { workspaceId: A, intelligenceId: String(iGuest._id), description: "x", decisionVersion: "decision-v1" } });
    check("LG2: ...and cannot mark a record decision-v1 (400)", r.status === 400);
    for (const body of [{ status: "proposed" }, { description: "rewritten" }, { intelligenceId: String(iGuest._id) }]) {
      r = await call("PATCH", `/decisions/${ok1.id}?workspaceId=${A}`, { headers: H(admin), body });
      check(`LG3: an admin's generic PATCH cannot change a Decision V1 (${Object.keys(body)[0]})`, r.status === 409, `HTTP ${r.status}`);
    }
    const legacyIntel = await Intelligence.create({ workspaceId: wsA._id, signalIds: [] });
    ids.intelligences.push(legacyIntel._id);
    r = await call("POST", `/decisions`, { headers: H(admin), body: { workspaceId: A, intelligenceId: String(legacyIntel._id), description: "legacy record" } });
    check("LG4: an authorized generic legacy POST creates a plain non-V1 record", r.status === 201 && r.data.decisionVersion === null);
    r = await call("POST", `/decisions`, { body: { workspaceId: A, intelligenceId: String(legacyIntel._id), description: "no token" } });
    check("LG4b: the generic legacy POST without a token -> 401 (Phase 16)", r.status === 401);
    check("LG5: the Decision V1 record is unchanged by every legacy attempt", (await Decision.findById(ok1.id).lean()).status === "approved" && (await Decision.findById(ok1.id).lean()).description === "Consider the documented guidance. Recommendation only.");

    // ------------------------------------------------ 8. side effects, privacy, integrity
    const after0 = { actions: await Action.countDocuments({ workspaceId: { $in: ids.workspaces } }), outcomes: await Outcome.countDocuments({ workspaceId: { $in: ids.workspaces } }) };
    check("SE1: no Action created by any proposal / approval / rejection", after0.actions === counts0.actions, `${counts0.actions} -> ${after0.actions}`);
    check("SE2: no Outcome created", after0.outcomes === counts0.outcomes, `${counts0.outcomes} -> ${after0.outcomes}`);
    check("SE3: no request reached the AI service (no LLM call)", trapHits.length === 0, trapHits.join(","));
    const priv = await call("GET", `/decisions?workspaceId=${A}&limit=100`, { headers: H(admin) });
    check("PV1: responses carry no guest PII, reservation id, provider/model or provenance", leaks(priv.json).length === 0, leaks(priv.json).join(","));
    check("PV2: no Decision V1 is `completed`", (await Decision.countDocuments({ workspaceId: { $in: ids.workspaces }, decisionVersion: "decision-v1", status: "completed" })) === 0);
    const afterCounts = await globalCounts();
    const drift = PRE_EXISTING.filter((name) => before[name] !== afterCounts[name]);
    check("DB1: every PRE-EXISTING operational collection is unchanged", drift.length === 0, drift.map((n) => `${n}:${before[n]}->${afterCounts[n]}`).join(","));
  } finally {
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
    trap.close();
    try {
      await cleanup();
      ok("mongodb cleanup");
    } catch (error) {
      fail("mongodb cleanup", String(error));
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

function ok(name) {
  check(name, true);
}
function fail(name, detail) {
  check(name, false, detail);
}

main().catch(async (error) => {
  console.error(error);
  try {
    await cleanup();
  } catch {
    // best effort
  }
  process.exit(1);
});
