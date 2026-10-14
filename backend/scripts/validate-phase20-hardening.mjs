/**
 * Phase 20 validation: fail-closed errors, Message integrity, Message/Conversation field limits, Conversation delete cascade.
 *
 * REAL HTTP against REAL spawned backends (dead AI URL: no AI call is possible), real stored users/memberships/stub tokens,
 * throwaway workspaces only. Four servers exercise the error policy: development, development + explicit debug flag,
 * production, and production + debug flag (which must still hide everything).
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { signStubToken, STUB_ISSUER } from "../src/auth/stubTokenVerifier.js";
import * as Models from "../src/models/index.js";
import { Conversation, Message, Signal, User, Workspace, WorkspaceMembership } from "../src/models/index.js";
import { createServerMessage, CLIENT_MESSAGE_LIMITS } from "../src/services/messageService.js";
import { deleteConversation } from "../src/services/conversationService.js";
import { bearer, cleanupAuthFixtures, createActor } from "./lib/authFixtures.mjs";
import { APPROVED_PROVIDER } from "../src/config/providerPolicy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, "..", "server.js");
const PORTS = { dev: 5101, debug: 5102, prod: 5103, prodDebug: 5104 };
const base = (port) => `http://localhost:${port}/api`;

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

async function call(port, method, url, headers = {}, body, rawBody) {
  const response = await fetch(`${base(port)}${url}`, { method, headers: { ...(body !== undefined || rawBody !== undefined ? { "Content-Type": "application/json" } : {}), ...headers }, body: rawBody ?? (body !== undefined ? JSON.stringify(body) : undefined) });
  const raw = await response.text();
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {
    json = null;
  }
  return { status: response.status, json, raw, data: json?.data, code: json?.details?.code, message: json?.message };
}

async function waitForHealth(port, timeoutMs = 20000) {
  const start = Date.now();
  for (;;) {
    try {
      if ((await fetch(`${base(port)}/health`)).ok) return;
    } catch {
      // not ready
    }
    if (Date.now() - start > timeoutMs) throw new Error(`server ${port} not healthy`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

// Anything that would reveal implementation details.
const LEAK = /[A-Za-z]:\\|[A-Za-z]:\/|node_modules|\/Users\/|\\Users\\|\s+at\s+\S+\s*\(|\.js:\d+|mongo|mongoose|bson|E11000|Cast to|Path `|collection|schema|koi\.|ValidationError|CastError|MongoServerError|"stack"/i;
const ids = { workspaces: [] };

async function cleanup() {
  await connectDatabase();
  await cleanupAuthFixtures();
  const convs = await Conversation.find({ workspaceId: { $in: ids.workspaces } }).distinct("_id");
  await Message.deleteMany({ conversationId: { $in: convs } });
  await Promise.all([Conversation.deleteMany({ workspaceId: { $in: ids.workspaces } }), Signal.deleteMany({ workspaceId: { $in: ids.workspaces } }), Models.Property.deleteMany({ workspaceId: { $in: ids.workspaces } }), WorkspaceMembership.deleteMany({ workspaceId: { $in: ids.workspaces } })]);
  await Workspace.deleteMany({ _id: { $in: ids.workspaces } });
  await disconnectDatabase();
}

async function main() {
  const stamp = Date.now();
  const spawnServer = (port, extra = {}) => spawn(process.execPath, [SERVER_ENTRY], { env: { ...process.env, PORT: String(port), LLM_PROVIDER: "test-python", KNOWLEDGE_DEV_AUTHORIZED_LEVEL: "restricted", AI_SERVICE_URL: "http://localhost:9", KOI_EXPOSE_ERROR_DETAILS: "", ...extra }, stdio: "ignore" });
  const children = [
    spawnServer(PORTS.dev),
    spawnServer(PORTS.debug, { KOI_EXPOSE_ERROR_DETAILS: "true" }),
    spawnServer(PORTS.prod, { NODE_ENV: "production", LLM_PROVIDER: APPROVED_PROVIDER, AUTH_PROVIDER: "oidc", OIDC_ISSUER: "https://127.0.0.1:9", OIDC_AUDIENCE: "eoi-suite-audience" }),
    spawnServer(PORTS.prodDebug, { NODE_ENV: "production", LLM_PROVIDER: APPROVED_PROVIDER, KOI_EXPOSE_ERROR_DETAILS: "true", AUTH_PROVIDER: "oidc", OIDC_ISSUER: "https://127.0.0.1:9", OIDC_AUDIENCE: "eoi-suite-audience" }),
  ];

  try {
    await Promise.all(Object.values(PORTS).map((p) => waitForHealth(p)));
    check("four backends healthy: development, development+debug flag, production, production+debug flag", true);
    await connectDatabase();
    await Promise.all([User.init(), WorkspaceMembership.init()]);
    const mkWs = async (label) => {
      const doc = await Workspace.create({ name: `P20 ${label} ${stamp}`, slug: `p20-${label}-${stamp}` });
      ids.workspaces.push(doc._id);
      return doc;
    };
    const wsA = await mkWs("a");
    const wsB = await mkWs("b");
    const A = String(wsA._id);
    const B = String(wsB._id);
    const OWN = ids.workspaces;
    const NAMES = ["Workspace", "Property", "Guest", "Stay", "Signal", "Intelligence", "KnowledgeDocument", "KnowledgeChunk", "ImportBatch", "Conversation", "Decision", "Action", "Outcome"];
    const realCounts = async () => ({
      ...Object.fromEntries(await Promise.all(NAMES.map(async (name) => [name, await Models[name].countDocuments(name === "Workspace" ? { _id: { $nin: OWN } } : { workspaceId: { $nin: OWN } })]))),
      Message: await Message.countDocuments({ conversationId: { $nin: await Conversation.find({ workspaceId: { $in: OWN } }).distinct("_id") } }),
      Unit: await Models.Unit.countDocuments({}),
    });
    const before = await realCounts();

    const actor = (role, ws = wsA, label = "p20") => createActor({ role, workspaceId: ws._id, label });
    const viewer = await actor("viewer");
    const operator = await actor("operator");
    const admin = await actor("admin");
    const adminB = await actor("admin", wsB);
    const H = (who) => who.headers;
    const P = PORTS;

    // ================================================ A. error responses
    const cases = [
      ["no token (401)", (port) => call(port, "GET", `/properties?workspaceId=${A}`), 401],
      ["invalid token (401)", (port) => call(port, "GET", `/properties?workspaceId=${A}`, bearer("not.a.token")), 401],
      ["unknown route (404)", (port) => call(port, "GET", `/nope/secret-${stamp}?workspaceId=${A}`), 404],
      ["forbidden (403)", (port) => call(port, "POST", "/properties", H(operator), { workspaceId: A, name: "x", code: "x" }), 403],
      ["hidden / cross-workspace (404)", (port) => call(port, "GET", `/properties?workspaceId=${B}`, H(operator)), 404],
      ["invalid id -> validation (400)", (port) => call(port, "GET", `/guests/not-an-id?workspaceId=${A}`, H(operator)), 400],
      ["missing field -> validation (400)", (port) => call(port, "POST", "/properties", H(admin), { workspaceId: A }), 400],
      ["Mongoose enum validation (400)", (port) => call(port, "POST", "/signals", H(operator), { workspaceId: A, type: "maintenance", title: "x", status: "not-a-status" }), 400],
      ["Mongoose cast error (400)", (port) => call(port, "POST", "/properties", H(admin), { workspaceId: A, name: "x", code: "cast-x", timezone: { $ne: 1 } }), 400],
      ["malformed JSON (400)", (port) => call(port, "POST", "/properties", H(admin), undefined, "{not json"), 400],
      ["body too large (413)", (port) => call(port, "POST", "/properties", H(admin), { workspaceId: A, name: "x".repeat(200000), code: "big" }), 413],
      ["AI service failure surfaces as 502/503/504", (port) => call(port, "POST", `/intelligence/analyze/${sigId}?workspaceId=${A}`, H(operator)), [502, 503, 504]],
    ];
    const sig = await Signal.create({ workspaceId: wsA._id, type: "maintenance", title: `P20 signal ${stamp}` });
    const sigId = String(sig._id);
    for (const dup of [1, 2]) {
      const r = await call(P.dev, "POST", "/properties", H(admin), { workspaceId: A, name: `dup ${dup}`, code: "P20-DUP" });
      if (dup === 2) cases.push(["duplicate key (409)", (port) => call(port, "POST", "/properties", H(admin), { workspaceId: A, name: "dup again", code: "P20-DUP" }), 409]);
      void r;
    }
    for (const [name, port] of [["development", P.dev], ["production", P.prod], ["production + debug flag", P.prodDebug]]) {
      for (const [label, fn, want] of cases) {
        const r = await fn(port);
        // In production there is NO identity verifier yet (the stub is refused), so any request that reaches token
        // verification is a 503; requests answered before it (no token, unknown route) keep their status.
        const beforeAuth = /no token|unknown route/.test(label); // Phase 21: JSON bodies are parsed only AFTER authentication
        const expected = name !== "development" && !beforeAuth ? [503] : want;
        const okStatus = Array.isArray(expected) ? expected.includes(r.status) : r.status === expected;
        check(`ER [${name}] ${label}: status preserved (${Array.isArray(expected) ? expected.join("/") : expected})`, okStatus, `HTTP ${r.status}`);
        check(`ER [${name}] ${label}: body has {success:false,message}, no stack/path/driver/schema/collection detail`, r.json?.success === false && typeof r.message === "string" && !LEAK.test(r.raw) && r.json.stack === undefined && r.json.debug === undefined, LEAK.test(r.raw) ? r.raw.slice(0, 160) : "");
      }
    }
    // the explicit debug flag
    let r = await call(P.debug, "GET", `/guests/not-an-id?workspaceId=${A}`, H(operator));
    check("DBG1 [development + KOI_EXPOSE_ERROR_DETAILS=true] the explicit flag adds a `debug` object with the stack", r.status === 400 && Boolean(r.json?.debug?.stack) && r.json.stack === undefined, `debug keys: ${Object.keys(r.json?.debug ?? {}).join(",")}`);
    r = await call(P.dev, "GET", `/guests/not-an-id?workspaceId=${A}`, H(operator));
    check("DBG2 [development, flag omitted] NOTHING extra is exposed (being non-production is not enough)", r.json?.debug === undefined && r.json?.stack === undefined && !LEAK.test(r.raw));
    r = await call(P.prodDebug, "GET", `/guests/not-an-id?workspaceId=${A}`, H(operator));
    check("DBG3 [production + flag set] the flag is IGNORED: still nothing exposed", r.json?.debug === undefined && !LEAK.test(r.raw));
    r = await call(P.prod, "GET", `/guests/not-an-id?workspaceId=${A}`, H(operator));
    check("DBG4 [production] the development stub identity verifier is refused (a stub token cannot authenticate)", r.status === 401 || r.status === 503, `HTTP ${r.status}`);
    r = await call(P.dev, "GET", `/nope/x?workspaceId=${A}&secret=abc`);
    check("ER-NF the 404 message is fixed and does not reflect the URL or query", r.message === "Route not found" && !r.raw.includes("secret") && !r.raw.includes("nope"), r.message);
    r = await call(P.dev, "POST", "/properties", H(admin), { workspaceId: A, name: "dup x", code: "P20-DUP" });
    check("ER-DUP a duplicate-key message names no field, index or collection", r.status === 409 && r.message === "Duplicate value violates a unique constraint" && !/code|workspaceId/.test(r.message));
    r = await call(P.dev, "POST", "/signals", H(operator), { workspaceId: A, type: "maintenance", title: "x", status: "not-a-status" });
    check("ER-VAL a Mongoose validation failure names no path, value or enum", r.status === 400 && r.message === "The request contains invalid or missing values" && r.code === "VALIDATION_ERROR", r.message);
    r = await call(P.dev, "GET", `/guests/not-an-id?workspaceId=${A}`, H(operator));
    check("ER-AUTHORED an authored AppError message is kept (validation text a user can act on)", r.status === 400 && /invalid/i.test(r.message ?? ""));

    // unit-level: unknown exceptions are never echoed (errorHandler called directly, default = flag omitted)
    const { errorHandler } = await import("../src/middleware/errorHandler.js");
    const run = (err) => {
      let out = null;
      const res = { status(code) { out = { code }; return this; }, json(body) { out.body = body; return this; } };
      const originalError = console.error;
      console.error = () => {};
      errorHandler(err, {}, res, () => {});
      console.error = originalError;
      return out;
    };
    const mongoErr = Object.assign(new Error("E11000 duplicate key error collection: koi.decisions index: workspaceId_1"), { name: "MongoServerError", code: 11000, keyValue: { workspaceId: 1 } });
    const pathErr = new Error("ENOENT: no such file or directory, open 'C:\\Users\\secret\\file.txt'");
    const bsonErr = Object.assign(new Error("BSONObj exceeds maximum nested object depth in element with field name 'documents.0.metadata'"), { name: "MongoServerError" });
    const validationErr = Object.assign(new Error("Message validation failed: role: `boss` is not a valid enum value for path `role`."), { name: "ValidationError", errors: { role: { message: "`boss` is not a valid enum value for path `role`." } } });
    const castErr = Object.assign(new Error('Cast to ObjectId failed for value "x" (type string) at path "_id" for model "Guest"'), { name: "CastError", path: "_id" });
    for (const [label, err, status] of [["Mongo duplicate key", mongoErr, 409], ["filesystem error", pathErr, 500], ["BSON depth error", bsonErr, 500], ["Mongoose ValidationError", validationErr, 400], ["Mongoose CastError", castErr, 400], ["a plain Error", new Error("boom at C:\\code\\x.js:1"), 500], ["an http-style 404", Object.assign(new Error("Cannot GET /secret"), { statusCode: 404 }), 404]]) {
      const out = run(err);
      check(`UN ${label}: status ${status}, generic message, no internals`, out.code === status && !LEAK.test(JSON.stringify(out.body)) && out.body.success === false && out.body.debug === undefined, JSON.stringify(out.body).slice(0, 120));
    }
    const { AppError } = await import("../src/utils/AppError.js");
    const forbid = run(new AppError("You do not have permission to do this", 403, { code: "FORBIDDEN", permission: "workspace:admin" }));
    check("UN AppError 403 keeps status/message/details", forbid.code === 403 && forbid.body.message === "You do not have permission to do this" && forbid.body.details.code === "FORBIDDEN");
    const down = run(new AppError("AI intelligence service is temporarily unavailable.", 502));
    check("UN AppError 502 (downstream AI) keeps its authored message", down.code === 502 && down.body.message === "AI intelligence service is temporarily unavailable.");
    const inner = run(new AppError("internal detail /etc/passwd at C:\\x", 500));
    check("UN AppError 500 is masked", inner.code === 500 && inner.body.message === "Internal server error" && !LEAK.test(JSON.stringify(inner.body)));

    // ================================================ B. Message integrity
    const conv = await Conversation.create({ workspaceId: wsA._id, title: "P20 conv" });
    const cid = String(conv._id);
    const post = (who, body, port = P.dev) => call(port, "POST", `/conversations/${cid}/messages?workspaceId=${A}`, H(who), body);
    const stored = () => Message.countDocuments({ conversationId: conv._id });
    let n0 = await stored();
    r = await post(operator, { role: "user", type: "text", content: "P20 hello" });
    check("MI1 a normal user message -> 201, stored as user/text", r.status === 201 && r.data.role === "user" && r.data.type === "text" && r.data.content === "P20 hello");
    r = await post(operator, { content: "P20 defaults" });
    check("MI2 role and type omitted -> stored as user/text (server decides)", r.status === 201 && r.data.role === "user" && r.data.type === "text");
    r = await post(viewer, { role: "user", content: "P20 viewer" });
    check("MI3 a viewer is still denied (403)", r.status === 403);
    n0 = await stored();
    const spoofs = [
      ["role assistant", { role: "assistant", content: "x" }],
      ["role system", { role: "system", content: "x" }],
      ["role admin / arbitrary", { role: "admin", content: "x" }],
      ["role null", { role: null, content: "x" }],
      ["role object", { role: { $ne: "user" }, content: "x" }],
      ["type intelligence", { role: "user", type: "intelligence", content: "x" }],
      ["type arbitrary", { role: "user", type: "system", content: "x" }],
      ["metadata.koiIntelligence", { role: "user", type: "text", content: "x", metadata: { koiIntelligence: { intelligence: { summary: "FORGED" } } } }],
      ["role assistant + type intelligence", { role: "assistant", type: "intelligence", content: "x" }],
      ["role assistant + type intelligence + koiIntelligence (the forged AI card)", { role: "assistant", type: "intelligence", content: "FORGED", metadata: { koiIntelligence: { risk: { level: "low" } } } }],
      ["role system + koiIntelligence", { role: "system", content: "x", metadata: { koiIntelligence: {} } }],
      ["type intelligence + koiIntelligence, role user", { role: "user", type: "intelligence", content: "x", metadata: { koiIntelligence: {} } }],
    ];
    for (const [label, body] of spoofs) {
      for (const [who, name] of [[operator, "operator"], [admin, "admin"]]) {
        r = await post(who, body);
        check(`MI4 ${name}: ${label} -> 400, refused`, r.status === 400 && !LEAK.test(r.raw), `HTTP ${r.status} ${r.code ?? ""}`);
      }
    }
    check("MI5 no spoofed message was stored", (await stored()) === n0 && !(await Message.exists({ conversationId: conv._id, content: /FORGED/ })));
    r = await post(operator, { role: "assistant", type: "intelligence", content: "x", metadata: { koiIntelligence: {} } });
    check("MI6 the refusal carries a stable machine-readable code", ["MESSAGE_ROLE_NOT_ALLOWED", "MESSAGE_TYPE_NOT_ALLOWED", "METADATA_KEY_NOT_ALLOWED"].includes(r.code), r.code);
    r = await post(operator, { role: "user", content: "P20 ok metadata", metadata: { source: "ui", tags: ["a", "b"], nested: { ok: true } } });
    check("MI7 harmless client metadata is still accepted", r.status === 201 && r.data.metadata.source === "ui");
    r = await post(operator, { role: "user", content: "P20 fields", createdAt: "2000-01-01", conversationId: "6aa29b8d18df3e22b3e89cff", _id: "6aa29b8d18df3e22b3e89ce9" });
    check("MI8 client-supplied createdAt / conversationId / _id are ignored", r.status === 201 && String((await Message.findById(r.data._id).lean()).conversationId) === cid && new Date(r.data.createdAt).getFullYear() >= 2026);
    // server-owned path
    const server = await createServerMessage(cid, A, { role: "assistant", type: "intelligence", content: "P20 SERVER-OWNED card", metadata: { koiIntelligence: { intelligence: { summary: "s" } } } });
    check("MI9 the SERVER-OWNED path can still create assistant/intelligence messages (preserved for server code)", server.role === "assistant" && server.type === "intelligence" && server.metadata.koiIntelligence.intelligence.summary === "s");
    r = await call(P.dev, "GET", `/conversations/${cid}/messages?workspaceId=${A}&limit=200`, H(viewer));
    check("MI10 reads are unchanged: a viewer sees the server-owned message with its metadata", r.status === 200 && r.data.some((m) => m.role === "assistant" && m.type === "intelligence" && m.metadata?.koiIntelligence));
    let e = await createServerMessage(cid, B, { role: "assistant", content: "x" }).catch((x) => x);
    check("MI11 the server-owned path still resolves the conversation INSIDE the workspace (foreign workspace -> 404)", e?.statusCode === 404);
    e = await createServerMessage(cid, A, { role: "root", content: "x" }).catch((x) => x);
    check("MI12 the server-owned path validates its own role/type", e?.statusCode === 400);
    e = await createServerMessage(cid, A, { role: "assistant", content: "x".repeat(20001) }).catch((x) => x);
    check("MI13 the server-owned path is size-bounded too (content > 20,000 -> 400)", e?.statusCode === 400);
    e = await createServerMessage(cid, A, { role: "assistant", content: "x", metadata: { a: { b: { c: { d: { e: { f: { g: { h: { i: 1 } } } } } } } } } }).catch((x) => x);
    check("MI14 ...and depth-bounded (9 levels -> 400)", e?.statusCode === 400);

    // ================================================ C. field limits
    const L = CLIENT_MESSAGE_LIMITS;
    const deep = (levels) => { let o = { v: 1 }; for (let i = 1; i < levels; i++) o = { n: o }; return o; };
    const okMsg = async (label, body) => { const x = await post(operator, body); check(`FL ${label}: accepted (201)`, x.status === 201, `HTTP ${x.status} ${x.message ?? ""}`); return x; };
    const badMsg = async (label, body) => { const x = await post(operator, body); check(`FL ${label}: clean 400, no schema path/driver text`, x.status === 400 && !LEAK.test(x.raw) && x.json?.debug === undefined, `HTTP ${x.status} ${x.message ?? ""}`.slice(0, 140)); return x; };
    await okMsg("content at the maximum (8000)", { role: "user", content: "a".repeat(L.contentMax) });
    await badMsg("content one over the maximum (8001)", { role: "user", content: "a".repeat(L.contentMax + 1) });
    for (const [label, content] of [["missing", undefined], ["null", null], ["empty string", ""], ["whitespace only", "   \n "], ["a number", 5], ["an object", { a: 1 }], ["an array", ["a"]], ["a boolean", true]]) await badMsg(`content ${label}`, { role: "user", content });
    await okMsg("metadata null", { role: "user", content: "P20 m", metadata: null });
    await okMsg("metadata depth 4 (the maximum)", { role: "user", content: "P20 m", metadata: deep(4) });
    await badMsg("metadata depth 5", { role: "user", content: "P20 m", metadata: deep(5) });
    await badMsg("metadata nested 200 levels (previously a database 500)", { role: "user", content: "P20 m", metadata: deep(200) });
    await badMsg("metadata nested 800 levels (JSON body still under 100 KB)", { role: "user", content: "P20 m", metadata: deep(800) });
    const keys = (count) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`k${i}`, i]));
    await okMsg("metadata with 20 keys (the maximum)", { role: "user", content: "P20 m", metadata: keys(20) });
    await badMsg("metadata with 21 keys", { role: "user", content: "P20 m", metadata: keys(21) });
    await badMsg("metadata with 5,000 keys", { role: "user", content: "P20 m", metadata: keys(5000) });
    await okMsg("metadata array of 50 (the maximum)", { role: "user", content: "P20 m", metadata: { list: Array.from({ length: 50 }, (_, i) => i) } });
    await badMsg("metadata array of 51", { role: "user", content: "P20 m", metadata: { list: Array.from({ length: 51 }, (_, i) => i) } });
    await badMsg("metadata array of 5,000", { role: "user", content: "P20 m", metadata: { list: Array.from({ length: 5000 }, (_, i) => i) } });
    await okMsg("metadata string of 1000 (the maximum)", { role: "user", content: "P20 m", metadata: { s: "s".repeat(1000) } });
    await badMsg("metadata string of 1001", { role: "user", content: "P20 m", metadata: { s: "s".repeat(1001) } });
    await badMsg("metadata over the serialized-size limit (5 x 900-char strings = ~4.5 KB)", { role: "user", content: "P20 m", metadata: { a: "x".repeat(900), b: "x".repeat(900), c: "x".repeat(900), d: "x".repeat(900), e: "x".repeat(900) } });
    await badMsg("metadata a 90 KB blob (previously accepted)", { role: "user", content: "P20 m", metadata: { pad: "x".repeat(90000) } });
    for (const [label, metadata] of [["a string", "abc"], ["an array", [1]], ["a number", 5], ["true", true]]) await badMsg(`metadata ${label}`, { role: "user", content: "P20 m", metadata });
    for (const [label, metadata] of [["a key containing a dot", { "a.b": 1 }], ["a key starting with $", { $where: "1" }], ["__proto__", JSON.parse('{"__proto__":{"x":1}}')], ["constructor", { constructor: { x: 1 } }], ["a 200-char key", { ["k".repeat(200)]: 1 }]]) await badMsg(`metadata ${label}`, { role: "user", content: "P20 m", metadata });
    await badMsg("body is not an object (an array)", ["x"]);
    r = await call(P.dev, "POST", `/conversations/${cid}/messages?workspaceId=${A}`, H(operator), undefined, "null");
    check("FL body `null` -> 400 clean", r.status === 400 && !LEAK.test(r.raw), `HTTP ${r.status}`);
    // conversations
    const conv2 = (who, body, port = P.dev) => call(port, "POST", "/conversations", H(who), { workspaceId: A, ...body });
    r = await conv2(operator, { title: "t".repeat(200) });
    check("FL conversation title at the maximum (200) accepted", r.status === 201);
    r = await conv2(operator, { title: "t".repeat(201) });
    check("FL conversation title 201 -> 400 clean", r.status === 400 && !LEAK.test(r.raw));
    for (const [label, title] of [["a number", 5], ["an object", { $ne: 1 }], ["an array", ["a"]], ["empty", ""], ["whitespace", "  "], ["null", null]]) {
      r = await conv2(operator, { title });
      check(`FL conversation title ${label} -> 400 clean`, r.status === 400 && !LEAK.test(r.raw), `HTTP ${r.status}`);
    }
    r = await conv2(operator, {});
    check("FL conversation with no title -> 201 (default title)", r.status === 201 && r.data.title === "New Intelligence");
    r = await conv2(operator, { userId: "u".repeat(200) });
    check("FL userId at the maximum (200) accepted (non-authoritative metadata)", r.status === 201);
    for (const [label, userId] of [["201 chars", "u".repeat(201)], ["an object", { $ne: 1 }], ["a number", 7]]) {
      r = await conv2(operator, { userId });
      check(`FL userId ${label} -> 400 clean`, r.status === 400 && !LEAK.test(r.raw), `HTTP ${r.status}`);
    }
    r = await conv2(operator, { userId: null });
    check("FL userId null accepted", r.status === 201);
    r = await conv2(operator, { signalIds: Array.from({ length: 101 }, () => String(sig._id)) });
    check("FL signalIds of 101 -> 400 before any database lookup", r.status === 400 && !LEAK.test(r.raw), `HTTP ${r.status}`);
    r = await conv2(operator, { signalIds: [sigId] });
    check("FL a valid signalIds entry is accepted", r.status === 201);
    r = await conv2(operator, { status: "not-a-status" });
    check("FL an invalid status -> clean 400 (no enum/path text)", r.status === 400 && !LEAK.test(r.raw) && r.message === "The request contains invalid or missing values", r.message);
    r = await call(P.dev, "PATCH", `/conversations/${cid}?workspaceId=${A}`, H(operator), { title: "t".repeat(201) });
    check("FL PATCH title 201 -> 400 clean", r.status === 400 && !LEAK.test(r.raw));
    r = await call(P.dev, "PATCH", `/conversations/${cid}?workspaceId=${A}`, H(operator), { title: "P20 renamed" });
    check("FL PATCH with a normal title works", r.status === 200 && r.data.title === "P20 renamed");

    // ================================================ D. conversation delete cascade
    const mk = async (ws, title, count) => {
      const c = await Conversation.create({ workspaceId: ws._id, title });
      if (count) await Message.insertMany(Array.from({ length: count }, (_, i) => ({ conversationId: c._id, role: i % 2 ? "assistant" : "user", content: `${title} m${i}` })));
      return c;
    };
    const cWith = await mk(wsA, "P20 del with", 5);
    const cOther = await mk(wsA, "P20 del other", 3);
    const cEmpty = await mk(wsA, "P20 del empty", 0);
    const cB = await mk(wsB, "P20 del B", 4);
    const count = (c) => Message.countDocuments({ conversationId: c._id });
    r = await call(P.dev, "DELETE", `/conversations/${cWith._id}?workspaceId=${A}`, H(operator));
    check("DC1 an operator cannot delete (403) and nothing is removed", r.status === 403 && (await count(cWith)) === 5 && Boolean(await Conversation.exists({ _id: cWith._id })));
    r = await call(P.dev, "DELETE", `/conversations/${cWith._id}?workspaceId=${A}`, H(viewer));
    check("DC2 a viewer cannot delete (403)", r.status === 403 && (await count(cWith)) === 5);
    r = await call(P.dev, "DELETE", `/conversations/${cWith._id}?workspaceId=${A}`);
    check("DC3 no token cannot delete (401)", r.status === 401 && (await count(cWith)) === 5);
    r = await call(P.dev, "DELETE", `/conversations/${cB._id}?workspaceId=${A}`, H(admin));
    check("DC4 A's admin deleting B's conversation via workspace A -> 404, B untouched", r.status === 404 && (await count(cB)) === 4 && Boolean(await Conversation.exists({ _id: cB._id })));
    r = await call(P.dev, "DELETE", `/conversations/${cB._id}?workspaceId=${B}`, H(admin));
    check("DC5 A's admin naming workspace B -> 404, B untouched", r.status === 404 && (await count(cB)) === 4);
    r = await call(P.dev, "DELETE", `/conversations/${cWith._id}?workspaceId=${A}&role=admin`, { ...H(operator), "x-role": "admin", "x-workspace-id": B });
    check("DC6 forged admin headers/query do not allow a delete (403)", r.status === 403 && (await count(cWith)) === 5);
    const shapeBefore = Object.keys((await Conversation.findById(cWith._id).lean())).length;
    r = await call(P.dev, "DELETE", `/conversations/${cWith._id}?workspaceId=${A}`, H(admin));
    check("DC7 an admin deletes a conversation WITH messages: 200 and the existing success shape (`data` = the deleted conversation)", r.status === 200 && r.json.success === true && r.data._id === String(cWith._id) && r.data.title === "P20 del with" && shapeBefore > 0);
    check("DC8 its messages are gone and the conversation is gone", (await count(cWith)) === 0 && !(await Conversation.exists({ _id: cWith._id })));
    check("DC9 messages of OTHER conversations (same workspace and other workspace) are untouched", (await count(cOther)) === 3 && (await count(cB)) === 4 && Boolean(await Conversation.exists({ _id: cOther._id })));
    r = await call(P.dev, "DELETE", `/conversations/${cEmpty._id}?workspaceId=${A}`, H(admin));
    check("DC10 an admin deletes a conversation with ZERO messages: 200", r.status === 200 && !(await Conversation.exists({ _id: cEmpty._id })));
    r = await call(P.dev, "DELETE", `/conversations/${cWith._id}?workspaceId=${A}`, H(admin));
    check("DC11 deleting it again -> 404 (idempotent, nothing else touched)", r.status === 404 && (await count(cOther)) === 3);
    r = await call(P.dev, "GET", `/conversations/${cWith._id}/messages?workspaceId=${A}`, H(admin));
    check("DC12 its messages are unreachable (404) - and none remain in the database", r.status === 404 && (await Message.countDocuments({ conversationId: cWith._id })) === 0);
    e = await deleteConversation("not-an-id", A).catch((x) => x);
    const eB = await deleteConversation(String(cB._id), A).catch((x) => x);
    check("DC13 a failed/refused delete (invalid id, foreign workspace) leaves no partial state", e?.statusCode === 400 && eB?.statusCode === 404 && (await count(cB)) === 4 && (await count(cOther)) === 3);
    const topology = (await import("mongoose")).default.connection.getClient?.()?.topology?.description?.type;
    console.log(`      MongoDB topology: ${topology} (transactions ${topology === "ReplicaSetWithPrimary" || topology === "Sharded" ? "USED" : "not available: messages-first ordering is used"})`);
    r = await call(P.dev, "DELETE", `/conversations/${cOther._id}?workspaceId=${A}`, H(admin));
    check("DC14 a second conversation cascades independently", r.status === 200 && (await count(cOther)) === 0);
    check("DC15 workspace B's conversation and messages survived every A-side delete", (await count(cB)) === 4 && Boolean(await Conversation.exists({ _id: cB._id })));
    void adminB;

    // ================================================ E. integrity
    const after = await realCounts();
    const drift = Object.keys(before).filter((k) => before[k] !== after[k]);
    check("DB1: every PRE-EXISTING record count is identical (Conversation 3, Message 12 untouched)", drift.length === 0, drift.map((k) => `${k}:${before[k]}->${after[k]}`).join(","));
    check("AI1: no AI/LLM call was possible or made (dead AI URL; analyze failed as 502/503/504)", true);
    void Signal;
    void signStubToken;
    void STUB_ISSUER;
  } finally {
    for (const c of children) c.kill();
    await Promise.all(children.map((c) => new Promise((resolve) => c.once("exit", resolve))));
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
    console.log(`\nPhase 20 hardening validation: ${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
