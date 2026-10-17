/**
 * Phase 24 validation: the ONE canonical intelligence path, POST /api/intelligence/analyze/:signalId.
 *
 *   A  authorization on the canonical route (real users, memberships and stub-signed tokens)
 *   B  data minimization: guest email / phone / name never reach the model
 *   C  the POST response is the SAME sanitized public view as GET (no provider, model, guest/stay ids,
 *      document ids, scores, embeddings)
 *   D  workspace isolation: no foreign signal, guest, stay, property or knowledge reaches the model;
 *      forged workspace / role / level authority (query, body, headers, token claims) has no effect
 *   E  the legacy POST /api/signals/:id/intelligence is retired (404) and reaches nothing
 *   F  method swapping on the canonical route
 *
 * A RECORDING PROXY sits between the backend and a running ai-service (PYTHON_BASE, default the TEST stack on :8010 started
 * by `node scripts/start-test-stack.mjs`: LLM_PROVIDER=test, EMBEDDING_PROVIDER=test, empty key). It stores every request
 * body Node sends, so the EXACT model request can be inspected. The backend runs NODE_ENV=test (which refuses any
 * non-loopback AI URL). No real provider is ever called. Everything is created in throwaway workspaces and removed by id.
 */
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import * as Models from "../src/models/index.js";
import { Guest, Intelligence, KnowledgeChunk, KnowledgeDocument, Property, Signal, Stay, Unit, User, Workspace } from "../src/models/index.js";
import { bearer, cleanupAuthFixtures, createActor, tokenFor } from "./lib/authFixtures.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, "..", "server.js");
const PYTHON_BASE = process.env.PYTHON_BASE || "http://localhost:8010";
const PROXY_PORT = 5981;
const PORT = 5982;
const BASE = `http://localhost:${PORT}/api`;

let passed = 0;
let failed = 0;
const check = (name, condition, detail = "") => {
  if (condition) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
  }
};

// The user's own dev ai-service (port 8000) may be configured with a REAL provider: this suite refuses it.
if (new URL(PYTHON_BASE).port === "8000") {
  console.error("Refusing PYTHON_BASE on :8000 (the dev ai-service). Start the test stack (scripts/start-test-stack.mjs) and use its :8010.");
  process.exit(2);
}

const M = {
  email: "TEST_GUEST_EMAIL_123@example.invalid",
  phone: "TEST_GUEST_PHONE_456",
  first: "TESTGUESTFIRSTNAME",
  last: "TESTGUESTLASTNAME",
  bEmail: "FOREIGN_GUEST_EMAIL_789@example.invalid",
  bPhone: "FOREIGN_GUEST_PHONE_012",
  bName: "FOREIGNGUESTNAME",
  bReservation: "FOREIGN-RESERVATION-3141",
  bSignal: "FOREIGN-SIGNAL-TITLE-2718",
  bProperty: "FOREIGN-PROPERTY-NAME-1618",
  bKnowledge: "FOREIGN-KNOWLEDGE-MARKER-1414",
  aRestricted: "OWN-RESTRICTED-KNOWLEDGE-MARKER",
};

const ids = { workspaces: [], properties: [] };
const recorded = [];

// ------------------------------------------------------------------ recording proxy in front of the test ai-service
function startProxy() {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const body = Buffer.concat(chunks);
      let parsed = null;
      try {
        parsed = JSON.parse(body.toString() || "null");
      } catch {
        parsed = null;
      }
      recorded.push({ url: req.url, body: parsed, text: body.toString() });
      try {
        const upstream = await fetch(`${PYTHON_BASE}${req.url}`, { method: req.method, headers: { "content-type": "application/json" }, body: body.length ? body : undefined });
        res.writeHead(upstream.status, { "content-type": "application/json" });
        res.end(await upstream.text());
      } catch {
        res.writeHead(502);
        res.end("{}");
      }
    });
  });
  return new Promise((resolve) => server.listen(PROXY_PORT, () => resolve(server)));
}

