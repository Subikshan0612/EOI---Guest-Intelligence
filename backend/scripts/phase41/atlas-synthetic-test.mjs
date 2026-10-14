/**
 * Phase 41 - synthetic write / tenant-isolation / model-compatibility test against the REAL Atlas database, with exact cleanup.
 *
 *   P41_DIR=<dir holding stub.secret> node scripts/phase41/atlas-synthetic-test.mjs
 *
 * SAFETY (each is enforced in code, not by convention):
 *   - it REFUSES to write unless the Atlas application database is EMPTY: no collection holds a single document;
 *   - every record is synthetic and named P41-SYNTHETIC; no real user, customer, signal or PII;
 *   - the only things it deletes are the records it created: the two synthetic workspaces (through the application's own cascade-delete route), the synthetic
 *     users/memberships (by tracked id), and the one directly inserted Outcome (by id). It never drops a collection or an index;
 *   - afterwards it verifies every collection holds 0 documents again (collections and indexes remain: that is the initialised state);
 *   - it needs a backend on :5041 started against Atlas with AUTH_PROVIDER=stub (the SAME random secret as P41_DIR/stub.secret) and test-python AI providers,
 *     so NO Gemini call is made. Nothing is printed except fixed messages, counts and statuses.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import mongoose from "mongoose";

const here = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(here, "..", "..");
const DIR = process.env.P41_DIR;
const uri = dotenv.parse(fs.readFileSync(path.join(BACKEND, ".env"), "utf8")).MONGODB_URI;
const SECRET = fs.readFileSync(path.join(DIR, "stub.secret"), "utf8").trim();
const API = "http://localhost:5041/api";
process.env.NODE_ENV = "development";
const { signStubToken, STUB_ISSUER } = await import("../../src/auth/stubTokenVerifier.js");
let passed = 0; let failed = 0;
const check = (name, ok, detail = "") => { if (ok) { passed += 1; console.log(`PASS  ${name}${detail ? ` - ${detail}` : ""}`); } else { failed += 1; console.error(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`); } };
const stamp = Date.now();
const tok = (sub, over = {}) => signStubToken({ iss: STUB_ISSUER, sub, exp: Math.floor(Date.now() / 1000) + 1800, ...over }, SECRET);
const call = async (method, url, who, body) => {
  const r = await fetch(`${API}${url}`, { method, headers: { "content-type": "application/json", ...(who ? { authorization: `Bearer ${typeof who === "string" && who.includes(".") ? who : tok(subjects[who])}` } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { j = null; } return { status: r.status, j, d: j?.data, code: j?.details?.code };
};
const subjects = {};
await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
await import("../../src/models/index.js");
const M = mongoose.models;
const tracked = { users: [], memberships: [], workspaces: [], outcome: null };
const counts = async () => Object.fromEntries(await Promise.all(Object.entries(M).map(async ([n, m]) => [n, await m.estimatedDocumentCount()])));

// ---- gate: only an EMPTY database may be written to
const before = await counts();
const nonEmpty = Object.entries(before).filter(([, n]) => n > 0);
if (mongoose.connection.name !== "koi_staging" || nonEmpty.length > 0) {
  console.error(`WRITE TEST NOT PERFORMED - DATABASE NOT CONFIRMED EMPTY (database "${mongoose.connection.name}", non-empty collections: ${nonEmpty.map(([n, c]) => `${n}:${c}`).join(", ") || "none"})`);
  await mongoose.disconnect(); process.exit(3);
}
check("G0 the Atlas application database is EMPTY (every model's collection holds 0 documents), so the synthetic write test may proceed", true, `${Object.keys(before).length} collections checked`);

try {
  // ---- provisioning (operator-style): two workspaces, users with memberships, one user with none
  const mkWs = async (k) => { const w = await M.Workspace.create({ name: `P41-SYNTHETIC-${k}`, slug: `p41-synthetic-${k.toLowerCase()}-${stamp}`, status: "active" }); tracked.workspaces.push(w._id); return w; };
  const wsA = await mkWs("A"); const wsB = await mkWs("B");
  const mkU = async (key, role, ws) => { const u = await M.User.create({ issuer: STUB_ISSUER, subject: `p41-synthetic-${key}-${stamp}` }); tracked.users.push(u._id); subjects[key] = u.subject; if (role) { const mem = await M.WorkspaceMembership.create({ userId: u._id, workspaceId: ws._id, role }); tracked.memberships.push(mem._id); } };
  await mkU("adminA", "admin", wsA); await mkU("operatorA", "operator", wsA); await mkU("reviewerA", "reviewer", wsA); await mkU("reviewer2A", "reviewer", wsA); await mkU("viewerA", "viewer", wsA); await mkU("adminB", "admin", wsB); await mkU("nobody", null, null);
  const A = String(wsA._id); const B = String(wsB._id);
  check("W1 INSERT: Workspace, User and WorkspaceMembership documents were written to Atlas through the application's models (unique indexes enforced)", (await M.User.countDocuments()) === 7 && (await M.WorkspaceMembership.countDocuments()) === 6);
  const dupUser = await M.User.create({ issuer: STUB_ISSUER, subject: subjects.adminA }).catch((e) => e);
  check("W2 the User unique index (issuer + subject) is enforced by Atlas", dupUser?.code === 11000);

  // ---- real API paths against Atlas
  const health = await fetch("http://localhost:5041/api/health").then((r) => r.json());
  check("A1 the backend started against Atlas reports healthy and database connected", health.status === "healthy" && health.database === "connected");
  const noTok = await call("GET", `/properties?workspaceId=${A}`);
  check("A2 a protected API with no token is 401", noTok.status === 401);
  const prop = await call("POST", "/properties", "adminA", { workspaceId: A, name: "P41-SYNTHETIC Property", code: "P41A" });
  check("A3 INSERT through the API (Property)", prop.status === 201, `${prop.status}`);
  const unit = await call("POST", "/units", "adminA", { workspaceId: A, propertyId: prop.d?._id, unitNumber: "P41-1" });
  const guest = await call("POST", "/guests", "adminA", { workspaceId: A, firstName: "P41-SYNTHETIC", lastName: "Guest" });
  const stay = await call("POST", "/stays", "adminA", { workspaceId: A, guestId: guest.d?._id, propertyId: prop.d?._id, unitId: unit.d?._id, checkIn: new Date().toISOString(), checkOut: new Date(Date.now() + 86400000).toISOString(), status: "checked_in" });
  const sig = await call("POST", "/signals", "adminA", { workspaceId: A, propertyId: prop.d?._id, unitId: unit.d?._id, guestId: guest.d?._id, stayId: stay.d?._id, type: "maintenance", severity: "medium", title: "P41-SYNTHETIC maintenance signal", description: "synthetic" });
  check("A4 INSERT (Unit, Guest, Stay, Signal) through the API", [unit, guest, stay, sig].every((r) => r.status === 201), [unit, guest, stay, sig].map((r) => r.status).join("/"));
  const read = await call("GET", `/signals/${sig.d?._id}?workspaceId=${A}`, "viewerA");
  check("A5 READ: a viewer reads the signal back from Atlas", read.status === 200 && read.d?.title === "P41-SYNTHETIC maintenance signal");
  const upd = await call("PATCH", `/signals/${sig.d?._id}?workspaceId=${A}`, "operatorA", { status: "acknowledged" });
  const read2 = await call("GET", `/signals/${sig.d?._id}?workspaceId=${A}`, "viewerA");
  check("A6 UPDATE: an operator acknowledges the signal and the change is read back", upd.status === 200 && read2.d?.status === "acknowledged");
  const doc = await call("POST", "/knowledge-documents", "adminA", { workspaceId: A, title: "P41-SYNTHETIC Procedure", documentType: "procedure", content: "# Synthetic heading\n\nSynthetic procedure text for the Atlas compatibility test.\n\n## Second\n\nMore synthetic text.", defaultVisibility: "guest", isTestData: true });
  const chunks = await call("POST", `/knowledge-documents/${doc.d?._id}/chunks?workspaceId=${A}`, "adminA");
  check("A7 KnowledgeDocument and KnowledgeChunk documents are written and indexed in Atlas (chunking only: no embedding call, no model)", doc.status === 201 && chunks.status === 201 && (await M.KnowledgeChunk.countDocuments({ workspaceId: A })) > 0, `${doc.status}/${chunks.status}`);

  // ---- analysis through the real path with the DETERMINISTIC test providers (no Gemini)
  const an = await call("POST", `/intelligence/analyze/${sig.d?._id}?workspaceId=${A}`, "operatorA");
  const audit = await M.AnalysisAdmission.findOne({ workspaceId: A, signalId: sig.d?._id }).lean();
  check("A8 Intelligence + AnalysisAdmission are written to Atlas by the real analysis pipeline (deterministic test provider; zero Gemini calls)", an.status === 201 && audit?.outcome === "accepted" && audit.provider === "test", `${an.status} ${audit?.outcome}/${audit?.provider}`);
  const again = await call("POST", `/intelligence/analyze/${sig.d?._id}?workspaceId=${A}`, "operatorA");
  check("A9 IDEMPOTENCY index in Atlas: a second analysis request returns the stored analysis (200), not a second document", again.status === 200 && (await M.Intelligence.countDocuments({ workspaceId: A })) === 1);
  const dec = await call("POST", `/decisions/propose/${an.d?._id}?workspaceId=${A}`, "operatorA", {});
  const self = await call("POST", `/decisions/${dec.d?._id}/approve?workspaceId=${A}`, "operatorA", {});
  const appr = await call("POST", `/decisions/${dec.d?._id}/approve?workspaceId=${A}`, "reviewerA", {});
  const act = await call("POST", `/actions/propose/${dec.d?._id}?workspaceId=${A}`, "operatorA", { actionType: "inspection" });
  const actAppr = await call("POST", `/actions/${act.d?._id}/approve?workspaceId=${A}`, "reviewer2A", {});
  check("A10 Decision and Action documents are written; proposer/reviewer separation holds on Atlas data (operator cannot approve: 403; a reviewer can: 200)", dec.status === 201 && self.status === 403 && appr.status === 200 && act.status === 201 && actAppr.status === 200, `${dec.status}/${self.status}/${appr.status}/${act.status}/${actAppr.status}`);
  const outcome = await M.Outcome.create({ workspaceId: A, intelligenceId: an.d?._id, actionId: act.d?._id, status: "unknown", result: { summary: "P41-SYNTHETIC outcome" } });
  tracked.outcome = outcome._id;
  check("A11 an Outcome document (the API refuses outcomes by design; inserted through the model) is stored and read back", Boolean(await M.Outcome.findById(outcome._id).lean()));

  // ---- tenant isolation on Atlas
  const xB = await call("GET", `/properties?workspaceId=${A}`, "adminB");
  const xA = await call("GET", `/properties?workspaceId=${B}`, "adminA");
  const obj = await call("GET", `/signals/${sig.d?._id}?workspaceId=${B}`, "adminB");
  const none = await call("GET", `/properties?workspaceId=${A}`, "nobody");
  const forged = await call("POST", `/signals?workspaceId=${A}`, "adminB", { workspaceId: A, type: "other", title: "forged" });
  const viewerWrite = await call("POST", "/properties", "viewerA", { workspaceId: A, name: "x", code: "V" });
  check("T1 Workspace B's admin cannot read Workspace A (404), and A's admin cannot read B (404)", xB.status === 404 && xA.status === 404, `${xB.status}/${xA.status}`);
  check("T2 object-level: A's signal requested under workspace B is 404", obj.status === 404);
  check("T3 an identity with no membership cannot read workspace A", [403, 404].includes(none.status), `${none.status}`);
  check("T4 a forged body workspace (A) from B's admin writes nothing into A", forged.status !== 201 && (await M.Signal.countDocuments({ workspaceId: A, title: "forged" })) === 0, `${forged.status}`);
  check("T5 RBAC still holds on Atlas: a viewer cannot create (403)", viewerWrite.status === 403);
  const adminBDecision = await call("GET", `/decisions/${dec.d?._id}?workspaceId=${B}`, "adminB");
  check("T6 B's admin cannot read A's Decision (404)", adminBDecision.status === 404);
} finally {
  // ---- cleanup: ONLY what this test created
  const A2 = tracked.workspaces;
  const cleanup = [];
  for (const w of A2) {
    const ws = await M.Workspace.findById(w).lean(); if (!ws) continue;
    const admin = ws.name.endsWith("-A") ? "adminA" : "adminB";
    const r = await call("DELETE", `/workspaces/${w}`, admin, { confirm: ws.slug });
    cleanup.push(r.status);
  }
  if (tracked.outcome) await M.Outcome.deleteOne({ _id: tracked.outcome, workspaceId: { $in: A2 } });
  await M.WorkspaceMembership.deleteMany({ _id: { $in: tracked.memberships } });
  await M.User.deleteMany({ _id: { $in: tracked.users } });
  const after = await counts();
  const left = Object.entries(after).filter(([, n]) => n > 0);
  check("C1 CLEANUP: both synthetic workspaces were deleted through the application's cascade-delete route", cleanup.every((s) => s === 200 || s === 204), `statuses ${cleanup.join("/")}`);
  check("C2 after cleanup EVERY collection holds 0 documents again (the database is empty; collections and indexes remain)", left.length === 0, left.map(([n, c]) => `${n}:${c}`).join(", ") || "all 0");
  await mongoose.disconnect();
}
console.log(`\nAtlas synthetic test: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
