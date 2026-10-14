/**
 * Phase 16 validation: workspace, legacy Decision, Action / Outcome / Learning authorization.
 *
 *   GET  /workspaces            authenticated; ONLY the caller's active-membership workspaces
 *   GET  /workspaces/:id        authenticated; active member of :id (any role), else 404
 *   POST /workspaces            RETIRED (404)
 *   PATCH/DELETE /workspaces/:id  workspace:admin (unchanged)
 *   POST /decisions (legacy)    decision:propose (+ decision:review to set a non-default status)
 *   PATCH /decisions/:id        decision:review
 *   GET /actions, /outcomes     decision:review (reviewer, admin) + parent-Intelligence visibility
 *   GET /learning[/patterns]    workspace:admin (it ignores parent visibility)
 *
 * REAL HTTP against a REAL spawned backend (fallback knowledge level: restricted, the worst case), real stored
 * users/memberships/stub tokens. Throwaway workspaces only; real record counts compared before and after.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { signStubToken, STUB_ISSUER } from "../src/auth/stubTokenVerifier.js";
import * as Models from "../src/models/index.js";
import { Action, Decision, Intelligence, Outcome, User, Workspace, WorkspaceMembership } from "../src/models/index.js";
import { bearer, cleanupAuthFixtures, createActor } from "./lib/authFixtures.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, "..", "server.js");
const PORT = 5086;
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
  await Promise.all([Outcome.deleteMany({ workspaceId: ws }), Action.deleteMany({ workspaceId: ws }), Decision.deleteMany({ workspaceId: ws })]);
  await Promise.all([Intelligence.deleteMany({ workspaceId: ws }), WorkspaceMembership.deleteMany({ workspaceId: ws })]);
  await Workspace.deleteMany({ _id: ws });
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
    check("ephemeral server healthy (stub authentication; process fallback level: restricted)", true);
    await connectDatabase();
    await Promise.all([User.init(), WorkspaceMembership.init(), Intelligence.init()]);

    const mkWs = async (label, status = "active") => {
      const doc = await Workspace.create({ name: `P16 ${label} ${stamp}`, slug: `p16-${label}-${stamp}`, status });
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
      Users: await User.countDocuments({ subject: { $not: /^(p16|authfetch|v1suite|vis-|never)/ } }),
    });
    const before = await realCounts();

    // ------------------------------------------------ actors
    const actor = (role, ws = wsA, label = "p16") => createActor({ role, workspaceId: ws._id, label });
    const viewer = await actor("viewer");
    const operator = await actor("operator");
    const reviewer = await actor("reviewer");
    const admin = await actor("admin");
    const adminB = await actor("admin", wsB);
    const outsider = await createActor({ label: "p16-outsider" });
    const revoked = await actor("operator", wsA, "p16-revoked");
    await WorkspaceMembership.updateOne({ _id: revoked.membership._id }, { $set: { status: "revoked" } });
    const disabled = await actor("operator", wsA, "p16-disabled");
    await User.updateOne({ _id: disabled.user._id }, { $set: { status: "disabled" } });
    const suspendedAdmin = await createActor({ role: "admin", workspaceId: wsS._id, label: "p16-suspended" });
    const both = await createActor({ role: "viewer", workspaceId: wsA._id, label: "p16-both" });
    await WorkspaceMembership.create({ userId: both.user._id, workspaceId: wsB._id, role: "admin" });
    const unregistered = bearer(signStubToken({ iss: STUB_ISSUER, sub: `never-provisioned-${stamp}`, exp: Math.floor(Date.now() / 1000) + 600 }, process.env.AUTH_STUB_SECRET));
    const exp = () => Math.floor(Date.now() / 1000) + 600;
    const H = (who) => who.headers;
    const roles = { viewer, operator, reviewer, admin };
    const forgedHeaders = { "x-role": "admin", "x-user-role": "admin", "x-permission": "workspace:admin", "x-permissions": "workspace:admin", "x-knowledge-level": "restricted", "x-workspace-id": B, cookie: "role=admin; permission=workspace:admin" };
    const forgedQuery = `role=admin&permission=workspace:admin&permissions=workspace:admin&authorizedLevel=restricted&knowledgeLevel=restricted`;
    const bodyForge = { role: "admin", permission: "workspace:admin", permissions: ["workspace:admin"], knowledgeLevel: "restricted", authorizedLevel: "restricted" };

    // ================================================ 1. authentication: every changed read route
    const readRoutes = [
      ["workspace list", `/workspaces`],
      ["workspace detail", `/workspaces/${A}`],
      ["legacy decision POST", null],
      ["actions list", `/actions?workspaceId=${A}`],
      ["outcomes list", `/outcomes?workspaceId=${A}`],
      ["learning report", `/learning?workspaceId=${A}`],
      ["learning patterns", `/learning/patterns?workspaceId=${A}`],
    ];
    for (const [label, url] of readRoutes) {
      if (!url) continue;
      let r = await call("GET", url);
      check(`AU1 ${label}: no token -> 401`, r.status === 401 && r.code === "MISSING_CREDENTIAL", `HTTP ${r.status}`);
      for (const [name, headers] of [["invalid", bearer("not.a.token")], ["malformed", { authorization: "Basic abc" }], ["expired", bearer(signStubToken({ iss: STUB_ISSUER, sub: admin.user.subject, exp: Math.floor(Date.now() / 1000) - 30 }, process.env.AUTH_STUB_SECRET))], ["wrong signature", bearer(signStubToken({ iss: STUB_ISSUER, sub: admin.user.subject, exp: exp() }, "a-different-secret-not-real-0123456789"))]]) {
        r = await call("GET", url, headers);
        check(`AU2 ${label}: ${name} credential -> 401`, r.status === 401, `HTTP ${r.status}`);
      }
      r = await call("GET", url, unregistered);
      check(`AU3 ${label}: valid token, unregistered identity -> 403`, r.status === 403 && r.code === "IDENTITY_NOT_REGISTERED", `HTTP ${r.status}`);
      r = await call("GET", url, H(disabled));
      check(`AU4 ${label}: disabled user -> 403`, r.status === 403, `HTTP ${r.status}`);
    }
    let r = await call("POST", "/decisions", {}, { workspaceId: A, intelligenceId: A, description: "x" });
    check("AU1 legacy decision POST: no token -> 401", r.status === 401);
    r = await call("PATCH", `/decisions/${A}?workspaceId=${A}`, {}, { status: "approved" });
    check("AU1 legacy decision PATCH: no token -> 401", r.status === 401);
    for (const [name, headers] of [["invalid", bearer("not.a.token")], ["malformed", { authorization: "Basic abc" }], ["unregistered", unregistered]]) {
      r = await call("POST", "/decisions", headers, { workspaceId: A, intelligenceId: A, description: "x" });
      check(`AU2 legacy decision POST: ${name} credential -> ${name === "unregistered" ? 403 : 401}`, r.status === (name === "unregistered" ? 403 : 401), `HTTP ${r.status}`);
      r = await call("PATCH", `/decisions/${A}?workspaceId=${A}`, headers, { status: "approved" });
      check(`AU2 legacy decision PATCH: ${name} credential -> ${name === "unregistered" ? 403 : 401}`, r.status === (name === "unregistered" ? 403 : 401), `HTTP ${r.status}`);
    }
    check("AU5: nothing was auto-provisioned for the unregistered identity", (await User.countDocuments({ subject: `never-provisioned-${stamp}` })) === 0);

    // ================================================ 2. workspaces
    // detail: any active member, any role
    for (const [role, who] of Object.entries(roles)) {
      r = await call("GET", `/workspaces/${A}`, H(who));
      check(`WS1 ${role}: workspace detail of own workspace -> 200`, r.status === 200 && r.data._id === A, `HTTP ${r.status}`);
      check(`WS1 ${role}: detail carries no membership/role/permission internals`, !/"(role|roles|permissions?|membership|userId|issuer|subject|token)"/i.test(r.raw));
      r = await call("GET", `/workspaces`, H(who));
      check(`WS2 ${role}: list -> 200 with ONLY workspace A`, r.status === 200 && r.data.length === 1 && r.data[0]._id === A && r.json.pagination.total === 1, `n=${r.data?.length}`);
      r = await call("GET", `/workspaces/${B}`, H(who));
      check(`WS3 ${role}: another workspace's detail -> 404`, r.status === 404);
    }
    r = await call("GET", `/workspaces/${A}`, H(adminB));
    check("WS4: another workspace's admin reading THIS workspace -> 404", r.status === 404);
    r = await call("GET", `/workspaces`, H(adminB));
    check("WS4: ...and its list holds only its own workspace", r.data.length === 1 && r.data[0]._id === B);
    r = await call("GET", `/workspaces`, H(both));
    check("WS5: a member of two workspaces lists exactly those two", r.status === 200 && r.data.map((w) => w._id).sort().join() === [A, B].sort().join(), `n=${r.data?.length}`);
    r = await call("GET", `/workspaces`, H(outsider));
    check("WS6: a user with no membership lists nothing (200, empty) and never enumerates workspaces", r.status === 200 && r.data.length === 0 && r.json.pagination.total === 0);
    r = await call("GET", `/workspaces`, H(revoked));
    check("WS7: a revoked membership contributes nothing", r.status === 200 && r.data.length === 0);
    r = await call("GET", `/workspaces`, H(suspendedAdmin));
    check("WS8: a suspended workspace is not listed", r.status === 200 && r.data.length === 0);
    for (const [label, who] of [["outsider", outsider], ["revoked", revoked], ["suspended-workspace admin", suspendedAdmin]]) {
      r = await call("GET", `/workspaces/${label === "suspended-workspace admin" ? S : A}`, H(who));
      check(`WS9 ${label}: detail -> 404 (no workspace data)`, r.status === 404 && !r.raw.includes(`P16 `));
    }
    r = await call("GET", `/workspaces/not-an-id`, H(admin));
    check("WS10: an invalid id -> 400", r.status === 400);
    // forged: nothing widens or elevates
    r = await call("GET", `/workspaces?${forgedQuery}&workspaceId=${B}&slug=p16-b-${stamp}&status=suspended`, { ...H(viewer), ...forgedHeaders });
    check("WS11: forged headers/query/workspaceId on the list never reveal another workspace", r.status === 200 && r.data.every((w) => w._id === A) && !r.raw.includes(B), `n=${r.data?.length}`);
    r = await call("GET", `/workspaces?slug=p16-b-${stamp}`, H(viewer));
    check("WS12: a slug filter cannot find another workspace", r.status === 200 && r.data.length === 0);
    r = await call("GET", `/workspaces/${B}?${forgedQuery}&workspaceId=${A}`, { ...H(viewer), ...forgedHeaders });
    check("WS13: forged headers/query cannot open another workspace's detail (404)", r.status === 404);
    const forgedTok = bearer(signStubToken({ iss: STUB_ISSUER, sub: viewer.user.subject, email: viewer.user.email, exp: exp(), role: "admin", permissions: ["workspace:admin"], workspaceId: B, workspaces: [A, B] }, process.env.AUTH_STUB_SECRET));
    r = await call("GET", `/workspaces`, forgedTok);
    check("WS14: a token CLAIMING workspaces/roles does not widen the list", r.status === 200 && r.data.length === 1 && r.data[0]._id === A);
    // create is retired
    const wsCount = await Workspace.countDocuments({});
    for (const [label, headers] of [["no token", {}], ["viewer", H(viewer)], ["admin", H(admin)], ["admin + forged", { ...H(admin), ...forgedHeaders }]]) {
      r = await call("POST", "/workspaces", headers, { name: `P16 created ${stamp}`, slug: `p16-created-${stamp}`, ...bodyForge });
      check(`WS15 POST /workspaces (${label}) -> 404: the route no longer exists`, r.status === 404, `HTTP ${r.status}`);
    }
    check("WS15: no workspace was created", (await Workspace.countDocuments({})) === wsCount && !(await Workspace.exists({ slug: `p16-created-${stamp}` })));
    // admin routes unchanged
    for (const role of ["viewer", "operator", "reviewer"]) {
      r = await call("PATCH", `/workspaces/${A}`, H(roles[role]), { name: "hijack" });
      check(`WS16 ${role}: PATCH workspace -> 403`, r.status === 403);
      r = await call("DELETE", `/workspaces/${A}`, H(roles[role]));
      check(`WS16 ${role}: DELETE workspace -> 403`, r.status === 403);
    }
    r = await call("PATCH", `/workspaces/${B}?workspaceId=${A}`, { ...H(admin), ...forgedHeaders }, { name: "hijack B", ...bodyForge });
    check("WS17: A's admin (forged) cannot PATCH workspace B -> 404", r.status === 404 && (await Workspace.findById(B).lean()).name === `P16 b ${stamp}`);
    r = await call("DELETE", `/workspaces/${B}?workspaceId=${A}`, { ...H(admin), ...forgedHeaders });
    check("WS17: A's admin (forged) cannot DELETE workspace B -> 404", r.status === 404 && Boolean(await Workspace.exists({ _id: B })));
    r = await call("PATCH", `/workspaces/${A}`, H(admin), { name: `P16 a ${stamp}` });
    check("WS18: an admin can still PATCH its own workspace (unchanged behaviour)", r.status === 200);
    // method swapping
    for (const [method, url] of [["PUT", `/workspaces`], ["PATCH", `/workspaces`], ["DELETE", `/workspaces`], ["PUT", `/workspaces/${A}`], ["POST", `/workspaces/${A}`]]) {
      r = await call(method, url, H(admin), { name: "swap" });
      check(`MS ${method} ${url.replace(A, ":id")} -> 404 (no such route)`, r.status === 404, `HTTP ${r.status}`);
    }
    check("MS: the workspace is unchanged by swapped methods", (await Workspace.findById(A).lean()).name === `P16 a ${stamp}`);

    // ================================================ 3. Intelligence / Decision / Action / Outcome fixtures
    const mkIntel = (ws, level, extra = {}) => Intelligence.create({ workspaceId: ws._id, signalIds: [], generatedBy: "llm", ...(level ? { analysisVersion: "intelligence-v1", analysisLevel: level, knowledgeVisibility: level === "guest" ? undefined : level, analysis: { situation: "s", evidence: ["e"], impact: "i", recommendation: "r", confidence: "low" } } : {}), ...extra });
    const iGuest = await mkIntel(wsA, "guest");
    const iStaff = await mkIntel(wsA, "staff");
    const iRestricted = await mkIntel(wsA, "restricted");
    const iLegacy = await mkIntel(wsA, null);
    const iB = await mkIntel(wsB, "guest");
    const orphanIntelId = "6aa29b8d18df3e22b3e89caa";
    const mkAction = (ws, intel, description) => Action.create({ workspaceId: ws._id, intelligenceId: intel, description });
    const mkOutcome = (ws, intel, summary) => Outcome.create({ workspaceId: ws._id, intelligenceId: intel, result: { summary } });
    const aGuest = await mkAction(wsA, iGuest._id, "P16 ACTION guest");
    const aStaff = await mkAction(wsA, iStaff._id, "P16 ACTION staff");
    const aRestricted = await mkAction(wsA, iRestricted._id, "P16 ACTION restricted");
    const aLegacy = await mkAction(wsA, iLegacy._id, "P16 ACTION legacy");
    const aOrphan = await mkAction(wsA, orphanIntelId, "P16 ACTION orphan");
    const aB = await mkAction(wsB, iB._id, "P16 ACTION other workspace");
    const oGuest = await mkOutcome(wsA, iGuest._id, "P16 OUTCOME guest");
    const oStaff = await mkOutcome(wsA, iStaff._id, "P16 OUTCOME staff");
    const oRestricted = await mkOutcome(wsA, iRestricted._id, "P16 OUTCOME restricted");
    const oLegacy = await mkOutcome(wsA, iLegacy._id, "P16 OUTCOME legacy");
    const oOrphan = await mkOutcome(wsA, orphanIntelId, "P16 OUTCOME orphan");
    const oB = await mkOutcome(wsB, iB._id, "P16 OUTCOME other workspace");
    const legacyDecision = await Decision.create({ workspaceId: wsA._id, intelligenceId: iLegacy._id, description: "P16 legacy decision" });
    const legacyDecisionB = await Decision.create({ workspaceId: wsB._id, intelligenceId: iB._id, description: "P16 legacy decision B" });
    const v1Decision = await Decision.create({ workspaceId: wsA._id, intelligenceId: iGuest._id, description: "P16 v1 decision", decisionVersion: "decision-v1", status: "proposed", analysisVersion: "intelligence-v1" });

    // ================================================ 4. Action / Outcome reads: role matrix + parent visibility
    const seen = {
      reviewer: { actions: [aGuest, aStaff, aLegacy], hiddenA: [aRestricted, aOrphan], outcomes: [oGuest, oStaff, oLegacy], hiddenO: [oRestricted, oOrphan] },
      admin: { actions: [aGuest, aStaff, aRestricted, aLegacy], hiddenA: [aOrphan], outcomes: [oGuest, oStaff, oRestricted, oLegacy], hiddenO: [oOrphan] },
    };
    for (const [role, who] of Object.entries(roles)) {
      const allowed = role === "reviewer" || role === "admin";
      for (const [kind, path_, docs, hidden] of [["action", "/actions", "actions", "hiddenA"], ["outcome", "/outcomes", "outcomes", "hiddenO"]]) {
        const l = await call("GET", `${path_}?workspaceId=${A}&limit=100`, H(who));
        check(`AO1 ${role}: ${kind} list -> ${allowed ? 200 : 403}`, l.status === (allowed ? 200 : 403), `HTTP ${l.status}`);
        if (!allowed) {
          check(`AO1 ${role}: the ${kind} denial leaks no record text`, !/P16 (ACTION|OUTCOME)/.test(l.raw));
          const d = await call("GET", `${path_}/${(kind === "action" ? aGuest : oGuest)._id}?workspaceId=${A}`, H(who));
          check(`AO1 ${role}: ${kind} detail -> 403`, d.status === 403 && !/P16 (ACTION|OUTCOME)/.test(d.raw));
          continue;
        }
        const ids_ = l.data.map((x) => x._id);
        check(`AO2 ${role}: ${kind} list holds exactly the records whose parent Intelligence is visible`, seen[role][docs].every((x) => ids_.includes(String(x._id))) && seen[role][hidden].every((x) => !ids_.includes(String(x._id))) && ids_.length === seen[role][docs].length, `n=${ids_.length}`);
        check(`AO3 ${role}: ${kind} pagination total respects the ceiling`, l.json.pagination.total === seen[role][docs].length, JSON.stringify(l.json.pagination));
        check(`AO4 ${role}: never another workspace's ${kind}`, !l.raw.includes("other workspace"));
        for (const x of seen[role][docs]) {
          const d = await call("GET", `${path_}/${x._id}?workspaceId=${A}`, H(who));
          check(`AO5 ${role}: ${kind} ${x.description ?? x.result?.summary} detail -> 200`, d.status === 200, `HTTP ${d.status}`);
        }
        for (const x of seen[role][hidden]) {
          const d = await call("GET", `${path_}/${x._id}?workspaceId=${A}`, H(who));
          check(`AO6 ${role}: ${kind} with a hidden/missing parent -> 404`, d.status === 404 && !/P16 (ACTION|OUTCOME)/.test(d.raw), `HTTP ${d.status}`);
        }
        const other = (kind === "action" ? aB : oB)._id;
        check(`AO7 ${role}: another workspace's ${kind}: 404 via A, 404 via B`, (await call("GET", `${path_}/${other}?workspaceId=${A}`, H(who))).status === 404 && (await call("GET", `${path_}/${other}?workspaceId=${B}`, H(who))).status === 404 && (await call("GET", `${path_}?workspaceId=${B}`, H(who))).status === 404);
        const byIntel = await call("GET", `${path_}?workspaceId=${A}&${kind === "action" ? "intelligenceId" : "intelligenceId"}=${iRestricted._id}`, H(who));
        check(`AO8 ${role}: filtering by a hidden parent Intelligence yields ${role === "admin" ? "its record" : "nothing"}`, byIntel.status === 200 && byIntel.data.length === (role === "admin" ? 1 : 0), `n=${byIntel.data?.length}`);
      }
    }
    // forged elevation
    for (const [kind, path_, hiddenDoc] of [["action", "/actions", aRestricted], ["outcome", "/outcomes", oRestricted]]) {
      for (const role of ["viewer", "operator"]) {
        let x = await call("GET", `${path_}?workspaceId=${A}&${forgedQuery}`, { ...H(roles[role]), ...forgedHeaders });
        check(`FG ${role}: ${kind} list with forged admin headers/query -> 403`, x.status === 403);
        x = await call("GET", `${path_}/${hiddenDoc._id}?workspaceId=${A}&${forgedQuery}`, { ...H(roles[role]), ...forgedHeaders });
        check(`FG ${role}: ${kind} detail with forged admin headers/query -> 403`, x.status === 403);
      }
      let x = await call("GET", `${path_}/${hiddenDoc._id}?workspaceId=${A}&${forgedQuery}`, { ...H(reviewer), ...forgedHeaders });
      check(`FG reviewer: forged restricted level cannot reveal a restricted-parent ${kind} (404)`, x.status === 404);
      x = await call("GET", `${path_}?workspaceId=${A}&limit=100&${forgedQuery}`, { ...H(reviewer), ...forgedHeaders });
      check(`FG reviewer: forged level does not add the restricted-parent ${kind} to the list`, x.status === 200 && !x.data.some((d) => d._id === String(hiddenDoc._id)));
      x = await call("GET", `${path_}?workspaceId=${B}&${forgedQuery}`, { ...H(admin), ...forgedHeaders });
      check(`FG admin of A naming workspace B (forged): ${kind} list -> 404`, x.status === 404);
      const tok = bearer(signStubToken({ iss: STUB_ISSUER, sub: operator.user.subject, email: operator.user.email, exp: exp(), role: "admin", permissions: ["decision:review", "workspace:admin"], knowledgeLevel: "restricted", workspaceId: B }, process.env.AUTH_STUB_SECRET));
      x = await call("GET", `${path_}?workspaceId=${A}`, tok);
      check(`FG a token CLAIMING role/permissions does not let an operator read ${kind}s (403)`, x.status === 403);
    }

    // ================================================ 5. Learning: admin-only
    for (const [label, url] of [["report", `/learning?workspaceId=${A}`], ["patterns", `/learning/patterns?workspaceId=${A}`]]) {
      for (const [role, who] of Object.entries(roles)) {
        r = await call("GET", url, H(who));
        check(`LR1 ${role}: learning ${label} -> ${role === "admin" ? 200 : 403}`, r.status === (role === "admin" ? 200 : 403), `HTTP ${r.status}`);
        if (role !== "admin") check(`LR1 ${role}: the denial carries no Action/Outcome/Decision text`, !/P16 (ACTION|OUTCOME|legacy|v1)/i.test(r.raw));
      }
      r = await call("GET", url.replace(`workspaceId=${A}`, `workspaceId=${B}`), H(admin));
      check(`LR2 learning ${label}: A's admin naming workspace B -> 404`, r.status === 404);
      r = await call("GET", url + `&${forgedQuery}`, { ...H(reviewer), ...forgedHeaders });
      check(`LR3 learning ${label}: a reviewer with forged admin headers/query -> 403`, r.status === 403);
      r = await call("GET", url.replace(`workspaceId=${A}`, `workspaceId=${B}`), H(adminB));
      check(`LR4 learning ${label}: B's admin sees only B (200)`, r.status === 200 && !r.raw.includes("P16 ACTION guest") && !r.raw.includes("P16 legacy decision\""));
    }
    r = await call("GET", `/learning?workspaceId=${A}`, H(admin));
    check("LR5 the admin's report is scoped to workspace A (B's records absent)", r.status === 200 && !r.raw.includes("other workspace") && !r.raw.includes("P16 legacy decision B"));
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      r = await call(method, `/learning?workspaceId=${A}`, H(admin), {});
      check(`MS ${method} /learning -> 404 (read-only report)`, r.status === 404, `HTTP ${r.status}`);
    }
    for (const method of ["PUT", "DELETE"]) {
      r = await call(method, `/actions/${aGuest._id}?workspaceId=${A}`, H(admin), {});
      check(`MS ${method} /actions/:id -> 404`, r.status === 404, `HTTP ${r.status}`);
      r = await call(method, `/outcomes/${oGuest._id}?workspaceId=${A}`, H(admin), {});
      check(`MS ${method} /outcomes/:id -> 404`, r.status === 404, `HTTP ${r.status}`);
    }

    // ================================================ 6. legacy Decision routes
    const dBefore = await Decision.countDocuments({ workspaceId: { $in: OWN } });
    const legacyBody = (extra = {}) => ({ workspaceId: A, intelligenceId: String(iLegacy._id), description: `P16 created ${Math.random().toString(36).slice(2)}`, ...extra });
    // POST: decision:propose (operator, reviewer, admin)
    for (const [role, who] of Object.entries(roles)) {
      const mayPropose = role !== "viewer";
      const mk = await call("POST", "/decisions", H(who), legacyBody());
      check(`LD1 ${role}: legacy POST -> ${mayPropose ? 201 : 403}`, mk.status === (mayPropose ? 201 : 403), `HTTP ${mk.status} ${mk.json?.message ?? ""}`);
      // setting a status other than the default needs decision:review as well
      const mayReview = role === "reviewer" || role === "admin";
      const st = await call("POST", "/decisions", H(who), legacyBody({ status: "approved" }));
      check(`LD2 ${role}: legacy POST with status "approved" -> ${mayReview ? 201 : 403}`, st.status === (mayReview ? 201 : 403), `HTTP ${st.status}`);
      const dflt = await call("POST", "/decisions", H(who), legacyBody({ status: "proposed" }));
      check(`LD2 ${role}: legacy POST with the default status "proposed" -> ${mayPropose ? 201 : 403}`, dflt.status === (mayPropose ? 201 : 403), `HTTP ${dflt.status}`);
      // PATCH: decision:review
      const upd = await call("PATCH", `/decisions/${legacyDecision._id}?workspaceId=${A}`, H(who), { description: `P16 legacy decision ${role}` });
      check(`LD3 ${role}: legacy PATCH -> ${mayReview ? 200 : 403}`, upd.status === (mayReview ? 200 : 403), `HTTP ${upd.status}`);
    }
    check("LD4: a denied legacy POST/PATCH stored nothing (operator could not mint an approved record)", (await Decision.countDocuments({ workspaceId: wsA._id, description: /^P16 created/, status: "approved" })) === 2);
    // Decision V1 cannot be mutated through the legacy routes, by ANY role
    const v1Snapshot = JSON.stringify(await Decision.findById(v1Decision._id).lean());
    for (const [role, who] of Object.entries(roles)) {
      for (const body of [{ status: "approved" }, { description: "rewritten" }, { intelligenceId: String(iLegacy._id) }, { decisionVersion: "decision-v1" }, { status: "completed" }]) {
        r = await call("PATCH", `/decisions/${v1Decision._id}?workspaceId=${A}`, H(who), body);
        check(`LV1 ${role}: legacy PATCH ${Object.keys(body)[0]} on a Decision V1 refused (${role === "reviewer" || role === "admin" ? "409/400" : "403"})`, role === "reviewer" || role === "admin" ? [409, 400].includes(r.status) : r.status === 403, `HTTP ${r.status}`);
      }
      r = await call("POST", "/decisions", H(who), { workspaceId: A, intelligenceId: String(iGuest._id), description: "bypass", status: "approved", decisionVersion: "decision-v1" });
      check(`LV2 ${role}: legacy POST on an Intelligence V1 / marking decision-v1 refused`, [400, 403, 409].includes(r.status) && r.status !== 201, `HTTP ${r.status}`);
    }
    check("LV3: the Decision V1 record is byte-for-byte unchanged", JSON.stringify(await Decision.findById(v1Decision._id).lean()) === v1Snapshot);
    // cross-workspace
    for (const [label, who] of [["A's admin", admin], ["B's admin", adminB]]) {
      const targetWs = label === "A's admin" ? B : A;
      const targetDecision = label === "A's admin" ? legacyDecisionB : legacyDecision;
      r = await call("PATCH", `/decisions/${targetDecision._id}?workspaceId=${targetWs}`, H(who), { description: "hijack" });
      check(`LX ${label}: legacy PATCH naming the OTHER workspace -> 404`, r.status === 404);
      r = await call("PATCH", `/decisions/${targetDecision._id}?workspaceId=${targetWs === A ? B : A}`, H(who), { description: "hijack" });
      check(`LX ${label}: legacy PATCH of the other workspace's Decision under OWN workspace -> 404`, r.status === 404);
      r = await call("POST", "/decisions", H(who), { workspaceId: targetWs, intelligenceId: String(label === "A's admin" ? iB._id : iLegacy._id), description: "hijack" });
      check(`LX ${label}: legacy POST into the OTHER workspace -> 404`, r.status === 404);
    }
    r = await call("POST", "/decisions", H(admin), { workspaceId: A, intelligenceId: String(iB._id), description: "cross intelligence" });
    check("LX: legacy POST with another workspace's Intelligence is refused (never stored)", r.status >= 400 && r.status < 500 && r.status !== 401 && r.status !== 403, `HTTP ${r.status}`);
    check("LX: workspace B's Decisions are unchanged", (await Decision.findById(legacyDecisionB._id).lean()).description === "P16 legacy decision B" && (await Decision.countDocuments({ workspaceId: wsB._id })) === 1);
    // forged
    for (const role of ["viewer", "operator"]) {
      r = await call("PATCH", `/decisions/${legacyDecision._id}?workspaceId=${A}&${forgedQuery}`, { ...H(roles[role]), ...forgedHeaders }, { description: "forged", ...bodyForge });
      check(`LF ${role}: legacy PATCH with forged admin headers/query/body -> 403`, r.status === 403, `HTTP ${r.status}`);
    }
    r = await call("POST", `/decisions?${forgedQuery}&workspaceId=${B}`, { ...H(viewer), ...forgedHeaders }, legacyBody(bodyForge));
    check("LF viewer: legacy POST with forged admin headers/query/body -> 403", r.status === 403);
    r = await call("POST", `/decisions?${forgedQuery}`, { ...H(operator), ...forgedHeaders }, legacyBody({ ...bodyForge, status: "approved" }));
    check("LF operator: forged admin headers/body cannot set an approved status (403)", r.status === 403);
    r = await call("POST", `/decisions?workspaceId=${A}`, H(operator), { ...legacyBody(), workspaceId: B });
    check("LF operator: query workspace A + body workspace B -> the body selector decides and B is not a member (404)", r.status === 404);
    const forgedTok2 = bearer(signStubToken({ iss: STUB_ISSUER, sub: operator.user.subject, email: operator.user.email, exp: exp(), role: "admin", permissions: ["decision:review"], workspaceId: B }, process.env.AUTH_STUB_SECRET));
    r = await call("PATCH", `/decisions/${legacyDecision._id}?workspaceId=${A}`, forgedTok2, { description: "claims" });
    check("LF a token CLAIMING role/permissions does not let an operator PATCH (403)", r.status === 403);
    // method swapping
    for (const [method, url] of [["PUT", `/decisions/${legacyDecision._id}?workspaceId=${A}`], ["DELETE", `/decisions/${legacyDecision._id}?workspaceId=${A}`], ["PATCH", `/decisions?workspaceId=${A}`], ["PUT", `/decisions?workspaceId=${A}`], ["DELETE", `/decisions?workspaceId=${A}`], ["POST", `/decisions/${legacyDecision._id}?workspaceId=${A}`]]) {
      r = await call(method, url, H(admin), { description: "swap", status: "approved" });
      check(`MS ${method} ${url.split("?")[0].replace(String(legacyDecision._id), ":id")} -> 404`, r.status === 404, `HTTP ${r.status}`);
    }
    r = await call("GET", `/decisions/${legacyDecision._id}?workspaceId=${A}`, H(viewer));
    check("MS: a GET still works for a viewer and the swapped methods changed nothing", r.status === 200 && r.data.status === "proposed");
    check("LD5: the missing-workspace legacy calls are refused cleanly (400)", (await call("PATCH", `/decisions/${legacyDecision._id}`, H(admin), { description: "x" })).status === 400 && (await call("POST", "/decisions", H(admin), { intelligenceId: String(iLegacy._id), description: "x" })).status === 400);
    void dBefore;

    // ================================================ 7. Action / Outcome writes: closed in Phase 17 (detailed in validate-phase17-authorization)
    r = await call("POST", "/actions", {}, { workspaceId: A, intelligenceId: String(iLegacy._id), description: "P16 write probe" });
    check("Action POST without a token -> 401 (Phase 17)", r.status === 401, `HTTP ${r.status}`);
    r = await call("POST", "/actions", H(admin), { workspaceId: A, intelligenceId: String(iLegacy._id), description: "P16 write probe" });
    check("Action POST by an admin -> 403 (no role holds action:execute; Phase 17)", r.status === 403, `HTTP ${r.status}`);

    // ================================================ 8. integrity
    const after = await realCounts();
    const drift = Object.keys(before).filter((k) => before[k] !== after[k]);
    check("DB1: every PRE-EXISTING record count is identical (Users excludes this suite's test users)", drift.length === 0, drift.map((k) => `${k}:${before[k]}->${after[k]}`).join(","));
    check("DB2: the three seeded workspaces still exist (only PATCHed by an authorized admin)", (await Workspace.countDocuments({ _id: { $in: OWN } })) === 3);
    check("DB3: the seeded Actions, Outcomes and Intelligence are unchanged", (await Action.countDocuments({ workspaceId: { $in: OWN } })) === 6 && (await Outcome.countDocuments({ workspaceId: { $in: OWN } })) === 6 && (await Intelligence.countDocuments({ workspaceId: { $in: OWN } })) === 5);
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
    console.log(`\nPhase 16 authorization validation: ${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
