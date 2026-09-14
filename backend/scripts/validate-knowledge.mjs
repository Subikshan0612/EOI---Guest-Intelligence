/**
 * Phase 6B validation: /api/knowledge-documents CRUD + tenant isolation.
 *
 * Mirrors validate-api.mjs's own conventions exactly (same request/
 * expectStatus/trackCreated/assertListExcludes helpers, same CROSS status
 * set) so this script can run against the same already-running backend
 * instance. No ingestion, chunking, embeddings, or retrieval exists yet —
 * this only exercises the thin CRUD service and its tenant-isolation
 * guarantees, per the Phase 6A architecture report.
 */
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { Workspace, Property, Unit, KnowledgeDocument } from "../src/models/index.js";

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
  await KnowledgeDocument.deleteMany({ _id: { $in: created.knowledgeDocumentIds } });
  await Unit.deleteMany({ _id: { $in: created.unitIds } });
  await Property.deleteMany({ _id: { $in: created.propertyIds } });
  await Workspace.deleteMany({ _id: { $in: created.workspaceIds } });
  await disconnectDatabase();
}

async function main() {
  const stamp = Date.now();

  // === Fixture: workspace A with a property + unit, and workspace B ===
  const wsARes = await expectStatus(
    "6B: workspace A create",
    "POST",
    "/workspaces",
    { name: `Phase6B WS A ${stamp}`, slug: `phase6b-ws-a-${stamp}` },
    201,
  );
  const wsA = trackCreated(wsARes, "workspaceIds");

  const propARes = await expectStatus(
    "6B: property A create",
    "POST",
    "/properties",
    { workspaceId: wsA, name: "Kolam Residency", code: `KR${stamp}` },
    201,
  );
  const propA = trackCreated(propARes, "propertyIds");

  const unitARes = await expectStatus(
    "6B: unit A create",
    "POST",
    "/units",
    { workspaceId: wsA, propertyId: propA, unitNumber: "101" },
    201,
  );
  const unitA = trackCreated(unitARes, "unitIds");

  const wsBRes = await expectStatus(
    "6B: workspace B create",
    "POST",
    "/workspaces",
    { name: `Phase6B WS B ${stamp}`, slug: `phase6b-ws-b-${stamp}` },
    201,
  );
  const wsB = trackCreated(wsBRes, "workspaceIds");

  const propBRes = await expectStatus(
    "6B: property B create",
    "POST",
    "/properties",
    { workspaceId: wsB, name: "B Residences", code: `BR${stamp}` },
    201,
  );
  const propB = trackCreated(propBRes, "propertyIds");

  // A second property in workspace A, used only to prove a unit/property
  // mismatch is caught even when both are validly in-workspace.
  const propA2Res = await expectStatus(
    "6B: second property A create",
    "POST",
    "/properties",
    { workspaceId: wsA, name: "Second Kolam Property", code: `KR2${stamp}` },
    201,
  );
  const propA2 = trackCreated(propA2Res, "propertyIds");

  // === 1: create — workspace-wide (example content only, not real KOI data) ===
  const docRes = await expectStatus(
    "6B.1: create workspace-wide SOP",
    "POST",
    "/knowledge-documents",
    {
      workspaceId: wsA,
      title: "Example: AC Failure Escalation SOP",
      documentType: "sop",
      content: "Example only. AC failures in occupied units should be escalated promptly.",
    },
    201,
  );
  const docId = trackCreated(docRes, "knowledgeDocumentIds");
  if (docRes.json?.data?.status === "active") ok("6B.1: defaults to status=active");
  else fail("6B.1: defaults to status=active", JSON.stringify(docRes.json?.data));
  if (docRes.json?.data?.version === 1) ok("6B.1: defaults to version=1");
  else fail("6B.1: defaults to version=1", JSON.stringify(docRes.json?.data));
  if (docRes.json?.data?.sourceType === "manual-entry") ok("6B.1: defaults sourceType=manual-entry");
  else fail("6B.1: defaults sourceType=manual-entry", JSON.stringify(docRes.json?.data));
  if (docRes.json?.data?.propertyId === undefined) ok("6B.1: workspace-wide doc has no propertyId");
  else fail("6B.1: workspace-wide doc has no propertyId", JSON.stringify(docRes.json?.data));

  // === 2: create — property-scoped ===
  const propScopedRes = await expectStatus(
    "6B.2: create property-scoped procedure",
    "POST",
    "/knowledge-documents",
    {
      workspaceId: wsA,
      propertyId: propA,
      title: "Example: HVAC Local Vendor Procedure",
      documentType: "procedure",
      content: "Example only. Contact the on-call HVAC vendor for this property.",
    },
    201,
  );
  const propScopedId = trackCreated(propScopedRes, "knowledgeDocumentIds");
  if (String(propScopedRes.json?.data?.propertyId) === String(propA)) {
    ok("6B.2: property scope recorded");
  } else {
    fail("6B.2: property scope recorded", JSON.stringify(propScopedRes.json?.data));
  }

  // === 3: create — unit-scoped (schema-ready per Phase 6A Section 4) ===
  const unitScopedRes = await expectStatus(
    "6B.3: create unit-scoped instruction",
    "POST",
    "/knowledge-documents",
    {
      workspaceId: wsA,
      propertyId: propA,
      unitId: unitA,
      title: "Example: Unit 101 HVAC Controller Note",
      documentType: "guideline",
      content: "Example only. This unit has a non-standard thermostat model.",
    },
    201,
  );
  const unitScopedId = trackCreated(unitScopedRes, "knowledgeDocumentIds");
  if (String(unitScopedRes.json?.data?.unitId) === String(unitA)) ok("6B.3: unit scope recorded");
  else fail("6B.3: unit scope recorded", JSON.stringify(unitScopedRes.json?.data));

  // === 4: validation — required fields ===
  await expectStatus(
    "6B.4: missing workspaceId",
    "POST",
    "/knowledge-documents",
    { title: "X", documentType: "sop", content: "x" },
    400,
  );
  await expectStatus(
    "6B.4: missing title",
    "POST",
    "/knowledge-documents",
    { workspaceId: wsA, documentType: "sop", content: "x" },
    400,
  );
  await expectStatus(
    "6B.4: missing documentType",
    "POST",
    "/knowledge-documents",
    { workspaceId: wsA, title: "X", content: "x" },
    400,
  );
  await expectStatus(
    "6B.4: missing content",
    "POST",
    "/knowledge-documents",
    { workspaceId: wsA, title: "X", documentType: "sop" },
    400,
  );
  await expectStatus(
    "6B.4: invalid documentType rejected by enum",
    "POST",
    "/knowledge-documents",
    { workspaceId: wsA, title: "X", documentType: "not-a-real-type", content: "x" },
    400,
  );
  await expectStatus(
    "6B.4: unknown workspace -> 404",
    "POST",
    "/knowledge-documents",
    { workspaceId: "64b64c4f2f1c2e0012345678", title: "X", documentType: "sop", content: "x" },
    404,
  );

  // === 5: cross-entity validation (Phase 6A Section 11, layer 1) ===
  trackCreated(
    await expectStatus(
      "6B.5: doc A cannot ref property B",
      "POST",
      "/knowledge-documents",
      { workspaceId: wsA, propertyId: propB, title: "X", documentType: "sop", content: "x" },
      400,
    ),
    "knowledgeDocumentIds",
  );
  trackCreated(
    await expectStatus(
      "6B.5: doc A cannot ref unit belonging to property B",
      "POST",
      "/knowledge-documents",
      { workspaceId: wsA, unitId: unitA, propertyId: propB, title: "X", documentType: "sop", content: "x" },
      400,
    ),
    "knowledgeDocumentIds",
  );
  trackCreated(
    await expectStatus(
      "6B.5: unit/property mismatch caught even within the same workspace",
      "POST",
      "/knowledge-documents",
      { workspaceId: wsA, unitId: unitA, propertyId: propA2, title: "X", documentType: "sop", content: "x" },
      400,
    ),
    "knowledgeDocumentIds",
  );

  // === 6: effective-date validation ===
  trackCreated(
    await expectStatus(
      "6B.6: invalid effectiveFrom rejected",
      "POST",
      "/knowledge-documents",
      { workspaceId: wsA, title: "X", documentType: "sop", content: "x", effectiveFrom: "not-a-date" },
      400,
    ),
    "knowledgeDocumentIds",
  );
  trackCreated(
    await expectStatus(
      "6B.6: effectiveTo before effectiveFrom rejected",
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
    ),
    "knowledgeDocumentIds",
  );

  // === 7: read ===
  await expectStatus("6B.7: get by id", "GET", `/knowledge-documents/${docId}?workspaceId=${wsA}`, null, 200);
  await expectStatus(
    "6B.7: list requires workspaceId",
    "GET",
    "/knowledge-documents",
    null,
    400,
  );
  const listRes = await expectStatus(
    "6B.7: list scoped to workspace",
    "GET",
    `/knowledge-documents?workspaceId=${wsA}`,
    null,
    200,
  );
  if ((listRes.json?.data || []).length >= 3) ok("6B.7: list returns created documents");
  else fail("6B.7: list returns created documents", JSON.stringify(listRes.json));

  const filteredRes = await expectStatus(
    "6B.7: list filtered by propertyId",
    "GET",
    `/knowledge-documents?workspaceId=${wsA}&propertyId=${propA}`,
    null,
    200,
  );
  const filteredIds = (filteredRes.json?.data || []).map((d) => d._id);
  if (filteredIds.includes(propScopedId) && !filteredIds.includes(docId)) {
    ok("6B.7: propertyId filter excludes workspace-wide doc");
  } else {
    fail("6B.7: propertyId filter excludes workspace-wide doc", JSON.stringify(filteredIds));
  }

  const typeFilteredRes = await expectStatus(
    "6B.7: list filtered by documentType",
    "GET",
    `/knowledge-documents?workspaceId=${wsA}&documentType=guideline`,
    null,
    200,
  );
  if ((typeFilteredRes.json?.data || []).some((d) => d._id === unitScopedId)) {
    ok("6B.7: documentType filter includes matching doc");
  } else {
    fail("6B.7: documentType filter includes matching doc");
  }

  // === 8: update — allowed fields ===
  const updateRes = await expectStatus(
    "6B.8: update title/status",
    "PATCH",
    `/knowledge-documents/${docId}?workspaceId=${wsA}`,
    { title: "Example: AC Failure Escalation SOP (Updated)", status: "archived" },
    200,
  );
  if (updateRes.json?.data?.status === "archived") ok("6B.8: status updated");
  else fail("6B.8: status updated", JSON.stringify(updateRes.json?.data));

  // === 9: update — immutability guarantees (Phase 6A Section 6) ===
  await expectStatus(
    "6B.9: content is immutable",
    "PATCH",
    `/knowledge-documents/${docId}?workspaceId=${wsA}`,
    { content: "trying to edit in place" },
    400,
  );
  await expectStatus(
    "6B.9: version cannot be changed directly",
    "PATCH",
    `/knowledge-documents/${docId}?workspaceId=${wsA}`,
    { version: 5 },
    400,
  );
  await expectStatus(
    "6B.9: workspaceId cannot be reassigned",
    "PATCH",
    `/knowledge-documents/${docId}?workspaceId=${wsA}`,
    { workspaceId: wsB },
    400,
  );
  const reassignCheck = await request("GET", `/knowledge-documents/${docId}?workspaceId=${wsA}`);
  if (String(reassignCheck.json?.data?.workspaceId) === String(wsA)) {
    ok("6B.9: document A still in workspace A after blocked reassignment");
  } else {
    fail("6B.9: document A still in workspace A after blocked reassignment");
  }
  await expectStatus(
    "6B.9: empty update body rejected",
    "PATCH",
    `/knowledge-documents/${docId}?workspaceId=${wsA}`,
    {},
    400,
  );

  // === 10: supersession lineage ===
  const supersedeRes = await expectStatus(
    "6B.10: new version supersedes the old one",
    "POST",
    "/knowledge-documents",
    {
      workspaceId: wsA,
      title: "Example: AC Failure Escalation SOP v2",
      documentType: "sop",
      content: "Example only. Escalate AC failures within 30 minutes (v2).",
      version: 2,
      supersedesId: docId,
    },
    201,
  );
  const supersedeId = trackCreated(supersedeRes, "knowledgeDocumentIds");
  if (String(supersedeRes.json?.data?.supersedesId) === String(docId)) {
    ok("6B.10: supersedesId lineage recorded");
  } else {
    fail("6B.10: supersedesId lineage recorded", JSON.stringify(supersedeRes.json?.data));
  }
  trackCreated(
    await expectStatus(
      "6B.10: supersedesId cannot reference another workspace's document",
      "POST",
      "/knowledge-documents",
      {
        workspaceId: wsB,
        title: "Hijack attempt",
        documentType: "sop",
        content: "x",
        supersedesId: docId,
      },
      400,
    ),
    "knowledgeDocumentIds",
  );

  // === 11: delete ===
  await expectStatus(
    "6B.11: delete",
    "DELETE",
    `/knowledge-documents/${unitScopedId}?workspaceId=${wsA}`,
    null,
    200,
  );
  await expectStatus(
    "6B.11: deleted document no longer found",
    "GET",
    `/knowledge-documents/${unitScopedId}?workspaceId=${wsA}`,
    null,
    404,
  );

  // === 12: tenant isolation (Phase 6A Section 11) ===
  const docBRes = await expectStatus(
    "6B.12: workspace B document create",
    "POST",
    "/knowledge-documents",
    { workspaceId: wsB, title: "B's own SOP", documentType: "sop", content: "Example only." },
    201,
  );
  const docB = trackCreated(docBRes, "knowledgeDocumentIds");

  await expectStatusOneOf(
    "6B.12: A cannot GET B's document",
    "GET",
    `/knowledge-documents/${docB}?workspaceId=${wsA}`,
    null,
    CROSS,
  );
  await expectStatusOneOf(
    "6B.12: A cannot PATCH B's document",
    "PATCH",
    `/knowledge-documents/${docB}?workspaceId=${wsA}`,
    { title: "hijack" },
    CROSS,
  );
  assertListExcludes(
    "6B.12: A's list never includes B's document",
    await request("GET", `/knowledge-documents?workspaceId=${wsA}&limit=100`),
    docB,
  );
  await expectStatusOneOf(
    "6B.12: A cannot DELETE B's document",
    "DELETE",
    `/knowledge-documents/${docB}?workspaceId=${wsA}`,
    null,
    CROSS,
  );
  await expectStatus(
    "6B.12: B's document survived A's delete attempt",
    "GET",
    `/knowledge-documents/${docB}?workspaceId=${wsB}`,
    null,
    200,
  );
  await expectStatus(
    "6B.12: malformed id still 400",
    "GET",
    `/knowledge-documents/not-an-id?workspaceId=${wsA}`,
    null,
    400,
  );

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
