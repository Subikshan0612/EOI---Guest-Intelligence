/**
 * Phase 4 validation: POST /api/signals/:id/intelligence
 *
 * Runs against ONE already-running backend process:
 *
 *  - TEST_BASE (default http://localhost:5057/api): a backend started with
 *    LLM_PROVIDER=test, so every AI call is answered by the deterministic
 *    in-process test provider (backend/src/services/ai/llmProvider.js). No
 *    network call, no API credits, fully reproducible. Its per-request
 *    `__testScenario` query param (honored ONLY when LLM_PROVIDER=test) lets
 *    this script exercise malformed/invalid/failure paths deterministically.
 *
 * Every provider-configuration edge case — "not configured" (gemini without
 * AI_SERVICE_URL, openai without a key), "unsupported provider value" — is
 * exercised by briefly
 * spawning its own throwaway backend process with `withEphemeralServer()`
 * below, with the relevant provider/key env vars explicitly overridden
 * (including explicitly cleared, e.g. `LLM_PROVIDER: ""`). This script
 * deliberately never depends on the ordinary dev backend's (port 5000)
 * ambient configuration for any assertion: a developer's real
 * backend/.env may have a working Gemini/OpenAI key at any moment, and an
 * earlier version of this suite that assumed port 5000 was always
 * "unconfigured" ended up silently firing a real Gemini request once a key
 * was added locally. Every fixture this script creates lives in the same
 * MongoDB as the dev backend, so nothing here requires port 5000 at all.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { Workspace, Property, Unit, Guest, Stay, Signal } from "../src/models/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, "..", "server.js");

const TEST_BASE = process.env.TEST_BASE || "http://localhost:5057/api";

const RISK_LEVELS = ["low", "medium", "high", "critical"];
const ACTION_PRIORITIES = ["low", "medium", "high"];

const created = {
  workspaceIds: [],
  propertyIds: [],
  unitIds: [],
  guestIds: [],
  stayIds: [],
  signalIds: [],
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

/**
 * Spawns a throwaway `node server.js` with the given env overrides layered
 * on top of this process's own env, waits for it to report healthy, runs
 * `fn(base)` against it, then always kills it — used only to exercise
 * provider-configuration edge cases without touching backend/.env or the
 * already-running TEST_BASE server.
 */
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
    // Brief settle time before the next spawn — avoids resource contention
    // when several ephemeral servers start in quick succession.
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function trackCreated(result, bucket) {
  const id = result?.json?.data?._id;
  if (id && !created[bucket].includes(id)) created[bucket].push(id);
  return id;
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
  await Signal.deleteMany({ _id: { $in: created.signalIds } });
  await Stay.deleteMany({ _id: { $in: created.stayIds } });
  await Guest.deleteMany({ _id: { $in: created.guestIds } });
  await Unit.deleteMany({ _id: { $in: created.unitIds } });
  await Property.deleteMany({ _id: { $in: created.propertyIds } });
  await Workspace.deleteMany({ _id: { $in: created.workspaceIds } });
  await disconnectDatabase();
}