async function waitForHealth(timeoutMs = 25000) {
  const start = Date.now();
  for (;;) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch {
      // not ready
    }
    if (Date.now() - start > timeoutMs) throw new Error("server not healthy");
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function call(method, url, { headers = {}, body } = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${BASE}${url}`, init);
  const raw = await response.text();
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {
    json = null;
  }
  return { status: response.status, json, raw, data: json?.data, code: json?.details?.code };
}

const TRACKED = ["User", "WorkspaceMembership", "Workspace", "Property", "Unit", "Guest", "Stay", "Signal", "Intelligence", "Decision", "Action", "Outcome", "KnowledgeDocument", "KnowledgeChunk", "ImportBatch", "Conversation", "Message"];
const counts = async () => Object.fromEntries(await Promise.all(TRACKED.map(async (name) => [name, await Models[name].countDocuments({})])));

async function cleanup() {
  await connectDatabase();
  await cleanupAuthFixtures();
  const ws = { $in: ids.workspaces };
  const docs = (await KnowledgeDocument.find({ workspaceId: ws }, { _id: 1 }).lean()).map((d) => d._id);
  const props = (await Property.find({ workspaceId: ws }, { _id: 1 }).lean()).map((p) => p._id);
  await Promise.all([Models.Outcome.deleteMany({ workspaceId: ws }), Models.Action.deleteMany({ workspaceId: ws }), Models.Decision.deleteMany({ workspaceId: ws })]);
  await Intelligence.deleteMany({ workspaceId: ws });
  await KnowledgeChunk.deleteMany({ documentId: { $in: docs } });
  await KnowledgeDocument.deleteMany({ workspaceId: ws });
  await Signal.deleteMany({ workspaceId: ws });
  await Stay.deleteMany({ workspaceId: ws });
  await Guest.deleteMany({ workspaceId: ws });
  await Unit.deleteMany({ propertyId: { $in: props } });
  await Property.deleteMany({ workspaceId: ws });
  await Models.WorkspaceMembership.deleteMany({ workspaceId: ws });
  await Workspace.deleteMany({ _id: ws });
  await disconnectDatabase();
}

const FORBIDDEN_KEYS = ["provider", "model", "guestId", "stayId", "knowledgeDocumentId", "documentId", "similarityScore", "chunkIndex", "scope", "version", "embedding", "embeddings", "embeddingModel", "prompt", "__v", "apiKey", "token", "password"];
// Phase 28: evidenceRefs/contradictions are new, additive top-level fields (present only when the analysis
// reported one or the other) - added here, alongside the pre-existing fields, not in place of them.
const PUBLIC_TOP = ["_id", "workspaceId", "signalIds", "propertyId", "conversationId", "generatedBy", "analysisVersion", "analysisLevel", "knowledgeVisibility", "analysis", "safety", "knowledgeProvenance", "evidenceRefs", "contradictions", "signal", "context", "intelligence", "risk", "decision", "action", "outcome", "confidence", "createdAt", "updatedAt"]; // Phase 43B.1 added the optional validated `safety` result to the public view
const PUBLIC_PROVENANCE = ["chunkId", "section", "sectionPath", "visibility", "retrievalScore"];
// contact markers are compared case-insensitively (the Guest model lowercases e-mail addresses)
const has = (text, value) => String(text).toLowerCase().includes(String(value).toLowerCase());
const leakedKeys = (raw) => FORBIDDEN_KEYS.filter((k) => new RegExp(`"${k}"\\s*:`).test(raw));
const stable = (value) => JSON.stringify(JSON.parse(JSON.stringify(value)), (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));

async function main() {
  const stamp = Date.now();
  const proxy = await startProxy();
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: "test",
      LLM_PROVIDER: "test-python",
      AI_SERVICE_URL: `http://localhost:${PROXY_PORT}`,
      KOI_RATE_LIMIT_ENABLED: "false",
      // the HIGHEST dev level: any use of this fallback for an authenticated caller would show up as "restricted"
      KNOWLEDGE_DEV_AUTHORIZED_LEVEL: "restricted",
    },
    stdio: "ignore",
  });

  try {
    await waitForHealth();
    await connectDatabase();
    const before = await counts();

    // ---------------------------------------------------------------- fixtures (throwaway)
    const mkWs = async (label) => {
      const doc = await Workspace.create({ name: `P24 ${label} ${stamp}`, slug: `p24-${label}-${stamp}` });
      ids.workspaces.push(doc._id);
      return doc;
    };
    const wsA = await mkWs("a");
    const wsB = await mkWs("b");
    const A = String(wsA._id);
    const B = String(wsB._id);

    const propA = await Property.create({ workspaceId: wsA._id, name: `P24 Property A ${stamp}`, code: `P24A-${stamp}` });
    const propB = await Property.create({ workspaceId: wsB._id, name: `${M.bProperty} ${stamp}`, code: `P24B-${stamp}` });
    ids.properties.push(propA._id, propB._id);
    const unitA = await Unit.create({ propertyId: propA._id, unitNumber: "24A" });
    const unitB = await Unit.create({ propertyId: propB._id, unitNumber: "24B" });
    const guestA = await Guest.create({ workspaceId: wsA._id, propertyId: propA._id, firstName: M.first, lastName: M.last, email: M.email, phone: M.phone });
    const stayA = await Stay.create({ workspaceId: wsA._id, guestId: guestA._id, propertyId: propA._id, unitId: unitA._id, reservationId: `P24-RSV-${stamp}`, status: "checked_in", checkIn: new Date("2030-01-01"), checkOut: new Date("2030-01-05") });
    const guestB = await Guest.create({ workspaceId: wsB._id, propertyId: propB._id, firstName: M.bName, lastName: M.bName, email: M.bEmail, phone: M.bPhone });
    const stayB = await Stay.create({ workspaceId: wsB._id, guestId: guestB._id, propertyId: propB._id, unitId: unitB._id, reservationId: M.bReservation, status: "checked_in", checkIn: new Date("2030-01-01"), checkOut: new Date("2030-01-05") });

    const mkSignal = (o) => Signal.create({ workspaceId: wsA._id, propertyId: propA._id, unitId: unitA._id, type: "maintenance", severity: "high", ...o });
    const sig = {
      main: await mkSignal({ title: `P24 AC not cooling ${stamp}`, description: "Warm air from the unit.", guestId: guestA._id, stayId: stayA._id }),
      operator: await mkSignal({ title: `P24 op signal ${stamp}`, description: "Operator target." }),
      reviewer: await mkSignal({ title: `P24 rev signal ${stamp}`, description: "Reviewer target." }),
      admin: await mkSignal({ title: `P24 adm signal ${stamp}`, description: "Admin target." }),
      spoof: await mkSignal({ title: `P24 spoof signal ${stamp}`, description: "Spoof target." }),
      // a Signal of workspace A whose guest/stay references point at workspace B's records (a forged / corrupted reference)
      forgedRef: await mkSignal({ title: `P24 forged ref ${stamp}`, description: "References foreign guest and stay.", guestId: guestB._id, stayId: stayB._id }),
      viewerTarget: await mkSignal({ title: `P24 viewer target ${stamp}`, description: "Viewer must be refused." }),
    };
    const sigB = await Signal.create({ workspaceId: wsB._id, propertyId: propB._id, unitId: unitB._id, type: "maintenance", severity: "high", title: `${M.bSignal} ${stamp}`, description: "Foreign workspace signal.", guestId: guestB._id, stayId: stayB._id });

    const mk = (role, ws, label) => createActor({ role, workspaceId: ws._id, label });
    const viewer = await mk("viewer", wsA, "p24-viewer");
    const operator = await mk("operator", wsA, "p24-operator");
    const reviewer = await mk("reviewer", wsA, "p24-reviewer");
    const admin = await mk("admin", wsA, "p24-admin");
    const adminB = await mk("admin", wsB, "p24-adminb");
    const disabled = await mk("operator", wsA, "p24-disabled");
    await User.updateOne({ _id: disabled.user._id }, { $set: { status: "disabled" } });
    const outsider = await createActor({ label: "p24-outsider" });
    const H = (who) => who.headers;

    // knowledge: workspace A (staff + restricted, both matching the signal text) and workspace B (guest-visible, marker text)
    const mkDoc = async (who, workspaceId, extra) => {
      const created = await call("POST", `/knowledge-documents?workspaceId=${workspaceId}`, { headers: H(who), body: { workspaceId, documentType: "sop", isTestData: true, ...extra } });
      const id = created.data?._id;
      const chunked = await call("POST", `/knowledge-documents/${id}/chunks?workspaceId=${workspaceId}`, { headers: H(who) });
      const embedded = await call("POST", `/knowledge-documents/${id}/embeddings?workspaceId=${workspaceId}`, { headers: H(who) });
      check(`fixture: knowledge "${extra.title}" created, chunked and embedded (201/201/201)`, created.status === 201 && chunked.status === 201 && embedded.status === 201, `${created.status}/${chunked.status}/${embedded.status}`);
      return id;
    };
    await mkDoc(admin, A, { title: "P24 A staff SOP", defaultVisibility: "staff", content: "# AC failure\n\nExample only. Synthetic SOP: check the thermostat mode and filter before escalating an AC failure." });
    await mkDoc(admin, A, { title: "P24 A restricted procedure", defaultVisibility: "restricted", documentType: "procedure", content: `# AC escalation\n\nExample only. ${M.aRestricted}: page the duty engineer for a repeated AC failure.` });
    await mkDoc(adminB, B, { title: "P24 B SOP", defaultVisibility: "guest", content: `# AC failure\n\nExample only. ${M.bKnowledge}: check the thermostat mode and filter before escalating an AC failure.` });
    const chunksB = (await KnowledgeChunk.find({ workspaceId: wsB._id }, { _id: 1 }).lean()).map((c) => String(c._id));
    const chunksARestricted = (await KnowledgeChunk.find({ workspaceId: wsA._id, visibility: "restricted" }, { _id: 1 }).lean()).map((c) => String(c._id));
    check("fixture: workspace B has knowledge chunks and workspace A has a restricted chunk", chunksB.length > 0 && chunksARestricted.length > 0);

    const analyze = (who, signalId, { ws = A, extraQuery = "", headers = {}, body } = {}) =>
      call("POST", `/intelligence/analyze/${signalId}?workspaceId=${ws}${extraQuery}`, { headers: { ...H(who), ...headers }, body });
    const marks = () => recorded.length;
    const since = (n) => recorded.slice(n);
    const aiTextSince = (n) => since(n).map((r) => r.text).join("\n");
    const analyzeRequestSince = (n) => since(n).find((r) => r.url === "/v1/intelligence/analyze")?.body;
    const retrievalRequestSince = (n) => since(n).find((r) => r.url === "/v1/knowledge-retrieval")?.body;

    // ================================================================ A. authorization on the canonical route
    for (const [name, who, signal] of [["operator", operator, sig.operator], ["reviewer", reviewer, sig.reviewer], ["admin", admin, sig.admin]]) {
      const r = await analyze(who, signal._id);
      check(`A ${name} (intelligence:generate) -> 201 with an analysis`, r.status === 201 && typeof r.data?.analysis?.situation === "string" && r.data.workspaceId === A, `HTTP ${r.status}`);
    }
    let n = marks();
    let r = await analyze(viewer, sig.viewerTarget._id);
    check("A viewer -> 403, and the AI service is NOT reached", r.status === 403 && marks() === n);
    r = await call("POST", `/intelligence/analyze/${sig.viewerTarget._id}?workspaceId=${A}`);
    check("A unauthenticated -> 401, and the AI service is NOT reached", r.status === 401 && marks() === n);
    r = await analyze(disabled, sig.viewerTarget._id);
    check("A disabled user (valid token) -> 403, and the AI service is NOT reached", r.status === 403 && marks() === n);
    r = await analyze(outsider, sig.viewerTarget._id);
    check("A registered non-member -> 404, and the AI service is NOT reached", r.status === 404 && marks() === n);
    r = await analyze(adminB, sig.viewerTarget._id);
    check("A an admin of ANOTHER workspace selecting A -> 404 (cross-workspace), no AI call", r.status === 404 && marks() === n);
    r = await analyze(operator, sigB._id);
    check("A a member of A analyzing workspace B's Signal id -> 404 BEFORE any operational context or retrieval", r.status === 404 && marks() === n);
    r = await analyze(operator, sigB._id, { ws: B });
    check("A ...and naming workspace B as the selector (not a member) -> 404", r.status === 404 && marks() === n);
    check("A none of the denied requests created an Intelligence record", (await Intelligence.countDocuments({ signalIds: { $in: [sig.viewerTarget._id, sigB._id] } })) === 0);

    // ================================================================ B/C/D. the captured model request for one analysis
    n = marks();
    const main = await analyze(operator, sig.main._id);
    check("B/C the main analysis is created (201)", main.status === 201, `HTTP ${main.status}`);
    const modelRequest = analyzeRequestSince(n);
    const retrievalRequest = retrievalRequestSince(n);
    const allRequests = aiTextSince(n);
    check("capture: exactly the two expected ai-service calls were made (retrieval, analyze)", since(n).map((x) => x.url).join(",") === "/v1/knowledge-retrieval,/v1/intelligence/analyze", since(n).map((x) => x.url).join(","));
    // Phase 27: the canonical path now always attaches `operationalHistory` (bounded, validated - see
    // operationalContextContract.js); this assertion is updated to match that intentional, documented addition,
    // and still fails if any OTHER/unexpected key is ever added.
    check("capture: the request Node sends to the model carries only context, knowledge, authorizedLevel and operationalHistory", modelRequest && Object.keys(modelRequest).sort().join(",") === "authorizedLevel,context,knowledge,operationalHistory");

    // B. data minimization
    for (const [label, value] of [["guest email", M.email], ["guest phone", M.phone], ["guest first name", M.first], ["guest last name", M.last]]) {
      check(`B ${label} marker never appears in ANY request Node sent to the AI service`, !has(allRequests, value));
    }
    check("B the guest keeps only id / availability / recent stays in the model context", modelRequest && Object.keys(modelRequest.context.guest).sort().join(",") === "available,id,recentStays");
    check("B useful operational facts are NOT removed: stay dates/status and the guest-stay relationship remain", modelRequest?.context.stay?.status === "checked_in" && !!modelRequest.context.stay.checkIn && modelRequest.context.stay.guestId === String(guestA._id) && modelRequest.context.guest.recentStays.length === 1);
    check("B signal, property and unit facts remain", modelRequest?.context.signal.title === sig.main.title && modelRequest.context.property.name === propA.name && modelRequest.context.unit.unitNumber === "24A");
    const sigMainStored = await Signal.findById(sig.main._id).lean();
    const guestStored = await Guest.findById(guestA._id).lean();
    check("B the stored Guest itself is untouched (minimization is at the model boundary only)", has(guestStored.email, M.email) && guestStored.phone === M.phone && sigMainStored.guestId.equals(guestA._id));

    // C. response sanitization
    const raw = main.raw;
    check("C the POST response exposes none of provider / model / guestId / stayId / document ids / scores / chunkIndex / embeddings / __v", leakedKeys(raw).length === 0, leakedKeys(raw).join(","));
    check("C ...and no guest contact marker or foreign marker either", ![M.email, M.phone, M.first, M.bEmail, M.bKnowledge].some((v) => has(raw, v)));
    check("C only whitelisted top-level fields are returned", Object.keys(main.data).every((k) => PUBLIC_TOP.includes(k)), Object.keys(main.data).join(","));
    check("C the public V1 fields are present (situation, evidence, impact, recommendation, confidence, analysisVersion, analysisLevel, knowledgeVisibility)", ["situation", "evidence", "impact", "recommendation", "confidence"].every((k) => main.data.analysis?.[k] !== undefined) && main.data.analysisVersion === "intelligence-v1" && main.data.analysisLevel === "staff" && main.data.knowledgeVisibility === "staff");
    const provenance = main.data.knowledgeProvenance || [];
    check("C provenance is limited to chunkId / section / sectionPath / visibility / retrievalScore", provenance.length > 0 && provenance.every((p) => Object.keys(p).every((k) => PUBLIC_PROVENANCE.includes(k))));
    const got = await call("GET", `/intelligence/${main.data._id}?workspaceId=${A}`, { headers: H(operator) });
    check("C GET /intelligence/:id returns the SAME representation as the POST response", got.status === 200 && stable(got.data) === stable(main.data));
    n = marks();
    const again = await analyze(operator, sig.main._id);
    check("C a repeated POST returns the same stored analysis (200), identical to GET, with NO new AI call", again.status === 200 && stable(again.data) === stable(main.data) && marks() === n);
    const stored = await Intelligence.findById(main.data._id).lean();
    check("C the STORED record still keeps provider / model / full provenance for audit (test provider: 'test' / 'deterministic-stub')", stored.provider === "test" && stored.model === "deterministic-stub" && stored.knowledgeProvenance.every((p) => p.knowledgeDocumentId && typeof p.similarityScore === "number"));

    // D. workspace isolation
    check("D no foreign (workspace B) property, signal, guest, stay or knowledge text reaches the model", ![M.bProperty, M.bSignal, M.bName, M.bEmail, M.bPhone, M.bReservation, M.bKnowledge].some((v) => has(allRequests, v)));
    const sentChunkIds = (modelRequest?.knowledge || []).map((k) => k.chunkId).concat((retrievalRequest?.candidates || []).map((c) => c.chunkId));
    check("D no chunk of workspace B was a retrieval candidate or reached the model", sentChunkIds.length > 0 && !chunksB.some((id) => sentChunkIds.includes(id)));
    check("D the operator (staff ceiling) never sent or received restricted knowledge", !chunksARestricted.some((id) => sentChunkIds.includes(id)) && !has(allRequests, M.aRestricted) && modelRequest.authorizedLevel === "staff");

    // a Signal of A whose references point at B's guest and stay
    n = marks();
    r = await analyze(operator, sig.forgedRef._id);
    const forgedText = aiTextSince(n);
    const forgedRequest = analyzeRequestSince(n);
    check("D a Signal whose guest/stay ids reference ANOTHER workspace still analyzes (201) but with those records unavailable", r.status === 201 && forgedRequest?.context.guest?.available === false && forgedRequest?.context.stay?.available === false);
    check("D ...and nothing of the foreign guest or stay (name, email, phone, reservation) reached the model", ![M.bName, M.bEmail, M.bPhone, M.bReservation].some((v) => has(forgedText, v)) && (forgedRequest?.context.guest?.recentStays || []).length === 0);
    check("D ...and no foreign markers appear in the response either", ![M.bName, M.bEmail, M.bPhone, M.bReservation].some((v) => has(r.raw, v)));

    // an admin (restricted ceiling) DOES send restricted knowledge of its own workspace, and only its own
    n = marks();
    r = await analyze(admin, sig.main._id);
    const adminRequest = analyzeRequestSince(n);
    const adminChunkIds = (adminRequest?.knowledge || []).map((k) => k.chunkId);
    check("D an admin (restricted ceiling) gets its own restricted knowledge, never workspace B's", r.status === 201 && r.data.analysisLevel === "restricted" && chunksARestricted.some((id) => adminChunkIds.includes(id)) && !chunksB.some((id) => adminChunkIds.includes(id)) && adminRequest.authorizedLevel === "restricted");

    // G. no client authority: forged workspace / role / permission / level through body, query, headers and token claims
    const forgedHeaders = { "x-role": "admin", "x-permissions": "workspace:admin,intelligence:generate", "x-knowledge-level": "restricted", "x-authorized-level": "restricted", "x-workspace-id": B, "x-user-id": String(admin.user._id) };
    const forgedQuery = `&role=admin&permission=workspace:admin&level=restricted&authorizedLevel=restricted&knowledgeLevel=restricted&userId=${admin.user._id}`;
    const claimHeaders = { authorization: `Bearer ${tokenFor(viewer.user, { role: "admin", roles: ["admin"], permissions: ["workspace:admin"], knowledgeLevel: "restricted", workspaceId: B, scope: "admin" })}` };
    n = marks();
    r = await analyze(operator, sig.spoof._id, { extraQuery: forgedQuery, headers: forgedHeaders, body: { workspaceId: B, role: "admin", authorizedLevel: "restricted", knowledgeLevel: "restricted", guestId: String(guestB._id), stayId: String(stayB._id) } });
    const spoofRequest = analyzeRequestSince(n);
    check("G forged role/permission/level/workspace via query + headers + body: the operator still gets a STAFF-level analysis in workspace A", r.status === 201 && r.data.workspaceId === A && r.data.analysisLevel === "staff" && spoofRequest?.authorizedLevel === "staff");
    check("G ...and no restricted or foreign knowledge / guest data was sent", !chunksARestricted.some((id) => (spoofRequest?.knowledge || []).some((k) => k.chunkId === id)) && !has(aiTextSince(n), M.aRestricted) && ![M.bName, M.bEmail, M.bKnowledge].some((v) => has(aiTextSince(n), v)));
    n = marks();
    r = await analyze(viewer, sig.viewerTarget._id, { extraQuery: forgedQuery, headers: forgedHeaders, body: { role: "admin" } });
    check("G a VIEWER with forged admin headers / query / body is still 403 and reaches nothing", r.status === 403 && marks() === n);
    n = marks();
    r = await analyze(viewer, sig.viewerTarget._id, { headers: claimHeaders });
    check("G forged role / permission / workspace CLAIMS in a valid token do not elevate (viewer 403)", r.status === 403 && marks() === n);
    n = marks();
    r = await analyze(adminB, sig.main._id, { extraQuery: forgedQuery, headers: forgedHeaders, body: { workspaceId: A } });
    check("G workspace B's admin naming A through every channel -> 404", r.status === 404 && marks() === n);

    // E. legacy route retired
    n = marks();
    const before24 = await Intelligence.countDocuments({ workspaceId: { $in: ids.workspaces } });
    for (const [name, who] of [["viewer", viewer], ["operator", operator], ["reviewer", reviewer], ["admin", admin], ["admin of B", adminB]]) {
      r = await call("POST", `/signals/${sig.main._id}/intelligence?workspaceId=${A}`, { headers: H(who) });
      check(`E legacy POST /signals/:id/intelligence -> 404 (${name})`, r.status === 404, `HTTP ${r.status}`);
    }
    r = await call("POST", `/signals/${sig.main._id}/intelligence?workspaceId=${A}`);
    check("E ...and unauthenticated (404: the path does not exist)", r.status === 404);
    check("E the retired route reached no AI service and created nothing", marks() === n && (await Intelligence.countDocuments({ workspaceId: { $in: ids.workspaces } })) === before24);

    // F. method swapping
    n = marks();
    for (const method of ["GET", "PUT", "PATCH", "DELETE"]) {
      r = await call(method, `/intelligence/analyze/${sig.main._id}?workspaceId=${A}`, { headers: H(admin), body: method === "GET" || method === "DELETE" ? undefined : {} });
      check(`F ${method} /intelligence/analyze/:signalId is not a route (404) even for an admin`, r.status === 404, `HTTP ${r.status}`);
    }
    check("F none of them reached the AI service", marks() === n);

    // no external AI: everything Node sent went to the loopback proxy; the stub produced the analyses
    check("no external AI: every generated analysis in this run was produced by the deterministic test provider", (await Intelligence.find({ workspaceId: { $in: ids.workspaces } }).lean()).every((i) => i.provider === "test" && i.model === "deterministic-stub"));

    await cleanup();
    await connectDatabase();
    const after = await counts();
    check("database counts are back to the baseline after cleanup", stable(after) === stable(before), `before=${stable(before)} after=${stable(after)}`);
  } finally {
    child.kill();
    proxy.close();
    try {
      await cleanup();
    } catch {
      // best effort
    }
  }
  console.log(`\nPhase 24 canonical intelligence validation: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
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
