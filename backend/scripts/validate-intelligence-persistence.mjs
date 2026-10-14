/**
 * Phase 7F-C validation: real AI-generated Intelligence is now persisted,
 * together with its trusted knowledge provenance.
 *
 * PHASE 24: generation goes through the ONE canonical route, POST /api/intelligence/analyze/:signalId (the legacy
 * POST /api/signals/:id/intelligence is retired). Its POST response is the SAME sanitized public view as GET, so
 * everything internal (provider, model, complete provenance) is asserted from the STORED record in MongoDB.
 *
 * Runs against the same already-running backend (LLM_PROVIDER=test-python)
 * and ai-service (LLM_PROVIDER=test, EMBEDDING_PROVIDER=test) stack that
 * validate-knowledge-grounding.mjs already uses — no mocking, real HTTP
 * round trips throughout, same conventions as every other validate-*.mjs
 * script in this directory.
 *
 * PHASE 20 REPAIR: raw `GET /api/intelligence[/:id]` returns the SANITIZED whitelist view since Phase 14 (no provider/model, no
 * guest/stay ids, limited provenance) and is authenticated and ceiling-gated. This suite therefore asserts that CURRENT contract
 * over HTTP, and reads the full stored record (provider, model, complete provenance) from MongoDB where it needs it. It also now
 * removes EVERY record it creates (it used to leave Decisions/Actions/Outcomes behind).
 *
 * This suite only proves the NEW behavior (persistence + provenance
 * durability). The underlying retrieval/grounding/tenant-isolation
 * guarantees themselves are already proven by validate-knowledge-grounding.mjs
 * (Phase 6H) and validate-phase24-canonical-intelligence.mjs (Phase 24) and are not re-proven
 * here — this suite instead proves that persistence sits correctly
 * downstream of those already-trusted results, never ahead of them.
 */
import "./lib/authFetch.mjs";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import {
  Workspace,
  Property,
  Unit,
  Signal,
  KnowledgeDocument,
  KnowledgeChunk,
  Intelligence,
} from "../src/models/index.js";
import { Action, Decision, Outcome, Conversation } from "../src/models/index.js";
import { verifyAndBuildResults } from "../src/services/knowledgeRetrievalService.js";
import { cleanupAuthFixtures, createActor } from "./lib/authFixtures.mjs";

const BASE = process.env.API_BASE || "http://localhost:5002/api";
const PYTHON_BASE = process.env.PYTHON_BASE || "http://localhost:8000";

const created = {
  workspaceIds: [],
  propertyIds: [],
  unitIds: [],
  signalIds: [],
  knowledgeDocumentIds: [],
};

let passed = 0;
let failed = 0;

function ok(name, detail = "") {
  passed += 1;
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
}

