/**
 * Phase 7A validation: Decision Foundation.
 *
 * Decision (route -> decisionController -> decisionService -> Decision model)
 * already existed from Phase 2 as a plain CRUD resource. This suite focuses
 * on exactly what Phase 7A adds/hardens on top of that foundation:
 *
 *  - Decision creation must reference an Intelligence record in the SAME
 *    workspace (already implemented by decisionService.createDecision via
 *    findByIdOr404 + assertSameWorkspace — verified here, not re-implemented).
 *  - PATCH must never move a Decision to a different workspace or a
 *    different Intelligence (workspaceId: assertWorkspaceUnchanged, already
 *    implemented; intelligenceId: excluded from UPDATABLE, already
 *    implemented — verified here).
 *  - Status transitions must follow a small deterministic lifecycle instead
 *    of accepting any enum value from any other (this WAS a gap before
 *    Phase 7A — see the DECISION_STATUS_TRANSITIONS map this phase added to
 *    decisionService.js). The existing enum
 *    (proposed/approved/rejected/completed) is reused unchanged.
 *  - No Action or Outcome is ever auto-created as a side effect of creating,
 *    approving, or otherwise updating a Decision (Phase 7B/7C boundary).
 *
 * Runs entirely against its own ephemeral `node server.js` (LLM_PROVIDER=test
 * — irrelevant to this suite functionally, since decisions never call AI,
 * but kept consistent with the project's "deterministic providers only in
 * automated suites" rule). Every fixture is cleaned up from MongoDB at the
 * end, mirroring validate-api.mjs / validate-intelligence.mjs conventions.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { Workspace, Intelligence, Decision, Action, Outcome } from "../src/models/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, "..", "server.js");
const PORT = 5064;
const BASE = `http://localhost:${PORT}/api`;

const created = {
  workspaceIds: [],
  intelligenceIds: [],
  decisionIds: [],
  actionIds: [],
  outcomeIds: [],
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

function assertListIncludes(name, result, expectedId) {
  const rows = result?.json?.data || [];
  if (rows.some((row) => String(row?._id) === String(expectedId))) {
    ok(name, `${rows.length} row(s), includes expected id`);
  } else {
    fail(name, `expected id ${expectedId} missing from list`);
  }
}

function waitForHealth(timeoutMs = 15000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = async () => {
      try {
        const res = await fetch(`${BASE}/health`);
        if (res.ok) {
          resolve();
          return;
        }
      } catch {
        // not ready yet
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Server at ${BASE} did not become healthy in time`));
        return;
      }
      setTimeout(attempt, 200);
    };
    attempt();
  });
}

async function cleanup() {
  await connectDatabase();
  await Promise.all([
    Outcome.deleteMany({ _id: { $in: created.outcomeIds } }),
    Action.deleteMany({ _id: { $in: created.actionIds } }),
    Decision.deleteMany({ _id: { $in: created.decisionIds } }),
    Intelligence.deleteMany({ _id: { $in: created.intelligenceIds } }),
    Workspace.deleteMany({ _id: { $in: created.workspaceIds } }),
  ]);
  await disconnectDatabase();
}

async function main() {
  const stamp = Date.now();
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, PORT: String(PORT), LLM_PROVIDER: "test" },
    stdio: "ignore",
  });

  try {
    await waitForHealth();
    ok("ephemeral backend healthy", BASE);

    // === Fixtures: two workspaces, one Intelligence record each ===
    const wsA = trackCreated(
      await expectStatus("setup: workspace A", "POST", "/workspaces", {
        name: `Phase 7A WS A ${stamp}`,
        slug: `phase-7a-ws-a-${stamp}`,
      }, 201),
      "workspaceIds",
    );
    const wsB = trackCreated(
      await expectStatus("setup: workspace B", "POST", "/workspaces", {
        name: `Phase 7A WS B ${stamp}`,
        slug: `phase-7a-ws-b-${stamp}`,
      }, 201),
      "workspaceIds",
    );

    const intelA = trackCreated(
      await expectStatus("setup: intelligence A", "POST", "/intelligence", { workspaceId: wsA }, 201),
      "intelligenceIds",
    );
    const intelB = trackCreated(
      await expectStatus("setup: intelligence B", "POST", "/intelligence", { workspaceId: wsB }, 201),
      "intelligenceIds",
    );

    const fakeIntelligenceId = "64b64c4f2f1c2e0012345678"; // valid ObjectId shape, no such document

    // === 1: create Decision from valid Intelligence ===
    const decisionARes = await expectStatus(
      "1: create decision from valid intelligence",
      "POST",
      "/decisions",
      { workspaceId: wsA, intelligenceId: intelA, description: "Assign maintenance technician" },
      201,
    );
    const decisionA = trackCreated(decisionARes, "decisionIds");
    const createdBody = decisionARes.json?.data;
    if (createdBody?.status === "proposed" && createdBody?.priority === "medium") {
      ok("1b: default status/priority applied", `status=${createdBody.status}, priority=${createdBody.priority}`);
    } else {
      fail("1b: default status/priority applied", JSON.stringify(createdBody));
    }
    if (String(createdBody?.workspaceId) === String(wsA) && String(createdBody?.intelligenceId) === String(intelA)) {
      ok("1c: workspaceId/intelligenceId persisted correctly");
    } else {
      fail("1c: workspaceId/intelligenceId persisted correctly", JSON.stringify(createdBody));
    }

    // === 2: missing Intelligence ===
    await expectStatus(
      "2: missing intelligence rejected",
      "POST",
      "/decisions",
      { workspaceId: wsA, intelligenceId: fakeIntelligenceId, description: "x" },
      404,
    );

    // === 3 / 15: cross-workspace Intelligence rejected (both directions) ===
    trackCreated(
      await expectStatus(
        "3: cross-workspace intelligence rejected (A -> B's intelligence)",
        "POST",
        "/decisions",
        { workspaceId: wsA, intelligenceId: intelB, description: "x" },
        400,
      ),
      "decisionIds",
    );
    trackCreated(
      await expectStatus(
        "15: cross-workspace intelligence rejected (B -> A's intelligence)",
        "POST",
        "/decisions",
        { workspaceId: wsB, intelligenceId: intelA, description: "x" },
        400,
      ),
      "decisionIds",
    );

    // === 14: required field validation ===
    await expectStatus("14a: missing workspaceId rejected", "POST", "/decisions", { intelligenceId: intelA, description: "x" }, 400);
    await expectStatus("14b: missing intelligenceId rejected", "POST", "/decisions", { workspaceId: wsA, description: "x" }, 400);
    await expectStatus("14c: missing description rejected", "POST", "/decisions", { workspaceId: wsA, intelligenceId: intelA }, 400);

    // === 13: multiple Decisions per Intelligence allowed (no invented uniqueness constraint) ===
    const decisionA2 = trackCreated(
      await expectStatus(
        "13: second decision for same intelligence allowed",
        "POST",
        "/decisions",
        { workspaceId: wsA, intelligenceId: intelA, description: "Second, independent decision" },
        201,
      ),
      "decisionIds",
    );

    // === 4 / 16: workspace-scoped list ===
    assertListIncludes(
      "4a: list scoped to A includes decision A",
      await request("GET", `/decisions?workspaceId=${wsA}&limit=100`),
      decisionA,
    );
    assertListExcludes(
      "4b/16: list scoped to B excludes decision A",
      await request("GET", `/decisions?workspaceId=${wsB}&limit=100`),
      decisionA,
    );
    await expectStatus("4c: list requires workspaceId", "GET", "/decisions", null, 400);

    // === 5: workspace-scoped GET-by-ID ===
    await expectStatus("5: GET decision A with correct workspace", "GET", `/decisions/${decisionA}?workspaceId=${wsA}`, null, 200);

    // === 6: cross-workspace GET-by-ID rejected ===
    await expectStatus("6: GET decision A with B's workspace rejected", "GET", `/decisions/${decisionA}?workspaceId=${wsB}`, null, 404);
    await expectStatus("6b: GET decision A without workspaceId rejected", "GET", `/decisions/${decisionA}`, null, 400);

    // === 7: PATCH mutable fields ===
    const patched = await expectStatus(
      "7: PATCH mutable fields (description, priority)",
      "PATCH",
      `/decisions/${decisionA}?workspaceId=${wsA}`,
      { description: "Assign maintenance technician immediately", priority: "critical" },
      200,
    );
    if (patched.json?.data?.description === "Assign maintenance technician immediately" && patched.json?.data?.priority === "critical") {
      ok("7b: mutable fields actually updated");
    } else {
      fail("7b: mutable fields actually updated", JSON.stringify(patched.json?.data));
    }

    // === 8: PATCH workspaceId blocked ===
    await expectStatus(
      "8: PATCH workspaceId blocked",
      "PATCH",
      `/decisions/${decisionA}?workspaceId=${wsA}`,
      { workspaceId: wsB },
      400,
    );
    const afterWorkspacePatchAttempt = await request("GET", `/decisions/${decisionA}?workspaceId=${wsA}`);
    if (String(afterWorkspacePatchAttempt.json?.data?.workspaceId) === String(wsA)) {
      ok("8b: workspaceId unchanged after blocked attempt");
    } else {
      fail("8b: workspaceId unchanged after blocked attempt", JSON.stringify(afterWorkspacePatchAttempt.json?.data));
    }

    // === 9: PATCH intelligenceId blocked (silently ignored, matches existing Action convention) ===
    await expectStatus(
      "9: PATCH with intelligenceId in body still succeeds (field ignored, not erroring)",
      "PATCH",
      `/decisions/${decisionA}?workspaceId=${wsA}`,
      { intelligenceId: intelB, description: "still referencing intelligence A" },
      200,
    );
    const afterIntelPatchAttempt = await request("GET", `/decisions/${decisionA}?workspaceId=${wsA}`);
    if (String(afterIntelPatchAttempt.json?.data?.intelligenceId) === String(intelA)) {
      ok("9b: intelligenceId unchanged after attempted mutation");
    } else {
      fail("9b: intelligenceId unchanged after attempted mutation", JSON.stringify(afterIntelPatchAttempt.json?.data));
    }

    // === 10: invalid status value rejected ===
    await expectStatus(
      "10: invalid status value rejected",
      "PATCH",
      `/decisions/${decisionA}?workspaceId=${wsA}`,
      { status: "not-a-real-status" },
      400,
    );

    // === 11: valid status transitions (proposed -> approved -> completed) ===
    await expectStatus(
      "11a: valid transition proposed -> approved",
      "PATCH",
      `/decisions/${decisionA}?workspaceId=${wsA}`,
      { status: "approved" },
      200,
    );
    await expectStatus(
      "11b: valid transition approved -> completed",
      "PATCH",
      `/decisions/${decisionA}?workspaceId=${wsA}`,
      { status: "completed" },
      200,
    );

    // === 12: invalid status transition rejected (completed is terminal) ===
    await expectStatus(
      "12a: invalid transition completed -> approved rejected",
      "PATCH",
      `/decisions/${decisionA}?workspaceId=${wsA}`,
      { status: "approved" },
      400,
    );

    // Second fixture decision to test the other rejected branch and the
    // idempotent same-status case without disturbing decisionA's history.
    await expectStatus(
      "11c: valid transition proposed -> rejected",
      "PATCH",
      `/decisions/${decisionA2}?workspaceId=${wsA}`,
      { status: "rejected" },
      200,
    );
    await expectStatus(
      "12b: invalid transition rejected -> approved rejected",
      "PATCH",
      `/decisions/${decisionA2}?workspaceId=${wsA}`,
      { status: "approved" },
      400,
    );
    await expectStatus(
      "12c: idempotent same-status PATCH allowed (not treated as a transition)",
      "PATCH",
      `/decisions/${decisionA2}?workspaceId=${wsA}`,
      { status: "rejected" },
      200,
    );
    await expectStatus(
      "11d: valid transition rejected -> completed",
      "PATCH",
      `/decisions/${decisionA2}?workspaceId=${wsA}`,
      { status: "completed" },
      200,
    );

    // === cross-workspace PATCH rejected ===
    await expectStatus(
      "cross-workspace PATCH rejected (B cannot PATCH A's decision)",
      "PATCH",
      `/decisions/${decisionA}?workspaceId=${wsB}`,
      { description: "hijacked" },
      404,
    );

    // === 17: no automatic Action creation ===
    const actionsForDecisionA = await request("GET", `/actions?workspaceId=${wsA}&decisionId=${decisionA}&limit=100`);
    if ((actionsForDecisionA.json?.data || []).length === 0) {
      ok("17: zero Actions auto-created for decision A");
    } else {
      fail("17: zero Actions auto-created for decision A", JSON.stringify(actionsForDecisionA.json?.data));
    }

    // === 18: no automatic Outcome creation ===
    const outcomesForIntelA = await request("GET", `/outcomes?workspaceId=${wsA}&intelligenceId=${intelA}&limit=100`);
    if ((outcomesForIntelA.json?.data || []).length === 0) {
      ok("18: zero Outcomes exist for intelligence A");
    } else {
      fail("18: zero Outcomes exist for intelligence A", JSON.stringify(outcomesForIntelA.json?.data));
    }

    // === 20: existing tenant isolation regression (Action -> Decision cross-workspace still rejected) ===
    trackCreated(
      await expectStatus(
        "20: action cannot reference another workspace's decision",
        "POST",
        "/actions",
        { workspaceId: wsB, intelligenceId: intelB, decisionId: decisionA, description: "x" },
        400,
      ),
      "actionIds",
    );

    // === 19: existing API regression spot-check (unrelated fields still round-trip) ===
    const typeCheck = await expectStatus(
      "19: decision create preserves free-form `type` field",
      "POST",
      "/decisions",
      { workspaceId: wsA, intelligenceId: intelA, description: "y", type: "service_recovery" },
      201,
    );
    trackCreated(typeCheck, "decisionIds");
    if (typeCheck.json?.data?.type === "service_recovery") {
      ok("19b: type field round-trips unchanged");
    } else {
      fail("19b: type field round-trips unchanged", JSON.stringify(typeCheck.json?.data));
    }

    await cleanup();
    ok("mongodb cleanup");
  } finally {
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
  }

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
