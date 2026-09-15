/**
 * Phase 6H validation: knowledge-grounded intelligence generation.
 *
 * Drives the real, existing POST /api/signals/:id/intelligence endpoint
 * with LLM_PROVIDER=test-python — the same safe, deterministic way every
 * prior phase's Python-routed tests avoid real Gemini calls. The Python
 * side's own deterministic stub (ai-service/app/services/
 * deterministic_stub.py) honestly echoes back every KnowledgeItem it was
 * supplied as knowledgeProvenance, which is exactly what makes the
 * Node<->Python knowledge contract itself verifiable end to end without a
 * real model call. Prompt CONTENT (separation, grounding instructions,
 * Gemini-side provenance cross-checking) is tested directly in
 * ai-service/tests/test_knowledge_grounding.py — this suite verifies the
 * real HTTP round trip: retrieval -> Python -> Node's own re-verification.
 *
 * Post-review correction: retrieval SUCCEEDING with zero results and
 * retrieval FAILING are two different states and must produce two
 * different outcomes (see intelligenceService.js's retrieveKnowledgeOrThrow).
 * The failure-injection tests below use two independent, genuine ways to
 * make the real running stack's retrieval call actually fail — no
 * mocking — mirroring conventions already established elsewhere in this
 * codebase: a directly-inserted zero-magnitude embedding (same technique
 * Phase 6G's own cap test uses) makes Python's real /v1/knowledge-retrieval
 * genuinely reject the request, and a short-lived ephemeral server with a
 * broken AI_SERVICE_URL (same withEphemeralServer pattern
 * validate-ai-service.mjs already uses) makes the real HTTP call to Python
 * genuinely fail to connect.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import {
  Workspace,
  Property,
  Unit,
  Signal,
  KnowledgeDocument,
  KnowledgeChunk,
} from "../src/models/index.js";

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

/** Same pattern validate-ai-service.mjs already uses — a throwaway server with deliberately broken env, reading the same MongoDB. */
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

  const wsA = trackCreated(await expectStatus("6H: workspace A create", "POST", "/workspaces", { name: `Phase6H WS A ${stamp}`, slug: `phase6h-ws-a-${stamp}` }, 201), "workspaceIds");
  const wsB = trackCreated(await expectStatus("6H: workspace B create", "POST", "/workspaces", { name: `Phase6H WS B ${stamp}`, slug: `phase6h-ws-b-${stamp}` }, 201), "workspaceIds");
  const propA = trackCreated(await expectStatus("6H: property A create", "POST", "/properties", { workspaceId: wsA, name: "Kolam Residency", code: `KRH${stamp}` }, 201), "propertyIds");
  const unitA = trackCreated(await expectStatus("6H: unit A create", "POST", "/units", { workspaceId: wsA, propertyId: propA, unitNumber: "204" }, 201), "unitIds");

  const KNOWLEDGE_TEXT = "Example only. Synthetic SOP: check thermostat mode and filter before escalating an AC failure.";

  // =========================================================
  // 1-3: relevant Unit / Property / Workspace knowledge, 4: multiple chunks
  // =========================================================
  const unitDocId = await createAndIndexDocument({ workspaceId: wsA, propertyId: propA, unitId: unitA, title: "Example: Unit AC SOP", documentType: "sop", content: KNOWLEDGE_TEXT });
  const propertyDocId = await createAndIndexDocument({ workspaceId: wsA, propertyId: propA, title: "Example: Property AC Procedure", documentType: "procedure", content: KNOWLEDGE_TEXT });
  const workspaceDocId = await createAndIndexDocument({ workspaceId: wsA, title: "Example: Workspace AC Policy", documentType: "policy", content: KNOWLEDGE_TEXT });

  const signalFull = await createSignal({ workspaceId: wsA, propertyId: propA, unitId: unitA, type: "maintenance", severity: "high", title: "AC not cooling", description: "Warm air blowing from the unit." });

  const intelRes = await expectStatus("6H.1-4: generate intelligence with full-scope knowledge available", "POST", `/signals/${signalFull}/intelligence?workspaceId=${wsA}`, null, 200);
  const provenance = intelRes.json?.data?.knowledgeProvenance || [];
  const provenanceDocIds = provenance.map((p) => p.knowledgeDocumentId);

  if (provenanceDocIds.includes(unitDocId)) ok("6H.1: relevant Unit knowledge appears in knowledgeProvenance");
  else fail("6H.1: relevant Unit knowledge appears in knowledgeProvenance", JSON.stringify(provenance));
  if (provenanceDocIds.includes(propertyDocId)) ok("6H.2: relevant Property knowledge appears in knowledgeProvenance");
  else fail("6H.2: relevant Property knowledge appears in knowledgeProvenance");
  if (provenanceDocIds.includes(workspaceDocId)) ok("6H.3: relevant Workspace knowledge appears in knowledgeProvenance");
  else fail("6H.3: relevant Workspace knowledge appears in knowledgeProvenance");
  if (provenance.length >= 2) ok("6H.4: multiple knowledge chunks are preserved in provenance together");
  else fail("6H.4: multiple knowledge chunks are preserved in provenance together", `got ${provenance.length}`);

  const allHaveRequiredProvenanceFields = provenance.every(
    (p) => p.knowledgeDocumentId && Number.isInteger(p.version) && typeof p.section === "string" && Number.isInteger(p.chunkIndex) && p.chunkId && p.scope && typeof p.similarityScore === "number" && typeof p.retrievalScore === "number",
  );
  if (allHaveRequiredProvenanceFields) ok("6H.11: every provenance item retains knowledgeDocumentId/version/section/chunkIndex/chunkId/scope/scores");
  else fail("6H.11: every provenance item retains knowledgeDocumentId/version/section/chunkIndex/chunkId/scope/scores", JSON.stringify(provenance));

  // =========================================================
  // 5: no retrieved knowledge
  // =========================================================
  const emptyWs = trackCreated(await expectStatus("6H.5: empty-workspace create", "POST", "/workspaces", { name: `Phase6H Empty WS ${stamp}`, slug: `phase6h-empty-ws-${stamp}` }, 201), "workspaceIds");
  const emptySignal = await createSignal({ workspaceId: emptyWs, type: "maintenance", title: "AC not cooling", description: "Warm air." });
  const emptyRes = await expectStatus("6H.5: intelligence generation with zero eligible knowledge", "POST", `/signals/${emptySignal}/intelligence?workspaceId=${emptyWs}`, null, 200);
  if (Array.isArray(emptyRes.json?.data?.knowledgeProvenance) && emptyRes.json.data.knowledgeProvenance.length === 0) {
    ok("6H.5: knowledgeProvenance is an empty array, not an error, when nothing is retrieved");
  } else {
    fail("6H.5: knowledgeProvenance is an empty array, not an error, when nothing is retrieved", JSON.stringify(emptyRes.json));
  }
  // The existing structured intelligence contract must still be fully present.
  const stillValidShape = ["summary", "findings", "risk", "decision", "action", "outcome", "confidence", "provenance"].every(
    (key) => emptyRes.json?.data?.[key] !== undefined,
  );
  if (stillValidShape) ok("6H.17: existing intelligence schema fields remain present with no knowledge");
  else fail("6H.17: existing intelligence schema fields remain present with no knowledge");

  // =========================================================
  // 14: provider/model provenance remains trusted
  // =========================================================
  if (intelRes.json?.data?.provenance?.provider && intelRes.json?.data?.provenance?.model) {
    ok("6H.14: provider/model provenance is still present and Node/Python-controlled");
  } else {
    fail("6H.14: provider/model provenance is still present and Node/Python-controlled", JSON.stringify(intelRes.json?.data?.provenance));
  }

  // =========================================================
  // 15: cross-workspace knowledge cannot reach Gemini
  // =========================================================
  const wsBDocId = await createAndIndexDocument({ workspaceId: wsB, title: "B's own policy", documentType: "policy", content: KNOWLEDGE_TEXT });
  const wsASignalForCrossCheck = await createSignal({ workspaceId: wsA, type: "maintenance", title: "AC not cooling", description: "Warm air blowing from the unit." });
  const crossRes = await expectStatus("6H.15: generate intelligence for workspace A signal", "POST", `/signals/${wsASignalForCrossCheck}/intelligence?workspaceId=${wsA}`, null, 200);
  const crossProvenanceDocIds = (crossRes.json?.data?.knowledgeProvenance || []).map((p) => p.knowledgeDocumentId);
  if (!crossProvenanceDocIds.includes(wsBDocId)) ok("6H.15: workspace B's knowledge never reaches workspace A's intelligence provenance");
  else fail("6H.15: workspace B's knowledge never reaches workspace A's intelligence provenance", JSON.stringify(crossProvenanceDocIds));

  // =========================================================
  // Tenant isolation on the intelligence endpoint itself (unchanged, re-verified with knowledge active)
  // =========================================================
  await expectStatus("6H: cross-workspace signal returns 404", "POST", `/signals/${signalFull}/intelligence?workspaceId=${wsB}`, null, 404);

  // =========================================================
  // 2-4: retrieval FAILURE must never be treated as "nothing was found"
  // =========================================================
  // A directly-inserted, structurally eligible chunk with a zero-magnitude
  // embedding — the same technique Phase 6G's own candidate-cap test uses.
  // Node's own candidate-selection query only checks embedding presence
  // (`$exists`/`$ne: null`), not validity, so this chunk IS selected and
  // sent to Python — which genuinely rejects the whole request (422,
  // zero-magnitude embedding) via its own real, unmocked validation. No
  // mocking anywhere in this test: the real running Python service really
  // does refuse this request.
  const failureWs = trackCreated(await expectStatus("6H.2-4: failure-test workspace create", "POST", "/workspaces", { name: `Phase6H Failure WS ${stamp}`, slug: `phase6h-failure-ws-${stamp}` }, 201), "workspaceIds");
  const failureDocRes = await expectStatus("6H.2-4: failure-test document create", "POST", "/knowledge-documents", { workspaceId: failureWs, title: "Example: Corrupted Vector Doc", documentType: "guideline", content: "placeholder" }, 201);
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
  const failureRes = await expectStatus(
    "6H.2: a genuine retrieval failure (Python rejects the request) does not return a successful intelligence result",
    "POST",
    `/signals/${failureSignal}/intelligence?workspaceId=${failureWs}`,
    null,
    502,
  );
  if (typeof failureRes.json?.message === "string" && failureRes.json.message.includes("KNOWLEDGE_RETRIEVAL_UNAVAILABLE")) {
    ok("6H.3: retrieval failure is surfaced through the existing application error mechanism with a distinct marker");
  } else {
    fail("6H.3: retrieval failure is surfaced through the existing application error mechanism with a distinct marker", JSON.stringify(failureRes.json));
  }
  if (failureRes.json?.data === undefined) {
    ok("6H.4: no intelligence content is returned when retrieval failed — never presented as knowledge-checked-and-empty");
  } else {
    fail("6H.4: no intelligence content is returned when retrieval failed — never presented as knowledge-checked-and-empty", JSON.stringify(failureRes.json));
  }

  // =========================================================
  // 2-3 (second cause): Python retrieval service genuinely unreachable —
  // a short-lived ephemeral server with a deliberately broken
  // AI_SERVICE_URL, reading the same MongoDB as the main test server
  // (same pattern validate-ai-service.mjs's own "5.6: unreachable Python
  // service" test already uses). wsA already has eligible workspace-wide
  // knowledge from the 1-4 block above, so retrieval genuinely attempts —
  // and genuinely fails — to reach Python, rather than short-circuiting
  // on an empty candidate set before ever trying.
  // =========================================================
  const unreachableSignal = await createSignal({ workspaceId: wsA, type: "maintenance", title: "AC not cooling", description: "Warm air." });
  await withEphemeralServer(5095, { LLM_PROVIDER: "test-python", AI_SERVICE_URL: "http://localhost:5999" }, async (base) => {
    const response = await fetch(`${base}/signals/${unreachableSignal}/intelligence?workspaceId=${wsA}`, { method: "POST" });
    const body = await response.json().catch(() => null);
    if (response.status === 502) {
      ok("6H.2b: Python retrieval service unreachable surfaces as a failure, not empty knowledge");
    } else {
      fail("6H.2b: Python retrieval service unreachable surfaces as a failure, not empty knowledge", `status=${response.status} body=${JSON.stringify(body)}`);
    }
    if (typeof body?.message === "string" && body.message.includes("KNOWLEDGE_RETRIEVAL_UNAVAILABLE")) {
      ok("6H.3b: unreachable-service failure also carries the KNOWLEDGE_RETRIEVAL_UNAVAILABLE marker");
    } else {
      fail("6H.3b: unreachable-service failure also carries the KNOWLEDGE_RETRIEVAL_UNAVAILABLE marker", JSON.stringify(body));
    }
    if (body?.data === undefined) {
      ok("6H.2b: no intelligence content is returned when Python was unreachable for retrieval");
    } else {
      fail("6H.2b: no intelligence content is returned when Python was unreachable for retrieval", JSON.stringify(body));
    }
  });

  // 5 and 6 (existing behavior unchanged): 6H.5 (no-knowledge) and 6H.15
  // (tenant isolation) above are the same, unmodified assertions from
  // before this correction, re-run as part of this same suite run.

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
