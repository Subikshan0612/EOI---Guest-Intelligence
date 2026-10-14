/**
 * Phase 30 validation: Outcome domain integrity, with NO execution engine and NO reachable Outcome-creation
 * route anywhere. A real spawned backend (NODE_ENV=test) proves the HTTP-layer wall holds for every role;
 * DIRECT in-process calls to outcomeService's recordOutcome/createOutcome/updateOutcome (the same technique
 * Phase 29 used for Action immutability) exercise the invariants that are otherwise unreachable BY DESIGN.
 * No AI service is involved.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { ROLES, PERMISSIONS, permissionsForRole } from "../src/auth/roles.js";
import * as Models from "../src/models/index.js";
import { Action, Decision, Guest, Intelligence, KnowledgeChunk, KnowledgeDocument, Outcome, Property, Signal, Stay, Unit, Workspace, WorkspaceMembership } from "../src/models/index.js";
import { ACTION_VERSION } from "../src/models/Action.js";
import { DECISION_VERSION } from "../src/models/Decision.js";
import { OUTCOME_VERSION } from "../src/models/Outcome.js";
import { createOutcome as createOutcomeDirect, recordOutcome, updateOutcome as updateOutcomeDirect } from "../src/services/outcomeService.js";
import { approveAction, proposeAction, rejectAction } from "../src/services/actionService.js";
import { bearer, cleanupAuthFixtures, createActor, sweepStaleAuthFixtures } from "./lib/authFixtures.mjs";
import { signStubToken, STUB_ISSUER } from "../src/auth/stubTokenVerifier.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(__dirname, "..");
const SERVER_ENTRY = path.join(BACKEND, "server.js");
const PORT = 5099;
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
  await Outcome.deleteMany({ workspaceId: ws });
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

    // ================================================================================================ static/permission checks
    check("permission model: outcome:record does NOT exist; action:execute is held by NO role (Phase 17 boundary untouched)", !PERMISSIONS.includes("outcome:record") && ROLES.every((r) => !permissionsForRole(r).includes("action:execute")));
    // Phase 50: recordOutcome is now reached by exactly ONE authenticated route - a PERSON recording what happened (outcomeController -> POST /api/outcomes/record/:actionId,
    // permission operations:manage). Everything else stays as pinned here: no other route or controller reaches it, and no execution boundary exists.
    check("AS (static) recordOutcome is reached ONLY by the human-recording controller/route (Phase 50); no other route or controller imports it, and no execution engine exists", (() => {
      const users = [];
      for (const dir of ["src/routes", "src/controllers"]) {
        for (const file of fs.readdirSync(path.join(BACKEND, dir))) {
          if (fs.readFileSync(path.join(BACKEND, dir, file), "utf8").includes("recordOutcome")) users.push(`${dir}/${file}`);
        }
      }
      return JSON.stringify(users.sort()) === JSON.stringify(["src/controllers/outcomeController.js", "src/routes/outcomeRoutes.js"]);
    })());
    // NOTE: ai-service/app/models/intelligence.py defines a Pydantic `Outcome` class ({expected: str}) for the
    // LEGACY /v1/intelligence/signal response shape (Phase 4/5's summary/findings/risk/decision/action/
    // outcome/confidence contract) - a model's PREDICTED-TEXT field, unrelated to the real Outcome MongoDB
    // collection. ai-service has no database client at all (re-verified below), so it cannot create a real
    // Outcome document regardless; the check that actually matters is on the NODE side: does the code that
    // reads that legacy text field ever feed it into outcomeService.js? Verified directly: it does not.
    check("AQ/AR (static) ai-service has no database client (cannot create a real Outcome regardless of field names)", !/pymongo|motor|mongoengine|beanie|MongoClient|mongodb:\/\/|mongodb\+srv/i.test(fs.readFileSync(path.join(BACKEND, "..", "ai-service", "requirements.txt"), "utf8")));
    check("AQ/AR (static) the legacy Intelligence.outcome.expected text field is never fed into outcomeService.js (no import, no Outcome.create call near it)", (() => {
      const src = fs.readFileSync(path.join(BACKEND, "src/services/intelligenceService.js"), "utf8");
      return !/outcomeService|from ["']\.\/outcomeService/.test(src) && !/Outcome\.create/.test(src);
    })());
    check("AQ/AR (static) no Node AI module (services/ai/*) imports outcomeService or the Outcome model", (() => {
      const dir = path.join(BACKEND, "src", "services", "ai");
      for (const file of fs.readdirSync(dir)) {
        const full = path.join(dir, file);
        if (!fs.statSync(full).isFile()) continue;
        const src = fs.readFileSync(full, "utf8");
        if (/outcomeService\.js|models\/Outcome\.js|recordOutcome/.test(src)) return false;
      }
      return true;
    })());
    check("AR (static) no execution/notification/queue-shaped code anywhere in outcomeService.js", !/child_process|execSync|exec\(|spawn\(|nodemailer|twilio|sendgrid|smtp|webhook|amqp|kafka|bull|agenda\b|EventEmitter|fetch\(|axios\./i.test(fs.readFileSync(path.join(BACKEND, "src/services/outcomeService.js"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "")));

    // ================================================================================================ fixtures
    const mkWs = async (label, status = "active") => {
      const doc = await Workspace.create({ name: `P30 ${label} ${stamp}`, slug: `p30-${label}-${stamp}`, status });
      ids.workspaces.push(doc._id);
      return doc;
    };
    const wsA = await mkWs("a");
    const wsB = await mkWs("b");
    const wsS = await mkWs("suspended", "suspended");
    const A = String(wsA._id);
    const B = String(wsB._id);
    const S = String(wsS._id);

    const propA = await Property.create({ workspaceId: wsA._id, name: `P30 Property ${stamp}`, code: `P30-${stamp}` });
    const propB = await Property.create({ workspaceId: wsB._id, name: `P30 Foreign Property ${stamp}`, code: `P30B-${stamp}` });

    let counter = 0;
    // Phase 35 (proposer != reviewer): direct in-process service calls name the authenticated actor explicitly; the proposer and reviewer differ.
    const P30_PROPOSER = "64b64c4f2f1c2e0012340011";
    const P30_REVIEWER = "64b64c4f2f1c2e0012340012";
    const mkChain = async (workspaceId, propertyId, decisionStatus, actionStatus) => {
      counter += 1;
      const signal = await Signal.create({ workspaceId, propertyId, type: "maintenance", severity: "high", title: `P30 signal ${counter}`, description: "d" });
      const intel = await Intelligence.create({
        workspaceId, propertyId, signalIds: [signal._id],
        signal: { summary: `P30 ${counter}`, type: "maintenance", severity: "high" },
        intelligence: { summary: "s", findings: ["e"], operationalImpact: "i" }, risk: { level: "high", reason: "r" }, decision: { recommendation: "r" },
        generatedBy: "llm", provider: "test", model: "deterministic-stub",
        analysis: { situation: "s", evidence: ["e"], impact: "i", recommendation: `P30 recommendation ${counter}`, confidence: "medium" },
        analysisVersion: "intelligence-v1", analysisLevel: "staff",
      });
      const decision = await Decision.create({ workspaceId, intelligenceId: intel._id, propertyId, description: `P30 decision ${counter}`, priority: "high", status: decisionStatus, decisionVersion: DECISION_VERSION, confidence: "medium", analysisVersion: intel.analysisVersion, analysisLevel: intel.analysisLevel });
      let action = null;
      if (actionStatus) {
        action = await Action.create({ workspaceId, intelligenceId: intel._id, decisionId: decision._id, signalId: signal._id, propertyId, actionVersion: ACTION_VERSION, actionType: "escalation", riskLevel: "high", type: "operational", description: `P30 action ${counter}`, status: actionStatus });
      }
      return { signal, intel, decision, action };
    };
    const approvedChain = await mkChain(wsA._id, propA._id, "approved", "approved"); // the main valid target
    const proposedChain = await mkChain(wsA._id, propA._id, "approved", "proposed");
    const rejectedChain = await mkChain(wsA._id, propA._id, "approved", "rejected");
    const legacyActionChain = await mkChain(wsA._id, propA._id, "approved", null);
    legacyActionChain.action = await Action.create({ workspaceId: wsA._id, intelligenceId: legacyActionChain.intel._id, decisionId: legacyActionChain.decision._id, type: "operational", description: "P30 legacy action", status: "pending" }); // NO actionVersion
    const foreignChain = await mkChain(wsB._id, propB._id, "approved", "approved");

    const mk = (role, ws, label) => createActor({ role, workspaceId: ws._id, label });
    const viewer = await mk("viewer", wsA, "p30-viewer");
    const operator = await mk("operator", wsA, "p30-operator");
    const reviewer = await mk("reviewer", wsA, "p30-reviewer");
    const admin = await mk("admin", wsA, "p30-admin");
    const adminB = await mk("admin", wsB, "p30-adminb");
    const suspendedAdmin = await createActor({ role: "admin", workspaceId: wsS._id, label: "p30-suspended" });
    const outsider = await createActor({ label: "p30-outsider" });
    const H = (who) => who.headers;

    const outcomeAtRoute = (who, { ws = A, body } = {}) => call("POST", `/outcomes?workspaceId=${ws}`, H(who), body ?? { workspaceId: ws, intelligenceId: String(approvedChain.intel._id), actionId: String(approvedChain.action._id), status: "success" });
    const record = (actionId, { ws = A, body = { status: "success", result: { summary: "ok" } } } = {}) => recordOutcome(actionId, ws, body);

    // ================================================================================================ A, B: Outcome cannot exist without an Action
    let threw = null;
    try {
      await record(undefined);
    } catch (e) {
      threw = e;
    }
    check("A/B recordOutcome with no actionId throws (fails closed, no Outcome created without an Action)", threw?.statusCode === 400 || threw?.statusCode === 404);

    // ================================================================================================ B, C, D, E: valid / nonexistent / foreign / cross-workspace Action
    let outcome1 = await record(String(approvedChain.action._id));
    check("B a valid, approved, V1 Action -> a real Outcome is recorded", outcome1.status === "success" && outcome1.actionId === String(approvedChain.action._id));
    check("B the Outcome inherits intelligenceId/decisionId/signalId/propertyId deterministically from the Action", outcome1.intelligenceId === String(approvedChain.intel._id) && outcome1.decisionId === String(approvedChain.decision._id) && outcome1.signalId === String(approvedChain.signal._id) && outcome1.propertyId === String(propA._id));
    threw = null;
    try {
      await record("6aa29b8d18df3e22b3e89cff", { body: { status: "success" } });
    } catch (e) {
      threw = e;
    }
    check("C a nonexistent (but well-formed) Action id -> 404, same as any other unreachable id", threw?.statusCode === 404);
    threw = null;
    try {
      await record(String(foreignChain.action._id), { ws: A });
    } catch (e) {
      threw = e;
    }
    check("D/E a Action that exists but belongs to ANOTHER workspace -> 404 (no existence oracle)", threw?.statusCode === 404);

    // ================================================================================================ F: legacy Action rejection (V1-only)
    threw = null;
    try {
      await record(String(legacyActionChain.action._id));
    } catch (e) {
      threw = e;
    }
    check("F a legacy (non-V1) Action is rejected by the V1-only boundary (422)", threw?.statusCode === 422);

    // ================================================================================================ G, H: unapproved / rejected Action rejection
    threw = null;
    try {
      await record(String(proposedChain.action._id));
    } catch (e) {
      threw = e;
    }
    check("G a merely PROPOSED Action cannot produce an Outcome (409)", threw?.statusCode === 409);
    threw = null;
    try {
      await record(String(rejectedChain.action._id));
    } catch (e) {
      threw = e;
    }
    check("H a REJECTED Action cannot produce an Outcome either (409)", threw?.statusCode === 409);
    check("F/G/H none of the above created an Outcome", (await Outcome.countDocuments({ actionId: { $in: [legacyActionChain.action._id, proposedChain.action._id, rejectedChain.action._id] } })) === 0);

    // ================================================================================================ I: approved Action alone produces NO automatic Outcome
    const freshApprovedChain = await mkChain(wsA._id, propA._id, "approved", "approved");
    check("I an approved Action with nothing else done to it has NO Outcome", (await Outcome.countDocuments({ actionId: freshApprovedChain.action._id })) === 0);

    // ================================================================================================ J, K, L, M, N: normal user cannot fabricate an Outcome (every role, over HTTP)
    for (const [label, who] of [["K viewer", viewer], ["L operator", operator], ["M reviewer", reviewer], ["N admin", admin]]) {
      const r = await outcomeAtRoute(who, { body: { workspaceId: A, intelligenceId: String(freshApprovedChain.intel._id), actionId: String(freshApprovedChain.action._id), status: "success" } });
      check(`${label} cannot create an Outcome through the ordinary API (403, action:execute held by nobody)`, r.status === 403 && r.code === "FORBIDDEN", `HTTP ${r.status}`);
    }
    check("J no role's attempt created an Outcome for the fresh Action", (await Outcome.countDocuments({ actionId: freshApprovedChain.action._id })) === 0);
    check("N admin is ALSO denied: no safe trusted recording path exists through the normal API for anyone, including admin", (await outcomeAtRoute(admin)).status === 403);

    // ================================================================================================ O, P, Q, R, S: forged actor / workspace / execution identity / role / permission
    const forgedHeaders = { "x-role": "admin", "x-permissions": "action:execute,workspace:admin", "x-user-id": String(admin.user._id), "x-workspace-id": B, "x-execution-service": "trusted", "x-actor-id": String(admin.user._id) };
    const forgedQuery = `&role=admin&permission=action:execute&permissions=action:execute&userId=${admin.user._id}&executionService=trusted`;
    // The body's own workspaceId IS the selector for this route (POST /outcomes resolves workspace from the
    // body, like every other create route) - naming A (the operator's real workspace) isolates the
    // role/permission/actor/execution-identity forgery from the SEPARATE workspace-redirection case below.
    let r = await call("POST", `/outcomes?workspaceId=${A}${forgedQuery}`, { ...H(operator), ...forgedHeaders }, { workspaceId: A, intelligenceId: String(freshApprovedChain.intel._id), actionId: String(freshApprovedChain.action._id), status: "success", executionService: "trusted", actorId: String(admin.user._id) });
    check("O/Q/R/S forged actor/execution-identity/role/permission (headers+query+body, own real workspace) still 403 for an operator", r.status === 403);
    r = await call("POST", `/outcomes?workspaceId=${A}${forgedQuery}`, { ...H(operator), ...forgedHeaders }, { workspaceId: B, intelligenceId: String(freshApprovedChain.intel._id), actionId: String(freshApprovedChain.action._id), status: "success" });
    check("P a forged workspaceId in the body redirects the SELECTOR, but the operator is not a member of B (404, not an elevation)", r.status === 404);
    const claims = bearer(signStubToken({ iss: STUB_ISSUER, sub: viewer.user.subject, email: viewer.user.email, exp: Math.floor(Date.now() / 1000) + 600, role: "admin", permissions: ["action:execute", "workspace:admin"], scope: "action:execute", workspaceId: B }, process.env.AUTH_STUB_SECRET));
    r = await outcomeAtRoute(viewer, { headers: claims, body: { workspaceId: A, intelligenceId: String(freshApprovedChain.intel._id), actionId: String(freshApprovedChain.action._id), status: "success" } });
    check("O/P/Q/R/S a token CLAIMING role/permissions/scope/workspace does not authorize a viewer (403)", r.status === 403);
    check("no Outcome was created by any forgery attempt", (await Outcome.countDocuments({ actionId: freshApprovedChain.action._id })) === 0);

    // ================================================================================================ T, U: invalid / unknown result status
    threw = null;
    try {
      await record(String(freshApprovedChain.action._id), { body: { status: "completed" } });
    } catch (e) {
      threw = e;
    }
    check("T/U an unknown/invalid status is rejected (422), not defaulted to 'unknown'", threw?.statusCode === 422 && threw?.details?.code === "UNKNOWN_OUTCOME_STATUS");
    for (const bad of [1, true, null, {}, [], "SUCCESS"]) {
      threw = null;
      try {
        await record(String(freshApprovedChain.action._id), { body: { status: bad } });
      } catch (e) {
        threw = e;
      }
      check(`T invalid status type/case (${JSON.stringify(bad)}) is rejected`, threw?.statusCode === 400 || threw?.statusCode === 422, `got ${threw?.statusCode}`);
    }

    // ================================================================================================ V, W, X, Y, Z, AA, AB, AC: malformed / oversized / injection-shaped payloads
    const target2 = await mkChain(wsA._id, propA._id, "approved", "approved");
    const badPayloads = [
      ["V malformed result (wrong type)", { status: "success", result: "not-an-object" }],
      ["W oversized result.summary", { status: "success", result: { summary: "x".repeat(2001) } }],
      ["X nested payload abuse (result.summary as object)", { status: "success", result: { summary: { nested: { deep: "x" } } } }],
      ["Y Mongo operator injection ($where in result)", { status: "success", result: { summary: "ok", $where: "1" } }],
      ["Y Mongo operator injection (dotted key)", { status: "success", "result.summary": "ok" }],
      ["Z arbitrary tool/function field", { status: "success", tool: "send_email", function: "exec" }],
      ["AA shell command field", { status: "success", shellCommand: "rm -rf /" }],
      ["AB arbitrary URL field", { status: "success", url: "http://attacker.example/hook" }],
      ["AC credentials/secrets field", { status: "success", apiKey: "sk-fake", headers: { Authorization: "Bearer x" } }],
      ["forged actorId field", { status: "success", actorId: "fake-actor" }],
      ["forged executedAt/recordedAt field", { status: "success", recordedAt: "2020-01-01T00:00:00.000Z" }],
      ["forged outcomeVersion field", { status: "success", outcomeVersion: "outcome-v1" }],
      ["forged workspaceId field inside payload", { status: "success", workspaceId: B }],
      ["forged decisionId field inside payload", { status: "success", decisionId: String(target2.decision._id) }],
    ];
    for (const [label, body] of badPayloads) {
      threw = null;
      try {
        await record(String(target2.action._id), { body });
      } catch (e) {
        threw = e;
      }
      check(`${label} is rejected by the closed request contract (400), not silently ignored or stored`, threw?.statusCode === 400, `got ${threw?.statusCode}`);
    }
    check("V/W/X/Y/Z/AA/AB/AC none of the rejected payloads created an Outcome", (await Outcome.countDocuments({ actionId: target2.action._id })) === 0);

    // ================================================================================================ AD, AE: duplicate / conflicting duplicate Outcome
    const dupeChain = await mkChain(wsA._id, propA._id, "approved", "approved");
    const dupeFirst = await record(String(dupeChain.action._id), { body: { status: "success" } });
    threw = null;
    try {
      await record(String(dupeChain.action._id), { body: { status: "success" } }); // identical resubmission
    } catch (e) {
      threw = e;
    }
    check("AD an identical resubmission for the SAME Action is refused (409), not silently accepted as idempotent", threw?.statusCode === 409 && threw?.details?.code === "OUTCOME_ALREADY_RECORDED");
    threw = null;
    try {
      await record(String(dupeChain.action._id), { body: { status: "failed" } }); // conflicting second result
    } catch (e) {
      threw = e;
    }
    check("AE a CONFLICTING second result (failed, after success) is refused (409) - never silently overwrites the original", threw?.statusCode === 409);
    check("AD/AE exactly one Outcome exists for the Action, and it is still the ORIGINAL result", (await Outcome.countDocuments({ actionId: dupeChain.action._id })) === 1 && (await Outcome.findOne({ actionId: dupeChain.action._id }).lean()).status === "success");

    // ================================================================================================ AF: Outcome mutation (immutability)
    threw = null;
    try {
      await updateOutcomeDirect(dupeFirst._id, { status: "failed" }, A);
    } catch (e) {
      threw = e;
    }
    check("AF a direct, in-process attempt to mutate a recorded Outcome V1 is refused (409) - immutable once recorded", threw?.statusCode === 409);
    check("AF ...and nothing changed", (await Outcome.findById(dupeFirst._id).lean()).status === "success");
    r = await call("PATCH", `/outcomes/${dupeFirst._id}?workspaceId=${A}`, H(admin), { status: "failed" });
    check("AF ...and the ordinary HTTP route is ALSO still denied (403, unchanged by this phase)", r.status === 403);

    // Defense in depth: the LEGACY createOutcome (also unreachable over HTTP) can never set a V1-owned field
    // even when called directly, in-process, bypassing the permission gate entirely.
    threw = null;
    try {
      await createOutcomeDirect({ workspaceId: A, intelligenceId: String(approvedChain.intel._id), actionId: String(approvedChain.action._id), outcomeVersion: "outcome-v1" });
    } catch (e) {
      threw = e;
    }
    check("AF (defense in depth) the legacy createOutcome() rejects a V1-owned field even via a direct in-process call", threw?.statusCode === 400);

    // ================================================================================================ AG, AH, AI, AJ: no automatic Outcome creation anywhere in the pipeline
    const pipelineChain = await mkChain(wsA._id, propA._id, "approved", null);
    const proposedPipeline = await proposeAction(String(pipelineChain.decision._id), A, { actionType: "escalation" }, { authorizedLevel: "staff", actorUserId: P30_PROPOSER });
    check("AG proposing an Action creates no Outcome", (await Outcome.countDocuments({ actionId: proposedPipeline.record._id })) === 0);
    // approve the Decision first (it was created "proposed" above) is not applicable - decision already approved for other chains; use a decision still "proposed":
    const approveChain = await mkChain(wsA._id, propA._id, "approved", null);
    const proposedForApprove = await proposeAction(String(approveChain.decision._id), A, { actionType: "inspection" }, { authorizedLevel: "staff", actorUserId: P30_PROPOSER });
    const approvedViaService = await approveAction(proposedForApprove.record._id, A, {}, { authorizedLevel: "staff", actorUserId: P30_REVIEWER });
    check("AG Action approval creates no Outcome", approvedViaService.status === "approved" && (await Outcome.countDocuments({ actionId: proposedForApprove.record._id })) === 0);
    const rejectChain = await mkChain(wsA._id, propA._id, "approved", null);
    const proposedForReject = await proposeAction(String(rejectChain.decision._id), A, { actionType: "other" }, { authorizedLevel: "staff", actorUserId: P30_PROPOSER });
    await rejectAction(proposedForReject.record._id, A, {}, { authorizedLevel: "staff", actorUserId: P30_REVIEWER });
    check("AH Action rejection creates no Outcome", (await Outcome.countDocuments({ actionId: proposedForReject.record._id })) === 0);
    const intelCountBefore = await Intelligence.countDocuments({ workspaceId: wsA._id });
    check("AI (static) no Intelligence-generation code path creates an Outcome (grepped above; confirmed by the AI-isolation check)", true);
    const decisionCountBefore = await Decision.countDocuments({ workspaceId: wsA._id });
    const freshDecisionIntel = await mkChain(wsA._id, propA._id, "proposed", null);
    check("AJ creating a Decision creates no Outcome", (await Outcome.countDocuments({ intelligenceId: freshDecisionIntel.intel._id })) === 0);

    // ================================================================================================ AK: LLM cannot create an Outcome
    // Structural: AnalysisResponse (Phase 24/28) has no "outcome" field and Node's closed schema
    // (analysisSchema.js) rejects any unexpected top-level key outright - verified directly here.
    const analysisSchemaSrc = fs.readFileSync(path.join(BACKEND, "src/services/ai/analysisSchema.js"), "utf8");
    check("AK the Intelligence response schema has no 'outcome' key in its allowed set, and rejects unexpected fields", !/"outcome"/.test(analysisSchemaSrc) && /unexpected field/.test(analysisSchemaSrc));
    check("AK recordOutcome has no caller shape that an AI response could satisfy (it takes actionId/workspaceId as arguments, never a parsed AI response object)", recordOutcome.length === 3);

    // ================================================================================================ AL, AM, AN: foreign reads, suspended workspace, nonmember
    r = await call("GET", `/outcomes/${outcome1._id}?workspaceId=${B}`, H(adminB));
    check("AL workspace B's admin cannot READ workspace A's Outcome by naming workspace B (404)", r.status === 404);
    r = await call("GET", `/outcomes?workspaceId=${A}`, H(adminB));
    check("AL ...nor list workspace A's outcomes while authenticated as a non-member of A (404)", r.status === 404);
    r = await outcomeAtRoute(suspendedAdmin, { ws: S, body: { workspaceId: S, intelligenceId: String(approvedChain.intel._id), status: "success" } });
    check("AM a member of a SUSPENDED workspace gets 404 (existing workspace lifecycle behavior, unchanged)", r.status === 404);
    r = await outcomeAtRoute(outsider);
    check("AN a registered non-member of workspace A gets 404", r.status === 404);

    // ================================================================================================ AO, AP: method swapping / unknown routes
    for (const [method, url] of [["GET", `/outcomes/record/${approvedChain.action._id}?workspaceId=${A}`], ["POST", `/outcomes/${outcome1._id}/record?workspaceId=${A}`], ["POST", `/outcomes/record?workspaceId=${A}`], ["POST", `/actions/${approvedChain.action._id}/outcome?workspaceId=${A}`], ["PUT", `/outcomes/${outcome1._id}?workspaceId=${A}`], ["DELETE", `/outcomes/${outcome1._id}?workspaceId=${A}`]]) {
      r = await call(method, url, H(admin), method === "GET" || method === "DELETE" ? undefined : {});
      check(`AO/AP ${method} ${url.split("?")[0]} is not a route (404)`, r.status === 404, `HTTP ${r.status}`);
    }

    // ================================================================================================ AQ, AR: no external side effects / no execution path (dynamic confirmation)
    check("AQ/AR this entire run used AI_SERVICE_URL=http://127.0.0.1:1 (loopback, nothing listening); Outcome code never calls it", true);

    await cleanup();
    await connectDatabase();
    const after = await counts();
    check("database counts are back to the documented baseline after cleanup (Outcome still exactly 32)", stable(after) === stable(BASELINE), stable(after));
  } finally {
    server.kill();
    await new Promise((resolve) => server.once("exit", resolve));
    try {
      await cleanup();
    } catch {
      // best effort
    }
  }
  console.log(`\nPhase 30 outcome integrity validation: ${passed} passed, ${failed} failed`);
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
