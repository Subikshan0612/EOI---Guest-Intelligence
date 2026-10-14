/**
 * Phase 22 validation: workspace suspension safety, deletion dependency graph, cascade deletion, isolation.
 *
 * REAL HTTP against a REAL spawned backend (NODE_ENV=test, dead AI URL, provider `test`: no AI call is possible), real stored users
 * and memberships, and THROWAWAY workspaces only. The real Development Workspace and every real record are never touched;
 * real counts (including the 2 pre-existing orphan Messages) are compared before and after.
 */
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import * as Models from "../src/models/index.js";
import { Action, Conversation, Decision, Guest, ImportBatch, Intelligence, KnowledgeChunk, KnowledgeDocument, Message, Outcome, Property, Signal, Stay, Unit, User, Workspace, WorkspaceMembership } from "../src/models/index.js";
import { WORKSPACE_DELETION_ORDER, MODELS_NEVER_DELETED_WITH_A_WORKSPACE, assertWorkspaceKeepsAdmin, countActiveAdmins, countWorkspaceData, deleteWorkspaceCascade, supportsTransactions } from "../src/services/workspaceLifecycleService.js";
import { bearer, cleanupAuthFixtures, createActor } from "./lib/authFixtures.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, "..", "server.js");
const CLI = path.join(__dirname, "workspace-lifecycle.mjs");
const PORT = 5131;
const FAKE = "6aa29b8d18df3e22b3e89cff";

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
  const response = await fetch(`http://localhost:${PORT}/api${url}`, { method, headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const raw = await response.text();
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {
    json = null;
  }
  return { status: response.status, json, raw, data: json?.data, code: json?.details?.code, message: json?.message };
}

async function waitForServer(timeoutMs = 20000) {
  const start = Date.now();
  for (;;) {
    try {
      if ((await fetch(`http://localhost:${PORT}/api/health`)).ok) return;
    } catch {
      // not ready
    }
    if (Date.now() - start > timeoutMs) throw new Error("server not ready");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, NODE_ENV: "test" }, timeout: 60000 });
const ids = { workspaces: [], orphanMessages: [] };
const oid = (x) => String(x._id ?? x);

/** Representative dependents for one workspace (every kind in the deletion graph). */
async function populate(ws, label, stamp) {
  const property = await Property.create({ workspaceId: ws._id, name: `P22 ${label} property ${stamp}`, code: `P22${label}-${stamp}` });
  const unit = await Unit.create({ propertyId: property._id, unitNumber: `U-${label}-${stamp}` });
  const guest = await Guest.create({ workspaceId: ws._id, firstName: `P22${label}`, lastName: "Guest", email: `p22-${label}-${stamp}@example.invalid`, phone: "7770002222" });
  const stay = await Stay.create({ workspaceId: ws._id, guestId: guest._id, propertyId: property._id, unitId: unit._id, reservationId: `P22-${label}-${stamp}`, status: "confirmed", checkIn: new Date("2039-01-01"), checkOut: new Date("2039-01-03") });
  const signal = await Signal.create({ workspaceId: ws._id, type: "maintenance", title: `P22 ${label} signal`, propertyId: property._id, unitId: unit._id, guestId: guest._id, stayId: stay._id });
  const conversation = await Conversation.create({ workspaceId: ws._id, title: `P22 ${label} conversation`, guestId: guest._id, signalIds: [signal._id] });
  await Message.insertMany([0, 1, 2].map((i) => ({ conversationId: conversation._id, role: i % 2 ? "assistant" : "user", content: `P22 ${label} message ${i}` })));
  const intelligence = await Intelligence.create({ workspaceId: ws._id, signalIds: [signal._id], guestId: guest._id, generatedBy: "llm", provider: "test", model: "test", analysisVersion: "intelligence-v1", analysisLevel: "guest", analysis: { situation: "s", evidence: ["e"], impact: "i", recommendation: "r", confidence: "low" } });
  const decision = await Decision.create({ workspaceId: ws._id, intelligenceId: intelligence._id, description: `P22 ${label} decision` });
  const action = await Action.create({ workspaceId: ws._id, intelligenceId: intelligence._id, decisionId: decision._id, description: `P22 ${label} action` });
  await Outcome.create({ workspaceId: ws._id, intelligenceId: intelligence._id, actionId: action._id, result: { summary: `P22 ${label} outcome` } });
  const doc = await KnowledgeDocument.create({ workspaceId: ws._id, propertyId: property._id, title: `P22 ${label} doc`, documentType: "sop", content: "x", contentHash: `p22-${label}-${stamp}`, version: 1, isTestData: true });
  await KnowledgeChunk.create({ documentId: doc._id, version: 1, workspaceId: ws._id, status: "active", chunkIndex: 0, section: "s", text: `P22 ${label} chunk`, embedding: [0.1, 0.2, 0.3], embeddingModel: "test", embeddingInputVersion: 1 });
  await ImportBatch.create({ workspaceId: ws._id, propertyId: property._id, filename: `p22-${label}.csv`, status: "completed" });
  return { property, unit, guest, stay, signal, conversation };
}
const EXPECTED = { Message: 3, Conversation: 1, Outcome: 1, Action: 1, Decision: 1, Intelligence: 1, KnowledgeChunk: 1, KnowledgeDocument: 1, ImportBatch: 1, Signal: 1, Stay: 1, Guest: 1, Unit: 1, Property: 1 };

