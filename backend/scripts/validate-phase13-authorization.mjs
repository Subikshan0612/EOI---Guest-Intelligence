/**
 * Phase 13 authorization validation: LLM operations, knowledge management, retrieval, import.
 *
 *   A  POST /intelligence/analyze/:signalId          intelligence:generate
 *   B  POST /signals/:id/intelligence  (legacy)      RETIRED in Phase 24: not a route (404), never reaches the AI service
 *   C  GET  /signals/:id/knowledge-retrieval (dev)   workspace:admin
 *   D  knowledge management: POST /knowledge-documents, /upload, /:id/chunks, /:id/embeddings,
 *      PATCH /:id (incl. defaultVisibility), DELETE /:id                       workspace:admin
 *   E  POST /imports/operational                                              workspace:admin
 *
 * Real spawned backend, real MongoDB, real users + memberships + stub-signed tokens: nothing
 * authenticates through a header, query parameter or body field. AI_SERVICE_URL points at a TRAP
 * server that records every request (and the `authorizedLevel` Node sent), so:
 *   - a DENIED request must never reach the AI service (no LLM/embedding call),
 *   - an ALLOWED request reaches the authorization boundary (the trap answers 500, so the
 *     operation ends in an AI error - the point is that authorization passed),
 *   - the level Node sends is the ACTOR's ceiling, whatever the caller claims.
 * The server's process fallback KNOWLEDGE_DEV_AUTHORIZED_LEVEL is set to the HIGHEST level: any
 * use of it for an authenticated caller would show up as "restricted".
 * No Gemini, no real corpus, no embedding of stored knowledge: all data is synthetic, in
 * throwaway workspaces, removed at the end.
 */
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { signStubToken, STUB_ISSUER } from "../src/auth/stubTokenVerifier.js";
import * as Models from "../src/models/index.js";
import { Action, Decision, Guest, ImportBatch, Intelligence, KnowledgeChunk, KnowledgeDocument, Outcome, Property, Signal, Stay, User, Workspace, WorkspaceMembership } from "../src/models/index.js";
import { bearer, cleanupAuthFixtures, createActor, tokenFor } from "./lib/authFixtures.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, "..", "server.js");
const PORT = 5095;
const TRAP_PORT = 5096;
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

