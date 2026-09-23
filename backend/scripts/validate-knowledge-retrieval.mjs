/**
 * Phase 6G validation: knowledge retrieval (GET /api/signals/:id/knowledge-retrieval).
 *
 * Requires a running Python AI service reachable at PYTHON_BASE, started
 * with EMBEDDING_PROVIDER=test (the deterministic stub) — this script
 * never consumes real provider credits. Mirrors the other validate-
 * knowledge-*.mjs scripts' conventions exactly.
 *
 * Since the deterministic test embedding provider is hash-based (not
 * semantic), "relevance" here is engineered directly: candidates that
 * should score identically use identical text (guaranteeing
 * similarityScore parity so scope precedence is what decides order), and
 * candidates that should score differently use deliberately different
 * text. This is the same approach ai-service/tests/test_retrieval.py
 * already uses at the Python level — this suite exercises the same
 * guarantees through the real Node candidate-selection + Node<->Python +
 * Node re-verification pipeline.
 */
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import {
  Workspace,
  Property,
  Unit,
  Signal,
  KnowledgeDocument,
  KnowledgeChunk,
} from "../src/models/index.js";
import { verifyAndBuildResults, scopeLabelForChunk } from "../src/services/knowledgeRetrievalService.js";

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
  // Phase 7F-D1: this suite deliberately creates many documents with
  // identical/near-identical content across different scopes/versions to
  // test retrieval ranking (see the file's own header comment) — exactly
  // the pattern the new duplicate-content constraint would otherwise
  // reject. isTestData:true exempts synthetic fixtures like these from it.
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

async function retrieve(signalId, workspaceId) {
  return request("GET", `/signals/${signalId}/knowledge-retrieval?workspaceId=${workspaceId}`);
}