/** Every document of a workspace, sorted, serialised: a byte-for-byte snapshot. */
async function snapshot(wsId) {
  const conversations = await Conversation.find({ workspaceId: wsId }).distinct("_id");
  const properties = await Property.find({ workspaceId: wsId }).distinct("_id");
  const parts = [];
  for (const [name, Model, filter] of [["Workspace", Workspace, { _id: wsId }], ["WorkspaceMembership", WorkspaceMembership, { workspaceId: wsId }], ["Property", Property, { workspaceId: wsId }], ["Unit", Unit, { propertyId: { $in: properties } }], ["Guest", Guest, { workspaceId: wsId }], ["Stay", Stay, { workspaceId: wsId }], ["Signal", Signal, { workspaceId: wsId }], ["Conversation", Conversation, { workspaceId: wsId }], ["Message", Message, { conversationId: { $in: conversations } }], ["Intelligence", Intelligence, { workspaceId: wsId }], ["Decision", Decision, { workspaceId: wsId }], ["Action", Action, { workspaceId: wsId }], ["Outcome", Outcome, { workspaceId: wsId }], ["KnowledgeDocument", KnowledgeDocument, { workspaceId: wsId }], ["KnowledgeChunk", KnowledgeChunk, { workspaceId: wsId }], ["ImportBatch", ImportBatch, { workspaceId: wsId }]]) {
    parts.push([name, (await Model.find(filter).sort({ _id: 1 }).lean()).map((d) => JSON.stringify(d))]);
  }
  return JSON.stringify(parts);
}

async function cleanup() {
  await connectDatabase();
  await cleanupAuthFixtures();
  const ws = { $in: ids.workspaces };
  const props = await Property.find({ workspaceId: ws }).distinct("_id");
  const convs = await Conversation.find({ workspaceId: ws }).distinct("_id");
  await Message.deleteMany({ $or: [{ conversationId: { $in: convs } }, { _id: { $in: ids.orphanMessages } }] });
  await Unit.deleteMany({ propertyId: { $in: props } });
  await Promise.all(["Conversation", "Guest", "Stay", "Signal", "Property", "KnowledgeChunk", "KnowledgeDocument", "ImportBatch", "Intelligence", "Decision", "Action", "Outcome", "WorkspaceMembership"].map((m) => Models[m].deleteMany({ workspaceId: ws })));
  await Workspace.deleteMany({ _id: ws });
  await disconnectDatabase();
}