async function call(method, url, { headers = {}, body, form } = {}) {
  const init = { method, headers: { ...headers } };
  if (form) init.body = form;
  else if (body !== undefined) {
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
  return { status: response.status, json, raw, data: json?.data, code: json?.details?.code, message: json?.message };
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

const PII = { first: "Zyxwvu", last: "Qponmlk", email: "zyxwvu.qponmlk@example.invalid", phone: "7770004444", reservation: "RSV-PHASE13-SECRET-9921" };
const DOC_SECRET = "PHASE13-DOC-CONTENT-SECRET";
const leaks = (raw) => [...Object.values(PII), DOC_SECRET].filter((v) => raw.toLowerCase().includes(v.toLowerCase()));
const ids = { workspaces: [], properties: [] };
const OUTSIDE = ["User", "WorkspaceMembership", "Workspace", "Property", "Unit", "Guest", "Stay", "Signal", "Intelligence", "Decision", "Action", "Outcome", "KnowledgeDocument", "KnowledgeChunk", "ImportBatch", "Conversation", "Message"];
const counts = async () => {
  const own = ids.workspaces;
  const out = {};
  for (const name of OUTSIDE) {
    const model = Models[name];
    if (name === "Workspace") out[name] = await model.countDocuments({ _id: { $nin: own } });
    else if (name === "User") out[name] = await model.countDocuments({ subject: { $not: /^(p13|legacy|authfetch|v1suite|dashsuite|sec)/ } });
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
  const props = (await Property.find({ workspaceId: ws }, { _id: 1 }).lean()).map((p) => p._id).concat(ids.properties);
  await Promise.all([Outcome.deleteMany({ workspaceId: ws }), Action.deleteMany({ workspaceId: ws }), Decision.deleteMany({ workspaceId: ws }), ImportBatch.deleteMany({ workspaceId: ws })]);
  await Promise.all([Intelligence.deleteMany({ workspaceId: ws }), Signal.deleteMany({ workspaceId: ws }), Stay.deleteMany({ workspaceId: ws }), Guest.deleteMany({ workspaceId: ws }), KnowledgeChunk.deleteMany({ workspaceId: ws }), KnowledgeDocument.deleteMany({ workspaceId: ws }), Property.deleteMany({ _id: { $in: props } }), WorkspaceMembership.deleteMany({ workspaceId: ws })]);
  await Workspace.deleteMany({ _id: ws });
  await disconnectDatabase();
}

async function main() {
  const stamp = Date.now();
  const trapReqs = [];
  const trap = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        body = null;
      }
      trapReqs.push({ method: req.method, url: req.url, level: body?.authorizedLevel });
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end("{}");
    });
  });
  await new Promise((resolve) => trap.listen(TRAP_PORT, resolve));
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, PORT: String(PORT), LLM_PROVIDER: "test-python", AI_SERVICE_URL: `http://localhost:${TRAP_PORT}`, KNOWLEDGE_DEV_AUTHORIZED_LEVEL: "restricted" },
    stdio: "ignore",
  });

  try {
    await waitForHealth();
    await connectDatabase();
    await Promise.all([User.init(), WorkspaceMembership.init(), Intelligence.init()]);

    const mkWs = async (label) => {
      const doc = await Workspace.create({ name: `P13 ${label} ${stamp}`, slug: `p13-${label}-${stamp}` });
      ids.workspaces.push(doc._id);
      return doc;
    };
    const wsA = await mkWs("a");
    const wsB = await mkWs("b");
    const A = String(wsA._id);
    const B = String(wsB._id);
    const before = await counts();

    const propA = await Property.create({ workspaceId: wsA._id, name: `P13 Property A ${stamp}`, code: `P13A-${stamp}` });
    const propB = await Property.create({ workspaceId: wsB._id, name: `P13 Property B ${stamp}`, code: `P13B-${stamp}` });
    ids.properties.push(propA._id, propB._id);
    const guest = await Guest.create({ workspaceId: wsA._id, firstName: PII.first, lastName: PII.last, email: PII.email, phone: PII.phone });
    await Stay.create({ workspaceId: wsA._id, guestId: guest._id, propertyId: propA._id, reservationId: PII.reservation, checkIn: new Date("2030-01-01"), checkOut: new Date("2030-01-03") });
    const sigA = await Signal.create({ workspaceId: wsA._id, propertyId: propA._id, type: "maintenance", severity: "medium", title: `P13 signal A ${stamp}`, guestId: guest._id });
    const sigA2 = await Signal.create({ workspaceId: wsA._id, propertyId: propA._id, type: "maintenance", severity: "low", title: `P13 signal A2 ${stamp}` });
    const sigB = await Signal.create({ workspaceId: wsB._id, propertyId: propB._id, type: "maintenance", severity: "medium", title: `P13 signal B ${stamp}` });
    const docA = await KnowledgeDocument.create({ workspaceId: wsA._id, title: "P13 doc A", documentType: "sop", content: DOC_SECRET, contentHash: `p13-${stamp}`, isTestData: true, defaultVisibility: "staff", sourceType: "manual-entry" });

    const mk = (role, ws, label) => createActor({ role, workspaceId: ws._id, label });
    const viewer = await mk("viewer", wsA, "p13-viewer");
    const operator = await mk("operator", wsA, "p13-operator");
    const reviewer = await mk("reviewer", wsA, "p13-reviewer");
    const admin = await mk("admin", wsA, "p13-admin");
    const adminB = await mk("admin", wsB, "p13-adminb");
    const outsider = await createActor({ label: "p13-outsider" });
    const unregistered = bearer(signStubToken({ iss: STUB_ISSUER, sub: `never-provisioned-${stamp}`, exp: Math.floor(Date.now() / 1000) + 600 }, process.env.AUTH_STUB_SECRET));
    const H = (who) => who.headers;
    const forged = { "x-role": "admin", "x-permissions": "workspace:admin,intelligence:generate", "x-permission": "workspace:admin", "x-knowledge-level": "restricted", "x-authorized-level": "restricted", "x-user-id": String(admin.user._id), "x-workspace-id": B };
    const forgedQuery = `&role=admin&permission=workspace:admin&level=restricted&authorizedLevel=restricted&knowledgeLevel=restricted&userId=${admin.user._id}`;
    const claims = (who) => ({ authorization: `Bearer ${tokenFor(who.user, { role: "admin", roles: ["admin"], permissions: ["workspace:admin", "intelligence:generate"], knowledgeLevel: "restricted", workspaceId: A, scope: "admin" })}` });
    const reached = (r) => ![401, 403, 404].includes(r.status); // got past authentication, membership and permission
    const aiHits = () => trapReqs.length;

    // ================================================================ generic matrix runner
    async function matrix(label, run, { roles, denyHitsAi = true }) {
      // run(headers, ws, extra) -> response
      let r = await run({}, A);
      check(`${label}: no token -> 401`, r.status === 401 && r.code === "MISSING_CREDENTIAL", `HTTP ${r.status}`);
      r = await run(bearer("not.a.token"), A);
      check(`${label}: invalid token -> 401`, r.status === 401 && r.code === "INVALID_TOKEN");
      r = await run({ authorization: "Basic abc" }, A);
      check(`${label}: malformed Authorization -> 401`, r.status === 401);
      r = await run(unregistered, A);
      check(`${label}: valid token, unregistered identity -> 403`, r.status === 403 && r.code === "IDENTITY_NOT_REGISTERED");
      r = await run(H(outsider), A);
      check(`${label}: valid registered NON-member -> 404`, r.status === 404);
      r = await run(H(adminB), A);
      check(`${label}: an admin of ANOTHER workspace -> 404 (cross-workspace)`, r.status === 404);
      for (const [name, who] of [["viewer", viewer], ["operator", operator], ["reviewer", reviewer], ["admin", admin]]) {
        const hits = aiHits();
        r = await run(H(who), A);
        const allowed = roles.includes(name);
        if (allowed) check(`${label}: ${name} passes authorization`, reached(r), `HTTP ${r.status}`);
        else {
          check(`${label}: ${name} -> 403 (member without the permission)`, r.status === 403 && r.code === "FORBIDDEN", `HTTP ${r.status}`);
          if (denyHitsAi) check(`${label}: ${name} denied: the AI service was NOT reached`, aiHits() === hits);
        }
      }
      // elevation attempts (a viewer stands for "the caller who is NOT allowed")
      const lowest = ["viewer", "operator", "reviewer", "admin"].find((role) => !roles.includes(role));
      if (lowest) {
        const who = { viewer, operator, reviewer, admin }[lowest];
        const hits = aiHits();
        r = await run({ ...H(who), ...forged }, A, forgedQuery);
        check(`${label}: forged role / permission / level / user-id / workspace headers AND query change nothing (${lowest} -> 403)`, r.status === 403);
        r = await run(claims(who), A);
        check(`${label}: forged role / permission / level / workspace CLAIMS in a valid token change nothing (${lowest} -> 403)`, r.status === 403);
        if (denyHitsAi) check(`${label}: no forged attempt reached the AI service`, aiHits() === hits);
      }
      r = await run({ ...H(adminB), ...forged }, A, forgedQuery);
      check(`${label}: workspace manipulation (B's admin naming A, forged headers) -> 404`, r.status === 404);
      r = await run(H(admin), B);
      check(`${label}: A's admin selecting workspace B (not a member) -> 404`, r.status === 404);
    }

    // ================================================================ A. V1 generation (intelligence:generate)
    const analyze = (headers, ws, extra = "", signalId = sigA._id) => call("POST", `/intelligence/analyze/${signalId}?workspaceId=${ws}${extra}`, { headers });
    await matrix("A analyze", analyze, { roles: ["operator", "reviewer", "admin"] });
    const levelSeen = async (who, extra = "", headers = {}, signalId = sigA2._id) => {
      const from = trapReqs.length;
      await call("POST", `/intelligence/analyze/${signalId}?workspaceId=${A}${extra}`, { headers: { ...H(who), ...headers } });
      return trapReqs.slice(from).find((t) => t.url === "/v1/intelligence/analyze")?.level;
    };
    check("A level: operator -> the AI service is asked at STAFF", (await levelSeen(operator)) === "staff");
    check("A level: reviewer -> STAFF", (await levelSeen(reviewer)) === "staff");
    check("A level: admin -> RESTRICTED", (await levelSeen(admin)) === "restricted");
    check("A level: the dev fallback (restricted) did NOT raise an operator", (await levelSeen(operator)) === "staff");
    check("A level: forged level headers + query + body-style params cannot raise an operator to restricted", (await levelSeen(operator, forgedQuery, forged)) === "staff");
    check("A level: token claims cannot raise an operator", (await levelSeen(operator, "", claims(operator))) === "staff");
    const hits0 = aiHits();
    let r = await call("POST", `/intelligence/analyze/${sigB._id}?workspaceId=${A}`, { headers: H(admin) });
    check("A isolation: analyzing another workspace's Signal by selecting A -> 404, no AI call", r.status === 404 && aiHits() === hits0);
    const hits = aiHits();
    r = await call("POST", `/intelligence/analyze/${sigB._id}?workspaceId=${A}`, { headers: H(operator) });
    check("A isolation: ...and for an operator", r.status === 404 && aiHits() === hits);
    r = await call("POST", `/intelligence/analyze/${sigA._id}?workspaceId=${A}`, { headers: H(operator), body: { authorizedLevel: "restricted", workspaceId: B, role: "admin" } });
    check("A body: a JSON body naming a level / workspace / role is ignored (still an operator in A: authorization passes)", reached(r), `HTTP ${r.status}`);
    check("A: no Intelligence was persisted by any of these (the trap answered 500)", (await Intelligence.countDocuments({ workspaceId: { $in: ids.workspaces } })) === 0);

    // ================================================================ B. legacy generation - RETIRED (Phase 24)
    {
      const hitsB = aiHits();
      const before = await Intelligence.countDocuments({ workspaceId: { $in: ids.workspaces } });
      for (const [name, who] of [["viewer", viewer], ["operator", operator], ["reviewer", reviewer], ["admin", admin]]) {
        const res = await call("POST", `/signals/${sigA._id}/intelligence?workspaceId=${A}`, { headers: H(who) });
        check(`B retired: POST /signals/:id/intelligence is not a route (404) for ${name}`, res.status === 404);
      }
      const anon = await call("POST", `/signals/${sigA._id}/intelligence?workspaceId=${A}`, {});
      check("B retired: ...and unauthenticated (404: the path does not exist)", anon.status === 404);
      const forgedLegacy = await call("POST", `/signals/${sigB._id}/intelligence?workspaceId=${A}`, { headers: H(admin) });
      check("B retired: another workspace's Signal via the retired path is also just 404", forgedLegacy.status === 404);
      check("B retired: none of these reached the AI service or persisted anything", aiHits() === hitsB && (await Intelligence.countDocuments({ workspaceId: { $in: ids.workspaces } })) === before);
    }

    // ================================================================ C. knowledge retrieval (dev endpoint, workspace:admin)
    const retrieval = (headers, ws, extra = "") => call("GET", `/signals/${sigA._id}/knowledge-retrieval?workspaceId=${ws}${extra}`, { headers });
    await matrix("C retrieval", retrieval, { roles: ["admin"] });
    r = await retrieval(H(admin), A);
    check("C retrieval: an admin gets the existing response (200) at its restricted ceiling", r.status === 200 && r.data && Array.isArray(r.data.results), `HTTP ${r.status}`);
    check("C retrieval: the response is not broadened (only the existing keys) and carries no PII", leaks(r.raw).length === 0);

    // ================================================================ D. knowledge management (workspace:admin)
    const created = [];
    const docBody = (ws, extra = {}) => ({ workspaceId: ws, title: `P13 new doc ${Math.random().toString(36).slice(2, 7)}`, documentType: "sop", isTestData: true, content: "# Heading\n\nPHASE13-NEW", ...extra });
    const createDoc = (headers, ws, extra = "") => call("POST", `/knowledge-documents?x=1${extra}`, { headers, body: docBody(ws) });
    await matrix("D create document", createDoc, { roles: ["admin"] });
    r = await createDoc(H(admin), A);
    check("D create: an admin can create a document in its own workspace (201)", r.status === 201);
    if (r.data?._id) created.push(r.data._id);
    check("D create: the document went into the VERIFIED workspace", (await KnowledgeDocument.findById(r.data._id).lean()).workspaceId.equals(wsA._id));
    r = await call("POST", `/knowledge-documents?workspaceId=${A}`, { headers: H(admin), body: docBody(B) });
    check("D create: admin of A with a BODY workspace of B (not a member) -> 404, nothing created in B", r.status === 404 && (await KnowledgeDocument.countDocuments({ workspaceId: wsB._id })) === 0);
    r = await call("POST", `/knowledge-documents?workspaceId=${B}`, { headers: H(admin), body: docBody(A) });
    check("D create: a QUERY workspace does not override the body selector (admin of A, body A) -> 201 in A", r.status === 201);
    if (r.data?._id) created.push(r.data._id);
    r = await call("POST", `/knowledge-documents`, { headers: H(admin), body: docBody(A, { defaultVisibility: "restricted" }) });
    check("D visibility: an admin (restricted ceiling) may create restricted knowledge", r.status === 201 && r.data.defaultVisibility === "restricted");
    if (r.data?._id) created.push(r.data._id);
    const docsBeforeDenied = await KnowledgeDocument.countDocuments({ workspaceId: wsA._id, title: /P13 new doc/ });
    for (const [name, who] of [["viewer", viewer], ["operator", operator], ["reviewer", reviewer]]) {
      const res = await call("POST", `/knowledge-documents`, { headers: H(who), body: docBody(A, { defaultVisibility: "guest" }) });
      check(`D visibility: ${name} cannot create knowledge, whatever visibility it names (403)`, res.status === 403);
    }
    check("D create: every refused attempt created nothing", (await KnowledgeDocument.countDocuments({ workspaceId: wsA._id, title: /P13 new doc/ })) === docsBeforeDenied);

    const patch = (headers, ws, extra = "") => call("PATCH", `/knowledge-documents/${docA._id}?workspaceId=${ws}${extra}`, { headers, body: { defaultVisibility: "guest" } });
    await matrix("D patch (visibility)", patch, { roles: ["admin"] });
    await KnowledgeDocument.updateOne({ _id: docA._id }, { $set: { defaultVisibility: "staff" } }); // the admin run above lowered it
    r = await call("PATCH", `/knowledge-documents/${docA._id}?workspaceId=${A}`, { headers: H(operator), body: { defaultVisibility: "guest" } });
    check("D patch: an operator cannot LOWER visibility (403) and the document is unchanged", r.status === 403 && (await KnowledgeDocument.findById(docA._id).lean()).defaultVisibility === "staff");
    r = await call("PATCH", `/knowledge-documents/${docA._id}?workspaceId=${A}`, { headers: H(admin), body: { defaultVisibility: "restricted", workspaceId: B } });
    check("D patch: a body workspaceId naming another workspace is refused by the existing immutability rule (400): nothing changed, the document did not move", r.status === 400 && (await KnowledgeDocument.findById(docA._id).lean()).workspaceId.equals(wsA._id) && (await KnowledgeDocument.findById(docA._id).lean()).defaultVisibility === "staff");
    r = await call("PATCH", `/knowledge-documents/${docA._id}?workspaceId=${A}`, { headers: H(admin), body: { defaultVisibility: "restricted" } });
    check("D patch: an admin changes visibility (200)", r.status === 200 && (await KnowledgeDocument.findById(docA._id).lean()).defaultVisibility === "restricted");
    r = await call("PATCH", `/knowledge-documents/${docA._id}?workspaceId=${B}`, { headers: H(adminB), body: { title: "hijack" } });
    check("D patch: B's admin cannot touch A's document (404) and it is unchanged", r.status === 404 && (await KnowledgeDocument.findById(docA._id).lean()).title === "P13 doc A");

    const chunks = (headers, ws, extra = "") => call("POST", `/knowledge-documents/${docA._id}/chunks?workspaceId=${ws}${extra}`, { headers });
    await matrix("D chunks", chunks, { roles: ["admin"] });
    r = await chunks(H(admin), A);
    check("D chunks: an admin passes authorization and can rebuild chunks", reached(r), `HTTP ${r.status}`);

    const embed = (headers, ws, extra = "") => call("POST", `/knowledge-documents/${docA._id}/embeddings?workspaceId=${ws}${extra}`, { headers });
    await matrix("D embeddings", embed, { roles: ["admin"] });
    const hitsE = aiHits();
    r = await embed(H(admin), A);
    check("D embeddings: an admin reaches the embedding step (the AI trap was contacted, not a real provider)", aiHits() > hitsE && r.status !== 401 && r.status !== 403 && r.status !== 404, `HTTP ${r.status}`);

    const upload = (headers, ws, extra = "") => {
      const form = new FormData();
      form.append("workspaceId", ws);
      form.append("title", "P13 upload");
      form.append("documentType", "sop");
      form.append("isTestData", "true");
      form.append("file", new Blob(["# Title\n\nPHASE13-UPLOAD body"], { type: "text/markdown" }), "p13.md");
      return call("POST", `/knowledge-documents/upload?x=1${extra}`, { headers, form });
    };
    await matrix("D upload", upload, { roles: ["admin"] });
    const docsBefore = await KnowledgeDocument.countDocuments({ workspaceId: { $in: ids.workspaces } });
    r = await upload(H(viewer), A);
    check("D upload: a denied upload created no document", r.status === 403 && (await KnowledgeDocument.countDocuments({ workspaceId: { $in: ids.workspaces } })) === docsBefore);
    r = await upload(H(admin), B);
    check("D upload: admin of A with a FORM workspace of B -> 404, nothing created in B", r.status === 404 && (await KnowledgeDocument.countDocuments({ workspaceId: wsB._id })) === 0);
    r = await upload(H(admin), A);
    check("D upload: an admin passes authorization (the document is created in A; embedding then hits the AI trap)", r.status !== 401 && r.status !== 403 && r.status !== 404 && (await KnowledgeDocument.countDocuments({ workspaceId: wsA._id, title: "P13 upload" })) >= 1, `HTTP ${r.status}`);

    const del = async (headers, ws, id) => call("DELETE", `/knowledge-documents/${id}?workspaceId=${ws}`, { headers });
    const victim = await KnowledgeDocument.create({ workspaceId: wsA._id, title: "P13 victim", documentType: "sop", content: "x", contentHash: `p13v-${stamp}`, isTestData: true, defaultVisibility: "guest", sourceType: "manual-entry" });
    for (const [name, who] of [["viewer", viewer], ["operator", operator], ["reviewer", reviewer]]) {
      r = await del(H(who), A, victim._id);
      check(`D delete: ${name} -> 403 and the document still exists`, r.status === 403 && Boolean(await KnowledgeDocument.findById(victim._id)));
    }
    r = await del(H(adminB), B, victim._id);
    check("D delete: B's admin cannot delete A's document (404)", r.status === 404 && Boolean(await KnowledgeDocument.findById(victim._id)));
    r = await del({}, A, victim._id);
    check("D delete: no token -> 401", r.status === 401);
    r = await del(H(admin), A, victim._id);
    check("D delete: the workspace's admin can (200)", r.status === 200 && !(await KnowledgeDocument.findById(victim._id)));
    check("D: error responses never expose document content or PII", leaks((await patch(H(viewer), A)).raw).length === 0 && leaks((await del(H(operator), A, docA._id)).raw).length === 0);

    // ================================================================ E. operational import (workspace:admin)
    const csv = "foo,bar\n1,2\n";
    const importReq = (headers, ws, extra = "", propertyId = propA._id) => {
      const form = new FormData();
      form.append("workspaceId", ws);
      form.append("propertyId", String(propertyId));
      form.append("file", new Blob([csv], { type: "text/csv" }), "p13.csv");
      return call("POST", `/imports/operational?x=1${extra}`, { headers, form });
    };
    const guestsBefore = await Guest.countDocuments({ workspaceId: { $in: ids.workspaces } });
    const staysBefore = await Stay.countDocuments({ workspaceId: { $in: ids.workspaces } });
    const batchesBefore = await ImportBatch.countDocuments({ workspaceId: { $in: ids.workspaces } });
    await matrix("E import", importReq, { roles: ["admin"], denyHitsAi: false });
    r = await importReq(H(admin), A);
    check("E import: an admin passes authorization (a malformed CSV then ends in an import validation error, not an auth error)", r.status !== 401 && r.status !== 403 && r.status !== 404, `HTTP ${r.status}`);
    r = await importReq(H(admin), B);
    check("E import: admin of A with FORM workspace B -> 404 (never imports into B)", r.status === 404);
    r = await importReq(H(adminB), B, "", propA._id);
    check("E import: B's admin naming A's PROPERTY cannot reach A (no writes)", r.status !== 201);
    r = await importReq(H(admin), A, `&workspaceId=${B}`);
    check("E import: a query workspaceId does not override the form selector", r.status !== 401 && r.status !== 403 && r.status !== 404);
    check("E import: no Guest, Stay or (successful) import in ANY throwaway workspace changed", (await Guest.countDocuments({ workspaceId: { $in: ids.workspaces } })) === guestsBefore && (await Stay.countDocuments({ workspaceId: { $in: ids.workspaces } })) === staysBefore && (await Guest.countDocuments({ workspaceId: wsB._id })) === 0);
    check("E import: the seeded Guest's PII is unchanged", (await Guest.findById(guest._id).lean()).email === PII.email);
    const denied = await importReq(H(operator), A);
    check("E import: an authorization error carries no Guest/Stay PII", denied.status === 403 && leaks(denied.raw).length === 0);
    void batchesBefore;

    // ================================================================ reads were hardened in Phase 14
    for (const [method, url, label] of [
      ["GET", `/intelligence?workspaceId=${A}`, "raw GET /intelligence"],
      ["GET", `/knowledge-documents?workspaceId=${A}`, "GET /knowledge-documents"],
      ["GET", `/knowledge-documents/${docA._id}/chunks?workspaceId=${A}`, "GET /knowledge-documents/:id/chunks"],
    ]) {
      const res = await call(method, url);
      check(`${label} now requires authentication (Phase 14; detailed in validate-phase14-authorization)`, res.status === 401, `HTTP ${res.status}`);
    }

    // ================================================================ database integrity
    const after = await counts();
    const drift = Object.keys(before).filter((k) => before[k] !== after[k]);
    check("DB: every PRE-EXISTING record count is identical (Users and Memberships included: none were created outside this suite's own fixtures)", drift.length === 0, drift.map((k) => `${k}:${before[k]}->${after[k]}`).join(","));
    check("DB: no Decision, Action or Outcome exists in this suite's workspaces", (await Decision.countDocuments({ workspaceId: { $in: ids.workspaces } })) + (await Action.countDocuments({ workspaceId: { $in: ids.workspaces } })) + (await Outcome.countDocuments({ workspaceId: { $in: ids.workspaces } })) === 0);
    check("AI: every AI-service request came from an AUTHORIZED request to the trap (no real provider exists in this suite)", trapReqs.every((t) => t.url.startsWith("/v1/")));
    console.log(`      trap requests received: ${trapReqs.length}`);
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
  if (failed > 0) process.exit(1);
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
