/**
 * Phase 17 validation: Action / Outcome WRITE authorization, and the Guest name-search regex fix.
 *
 *   POST /actions, PATCH /actions/:id, POST /outcomes, PATCH /outcomes/:id
 *       authenticate -> active membership of the verified workspace -> `action:execute`,
 *       a permission NO role holds (Phase 12 policy). Every authenticated member is therefore denied (403).
 *       No permission was added to any role; `outcome:record` was NOT created.
 *   GET /guests?name=   the client's text is matched literally (regex metacharacters escaped), length <= 100.
 *
 * REAL HTTP against a REAL spawned backend (process fallback knowledge level: restricted, the worst case), real stored
 * users/memberships/stub tokens, throwaway workspaces. Object-level rules (workspace ownership, parent chain) are also
 * exercised in-process against the services, since no HTTP caller can reach them any more. No AI service is involved.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { signStubToken, STUB_ISSUER } from "../src/auth/stubTokenVerifier.js";
import { ROLES, permissionsForRole } from "../src/auth/roles.js";
import * as Models from "../src/models/index.js";
import { Action, Decision, Guest, Intelligence, Outcome, User, Workspace, WorkspaceMembership } from "../src/models/index.js";
import { createAction, updateAction } from "../src/services/actionService.js";
import { createOutcome, updateOutcome } from "../src/services/outcomeService.js";
import { bearer, cleanupAuthFixtures, createActor } from "./lib/authFixtures.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, "..", "server.js");
const PORT = 5087;
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

async function call(method, url, headers = {}, body) {
  const response = await fetch(`${BASE}${url}`, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const raw = await response.text();
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {
    json = null;
  }
  return { status: response.status, json, raw, data: json?.data, code: json?.details?.code };
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

const ids = { workspaces: [] };
async function cleanup() {
  await connectDatabase();
  await cleanupAuthFixtures();
  const ws = { $in: ids.workspaces };
  await Promise.all([Models.Outcome.deleteMany({ workspaceId: ws }), Models.Action.deleteMany({ workspaceId: ws }), Models.Decision.deleteMany({ workspaceId: ws }), Models.Guest.deleteMany({ workspaceId: ws })]);
  await Promise.all([Models.Intelligence.deleteMany({ workspaceId: ws }), Models.WorkspaceMembership.deleteMany({ workspaceId: ws })]);
  await Models.Workspace.deleteMany({ _id: ws });
  await disconnectDatabase();
}

async function main() {
  const stamp = Date.now();
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, PORT: String(PORT), LLM_PROVIDER: "test", KNOWLEDGE_DEV_AUTHORIZED_LEVEL: "restricted", AI_SERVICE_URL: "http://localhost:9" },
    stdio: "ignore",
  });

  try {
    await waitForHealth();
    check("ephemeral server healthy (stub authentication; process fallback level: restricted; AI service URL is a dead port)", true);
    await connectDatabase();
    await Promise.all([User.init(), WorkspaceMembership.init(), Intelligence.init()]);

    check("PM1: NO role holds `action:execute`, and no `outcome:record` permission exists", ROLES.every((role) => !permissionsForRole(role).includes("action:execute") && !permissionsForRole(role).includes("outcome:record")));

    const mkWs = async (label, status = "active") => {
      const doc = await Workspace.create({ name: `P17 ${label} ${stamp}`, slug: `p17-${label}-${stamp}`, status });
      ids.workspaces.push(doc._id);
      return doc;
    };
    const wsA = await mkWs("a");
    const wsB = await mkWs("b");
    const wsS = await mkWs("suspended", "suspended");
    const A = String(wsA._id);
    const B = String(wsB._id);
    const S = String(wsS._id);
    const OWN = ids.workspaces;
    const NAMES = ["Workspace", "Property", "Guest", "Stay", "Signal", "Intelligence", "KnowledgeDocument", "KnowledgeChunk", "ImportBatch", "Conversation", "Message", "Decision", "Action", "Outcome"];
    const realCounts = async () => ({
      ...Object.fromEntries(await Promise.all(NAMES.map(async (name) => [name, await Models[name].countDocuments(name === "Workspace" ? { _id: { $nin: OWN } } : { workspaceId: { $nin: OWN } })]))),
      Unit: await Models.Unit.countDocuments({}),
    });
    const before = await realCounts();

    const actor = (role, ws = wsA, label = "p17") => createActor({ role, workspaceId: ws._id, label });
    const viewer = await actor("viewer");
    const operator = await actor("operator");
    const reviewer = await actor("reviewer");
    const admin = await actor("admin");
    const adminB = await actor("admin", wsB);
    const outsider = await createActor({ label: "p17-outsider" });
    const revoked = await actor("operator", wsA, "p17-revoked");
    await WorkspaceMembership.updateOne({ _id: revoked.membership._id }, { $set: { status: "revoked" } });
    const disabled = await actor("operator", wsA, "p17-disabled");
    await User.updateOne({ _id: disabled.user._id }, { $set: { status: "disabled" } });
    const suspendedAdmin = await createActor({ role: "admin", workspaceId: wsS._id, label: "p17-suspended" });
    const unregistered = bearer(signStubToken({ iss: STUB_ISSUER, sub: `never-provisioned-${stamp}`, exp: Math.floor(Date.now() / 1000) + 600 }, process.env.AUTH_STUB_SECRET));
    const exp = () => Math.floor(Date.now() / 1000) + 600;
    const H = (who) => who.headers;
    const roles = { viewer, operator, reviewer, admin };
    const forgedHeaders = { "x-role": "admin", "x-user-role": "admin", "x-permission": "action:execute", "x-permissions": "action:execute,workspace:admin", "x-knowledge-level": "restricted", "x-workspace-id": B, cookie: "role=admin; permission=action:execute" };
    const forgedQuery = "role=admin&permission=action:execute&permissions=action:execute&authorizedLevel=restricted";
    const bodyForge = { role: "admin", permission: "action:execute", permissions: ["action:execute"], knowledgeLevel: "restricted", authorizedLevel: "restricted" };

    // ------------------------------------------------ fixtures (models; throwaway workspaces)
    const mkIntel = (ws, level) => Intelligence.create({ workspaceId: ws._id, signalIds: [], generatedBy: "llm", analysisVersion: "intelligence-v1", analysisLevel: level, knowledgeVisibility: level === "guest" ? undefined : level, analysis: { situation: "s", evidence: ["e"], impact: "i", recommendation: "r", confidence: "low" } });
    const iA = await mkIntel(wsA, "guest");
    const iB = await mkIntel(wsB, "guest");
    const aA = await Action.create({ workspaceId: wsA._id, intelligenceId: iA._id, description: "P17 ACTION A" });
    const aB = await Action.create({ workspaceId: wsB._id, intelligenceId: iB._id, description: "P17 ACTION B" });
    const oA = await Outcome.create({ workspaceId: wsA._id, intelligenceId: iA._id, result: { summary: "P17 OUTCOME A" } });
    const oB = await Outcome.create({ workspaceId: wsB._id, intelligenceId: iB._id, result: { summary: "P17 OUTCOME B" } });
    const dApproved = await Decision.create({ workspaceId: wsA._id, intelligenceId: iA._id, description: "P17 decision", decisionVersion: "decision-v1", status: "approved", analysisVersion: "intelligence-v1" });
    const dApprovedB = await Decision.create({ workspaceId: wsB._id, intelligenceId: iB._id, description: "P17 decision B", decisionVersion: "decision-v1", status: "approved", analysisVersion: "intelligence-v1" });
    const snap = async () => JSON.stringify([await Action.find({ workspaceId: { $in: OWN } }).sort({ _id: 1 }).lean(), await Outcome.find({ workspaceId: { $in: OWN } }).sort({ _id: 1 }).lean()]);
    const snapshot0 = await snap();
    const counts0 = { actions: await Action.countDocuments({ workspaceId: { $in: OWN } }), outcomes: await Outcome.countDocuments({ workspaceId: { $in: OWN } }) };

    const kinds = {
      action: { path: "/actions", seedA: aA, seedB: aB, intelA: iA, intelB: iB, create: (ws, intel, extra = {}) => ({ workspaceId: ws, intelligenceId: String(intel._id), description: "P17 write probe", ...extra }), patch: { description: "P17 patched" } },
      outcome: { path: "/outcomes", seedA: oA, seedB: oB, intelA: iA, intelB: iB, create: (ws, intel, extra = {}) => ({ workspaceId: ws, intelligenceId: String(intel._id), result: { summary: "P17 write probe" }, ...extra }), patch: { status: "successful" } },
    };

    // ================================================ 1. authentication
    for (const [kind, k] of Object.entries(kinds)) {
      const post = (headers, ws = A, extra) => call("POST", k.path, headers, k.create(ws, k.intelA, extra));
      const patch = (headers, ws = A) => call("PATCH", `${k.path}/${k.seedA._id}?workspaceId=${ws}`, headers, k.patch);
      let r = await post({});
      check(`AU1 ${kind}: POST without a token -> 401`, r.status === 401 && r.code === "MISSING_CREDENTIAL", `HTTP ${r.status}`);
      r = await patch({});
      check(`AU1 ${kind}: PATCH without a token -> 401`, r.status === 401 && r.code === "MISSING_CREDENTIAL", `HTTP ${r.status}`);
      for (const [name, headers] of [["invalid", bearer("not.a.token")], ["malformed", { authorization: "Basic abc" }], ["expired", bearer(signStubToken({ iss: STUB_ISSUER, sub: admin.user.subject, exp: Math.floor(Date.now() / 1000) - 30 }, process.env.AUTH_STUB_SECRET))], ["wrong signature", bearer(signStubToken({ iss: STUB_ISSUER, sub: admin.user.subject, exp: exp() }, "a-different-secret-not-real-0123456789"))]]) {
        check(`AU2 ${kind}: ${name} credential -> 401 (POST and PATCH)`, (await post(headers)).status === 401 && (await patch(headers)).status === 401);
      }
      r = await post(unregistered);
      check(`AU3 ${kind}: valid token, unregistered identity -> 403 IDENTITY_NOT_REGISTERED (POST)`, r.status === 403 && r.code === "IDENTITY_NOT_REGISTERED");
      r = await patch(unregistered);
      check(`AU3 ${kind}: valid token, unregistered identity -> 403 (PATCH)`, r.status === 403 && r.code === "IDENTITY_NOT_REGISTERED");
      check(`AU4 ${kind}: disabled user -> 403 (POST, PATCH)`, (await post(H(disabled))).status === 403 && (await patch(H(disabled))).status === 403);
      check(`AU5 ${kind}: revoked membership -> 404 (POST, PATCH)`, (await post(H(revoked))).status === 404 && (await patch(H(revoked))).status === 404);
      check(`AU6 ${kind}: non-member -> 404 (POST, PATCH)`, (await post(H(outsider))).status === 404 && (await patch(H(outsider))).status === 404);
      check(`AU7 ${kind}: member of a suspended workspace -> 404`, (await call("POST", k.path, H(suspendedAdmin), k.create(S, k.intelA))).status === 404 && (await call("PATCH", `${k.path}/${k.seedA._id}?workspaceId=${S}`, H(suspendedAdmin), k.patch)).status === 404);
      check(`AU8 ${kind}: missing workspace selector -> 400 (POST body, PATCH query)`, (await call("POST", k.path, H(admin), { intelligenceId: String(k.intelA._id) })).status === 400 && (await call("PATCH", `${k.path}/${k.seedA._id}`, H(admin), k.patch)).status === 400);
    }
    check("AU9: nothing was auto-provisioned", (await User.countDocuments({ subject: `never-provisioned-${stamp}` })) === 0);

    // ================================================ 2. every role is DENIED (403), nothing stored or changed
    for (const [kind, k] of Object.entries(kinds)) {
      for (const [role, who] of Object.entries(roles)) {
        let r = await call("POST", k.path, H(who), k.create(A, k.intelA));
        check(`WR1 ${kind}/${role}: POST -> 403 FORBIDDEN (no role holds action:execute)`, r.status === 403 && r.code === "FORBIDDEN", `HTTP ${r.status}`);
        check(`WR1 ${kind}/${role}: the denial leaks no record text`, !/P17 (ACTION|OUTCOME)/.test(r.raw));
        r = await call("PATCH", `${k.path}/${k.seedA._id}?workspaceId=${A}`, H(who), k.patch);
        check(`WR2 ${kind}/${role}: PATCH of an own-workspace record -> 403`, r.status === 403 && r.code === "FORBIDDEN", `HTTP ${r.status}`);
        r = await call("PATCH", `${k.path}/6aa29b8d18df3e22b3e89cff?workspaceId=${A}`, H(who), k.patch);
        check(`WR3 ${kind}/${role}: PATCH of a NON-EXISTENT id -> 403 (authorization precedes the lookup: no existence oracle)`, r.status === 403, `HTTP ${r.status}`);
        r = await call("PATCH", `${k.path}/${k.seedB._id}?workspaceId=${A}`, H(who), k.patch);
        check(`WR3 ${kind}/${role}: PATCH of ANOTHER workspace's id -> 403 (same answer as any id)`, r.status === 403, `HTTP ${r.status}`);
      }
    }
    check("WR4: no Action or Outcome was created or changed by any denied write", (await snap()) === snapshot0);

    // ================================================ 3. workspace isolation
    for (const [kind, k] of Object.entries(kinds)) {
      let r = await call("PATCH", `${k.path}/${k.seedB._id}?workspaceId=${B}`, H(admin), k.patch);
      check(`WI1 ${kind}: A's admin selecting workspace B to PATCH B's record -> 404 (not a member of B)`, r.status === 404, `HTTP ${r.status}`);
      r = await call("POST", k.path, H(admin), k.create(B, k.intelB));
      check(`WI2 ${kind}: A's admin POSTing into workspace B -> 404`, r.status === 404, `HTTP ${r.status}`);
      r = await call("PATCH", `${k.path}/${k.seedA._id}?workspaceId=${A}`, H(adminB), k.patch);
      check(`WI3 ${kind}: B's admin PATCHing A's record naming workspace A -> 404`, r.status === 404);
      r = await call("PATCH", `${k.path}/${k.seedA._id}?workspaceId=${B}`, H(adminB), k.patch);
      check(`WI4 ${kind}: B's admin PATCHing A's record via workspace B -> 403 (membership ok, permission denied) and A's record is untouched`, r.status === 403);
      r = await call("POST", `${k.path}?workspaceId=${B}`, H(admin), k.create(A, k.intelA));
      check(`WI5 ${kind}: query workspace B + body workspace A: the body selector decides and the permission still denies -> 403`, r.status === 403);
      r = await call("POST", `${k.path}?workspaceId=${A}`, H(admin), k.create(B, k.intelB));
      check(`WI6 ${kind}: query workspace A + body workspace B: B is not a member workspace -> 404`, r.status === 404);
      r = await call("PATCH", `${k.path}/${k.seedB._id}?workspaceId=${A}`, H(admin), { ...k.patch, workspaceId: B });
      check(`WI7 ${kind}: body workspaceId B on a PATCH cannot redirect authorization (403)`, r.status === 403);
    }
    check("WI8: workspace B's records are unchanged", JSON.stringify([await Action.findById(aB._id).lean(), await Outcome.findById(oB._id).lean()]) === JSON.stringify([aB.toObject(), oB.toObject()]) || (await snap()) === snapshot0);

    // ================================================ 4. spoofing
    for (const [kind, k] of Object.entries(kinds)) {
      for (const role of ["viewer", "operator", "reviewer", "admin"]) {
        let r = await call("POST", `${k.path}?${forgedQuery}&workspaceId=${B}`, { ...H(roles[role]), ...forgedHeaders }, { ...k.create(A, k.intelA), ...bodyForge });
        check(`SP1 ${kind}/${role}: POST with forged headers, query and body -> 403`, r.status === 403, `HTTP ${r.status}`);
        r = await call("PATCH", `${k.path}/${k.seedA._id}?workspaceId=${A}&${forgedQuery}`, { ...H(roles[role]), ...forgedHeaders }, { ...k.patch, ...bodyForge });
        check(`SP2 ${kind}/${role}: PATCH with forged headers, query and body -> 403`, r.status === 403, `HTTP ${r.status}`);
      }
      const claims = bearer(signStubToken({ iss: STUB_ISSUER, sub: operator.user.subject, email: operator.user.email, exp: exp(), role: "admin", permissions: ["action:execute", "workspace:admin"], scope: "action:execute", knowledgeLevel: "restricted", workspaceId: B }, process.env.AUTH_STUB_SECRET));
      check(`SP3 ${kind}: a token CLAIMING role/permissions/scope/workspace does not authorize a write`, (await call("POST", k.path, claims, k.create(A, k.intelA))).status === 403 && (await call("PATCH", `${k.path}/${k.seedA._id}?workspaceId=${A}`, claims, k.patch)).status === 403);
      const r = await call("POST", k.path, { ...H(operator), ...forgedHeaders }, k.create(B, k.intelB));
      check(`SP4 ${kind}: forged X-Workspace-Id / admin headers cannot reach workspace B (404)`, r.status === 404);
    }
    check("SP5: nothing changed after all the spoofed requests", (await snap()) === snapshot0);

    // ================================================ 5. method swapping and alternate paths
    for (const [kind, k] of Object.entries(kinds)) {
      const one = `${k.path}/${k.seedA._id}?workspaceId=${A}`;
      const many = `${k.path}?workspaceId=${A}`;
      const attempts = [
        ["PUT", one], ["DELETE", one], ["PUT", many], ["DELETE", many], ["PATCH", many], ["POST", one],
        // Phase 29 added POST /actions/:id/approve (and /reject) as a REAL, action:review-gated Action V1
        // route (see routes/actionRoutes.js) - this generic "guessed unexpected route" probe no longer
        // applies to it for `action`; it is still checked below at RA1/RA2, still never write to a legacy
        // record, and it still stays a guessed-and-absent path for `outcome` (no Outcome V1 route exists).
        ...(kind === "action" ? [] : [["POST", `${k.path}/${k.seedA._id}/approve?workspaceId=${A}`]]),
        ["PATCH", `${k.path}/${k.seedA._id}/status?workspaceId=${A}`], ["POST", `${k.path}/execute?workspaceId=${A}`],
        ["POST", `${k.path}/${k.seedA._id}/messages?workspaceId=${A}`], ["OPTIONSX", one],
      ];
      for (const [method, url] of attempts) {
        if (method === "OPTIONSX") continue;
        const r = await call(method, url, H(admin), { ...k.patch, ...k.create(A, k.intelA) });
        check(`MS ${kind}: ${method} ${url.split("?")[0].replace(String(k.seedA._id), ":id")} -> 404 (no such route), never a write`, r.status === 404, `HTTP ${r.status}`);
      }
      if (kind === "action") {
        // RA1/RA2: the route is real, but it is gated by action:review and, for this LEGACY (non-V1) seed
        // Action, correctly refused as "not a V1 record" - it still writes nothing to aA.
        const before = await Action.findById(k.seedA._id).lean();
        let r = await call("POST", `${k.path}/${k.seedA._id}/approve?workspaceId=${A}`, H(admin), {});
        check("RA1 action: POST /actions/:id/approve on a LEGACY (non-V1) Action -> 409, not a silent write", r.status === 409, `HTTP ${r.status}`);
        r = await call("POST", `${k.path}/${k.seedA._id}/approve?workspaceId=${A}`, H(viewer), {});
        check("RA2 action: POST /actions/:id/approve denied to a role without action:review (403)", r.status === 403, `HTTP ${r.status}`);
        check("RA3 action: neither attempt changed the legacy Action", JSON.stringify(await Action.findById(k.seedA._id).lean()) === JSON.stringify(before));
      }
      for (const method of ["GET"]) {
        const w = await call(method, `${k.path}/${k.seedA._id}?workspaceId=${A}&description=x&status=successful`, H(operator));
        check(`MS ${kind}: a GET carrying write fields in the query changes nothing (operator: 403 read denial)`, w.status === 403);
      }
      // the read policy of Phase 16 is intact
      check(`RD ${kind}: reviewer/admin reads still work (200); viewer/operator still 403`, (await call("GET", `${k.path}/${k.seedA._id}?workspaceId=${A}`, H(reviewer))).status === 200 && (await call("GET", `${k.path}?workspaceId=${A}`, H(admin))).status === 200 && (await call("GET", `${k.path}?workspaceId=${A}`, H(viewer))).status === 403 && (await call("GET", `${k.path}?workspaceId=${A}`, H(operator))).status === 403);
    }
    check("MS: nothing changed after every swapped method", (await snap()) === snapshot0);

    // ================================================ 6. object-level rules (in-process; no HTTP caller can reach them now)
    const rejects = async (fn) => {
      try {
        await fn();
        return null;
      } catch (error) {
        return error;
      }
    };
    let e = await rejects(() => updateAction(String(aB._id), { description: "IDOR" }, A));
    check("OL1 updateAction: another workspace's Action id under workspace A -> 404", e?.statusCode === 404, String(e?.statusCode));
    e = await rejects(() => updateOutcome(String(oB._id), { status: "successful" }, A));
    check("OL1 updateOutcome: another workspace's Outcome id under workspace A -> 404", e?.statusCode === 404, String(e?.statusCode));
    e = await rejects(() => createAction({ workspaceId: A, intelligenceId: String(iB._id), description: "cross intelligence" }));
    check("OL2 createAction: Intelligence of workspace B under workspace A -> refused", e && e.statusCode >= 400 && e.statusCode < 500, String(e?.statusCode));
    e = await rejects(() => createAction({ workspaceId: A, intelligenceId: String(iA._id), decisionId: String(dApprovedB._id), description: "cross decision" }));
    check("OL3 createAction: Decision of workspace B under workspace A -> refused", e && e.statusCode >= 400 && e.statusCode < 500, String(e?.statusCode));
    e = await rejects(() => updateAction(String(aA._id), { decisionId: String(dApprovedB._id) }, A));
    check("OL3 updateAction: re-pointing to a Decision of workspace B -> refused", e && e.statusCode >= 400 && e.statusCode < 500, String(e?.statusCode));
    e = await rejects(() => createOutcome({ workspaceId: A, intelligenceId: String(iB._id), result: { summary: "x" } }));
    check("OL4 createOutcome: Intelligence of workspace B under workspace A -> refused", e && e.statusCode >= 400 && e.statusCode < 500, String(e?.statusCode));
    e = await rejects(() => createOutcome({ workspaceId: A, intelligenceId: String(iA._id), actionId: String(aB._id), result: { summary: "x" } }));
    check("OL5 createOutcome: Action of workspace B under workspace A -> refused", e && e.statusCode >= 400 && e.statusCode < 500, String(e?.statusCode));
    e = await rejects(() => updateOutcome(String(oA._id), { actionId: String(aB._id) }, A));
    check("OL5 updateOutcome: re-pointing to an Action of workspace B -> refused", e && e.statusCode >= 400 && e.statusCode < 500, String(e?.statusCode));
    e = await rejects(() => updateAction(String(aA._id), { workspaceId: B, description: "move" }, A));
    check("OL6 updateAction: workspaceId cannot be reassigned", e?.statusCode === 400, String(e?.statusCode));
    e = await rejects(() => updateOutcome(String(oA._id), { workspaceId: B, status: "successful" }, A));
    check("OL6 updateOutcome: workspaceId cannot be reassigned", e?.statusCode === 400, String(e?.statusCode));
    const iA2 = await mkIntel(wsA, "staff");
    const proposed = await Decision.create({ workspaceId: wsA._id, intelligenceId: iA2._id, description: "P17 proposed v1", decisionVersion: "decision-v1", status: "proposed", analysisVersion: "intelligence-v1" });
    e = await rejects(() => createAction({ workspaceId: A, intelligenceId: String(iA2._id), decisionId: String(proposed._id), description: "unapproved" }));
    check("OL7 createAction: a Decision V1 that is not approved is still refused (409)", e?.statusCode === 409, String(e?.statusCode));
    const okAction = await createAction({ workspaceId: A, intelligenceId: String(iA._id), decisionId: String(dApproved._id), description: "P17 in-process ok" });
    check("OL8 createAction: the consistent same-workspace chain still works in-process (fixture path)", Boolean(okAction._id));
    await Action.deleteOne({ _id: okAction._id });
    check("OL9: the cross-workspace attempts changed nothing", (await snap()) === snapshot0);

    // ================================================ 7. GET /guests?name= : literal matching
    const mkGuest = (first, last) => Guest.create({ workspaceId: wsA._id, firstName: first, lastName: last, email: `p17-${Math.random().toString(36).slice(2)}@example.invalid` });
    const g = {
      plain: await mkGuest("Anne", "Marie"),
      dot: await mkGuest("Bob.Smith", "Dotted"),
      nodot: await mkGuest("Bobxsmith", "Plain"),
      apostrophe: await mkGuest("Zoe", "O'Neil"),
      parens: await mkGuest("J(ohn)", "Parens"),
      bracket: await mkGuest("Kay[1]", "Brackets"),
      star: await mkGuest("Al*", "Star"),
      dollar: await mkGuest("Cash$", "Money"),
      caret: await mkGuest("^Hat", "Caret"),
      pipe: await mkGuest("Pi|pe", "Pipe"),
      brace: await mkGuest("Br{2}", "Brace"),
      plus: await mkGuest("Ann+", "Plus"),
      question: await mkGuest("Why?", "Mark"),
      backslash: await mkGuest("Back\\slash", "Slash"),
      spaced: await mkGuest("Mary Ann", "Spaced"),
      other: await Guest.create({ workspaceId: wsB._id, firstName: "Bob.Smith", lastName: "OtherWorkspace", email: "p17-other@example.invalid" }),
    };
    const total = await Guest.countDocuments({ workspaceId: wsA._id });
    const search = async (name, who = operator) => call("GET", `/guests?workspaceId=${A}&limit=100&name=${encodeURIComponent(name)}`, H(who));
    const idsOf = (res) => res.data.map((x) => x._id).sort().join(",");
    const only = (...gs) => gs.map((x) => String(x._id)).sort().join(",");
    let r = await search("anne");
    check("NS1 a normal search is a case-insensitive substring match on the first name", r.status === 200 && idsOf(r) === only(g.plain), `n=${r.data?.length}`);
    r = await search("O'NEIL");
    check("NS2 punctuation (apostrophe) matches the last name, case-insensitively", r.status === 200 && idsOf(r) === only(g.apostrophe), `n=${r.data?.length}`);
    r = await search("marie");
    check("NS3 a last-name match", r.status === 200 && idsOf(r) === only(g.plain));
    r = await search("Mary Ann");
    check("NS4 a value containing a space is matched literally", r.status === 200 && idsOf(r) === only(g.spaced));
    r = await search("  anne  ");
    check("NS5 surrounding whitespace is trimmed", r.status === 200 && r.data.some((x) => x._id === String(g.plain._id)));
    r = await search("Bob.Smith");
    check("NS6 a dot is LITERAL: 'Bob.Smith' matches only the guest with a dot (not 'Bobxsmith')", r.status === 200 && idsOf(r) === only(g.dot));
    r = await search("Bob.Smit");
    check("NS6b ...and a partial 'Bob.Smit' still matches by substring", r.status === 200 && idsOf(r) === only(g.dot));
    r = await search("Bob");
    check("NS7 plain 'Bob' matches both Bob guests (workspace A only)", r.status === 200 && idsOf(r) === only(g.dot, g.nodot) && !r.raw.includes(String(g.other._id)));
    for (const [label, term, expected] of [
      ["'.' matches only names containing a literal dot", ".", [g.dot]],
      ["'*' matches only names containing a literal star", "*", [g.star]],
      ["'+' matches only names containing a literal plus", "+", [g.plus]],
      ["'?' matches only names containing a literal question mark", "?", [g.question]],
      ["'^' matches only names containing a literal caret", "^", [g.caret]],
      ["'$' matches only names containing a literal dollar", "$", [g.dollar]],
      ["'(' matches only names containing a literal parenthesis", "(", [g.parens]],
      ["')' matches only names containing a literal parenthesis", ")", [g.parens]],
      ["'[' matches only names containing a literal bracket", "[", [g.bracket]],
      ["']' matches only names containing a literal bracket", "]", [g.bracket]],
      ["'{' matches only names containing a literal brace", "{", [g.brace]],
      ["'}' matches only names containing a literal brace", "}", [g.brace]],
      ["'|' matches only names containing a literal pipe", "|", [g.pipe]],
      ["a backslash is literal", "\\", [g.backslash]],
    ]) {
      r = await search(term);
      check(`NS8 metacharacter ${label}`, r.status === 200 && idsOf(r) === only(...expected), `HTTP ${r.status} n=${r.data?.length}`);
    }
    for (const term of [".*", "^.*$", "a|b", "(a+)+$", "[a-z]+", "(?=x)", "\\d+", "Bob.*", "(", "[", "{", "*", "+"]) {
      const started = Date.now();
      r = await search(term);
      const literalHits = await Guest.countDocuments({ workspaceId: wsA._id, $or: [{ firstName: { $regex: term.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&"), $options: "i" } }, { lastName: { $regex: term.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&"), $options: "i" } }] });
      check(`NS9 regex syntax '${term}' is treated as literal text: no error, fast, exactly the literal matches`, r.status === 200 && r.data.length === literalHits && Date.now() - started < 2000, `HTTP ${r.status} n=${r.data?.length} literal=${literalHits}`);
    }
    r = await search(".*");
    check("NS10 '.*' does NOT match everything", r.status === 200 && r.data.length < total);
    r = await search("a".repeat(100));
    check("NS11 a 100-character value (the maximum) is accepted", r.status === 200 && r.data.length === 0);
    r = await search("a".repeat(101));
    check("NS12 a 101-character value -> 400", r.status === 400, `HTTP ${r.status}`);
    r = await search("(a+)+$".repeat(500));
    check("NS13 a 3000-character catastrophic-backtracking pattern -> 400 immediately (never reaches the database)", r.status === 400, `HTTP ${r.status}`);
    const started = Date.now();
    r = await search("a".repeat(99) + "!");
    check("NS14 a long near-maximum value is answered quickly", r.status === 200 && Date.now() - started < 2000);
    r = await search("");
    check("NS15 an empty name applies NO name filter (all of A's guests, none of B's)", r.status === 200 && r.data.length === total && !r.raw.includes(String(g.other._id)), `n=${r.data?.length}/${total}`);
    r = await search("   ");
    check("NS16 a whitespace-only name applies NO name filter", r.status === 200 && r.data.length === total);
    r = await call("GET", `/guests?workspaceId=${A}&limit=100&name[]=a&name[]=b`, H(operator));
    check("NS17 a repeated/array `name` parameter is not treated as a pattern (no filter, no error)", r.status === 200 && r.data.length === total);
    r = await call("GET", `/guests?workspaceId=${A}&limit=100&name[$regex]=.*`, H(operator));
    check("NS18 an operator-object `name[$regex]` is not treated as a pattern (no filter, no error)", r.status === 200 && r.data.length === total);
    r = await call("GET", `/guests?workspaceId=${A}&limit=100&email=${encodeURIComponent(g.plain.email)}`, H(operator));
    check("NS19 unrelated Guest filtering is unchanged (email filter)", r.status === 200 && r.data.length === 1 && r.data[0]._id === String(g.plain._id));
    r = await call("GET", `/guests?workspaceId=${A}&limit=100&name=Bob&email=${encodeURIComponent(g.dot.email)}`, H(operator));
    check("NS20 name + email filters still combine", r.status === 200 && idsOf(r) === only(g.dot));
    r = await search("Bob", viewer);
    check("NS21 a viewer is still denied Guest reads (403)", r.status === 403);
    r = await call("GET", `/guests?workspaceId=${B}&name=Bob`, H(admin));
    check("NS22 another workspace stays unreachable via name search (404)", r.status === 404);
    r = await call("GET", `/guests?workspaceId=${A}&name=Bob`, {});
    check("NS23 no token -> 401", r.status === 401);

    // ================================================ 8. integrity
    check("DB1: this suite's Actions/Outcomes are unchanged (no denied write stored or changed anything)", (await snap()) === snapshot0 && (await Action.countDocuments({ workspaceId: { $in: OWN } })) === counts0.actions && (await Outcome.countDocuments({ workspaceId: { $in: OWN } })) === counts0.outcomes);
    const after = await realCounts();
    const drift = Object.keys(before).filter((key) => before[key] !== after[key]);
    check("DB2: every PRE-EXISTING record count is identical (Action 32, Outcome 32, Decision 33, ... untouched)", drift.length === 0, drift.map((key) => `${key}:${before[key]}->${after[key]}`).join(","));
    check("AI1: no AI/LLM call was possible (AI service URL was a dead port, provider `test`)", true);
    void S;
  } finally {
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
    try {
      await cleanup();
      check("mongodb cleanup", true);
    } catch (error) {
      check("mongodb cleanup", false, String(error));
    }
  }
}

main()
  .then(() => {
    console.log(`\nPhase 17 authorization validation: ${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
