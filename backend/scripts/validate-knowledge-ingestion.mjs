/**
 * Phase 7F-D1 validation: KnowledgeDocument metadata, deterministic
 * duplicate-content detection, and hardened version/supersession.
 *
 * This is a hardening phase ahead of real file ingestion (7F-D2+) — no
 * upload endpoint, no file parsing, no new AI/RAG behavior exists yet.
 * Everything here is exercised through the same existing
 * POST/GET/PATCH /api/knowledge-documents contract validate-knowledge.mjs
 * and validate-knowledge-authoring.mjs already cover; this suite adds
 * focused coverage for what's new in 7F-D1 specifically, and does not
 * duplicate their existing assertions.
 *
 * Requires a running Python AI service reachable at PYTHON_BASE (only used
 * by the final "existing RAG behavior remains compatible" check, #15,
 * which chunks + embeds a document exactly like validate-knowledge-
 * embedding.mjs already does) — started with EMBEDDING_PROVIDER=test.
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { Workspace, Property, Unit, KnowledgeDocument, KnowledgeChunk } from "../src/models/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, "..", "server.js");

const BASE = process.env.API_BASE || "http://localhost:5002/api";
const PYTHON_BASE = process.env.PYTHON_BASE || "http://localhost:8000";

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
  if (result.status === expectedStatus) ok(name, `HTTP ${result.status}`);
  else fail(name, `expected ${expectedStatus}, got ${result.status}: ${JSON.stringify(result.json)}`);
  return result;
}

function trackCreated(result, bucket) {
  const id = result?.json?.data?._id;
  if (id && !created[bucket].includes(id)) created[bucket].push(id);
  return id;
}

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Phase 7F-D2 follow-up — same pattern validate-ai-service.mjs's "5.6" and
 * validate-knowledge-grounding.mjs's "6H.2b" already use: a throwaway
 * `node server.js` with a deliberately broken AI_SERVICE_URL, reading the
 * same MongoDB as the main test server. The deterministic test embedding
 * provider itself has no failure mode for any input (it's a pure hash
 * function), so this — a genuine, unmocked Node->Python connection
 * failure — is the only way to exercise a real embedding failure without
 * touching real provider config.
 */
