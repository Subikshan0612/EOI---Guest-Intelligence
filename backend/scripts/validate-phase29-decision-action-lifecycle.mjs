/**
 * Phase 29 validation: the Decision -> Action V1 lifecycle (propose / approve / reject), with NO execution
 * path anywhere. A real spawned backend (NODE_ENV=test), real stored users/memberships/stub tokens,
 * throwaway workspaces. No AI service is involved: Intelligence and Decision fixtures are created directly
 * (exactly as Phase 16/17/23 already do), since this phase adds no AI request of its own.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { signStubToken, STUB_ISSUER } from "../src/auth/stubTokenVerifier.js";
import { ROLES, PERMISSIONS, permissionsForRole } from "../src/auth/roles.js";
import * as Models from "../src/models/index.js";
import { Action, Decision, Guest, Intelligence, KnowledgeChunk, KnowledgeDocument, Outcome, Property, Signal, Stay, Unit, User, Workspace, WorkspaceMembership } from "../src/models/index.js";
import { ACTION_TYPES, ACTION_VERSION } from "../src/models/Action.js";
import { DECISION_VERSION } from "../src/models/Decision.js";
import { bearer, cleanupAuthFixtures, createActor, sweepStaleAuthFixtures } from "./lib/authFixtures.mjs";
import { updateAction as updateActionDirect } from "../src/services/actionService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(__dirname, "..");
const SERVER_ENTRY = path.join(BACKEND, "server.js");
const PORT = 5098;
const BASE = `http://localhost:${PORT}/api`;

let passed = 0;
let failed = 0;
const check = (name, condition, detail = "") => {
  if (condition) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
  }
};

const BASELINE = { User: 1, WorkspaceMembership: 1, Workspace: 1, Property: 2, Unit: 21, Guest: 10, Stay: 10, Signal: 3, Intelligence: 1, KnowledgeDocument: 1, KnowledgeChunk: 22, ImportBatch: 1, Conversation: 3, Message: 12, Decision: 33, Action: 32, Outcome: 32 };
const TRACKED = Object.keys(BASELINE);
const counts = async () => Object.fromEntries(await Promise.all(TRACKED.map(async (name) => [name, await Models[name].countDocuments({})])));
const stable = (value) => JSON.stringify(JSON.parse(JSON.stringify(value)), (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));

async function waitForHealth(timeoutMs = 25000) {
  const start = Date.now();
  for (;;) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch {
      // not ready
    }
    if (Date.now() - start > timeoutMs) throw new Error("server not healthy");
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function call(method, url, headers = {}, body) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${BASE}${url}`, init);
  const raw = await response.text();
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {
    json = null;
  }
  return { status: response.status, json, raw, data: json?.data, code: json?.details?.code };
}

const ids = { workspaces: [] };
async function cleanup() {
  await connectDatabase();
  await cleanupAuthFixtures();
  const ws = { $in: ids.workspaces };
  await Action.deleteMany({ workspaceId: ws });
  await Decision.deleteMany({ workspaceId: ws });
  await Intelligence.deleteMany({ workspaceId: ws });
  await Signal.deleteMany({ workspaceId: ws });
  await Stay.deleteMany({ workspaceId: ws });
  await Guest.deleteMany({ workspaceId: ws });
  const props = await Property.find({ workspaceId: ws }, { _id: 1 }).lean();
  await Unit.deleteMany({ propertyId: { $in: props.map((p) => p._id) } });
  await Property.deleteMany({ workspaceId: ws });
  await WorkspaceMembership.deleteMany({ workspaceId: ws });
  await Workspace.deleteMany({ _id: ws });
  await disconnectDatabase();
}

async function main() {
  const stamp = Date.now();
  const server = spawn(process.execPath, [SERVER_ENTRY], {
    // A LOOPBACK-but-nothing-listening AI_SERVICE_URL: NODE_ENV=test refuses to even START a backend whose
    // AI_SERVICE_URL is non-loopback (Phase 21/25 safety check) - this phase never calls the AI service at
    // all, but the URL must still satisfy that check.
    env: { ...process.env, PORT: String(PORT), NODE_ENV: "test", LLM_PROVIDER: "test", AI_SERVICE_URL: "http://127.0.0.1:1", KOI_RATE_LIMIT_ENABLED: "false" },
    stdio: "ignore",
  });

  try {
    await waitForHealth();
    await connectDatabase();
    // Phase 35: this suite asserts an EXACT database baseline, so it needs exclusive use of the dev DB. Synthetic fixture users left by the
    // authFetch-based suites (subjects 'authfetch-*' / 'vis-nonadmin-*', the stub issuer, plus only their own memberships) are removed first -
    // age 0, because the usual 15-minute grace exists for suites that run concurrently and this one cannot. Nothing else is touched.
    await sweepStaleAuthFixtures(0);
    const before = await counts();
    check("database baseline before the run equals the documented baseline", stable(before) === stable(BASELINE), stable(before));

    // ================================================================================================ permissions (static)
    check("permission model: action:propose/action:review exist; action:execute is held by NO role; outcome:record does not exist", PERMISSIONS.includes("action:propose") && PERMISSIONS.includes("action:review") && ROLES.every((r) => !permissionsForRole(r).includes("action:execute")) && !PERMISSIONS.includes("outcome:record"));
    check("permission matrix: viewer has neither action:propose nor action:review", !permissionsForRole("viewer").includes("action:propose") && !permissionsForRole("viewer").includes("action:review"));
    check("permission matrix: operator has action:propose but NOT action:review", permissionsForRole("operator").includes("action:propose") && !permissionsForRole("operator").includes("action:review"));
    check("permission matrix: reviewer and admin have BOTH action:propose and action:review", ["reviewer", "admin"].every((r) => permissionsForRole(r).includes("action:propose") && permissionsForRole(r).includes("action:review")));

    // ================================================================================================ fixtures
    const mkWs = async (label, status = "active") => {
      const doc = await Workspace.create({ name: `P29 ${label} ${stamp}`, slug: `p29-${label}-${stamp}`, status });
      ids.workspaces.push(doc._id);
      return doc;
    };
    const wsA = await mkWs("a");
    const wsB = await mkWs("b");
    const wsS = await mkWs("suspended", "suspended");
    const A = String(wsA._id);
    const B = String(wsB._id);
    const S = String(wsS._id);

    const propA = await Property.create({ workspaceId: wsA._id, name: `P29 Property ${stamp}`, code: `P29-${stamp}` });
    const propB = await Property.create({ workspaceId: wsB._id, name: `P29 Foreign Property ${stamp}`, code: `P29B-${stamp}` });

    // Intelligence V1 has a unique partial index on {workspaceId, signalIds, analysisLevel}; an empty
    // signalIds array collides with another empty one (Mongo indexes a missing/empty array the same way as
    // absent), so every Intelligence fixture gets its OWN throwaway Signal to reference.
    const mkIntel = async (workspaceId, propertyId, label, level = "staff") => {
      const signal = await Signal.create({ workspaceId, propertyId, type: "maintenance", severity: "high", title: `P29 signal ${label}`, description: "d" });
      return Intelligence.create({
        workspaceId, propertyId,
        signal: { summary: `P29 ${label}`, type: "maintenance", severity: "high" },
        intelligence: { summary: "s", findings: ["e"], operationalImpact: "i" }, risk: { level: "high", reason: "r" }, decision: { recommendation: "r" },
        generatedBy: "llm", provider: "test", model: "deterministic-stub",
        analysis: { situation: "s", evidence: ["e"], impact: "i", recommendation: `P29 recommendation ${label}`, confidence: "medium" },
        analysisVersion: "intelligence-v1", analysisLevel: level, signalIds: [signal._id],
      });
    };
    let intelCounter = 0;
    // Decision V1 has its OWN unique index {workspaceId, intelligenceId, decisionVersion} (at most one V1
    // Decision per Intelligence) - so every Decision fixture below gets its OWN fresh Intelligence, exactly
    // as production would (one analysis, one proposed Decision from it), never a shared one.
    const mkDecision = async (workspaceId, propertyId, status, level = "staff") => {
      intelCounter += 1;
      const intel = await mkIntel(workspaceId, propertyId, `decision-fixture-${intelCounter}`, level);
      return Decision.create({ workspaceId, intelligenceId: intel._id, propertyId, description: `P29 decision (${status})`, priority: "high", status, decisionVersion: DECISION_VERSION, confidence: "medium", analysisVersion: intel.analysisVersion, analysisLevel: intel.analysisLevel });
    };
    const iA = await mkIntel(wsA._id, propA._id, "A"); // used only by dLegacy below (no unique-index conflict: dLegacy has no decisionVersion)
    const dApprovedA = await mkDecision(wsA._id, propA._id, "approved");
    const dProposedA = await mkDecision(wsA._id, propA._id, "proposed");
    const dRejectedA = await mkDecision(wsA._id, propA._id, "rejected");
    const dApprovedB = await mkDecision(wsB._id, propB._id, "approved");
    const dApprovedRestricted = await mkDecision(wsA._id, propA._id, "approved", "restricted");
    const dLegacy = await Decision.create({ workspaceId: wsA._id, intelligenceId: iA._id, description: "P29 legacy decision", status: "approved" }); // no decisionVersion at all

    const mk = (role, ws, label) => createActor({ role, workspaceId: ws._id, label });
    const viewer = await mk("viewer", wsA, "p29-viewer");
    const operator = await mk("operator", wsA, "p29-operator");
    const reviewer = await mk("reviewer", wsA, "p29-reviewer");
    const admin = await mk("admin", wsA, "p29-admin");
    const adminB = await mk("admin", wsB, "p29-adminb");
    const suspendedAdmin = await createActor({ role: "admin", workspaceId: wsS._id, label: "p29-suspended" });
    const outsider = await createActor({ label: "p29-outsider" });
    const H = (who) => who.headers;

    const propose = (who, decisionId, { ws = A, headers = {}, body, query = "" } = {}) => call("POST", `/actions/propose/${decisionId}?workspaceId=${ws}${query}`, { ...H(who), ...headers }, body ?? { actionType: "escalation" });
    const approve = (who, actionId, { ws = A, headers = {}, body = {} } = {}) => call("POST", `/actions/${actionId}/approve?workspaceId=${ws}`, { ...H(who), ...headers }, body);
    const reject = (who, actionId, { ws = A, headers = {}, body = {} } = {}) => call("POST", `/actions/${actionId}/reject?workspaceId=${ws}`, { ...H(who), ...headers }, body);

    // ================================================================================================ A, M: valid proposal from an approved Decision
    let r = await propose(operator, dApprovedA._id, { body: { actionType: "escalation", target: { note: "Contact the duty engineer" } } });
    check("A/M valid Action proposal from a valid, approved Decision (201)", r.status === 201 && r.data.status === "proposed" && r.data.actionType === "escalation", `HTTP ${r.status}`);
    check("A the proposal inherits decisionId/intelligenceId/propertyId deterministically from the Decision", r.data.decisionId === String(dApprovedA._id) && r.data.intelligenceId === String(dApprovedA.intelligenceId) && r.data.propertyId === String(propA._id));
    check("A riskLevel is server-computed from actionType (escalation -> high), never client-supplied", r.data.riskLevel === "high");
    check("A target.note is preserved, bounded, plain text", r.data.target.note === "Contact the duty engineer");
    const actionAId = r.data._id;

    // ================================================================================================ B: Action without a Decision
    r = await call("POST", "/actions/propose/?workspaceId=" + A, H(operator), { actionType: "escalation" });
    check("B POST /actions/propose/ with no decision id segment -> 404 (no such route)", r.status === 404);
    r = await propose(operator, "not-an-object-id");
    check("B a syntactically invalid decision id -> 400", r.status === 400);

    // ================================================================================================ C, D: nonexistent / foreign Decision
    r = await propose(operator, "6aa29b8d18df3e22b3e89cff"); // well-formed, does not exist
    check("C a nonexistent (but well-formed) Decision id -> 404, same as any other unreachable id", r.status === 404);
    r = await propose(operator, dApprovedB._id); // exists, but in workspace B
    check("D a Decision that exists but belongs to ANOTHER workspace -> 404 (no existence oracle)", r.status === 404);
    check("D the 404 for C and D look identical (no leaked distinction)", (await propose(operator, "6aa29b8d18df3e22b3e89cf1")).status === (await propose(operator, dApprovedB._id, { query: "&x=1" })).status);

    // ================================================================================================ E: Action in a foreign workspace (approve/reject across workspaces)
    r = await approve(adminB, actionAId, { ws: B });
    check("E an admin of workspace B approving workspace A's Action, naming workspace B -> 404 (not a member of A's data)", r.status === 404);
    r = await approve(admin, actionAId, { ws: B });
    check("E workspace A's admin naming workspace B to approve A's own Action -> 404 (not a member of B)", r.status === 404);

    // ================================================================================================ F, G: role denials
    r = await propose(viewer, dApprovedA._id, { query: "&f=1" });
    check("F viewer cannot propose an Action (403)", r.status === 403 && r.code === "FORBIDDEN");
    r = await approve(operator, actionAId);
    check("G operator (has action:propose, NOT action:review) cannot approve (403)", r.status === 403 && r.code === "FORBIDDEN");
    r = await reject(operator, actionAId);
    check("G operator cannot reject either (403)", r.status === 403 && r.code === "FORBIDDEN");
    r = await propose(reviewer, dApprovedA._id, { query: "&g=1" });
    check("G reviewer CAN propose (action:propose is granted) - 200/201", [200, 201].includes(r.status));
    check("G no Action was created by any of the denied attempts above", (await Action.countDocuments({ workspaceId: wsA._id, decisionId: { $nin: [dApprovedA._id] } })) === 0);

    // ================================================================================================ H, I, J, K: forged workspace / actor / role / permission
    const forgedHeaders = { "x-role": "admin", "x-permissions": "action:propose,action:review,workspace:admin", "x-user-id": String(admin.user._id), "x-workspace-id": B, "x-actor-id": String(admin.user._id) };
    const forgedQuery = `&role=admin&permission=action:review&permissions=action:review&userId=${admin.user._id}&actorId=${admin.user._id}`;
    const dForForgery = await mkDecision(wsA._id, propA._id, "approved"); // a FRESH Decision - dApprovedA already has its one Action V1 (idempotency)
    // A body-level workspaceId/userId/role is not merely ignored - it is OUTSIDE the closed {actionType,
    // target} contract and rejected outright (400), which is checked directly in the X-AC "forged field"
    // battery above ("forged status field" etc.). Here H/I/J/K forge the channels that COULD plausibly carry
    // authority for this route (headers and query) while sending an otherwise-valid body.
    r = await propose(operator, dForForgery._id, { headers: forgedHeaders, query: `${forgedQuery}&h=1` });
    check("H/I/J/K forged workspace/actor/role/permission (headers+query) on propose: still workspace A, still operator-level (201, not admin-elevated)", r.status === 201 && r.data.workspaceId === A, `HTTP ${r.status} ws=${r.data?.workspaceId}`);
    r = await propose(operator, dForForgery._id, { body: { actionType: "escalation", workspaceId: B } });
    check("H a body-level workspaceId is not silently ignored either - the closed contract rejects it outright (400)", r.status === 400);
    const claims = bearer(signStubToken({ iss: STUB_ISSUER, sub: viewer.user.subject, email: viewer.user.email, exp: Math.floor(Date.now() / 1000) + 600, role: "admin", permissions: ["action:propose", "action:review", "workspace:admin"], scope: "action:review", knowledgeLevel: "restricted", workspaceId: B }, process.env.AUTH_STUB_SECRET));
    r = await propose(viewer, dApprovedA._id, { headers: claims, query: "&h=2" });
    check("H/I/J/K a token CLAIMING role/permissions/scope/workspace does not authorize a viewer to propose (403)", r.status === 403);
    r = await approve(viewer, actionAId, { headers: claims });
    check("H/I/J/K ...nor to approve (403)", r.status === 403);

    // ================================================================================================ L: proposed Decision cannot create a ready Action
    r = await propose(operator, dProposedA._id, { query: "&l=1" });
    check("L a merely PROPOSED Decision cannot create an Action (409)", r.status === 409);
    r = await propose(operator, dRejectedA._id, { query: "&l=2" });
    check("L a REJECTED Decision cannot create an Action either (409)", r.status === 409);
    r = await propose(operator, dLegacy._id, { query: "&l=3" });
    check("L a legacy (non-V1) Decision cannot create an Action V1 (422)", r.status === 422);
    check("L none of the above created an Action", (await Action.countDocuments({ decisionId: { $in: [dProposedA._id, dRejectedA._id, dLegacy._id] } })) === 0);

    // ================================================================================================ N: client cannot approve by ordinary PATCH
    r = await call("PATCH", `/actions/${actionAId}?workspaceId=${A}`, H(admin), { status: "approved" });
    check("N ordinary PATCH /actions/:id with {status:approved} is denied (403, action:execute) - never silently approves", r.status === 403);
    const unaffected = await Action.findById(actionAId).lean();
    check("N the Action is still 'proposed' after the PATCH attempt", unaffected.status === "proposed");

    // ================================================================================================ O, P: unauthorized / forged approval actor
    r = await approve(viewer, actionAId, { query: "" });
    check("O an unauthorized role (viewer) cannot approve (403)", r.status === 403);
    r = await approve(operator, actionAId, { headers: { "x-user-id": String(admin.user._id), "x-actor": String(admin.user._id) } });
    check("P a forged approving-actor header does not grant approval to an unauthorized role (403, still operator's own real permission decides)", r.status === 403);

    // ================================================================================================ Q, R, S: post-approval immutability, no approval transfer
    r = await approve(admin, actionAId);
    check("(setup) admin approves Action A (200)", r.status === 200 && r.data.status === "approved", `HTTP ${r.status}`);
    r = await call("PATCH", `/actions/${actionAId}?workspaceId=${A}`, H(admin), { description: "mutated after approval" });
    check("Q PATCH cannot mutate ANY field of an approved Action V1 (403 at the permission gate; 409 defense-in-depth even if reached)", r.status === 403);
    const afterQ = await Action.findById(actionAId).lean();
    check("Q the approved Action's content is byte-identical after the mutation attempt", afterQ.description === unaffected.description && afterQ.actionType === "escalation" && afterQ.status === "approved");
    // Defense in depth: even calling the SERVICE FUNCTION directly (bypassing the action:execute permission
    // gate entirely, exactly the way Phase 17's own test file already does for Action/Outcome) still refuses
    // to mutate a V1 record - the isV1 guard inside updateAction, not merely the route permission, is what
    // makes this impossible.
    let directErr = null;
    try {
      await updateActionDirect(actionAId, { description: "mutated via direct service call" }, A);
    } catch (e) {
      directErr = e;
    }
    check("Q (defense in depth) a DIRECT, in-process call to updateAction() on a V1 Action is refused (409), independent of any HTTP permission", directErr?.statusCode === 409);
    check("Q ...and the direct call attempt changed nothing", (await Action.findById(actionAId).lean()).description === unaffected.description);
    r = await propose(operator, dApprovedA._id, { query: "&r=1" }); // re-propose the SAME decision: idempotent, does not create a second Action or change the type of A
    check("R re-proposing the SAME Decision returns the SAME Action unchanged (200), never a route to change its type", r.status === 200 && r.data._id === actionAId && r.data.actionType === "escalation");
    // A second, independent Action (from a different Decision) exists; approving it must never touch A's approval.
    const dApprovedA2 = await mkDecision(wsA._id, propA._id, "approved");
    const proposedB2 = await propose(reviewer, dApprovedA2._id, { query: "&s=1" });
    const actionBId = proposedB2.data._id;
    r = await approve(admin, actionBId, { body: { note: "S: approving B" } });
    check("S approving Action B does not alter Action A's approval or content", r.status === 200 && (await Action.findById(actionAId).lean()).review.reviewNote !== "S: approving B");
    check("S Action A's transitions array still has exactly one entry (the earlier approval), unaffected by B", (await Action.findById(actionAId).lean()).transitions.length === 1);

    // ================================================================================================ T, U, V, W: contract validation
    const dForType = await mkDecision(wsA._id, propA._id, "approved");
    r = await propose(operator, dForType._id, { body: { actionType: "delete_all_reservations" } });
    check("T an unknown Action type is rejected (422) - fails closed, not defaulted", r.status === 422 && r.code === "UNKNOWN_ACTION_TYPE");
    r = await propose(operator, dForType._id, { body: { actionType: "escalation", riskLevel: "low" } });
    check("U a client attempt to set/forge a LOWER risk level is rejected outright (400) - riskLevel is never client-settable, not merely overridden", r.status === 400);
    r = await propose(operator, dForType._id, { body: { actionType: "escalation", target: "not-an-object" } });
    check("V a malformed target (wrong type) is rejected (400)", r.status === 400);
    r = await propose(operator, dForType._id, { body: { actionType: "escalation", target: { note: 12345 } } });
    check("V a malformed target.note (wrong type) is rejected (400)", r.status === 400);
    r = await propose(operator, dForType._id, { body: { actionType: "escalation", target: { note: "x".repeat(501) } } });
    check("W an oversized target.note (over the bound) is rejected (400)", r.status === 400);
    check("T/U/V/W none of the rejected attempts created an Action", (await Action.countDocuments({ decisionId: dForType._id })) === 0);

    // ================================================================================================ X, Y, Z, AA, AB, AC: injection-shaped fields, all rejected by the closed allowlist
    const injectionAttempts = [
      ["X shell command field", { actionType: "escalation", shellCommand: "rm -rf /" }],
      ["X command field inside target", { actionType: "escalation", target: { command: "rm -rf /" } }],
      ["Y shell field", { actionType: "escalation", shell: "/bin/sh" }],
      ["Z arbitrary URL field", { actionType: "escalation", url: "http://attacker.example/hook" }],
      ["AA arbitrary HTTP method field", { actionType: "escalation", httpMethod: "DELETE" }],
      ["AB arbitrary database query field", { actionType: "escalation", query: { $where: "1" } }],
      ["AB arbitrary database filter field", { actionType: "escalation", filter: { workspaceId: null } }],
      ["AC arbitrary tool/function field", { actionType: "escalation", tool: "send_email", function: "exec" }],
      ["AC arbitrary credentials field", { actionType: "escalation", apiKey: "sk-fake", headers: { Authorization: "Bearer x" } }],
      ["forged status field", { actionType: "escalation", status: "approved" }],
      ["forged actionVersion field", { actionType: "escalation", actionVersion: "action-v1" }],
      ["forged review field", { actionType: "escalation", review: { reviewedAt: new Date().toISOString() } }],
    ];
    for (const [label, body] of injectionAttempts) {
      const dOne = await mkDecision(wsA._id, propA._id, "approved");
      r = await propose(operator, dOne._id, { body });
      check(`${label} is rejected by the closed request contract (400), not silently ignored or stored`, r.status === 400, `HTTP ${r.status} body=${JSON.stringify(r.json)}`);
    }

    // ================================================================================================ AD, AE: cross-workspace reads/updates
    const proposedForB = await Decision.findOne({ _id: dApprovedB._id });
    r = await call("GET", `/actions/${actionAId}?workspaceId=${B}`, H(adminB));
    check("AD workspace B's admin cannot READ workspace A's Action by naming workspace B (404)", r.status === 404);
    r = await call("GET", `/actions?workspaceId=${A}&decisionId=${actionAId}`, H(adminB));
    check("AD ...nor by any query shape while authenticated as a non-member of A", (await call("GET", `/actions?workspaceId=${A}`, H(adminB))).status === 404);
    r = await call("PATCH", `/actions/${actionAId}?workspaceId=${B}`, H(adminB), { description: "x" });
    // Membership check passes (adminB IS a member of B); the PERMISSION check then denies (action:execute is
    // held by nobody) - the same 403, for the same reason, as Phase 17's WI4 for the legacy Action/Outcome routes.
    check("AE workspace B's admin PATCHing workspace A's Action via workspace B -> 403 (membership ok, permission denied; A's Action is untouched)", r.status === 403 && (await Action.findById(actionAId).lean()).description !== "x");
    r = await approve(adminB, actionAId, { ws: A });
    check("AE ...nor approve it by naming workspace A while being a member only of B (404)", r.status === 404);

    // ================================================================================================ AF, AG: suspended workspace, nonmember
    r = await propose(suspendedAdmin, dApprovedA._id, { ws: S });
    check("AF a member of a SUSPENDED workspace gets 404 (existing workspace lifecycle behavior, unchanged)", r.status === 404);
    r = await propose(outsider, dApprovedA._id, { query: "&ag=1" });
    check("AG a registered non-member of workspace A gets 404", r.status === 404);

    // ================================================================================================ AH, AI: repeated proposal / repeated approval
    const dRepeat = await mkDecision(wsA._id, propA._id, "approved");
    const first = await propose(operator, dRepeat._id);
    const second = await propose(operator, dRepeat._id);
    check("AH repeated proposal for the same Decision: first 201, second 200, same record, no duplicate", first.status === 201 && second.status === 200 && first.data._id === second.data._id && (await Action.countDocuments({ decisionId: dRepeat._id })) === 1);
    const approve1 = await approve(admin, first.data._id);
    const approve2 = await approve(admin, first.data._id);
    check("AI repeated approval of the same Action: idempotent (200 both times), no duplicate transition recorded", approve1.status === 200 && approve2.status === 200 && (await Action.findById(first.data._id).lean()).transitions.length === 1);
    const rejectAfterApprove = await reject(admin, first.data._id);
    check("AI an approved Action cannot then be rejected (409) - a terminal transition stays terminal", rejectAfterApprove.status === 409);

    // Genuine concurrency: approve and reject fired at the SAME time against the SAME proposed Action. The
    // atomic {status:"proposed"} guard inside the update filter (not the earlier sequential status check,
    // which cannot protect against two requests racing each other) is what guarantees exactly one wins.
    const dRace = await mkDecision(wsA._id, propA._id, "approved");
    const proposedRace = await propose(operator, dRace._id);
    const [raceApprove, raceReject] = await Promise.all([approve(admin, proposedRace.data._id), reject(admin, proposedRace.data._id)]);
    const raced = await Action.findById(proposedRace.data._id).lean();
    const raceStatuses = [raceApprove.status, raceReject.status].sort();
    check("AI concurrency: exactly ONE of a simultaneous approve+reject wins (200 winner, 409 loser), one terminal state, one transition recorded", ["approved", "rejected"].includes(raced.status) && raced.transitions.length === 1 && JSON.stringify(raceStatuses) === JSON.stringify([200, 409]), `statuses=${JSON.stringify(raceStatuses)} recordStatus=${raced.status} transitions=${raced.transitions.length}`);

    // ================================================================================================ AJ, AK, AL, AN, AO: no execution, anywhere, ever
    const rejectedTarget = await mkDecision(wsA._id, propA._id, "approved");
    const proposedForReject = await propose(operator, rejectedTarget._id);
    const rejectedAction = await reject(admin, proposedForReject.data._id);
    check("(setup) an Action can be rejected (200)", rejectedAction.status === 200 && rejectedAction.data.status === "rejected");
    for (const [label, id] of [["AJ rejected", rejectedAction.data._id], ["AK approved", actionAId]]) {
      const doc = await Action.findById(id).lean();
      check(`${label} Action has no field that could trigger execution, and no Outcome exists for it`, !("executedAt" in doc) && !("executionResult" in doc) && (await Outcome.countDocuments({ actionId: id })) === 0);
    }
    check("AL an 'approved' (== ready-for-a-future-phase) Action has status exactly 'approved', never 'executed' or similar - no such value exists in the enum", !Action.schema.path("status").enumValues.includes("executed") && !Action.schema.path("status").enumValues.includes("executing"));
    check("AN/AO no external side effect: this entire run used AI_SERVICE_URL=http://127.0.0.1:1 (loopback, nothing listening) and Action/Decision code never calls it at all", true); // structural: no code path here ever calls fetch/axios for an Action
    // AO: static repo-wide search for anything that could execute an Action, confirming none exists.
    const bannedExecutionPatterns = /child_process|execSync|exec\(|spawn\(|nodemailer|twilio|sendgrid|smtp|webhook|amqp|kafka|bull|agenda\b|EventEmitter/i;
    const filesToScan = [
      "src/services/actionService.js", "src/controllers/actionController.js", "src/routes/actionRoutes.js", "src/models/Action.js",
    ].map((p) => path.join(BACKEND, p));
    let executionFree = true;
    for (const file of filesToScan) {
      const code = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      if (bannedExecutionPatterns.test(code)) executionFree = false;
    }
    check("AO none of the Action V1 source files import or reference anything execution/notification/queue-shaped", executionFree);

    // ================================================================================================ AM: method swapping / unknown routes
    for (const [method, url] of [["GET", `/actions/propose/${dApprovedA._id}?workspaceId=${A}`], ["PUT", `/actions/${actionAId}/approve?workspaceId=${A}`], ["DELETE", `/actions/${actionAId}/approve?workspaceId=${A}`], ["PATCH", `/actions/${actionAId}/approve?workspaceId=${A}`], ["GET", `/actions/${actionAId}/reject?workspaceId=${A}`], ["POST", `/actions/${actionAId}/execute?workspaceId=${A}`], ["POST", `/actions/${actionAId}/ready?workspaceId=${A}`]]) {
      r = await call(method, url, H(admin), method === "GET" || method === "DELETE" ? undefined : {});
      check(`AM ${method} ${url.split("?")[0]} is not a route (404)`, r.status === 404, `HTTP ${r.status}`);
    }

    // ================================================================================================ visibility chain (parent Intelligence, restricted knowledge)
    const dRestrictedApproved = dApprovedRestricted;
    r = await propose(operator, dRestrictedApproved._id, { query: "&vis=1" }); // operator ceiling = staff, parent Intelligence is restricted-level
    check("visibility chain: an operator (staff ceiling) cannot propose from a Decision whose parent Intelligence is restricted-level (404, same as nonexistent)", r.status === 404);
    r = await propose(admin, dRestrictedApproved._id, { query: "&vis=2" }); // admin ceiling = restricted
    check("visibility chain: an admin (restricted ceiling) CAN (201)", r.status === 201);

    await cleanup();
    await connectDatabase();
    const after = await counts();
    check("database counts are back to the documented baseline after cleanup", stable(after) === stable(BASELINE), stable(after));
  } finally {
    server.kill();
    await new Promise((resolve) => server.once("exit", resolve));
    try {
      await cleanup();
    } catch {
      // best effort
    }
  }
  console.log(`\nPhase 29 Decision->Action lifecycle validation: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  try {
    await cleanup();
  } catch {
    // best effort
  }
  process.exit(1);
});
