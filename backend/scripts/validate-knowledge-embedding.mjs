/**
 * Phase 6E validation: Node -> Python embedding generation + persistence.
 *
 * Requires a running Python AI service (ai-service/) reachable at
 * PYTHON_BASE, started with EMBEDDING_PROVIDER=test (the deterministic
 * stub — never calls Gemini or any other model), matching the exact
 * discipline validate-ai-service.mjs already established for the
 * intelligence path: this script never consumes real provider credits.
 *
 * Exercises POST /api/knowledge-documents/:documentId/embeddings end to end
 * (real HTTP, real MongoDB, real Node->Python call) — the Node->Python
 * flow, document/version isolation, tenant isolation, data integrity, and
 * the embedding boundary (Python is the only embedding caller, no MongoDB
 * in Python, no Gemini SDK in Node).
 */
import { readFileSync } from "node:fs";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { Workspace, Property, KnowledgeDocument, KnowledgeChunk } from "../src/models/index.js";

const BASE = process.env.API_BASE || "http://localhost:5002/api";
const PYTHON_BASE = process.env.PYTHON_BASE || "http://localhost:8000";
const CROSS = [403, 404];
const TEST_EMBEDDING_MODEL = "deterministic-embedding-v1";
const TEST_EMBEDDING_DIMENSIONS = 32;

const created = {
  workspaceIds: [],
  propertyIds: [],
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
  if (result.status === expectedStatus) {
    ok(name, `HTTP ${result.status}`);
  } else {
    fail(name, `expected ${expectedStatus}, got ${result.status}: ${JSON.stringify(result.json)}`);
  }
  return result;
}

async function expectStatusOneOf(name, method, path, body, expectedStatuses) {
  const result = await request(method, path, body);
  if (expectedStatuses.includes(result.status)) {
    ok(name, `HTTP ${result.status}`);
  } else {
    fail(
      name,
      `expected one of [${expectedStatuses.join(", ")}], got ${result.status}: ${JSON.stringify(
        result.json,
      )}`,
    );
  }
  return result;
}

function trackCreated(result, bucket) {
  const id = result?.json?.data?._id;
  if (id && !created[bucket].includes(id)) created[bucket].push(id);
  return id;
}

async function getChunks(documentId, workspaceId) {
  const res = await request("GET", `/knowledge-documents/${documentId}/chunks?workspaceId=${workspaceId}&limit=200`);
  return res.json?.data || [];
}

async function createDocument(body) {
  const res = await expectStatus(`fixture: create "${body.title}"`, "POST", "/knowledge-documents", body, 201);
  return trackCreated(res, "knowledgeDocumentIds");
}

async function cleanup() {
  await connectDatabase();
  await KnowledgeChunk.deleteMany({ documentId: { $in: created.knowledgeDocumentIds } });
  await KnowledgeDocument.deleteMany({ _id: { $in: created.knowledgeDocumentIds } });
  await Property.deleteMany({ _id: { $in: created.propertyIds } });
  await Workspace.deleteMany({ _id: { $in: created.workspaceIds } });
  await disconnectDatabase();
}

