/**
 * Phase 7D validation: Deterministic Learning Foundation.
 *
 * Learning v1 (route -> learningController -> learningService) is a
 * brand-new, read-only, workspace-scoped report computed on-demand from the
 * EXISTING Intelligence/Decision/Action/Outcome collections — no new
 * MongoDB model, no persistence, no Python/Gemini/RAG/embeddings call, and
 * no mutation of anything. This suite proves:
 *
 *  - Operational counts (Decision/Action/Outcome status distributions) are
 *    derived correctly from MongoDB, not hardcoded.
 *  - Chain coverage (decisionsWithActions, actionsWithOutcomes, etc.) counts
 *    DISTINCT parent ids, never inflated by a parent having multiple
 *    children (one Decision with 2 Actions is one "decisionsWithActions"
 *    row, not two).
 *  - The traceable breakdown correctly cross-references Decision->Action
 *    and Action->Outcome, including every documented incomplete-chain case
 *    (Decision with no Action, Action with no Outcome, Outcome with no
 *    Action at all).
 *  - Tenant isolation holds under every filter combination — a foreign
 *    workspace's data never appears, and a foreign-workspace filter value
 *    quietly narrows to nothing rather than leaking or erroring.
 *  - Optional filters (intelligenceId/decisionId/actionId/from/to) behave
 *    exactly as documented in learningService.js's own comments, including
 *    the asymmetry (decisionId narrows Outcomes indirectly via its Actions;
 *    actionId narrows Outcomes directly and takes precedence; from/to only
 *    ever touch Outcome.occurredAt).
 *  - The endpoint is read-only (no source document changes) and
 *    deterministic (identical requests against unchanged data produce
 *    byte-identical responses).
 *
 * Runs entirely against its own ephemeral `node server.js` (LLM_PROVIDER=test
 * — irrelevant to this suite functionally, since Learning never calls AI,
 * but kept consistent with the project's "deterministic providers only in
 * automated suites" rule). Every fixture is cleaned up from MongoDB at the
 * end, mirroring validate-outcome.mjs's conventions.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { Workspace, Intelligence, Decision, Action, Outcome } from "../src/models/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, "..", "server.js");
const PORT = 5068;
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

function assertEqual(name, actual, expected) {
  if (actual === expected) {
    ok(name, `${actual}`);
  } else {
    fail(name, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertSetEqual(name, actualIds, expectedIds) {
  const a = new Set(actualIds.map(String));
  const e = new Set(expectedIds.map(String));
  const same = a.size === e.size && [...e].every((id) => a.has(id));
  if (same) {
    ok(name, `${actualIds.length} id(s)`);
  } else {
    fail(name, `expected ${JSON.stringify([...e])}, got ${JSON.stringify([...a])}`);
  }
}

function findById(list, idField, id) {
  return list.find((item) => String(item[idField]) === String(id));
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

    // === J. Error handling (before any fixtures exist, exercised first) ===
    await expectStatus("38: missing workspaceId rejected", "GET", "/learning", null, 400);
    await expectStatus("39: invalid workspaceId rejected", "GET", "/learning?workspaceId=not-an-id", null, 400);

    // === A1: empty workspace returns a valid zero report ===
    const wsEmpty = trackCreated(
      await expectStatus("setup: empty workspace", "POST", "/workspaces", { name: `Phase 7D WS Empty ${stamp}`, slug: `phase-7d-ws-empty-${stamp}` }, 201),
      "workspaceIds",
    );
    const emptyReport = await expectStatus("A1: empty workspace returns valid zero report", "GET", `/learning?workspaceId=${wsEmpty}`, null, 200);
    const e = emptyReport.json?.data;
    if (
      e?.counts?.decisions?.total === 0 &&
      e?.counts?.actions?.total === 0 &&
      e?.counts?.outcomes?.total === 0 &&
      e?.decisions?.length === 0 &&
      e?.actions?.length === 0 &&
      e?.outcomes?.length === 0
    ) {
      ok("A1b: zero report shape is well-formed");
    } else {
      fail("A1b: zero report shape is well-formed", JSON.stringify(e));
    }

    await expectStatus("40: invalid optional ObjectId rejected", "GET", `/learning?workspaceId=${wsEmpty}&intelligenceId=not-an-id`, null, 400);

    // === Fixtures: workspace A (the main fixture graph) ===
    const wsA = trackCreated(
      await expectStatus("setup: workspace A", "POST", "/workspaces", { name: `Phase 7D WS A ${stamp}`, slug: `phase-7d-ws-a-${stamp}` }, 201),
      "workspaceIds",
    );
    const wsB = trackCreated(
      await expectStatus("setup: workspace B", "POST", "/workspaces", { name: `Phase 7D WS B ${stamp}`, slug: `phase-7d-ws-b-${stamp}` }, 201),
      "workspaceIds",
    );

    const intelA = trackCreated(
      await expectStatus("setup: intelligence A", "POST", "/intelligence", { workspaceId: wsA }, 201),
      "intelligenceIds",
    );
    const intelA2 = trackCreated(
      await expectStatus("setup: intelligence A2 (same workspace)", "POST", "/intelligence", { workspaceId: wsA }, 201),
      "intelligenceIds",
    );
    const intelB = trackCreated(
      await expectStatus("setup: intelligence B", "POST", "/intelligence", { workspaceId: wsB }, 201),
      "intelligenceIds",
    );

    // --- Decisions (wsA, intelA): one of each status ---
    const decisionProposed = trackCreated(
      await expectStatus("setup: decisionProposed", "POST", "/decisions", { workspaceId: wsA, intelligenceId: intelA, description: "Proposed decision, no actions" }, 201),
      "decisionIds",
    );
    const decisionApproved = trackCreated(
      await expectStatus("setup: decisionApproved", "POST", "/decisions", { workspaceId: wsA, intelligenceId: intelA, description: "Approved decision, one action" }, 201),
      "decisionIds",
    );
    await expectStatus("setup: approve decisionApproved", "PATCH", `/decisions/${decisionApproved}?workspaceId=${wsA}`, { status: "approved" }, 200);
    const decisionRejected = trackCreated(
      await expectStatus("setup: decisionRejected", "POST", "/decisions", { workspaceId: wsA, intelligenceId: intelA, description: "Rejected decision" }, 201),
      "decisionIds",
    );
    await expectStatus("setup: reject decisionRejected", "PATCH", `/decisions/${decisionRejected}?workspaceId=${wsA}`, { status: "rejected" }, 200);
    const decisionCompleted = trackCreated(
      await expectStatus("setup: decisionCompleted", "POST", "/decisions", { workspaceId: wsA, intelligenceId: intelA, description: "Completed decision, two actions" }, 201),
      "decisionIds",
    );
    await expectStatus("setup: approve decisionCompleted", "PATCH", `/decisions/${decisionCompleted}?workspaceId=${wsA}`, { status: "approved" }, 200);
    await expectStatus("setup: complete decisionCompleted", "PATCH", `/decisions/${decisionCompleted}?workspaceId=${wsA}`, { status: "completed" }, 200);

    // --- Actions (wsA, intelA): one of each status, mixed decision linkage ---
    const actionForApproved = trackCreated(
      await expectStatus("setup: actionForApproved (pending, under decisionApproved)", "POST", "/actions", { workspaceId: wsA, intelligenceId: intelA, decisionId: decisionApproved, description: "Assign technician" }, 201),
      "actionIds",
    );
    const actionC1 = trackCreated(
      await expectStatus("setup: actionC1 (under decisionCompleted)", "POST", "/actions", { workspaceId: wsA, intelligenceId: intelA, decisionId: decisionCompleted, description: "Contact guest" }, 201),
      "actionIds",
    );
    await expectStatus("setup: actionC1 -> in_progress", "PATCH", `/actions/${actionC1}?workspaceId=${wsA}`, { status: "in_progress" }, 200);
    await expectStatus("setup: actionC1 -> completed", "PATCH", `/actions/${actionC1}?workspaceId=${wsA}`, { status: "completed" }, 200);
    const actionC2 = trackCreated(
      await expectStatus("setup: actionC2 (under decisionCompleted)", "POST", "/actions", { workspaceId: wsA, intelligenceId: intelA, decisionId: decisionCompleted, description: "Offer compensation" }, 201),
      "actionIds",
    );
    await expectStatus("setup: actionC2 -> in_progress", "PATCH", `/actions/${actionC2}?workspaceId=${wsA}`, { status: "in_progress" }, 200);
    await expectStatus("setup: actionC2 -> completed", "PATCH", `/actions/${actionC2}?workspaceId=${wsA}`, { status: "completed" }, 200);
    const actionInProgressOnly = trackCreated(
      await expectStatus("setup: actionInProgressOnly (no decision)", "POST", "/actions", { workspaceId: wsA, intelligenceId: intelA, description: "Independent in-progress action" }, 201),
      "actionIds",
    );
    await expectStatus("setup: actionInProgressOnly -> in_progress", "PATCH", `/actions/${actionInProgressOnly}?workspaceId=${wsA}`, { status: "in_progress" }, 200);
    const actionCancelled = trackCreated(
      await expectStatus("setup: actionCancelled (no decision)", "POST", "/actions", { workspaceId: wsA, intelligenceId: intelA, description: "Cancelled action" }, 201),
      "actionIds",
    );
    await expectStatus("setup: actionCancelled -> cancelled", "PATCH", `/actions/${actionCancelled}?workspaceId=${wsA}`, { status: "cancelled" }, 200);
    const actionFailed = trackCreated(
      await expectStatus("setup: actionFailed (no decision)", "POST", "/actions", { workspaceId: wsA, intelligenceId: intelA, description: "Failed action" }, 201),
      "actionIds",
    );
    await expectStatus("setup: actionFailed -> in_progress", "PATCH", `/actions/${actionFailed}?workspaceId=${wsA}`, { status: "in_progress" }, 200);
    await expectStatus("setup: actionFailed -> failed", "PATCH", `/actions/${actionFailed}?workspaceId=${wsA}`, { status: "failed" }, 200);

    // --- Outcomes (wsA, intelA): status variety + one/many-per-action + one without an action ---
    const outcomeC1a = trackCreated(
      await expectStatus("setup: outcomeC1a (actionC1, success)", "POST", "/outcomes", { workspaceId: wsA, intelligenceId: intelA, actionId: actionC1, status: "success", occurredAt: "2024-01-01T00:00:00.000Z" }, 201),
      "outcomeIds",
    );
    const outcomeC2a = trackCreated(
      await expectStatus("setup: outcomeC2a (actionC2, partial)", "POST", "/outcomes", { workspaceId: wsA, intelligenceId: intelA, actionId: actionC2, status: "partial", occurredAt: "2024-06-01T00:00:00.000Z" }, 201),
      "outcomeIds",
    );
    const outcomeC2b = trackCreated(
      await expectStatus("setup: outcomeC2b (actionC2, failed)", "POST", "/outcomes", { workspaceId: wsA, intelligenceId: intelA, actionId: actionC2, status: "failed", occurredAt: "2024-12-01T00:00:00.000Z" }, 201),
      "outcomeIds",
    );
    const outcomeNoAction = trackCreated(
      await expectStatus("setup: outcomeNoAction (unknown, no action)", "POST", "/outcomes", { workspaceId: wsA, intelligenceId: intelA, status: "unknown", occurredAt: "2025-01-01T00:00:00.000Z" }, 201),
      "outcomeIds",
    );

    // --- Second-intelligence subgraph within workspace A (for filter tests) ---
    const decisionForIntelA2 = trackCreated(
      await expectStatus("setup: decisionForIntelA2", "POST", "/decisions", { workspaceId: wsA, intelligenceId: intelA2, description: "Separate intelligence's decision" }, 201),
      "decisionIds",
    );
    const actionForIntelA2 = trackCreated(
      await expectStatus("setup: actionForIntelA2", "POST", "/actions", { workspaceId: wsA, intelligenceId: intelA2, description: "Separate intelligence's action" }, 201),
      "actionIds",
    );
    const outcomeForIntelA2 = trackCreated(
      await expectStatus("setup: outcomeForIntelA2", "POST", "/outcomes", { workspaceId: wsA, intelligenceId: intelA2, status: "unknown" }, 201),
      "outcomeIds",
    );

    // --- Workspace B fixtures (tenant isolation controls) ---
    const decisionB = trackCreated(
      await expectStatus("setup: decisionB (wsB)", "POST", "/decisions", { workspaceId: wsB, intelligenceId: intelB, description: "Workspace B decision" }, 201),
      "decisionIds",
    );
    const actionB = trackCreated(
      await expectStatus("setup: actionB (wsB)", "POST", "/actions", { workspaceId: wsB, intelligenceId: intelB, decisionId: decisionB, description: "Workspace B action" }, 201),
      "actionIds",
    );
    const outcomeB = trackCreated(
      await expectStatus("setup: outcomeB (wsB)", "POST", "/outcomes", { workspaceId: wsB, intelligenceId: intelB, actionId: actionB, status: "success" }, 201),
      "outcomeIds",
    );

    // === Fetch the full, unfiltered workspace A report ===
    const reportRes = await expectStatus("A2/A3/A4: workspace A report", "GET", `/learning?workspaceId=${wsA}`, null, 200);
    const report = reportRes.json?.data;

    // === A. Basic report ===
    assertEqual("A2: Decision total count correct", report?.counts?.decisions?.total, 5); // 4 main + decisionForIntelA2
    assertEqual("A3: Action total count correct", report?.counts?.actions?.total, 7); // 6 main + actionForIntelA2
    assertEqual("A4: Outcome total count correct", report?.counts?.outcomes?.total, 5); // 4 main + outcomeForIntelA2

    // === B. Status distributions ===
    const dCounts = report?.counts?.decisions;
    if (dCounts?.proposed === 2 && dCounts?.approved === 1 && dCounts?.rejected === 1 && dCounts?.completed === 1) {
      ok("5: all Decision statuses represented correctly", JSON.stringify(dCounts));
    } else {
      fail("5: all Decision statuses represented correctly", JSON.stringify(dCounts));
    }
    const aCounts = report?.counts?.actions;
    if (aCounts?.pending === 2 && aCounts?.in_progress === 1 && aCounts?.completed === 2 && aCounts?.cancelled === 1 && aCounts?.failed === 1) {
      ok("6: all Action statuses represented correctly", JSON.stringify(aCounts));
    } else {
      fail("6: all Action statuses represented correctly", JSON.stringify(aCounts));
    }
    const oCounts = report?.counts?.outcomes;
    if (oCounts?.success === 1 && oCounts?.partial === 1 && oCounts?.failed === 1 && oCounts?.unknown === 2) {
      ok("7: all Outcome statuses represented correctly", JSON.stringify(oCounts));
    } else {
      fail("7: all Outcome statuses represented correctly", JSON.stringify(oCounts));
    }

    // === C. Chain coverage ===
    const decisionProposedRecord = findById(report.decisions, "decisionId", decisionProposed);
    assertEqual("8: Decision with no Action (actionCount)", decisionProposedRecord?.actionCount, 0);

    const decisionApprovedRecord = findById(report.decisions, "decisionId", decisionApproved);
    assertEqual("9: Decision with one Action (actionCount)", decisionApprovedRecord?.actionCount, 1);

    const decisionCompletedRecord = findById(report.decisions, "decisionId", decisionCompleted);
    assertEqual("10: Decision with multiple Actions (actionCount)", decisionCompletedRecord?.actionCount, 2);

    const actionForApprovedRecord = findById(report.actions, "actionId", actionForApproved);
    assertEqual("11: Action with no Outcome (outcomeCount)", actionForApprovedRecord?.outcomeCount, 0);

    const actionC1Record = findById(report.actions, "actionId", actionC1);
    assertEqual("12: Action with one Outcome (outcomeCount)", actionC1Record?.outcomeCount, 1);

    const actionC2Record = findById(report.actions, "actionId", actionC2);
    assertEqual("13: Action with multiple Outcomes (outcomeCount)", actionC2Record?.outcomeCount, 2);

    assertEqual("14: Decision with Outcomes through Actions (outcomeCount)", decisionCompletedRecord?.outcomeCount, 3);

    const outcomeNoActionRecord = findById(report.outcomes, "outcomeId", outcomeNoAction);
    if (outcomeNoActionRecord && outcomeNoActionRecord.actionId === null) {
      ok("15: Outcome without Action remains represented", JSON.stringify(outcomeNoActionRecord));
    } else {
      fail("15: Outcome without Action remains represented", JSON.stringify(outcomeNoActionRecord));
    }

    // === D. Distinct counting ===
    assertEqual("16: multiple Actions do not inflate Decision count", report.decisions.length, 5);
    assertEqual("17: multiple Outcomes do not inflate Action count", report.actions.length, 7);
    assertEqual("18: multiple Outcomes do not inflate Decision count", report.decisions.length, 5);

    // === E. Traceability ===
    assertSetEqual("19: Decision contains expected Action records", decisionCompletedRecord.actions.map((a) => a.actionId), [actionC1, actionC2]);
    assertEqual("20: Action contains expected Outcome records (outcomeCount matches attached Outcomes)", actionC2Record?.outcomeCount, 2);
    const idsLinkedCorrectly =
      decisionApprovedRecord.actions.every((a) => a.actionId === actionForApproved) &&
      decisionCompletedRecord.outcomes.every((o) => [outcomeC1a, outcomeC2a, outcomeC2b].includes(o.outcomeId));
    if (idsLinkedCorrectly) {
      ok("21: IDs remain correctly linked across the breakdown");
    } else {
      fail("21: IDs remain correctly linked across the breakdown", JSON.stringify({ decisionApprovedRecord, decisionCompletedRecord }));
    }

    // === Chain coverage numbers, precisely ===
    if (
      report.coverage.decisionsWithActions === 2 &&
      report.coverage.decisionsWithoutActions === 3 &&
      report.coverage.actionsWithOutcomes === 2 &&
      report.coverage.actionsWithoutOutcomes === 5 &&
      report.coverage.decisionsWithOutcomes === 1 &&
      report.coverage.decisionsWithoutOutcomes === 4
    ) {
      ok("chain coverage numbers exactly match the constructed fixture graph", JSON.stringify(report.coverage));
    } else {
      fail("chain coverage numbers exactly match the constructed fixture graph", JSON.stringify(report.coverage));
    }

    // === F. Tenant isolation ===
    const wsAIds = {
      decisions: report.decisions.map((d) => d.decisionId),
      actions: report.actions.map((a) => a.actionId),
      outcomes: report.outcomes.map((o) => o.outcomeId),
    };
    if (!wsAIds.decisions.includes(decisionB)) ok("22: workspace A never sees workspace B Decisions");
    else fail("22: workspace A never sees workspace B Decisions", JSON.stringify(wsAIds.decisions));
    if (!wsAIds.actions.includes(actionB)) ok("23: workspace A never sees workspace B Actions");
    else fail("23: workspace A never sees workspace B Actions", JSON.stringify(wsAIds.actions));
    if (!wsAIds.outcomes.includes(outcomeB)) ok("24: workspace A never sees workspace B Outcomes");
    else fail("24: workspace A never sees workspace B Outcomes", JSON.stringify(wsAIds.outcomes));
    const anyIntelBReference = [...report.decisions, ...report.actions, ...report.outcomes].some((r) => r.intelligenceId === intelB);
    if (!anyIntelBReference) ok("25: workspace A never sees workspace B Intelligence");
    else fail("25: workspace A never sees workspace B Intelligence", "found a record referencing intelB");

    const foreignIntel = await expectStatus("26: foreign intelligenceId filter cannot leak data", "GET", `/learning?workspaceId=${wsA}&intelligenceId=${intelB}`, null, 200);
    if ((foreignIntel.json?.data?.decisions?.length || 0) === 0 && (foreignIntel.json?.data?.actions?.length || 0) === 0 && (foreignIntel.json?.data?.outcomes?.length || 0) === 0) {
      ok("26b: foreign intelligenceId filter narrows to nothing");
    } else {
      fail("26b: foreign intelligenceId filter narrows to nothing", JSON.stringify(foreignIntel.json?.data));
    }

    const foreignDecision = await expectStatus("27: foreign decisionId filter cannot leak data", "GET", `/learning?workspaceId=${wsA}&decisionId=${decisionB}`, null, 200);
    if ((foreignDecision.json?.data?.decisions?.length || 0) === 0) {
      ok("27b: foreign decisionId filter narrows Decisions to nothing");
    } else {
      fail("27b: foreign decisionId filter narrows Decisions to nothing", JSON.stringify(foreignDecision.json?.data?.decisions));
    }

    const foreignAction = await expectStatus("28: foreign actionId filter cannot leak data", "GET", `/learning?workspaceId=${wsA}&actionId=${actionB}`, null, 200);
    if ((foreignAction.json?.data?.actions?.length || 0) === 0 && (foreignAction.json?.data?.outcomes?.length || 0) === 0) {
      ok("28b: foreign actionId filter narrows Actions/Outcomes to nothing");
    } else {
      fail("28b: foreign actionId filter narrows Actions/Outcomes to nothing", JSON.stringify(foreignAction.json?.data));
    }

    // === G. Optional filters ===
    const byIntelA2 = await expectStatus("29: intelligenceId narrows results", "GET", `/learning?workspaceId=${wsA}&intelligenceId=${intelA2}`, null, 200);
    const r29 = byIntelA2.json?.data;
    if (r29?.decisions?.length === 1 && r29.decisions[0].decisionId === decisionForIntelA2 && r29?.actions?.length === 1 && r29?.outcomes?.length === 1) {
      ok("29b: intelligenceId filter narrows to exactly the matching subgraph");
    } else {
      fail("29b: intelligenceId filter narrows to exactly the matching subgraph", JSON.stringify(r29));
    }

    const byDecisionCompleted = await expectStatus("30: decisionId narrows results", "GET", `/learning?workspaceId=${wsA}&decisionId=${decisionCompleted}`, null, 200);
    const r30 = byDecisionCompleted.json?.data;
    const r30OutcomeIds = (r30?.outcomes || []).map((o) => o.outcomeId);
    if (
      r30?.decisions?.length === 1 &&
      r30.decisions[0].decisionId === decisionCompleted &&
      r30?.actions?.length === 2 &&
      r30OutcomeIds.length === 3 &&
      [outcomeC1a, outcomeC2a, outcomeC2b].every((id) => r30OutcomeIds.includes(id)) &&
      !r30OutcomeIds.includes(outcomeNoAction)
    ) {
      ok("30b: decisionId filter narrows Decisions/Actions directly and Outcomes indirectly via those Actions");
    } else {
      fail("30b: decisionId filter narrows Decisions/Actions directly and Outcomes indirectly via those Actions", JSON.stringify(r30));
    }

    const byActionC1 = await expectStatus("31: actionId narrows results", "GET", `/learning?workspaceId=${wsA}&actionId=${actionC1}`, null, 200);
    const r31 = byActionC1.json?.data;
    if (
      r31?.actions?.length === 1 &&
      r31.actions[0].actionId === actionC1 &&
      r31?.outcomes?.length === 1 &&
      r31.outcomes[0].outcomeId === outcomeC1a &&
      r31?.decisions?.length === 5 // documented behavior: actionId does not narrow the Decisions query
    ) {
      ok("31b: actionId filter narrows Actions/Outcomes directly; Decisions remain workspace-wide (documented asymmetry)");
    } else {
      fail("31b: actionId filter narrows Actions/Outcomes directly; Decisions remain workspace-wide (documented asymmetry)", JSON.stringify(r31));
    }

    const byDateRange = await expectStatus("32: from/to date filters behave deterministically", "GET", `/learning?workspaceId=${wsA}&from=2024-05-01T00:00:00.000Z&to=2024-12-31T23:59:59.000Z`, null, 200);
    const r32 = byDateRange.json?.data;
    const r32OutcomeIds = (r32?.outcomes || []).map((o) => o.outcomeId);
    if (
      r32OutcomeIds.length === 2 &&
      r32OutcomeIds.includes(outcomeC2a) &&
      r32OutcomeIds.includes(outcomeC2b) &&
      !r32OutcomeIds.includes(outcomeC1a) &&
      !r32OutcomeIds.includes(outcomeNoAction) &&
      r32?.decisions?.length === 5 &&
      r32?.actions?.length === 7
    ) {
      ok("32b: from/to filters only narrow Outcome.occurredAt, never Decision/Action queries");
    } else {
      fail("32b: from/to filters only narrow Outcome.occurredAt, never Decision/Action queries", JSON.stringify(r32));
    }

    // === H. Read-only behavior ===
    const decisionBefore = await request("GET", `/decisions/${decisionCompleted}?workspaceId=${wsA}`);
    const actionBefore = await request("GET", `/actions/${actionC2}?workspaceId=${wsA}`);
    const outcomeBefore = await request("GET", `/outcomes/${outcomeC2b}?workspaceId=${wsA}`);
    const intelBefore = await request("GET", `/intelligence/${intelA}?workspaceId=${wsA}`);

    await request("GET", `/learning?workspaceId=${wsA}`);
    await request("GET", `/learning?workspaceId=${wsA}&decisionId=${decisionCompleted}`);
    await request("GET", `/learning?workspaceId=${wsA}&actionId=${actionC1}`);

    const decisionAfter = await request("GET", `/decisions/${decisionCompleted}?workspaceId=${wsA}`);
    const actionAfter = await request("GET", `/actions/${actionC2}?workspaceId=${wsA}`);
    const outcomeAfter = await request("GET", `/outcomes/${outcomeC2b}?workspaceId=${wsA}`);
    const intelAfter = await request("GET", `/intelligence/${intelA}?workspaceId=${wsA}`);

    assertEqual("33: running Learning does not modify Decisions", decisionAfter.json?.data?.updatedAt, decisionBefore.json?.data?.updatedAt);
    assertEqual("34: running Learning does not modify Actions", actionAfter.json?.data?.updatedAt, actionBefore.json?.data?.updatedAt);
    assertEqual("35: running Learning does not modify Outcomes", outcomeAfter.json?.data?.updatedAt, outcomeBefore.json?.data?.updatedAt);
    assertEqual("36: running Learning does not modify Intelligence", intelAfter.json?.data?.updatedAt, intelBefore.json?.data?.updatedAt);

    // === I. Determinism ===
    const run1 = await request("GET", `/learning?workspaceId=${wsA}`);
    const run2 = await request("GET", `/learning?workspaceId=${wsA}`);
    if (JSON.stringify(run1.json) === JSON.stringify(run2.json)) {
      ok("37: same database state produces identical report");
    } else {
      fail("37: same database state produces identical report", "responses differed between two identical requests");
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