async function main() {
  const stamp = Date.now();

  const testHealth = await request(TEST_BASE, "GET", "/health");
  if (testHealth.status === 200) ok("test-provider backend reachable", TEST_BASE);
  else {
    fail("test-provider backend reachable", `${TEST_BASE} — is it running with LLM_PROVIDER=test?`);
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(1);
  }

  // --- Fixture: workspace A with a fully-linked signal + a bare signal ---
  const wsARes = await expectStatus(
    TEST_BASE,
    "4: workspace A create",
    "POST",
    "/workspaces",
    { name: `Phase4 WS A ${stamp}`, slug: `phase4-ws-a-${stamp}` },
    201,
  );
  const wsA = trackCreated(wsARes, "workspaceIds");

  const propertyRes = await expectStatus(
    TEST_BASE,
    "4: property create",
    "POST",
    "/properties",
    { workspaceId: wsA, name: "Phase 4 Residency", code: `P4${stamp}` },
    201,
  );
  const propertyId = trackCreated(propertyRes, "propertyIds");

  const unitRes = await expectStatus(
    TEST_BASE,
    "4: unit create",
    "POST",
    "/units",
    { workspaceId: wsA, propertyId, unitNumber: "401" },
    201,
  );
  const unitId = trackCreated(unitRes, "unitIds");

  const guestRes = await expectStatus(
    TEST_BASE,
    "4: guest create",
    "POST",
    "/guests",
    { workspaceId: wsA, firstName: "Ada", lastName: "Rao" },
    201,
  );
  const guestId = trackCreated(guestRes, "guestIds");

  const stayRes = await expectStatus(
    TEST_BASE,
    "4: stay create",
    "POST",
    "/stays",
    { workspaceId: wsA, guestId, propertyId, unitId, status: "checked_in", checkIn: new Date().toISOString() },
    201,
  );
  const stayId = trackCreated(stayRes, "stayIds");

  const signalRes = await expectStatus(
    TEST_BASE,
    "4: signal create",
    "POST",
    "/signals",
    {
      workspaceId: wsA,
      propertyId,
      unitId,
      guestId,
      stayId,
      type: "complaint",
      severity: "high",
      title: "Noise complaint",
    },
    201,
  );
  const signalId = trackCreated(signalRes, "signalIds");

  const bareSignalRes = await expectStatus(
    TEST_BASE,
    "4: bare signal (no relations) create",
    "POST",
    "/signals",
    { workspaceId: wsA, type: "other", title: "Unlinked signal" },
    201,
  );
  const bareSignalId = trackCreated(bareSignalRes, "signalIds");

  const wsBRes = await expectStatus(
    TEST_BASE,
    "4: workspace B create",
    "POST",
    "/workspaces",
    { name: `Phase4 WS B ${stamp}`, slug: `phase4-ws-b-${stamp}` },
    201,
  );
  const wsB = trackCreated(wsBRes, "workspaceIds");

  const signalBRes = await expectStatus(
    TEST_BASE,
    "4: signal B create",
    "POST",
    "/signals",
    { workspaceId: wsB, type: "other", title: "B signal" },
    201,
  );
  const signalB = trackCreated(signalBRes, "signalIds");

  // === 1 & 8: valid signal + valid workspace -> successful structured AI response ===
  const validRes = await expectStatus(
    TEST_BASE,
    "4.1: valid generate",
    "POST",
    `/signals/${signalId}/intelligence?workspaceId=${wsA}`,
    null,
    200,
  );
  assertValidIntelligenceShape("4.1/4.8: structured shape valid", validRes.json?.data);
  if (validRes.json?.data?.provenance?.provider === "test") {
    ok("4.8: provenance honestly reports the test provider");
  } else {
    fail("4.8: provenance honestly reports the test provider", JSON.stringify(validRes.json?.data?.provenance));
  }

  // === 2: missing workspaceId ===
  await expectStatus(
    TEST_BASE,
    "4.2: missing workspaceId",
    "POST",
    `/signals/${signalId}/intelligence`,
    null,
    400,
  );

  // === 3: invalid signal id ===
  await expectStatus(
    TEST_BASE,
    "4.3: invalid signal id",
    "POST",
    `/signals/not-an-id/intelligence?workspaceId=${wsA}`,
    null,
    400,
  );

  // === 4 & 5: signal belonging to another workspace cannot leak / cannot be used ===
  await expectStatus(
    TEST_BASE,
    "4.4: A cannot generate intelligence for B's signal",
    "POST",
    `/signals/${signalB}/intelligence?workspaceId=${wsA}`,
    null,
    404,
  );
  await expectStatus(
    TEST_BASE,
    "4.5: B can generate intelligence for its own signal (isolation control)",
    "POST",
    `/signals/${signalB}/intelligence?workspaceId=${wsB}`,
    null,
    200,
  );

  // === Provider-selection edge cases: each spawns its own throwaway server ===
  // Phase 5 Step 4 correction: LLM_PROVIDER=gemini now delegates to the
  // Python AI service (aiServiceClient.js) rather than calling Gemini
  // directly from Node — so "not configured" here means "no AI_SERVICE_URL
  // reachable," not "no GEMINI_API_KEY" (Node no longer reads that key for
  // this value at all). GEMINI_API_KEY is still cleared defensively.
  await withEphemeralServer(
    5058,
    { LLM_PROVIDER: "gemini", GEMINI_API_KEY: "", AI_SERVICE_URL: "" },
    async (base) => {
      await expectStatus(
        base,
        "4G.1: LLM_PROVIDER=gemini without AI_SERVICE_URL -> not configured",
        "POST",
        `/signals/${signalId}/intelligence?workspaceId=${wsA}`,
        null,
        503,
      );
    },
  );

  await withEphemeralServer(5059, { LLM_PROVIDER: "openai", OPENAI_API_KEY: "" }, async (base) => {
    await expectStatus(
      base,
      "4G.2: LLM_PROVIDER=openai without a key -> not configured",
      "POST",
      `/signals/${signalId}/intelligence?workspaceId=${wsA}`,
      null,
      503,
    );
  });

  // Note: ports 5060/5061 (SIP/SIPS) are deliberately avoided — they're on
  // the Fetch spec's "bad ports" list, which Node's native fetch() (undici)
  // refuses to connect to, the same restriction browsers enforce.
  await withEphemeralServer(5062, { LLM_PROVIDER: "not-a-real-provider" }, async (base) => {
    await expectStatus(
      base,
      "4G.3: unsupported LLM_PROVIDER value -> not configured",
      "POST",
      `/signals/${signalId}/intelligence?workspaceId=${wsA}`,
      null,
      503,
    );
  });

  // === 6: missing related records (no guest/stay/property/unit) handled safely ===
  const bareRes = await expectStatus(
    TEST_BASE,
    "4.6: bare signal generates safely",
    "POST",
    `/signals/${bareSignalId}/intelligence?workspaceId=${wsA}`,
    null,
    200,
  );
  assertValidIntelligenceShape("4.6: bare-signal result shape valid", bareRes.json?.data);

  // === 7: AI provider not configured ===
  // Deliberately an ephemeral spawn with LLM_PROVIDER explicitly cleared,
  // rather than relying on the ordinary dev backend (port 5000) to happen to
  // have no provider configured. A developer's real backend/.env may have a
  // working Gemini/OpenAI key at any time — trusting that ambient state
  // caused this exact test to silently fire a real Gemini request once a
  // key was added locally. This spawn can never do that.
  let notConfiguredRes;
  await withEphemeralServer(5063, { LLM_PROVIDER: "", GEMINI_API_KEY: "", OPENAI_API_KEY: "" }, async (base) => {
    notConfiguredRes = await expectStatus(
      base,
      "4.7: AI not configured",
      "POST",
      `/signals/${signalId}/intelligence?workspaceId=${wsA}`,
      null,
      503,
    );
  });

  // === 9-13: deterministic failure scenarios via the LLM_PROVIDER=test-only scenario hook ===
  await expectStatus(
    TEST_BASE,
    "4.9: malformed AI response rejected",
    "POST",
    `/signals/${signalId}/intelligence?workspaceId=${wsA}&__testScenario=malformed`,
    null,
    502,
  );
  await expectStatus(
    TEST_BASE,
    "4.10: invalid risk level rejected",
    "POST",
    `/signals/${signalId}/intelligence?workspaceId=${wsA}&__testScenario=invalid-risk`,
    null,
    502,
  );
  await expectStatus(
    TEST_BASE,
    "4.11: invalid confidence rejected",
    "POST",
    `/signals/${signalId}/intelligence?workspaceId=${wsA}&__testScenario=invalid-confidence`,
    null,
    502,
  );
  await expectStatus(
    TEST_BASE,
    "4.12: provider failure surfaced as a safe application error",
    "POST",
    `/signals/${signalId}/intelligence?workspaceId=${wsA}&__testScenario=provider-error`,
    null,
    502,
  );
  await expectStatus(
    TEST_BASE,
    "4.13: provider timeout surfaced as a safe application error",
    "POST",
    `/signals/${signalId}/intelligence?workspaceId=${wsA}&__testScenario=timeout`,
    null,
    504,
  );

  // === 14: no secret/provider-internal leakage in any error response ===
  const scenarios = ["malformed", "invalid-risk", "invalid-confidence", "provider-error", "timeout"];
  const responses = await Promise.all(
    scenarios.map((scenario) =>
      request(TEST_BASE, "POST", `/signals/${signalId}/intelligence?workspaceId=${wsA}&__testScenario=${scenario}`, null),
    ),
  );
  responses.push(notConfiguredRes);

  const secretPattern = /sk-[A-Za-z0-9]{10,}|OPENAI_API_KEY|Authorization:\s*Bearer/i;
  const leaked = responses.some((res) => secretPattern.test(JSON.stringify(res.json)));
  if (!leaked) ok("4.14: no secret/credential leakage across any failure response");
  else fail("4.14: no secret/credential leakage across any failure response");

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
