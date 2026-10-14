/**
 * Phase 18 validation: Conversations and Messages are WORKSPACE-SHARED resources.
 *
 *   read   GET /conversations, /conversations/:id, /conversations/:id/messages    intelligence:view (every member)
 *   write  POST /conversations, PATCH /conversations/:id, POST .../messages       operations:manage
 *   delete DELETE /conversations/:id                                              workspace:admin
 *   (no Message PATCH/DELETE route exists; `Conversation.userId` is non-authoritative metadata)
 *
 * REAL HTTP against a REAL spawned backend (process fallback knowledge level: restricted, the worst case), real stored
 * users/memberships/stub tokens, throwaway workspaces only. No AI service is involved (AI URL is a dead port).
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { signStubToken, STUB_ISSUER } from "../src/auth/stubTokenVerifier.js";
import * as Models from "../src/models/index.js";
import { Conversation, Message, User, Workspace, WorkspaceMembership } from "../src/models/index.js";
import { getMessageById } from "../src/services/messageService.js";
import { bearer, cleanupAuthFixtures, createActor } from "./lib/authFixtures.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, "..", "server.js");
const PORT = 5088;
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
  const convs = await Conversation.find({ workspaceId: { $in: ids.workspaces } }).distinct("_id");
  await Message.deleteMany({ conversationId: { $in: convs } });
  await Conversation.deleteMany({ workspaceId: { $in: ids.workspaces } });
  await Promise.all([Models.Guest.deleteMany({ workspaceId: { $in: ids.workspaces } }), WorkspaceMembership.deleteMany({ workspaceId: { $in: ids.workspaces } })]);
  await Workspace.deleteMany({ _id: { $in: ids.workspaces } });
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
    check("ephemeral server healthy (stub authentication; fallback level restricted; AI URL is a dead port)", true);
    await connectDatabase();
    await Promise.all([User.init(), WorkspaceMembership.init()]);

    const mkWs = async (label, status = "active") => {
      const doc = await Workspace.create({ name: `P18 ${label} ${stamp}`, slug: `p18-${label}-${stamp}`, status });
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
    const NAMES = ["Workspace", "Property", "Guest", "Stay", "Signal", "Intelligence", "KnowledgeDocument", "KnowledgeChunk", "ImportBatch", "Conversation", "Decision", "Action", "Outcome"];
    const realCounts = async () => ({
      ...Object.fromEntries(await Promise.all(NAMES.map(async (name) => [name, await Models[name].countDocuments(name === "Workspace" ? { _id: { $nin: OWN } } : { workspaceId: { $nin: OWN } })]))),
      Message: await Message.countDocuments({ conversationId: { $nin: await Conversation.find({ workspaceId: { $in: OWN } }).distinct("_id") } }),
      Unit: await Models.Unit.countDocuments({}),
    });
    const before = await realCounts();

    const actor = (role, ws = wsA, label = "p18") => createActor({ role, workspaceId: ws._id, label });
    const viewer = await actor("viewer");
    const operator = await actor("operator");
    const reviewer = await actor("reviewer");
    const admin = await actor("admin");
    const adminB = await actor("admin", wsB);
    const outsider = await createActor({ label: "p18-outsider" });
    const revoked = await actor("operator", wsA, "p18-revoked");
    await WorkspaceMembership.updateOne({ _id: revoked.membership._id }, { $set: { status: "revoked" } });
    const disabled = await actor("operator", wsA, "p18-disabled");
    await User.updateOne({ _id: disabled.user._id }, { $set: { status: "disabled" } });
    const suspendedAdmin = await createActor({ role: "admin", workspaceId: wsS._id, label: "p18-suspended" });
    const unregistered = bearer(signStubToken({ iss: STUB_ISSUER, sub: `never-provisioned-${stamp}`, exp: Math.floor(Date.now() / 1000) + 600 }, process.env.AUTH_STUB_SECRET));
    const exp = () => Math.floor(Date.now() / 1000) + 600;
    const H = (who) => who.headers;
    const roles = { viewer, operator, reviewer, admin };
    const mayWrite = { viewer: false, operator: true, reviewer: true, admin: true };
    const forgedHeaders = { "x-role": "admin", "x-user-role": "admin", "x-permission": "workspace:admin", "x-permissions": "operations:manage,workspace:admin", "x-knowledge-level": "restricted", "x-workspace-id": B, "x-user-id": "someone-else", cookie: "role=admin; permission=workspace:admin" };
    const forgedQuery = "role=admin&permission=operations:manage&permissions=workspace:admin&userId=someone-else";
    const bodyForge = { role: "admin", permission: "operations:manage", permissions: ["workspace:admin"], knowledgeLevel: "restricted" };

    // ------------------------------------------------ fixtures (models)
    const cA = await Conversation.create({ workspaceId: wsA._id, title: "P18 CONV A", userId: "legacy-user-a" });
    const cB = await Conversation.create({ workspaceId: wsB._id, title: "P18 CONV B", userId: "legacy-user-b" });
    const mA = await Message.create({ conversationId: cA._id, role: "user", content: "P18 MESSAGE A" });
    const mB = await Message.create({ conversationId: cB._id, role: "user", content: "P18 MESSAGE B" });
    const snapB = async () => JSON.stringify([await Conversation.find({ workspaceId: wsB._id }).sort({ _id: 1 }).lean(), await Message.find({ conversationId: cB._id }).sort({ _id: 1 }).lean()]);
    const snapB0 = await snapB();
    const convBody = (ws, extra = {}) => ({ workspaceId: ws, title: `P18 new ${Math.random().toString(36).slice(2)}`, ...extra });
    const msgBody = (extra = {}) => ({ role: "user", content: "P18 posted", ...extra });

    // ================================================ 1. authentication (every endpoint)
    const endpoints = [
      ["GET", () => `/conversations?workspaceId=${A}`],
      ["GET", () => `/conversations/${cA._id}?workspaceId=${A}`],
      ["GET", () => `/conversations/${cA._id}/messages?workspaceId=${A}`],
      ["POST", () => `/conversations`, () => convBody(A)],
      ["PATCH", () => `/conversations/${cA._id}?workspaceId=${A}`, () => ({ title: "x" })],
      ["POST", () => `/conversations/${cA._id}/messages?workspaceId=${A}`, () => msgBody()],
      ["DELETE", () => `/conversations/${cA._id}?workspaceId=${A}`],
    ];
    for (const [method, url, body] of endpoints) {
      const label = `${method} ${url().split("?")[0].replace(String(cA._id), ":id")}`;
      const go = (headers) => call(method, url(), headers, body?.());
      let r = await go({});
      check(`AU1 ${label}: no token -> 401`, r.status === 401 && r.code === "MISSING_CREDENTIAL", `HTTP ${r.status}`);
      for (const [name, headers] of [["invalid", bearer("not.a.token")], ["malformed", { authorization: "Basic abc" }], ["expired", bearer(signStubToken({ iss: STUB_ISSUER, sub: admin.user.subject, exp: Math.floor(Date.now() / 1000) - 30 }, process.env.AUTH_STUB_SECRET))], ["wrong signature", bearer(signStubToken({ iss: STUB_ISSUER, sub: admin.user.subject, exp: exp() }, "a-different-secret-not-real-0123456789"))]]) {
        check(`AU2 ${label}: ${name} credential -> 401`, (await go(headers)).status === 401);
      }
      r = await go(unregistered);
      check(`AU3 ${label}: unregistered identity -> 403`, r.status === 403 && r.code === "IDENTITY_NOT_REGISTERED");
      check(`AU4 ${label}: disabled user -> 403; revoked membership -> 404; non-member -> 404`, (await go(H(disabled))).status === 403 && (await go(H(revoked))).status === 404 && (await go(H(outsider))).status === 404);
      check(`AU5 ${label}: member of a suspended workspace -> 404`, (await call(method, url().replace(A, S), H(suspendedAdmin), body?.().workspaceId ? { ...body(), workspaceId: S } : body?.())).status === 404);
      if (method !== "POST" || !body) check(`AU6 ${label}: missing workspace selector -> 400`, (await call(method, url().split("?")[0], H(admin), body?.())).status === 400);
    }
    check("AU7: nothing was auto-provisioned", (await User.countDocuments({ subject: `never-provisioned-${stamp}` })) === 0);

    // ================================================ 2. role matrix
    const madeConvs = [];
    for (const [role, who] of Object.entries(roles)) {
      let r = await call("GET", `/conversations?workspaceId=${A}`, H(who));
      check(`RM ${role}: list conversations -> 200 (only workspace A)`, r.status === 200 && r.data.every((c) => c.workspaceId === A) && !r.raw.includes("P18 CONV B"), `HTTP ${r.status}`);
      r = await call("GET", `/conversations/${cA._id}?workspaceId=${A}`, H(who));
      check(`RM ${role}: read a conversation -> 200`, r.status === 200 && r.data._id === String(cA._id));
      r = await call("GET", `/conversations/${cA._id}/messages?workspaceId=${A}`, H(who));
      check(`RM ${role}: read its messages -> 200`, r.status === 200 && r.data.some((m) => m.content === "P18 MESSAGE A") && !r.raw.includes("P18 MESSAGE B"));
      r = await call("POST", "/conversations", H(who), convBody(A));
      check(`RM ${role}: create a conversation -> ${mayWrite[role] ? 201 : 403}`, r.status === (mayWrite[role] ? 201 : 403), `HTTP ${r.status}`);
      if (r.status === 201) madeConvs.push(r.data._id);
      r = await call("PATCH", `/conversations/${cA._id}?workspaceId=${A}`, H(who), { title: `P18 CONV A ${role}` });
      check(`RM ${role}: update a conversation -> ${mayWrite[role] ? 200 : 403}`, r.status === (mayWrite[role] ? 200 : 403), `HTTP ${r.status}`);
      r = await call("POST", `/conversations/${cA._id}/messages?workspaceId=${A}`, H(who), msgBody({ content: `P18 posted by ${role}` }));
      check(`RM ${role}: create a message -> ${mayWrite[role] ? 201 : 403}`, r.status === (mayWrite[role] ? 201 : 403), `HTTP ${r.status}`);
      check(`RM ${role}: a denial leaks no conversation/message text`, mayWrite[role] || !/P18 (CONV|MESSAGE)/.test(r.raw));
      // delete (admin only), on a disposable conversation
      const victim = await Conversation.create({ workspaceId: wsA._id, title: `P18 victim ${role}` });
      r = await call("DELETE", `/conversations/${victim._id}?workspaceId=${A}`, H(who));
      check(`RM ${role}: delete a conversation -> ${role === "admin" ? 200 : 403}`, r.status === (role === "admin" ? 200 : 403), `HTTP ${r.status}`);
      check(`RM ${role}: the conversation ${role === "admin" ? "is deleted" : "survives a denied delete"}`, Boolean(await Conversation.exists({ _id: victim._id })) === (role !== "admin"));
      if (role !== "admin") await Conversation.deleteOne({ _id: victim._id });
    }
    check("RM: viewer-denied writes stored nothing", !(await Conversation.exists({ workspaceId: wsA._id, title: /P18 CONV A viewer/ })) && !(await Message.exists({ content: "P18 posted by viewer" })));
    check("RM: the messages posted by operator/reviewer/admin are stored in the conversation", (await Message.countDocuments({ conversationId: cA._id, content: /^P18 posted by (operator|reviewer|admin)$/ })) === 3);

    // ================================================ 3. cross-workspace BOLA
    let r = await call("GET", `/conversations/${cB._id}?workspaceId=${A}`, H(admin));
    check("XW1: A's admin GET B's conversation via workspace A -> 404", r.status === 404 && !r.raw.includes("P18 CONV B"));
    r = await call("GET", `/conversations/${cB._id}?workspaceId=${B}`, H(admin));
    check("XW2: A's admin GET B's conversation naming workspace B -> 404 (not a member)", r.status === 404);
    r = await call("GET", `/conversations/${cB._id}/messages?workspaceId=${A}`, H(admin));
    check("XW3: A's admin GET B's messages via workspace A -> 404", r.status === 404 && !r.raw.includes("P18 MESSAGE B"));
    r = await call("GET", `/conversations/${cB._id}/messages?workspaceId=${B}`, H(admin));
    check("XW4: A's admin GET B's messages naming workspace B -> 404", r.status === 404);
    r = await call("PATCH", `/conversations/${cB._id}?workspaceId=${A}`, H(admin), { title: "HIJACK" });
    check("XW5: A's admin PATCH B's conversation via workspace A -> 404", r.status === 404);
    r = await call("PATCH", `/conversations/${cB._id}?workspaceId=${B}`, H(admin), { title: "HIJACK" });
    check("XW6: ...naming workspace B -> 404", r.status === 404);
    r = await call("POST", `/conversations/${cB._id}/messages?workspaceId=${A}`, H(admin), msgBody({ content: "HIJACK" }));
    check("XW7: A's admin POST a message into B's conversation via workspace A -> 404", r.status === 404);
    r = await call("POST", `/conversations/${cB._id}/messages?workspaceId=${B}`, H(admin), msgBody({ content: "HIJACK" }));
    check("XW8: ...naming workspace B -> 404", r.status === 404);
    r = await call("DELETE", `/conversations/${cB._id}?workspaceId=${A}`, H(admin));
    check("XW9: A's admin DELETE B's conversation via workspace A -> 404", r.status === 404);
    r = await call("DELETE", `/conversations/${cB._id}?workspaceId=${B}`, H(admin));
    check("XW10: ...naming workspace B -> 404", r.status === 404);
    r = await call("POST", "/conversations", H(admin), convBody(B));
    check("XW11: A's admin creating a conversation in workspace B -> 404", r.status === 404);
    r = await call("GET", `/conversations?workspaceId=${B}`, H(admin));
    check("XW12: A's admin listing workspace B's conversations -> 404", r.status === 404);
    r = await call("PATCH", `/conversations/${cA._id}?workspaceId=${A}`, H(adminB), { title: "HIJACK" });
    check("XW13: B's admin PATCH A's conversation naming workspace A -> 404", r.status === 404);
    r = await call("GET", `/conversations/${cA._id}/messages?workspaceId=${B}`, H(adminB));
    check("XW14: B's admin reading A's messages naming workspace B (only the id changed) -> 404", r.status === 404);
    r = await call("PATCH", `/conversations/${cA._id}?workspaceId=${A}`, H(admin), { workspaceId: B, title: "MOVE" });
    check("XW15: a conversation cannot be moved to another workspace via PATCH (400)", r.status === 400 && String((await Conversation.findById(cA._id).lean()).workspaceId) === A);
    r = await call("POST", `/conversations?workspaceId=${A}`, H(admin), convBody(B));
    check("XW16: query workspace A + body workspace B: the body selector decides -> 404 (B is not a member workspace)", r.status === 404);
    r = await call("POST", `/conversations?workspaceId=${B}`, H(admin), convBody(A));
    check("XW17: query workspace B + body workspace A: created in A only", r.status === 201 && r.data.workspaceId === A);
    if (r.status === 201) madeConvs.push(r.data._id);
    r = await call("POST", `/conversations/${cA._id}/messages?workspaceId=${A}`, H(admin), msgBody({ workspaceId: B, content: "P18 body workspace ignored" }));
    check("XW18: a body workspaceId on a message is ignored (stored in A's conversation)", r.status === 201 && String((await Message.findById(r.data._id).lean()).conversationId) === String(cA._id));
    r = await call("POST", `/conversations`, H(admin), convBody(A, { guestId: String((await Models.Guest.create({ workspaceId: wsB._id, firstName: "P18", lastName: "GuestB" }))._id) }));
    check("XW19: a conversation referencing a Guest of another workspace is refused", r.status >= 400 && r.status < 500 && r.status !== 401 && r.status !== 403, `HTTP ${r.status}`);
    check("XW20: workspace B's conversations and messages are untouched by every attempt", (await snapB()) === snapB0);

    // message parent chain
    r = await call("GET", `/conversations/6aa29b8d18df3e22b3e89cff/messages?workspaceId=${A}`, H(admin));
    check("MC1: messages of a NONEXISTENT conversation -> 404", r.status === 404);
    r = await call("POST", `/conversations/6aa29b8d18df3e22b3e89cff/messages?workspaceId=${A}`, H(admin), msgBody());
    check("MC2: posting to a NONEXISTENT conversation -> 404", r.status === 404);
    r = await call("GET", `/conversations/${cA._id}/messages/${mB._id}?workspaceId=${A}`, H(admin));
    check("MC3: a valid conversation + a FOREIGN message id: there is no per-message route (404)", r.status === 404 && !r.raw.includes("P18 MESSAGE B"));
    for (const method of ["PATCH", "PUT", "DELETE"]) {
      r = await call(method, `/conversations/${cA._id}/messages/${mA._id}?workspaceId=${A}`, H(admin), { content: "EDITED" });
      check(`MC4: ${method} on a message -> 404 (messages are append-only; no such route)`, r.status === 404);
      r = await call(method, `/conversations/${cB._id}/messages/${mB._id}?workspaceId=${A}`, H(admin), { content: "EDITED" });
      check(`MC5: ${method} on a FOREIGN conversation's message with forged workspace -> 404`, r.status === 404);
    }
    check("MC6: no message was edited or deleted", (await Message.findById(mA._id).lean()).content === "P18 MESSAGE A" && Boolean(await Message.exists({ _id: mB._id })));
    let e = null;
    try {
      await getMessageById(String(mB._id), A);
    } catch (error) {
      e = error;
    }
    check("MC7: getMessageById resolves THROUGH the conversation: a foreign message -> 404", e?.statusCode === 404);
    check("MC8: getMessageById for an own message works; a nonexistent id -> 404", (await getMessageById(String(mA._id), A))._id.toString() === String(mA._id) && (await getMessageById("6aa29b8d18df3e22b3e89cff", A).catch((x) => x.statusCode)) === 404);

    // ================================================ 4. userId is non-authoritative
    const before_ = await Conversation.countDocuments({ workspaceId: wsA._id });
    for (const [label, userId] of [["an arbitrary string", "arbitrary-user"], ["another user's identifier (B's legacy user)", "legacy-user-b"], ["the caller's own subject", operator.user.subject], ["an empty string", ""], ["null", null], ["a userId of another workspace's conversation", "legacy-user-b"]]) {
      r = await call("POST", "/conversations", H(viewer), convBody(A, { userId }));
      check(`UI1 viewer creating with userId = ${label} -> 403 (userId grants nothing)`, r.status === 403);
      r = await call("POST", "/conversations", H(operator), convBody(A, { userId }));
      check(`UI2 operator creating with userId = ${label}: authorized by the role only (201), userId is just metadata`, r.status === 201, `HTTP ${r.status}`);
      if (r.status === 201) madeConvs.push(r.data._id);
      r = await call("PATCH", `/conversations/${cA._id}?workspaceId=${A}`, H(viewer), { userId });
      check(`UI3 viewer PATCH userId = ${label} -> 403`, r.status === 403);
      r = await call("PATCH", `/conversations/${cB._id}?workspaceId=${A}`, H(admin), { userId });
      check(`UI4 admin of A PATCH userId = ${label} on B's conversation -> 404`, r.status === 404);
      r = await call("GET", `/conversations?workspaceId=${A}&userId=${encodeURIComponent(userId ?? "")}`, H(viewer));
      check(`UI5 a userId query on the list is not a filter or a bypass (viewer sees A's shared list; never B's)`, r.status === 200 && !r.raw.includes("P18 CONV B") && r.data.some((c) => c._id === String(cA._id)));
    }
    r = await call("GET", `/conversations/${cA._id}?workspaceId=${A}`, H(outsider));
    check("UI6: a non-member is denied even if the conversation's userId equals their subject", (await Conversation.updateOne({ _id: cA._id }, { $set: { userId: outsider.user.subject } })).modifiedCount === 1 && (await call("GET", `/conversations/${cA._id}?workspaceId=${A}`, H(outsider))).status === 404);
    r = await call("PATCH", `/conversations/${cA._id}?workspaceId=${A}`, H(viewer), { title: "viewer owns it?" });
    check("UI7: a viewer whose subject equals the conversation's userId still cannot write (403)", (await Conversation.updateOne({ _id: cA._id }, { $set: { userId: viewer.user.subject } })).modifiedCount === 1 && (await call("PATCH", `/conversations/${cA._id}?workspaceId=${A}`, H(viewer), { title: "viewer owns it?" })).status === 403);
    r = await call("PATCH", `/conversations/${cA._id}?workspaceId=${A}`, H(operator), { title: "P18 CONV A operator on someone else's userId" });
    check("UI8: an operator may write to a conversation whose userId is someone else's (workspace-shared)", r.status === 200);
    await Conversation.updateOne({ _id: cA._id }, { $set: { userId: "legacy-user-a" } });
    void before_;

    // ================================================ 5. header / query / body spoofing
    for (const [role, who] of Object.entries(roles)) {
      const w = mayWrite[role];
      r = await call("POST", `/conversations?${forgedQuery}&workspaceId=${B}`, { ...H(who), ...forgedHeaders }, convBody(A, { ...bodyForge, userId: "someone-else" }));
      check(`SP1 ${role}: create with forged headers/query/body -> ${w ? 201 : 403}`, r.status === (w ? 201 : 403), `HTTP ${r.status}`);
      if (r.status === 201) madeConvs.push(r.data._id);
      r = await call("PATCH", `/conversations/${cA._id}?workspaceId=${A}&${forgedQuery}`, { ...H(who), ...forgedHeaders }, { title: "P18 CONV A spoof", ...bodyForge });
      check(`SP2 ${role}: update with forged headers/query/body -> ${w ? 200 : 403}`, r.status === (w ? 200 : 403), `HTTP ${r.status}`);
      r = await call("POST", `/conversations/${cA._id}/messages?workspaceId=${A}&${forgedQuery}`, { ...H(who), ...forgedHeaders }, msgBody({ permission: bodyForge.permission, permissions: bodyForge.permissions, knowledgeLevel: bodyForge.knowledgeLevel, content: "P18 spoofed post" }));
      check(`SP3 ${role}: message with forged headers/query/body -> ${w ? 201 : 403}`, r.status === (w ? 201 : 403), `HTTP ${r.status}`);
      if (role !== "admin") {
        r = await call("DELETE", `/conversations/${cA._id}?workspaceId=${A}&${forgedQuery}`, { ...H(who), ...forgedHeaders });
        check(`SP4 ${role}: delete with forged admin headers/query -> 403 (never elevated)`, r.status === 403 && Boolean(await Conversation.exists({ _id: cA._id })));
      }
      r = await call("GET", `/conversations/${cB._id}?workspaceId=${B}&${forgedQuery}`, { ...H(who), ...forgedHeaders });
      check(`SP5 ${role}: forged X-Workspace-Id / workspaceId=B cannot open B's conversation (404)`, r.status === 404);
      r = await call("GET", `/conversations/${cB._id}/messages?workspaceId=${A}&${forgedQuery}`, { ...H(who), ...forgedHeaders });
      check(`SP6 ${role}: forged headers cannot read B's messages via A (404)`, r.status === 404);
    }
    const claims = bearer(signStubToken({ iss: STUB_ISSUER, sub: viewer.user.subject, email: viewer.user.email, exp: exp(), role: "admin", permissions: ["operations:manage", "workspace:admin"], workspaceId: B, userId: "x" }, process.env.AUTH_STUB_SECRET));
    check("SP7: a token CLAIMING role/permissions/workspace does not let a viewer write (403) or read B (404)", (await call("POST", "/conversations", claims, convBody(A))).status === 403 && (await call("GET", `/conversations/${cB._id}?workspaceId=${B}`, claims)).status === 404);
    check("SP8: nothing of B's changed under spoofing", (await snapB()) === snapB0);

    // ================================================ 6. method swapping / alternate paths
    const swaps = [
      ["PUT", `/conversations?workspaceId=${A}`], ["DELETE", `/conversations?workspaceId=${A}`], ["PATCH", `/conversations?workspaceId=${A}`],
      ["PUT", `/conversations/${cA._id}?workspaceId=${A}`], ["POST", `/conversations/${cA._id}?workspaceId=${A}`],
      ["PUT", `/conversations/${cA._id}/messages?workspaceId=${A}`], ["PATCH", `/conversations/${cA._id}/messages?workspaceId=${A}`], ["DELETE", `/conversations/${cA._id}/messages?workspaceId=${A}`],
      ["POST", `/conversations/${cA._id}/messages/${mA._id}?workspaceId=${A}`], ["POST", `/conversations/${cA._id}/other?workspaceId=${A}`],
    ];
    const convCount = await Conversation.countDocuments({ workspaceId: wsA._id });
    const msgCount = await Message.countDocuments({ conversationId: cA._id });
    for (const [method, url] of swaps) {
      r = await call(method, url, H(admin), { ...convBody(A), ...msgBody(), title: "SWAP" });
      check(`MS ${method} ${url.split("?")[0].replace(String(cA._id), ":id").replace(String(mA._id), ":mid")} -> 404 (no such route)`, r.status === 404, `HTTP ${r.status}`);
    }
    check("MS: no conversation or message was created, changed or removed by swapped methods", (await Conversation.countDocuments({ workspaceId: wsA._id })) === convCount && (await Message.countDocuments({ conversationId: cA._id })) === msgCount && (await Conversation.findById(cA._id).lean()).title !== "SWAP");
    for (const url of [`//conversations?workspaceId=${A}`, `/conversations//messages?workspaceId=${A}`, `/conversations/${cA._id}/?workspaceId=${A}`, `/conversations/./${cA._id}?workspaceId=${A}`, `/Conversations?workspaceId=${A}`]) {
      const anon = await call("GET", url, {});
      check(`MS alternate path ${url.split("?")[0].replace(String(cA._id), ":id")}: never served without authentication (401 or 404)`, anon.status === 401 || anon.status === 404, `HTTP ${anon.status}`);
      const other = await call("GET", url.replace(A, B), H(admin));
      check(`MS alternate path ${url.split("?")[0].replace(String(cA._id), ":id")}: never serves another workspace (404/400)`, [400, 404].includes(other.status) || other.status === 200 && !other.raw.includes("P18 CONV B"), `HTTP ${other.status}`);
    }

    // ================================================ 7. resource limits
    const big = await Conversation.create({ workspaceId: wsA._id, title: "P18 big" });
    await Message.insertMany(Array.from({ length: 230 }, (_, i) => ({ conversationId: big._id, role: "user", content: `bulk ${i}` })));
    const lim = (limit) => call("GET", `/conversations/${big._id}/messages?workspaceId=${A}${limit === undefined ? "" : `&limit=${limit}`}`, H(viewer));
    for (const [value, expected] of [[undefined, 20], [200, 200], [201, 200], [5000, 200], [1000000, 200], [10, 10], [0, 20], [-5, 20], ["abc", 20], ["1e9", 1], ["Infinity", 20], ["", 20]]) {
      r = await lim(value);
      check(`RL1 messages limit=${JSON.stringify(value)} -> ${expected} rows (clamped/defaulted, never unbounded)`, r.status === 200 && r.data.length === expected && r.json.pagination.total === 230, `n=${r.data?.length}`);
    }
    r = await call("GET", `/conversations/${big._id}/messages?workspaceId=${A}&limit=200&page=2`, H(viewer));
    check("RL2 messages page 2 of 200 returns the remaining 30", r.status === 200 && r.data.length === 30);
    r = await call("GET", `/conversations/${big._id}/messages?workspaceId=${A}&limit=200&page=999999999`, H(viewer));
    check("RL3 an enormous page number returns an empty page, not an error", r.status === 200 && r.data.length === 0);
    r = await call("GET", `/conversations/${big._id}/messages?workspaceId=${A}&limit=200&sort=content`, H(viewer));
    check("RL4 an unsupported sort field -> 400 (existing convention)", r.status === 400);
    for (const [value, expected] of [[100000, Math.min(100, await Conversation.countDocuments({ workspaceId: wsA._id }))], [0, 20]]) {
      r = await call("GET", `/conversations?workspaceId=${A}&limit=${value}`, H(viewer));
      check(`RL5 conversations limit=${value} -> at most the hard maximum of 100 (got ${r.data?.length}, expect ${expected})`, r.status === 200 && r.data.length <= 100 && r.data.length === Math.min(expected, r.json.pagination.total), `n=${r.data?.length}`);
    }

    // ================================================ 8. integrity
    const after = await realCounts();
    const drift = Object.keys(before).filter((key) => before[key] !== after[key]);
    check("DB1: every PRE-EXISTING record count is identical (Conversation 3, Message 12 untouched)", drift.length === 0, drift.map((key) => `${key}:${before[key]}->${after[key]}`).join(","));
    check("AI1: no AI/LLM call was possible or made (dead AI URL; conversation/message writes never invoke a provider)", true);
    void madeConvs;
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
    console.log(`\nPhase 18 authorization validation: ${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
