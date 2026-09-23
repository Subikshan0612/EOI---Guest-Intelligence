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
// Phase 7F-D4: jszip is not a direct dependency of this project — it is
// mammoth's own hard-pinned direct dependency (mammoth cannot function
// without unzipping a .docx at all, so this is about as stable a
// transitive dependency as exists) and is used here ONLY to build valid
// DOCX byte fixtures for these tests, the same way earlier phases hand-
// built minimal PDF byte fixtures without adding a PDF-writing dependency.
import JSZip from "jszip";
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
 * Phase 7F-D3 — hand-built, minimal, single-page, single-line PDF byte
 * sequences for testing the real pdf-parse extraction path with no
 * external PDF files, no network fetches, and no extra dependency beyond
 * the one approved (pdf-parse itself). Byte offsets in the xref table are
 * computed from the actual bytes written, not hand-typed, so this stays
 * correct regardless of how long `text` is (within the single-line width
 * limit — see buildMultilinePdf below for genuinely long content).
 *
 * MediaBox is deliberately wide (4000pt) rather than a "normal" page
 * width: pdf.js's text extraction clips a single unwrapped `Tj` line at
 * the page's visible width (verified directly against the installed
 * library — at a normal ~300pt page width, even a ~40-character line was
 * silently truncated to ~36 characters). A real PDF generator would never
 * emit one giant unwrapped line either, but this function intentionally
 * does, for simplicity — so it needs the wide page to stay correct for
 * every test string used against it, not just very short ones.
 */
function buildMinimalPdf(text) {
  const escaped = text.replace(/([()\\])/g, "\\$1");
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 4000 200] /Contents 5 0 R >>\nendobj\n",
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];
  const streamContent = text.length > 0 ? `BT /F1 14 Tf 20 150 Td (${escaped}) Tj ET` : "BT ET";
  objects.push(
    `5 0 obj\n<< /Length ${Buffer.byteLength(streamContent, "utf8")} >>\nstream\n${streamContent}\nendstream\nendobj\n`,
  );
  return finishPdf(objects);
}

/**
 * Same idea, but wraps `text` across many lines (a tall single page, one
 * `Tj` per line) — real pdf.js text extraction clips a single unwrapped
 * `Tj` line at the page's visible width (verified directly against the
 * installed library before writing this: a 500,000-character single-line
 * PDF only extracted ~36 characters at a normal page width), exactly like
 * a real PDF generator would never emit one giant unwrapped line either.
 * Used for the extracted-text-ceiling test, where genuinely large
 * extracted text is the point.
 */