async function main() {
  const stamp = Date.now();

  const healthCheck = await fetch(`${PYTHON_BASE}/v1/health`).then((r) => r.json()).catch(() => null);
  if (healthCheck?.status === "healthy") {
    ok("Python AI service reachable", PYTHON_BASE);
  } else {
    fail("Python AI service reachable", `${PYTHON_BASE} — is ai-service running with EMBEDDING_PROVIDER=test?`);
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(1);
  }

  const wsA = trackCreated(
    await expectStatus("6E: workspace A create", "POST", "/workspaces", { name: `Phase6E WS A ${stamp}`, slug: `phase6e-ws-a-${stamp}` }, 201),
    "workspaceIds",
  );
  const wsB = trackCreated(
    await expectStatus("6E: workspace B create", "POST", "/workspaces", { name: `Phase6E WS B ${stamp}`, slug: `phase6e-ws-b-${stamp}` }, 201),
    "workspaceIds",
  );
  const propA = trackCreated(
    await expectStatus("6E: property A create", "POST", "/properties", { workspaceId: wsA, name: "Kolam Residency", code: `KRE${stamp}` }, 201),
    "propertyIds",
  );

  // =========================================================
  // NODE -> PYTHON
  // =========================================================
  const docId = await createDocument({
    workspaceId: wsA,
    propertyId: propA,
    title: "Example: Escalation SOP",
    documentType: "sop",
    content: "## Escalation\n\nEscalate high-severity signals to on-call staff immediately.\n\n## Contacts\n\nUse the on-call rotation for after-hours issues.\n",
  });
  await expectStatus("6E fixture: chunk the document", "POST", `/knowledge-documents/${docId}/chunks?workspaceId=${wsA}`, null, 201);
  const chunksBefore = await getChunks(docId, wsA);
  if (chunksBefore.length === 2 && chunksBefore.every((c) => c.embedding === undefined)) {
    ok("6E fixture: document chunked, no embeddings yet");
  } else {
    fail("6E fixture: document chunked, no embeddings yet", JSON.stringify(chunksBefore.map((c) => ({ section: c.section, embedding: c.embedding }))));
  }

  const embedRes = await expectStatus(
    "6E NODE->PYTHON: embed the document",
    "POST",
    `/knowledge-documents/${docId}/embeddings?workspaceId=${wsA}`,
    null,
    201,
  );
  if (embedRes.json?.data?.chunkCount === 2) ok("6E NODE->PYTHON: response reports correct chunk count");
  else fail("6E NODE->PYTHON: response reports correct chunk count", JSON.stringify(embedRes.json?.data));
  if (embedRes.json?.data?.embeddingModel === TEST_EMBEDDING_MODEL) {
    ok("6E NODE->PYTHON: response reports the deterministic test embedding model");
  } else {
    fail("6E NODE->PYTHON: response reports the deterministic test embedding model", JSON.stringify(embedRes.json?.data));
  }

  const chunksAfter = await getChunks(docId, wsA);
  const allEmbedded = chunksAfter.every(
    (c) => Array.isArray(c.embedding) && c.embedding.length === TEST_EMBEDDING_DIMENSIONS && c.embeddingModel === TEST_EMBEDDING_MODEL,
  );
  if (allEmbedded) ok("6E NODE->PYTHON: every chunk persisted an embedding + embeddingModel");
  else fail("6E NODE->PYTHON: every chunk persisted an embedding + embeddingModel", JSON.stringify(chunksAfter));

  const allNumeric = chunksAfter.every((c) => c.embedding.every((v) => typeof v === "number" && Number.isFinite(v)));
  if (allNumeric) ok("6E NODE->PYTHON: every embedding value is finite numeric data");
  else fail("6E NODE->PYTHON: every embedding value is finite numeric data");

  const dims = new Set(chunksAfter.map((c) => c.embedding.length));
  if (dims.size === 1) ok("6E NODE->PYTHON: all vectors share identical dimensionality");
  else fail("6E NODE->PYTHON: all vectors share identical dimensionality", JSON.stringify([...dims]));

  // =========================================================
  // DOCUMENT / VERSION
  // =========================================================
  const noChunksDocId = await createDocument({
    workspaceId: wsA,
    title: "Example: Unchunked Document",
    documentType: "guideline",
    content: "Example only. Never chunked before embedding is attempted.",
  });
  await expectStatus(
    "6E DOC/VERSION: document with no chunks is rejected",
    "POST",
    `/knowledge-documents/${noChunksDocId}/embeddings?workspaceId=${wsA}`,
    null,
    400,
  );
  const noChunksAfter = await getChunks(noChunksDocId, wsA);
  if (noChunksAfter.length === 0) ok("6E DOC/VERSION: no chunks were silently created for the rejected request");
  else fail("6E DOC/VERSION: no chunks were silently created for the rejected request");

  const v2Content = "## Escalation v2\n\nEscalate within 15 minutes for high-severity signals.\n";
  const v2Id = await createDocument({
    workspaceId: wsA,
    title: "Example: Escalation SOP v2",
    documentType: "sop",
    content: v2Content,
    version: 2,
    supersedesId: docId,
  });
  await expectStatus("6E DOC/VERSION: chunk v2", "POST", `/knowledge-documents/${v2Id}/chunks?workspaceId=${wsA}`, null, 201);
  await expectStatus("6E DOC/VERSION: embed v2", "POST", `/knowledge-documents/${v2Id}/embeddings?workspaceId=${wsA}`, null, 201);

  const v1AfterV2 = await getChunks(docId, wsA);
  if (JSON.stringify(v1AfterV2.map((c) => c.embedding)) === JSON.stringify(chunksAfter.map((c) => c.embedding))) {
    ok("6E DOC/VERSION: v1 embeddings unchanged after embedding v2");
  } else {
    fail("6E DOC/VERSION: v1 embeddings unchanged after embedding v2");
  }
  const v2Chunks = await getChunks(v2Id, wsA);
  const v1OwnedCorrectly = v1AfterV2.every((c) => String(c.documentId) === String(docId));
  const v2OwnedCorrectly = v2Chunks.every((c) => String(c.documentId) === String(v2Id));
  if (v1OwnedCorrectly && v2OwnedCorrectly) ok("6E DOC/VERSION: chunk documentId/version ownership maintained across versions");
  else fail("6E DOC/VERSION: chunk documentId/version ownership maintained across versions");

  // Re-embedding: same chunk _ids, deterministic identical vectors, no duplicates.
  const rechunkCountBefore = chunksAfter.length;
  const reembedRes = await expectStatus(
    "6E DOC/VERSION: re-embed v1 (same chunks, unchanged content)",
    "POST",
    `/knowledge-documents/${docId}/embeddings?workspaceId=${wsA}`,
    null,
    201,
  );
  const chunksAfterReembed = await getChunks(docId, wsA);
  if (chunksAfterReembed.length === rechunkCountBefore) ok("6E DOC/VERSION: re-embedding creates no duplicate chunks");
  else fail("6E DOC/VERSION: re-embedding creates no duplicate chunks", `before=${rechunkCountBefore} after=${chunksAfterReembed.length}`);

  const sameIds = chunksAfterReembed.every((c, i) => String(c._id) === String(chunksAfter[i]._id));
  if (sameIds) ok("6E DOC/VERSION: re-embedding updates the existing chunk documents (same _id)");
  else fail("6E DOC/VERSION: re-embedding updates the existing chunk documents (same _id)");

  if (JSON.stringify(chunksAfterReembed.map((c) => c.embedding)) === JSON.stringify(chunksAfter.map((c) => c.embedding))) {
    ok("6E DOC/VERSION: re-embedding is deterministic under the test provider (identical vectors)");
  } else {
    fail("6E DOC/VERSION: re-embedding is deterministic under the test provider (identical vectors)");
  }
  if (embedRes.json?.data && reembedRes.json?.data?.chunkCount === embedRes.json?.data?.chunkCount) {
    ok("6E DOC/VERSION: re-embed response reports the same chunk count");
  } else {
    fail("6E DOC/VERSION: re-embed response reports the same chunk count");
  }

  // =========================================================
  // TENANT ISOLATION
  // =========================================================
  const docBId = trackCreated(
    await expectStatus("6E ISOLATION: workspace B document create", "POST", "/knowledge-documents", { workspaceId: wsB, title: "B's own SOP", documentType: "sop", content: "Example only. B's content." }, 201),
    "knowledgeDocumentIds",
  );
  await expectStatus("6E ISOLATION: chunk B's document", "POST", `/knowledge-documents/${docBId}/chunks?workspaceId=${wsB}`, null, 201);

  await expectStatusOneOf(
    "6E ISOLATION: A cannot embed B's document",
    "POST",
    `/knowledge-documents/${docBId}/embeddings?workspaceId=${wsA}`,
    null,
    CROSS,
  );
  await expectStatus(
    "6E ISOLATION: unknown documentId returns 404",
    "POST",
    "/knowledge-documents/000000000000000000000000/embeddings?workspaceId=" + wsA,
    null,
    404,
  );
  await expectStatus(
    "6E ISOLATION: malformed documentId returns 400",
    "POST",
    `/knowledge-documents/not-an-id/embeddings?workspaceId=${wsA}`,
    null,
    400,
  );

  const bChunksAfterAttack = await getChunks(docBId, wsB);
  if (bChunksAfterAttack.every((c) => c.embedding === undefined)) {
    ok("6E ISOLATION: A's blocked embed attempt left B's chunks untouched (no embeddings)");
  } else {
    fail("6E ISOLATION: A's blocked embed attempt left B's chunks untouched (no embeddings)");
  }

  // =========================================================
  // DATA INTEGRITY
  // =========================================================
  const preservedFields = (chunk) => ({
    chunkIndex: chunk.chunkIndex,
    documentId: chunk.documentId,
    version: chunk.version,
    section: chunk.section,
    text: chunk.text,
    workspaceId: chunk.workspaceId,
    propertyId: chunk.propertyId,
    unitId: chunk.unitId,
    status: chunk.status,
  });
  const beforeShape = JSON.stringify(chunksBefore.map(preservedFields));
  const afterShape = JSON.stringify(chunksAfter.map(preservedFields));
  if (beforeShape === afterShape) {
    ok("6E DATA INTEGRITY: chunkIndex/documentId/version/section/text/denormalized scope all unchanged by embedding");
  } else {
    fail("6E DATA INTEGRITY: chunkIndex/documentId/version/section/text/denormalized scope all unchanged by embedding", `before=${beforeShape} after=${afterShape}`);
  }

  // =========================================================
  // EMBEDDING BOUNDARY
  // =========================================================
  const nodeSourceFiles = [
    "../src/services/knowledgeEmbeddingService.js",
    "../src/services/ai/aiServiceClient.js",
    "../src/services/knowledge/embeddingValidation.js",
  ].map((p) => readFileSync(new URL(p, import.meta.url), "utf8"));
  const forbiddenNodeImport = /@google\/genai|GoogleGenAI|from ["']openai["']|pymongo|mongodb\+srv/i;
  if (nodeSourceFiles.every((src) => !forbiddenNodeImport.test(src))) {
    ok("6E EMBEDDING BOUNDARY: Node embedding code imports no Gemini/embedding SDK of its own");
  } else {
    fail("6E EMBEDDING BOUNDARY: Node embedding code imports no Gemini/embedding SDK of its own");
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
