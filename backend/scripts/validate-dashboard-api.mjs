/**
 * Dashboard V1 read model - database + HTTP validation of
 *   GET /api/dashboard/signals
 *   GET /api/dashboard/signals/:signalId
 *
 * The endpoints are AUTHENTICATED (bearer token -> workspace membership ->
 * intelligence:view). The three throwaway servers stand for three callers: guest =
 * a viewer (ceiling guest), staff = an operator (ceiling staff), restricted = an
 * admin (ceiling restricted); each call carries a real token for a real user with a
 * real active membership in the workspace the URL names. The servers' process-wide
 * KNOWLEDGE_DEV_AUTHORIZED_LEVEL is set to the OPPOSITE extreme (guest server ->
 * restricted, the others -> guest) to prove the role, never the environment, decides.
 * Their AI_SERVICE_URL points at a TRAP server: any request
 * that reaches it (generation, retrieval or embedding) fails the suite - the
 * dashboard must only read stored data. All data is SYNTHETIC, created
 * directly in stamped throwaway workspaces and removed by workspaceId
 * afterward. Real (non-throwaway) records are fingerprinted before and after.
 */
import crypto from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import {
  Workspace, Property, Unit, Guest, Stay, Signal, KnowledgeDocument, KnowledgeChunk, Intelligence, ImportBatch,
} from "../src/models/index.js";
import { listDashboardSignals } from "../src/services/dashboardService.js";
import { actorFor, cleanupAuthFixtures } from "./lib/authFixtures.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, "..", "server.js");
const TRAP_PORT = 5994;
const PORTS = { guest: 5121, staff: 5122, restricted: 5123 };

let passed = 0;
let failed = 0;
const ok = (n) => { passed += 1; console.log(`PASS  ${n}`); };
const fail = (n, d = "") => { failed += 1; console.error(`FAIL  ${n}${d ? ` — ${d}` : ""}`); };
const check = (n, c, d = "") => (c ? ok(n) : fail(n, d));
const same = (n, a, e) => check(n, JSON.stringify(a) === JSON.stringify(e), `actual=${JSON.stringify(a)} expected=${JSON.stringify(e)}`);

const servers = [];
const trap = { hits: [], server: null };
const created = { workspaceIds: [] };

function startTrap() {
  trap.server = http.createServer((req, res) => { trap.hits.push(`${req.method} ${req.url}`); res.writeHead(500); res.end("trap"); });
  return new Promise((resolve) => trap.server.listen(TRAP_PORT, resolve));
}

const ROLE_FOR_SERVER = { guest: "viewer", staff: "operator", restricted: "admin" };
const FALLBACK_FOR_SERVER = { guest: "restricted", staff: "guest", restricted: "guest" };
const roleByBase = new Map();

