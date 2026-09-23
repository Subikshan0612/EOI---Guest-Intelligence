/**
 * Phase 7F-C validation: real AI-generated Intelligence is now persisted,
 * together with its trusted knowledge provenance.
 *
 * Runs against the same already-running backend (LLM_PROVIDER=test-python)
 * and ai-service (LLM_PROVIDER=test, EMBEDDING_PROVIDER=test) stack that
 * validate-knowledge-grounding.mjs already uses — no mocking, real HTTP
 * round trips throughout, same conventions as every other validate-*.mjs
 * script in this directory.
 *
 * This suite only proves the NEW behavior (persistence + provenance
 * durability). The underlying retrieval/grounding/tenant-isolation
 * guarantees themselves are already proven by validate-knowledge-grounding.mjs
 * (Phase 6H) and validate-intelligence.mjs (Phase 4) and are not re-proven
 * here — this suite instead proves that persistence sits correctly
 * downstream of those already-trusted results, never ahead of them.
 */
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
import { verifyAndBuildResults } from "../src/services/knowledgeRetrievalService.js";

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
  const docRes = await expectStatus(`fixture: create "${body.title}"`, "POST", "/knowledge-documents", body, 201);
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
  const genRes = await expectStatus("7FC.A: generate intelligence", "POST", `/signals/${signalA}/intelligence?workspaceId=${wsA}`, null, 200);
  const responseData = genRes.json?.data;
  const intelId = responseData?._id;

  if (intelId) ok("7FC.A: response carries a persisted _id");
  else fail("7FC.A: response carries a persisted _id", JSON.stringify(responseData));

  if (responseData?.createdAt) ok("7FC.A: response carries createdAt");
  else fail("7FC.A: response carries createdAt");

  // Existing pre-7F-C contract fields must still all be present (additive-only change).
  const existingContractIntact = ["summary", "findings", "risk", "decision", "action", "outcome", "confidence", "provenance", "knowledgeProvenance"].every(
    (key) => responseData?.[key] !== undefined,
  );
  if (existingContractIntact) ok("7FC: pre-existing response contract fields all still present");
  else fail("7FC: pre-existing response contract fields all still present", JSON.stringify(Object.keys(responseData || {})));

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

  if (persisted?.provider && persisted?.model) ok("7FC.B: persisted record carries provider/model");
  else fail("7FC.B: persisted record carries provider/model", JSON.stringify({ provider: persisted?.provider, model: persisted?.model }));

  if (typeof persisted?.confidence === "number") ok("7FC.B: persisted record carries confidence");
  else fail("7FC.B: persisted record carries confidence", persisted?.confidence);

  if (persisted?.createdAt) ok("7FC.B: persisted record carries a createdAt timestamp (generatedAt equivalent)");
  else fail("7FC.B: persisted record carries a createdAt timestamp");

  const persistedProvenanceDocIds = (persisted?.knowledgeProvenance || []).map((p) => p.knowledgeDocumentId);
  if (persistedProvenanceDocIds.includes(unitDocId)) {
    ok("7FC.C: persisted knowledgeProvenance matches the trusted result actually returned for this request");
  } else {
    fail("7FC.C: persisted knowledgeProvenance matches the trusted result actually returned for this request", JSON.stringify(persisted?.knowledgeProvenance));
  }

  if (JSON.stringify(persisted?.knowledgeProvenance) === JSON.stringify(responseData?.knowledgeProvenance)) {
    ok("7FC.C: persisted knowledgeProvenance is byte-for-byte identical to the response's own trusted provenance");
  } else {
    fail("7FC.C: persisted knowledgeProvenance is byte-for-byte identical to the response's own trusted provenance");
  }

  const provenanceShapeIntact = (persisted?.knowledgeProvenance || []).every(
    (p) => p.chunkId && p.knowledgeDocumentId && Number.isInteger(p.version) && p.scope && typeof p.section === "string" && Number.isInteger(p.chunkIndex) && typeof p.similarityScore === "number" && typeof p.retrievalScore === "number",
  );
  if (provenanceShapeIntact) ok("7FC.C: every persisted provenance item retains all trusted fields");
  else fail("7FC.C: every persisted provenance item retains all trusted fields", JSON.stringify(persisted?.knowledgeProvenance));

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
  const crossRes = await expectStatus("7FC.E: generate intelligence for workspace A signal", "POST", `/signals/${crossSignal}/intelligence?workspaceId=${wsA}`, null, 200);
  const crossIntelId = crossRes.json?.data?._id;
  const crossFetch = await expectStatus("7FC.E: fetch the persisted record", "GET", `/intelligence/${crossIntelId}?workspaceId=${wsA}`, null, 200);
  const crossPersistedDocIds = (crossFetch.json?.data?.knowledgeProvenance || []).map((p) => p.knowledgeDocumentId);
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
  if (manualRes.json?.data?.generatedBy === "system") {
    ok("7FC.F: manually-created records still default generatedBy to system (distinguishable from AI-generated llm records)");
  } else {
    fail("7FC.F: manually-created records still default generatedBy to system", manualRes.json?.data?.generatedBy);
  }
  await expectStatus("7FC.F: manual record still readable", "GET", `/intelligence/${manualId}?workspaceId=${wsA}`, null, 200);
  await expectStatus("7FC.F: AI-generated record still readable via the same CRUD GET endpoint", "GET", `/intelligence/${intelId}?workspaceId=${wsA}`, null, 200);

  const decisionRes = await expectStatus("7FC.G: Decision can reference a persisted AI-generated Intelligence", "POST", "/decisions", { workspaceId: wsA, intelligenceId: intelId, description: "Check thermostat" }, 201);
  const decisionId = decisionRes.json?.data?._id;
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
  const emptyRes = await expectStatus("7FC.I: generate with zero eligible knowledge", "POST", `/signals/${emptySignal}/intelligence?workspaceId=${emptyWs}`, null, 200);
  const emptyIntelId = emptyRes.json?.data?._id;
  if (Array.isArray(emptyRes.json?.data?.knowledgeProvenance) && emptyRes.json.data.knowledgeProvenance.length === 0) {
    ok("7FC.I: knowledgeProvenance remains an empty array (not an error) with nothing retrieved");
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
  await expectStatus("7FC.J: a genuine retrieval failure does not return a successful result", "POST", `/signals/${failureSignal}/intelligence?workspaceId=${failureWs}`, null, 502);

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
