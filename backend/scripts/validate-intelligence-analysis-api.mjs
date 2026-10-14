/**
 * Intelligence V1 - database + HTTP validation of POST /api/intelligence/analyze/:signalId.
 *
 * Requires an AI service reachable at PYTHON_BASE started with test providers
 * (LLM_PROVIDER=test EMBEDDING_PROVIDER=test): deterministic, no external call.
 * Throwaway backend servers run at each authorized level (guest / staff /
 * restricted) plus two misconfigured ones. A small in-process proxy sits in
 * front of the AI service so the suite can (a) count analysis calls and (b)
 * inject malformed / hostile LLM output; everything else is forwarded to the
 * real service. All data is SYNTHETIC and lives in stamped throwaway
 * workspaces, removed by workspaceId afterward. Real workspaces' operational
 * and knowledge records are fingerprinted before and after.
 */
import { registerServerLevel } from "./lib/authFetch.mjs";
import crypto from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import {
  Workspace, Property, Unit, Guest, Stay, Signal, KnowledgeDocument, KnowledgeChunk, Intelligence, ImportBatch,
} from "../src/models/index.js";
import { buildAnalysisContext } from "../src/services/analysisContextService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, "..", "server.js");
const PYTHON_BASE = process.env.PYTHON_BASE || "http://localhost:8000";
const FAKE_PORT = 5990;
const FAKE_URL = `http://localhost:${FAKE_PORT}`;
const PORTS = { guest: 5111, staff: 5112, restricted: 5113, nonrouted: 5114, down: 5115 };

let passed = 0;
let failed = 0;
const ok = (n) => { passed += 1; console.log(`PASS  ${n}`); };
const fail = (n, d = "") => { failed += 1; console.error(`FAIL  ${n}${d ? ` — ${d}` : ""}`); };
const check = (n, c, d = "") => (c ? ok(n) : fail(n, d));
const same = (n, a, e) => check(n, JSON.stringify(a) === JSON.stringify(e), `actual=${JSON.stringify(a)} expected=${JSON.stringify(e)}`);
const sorted = (l) => [...l].sort();

const created = { workspaceIds: [] };
const servers = [];
const fake = { mode: null, analyzeCalls: 0, requests: [], server: null };

// ---------------------------------------------------------------- fake AI proxy
function startFakeAi() {
  fake.server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    if (req.url === "/v1/intelligence/analyze") {
      fake.analyzeCalls += 1;
      const parsed = JSON.parse(body.toString() || "{}");
      fake.requests.push(parsed);
      if (fake.mode) {
        const out = typeof fake.mode.body === "function" ? fake.mode.body(parsed) : fake.mode.body;
        res.writeHead(fake.mode.status || 200, { "content-type": "application/json" });
        return res.end(typeof out === "string" ? out : JSON.stringify(out));
      }
    }
    const upstream = await fetch(`${PYTHON_BASE}${req.url}`, { method: req.method, headers: { "content-type": "application/json" }, body: body.length ? body : undefined });
    res.writeHead(upstream.status, { "content-type": "application/json" });
    res.end(await upstream.text());
  });
  return new Promise((resolve) => fake.server.listen(FAKE_PORT, resolve));
}