async function cleanup() {
  await connectDatabase();
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
    fail("Python AI service reachable", `${PYTHON_BASE} — is ai-service running with EMBEDDING_PROVIDER=test?`);
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(1);
  }

  // === Fixtures: workspace A (property A > unit A) + workspace B ===
  const wsA = trackCreated(await expectStatus("6G: workspace A create", "POST", "/workspaces", { name: `Phase6G WS A ${stamp}`, slug: `phase6g-ws-a-${stamp}` }, 201), "workspaceIds");
  const wsB = trackCreated(await expectStatus("6G: workspace B create", "POST", "/workspaces", { name: `Phase6G WS B ${stamp}`, slug: `phase6g-ws-b-${stamp}` }, 201), "workspaceIds");
  const propA = trackCreated(await expectStatus("6G: property A create", "POST", "/properties", { workspaceId: wsA, name: "Kolam Residency", code: `KRG${stamp}` }, 201), "propertyIds");
  const unitA = trackCreated(await expectStatus("6G: unit A create", "POST", "/units", { workspaceId: wsA, propertyId: propA, unitNumber: "204" }, 201), "unitIds");

  const QUERY_TEXT = "maintenance. AC not cooling. Warm air blowing from the unit.";

  // === 1-4: Unit/Property/Workspace knowledge ranks correctly + precedence ===
  const unitDocId = await createAndIndexDocument({
    workspaceId: wsA, propertyId: propA, unitId: unitA,
    title: "Example: Unit AC Note", documentType: "guideline", content: QUERY_TEXT,
  });
  const propertyDocId = await createAndIndexDocument({
    workspaceId: wsA, propertyId: propA,
    title: "Example: Property AC Procedure", documentType: "procedure", content: QUERY_TEXT,
  });
  const workspaceDocId = await createAndIndexDocument({
    workspaceId: wsA,
    title: "Example: Workspace AC Policy", documentType: "policy", content: QUERY_TEXT,
  });

  const signalFull = await createSignal({
    workspaceId: wsA, propertyId: propA, unitId: unitA,
    type: "maintenance", severity: "high", title: "AC not cooling", description: "Warm air blowing from the unit.",
  });

  const fullRes = await expectStatus("6G.1-4: retrieval for signal with full context", "GET", `/signals/${signalFull}/knowledge-retrieval?workspaceId=${wsA}`, null, 200);
  const fullResults = fullRes.json?.data?.results || [];
  const scopesInOrder = fullResults.map((r) => r.scope);
  if (fullResults.length === 3) ok("6G.1: relevant Unit knowledge is present in results");
  else fail("6G.1: relevant Unit knowledge is present in results", JSON.stringify(fullResults));
  if (scopesInOrder[0] === "unit") ok("6G.1: Unit-scope knowledge ranks first among tied similarity");
  else fail("6G.1: Unit-scope knowledge ranks first among tied similarity", JSON.stringify(scopesInOrder));
  if (scopesInOrder[1] === "property") ok("6G.2: Property-scope knowledge ranks second among tied similarity");
  else fail("6G.2: Property-scope knowledge ranks second among tied similarity", JSON.stringify(scopesInOrder));
  if (scopesInOrder[2] === "workspace") ok("6G.3: Workspace-scope knowledge ranks third among tied similarity");
  else fail("6G.3: Workspace-scope knowledge ranks third among tied similarity", JSON.stringify(scopesInOrder));
  if (JSON.stringify(scopesInOrder) === JSON.stringify(["unit", "property", "workspace"])) {
    ok("6G.4: Unit > Property > Workspace precedence holds end-to-end");
  } else {
    fail("6G.4: Unit > Property > Workspace precedence holds end-to-end", JSON.stringify(scopesInOrder));
  }
  const allRetrievalScoresPositive = fullResults.every((r) => typeof r.retrievalScore === "number" && r.retrievalScore > 0);
  const allSimilarityTied = new Set(fullResults.map((r) => r.similarityScore)).size === 1;
  if (allRetrievalScoresPositive && allSimilarityTied) {
    ok("6G: similarityScore tied across candidates, retrievalScore differs by scope boost only");
  } else {
    fail("6G: similarityScore tied across candidates, retrievalScore differs by scope boost only", JSON.stringify(fullResults));
  }

  // === 5: broader knowledge not blindly discarded ===
  const unrelatedUnitDocId = await createAndIndexDocument({
    workspaceId: wsA, propertyId: propA, unitId: unitA,
    title: "Example: Unrelated Unit Note", documentType: "guideline",
    content: "Example only. This document is about linen inventory counts and has nothing to do with the query.",
  });
  const relevantWorkspaceDocId = await createAndIndexDocument({
    workspaceId: wsA,
    title: "Example: Highly Relevant Workspace Policy", documentType: "policy", content: QUERY_TEXT,
  });
  const signalForBroaderTest = await createSignal({
    workspaceId: wsA, propertyId: propA, unitId: unitA,
    type: "maintenance", severity: "high", title: "AC not cooling", description: "Warm air blowing from the unit.",
  });
  // Isolate this check to just the two new docs by deleting the earlier three from contention —
  // instead, just inspect the ranked order and confirm the highly-relevant workspace chunk
  // outranks the unrelated unit chunk regardless of what else is present.
  const broaderRes = await request("GET", `/signals/${signalForBroaderTest}/knowledge-retrieval?workspaceId=${wsA}`);
  const broaderResults = broaderRes.json?.data?.results || [];
  const relevantWorkspaceRank = broaderResults.findIndex((r) => r.knowledgeDocumentId === relevantWorkspaceDocId);
  const unrelatedUnitRank = broaderResults.findIndex((r) => r.knowledgeDocumentId === unrelatedUnitDocId);
  if (relevantWorkspaceRank !== -1 && (unrelatedUnitRank === -1 || relevantWorkspaceRank < unrelatedUnitRank)) {
    ok("6G.5: a highly relevant Workspace chunk outranks a barely relevant Unit chunk");
  } else {
    fail("6G.5: a highly relevant Workspace chunk outranks a barely relevant Unit chunk", JSON.stringify({ relevantWorkspaceRank, unrelatedUnitRank }));
  }

  // === 6: top-K = 5 ===
  for (let i = 0; i < 4; i += 1) {
    await createAndIndexDocument({
      workspaceId: wsA, title: `Example: Extra Workspace Doc ${i} ${stamp}`, documentType: "guideline",
      content: `${QUERY_TEXT} (variant ${i})`,
    });
  }
  const topKRes = await request("GET", `/signals/${signalFull}/knowledge-retrieval?workspaceId=${wsA}`);
  const topKResults = topKRes.json?.data?.results || [];
  if (topKResults.length === 5) ok("6G.6: results are capped at top-K = 5");
  else fail("6G.6: results are capped at top-K = 5", `got ${topKResults.length}`);

  // === 7: candidate cap = 200 (bulk-inserted directly for speed) ===
  await connectDatabase();
  const capWs = trackCreated(await expectStatus("6G.7: cap-test workspace create", "POST", "/workspaces", { name: `Phase6G Cap WS ${stamp}`, slug: `phase6g-cap-ws-${stamp}` }, 201), "workspaceIds");
  const capDoc = trackCreated(
    await expectStatus("6G.7: cap-test document create", "POST", "/knowledge-documents", { workspaceId: capWs, title: "Cap test doc", documentType: "guideline", content: "placeholder", isTestData: true }, 201),
    "knowledgeDocumentIds",
  );
  const capChunks = [];
  for (let i = 0; i < 250; i += 1) {
    const vector = new Array(32).fill(0).map((_, idx) => Math.sin(i * 31 + idx));
    capChunks.push({
      documentId: capDoc, version: 1, workspaceId: capWs, status: "active",
      chunkIndex: i, section: "", text: `placeholder chunk ${i}`, embedding: vector, embeddingModel: "synthetic-test",
    });
  }
  await KnowledgeChunk.insertMany(capChunks);
  const capSignal = await createSignal({ workspaceId: capWs, type: "maintenance", title: "AC not cooling", description: "Warm air." });
  const capRes = await expectStatus("6G.7: retrieval succeeds despite 250 eligible chunks (cap applied)", "GET", `/signals/${capSignal}/knowledge-retrieval?workspaceId=${capWs}`, null, 200);
  if ((capRes.json?.data?.results || []).length <= 5) ok("6G.7: candidate cap prevented an oversized Python request from failing");
  else fail("6G.7: candidate cap prevented an oversized Python request from failing");

  // === 8: deterministic tie-breaking ===
  const tie1 = await retrieve(signalFull, wsA);
  const tie2 = await retrieve(signalFull, wsA);
  // Compare only `results` — `retrievedAt` is a fresh timestamp on every call by design.
  if (JSON.stringify(tie1.json?.data?.results) === JSON.stringify(tie2.json?.data?.results)) {
    ok("6G.8: repeated retrieval returns identical, deterministically ordered results");
  } else {
    fail("6G.8: repeated retrieval returns identical, deterministically ordered results");
  }

  // === 9-12: status / effective-date filtering ===
  const futureDocId = await createAndIndexDocument({
    workspaceId: wsA, title: "Example: Future Policy", documentType: "policy", content: QUERY_TEXT,
    effectiveFrom: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
  });
  const expiredDocId = await createAndIndexDocument({
    workspaceId: wsA, title: "Example: Expired Policy", documentType: "policy", content: QUERY_TEXT,
    effectiveFrom: new Date(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000).toISOString(),
    effectiveTo: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
  });
  const archivedDocId = await createAndIndexDocument({
    workspaceId: wsA, title: "Example: Archived Guideline", documentType: "guideline", content: QUERY_TEXT, status: "archived",
  });

  const filterSignal = await createSignal({ workspaceId: wsA, type: "maintenance", title: "AC not cooling", description: "Warm air blowing from the unit." });
  const filterRes = await request("GET", `/signals/${filterSignal}/knowledge-retrieval?workspaceId=${wsA}`);
  const filterDocIds = (filterRes.json?.data?.results || []).map((r) => r.knowledgeDocumentId);

  if (!filterDocIds.includes(futureDocId)) ok("6G.10: future-effective knowledge excluded");
  else fail("6G.10: future-effective knowledge excluded");
  if (!filterDocIds.includes(expiredDocId)) ok("6G.11: expired knowledge excluded");
  else fail("6G.11: expired knowledge excluded");
  if (!filterDocIds.includes(archivedDocId)) ok("6G.12: inactive (archived) knowledge excluded");
  else fail("6G.12: inactive (archived) knowledge excluded");
  if (filterDocIds.includes(workspaceDocId)) ok("6G.9: active, currently-effective knowledge is included");
  else fail("6G.9: active, currently-effective knowledge is included");

  // === 13: old/invalid version cannot leak ===
  const v1DocId = await createAndIndexDocument({
    workspaceId: wsA, title: "Example: Escalation SOP v1", documentType: "sop", content: QUERY_TEXT,
  });
  const v2DocId = await createAndIndexDocument({
    workspaceId: wsA, title: "Example: Escalation SOP v2", documentType: "sop", content: QUERY_TEXT,
    version: 2, supersedesId: v1DocId,
  });
  // Mark v1 superseded, then refresh (re-chunk + re-embed) so its chunks'
  // denormalized status actually reflects the change — chunks snapshot
  // their parent document's fields at (re-)chunk time, they don't live-join.
  await expectStatus("6G.13: mark v1 superseded", "PATCH", `/knowledge-documents/${v1DocId}?workspaceId=${wsA}`, { status: "superseded" }, 200);
  await expectStatus("6G.13: re-chunk v1 to refresh denormalized status", "POST", `/knowledge-documents/${v1DocId}/chunks?workspaceId=${wsA}`, null, 201);
  await expectStatus("6G.13: re-embed v1 (re-chunk cleared its embedding)", "POST", `/knowledge-documents/${v1DocId}/embeddings?workspaceId=${wsA}`, null, 201);

  const versionSignal = await createSignal({ workspaceId: wsA, type: "maintenance", title: "AC not cooling", description: "Warm air blowing from the unit." });
  const versionRes = await request("GET", `/signals/${versionSignal}/knowledge-retrieval?workspaceId=${wsA}`);
  const versionDocIds = (versionRes.json?.data?.results || []).map((r) => r.knowledgeDocumentId);
  if (!versionDocIds.includes(v1DocId) && versionDocIds.includes(v2DocId)) {
    ok("6G.13: superseded v1 excluded, active v2 included — no version leak");
  } else {
    fail("6G.13: superseded v1 excluded, active v2 included — no version leak", JSON.stringify(versionDocIds));
  }

  // === 14: cross-workspace knowledge never enters candidates ===
  const wsBDocId = await createAndIndexDocument({ workspaceId: wsB, title: "B's own policy", documentType: "policy", content: QUERY_TEXT });
  const wsASignalForCrossCheck = await createSignal({ workspaceId: wsA, type: "maintenance", title: "AC not cooling", description: "Warm air blowing from the unit." });
  const crossRes = await request("GET", `/signals/${wsASignalForCrossCheck}/knowledge-retrieval?workspaceId=${wsA}`);
  const crossDocIds = (crossRes.json?.data?.results || []).map((r) => r.knowledgeDocumentId);
  if (!crossDocIds.includes(wsBDocId)) ok("6G.14: workspace B's knowledge never appears in workspace A's candidates");
  else fail("6G.14: workspace B's knowledge never appears in workspace A's candidates");

  // === 15-17: Python cannot establish tenant authority; Node validates/rejects unsafe results ===
  const eligibleChunk = await KnowledgeChunk.findOne({ documentId: workspaceDocId });
  const eligibleMap = new Map([[String(eligibleChunk._id), eligibleChunk]]);

  const spoofedChunkIdResult = verifyAndBuildResults(
    [{ chunkId: "000000000000000000000000", scope: "workspace", similarityScore: 0.99, retrievalScore: 0.99 }],
    eligibleMap,
  );
  if (spoofedChunkIdResult.length === 0) ok("6G.15/16: a chunkId Python returns that Node never sent is dropped, not trusted");
  else fail("6G.15/16: a chunkId Python returns that Node never sent is dropped, not trusted");

  const spoofedScopeResult = verifyAndBuildResults(
    [{ chunkId: String(eligibleChunk._id), scope: "unit", similarityScore: 0.99, retrievalScore: 1.5 }],
    eligibleMap,
  );
  if (spoofedScopeResult.length === 0) ok("6G.17: a mismatched scope echoed by Python is rejected, not trusted");
  else fail("6G.17: a mismatched scope echoed by Python is rejected, not trusted");

  const nonFiniteScoreResult = verifyAndBuildResults(
    [{ chunkId: String(eligibleChunk._id), scope: scopeLabelForChunk(eligibleChunk), similarityScore: Number.POSITIVE_INFINITY, retrievalScore: 1 }],
    eligibleMap,
  );
  if (nonFiniteScoreResult.length === 0) ok("6G.17: a non-finite score from Python is rejected safely");
  else fail("6G.17: a non-finite score from Python is rejected safely");

  const validResult = verifyAndBuildResults(
    [{ chunkId: String(eligibleChunk._id), scope: scopeLabelForChunk(eligibleChunk), similarityScore: 0.5, retrievalScore: 0.5 }],
    eligibleMap,
  );
  if (validResult.length === 1 && validResult[0].knowledgeDocumentId === String(eligibleChunk.documentId)) {
    ok("6G.16: a genuinely eligible chunkId is accepted and enriched from Node's own data");
  } else {
    fail("6G.16: a genuinely eligible chunkId is accepted and enriched from Node's own data");
  }
  await disconnectDatabase();

  // === 18-20: missing operational context handled gracefully ===
  const signalPropertyOnly = await createSignal({ workspaceId: wsA, propertyId: propA, type: "maintenance", title: "AC not cooling", description: "Warm air blowing from the unit." });
  const propertyOnlyRes = await expectStatus("6G.18: retrieval for signal with property but no unit", "GET", `/signals/${signalPropertyOnly}/knowledge-retrieval?workspaceId=${wsA}`, null, 200);
  const propertyOnlyDocIds = (propertyOnlyRes.json?.data?.results || []).map((r) => r.knowledgeDocumentId);
  if (!propertyOnlyDocIds.includes(unitDocId)) ok("6G.18: unit-scoped knowledge excluded when Signal has no unit");
  else fail("6G.18: unit-scoped knowledge excluded when Signal has no unit", JSON.stringify(propertyOnlyDocIds));
  if (propertyOnlyDocIds.includes(propertyDocId)) ok("6G.18: property-scoped knowledge still included when property is present");
  else fail("6G.18: property-scoped knowledge still included when property is present");

  const signalNoProperty = await createSignal({ workspaceId: wsA, type: "maintenance", title: "AC not cooling", description: "Warm air blowing from the unit." });
  const noPropertyRes = await expectStatus("6G.19: retrieval for signal with no property", "GET", `/signals/${signalNoProperty}/knowledge-retrieval?workspaceId=${wsA}`, null, 200);
  const noPropertyDocIds = (noPropertyRes.json?.data?.results || []).map((r) => r.knowledgeDocumentId);
  if (!noPropertyDocIds.includes(unitDocId) && !noPropertyDocIds.includes(propertyDocId)) {
    ok("6G.19: unit- and property-scoped knowledge excluded when Signal has no property");
  } else {
    fail("6G.19: unit- and property-scoped knowledge excluded when Signal has no property", JSON.stringify(noPropertyDocIds));
  }
  if (noPropertyDocIds.includes(workspaceDocId)) ok("6G.19: workspace-scoped knowledge still included");
  else fail("6G.19: workspace-scoped knowledge still included");

  // guest/stay presence or absence has no bearing on retrieval scope at all —
  // this confirms the pipeline degrades gracefully (no crash) either way.
  const signalNoGuestStay = await createSignal({
    workspaceId: wsA, propertyId: propA, unitId: unitA,
    type: "maintenance", title: "AC not cooling", description: "Warm air blowing from the unit.",
  });
  await expectStatus("6G.20: retrieval for signal with no guest/stay does not error", "GET", `/signals/${signalNoGuestStay}/knowledge-retrieval?workspaceId=${wsA}`, null, 200);

  // === 21: empty candidate result handled gracefully ===
  const emptyWs = trackCreated(await expectStatus("6G.21: empty-workspace create", "POST", "/workspaces", { name: `Phase6G Empty WS ${stamp}`, slug: `phase6g-empty-ws-${stamp}` }, 201), "workspaceIds");
  const emptySignal = await createSignal({ workspaceId: emptyWs, type: "maintenance", title: "AC not cooling", description: "Warm air." });
  const emptyRes = await expectStatus("6G.21: retrieval with zero eligible knowledge", "GET", `/signals/${emptySignal}/knowledge-retrieval?workspaceId=${emptyWs}`, null, 200);
  if (Array.isArray(emptyRes.json?.data?.results) && emptyRes.json.data.results.length === 0) {
    ok("6G.21: empty candidate set returns an empty result list, not an error");
  } else {
    fail("6G.21: empty candidate set returns an empty result list, not an error", JSON.stringify(emptyRes.json));
  }

  // === Tenant isolation on the endpoint itself ===
  await expectStatus("6G: cross-workspace signal returns 404", "GET", `/signals/${signalFull}/knowledge-retrieval?workspaceId=${wsB}`, null, 404);
  await expectStatus("6G: missing workspaceId returns 400", "GET", `/signals/${signalFull}/knowledge-retrieval`, null, 400);

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
