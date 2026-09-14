/**
 * Phase 6D validation: section-aware KnowledgeDocument chunking.
 *
 * Exercises POST/GET /api/knowledge-documents/:documentId/chunks end to end
 * (real HTTP, real MongoDB) — basic chunking, section detection, numbered-
 * procedure preservation, fixed-size fallback, determinism, version
 * isolation, tenant isolation, denormalization, and the embedding boundary
 * (no embeddings, no embedding provider, no Python involvement).
 *
 * Mirrors validate-knowledge.mjs/validate-knowledge-authoring.mjs's own
 * conventions exactly so it can run against the same already-running
 * backend instance.
 */
import { readFileSync } from "node:fs";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { Workspace, Property, KnowledgeDocument, KnowledgeChunk } from "../src/models/index.js";

const BASE = process.env.API_BASE || "http://localhost:5002/api";
const CROSS = [403, 404];

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

async function createDocument(body) {
  const res = await expectStatus(
    `fixture: create "${body.title}"`,
    "POST",
    "/knowledge-documents",
    body,
    201,
  );
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

const HOUSEKEEPING_SOP = `# Housekeeping SOP

## Check-in Procedure

1. Verify guest identity.
2. Confirm booking.
3. Provide access information.

## Checkout Procedure

1. Inspect the unit.
2. Record damages.
3. Update unit status.
`;

function buildOversizedProcedure() {
  const steps = [];
  for (let i = 1; i <= 60; i += 1) {
    steps.push(`${i}. Perform inspection step number ${i} of the extended maintenance checklist.`);
  }
  return `## Extended Maintenance Checklist\n\n${steps.join("\n")}\n`;
}

async function main() {
  const stamp = Date.now();

  const wsA = trackCreated(
    await expectStatus(
      "6D: workspace A create",
      "POST",
      "/workspaces",
      { name: `Phase6D WS A ${stamp}`, slug: `phase6d-ws-a-${stamp}` },
      201,
    ),
    "workspaceIds",
  );
  const wsB = trackCreated(
    await expectStatus(
      "6D: workspace B create",
      "POST",
      "/workspaces",
      { name: `Phase6D WS B ${stamp}`, slug: `phase6d-ws-b-${stamp}` },
      201,
    ),
    "workspaceIds",
  );
  const propA = trackCreated(
    await expectStatus(
      "6D: property A create",
      "POST",
      "/properties",
      { workspaceId: wsA, name: "Kolam Residency", code: `KRD${stamp}` },
      201,
    ),
    "propertyIds",
  );

  // =========================================================
  // BASIC CHUNKING
  // =========================================================
  const sopId = await createDocument({
    workspaceId: wsA,
    propertyId: propA,
    title: "Example: Housekeeping SOP",
    documentType: "sop",
    content: HOUSEKEEPING_SOP,
  });

  const chunkRes = await expectStatus(
    "6D BASIC: structured document creates chunks",
    "POST",
    `/knowledge-documents/${sopId}/chunks?workspaceId=${wsA}`,
    null,
    201,
  );
  const chunks = chunkRes.json?.data?.chunks || [];
  if (chunks.length === 2) ok("6D BASIC: expected chunk count for two procedures");
  else fail("6D BASIC: expected chunk count for two procedures", `got ${chunks.length}`);

  if (chunks[0]?.chunkIndex === 0) ok("6D BASIC: chunkIndex starts at 0");
  else fail("6D BASIC: chunkIndex starts at 0", JSON.stringify(chunks[0]));

  const isSequential = chunks.every((c, i) => c.chunkIndex === i);
  if (isSequential) ok("6D BASIC: chunkIndex is sequential with no gaps");
  else fail("6D BASIC: chunkIndex is sequential with no gaps", JSON.stringify(chunks.map((c) => c.chunkIndex)));

  const allNonEmpty = chunks.every((c) => typeof c.text === "string" && c.text.trim().length > 0);
  if (allNonEmpty) ok("6D BASIC: every chunk's text is non-empty");
  else fail("6D BASIC: every chunk's text is non-empty");

  const sectionOrder = chunks.map((c) => c.section);
  if (JSON.stringify(sectionOrder) === JSON.stringify(["Check-in Procedure", "Checkout Procedure"])) {
    ok("6D BASIC: source ordering preserved (sections in document order)");
  } else {
    fail("6D BASIC: source ordering preserved (sections in document order)", JSON.stringify(sectionOrder));
  }

  const docAfterChunk = await request("GET", `/knowledge-documents/${sopId}?workspaceId=${wsA}`);
  if (docAfterChunk.json?.data?.content === HOUSEKEEPING_SOP) {
    ok("6D BASIC: canonical KnowledgeDocument.content unchanged after chunking");
  } else {
    fail("6D BASIC: canonical KnowledgeDocument.content unchanged after chunking");
  }

  // =========================================================
  // SECTION AWARENESS
  // =========================================================
  if (chunks[0]?.section === "Check-in Procedure" && chunks[1]?.section === "Checkout Procedure") {
    ok("6D SECTION: Markdown headings detected and recorded on the right chunks");
  } else {
    fail("6D SECTION: Markdown headings detected and recorded on the right chunks", JSON.stringify(chunks.map((c) => c.section)));
  }
  if (chunks[0].section !== chunks[1].section) ok("6D SECTION: different sections remain distinguishable");
  else fail("6D SECTION: different sections remain distinguishable");

  const numberedHeadingDoc = await createDocument({
    workspaceId: wsA,
    title: "Example: Numbered Heading Document",
    documentType: "guideline",
    content: "1. Housekeeping\n\nGeneral housekeeping guidance for staff.\n\n2. Check-in\n\nGeneral check-in guidance for staff.\n",
  });
  const numberedRes = await expectStatus(
    "6D SECTION: numbered-heading document chunks",
    "POST",
    `/knowledge-documents/${numberedHeadingDoc}/chunks?workspaceId=${wsA}`,
    null,
    201,
  );
  const numberedChunks = numberedRes.json?.data?.chunks || [];
  const numberedSections = numberedChunks.map((c) => c.section);
  if (JSON.stringify(numberedSections) === JSON.stringify(["Housekeeping", "Check-in"])) {
    ok("6D SECTION: numbered headings ('1. Housekeeping') detected, not treated as steps");
  } else {
    fail("6D SECTION: numbered headings ('1. Housekeeping') detected, not treated as steps", JSON.stringify(numberedSections));
  }

  // =========================================================
  // NUMBERED PROCEDURES
  // =========================================================
  if (chunks[0].text === "1. Verify guest identity.\n2. Confirm booking.\n3. Provide access information.") {
    ok("6D PROCEDURE: small procedure stays together as one chunk when under the limit");
  } else {
    fail("6D PROCEDURE: small procedure stays together as one chunk when under the limit", JSON.stringify(chunks[0].text));
  }

  const oversizedId = await createDocument({
    workspaceId: wsA,
    title: "Example: Extended Maintenance Checklist",
    documentType: "procedure",
    content: buildOversizedProcedure(),
  });
  const oversizedRes = await expectStatus(
    "6D PROCEDURE: oversized procedure chunks",
    "POST",
    `/knowledge-documents/${oversizedId}/chunks?workspaceId=${wsA}`,
    null,
    201,
  );
  const oversizedChunks = oversizedRes.json?.data?.chunks || [];
  if (oversizedChunks.length > 1) ok("6D PROCEDURE: oversized procedure splits into multiple chunks");
  else fail("6D PROCEDURE: oversized procedure splits into multiple chunks", `got ${oversizedChunks.length}`);

  const allUnderMax = oversizedChunks.every((c) => c.text.length <= 2000);
  if (allUnderMax) ok("6D PROCEDURE: every chunk respects the hard maximum");
  else fail("6D PROCEDURE: every chunk respects the hard maximum", JSON.stringify(oversizedChunks.map((c) => c.text.length)));

  const noMidStepCuts = oversizedChunks.every((c) =>
    c.text
      .split("\n")
      .every((line) => /^\d+\. Perform inspection step number \d+ of the extended maintenance checklist\.$/.test(line)),
  );
  if (noMidStepCuts) ok("6D PROCEDURE: split preserves whole steps — no chunk starts or ends mid-step");
  else fail("6D PROCEDURE: split preserves whole steps — no chunk starts or ends mid-step");

  const sameSectionThroughout = oversizedChunks.every((c) => c.section === "Extended Maintenance Checklist");
  if (sameSectionThroughout) ok("6D PROCEDURE: section label preserved across all split chunks");
  else fail("6D PROCEDURE: section label preserved across all split chunks");

  // =========================================================
  // FALLBACK (unstructured documents)
  // =========================================================
  const unstructuredId = await createDocument({
    workspaceId: wsA,
    title: "Example: Unstructured Note",
    documentType: "guideline",
    content: "Example only. This is a short, plain, unstructured note with no headings at all.",
  });
  const unstructuredRes = await expectStatus(
    "6D FALLBACK: unstructured document chunks",
    "POST",
    `/knowledge-documents/${unstructuredId}/chunks?workspaceId=${wsA}`,
    null,
    201,
  );
  const unstructuredChunks = unstructuredRes.json?.data?.chunks || [];
  if (unstructuredChunks.length === 1 && unstructuredChunks[0].section === "") {
    ok("6D FALLBACK: unstructured document uses fallback chunking (single chunk, no section)");
  } else {
    fail("6D FALLBACK: unstructured document uses fallback chunking (single chunk, no section)", JSON.stringify(unstructuredChunks));
  }

  const giantLine = "x".repeat(5000);
  const giantId = await createDocument({
    workspaceId: wsA,
    title: "Example: Unbroken Long Text",
    documentType: "guideline",
    content: giantLine,
  });
  const giantRes = await expectStatus(
    "6D FALLBACK: unbroken oversized text chunks",
    "POST",
    `/knowledge-documents/${giantId}/chunks?workspaceId=${wsA}`,
    null,
    201,
  );
  const giantChunks = giantRes.json?.data?.chunks || [];
  if (giantChunks.every((c) => c.text.length <= 2000)) ok("6D FALLBACK: hard split respects the hard maximum");
  else fail("6D FALLBACK: hard split respects the hard maximum", JSON.stringify(giantChunks.map((c) => c.text.length)));
  if (giantChunks.every((c) => c.text.length > 0)) ok("6D FALLBACK: no empty chunks in hard split");
  else fail("6D FALLBACK: no empty chunks in hard split");
  if (giantChunks.map((c) => c.text).join("") === giantLine) {
    ok("6D FALLBACK: source text preserved in order (exact reconstruction)");
  } else {
    fail("6D FALLBACK: source text preserved in order (exact reconstruction)");
  }

  // =========================================================
  // DETERMINISM
  // =========================================================
  const rechunkRes = await expectStatus(
    "6D DETERMINISM: re-chunk unchanged document",
    "POST",
    `/knowledge-documents/${sopId}/chunks?workspaceId=${wsA}`,
    null,
    201,
  );
  const rechunked = rechunkRes.json?.data?.chunks || [];
  if (JSON.stringify(rechunked.map((c) => ({ section: c.section, text: c.text }))) ===
    JSON.stringify(chunks.map((c) => ({ section: c.section, text: c.text })))) {
    ok("6D DETERMINISM: identical content produces identical chunks");
  } else {
    fail("6D DETERMINISM: identical content produces identical chunks");
  }
  if (rechunked.length === chunks.length) {
    ok("6D DETERMINISM: re-chunking does not create duplicates");
  } else {
    fail("6D DETERMINISM: re-chunking does not create duplicates", `before=${chunks.length} after=${rechunked.length}`);
  }
  const sameIds = rechunked.every((c, i) => String(c._id) === String(chunks[i]._id));
  if (sameIds) ok("6D DETERMINISM: chunk identity (and index) stable across re-chunk — updated in place, not replaced");
  else fail("6D DETERMINISM: chunk identity (and index) stable across re-chunk — updated in place, not replaced");

  // =========================================================
  // VERSION ISOLATION
  // =========================================================
  const v2Content = "## Escalation Policy v2\n\nEscalate high-severity signals within 15 minutes.\n";
  const v2Id = await createDocument({
    workspaceId: wsA,
    title: "Example: Escalation Policy v2",
    documentType: "policy",
    content: v2Content,
    version: 2,
    supersedesId: sopId,
  });
  const v2ChunkRes = await expectStatus(
    "6D VERSION: chunk the new version",
    "POST",
    `/knowledge-documents/${v2Id}/chunks?workspaceId=${wsA}`,
    null,
    201,
  );
  const v2Chunks = v2ChunkRes.json?.data?.chunks || [];

  const v1ChunksAfter = await request("GET", `/knowledge-documents/${sopId}/chunks?workspaceId=${wsA}`);
  if (JSON.stringify((v1ChunksAfter.json?.data || []).map((c) => c.text)) === JSON.stringify(rechunked.map((c) => c.text))) {
    ok("6D VERSION: previous version's chunks remain untouched after chunking a new version");
  } else {
    fail("6D VERSION: previous version's chunks remain untouched after chunking a new version");
  }

  await expectStatus(
    "6D VERSION: re-chunking the new version",
    "POST",
    `/knowledge-documents/${v2Id}/chunks?workspaceId=${wsA}`,
    null,
    201,
  );
  const v1ChunksAfterV2Rechunk = await request("GET", `/knowledge-documents/${sopId}/chunks?workspaceId=${wsA}`);
  if ((v1ChunksAfterV2Rechunk.json?.data || []).length === (v1ChunksAfter.json?.data || []).length) {
    ok("6D VERSION: re-chunking v2 does not affect v1's chunk count");
  } else {
    fail("6D VERSION: re-chunking v2 does not affect v1's chunk count");
  }

  const allV1OwnedBySop = (v1ChunksAfter.json?.data || []).every((c) => String(c.documentId) === String(sopId));
  const allV2OwnedByV2 = v2Chunks.every((c) => String(c.documentId) === String(v2Id));
  if (allV1OwnedBySop && allV2OwnedByV2) {
    ok("6D VERSION: exact documentId/version ownership maintained across both versions");
  } else {
    fail("6D VERSION: exact documentId/version ownership maintained across both versions");
  }

  // =========================================================
  // TENANT ISOLATION
  // =========================================================
  const docBId = trackCreated(
    await expectStatus(
      "6D ISOLATION: workspace B document create",
      "POST",
      "/knowledge-documents",
      { workspaceId: wsB, title: "B's own SOP", documentType: "sop", content: "Example only. B's content." },
      201,
    ),
    "knowledgeDocumentIds",
  );
  await expectStatusOneOf(
    "6D ISOLATION: A cannot POST-chunk B's document",
    "POST",
    `/knowledge-documents/${docBId}/chunks?workspaceId=${wsA}`,
    null,
    CROSS,
  );
  await expectStatusOneOf(
    "6D ISOLATION: A cannot GET B's chunks",
    "GET",
    `/knowledge-documents/${docBId}/chunks?workspaceId=${wsA}`,
    null,
    CROSS,
  );
  // Prove no chunk was created for B's document via the leaked attempt above.
  const bChunkCountCheck = await request("GET", `/knowledge-documents/${docBId}/chunks?workspaceId=${wsB}`);
  if ((bChunkCountCheck.json?.data || []).length === 0) {
    ok("6D ISOLATION: A's blocked chunk attempt created nothing under B's document");
  } else {
    fail("6D ISOLATION: A's blocked chunk attempt created nothing under B's document");
  }
  await expectStatus(
    "6D ISOLATION: unknown documentId returns 404",
    "POST",
    `/knowledge-documents/000000000000000000000000/chunks?workspaceId=${wsA}`,
    null,
    404,
  );
  await expectStatus(
    "6D ISOLATION: malformed documentId returns 400",
    "POST",
    `/knowledge-documents/not-an-id/chunks?workspaceId=${wsA}`,
    null,
    400,
  );

  // =========================================================
  // DENORMALIZATION (and: no client-supplied scope is trusted)
  // =========================================================
  const denormCheck = await request("GET", `/knowledge-documents/${sopId}/chunks?workspaceId=${wsA}`);
  const denormRow = (denormCheck.json?.data || [])[0];
  const docCheck = await request("GET", `/knowledge-documents/${sopId}?workspaceId=${wsA}`);
  const parentDoc = docCheck.json?.data;
  if (
    String(denormRow?.workspaceId) === String(parentDoc?.workspaceId) &&
    String(denormRow?.propertyId) === String(parentDoc?.propertyId) &&
    denormRow?.status === parentDoc?.status
  ) {
    ok("6D DENORM: chunk workspaceId/propertyId/status come from the parent document");
  } else {
    fail("6D DENORM: chunk workspaceId/propertyId/status come from the parent document", JSON.stringify({ denormRow, parentDoc }));
  }

  const injectionRes = await expectStatus(
    "6D DENORM: a request body cannot inject a different scope",
    "POST",
    `/knowledge-documents/${sopId}/chunks?workspaceId=${wsA}`,
    { workspaceId: wsB, propertyId: "000000000000000000000000", status: "archived" },
    201,
  );
  const injectedChunks = injectionRes.json?.data?.chunks || [];
  if (injectedChunks.every((c) => String(c.workspaceId) === String(wsA) && c.status === parentDoc?.status)) {
    ok("6D DENORM: caller-supplied scope in the request body is ignored entirely");
  } else {
    fail("6D DENORM: caller-supplied scope in the request body is ignored entirely", JSON.stringify(injectedChunks));
  }

  // =========================================================
  // EMBEDDING BOUNDARY
  // =========================================================
  const embeddingCheck = (denormCheck.json?.data || []).every(
    (c) => c.embedding === undefined && c.embeddingModel === undefined,
  );
  if (embeddingCheck) ok("6D EMBEDDING: embedding/embeddingModel remain absent on every chunk");
  else fail("6D EMBEDDING: embedding/embeddingModel remain absent on every chunk", JSON.stringify(denormCheck.json?.data));

  const chunkerSource = readFileSync(new URL("../src/services/knowledge/knowledgeChunker.js", import.meta.url), "utf8");
  const chunkServiceSource = readFileSync(new URL("../src/services/knowledgeChunkService.js", import.meta.url), "utf8");
  const forbidden = /genai|openai|embedding[-_]?provider|gemini|fetch\(/i;
  if (!forbidden.test(chunkerSource) && !forbidden.test(chunkServiceSource)) {
    ok("6D EMBEDDING: no embedding provider, LLM SDK, or network call imported by the chunking code");
  } else {
    fail("6D EMBEDDING: no embedding provider, LLM SDK, or network call imported by the chunking code");
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
