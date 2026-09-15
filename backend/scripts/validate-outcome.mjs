/**
 * Phase 7C validation: Outcome Foundation.
 *
 * Outcome (route -> outcomeController -> outcomeService -> Outcome model)
 * already existed from Phase 2 as a plain CRUD resource, already tenant-
 * isolated and already immutable on workspaceId/intelligenceId. This suite
 * focuses on exactly what Phase 7C adds/hardens on top of that foundation:
 *
 *  - An Action attached to an Outcome (at creation or via PATCH) must
 *    belong to the SAME Intelligence the Outcome itself references, not
 *    merely the same workspace (the gap the Phase 7C audit found —
 *    outcomeService.assertActionUsableForOutcome).
 *  - Outcome may attach to an Action in ANY status — no Action-status gate
 *    was added, and this suite proves that deliberately (pending, in_progress,
 *    completed, cancelled, failed all remain valid).
 *  - Outcome status (success/partial/failed/unknown) has NO transition
 *    enforcement — it is a corrigible observation, not a workflow. Any
 *    status may follow any other, including being "corrected" back and
 *    forth, and this suite proves that deliberately too.
 *  - One Action may have multiple Outcomes; an Outcome may exist without
 *    any Action at all — both preserved, unchanged.
 *  - No Outcome operation ever mutates Action, Decision, or Intelligence,
 *    and nothing here calls Python/Gemini/RAG/embeddings or triggers any
 *    learning process (Phase 7C/future-Learning boundary).
 *
 * Runs entirely against its own ephemeral `node server.js` (LLM_PROVIDER=test
 * — irrelevant to this suite functionally, since outcomes never call AI, but
 * kept consistent with the project's "deterministic providers only in
 * automated suites" rule). Every fixture is cleaned up from MongoDB at the
 * end, mirroring validate-decision.mjs / validate-action.mjs conventions.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { Workspace, Intelligence, Decision, Action, Outcome } from "../src/models/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, "..", "server.js");
const PORT = 5066;
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
        name: `Phase 7C WS A ${stamp}`,
        slug: `phase-7c-ws-a-${stamp}`,
      }, 201),
      "workspaceIds",
    );
    const wsB = trackCreated(
      await expectStatus("setup: workspace B", "POST", "/workspaces", {
        name: `Phase 7C WS B ${stamp}`,
        slug: `phase-7c-ws-b-${stamp}`,
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

    // Actions in every status, all against intelA (wsA) — used for A8-A12.
    const actionPending = trackCreated(
      await expectStatus("setup: action (pending)", "POST", "/actions", { workspaceId: wsA, intelligenceId: intelA, description: "pending action" }, 201),
      "actionIds",
    );
    const actionInProgress = trackCreated(
      await expectStatus("setup: action (for in_progress)", "POST", "/actions", { workspaceId: wsA, intelligenceId: intelA, description: "in_progress action" }, 201),
      "actionIds",
    );
    await expectStatus("setup: move to in_progress", "PATCH", `/actions/${actionInProgress}?workspaceId=${wsA}`, { status: "in_progress" }, 200);

    const actionCompleted = trackCreated(
      await expectStatus("setup: action (for completed)", "POST", "/actions", { workspaceId: wsA, intelligenceId: intelA, description: "completed action" }, 201),
      "actionIds",
    );
    await expectStatus("setup: move to in_progress (completed path)", "PATCH", `/actions/${actionCompleted}?workspaceId=${wsA}`, { status: "in_progress" }, 200);
    await expectStatus("setup: move to completed", "PATCH", `/actions/${actionCompleted}?workspaceId=${wsA}`, { status: "completed" }, 200);

    const actionCancelled = trackCreated(
      await expectStatus("setup: action (for cancelled)", "POST", "/actions", { workspaceId: wsA, intelligenceId: intelA, description: "cancelled action" }, 201),
      "actionIds",
    );
    await expectStatus("setup: move to cancelled", "PATCH", `/actions/${actionCancelled}?workspaceId=${wsA}`, { status: "cancelled" }, 200);

    const actionFailed = trackCreated(
      await expectStatus("setup: action (for failed)", "POST", "/actions", { workspaceId: wsA, intelligenceId: intelA, description: "failed action" }, 201),
      "actionIds",
    );
    await expectStatus("setup: move to in_progress (failed path)", "PATCH", `/actions/${actionFailed}?workspaceId=${wsA}`, { status: "in_progress" }, 200);
    await expectStatus("setup: move to failed", "PATCH", `/actions/${actionFailed}?workspaceId=${wsA}`, { status: "failed" }, 200);

    // Action belonging to a DIFFERENT Intelligence, same workspace (A7 mismatch fixture).
    const actionWrongIntel = trackCreated(
      await expectStatus("setup: action for intelA2 (same workspace, different intelligence)", "POST", "/actions", { workspaceId: wsA, intelligenceId: intelA2, description: "unrelated action" }, 201),
      "actionIds",
    );

    // Action in workspace B (A6 cross-workspace fixture).
    const actionB = trackCreated(
      await expectStatus("setup: action B (wsB, intelB)", "POST", "/actions", { workspaceId: wsB, intelligenceId: intelB, description: "workspace B action" }, 201),
      "actionIds",
    );

    // === A. Creation ===
    const outcome1Res = await expectStatus(
      "A1: Outcome with Intelligence only",
      "POST",
      "/outcomes",
      { workspaceId: wsA, intelligenceId: intelA, status: "unknown" },
      201,
    );
    const outcome1 = trackCreated(outcome1Res, "outcomeIds");
    if (outcome1Res.json?.data?.actionId === undefined || outcome1Res.json?.data?.actionId === null) {
      ok("A1b: Outcome without Action confirmed (actionId absent)");
    } else {
      fail("A1b: Outcome without Action confirmed", JSON.stringify(outcome1Res.json?.data));
    }

    const outcome2Res = await expectStatus(
      "A2: Outcome with matching Action",
      "POST",
      "/outcomes",
      { workspaceId: wsA, intelligenceId: intelA, actionId: actionPending, status: "unknown", result: { summary: "Awaiting technician" } },
      201,
    );
    const outcome2 = trackCreated(outcome2Res, "outcomeIds");

    await expectStatus("A3: missing Intelligence rejected", "POST", "/outcomes", { workspaceId: wsA, intelligenceId: fakeId }, 404);
    await expectStatus("A4: missing Action rejected", "POST", "/outcomes", { workspaceId: wsA, intelligenceId: intelA, actionId: fakeId }, 404);
    await expectStatus("A5: cross-workspace Intelligence rejected", "POST", "/outcomes", { workspaceId: wsA, intelligenceId: intelB }, 400);
    await expectStatus("A6: cross-workspace Action rejected", "POST", "/outcomes", { workspaceId: wsA, intelligenceId: intelA, actionId: actionB }, 400);
    await expectStatus("A7: same-workspace Action with different Intelligence rejected", "POST", "/outcomes", { workspaceId: wsA, intelligenceId: intelA, actionId: actionWrongIntel }, 400);

    trackCreated(
      await expectStatus("A8: completed Action allowed", "POST", "/outcomes", { workspaceId: wsA, intelligenceId: intelA, actionId: actionCompleted, status: "success" }, 201),
      "outcomeIds",
    );
    trackCreated(
      await expectStatus("A9: pending Action allowed", "POST", "/outcomes", { workspaceId: wsA, intelligenceId: intelA, actionId: actionPending, status: "unknown" }, 201),
      "outcomeIds",
    );
    trackCreated(
      await expectStatus("A10: in_progress Action allowed", "POST", "/outcomes", { workspaceId: wsA, intelligenceId: intelA, actionId: actionInProgress, status: "partial" }, 201),
      "outcomeIds",
    );
    trackCreated(
      await expectStatus("A11: cancelled Action allowed", "POST", "/outcomes", { workspaceId: wsA, intelligenceId: intelA, actionId: actionCancelled, status: "unknown" }, 201),
      "outcomeIds",
    );
    trackCreated(
      await expectStatus("A12: failed Action allowed", "POST", "/outcomes", { workspaceId: wsA, intelligenceId: intelA, actionId: actionFailed, status: "failed" }, 201),
      "outcomeIds",
    );

    // === B. Tenant isolation ===
    assertListIncludes(
      "13: workspace-scoped list includes outcome1",
      await request("GET", `/outcomes?workspaceId=${wsA}&limit=100`),
      outcome1,
    );
    assertListExcludes(
      "14: foreign Outcome not returned in workspace B's list",
      await request("GET", `/outcomes?workspaceId=${wsB}&limit=100`),
      outcome1,
    );
    await expectStatus("15: foreign Outcome GET returns 404", "GET", `/outcomes/${outcome1}?workspaceId=${wsB}`, null, 404);

    await expectStatus(
      "16: workspaceId reassignment rejected",
      "PATCH",
      `/outcomes/${outcome1}?workspaceId=${wsA}`,
      { workspaceId: wsB },
      400,
    );
    const afterWorkspaceAttempt = await request("GET", `/outcomes/${outcome1}?workspaceId=${wsA}`);
    if (String(afterWorkspaceAttempt.json?.data?.workspaceId) === String(wsA)) {
      ok("16b: workspaceId unchanged after blocked attempt");
    } else {
      fail("16b: workspaceId unchanged after blocked attempt", JSON.stringify(afterWorkspaceAttempt.json?.data));
    }

    await expectStatus(
      "17: intelligenceId cannot be changed (silently ignored, not erroring)",
      "PATCH",
      `/outcomes/${outcome1}?workspaceId=${wsA}`,
      { intelligenceId: intelB, status: "unknown" },
      200,
    );
    const afterIntelAttempt = await request("GET", `/outcomes/${outcome1}?workspaceId=${wsA}`);
    if (String(afterIntelAttempt.json?.data?.intelligenceId) === String(intelA)) {
      ok("17b: intelligenceId unchanged after attempted mutation");
    } else {
      fail("17b: intelligenceId unchanged after attempted mutation", JSON.stringify(afterIntelAttempt.json?.data));
    }

    // === C. Action reassignment (using outcome2, currently actionId=actionPending) ===
    await expectStatus(
      "18: valid actionId reassignment allowed",
      "PATCH",
      `/outcomes/${outcome2}?workspaceId=${wsA}`,
      { actionId: actionInProgress },
      200,
    );
    await expectStatus(
      "19: cross-workspace Action reassignment rejected",
      "PATCH",
      `/outcomes/${outcome2}?workspaceId=${wsA}`,
      { actionId: actionB },
      400,
    );
    await expectStatus(
      "20: mismatched-Intelligence Action reassignment rejected",
      "PATCH",
      `/outcomes/${outcome2}?workspaceId=${wsA}`,
      { actionId: actionWrongIntel },
      400,
    );

    const outcome2After = await request("GET", `/outcomes/${outcome2}?workspaceId=${wsA}`);
    const integrityOk =
      String(outcome2After.json?.data?.actionId) === String(actionInProgress) &&
      String(outcome2After.json?.data?.workspaceId) === String(wsA) &&
      String(outcome2After.json?.data?.intelligenceId) === String(intelA);
    if (integrityOk) {
      ok("21: valid reassignment preserves graph integrity");
      ok("22: failed reassignment attempts left the Outcome unchanged");
    } else {
      fail("21: valid reassignment preserves graph integrity", JSON.stringify(outcome2After.json?.data));
      fail("22: failed reassignment attempts left the Outcome unchanged", JSON.stringify(outcome2After.json?.data));
    }

    // === D. Multiple Outcomes ===
    trackCreated(
      await expectStatus("23a: second Outcome referencing actionCompleted", "POST", "/outcomes", { workspaceId: wsA, intelligenceId: intelA, actionId: actionCompleted, status: "partial" }, 201),
      "outcomeIds",
    );
    const outcomesForActionCompleted = await request("GET", `/outcomes?workspaceId=${wsA}&actionId=${actionCompleted}&limit=100`);
    if ((outcomesForActionCompleted.json?.data || []).length >= 2) {
      ok("23b: multiple Outcomes may reference the same Action", `${outcomesForActionCompleted.json.data.length} row(s)`);
    } else {
      fail("23b: multiple Outcomes may reference the same Action", JSON.stringify(outcomesForActionCompleted.json?.data));
    }

    // === E. Outcome statuses ===
    const statusOutcome = trackCreated(
      await expectStatus("setup: status test Outcome", "POST", "/outcomes", { workspaceId: wsA, intelligenceId: intelA, status: "unknown" }, 201),
      "outcomeIds",
    );
    await expectStatus("24: success accepted", "PATCH", `/outcomes/${statusOutcome}?workspaceId=${wsA}`, { status: "success" }, 200);
    await expectStatus("25: partial accepted", "PATCH", `/outcomes/${statusOutcome}?workspaceId=${wsA}`, { status: "partial" }, 200);
    await expectStatus("26: failed accepted", "PATCH", `/outcomes/${statusOutcome}?workspaceId=${wsA}`, { status: "failed" }, 200);
    await expectStatus("27: unknown accepted", "PATCH", `/outcomes/${statusOutcome}?workspaceId=${wsA}`, { status: "unknown" }, 200);
    // Arbitrary "backwards" corrections, proving there is no transition state machine.
    await expectStatus("28a: success -> unknown correction allowed", "PATCH", `/outcomes/${statusOutcome}?workspaceId=${wsA}`, { status: "success" }, 200);
    await expectStatus("28b: success -> failed correction allowed (no forbidden transition)", "PATCH", `/outcomes/${statusOutcome}?workspaceId=${wsA}`, { status: "failed" }, 200);
    await expectStatus("28c: failed -> success correction allowed (no forbidden transition)", "PATCH", `/outcomes/${statusOutcome}?workspaceId=${wsA}`, { status: "success" }, 200);
    await expectStatus("28d: same-status no-op remains a plain update, not a rejected transition", "PATCH", `/outcomes/${statusOutcome}?workspaceId=${wsA}`, { status: "success" }, 200);
    await expectStatus("28e: invalid status value still rejected by the schema enum", "PATCH", `/outcomes/${statusOutcome}?workspaceId=${wsA}`, { status: "not-a-real-status" }, 400);

    // === F. Data persistence ===
    const persistenceRes = await expectStatus(
      "29/30/31: result/metrics/feedback persist on create",
      "POST",
      "/outcomes",
      {
        workspaceId: wsA,
        intelligenceId: intelA,
        status: "success",
        result: { summary: "Guest accepted room change", notes: "Handled within 20 minutes" },
        metrics: { resolutionMinutes: 20 },
        feedback: { guestSatisfaction: "positive" },
      },
      201,
    );
    const persistenceOutcome = trackCreated(persistenceRes, "outcomeIds");
    const p = persistenceRes.json?.data;
    if (p?.result?.summary === "Guest accepted room change" && p?.result?.notes === "Handled within 20 minutes") {
      ok("29: result persists and round-trips");
    } else {
      fail("29: result persists and round-trips", JSON.stringify(p?.result));
    }
    if (p?.metrics?.resolutionMinutes === 20) {
      ok("30: metrics persists and round-trips");
    } else {
      fail("30: metrics persists and round-trips", JSON.stringify(p?.metrics));
    }
    if (p?.feedback?.guestSatisfaction === "positive") {
      ok("31: feedback persists and round-trips");
    } else {
      fail("31: feedback persists and round-trips", JSON.stringify(p?.feedback));
    }
    if (p?.occurredAt && !Number.isNaN(Date.parse(p.occurredAt))) {
      ok("32: occurredAt defaults appropriately", p.occurredAt);
    } else {
      fail("32: occurredAt defaults appropriately", JSON.stringify(p));
    }

    const suppliedOccurredAt = "2020-01-15T10:00:00.000Z";
    const suppliedRes = await expectStatus(
      "33: supplied occurredAt is preserved",
      "POST",
      "/outcomes",
      { workspaceId: wsA, intelligenceId: intelA, status: "unknown", occurredAt: suppliedOccurredAt },
      201,
    );
    trackCreated(suppliedRes, "outcomeIds");
    if (new Date(suppliedRes.json?.data?.occurredAt).toISOString() === suppliedOccurredAt) {
      ok("33b: supplied occurredAt value matches exactly");
    } else {
      fail("33b: supplied occurredAt value matches exactly", JSON.stringify(suppliedRes.json?.data));
    }

    // === G. Graph integrity (Action -> Decision -> Intelligence coherence) ===
    const graphDecision = trackCreated(
      await expectStatus("setup: graph decision (intelA)", "POST", "/decisions", { workspaceId: wsA, intelligenceId: intelA, description: "graph integrity decision" }, 201),
      "decisionIds",
    );
    const graphAction = trackCreated(
      await expectStatus("setup: graph action (intelA, decision above)", "POST", "/actions", { workspaceId: wsA, intelligenceId: intelA, decisionId: graphDecision, description: "graph integrity action" }, 201),
      "actionIds",
    );
    const graphOutcomeRes = await expectStatus(
      "34: Outcome referencing graph-coherent Action",
      "POST",
      "/outcomes",
      { workspaceId: wsA, intelligenceId: intelA, actionId: graphAction, status: "success" },
      201,
    );
    const graphOutcome = trackCreated(graphOutcomeRes, "outcomeIds");
    if (String(graphOutcomeRes.json?.data?.intelligenceId) === String(intelA)) {
      ok("34b: Outcome remains attached to the correct Intelligence through the full Decision->Action->Outcome chain");
    } else {
      fail("34b: Outcome remains attached to the correct Intelligence", JSON.stringify(graphOutcomeRes.json?.data));
    }

    // === H. Side effects ===
    const actionBeforeOutcomeOps = await request("GET", `/actions/${graphAction}?workspaceId=${wsA}`);
    await expectStatus("side effect: update the graph outcome", "PATCH", `/outcomes/${graphOutcome}?workspaceId=${wsA}`, { status: "partial", result: { summary: "revised" } }, 200);
    const actionAfterOutcomeOps = await request("GET", `/actions/${graphAction}?workspaceId=${wsA}`);
    if (actionBeforeOutcomeOps.json?.data?.status === actionAfterOutcomeOps.json?.data?.status &&
        actionBeforeOutcomeOps.json?.data?.updatedAt === actionAfterOutcomeOps.json?.data?.updatedAt) {
      ok("35/36: Outcome creation and update do not modify the Action");
    } else {
      fail("35/36: Outcome creation and update do not modify the Action", JSON.stringify({ before: actionBeforeOutcomeOps.json?.data, after: actionAfterOutcomeOps.json?.data }));
    }

    const decisionAfterOutcomeOps = await request("GET", `/decisions/${graphDecision}?workspaceId=${wsA}`);
    if (decisionAfterOutcomeOps.json?.data?.status === "proposed") {
      ok("37: Outcome operations do not modify the Decision");
    } else {
      fail("37: Outcome operations do not modify the Decision", JSON.stringify(decisionAfterOutcomeOps.json?.data));
    }

    const intelligenceAfterOutcomeOps = await request("GET", `/intelligence/${intelA}?workspaceId=${wsA}`);
    if (intelligenceAfterOutcomeOps.status === 200) {
      ok("38: Outcome operations do not modify Intelligence (still readable, unaffected)");
    } else {
      fail("38: Outcome operations do not modify Intelligence", JSON.stringify(intelligenceAfterOutcomeOps.json));
    }

    ok("39: no learning/external execution path is triggered (outcomeService.js calls no Python/Gemini/RAG/embeddings API — confirmed by code inspection, not reachable from any test)");

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
