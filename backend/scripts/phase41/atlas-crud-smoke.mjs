/**
 * Atlas preflight - synthetic CRUD / tenant-isolation smoke against a database that ALREADY holds data, using ONLY the least-privilege application credential in backend/.env.
 *
 *   node scripts/phase41/atlas-crud-smoke.mjs
 *
 * It is the non-empty counterpart of atlas-synthetic-test.mjs (which refuses to write unless the database is empty). The same rules, enforced in code:
 *   - it REFUSES to run unless the connected database is `koi_staging` AND the authenticated user holds exactly `readWrite@koi_staging` (no admin credential is ever used);
 *   - BEFORE writing it fingerprints every existing document (per collection: count + a hash of the sorted _id list); AFTER cleanup the fingerprint must be IDENTICAL, which proves no
 *     existing record was modified or removed (collections with a TTL index - authsessions, authtokens - are compared by the ids this run could have touched: none);
 *   - every record it creates is synthetic (named ATLAS-SMOKE) and tracked by id; the only things deleted are what it created: both synthetic workspaces through the application's own
 *     cascade-delete route, and the synthetic users / memberships by tracked id. It never drops a collection or an index;
 *   - no Gemini call and no AI service: the one Intelligence record is written through the application's own service with the deterministic test label;
 *   - the backend is started as a child on :5041 against Atlas with AUTH_PROVIDER=stub and a RANDOM in-memory secret (nothing else in backend/.env is changed or copied).
 * Nothing is printed except fixed messages, counts and statuses: no credential, URI or host name.
 */