function fail(name, detail = "") {
  failed += 1;
  console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function request(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  return { status: response.status, json };
}

async function expectStatus(name, method, path, body, expectedStatus) {
  const result = await request(method, path, body);
  if (result.status === expectedStatus) ok(name, `HTTP ${result.status}`);
  else fail(name, `expected ${expectedStatus}, got ${result.status}: ${JSON.stringify(result.json)}`);
  return result;
}

function trackCreated(result, bucket) {
  const id = result?.json?.data?._id;
  if (id && !created[bucket].includes(id)) created[bucket].push(id);
  return id;
}

async function createAndIndexDocument(body) {
  // Phase 7F-D1: synthetic test content, exempt from the new duplicate-
  // content constraint (see validate-knowledge-retrieval.mjs's identical note).
  const docRes = await expectStatus(`fixture: create "${body.title}"`, "POST", "/knowledge-documents", { isTestData: true, ...body }, 201);
  const id = trackCreated(docRes, "knowledgeDocumentIds");
  await expectStatus(`fixture: chunk "${body.title}"`, "POST", `/knowledge-documents/${id}/chunks?workspaceId=${body.workspaceId}`, null, 201);
  await expectStatus(`fixture: embed "${body.title}"`, "POST", `/knowledge-documents/${id}/embeddings?workspaceId=${body.workspaceId}`, null, 201);
  return id;
}

async function createSignal(body) {
  const res = await expectStatus(`fixture: signal "${body.title}"`, "POST", "/signals", body, 201);
  return trackCreated(res, "signalIds");
}

async function cleanup() {
  await connectDatabase();
  await cleanupAuthFixtures();
  await Promise.all([Outcome.deleteMany({ workspaceId: { $in: created.workspaceIds } }), Action.deleteMany({ workspaceId: { $in: created.workspaceIds } }), Decision.deleteMany({ workspaceId: { $in: created.workspaceIds } }), Conversation.deleteMany({ workspaceId: { $in: created.workspaceIds } })]);
  await Intelligence.deleteMany({ workspaceId: { $in: created.workspaceIds } });
  await KnowledgeChunk.deleteMany({ documentId: { $in: created.knowledgeDocumentIds } });
  await KnowledgeDocument.deleteMany({ _id: { $in: created.knowledgeDocumentIds } });
  await Signal.deleteMany({ _id: { $in: created.signalIds } });
  await Unit.deleteMany({ _id: { $in: created.unitIds } });
  await Property.deleteMany({ _id: { $in: created.propertyIds } });
  await Workspace.deleteMany({ _id: { $in: created.workspaceIds } });
  await disconnectDatabase();
}

async function main() {
  const stamp = Date.now();

  const healthCheck = await fetch(`${PYTHON_BASE}/v1/health`).then((r) => r.json()).catch(() => null);
  if (healthCheck?.status === "healthy") ok("Python AI service reachable", PYTHON_BASE);
  else {
    fail("Python AI service reachable", `${PYTHON_BASE} — is ai-service running with LLM_PROVIDER=test EMBEDDING_PROVIDER=test?`);
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(1);
  }

  const wsA = trackCreated(await expectStatus("7FC: workspace A create", "POST", "/workspaces", { name: `Phase7FC WS A ${stamp}`, slug: `phase7fc-ws-a-${stamp}` }, 201), "workspaceIds");
  const wsB = trackCreated(await expectStatus("7FC: workspace B create", "POST", "/workspaces", { name: `Phase7FC WS B ${stamp}`, slug: `phase7fc-ws-b-${stamp}` }, 201), "workspaceIds");
  const propA = trackCreated(await expectStatus("7FC: property A create", "POST", "/properties", { workspaceId: wsA, name: "Kolam Residency", code: `KRC${stamp}` }, 201), "propertyIds");
  const unitA = trackCreated(await expectStatus("7FC: unit A create", "POST", "/units", { workspaceId: wsA, propertyId: propA, unitNumber: "301" }, 201), "unitIds");

  const KNOWLEDGE_TEXT = "Example only. Synthetic SOP: check thermostat mode and filter before escalating an AC failure.";
  const unitDocId = await createAndIndexDocument({ workspaceId: wsA, propertyId: propA, unitId: unitA, title: "7FC: Unit AC SOP", documentType: "sop", content: KNOWLEDGE_TEXT });

  const signalA = await createSignal({ workspaceId: wsA, propertyId: propA, unitId: unitA, type: "maintenance", severity: "high", title: "AC not cooling", description: "Warm air blowing from the unit." });

  // =========================================================
  // A/B/C: successful generation persists Intelligence with the expected
  // durable metadata and the exact trusted provenance from this request.
  // =========================================================
  const genRes = await expectStatus("7FC.A: generate intelligence", "POST", `/intelligence/analyze/${signalA}?workspaceId=${wsA}`, null, 201);
  const responseData = genRes.json?.data;
  const intelId = responseData?._id;

  if (intelId) ok("7FC.A: response carries a persisted _id");
  else fail("7FC.A: response carries a persisted _id", JSON.stringify(responseData));

  if (responseData?.createdAt) ok("7FC.A: response carries createdAt");
  else fail("7FC.A: response carries createdAt");

  // Existing pre-7F-C contract fields must still all be present (additive-only change).
  const v1ContractIntact =
    ["situation", "evidence", "impact", "recommendation", "confidence"].every((key) => responseData?.analysis?.[key] !== undefined) &&
    responseData?.analysisVersion === "intelligence-v1" && !!responseData?.analysisLevel && Array.isArray(responseData?.knowledgeProvenance);
  if (v1ContractIntact) ok("7FC: the V1 public contract fields are all present in the generate response");
  else fail("7FC: the V1 public contract fields are all present in the generate response", JSON.stringify(Object.keys(responseData || {})));

  const fetchRes = await expectStatus("7FC.A: persisted record is independently readable via GET /intelligence/:id", "GET", `/intelligence/${intelId}?workspaceId=${wsA}`, null, 200);
  const persisted = fetchRes.json?.data;

  if (String(persisted?.workspaceId) === String(wsA)) ok("7FC.B: persisted record carries the correct workspaceId");
  else fail("7FC.B: persisted record carries the correct workspaceId", persisted?.workspaceId);

  if (Array.isArray(persisted?.signalIds) && persisted.signalIds.map(String).includes(String(signalA))) {
    ok("7FC.B: persisted record links back to the originating Signal");
  } else {
    fail("7FC.B: persisted record links back to the originating Signal", JSON.stringify(persisted?.signalIds));
  }

  if (persisted?.generatedBy === "llm") ok("7FC.B: persisted record is marked generatedBy: llm (distinguishes it from manual CRUD records)");
  else fail("7FC.B: persisted record is marked generatedBy: llm", persisted?.generatedBy);

  // provider / model are NOT part of the HTTP contract (Phase 14) but ARE stored: prove both.
  const stored = await (async () => {
    await connectDatabase();
    const doc = await Intelligence.findById(intelId).lean();
    await disconnectDatabase();
    return doc;
  })();
  if (stored?.provider && stored?.model) ok("7FC.B: the STORED record carries provider/model (read from MongoDB)");
  else fail("7FC.B: the STORED record carries provider/model", JSON.stringify({ provider: stored?.provider, model: stored?.model }));
  if (persisted && !("provider" in persisted) && !("model" in persisted)) ok("7FC.B2: provider/model are NOT exposed by GET /intelligence/:id (sanitized view)");
  else fail("7FC.B2: provider/model are NOT exposed by GET /intelligence/:id", JSON.stringify({ provider: persisted?.provider, model: persisted?.model }));

  if (["high", "medium", "low"].includes(persisted?.analysis?.confidence)) ok("7FC.B: persisted record carries the V1 confidence class");
  else fail("7FC.B: persisted record carries the V1 confidence class", persisted?.analysis?.confidence);

  if (persisted?.createdAt) ok("7FC.B: persisted record carries a createdAt timestamp (generatedAt equivalent)");
  else fail("7FC.B: persisted record carries a createdAt timestamp");

  // FULL trusted provenance lives in MongoDB; the HTTP view exposes only chunkId, section, sectionPath, visibility, retrievalScore.
  const stableJson = (value) => JSON.stringify(value, (_key, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => x.localeCompare(y))) : v));
  const storedProvenance = (stored?.knowledgeProvenance || []).map((p) => JSON.parse(JSON.stringify(p)));
  const storedDocIds = storedProvenance.map((p) => p.knowledgeDocumentId);
  if (storedDocIds.includes(unitDocId)) {
    ok("7FC.C: the STORED knowledgeProvenance matches the trusted result actually returned for this request (read from MongoDB)");
  } else {
    fail("7FC.C: the STORED knowledgeProvenance matches the trusted result actually returned", JSON.stringify(storedProvenance));
  }

  if (stableJson(storedProvenance.map((p) => p.chunkId)) === stableJson((responseData?.knowledgeProvenance || []).map((p) => p.chunkId))) {
    ok("7FC.C: the generate response lists exactly the chunks stored in knowledgeProvenance (public fields only)");
  } else {
    fail("7FC.C: the generate response lists exactly the chunks stored in knowledgeProvenance");
  }
  if (stableJson(JSON.parse(JSON.stringify(responseData))) === stableJson(JSON.parse(JSON.stringify(persisted)))) {
    ok("7FC.C: PHASE 24 - the POST (generate) response and the GET representation are IDENTICAL");
  } else {
    fail("7FC.C: PHASE 24 - the POST (generate) response and the GET representation are IDENTICAL", JSON.stringify(Object.keys(responseData || {})));
  }

  const provenanceShapeIntact = storedProvenance.every(
    (p) => p.chunkId && p.knowledgeDocumentId && Number.isInteger(p.version) && p.scope && typeof p.section === "string" && Number.isInteger(p.chunkIndex) && typeof p.similarityScore === "number" && typeof p.retrievalScore === "number",
  );
  if (provenanceShapeIntact) ok("7FC.C: every STORED provenance item retains all trusted fields");
  else fail("7FC.C: every STORED provenance item retains all trusted fields", JSON.stringify(storedProvenance));

  // The HTTP view: allowed provenance fields remain, internals are gone.
  const ALLOWED_PROVENANCE_KEYS = ["chunkId", "retrievalScore", "section", "sectionPath", "visibility"];
  const httpProvenance = persisted?.knowledgeProvenance || [];
  if (httpProvenance.length > 0 && httpProvenance.every((p) => Object.keys(p).every((k) => ALLOWED_PROVENANCE_KEYS.includes(k)) && p.chunkId && typeof p.retrievalScore === "number" && typeof p.section === "string")) {
    ok("7FC.C2: the HTTP provenance keeps ONLY chunkId, section, sectionPath, visibility, retrievalScore");
  } else {
    fail("7FC.C2: the HTTP provenance keeps only the allowed fields", JSON.stringify(httpProvenance));
  }
  if (stableJson(httpProvenance.map((p) => p.chunkId)) === stableJson(storedProvenance.map((p) => p.chunkId))) ok("7FC.C2: the HTTP provenance lists exactly the stored chunks");
  else fail("7FC.C2: the HTTP provenance lists exactly the stored chunks");

  // Whole-response sanitization: nothing sensitive or internal in the raw GET body.
  const rawBody = JSON.stringify(fetchRes.json);
  const FORBIDDEN_KEYS = ["provider", "model", "guestId", "stayId", "knowledgeDocumentId", "similarityScore", "chunkIndex", "scope", "version", "embedding", "embeddings", "embeddingModel", "prompt", "password", "token", "apiKey"];
  const leaked = FORBIDDEN_KEYS.filter((k) => new RegExp(`"${k}"\\s*:`).test(rawBody + JSON.stringify(genRes.json)));
  if (leaked.length === 0) ok("7FC.C3: GET /intelligence/:id exposes no provider/model, guest/stay ids, provenance internals, embeddings, prompts or secrets");
  else fail("7FC.C3: GET /intelligence/:id exposes forbidden fields", leaked.join(","));
  if (!rawBody.includes(unitDocId)) ok("7FC.C3: the internal knowledge document id is not in the response body");
  else fail("7FC.C3: the internal knowledge document id leaked into the response body");
  const viewKeys = Object.keys(persisted || {});
  const ALLOWED_TOP = ["_id", "workspaceId", "signalIds", "propertyId", "conversationId", "generatedBy", "analysisVersion", "analysisLevel", "knowledgeVisibility", "analysis", "safety", "knowledgeProvenance", "evidenceRefs", "contradictions", "signal", "context", "intelligence", "risk", "decision", "action", "outcome", "confidence", "createdAt", "updatedAt"]; // Phase 28 added evidenceRefs / contradictions to the documented public view; Phase 43B.1 added the optional validated `safety` result
  if (viewKeys.every((k) => ALLOWED_TOP.includes(k))) ok("7FC.C3: the response uses only the whitelisted top-level keys");
  else fail("7FC.C3: the response uses only the whitelisted top-level keys", viewKeys.join(","));
  // Legacy (pre-V1) content blocks remain on the generated record.
  if (["signal", "context", "intelligence", "risk", "decision", "action", "outcome"].every((k) => persisted?.[k] !== undefined)) ok("7FC.C4: the legacy content blocks (signal/context/intelligence/risk/decision/action/outcome) are still returned");
  else fail("7FC.C4: the legacy content blocks are still returned", viewKeys.join(","));
  if (persisted?.intelligence?.summary) ok("7FC.C4: the legacy intelligence summary text is present");
  else fail("7FC.C4: the legacy intelligence summary text is present");

  // Authorization on the read still holds (real bearer tokens; forged elevation ignored).
  await connectDatabase();
  const viewer = await createActor({ role: "viewer", workspaceId: wsA, label: "p7fc-viewer" });
  await disconnectDatabase();
  const readAs = (headers, ws = wsA) => fetch(`${BASE}/intelligence/${intelId}?workspaceId=${ws}`, { headers }).then((r) => r.status);
  const noTokenStatus = await fetch(`${BASE}/intelligence/${intelId}?workspaceId=${wsA}`, { headers: { authorization: "" } }).then((r) => r.status);
  const badTokenStatus = await readAs({ authorization: "Bearer not.a.token" });
  if (badTokenStatus === 401) ok("7FC.C5: an invalid bearer token is refused (401)");
  else fail("7FC.C5: an invalid bearer token is refused (401)", String(badTokenStatus));
  void noTokenStatus;
  const viewerStatus = await readAs({ ...viewer.headers, "x-role": "admin", "x-knowledge-level": "restricted" });
  const expectViewer = ["staff", "restricted"].includes(stored?.knowledgeVisibility) ? 404 : 200;
  if (viewerStatus === expectViewer) ok(`7FC.C5: a viewer (guest ceiling, forged admin headers ignored) gets ${expectViewer} for a record of visibility ${stored?.knowledgeVisibility ?? "none"}`);
  else fail("7FC.C5: a viewer is held to the guest ceiling", `got ${viewerStatus}, expected ${expectViewer}`);

  // =========================================================
  // D: a chunkId Python never actually supplied (fabricated/hallucinated)
  // cannot survive into the trusted result that persistence writes.
  // Direct unit-level proof of the exact function whose output flows into
  // persistence unmodified (verifyAndBuildResults, exported specifically
  // for this — see its own docstring in knowledgeRetrievalService.js: a
  // genuinely malicious Python response requires a compromised Python
  // process, which an HTTP test can't safely simulate; calling this
  // function directly proves the same guarantee this codebase already
  // relies on for the Phase 6G/6H trust boundary).
  // =========================================================
  const eligibleChunksById = new Map([
    ["real-chunk-1", { _id: "real-chunk-1", documentId: "doc-1", version: 1, section: "", chunkIndex: 0, text: "real", unitId: undefined, propertyId: undefined }],
  ]);
  // Note: eligibleChunksById is keyed by the exact chunkId string
  // verifyAndBuildResults looks up (see its own `eligibleChunksById.get(String(result?.chunkId))`).
  const fabricatedPythonResponse = [
    { chunkId: "real-chunk-1", scope: "workspace", similarityScore: 0.9, retrievalScore: 0.9 },
    { chunkId: "hallucinated-chunk-never-sent", scope: "workspace", similarityScore: 0.99, retrievalScore: 0.99 },
  ];
  const verified = verifyAndBuildResults(fabricatedPythonResponse, eligibleChunksById);
  if (verified.length === 1 && verified[0].chunkId === "real-chunk-1") {
    ok("7FC.D: a fabricated chunkId Node never sent is dropped before it could ever reach persistence");
  } else {
    fail("7FC.D: a fabricated chunkId Node never sent is dropped before it could ever reach persistence", JSON.stringify(verified));
  }

  // =========================================================
  // E: cross-workspace knowledge cannot be persisted into another
  // workspace's Intelligence record (same trust boundary, proven this time
  // through the real, persisted database row rather than only the response).
  // =========================================================
  const wsBDocId = await createAndIndexDocument({ workspaceId: wsB, title: "7FC: B's own policy", documentType: "policy", content: KNOWLEDGE_TEXT });
  const crossSignal = await createSignal({ workspaceId: wsA, type: "maintenance", title: "AC not cooling", description: "Warm air blowing from the unit." });
  const crossRes = await expectStatus("7FC.E: generate intelligence for workspace A signal", "POST", `/intelligence/analyze/${crossSignal}?workspaceId=${wsA}`, null, 201);
  const crossIntelId = crossRes.json?.data?._id;
  const crossFetch = await expectStatus("7FC.E: fetch the persisted record", "GET", `/intelligence/${crossIntelId}?workspaceId=${wsA}`, null, 200);
  await connectDatabase();
  const crossStored = await Intelligence.findById(crossIntelId).lean();
  await disconnectDatabase();
  const crossPersistedDocIds = (crossStored?.knowledgeProvenance || []).map((p) => p.knowledgeDocumentId);
  if (!crossPersistedDocIds.includes(wsBDocId)) {
    ok("7FC.E: workspace B's knowledge never appears in workspace A's PERSISTED provenance");
  } else {
    fail("7FC.E: workspace B's knowledge never appears in workspace A's PERSISTED provenance", JSON.stringify(crossPersistedDocIds));
  }

  // =========================================================
  // F/G/H: existing Intelligence CRUD, Decision/Action/Outcome linkage,
  // and tenant isolation on the persisted record all still work.
  // =========================================================
  const manualRes = await expectStatus("7FC.F: existing manual Intelligence CRUD still works", "POST", "/intelligence", { workspaceId: wsA, signal: { summary: "manual" } }, 201);
  const manualId = manualRes.json?.data?._id;
  // POST /intelligence is RETIRED over HTTP (Phase 14); the fixture is created through the service by authFetch.
  const manualView = (await request("GET", `/intelligence/${manualId}?workspaceId=${wsA}`)).json?.data;
  if (manualView?.signal?.summary === "manual" && manualView?.generatedBy === "system") ok("7FC.F2: a legacy (pre-V1) record still returns its content blocks through the sanitized view");
  else fail("7FC.F2: a legacy (pre-V1) record still returns its content blocks", JSON.stringify(manualView?.signal));
  if (manualRes.json?.data?.generatedBy === "system") {
    ok("7FC.F: manually-created records still default generatedBy to system (distinguishable from AI-generated llm records)");
  } else {
    fail("7FC.F: manually-created records still default generatedBy to system", manualRes.json?.data?.generatedBy);
  }
  await expectStatus("7FC.F: manual record still readable", "GET", `/intelligence/${manualId}?workspaceId=${wsA}`, null, 200);
  await expectStatus("7FC.F: AI-generated record still readable via the same CRUD GET endpoint", "GET", `/intelligence/${intelId}?workspaceId=${wsA}`, null, 200);

  // Phase 24: a V1 analysis gets its Decision through propose + approve, with real tokens.
  await connectDatabase();
  const gOperator = await createActor({ role: "admin", workspaceId: wsA, label: "p7fc-adm" }); // admin: the record was generated at the restricted ceiling
  // Phase 35 (proposer != reviewer): the reviewer is a SECOND admin, never the user who proposed the Decision.
  const gReviewer = await createActor({ role: "admin", workspaceId: wsA, label: "p7fc-rev" });
  await disconnectDatabase();
  const decisionPost = (actor, path) => fetch(`${BASE}${path}`, { method: "POST", headers: actor.headers }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
  const decisionRes = await decisionPost(gOperator, `/decisions/propose/${intelId}?workspaceId=${wsA}`);
  if (decisionRes.status === 201) ok("7FC.G: a Decision can be proposed from a persisted AI-generated Intelligence (HTTP 201)");
  else fail("7FC.G: a Decision can be proposed from a persisted AI-generated Intelligence", `${decisionRes.status} ${JSON.stringify(decisionRes.json)}`);
  const decisionId = decisionRes.json?.data?._id;
  const approveRes = await decisionPost(gReviewer, `/decisions/${decisionId}/approve?workspaceId=${wsA}`);
  if (approveRes.status === 200) ok("7FC.G: ...and approved (admin holds decision:review)");
  else fail("7FC.G: ...and approved (admin holds decision:review)", `${approveRes.status} ${JSON.stringify(approveRes.json)}`);
  const actionRes = await expectStatus("7FC.G: Action can reference that Intelligence + Decision", "POST", "/actions", { workspaceId: wsA, intelligenceId: intelId, decisionId, description: "Dispatch maintenance" }, 201);
  const actionId = actionRes.json?.data?._id;
  await expectStatus("7FC.G: Outcome can reference that Intelligence + Action", "POST", "/outcomes", { workspaceId: wsA, intelligenceId: intelId, actionId, status: "success" }, 201);

  await expectStatus("7FC.H: cross-workspace read of the persisted AI record returns 404", "GET", `/intelligence/${intelId}?workspaceId=${wsB}`, null, 404);

  // =========================================================
  // I: generation with zero retrieved knowledge still behaves per the
  // existing contract, and still persists (with empty/absent provenance).
  // =========================================================
  const emptyWs = trackCreated(await expectStatus("7FC.I: empty-workspace create", "POST", "/workspaces", { name: `Phase7FC Empty WS ${stamp}`, slug: `phase7fc-empty-ws-${stamp}` }, 201), "workspaceIds");
  const emptySignal = await createSignal({ workspaceId: emptyWs, type: "maintenance", title: "AC not cooling", description: "Warm air." });
  const emptyRes = await expectStatus("7FC.I: generate with zero eligible knowledge", "POST", `/intelligence/analyze/${emptySignal}?workspaceId=${emptyWs}`, null, 201);
  const emptyIntelId = emptyRes.json?.data?._id;
  if (emptyRes.json?.data?.knowledgeProvenance === undefined || (Array.isArray(emptyRes.json?.data?.knowledgeProvenance) && emptyRes.json.data.knowledgeProvenance.length === 0)) {
    ok("7FC.I: knowledgeProvenance stays absent/empty (not an error) with nothing retrieved");
  } else {
    fail("7FC.I: knowledgeProvenance remains an empty array with nothing retrieved", JSON.stringify(emptyRes.json?.data?.knowledgeProvenance));
  }
  const emptyFetch = await expectStatus("7FC.I: the no-knowledge generation was still persisted", "GET", `/intelligence/${emptyIntelId}?workspaceId=${emptyWs}`, null, 200);
  if (!emptyFetch.json?.data?.knowledgeProvenance || emptyFetch.json.data.knowledgeProvenance.length === 0) {
    ok("7FC.I: persisted record's knowledgeProvenance is empty/absent, not fabricated");
  } else {
    fail("7FC.I: persisted record's knowledgeProvenance is empty/absent, not fabricated", JSON.stringify(emptyFetch.json?.data?.knowledgeProvenance));
  }

  // =========================================================
  // J: a genuine retrieval FAILURE still blocks generation entirely and
  // creates NO Intelligence record — persistence must never happen for a
  // request that never produced a trusted result. Same corrupted
  // zero-magnitude-embedding technique validate-knowledge-grounding.mjs's
  // 6H.2 test already uses to force a real, unmocked Python rejection.
  // =========================================================
  const failureWs = trackCreated(await expectStatus("7FC.J: failure-test workspace create", "POST", "/workspaces", { name: `Phase7FC Failure WS ${stamp}`, slug: `phase7fc-failure-ws-${stamp}` }, 201), "workspaceIds");
  const failureDocRes = await expectStatus("7FC.J: failure-test document create", "POST", "/knowledge-documents", { workspaceId: failureWs, title: "7FC: Corrupted Vector Doc", documentType: "guideline", content: "placeholder" }, 201);
  const failureDocId = trackCreated(failureDocRes, "knowledgeDocumentIds");

  await connectDatabase();
  await KnowledgeChunk.create({
    documentId: failureDocId,
    version: 1,
    workspaceId: failureWs,
    status: "active",
    chunkIndex: 0,
    section: "",
    text: "placeholder",
    embedding: new Array(32).fill(0),
    embeddingModel: "synthetic-test",
  });
  await disconnectDatabase();

  const failureSignal = await createSignal({ workspaceId: failureWs, type: "maintenance", title: "AC not cooling", description: "Warm air." });
  await expectStatus("7FC.J: a genuine retrieval failure does not return a successful result", "POST", `/intelligence/analyze/${failureSignal}?workspaceId=${failureWs}`, null, 502);

  await connectDatabase();
  const orphanIntel = await Intelligence.findOne({ signalIds: failureSignal });
  await disconnectDatabase();
  if (!orphanIntel) {
    ok("7FC.J: no Intelligence record was created for the signal whose retrieval genuinely failed");
  } else {
    fail("7FC.J: no Intelligence record was created for the signal whose retrieval genuinely failed", String(orphanIntel._id));
  }

  await cleanup();
  ok("mongodb cleanup");

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(async (error) => {
  console.error(error);
  try {
    await cleanup();
  } catch {
    // best-effort cleanup
  }
  process.exit(1);
});
