/**
 * Phase 7F-D2 validation: POST /api/knowledge-documents/upload
 * (TXT/Markdown file ingestion).
 *
 * The upload endpoint is a new transport (multipart/form-data) onto the
 * exact same, unmodified KnowledgeDocument -> chunking -> embedding ->
 * retrieval -> RAG pipeline validate-knowledge*.mjs and
 * validate-intelligence-persistence.mjs already prove. This suite focuses
 * only on what's new in 7F-D2: the upload boundary itself (file
 * validation, extraction, normalization, metadata/duplicate/supersession
 * behavior reused from D1), plus one end-to-end proof that an uploaded
 * document is retrievable and traceable through the existing, unmodified
 * RAG/provenance mechanism.
 *
 * Requires a running Python AI service reachable at PYTHON_BASE
 * (LLM_PROVIDER=test-python on the backend, EMBEDDING_PROVIDER=test on
 * ai-service) for the retrieval/provenance checks (#31/#32) — same
 * requirement validate-knowledge-grounding.mjs and
 * validate-intelligence-persistence.mjs already have.
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { Workspace, Property, Unit, Signal, KnowledgeDocument, KnowledgeChunk, Intelligence } from "../src/models/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, "..", "server.js");

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

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Real multipart/form-data upload — the actual transport this endpoint
 * uses, not the JSON `request()` helper above. `fileBytes` may be a string
 * (encoded as UTF-8) or a Uint8Array (for the invalid-UTF-8 test, which
 * needs raw, non-decodable bytes).
 */
async function upload({ fields = {}, fileBytes, filename, mimeType = "text/plain", omitFile = false, baseUrl = BASE }) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) form.append(key, String(value));
  }
  if (!omitFile) {
    const blob = new Blob([fileBytes], { type: mimeType });
    form.append("file", blob, filename);
  }
  const response = await fetch(`${baseUrl}/knowledge-documents/upload`, { method: "POST", body: form });
  let json = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  return { status: response.status, json };
}

async function expectUploadStatus(name, options, expectedStatus) {
  const result = await upload(options);
  if (result.status === expectedStatus) ok(name, `HTTP ${result.status}`);
  else fail(name, `expected ${expectedStatus}, got ${result.status}: ${JSON.stringify(result.json)}`);
  return result;
}