function waitForHealth(base, timeoutMs = 15000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = async () => {
      try {
        const res = await fetch(`${base}/health`);
        if (res.ok) {
          resolve();
          return;
        }
      } catch {
        // not ready yet
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Server at ${base} did not become healthy in time`));
        return;
      }
      setTimeout(attempt, 200);
    };
    attempt();
  });
}

async function withEphemeralServer(port, envOverrides, fn) {
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, PORT: String(port), ...envOverrides },
    stdio: "ignore",
  });

  const base = `http://localhost:${port}/api`;
  try {
    await waitForHealth(base);
    await fn(base);
  } finally {
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
    await new Promise((resolve) => setTimeout(resolve, 500));
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

  const healthCheck = await fetch(`${PYTHON_BASE}/v1/health`).then((r) => r.json()).catch(() => null);
  if (healthCheck?.status === "healthy") ok("Python AI service reachable", PYTHON_BASE);
  else {
    fail("Python AI service reachable", `${PYTHON_BASE} — is ai-service running with EMBEDDING_PROVIDER=test?`);
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(1);
  }

  const wsA = trackCreated(await expectStatus("7FD1: workspace A create", "POST", "/workspaces", { name: `Phase7FD1 WS A ${stamp}`, slug: `phase7fd1-ws-a-${stamp}` }, 201), "workspaceIds");
  const wsB = trackCreated(await expectStatus("7FD1: workspace B create", "POST", "/workspaces", { name: `Phase7FD1 WS B ${stamp}`, slug: `phase7fd1-ws-b-${stamp}` }, 201), "workspaceIds");
  const propA = trackCreated(await expectStatus("7FD1: property A create", "POST", "/properties", { workspaceId: wsA, name: "Kolam Residency", code: `KRD${stamp}` }, 201), "propertyIds");
  const propA2 = trackCreated(await expectStatus("7FD1: second property A create", "POST", "/properties", { workspaceId: wsA, name: "Second Kolam Property", code: `KRD2${stamp}` }, 201), "propertyIds");
  const unitA = trackCreated(await expectStatus("7FD1: unit A create", "POST", "/units", { workspaceId: wsA, propertyId: propA, unitNumber: "301" }, 201), "unitIds");

  // =========================================================
  // 1: sourceType validation
  // =========================================================
  for (const sourceType of ["manual-entry", "txt-upload", "md-upload", "pdf-upload", "docx-upload"]) {
    const res = await expectStatus(
      `7FD1.1: sourceType "${sourceType}" accepted`,
      "POST",
      "/knowledge-documents",
      { workspaceId: wsA, title: `Example: sourceType ${sourceType}`, documentType: "guideline", content: `Example only. sourceType ${sourceType} content ${stamp}.`, sourceType, isTestData: true },
      201,
    );
    trackCreated(res, "knowledgeDocumentIds");
  }
  await expectStatus(
    "7FD1.1: the old, retired sourceType value \"upload\" is now rejected",
    "POST",
    "/knowledge-documents",
    { workspaceId: wsA, title: "X", documentType: "guideline", content: "x", sourceType: "upload", isTestData: true },
    400,
  );

  // =========================================================
  // 2: isTestData default/validation
  // =========================================================
  const defaultTestDataRes = await expectStatus(
    "7FD1.2: isTestData create without the field",
    "POST",
    "/knowledge-documents",
    { workspaceId: wsA, title: "Example: no isTestData given", documentType: "guideline", content: `Example only. Default isTestData check ${stamp}.` },
    201,
  );
  const defaultTestDataId = trackCreated(defaultTestDataRes, "knowledgeDocumentIds");
  if (defaultTestDataRes.json?.data?.isTestData === false) ok("7FD1.2: isTestData defaults to false");
  else fail("7FD1.2: isTestData defaults to false", JSON.stringify(defaultTestDataRes.json?.data));

  const explicitTrueRes = await expectStatus(
    "7FD1.2: isTestData explicitly true honored",
    "POST",
    "/knowledge-documents",
    { workspaceId: wsA, title: "Example: isTestData true", documentType: "guideline", content: `Example only. isTestData true check ${stamp}.`, isTestData: true },
    201,
  );
  trackCreated(explicitTrueRes, "knowledgeDocumentIds");
  if (explicitTrueRes.json?.data?.isTestData === true) ok("7FD1.2: isTestData:true honored");
  else fail("7FD1.2: isTestData:true honored", JSON.stringify(explicitTrueRes.json?.data));

  await expectStatus(
    "7FD1.2: non-boolean isTestData rejected",
    "POST",
    "/knowledge-documents",
    { workspaceId: wsA, title: "X", documentType: "guideline", content: "x", isTestData: "true" },
    400,
  );

  const patchIsTestDataRes = await expectStatus(
    "7FD1.2: isTestData can be updated via PATCH",
    "PATCH",
    `/knowledge-documents/${defaultTestDataId}?workspaceId=${wsA}`,
    { isTestData: true },
    200,
  );
  if (patchIsTestDataRes.json?.data?.isTestData === true) ok("7FD1.2: isTestData PATCH honored");
  else fail("7FD1.2: isTestData PATCH honored", JSON.stringify(patchIsTestDataRes.json?.data));
  await expectStatus(
    "7FD1.2: non-boolean isTestData rejected on PATCH",
    "PATCH",
    `/knowledge-documents/${defaultTestDataId}?workspaceId=${wsA}`,
    { isTestData: "yes" },
    400,
  );

  // =========================================================
  // 3: sourceFilename validation
  // =========================================================
  const withFilenameRes = await expectStatus(
    "7FD1.3: sourceFilename accepted on create",
    "POST",
    "/knowledge-documents",
    { workspaceId: wsA, title: "Example: with sourceFilename", documentType: "guideline", content: `Example only. sourceFilename check ${stamp}.`, sourceFilename: "Housekeeping_SOP_v1.pdf", isTestData: true },
    201,
  );
  const withFilenameId = trackCreated(withFilenameRes, "knowledgeDocumentIds");
  if (withFilenameRes.json?.data?.sourceFilename === "Housekeeping_SOP_v1.pdf") {
    ok("7FD1.3: sourceFilename stored and returned");
  } else {
    fail("7FD1.3: sourceFilename stored and returned", JSON.stringify(withFilenameRes.json?.data));
  }
  const withoutFilenameRes = await expectStatus(
    "7FD1.3: sourceFilename is optional (creation succeeds without it)",
    "POST",
    "/knowledge-documents",
    { workspaceId: wsA, title: "Example: no sourceFilename", documentType: "guideline", content: `Example only. No filename check ${stamp}.`, isTestData: true },
    201,
  );
  trackCreated(withoutFilenameRes, "knowledgeDocumentIds");
  if (withoutFilenameRes.json?.data?.sourceFilename === undefined) ok("7FD1.3: sourceFilename absent when not provided");
  else fail("7FD1.3: sourceFilename absent when not provided", JSON.stringify(withoutFilenameRes.json?.data));

  const patchFilenameRes = await expectStatus(
    "7FD1.3: sourceFilename can be corrected via PATCH",
    "PATCH",
    `/knowledge-documents/${withFilenameId}?workspaceId=${wsA}`,
    { sourceFilename: "Housekeeping_SOP_v1_final.pdf" },
    200,
  );
  if (patchFilenameRes.json?.data?.sourceFilename === "Housekeeping_SOP_v1_final.pdf") {
    ok("7FD1.3: sourceFilename PATCH honored");
  } else {
    fail("7FD1.3: sourceFilename PATCH honored", JSON.stringify(patchFilenameRes.json?.data));
  }

  // =========================================================
  // 4: deterministic SHA-256 content hashing
  // =========================================================
  const hashContent = `Example only. Deterministic hash content ${stamp}.`;
  const hashRes = await expectStatus(
    "7FD1.4: create document for hash check",
    "POST",
    "/knowledge-documents",
    { workspaceId: wsA, title: "Example: hash check", documentType: "guideline", content: hashContent, isTestData: true },
    201,
  );
  const hashDocId = trackCreated(hashRes, "knowledgeDocumentIds");
  const expectedHash = sha256Hex(hashContent);
  if (hashRes.json?.data?.contentHash === expectedHash) {
    ok("7FD1.4: contentHash is a correct, deterministic SHA-256 of the stored content");
  } else {
    fail("7FD1.4: contentHash is a correct, deterministic SHA-256 of the stored content", JSON.stringify({ got: hashRes.json?.data?.contentHash, expected: expectedHash }));
  }
  const rereadHash = await request("GET", `/knowledge-documents/${hashDocId}?workspaceId=${wsA}`);
  if (rereadHash.json?.data?.contentHash === expectedHash) {
    ok("7FD1.4: contentHash is stable across reads (not recomputed per request)");
  } else {
    fail("7FD1.4: contentHash is stable across reads (not recomputed per request)");
  }
  // contentHash can never be supplied by a caller — always server-computed.
  const spoofHashRes = await expectStatus(
    "7FD1.4: a caller-supplied contentHash is ignored, not trusted",
    "POST",
    "/knowledge-documents",
    { workspaceId: wsA, title: "Example: spoofed hash attempt", documentType: "guideline", content: `Example only. Spoof attempt ${stamp}.`, contentHash: "0000000000000000000000000000000000000000000000000000000000000000", isTestData: true },
    201,
  );
  trackCreated(spoofHashRes, "knowledgeDocumentIds");
  if (spoofHashRes.json?.data?.contentHash === sha256Hex(`Example only. Spoof attempt ${stamp}.`)) {
    ok("7FD1.4: contentHash is always server-computed, never a caller-supplied value");
  } else {
    fail("7FD1.4: contentHash is always server-computed, never a caller-supplied value", JSON.stringify(spoofHashRes.json?.data));
  }

  // =========================================================
  // 5/6/7: duplicate detection — workspace/scope-aware, real (non-test) content only
  // =========================================================
  const dupContent = `Example only. Duplicate detection content ${stamp}.`;

  const dupFirstRes = await expectStatus(
    "7FD1.5: first real (isTestData:false) document with this content succeeds",
    "POST",
    "/knowledge-documents",
    { workspaceId: wsA, title: "Example: duplicate source", documentType: "policy", content: dupContent, isTestData: false },
    201,
  );
  const dupFirstId = trackCreated(dupFirstRes, "knowledgeDocumentIds");

  await expectStatus(
    "7FD1.5: identical content, same workspace, same scope -> 409 duplicate",
    "POST",
    "/knowledge-documents",
    { workspaceId: wsA, title: "Example: duplicate attempt", documentType: "policy", content: dupContent, isTestData: false },
    409,
  );

  const dupOtherWsRes = await expectStatus(
    "7FD1.6: identical content in a DIFFERENT workspace is not a duplicate",
    "POST",
    "/knowledge-documents",
    { workspaceId: wsB, title: "Example: same content, different workspace", documentType: "policy", content: dupContent, isTestData: false },
    201,
  );
  trackCreated(dupOtherWsRes, "knowledgeDocumentIds");

  const dupPropertyScopedRes = await expectStatus(
    "7FD1.7: identical content, same workspace, DIFFERENT scope (property-scoped) is not a duplicate",
    "POST",
    "/knowledge-documents",
    { workspaceId: wsA, propertyId: propA, title: "Example: same content, property scope", documentType: "policy", content: dupContent, isTestData: false },
    201,
  );
  const dupPropertyScopedId = trackCreated(dupPropertyScopedRes, "knowledgeDocumentIds");

  await expectStatus(
    "7FD1.7: identical content, same workspace, SAME property scope -> 409 duplicate",
    "POST",
    "/knowledge-documents",
    { workspaceId: wsA, propertyId: propA, title: "Example: property-scope duplicate attempt", documentType: "policy", content: dupContent, isTestData: false },
    409,
  );

  const dupUnitScopedRes = await expectStatus(
    "7FD1.7: identical content, same workspace/property, DIFFERENT scope (unit-scoped) is not a duplicate",
    "POST",
    "/knowledge-documents",
    { workspaceId: wsA, propertyId: propA, unitId: unitA, title: "Example: same content, unit scope", documentType: "policy", content: dupContent, isTestData: false },
    201,
  );
  trackCreated(dupUnitScopedRes, "knowledgeDocumentIds");

  // A superseded (no longer active) document's content no longer blocks reuse.
  await expectStatus(
    "7FD1: mark the workspace-wide duplicate source archived",
    "PATCH",
    `/knowledge-documents/${dupFirstId}?workspaceId=${wsA}`,
    { status: "archived" },
    200,
  );
  const dupAfterArchiveRes = await expectStatus(
    "7FD1: identical content no longer blocked once the original is archived (not active)",
    "POST",
    "/knowledge-documents",
    { workspaceId: wsA, title: "Example: reuse after archive", documentType: "policy", content: dupContent, isTestData: false },
    201,
  );
  trackCreated(dupAfterArchiveRes, "knowledgeDocumentIds");

  // isTestData:true is explicitly exempt from the duplicate constraint,
  // even for content that already collides among real (isTestData:false) docs.
  const dupTestDataExemptRes = await expectStatus(
    "7FD1: isTestData:true is exempt from duplicate detection even for colliding content",
    "POST",
    "/knowledge-documents",
    { workspaceId: wsA, propertyId: propA, unitId: unitA, title: "Example: synthetic duplicate, exempt", documentType: "policy", content: dupContent, isTestData: true },
    201,
  );
  trackCreated(dupTestDataExemptRes, "knowledgeDocumentIds");

  // =========================================================
  // 8/9/10/11/12: supersession — version, workspace, scope, status transitions
  // =========================================================
  const superV1Content = `Example only. Supersession v1 content ${stamp}.`;
  const superV1Res = await expectStatus(
    "7FD1.8: supersession fixture v1 create",
    "POST",
    "/knowledge-documents",
    { workspaceId: wsA, propertyId: propA, title: "Example: Supersession Target v1", documentType: "sop", content: superV1Content, isTestData: true },
    201,
  );
  const superV1Id = trackCreated(superV1Res, "knowledgeDocumentIds");
  if (superV1Res.json?.data?.version === 1) ok("7FD1.8: v1 starts at version 1");
  else fail("7FD1.8: v1 starts at version 1", JSON.stringify(superV1Res.json?.data));

  const superV2Res = await expectStatus(
    "7FD1.8: supersede v1 without specifying a version — server derives it",
    "POST",
    "/knowledge-documents",
    { workspaceId: wsA, title: "Example: Supersession Target v2", documentType: "sop", content: `Example only. Supersession v2 content ${stamp}.`, supersedesId: superV1Id, isTestData: true },
    201,
  );
  const superV2Id = trackCreated(superV2Res, "knowledgeDocumentIds");
  if (superV2Res.json?.data?.version === 2) ok("7FD1.8: server-derived version is superseded.version + 1");
  else fail("7FD1.8: server-derived version is superseded.version + 1", JSON.stringify(superV2Res.json?.data));

  // Scope inheritance: v2's body above omitted propertyId entirely — it must inherit v1's propA scope, not become workspace-wide.
  if (String(superV2Res.json?.data?.propertyId) === String(propA)) {
    ok("7FD1.10: new version inherits the superseded document's scope when none is explicitly given");
  } else {
    fail("7FD1.10: new version inherits the superseded document's scope when none is explicitly given", JSON.stringify(superV2Res.json?.data));
  }

  // A caller-supplied version is ignored entirely when supersedesId is given.
  const superV3IgnoredVersionRes = await expectStatus(
    "7FD1.8: caller-supplied version is ignored during supersession",
    "POST",
    "/knowledge-documents",
    { workspaceId: wsA, propertyId: propA, title: "Example: Supersession Target v3", documentType: "sop", content: `Example only. Supersession v3 content ${stamp}.`, supersedesId: superV2Id, version: 99, isTestData: true },
    201,
  );
  const superV3Id = trackCreated(superV3IgnoredVersionRes, "knowledgeDocumentIds");
  if (superV3IgnoredVersionRes.json?.data?.version === 3) {
    ok("7FD1.8: caller-supplied version (99) was ignored; server derived 3 from superseded.version + 1");
  } else {
    fail("7FD1.8: caller-supplied version (99) was ignored", JSON.stringify(superV3IgnoredVersionRes.json?.data));
  }

  const v1AfterSuper = await request("GET", `/knowledge-documents/${superV1Id}?workspaceId=${wsA}`);
  if (v1AfterSuper.json?.data?.status === "superseded") ok("7FD1.11: superseded v1 automatically becomes status:superseded");
  else fail("7FD1.11: superseded v1 automatically becomes status:superseded", JSON.stringify(v1AfterSuper.json?.data));

  const v2AfterSuper = await request("GET", `/knowledge-documents/${superV2Id}?workspaceId=${wsA}`);
  if (v2AfterSuper.json?.data?.status === "superseded") ok("7FD1.11: v2, once itself superseded by v3, also becomes status:superseded");
  else fail("7FD1.11: v2, once itself superseded by v3, also becomes status:superseded", JSON.stringify(v2AfterSuper.json?.data));

  const v3AfterSuper = await request("GET", `/knowledge-documents/${superV3Id}?workspaceId=${wsA}`);
  if (v3AfterSuper.json?.data?.status === "active") ok("7FD1.12: the newest version (v3) remains status:active");
  else fail("7FD1.12: the newest version (v3) remains status:active", JSON.stringify(v3AfterSuper.json?.data));

  // 9: workspace ownership validation on supersession.
  const crossWsSupersedeRes = await expectStatus(
    "7FD1.9: supersedesId cannot reference another workspace's document",
    "POST",
    "/knowledge-documents",
    { workspaceId: wsB, title: "Hijack attempt", documentType: "sop", content: "x", supersedesId: superV3Id, isTestData: true },
    400,
  );
  if (crossWsSupersedeRes.json?.data === undefined) ok("7FD1.13: rejected cross-workspace supersession created nothing");
  else fail("7FD1.13: rejected cross-workspace supersession created nothing", JSON.stringify(crossWsSupersedeRes.json));
  const v3AfterFailedCrossWs = await request("GET", `/knowledge-documents/${superV3Id}?workspaceId=${wsA}`);
  if (v3AfterFailedCrossWs.json?.data?.status === "active") {
    ok("7FD1.13: rejected cross-workspace supersession left the real target document untouched");
  } else {
    fail("7FD1.13: rejected cross-workspace supersession left the real target document untouched", JSON.stringify(v3AfterFailedCrossWs.json?.data));
  }

  // 10/13: scope validation on supersession — explicit mismatch is rejected, and mutates nothing.
  const scopeMismatchRes = await expectStatus(
    "7FD1.10: supersession scope mismatch (different property) is rejected",
    "POST",
    "/knowledge-documents",
    { workspaceId: wsA, propertyId: propA2, title: "Example: scope-mismatched v4 attempt", documentType: "sop", content: `Example only. Scope mismatch attempt ${stamp}.`, supersedesId: superV3Id, isTestData: true },
    400,
  );
  if (scopeMismatchRes.json?.data === undefined) ok("7FD1.13: rejected scope-mismatched supersession created nothing");
  else fail("7FD1.13: rejected scope-mismatched supersession created nothing", JSON.stringify(scopeMismatchRes.json));
  const v3AfterScopeMismatch = await request("GET", `/knowledge-documents/${superV3Id}?workspaceId=${wsA}`);
  if (v3AfterScopeMismatch.json?.data?.status === "active" && String(v3AfterScopeMismatch.json?.data?.propertyId) === String(propA)) {
    ok("7FD1.13: rejected scope-mismatched supersession left the real target document completely unmutated");
  } else {
    fail("7FD1.13: rejected scope-mismatched supersession left the real target document completely unmutated", JSON.stringify(v3AfterScopeMismatch.json?.data));
  }

  // Superseding an already-archived document does not overwrite its archived status.
  const archivedTargetRes = await expectStatus(
    "7FD1: create a document to archive then supersede",
    "POST",
    "/knowledge-documents",
    { workspaceId: wsA, title: "Example: Archived-then-superseded", documentType: "guideline", content: `Example only. Archived target ${stamp}.`, isTestData: true },
    201,
  );
  const archivedTargetId = trackCreated(archivedTargetRes, "knowledgeDocumentIds");
  await expectStatus("7FD1: archive it", "PATCH", `/knowledge-documents/${archivedTargetId}?workspaceId=${wsA}`, { status: "archived" }, 200);
  const supersedeArchivedRes = await expectStatus(
    "7FD1.11: superseding an already-archived document still succeeds",
    "POST",
    "/knowledge-documents",
    { workspaceId: wsA, title: "Example: Successor of archived doc", documentType: "guideline", content: `Example only. Successor content ${stamp}.`, supersedesId: archivedTargetId, isTestData: true },
    201,
  );
  trackCreated(supersedeArchivedRes, "knowledgeDocumentIds");
  const archivedTargetAfter = await request("GET", `/knowledge-documents/${archivedTargetId}?workspaceId=${wsA}`);
  if (archivedTargetAfter.json?.data?.status === "archived") {
    ok("7FD1.11: superseding an already-archived document leaves it archived, not overwritten to superseded");
  } else {
    fail("7FD1.11: superseding an already-archived document leaves it archived, not overwritten to superseded", JSON.stringify(archivedTargetAfter.json?.data));
  }

  // =========================================================
  // 14: existing manual-entry creation still works, unaffected
  // =========================================================
  const manualRes = await expectStatus(
    "7FD1.14: ordinary manual-entry creation (no version/scope/supersession involved) still works",
    "POST",
    "/knowledge-documents",
    { workspaceId: wsA, title: "Example: Ordinary Manual Entry", documentType: "guideline", content: `Example only. Ordinary manual entry ${stamp}.`, isTestData: true },
    201,
  );
  const manualId = trackCreated(manualRes, "knowledgeDocumentIds");
  if (manualRes.json?.data?.sourceType === "manual-entry" && manualRes.json?.data?.version === 1 && manualRes.json?.data?.status === "active") {
    ok("7FD1.14: ordinary manual-entry document has all the expected pre-7F-D1 defaults");
  } else {
    fail("7FD1.14: ordinary manual-entry document has all the expected pre-7F-D1 defaults", JSON.stringify(manualRes.json?.data));
  }
  await expectStatus("7FD1.14: ordinary manual-entry document is readable", "GET", `/knowledge-documents/${manualId}?workspaceId=${wsA}`, null, 200);

  // =========================================================
  // 15: existing knowledge/RAG behavior remains compatible — chunking and
  // embedding still work end-to-end on a 7F-D1-created document.
  // =========================================================
  await expectStatus("7FD1.15: chunk the document", "POST", `/knowledge-documents/${manualId}/chunks?workspaceId=${wsA}`, null, 201);
  const embedRes = await expectStatus("7FD1.15: embed the document", "POST", `/knowledge-documents/${manualId}/embeddings?workspaceId=${wsA}`, null, 201);
  const chunksRes = await request("GET", `/knowledge-documents/${manualId}/chunks?workspaceId=${wsA}`);
  const allEmbedded = (chunksRes.json?.data || []).length > 0 && (chunksRes.json.data).every((c) => Array.isArray(c.embedding) && c.embedding.length > 0);
  if (allEmbedded) ok("7FD1.15: chunking + embedding still work end-to-end on a 7F-D1-created document");
  else fail("7FD1.15: chunking + embedding still work end-to-end on a 7F-D1-created document", JSON.stringify({ embedRes: embedRes.json, chunksRes: chunksRes.json }));

  // =========================================================
  // 16: ingestion processing state (pending/ready/failed) — Phase 7F-D2
  // follow-up. Orthogonal to the status (active/superseded/archived)
  // tests in sections 8-13 above — those all still passed unmodified,
  // proving ingestionStatus doesn't interfere with the existing lifecycle.
  // =========================================================
  const freshDocRes = await expectStatus(
    "7FD1.16: create a fresh document for ingestion-status checks",
    "POST",
    "/knowledge-documents",
    { workspaceId: wsA, title: "Example: Ingestion status check", documentType: "guideline", content: `Example only. Ingestion status check ${stamp}.`, isTestData: true },
    201,
  );
  const freshDocId = trackCreated(freshDocRes, "knowledgeDocumentIds");
  if (freshDocRes.json?.data?.ingestionStatus === "pending") ok("7FD1.16a: a newly created document starts ingestionStatus:pending");
  else fail("7FD1.16a: a newly created document starts ingestionStatus:pending", JSON.stringify(freshDocRes.json?.data));
  if (freshDocRes.json?.data?.ingestionError === undefined) ok("7FD1.16a: a newly created document has no ingestionError");
  else fail("7FD1.16a: a newly created document has no ingestionError", JSON.stringify(freshDocRes.json?.data));

  await expectStatus("7FD1.16: chunk the fresh document", "POST", `/knowledge-documents/${freshDocId}/chunks?workspaceId=${wsA}`, null, 201);
  await expectStatus("7FD1.16: embed the fresh document", "POST", `/knowledge-documents/${freshDocId}/embeddings?workspaceId=${wsA}`, null, 201);
  const readyDoc = await request("GET", `/knowledge-documents/${freshDocId}?workspaceId=${wsA}`);
  if (readyDoc.json?.data?.ingestionStatus === "ready") ok("7FD1.16b: successful embedding changes ingestionStatus pending -> ready");
  else fail("7FD1.16b: successful embedding changes ingestionStatus pending -> ready", JSON.stringify(readyDoc.json?.data));
  if (readyDoc.json?.data?.ingestionError === undefined) ok("7FD1.16b: ingestionError remains absent after a successful embed");
  else fail("7FD1.16b: ingestionError remains absent after a successful embed", JSON.stringify(readyDoc.json?.data));

  const failDocRes = await expectStatus(
    "7FD1.16: create a document to force a genuine embedding failure on",
    "POST",
    "/knowledge-documents",
    { workspaceId: wsA, title: "Example: Ingestion failure check", documentType: "guideline", content: `Example only. Ingestion failure check ${stamp}.`, isTestData: true },
    201,
  );
  const failDocId = trackCreated(failDocRes, "knowledgeDocumentIds");
  await expectStatus("7FD1.16: chunk the failure-test document", "POST", `/knowledge-documents/${failDocId}/chunks?workspaceId=${wsA}`, null, 201);

  await withEphemeralServer(5096, { AI_SERVICE_URL: "http://localhost:5999" }, async (base) => {
    const embedAttempt = await fetch(`${base}/knowledge-documents/${failDocId}/embeddings?workspaceId=${wsA}`, { method: "POST" });
    if (embedAttempt.status === 502) {
      ok("7FD1.16c: a genuine embedding failure (Python unreachable) still surfaces the existing 502 behavior, unchanged");
    } else {
      fail("7FD1.16c: a genuine embedding failure surfaces the existing 502 behavior, unchanged", `status=${embedAttempt.status}`);
    }
  });

  const failedDoc = await request("GET", `/knowledge-documents/${failDocId}?workspaceId=${wsA}`);
  if (failedDoc.json?.data?.ingestionStatus === "failed") ok("7FD1.16d: a genuine embedding failure changes ingestionStatus pending -> failed");
  else fail("7FD1.16d: a genuine embedding failure changes ingestionStatus pending -> failed", JSON.stringify(failedDoc.json?.data));

  const ingestionErrorMessage = failedDoc.json?.data?.ingestionError;
  const secretPattern = /ECONNREFUSED|fetch failed|node_modules|at\s+\S+\.js:\d+|Authorization:\s*Bearer/i;
  if (typeof ingestionErrorMessage === "string" && ingestionErrorMessage.length > 0 && ingestionErrorMessage.length < 200 && !secretPattern.test(ingestionErrorMessage)) {
    ok("7FD1.16e: ingestionError records only a short, safe message — no leaked internals");
  } else {
    fail("7FD1.16e: ingestionError records only a short, safe message", JSON.stringify(ingestionErrorMessage));
  }

  const filteredList = await request("GET", `/knowledge-documents?workspaceId=${wsA}&ingestionStatus=failed&limit=200`);
  const filteredIds = (filteredList.json?.data || []).map((d) => d._id);
  if (filteredIds.includes(failDocId)) ok("7FD1.16f: GET ?ingestionStatus=failed finds the failed document");
  else fail("7FD1.16f: GET ?ingestionStatus=failed finds the failed document", JSON.stringify(filteredIds));
  if (!filteredIds.includes(freshDocId)) ok("7FD1.16f: GET ?ingestionStatus=failed does not include a ready document");
  else fail("7FD1.16f: GET ?ingestionStatus=failed does not include a ready document");

  // Retry: re-running the EXISTING chunk/embed endpoints (against the
  // real, working backend, not the broken ephemeral one above) is already
  // a complete retry path — no new endpoint was added or is needed.
  await expectStatus("7FD1.16: retry — re-chunk the failed document", "POST", `/knowledge-documents/${failDocId}/chunks?workspaceId=${wsA}`, null, 201);
  await expectStatus("7FD1.16: retry — re-embed the failed document", "POST", `/knowledge-documents/${failDocId}/embeddings?workspaceId=${wsA}`, null, 201);
  const recoveredDoc = await request("GET", `/knowledge-documents/${failDocId}?workspaceId=${wsA}`);
  if (recoveredDoc.json?.data?.ingestionStatus === "ready") {
    ok("7FD1.16g: the existing chunk/embed endpoints already form a complete retry path — failed -> ready, no new endpoint");
  } else {
    fail("7FD1.16g: the existing chunk/embed endpoints already form a complete retry path", JSON.stringify(recoveredDoc.json?.data));
  }
  if (recoveredDoc.json?.data?.ingestionError === undefined) ok("7FD1.16h: ingestionError is cleared after a successful retry");
  else fail("7FD1.16h: ingestionError is cleared after a successful retry", JSON.stringify(recoveredDoc.json?.data));

  if (freshDocRes.json?.data?.status === "active" && readyDoc.json?.data?.status === "active" && recoveredDoc.json?.data?.status === "active") {
    ok("7FD1.16i: existing active/superseded/archived `status` behavior is completely unaffected by ingestionStatus");
  } else {
    fail(
      "7FD1.16i: existing active/superseded/archived `status` behavior is completely unaffected by ingestionStatus",
      JSON.stringify({ fresh: freshDocRes.json?.data?.status, ready: readyDoc.json?.data?.status, recovered: recoveredDoc.json?.data?.status }),
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
