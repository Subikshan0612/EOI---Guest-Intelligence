/**
 * Phase 6C validation: the KnowledgeDocument authoring/ingestion contract.
 *
 * Phase 6C introduced no new endpoint — POST/PATCH /api/knowledge-documents
 * (Phase 6B) already is the authoring contract. This script exists to prove
 * that contract explicitly and completely on its own, independent of
 * validate-knowledge.mjs's CRUD-shape coverage: every validation rule in the
 * Phase 6A architecture report, full tenant isolation, immutability,
 * version/lineage behavior, and — critically — that authoring a
 * KnowledgeDocument never creates a KnowledgeChunk (that's Phase 6D).
 *
 * Mirrors validate-api.mjs/validate-knowledge.mjs's own conventions exactly
 * so it can run against the same already-running backend instance.
 */
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { Workspace, Property, Unit, KnowledgeDocument, KnowledgeChunk } from "../src/models/index.js";

const BASE = process.env.API_BASE || "http://localhost:5002/api";
const CROSS = [403, 404];

const created = {
  workspaceIds: [],
  propertyIds: [],
  unitIds: [],
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

function assertListExcludes(name, result, forbiddenId) {
  const rows = result?.json?.data || [];
  if (rows.some((row) => String(row?._id) === String(forbiddenId))) {
    fail(name, `list leaked foreign id ${forbiddenId}`);
  } else {
    ok(name, `${rows.length} row(s), no foreign data`);
  }
}

async function cleanup() {
  await connectDatabase();
  await KnowledgeChunk.deleteMany({ documentId: { $in: created.knowledgeDocumentIds } });
  await KnowledgeDocument.deleteMany({ _id: { $in: created.knowledgeDocumentIds } });
  await Unit.deleteMany({ _id: { $in: created.unitIds } });
  await Property.deleteMany({ _id: { $in: created.propertyIds } });
  await Workspace.deleteMany({ _id: { $in: created.workspaceIds } });
  await disconnectDatabase();
}

async function main() {
  const stamp = Date.now();

  // === Fixture: workspace A (+ property, second property, unit) and workspace B ===
  const wsA = trackCreated(
    await expectStatus(
      "6C: workspace A create",
      "POST",
      "/workspaces",
      { name: `Phase6C WS A ${stamp}`, slug: `phase6c-ws-a-${stamp}` },
      201,
    ),
    "workspaceIds",
  );
  const propA = trackCreated(
    await expectStatus(
      "6C: property A create",
      "POST",
      "/properties",
      { workspaceId: wsA, name: "Kolam Residency", code: `KRC${stamp}` },
      201,
    ),
    "propertyIds",
  );
  const propA2 = trackCreated(
    await expectStatus(
      "6C: second property A create",
      "POST",
      "/properties",
      { workspaceId: wsA, name: "Second Kolam Property", code: `KRC2${stamp}` },
      201,
    ),
    "propertyIds",
  );
  const unitA = trackCreated(
    await expectStatus(
      "6C: unit A create",
      "POST",
      "/units",
      { workspaceId: wsA, propertyId: propA, unitNumber: "201" },
      201,
    ),
    "unitIds",
  );
  const wsB = trackCreated(
    await expectStatus(
      "6C: workspace B create",
      "POST",
      "/workspaces",
      { name: `Phase6C WS B ${stamp}`, slug: `phase6c-ws-b-${stamp}` },
      201,
    ),
    "workspaceIds",
  );

  // =========================================================
  // CREATE — the authoring contract's happy paths
  // =========================================================
  const wsWideRes = await expectStatus(
    "6C CREATE: valid workspace-wide document",
    "POST",
    "/knowledge-documents",
    {
      workspaceId: wsA,
      title: "Example: Escalation Policy",
      documentType: "policy",
      sourceType: "manual-entry",
      content: "Example only. Escalate high-severity signals to on-call staff.",
      isTestData: true,
    },
    201,
  );
  const wsWideId = trackCreated(wsWideRes, "knowledgeDocumentIds");

  const propScopedRes = await expectStatus(
    "6C CREATE: valid property-scoped document",
    "POST",
    "/knowledge-documents",
    {
      workspaceId: wsA,
      propertyId: propA,
      title: "Example: Property Maintenance Procedure",
      documentType: "procedure",
      content: "Example only. Contact the property's on-call maintenance vendor.",
      isTestData: true,
    },
    201,
  );
  const propScopedId = trackCreated(propScopedRes, "knowledgeDocumentIds");

  const unitScopedRes = await expectStatus(
    "6C CREATE: valid unit-scoped document",
    "POST",
    "/knowledge-documents",
    {
      workspaceId: wsA,
      propertyId: propA,
      unitId: unitA,
      title: "Example: Unit 201 Guideline",
      documentType: "guideline",
      content: "Example only. This unit has a non-standard thermostat.",
      isTestData: true,
    },
    201,
  );
  const unitScopedId = trackCreated(unitScopedRes, "knowledgeDocumentIds");

  const versionedRes = await expectStatus(
    "6C CREATE: valid explicit version",
    "POST",
    "/knowledge-documents",
    {
      workspaceId: wsA,
      title: "Example: Standalone v3 document",
      documentType: "standard",
      content: "Example only.",
      version: 3,
      isTestData: true,
    },
    201,
  );
  const versionedId = trackCreated(versionedRes, "knowledgeDocumentIds");
  if (versionedRes.json?.data?.version === 3) ok("6C CREATE: version honored");
  else fail("6C CREATE: version honored", JSON.stringify(versionedRes.json?.data));

  const effectiveRangeRes = await expectStatus(
    "6C CREATE: valid effective date range",
    "POST",
    "/knowledge-documents",
    {
      workspaceId: wsA,
      title: "Example: Seasonal Guideline",
      documentType: "guideline",
      content: "Example only.",
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      effectiveTo: "2026-12-31T00:00:00.000Z",
      isTestData: true,
    },
    201,
  );
  trackCreated(effectiveRangeRes, "knowledgeDocumentIds");

  const supersedeRes = await expectStatus(
    "6C CREATE: valid supersedesId",
    "POST",
    "/knowledge-documents",
    {
      workspaceId: wsA,
      title: "Example: Escalation Policy v2",
      documentType: "policy",
      content: "Example only. Escalate high-severity signals within 15 minutes (v2).",
      version: 2,
      supersedesId: wsWideId,
      isTestData: true,
    },
    201,
  );
  const supersedeId = trackCreated(supersedeRes, "knowledgeDocumentIds");
  if (String(supersedeRes.json?.data?.supersedesId) === String(wsWideId)) {
    ok("6C CREATE: supersedesId lineage recorded");
  } else {
    fail("6C CREATE: supersedesId lineage recorded", JSON.stringify(supersedeRes.json?.data));
  }

  // =========================================================
  // VALIDATION
  // =========================================================
  await expectStatus(
    "6C VALIDATE: missing workspaceId",
    "POST",
    "/knowledge-documents",
    { title: "X", documentType: "sop", content: "x" },
    400,
  );
  await expectStatus(
    "6C VALIDATE: invalid (malformed) workspaceId",
    "POST",
    "/knowledge-documents",
    { workspaceId: "not-an-id", title: "X", documentType: "sop", content: "x" },
    400,
  );
  await expectStatus(
    "6C VALIDATE: unknown workspaceId -> 404",
    "POST",
    "/knowledge-documents",
    { workspaceId: "64b64c4f2f1c2e0012345678", title: "X", documentType: "sop", content: "x" },
    404,
  );
  await expectStatus(
    "6C VALIDATE: missing title",
    "POST",
    "/knowledge-documents",
    { workspaceId: wsA, documentType: "sop", content: "x" },
    400,
  );
  await expectStatus(
    "6C VALIDATE: empty content rejected",
    "POST",
    "/knowledge-documents",
    { workspaceId: wsA, title: "X", documentType: "sop", content: "" },
    400,
  );
  await expectStatus(
    "6C VALIDATE: whitespace-only content rejected",
    "POST",
    "/knowledge-documents",
    { workspaceId: wsA, title: "X", documentType: "sop", content: "   \n\t  " },
    400,
  );
  await expectStatus(
    "6C VALIDATE: invalid documentType",
    "POST",
    "/knowledge-documents",
    { workspaceId: wsA, title: "X", documentType: "not-a-real-type", content: "x" },
    400,
  );
  await expectStatus(
    "6C VALIDATE: invalid sourceType",
    "POST",
    "/knowledge-documents",
    { workspaceId: wsA, title: "X", documentType: "sop", content: "x", sourceType: "carrier-pigeon" },
    400,
  );
  await expectStatus(
    "6C VALIDATE: invalid status",
    "POST",
    "/knowledge-documents",
    { workspaceId: wsA, title: "X", documentType: "sop", content: "x", status: "not-a-real-status" },
    400,
  );
  await expectStatus(
    "6C VALIDATE: invalid version (zero)",
    "POST",
    "/knowledge-documents",
    { workspaceId: wsA, title: "X", documentType: "sop", content: "x", version: 0 },
    400,
  );
  await expectStatus(
    "6C VALIDATE: invalid version (non-integer)",
    "POST",
    "/knowledge-documents",
    { workspaceId: wsA, title: "X", documentType: "sop", content: "x", version: 1.5 },
    400,
  );
  await expectStatus(
    "6C VALIDATE: invalid version (non-numeric)",
    "POST",
    "/knowledge-documents",
    { workspaceId: wsA, title: "X", documentType: "sop", content: "x", version: "abc" },
    400,
  );
  await expectStatus(
    "6C VALIDATE: invalid effective date range",
    "POST",
    "/knowledge-documents",
    {
      workspaceId: wsA,
      title: "X",
      documentType: "sop",
      content: "x",
      effectiveFrom: "2026-06-01T00:00:00.000Z",
      effectiveTo: "2026-01-01T00:00:00.000Z",
    },
    400,
  );
  trackCreated(
    await expectStatus(
      "6C VALIDATE: invalid property reference (wrong workspace)",
      "POST",
      "/knowledge-documents",
      { workspaceId: wsA, propertyId: "64b64c4f2f1c2e0012345678", title: "X", documentType: "sop", content: "x" },
      404,
    ),
    "knowledgeDocumentIds",
  );
  trackCreated(
    await expectStatus(
      "6C VALIDATE: invalid unit reference (unknown)",
      "POST",
      "/knowledge-documents",
      { workspaceId: wsA, unitId: "64b64c4f2f1c2e0012345678", title: "X", documentType: "sop", content: "x" },
      404,
    ),
    "knowledgeDocumentIds",
  );
  trackCreated(
    await expectStatus(
      "6C VALIDATE: unit/property mismatch",
      "POST",
      "/knowledge-documents",
      { workspaceId: wsA, unitId: unitA, propertyId: propA2, title: "X", documentType: "sop", content: "x" },
      400,
    ),
    "knowledgeDocumentIds",
  );
  trackCreated(
    await expectStatus(
      "6C VALIDATE: invalid supersedesId (unknown)",
      "POST",
      "/knowledge-documents",
      { workspaceId: wsA, title: "X", documentType: "sop", content: "x", supersedesId: "64b64c4f2f1c2e0012345678" },
      404,
    ),
    "knowledgeDocumentIds",
  );
  trackCreated(
    await expectStatus(
      "6C VALIDATE: cross-workspace supersedesId rejected",
      "POST",
      "/knowledge-documents",
      { workspaceId: wsB, title: "Hijack attempt", documentType: "sop", content: "x", supersedesId: wsWideId },
      400,
    ),
    "knowledgeDocumentIds",
  );

  // =========================================================
  // TENANT ISOLATION
  // =========================================================
  const docB = trackCreated(
    await expectStatus(
      "6C ISOLATION: workspace B document create",
      "POST",
      "/knowledge-documents",
      { workspaceId: wsB, title: "B's own policy", documentType: "policy", content: "Example only.", isTestData: true },
      201,
    ),
    "knowledgeDocumentIds",
  );
  await expectStatusOneOf(
    "6C ISOLATION: A cannot GET B's document",
    "GET",
    `/knowledge-documents/${docB}?workspaceId=${wsA}`,
    null,
    CROSS,
  );
  await expectStatusOneOf(
    "6C ISOLATION: A cannot PATCH B's document",
    "PATCH",
    `/knowledge-documents/${docB}?workspaceId=${wsA}`,
    { title: "hijack" },
    CROSS,
  );
  await expectStatusOneOf(
    "6C ISOLATION: A cannot DELETE B's document",
    "DELETE",
    `/knowledge-documents/${docB}?workspaceId=${wsA}`,
    null,
    CROSS,
  );
  await expectStatus(
    "6C ISOLATION: B's document survived A's delete attempt",
    "GET",
    `/knowledge-documents/${docB}?workspaceId=${wsB}`,
    null,
    200,
  );
  assertListExcludes(
    "6C ISOLATION: A's list never returns B's document",
    await request("GET", `/knowledge-documents?workspaceId=${wsA}&limit=200`),
    docB,
  );

  // =========================================================
  // IMMUTABILITY
  // =========================================================
  await expectStatus(
    "6C IMMUTABLE: content cannot be changed via PATCH",
    "PATCH",
    `/knowledge-documents/${wsWideId}?workspaceId=${wsA}`,
    { content: "trying to edit canonical content in place" },
    400,
  );
  await expectStatus(
    "6C IMMUTABLE: version cannot be changed via PATCH",
    "PATCH",
    `/knowledge-documents/${wsWideId}?workspaceId=${wsA}`,
    { version: 99 },
    400,
  );
  const unchangedCheck = await request("GET", `/knowledge-documents/${wsWideId}?workspaceId=${wsA}`);
  if (unchangedCheck.json?.data?.content?.includes("Escalate high-severity signals to on-call staff")) {
    ok("6C IMMUTABLE: original content unchanged after blocked PATCH attempts");
  } else {
    fail("6C IMMUTABLE: original content unchanged after blocked PATCH attempts", JSON.stringify(unchangedCheck.json?.data));
  }
  if (unchangedCheck.json?.data?.version === 1) ok("6C IMMUTABLE: original version unchanged");
  else fail("6C IMMUTABLE: original version unchanged", JSON.stringify(unchangedCheck.json?.data));

  // =========================================================
  // VERSIONING / LINEAGE
  // =========================================================
  if (supersedeId && supersedeId !== wsWideId) ok("6C LINEAGE: new version is a distinct document row");
  else fail("6C LINEAGE: new version is a distinct document row");

  // Phase 7F-D1: hardened supersession now marks the superseded document
  // superseded automatically, specifically to prevent both the old and new
  // versions from being simultaneously active (the previous, pre-7F-D1
  // behavior this test used to assert was the exact gap 7F-D1 closes).
  const originalAfterSupersede = await request("GET", `/knowledge-documents/${wsWideId}?workspaceId=${wsA}`);
  if (originalAfterSupersede.json?.data?.status === "superseded") {
    ok("6C LINEAGE (7F-D1): previous version was automatically marked superseded by creating a new one");
  } else {
    fail(
      "6C LINEAGE (7F-D1): previous version was automatically marked superseded by creating a new one",
      JSON.stringify(originalAfterSupersede.json?.data),
    );
  }
  if (String(originalAfterSupersede.json?.data?._id) === String(wsWideId)) {
    ok("6C LINEAGE: no silent overwrite — original id still resolves to the original document");
  } else {
    fail("6C LINEAGE: no silent overwrite — original id still resolves to the original document");
  }

  // =========================================================
  // CHUNK BOUNDARY — the critical Phase 6C/6D architectural line
  // =========================================================
  await connectDatabase();
  const chunkCount = await KnowledgeChunk.countDocuments({
    documentId: { $in: [wsWideId, propScopedId, unitScopedId, versionedId, supersedeId] },
  });
  const totalChunksInCollection = await KnowledgeChunk.countDocuments({});
  await disconnectDatabase();

  if (chunkCount === 0) {
    ok("6C CHUNK BOUNDARY: authoring documents created zero KnowledgeChunk rows for them");
  } else {
    fail("6C CHUNK BOUNDARY: authoring documents created zero KnowledgeChunk rows for them", `found ${chunkCount}`);
  }
  if (totalChunksInCollection === 0) {
    ok("6C CHUNK BOUNDARY: KnowledgeChunk collection remains entirely empty (chunking is Phase 6D)");
  } else {
    fail(
      "6C CHUNK BOUNDARY: KnowledgeChunk collection remains entirely empty (chunking is Phase 6D)",
      `found ${totalChunksInCollection} total`,
    );
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