/**
 * Phase 7F-D2 follow-up — same throwaway-server technique
 * validate-knowledge-ingestion.mjs's "7FD1.16" section and
 * validate-ai-service.mjs's "5.6" already use, applied here specifically
 * through the multipart upload endpoint: proves the upload controller's
 * own error-details attachment works on a genuine, unmocked chunk/embed
 * failure, not just the plain JSON chunk/embed endpoints.
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
    fail("Python AI service reachable", `${PYTHON_BASE} — is ai-service running with EMBEDDING_PROVIDER=test?`);
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(1);
  }

  const wsA = trackCreated(await expectStatus("7FD2: workspace A create", "POST", "/workspaces", { name: `Phase7FD2 WS A ${stamp}`, slug: `phase7fd2-ws-a-${stamp}` }, 201), "workspaceIds");
  const wsB = trackCreated(await expectStatus("7FD2: workspace B create", "POST", "/workspaces", { name: `Phase7FD2 WS B ${stamp}`, slug: `phase7fd2-ws-b-${stamp}` }, 201), "workspaceIds");
  const propA = trackCreated(await expectStatus("7FD2: property A create", "POST", "/properties", { workspaceId: wsA, name: "Kolam Residency", code: `KRU${stamp}` }, 201), "propertyIds");
  const propA2 = trackCreated(await expectStatus("7FD2: second property A create", "POST", "/properties", { workspaceId: wsA, name: "Second Kolam Property", code: `KRU2${stamp}` }, 201), "propertyIds");
  const propB = trackCreated(await expectStatus("7FD2: property B create", "POST", "/properties", { workspaceId: wsB, name: "B Residency", code: `KRB${stamp}` }, 201), "propertyIds");
  const unitA = trackCreated(await expectStatus("7FD2: unit A create", "POST", "/units", { workspaceId: wsA, propertyId: propA, unitNumber: "401" }, 201), "unitIds");
  const unitB = trackCreated(await expectStatus("7FD2: unit B create", "POST", "/units", { workspaceId: wsB, propertyId: propB, unitNumber: "1" }, 201), "unitIds");

  // =========================================================
  // 1/2/3/16/17/18/28: basic successful uploads for each supported extension
  // =========================================================
  const txtContent = `Example only. TXT upload content ${stamp}.`;
  const txtRes = await expectUploadStatus(
    "7FD2.1: TXT upload succeeds",
    { fields: { workspaceId: wsA, title: "Example: TXT Upload", documentType: "sop", isTestData: "true" }, fileBytes: txtContent, filename: "housekeeping.txt", mimeType: "text/plain" },
    201,
  );
  const txtId = trackCreated(txtRes, "knowledgeDocumentIds");
  if (txtRes.json?.data?._id) ok("7FD2.28: uploaded TXT document received a KnowledgeDocument _id");
  else fail("7FD2.28: uploaded TXT document received a KnowledgeDocument _id");
  if (txtRes.json?.data?.sourceType === "txt-upload") ok("7FD2.16: sourceType is txt-upload for a .txt file");
  else fail("7FD2.16: sourceType is txt-upload for a .txt file", JSON.stringify(txtRes.json?.data));
  if (txtRes.json?.data?.sourceFilename === "housekeeping.txt") ok("7FD2.18: sourceFilename is stored for TXT upload");
  else fail("7FD2.18: sourceFilename is stored for TXT upload", JSON.stringify(txtRes.json?.data));

  const mdContent = `# Example: MD Upload ${stamp}\n\nSome guidance text.`;
  const mdRes = await expectUploadStatus(
    "7FD2.2: Markdown (.md) upload succeeds",
    { fields: { workspaceId: wsA, title: "Example: MD Upload", documentType: "guideline", isTestData: "true" }, fileBytes: mdContent, filename: "policy.md", mimeType: "text/markdown" },
    201,
  );
  trackCreated(mdRes, "knowledgeDocumentIds");
  if (mdRes.json?.data?.sourceType === "md-upload") ok("7FD2.17a: sourceType is md-upload for a .md file");
  else fail("7FD2.17a: sourceType is md-upload for a .md file", JSON.stringify(mdRes.json?.data));

  const markdownExtRes = await expectUploadStatus(
    "7FD2.3: .markdown extension upload succeeds",
    { fields: { workspaceId: wsA, title: "Example: .markdown Upload", documentType: "guideline", isTestData: "true" }, fileBytes: `# Example ${stamp}\n\nBody text.`, filename: "notes.markdown", mimeType: "text/markdown" },
    201,
  );
  trackCreated(markdownExtRes, "knowledgeDocumentIds");
  if (markdownExtRes.json?.data?.sourceType === "md-upload") ok("7FD2.17b: sourceType is md-upload for a .markdown file");
  else fail("7FD2.17b: sourceType is md-upload for a .markdown file", JSON.stringify(markdownExtRes.json?.data));

  // =========================================================
  // 4/5/6/7: rejection paths
  // =========================================================
  await expectUploadStatus(
    "7FD2.4: missing file rejected",
    { fields: { workspaceId: wsA, title: "X", documentType: "guideline" }, omitFile: true },
    400,
  );
  await expectUploadStatus(
    "7FD2.5: empty file rejected",
    { fields: { workspaceId: wsA, title: "X", documentType: "guideline", isTestData: "true" }, fileBytes: "", filename: "empty.txt" },
    400,
  );
  const oversized = "a".repeat(10 * 1024 * 1024 + 1024); // 10 MB + 1 KB
  await expectUploadStatus(
    "7FD2.6: file exceeding 10 MB rejected",
    { fields: { workspaceId: wsA, title: "X", documentType: "guideline", isTestData: "true" }, fileBytes: oversized, filename: "huge.txt" },
    413,
  );
  await expectUploadStatus(
    "7FD2.7: unsupported extension (.exe) rejected",
    { fields: { workspaceId: wsA, title: "X", documentType: "guideline", isTestData: "true" }, fileBytes: "not really an exe", filename: "malware.exe", mimeType: "application/octet-stream" },
    400,
  );
  await expectUploadStatus(
    "7FD2.7b: unsupported extension (.pdf) rejected — PDF is not supported until a later phase",
    { fields: { workspaceId: wsA, title: "X", documentType: "guideline", isTestData: "true" }, fileBytes: "%PDF-1.4 fake", filename: "document.pdf", mimeType: "application/pdf" },
    400,
  );
  await expectUploadStatus(
    "7FD2.8: a spoofed MIME type cannot make an unsupported extension pass (extension is authoritative)",
    { fields: { workspaceId: wsA, title: "X", documentType: "guideline", isTestData: "true" }, fileBytes: "plain text content", filename: "sneaky.exe", mimeType: "text/plain" },
    400,
  );
  const mimeMismatchRes = await expectUploadStatus(
    "7FD2.8b: a mismatched/unusual MIME type on a SUPPORTED extension is still accepted (extension governs, not MIME)",
    { fields: { workspaceId: wsA, title: "Example: MIME mismatch", documentType: "guideline", isTestData: "true" }, fileBytes: `Example only. MIME mismatch check ${stamp}.`, filename: "real.txt", mimeType: "application/octet-stream" },
    201,
  );
  trackCreated(mimeMismatchRes, "knowledgeDocumentIds");

  // Invalid UTF-8: a lone 0xC3 byte with no valid continuation byte.
  const invalidUtf8 = new Uint8Array([0x45, 0x78, 0x61, 0x6d, 0x70, 0x6c, 0x65, 0xc3, 0x28]);
  await expectUploadStatus(
    "7FD2: invalid UTF-8 byte sequence rejected, not silently corrupted",
    { fields: { workspaceId: wsA, title: "X", documentType: "guideline", isTestData: "true" }, fileBytes: invalidUtf8, filename: "invalid.txt" },
    400,
  );

  // =========================================================
  // 9/10/11/12: extraction + normalization correctness
  // =========================================================
  const unicodeContent = `Example only. Unicode check ${stamp}: café, résumé, 日本語, emoji 🏨.`;
  const unicodeRes = await expectUploadStatus(
    "7FD2.9: UTF-8 upload succeeds",
    { fields: { workspaceId: wsA, title: "Example: Unicode content", documentType: "guideline", isTestData: "true" }, fileBytes: unicodeContent, filename: "unicode.txt" },
    201,
  );
  const unicodeId = trackCreated(unicodeRes, "knowledgeDocumentIds");
  if (unicodeRes.json?.data?.content === unicodeContent) ok("7FD2.9: UTF-8 text (including non-ASCII) preserved exactly");
  else fail("7FD2.9: UTF-8 text (including non-ASCII) preserved exactly", JSON.stringify(unicodeRes.json?.data?.content));

  const bomBytes = new TextEncoder().encode(`﻿Example only. BOM check ${stamp}.`);
  const bomRes = await expectUploadStatus(
    "7FD2.10: UTF-8 BOM upload succeeds",
    { fields: { workspaceId: wsA, title: "Example: BOM content", documentType: "guideline", isTestData: "true" }, fileBytes: bomBytes, filename: "bom.txt" },
    201,
  );
  trackCreated(bomRes, "knowledgeDocumentIds");
  if (bomRes.json?.data?.content === `Example only. BOM check ${stamp}.` && !bomRes.json?.data?.content?.includes("﻿")) {
    ok("7FD2.10: leading UTF-8 BOM is stripped, not stored");
  } else {
    fail("7FD2.10: leading UTF-8 BOM is stripped, not stored", JSON.stringify(bomRes.json?.data?.content));
  }

  const crlfContent = `Example only. CRLF check ${stamp}.\r\nSecond line.\r\nThird line.`;
  const crlfRes = await expectUploadStatus(
    "7FD2.11: CRLF content upload succeeds",
    { fields: { workspaceId: wsA, title: "Example: CRLF content", documentType: "guideline", isTestData: "true" }, fileBytes: crlfContent, filename: "crlf.txt" },
    201,
  );
  trackCreated(crlfRes, "knowledgeDocumentIds");
  const expectedCrlfNormalized = `Example only. CRLF check ${stamp}.\nSecond line.\nThird line.`;
  if (crlfRes.json?.data?.content === expectedCrlfNormalized) ok("7FD2.11: CRLF is deterministically normalized to LF");
  else fail("7FD2.11: CRLF is deterministically normalized to LF", JSON.stringify(crlfRes.json?.data?.content));

  const headingContent = `# Escalation Procedure ${stamp}\n\n## Step One\n\nCheck the thermostat.\n\n## Step Two\n\nEscalate to on-call staff.\n`;
  const headingRes = await expectUploadStatus(
    "7FD2.12: Markdown with headings uploads successfully",
    { fields: { workspaceId: wsA, title: "Example: Heading structure", documentType: "sop", isTestData: "true" }, fileBytes: headingContent, filename: "structured.md" },
    201,
  );
  const headingId = trackCreated(headingRes, "knowledgeDocumentIds");
  if (headingRes.json?.data?.content?.includes("## Step One") && headingRes.json?.data?.content?.includes("## Step Two")) {
    ok("7FD2.12: Markdown headings are preserved verbatim, not stripped");
  } else {
    fail("7FD2.12: Markdown headings are preserved verbatim, not stripped", JSON.stringify(headingRes.json?.data?.content));
  }
  await expectStatus("7FD2: chunk the heading document", "POST", `/knowledge-documents/${headingId}/chunks?workspaceId=${wsA}`, null, 201);
  const headingChunks = await request("GET", `/knowledge-documents/${headingId}/chunks?workspaceId=${wsA}`);
  const sections = (headingChunks.json?.data || []).map((c) => c.section);
  if (sections.includes("Step One") || sections.includes("Step Two")) {
    ok("7FD2.12b: the existing chunker's heading detection correctly picks up section headings from the uploaded content");
  } else {
    fail("7FD2.12b: the existing chunker's heading detection correctly picks up section headings from the uploaded content", JSON.stringify(sections));
  }

  // =========================================================
  // 13: filename sanitization
  // =========================================================
  const pathFilenameRes = await expectUploadStatus(
    "7FD2.13: upload with a path-like client-supplied filename",
    { fields: { workspaceId: wsA, title: "Example: Path filename", documentType: "guideline", isTestData: "true" }, fileBytes: `Example only. Path filename check ${stamp}.`, filename: "../../etc/evil.txt" },
    201,
  );
  trackCreated(pathFilenameRes, "knowledgeDocumentIds");
  const storedFilename = pathFilenameRes.json?.data?.sourceFilename;
  if (storedFilename === "evil.txt") {
    ok("7FD2.13: sourceFilename is sanitized to its basename, no path components persisted");
  } else {
    fail("7FD2.13: sourceFilename is sanitized to its basename, no path components persisted", JSON.stringify(storedFilename));
  }

  // =========================================================
  // 14/15: contentHash — server-computed, never client-supplied
  // =========================================================
  const hashContent = `Example only. Hash check ${stamp}.`;
  const spoofHashRes = await expectUploadStatus(
    "7FD2.14: a client-supplied contentHash form field is ignored",
    { fields: { workspaceId: wsA, title: "Example: Spoofed hash", documentType: "guideline", isTestData: "true", contentHash: "0".repeat(64) }, fileBytes: hashContent, filename: "hash.txt" },
    201,
  );
  trackCreated(spoofHashRes, "knowledgeDocumentIds");
  if (spoofHashRes.json?.data?.contentHash === sha256Hex(hashContent)) {
    ok("7FD2.15: server computes the correct SHA-256 of the extracted content, ignoring any client-supplied value");
  } else {
    fail("7FD2.15: server computes the correct SHA-256 of the extracted content, ignoring any client-supplied value", JSON.stringify(spoofHashRes.json?.data));
  }

  // =========================================================
  // 19: isTestData behavior preserved from D1
  // =========================================================
  const defaultTestDataRes = await expectUploadStatus(
    "7FD2.19: upload without isTestData field",
    { fields: { workspaceId: wsA, title: "Example: default isTestData", documentType: "guideline" }, fileBytes: `Example only. Default isTestData upload ${stamp}.`, filename: "default.txt" },
    201,
  );
  const defaultTestDataId = trackCreated(defaultTestDataRes, "knowledgeDocumentIds");
  if (defaultTestDataRes.json?.data?.isTestData === false) ok("7FD2.19a: isTestData defaults to false on upload, same as manual-entry");
  else fail("7FD2.19a: isTestData defaults to false on upload, same as manual-entry", JSON.stringify(defaultTestDataRes.json?.data));
  // Clean this one up immediately — isTestData:false and workspace-wide,
  // it would otherwise occupy a duplicate-detection scope bucket for the rest of this run.
  await connectDatabase();
  await KnowledgeDocument.deleteOne({ _id: defaultTestDataId });
  await disconnectDatabase();

  const explicitFalseRes = await expectUploadStatus(
    '7FD2.19b: isTestData="false" string form field is coerced to boolean false',
    { fields: { workspaceId: wsA, title: "Example: explicit false", documentType: "guideline", isTestData: "false" }, fileBytes: `Example only. Explicit false isTestData upload ${stamp}.`, filename: "explicit-false.txt" },
    201,
  );
  const explicitFalseId = trackCreated(explicitFalseRes, "knowledgeDocumentIds");
  if (explicitFalseRes.json?.data?.isTestData === false) ok('7FD2.19b: isTestData="false" (string) correctly becomes boolean false');
  else fail('7FD2.19b: isTestData="false" (string) correctly becomes boolean false', JSON.stringify(explicitFalseRes.json?.data));
  await connectDatabase();
  await KnowledgeDocument.deleteOne({ _id: explicitFalseId });
  await disconnectDatabase();

  await expectUploadStatus(
    "7FD2.19c: a non-boolean-like isTestData value is rejected, same validation as manual-entry",
    { fields: { workspaceId: wsA, title: "X", documentType: "guideline", isTestData: "maybe" }, fileBytes: "x", filename: "x.txt" },
    400,
  );

  // =========================================================
  // 20/21/22: duplicate detection reused from D1 (isTestData:false only)
  // =========================================================
  const dupContent = `Example only. Upload duplicate check ${stamp}.`;
  const dupFirstRes = await expectUploadStatus(
    "7FD2.20: first real (isTestData:false) upload with this content succeeds",
    { fields: { workspaceId: wsA, title: "Example: dup source", documentType: "policy", isTestData: "false" }, fileBytes: dupContent, filename: "dup1.txt" },
    201,
  );
  const dupFirstId = trackCreated(dupFirstRes, "knowledgeDocumentIds");
  await expectUploadStatus(
    "7FD2.20: identical content upload, same workspace/scope -> 409 duplicate (reusing D1's constraint)",
    { fields: { workspaceId: wsA, title: "Example: dup attempt", documentType: "policy", isTestData: "false" }, fileBytes: dupContent, filename: "dup2.txt" },
    409,
  );
  const dupOtherWsRes = await expectUploadStatus(
    "7FD2.21: identical content uploaded to a DIFFERENT workspace is not a duplicate",
    { fields: { workspaceId: wsB, title: "Example: dup other workspace", documentType: "policy", isTestData: "false" }, fileBytes: dupContent, filename: "dup3.txt" },
    201,
  );
  trackCreated(dupOtherWsRes, "knowledgeDocumentIds");
  const dupOtherScopeRes = await expectUploadStatus(
    "7FD2.22: identical content, same workspace, DIFFERENT scope (property-scoped) is not a duplicate",
    { fields: { workspaceId: wsA, propertyId: propA, title: "Example: dup other scope", documentType: "policy", isTestData: "false" }, fileBytes: dupContent, filename: "dup4.txt" },
    201,
  );
  trackCreated(dupOtherScopeRes, "knowledgeDocumentIds");
  // cleanup dupFirstId's active row so it doesn't collide with anything else run later
  await connectDatabase();
  await KnowledgeDocument.deleteOne({ _id: dupFirstId });
  await disconnectDatabase();

  // =========================================================
  // 23/24/25/26: tenant isolation on the upload endpoint
  // =========================================================
  await expectUploadStatus(
    "7FD2.23: unknown workspaceId rejected",
    { fields: { workspaceId: "64b64c4f2f1c2e0012345678", title: "X", documentType: "guideline", isTestData: "true" }, fileBytes: "x", filename: "x.txt" },
    404,
  );
  await expectUploadStatus(
    "7FD2.23b: missing workspaceId rejected",
    { fields: { title: "X", documentType: "guideline", isTestData: "true" }, fileBytes: "x", filename: "x.txt" },
    400,
  );
  await expectUploadStatus(
    "7FD2.24: cross-workspace propertyId rejected",
    { fields: { workspaceId: wsA, propertyId: propB, title: "X", documentType: "guideline", isTestData: "true" }, fileBytes: "x", filename: "x.txt" },
    400,
  );
  await expectUploadStatus(
    "7FD2.25: cross-workspace unitId rejected",
    { fields: { workspaceId: wsA, unitId: unitB, title: "X", documentType: "guideline", isTestData: "true" }, fileBytes: "x", filename: "x.txt" },
    400,
  );

  // =========================================================
  // 27: supersession uses D1 version behavior, via upload
  // =========================================================
  const superV1Res = await expectUploadStatus(
    "7FD2.27: supersession fixture v1 upload",
    { fields: { workspaceId: wsA, propertyId: propA, title: "Example: Upload Supersession v1", documentType: "sop", isTestData: "true" }, fileBytes: `Example only. Supersession v1 upload ${stamp}.`, filename: "super-v1.txt" },
    201,
  );
  const superV1Id = trackCreated(superV1Res, "knowledgeDocumentIds");
  if (superV1Res.json?.data?.version === 1) ok("7FD2.27a: v1 upload starts at version 1");
  else fail("7FD2.27a: v1 upload starts at version 1", JSON.stringify(superV1Res.json?.data));

  const superV2Res = await expectUploadStatus(
    "7FD2.27: supersede v1 via a second upload with supersedesId",
    { fields: { workspaceId: wsA, title: "Example: Upload Supersession v2", documentType: "sop", isTestData: "true", supersedesId: superV1Id }, fileBytes: `Example only. Supersession v2 upload ${stamp}.`, filename: "super-v2.txt" },
    201,
  );
  const superV2Id = trackCreated(superV2Res, "knowledgeDocumentIds");
  if (superV2Res.json?.data?.version === 2) ok("7FD2.27b: uploaded new version's version is server-derived (superseded.version + 1), same as D1");
  else fail("7FD2.27b: uploaded new version's version is server-derived", JSON.stringify(superV2Res.json?.data));
  if (String(superV2Res.json?.data?.propertyId) === String(propA)) {
    ok("7FD2.27c: uploaded new version inherits the superseded document's scope, same as D1");
  } else {
    fail("7FD2.27c: uploaded new version inherits the superseded document's scope", JSON.stringify(superV2Res.json?.data));
  }
  const v1AfterSuper = await request("GET", `/knowledge-documents/${superV1Id}?workspaceId=${wsA}`);
  if (v1AfterSuper.json?.data?.status === "superseded") ok("7FD2.27d: v1 becomes superseded after being superseded by an uploaded v2");
  else fail("7FD2.27d: v1 becomes superseded after being superseded by an uploaded v2", JSON.stringify(v1AfterSuper.json?.data));

  await expectUploadStatus(
    "7FD2.26: cross-workspace supersedesId rejected",
    { fields: { workspaceId: wsB, title: "Hijack attempt", documentType: "sop", isTestData: "true", supersedesId: superV2Id }, fileBytes: "x", filename: "x.txt" },
    400,
  );

  // =========================================================
  // 33: no partial document exists after an extraction/validation failure
  // =========================================================
  await connectDatabase();
  const beforeFailCount = await KnowledgeDocument.countDocuments({ workspaceId: wsA });
  await disconnectDatabase();
  await expectUploadStatus(
    "7FD2.33: an unsupported-extension attempt is rejected",
    { fields: { workspaceId: wsA, title: "Should not be created", documentType: "guideline", isTestData: "true" }, fileBytes: "x", filename: "nope.csv" },
    400,
  );
  await connectDatabase();
  const afterFailCount = await KnowledgeDocument.countDocuments({ workspaceId: wsA });
  await disconnectDatabase();
  if (afterFailCount === beforeFailCount) ok("7FD2.33: a rejected upload creates no KnowledgeDocument at all");
  else fail("7FD2.33: a rejected upload creates no KnowledgeDocument at all", `before=${beforeFailCount} after=${afterFailCount}`);

  // =========================================================
  // 29/30: uploaded document produces chunks + embeddings via the
  // existing, unmodified pipeline (already implicitly proven by 7FD2.12b
  // above for chunks; this explicitly proves embeddings too).
  // =========================================================
  const chunksAfterUpload = await request("GET", `/knowledge-documents/${txtId}/chunks?workspaceId=${wsA}`);
  const chunkRows = chunksAfterUpload.json?.data || [];
  if (chunkRows.length > 0) ok("7FD2.29: the uploaded TXT document already has chunks (created synchronously as part of the upload)");
  else fail("7FD2.29: the uploaded TXT document already has chunks", JSON.stringify(chunkRows));
  const allEmbedded = chunkRows.length > 0 && chunkRows.every((c) => Array.isArray(c.embedding) && c.embedding.length > 0);
  if (allEmbedded) ok("7FD2.30: every chunk of the uploaded document already has an embedding (created synchronously as part of the upload, via the existing embedding pipeline)");
  else fail("7FD2.30: every chunk of the uploaded document already has an embedding", JSON.stringify(chunkRows));

  // =========================================================
  // 31/32: uploaded document is retrievable and traceable through the
  // existing, unmodified retrieval + RAG provenance pipeline.
  // =========================================================
  const QUERY_TEXT = `maintenance. AC unit ${stamp} not cooling. Warm air blowing from the vent.`;
  const ragDocRes = await expectUploadStatus(
    "7FD2.31: upload a document whose content matches the retrieval query exactly",
    { fields: { workspaceId: wsA, propertyId: propA, unitId: unitA, title: "Example: RAG traceability SOP", documentType: "sop", isTestData: "true" }, fileBytes: QUERY_TEXT, filename: "rag-check.txt" },
    201,
  );
  const ragDocId = trackCreated(ragDocRes, "knowledgeDocumentIds");

  const ragSignal = trackCreated(
    await expectStatus(
      "7FD2: create a signal matching the uploaded document's content",
      "POST",
      "/signals",
      { workspaceId: wsA, propertyId: propA, unitId: unitA, type: "maintenance", severity: "high", title: `AC unit ${stamp} not cooling`, description: "Warm air blowing from the vent." },
      201,
    ),
    "signalIds",
  );

  const retrievalRes = await expectStatus(
    "7FD2.31: the uploaded document is retrievable via the existing knowledge-retrieval endpoint",
    "GET",
    `/signals/${ragSignal}/knowledge-retrieval?workspaceId=${wsA}`,
    null,
    200,
  );
  const retrievalDocIds = (retrievalRes.json?.data?.results || []).map((r) => r.knowledgeDocumentId);
  if (retrievalDocIds.includes(ragDocId)) ok("7FD2.31b: the uploaded document's chunk is present in retrieval results");
  else fail("7FD2.31b: the uploaded document's chunk is present in retrieval results", JSON.stringify(retrievalDocIds));

  const intelRes = await expectStatus(
    "7FD2.32: generate knowledge-grounded intelligence for the signal",
    "POST",
    `/signals/${ragSignal}/intelligence?workspaceId=${wsA}`,
    null,
    200,
  );
  const provenanceDocIds = (intelRes.json?.data?.knowledgeProvenance || []).map((p) => p.knowledgeDocumentId);
  if (provenanceDocIds.includes(ragDocId)) {
    ok("7FD2.32: RAG provenance correctly identifies the uploaded KnowledgeDocument as a grounding source");
  } else {
    fail("7FD2.32: RAG provenance correctly identifies the uploaded KnowledgeDocument as a grounding source", JSON.stringify(provenanceDocIds));
  }
  const uploadedChunk = (intelRes.json?.data?.knowledgeProvenance || []).find((p) => p.knowledgeDocumentId === ragDocId);
  if (uploadedChunk?.chunkId && Number.isInteger(uploadedChunk?.version) && typeof uploadedChunk?.section === "string" && Number.isInteger(uploadedChunk?.chunkIndex) && typeof uploadedChunk?.retrievalScore === "number") {
    ok("7FD2.32b: provenance for the uploaded document retains chunkId/version/section/chunkIndex/scores, unchanged from the existing mechanism");
  } else {
    fail("7FD2.32b: provenance for the uploaded document retains chunkId/version/section/chunkIndex/scores", JSON.stringify(uploadedChunk));
  }

  // The persisted (7F-C) Intelligence record's own provenance must trace to the same uploaded document too.
  const persistedIntel = await request("GET", `/intelligence/${intelRes.json?.data?._id}?workspaceId=${wsA}`);
  const persistedProvenanceDocIds = (persistedIntel.json?.data?.knowledgeProvenance || []).map((p) => p.knowledgeDocumentId);
  if (persistedProvenanceDocIds.includes(ragDocId)) {
    ok("7FD2.32c: the PERSISTED Intelligence record's provenance also traces to the uploaded KnowledgeDocument");
  } else {
    fail("7FD2.32c: the PERSISTED Intelligence record's provenance also traces to the uploaded KnowledgeDocument", JSON.stringify(persistedProvenanceDocIds));
  }

  // =========================================================
  // 34: existing manual-entry creation still works, completely unaffected
  // =========================================================
  const manualRes = await expectStatus(
    "7FD2.34: existing JSON manual-entry creation still works unchanged",
    "POST",
    "/knowledge-documents",
    { workspaceId: wsA, title: "Example: Manual Entry Unaffected", documentType: "guideline", content: `Example only. Manual entry still works ${stamp}.`, isTestData: true },
    201,
  );
  const manualId = trackCreated(manualRes, "knowledgeDocumentIds");
  if (manualRes.json?.data?.sourceType === "manual-entry") ok("7FD2.34b: manual-entry documents still default sourceType correctly, unaffected by the upload path");
  else fail("7FD2.34b: manual-entry documents still default sourceType correctly", JSON.stringify(manualRes.json?.data));
  await expectStatus("7FD2.34c: manual-entry document is readable", "GET", `/knowledge-documents/${manualId}?workspaceId=${wsA}`, null, 200);

  // =========================================================
  // Phase 7F-D2 follow-up: when a document is created by an upload but a
  // subsequent chunk/embed step genuinely fails, the error response must
  // still carry the already-created document's id (so the caller isn't
  // left with an error and nothing to act on), and that document must be
  // independently observable as ingestionStatus:failed.
  // =========================================================
  await withEphemeralServer(5097, { AI_SERVICE_URL: "http://localhost:5999" }, async (ephemeralBase) => {
    const failedUploadRes = await upload({
      baseUrl: ephemeralBase,
      fields: { workspaceId: wsA, title: "Example: Upload with forced ingestion failure", documentType: "guideline", isTestData: "true" },
      fileBytes: `Example only. Forced ingestion failure upload ${stamp}.`,
      filename: "forced-failure.txt",
    });
    if (failedUploadRes.status === 502) {
      ok("7FD2-followup: an upload whose embedding step genuinely fails still returns the existing 502 behavior, unchanged");
    } else {
      fail("7FD2-followup: an upload whose embedding step genuinely fails still returns the existing 502 behavior", `status=${failedUploadRes.status}`);
    }
    const attachedId = failedUploadRes.json?.details?.knowledgeDocumentId;
    if (typeof attachedId === "string" && attachedId.length === 24) {
      ok("7FD2-followup: the failed upload's error response carries the already-created document's id in `details`");
      trackCreated({ json: { data: { _id: attachedId } } }, "knowledgeDocumentIds");

      await connectDatabase();
      const orphaned = await KnowledgeDocument.findById(attachedId);
      await disconnectDatabase();
      if (orphaned?.ingestionStatus === "failed" && typeof orphaned?.ingestionError === "string") {
        ok("7FD2-followup: the document referenced by the error response is independently observable as ingestionStatus:failed with a safe error message");
      } else {
        fail(
          "7FD2-followup: the document referenced by the error response is independently observable as ingestionStatus:failed",
          JSON.stringify({ ingestionStatus: orphaned?.ingestionStatus, ingestionError: orphaned?.ingestionError }),
        );
      }
    } else {
      fail("7FD2-followup: the failed upload's error response carries the already-created document's id in `details`", JSON.stringify(failedUploadRes.json));
    }
  });

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