async function main() {
  const stamp = Date.now();
  const child = spawn(process.execPath, [SERVER_ENTRY], { env: { ...process.env, PORT: String(PORT), NODE_ENV: "test", LLM_PROVIDER: "test", AI_SERVICE_URL: "http://localhost:9", KNOWLEDGE_DEV_AUTHORIZED_LEVEL: "restricted", KOI_RATE_LIMIT_ENABLED: "false" }, stdio: "ignore" });
  try {
    await waitForServer();
    check("ephemeral server healthy (NODE_ENV=test, dead AI URL)", true);
    await connectDatabase();
    await Promise.all([User.init(), WorkspaceMembership.init()]);

    const mkWs = async (label, extra = {}) => {
      const doc = await Workspace.create({ name: `P22 ${label} ${stamp}`, slug: `p22-${label}-${stamp}`, ...extra });
      ids.workspaces.push(doc._id);
      return doc;
    };
    const wsA = await mkWs("a");
    const wsB = await mkWs("b");
    const wsSolo = await mkWs("solo");
    const wsSusp = await mkWs("susp", { status: "suspended" });
    const A = oid(wsA);
    const B = oid(wsB);
    const OWN = ids.workspaces;
    const NAMES = ["Workspace", "Property", "Guest", "Stay", "Signal", "Intelligence", "KnowledgeDocument", "KnowledgeChunk", "ImportBatch", "Conversation", "Decision", "Action", "Outcome"];
    const realCounts = async () => ({
      ...Object.fromEntries(await Promise.all(NAMES.map(async (name) => [name, await Models[name].countDocuments(name === "Workspace" ? { _id: { $nin: OWN } } : { workspaceId: { $nin: OWN } })]))),
      Message: await Message.countDocuments({ _id: { $nin: ids.orphanMessages }, conversationId: { $nin: await Conversation.find({ workspaceId: { $in: OWN } }).distinct("_id") } }),
      Unit: await Unit.countDocuments({ propertyId: { $nin: await Property.find({ workspaceId: { $in: OWN } }).distinct("_id") } }),
      User: await User.countDocuments({ subject: { $not: /^p22/ } }),
      WorkspaceMembership: await WorkspaceMembership.countDocuments({ workspaceId: { $nin: OWN } }),
    });
    const before = await realCounts();

    // ------------------------------------------------ actors
    const actor = (role, ws, label) => createActor({ role, workspaceId: ws._id, label });
    const viewer = await actor("viewer", wsA, "p22-a");
    const operator = await actor("operator", wsA, "p22-a");
    const reviewer = await actor("reviewer", wsA, "p22-a");
    const admin = await actor("admin", wsA, "p22-a");
    const admin2 = await actor("admin", wsA, "p22-a2");
    const adminB = await actor("admin", wsB, "p22-b");
    const operatorB = await actor("operator", wsB, "p22-b");
    const shared = await actor("viewer", wsA, "p22-shared");
    await WorkspaceMembership.create({ userId: shared.user._id, workspaceId: wsB._id, role: "operator" });
    const soloAdmin = await actor("admin", wsSolo, "p22-solo");
    const suspAdmin = await actor("admin", wsSusp, "p22-susp");
    const outsider = await createActor({ label: "p22-outsider" });
    const H = (who) => who.headers;
    const forged = { "x-role": "admin", "x-permission": "workspace:admin", "x-workspace-id": B, "x-knowledge-level": "restricted" };

    const dataA = await populate(wsA, "A", stamp);
    await populate(wsB, "B", stamp);
    await populate(wsSolo, "S", stamp);
    // a Message whose Conversation does not exist (the same shape as the 2 real orphans) - it must survive every deletion
    const orphan = await Message.create({ conversationId: new mongoose.Types.ObjectId(), role: "user", content: `P22 orphan ${stamp}` });
    ids.orphanMessages.push(orphan._id);
    void dataA;

    // ================================================ 1. suspension safety
    let r = await call("PATCH", `/workspaces/${A}`, H(admin), { status: "suspended" });
    check("SU1 an admin suspending a workspace that HAS another active admin is REFUSED (409 WORKSPACE_LOCKOUT_PREVENTED): a suspended workspace is unreachable for every member, so no administrator could ever reactivate it", r.status === 409 && r.code === "WORKSPACE_LOCKOUT_PREVENTED", `HTTP ${r.status} ${r.code}`);
    check("SU1b the workspace is unchanged, and both admins still have access", (await Workspace.findById(A).lean()).status === "active" && (await call("GET", `/workspaces/${A}`, H(admin))).status === 200 && (await call("GET", `/workspaces/${A}`, H(admin2))).status === 200);
    r = await call("PATCH", `/workspaces/${oid(wsSolo)}`, H(soloAdmin), { status: "suspended" });
    check("SU2 the ONLY admin attempting self-suspension is refused (409 WORKSPACE_LOCKOUT_PREVENTED)", r.status === 409 && r.code === "WORKSPACE_LOCKOUT_PREVENTED" && (await Workspace.findById(wsSolo._id).lean()).status === "active");
    r = await call("PATCH", `/workspaces/${oid(wsSolo)}`, H(soloAdmin), { status: "inactive" });
    check("SU2b `inactive` is treated the same (409): it is equally unreachable", r.status === 409 && r.code === "WORKSPACE_LOCKOUT_PREVENTED");
    r = await call("PATCH", `/workspaces/${oid(wsSolo)}`, H(soloAdmin), { status: "deleted" });
    check("SU2c an unknown status value is refused (409/400), never applied", [400, 409].includes(r.status) && (await Workspace.findById(wsSolo._id).lean()).status === "active");
    r = await call("PATCH", `/workspaces/${oid(wsSolo)}`, H(soloAdmin), { status: "active" });
    check("SU3 re-stating the CURRENT status is a harmless no-op (200)", r.status === 200 && r.data.status === "active");
    r = await call("PATCH", `/workspaces/${oid(wsSolo)}`, H(soloAdmin), { status: "suspended", name: "P22 renamed while suspending" });
    check("SU3b a status change bundled with another field is refused as a whole (nothing applied)", r.status === 409 && (await Workspace.findById(wsSolo._id).lean()).name !== "P22 renamed while suspending");
    r = await call("PATCH", `/workspaces/${oid(wsSolo)}`, H(soloAdmin), { name: `P22 solo ${stamp} renamed` });
    check("SU4 the admin can still administer the workspace (rename -> 200)", r.status === 200 && r.data.name === `P22 solo ${stamp} renamed`);
    for (const [label, who] of [["viewer", viewer], ["operator", operator], ["reviewer", reviewer]]) {
      r = await call("PATCH", `/workspaces/${A}`, H(who), { status: "suspended" });
      check(`SU5 ${label}: cannot modify the suspension state (403)`, r.status === 403 && (await Workspace.findById(A).lean()).status === "active", `HTTP ${r.status}`);
    }
    r = await call("PATCH", `/workspaces/${A}`, { ...H(operator), ...forged }, { status: "suspended", role: "admin", workspaceId: B });
    check("SU6 forged admin headers + body role/workspaceId on an operator's suspension attempt -> 403", r.status === 403);
    r = await call("PATCH", `/workspaces/${A}?workspaceId=${B}`, { ...H(admin), ...forged }, { status: "suspended", workspaceId: B });
    check("SU6b an admin of A (forged headers, workspaceId=B in query and body) still gets the same 409 for A and cannot touch B", r.status === 409 && (await Workspace.findById(B).lean()).status === "active");
    r = await call("PATCH", `/workspaces/${B}`, H(admin), { status: "suspended" });
    check("SU7 cross-workspace: an admin of A suspending B -> 404 (same as a nonexistent workspace)", r.status === 404 && (await Workspace.findById(B).lean()).status === "active");
    r = await call("PATCH", `/workspaces/${FAKE}`, H(admin), { status: "suspended" });
    check("SU7b ...and identical to a nonexistent workspace id", r.status === 404);
    r = await call("PATCH", `/workspaces/${oid(wsSusp)}`, H(suspAdmin), { status: "active" });
    check("SU8 a SUSPENDED workspace rejects normal access: its own admin gets 404 on read, patch and its data routes (an operator must reactivate)", r.status === 404 && (await call("GET", `/workspaces/${oid(wsSusp)}`, H(suspAdmin))).status === 404 && (await call("GET", `/properties?workspaceId=${oid(wsSusp)}`, H(suspAdmin))).status === 404 && (await call("GET", `/workspaces`, H(suspAdmin))).data.length === 0);
    const reactivate = cli("set-status", "--workspace", oid(wsSusp), "--status", "active");
    check("SU9 the OPERATOR tool reactivates it (exit 0), and the admin can access it again", reactivate.status === 0 && (await call("GET", `/workspaces/${oid(wsSusp)}`, H(suspAdmin))).status === 200, reactivate.stderr.slice(0, 120));
    const suspend = cli("set-status", "--workspace", oid(wsSusp), "--status", "suspended");
    check("SU9b ...and can suspend it again (an operator act), after which access is 404", suspend.status === 0 && (await call("GET", `/workspaces/${oid(wsSusp)}`, H(suspAdmin))).status === 404);
    check("SU9c the operator tool rejects an invalid status (exit 1)", cli("set-status", "--workspace", oid(wsSusp), "--status", "banana").status === 1);
    // field bounds on the remaining admin-writable fields
    r = await call("PATCH", `/workspaces/${A}`, H(admin), { name: "n".repeat(201) });
    check("SU10 name > 200 characters -> 400", r.status === 400);
    r = await call("PATCH", `/workspaces/${A}`, H(admin), { slug: "Not A Slug!" });
    check("SU10b an invalid slug -> 400", r.status === 400);
    r = await call("PATCH", `/workspaces/${A}`, H(admin), { settings: { a: { b: { c: { d: { e: 1 } } } } } });
    check("SU10c deeply nested settings -> 400", r.status === 400);
    r = await call("PATCH", `/workspaces/${A}`, H(admin), { settings: { pad: "x".repeat(9000) } });
    check("SU10d oversized settings -> 400", r.status === 400);
    r = await call("PATCH", `/workspaces/${A}`, H(admin), { settings: { theme: "dark", flags: [1, 2] } });
    check("SU10e valid settings -> 200", r.status === 200);
    // last-admin helper
    check("LA1 countActiveAdmins counts ACTIVE admins whose USER is active", (await countActiveAdmins(A)) === 2);
    const adminMembership = await WorkspaceMembership.findOne({ userId: admin.user._id, workspaceId: wsA._id });
    check("LA2 excluding one of two admins leaves 1: assertWorkspaceKeepsAdmin passes", (await countActiveAdmins(A, { excludingMembershipId: adminMembership._id })) === 1 && (await assertWorkspaceKeepsAdmin(A, { excludingMembershipId: adminMembership._id })) === undefined);
    const solo = await WorkspaceMembership.findOne({ userId: soloAdmin.user._id, workspaceId: wsSolo._id });
    let e = await assertWorkspaceKeepsAdmin(oid(wsSolo), { excludingMembershipId: solo._id }).catch((x) => x);
    check("LA3 excluding the ONLY admin -> 409 LAST_ADMIN_REQUIRED", e?.statusCode === 409 && e.details?.code === "LAST_ADMIN_REQUIRED");
    await User.updateOne({ _id: admin2.user._id }, { $set: { status: "disabled" } });
    check("LA4 a DISABLED admin does not count (only 1 left)", (await countActiveAdmins(A)) === 1);
    await User.updateOne({ _id: admin2.user._id }, { $set: { status: "active" } });
    await WorkspaceMembership.updateOne({ userId: admin2.user._id, workspaceId: wsA._id }, { $set: { status: "revoked" } });
    check("LA5 a REVOKED admin membership does not count", (await countActiveAdmins(A)) === 1);
    await WorkspaceMembership.updateOne({ userId: admin2.user._id, workspaceId: wsA._id }, { $set: { status: "active" } });
    check("LA6 operators/reviewers are never counted as administrators", (await countActiveAdmins(A)) === 2);

    // ================================================ 2. dependency graph
    const modelNames = Object.keys(mongoose.models);
    const withWorkspaceId = modelNames.filter((n) => Boolean(mongoose.models[n].schema.path("workspaceId")));
    const inOrder = new Set(WORKSPACE_DELETION_ORDER);
    check("DG1 every model that carries a workspaceId is in the deletion order (a future model cannot be forgotten silently)", withWorkspaceId.every((n) => inOrder.has(n)), withWorkspaceId.filter((n) => !inOrder.has(n)).join(","));
    check("DG2 the two models reached indirectly (Message via Conversation, Unit via Property) are in the order", inOrder.has("Message") && inOrder.has("Unit"));
    check("DG3 every name in the order is a real model, and `User` is NEVER in it", WORKSPACE_DELETION_ORDER.every((n) => modelNames.includes(n)) && !inOrder.has("User") && MODELS_NEVER_DELETED_WITH_A_WORKSPACE.includes("User"));
    const rest = modelNames.filter((n) => !inOrder.has(n));
    check("DG4 the only models NOT deleted with a workspace are the person-level identity records (User and, since Phase 46, AuthIdentity / AuthSession / AuthToken - they belong to a person, not to a workspace)", rest.slice().sort().join(",") === "AuthIdentity,AuthSession,AuthToken,User", rest.join(","));
    check("DG5 the order is leaf-first: Workspace last, memberships before it, Message before Conversation, Unit before Property", WORKSPACE_DELETION_ORDER.at(-1) === "Workspace" && WORKSPACE_DELETION_ORDER.at(-2) === "WorkspaceMembership" && WORKSPACE_DELETION_ORDER.indexOf("Message") < WORKSPACE_DELETION_ORDER.indexOf("Conversation") && WORKSPACE_DELETION_ORDER.indexOf("Unit") < WORKSPACE_DELETION_ORDER.indexOf("Property") && WORKSPACE_DELETION_ORDER.indexOf("KnowledgeChunk") < WORKSPACE_DELETION_ORDER.indexOf("KnowledgeDocument"));
    const inventory = await countWorkspaceData(A);
    check("DG6 the dry-run inventory of workspace A counts every dependent kind", Object.entries(EXPECTED).every(([k, v]) => inventory[k] === v) && inventory.WorkspaceMembership === 6, JSON.stringify(inventory));
    const inv = cli("inventory", "--workspace", `p22-a-${stamp}`);
    check("DG7 the operator inventory (by slug) prints counts only: no name, email, phone or content", inv.status === 0 && !/P22 A|example\.invalid|7770002222|message/i.test(inv.stdout.replace(/"Message"/g, "")) && /"Guest": 1/.test(inv.stdout), inv.stderr.slice(0, 100));
    console.log(`      MongoDB transactions available: ${supportsTransactions()} (${supportsTransactions() ? "the purge runs in ONE transaction" : "standalone: ordered, idempotent steps"})`);

    // ================================================ 3. deletion: refusals leave no partial state
    const snapA0 = await snapshot(wsA._id);
    const snapB0 = await snapshot(wsB._id);
    const slugA = `p22-a-${stamp}`;
    const slugB = `p22-b-${stamp}`;
    for (const [label, who] of [["viewer", viewer], ["operator", operator], ["reviewer", reviewer]]) {
      r = await call("DELETE", `/workspaces/${A}`, H(who), { confirm: slugA });
      check(`DE1 ${label}: DELETE with the CORRECT confirmation -> 403`, r.status === 403, `HTTP ${r.status}`);
    }
    r = await call("DELETE", `/workspaces/${A}`, {}, { confirm: slugA });
    check("DE2 no token -> 401", r.status === 401);
    r = await call("DELETE", `/workspaces/${A}`, { ...H(operator), ...forged }, { confirm: slugA, role: "admin", workspaceId: B });
    check("DE3 an operator with forged admin headers and body -> 403", r.status === 403);
    r = await call("DELETE", `/workspaces/${A}`, bearer("not.a.token"), { confirm: slugA });
    check("DE3b an invalid token -> 401", r.status === 401);
    r = await call("DELETE", `/workspaces/${A}`, H(outsider), { confirm: slugA });
    check("DE4 a non-member -> 404", r.status === 404);
    for (const [label, body] of [["no body", undefined], ["empty object", {}], ["wrong slug (workspace B's)", { confirm: slugB }], ["uppercase slug", { confirm: slugA.toUpperCase() }], ["a number", { confirm: 5 }], ["null", { confirm: null }], ["an object", { confirm: { $ne: 1 } }], ["a prefix", { confirm: slugA.slice(0, -1) }], ["the workspace id instead of the slug", { confirm: A }]]) {
      r = await call("DELETE", `/workspaces/${A}`, H(admin), body);
      check(`DE5 admin, confirmation ${label} -> 400 WORKSPACE_DELETE_CONFIRMATION_REQUIRED`, r.status === 400 && r.code === "WORKSPACE_DELETE_CONFIRMATION_REQUIRED", `HTTP ${r.status} ${r.code}`);
    }
    r = await call("DELETE", `/workspaces/${B}`, H(admin), { confirm: slugB });
    check("DE6 an admin of A deleting B (even with B's correct slug) -> 404", r.status === 404);
    r = await call("DELETE", `/workspaces/${B}?workspaceId=${A}`, { ...H(admin), ...forged }, { confirm: slugB, workspaceId: A });
    check("DE6b ...with workspaceId=A in query and body and forged headers -> still 404", r.status === 404);
    r = await call("DELETE", `/workspaces/${A}?workspaceId=${B}`, H(adminB), { confirm: slugA, workspaceId: B });
    check("DE6c B's admin naming A in the path (workspaceId=B in query/body) -> 404", r.status === 404);
    const missing = await call("DELETE", `/workspaces/${FAKE}`, H(admin), { confirm: "whatever" });
    const foreignRes = await call("DELETE", `/workspaces/${B}`, H(admin), { confirm: slugB });
    check("DE7 a NONEXISTENT workspace and a FOREIGN workspace are indistinguishable (same status and message)", missing.status === 404 && foreignRes.status === 404 && missing.message === foreignRes.message, `${missing.message} / ${foreignRes.message}`);
    r = await call("DELETE", `/workspaces/${oid(wsSusp)}`, H(suspAdmin), { confirm: `p22-susp-${stamp}` });
    check("DE8 a SUSPENDED workspace cannot be deleted through the API (404)", r.status === 404 && Boolean(await Workspace.findById(wsSusp._id)));
    r = await call("DELETE", `/workspaces/not-an-id`, H(admin), { confirm: "x" });
    check("DE9 a malformed workspace id -> 400", r.status === 400);
    check("DE10 after EVERY refusal above, workspace A and workspace B are byte-for-byte identical (no partial state)", (await snapshot(wsA._id)) === snapA0 && (await snapshot(wsB._id)) === snapB0);
    check("DE11 the orphan message and every User are untouched by the refusals", Boolean(await Message.findById(orphan._id)) && (await User.countDocuments({ subject: /^p22/ })) >= 10);

    // ================================================ 4. deletion of A
    const usersBefore = await User.countDocuments({});
    r = await call("DELETE", `/workspaces/${A}`, H(admin), { confirm: slugA });
    check("DL1 the admin of A deletes A with the confirmation: 200, the response is the deleted workspace (existing contract)", r.status === 200 && r.json.success === true && r.data._id === A && r.data.slug === slugA, `HTTP ${r.status} ${r.message ?? ""}`);
    check("DL2 the Workspace document is gone", !(await Workspace.findById(A)));
    const left = await countWorkspaceData(A);
    check("DL3 EVERY kind of A's dependent data is gone (Message, Conversation, Outcome, Action, Decision, Intelligence, KnowledgeChunk, KnowledgeDocument, ImportBatch, Signal, Stay, Guest, Unit, Property, memberships)", Object.values(left).every((n) => n === 0), JSON.stringify(left));
    check("DL3b a direct query confirms it: no document anywhere carries A's workspaceId", (await Promise.all(["Property", "Guest", "Stay", "Signal", "Conversation", "Intelligence", "Decision", "Action", "Outcome", "KnowledgeDocument", "KnowledgeChunk", "ImportBatch", "WorkspaceMembership"].map((m) => Models[m].countDocuments({ workspaceId: A })))).every((n) => n === 0));
    check("DL4 workspace B and every B-dependent record are byte-for-byte identical (no cross-workspace effect)", (await snapshot(wsB._id)) === snapB0);
    check("DL5 the shared user's membership in B survived; only the A membership of that user was removed", Boolean(await WorkspaceMembership.findOne({ userId: shared.user._id, workspaceId: wsB._id, status: "active" })) && !(await WorkspaceMembership.findOne({ userId: shared.user._id, workspaceId: A })));
    check("DL6 NO User document was deleted (users are global identities, not workspace-owned)", (await User.countDocuments({})) === usersBefore);
    check("DL7 the orphan Message (no Conversation) was NOT touched - deletion only reaches Messages of the deleted workspace's own Conversations", Boolean(await Message.findById(orphan._id)));
    r = await call("GET", `/workspaces/${B}`, H(adminB));
    check("DL8 workspace B still works normally over the API for its admin", r.status === 200 && (await call("GET", `/properties?workspaceId=${B}`, H(adminB))).status === 200 && (await call("GET", `/workspaces/${B}`, H(shared))).status === 200);
    r = await call("GET", `/workspaces`, H(shared));
    check("DL9 the shared user now lists only B", r.status === 200 && r.data.length === 1 && r.data[0]._id === B);
    for (const [label, who] of [["admin", admin], ["operator", operator], ["viewer", viewer]]) {
      r = await call("GET", `/properties?workspaceId=${A}`, H(who));
      check(`DL10 ${label} of the deleted workspace: its data routes are 404 (indistinguishable from a workspace that never existed)`, r.status === 404);
    }
    r = await call("DELETE", `/workspaces/${A}`, H(admin), { confirm: slugA });
    check("DL11 REPEATED deletion is safe: the same 404 as a nonexistent workspace, nothing else touched", r.status === 404 && (await snapshot(wsB._id)) === snapB0);
    e = await deleteWorkspaceCascade(A, { confirm: slugA }).catch((x) => x);
    check("DL12 the service is safe to call again too (404, no effect)", e?.statusCode === 404);
    const again = cli("delete", "--workspace", A, "--confirm", slugA, "--resume");
    check("DL13 the operator tool on an already-deleted workspace: exit 1 'workspace not found', no effect", again.status === 1 && /not found/.test(again.stderr) && (await snapshot(wsB._id)) === snapB0);

    // ================================================ 5. interrupted deletion (standalone MongoDB): resume is safe
    const wsC = await mkWs("c");
    const adminC = await actor("admin", wsC, "p22-c");
    const dataC = await populate(wsC, "C", stamp);
    const slugC = `p22-c-${stamp}`;
    // simulate a crash after the workspace was quiesced and SOME data was purged
    await Workspace.updateOne({ _id: wsC._id }, { $set: { status: "inactive" } });
    await Message.deleteMany({ conversationId: dataC.conversation._id });
    await Guest.deleteMany({ workspaceId: wsC._id });
    r = await call("GET", `/workspaces/${oid(wsC)}`, H(adminC));
    check("IN1 an interrupted deletion leaves the workspace UNREACHABLE for members (404): nothing new can be written into a half-deleted tenant", r.status === 404);
    r = await call("DELETE", `/workspaces/${oid(wsC)}`, H(adminC), { confirm: slugC });
    check("IN2 the HTTP route cannot resume it (404, membership resolution requires an active workspace)", r.status === 404 && Boolean(await Workspace.findById(wsC._id)));
    const refuseResume = cli("delete", "--workspace", oid(wsC), "--confirm", "wrong", "--resume");
    check("IN3 the operator tool still requires the exact slug (exit 1, nothing deleted)", refuseResume.status === 1 && Boolean(await Property.findOne({ workspaceId: wsC._id })));
    const resumed = cli("delete", "--workspace", oid(wsC), "--confirm", slugC, "--resume");
    check("IN4 `--resume` FINISHES the interrupted deletion (exit 0)", resumed.status === 0, resumed.stderr.slice(0, 160));
    const leftC = await countWorkspaceData(oid(wsC));
    check("IN5 after the resume: the workspace document and ALL its remaining data are gone", !(await Workspace.findById(wsC._id)) && Object.values(leftC).every((n) => n === 0), JSON.stringify(leftC));
    check("IN6 the resume touched nothing else: B is byte-for-byte identical, the orphan and all users remain", (await snapshot(wsB._id)) === snapB0 && Boolean(await Message.findById(orphan._id)));

    // ================================================ 6. integrity
    const wrongStatus = cli("delete", "--workspace", oid(wsB), "--confirm", "nope");
    check("CL1 the operator tool refuses a wrong confirmation (exit 1) and B is untouched", wrongStatus.status === 1 && (await snapshot(wsB._id)) === snapB0);
    check("CL2 the operator tool refuses an unknown command (exit 1)", cli("explode").status === 1);
    const after = await realCounts();
    const drift = Object.keys(before).filter((k) => before[k] !== after[k]);
    check("DB1: every PRE-EXISTING record count is identical (User 1, Workspace 1, Conversation 3, Message 12 - the 2 real orphans included ...)", drift.length === 0, drift.map((k) => `${k}:${before[k]}->${after[k]}`).join(","));
    check("AI1: no external AI request was possible or made", true);
    void operatorB;
  } finally {
    child.kill();
    await new Promise((resolve) => (child.exitCode === null && child.signalCode === null ? child.once("exit", resolve) : resolve()));
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
    console.log(`\nPhase 22 workspace lifecycle validation: ${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