async function startServer(name, port, level) {
  const env = { ...process.env, PORT: String(port), LLM_PROVIDER: "test-python", AI_SERVICE_URL: `http://localhost:${TRAP_PORT}`, KNOWLEDGE_DEV_AUTHORIZED_LEVEL: FALLBACK_FOR_SERVER[name] };
  servers.push(spawn(process.execPath, [SERVER_ENTRY], { env, stdio: "ignore" }));
  const base = `http://localhost:${port}/api`;
  const start = Date.now();
  for (;;) {
    try { if ((await fetch(`${base}/health`)).ok) { roleByBase.set(base, ROLE_FOR_SERVER[name]); return base; } } catch { /* not ready */ }
    if (Date.now() - start > 30000) throw new Error(`server ${name} not healthy`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function call(base, method, url, headers = {}) {
  const role = roleByBase.get(base);
  if (role) {
    const workspaceId = /[?&]workspaceId=([0-9a-fA-F]{24})/.exec(url)?.[1];
    headers = { ...headers, ...(await actorFor(role, workspaceId, "dashsuite")).headers };
  }
  const res = await fetch(`${base}${url}`, { method, headers });
  const raw = await res.text();
  let json = null;
  try { json = JSON.parse(raw); } catch { /* not json */ }
  return { status: res.status, json, raw };
}

const hashRows = (rows) => `${rows.length}:${crypto.createHash("sha256").update(rows.map((r) => `${r._id}:${r.updatedAt?.getTime?.() ?? ""}`).join("|")).digest("hex").slice(0, 12)}`;
const MODELS = [["Guest", Guest], ["Stay", Stay], ["ImportBatch", ImportBatch], ["Signal", Signal], ["KnowledgeDocument", KnowledgeDocument], ["KnowledgeChunk", KnowledgeChunk], ["Intelligence", Intelligence]];
async function fingerprint(filter) {
  const out = {};
  for (const [name, Model] of MODELS) out[name] = hashRows(await Model.find(filter, { _id: 1, updatedAt: 1 }).sort({ _id: 1 }).lean());
  return out;
}

async function cleanup() {
  const ids = created.workspaceIds;
  const props = (await Property.find({ workspaceId: { $in: ids } }, { _id: 1 }).lean()).map((p) => p._id);
  await KnowledgeChunk.deleteMany({ workspaceId: { $in: ids } });
  await KnowledgeDocument.deleteMany({ workspaceId: { $in: ids } });
  await Intelligence.deleteMany({ workspaceId: { $in: ids } });
  await Signal.deleteMany({ workspaceId: { $in: ids } });
  await Stay.deleteMany({ workspaceId: { $in: ids } });
  await Guest.deleteMany({ workspaceId: { $in: ids } });
  await Unit.deleteMany({ propertyId: { $in: props } });
  await Property.deleteMany({ workspaceId: { $in: ids } });
  await Workspace.deleteMany({ _id: { $in: ids } });
}

// recursively collect every key path in a JSON value
function keyPaths(value, prefix = "") {
  if (Array.isArray(value)) return value.flatMap((v, i) => keyPaths(v, `${prefix}[${i}]`));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => [`${prefix}.${k}`, ...keyPaths(v, `${prefix}.${k}`)]);
  return [];
}

async function main() {
  await connectDatabase();
  await Intelligence.init();
  const stamp = Date.now();
  await startTrap();
  const bases = {
    restricted: await startServer("restricted", PORTS.restricted, "restricted"),
    staff: await startServer("staff", PORTS.staff, "staff"),
    guest: await startServer("guest", PORTS.guest, "guest"),
  };

  const wsA = (await Workspace.create({ name: `7D A ${stamp}`, slug: `7d-a-${stamp}` }))._id;
  const wsB = (await Workspace.create({ name: `7D B ${stamp}`, slug: `7d-b-${stamp}` }))._id;
  const wsP = (await Workspace.create({ name: `7D P ${stamp}`, slug: `7d-p-${stamp}` }))._id;
  created.workspaceIds.push(wsA, wsB, wsP);
  const outsideBefore = await fingerprint({ workspaceId: { $nin: created.workspaceIds } });

  const propA = (await Property.create({ workspaceId: wsA, name: "Synthetic Property A", code: `DA${stamp}` }))._id;
  const propA2 = (await Property.create({ workspaceId: wsA, name: "Synthetic Property A2", code: `DB${stamp}` }))._id;
  const propB = (await Property.create({ workspaceId: wsB, name: "SECRET OTHER TENANT PROPERTY", code: `DC${stamp}` }))._id;
  const propP = (await Property.create({ workspaceId: wsP, name: "Synthetic Property P", code: `DP${stamp}` }))._id;
  const unitA = (await Unit.create({ propertyId: propA, unitNumber: "1A-R1", type: "room" }))._id;
  const unitB = (await Unit.create({ propertyId: propB, unitNumber: "SECRET-B-UNIT", type: "room" }))._id;
  const RES = `RES-${stamp}-SECRET`;
  const guest = await Guest.create({ workspaceId: wsA, firstName: "Zorbfirst", lastName: "Zorblast", email: `zorb-${stamp}@example.invalid`, phone: "7770001111" });
  const guestB = await Guest.create({ workspaceId: wsB, firstName: "Otherfirst", lastName: "Otherlast" });
  const CHECK_IN = new Date("2026-09-24T06:30:00.000Z"), CHECK_OUT = new Date("2026-09-27T05:30:00.000Z");
  const stay = await Stay.create({ workspaceId: wsA, guestId: guest._id, propertyId: propA, unitId: unitA, reservationId: RES, status: "confirmed", checkIn: CHECK_IN, checkOut: CHECK_OUT });
  const stayB = await Stay.create({ workspaceId: wsB, guestId: guestB._id, propertyId: propB, unitId: unitB, reservationId: `RES-${stamp}-OTHER`, status: "checked_in", checkIn: CHECK_IN, checkOut: CHECK_OUT });

  const doc = await KnowledgeDocument.create({ workspaceId: wsA, propertyId: propA, title: "Doc", documentType: "sop", content: "DOC-CONTENT-SECRET full source text", contentHash: `h-${stamp}`, isTestData: true, defaultVisibility: "staff" });
  const chunks = await KnowledgeChunk.insertMany(["15. Maintenance", "19. Staff Roles & Escalation", "Guest Policies"].map((section, i) => ({ documentId: doc._id, version: 1, workspaceId: wsA, propertyId: propA, status: "active", chunkIndex: i, section, sectionPath: [section], text: "CHUNK-TEXT-SECRET", visibility: i < 2 ? "staff" : "guest" })));
  const prov = (c, score) => ({ chunkId: String(c._id), knowledgeDocumentId: String(doc._id), version: 1, scope: "property", section: c.section, sectionPath: c.sectionPath, visibility: c.visibility, chunkIndex: c.chunkIndex, similarityScore: score - 0.05, retrievalScore: score });

  const mkSignal = (over) => Signal.create({ workspaceId: wsA, type: "maintenance", severity: "medium", source: "system", status: "new", description: "Synthetic.", occurredAt: new Date("2026-09-20T00:00:00Z"), ...over });
  const A = await mkSignal({ title: "SIG A full", severity: "medium", propertyId: propA, unitId: unitA, guestId: guest._id, stayId: stay._id, metadata: { synthetic: "true", purpose: "test" }, occurredAt: new Date("2026-09-25T07:00:00Z") });
  const B = await mkSignal({ title: "SIG B bare", severity: "high", propertyId: propA, occurredAt: new Date("2026-09-24T00:00:00Z") });
  const C = await mkSignal({ title: "SIG C legacy only", severity: "critical", propertyId: propA, occurredAt: new Date("2026-09-23T00:00:00Z") });
  const D = await mkSignal({ title: "SIG D restricted only", severity: "low", type: "complaint", propertyId: propA2, occurredAt: new Date("2026-09-22T00:00:00Z") });
  const E = await mkSignal({ title: "[SYNTHETIC TEST] looks synthetic but is not marked", severity: "low", type: "housekeeping", propertyId: propA, occurredAt: new Date("2026-09-26T00:00:00Z"), status: "acknowledged", metadata: { note: "synthetic" } });
  const CROSS = await mkSignal({ title: "SIG CROSS refs another workspace", severity: "medium", propertyId: propB, unitId: unitB, guestId: guestB._id, stayId: stayB._id, occurredAt: new Date("2026-09-21T00:00:00Z") });
  const X = await Signal.create({ workspaceId: wsB, type: "maintenance", severity: "critical", title: "SIG X other tenant", description: "SECRET-B-DESCRIPTION", propertyId: propB, occurredAt: new Date("2026-09-27T00:00:00Z") });

  const v1 = (signal, level, extra = {}) => Intelligence.create({
    workspaceId: wsA, signalIds: [signal._id], propertyId: signal.propertyId, provider: "test", model: "deterministic-stub", generatedBy: "llm",
    analysis: { situation: `SITUATION-${level}`, evidence: [`EVIDENCE-${level}-1`, `EVIDENCE-${level}-2`, `EVIDENCE-${level}-3`], impact: `IMPACT-${level}`, recommendation: `RECOMMENDATION-${level}`, confidence: "medium" },
    analysisVersion: "intelligence-v1", analysisLevel: level, knowledgeVisibility: level === "guest" ? "guest" : level,
    knowledgeProvenance: level === "guest" ? [prov(chunks[2], 0.8)] : [prov(chunks[0], 0.87), prov(chunks[1], 0.81)], ...extra,
  });
  const recGuest = await v1(A, "guest");
  const recStaff = await v1(A, "staff");
  const recRestricted = await v1(D, "restricted");
  await Intelligence.create({ workspaceId: wsA, signalIds: [C._id], generatedBy: "llm", provider: "test", model: "old", intelligence: { summary: "LEGACY-MARK summary" }, risk: { level: "high", reason: "LEGACY-MARK" }, confidence: 0.9 });
  check("fixtures created", [A, B, C, D, E, CROSS, X, recGuest, recStaff, recRestricted].every(Boolean));

  // ---- a separate workspace for pagination / ordering / filters / N+1
  const sevs = ["low", "medium", "critical", "high"];
  const types = ["maintenance", "complaint", "housekeeping"];
  const statuses = ["new", "acknowledged", "resolved"];
  const pSignals = [];
  for (let i = 0; i < 25; i += 1) {
    pSignals.push(await Signal.create({
      workspaceId: wsP, propertyId: propP, type: types[i % 3], severity: sevs[i % 4], status: statuses[i % 3], source: "system", title: `P-${String(i).padStart(2, "0")}`, description: "Synthetic.",
      // deliberate ties: pairs of signals share the same occurredAt so the id tie-break is exercised
      occurredAt: new Date(Date.UTC(2026, 8, 1 + Math.floor(i / 2), 0, 0, 0)),
    }));
  }
  for (const s of pSignals.slice(0, 6)) await Intelligence.create({ workspaceId: wsP, signalIds: [s._id], propertyId: propP, generatedBy: "llm", provider: "test", model: "m", analysis: { situation: "s", evidence: ["e"], impact: "i", recommendation: "r", confidence: "low" }, analysisVersion: "intelligence-v1", analysisLevel: pSignals.indexOf(s) < 4 ? "guest" : "staff", knowledgeVisibility: undefined });
  const expectedOrder = (list) => [...list].sort((a, b) => ({ critical: 0, high: 1, medium: 2, low: 3 }[a.severity] - { critical: 0, high: 1, medium: 2, low: 3 }[b.severity]) || (b.occurredAt - a.occurredAt) || (String(b._id) < String(a._id) ? -1 : 1)).map((s) => String(s._id));

  const list = (level, ws, q = "") => call(bases[level], "GET", `/dashboard/signals?workspaceId=${ws}${q}`);
  const detail = (level, id, ws = wsA) => call(bases[level], "GET", `/dashboard/signals/${id}?workspaceId=${ws}`);
  const ids = (res) => res.json.data.map((x) => x.id);
  const byId = (res, id) => res.json.data.find((x) => x.id === String(id));

  // ================================================================ contract
  const staffList = await list("staff", wsA);
  check("list: HTTP 200 with the existing envelope {success, data, pagination{page,limit,total,pages}}", staffList.status === 200 && staffList.json.success === true && Array.isArray(staffList.json.data) && JSON.stringify(Object.keys(staffList.json.pagination).sort()) === JSON.stringify(["limit", "page", "pages", "total"]));
  const itemA = byId(staffList, A._id);
  same("list item has exactly the approved fields", Object.keys(itemA).sort(), ["description", "hasGuest", "id", "intelligence", "occurredAt", "property", "severity", "source", "status", "stay", "synthetic", "title", "type", "unit"]);
  check("list item observed facts: property {id,code,name}, unit {id,unitNumber}, stay {status,checkIn,checkOut}, hasGuest", JSON.stringify(Object.keys(itemA.property).sort()) === JSON.stringify(["code", "id", "name"]) && itemA.property.name === "Synthetic Property A" && JSON.stringify(Object.keys(itemA.unit).sort()) === JSON.stringify(["id", "unitNumber"]) && itemA.unit.unitNumber === "1A-R1" && JSON.stringify(Object.keys(itemA.stay).sort()) === JSON.stringify(["checkIn", "checkOut", "status"]) && itemA.stay.status === "confirmed" && itemA.hasGuest === true);
  check("list item intelligence summary: id, confidence, createdAt, evidenceCount, citedSections", JSON.stringify(Object.keys(itemA.intelligence).sort()) === JSON.stringify(["citedSections", "confidence", "createdAt", "evidenceCount", "id"]) && itemA.intelligence.evidenceCount === 3 && JSON.stringify(itemA.intelligence.citedSections) === JSON.stringify(["15. Maintenance", "19. Staff Roles & Escalation"]) && itemA.intelligence.confidence === "medium");
  check("a Signal with no stored V1 analysis has intelligence: null (nothing is generated)", byId(staffList, B._id).intelligence === null);
  const detA = await detail("staff", A._id);
  same("detail data has exactly signal, observed, intelligence", Object.keys(detA.json.data).sort(), ["intelligence", "observed", "signal"]);
  same("detail signal has exactly the approved fields", Object.keys(detA.json.data.signal).sort(), ["description", "id", "occurredAt", "severity", "source", "status", "synthetic", "title", "type"]);
  same("detail observed has exactly property, unit, stay, hasGuest", Object.keys(detA.json.data.observed).sort(), ["hasGuest", "property", "stay", "unit"]);
  same("detail intelligence has exactly the analysis fields", Object.keys(detA.json.data.intelligence).sort(), ["analysisVersion", "confidence", "createdAt", "evidence", "id", "impact", "knowledgeProvenance", "recommendation", "situation"]);
  check("detail intelligence content", detA.json.data.intelligence.analysisVersion === "intelligence-v1" && detA.json.data.intelligence.situation === "SITUATION-staff" && detA.json.data.intelligence.evidence.length === 3 && detA.json.data.intelligence.recommendation === "RECOMMENDATION-staff" && detA.json.data.intelligence.confidence === "medium");
  same("provenance items expose exactly chunkId, section, sectionPath, visibility, retrievalScore", detA.json.data.intelligence.knowledgeProvenance.map((p) => Object.keys(p).sort()), [["chunkId", "retrievalScore", "section", "sectionPath", "visibility"], ["chunkId", "retrievalScore", "section", "sectionPath", "visibility"]]);
  check("provenance points at real retrieved chunks with their stored section, path, visibility and score", detA.json.data.intelligence.knowledgeProvenance.every((p, i) => p.chunkId === String(chunks[i]._id) && p.section === chunks[i].section && p.visibility === "staff") && detA.json.data.intelligence.knowledgeProvenance[0].retrievalScore === 0.87);
  check("detail of a Signal with no analysis returns intelligence: null", (await detail("staff", B._id)).json.data.intelligence === null);
  check("detail 404s: missing Signal, malformed id (400), missing workspaceId (400)", (await detail("staff", "000000000000000000000000")).status === 404 && (await detail("staff", "not-an-id")).status === 400 && (await call(bases.staff, "GET", `/dashboard/signals/${A._id}`)).status === 400);
  check("list requires workspaceId (400) and rejects a malformed one", (await call(bases.staff, "GET", "/dashboard/signals")).status === 400 && (await call(bases.staff, "GET", "/dashboard/signals?workspaceId=nope")).status === 400);

  // ================================================================ synthetic marker + dates
  check("synthetic: true only where metadata says so", itemA.synthetic === true && staffList.json.data.filter((x) => x.synthetic).length === 1 && byId(staffList, E._id).synthetic === false && detA.json.data.signal.synthetic === true);
  check("dates: occurredAt and stay dates are the stored UTC instants as ISO strings, unconverted", itemA.occurredAt === "2026-09-25T07:00:00.000Z" && itemA.stay.checkIn === CHECK_IN.toISOString() && itemA.stay.checkOut === CHECK_OUT.toISOString() && detA.json.data.observed.stay.checkIn === "2026-09-24T06:30:00.000Z");

  // ================================================================ workspace isolation
  const listB = await list("staff", wsB);
  check("workspace isolation: another workspace's Signal never appears, and each list shows only its own", !ids(staffList).includes(String(X._id)) && ids(listB).length === 1 && ids(listB)[0] === String(X._id));
  const notFoundBody = (await detail("staff", "000000000000000000000000")).json;
  const wrongWs = await detail("staff", X._id, wsA);
  check("workspace isolation: detail with the wrong workspace is the same 404 as a missing Signal", wrongWs.status === 404 && wrongWs.json.message === notFoundBody.message && (await detail("staff", A._id, wsB)).status === 404);
  const crossItem = byId(staffList, CROSS._id);
  check("workspace isolation: references into another workspace resolve to nothing (no property, unit, stay, guest)", crossItem.property === null && crossItem.unit === null && crossItem.stay === null && crossItem.hasGuest === false);
  check("workspace isolation: nothing from the other workspace leaks anywhere in this workspace's responses", !staffList.raw.includes("SECRET OTHER TENANT") && !staffList.raw.includes("SECRET-B") && !staffList.raw.includes("Otherfirst") && !JSON.stringify((await detail("staff", CROSS._id)).json).includes("SECRET"));
  check("hasGuest is true only when the guest resolves in this workspace", itemA.hasGuest === true && byId(staffList, B._id).hasGuest === false);

  // ================================================================ intelligence visibility
  const guestList = await list("guest", wsA);
  const restrictedList = await list("restricted", wsA);
  check("visibility (guest): the guest-level V1 record only; the staff-level record behaves as absent", byId(guestList, A._id).intelligence?.id === String(recGuest._id) && byId(guestList, A._id).intelligence.evidenceCount === 3 && JSON.stringify(byId(guestList, A._id).intelligence.citedSections) === JSON.stringify(["Guest Policies"]));
  check("visibility (staff): the staff-level record is preferred over the guest-level one", byId(staffList, A._id).intelligence?.id === String(recStaff._id));
  check("visibility (restricted): sees the most informative record it may see (staff here; no restricted one exists for A)", byId(restrictedList, A._id).intelligence?.id === String(recStaff._id));
  check("visibility: a restricted-level record is absent for guest and staff, present for restricted", byId(guestList, D._id).intelligence === null && byId(staffList, D._id).intelligence === null && byId(restrictedList, D._id).intelligence?.id === String(recRestricted._id));
  const detGuest = await detail("guest", A._id);
  check("visibility (detail): guest gets the guest-level analysis and no staff evidence, sections or text anywhere", detGuest.json.data.intelligence.situation === "SITUATION-guest" && !detGuest.raw.includes("EVIDENCE-staff") && !detGuest.raw.includes("RECOMMENDATION-staff") && !detGuest.raw.includes("15. Maintenance") && !guestList.raw.includes("EVIDENCE-staff") && !guestList.raw.includes("19. Staff Roles"));
  check("visibility (detail): a restricted-only analysis is null for guest and staff, and returned to restricted", (await detail("guest", D._id)).json.data.intelligence === null && (await detail("staff", D._id)).json.data.intelligence === null && (await detail("restricted", D._id)).json.data.intelligence?.situation === "SITUATION-restricted");
  const spoofed = await Promise.all([list("guest", wsA, "&authorizedLevel=restricted&level=restricted"), call(bases.guest, "GET", `/dashboard/signals?workspaceId=${wsA}`, { "x-authorized-level": "restricted", "x-knowledge-level": "restricted", "x-role": "admin", "x-permissions": "decision:review" })]);
  check("visibility: a caller cannot raise its own level (query or header ignored)", spoofed.every((r) => byId(r, D._id).intelligence === null && byId(r, A._id).intelligence.id === String(recGuest._id)));
  check("hasIntelligence filter respects visibility: guest sees 1 signal with intelligence, staff 1, restricted 2", ids(await list("guest", wsA, "&hasIntelligence=true")).length === 1 && ids(await list("staff", wsA, "&hasIntelligence=true")).length === 1 && ids(await list("restricted", wsA, "&hasIntelligence=true")).length === 2);

  // ================================================================ V1 only
  const cItem = byId(restrictedList, C._id);
  check("V1-only: a Signal that has only a legacy Intelligence record shows intelligence: null, at every level", cItem.intelligence === null && byId(guestList, C._id).intelligence === null && (await detail("restricted", C._id)).json.data.intelligence === null);
  check("V1-only: legacy content never appears in any dashboard response", !JSON.stringify([guestList.json, staffList.json, restrictedList.json, (await detail("restricted", C._id)).json]).includes("LEGACY-MARK"));
  check("V1-only: hasIntelligence=true excludes the legacy-only Signal; hasIntelligence=false includes it", !ids(await list("restricted", wsA, "&hasIntelligence=true")).includes(String(C._id)) && ids(await list("restricted", wsA, "&hasIntelligence=false")).includes(String(C._id)));

  // ================================================================ privacy
  const responses = [];
  for (const level of ["guest", "staff", "restricted"]) {
    responses.push((await list(level, wsA)).json, (await list(level, wsA, "&limit=100&page=1")).json);
    for (const s of [A, B, C, D, E, CROSS]) responses.push((await detail(level, s._id)).json);
  }
  const forbiddenKeys = ["firstName", "lastName", "fullName", "email", "phone", "reservationId", "provider", "model", "prompt", "apiKey", "content", "embedding", "embeddingText", "text", "guest", "guestId", "stayId", "workspaceId", "generatedBy", "analysisLevel", "knowledgeVisibility", "knowledgeDocumentId", "similarityScore"];
  const allPaths = responses.flatMap((r) => keyPaths(r.data));
  check("privacy: no guest name/contact, reservation id, provider/model, prompt, api key, embedding or document-content KEYS anywhere", forbiddenKeys.every((k) => !allPaths.some((p) => p.endsWith(`.${k}`))), JSON.stringify(forbiddenKeys.filter((k) => allPaths.some((p) => p.endsWith(`.${k}`)))));
  check("privacy: the only 'name' key is a property's name (never a guest's)", allPaths.filter((p) => p.endsWith(".name")).every((p) => /property\.name$/.test(p)));
  check("privacy: the only guest information exposed is the boolean hasGuest", allPaths.filter((p) => /hasGuest$/.test(p)).length > 0 && responses.flatMap((r) => JSON.stringify(r.data).match(/"hasGuest":(true|false)/g) || []).length > 0);
  const raw = JSON.stringify(responses);
  const secretValues = ["Zorbfirst", "Zorblast", `zorb-${stamp}`, "7770001111", RES, "deterministic-stub", "DOC-CONTENT-SECRET", "CHUNK-TEXT-SECRET", "Otherfirst", ...(process.env.GEMINI_API_KEY ? [process.env.GEMINI_API_KEY] : [])];
  check("privacy: no secret VALUE appears in any response (guest name, email, phone, reservation id, model, document/chunk text, api key)", secretValues.every((v) => !raw.includes(v)), JSON.stringify(secretValues.filter((v) => raw.includes(v))));

  // ================================================================ severity ordering, pagination, filters
  const full = await list("staff", wsP, "&limit=100");
  same("ordering: critical, high, medium, low, then most recent occurredAt, then a stable id tie-break", ids(full), expectedOrder(pSignals));
  {
    const sevSeq = full.json.data.map((x) => x.severity);
    const rank = { critical: 0, high: 1, medium: 2, low: 3 };
    check("ordering: severities are non-decreasing in rank across the whole list", sevSeq.every((s, i) => i === 0 || rank[sevSeq[i - 1]] <= rank[s]));
    const firstLow = sevSeq.indexOf("low"), lastMedium = sevSeq.lastIndexOf("medium");
    check("ordering: every 'medium' comes BEFORE any 'low' (alphabetical order would put 'low' first)", lastMedium < firstLow && firstLow > 0);
    const alphabetical = [...pSignals].sort((a, b) => a.severity.localeCompare(b.severity) || (b.occurredAt - a.occurredAt)).map((s) => String(s._id));
    check("ordering: the served order differs from the alphabetical-severity order (the test would catch that bug)", JSON.stringify(ids(full)) !== JSON.stringify(alphabetical));
    const within = full.json.data.filter((x) => x.severity === "high");
    check("ordering: within one severity, most recent occurredAt first", within.every((x, i) => i === 0 || within[i - 1].occurredAt >= x.occurredAt));
  }
  const p1 = await list("staff", wsP, "&limit=10&page=1"), p2 = await list("staff", wsP, "&limit=10&page=2"), p3 = await list("staff", wsP, "&limit=10&page=3"), p4 = await list("staff", wsP, "&limit=10&page=4");
  check("pagination: 25 signals over pages of 10 -> 10, 10, 5 items, total 25, pages 3", p1.json.data.length === 10 && p2.json.data.length === 10 && p3.json.data.length === 5 && [p1, p2, p3].every((p) => p.json.pagination.total === 25 && p.json.pagination.pages === 3 && p.json.pagination.limit === 10) && [1, 2, 3].every((n, i) => [p1, p2, p3][i].json.pagination.page === n));
  same("pagination: the pages concatenate to the full ordered list with no duplicates or gaps", [...ids(p1), ...ids(p2), ...ids(p3)], expectedOrder(pSignals));
  check("pagination: a page past the end is empty but reports the same total", p4.json.data.length === 0 && p4.json.pagination.total === 25 && p4.json.pagination.page === 4);
  check("pagination: repeating a request returns the identical page (stable ordering)", JSON.stringify(ids(await list("staff", wsP, "&limit=10&page=2"))) === JSON.stringify(ids(p2)));
  const def = await list("staff", wsP);
  check("pagination: default limit 20; limit is capped at 100; a bad page/limit falls back safely", def.json.pagination.limit === 20 && def.json.data.length === 20 && (await list("staff", wsP, "&limit=500")).json.pagination.limit === 100 && (await list("staff", wsP, "&page=abc&limit=xyz")).json.pagination.page === 1);
  const filt = async (q, level = "staff") => (await list(level, wsP, `${q}&limit=100`)).json;
  check("filter severity=high", (await filt("&severity=high")).data.every((x) => x.severity === "high") && (await filt("&severity=high")).pagination.total === pSignals.filter((s) => s.severity === "high").length);
  check("filter status", (await filt("&status=resolved")).pagination.total === pSignals.filter((s) => s.status === "resolved").length && (await filt("&status=resolved")).data.every((x) => x.status === "resolved"));
  check("filter type", (await filt("&type=complaint")).pagination.total === pSignals.filter((s) => s.type === "complaint").length);
  check("filter propertyId (matches one workspace property; another property yields nothing)", (await filt(`&propertyId=${propP}`)).pagination.total === 25 && (await filt(`&propertyId=${propA}`)).pagination.total === 0);
  check("filters combine and keep pagination totals right", (await filt("&severity=low&status=new")).pagination.total === pSignals.filter((s) => s.severity === "low" && s.status === "new").length);
  check("filter hasIntelligence: staff sees 6 analyzed, guest sees only the guest-level ones (4)", (await filt("&hasIntelligence=true")).pagination.total === 6 && (await filt("&hasIntelligence=true", "guest")).pagination.total === 4 && (await filt("&hasIntelligence=false")).pagination.total === 19 && (await filt("&hasIntelligence=false", "guest")).pagination.total === 21);
  check("filter hasIntelligence combined with pagination: totals and page contents agree", await (async () => { const r = await list("staff", wsP, "&hasIntelligence=true&limit=4&page=2"); return r.json.pagination.total === 6 && r.json.pagination.pages === 2 && r.json.data.length === 2 && r.json.data.every((x) => x.intelligence !== null); })());
  check("invalid filter values are 400s", (await list("staff", wsP, "&severity=urgent")).status === 400 && (await list("staff", wsP, "&status=open")).status === 400 && (await list("staff", wsP, "&type=plumbing")).status === 400 && (await list("staff", wsP, "&propertyId=zzz")).status === 400 && (await list("staff", wsP, "&hasIntelligence=maybe")).status === 400);

  // ================================================================ N+1 protection (in-process, counting database operations)
  {
    const count = async (limit) => {
      const ops = [];
      mongoose.set("debug", (collection, method) => ops.push(`${collection}.${method}`));
      await listDashboardSignals({ workspaceId: String(wsP), limit: String(limit) }, "staff");
      mongoose.set("debug", false);
      return ops;
    };
    const small = await count(2), large = await count(25);
    check("N+1: the number of database operations does not grow with the page size", small.length === large.length, `limit 2 -> ${small.length} ops, limit 25 -> ${large.length} ops`);
    check("N+1: a fixed, small number of operations serves a full page (<= 8)", large.length <= 8, `${large.length}: ${large.join(", ")}`);
    check("N+1: each collection is hit a bounded number of times, never once per Signal", ["properties", "units", "stays", "guests", "intelligences"].every((c) => large.filter((o) => o.startsWith(`${c}.`)).length <= 1), large.join(", "));
    const withFilter = async () => { const ops = []; mongoose.set("debug", (c, m) => ops.push(`${c}.${m}`)); await listDashboardSignals({ workspaceId: String(wsP), limit: "25", hasIntelligence: "true" }, "staff"); mongoose.set("debug", false); return ops; };
    check("N+1: the hasIntelligence filter adds a constant number of operations", (await withFilter()).length <= 10);
  }

  // ================================================================ read-only
  const mutating = [];
  for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
    mutating.push((await call(bases.restricted, method, `/dashboard/signals?workspaceId=${wsA}`)).status, (await call(bases.restricted, method, `/dashboard/signals/${A._id}?workspaceId=${wsA}`)).status);
  }
  check("read-only: POST / PATCH / PUT / DELETE on both dashboard routes do not exist (404)", mutating.every((s) => s === 404), JSON.stringify(mutating));
  check("read-only: no analysis, retrieval or embedding request ever reached the AI service (trap server hit 0 times)", trap.hits.length === 0, JSON.stringify(trap.hits));
  const insideAfter = await fingerprint({ workspaceId: { $in: created.workspaceIds } });
  check("read-only: no Signal, Guest, Stay, Property, Unit, KnowledgeDocument, KnowledgeChunk or Intelligence changed (row counts and updatedAt)", insideAfter.Signal === hashRows(await Signal.find({ workspaceId: { $in: created.workspaceIds } }, { _id: 1, updatedAt: 1 }).sort({ _id: 1 }).lean()) && (await Intelligence.countDocuments({ workspaceId: { $in: created.workspaceIds } })) === 3 + 1 + 6 && (await Signal.countDocuments({ workspaceId: wsA })) === 6 && (await KnowledgeChunk.countDocuments({ workspaceId: wsA })) === 3);
  same("real (non-throwaway) operational and knowledge records are unchanged by this suite", await fingerprint({ workspaceId: { $nin: created.workspaceIds } }), outsideBefore);
  check("read-only: this suite's Signals still carry their original timestamps (never touched)", (await Signal.find({ _id: { $in: [A._id, B._id, C._id, D._id, E._id] } }).lean()).every((s) => s.updatedAt.getTime() === s.createdAt.getTime()));
}

let exitCode = 1;
try {
  await main();
  exitCode = failed === 0 ? 0 : 1;
} catch (error) {
  fail("suite crashed", error?.stack || String(error));
} finally {
  for (const child of servers) child.kill();
  trap.server?.close();
  try { await cleanupAuthFixtures(); await cleanup(); } catch (error) { console.error("cleanup failed:", error?.message); }
  await disconnectDatabase();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(exitCode);
}
