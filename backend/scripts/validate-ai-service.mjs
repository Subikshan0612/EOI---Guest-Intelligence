/**
 * Phase 5 Step 3 validation: Node -> Python AI service deterministic contract.
 *
 * PHASE 24: driven through the ONE generation route, POST /api/intelligence/analyze/:signalId (the legacy
 * POST /api/signals/:id/intelligence and its Node-level providers were retired). Its response is the sanitized public
 * view, so provider/model are asserted from the STORED record. Each delegation check uses a FRESH Signal, because a
 * repeated request for the same (Signal, level) returns the stored analysis without contacting Python at all.
 *
 * Requires a running Python AI service (ai-service/) reachable at PYTHON_BASE
 * (default http://localhost:8000). Its /v1/intelligence/analyze endpoint is a
 * deterministic stub — it never calls Gemini or any other model — so this
 * script never consumes AI provider credits and never depends on a real key.
 *
 * Every Node instance this script spawns is a throwaway `node server.js`
 * process with LLM_PROVIDER=test-python (or a deliberately broken
 * AI_SERVICE_URL) set as an env override — backend/.env is never touched.
 */
import "./lib/authFetch.mjs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { Workspace, Signal, Intelligence } from "../src/models/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, "..", "server.js");

const PYTHON_BASE = process.env.PYTHON_BASE || "http://localhost:8000";

const RISK_LEVELS = ["low", "medium", "high", "critical"];
const ACTION_PRIORITIES = ["low", "medium", "high"];

const created = { workspaceIds: [], signalIds: [] };

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

