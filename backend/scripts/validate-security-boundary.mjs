/**
 * Phase 11 security-boundary validation.
 *
 * Two kinds of checks against REAL spawned backend + MongoDB, with real users,
 * memberships and stub-signed tokens (nothing authenticates through a header):
 *
 *   HARDENED (must hold)
 *     1. Workspace administration: PATCH / DELETE /api/workspaces/:id need an
 *        authenticated ACTIVE member with workspace:admin IN THAT WORKSPACE; the
 *        workspace acted on is the route's :id, never a query/body field.
 *     2. Action: a Decision V1 can only be attached to an Action once it is APPROVED
 *        (a merely proposed / rejected V1 cannot), legacy Decisions unchanged.
 *
 *   FINDINGS (current behaviour, deliberately NOT changed - each needs a product
 *   decision; asserted here so the audit is evidence, not opinion, and so a later
 *   phase that closes one is forced to update the test)
 *     - unauthenticated Action / Outcome writes, generic legacy Decision POST/PATCH
 *     - unauthenticated Intelligence analysis / generation / retrieval, which reach the
 *       AI service (here a TRAP server: nothing real is ever called)
 *     - unauthenticated operational reads (guest PII) and writes, workspace list/get/create
 *
 * All data is synthetic, in throwaway workspaces, and removed at the end by id.
 */
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { signStubToken, STUB_ISSUER } from "../src/auth/stubTokenVerifier.js";
import * as Models from "../src/models/index.js";
import { createAction, updateAction } from "../src/services/actionService.js";
import { createOutcome, updateOutcome } from "../src/services/outcomeService.js";
import { Action, Conversation, Decision, Guest, Intelligence, KnowledgeChunk, KnowledgeDocument, Message, Outcome, Property, Signal, Stay, Unit, User, Workspace, WorkspaceMembership } from "../src/models/index.js";
import { bearer, cleanupAuthFixtures, createActor, tokenFor } from "./lib/authFixtures.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, "..", "server.js");
const PORT = 5090;
const TRAP_PORT = 5091;
const BASE = `http://localhost:${PORT}/api`;

