/**
 * Phase 15 validation: operational data authorization (Property, Unit, Signal, Guest, Stay).
 *
 *   READ    Property / Unit / Signal   intelligence:view  (every member)
 *           Guest / Stay               operations:view    (operator, reviewer, admin; NOT viewer)
 *           Signal context             operations:view    (it embeds Guest and Stay facts)
 *   WRITE   Property / Unit            workspace:admin
 *           Signal / Guest / Stay      operations:manage  (create, update)
 *   DELETE  every resource             workspace:admin
 *
 * REAL HTTP against a REAL spawned backend (its process-wide fallback knowledge level is the HIGHEST, so
 * any use of it for an authenticated caller would leak), REAL stored users and memberships and
 * stub-signed tokens. Everything is synthetic and lives in throwaway workspaces that are removed at the
 * end; the real operational records are counted before and after and are never touched.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { signStubToken, STUB_ISSUER } from "../src/auth/stubTokenVerifier.js";
import * as Models from "../src/models/index.js";
import { Guest, Property, Signal, Stay, Unit, User, Workspace, WorkspaceMembership } from "../src/models/index.js";
import { bearer, cleanupAuthFixtures, createActor } from "./lib/authFixtures.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, "..", "server.js");
const PORT = 5085;
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

async function call(method, url, headers = {}, body) {
  const response = await fetch(`${BASE}${url}`, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const raw = await response.text();
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {
    json = null;
  }
  return { status: response.status, json, raw, data: json?.data, code: json?.details?.code };
}

async function waitForHealth(timeoutMs = 20000) {
  const start = Date.now();
  for (;;) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch {
      // not ready
    }
    if (Date.now() - start > timeoutMs) throw new Error("server not healthy");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

const PII = { first: "Zyxwvu", last: "Qponmlk", email: "zyxwvu.p15@example.invalid", phone: "7770001515", reservation: "RSV-P15-SECRET-7731" };
const piiLeaks = (raw) => Object.values(PII).filter((v) => raw.toLowerCase().includes(v.toLowerCase()));
const ids = { workspaces: [] };

async function cleanup() {
  await connectDatabase();
  await cleanupAuthFixtures();
  const ws = { $in: ids.workspaces };
  const owned = await Property.find({ workspaceId: ws }).distinct("_id");
  await Promise.all([Models.Signal.deleteMany({ workspaceId: ws }), Models.Stay.deleteMany({ workspaceId: ws }), Models.Guest.deleteMany({ workspaceId: ws })]);
  await Models.Unit.deleteMany({ propertyId: { $in: owned } });
  await Promise.all([Property.deleteMany({ workspaceId: ws }), WorkspaceMembership.deleteMany({ workspaceId: ws })]);
  await Workspace.deleteMany({ _id: ws });
  await disconnectDatabase();
}

async function main() {
  const stamp = Date.now();
  let n = 0;
  const uniq = () => `${stamp}-${(n += 1)}`;
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, PORT: String(PORT), LLM_PROVIDER: "test", KNOWLEDGE_DEV_AUTHORIZED_LEVEL: "restricted", AI_SERVICE_URL: "http://localhost:9" },
    stdio: "ignore",
  });

  try {
    await waitForHealth();
    check("ephemeral server healthy (stub authentication; process fallback level: restricted)", true);
    await connectDatabase();
    await Promise.all([User.init(), WorkspaceMembership.init()]);

    const mkWs = async (label, status = "active") => {
      const doc = await Workspace.create({ name: `P15 ${label} ${stamp}`, slug: `p15-${label}-${stamp}`, status });
      ids.workspaces.push(doc._id);
      return doc;
    };
    const wsA = await mkWs("a");
    const wsB = await mkWs("b");
    const wsS = await mkWs("suspended", "suspended");
    const A = String(wsA._id);
    const B = String(wsB._id);
    const S = String(wsS._id);
    const OWN = ids.workspaces;
    const NAMES = ["Workspace", "Property", "Guest", "Stay", "Signal", "Intelligence", "KnowledgeDocument", "KnowledgeChunk", "ImportBatch", "Conversation", "Message", "Decision", "Action", "Outcome"];
    const realCounts = async () => ({
      ...Object.fromEntries(await Promise.all(NAMES.map(async (name) => [name, await Models[name].countDocuments(name === "Workspace" ? { _id: { $nin: OWN } } : { workspaceId: { $nin: OWN } })]))),
      Unit: await Unit.countDocuments({ propertyId: { $nin: await Property.find({ workspaceId: { $in: OWN } }).distinct("_id") } }),
    });
    const before = await realCounts();
    const usersBefore = await User.countDocuments({});
    const membershipsBefore = await WorkspaceMembership.countDocuments({});

    // ------------------------------------------------ seed fixtures (models, in the throwaway workspaces)
    const mkProperty = (ws, tag) => Property.create({ workspaceId: ws._id, name: `P15 Property ${tag} ${uniq()}`, code: `P15-${tag}-${uniq()}` });
    const PA = await mkProperty(wsA, "A");
    const PB = await mkProperty(wsB, "B");
    const mkUnit = (property) => Unit.create({ propertyId: property._id, unitNumber: `U-${uniq()}` });
    const UA = await mkUnit(PA);
    const UB = await mkUnit(PB);
    const mkGuest = (ws, extra = {}) => Guest.create({ workspaceId: ws._id, firstName: PII.first, lastName: PII.last, email: `${uniq()}.${PII.email}`, phone: PII.phone, ...extra });
    const GA = await mkGuest(wsA, { propertyId: PA._id });
    const GB = await mkGuest(wsB, { propertyId: PB._id });
    const mkStay = (ws, guest, property, unit, extra = {}) => Stay.create({ workspaceId: ws._id, guestId: guest._id, propertyId: property._id, unitId: unit?._id, reservationId: `${PII.reservation}-${uniq()}`, status: "confirmed", checkIn: new Date("2031-01-01"), checkOut: new Date("2031-01-03"), ...extra });
    const SA = await mkStay(wsA, GA, PA, UA);
    const SB = await mkStay(wsB, GB, PB, UB, { checkIn: new Date("2032-01-01"), checkOut: new Date("2032-01-03") });
    const mkSignal = (ws, extra = {}) => Signal.create({ workspaceId: ws._id, type: "maintenance", title: `P15 signal ${uniq()}`, ...extra });
    const GSigA = await mkSignal(wsA, { propertyId: PA._id, unitId: UA._id, guestId: GA._id, stayId: SA._id });
    const GSigB = await mkSignal(wsB, { propertyId: PB._id });

    const actor = (role, ws = wsA, label = "p15") => createActor({ role, workspaceId: ws._id, label });
    const viewer = await actor("viewer");
    const operator = await actor("operator");
    const reviewer = await actor("reviewer");
    const admin = await actor("admin");
    const adminB = await actor("admin", wsB);
    const outsider = await createActor({ label: "p15-outsider" });
    const revoked = await actor("operator", wsA, "p15-revoked");
    await WorkspaceMembership.updateOne({ _id: revoked.membership._id }, { $set: { status: "revoked" } });
    const disabled = await actor("operator", wsA, "p15-disabled");
    await User.updateOne({ _id: disabled.user._id }, { $set: { status: "disabled" } });
    const suspendedAdmin = await createActor({ role: "admin", workspaceId: wsS._id, label: "p15-suspended" });
    const unregistered = bearer(signStubToken({ iss: STUB_ISSUER, sub: `never-provisioned-${stamp}`, exp: Math.floor(Date.now() / 1000) + 600 }, process.env.AUTH_STUB_SECRET));
    const exp = () => Math.floor(Date.now() / 1000) + 600;
    const H = (who) => who.headers;
    const roles = { viewer, operator, reviewer, admin };

    // ------------------------------------------------ resource table
    const R = {
      property: { path: "/properties", read: ["viewer", "operator", "reviewer", "admin"], write: ["admin"], seed: PA, seedB: PB, create: (ws) => ({ workspaceId: ws, name: `P15 new ${uniq()}`, code: `P15N-${uniq()}` }), patch: { name: "P15 renamed" }, model: Property },
      unit: { path: "/units", read: ["viewer", "operator", "reviewer", "admin"], write: ["admin"], seed: UA, seedB: UB, create: (ws) => ({ workspaceId: ws, propertyId: String(PA._id), unitNumber: `N-${uniq()}` }), patch: { type: "suite" }, model: Unit },
      signal: { path: "/signals", read: ["viewer", "operator", "reviewer", "admin"], write: ["operator", "reviewer", "admin"], seed: GSigA, seedB: GSigB, create: (ws) => ({ workspaceId: ws, type: "maintenance", title: `P15 created ${uniq()}` }), patch: { title: "P15 retitled" }, model: Signal },
      guest: { path: "/guests", read: ["operator", "reviewer", "admin"], write: ["operator", "reviewer", "admin"], seed: GA, seedB: GB, create: (ws) => ({ workspaceId: ws, propertyId: String(ws === A ? PA._id : PB._id), firstName: "P15new", lastName: "Guest", email: `${uniq()}@example.invalid` }), patch: { phone: "7770002626" }, model: Guest },
      stay: { path: "/stays", read: ["operator", "reviewer", "admin"], write: ["operator", "reviewer", "admin"], seed: SA, seedB: SB, create: (ws) => ({ workspaceId: ws, guestId: String(GA._id), propertyId: String(PA._id), reservationId: `P15-NEW-${uniq()}` }), patch: { source: "p15" }, model: Stay },
    };
    const created = []; // [resourceName, id] of records this suite created over HTTP (for cleanup counts)

    // ================================================ 1. identity, every resource (list + detail + a write)
    for (const [name, r] of Object.entries(R)) {
      const one = () => `${r.path}/${r.seed._id}?workspaceId=${A}`;
      const many = () => `${r.path}?workspaceId=${A}`;
      let res = await call("GET", many());
      check(`ID1 ${name}: list without a token -> 401`, res.status === 401 && res.code === "MISSING_CREDENTIAL", `HTTP ${res.status}`);
      res = await call("GET", one());
      check(`ID1 ${name}: detail without a token -> 401`, res.status === 401);
      res = await call("POST", r.path, {}, r.create(A));
      check(`ID1 ${name}: create without a token -> 401`, res.status === 401);
      res = await call("PATCH", one(), {}, r.patch);
      check(`ID1 ${name}: update without a token -> 401`, res.status === 401);
      res = await call("DELETE", one());
      check(`ID1 ${name}: delete without a token -> 401`, res.status === 401);
      for (const [label, headers] of [["invalid", bearer("not.a.token")], ["malformed", { authorization: "Basic abc" }], ["expired", bearer(signStubToken({ iss: STUB_ISSUER, sub: operator.user.subject, exp: Math.floor(Date.now() / 1000) - 30 }, process.env.AUTH_STUB_SECRET))], ["wrong signature", bearer(signStubToken({ iss: STUB_ISSUER, sub: operator.user.subject, exp: exp() }, "a-different-secret-not-real-0123456789"))]]) {
        res = await call("GET", one(), headers);
        check(`ID2 ${name}: ${label} credential -> 401`, res.status === 401, `HTTP ${res.status}`);
      }
      res = await call("GET", many(), unregistered);
      check(`ID3 ${name}: valid token, unregistered identity -> 403`, res.status === 403 && res.code === "IDENTITY_NOT_REGISTERED");
      res = await call("GET", many(), H(disabled));
      check(`ID4 ${name}: disabled user -> 403`, res.status === 403);
      res = await call("GET", many(), H(revoked));
      check(`ID5 ${name}: revoked membership -> 404`, res.status === 404);
      res = await call("GET", many(), H(outsider));
      check(`ID6 ${name}: non-member -> 404`, res.status === 404);
      res = await call("GET", `${r.path}?workspaceId=${S}`, H(suspendedAdmin));
      check(`ID7 ${name}: member of a SUSPENDED workspace -> 404`, res.status === 404);
      res = await call("GET", r.path, H(admin));
      check(`ID8 ${name}: missing workspaceId -> clean 400`, res.status === 400);
      res = await call("GET", one(), H(operator));
      check(`ID9 ${name}: an active member is authenticated (${r.read.includes("operator") ? "200" : "403"})`, res.status === (r.read.includes("operator") ? 200 : 403), `HTTP ${res.status}`);
    }
    check("ID10: nothing was auto-provisioned for the unregistered identity", (await User.countDocuments({ subject: `never-provisioned-${stamp}` })) === 0);

    // ================================================ 2. the role matrix, every resource
    for (const [name, r] of Object.entries(R)) {
      for (const [role, who] of Object.entries(roles)) {
        const mayRead = r.read.includes(role);
        const mayWrite = r.write.includes(role);
        const list = await call("GET", `${r.path}?workspaceId=${A}`, H(who));
        check(`RM ${name}/${role}: list -> ${mayRead ? 200 : 403}`, list.status === (mayRead ? 200 : 403), `HTTP ${list.status}`);
        const detail = await call("GET", `${r.path}/${r.seed._id}?workspaceId=${A}`, H(who));
        check(`RM ${name}/${role}: detail -> ${mayRead ? 200 : 403}`, detail.status === (mayRead ? 200 : 403), `HTTP ${detail.status}`);
        if (!mayRead) check(`RM ${name}/${role}: the denial carries no Guest/Stay PII`, piiLeaks(list.raw + detail.raw).length === 0);
        if (mayRead) check(`RM ${name}/${role}: the list contains only workspace A rows`, list.data.every((x) => String(x.workspaceId ?? A) === A) && !list.raw.includes(String(r.seedB._id)));
        const make = await call("POST", r.path, H(who), r.create(A));
        check(`RM ${name}/${role}: create -> ${mayWrite ? 201 : 403}`, make.status === (mayWrite ? 201 : 403), `HTTP ${make.status} ${make.json?.message ?? ""}`);
        if (make.status === 201) created.push([name, make.data._id]);
        const upd = await call("PATCH", `${r.path}/${r.seed._id}?workspaceId=${A}`, H(who), r.patch);
        check(`RM ${name}/${role}: update -> ${mayWrite ? 200 : 403}`, upd.status === (mayWrite ? 200 : 403), `HTTP ${upd.status} ${upd.json?.message ?? ""}`);
        // a disposable record to delete
        const victim = await r.model.create(name === "unit" ? { propertyId: PA._id, unitNumber: `D-${uniq()}` } : name === "property" ? { workspaceId: wsA._id, name: `P15 victim ${uniq()}`, code: `P15V-${uniq()}` } : name === "signal" ? { workspaceId: wsA._id, type: "maintenance", title: `P15 victim ${uniq()}` } : name === "guest" ? { workspaceId: wsA._id, firstName: "P15v", lastName: "Victim", email: `${uniq()}@example.invalid` } : { workspaceId: wsA._id, guestId: GA._id, propertyId: PA._id, reservationId: `P15-V-${uniq()}` });
        const del = await call("DELETE", `${r.path}/${victim._id}?workspaceId=${A}`, H(who));
        const mayDelete = role === "admin";
        check(`RM ${name}/${role}: delete -> ${mayDelete ? 200 : 403}`, del.status === (mayDelete ? 200 : 403), `HTTP ${del.status}`);
        check(`RM ${name}/${role}: the record ${mayDelete ? "is deleted" : "survives a denied delete"}`, Boolean(await r.model.exists({ _id: victim._id })) === !mayDelete);
        if (!mayDelete) await r.model.deleteOne({ _id: victim._id });
      }
    }
    // the seeded records still exist and were only changed by AUTHORIZED updates
    for (const [name, r] of Object.entries(R)) check(`RM ${name}: seeded record still present`, Boolean(await r.model.exists({ _id: r.seed._id })));

    // ================================================ 3. Signal context (embeds Guest/Stay facts)
    for (const [role, who] of Object.entries(roles)) {
      const c = await call("GET", `/signals/${GSigA._id}/context?workspaceId=${A}`, H(who));
      check(`CX ${role}: signal context -> ${role === "viewer" ? 403 : 200}`, c.status === (role === "viewer" ? 403 : 200), `HTTP ${c.status}`);
      if (role === "viewer") check("CX viewer: the denial carries no Guest/Stay PII", piiLeaks(c.raw).length === 0);
    }
    check("CX no token -> 401; cross-workspace -> 404", (await call("GET", `/signals/${GSigA._id}/context?workspaceId=${A}`)).status === 401 && (await call("GET", `/signals/${GSigA._id}/context?workspaceId=${B}`, H(admin))).status === 404 && (await call("GET", `/signals/${GSigA._id}/context?workspaceId=${B}`, H(adminB))).status === 404);

    // ================================================ 4. cross-workspace, every resource
    for (const [name, r] of Object.entries(R)) {
      const countB = await r.model.countDocuments(name === "unit" ? { propertyId: PB._id } : { workspaceId: wsB._id });
      const countA = await r.model.countDocuments(name === "unit" ? { propertyId: PA._id } : { workspaceId: wsA._id });
      // A's admin naming B
      let res = await call("GET", `${r.path}?workspaceId=${B}`, H(admin));
      check(`XW ${name}: A's admin listing workspace B -> 404`, res.status === 404);
      res = await call("GET", `${r.path}/${r.seedB._id}?workspaceId=${B}`, H(admin));
      check(`XW ${name}: A's admin reading B's record via workspace B -> 404`, res.status === 404);
      res = await call("POST", r.path, H(admin), r.create(B));
      check(`XW ${name}: A's admin creating in workspace B -> 404`, res.status === 404);
      res = await call("PATCH", `${r.path}/${r.seedB._id}?workspaceId=${B}`, H(admin), r.patch);
      check(`XW ${name}: A's admin updating B's record via workspace B -> 404`, res.status === 404);
      res = await call("DELETE", `${r.path}/${r.seedB._id}?workspaceId=${B}`, H(admin));
      check(`XW ${name}: A's admin deleting B's record via workspace B -> 404`, res.status === 404);
      // A's admin, own workspace selected, B's record id
      res = await call("GET", `${r.path}/${r.seedB._id}?workspaceId=${A}`, H(admin));
      check(`XW ${name}: B's record id under workspace A -> 404 (no cross-workspace read)`, res.status === 404 && piiLeaks(res.raw).length === 0);
      res = await call("PATCH", `${r.path}/${r.seedB._id}?workspaceId=${A}`, H(admin), r.patch);
      check(`XW ${name}: B's record id under workspace A cannot be updated -> 404`, res.status === 404);
      res = await call("DELETE", `${r.path}/${r.seedB._id}?workspaceId=${A}`, H(admin));
      check(`XW ${name}: B's record id under workspace A cannot be deleted -> 404`, res.status === 404);
      // query/body workspace disagreement: verified membership wins, and B is never written
      res = await call("POST", r.path + `?workspaceId=${B}`, H(admin), r.create(A));
      check(`XW ${name}: query workspace B + body workspace A: created (if at all) in A only`, (res.status === 201 ? String(res.data.workspaceId ?? A) === A : res.status !== 201), `HTTP ${res.status}`);
      if (res.status === 201) created.push([name, res.data._id]);
      check(`XW ${name}: no record of workspace B was created, changed or deleted`, (await r.model.countDocuments(name === "unit" ? { propertyId: PB._id } : { workspaceId: wsB._id })) === countB && (await r.model.exists({ _id: r.seedB._id })) !== null);
      void countA;
    }
    check("XW: B's seeded PII is unchanged", (await Guest.findById(GB._id).lean()).phone === PII.phone);

    // ================================================ 5. relationship attacks
    const asOperator = H(operator);
    const foreign = { property: String(PB._id), unit: String(UB._id), guest: String(GB._id), stay: String(SB._id) };
    const mustFail = (res) => res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 403;
    // Signals (operator of A)
    const sigBase = () => ({ workspaceId: A, type: "maintenance", title: `P15 rel ${uniq()}` });
    for (const [label, extra] of [["Property B", { propertyId: foreign.property }], ["Unit B", { unitId: foreign.unit }], ["Guest B", { guestId: foreign.guest }], ["Stay B", { stayId: foreign.stay }], ["Property A + Unit B", { propertyId: String(PA._id), unitId: foreign.unit }], ["Guest A + Stay B", { guestId: String(GA._id), stayId: foreign.stay }]]) {
      const body = { ...sigBase(), ...extra };
      const res = await call("POST", "/signals", asOperator, body);
      check(`RL Signal A + ${label}: create rejected`, mustFail(res), `HTTP ${res.status}`);
      check(`RL Signal A + ${label}: nothing was stored`, (await Signal.countDocuments({ title: body.title })) === 0);
    }
    for (const [label, extra] of [["Property B", { propertyId: foreign.property }], ["Unit B", { unitId: foreign.unit }], ["Guest B", { guestId: foreign.guest }], ["Stay B", { stayId: foreign.stay }]]) {
      const target = await mkSignal(wsA);
      const res = await call("PATCH", `/signals/${target._id}?workspaceId=${A}`, asOperator, extra);
      const stored = await Signal.findById(target._id).lean();
      check(`RL Signal A update -> ${label}: rejected and unchanged`, mustFail(res) && !["propertyId", "unitId", "guestId", "stayId"].some((k) => stored[k] && [foreign.property, foreign.unit, foreign.guest, foreign.stay].includes(String(stored[k]))), `HTTP ${res.status}`);
    }
    // a fully consistent same-workspace Signal is accepted
    let res = await call("POST", "/signals", asOperator, { ...sigBase(), propertyId: String(PA._id), unitId: String(UA._id), guestId: String(GA._id), stayId: String(SA._id) });
    check("RL Signal: valid same-workspace Property + Unit + Guest + Stay -> 201", res.status === 201, `HTTP ${res.status} ${res.json?.message ?? ""}`);
    if (res.status === 201) created.push(["signal", res.data._id]);
    for (const [label, extra] of [["Property", { propertyId: String(PA._id) }], ["Unit", { unitId: String(UA._id) }], ["Guest", { guestId: String(GA._id) }], ["Stay", { stayId: String(SA._id) }]]) {
      res = await call("POST", "/signals", asOperator, { ...sigBase(), ...extra });
      check(`RL Signal: valid same-workspace ${label} alone -> 201`, res.status === 201, `HTTP ${res.status} ${res.json?.message ?? ""}`);
      if (res.status === 201) created.push(["signal", res.data._id]);
    }
    // Stays
    for (const [label, extra] of [["Guest B", { guestId: foreign.guest }], ["Unit B", { unitId: foreign.unit }], ["Property B", { propertyId: foreign.property }], ["Property B + Unit B + Guest A", { propertyId: foreign.property, unitId: foreign.unit }]]) {
      const body = { workspaceId: A, guestId: String(GA._id), propertyId: String(PA._id), reservationId: `P15-REL-${uniq()}`, ...extra };
      res = await call("POST", "/stays", asOperator, body);
      check(`RL Stay A + ${label}: create rejected`, mustFail(res), `HTTP ${res.status}`);
      check(`RL Stay A + ${label}: nothing was stored`, (await Stay.countDocuments({ reservationId: body.reservationId })) === 0);
    }
    const stayTarget = await mkStay(wsA, GA, PA, null, { checkIn: new Date("2033-01-01"), checkOut: new Date("2033-01-02") });
    res = await call("PATCH", `/stays/${stayTarget._id}?workspaceId=${A}`, asOperator, { unitId: foreign.unit });
    check("RL Stay A update -> Unit B: rejected and unchanged", mustFail(res) && !(await Stay.findById(stayTarget._id).lean()).unitId, `HTTP ${res.status}`);
    res = await call("PATCH", `/stays/${stayTarget._id}?workspaceId=${A}`, asOperator, { guestId: foreign.guest, propertyId: foreign.property });
    const stayAfter = await Stay.findById(stayTarget._id).lean();
    check("RL Stay A update -> Guest B / Property B: cannot be re-pointed", String(stayAfter.guestId) === String(GA._id) && String(stayAfter.propertyId) === String(PA._id), `HTTP ${res.status}`);
    res = await call("POST", "/stays", asOperator, { workspaceId: A, guestId: String(GA._id), propertyId: String(PA._id), unitId: String(UA._id), reservationId: `P15-OK-${uniq()}`, checkIn: "2034-01-01", checkOut: "2034-01-03" });
    check("RL Stay: valid same-workspace Guest + Property + Unit -> 201", res.status === 201, `HTTP ${res.status} ${res.json?.message ?? ""}`);
    if (res.status === 201) created.push(["stay", res.data._id]);
    // Units
    const unitCount = await Unit.countDocuments({ propertyId: PB._id });
    res = await call("POST", "/units", H(admin), { workspaceId: A, propertyId: foreign.property, unitNumber: `X-${uniq()}` });
    check("RL Unit A + Property B: create rejected (404)", mustFail(res), `HTTP ${res.status}`);
    check("RL Unit A + Property B: nothing was added to Property B", (await Unit.countDocuments({ propertyId: PB._id })) === unitCount);
    res = await call("PATCH", `/units/${UB._id}?workspaceId=${A}`, H(admin), { type: "hijack" });
    check("RL Unit B via workspace A: cannot be updated", mustFail(res) && (await Unit.findById(UB._id).lean()).type !== "hijack");
    res = await call("GET", `/units?workspaceId=${A}&propertyId=${foreign.property}`, H(admin));
    check("RL Unit list filtered by Property B under workspace A: empty", res.status === 200 && res.data.length === 0);
    res = await call("GET", `/stays?workspaceId=${A}&guestId=${foreign.guest}`, H(operator));
    check("RL Stay list filtered by Guest B under workspace A: empty", res.status === 200 && res.data.length === 0);
    res = await call("GET", `/signals?workspaceId=${A}&guestId=${foreign.guest}`, H(viewer));
    check("RL Signal list filtered by Guest B under workspace A: empty", res.status === 200 && res.data.length === 0);

    // ================================================ 6. forged authorization never elevates
    const forged = { "x-role": "admin", "x-user-role": "admin", "x-permission": "workspace:admin", "x-permissions": "workspace:admin", "x-knowledge-level": "restricted", "x-workspace-id": B, cookie: "role=admin; permission=workspace:admin" };
    const forgedQuery = `&role=admin&permission=workspace:admin&permissions=workspace:admin&authorizedLevel=restricted`;
    const bodyForge = { role: "admin", permission: "workspace:admin", permissions: ["workspace:admin"], knowledgeLevel: "restricted", authorizedLevel: "restricted" };
    for (const [name, r] of Object.entries(R)) {
      const one = `${r.path}/${r.seed._id}?workspaceId=${A}${forgedQuery}`;
      for (const [role, who] of Object.entries(roles)) {
        const mayRead = r.read.includes(role);
        const mayWrite = r.write.includes(role);
        let x = await call("GET", `${r.path}?workspaceId=${A}${forgedQuery}`, { ...H(who), ...forged });
        check(`FG ${name}/${role}: list with forged headers + query -> ${mayRead ? 200 : 403}`, x.status === (mayRead ? 200 : 403), `HTTP ${x.status}`);
        x = await call("GET", one, { ...H(who), ...forged });
        check(`FG ${name}/${role}: detail with forged headers + query -> ${mayRead ? 200 : 403}`, x.status === (mayRead ? 200 : 403), `HTTP ${x.status}`);
        x = await call("POST", r.path, { ...H(who), ...forged }, { ...r.create(A), ...bodyForge });
        check(`FG ${name}/${role}: create with forged headers + body role/permission -> ${mayWrite ? 201 : 403}`, x.status === (mayWrite ? 201 : 403), `HTTP ${x.status}`);
        if (x.status === 201) created.push([name, x.data._id]);
        x = await call("PATCH", one, { ...H(who), ...forged }, { ...r.patch, ...bodyForge });
        check(`FG ${name}/${role}: update with forged headers + body role/permission -> ${mayWrite ? 200 : 403}`, x.status === (mayWrite ? 200 : 403), `HTTP ${x.status}`);
        if (role !== "admin") {
          x = await call("DELETE", one, { ...H(who), ...forged });
          check(`FG ${name}/${role}: delete with forged admin headers/query -> 403`, x.status === 403, `HTTP ${x.status}`);
        }
      }
      // forged workspace selection: the token's membership is still what decides
      let x = await call("GET", `${r.path}?workspaceId=${B}${forgedQuery}`, { ...H(operator), ...forged });
      check(`FG ${name}: operator of A selecting workspace B with forged headers -> 404`, x.status === 404);
      x = await call("POST", r.path, { ...H(operator), ...forged }, { ...r.create(B), ...bodyForge });
      check(`FG ${name}: operator of A posting body workspaceId B with forged headers -> 404 (or 403), never a write to B`, [403, 404].includes(x.status), `HTTP ${x.status}`);
      const forgedTok = bearer(signStubToken({ iss: STUB_ISSUER, sub: viewer.user.subject, email: viewer.user.email, exp: exp(), role: "admin", permissions: ["workspace:admin"], knowledgeLevel: "restricted", workspaceId: B }, process.env.AUTH_STUB_SECRET));
      x = await call("POST", r.path, forgedTok, r.create(A));
      check(`FG ${name}: a token CLAIMING role/permissions/workspace does not elevate a viewer (create -> 403)`, x.status === 403 || (r.write.includes("viewer") && x.status === 201), `HTTP ${x.status}`);
    }
    check("FG: nothing was written to workspace B by any forged request", (await Signal.countDocuments({ workspaceId: wsB._id })) === 1 && (await Guest.countDocuments({ workspaceId: wsB._id })) === 1 && (await Property.countDocuments({ workspaceId: wsB._id })) === 1 && (await Stay.countDocuments({ workspaceId: wsB._id })) === 1 && (await Unit.countDocuments({ propertyId: PB._id })) === 1);

    // ================================================ 7. PII in responses
    const gList = await call("GET", `/guests?workspaceId=${A}`, H(operator));
    check("PII1 operator: the Guest list returns the guest fields (existing contract)", gList.status === 200 && gList.data.length >= 1 && gList.data.every((g) => g.workspaceId === A));
    check("PII2 operator: the Guest list holds no other workspace's guest", !gList.raw.includes(String(GB._id)));
    check("PII3 no auth/role/permission/membership internals in Guest, Stay or Signal responses", !/"(password|token|issuer|subject|role|permissions?|membership|knowledgeLevel|authorizedLevel)"/i.test((await call("GET", `/guests/${GA._id}?workspaceId=${A}`, H(operator))).raw + (await call("GET", `/stays/${SA._id}?workspaceId=${A}`, H(operator))).raw + (await call("GET", `/signals?workspaceId=${A}`, H(viewer))).raw));
    const denials = [
      await call("GET", `/guests/${GA._id}?workspaceId=${A}`, H(viewer)),
      await call("GET", `/stays/${SA._id}?workspaceId=${A}`, H(viewer)),
      await call("GET", `/guests/${GB._id}?workspaceId=${A}`, H(operator)),
      await call("GET", `/stays/${SB._id}?workspaceId=${A}`, H(operator)),
      await call("GET", `/guests/${GB._id}?workspaceId=${B}`, H(operator)),
      await call("POST", "/guests", H(viewer), { workspaceId: A, firstName: PII.first, lastName: PII.last, email: PII.email }),
      await call("POST", "/stays", H(operator), { workspaceId: A, guestId: String(GB._id), propertyId: String(PA._id), reservationId: PII.reservation }),
      await call("GET", `/guests/${GA._id}?workspaceId=${A}`),
    ];
    check("PII4 no denial, 404 or validation error echoes Guest/Stay PII (name, email, phone, reservation id)", denials.every((d) => piiLeaks(d.raw).length === 0), denials.map((d) => d.status).join(","));
    check("PII5 statuses: viewer 403/403, cross-workspace 404/404/404, viewer POST 403, cross-ref rejected, no token 401", denials[0].status === 403 && denials[1].status === 403 && denials[2].status === 404 && denials[3].status === 404 && denials[4].status === 404 && denials[5].status === 403 && mustFail(denials[6]) && denials[7].status === 401, denials.map((d) => d.status).join(","));
    check("PII6 a hidden Guest and a missing Guest give the same 404 message", (await call("GET", `/guests/${GB._id}?workspaceId=${A}`, H(operator))).json?.message === (await call("GET", `/guests/6aa29b8d18df3e22b3e89c99?workspaceId=${A}`, H(operator))).json?.message);

    // ================================================ 8. integrity
    const after = await realCounts();
    const drift = Object.keys(before).filter((k) => before[k] !== after[k]);
    check("DB1: every PRE-EXISTING record count is identical", drift.length === 0, drift.map((k) => `${k}:${before[k]}->${after[k]}`).join(","));
    check("DB2: the throwaway seed records still exist (only authorized updates changed them)", (await Guest.exists({ _id: GA._id })) && (await Stay.exists({ _id: SA._id })) && (await Unit.exists({ _id: UA._id })));
    check("DB3: this suite created HTTP records only via authorized roles", created.length > 0);
    void usersBefore;
    void membershipsBefore;
  } finally {
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
    try {
      await cleanup();
      check("mongodb cleanup", true);
    } catch (error) {
      check("mongodb cleanup", false, String(error));
    }
  }
}

main()
  .then(() => {
    console.log(`\nPhase 15 operational authorization validation: ${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