async function request(base, method, path, body) {
  const response = await fetch(`${base}${path}`, {
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

async function expectStatus(base, name, method, path, body, expectedStatus) {
  const result = await request(base, method, path, body);
  if (result.status === expectedStatus) {
    ok(name, `HTTP ${result.status}`);
  } else {
    fail(name, `expected ${expectedStatus}, got ${result.status}: ${JSON.stringify(result.json)}`);
  }
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

const CONFIDENCE_LEVELS = ["high", "medium", "low"];

function assertValidAnalysisShape(name, data) {
  const problems = [];
  const a = data?.analysis;
  if (typeof a?.situation !== "string" || !a.situation.trim()) problems.push("analysis.situation");
  if (!Array.isArray(a?.evidence) || a.evidence.length === 0) problems.push("analysis.evidence");
  if (typeof a?.impact !== "string" || !a.impact.trim()) problems.push("analysis.impact");
  if (typeof a?.recommendation !== "string" || !a.recommendation.trim()) problems.push("analysis.recommendation");
  if (!CONFIDENCE_LEVELS.includes(a?.confidence)) problems.push("analysis.confidence");
  if (data?.analysisVersion !== "intelligence-v1") problems.push("analysisVersion");
  if (!data?.analysisLevel) problems.push("analysisLevel");
  if ("provider" in (data || {}) || "model" in (data || {})) problems.push("provider/model must not be public");

  if (problems.length) fail(name, `missing/invalid: ${problems.join(", ")}`);
  else ok(name);
}

async function storedRecord(id) {
  await connectDatabase();
  const doc = await Intelligence.findById(id).lean();
  await disconnectDatabase();
  return doc;
}

async function cleanup() {
  await connectDatabase();
  // Phase 7F-C — every successful generate call now persists an
  // Intelligence record; clean those up too, scoped by workspaceId.
  await Intelligence.deleteMany({ workspaceId: { $in: created.workspaceIds } });
  await Signal.deleteMany({ _id: { $in: created.signalIds } });
  await Workspace.deleteMany({ _id: { $in: created.workspaceIds } });
  await disconnectDatabase();
}

async function main() {
  const stamp = Date.now();

  const pythonHealth = await request(PYTHON_BASE, "GET", "/v1/health");
  if (pythonHealth.status === 200 && pythonHealth.json?.status === "healthy") {
    ok("Python AI service reachable", PYTHON_BASE);
  } else {
    fail("Python AI service reachable", `${PYTHON_BASE} — is ai-service running (uvicorn app.main:app --port 8000)?`);
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(1);
  }

  // === Fixture: one signal in workspace A, one in workspace B, no relations
  // needed beyond property (mirrors the minimal real-signal fixture used
  // throughout Phase 5) ===
  let wsA;
  let signalA;
  let wsB;
  let signalB;
  const freshSignals = {};

  await withEphemeralServer(
    5064,
    { LLM_PROVIDER: "test-python", AI_SERVICE_URL: PYTHON_BASE },
    async (base) => {
      const wsARes = await expectStatus(
        base,
        "5: workspace A create",
        "POST",
        "/workspaces",
        { name: `Phase5 WS A ${stamp}`, slug: `phase5-ws-a-${stamp}` },
        201,
      );
      wsA = trackCreated(wsARes, "workspaceIds");

      const signalARes = await expectStatus(
        base,
        "5: signal A create",
        "POST",
        "/signals",
        { workspaceId: wsA, type: "maintenance", severity: "high", title: "AC not cooling" },
        201,
      );
      signalA = trackCreated(signalARes, "signalIds");

      const wsBRes = await expectStatus(
        base,
        "5: workspace B create",
        "POST",
        "/workspaces",
        { name: `Phase5 WS B ${stamp}`, slug: `phase5-ws-b-${stamp}` },
        201,
      );
      wsB = trackCreated(wsBRes, "workspaceIds");

      const signalBRes = await expectStatus(
        base,
        "5: signal B create",
        "POST",
        "/signals",
        { workspaceId: wsB, type: "other", title: "B signal" },
        201,
      );
      signalB = trackCreated(signalBRes, "signalIds");

      // Fresh Signals for the delegation checks that must reach Python (no stored analysis yet).
      for (const label of ["5.5", "5.6", "5.8"]) {
        const res = await expectStatus(base, `5: signal for ${label} create`, "POST", "/signals", { workspaceId: wsA, type: "maintenance", severity: "medium", title: `Fresh signal ${label}` }, 201);
        freshSignals[label] = trackCreated(res, "signalIds");
      }

      // === Valid generate via test-python -> Python deterministic stub ===
      const validRes = await expectStatus(
        base,
        "5.1: valid generate via test-python",
        "POST",
        `/intelligence/analyze/${signalA}?workspaceId=${wsA}`,
        null,
        201,
      );
      assertValidAnalysisShape("5.1: structured V1 shape valid", validRes.json?.data);
      // "test" is Python's own honest self-report (its LLM_PROVIDER default) - Node's "test-python" env value only
      // means "delegate to Python" (Node relays Python's real provenance rather than hard-coding a label).
      const stored = await storedRecord(validRes.json?.data?._id);
      if (stored?.provider === "test") ok("5.1: the STORED provenance honestly reports Python's own provider (test)");
      else fail("5.1: the STORED provenance honestly reports Python's own provider (test)", JSON.stringify({ provider: stored?.provider }));
      if (stored?.model === "deterministic-stub") ok("5.1: the STORED provenance reports the deterministic-stub model");
      else fail("5.1: the STORED provenance reports the deterministic-stub model", JSON.stringify({ model: stored?.model }));
      if (validRes.json?.data?.analysis?.situation?.includes("AC not cooling")) ok("5.1: response is grounded in the actual Signal's own title");
      else fail("5.1: response is grounded in the actual Signal's own title", validRes.json?.data?.analysis?.situation);

      // === Idempotency: the same (Signal, level) returns the STORED analysis (no second generation) ===
      const secondRes = await request(base, "POST", `/intelligence/analyze/${signalA}?workspaceId=${wsA}`, null);
      if (secondRes.status === 200 && secondRes.json?.data?._id === validRes.json?.data?._id && JSON.stringify(secondRes.json.data) === JSON.stringify(validRes.json.data)) {
        ok("5.2: a repeated request returns the same stored analysis (200), identical content");
      } else {
        fail("5.2: a repeated request returns the same stored analysis (200), identical content", `status ${secondRes.status}`);
      }

      // === Tenant boundary: enforced BEFORE Python is ever reached ===
      await expectStatus(
        base,
        "5.3: A cannot generate intelligence for B's signal (test-python mode)",
        "POST",
        `/intelligence/analyze/${signalB}?workspaceId=${wsA}`,
        null,
        404,
      );

      // === Missing workspaceId ===
      await expectStatus(
        base,
        "5.4: missing workspaceId still rejected in test-python mode",
        "POST",
        `/intelligence/analyze/${signalA}`,
        null,
        400,
      );
    },
  );

  // === AI_SERVICE_URL unset while LLM_PROVIDER=test-python -> not configured ===
  await withEphemeralServer(5065, { LLM_PROVIDER: "test-python", AI_SERVICE_URL: "" }, async (base) => {
    // signalA/wsA already exist in the shared MongoDB from the block above.
    await expectStatus(
      base,
      "5.5: test-python without AI_SERVICE_URL -> not configured",
      "POST",
      `/intelligence/analyze/${freshSignals["5.5"]}?workspaceId=${wsA}`,
      null,
      503,
    );
  });

  // === Python unreachable (AI_SERVICE_URL points at a dead port) -> safe error ===
  await withEphemeralServer(
    5066,
    { LLM_PROVIDER: "test-python", AI_SERVICE_URL: "http://localhost:5999" },
    async (base) => {
      const res = await expectStatus(
        base,
        "5.6: unreachable Python service surfaced as a safe application error",
        "POST",
        `/intelligence/analyze/${freshSignals["5.6"]}?workspaceId=${wsA}`,
        null,
        502,
      );
      const text = JSON.stringify(res.json);
      const secretPattern = /ECONNREFUSED|fetch failed|node_modules|at\s+\S+\.js:\d+/i;
      if (!secretPattern.test(text)) {
        ok("5.7: no internal error/stack detail leaked for unreachable Python service");
      } else {
        fail("5.7: no internal error/stack detail leaked for unreachable Python service", text);
      }
    },
  );

  // === Phase 5 Step 4 correction: LLM_PROVIDER=gemini delegates to Python
  // identically to LLM_PROVIDER=test-python. This proves "gemini" is no
  // longer a direct Node->Gemini call - it reaches the
  // same aiServiceClient.js -> Python path, confirmed by getting back
  // Python's own honestly-reported provenance (Python's LLM_PROVIDER default
  // is "test", so the deterministic stub runs — no real Gemini call is made
  // here, only the delegation itself is verified). ===
  await withEphemeralServer(
    5067,
    { LLM_PROVIDER: "gemini", AI_SERVICE_URL: PYTHON_BASE },
    async (base) => {
      const res = await expectStatus(
        base,
        "5.8: LLM_PROVIDER=gemini delegates to Python (Node has no direct provider path any more)",
        "POST",
        `/intelligence/analyze/${freshSignals["5.8"]}?workspaceId=${wsA}`,
        null,
        201,
      );
      assertValidAnalysisShape("5.8: structured V1 shape valid", res.json?.data);
      const stored8 = await storedRecord(res.json?.data?._id);
      if (stored8?.provider === "test") {
        ok("5.8: the STORED provenance is Python's own honest self-report, proving delegation occurred");
      } else {
        fail("5.8: the STORED provenance is Python's own honest self-report, proving delegation occurred", JSON.stringify({ provider: stored8?.provider }));
      }

      // Tenant/context validation still happens in Node, before Python is
      // ever reached, even on this "gemini" trigger value.
      await expectStatus(
        base,
        "5.9: tenant isolation still enforced in Node before Python (gemini trigger)",
        "POST",
        `/intelligence/analyze/${signalB}?workspaceId=${wsA}`,
        null,
        404,
      );
    },
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