let passed = 0;
let failed = 0;
const check = (name, condition, detail = "") => {
  if (condition) {
    passed += 1;
    console.log(`PASS  ${name}${detail ? ` - ${detail}` : ""}`);
  } else {
    failed += 1;
    console.error(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
  }
};

async function call(method, url, { headers = {}, body } = {}) {
  const response = await fetch(`${BASE}${url}`, {
    method,
    headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  return { status: response.status, json, data: json?.data, code: json?.details?.code, message: json?.message };
}

/**
 * Action / Outcome WRITES are blocked over HTTP for every role since Phase 17 (nobody holds action:execute), so the
 * DATA INVARIANTS these checks cover (approved-Decision rule, workspace/Intelligence consistency) are exercised
 * against the service in-process. The HTTP boundary itself is tested in validate-phase17-authorization.
 */
async function svc(method, url, { body } = {}) {
  const isAction = url.startsWith("/actions");
  try {
    const data =
      method === "POST"
        ? await (isAction ? createAction : createOutcome)(body)
        : await (isAction ? updateAction : updateOutcome)(url.split("?")[0].split("/")[2], body, new URL(`http://x${url}`).searchParams.get("workspaceId"));
    return { status: method === "POST" ? 201 : 200, json: null, data: JSON.parse(JSON.stringify(data)), message: undefined };
  } catch (error) {
    return { status: error.name === "ValidationError" ? 400 : Number(error.statusCode) || 500, json: null, data: undefined, message: error.message };
  }
}

async function waitForHealth(timeoutMs = 20000) {
  const start = Date.now();
  for (;;) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch {
      // not ready
    }
    if (Date.now() - start > timeoutMs) throw new Error("server not healthy");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

const ids = { workspaces: [], properties: [] };
const COUNT_MODELS = ["User", "WorkspaceMembership", "Workspace", "Property", "Unit", "Guest", "Stay", "Signal", "Intelligence", "Decision", "Action", "Outcome", "KnowledgeDocument", "KnowledgeChunk", "ImportBatch", "Conversation", "Message"];
const realCounts = async () => {
  const own = ids.workspaces;
  const out = {};
  for (const name of COUNT_MODELS) {
    const model = Models[name];
    if (name === "Workspace") out[name] = await model.countDocuments({ _id: { $nin: own } });
    else if (name === "User") out[name] = await model.countDocuments({ subject: { $not: /^(sec|legacy)-/ } });
    else if (name === "WorkspaceMembership") out[name] = await model.countDocuments({ workspaceId: { $nin: own } });
    else if (name === "Unit") out[name] = await model.countDocuments({ propertyId: { $nin: ids.properties } });
    else if (name === "Message") out[name] = await model.countDocuments({});
    else out[name] = await model.countDocuments({ workspaceId: { $nin: own } });
  }
  return out;
};

async function cleanup() {
  await connectDatabase();
  await cleanupAuthFixtures();
  const ws = { $in: ids.workspaces };
  const conversations = (await Conversation.find({ workspaceId: ws }, { _id: 1 }).lean()).map((c) => c._id);
  const props = (await Property.find({ workspaceId: ws }, { _id: 1 }).lean()).map((p) => p._id).concat(ids.properties);
  await Promise.all([Outcome.deleteMany({ workspaceId: ws }), Action.deleteMany({ workspaceId: ws }), Decision.deleteMany({ workspaceId: ws }), Message.deleteMany({ conversationId: { $in: conversations } })]);
  await Promise.all([Intelligence.deleteMany({ workspaceId: ws }), Signal.deleteMany({ workspaceId: ws }), Stay.deleteMany({ workspaceId: ws }), Guest.deleteMany({ workspaceId: ws }), Conversation.deleteMany({ workspaceId: ws }), KnowledgeChunk.deleteMany({ workspaceId: ws }), KnowledgeDocument.deleteMany({ workspaceId: ws }), Unit.deleteMany({ propertyId: { $in: props } }), Property.deleteMany({ _id: { $in: props } }), WorkspaceMembership.deleteMany({ workspaceId: ws })]);
  await Workspace.deleteMany({ _id: ws });
  await disconnectDatabase();
}

async function main() {
  const stamp = Date.now();
  const trapHits = [];
  const trap = http.createServer((req, res) => {
    trapHits.push(`${req.method} ${req.url}`);
    res.statusCode = 500;
    res.end("{}");
  });
  await new Promise((resolve) => trap.listen(TRAP_PORT, resolve));
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    // The dev fallback is set to STAFF: it must never help an authenticated caller, and it is
    // exactly what lets the unauthenticated AI routes run at all.
    env: { ...process.env, PORT: String(PORT), LLM_PROVIDER: "test-python", AI_SERVICE_URL: `http://localhost:${TRAP_PORT}`, KNOWLEDGE_DEV_AUTHORIZED_LEVEL: "staff" },
    stdio: "ignore",
  });

  try {
    await waitForHealth();
    await connectDatabase();
    await Promise.all([User.init(), WorkspaceMembership.init(), Decision.init(), Intelligence.init()]);

    const mkWs = async (label) => {
      const doc = await Workspace.create({ name: `Sec ${label} ${stamp}`, slug: `sec-${label}-${stamp}` });
      ids.workspaces.push(doc._id);
      return doc;
    };
    const wsA = await mkWs("a");
    const wsB = await mkWs("b");
    const A = String(wsA._id);
    const B = String(wsB._id);
    const before = await realCounts();
    const mk = (role, ws, label = "sec") => createActor({ role, workspaceId: ws._id, label: `${label}` });
    const admin = await mk("admin", wsA, "sec-admin");
    const reviewer = await mk("reviewer", wsA, "sec-reviewer");
    const operator = await mk("operator", wsA, "sec-operator");
    const viewer = await mk("viewer", wsA, "sec-viewer");
    const adminB = await mk("admin", wsB, "sec-adminb");
    const outsider = await createActor({ label: "sec-outsider" });
    const unregistered = bearer(signStubToken({ iss: STUB_ISSUER, sub: `never-provisioned-${stamp}`, exp: Math.floor(Date.now() / 1000) + 600 }, process.env.AUTH_STUB_SECRET));
    const H = (who) => who.headers;
    const wsState = async (id) => Workspace.findById(id).lean();

    // =================================================================== 1. WORKSPACE ADMINISTRATION (hardened)
    const orig = await wsState(wsA._id);
    for (const [verb, url, body] of [["PATCH", `/workspaces/${A}`, { name: "HACKED", status: "suspended", slug: "hacked" }], ["DELETE", `/workspaces/${A}`, undefined]]) {
      const ask = (headers, u = url) => call(verb, u, { headers, body });
      let r = await ask({});
      check(`WA1 ${verb}: no token -> 401`, r.status === 401 && r.code === "MISSING_CREDENTIAL");
      r = await ask(bearer("not.a.token"));
      check(`WA2 ${verb}: invalid token -> 401`, r.status === 401);
      r = await ask(unregistered);
      check(`WA3 ${verb}: valid token, unregistered identity -> 403`, r.status === 403 && r.code === "IDENTITY_NOT_REGISTERED");
      r = await ask(H(outsider));
      check(`WA4 ${verb}: registered user, no membership -> 404`, r.status === 404);
      for (const [name, who] of [["viewer", viewer], ["operator", operator], ["reviewer", reviewer]]) {
        r = await ask(H(who));
        check(`WA5 ${verb}: ${name} (a member without workspace:admin) -> 403`, r.status === 403 && r.code === "FORBIDDEN");
      }
      r = await ask(H(adminB));
      check(`WA6 ${verb}: an admin of ANOTHER workspace -> 404 (cross-workspace)`, r.status === 404);
      r = await ask(H(adminB), `${url}?workspaceId=${B}`);
      check(`WA7 ${verb}: ...even when the query names THEIR workspace (the route :id decides)`, r.status === 404);
      r = await ask({ ...H(viewer), "x-role": "admin", "x-permissions": "workspace:admin", "x-knowledge-level": "restricted", "x-user-id": String(admin.user._id), "x-workspace-id": A }, `${url}?workspaceId=${A}&role=admin&permission=workspace:admin&level=restricted&userId=${admin.user._id}`);
      check(`WA8 ${verb}: forged role / permission / level / user-id headers and query change nothing (403)`, r.status === 403);
      r = await ask({ authorization: `Bearer ${tokenFor(viewer.user, { role: "admin", permissions: ["workspace:admin"], workspaceId: A, knowledgeLevel: "restricted" })}` });
      check(`WA9 ${verb}: forged claims inside a valid token change nothing (403)`, r.status === 403);
      const now = await wsState(wsA._id);
      check(`WA10 ${verb}: DATABASE: after every denial the workspace exists, unchanged`, now && now.name === orig.name && now.slug === orig.slug && now.status === orig.status);
    }
    let r = await call("PATCH", `/workspaces/${B}?workspaceId=${A}`, { headers: H(admin), body: { name: "HACKED-B" } });
    check("WA11: an admin of A cannot change B even when the query names A (404); B unchanged", r.status === 404 && (await wsState(wsB._id)).name === `Sec b ${stamp}`);
    r = await call("PATCH", `/workspaces/${A}`, { headers: H(admin), body: { name: `Sec a renamed ${stamp}` } });
    check("WA12: the workspace's own admin can update it (200) and the database changed", r.status === 200 && (await wsState(wsA._id)).name === `Sec a renamed ${stamp}`);
    r = await call("PATCH", `/workspaces/${A}`, { headers: H(admin), body: {} });
    check("WA13: an empty update is still rejected by the existing validation (400)", r.status === 400);
    r = await call("PATCH", `/workspaces/${A}`, { headers: H(admin), body: { status: "suspended" } });
    const stillIn = await call("GET", `/dashboard/signals?workspaceId=${A}`, { headers: H(admin) });
    check("WA14: an admin can no longer suspend their own workspace (409 WORKSPACE_LOCKOUT_PREVENTED, Phase 22); the workspace stays active and reachable", r.status === 409 && r.code === "WORKSPACE_LOCKOUT_PREVENTED" && stillIn.status === 200 && (await wsState(wsA._id)).status === "active");
    const wsC = await mkWs("c");
    const adminC = await mk("admin", wsC, "sec-adminc");
    const propC = await Property.create({ workspaceId: wsC._id, name: `Sec C ${stamp}`, code: `SC-${stamp}` });
    ids.properties.push(propC._id);
    r = await call("DELETE", `/workspaces/${wsC._id}`, { headers: H(adminC) });
    check("WA15a: deleting WITHOUT the slug confirmation is refused (400 WORKSPACE_DELETE_CONFIRMATION_REQUIRED) and nothing is removed", r.status === 400 && r.code === "WORKSPACE_DELETE_CONFIRMATION_REQUIRED" && Boolean(await wsState(wsC._id)) && Boolean(await Property.findById(propC._id)));
    r = await call("DELETE", `/workspaces/${wsC._id}`, { headers: H(adminC), body: { confirm: `sec-c-${stamp}` } });
    check("WA15: the workspace's own admin can delete it WITH the confirmation (200): the workspace document is gone", r.status === 200 && !(await wsState(wsC._id)));
    check("WA16: deleting a workspace now CASCADES (Phase 22): its data is removed, not orphaned", !(await Property.findById(propC._id)));
    r = await call("GET", `/dashboard/signals?workspaceId=${wsC._id}`, { headers: H(adminC) });
    check("WA17: ...and the deleted workspace is unreachable over the authenticated API (404)", r.status === 404);

    // =================================================================== 2. ACTION -> DECISION V1 (hardened)
    const signal = await Signal.create({ workspaceId: wsA._id, type: "maintenance", severity: "medium", title: `SEC signal ${stamp}` });
    const mkIntel = async (label) => {
      const s = await Signal.create({ workspaceId: wsA._id, type: "maintenance", severity: "medium", title: `SEC signal ${label} ${stamp}` });
      return Intelligence.create({ workspaceId: wsA._id, signalIds: [s._id], generatedBy: "llm", analysis: { situation: "s", evidence: ["e"], impact: "i", recommendation: "Recommendation only.", confidence: "medium" }, analysisVersion: "intelligence-v1", analysisLevel: "guest" });
    };
    void signal;
    const propose = async (intel) => (await call("POST", `/decisions/propose/${intel._id}?workspaceId=${A}`, { headers: H(operator) })).data._id;
    const iP = await mkIntel("proposed");
    const iR = await mkIntel("rejected");
    const iA = await mkIntel("approved");
    const dProposed = await propose(iP);
    const dRejected = await propose(iR);
    const dApproved = await propose(iA);
    await call("POST", `/decisions/${dRejected}/reject?workspaceId=${A}`, { headers: H(reviewer), body: {} });
    await call("POST", `/decisions/${dApproved}/approve?workspaceId=${A}`, { headers: H(reviewer), body: {} });
    const mkAction = (intel, decisionId) => svc("POST", "/actions", { body: { workspaceId: A, intelligenceId: String(intel._id), decisionId, description: "SEC action" } });
    const actionsFor = (intel) => Action.countDocuments({ intelligenceId: intel._id });
    r = await mkAction(iP, dProposed);
    check("AC1: an Action cannot be attached to a PROPOSED Decision V1 (409)", r.status === 409 && (await actionsFor(iP)) === 0, `HTTP ${r.status}: ${r.message}`);
    r = await mkAction(iR, dRejected);
    check("AC2: ...nor to a REJECTED one (400, existing rule)", r.status === 400 && (await actionsFor(iR)) === 0);
    r = await mkAction(iA, dApproved);
    check("AC3: an APPROVED Decision V1 can be attached (201) - and nothing else changed", r.status === 201 && (await actionsFor(iA)) === 1);
    const actionId = r.data?._id;
    const loose = await svc("POST", "/actions", { body: { workspaceId: A, intelligenceId: String(iP._id), description: "no decision yet" } });
    r = await svc("PATCH", `/actions/${loose.data._id}?workspaceId=${A}`, { body: { decisionId: dProposed } });
    check("AC4: attaching an existing Action to a PROPOSED Decision V1 (same Intelligence) is refused (409) and the Action is unchanged", loose.status === 201 && r.status === 409 && !(await Action.findById(loose.data._id).lean()).decisionId, `HTTP ${r.status}`);
    r = await svc("PATCH", `/actions/${actionId}?workspaceId=${A}`, { body: { decisionId: dProposed } });
    check("AC4b: (existing rule) a Decision from another Intelligence is refused (400) and the Action keeps its approved Decision", r.status === 400 && String((await Action.findById(actionId).lean()).decisionId) === dApproved);
    const other = await Intelligence.create({ workspaceId: wsB._id, generatedBy: "llm" });
    r = await svc("POST", "/actions", { body: { workspaceId: A, intelligenceId: String(iA._id), decisionId: dApproved, description: "x" } });
    check("AC5: (sanity) the approved Decision is reusable only for its own Intelligence", r.status === 201);
    r = await svc("POST", "/actions", { body: { workspaceId: A, intelligenceId: String(other._id), decisionId: dApproved, description: "x" } });
    check("AC6: cross-workspace Intelligence with a Decision from A is refused (404, indistinguishable from a missing id; Phase 21)", r.status === 404);
    const legacyIntel = await Intelligence.create({ workspaceId: wsA._id, generatedBy: "system" });
    const legacyDecision = await call("POST", "/decisions", { headers: H(admin), body: { workspaceId: A, intelligenceId: String(legacyIntel._id), description: "legacy decision" } });
    r = await svc("POST", "/actions", { body: { workspaceId: A, intelligenceId: String(legacyIntel._id), decisionId: legacyDecision.data._id, description: "legacy action" } });
    check("AC7: a LEGACY (pre-V1) proposed Decision still accepts an Action (compatibility unchanged)", legacyDecision.status === 201 && r.status === 201);
    check("AC8: no Decision V1 was changed by any Action attempt", (await Decision.findById(dProposed).lean()).status === "proposed" && (await Decision.findById(dApproved).lean()).status === "approved");

    // =================================================================== 3. FINDINGS (documented, not changed)
    r = await call("POST", "/decisions", { headers: H(admin), body: { workspaceId: A, intelligenceId: String(iA._id), description: "bypass", status: "approved" } });
    check("LG1: generic legacy POST cannot create a Decision on an Intelligence V1 (409)", r.status === 409);
    r = await call("POST", "/decisions", { headers: H(admin), body: { workspaceId: A, intelligenceId: String(legacyIntel._id), description: "x", decisionVersion: "decision-v1", status: "approved" } });
    check("LG2: ...nor mark a record decision-v1 (400)", r.status === 400);
    for (const body of [{ status: "approved" }, { status: "completed" }, { description: "rewritten" }, { workspaceId: B }]) {
      r = await call("PATCH", `/decisions/${dProposed}?workspaceId=${A}`, { headers: H(admin), body });
      check(`LG3: generic legacy PATCH cannot change a Decision V1 (${Object.keys(body)[0]})`, r.status === 409 || r.status === 400, `HTTP ${r.status}`);
    }
    check("LG4: the Decision V1 is unchanged after every legacy attempt", (await Decision.findById(dProposed).lean()).status === "proposed");
    r = await call("POST", "/decisions", { headers: H(admin), body: { workspaceId: B, intelligenceId: String(legacyIntel._id), description: "cross" } });
    check("LG5: legacy POST cannot cross workspaces (A's admin naming workspace B -> 404)", r.status === 404);
    check("LG6: an authorized generic legacy Decision POST creates a legacy record (201); without a token it is 401 (Phase 16)", legacyDecision.status === 201 && legacyDecision.data.decisionVersion === null && (await call("POST", "/decisions", { body: { workspaceId: A, intelligenceId: String(legacyIntel._id), description: "no token" } })).status === 401);
    r = await call("PATCH", `/decisions/${legacyDecision.data._id}?workspaceId=${A}`, { headers: H(admin), body: { status: "approved" } });
    check("LG7: an admin (decision:review) can move a LEGACY Decision (200); without a token -> 401", r.status === 200 && (await call("PATCH", `/decisions/${legacyDecision.data._id}?workspaceId=${A}`, { body: { status: "completed" } })).status === 401);

    r = await svc("POST", "/outcomes", { body: { workspaceId: A, intelligenceId: String(iA._id), status: "success", metrics: { anything: 1 }, feedback: { forged: true } } });
    check("OU1: (service level) an Outcome record may still be shaped with NO Action and free-form metrics/feedback - reachable by NO HTTP caller since Phase 17", r.status === 201 && !r.data.actionId);
    r = await svc("POST", "/outcomes", { body: { workspaceId: A, intelligenceId: String(iA._id), actionId, status: "success" } });
    check("OU2: an Outcome for an Action must match the Action's workspace and Intelligence (existing rule)", r.status === 201);
    r = await svc("POST", "/outcomes", { body: { workspaceId: B, intelligenceId: String(other._id), actionId, status: "success" } });
    check("OU3: ...and cannot point across workspaces (404, indistinguishable from a missing id; Phase 21)", r.status === 404);
    r = await svc("POST", "/outcomes", { body: { workspaceId: A, intelligenceId: String(iA._id), status: "totally-forged" } });
    check("OU4: an unknown Outcome status is rejected by the schema (400)", r.status === 400);
    for (const [m, u, b] of [["POST", "/actions", { workspaceId: A }], ["POST", "/outcomes", { workspaceId: A }]]) {
      check(`AW: HTTP ${m} ${u} without a token -> 401; by an admin -> 403 (Phase 17)`, (await call(m, u, { body: b })).status === 401 && (await call(m, u, { headers: H(admin), body: b })).status === 403);
    }
    r = await svc("POST", "/actions", { body: { workspaceId: A, intelligenceId: String(legacyIntel._id), description: "unowned", status: "completed", assignedTo: "anyone-i-like" } });
    check("AC9: (service level) an Action record may still be shaped with no Decision / any status / free-text assignee - reachable by NO HTTP caller since Phase 17", r.status === 201 && r.data.status === "completed");

    // ---- AI reachability (a TRAP server stands in for the AI service: nothing real is ever called)
    const sig = await Signal.create({ workspaceId: wsA._id, type: "maintenance", severity: "medium", title: `SEC analyze target ${stamp}` });
    const sigB = await Signal.create({ workspaceId: wsB._id, type: "maintenance", severity: "medium", title: `SEC analyze target B ${stamp}` });
    const hits0 = trapHits.length;
    r = await call("POST", `/intelligence/analyze/${sigB._id}?workspaceId=${A}`, { headers: H(operator) });
    check("AI1: an authorized operator analyzing another workspace's Signal id gets 404 BEFORE any AI call (tenant check holds)", r.status === 404 && trapHits.length === hits0);
    r = await call("POST", `/intelligence/analyze/${sig._id}?workspaceId=${A}`);
    check("AI2: POST /intelligence/analyze/:signalId is now AUTHENTICATED: no token -> 401 and the AI service is NOT reached", r.status === 401 && trapHits.length === hits0);
    const hits1 = trapHits.length;
    r = await call("POST", `/signals/${sig._id}/intelligence?workspaceId=${A}`);
    check("AI3: the legacy POST /signals/:id/intelligence is RETIRED (Phase 24): it does not exist (404) and the AI service is NOT reached", r.status === 404 && trapHits.length === hits1);
    const hits2 = trapHits.length;
    r = await call("GET", `/signals/${sig._id}/knowledge-retrieval?workspaceId=${A}`);
    check("AI4: GET /signals/:id/knowledge-retrieval is now AUTHENTICATED (401) and the AI service is NOT reached", r.status === 401 && trapHits.length === hits2);

    // ---- other unauthenticated surfaces (documented)
    const surfaces = [
    ];
    const rows = [];
    for (const [method, url, body, label] of surfaces) {
      const res = await call(method, url, { body });
      rows.push(`${method} ${url.split("?")[0]} -> ${res.status} (${label})`);
      check(`UN: FINDING: ${label} [${method} ${url.split("?")[0]}] is reachable WITHOUT authentication`, res.status !== 401 && res.status !== 403, `HTTP ${res.status}`);
    }
    for (const [method, url, label] of [["GET", `/actions?workspaceId=${A}`, "action list"], ["GET", `/outcomes?workspaceId=${A}`, "outcome list"], ["GET", `/learning?workspaceId=${A}`, "learning report"], ["GET", `/workspaces?limit=1`, "workspace listing"], ["GET", `/workspaces/${A}`, "workspace read by id"]]) {
      const res = await call(method, url);
      check(`WS: ${label} is now AUTHENTICATED (401) - Phase 16`, res.status === 401, `HTTP ${res.status}`);
    }
    const wsList = await call("POST", "/workspaces", { body: { name: `Sec created ${stamp}`, slug: `sec-created-${stamp}` } });
    check("WS: POST /workspaces is RETIRED (404, nothing created) - Phase 16", wsList.status === 404 && !(await Workspace.exists({ slug: `sec-created-${stamp}` })));
    r = await call("POST", "/knowledge-documents", { body: { workspaceId: A, title: "SEC doc", documentType: "sop", content: "x" } });
    check("KM: knowledge-document creation is now AUTHENTICATED (401) - Phase 13", r.status === 401);
    for (const [url, label] of [[`/intelligence?workspaceId=${A}`, "raw Intelligence list"], [`/knowledge-documents?workspaceId=${A}`, "knowledge document list"]]) {
      const res = await call("GET", url);
      check(`RD: ${label} is now AUTHENTICATED (401) - Phase 14`, res.status === 401, `HTTP ${res.status}`);
    }
    for (const [method, url, body, label] of [
      ["GET", `/guests?workspaceId=${A}`, undefined, "guest list (PII)"],
      ["GET", `/stays?workspaceId=${A}`, undefined, "stay list"],
      ["GET", `/properties?workspaceId=${A}`, undefined, "property list"],
      ["GET", `/units?workspaceId=${A}`, undefined, "unit list"],
      ["GET", `/signals?workspaceId=${A}`, undefined, "signal list"],
      ["GET", `/conversations?workspaceId=${A}`, undefined, "conversation list"],
      ["POST", `/conversations`, { workspaceId: A, title: "SEC conv", userId: "anyone" }, "conversation write"],
      ["POST", `/signals`, { workspaceId: A, type: "maintenance", title: "SEC forged signal" }, "signal write"],
      ["POST", `/guests`, { workspaceId: A, firstName: "Secfirst", lastName: "Seclast", email: "sec@example.invalid" }, "guest write (PII)"],
    ]) {
      const res = await call(method, url, { body });
      check(`OP: ${label} is now AUTHENTICATED (401) - Phase 15`, res.status === 401, `HTTP ${res.status}`);
    }
    const impRes = await fetch(`${BASE}/imports/operational`, { method: "POST" });
    check("IM: POST /imports/operational is now AUTHENTICATED (401) - Phase 13", impRes.status === 401, `HTTP ${impRes.status}`);

    // ---- integrity
    const after = await realCounts();
    const drift = Object.keys(before).filter((k) => before[k] !== after[k]);
    check("DB1: every PRE-EXISTING operational collection is unchanged (counts, excluding this suite's own throwaway data)", drift.length === 0, drift.map((k) => `${k}:${before[k]}->${after[k]}`).join(","));
    console.log("      unauthenticated surface probe:\n        " + rows.join("\n        "));
  } finally {
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
    trap.close();
    try {
      await cleanup();
      check("mongodb cleanup", true);
    } catch (error) {
      check("mongodb cleanup", false, String(error));
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0); // in-process service imports can leave idle handles
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