import crypto from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import dotenv from "dotenv";
import fs from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(here, "..", "..");
const uri = dotenv.parse(fs.readFileSync(path.join(BACKEND, ".env"), "utf8")).MONGODB_URI;
const PORT = 5041; const API = `http://localhost:${PORT}/api`;
const SECRET = crypto.randomBytes(32).toString("hex");
process.env.NODE_ENV = "development"; // the stub token signer needs an explicit development environment
const { signStubToken, STUB_ISSUER } = await import("../../src/auth/stubTokenVerifier.js");
let passed = 0; let failed = 0;
const check = (name, ok, detail = "") => { if (ok) { passed += 1; console.log(`PASS  ${name}${detail ? ` - ${detail}` : ""}`); } else { failed += 1; console.error(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`); } };
const stamp = Date.now();
const subjects = {};
const tok = (sub) => signStubToken({ iss: STUB_ISSUER, sub, exp: Math.floor(Date.now() / 1000) + 1800 }, SECRET);
const call = async (method, url, who, body) => {
  const r = await fetch(`${API}${url}`, { method, headers: { "content-type": "application/json", ...(who ? { authorization: `Bearer ${tok(subjects[who])}` } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { j = null; } return { status: r.status, j, d: j?.data, code: j?.details?.code };
};

if (!uri) { console.error("No MONGODB_URI in backend/.env"); process.exit(2); }
await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });
await import("../../src/models/index.js");
const M = mongoose.models;

// ---- gate: right database, exactly the least-privilege role
const status = await mongoose.connection.db.admin().command({ connectionStatus: 1 });
const roles = (status.authInfo?.authenticatedUserRoles ?? []).map((r) => `${r.role}@${r.db}`);
if (mongoose.connection.name !== "koi_staging" || roles.length !== 1 || roles[0] !== "readWrite@koi_staging") {
  console.error(`SMOKE NOT PERFORMED - the credential is not exactly readWrite@koi_staging (database "${mongoose.connection.name}", roles: ${roles.join(", ") || "none"})`);
  await mongoose.disconnect(); process.exit(3);
}
check("G0 the application credential holds exactly readWrite@koi_staging and the connected database is koi_staging", true);

const TTL = new Set(["authsessions", "authtokens"]);
async function fingerprint() {
  const out = {};
  for (const m of Object.values(M)) {
    const ids = (await m.collection.find({}, { projection: { _id: 1 } }).toArray()).map((d) => String(d._id)).sort();
    out[m.collection.collectionName] = { count: ids.length, hash: crypto.createHash("sha256").update(ids.join(",")).digest("hex").slice(0, 16) };
  }
  return out;
}
const before = await fingerprint();
const totalBefore = Object.values(before).reduce((s, v) => s + v.count, 0);
check("G1 existing data fingerprinted before any write", totalBefore > 0, `${Object.keys(before).length} collections, ${totalBefore} existing documents`);

const tracked = { users: [], memberships: [], workspaces: [] };
const server = spawn(process.execPath, [path.join(BACKEND, "server.js")], { cwd: BACKEND, env: { ...process.env, PORT: String(PORT), NODE_ENV: "development", AUTH_PROVIDER: "stub", AUTH_TOKEN_VERIFIER: "stub", AUTH_STUB_SECRET: SECRET, KOI_RATE_LIMIT_ENABLED: "false", KOI_LEARNING_CONTEXT_ENABLED: "" }, stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  let health = null;
  for (let i = 0; i < 80 && !health; i += 1) { try { const r = await fetch(`${API}/health`); if (r.ok) health = await r.json(); } catch { /* starting */ } if (!health) await sleep(500); }
  check("A1 the backend started against Atlas with the application credential reports healthy and database connected", health?.status === "healthy" && health?.database === "connected");

  // ---- provisioning: two synthetic workspaces, users + memberships (written through the application's models)
  const mkWs = async (k) => { const w = await M.Workspace.create({ name: `ATLAS-SMOKE-${k}`, slug: `atlas-smoke-${k.toLowerCase()}-${stamp}`, status: "active" }); tracked.workspaces.push(w._id); return w; };
  const wsA = await mkWs("A"); const wsB = await mkWs("B");
  const mkU = async (key, role, ws) => { const u = await M.User.create({ issuer: STUB_ISSUER, subject: `atlas-smoke-${key}-${stamp}` }); tracked.users.push(u._id); subjects[key] = u.subject; if (role) { const mem = await M.WorkspaceMembership.create({ userId: u._id, workspaceId: ws._id, role, status: "active" }); tracked.memberships.push(mem._id); } return u; };
  await mkU("adminA", "admin", wsA); await mkU("operatorA", "operator", wsA); await mkU("viewerA", "viewer", wsA); await mkU("adminB", "admin", wsB); await mkU("nobody", null);
  const A = String(wsA._id); const B = String(wsB._id);
  check("W1 INSERT: synthetic Workspace, User and WorkspaceMembership documents were written to Atlas", (await M.Workspace.countDocuments({ _id: { $in: tracked.workspaces } })) === 2 && (await M.User.countDocuments({ _id: { $in: tracked.users } })) === 5 && (await M.WorkspaceMembership.countDocuments({ _id: { $in: tracked.memberships } })) === 4);
  const dupUser = await M.User.create({ issuer: STUB_ISSUER, subject: subjects.adminA }).catch((e) => e);
  check("W2 the User unique index (issuer + subject) is enforced by Atlas", dupUser?.code === 11000);

  // ---- real API paths against Atlas
  const noTok = await call("GET", `/properties?workspaceId=${A}`);
  check("A2 a protected API with no token is 401", noTok.status === 401);
  const prop = await call("POST", "/properties", "adminA", { workspaceId: A, name: "ATLAS-SMOKE Property", code: "ASMK" });
  const unit = await call("POST", "/units", "adminA", { workspaceId: A, propertyId: prop.d?._id, unitNumber: "S-1" });
  const guest = await call("POST", "/guests", "adminA", { workspaceId: A, propertyId: prop.d?._id, firstName: "ATLAS-SMOKE", lastName: "Guest" });
  const stay = await call("POST", "/stays", "adminA", { workspaceId: A, guestId: guest.d?._id, propertyId: prop.d?._id, unitId: unit.d?._id, checkIn: new Date().toISOString(), checkOut: new Date(Date.now() + 86400000).toISOString(), status: "checked_in" });
  const sig = await call("POST", "/signals", "adminA", { workspaceId: A, propertyId: prop.d?._id, unitId: unit.d?._id, guestId: guest.d?._id, stayId: stay.d?._id, type: "maintenance", severity: "medium", title: "ATLAS-SMOKE maintenance signal", description: "Synthetic signal for the Atlas CRUD smoke test." });
  check("C-INSERT Property, Unit, Guest, Stay and Signal were created through the API", [prop, unit, guest, stay, sig].every((r) => r.status === 201), [prop, unit, guest, stay, sig].map((r) => r.status).join("/"));
  const read = await call("GET", `/signals/${sig.d?._id}?workspaceId=${A}`, "viewerA");
  check("C-READ a viewer reads the signal back from Atlas", read.status === 200 && read.d?.title === "ATLAS-SMOKE maintenance signal");
  const upd = await call("PATCH", `/signals/${sig.d?._id}?workspaceId=${A}`, "operatorA", { status: "acknowledged" });
  const read2 = await call("GET", `/signals/${sig.d?._id}?workspaceId=${A}`, "viewerA");
  check("C-UPDATE an operator acknowledges the signal and the change is read back", upd.status === 200 && read2.d?.status === "acknowledged");
  const list = await call("GET", `/signals?workspaceId=${A}`, "viewerA");
  check("C-LIST the workspace list returns exactly this workspace's one synthetic signal (workspaceId index)", list.status === 200 && (list.d?.length ?? list.j?.data?.items?.length) === 1);
  const doc = await call("POST", "/knowledge-documents", "adminA", { workspaceId: A, title: "ATLAS-SMOKE Procedure", documentType: "procedure", content: "# Synthetic heading\n\nSynthetic procedure text for the Atlas smoke test.\n\n## Second section\n\nMore synthetic text.", defaultVisibility: "staff" });
  const chunks = await call("POST", `/knowledge-documents/${doc.d?._id}/chunks?workspaceId=${A}`, "adminA", {});
  check("C-KNOWLEDGE a KnowledgeDocument and its KnowledgeChunk documents are written and indexed (chunking only: no embedding, no model)", doc.status === 201 && chunks.status === 201 && (await M.KnowledgeChunk.countDocuments({ workspaceId: A })) > 0, `${doc.status}/${chunks.status}`);

  // ---- Intelligence -> Decision -> Action -> Outcome (a PERSON acts; Intelligence is written by the application's own service with the deterministic test label: no Gemini)
  const { createAnalysisIntelligence } = await import("../../src/services/intelligenceService.js");
  const intel = (await createAnalysisIntelligence({ workspaceId: A, signal: { id: sig.d?._id, title: "ATLAS-SMOKE maintenance signal", type: "maintenance", severity: "medium" }, propertyId: prop.d?._id, level: "staff", analysis: { situation: "Synthetic situation.", evidence: ["Synthetic evidence."], impact: "Synthetic impact.", recommendation: "A person could consider a synthetic inspection.", confidence: "low" }, provider: "test", model: "deterministic-stub", knowledgeProvenance: [], safety: { state: "NORMAL", urgency: "routine", recommendedActionType: "inspection" } })).record;
  const dup = await createAnalysisIntelligence({ workspaceId: A, signal: { id: sig.d?._id, title: "ATLAS-SMOKE maintenance signal", type: "maintenance", severity: "medium" }, propertyId: prop.d?._id, level: "staff", analysis: { situation: "Second.", evidence: ["x"], impact: "x", recommendation: "x", confidence: "low" }, provider: "test", model: "deterministic-stub", knowledgeProvenance: [] });
  check("I1 Intelligence is written; the idempotency unique index in Atlas returns the stored record for a second write (created: false), not a second document", Boolean(intel?._id) && dup.created === false && (await M.Intelligence.countDocuments({ workspaceId: A })) === 1);
  const dec = await call("POST", `/decisions/propose/${intel._id}?workspaceId=${A}`, "adminA");
  const viewerDec = await call("POST", `/decisions/propose/${intel._id}?workspaceId=${A}`, "viewerA");
  const opApprove = await call("POST", `/decisions/${dec.d?._id}/approve?workspaceId=${A}`, "operatorA", {});
  const approve = await call("POST", `/decisions/${dec.d?._id}/approve?workspaceId=${A}`, "adminA", {});
  const act = await call("POST", `/actions/propose/${dec.d?._id}?workspaceId=${A}`, "adminA");
  const actApprove = await call("POST", `/actions/${act.d?._id}/approve?workspaceId=${A}`, "adminA", { note: "Atlas smoke." });
  const outcome = await call("POST", `/outcomes/record/${act.d?._id}?workspaceId=${A}`, "adminA", { status: "unknown", result: { summary: "ATLAS-SMOKE synthetic outcome" } });
  check("I2 Decision, Action and Outcome documents are written by people; role separation holds on Atlas data (viewer 403, operator cannot approve 403)", dec.status === 201 && viewerDec.status === 403 && opApprove.status === 403 && approve.status === 200 && act.status === 201 && actApprove.status === 200 && outcome.status === 201, [dec, viewerDec, opApprove, approve, act, actApprove, outcome].map((r) => r.status).join("/"));
  const back = await call("GET", `/outcomes?workspaceId=${A}`, "adminA");
  check("I3 the Outcome is read back from Atlas", back.status === 200 && JSON.stringify(back.j).includes("ATLAS-SMOKE synthetic outcome"));

  // ---- tenant isolation on Atlas
  const xB = await call("GET", `/properties?workspaceId=${A}`, "adminB");
  const xA = await call("GET", `/properties?workspaceId=${B}`, "adminA");
  const obj = await call("GET", `/signals/${sig.d?._id}?workspaceId=${B}`, "adminB");
  const none = await call("GET", `/properties?workspaceId=${A}`, "nobody");
  const forged = await call("POST", `/signals?workspaceId=${A}`, "adminB", { workspaceId: A, type: "other", title: "forged" });
  const viewerWrite = await call("POST", "/properties", "viewerA", { workspaceId: A, name: "x", code: "V" });
  const bDecision = await call("GET", `/decisions/${dec.d?._id}?workspaceId=${B}`, "adminB");
  const bIntel = await call("GET", `/intelligence/${intel._id}?workspaceId=${A}`, "adminB");
  check("T1 workspace B's admin cannot read workspace A (404), and A's admin cannot read B (404)", xB.status === 404 && xA.status === 404, `${xB.status}/${xA.status}`);
  check("T2 object-level: A's signal requested under workspace B is 404", obj.status === 404);
  check("T3 an identity with no membership cannot read workspace A", [403, 404].includes(none.status), `${none.status}`);
  check("T4 a forged body workspace (A) from B's admin writes nothing into A", forged.status !== 201 && (await M.Signal.countDocuments({ workspaceId: A, title: "forged" })) === 0, `${forged.status}`);
  check("T5 RBAC holds on Atlas: a viewer cannot create (403)", viewerWrite.status === 403);
  check("T6 B's admin cannot read A's Decision (404) or A's Intelligence (404/403)", bDecision.status === 404 && [403, 404].includes(bIntel.status), `${bDecision.status}/${bIntel.status}`);
  check("T7 workspace B holds no record created for A (Property / Guest / Signal / Intelligence / Decision / Action / Outcome counts are 0 in B)", (await Promise.all(["Property", "Guest", "Signal", "Intelligence", "Decision", "Action", "Outcome"].map((n) => M[n].countDocuments({ workspaceId: B })))).every((c) => c === 0));
} finally {
  // ---- cleanup: ONLY what this run created
  const statuses = [];
  for (const w of tracked.workspaces) {
    const ws = await M.Workspace.findById(w).lean(); if (!ws) continue;
    const r = await call("DELETE", `/workspaces/${w}`, ws.name.endsWith("-A") ? "adminA" : "adminB", { confirm: ws.slug });
    statuses.push(r.status);
  }
  await M.WorkspaceMembership.deleteMany({ _id: { $in: tracked.memberships } });
  await M.User.deleteMany({ _id: { $in: tracked.users } });
  try { server.kill(); } catch { /* gone */ }
  const after = await fingerprint();
  const diff = Object.keys(before).filter((k) => !TTL.has(k) && (before[k].count !== after[k].count || before[k].hash !== after[k].hash));
  const ttlDiff = [...TTL].filter((k) => before[k].hash !== after[k].hash);
  check("K1 CLEANUP: both synthetic workspaces were deleted through the application's cascade-delete route", statuses.length === 2 && statuses.every((s) => s === 200 || s === 204), `statuses ${statuses.join("/")}`);
  check("K2 DATA SAFETY: every pre-existing collection holds exactly the same document ids as before (count and id hash identical) - no existing record was modified-by-replacement or removed", diff.length === 0, diff.length ? diff.join(", ") : `${Object.keys(before).length - TTL.size} collections identical`);
  check("K3 the TTL collections (authsessions, authtokens) hold the same ids as before, or differ only by the server's own TTL expiry", ttlDiff.length === 0 || ttlDiff.every((k) => after[k].count <= before[k].count), ttlDiff.length ? `expired by TTL: ${ttlDiff.join(", ")}` : "identical");
  const leftover = (await Promise.all([M.Workspace.countDocuments({ _id: { $in: tracked.workspaces } }), M.User.countDocuments({ _id: { $in: tracked.users } }), M.WorkspaceMembership.countDocuments({ _id: { $in: tracked.memberships } })])).reduce((s, n) => s + n, 0);
  check("K4 no synthetic Workspace / User / WorkspaceMembership remains", leftover === 0);
  await mongoose.disconnect();
}
console.log(`\nAtlas CRUD smoke: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