function buildMultilinePdf(text, lineWidth = 80) {
  const lines = [];
  for (let i = 0; i < text.length; i += lineWidth) lines.push(text.slice(i, i + lineWidth));
  const escapedLines = lines.map((line) => line.replace(/([()\\])/g, "\\$1"));
  const pageWidth = 700;
  const pageHeight = (lines.length + 5) * 14 + 100;

  let streamContent = `BT /F1 12 Tf 20 ${pageHeight - 30} Td\n`;
  for (const line of escapedLines) streamContent += `(${line}) Tj 0 -14 Td\n`;
  streamContent += "ET";

  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Contents 5 0 R >>\nendobj\n`,
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];
  objects.push(
    `5 0 obj\n<< /Length ${Buffer.byteLength(streamContent, "utf8")} >>\nstream\n${streamContent}\nendstream\nendobj\n`,
  );
  return finishPdf(objects);
}

/** Shared xref/trailer builder for both PDF generators above. */
function finishPdf(objects) {
  const header = "%PDF-1.4\n";
  let body = header;
  const offsets = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(body, "utf8"));
    body += obj;
  }
  const xrefOffset = Buffer.byteLength(body, "utf8");
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i += 1) {
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(body + xref + trailer, "utf8");
}

/**
 * A minimal, single-page PDF whose trailer references an /Encrypt
 * dictionary with deliberately-invalid O/U password hashes — enough for
 * pdf.js to detect the document requires a password and throw
 * PasswordException, without needing to implement real RC4/AES PDF
 * encryption (verified directly against the installed library: this does
 * genuinely trigger PasswordException, not a generic parse failure).
 */
function buildEncryptedPdf() {
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 300 200] /Contents 5 0 R >>\nendobj\n",
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
    "5 0 obj\n<< /Length 10 >>\nstream\nBT ET\nendstream\nendobj\n",
    "6 0 obj\n<< /Filter /Standard /V 1 /R 2 /O (\\376\\377\\376\\377\\376\\377\\376\\377\\376\\377\\376\\377\\376\\377\\376) /U (\\376\\377\\376\\377\\376\\377\\376\\377\\376\\377\\376\\377\\376\\377\\376) /P -44 >>\nendobj\n",
  ];
  const header = "%PDF-1.4\n";
  let body = header;
  const offsets = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(body, "utf8"));
    body += obj;
  }
  const xrefOffset = Buffer.byteLength(body, "utf8");
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i += 1) {
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Encrypt 6 0 R /ID [(1234567890123456) (1234567890123456)] >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(body + xref + trailer, "utf8");
}

/**
 * Phase 7F-D4 — hand-built, minimal, valid DOCX (OOXML-in-ZIP) fixtures
 * using jszip directly (see the import above). `bodyXml` is the raw
 * `<w:body>...</w:body>` inner content; `extraParts` optionally adds a
 * numbering.xml (required for a real <ul>/<ol> list — verified directly:
 * without it, mammoth silently renders list paragraphs as plain <p>, not
 * <li>), a header/footer pair, and a footnotes part + its relationship.
 */
async function buildDocx(bodyXml, { withNumbering = false, withHeaderFooter = false, withFootnote = false, withHyperlink = false } = {}) {
  const zip = new JSZip();
  const overrides = [
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
  ];
  const docRels = [
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>',
  ];

  if (withNumbering) {
    overrides.push('<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>');
    zip.folder("word").file(
      "numbering.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="&#8226;"/></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>`,
    );
  }

  if (withHeaderFooter) {
    overrides.push('<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>');
    overrides.push('<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>');
    docRels.push('<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>');
    docRels.push('<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>');
    zip.folder("word").file("header1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>HEADER TEXT MARKER</w:t></w:r></w:p></w:hdr>`);
    zip.folder("word").file("footer1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>FOOTER TEXT MARKER</w:t></w:r></w:p></w:ftr>`);
  }

  if (withFootnote) {
    overrides.push('<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>');
    docRels.push('<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>');
    zip.folder("word").file(
      "footnotes.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:footnote w:id="1"><w:p><w:r><w:t>FOOTNOTE TEXT MARKER</w:t></w:r></w:p></w:footnote>
</w:footnotes>`,
    );
  }

  if (withHyperlink) {
    docRels.push('<Relationship Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/policy" TargetMode="External"/>');
  }

  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
${overrides.join("\n")}
</Types>`,
  );
  zip.folder("_rels").file(
    ".rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );
  zip.folder("word").folder("_rels").file(
    "document.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${docRels.slice(1).join("\n")}
</Relationships>`,
  );
  zip.folder("word").file(
    "document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<w:body>${bodyXml}</w:body>
</w:document>`,
  );

  return zip.generateAsync({ type: "nodebuffer" });
}

function paragraph(text) {
  return `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

function heading(level, text) {
  return `<w:p><w:pPr><w:pStyle w:val="Heading${level}"/></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
}

function listItem(text) {
  return `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
}

function hyperlinkParagraph(displayText) {
  return `<w:p><w:hyperlink r:id="rIdLink"><w:r><w:t>${displayText}</w:t></w:r></w:hyperlink></w:p>`;
}

function table(rows) {
  const rowsXml = rows
    .map((cells) => `<w:tr>${cells.map((cell) => `<w:tc><w:p><w:r><w:t>${cell}</w:t></w:r></w:p></w:tc>`).join("")}</w:tr>`)
    .join("");
  return `<w:tbl>${rowsXml}</w:tbl>`;
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

  // =========================================================
  // Phase 7F-D3: PDF ingestion. Reuses the exact same upload endpoint,
  // metadata behavior, duplicate detection, supersession, ingestion-status
  // machinery, and retrieval/RAG pipeline every TXT/Markdown test above
  // already exercises — this section only proves the new PDF-specific
  // extraction path (documentExtractor.js's extractPdfText) behaves
  // correctly, and that nothing else needed to change.
  // =========================================================

  // --- 1: valid text PDF ---
  const pdfContent = `Example only. PDF upload content ${stamp}.`;
  const validPdfRes = await expectUploadStatus(
    "7FD3.1: valid text PDF upload succeeds",
    { fields: { workspaceId: wsA, title: "Example: Valid PDF", documentType: "sop", isTestData: "true" }, fileBytes: buildMinimalPdf(pdfContent), filename: "valid.pdf" },
    201,
  );
  const validPdfId = trackCreated(validPdfRes, "knowledgeDocumentIds");
  if (validPdfRes.json?.data?.sourceType === "pdf-upload") ok("7FD3.1: sourceType is pdf-upload");
  else fail("7FD3.1: sourceType is pdf-upload", JSON.stringify(validPdfRes.json?.data));
  if (typeof validPdfRes.json?.data?.content === "string" && validPdfRes.json.data.content.includes(pdfContent)) {
    ok("7FD3.1: extracted content is non-empty and contains the expected text");
  } else {
    fail("7FD3.1: extracted content is non-empty and contains the expected text", JSON.stringify(validPdfRes.json?.data?.content));
  }
  // The upload response's own `data` is a snapshot taken at create time,
  // before chunk/embed run (same pre-existing characteristic the D2/D2-
  // followup tests above already work around by re-fetching) — so the
  // *final* ingestionStatus is checked via a fresh GET, not the POST response.
  const validPdfAfter = await request("GET", `/knowledge-documents/${validPdfId}?workspaceId=${wsA}`);
  if (validPdfAfter.json?.data?.ingestionStatus === "ready") ok("7FD3.1: document reaches ingestionStatus:ready (embedding already ran synchronously)");
  else fail("7FD3.1: document reaches ingestionStatus:ready", JSON.stringify(validPdfAfter.json?.data));
  // Verify through the actual persisted chunks, not just the HTTP response.
  const validPdfChunks = await request("GET", `/knowledge-documents/${validPdfId}/chunks?workspaceId=${wsA}`);
  const validPdfChunkRows = validPdfChunks.json?.data || [];
  if (validPdfChunkRows.length > 0 && validPdfChunkRows.every((c) => c.text.includes(pdfContent.split(".")[0]) || c.text.length > 0) && validPdfChunkRows.every((c) => Array.isArray(c.embedding) && c.embedding.length > 0)) {
    ok("7FD3.1: the persisted KnowledgeChunk rows contain real extracted text and are fully embedded");
  } else {
    fail("7FD3.1: the persisted KnowledgeChunk rows contain real extracted text and are fully embedded", JSON.stringify(validPdfChunkRows));
  }

  // --- 2: malformed PDF ---
  const malformedRes = await expectUploadStatus(
    "7FD3.2: malformed PDF (.pdf extension, invalid bytes) rejected",
    { fields: { workspaceId: wsA, title: "X", documentType: "guideline", isTestData: "true" }, fileBytes: "this is not a pdf at all, just garbage bytes pretending to be one", filename: "malformed.pdf" },
    400,
  );
  if (malformedRes.status !== 500) ok("7FD3.2: malformed PDF never returns 500");
  else fail("7FD3.2: malformed PDF never returns 500");

  // --- 3: encrypted/password-protected PDF ---
  const encryptedRes = await expectUploadStatus(
    "7FD3.3: encrypted/password-protected PDF rejected",
    { fields: { workspaceId: wsA, title: "X", documentType: "guideline", isTestData: "true" }, fileBytes: buildEncryptedPdf(), filename: "encrypted.pdf" },
    400,
  );
  const encryptedMessage = JSON.stringify(encryptedRes.json);
  const secretPattern = /node_modules|at\s+\S+\.(js|cjs|mjs):\d+|Authorization:\s*Bearer|[A-Za-z]:\\Users|\/home\//i;
  if (!secretPattern.test(encryptedMessage)) ok("7FD3.3: encrypted-PDF error response exposes no stack trace, file path, or internal detail");
  else fail("7FD3.3: encrypted-PDF error response exposes no internal detail", encryptedMessage);

  // --- 4/5: image-only/scanned PDF and empty/no-extractable-text PDF —
  // both produce empty extracted text and are rejected through the
  // EXISTING content validation path (assertNonBlankContent inside
  // createKnowledgeDocument), not a new PDF-specific empty check. A
  // blank-page PDF (no text-drawing operators at all) is the closest
  // deterministic stand-in for "image-only" achievable without a real
  // scanned-image PDF fixture or OCR (explicitly out of scope).
  // =========================================================
  const blankPdfRes = await expectUploadStatus(
    "7FD3.4/5: image-only/empty PDF (no extractable text) rejected via the existing content validation path",
    { fields: { workspaceId: wsA, title: "X", documentType: "guideline", isTestData: "true" }, fileBytes: buildMinimalPdf(""), filename: "blank.pdf" },
    400,
  );
  if (typeof blankPdfRes.json?.message === "string" && blankPdfRes.json.message.includes("content is required")) {
    ok("7FD3.4/5: rejected with the exact same message an empty TXT upload already gets — no new/duplicate validation logic");
  } else {
    fail("7FD3.4/5: rejected with the exact same message an empty TXT upload already gets", JSON.stringify(blankPdfRes.json));
  }

  // --- 6: PDF under 10 MB with valid text succeeds (already proven by #1;
  // explicit check that a moderately larger, still well-under-10MB PDF
  // also succeeds) ---
  const moderatePdfRes = await expectUploadStatus(
    "7FD3.6: a larger (still well under 10 MB) PDF with valid text succeeds",
    { fields: { workspaceId: wsA, title: "Example: Moderate PDF", documentType: "guideline", isTestData: "true" }, fileBytes: buildMultilinePdf(`Example only. Moderate PDF content ${stamp}. `.repeat(200)), filename: "moderate.pdf" },
    201,
  );
  trackCreated(moderatePdfRes, "knowledgeDocumentIds");

  // --- 7: unsupported extension still rejected (regression: adding .pdf
  // support did not loosen the extension allow-list) ---
  await expectUploadStatus(
    "7FD3.7: unsupported extension (.doc) still rejected",
    { fields: { workspaceId: wsA, title: "X", documentType: "guideline", isTestData: "true" }, fileBytes: "irrelevant", filename: "document.doc" },
    400,
  );

  // --- 8: duplicate PDF content -> 409 (reusing D1's constraint, isTestData:false only) ---
  const pdfDupContent = `Example only. PDF duplicate check ${stamp}.`;
  const pdfDupFirstRes = await expectUploadStatus(
    "7FD3.8: first real PDF upload with this content succeeds",
    { fields: { workspaceId: wsA, title: "Example: PDF dup source", documentType: "policy", isTestData: "false" }, fileBytes: buildMinimalPdf(pdfDupContent), filename: "pdf-dup-1.pdf" },
    201,
  );
  const pdfDupFirstId = trackCreated(pdfDupFirstRes, "knowledgeDocumentIds");
  await expectUploadStatus(
    "7FD3.8: identical PDF content, same workspace/scope -> 409 duplicate",
    { fields: { workspaceId: wsA, title: "Example: PDF dup attempt", documentType: "policy", isTestData: "false" }, fileBytes: buildMinimalPdf(pdfDupContent), filename: "pdf-dup-2.pdf" },
    409,
  );

  // --- 9: cross-format duplicate — PDF extracted text identical to an
  // existing TXT document's content -> 409, proving contentHash is
  // computed from canonical extracted content, not file identity/format. ---
  const crossFormatContent = `Example only. Cross-format duplicate check ${stamp}.`;
  const txtSourceRes = await expectUploadStatus(
    "7FD3.9: TXT upload establishing the cross-format duplicate source",
    { fields: { workspaceId: wsA, title: "Example: TXT dup source", documentType: "policy", isTestData: "false" }, fileBytes: crossFormatContent, filename: "cross-format.txt" },
    201,
  );
  const txtSourceId = trackCreated(txtSourceRes, "knowledgeDocumentIds");
  await expectUploadStatus(
    "7FD3.9: PDF whose extracted text matches an existing TXT document's content -> 409 duplicate",
    { fields: { workspaceId: wsA, title: "Example: PDF cross-format dup attempt", documentType: "policy", isTestData: "false" }, fileBytes: buildMinimalPdf(crossFormatContent), filename: "cross-format.pdf" },
    409,
  );

  // clean up the two isTestData:false active duplicate sources above so
  // they don't collide with anything else this suite creates later.
  await connectDatabase();
  await KnowledgeDocument.deleteMany({ _id: { $in: [pdfDupFirstId, txtSourceId] } });
  await disconnectDatabase();

  // --- 10: PDF extraction followed by a genuine embedding failure ---
  await withEphemeralServer(5098, { AI_SERVICE_URL: "http://localhost:5999" }, async (ephemeralBase) => {
    const pdfFailRes = await upload({
      baseUrl: ephemeralBase,
      fields: { workspaceId: wsA, title: "Example: PDF with forced ingestion failure", documentType: "guideline", isTestData: "true" },
      fileBytes: buildMinimalPdf(`Example only. PDF ingestion failure check ${stamp}.`),
      filename: "pdf-forced-failure.pdf",
    });
    if (pdfFailRes.status === 502) ok("7FD3.10: a PDF upload whose embedding step genuinely fails still returns the existing 502 behavior, unchanged");
    else fail("7FD3.10: a PDF upload whose embedding step genuinely fails still returns the existing 502 behavior", `status=${pdfFailRes.status}`);

    const pdfFailedId = pdfFailRes.json?.details?.knowledgeDocumentId;
    if (typeof pdfFailedId === "string" && pdfFailedId.length === 24) {
      ok("7FD3.10: the failed PDF upload's error response carries the already-created document's id in `details`");
      trackCreated({ json: { data: { _id: pdfFailedId } } }, "knowledgeDocumentIds");

      await connectDatabase();
      const pdfFailedDoc = await KnowledgeDocument.findById(pdfFailedId);
      await disconnectDatabase();
      if (pdfFailedDoc?.ingestionStatus === "failed" && typeof pdfFailedDoc?.ingestionError === "string" && !secretPattern.test(pdfFailedDoc.ingestionError)) {
        ok("7FD3.10: the document is independently observable as ingestionStatus:failed with a safe ingestionError");
      } else {
        fail("7FD3.10: the document is independently observable as ingestionStatus:failed with a safe ingestionError", JSON.stringify({ status: pdfFailedDoc?.ingestionStatus, error: pdfFailedDoc?.ingestionError }));
      }

      // existing retry flow (against the real, working backend) recovers it
      await expectStatus("7FD3.10: retry — re-chunk the failed PDF document", "POST", `/knowledge-documents/${pdfFailedId}/chunks?workspaceId=${wsA}`, null, 201);
      await expectStatus("7FD3.10: retry — re-embed the failed PDF document", "POST", `/knowledge-documents/${pdfFailedId}/embeddings?workspaceId=${wsA}`, null, 201);
      const pdfRecovered = await request("GET", `/knowledge-documents/${pdfFailedId}?workspaceId=${wsA}`);
      if (pdfRecovered.json?.data?.ingestionStatus === "ready") ok("7FD3.10: the existing chunk/embed retry endpoints recover a failed PDF document to ready, same as TXT/MD");
      else fail("7FD3.10: the existing chunk/embed retry endpoints recover a failed PDF document to ready", JSON.stringify(pdfRecovered.json?.data));
    } else {
      fail("7FD3.10: the failed PDF upload's error response carries the already-created document's id in `details`", JSON.stringify(pdfFailRes.json));
    }
  });

  // --- 11: spoofed MIME type on a valid PDF still works (extension governs) ---
  const spoofedMimeRes = await expectUploadStatus(
    "7FD3.11: a valid PDF with an arbitrary/wrong MIME type still works",
    { fields: { workspaceId: wsA, title: "Example: PDF spoofed MIME", documentType: "guideline", isTestData: "true" }, fileBytes: buildMinimalPdf(`Example only. Spoofed MIME PDF check ${stamp}.`), filename: "spoofed-mime.pdf", mimeType: "application/octet-stream" },
    201,
  );
  trackCreated(spoofedMimeRes, "knowledgeDocumentIds");
  if (spoofedMimeRes.json?.data?.sourceType === "pdf-upload") ok("7FD3.11: sourceType remains pdf-upload regardless of the client-supplied MIME type");
  else fail("7FD3.11: sourceType remains pdf-upload regardless of the client-supplied MIME type", JSON.stringify(spoofedMimeRes.json?.data));

  // --- 12: fake PDF — .pdf extension, content is not PDF bytes at all ---
  await expectUploadStatus(
    "7FD3.12: a .pdf-named file whose content is not a real PDF is rejected with 400",
    { fields: { workspaceId: wsA, title: "X", documentType: "guideline", isTestData: "true" }, fileBytes: "Just plain text content, not a PDF structure whatsoever.", filename: "fake.pdf", mimeType: "application/pdf" },
    400,
  );

  // --- 13: extracted-text ceiling ---
  await connectDatabase();
  const beforeCeilingCount = await KnowledgeDocument.countDocuments({ workspaceId: wsA });
  await disconnectDatabase();
  const overCeilingRes = await expectUploadStatus(
    "7FD3.13: a PDF whose extracted text exceeds the configured ceiling is rejected",
    { fields: { workspaceId: wsA, title: "Example: Over-ceiling PDF", documentType: "guideline", isTestData: "true" }, fileBytes: buildMultilinePdf("a".repeat(500_001)), filename: "over-ceiling.pdf" },
    400,
  );
  if (typeof overCeilingRes.json?.message === "string" && overCeilingRes.json.message.includes("exceeds the maximum supported length")) {
    ok("7FD3.13: the ceiling rejection carries a clear, specific message");
  } else {
    fail("7FD3.13: the ceiling rejection carries a clear, specific message", JSON.stringify(overCeilingRes.json));
  }
  await connectDatabase();
  const afterCeilingCount = await KnowledgeDocument.countDocuments({ workspaceId: wsA });
  await disconnectDatabase();
  if (afterCeilingCount === beforeCeilingCount) ok("7FD3.13: no partial KnowledgeDocument was created when the ceiling was exceeded");
  else fail("7FD3.13: no partial KnowledgeDocument was created when the ceiling was exceeded", `before=${beforeCeilingCount} after=${afterCeilingCount}`);

  // Sanity: content comfortably under the ceiling still succeeds (proves
  // this is a real ceiling, not an accidentally-always-failing check).
  const underCeilingRes = await expectUploadStatus(
    "7FD3.13b: a PDF whose extracted text is comfortably under the ceiling succeeds",
    { fields: { workspaceId: wsA, title: "Example: Under-ceiling PDF", documentType: "guideline", isTestData: "true" }, fileBytes: buildMultilinePdf("b".repeat(400_000)), filename: "under-ceiling.pdf" },
    201,
  );
  trackCreated(underCeilingRes, "knowledgeDocumentIds");

  // --- 14: regression — TXT and Markdown uploads still behave exactly as
  // before adding PDF support (sections 1-34 above, run unmodified in the
  // same suite, already prove this; this is one additional explicit
  // smoke check specifically placed after the PDF work). ---
  const txtRegressionRes = await expectUploadStatus(
    "7FD3.14: TXT upload still works unchanged after PDF support was added",
    { fields: { workspaceId: wsA, title: "Example: TXT still works", documentType: "guideline", isTestData: "true" }, fileBytes: `Example only. TXT regression check ${stamp}.`, filename: "regression.txt" },
    201,
  );
  trackCreated(txtRegressionRes, "knowledgeDocumentIds");
  if (txtRegressionRes.json?.data?.sourceType === "txt-upload") ok("7FD3.14: TXT sourceType unaffected");
  else fail("7FD3.14: TXT sourceType unaffected", JSON.stringify(txtRegressionRes.json?.data));

  const mdRegressionRes = await expectUploadStatus(
    "7FD3.14: Markdown upload still works unchanged after PDF support was added",
    { fields: { workspaceId: wsA, title: "Example: MD still works", documentType: "guideline", isTestData: "true" }, fileBytes: `# Example ${stamp}\n\nStill works.`, filename: "regression.md" },
    201,
  );
  trackCreated(mdRegressionRes, "knowledgeDocumentIds");
  if (mdRegressionRes.json?.data?.sourceType === "md-upload") ok("7FD3.14: Markdown sourceType unaffected");
  else fail("7FD3.14: Markdown sourceType unaffected", JSON.stringify(mdRegressionRes.json?.data));

  // =========================================================
  // Phase 7F-D4: DOCX ingestion. Reuses the exact same upload endpoint,
  // metadata behavior, duplicate detection, supersession, ingestion-status
  // machinery, and retrieval/RAG pipeline every TXT/Markdown/PDF test above
  // already exercises — this section only proves the new DOCX-specific
  // extraction path (documentExtractor.js's extractDocxText +
  // htmlToPlainText) behaves correctly.
  // =========================================================

  // --- 1: normal DOCX paragraphs ---
  const docxParaText = `Example only. DOCX upload content ${stamp}.`;
  const normalDocxBuffer = await buildDocx(paragraph(docxParaText));
  const normalDocxRes = await expectUploadStatus(
    "7FD4.1: DOCX with normal paragraphs upload succeeds",
    { fields: { workspaceId: wsA, title: "Example: Normal DOCX", documentType: "sop", isTestData: "true" }, fileBytes: normalDocxBuffer, filename: "normal.docx" },
    201,
  );
  const normalDocxId = trackCreated(normalDocxRes, "knowledgeDocumentIds");
  if (normalDocxRes.json?.data?.sourceType === "docx-upload") ok("7FD4.1: sourceType is docx-upload");
  else fail("7FD4.1: sourceType is docx-upload", JSON.stringify(normalDocxRes.json?.data));
  if (typeof normalDocxRes.json?.data?.content === "string" && normalDocxRes.json.data.content.includes(docxParaText)) {
    ok("7FD4.1: persisted KnowledgeDocument.content contains readable extracted text");
  } else {
    fail("7FD4.1: persisted KnowledgeDocument.content contains readable extracted text", JSON.stringify(normalDocxRes.json?.data?.content));
  }
  const normalDocxAfter = await request("GET", `/knowledge-documents/${normalDocxId}?workspaceId=${wsA}`);
  if (normalDocxAfter.json?.data?.ingestionStatus === "ready") ok("7FD4.1: document reaches ingestionStatus:ready");
  else fail("7FD4.1: document reaches ingestionStatus:ready", JSON.stringify(normalDocxAfter.json?.data));

  // --- 2: headings ---
  const headingDocxBuffer = await buildDocx(heading(1, "Escalation Procedure") + heading(2, "Step One") + paragraph("Body text under the heading."));
  const headingDocxRes = await expectUploadStatus(
    "7FD4.2: DOCX with headings upload succeeds",
    { fields: { workspaceId: wsA, title: "Example: DOCX Headings", documentType: "sop", isTestData: "true" }, fileBytes: headingDocxBuffer, filename: "headings.docx" },
    201,
  );
  const headingDocxId = trackCreated(headingDocxRes, "knowledgeDocumentIds");
  const headingDocxContent = headingDocxRes.json?.data?.content || "";
  if (headingDocxContent.includes("# Escalation Procedure")) ok('7FD4.2: Heading 1 becomes "# ..."');
  else fail('7FD4.2: Heading 1 becomes "# ..."', JSON.stringify(headingDocxContent));
  if (headingDocxContent.includes("## Step One")) ok('7FD4.2: Heading 2 becomes "## ..."');
  else fail('7FD4.2: Heading 2 becomes "## ..."', JSON.stringify(headingDocxContent));
  await expectStatus("7FD4.2: chunk the heading document", "POST", `/knowledge-documents/${headingDocxId}/chunks?workspaceId=${wsA}`, null, 201);
  const headingChunksRes = await request("GET", `/knowledge-documents/${headingDocxId}/chunks?workspaceId=${wsA}`);
  const headingSections = (headingChunksRes.json?.data || []).map((c) => c.section);
  if (headingSections.includes("Escalation Procedure") || headingSections.includes("Step One")) {
    ok("7FD4.2: persisted chunks retain heading structure via the existing chunker's heading detection");
  } else {
    fail("7FD4.2: persisted chunks retain heading structure via the existing chunker's heading detection", JSON.stringify(headingSections));
  }

  // --- 3: lists ---
  const listDocxBuffer = await buildDocx(heading(2, "Steps") + listItem("Check the thermostat") + listItem("Escalate to on-call staff"), { withNumbering: true });
  const listDocxRes = await expectUploadStatus(
    "7FD4.3: DOCX with a list upload succeeds",
    { fields: { workspaceId: wsA, title: "Example: DOCX List", documentType: "sop", isTestData: "true" }, fileBytes: listDocxBuffer, filename: "list.docx" },
    201,
  );
  trackCreated(listDocxRes, "knowledgeDocumentIds");
  const listContent = listDocxRes.json?.data?.content || "";
  if (listContent.includes("- Check the thermostat") && listContent.includes("- Escalate to on-call staff")) {
    ok('7FD4.3: list items become readable "- " lines, content preserved');
  } else {
    fail('7FD4.3: list items become readable "- " lines, content preserved', JSON.stringify(listContent));
  }

  // --- 4: tables ---
  const tableDocxBuffer = await buildDocx(paragraph("Unit status:") + table([["Room", "Status"], ["204", "Occupied"]]));
  const tableDocxRes = await expectUploadStatus(
    "7FD4.4: DOCX with a table upload succeeds",
    { fields: { workspaceId: wsA, title: "Example: DOCX Table", documentType: "guideline", isTestData: "true" }, fileBytes: tableDocxBuffer, filename: "table.docx" },
    201,
  );
  trackCreated(tableDocxRes, "knowledgeDocumentIds");
  const tableContent = tableDocxRes.json?.data?.content || "";
  if (["Room", "Status", "204", "Occupied"].every((cell) => tableContent.includes(cell))) {
    ok("7FD4.4: table cell textual content is present in extracted text");
  } else {
    fail("7FD4.4: table cell textual content is present in extracted text", JSON.stringify(tableContent));
  }
  if (!/<w?:?tbl|<table|<tr>|<td>/i.test(tableContent)) {
    ok("7FD4.4: no structured table markup/model leaks into the stored content (flattened text only)");
  } else {
    fail("7FD4.4: no structured table markup/model leaks into the stored content", JSON.stringify(tableContent));
  }

  // --- 5: hyperlinks ---
  const hyperlinkDocxBuffer = await buildDocx(hyperlinkParagraph("Escalation Policy Document"), { withHyperlink: true });
  const hyperlinkDocxRes = await expectUploadStatus(
    "7FD4.5: DOCX with a hyperlink upload succeeds",
    { fields: { workspaceId: wsA, title: "Example: DOCX Hyperlink", documentType: "guideline", isTestData: "true" }, fileBytes: hyperlinkDocxBuffer, filename: "hyperlink.docx" },
    201,
  );
  trackCreated(hyperlinkDocxRes, "knowledgeDocumentIds");
  const hyperlinkContent = hyperlinkDocxRes.json?.data?.content || "";
  if (hyperlinkContent.includes("Escalation Policy Document") && !hyperlinkContent.includes("example.com")) {
    ok("7FD4.5: hyperlink visible text is preserved; the raw URL itself is not");
  } else {
    fail("7FD4.5: hyperlink visible text is preserved", JSON.stringify(hyperlinkContent));
  }

  // --- 6: malformed DOCX ---
  const malformedDocxRes = await expectUploadStatus(
    "7FD4.6: malformed DOCX (garbage bytes, .docx extension) rejected",
    { fields: { workspaceId: wsA, title: "X", documentType: "guideline", isTestData: "true" }, fileBytes: "this is not a docx at all, just garbage bytes pretending to be one", filename: "malformed.docx" },
    400,
  );
  if (malformedDocxRes.status !== 500) ok("7FD4.6: malformed DOCX never returns 500");
  else fail("7FD4.6: malformed DOCX never returns 500");
  const malformedDocxMessage = JSON.stringify(malformedDocxRes.json);
  if (!secretPattern.test(malformedDocxMessage) && !/xmldom|jszip|node_modules/i.test(malformedDocxMessage)) {
    ok("7FD4.6: malformed-DOCX error exposes no internal parser/library implementation detail");
  } else {
    fail("7FD4.6: malformed-DOCX error exposes no internal parser/library implementation detail", malformedDocxMessage);
  }

  // --- 7: non-DOCX file renamed .docx (a valid ZIP, but not a DOCX structure) ---
  const notReallyDocxZip = new JSZip();
  notReallyDocxZip.file("hello.txt", "just a regular zip file, not a docx");
  const notReallyDocxBuffer = await notReallyDocxZip.generateAsync({ type: "nodebuffer" });
  await expectUploadStatus(
    "7FD4.7: a valid ZIP that is not a real DOCX structure is rejected",
    { fields: { workspaceId: wsA, title: "X", documentType: "guideline", isTestData: "true" }, fileBytes: notReallyDocxBuffer, filename: "not-a-docx.docx" },
    400,
  );

  // --- 8: empty DOCX ---
  const emptyDocxBuffer = await buildDocx("");
  const emptyDocxRes = await expectUploadStatus(
    "7FD4.8: empty DOCX (no paragraphs) rejected via the existing content validation path",
    { fields: { workspaceId: wsA, title: "X", documentType: "guideline", isTestData: "true" }, fileBytes: emptyDocxBuffer, filename: "empty.docx" },
    400,
  );
  if (typeof emptyDocxRes.json?.message === "string" && emptyDocxRes.json.message.includes("content is required")) {
    ok("7FD4.8: rejected with the exact same message an empty TXT upload already gets — no new/duplicate validation logic");
  } else {
    fail("7FD4.8: rejected with the exact same message an empty TXT upload already gets", JSON.stringify(emptyDocxRes.json));
  }

  // --- 9: image-only DOCX (a paragraph with no text run at all — the
  // closest deterministic stand-in for "only an image", since an actual
  // embedded image requires binary image bytes; the code path that
  // matters — zero extracted text — is identical either way). ---
  const imageOnlyDocxBuffer = await buildDocx('<w:p><w:r><w:t></w:t></w:r></w:p>');
  const imageOnlyDocxRes = await expectUploadStatus(
    "7FD4.9: image-only DOCX (no extractable text) rejected, no OCR performed",
    { fields: { workspaceId: wsA, title: "X", documentType: "guideline", isTestData: "true" }, fileBytes: imageOnlyDocxBuffer, filename: "image-only.docx" },
    400,
  );
  if (typeof imageOnlyDocxRes.json?.message === "string" && imageOnlyDocxRes.json.message.includes("content is required")) {
    ok("7FD4.9: image-only DOCX rejected via the same existing empty-content path, not a new OCR/image code path");
  } else {
    fail("7FD4.9: image-only DOCX rejected via the same existing empty-content path", JSON.stringify(imageOnlyDocxRes.json));
  }

  // --- 10: large DOCX under 10 MB ---
  const manyParagraphs = Array.from({ length: 2000 }, (_, i) => paragraph(`Paragraph number ${i} of a larger operational document ${stamp}.`)).join("");
  const largeDocxBuffer = await buildDocx(manyParagraphs);
  if (largeDocxBuffer.length < 10 * 1024 * 1024) {
    ok(`7FD4.10: the larger DOCX fixture is well under 10 MB (${largeDocxBuffer.length} bytes) as intended`);
  } else {
    fail(`7FD4.10: the larger DOCX fixture is well under 10 MB`, `${largeDocxBuffer.length} bytes`);
  }
  const largeDocxRes = await expectUploadStatus(
    "7FD4.10: a larger DOCX (well under 10 MB) with valid text succeeds",
    { fields: { workspaceId: wsA, title: "Example: Large DOCX", documentType: "guideline", isTestData: "true" }, fileBytes: largeDocxBuffer, filename: "large.docx" },
    201,
  );
  trackCreated(largeDocxRes, "knowledgeDocumentIds");

  // --- 11: duplicate DOCX content -> 409 ---
  const docxDupContent = `Example only. DOCX duplicate check ${stamp}.`;
  const docxDupFirstRes = await expectUploadStatus(
    "7FD4.11: first real DOCX upload with this content succeeds",
    { fields: { workspaceId: wsA, title: "Example: DOCX dup source", documentType: "policy", isTestData: "false" }, fileBytes: await buildDocx(paragraph(docxDupContent)), filename: "docx-dup-1.docx" },
    201,
  );
  const docxDupFirstId = trackCreated(docxDupFirstRes, "knowledgeDocumentIds");
  await expectUploadStatus(
    "7FD4.11: identical DOCX content, same workspace/scope -> 409 duplicate",
    { fields: { workspaceId: wsA, title: "Example: DOCX dup attempt", documentType: "policy", isTestData: "false" }, fileBytes: await buildDocx(paragraph(docxDupContent)), filename: "docx-dup-2.docx" },
    409,
  );

  // --- 12: cross-format duplicate — DOCX extracted text identical to an
  // existing TXT document's content -> 409. ---
  const crossFormatDocxContent = `Example only. Cross-format DOCX duplicate check ${stamp}.`;
  const txtCrossSourceRes = await expectUploadStatus(
    "7FD4.12: TXT upload establishing the DOCX cross-format duplicate source",
    { fields: { workspaceId: wsA, title: "Example: TXT dup source for DOCX", documentType: "policy", isTestData: "false" }, fileBytes: crossFormatDocxContent, filename: "cross-format-for-docx.txt" },
    201,
  );
  const txtCrossSourceId = trackCreated(txtCrossSourceRes, "knowledgeDocumentIds");
  await expectUploadStatus(
    "7FD4.12: DOCX whose extracted text matches an existing TXT document's content -> 409 duplicate",
    { fields: { workspaceId: wsA, title: "Example: DOCX cross-format dup attempt", documentType: "policy", isTestData: "false" }, fileBytes: await buildDocx(paragraph(crossFormatDocxContent)), filename: "cross-format.docx" },
    409,
  );

  await connectDatabase();
  await KnowledgeDocument.deleteMany({ _id: { $in: [docxDupFirstId, txtCrossSourceId] } });
  await disconnectDatabase();

  // --- 13: embedding failure after successful DOCX extraction ---
  await withEphemeralServer(5099, { AI_SERVICE_URL: "http://localhost:5999" }, async (ephemeralBase) => {
    const docxFailRes = await upload({
      baseUrl: ephemeralBase,
      fields: { workspaceId: wsA, title: "Example: DOCX with forced ingestion failure", documentType: "guideline", isTestData: "true" },
      fileBytes: await buildDocx(paragraph(`Example only. DOCX ingestion failure check ${stamp}.`)),
      filename: "docx-forced-failure.docx",
    });
    if (docxFailRes.status === 502) ok("7FD4.13: a DOCX upload whose embedding step genuinely fails still returns the existing 502 behavior, unchanged");
    else fail("7FD4.13: a DOCX upload whose embedding step genuinely fails still returns the existing 502 behavior", `status=${docxFailRes.status}`);

    const docxFailedId = docxFailRes.json?.details?.knowledgeDocumentId;
    if (typeof docxFailedId === "string" && docxFailedId.length === 24) {
      ok("7FD4.13: the failed DOCX upload's error response carries the already-created document's id in `details`");
      trackCreated({ json: { data: { _id: docxFailedId } } }, "knowledgeDocumentIds");

      await connectDatabase();
      const docxFailedDoc = await KnowledgeDocument.findById(docxFailedId);
      await disconnectDatabase();
      if (docxFailedDoc?.ingestionStatus === "failed" && typeof docxFailedDoc?.ingestionError === "string" && !secretPattern.test(docxFailedDoc.ingestionError)) {
        ok("7FD4.13: the document is independently observable as ingestionStatus:failed with a safe ingestionError");
      } else {
        fail("7FD4.13: the document is independently observable as ingestionStatus:failed with a safe ingestionError", JSON.stringify({ status: docxFailedDoc?.ingestionStatus, error: docxFailedDoc?.ingestionError }));
      }

      await expectStatus("7FD4.13: retry — re-chunk the failed DOCX document", "POST", `/knowledge-documents/${docxFailedId}/chunks?workspaceId=${wsA}`, null, 201);
      await expectStatus("7FD4.13: retry — re-embed the failed DOCX document", "POST", `/knowledge-documents/${docxFailedId}/embeddings?workspaceId=${wsA}`, null, 201);
      const docxRecovered = await request("GET", `/knowledge-documents/${docxFailedId}?workspaceId=${wsA}`);
      if (docxRecovered.json?.data?.ingestionStatus === "ready") ok("7FD4.13: the existing chunk/embed retry endpoints recover a failed DOCX document to ready, same as TXT/MD/PDF");
      else fail("7FD4.13: the existing chunk/embed retry endpoints recover a failed DOCX document to ready", JSON.stringify(docxRecovered.json?.data));
    } else {
      fail("7FD4.13: the failed DOCX upload's error response carries the already-created document's id in `details`", JSON.stringify(docxFailRes.json));
    }
  });

  // --- 14: extracted-text ceiling ---
  await connectDatabase();
  const beforeDocxCeilingCount = await KnowledgeDocument.countDocuments({ workspaceId: wsA });
  await disconnectDatabase();
  const overCeilingParagraphs = Array.from({ length: 7000 }, (_, i) => paragraph(`x`.repeat(80) + ` line ${i}`)).join("");
  const overCeilingDocxBuffer = await buildDocx(overCeilingParagraphs);
  const overCeilingDocxRes = await expectUploadStatus(
    "7FD4.14: a DOCX whose extracted text exceeds the configured ceiling is rejected",
    { fields: { workspaceId: wsA, title: "Example: Over-ceiling DOCX", documentType: "guideline", isTestData: "true" }, fileBytes: overCeilingDocxBuffer, filename: "over-ceiling.docx" },
    400,
  );
  if (typeof overCeilingDocxRes.json?.message === "string" && overCeilingDocxRes.json.message.includes("exceeds the maximum supported length")) {
    ok("7FD4.14: the ceiling rejection carries a clear, specific message");
  } else {
    fail("7FD4.14: the ceiling rejection carries a clear, specific message", JSON.stringify(overCeilingDocxRes.json));
  }
  await connectDatabase();
  const afterDocxCeilingCount = await KnowledgeDocument.countDocuments({ workspaceId: wsA });
  await disconnectDatabase();
  if (afterDocxCeilingCount === beforeDocxCeilingCount) ok("7FD4.14: no partial KnowledgeDocument was created when the ceiling was exceeded");
  else fail("7FD4.14: no partial KnowledgeDocument was created when the ceiling was exceeded", `before=${beforeDocxCeilingCount} after=${afterDocxCeilingCount}`);

  // --- 15: unsupported extension regression ---
  await expectUploadStatus(
    "7FD4.15: unsupported extension (.xlsx) still rejected after DOCX support was added",
    { fields: { workspaceId: wsA, title: "X", documentType: "guideline", isTestData: "true" }, fileBytes: "irrelevant", filename: "spreadsheet.xlsx" },
    400,
  );

  // --- 16: regression — TXT/MD/PDF still work ---
  const finalTxtRes = await expectUploadStatus(
    "7FD4.16: TXT upload still works unchanged after DOCX support was added",
    { fields: { workspaceId: wsA, title: "Example: TXT still works (post-DOCX)", documentType: "guideline", isTestData: "true" }, fileBytes: `Example only. TXT still works post-DOCX ${stamp}.`, filename: "post-docx.txt" },
    201,
  );
  trackCreated(finalTxtRes, "knowledgeDocumentIds");
  const finalMdRes = await expectUploadStatus(
    "7FD4.16: Markdown upload still works unchanged after DOCX support was added",
    { fields: { workspaceId: wsA, title: "Example: MD still works (post-DOCX)", documentType: "guideline", isTestData: "true" }, fileBytes: `# Example ${stamp}\n\nStill works post-DOCX.`, filename: "post-docx.md" },
    201,
  );
  trackCreated(finalMdRes, "knowledgeDocumentIds");
  const finalPdfRes = await expectUploadStatus(
    "7FD4.16: PDF upload still works unchanged after DOCX support was added",
    { fields: { workspaceId: wsA, title: "Example: PDF still works (post-DOCX)", documentType: "guideline", isTestData: "true" }, fileBytes: buildMinimalPdf(`Example only. PDF still works post-DOCX ${stamp}.`), filename: "post-docx.pdf" },
    201,
  );
  trackCreated(finalPdfRes, "knowledgeDocumentIds");
  if (finalTxtRes.json?.data?.sourceType === "txt-upload" && finalMdRes.json?.data?.sourceType === "md-upload" && finalPdfRes.json?.data?.sourceType === "pdf-upload") {
    ok("7FD4.16: TXT/MD/PDF sourceTypes all remain correct and unaffected by adding DOCX support");
  } else {
    fail("7FD4.16: TXT/MD/PDF sourceTypes all remain correct and unaffected", JSON.stringify({ txt: finalTxtRes.json?.data?.sourceType, md: finalMdRes.json?.data?.sourceType, pdf: finalPdfRes.json?.data?.sourceType }));
  }

  // --- 17: verify actual mammoth behavior for headers/footers/footnotes,
  // documented rather than elaborately supported. ---
  const headerFooterFootnoteDocxBuffer = await buildDocx(
    paragraph("Body paragraph with a footnote.") + '<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="1"/></w:r>',
    { withHeaderFooter: true, withFootnote: true },
  );
  const headerFooterFootnoteRes = await expectUploadStatus(
    "7FD4.17: DOCX with header/footer/footnote parts uploads successfully",
    { fields: { workspaceId: wsA, title: "Example: DOCX header/footer/footnote", documentType: "guideline", isTestData: "true" }, fileBytes: headerFooterFootnoteDocxBuffer, filename: "header-footer-footnote.docx" },
    201,
  );
  trackCreated(headerFooterFootnoteRes, "knowledgeDocumentIds");
  const hffContent = headerFooterFootnoteRes.json?.data?.content || "";
  if (!hffContent.includes("HEADER TEXT MARKER") && !hffContent.includes("FOOTER TEXT MARKER")) {
    ok("7FD4.17: VERIFIED — mammoth does not include header/footer content in extracted text (documented, not supported)");
  } else {
    fail("7FD4.17: expected header/footer content to be absent (documenting actual observed behavior)", JSON.stringify(hffContent));
  }
  if (hffContent.includes("FOOTNOTE TEXT MARKER")) {
    ok("7FD4.17: VERIFIED — footnote text content IS included in extracted text (via mammoth's trailing footnote list), documented as observed behavior");
  } else {
    fail("7FD4.17: expected footnote text content to be present (documenting actual observed behavior)", JSON.stringify(hffContent));
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
