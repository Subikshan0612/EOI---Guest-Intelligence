/**
 * Phase 5 Step 3 validation: Node -> Python AI service deterministic contract.
 *
 * Requires a running Python AI service (ai-service/) reachable at PYTHON_BASE
 * (default http://localhost:8000). Its /v1/intelligence/signal endpoint is a
 * deterministic stub — it never calls Gemini or any other model — so this
 * script never consumes AI provider credits and never depends on a real key.
 *
 * Every Node instance this script spawns is a throwaway `node server.js`
 * process with LLM_PROVIDER=test-python (or a deliberately broken
 * AI_SERVICE_URL) set as an env override — backend/.env is never touched.
 */
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

function assertValidIntelligenceShape(name, data) {
  const problems = [];
  if (typeof data?.summary !== "string" || !data.summary.trim()) problems.push("summary");
  if (!Array.isArray(data?.findings)) problems.push("findings");
  if (!RISK_LEVELS.includes(data?.risk?.level)) problems.push("risk.level");
  if (typeof data?.risk?.reason !== "string" || !data.risk.reason.trim()) problems.push("risk.reason");
  if (typeof data?.decision?.recommendation !== "string" || !data.decision.recommendation.trim()) {
    problems.push("decision.recommendation");
  }
  if (typeof data?.action?.label !== "string" || !data.action.label.trim()) problems.push("action.label");
  if (
    !Array.isArray(data?.action?.recommended) ||
    !data.action.recommended.every((step) => ACTION_PRIORITIES.includes(step?.priority))
  ) {
    problems.push("action.recommended");
  }
  if (typeof data?.outcome?.expected !== "string") problems.push("outcome.expected");
  if (typeof data?.confidence !== "number" || data.confidence < 0 || data.confidence > 1) {
    problems.push("confidence");
  }
  if (!data?.provenance?.provider || !data?.provenance?.model) problems.push("provenance");

  if (problems.length) fail(name, `missing/invalid: ${problems.join(", ")}`);
  else ok(name);
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

      // === Valid generate via test-python -> Python deterministic stub ===
      const validRes = await expectStatus(
        base,
        "5.1: valid generate via test-python",
        "POST",
        `/signals/${signalA}/intelligence?workspaceId=${wsA}`,
        null,
        200,
      );
      assertValidIntelligenceShape("5.1: structured shape valid", validRes.json?.data);
      // "test" is Python's own honest self-report (its LLM_PROVIDER default)
      // — Node's "test-python" env value only means "delegate to Python"
      // (Phase 5 Step 4: Node relays Python's real provenance rather than
      // hard-coding a label).
      if (validRes.json?.data?.provenance?.provider === "test") {
        ok("5.1: provenance honestly reports Python's own provider (test)");
      } else {
        fail("5.1: provenance honestly reports Python's own provider (test)", JSON.stringify(validRes.json?.data?.provenance));
      }
      if (validRes.json?.data?.provenance?.model === "deterministic-stub") {
        ok("5.1: provenance reports the deterministic-stub model");
      } else {
        fail("5.1: provenance reports the deterministic-stub model", JSON.stringify(validRes.json?.data?.provenance));
      }
      if (validRes.json?.data?.summary?.includes("AC not cooling")) {
        ok("5.1: response is grounded in the actual Signal's own title");
      } else {
        fail("5.1: response is grounded in the actual Signal's own title", validRes.json?.data?.summary);
      }

      // === Determinism: the same signal generates identical CONTENT twice ===
      // Phase 7F-C: each generation now persists its own Intelligence record,
      // so `_id`/`createdAt` legitimately differ between the two calls even
      // though the deterministic stub's actual content does not — those two
      // identity fields are excluded from the comparison below rather than
      // the whole response, so this still genuinely verifies determinism of
      // generation, not persistence identity.
      const secondRes = await request(base, "POST", `/signals/${signalA}/intelligence?workspaceId=${wsA}`, null);
      const stripIdentity = ({ _id, createdAt, ...rest }) => rest;
      if (
        validRes.json?.data &&
        secondRes.json?.data &&
        JSON.stringify(stripIdentity(secondRes.json.data)) === JSON.stringify(stripIdentity(validRes.json.data))
      ) {
        ok("5.2: repeated generation is deterministic (identical content)");
      } else {
        fail("5.2: repeated generation is deterministic (identical content)");
      }
      if (secondRes.json?.data?._id && secondRes.json.data._id !== validRes.json?.data?._id) {
        ok("5.2b: repeated generation persists a distinct Intelligence record each time");
      } else {
        fail("5.2b: repeated generation persists a distinct Intelligence record each time", JSON.stringify(secondRes.json?.data?._id));
      }

      // === Tenant boundary: enforced BEFORE Python is ever reached ===
      await expectStatus(
        base,
        "5.3: A cannot generate intelligence for B's signal (test-python mode)",
        "POST",
        `/signals/${signalB}/intelligence?workspaceId=${wsA}`,
        null,
        404,
      );

      // === Missing workspaceId ===
      await expectStatus(
        base,
        "5.4: missing workspaceId still rejected in test-python mode",
        "POST",
        `/signals/${signalA}/intelligence`,
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
      `/signals/${signalA}/intelligence?workspaceId=${wsA}`,
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
        `/signals/${signalA}/intelligence?workspaceId=${wsA}`,
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
  // longer a direct Node->Gemini call (llmProvider.js) — it now reaches the
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
        "5.8: LLM_PROVIDER=gemini delegates to Python (not the direct llmProvider.js path)",
        "POST",
        `/signals/${signalA}/intelligence?workspaceId=${wsA}`,
        null,
        200,
      );
      assertValidIntelligenceShape("5.8: structured shape valid", res.json?.data);
      if (res.json?.data?.provenance?.provider === "test") {
        ok("5.8: provenance is Python's own honest self-report, proving delegation occurred");
      } else {
        fail(
          "5.8: provenance is Python's own honest self-report, proving delegation occurred",
          JSON.stringify(res.json?.data?.provenance),
        );
      }

      // Tenant/context validation still happens in Node, before Python is
      // ever reached, even on this "gemini" trigger value.
      await expectStatus(
        base,
        "5.9: tenant isolation still enforced in Node before Python (gemini trigger)",
        "POST",
        `/signals/${signalB}/intelligence?workspaceId=${wsA}`,
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
