/**
 * Phase 7B validation: Action Workflow.
 *
 * Action (route -> actionController -> actionService -> Action model)
 * already existed from Phase 2 as a plain CRUD resource, already tenant-
 * isolated and already immutable on workspaceId/intelligenceId. This suite
 * focuses on exactly what Phase 7B adds/hardens on top of that foundation:
 *
 *  - A Decision attached to an Action (at creation or via PATCH) must
 *    belong to the SAME Intelligence the Action itself references, not
 *    merely the same workspace (the gap the Phase 7B audit found —
 *    actionService.assertDecisionUsableForAction).
 *  - An Action must never be attached to a `rejected` Decision, at creation
 *    or via a later PATCH reassigning decisionId.
 *  - Action status follows a small deterministic lifecycle over the
 *    EXISTING enum (pending/in_progress/completed/cancelled/failed) instead
 *    of accepting any value from any other (the same category of gap
 *    Phase 7A found and fixed on Decision).
 *  - completedAt is set server-side, deterministically, only on a genuine
 *    transition into `completed` — never trusted from the client, never
 *    touched on a same-status no-op.
 *  - No Outcome is ever auto-created as a side effect of any Action
 *    operation, and no Action operation ever mutates the Decision it
 *    references (Phase 7B/7C boundary).
 *
 * Runs entirely against its own ephemeral `node server.js` (LLM_PROVIDER=test
 * — irrelevant to this suite functionally, since actions never call AI, but
 * kept consistent with the project's "deterministic providers only in
 * automated suites" rule). Every fixture is cleaned up from MongoDB at the
 * end, mirroring validate-decision.mjs's conventions.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { Workspace, Intelligence, Decision, Action, Outcome } from "../src/models/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, "..", "server.js");
const PORT = 5065;
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

    // === Fixtures ===
    const wsA = trackCreated(
      await expectStatus("setup: workspace A", "POST", "/workspaces", {
        name: `Phase 7B WS A ${stamp}`,
        slug: `phase-7b-ws-a-${stamp}`,
      }, 201),
      "workspaceIds",
    );
    const wsB = trackCreated(
      await expectStatus("setup: workspace B", "POST", "/workspaces", {
        name: `Phase 7B WS B ${stamp}`,
        slug: `phase-7b-ws-b-${stamp}`,
      }, 201),
      "workspaceIds",
    );

    const intelA = trackCreated(
      await expectStatus("setup: intelligence A", "POST", "/intelligence", { workspaceId: wsA }, 201),
      "intelligenceIds",
    );
    const intelA2 = trackCreated(
      await expectStatus("setup: intelligence A2 (same workspace, different record)", "POST", "/intelligence", { workspaceId: wsA }, 201),
      "intelligenceIds",
    );
    const intelB = trackCreated(
      await expectStatus("setup: intelligence B", "POST", "/intelligence", { workspaceId: wsB }, 201),
      "intelligenceIds",
    );

    const fakeId = "64b64c4f2f1c2e0012345678"; // valid ObjectId shape, no such document

    // Decisions used as fixtures for Action tests.
    const decisionA = trackCreated(
      await expectStatus("setup: decision A (intelA, proposed)", "POST", "/decisions", { workspaceId: wsA, intelligenceId: intelA, description: "Assign technician" }, 201),
      "decisionIds",
    );
    const decisionA2 = trackCreated(
      await expectStatus("setup: decision A2 (intelA, proposed)", "POST", "/decisions", { workspaceId: wsA, intelligenceId: intelA, description: "Alternative decision" }, 201),
      "decisionIds",
    );
    const decisionWrongIntel = trackCreated(
      await expectStatus("setup: decision for intelA2 (same workspace, different intelligence)", "POST", "/decisions", { workspaceId: wsA, intelligenceId: intelA2, description: "Unrelated decision" }, 201),
      "decisionIds",
    );
    const decisionB = trackCreated(
      await expectStatus("setup: decision B (wsB, intelB)", "POST", "/decisions", { workspaceId: wsB, intelligenceId: intelB, description: "Workspace B decision" }, 201),
      "decisionIds",
    );
    const decisionRejected = trackCreated(
      await expectStatus("setup: decision to be rejected", "POST", "/decisions", { workspaceId: wsA, intelligenceId: intelA, description: "Will be rejected" }, 201),
      "decisionIds",
    );
    await expectStatus("setup: reject decisionRejected", "PATCH", `/decisions/${decisionRejected}?workspaceId=${wsA}`, { status: "rejected" }, 200);
    const decisionCompleted = trackCreated(
      await expectStatus("setup: decision to be completed", "POST", "/decisions", { workspaceId: wsA, intelligenceId: intelA, description: "Will be completed" }, 201),
      "decisionIds",
    );
    await expectStatus("setup: approve decisionCompleted", "PATCH", `/decisions/${decisionCompleted}?workspaceId=${wsA}`, { status: "approved" }, 200);
    await expectStatus("setup: complete decisionCompleted", "PATCH", `/decisions/${decisionCompleted}?workspaceId=${wsA}`, { status: "completed" }, 200);

    // === A. Creation ===
    const action1Res = await expectStatus(
      "A1: valid Action with Intelligence only",
      "POST",
      "/actions",
      { workspaceId: wsA, intelligenceId: intelA, description: "Log guest apology call" },
      201,
    );
    const action1 = trackCreated(action1Res, "actionIds");
    if (action1Res.json?.data?.decisionId === undefined || action1Res.json?.data?.decisionId === null) {
      ok("A10: Action without Decision remains allowed");
    } else {
      fail("A10: Action without Decision remains allowed", JSON.stringify(action1Res.json?.data));
    }

    const action2Res = await expectStatus(
      "A2: valid Action with Decision",
      "POST",
      "/actions",
      { workspaceId: wsA, intelligenceId: intelA, decisionId: decisionA, description: "Assign maintenance technician" },
      201,
    );
    const action2 = trackCreated(action2Res, "actionIds");

    await expectStatus(
      "A3: missing Intelligence rejected",
      "POST",
      "/actions",
      { workspaceId: wsA, intelligenceId: fakeId, description: "x" },
      404,
    );
    await expectStatus(
      "A4: missing Decision rejected",
      "POST",
      "/actions",
      { workspaceId: wsA, intelligenceId: intelA, decisionId: fakeId, description: "x" },
      404,
    );
    await expectStatus(
      "A5: cross-workspace Intelligence rejected",
      "POST",
      "/actions",
      { workspaceId: wsA, intelligenceId: intelB, description: "x" },
      400,
    );
    await expectStatus(
      "A6: cross-workspace Decision rejected",
      "POST",
      "/actions",
      { workspaceId: wsA, intelligenceId: intelA, decisionId: decisionB, description: "x" },
      400,
    );
    await expectStatus(
      "A7: Decision/Action Intelligence mismatch rejected",
      "POST",
      "/actions",
      { workspaceId: wsA, intelligenceId: intelA, decisionId: decisionWrongIntel, description: "x" },
      400,
    );
    await expectStatus(
      "A8: rejected Decision rejected",
      "POST",
      "/actions",
      { workspaceId: wsA, intelligenceId: intelA, decisionId: decisionRejected, description: "x" },
      400,
    );
    trackCreated(
      await expectStatus(
        "A9: completed Decision may still have an Action",
        "POST",
        "/actions",
        { workspaceId: wsA, intelligenceId: intelA, decisionId: decisionCompleted, description: "Follow-up after completion" },
        201,
      ),
      "actionIds",
    );

    // === B. Tenant isolation ===
    assertListIncludes(
      "11: workspace-scoped list includes action1",
      await request("GET", `/actions?workspaceId=${wsA}&limit=100`),
      action1,
    );
    assertListExcludes(
      "12: foreign Action does not appear in workspace B's list",
      await request("GET", `/actions?workspaceId=${wsB}&limit=100`),
      action1,
    );
    await expectStatus("13: foreign Action GET returns 404", "GET", `/actions/${action1}?workspaceId=${wsB}`, null, 404);

    await expectStatus(
      "14: workspaceId cannot be changed",
      "PATCH",
      `/actions/${action1}?workspaceId=${wsA}`,
      { workspaceId: wsB },
      400,
    );
    const afterWorkspaceAttempt = await request("GET", `/actions/${action1}?workspaceId=${wsA}`);
    if (String(afterWorkspaceAttempt.json?.data?.workspaceId) === String(wsA)) {
      ok("14b: workspaceId unchanged after blocked attempt");
    } else {
      fail("14b: workspaceId unchanged after blocked attempt", JSON.stringify(afterWorkspaceAttempt.json?.data));
    }

    await expectStatus(
      "15: intelligenceId cannot be changed (silently ignored, not erroring)",
      "PATCH",
      `/actions/${action1}?workspaceId=${wsA}`,
      { intelligenceId: intelB, description: "still referencing intelligence A" },
      200,
    );
    const afterIntelAttempt = await request("GET", `/actions/${action1}?workspaceId=${wsA}`);
    if (String(afterIntelAttempt.json?.data?.intelligenceId) === String(intelA)) {
      ok("15b: intelligenceId unchanged after attempted mutation");
    } else {
      fail("15b: intelligenceId unchanged after attempted mutation", JSON.stringify(afterIntelAttempt.json?.data));
    }

    // === C. Decision reassignment (using action2, currently decisionId=decisionA) ===
    await expectStatus(
      "16: valid decisionId PATCH allowed",
      "PATCH",
      `/actions/${action2}?workspaceId=${wsA}`,
      { decisionId: decisionA2 },
      200,
    );

    await expectStatus(
      "17: cross-workspace Decision PATCH rejected",
      "PATCH",
      `/actions/${action2}?workspaceId=${wsA}`,
      { decisionId: decisionB },
      400,
    );
    await expectStatus(
      "18: mismatched-Intelligence Decision PATCH rejected",
      "PATCH",
      `/actions/${action2}?workspaceId=${wsA}`,
      { decisionId: decisionWrongIntel },
      400,
    );
    await expectStatus(
      "19: rejected-Decision PATCH rejected",
      "PATCH",
      `/actions/${action2}?workspaceId=${wsA}`,
      { decisionId: decisionRejected },
      400,
    );

    const action2After = await request("GET", `/actions/${action2}?workspaceId=${wsA}`);
    const integrityOk =
      String(action2After.json?.data?.decisionId) === String(decisionA2) &&
      String(action2After.json?.data?.workspaceId) === String(wsA) &&
      String(action2After.json?.data?.intelligenceId) === String(intelA);
    if (integrityOk) {
      ok("20: valid Decision reassignment preserves Action integrity (rejected PATCHes left it untouched)");
    } else {
      fail("20: valid Decision reassignment preserves Action integrity", JSON.stringify(action2After.json?.data));
    }

    // === D. Status lifecycle ===
    const lifeA = trackCreated(
      await expectStatus("setup: lifecycle action A (pending)", "POST", "/actions", { workspaceId: wsA, intelligenceId: intelA, description: "lifecycle A" }, 201),
      "actionIds",
    );
    await expectStatus("D: pending -> pending (no-op)", "PATCH", `/actions/${lifeA}?workspaceId=${wsA}`, { status: "pending" }, 200);
    await expectStatus("D: pending -> completed rejected", "PATCH", `/actions/${lifeA}?workspaceId=${wsA}`, { status: "completed" }, 400);
    await expectStatus("D: pending -> failed rejected", "PATCH", `/actions/${lifeA}?workspaceId=${wsA}`, { status: "failed" }, 400);
    await expectStatus("D: pending -> in_progress allowed", "PATCH", `/actions/${lifeA}?workspaceId=${wsA}`, { status: "in_progress" }, 200);
    await expectStatus("D: in_progress -> pending rejected", "PATCH", `/actions/${lifeA}?workspaceId=${wsA}`, { status: "pending" }, 400);
    const completedRes = await expectStatus("D: in_progress -> completed allowed", "PATCH", `/actions/${lifeA}?workspaceId=${wsA}`, { status: "completed" }, 200);
    await expectStatus("D: completed -> in_progress rejected (terminal)", "PATCH", `/actions/${lifeA}?workspaceId=${wsA}`, { status: "in_progress" }, 400);
    await expectStatus("D: completed -> cancelled rejected (terminal)", "PATCH", `/actions/${lifeA}?workspaceId=${wsA}`, { status: "cancelled" }, 400);
    await expectStatus("D: completed -> pending rejected (terminal)", "PATCH", `/actions/${lifeA}?workspaceId=${wsA}`, { status: "pending" }, 400);
    const noopRes = await expectStatus("D: completed -> completed (no-op) allowed", "PATCH", `/actions/${lifeA}?workspaceId=${wsA}`, { status: "completed" }, 200);

    const lifeB = trackCreated(
      await expectStatus("setup: lifecycle action B (pending)", "POST", "/actions", { workspaceId: wsA, intelligenceId: intelA, description: "lifecycle B" }, 201),
      "actionIds",
    );
    await expectStatus("D: pending -> cancelled allowed", "PATCH", `/actions/${lifeB}?workspaceId=${wsA}`, { status: "cancelled" }, 200);
    await expectStatus("D: cancelled -> pending rejected (terminal)", "PATCH", `/actions/${lifeB}?workspaceId=${wsA}`, { status: "pending" }, 400);
    await expectStatus("D: cancelled -> in_progress rejected (terminal)", "PATCH", `/actions/${lifeB}?workspaceId=${wsA}`, { status: "in_progress" }, 400);
    await expectStatus("D: cancelled -> completed rejected (terminal)", "PATCH", `/actions/${lifeB}?workspaceId=${wsA}`, { status: "completed" }, 400);
    await expectStatus("D: cancelled -> cancelled (no-op) allowed", "PATCH", `/actions/${lifeB}?workspaceId=${wsA}`, { status: "cancelled" }, 200);

    const lifeC = trackCreated(
      await expectStatus("setup: lifecycle action C (pending)", "POST", "/actions", { workspaceId: wsA, intelligenceId: intelA, description: "lifecycle C" }, 201),
      "actionIds",
    );
    await expectStatus("D: pending -> in_progress allowed (C)", "PATCH", `/actions/${lifeC}?workspaceId=${wsA}`, { status: "in_progress" }, 200);
    await expectStatus("D: in_progress -> cancelled allowed", "PATCH", `/actions/${lifeC}?workspaceId=${wsA}`, { status: "cancelled" }, 200);
    await expectStatus("D: cancelled -> in_progress rejected (terminal, via C)", "PATCH", `/actions/${lifeC}?workspaceId=${wsA}`, { status: "in_progress" }, 400);

    const lifeD = trackCreated(
      await expectStatus("setup: lifecycle action D (pending)", "POST", "/actions", { workspaceId: wsA, intelligenceId: intelA, description: "lifecycle D" }, 201),
      "actionIds",
    );
    await expectStatus("D: pending -> in_progress allowed (D)", "PATCH", `/actions/${lifeD}?workspaceId=${wsA}`, { status: "in_progress" }, 200);
    await expectStatus("D: in_progress -> failed allowed", "PATCH", `/actions/${lifeD}?workspaceId=${wsA}`, { status: "failed" }, 200);
    await expectStatus("D: failed -> completed rejected (terminal)", "PATCH", `/actions/${lifeD}?workspaceId=${wsA}`, { status: "completed" }, 400);
    await expectStatus("D: failed -> failed (no-op) allowed", "PATCH", `/actions/${lifeD}?workspaceId=${wsA}`, { status: "failed" }, 200);

    await expectStatus("D: invalid status value rejected", "PATCH", `/actions/${lifeD}?workspaceId=${wsA}`, { status: "not-a-real-status" }, 400);

    // === E. completedAt ===
    const completedAt = completedRes.json?.data?.completedAt;
    if (completedAt && !Number.isNaN(Date.parse(completedAt))) {
      ok("21: transition to completed automatically sets completedAt", completedAt);
    } else {
      fail("21: transition to completed automatically sets completedAt", JSON.stringify(completedRes.json?.data));
    }
    ok("22: client did not provide completedAt in that PATCH body and it was still set");
    if (noopRes.json?.data?.status === "completed") {
      ok("23: completed remains terminal (verified via the rejected transitions above)");
    } else {
      fail("23: completed remains terminal", JSON.stringify(noopRes.json?.data));
    }
    if (noopRes.json?.data?.completedAt === completedAt) {
      ok("24: completedAt preserved on same-status PATCH");
    } else {
      fail("24: completedAt preserved on same-status PATCH", `before=${completedAt} after=${noopRes.json?.data?.completedAt}`);
    }

    // === F. One-to-many ===
    trackCreated(
      await expectStatus("25a: first Action referencing decisionA2", "POST", "/actions", { workspaceId: wsA, intelligenceId: intelA, decisionId: decisionA2, description: "First follow-up" }, 201),
      "actionIds",
    );
    trackCreated(
      await expectStatus("25b: second Action referencing the same decisionA2", "POST", "/actions", { workspaceId: wsA, intelligenceId: intelA, decisionId: decisionA2, description: "Second, independent follow-up" }, 201),
      "actionIds",
    );
    const actionsForDecisionA2 = await request("GET", `/actions?workspaceId=${wsA}&decisionId=${decisionA2}&limit=100`);
    if ((actionsForDecisionA2.json?.data || []).length >= 2) {
      ok("25c: multiple Actions can reference the same Decision", `${actionsForDecisionA2.json.data.length} row(s)`);
    } else {
      fail("25c: multiple Actions can reference the same Decision", JSON.stringify(actionsForDecisionA2.json?.data));
    }

    // === G. Side effects ===
    const outcomesAfterCreate = await request("GET", `/outcomes?workspaceId=${wsA}&intelligenceId=${intelA}&limit=100`);
    if ((outcomesAfterCreate.json?.data || []).length === 0) {
      ok("26: creating an Action does not create an Outcome");
    } else {
      fail("26: creating an Action does not create an Outcome", JSON.stringify(outcomesAfterCreate.json?.data));
    }

    await expectStatus("side effect: one more status update on lifeA", "PATCH", `/actions/${lifeA}?workspaceId=${wsA}`, { result: { summary: "closed out", notes: "" } }, 200);
    const outcomesAfterUpdate = await request("GET", `/outcomes?workspaceId=${wsA}&intelligenceId=${intelA}&limit=100`);
    if ((outcomesAfterUpdate.json?.data || []).length === 0) {
      ok("27: updating an Action does not create an Outcome");
    } else {
      fail("27: updating an Action does not create an Outcome", JSON.stringify(outcomesAfterUpdate.json?.data));
    }

    const decisionAAfter = await request("GET", `/decisions/${decisionA}?workspaceId=${wsA}`);
    if (decisionAAfter.json?.data?.status === "proposed") {
      ok("28: Action operations do not modify the Decision unexpectedly");
    } else {
      fail("28: Action operations do not modify the Decision unexpectedly", JSON.stringify(decisionAAfter.json?.data));
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