async function startServer(name, port, { level, provider = "test-python", ai = FAKE_URL } = {}) {
  const env = { ...process.env, PORT: String(port), LLM_PROVIDER: provider, AI_SERVICE_URL: ai };
  delete env.KNOWLEDGE_DEV_AUTHORIZED_LEVEL;
  if (level !== undefined) env.KNOWLEDGE_DEV_AUTHORIZED_LEVEL = level;
  servers.push(spawn(process.execPath, [SERVER_ENTRY], { env, stdio: "ignore" }));
  const base = `http://localhost:${port}/api`;
  const start = Date.now();
  for (;;) {
    try { if ((await fetch(`${base}/health`)).ok) { registerServerLevel(base, level); return base; } } catch { /* not ready */ }
    if (Date.now() - start > 30000) throw new Error(`server ${name} not healthy`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function http_(base, method, url, body, headers = {}) {
  const res = await fetch(`${base}${url}`, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, json };
}

const vec = (seed) => Array.from({ length: 32 }, (_, i) => Math.sin(seed * 31 + i) + 0.001);
const hashRows = (rows) => `${rows.length}:${crypto.createHash("sha256").update(rows.map((r) => `${r._id}:${r.updatedAt?.getTime?.() ?? ""}`).join("|")).digest("hex").slice(0, 12)}`;

async function fingerprintOutside(ids) {
  const out = {};
  for (const [name, Model] of [["Guest", Guest], ["Stay", Stay], ["ImportBatch", ImportBatch], ["Signal", Signal], ["KnowledgeDocument", KnowledgeDocument], ["KnowledgeChunk", KnowledgeChunk], ["Intelligence", Intelligence]]) {
    out[name] = hashRows(await Model.find({ workspaceId: { $nin: ids } }, { _id: 1, updatedAt: 1 }).sort({ _id: 1 }).lean());
  }
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

async function main() {
  const health = await fetch(`${PYTHON_BASE}/v1/health`).then((r) => r.json()).catch(() => null);
  if (health?.status !== "healthy") { fail("AI service reachable", `${PYTHON_BASE}: start it with LLM_PROVIDER=test EMBEDDING_PROVIDER=test`); return; }
  ok("AI service reachable");

  await connectDatabase();
  await Intelligence.init(); // make sure the partial unique index exists before any race
  const stamp = Date.now();
  await startFakeAi();

  const bases = {
    restricted: await startServer("restricted", PORTS.restricted, { level: "restricted" }),
    staff: await startServer("staff", PORTS.staff, { level: "staff" }),
    guest: await startServer("guest", PORTS.guest, { level: "guest" }),
    nonrouted: await startServer("nonrouted", PORTS.nonrouted, { level: "restricted", provider: "test" }),
    down: await startServer("down", PORTS.down, { level: "staff", ai: "http://localhost:5999" }),
  };
  const admin = bases.restricted;

  const wsA = (await Workspace.create({ name: `7I A ${stamp}`, slug: `7i-a-${stamp}` }))._id;
  const wsB = (await Workspace.create({ name: `7I B ${stamp}`, slug: `7i-b-${stamp}` }))._id;
  created.workspaceIds.push(wsA, wsB);
  const outsideBefore = await fingerprintOutside(created.workspaceIds);

  const propA = (await Property.create({ workspaceId: wsA, name: "Synthetic Property A", code: `SA${stamp}` }))._id;
  const propA2 = (await Property.create({ workspaceId: wsA, name: "Synthetic Property A2", code: `SB${stamp}` }))._id;
  const propB = (await Property.create({ workspaceId: wsB, name: "Synthetic Property B", code: `SC${stamp}` }))._id;
  const post = async (url, body) => { const r = await http_(admin, "POST", url, body); if (r.status !== 201) fail(`fixture ${url}`, JSON.stringify(r.json)); return r.json?.data?._id; };
  const unit = await post("/units", { workspaceId: String(wsA), propertyId: String(propA), unitNumber: "204", type: "apartment" });
  const guest = await post("/guests", { workspaceId: String(wsA), firstName: "Synth", lastName: "Guest", email: `synth-${stamp}@example.invalid`, phone: "10001 20002" });
  const guestB = await post("/guests", { workspaceId: String(wsB), firstName: "Other", lastName: "Tenant" });
  const stay = await post("/stays", { workspaceId: String(wsA), guestId: guest, propertyId: String(propA), unitId: unit, reservationId: `SYN-${stamp}`, status: "checked_in", checkIn: new Date().toISOString() });
  const sig = (ws, body) => post("/signals", { workspaceId: String(ws), type: "maintenance", severity: "high", ...body });
  const S1 = await sig(wsA, { title: "Synthetic AC not cooling", description: "Synthetic warm air report.", propertyId: String(propA), unitId: unit, guestId: guest, stayId: stay, source: "guest" });
  const S2 = await sig(wsA, { title: "Synthetic noise report", description: "Synthetic.", propertyId: String(propA) });
  const S3 = await sig(wsA, { title: "Synthetic workspace-level report", description: "Synthetic." });
  const S4 = await sig(wsA, { title: "Synthetic report at the other property", description: "Synthetic.", propertyId: String(propA2) });
  const S5 = await sig(wsA, { title: "Synthetic spoof-attempt report", description: "Synthetic.", propertyId: String(propA) });
  const S6 = await sig(wsA, { title: "Synthetic malformed-output report", description: "Synthetic.", propertyId: String(propA) });
  const S7 = await sig(wsA, { title: "Synthetic service-down report", description: "Synthetic.", propertyId: String(propA) });
  const SB = await sig(wsB, { title: "Synthetic other-tenant report", description: "Synthetic.", propertyId: String(propB) });
  const S8 = (await Signal.create({ workspaceId: wsA, type: "maintenance", title: "Synthetic cross-workspace reference", propertyId: propA, guestId: guestB }))._id; // reference deliberately unresolvable inside wsA
  check("fixtures created", [unit, guest, guestB, stay, S1, S2, S3, S4, S5, S6, S7, SB].every(Boolean) && !!S8);

  const mkDoc = async (ws, prop, title) => post("/knowledge-documents", { workspaceId: String(ws), propertyId: String(prop), title, documentType: "sop", isTestData: true, content: `# One\n\nSynthetic ${title}`, defaultVisibility: "guest" });
  const docA = await mkDoc(wsA, propA, "Doc A"); const docA2 = await mkDoc(wsA, propA2, "Doc A2"); const docB = await mkDoc(wsB, propB, "Doc B");
  const ch = (ws, prop, doc, i, text, visibility, sectionPath, seed) => ({ documentId: doc, version: 1, workspaceId: ws, propertyId: prop, status: "active", chunkIndex: i, section: sectionPath.at(-1), sectionPath, text, visibility, embedding: vec(seed), embeddingModel: "deterministic-embedding-v1" });
  const inserted = await KnowledgeChunk.insertMany([
    ch(wsA, propA, docA, 0, "SYNTH-GUEST-GUIDANCE", "guest", ["Guest Policies", "Timings"], 1),
    ch(wsA, propA, docA, 1, "SYNTH-STAFF-GUIDANCE", "staff", ["Staff Procedures", "Maintenance"], 2),
    ch(wsA, propA, docA, 2, "SYNTH-RESTRICTED-GUIDANCE", "restricted", ["Internal", "Escalation"], 3),
    ch(wsA, propA2, docA2, 0, "SYNTH-OTHER-PROPERTY", "guest", ["Other Property Rules"], 4),
    ch(wsB, propB, docB, 0, "SYNTH-OTHER-TENANT", "guest", ["Other Tenant Rules"], 5),
  ]);
  const cid = { G: String(inserted[0]._id), S: String(inserted[1]._id), R: String(inserted[2]._id), OP: String(inserted[3]._id), OT: String(inserted[4]._id) };
  const knowledgeBefore = hashRows(await KnowledgeChunk.find({ workspaceId: { $in: created.workspaceIds } }, { _id: 1, updatedAt: 1 }).sort({ _id: 1 }).lean());
  const opsBefore = {};
  for (const [name, Model] of [["Signal", Signal], ["Guest", Guest], ["Stay", Stay], ["Property", Property], ["Unit", Unit]]) opsBefore[name] = hashRows(await Model.find(name === "Unit" ? { propertyId: { $in: [propA, propA2, propB] } } : { workspaceId: { $in: created.workspaceIds } }, { _id: 1, updatedAt: 1 }).sort({ _id: 1 }).lean());

  // PHASE 13: POST /intelligence/analyze needs intelligence:generate, and no role with a GUEST ceiling holds it
  // (viewer may not generate). The knowledge level of an analysis is the ACTOR's ceiling, so a guest-level
  // analysis can no longer be produced over HTTP by anyone. The suite's guest-level analyses therefore run
  // through the SAME service the route calls (analyzeSignal) with a guest ceiling; staff/restricted go over HTTP
  // as an operator / admin (real tokens). Caller-supplied-level spoofing is exercised over HTTP as an operator.
  process.env.LLM_PROVIDER = "test-python";
  process.env.AI_SERVICE_URL = FAKE_URL;
  const { analyzeSignal } = await import("../src/services/intelligenceAnalysisService.js");
  const analyzeInProcess = async (level, signalId, ws) => {
    try {
      const { record, created } = await analyzeSignal(String(signalId), String(ws), { authorizedLevel: level });
      return { status: created ? 201 : 200, json: { success: true, data: JSON.parse(JSON.stringify(record)) } }; // JSON round trip: ids as strings, as over HTTP
    } catch (error) {
      return { status: error.statusCode ?? 500, json: { success: false, message: error.message, details: error.details } };
    }
  };
  const analyze = (level, signalId, { ws = wsA, query = "", headers = {}, body } = {}) => {
    const plain = !query && !Object.keys(headers).length && body === undefined;
    if (level === "guest" && plain) return analyzeInProcess("guest", signalId, ws);
    return http_(bases[level === "guest" ? "staff" : level], "POST", `/intelligence/analyze/${signalId}?workspaceId=${ws}${query}`, body, headers);
  };
  const count = (signalId, level) => Intelligence.countDocuments({ signalIds: signalId, analysisVersion: "intelligence-v1", ...(level ? { analysisLevel: level } : {}) });
  const provIds = (rec) => sorted((rec.knowledgeProvenance || []).map((p) => p.chunkId));

  // ================================================================ A. context builder
  {
    const ctx = await buildAnalysisContext(S1, wsA);
    const dbGuest = await Guest.findById(guest).lean();
    check("A context: a valid Signal yields signal, guest, stay, property and unit facts", ctx.signal.id === S1 && ctx.guest.available && ctx.stay.available && ctx.property.available && ctx.unit.available && ctx.property.name === "Synthetic Property A" && ctx.unit.unitNumber === "204");
    check("A context (privacy): the guest's name is stored but never enters the analysis context; the guest keeps only id, availability and recent stays", !!dbGuest.firstName && !!dbGuest.lastName && JSON.stringify(Object.keys(ctx.guest).sort()) === JSON.stringify(["available", "id", "recentStays"]) && !/\bSynth\b/.test(JSON.stringify(ctx)));
    check("A context: the recorded stay status is preserved exactly as stored, with its dates and reservation id", ctx.stay.status === "checked_in" && !!ctx.stay.checkIn && ctx.stay.reservationId === `SYN-${stamp}` && ctx.guest.recentStays[0].status === "checked_in");
    check("A context: the guest's email and phone are stored but never enter the analysis context", !!dbGuest.email && !!dbGuest.phone && !("email" in ctx.guest) && !("phone" in ctx.guest) && !JSON.stringify(ctx).includes("example.invalid") && !JSON.stringify(ctx).includes("20002"));
    const c2 = await buildAnalysisContext(S2, wsA);
    check("A context: a Signal with no guest/stay/unit leaves them absent (null), nothing inferred", c2.guest === null && c2.stay === null && c2.unit === null && c2.property.available);
    const c3 = await buildAnalysisContext(S3, wsA);
    check("A context: a Signal with no property has no property in its context", c3.property === null && c3.guest === null);
    const c8 = await buildAnalysisContext(S8, wsA);
    check("A context: a guest reference that does not resolve inside the workspace is unavailable, never matched or fabricated", c8.guest.available === false && !c8.guest.firstName);
    let threw = null;
    try { await buildAnalysisContext(S1, wsB); } catch (e) { threw = e.statusCode; }
    check("A context: another workspace cannot build this Signal's context (404)", threw === 404);
    check("A context: history is limited to the Signal's own workspace and relations", (await buildAnalysisContext(S1, wsA)).history.signals.every((h) => h.id !== SB));
  }

  // ================================================================ F1/H. create + idempotency
  fake.requests.length = 0;
  const g1 = await analyze("guest", S1);
  const rec = g1.json?.data;
  check("H api: successful analysis returns 201 with the persisted Intelligence", g1.status === 201 && !!rec?._id, JSON.stringify(g1.json));
  check("F persistence: the record references the originating Signal, workspace, property, guest and stay", rec.signalIds.includes(S1) && String(rec.workspaceId) === String(wsA) && String(rec.propertyId) === String(propA) && String(rec.guestId) === String(guest) && String(rec.stayId) === String(stay));
  check("V1 analysis is stored: situation, evidence[], impact, recommendation, confidence", rec.analysis && rec.analysis.situation && Array.isArray(rec.analysis.evidence) && rec.analysis.evidence.length > 0 && rec.analysis.impact && rec.analysis.recommendation && ["high", "medium", "low"].includes(rec.analysis.confidence));
  check("D confidence: the stored confidence is the enum, and no numeric confidence was invented", rec.analysis.confidence === "medium" && rec.confidence === undefined);
  check("legacy fields are mapped deterministically from the analysis and the Signal (no invented values)", rec.intelligence.summary === rec.analysis.situation && JSON.stringify(rec.intelligence.findings) === JSON.stringify(rec.analysis.evidence) && rec.intelligence.operationalImpact === rec.analysis.impact && rec.decision.recommendation === rec.analysis.recommendation && rec.risk.level === "high" && rec.signal.summary === "Synthetic AC not cooling");
  check("provider and model come from the AI service's own provenance", rec.provider === "test" && rec.model === "deterministic-stub" && rec.generatedBy === "llm");
  check("G llm safety: no action, tool call or message is stored (legacy action fields stay empty)", rec.action.label === undefined && rec.action.recommended === undefined && rec.outcome.expected === undefined && !("toolCalls" in rec) && !("actions" in rec));
  check("the analysis says it is a recommendation only and claims no completed action", /recommendation only/.test(rec.analysis.recommendation) && !/already|was contacted|has been resolved/i.test(rec.analysis.recommendation));

  // C provenance
  const stored = await Intelligence.findById(rec._id).lean();
  const retrievedInDb = await KnowledgeChunk.find({ _id: { $in: (rec.knowledgeProvenance || []).map((p) => p.chunkId) } }).lean();
  same("C provenance (guest level): exactly the retrieved guest chunk is cited", provIds(rec), [cid.G]);
  const p0 = rec.knowledgeProvenance[0];
  check("C provenance: section, sectionPath, visibility and retrieval score are preserved from the retrieval result", p0.section === "Timings" && JSON.stringify(p0.sectionPath) === JSON.stringify(["Guest Policies", "Timings"]) && p0.visibility === "guest" && typeof p0.retrievalScore === "number" && typeof p0.similarityScore === "number" && p0.scope === "property" && p0.knowledgeDocumentId === String(docA));
  check("C provenance: every cited chunk really exists in the corpus and belongs to this workspace and property", retrievedInDb.length === 1 && String(retrievedInDb[0].workspaceId) === String(wsA) && String(retrievedInDb[0].propertyId) === String(propA));
  check("E visibility: the record is marked with the highest visibility retrieved (guest)", stored.knowledgeVisibility === "guest" && stored.analysisLevel === "guest" && stored.analysisVersion === "intelligence-v1");

  // B grounding + what the AI service was actually sent
  const sent = fake.requests.at(-1);
  check("B grounding: the AI service received only context, authorized knowledge, the bounded operationalHistory (Phase 27) and the trusted level - and no `learning` key while Learning is OFF", JSON.stringify(Object.keys(sent).sort()) === JSON.stringify(["authorizedLevel", "context", "knowledge", "operationalHistory"]) && sent.authorizedLevel === "guest" && !("learning" in sent));
  same("B grounding: the knowledge it received was only the guest chunk", sent.knowledge.map((k) => k.chunkId), [cid.G]);
  check("B grounding: no staff/restricted/other-property/other-tenant knowledge text reached the AI service", !["SYNTH-STAFF", "SYNTH-RESTRICTED", "SYNTH-OTHER"].some((m) => JSON.stringify(sent).includes(m)));
  check("B grounding (privacy): no guest name field or value reached the AI service", !/"firstName"|"lastName"|"fullName"/.test(JSON.stringify(sent)) && !/\bSynth\b/.test(JSON.stringify(sent)) && JSON.stringify(Object.keys(sent.context.guest).sort()) === JSON.stringify(["available", "id", "recentStays"]));
  check("B grounding: the recorded stay status was sent exactly as stored", sent.context.stay.status === "checked_in" && sent.context.stay.reservationId === `SYN-${stamp}`);
  check("B grounding: no guest contact details reached the AI service", !JSON.stringify(sent).includes("example.invalid") && !JSON.stringify(sent).includes("20002") && !("email" in sent.context.guest) && !("phone" in sent.context.guest));
  check("B grounding: operational facts in the analysis are the Signal's own facts, nothing invented", rec.analysis.evidence.some((e) => e.includes("Synthetic AC not cooling") && e.includes("'high'")) && rec.analysis.evidence.some((e) => e.includes("A guest record is linked")) && rec.analysis.evidence.some((e) => e.includes("A stay is linked")));
  check("B grounding: the recommendation is grounded in the retrieved section", rec.analysis.recommendation.includes("Guest Policies > Timings"));

  // idempotency
  const callsBefore = fake.analyzeCalls;
  const g1b = await analyze("guest", S1);
  check("F persistence: asking again returns the SAME record (200), with no new analysis call", g1b.status === 200 && g1b.json.data._id === rec._id && fake.analyzeCalls === callsBefore && (await count(S1, "guest")) === 1);
  const race = await Promise.all(Array.from({ length: 4 }, () => analyze("guest", S2)));
  check("F persistence: concurrent requests for one Signal converge on ONE record", race.every((r) => [200, 201].includes(r.status)) && race.filter((r) => r.status === 201).length === 1 && new Set(race.map((r) => r.json.data._id)).size === 1 && (await count(S2, "guest")) === 1, JSON.stringify(race.map((r) => r.status)));

  // missing guest / stay
  const r2 = race.find((r) => r.status === 201).json.data;
  check("A context: a Signal with no guest or stay produces an analysis that says so, and stores no guest/stay reference", r2.guestId === undefined && r2.stayId === undefined && r2.analysis.evidence.some((e) => e.includes("No guest is linked")) && r2.analysis.evidence.some((e) => e.includes("No stay is linked")));
  const r8 = (await analyze("guest", String(S8))).json.data;
  check("A context: an unresolvable guest reference is reported as unavailable and is not stored as a link", r8.analysis.evidence.some((e) => e.includes("linked guest record is unavailable")) && r8.guestId === undefined);

  // no knowledge
  const r3 = (await analyze("guest", S3)).json.data;
  check("B grounding: no relevant knowledge is acknowledged explicitly, confidence is low, and no provenance is stored", r3.analysis.confidence === "low" && r3.analysis.evidence.some((e) => e.includes("No relevant documented Business Knowledge was retrieved")) && /No documented guidance was retrieved/.test(r3.analysis.recommendation) && r3.knowledgeProvenance === undefined && r3.knowledgeVisibility === undefined);
  check("H api: a Signal with no property does not retrieve property-scoped knowledge", provIds(r3).length === 0);

  // E visibility per level; own record per level
  const s1 = await analyze("staff", S1);
  const r1 = await analyze("restricted", S1);
  same("E visibility: staff-level analysis cites guest + staff knowledge only", provIds(s1.json.data), sorted([cid.G, cid.S]));
  same("E visibility: restricted-level analysis (trusted) may cite all three", provIds(r1.json.data), sorted([cid.G, cid.S, cid.R]));
  check("E visibility: each level got its own record, marked with its highest retrieved visibility", s1.status === 201 && r1.status === 201 && s1.json.data.knowledgeVisibility === "staff" && r1.json.data.knowledgeVisibility === "restricted" && new Set([rec._id, s1.json.data._id, r1.json.data._id]).size === 3 && (await count(S1)) === 3);
  check("E visibility: the guest analysis contains no staff or restricted text or section label anywhere", !["SYNTH-STAFF", "SYNTH-RESTRICTED", "Staff Procedures", "Escalation"].some((m) => JSON.stringify(rec).includes(m)));
  const guestRead = (id) => http_(bases.guest, "GET", `/intelligence/${id}?workspaceId=${wsA}`);
  check("E visibility: a guest caller cannot read the staff- or restricted-derived records (404)", (await guestRead(s1.json.data._id)).status === 404 && (await guestRead(r1.json.data._id)).status === 404 && (await guestRead(rec._id)).status === 200);
  const listG = await http_(bases.guest, "GET", `/intelligence?workspaceId=${wsA}&signalId=${S1}`);
  same("E visibility: the guest list contains only the guest-level record", listG.json.data.map((x) => x._id), [rec._id]);

  // a caller cannot pick its own level
  for (const [label, opts] of [
    ["?authorizedLevel=restricted", { query: "&authorizedLevel=restricted" }],
    ["?level=restricted&visibility=restricted", { query: "&level=restricted&visibility=restricted" }],
    ["x-authorized-level header", { headers: { "x-authorized-level": "restricted", "x-knowledge-level": "restricted", "x-role": "admin" } }],
    ["a JSON body authorizedLevel", { body: { authorizedLevel: "restricted", level: "restricted" } }],
  ]) {
    const s = await sig(wsA, { title: `Synthetic spoof ${label}`, description: "Synthetic.", propertyId: String(propA) });
    const r = await analyze("guest", s, opts); // HTTP as an OPERATOR (staff ceiling)
    check(`H api: a caller-supplied level is ignored (${label}): an operator's analysis stays staff-level, never restricted`, r.status === 201 && r.json.data.analysisLevel === "staff" && r.json.data.knowledgeVisibility !== "restricted" && !JSON.stringify(r.json.data).includes("SYNTH-RESTRICTED"));
  }
  const s5 = await analyze("guest", S5);
  same("E visibility: an analysis at guest level never cites staff/restricted chunks", provIds(s5.json.data), [cid.G]);

  // isolation
  check("A isolation (property): a Signal at one property never uses another property's knowledge", !provIds(rec).includes(cid.OP) && !JSON.stringify(rec).includes("SYNTH-OTHER-PROPERTY"));
  const r4 = (await analyze("restricted", S4)).json.data;
  same("A isolation (property): a Signal at the other property cites only that property's chunk", provIds(r4), [cid.OP]);
  const rB = await analyze("restricted", SB, { ws: wsB });
  same("A isolation (workspace): another workspace's Signal uses only its own knowledge", provIds(rB.json.data), [cid.OT]);
  check("A isolation (workspace): analyzing a Signal through the wrong workspace is 404 in both directions", (await analyze("restricted", S1, { ws: wsB })).status === 404 && (await analyze("restricted", SB, { ws: wsA })).status === 404);

  // ================================================================ D/G/C hostile or malformed LLM output
  {
    const before = await Intelligence.countDocuments({ signalIds: S6 });
    // Phase 34A-B: the fake AI service now reports the deterministic stub's REAL identity (was an arbitrary "m"). Node verifies
    // provider/model against the approved policy before persisting, so an otherwise-valid body with an unapproved identity is
    // rejected for THAT reason; keeping "m" would make every case below pass for the wrong reason and hide the check under test.
    const goodBody = (extra = {}) => (req) => ({ situation: "s", evidence: ["e"], impact: "i", recommendation: "r", confidence: "medium", usedKnowledgeChunkIds: [], provenance: { provider: "test", model: "deterministic-stub" }, ...extra });
    const cases = [
      ["non-JSON output", { status: 200, body: "this is not json {{{" }],
      ["confidence 0.9 (a number)", { body: goodBody({ confidence: 0.9 }) }],
      ["confidence '0.9'", { body: goodBody({ confidence: "0.9" }) }],
      ["confidence 'HIGH'", { body: goodBody({ confidence: "HIGH" }) }],
      ["confidence 'certain'", { body: goodBody({ confidence: "certain" }) }],
      ["missing evidence", { body: (r) => { const b = goodBody()(r); delete b.evidence; return b; } }],
      ["blank recommendation", { body: goodBody({ recommendation: "  " }) }],
      ["an injected 'action' field", { body: goodBody({ action: "refund the guest" }) }],
      ["an injected 'toolCalls' field", { body: goodBody({ toolCalls: [{ name: "send_email" }] }) }],
      ["an injected 'sendMessage' field", { body: goodBody({ sendMessage: "hello" }) }],
      ["a cited chunk that was never retrieved (invented id)", { body: goodBody({ usedKnowledgeChunkIds: ["000000000000000000000000"] }) }],
      ["a cited chunk from another workspace", { body: goodBody({ usedKnowledgeChunkIds: [cid.OT] }) }],
      ["a cited chunk from another property", { body: goodBody({ usedKnowledgeChunkIds: [cid.OP] }) }],
      ["a cited staff chunk at guest level", { body: goodBody({ usedKnowledgeChunkIds: [cid.S] }) }],
      ["a cited restricted chunk at guest level", { body: goodBody({ usedKnowledgeChunkIds: [cid.R] }) }],
      ["an AI-service error payload", { status: 502, body: { error: { code: "MALFORMED_RESPONSE", message: "x" } } }],
    ];
    for (const [label, mode] of cases) {
      fake.mode = mode;
      const res = await analyze("guest", S6);
      check(`G/D/C hostile output rejected with nothing persisted: ${label}`, [502, 503, 504].includes(res.status) && (await Intelligence.countDocuments({ signalIds: S6 })) === before, `status ${res.status}`);
    }
    fake.mode = { body: (req) => ({ situation: "s", evidence: ["e"], impact: "i", recommendation: "r", confidence: "high", usedKnowledgeChunkIds: req.knowledge.map((k) => k.chunkId).slice(0, 1), provenance: { provider: "test", model: "deterministic-stub" } }) };
    const okRes = await analyze("guest", S6);
    fake.mode = null;
    check("D confidence: a valid 'high' is accepted and stored exactly as given", okRes.status === 201 && okRes.json.data.analysis.confidence === "high" && okRes.json.data.confidence === undefined);
    same("C provenance: the stored provenance comes from Node's retrieval, for the chunk the analysis cited", provIds(okRes.json.data), [cid.G]);
    check("C provenance: retrieval score and sectionPath come from the retrieval result, not the model", typeof okRes.json.data.knowledgeProvenance[0].retrievalScore === "number" && JSON.stringify(okRes.json.data.knowledgeProvenance[0].sectionPath) === JSON.stringify(["Guest Policies", "Timings"]));
  }
  fake.mode = null;

  // ================================================================ H. API edge cases
  check("H api: a missing Signal is 404", (await analyze("restricted", "000000000000000000000000")).status === 404);
  check("H api: a malformed Signal id is 400", (await analyze("restricted", "not-an-id")).status === 400);
  check("H api: a missing workspaceId is 400", (await http_(bases.restricted, "POST", `/intelligence/analyze/${S1}`)).status === 400);
  const nonRouted = await http_(bases.nonrouted, "POST", `/intelligence/analyze/${S1}?workspaceId=${wsA}`);
  check("H api: a Node provider that is not AI-service-routed cannot run grounded analysis (503)", nonRouted.status === 503);
  const before7 = await Intelligence.countDocuments({ signalIds: S7 });
  const down = await analyze("down", S7);
  check("H api: an unreachable AI service fails with an error and persists nothing", down.status >= 500 && (await Intelligence.countDocuments({ signalIds: S7 })) === before7, `status ${down.status}`);
  const legacy = await http_(admin, "POST", `/signals/${S1}/intelligence?workspaceId=${wsA}`);
  check("Phase 24: the legacy generate endpoint is RETIRED (404, not a route) and the V1 one-per-level rule is untouched", legacy.status === 404 && (await count(S1)) === 3);

  // ================================================================ F. no side effects
  const opsAfter = {};
  for (const [name, Model] of [["Signal", Signal], ["Guest", Guest], ["Stay", Stay], ["Property", Property], ["Unit", Unit]]) opsAfter[name] = hashRows(await Model.find(name === "Unit" ? { propertyId: { $in: [propA, propA2, propB] } } : { workspaceId: { $in: created.workspaceIds } }, { _id: 1, updatedAt: 1 }).sort({ _id: 1 }).lean());
  same("F persistence: no Signal, Guest, Stay, Property or Unit was modified by any analysis", Object.fromEntries(Object.entries(opsAfter).filter(([k]) => k !== "Signal")), Object.fromEntries(Object.entries(opsBefore).filter(([k]) => k !== "Signal")));
  check("F persistence: Signals were only added by this suite's own extra spoof fixtures, never modified", (await Signal.find({ _id: { $in: [S1, S2, S3, S4, S5, S6, S7, SB, S8] } }).lean()).every((s) => s.status === "new" && String(s.updatedAt.getTime()) === String((new Date(s.createdAt)).getTime())));
  check("F persistence: the knowledge chunks used were not modified (no re-embedding)", hashRows(await KnowledgeChunk.find({ workspaceId: { $in: created.workspaceIds } }, { _id: 1, updatedAt: 1 }).sort({ _id: 1 }).lean()) === knowledgeBefore);
  same("real (non-throwaway) operational and knowledge records are unchanged by this suite", await fingerprintOutside(created.workspaceIds), outsideBefore);
}

let exitCode = 1;
try {
  await main();
  exitCode = failed === 0 ? 0 : 1;
} catch (error) {
  fail("suite crashed", error?.stack || String(error));
} finally {
  for (const child of servers) child.kill();
  fake.server?.close();
  try { await cleanup(); } catch (error) { console.error("cleanup failed:", error?.message); }
  await disconnectDatabase();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(exitCode);
}
