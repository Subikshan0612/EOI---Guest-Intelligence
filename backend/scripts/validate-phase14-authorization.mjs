/**
 * Phase 14 validation: raw Intelligence reads, knowledge reads, import reads, and the retired
 * raw Intelligence write.
 *
 *   GET  /api/intelligence, /api/intelligence/:id           authenticate -> membership -> intelligence:view -> ceiling
 *   GET  /api/knowledge-documents, /:id, /:id/chunks        same chain (chunks: NO embedding vectors)
 *   GET  /api/imports/:id                                   authenticate -> membership -> operations:view
 *   POST /api/intelligence                                  RETIRED (no route)
 *
 * REAL HTTP against REAL spawned backends (one whose process fallback level is the HIGHEST, so any
 * use of it for an authenticated caller leaks; one whose fallback is the LOWEST), REAL stored users,
 * memberships and stub-signed tokens. AI_SERVICE_URL is a TRAP: nothing may reach it (no generation
 * happens in this suite). Data is synthetic, in throwaway workspaces, removed at the end; real record
 * counts are compared before and after.
 */
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { signStubToken, STUB_ISSUER } from "../src/auth/stubTokenVerifier.js";
import * as Models from "../src/models/index.js";
import { Guest, ImportBatch, Intelligence, KnowledgeChunk, KnowledgeDocument, Property, Signal, Stay, User, Workspace, WorkspaceMembership } from "../src/models/index.js";
import { bearer, cleanupAuthFixtures, createActor } from "./lib/authFixtures.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, "..", "server.js");
const HIGH = { port: 5082, fallback: "restricted", base: "http://localhost:5082/api" };
const LOW = { port: 5083, fallback: "guest", base: "http://localhost:5083/api" };
const TRAP_PORT = 5084;

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

async function call(server, method, url, headers = {}, body) {
  const response = await fetch(`${server.base}${url}`, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const raw = await response.text();
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {
    json = null;
  }
  return { status: response.status, json, raw, data: json?.data, code: json?.details?.code };
}

async function waitForHealth(server, timeoutMs = 20000) {
  const start = Date.now();
  for (;;) {
    try {
      if ((await fetch(`${server.base}/health`)).ok) return;
    } catch {
      // not ready
    }
    if (Date.now() - start > timeoutMs) throw new Error(`server ${server.port} not healthy`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

const M = { first: "Zyxwvu", last: "Qponmlk", email: "zyxwvu.p14@example.invalid", provider: "provider-p14-secret", model: "model-p14-secret", docId: "doc-p14-internal-id", chunkText: "CHUNKTEXT-P14-SECRET" };
const leaks = (raw, extra = []) => [...Object.values(M), ...extra].filter((v) => raw.toLowerCase().includes(String(v).toLowerCase()));
const keyPaths = (v, p = "") => (Array.isArray(v) ? v.flatMap((x, i) => keyPaths(x, `${p}[${i}]`)) : v && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => [`${p}.${k}`, ...keyPaths(x, `${p}.${k}`)]) : []);
const ids = { workspaces: [] };

async function cleanup() {
  await connectDatabase();
  await cleanupAuthFixtures();
  const ws = { $in: ids.workspaces };
  await Promise.all([Intelligence.deleteMany({ workspaceId: ws }), Signal.deleteMany({ workspaceId: ws }), Stay.deleteMany({ workspaceId: ws }), Guest.deleteMany({ workspaceId: ws }), KnowledgeChunk.deleteMany({ workspaceId: ws }), KnowledgeDocument.deleteMany({ workspaceId: ws }), ImportBatch.deleteMany({ workspaceId: ws }), Property.deleteMany({ workspaceId: ws }), WorkspaceMembership.deleteMany({ workspaceId: ws })]);
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
  const children = [HIGH, LOW].map((server) =>
    spawn(process.execPath, [SERVER_ENTRY], {
      env: { ...process.env, PORT: String(server.port), LLM_PROVIDER: "test-python", AI_SERVICE_URL: `http://localhost:${TRAP_PORT}`, KNOWLEDGE_DEV_AUTHORIZED_LEVEL: server.fallback },
      stdio: "ignore",
    }),
  );

  try {
    await Promise.all([waitForHealth(HIGH), waitForHealth(LOW)]);
    check("two ephemeral servers healthy (stub authentication; dev fallback: restricted / guest)", true);
    await connectDatabase();
    await Promise.all([User.init(), WorkspaceMembership.init(), Intelligence.init()]);

    const mkWs = async (label, status = "active") => {
      const doc = await Workspace.create({ name: `P14 ${label} ${stamp}`, slug: `p14-${label}-${stamp}`, status });
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
    const NAMES = ["Guest", "Stay", "Signal", "Intelligence", "Property", "KnowledgeDocument", "KnowledgeChunk", "ImportBatch", "Decision", "Action", "Outcome", "Conversation", "Message"];
    const realCounts = async () => Object.fromEntries(await Promise.all(NAMES.map(async (n) => [n, await Models[n].countDocuments({ workspaceId: { $nin: OWN } }).catch(() => -1)])));
    const before = await realCounts();
    const usersBefore = await User.countDocuments({});
    const membershipsBefore = await WorkspaceMembership.countDocuments({});

    // ------------------------------------------------ fixtures
    const property = await Property.create({ workspaceId: wsA._id, name: `P14 Property ${stamp}`, code: `P14-${stamp}` });
    const propertyB = await Property.create({ workspaceId: wsB._id, name: `P14 PropertyB ${stamp}`, code: `P14B-${stamp}` });
    const guest = await Guest.create({ workspaceId: wsA._id, firstName: M.first, lastName: M.last, email: M.email });
    const stay = await Stay.create({ workspaceId: wsA._id, guestId: guest._id, propertyId: property._id, reservationId: `RSV-P14-${stamp}`, status: "confirmed", checkIn: new Date("2030-01-01"), checkOut: new Date("2030-01-03") });
    const mkSignal = (ws, title, extra = {}) => Signal.create({ workspaceId: ws._id, type: "maintenance", severity: "high", title, ...extra });
    const s1 = await mkSignal(wsA, "P14 S1", { propertyId: property._id, guestId: guest._id, stayId: stay._id });
    const s3 = await mkSignal(wsA, "P14 S3", { propertyId: property._id });
    const sB = await mkSignal(wsB, "P14 SB");
    const v1 = (ws, signal, level, extra = {}) =>
      Intelligence.create({
        workspaceId: ws._id, signalIds: [signal._id], propertyId: ws === wsA ? property._id : undefined, guestId: ws === wsA ? guest._id : undefined, stayId: ws === wsA ? stay._id : undefined,
        generatedBy: "llm", provider: M.provider, model: M.model,
        analysis: { situation: `SITUATION-${level}`, evidence: [`EVIDENCE-${level}`], impact: `IMPACT-${level}`, recommendation: `RECOMMENDATION-${level}`, confidence: "medium" },
        analysisVersion: "intelligence-v1", analysisLevel: level, knowledgeVisibility: level === "guest" ? undefined : level,
        knowledgeProvenance: [{ chunkId: "chunk-p14-1", knowledgeDocumentId: M.docId, version: 1, scope: "property", section: `Section ${level}`, sectionPath: [`Section ${level}`], visibility: level, chunkIndex: 0, similarityScore: 0.5, retrievalScore: 0.8 }],
        ...extra,
      });
    const iGuest = await v1(wsA, s1, "guest");
    const iStaff = await v1(wsA, s1, "staff");
    const iRestricted = await v1(wsA, s3, "restricted");
    const iB = await v1(wsB, sB, "guest");
    // a legacy (pre-V1) record: no analysis, no level, no knowledge
    const iLegacy = await Intelligence.create({ workspaceId: wsA._id, signalIds: [s3._id], guestId: guest._id, generatedBy: "llm", provider: M.provider, model: M.model, intelligence: { summary: "LEGACY-P14 summary" }, risk: { level: "low", reason: "r" } });
    const totalA = { viewer: 2, operator: 3, admin: 4 }; // guest V1 + legacy | + staff | + restricted

    const actor = (role, ws = wsA, label = "p14") => createActor({ role, workspaceId: ws._id, label });
    const viewer = await actor("viewer");
    const operator = await actor("operator");
    const reviewer = await actor("reviewer");
    const admin = await actor("admin");
    const adminB = await actor("admin", wsB);
    const outsider = await createActor({ label: "p14-outsider" });
    const revoked = await actor("operator", wsA, "p14-revoked");
    await WorkspaceMembership.updateOne({ _id: revoked.membership._id }, { $set: { status: "revoked" } });
    const disabled = await actor("operator", wsA, "p14-disabled");
    await User.updateOne({ _id: disabled.user._id }, { $set: { status: "disabled" } });
    const suspendedAdmin = await createActor({ role: "admin", workspaceId: wsS._id, label: "p14-suspended" });
    const unregistered = bearer(signStubToken({ iss: STUB_ISSUER, sub: `never-provisioned-${stamp}`, exp: Math.floor(Date.now() / 1000) + 600 }, process.env.AUTH_STUB_SECRET));
    const exp = () => Math.floor(Date.now() / 1000) + 600;
    const H = (who) => who.headers;

    // knowledge: three documents (guest / staff / restricted default visibility), chunked through the real admin API
    const docs = {};
    for (const level of ["guest", "staff", "restricted"]) {
      const created = await call(HIGH, "POST", "/knowledge-documents", H(admin), { workspaceId: A, title: `P14 ${level} doc`, documentType: "sop", isTestData: true, defaultVisibility: level, content: `# ${level} heading\n\n${M.chunkText} for ${level}` });
      docs[level] = created.data;
      const chunked = await call(HIGH, "POST", `/knowledge-documents/${created.data._id}/chunks?workspaceId=${A}`, H(admin));
      check(`FX: ${level} document created and chunked through the admin API`, created.status === 201 && chunked.status < 300, `${created.status}/${chunked.status}`);
    }
    const vecUpdate = await KnowledgeChunk.updateMany({ workspaceId: wsA._id }, { $set: { embedding: [0.1234567, 0.7654321, 0.5], embeddingModel: "embed-p14", embeddingInputVersion: 1 } });
    check("FX: embeddings were stored on the fixture chunks (in MongoDB)", vecUpdate.modifiedCount >= 3, `modified ${vecUpdate.modifiedCount}`);
    const batch = await ImportBatch.create({ workspaceId: wsA._id, propertyId: property._id, filename: "p14.csv", status: "completed" });
    const batchB = await ImportBatch.create({ workspaceId: wsB._id, propertyId: propertyB._id, filename: "p14b.csv", status: "completed" });

    const rawList = (server, who, ws = A, q = "") => call(server, "GET", `/intelligence?workspaceId=${ws}${q}`, who ? H(who) : {});
    const rawGet = (server, who, id, ws = A) => call(server, "GET", `/intelligence/${id}?workspaceId=${ws}`, who ? H(who) : {});

    // ================================================ 1. identity (all six read routes)
    const routes = [
      ["intelligence list", () => `/intelligence?workspaceId=${A}`],
      ["intelligence detail", () => `/intelligence/${iGuest._id}?workspaceId=${A}`],
      ["knowledge list", () => `/knowledge-documents?workspaceId=${A}`],
      ["knowledge detail", () => `/knowledge-documents/${docs.guest._id}?workspaceId=${A}`],
      ["knowledge chunks", () => `/knowledge-documents/${docs.guest._id}/chunks?workspaceId=${A}`],
      ["import detail", () => `/imports/${batch._id}?workspaceId=${A}`],
    ];
    for (const server of [HIGH, LOW]) {
      const tag = server.fallback;
      for (const [label, url] of routes) {
        let r = await call(server, "GET", url());
        check(`ID1 [${tag}] ${label}: no token -> 401`, r.status === 401 && r.code === "MISSING_CREDENTIAL", `HTTP ${r.status}`);
        for (const [name, headers] of [["invalid", bearer("not.a.token")], ["malformed", { authorization: "Basic abc" }], ["expired", bearer(signStubToken({ iss: STUB_ISSUER, sub: viewer.user.subject, exp: Math.floor(Date.now() / 1000) - 30 }, process.env.AUTH_STUB_SECRET))], ["wrong signature", bearer(signStubToken({ iss: STUB_ISSUER, sub: viewer.user.subject, exp: exp() }, "a-different-secret-not-real-0123456789"))]]) {
          r = await call(server, "GET", url(), headers);
          check(`ID2 [${tag}] ${label}: ${name} credential -> 401`, r.status === 401, `HTTP ${r.status}`);
        }
        r = await call(server, "GET", url(), unregistered);
        check(`ID3 [${tag}] ${label}: unregistered identity -> 403`, r.status === 403 && r.code === "IDENTITY_NOT_REGISTERED");
        r = await call(server, "GET", url(), H(disabled));
        check(`ID4 [${tag}] ${label}: disabled user -> 403`, r.status === 403);
        r = await call(server, "GET", url(), H(revoked));
        check(`ID5 [${tag}] ${label}: revoked membership -> 404`, r.status === 404);
        r = await call(server, "GET", url(), H(outsider));
        check(`ID6 [${tag}] ${label}: non-member -> 404`, r.status === 404);
        r = await call(server, "GET", url().replace(`workspaceId=${A}`, `workspaceId=${S}`), H(suspendedAdmin));
        check(`ID7 [${tag}] ${label}: member of a SUSPENDED workspace -> 404`, r.status === 404);
        r = await call(server, "GET", url().replace(`workspaceId=${A}`, `workspaceId=${B}`), H(admin));
        check(`ID8 [${tag}] ${label}: admin of A selecting workspace B -> 404 (cross-workspace, no existence leak)`, r.status === 404);
        r = await call(server, "GET", url().replace(`?workspaceId=${A}`, ""), H(admin));
        check(`ID9 [${tag}] ${label}: missing workspaceId -> clean 400`, r.status === 400);
      }
    }
    check("ID10: nothing was auto-provisioned for the unregistered identity", (await User.countDocuments({ subject: `never-provisioned-${stamp}` })) === 0);

    // ================================================ 2. raw Intelligence: role ceiling
    const ceilings = { viewer: [viewer, ["SITUATION-guest", "LEGACY-P14"], ["SITUATION-staff", "SITUATION-restricted"]], operator: [operator, ["SITUATION-guest", "SITUATION-staff", "LEGACY-P14"], ["SITUATION-restricted"]], reviewer: [reviewer, ["SITUATION-guest", "SITUATION-staff", "LEGACY-P14"], ["SITUATION-restricted"]], admin: [admin, ["SITUATION-guest", "SITUATION-staff", "SITUATION-restricted", "LEGACY-P14"], []] };
    for (const server of [HIGH, LOW]) {
      const tag = `fallback=${server.fallback}`;
      for (const [role, [who, seen, hidden]] of Object.entries(ceilings)) {
        const l = await rawList(server, who);
        check(`IN1 [${tag}] ${role}: list is 200 with the ceiling's records`, l.status === 200 && seen.every((s) => l.raw.includes(s)) && hidden.every((h) => !l.raw.includes(h)) && l.data.length === (totalA[role === "reviewer" ? "operator" : role]), `HTTP ${l.status} n=${l.data?.length}`);
        check(`IN2 [${tag}] ${role}: pagination total respects the ceiling`, l.json?.pagination?.total === totalA[role === "reviewer" ? "operator" : role], JSON.stringify(l.json?.pagination));
        check(`IN3 [${tag}] ${role}: never another workspace's record`, !l.raw.includes(String(iB._id)) && !l.raw.includes(B));
      }
      const g = { guest: iGuest, staff: iStaff, restricted: iRestricted, legacy: iLegacy };
      for (const [name, rec] of Object.entries(g)) {
        const allowed = { guest: ["viewer", "operator", "reviewer", "admin"], legacy: ["viewer", "operator", "reviewer", "admin"], staff: ["operator", "reviewer", "admin"], restricted: ["admin"] }[name];
        for (const [role, [who]] of Object.entries(ceilings)) {
          const d = await rawGet(server, who, rec._id);
          check(`IN4 [${tag}] ${role}: detail of the ${name} record -> ${allowed.includes(role) ? 200 : 404}`, d.status === (allowed.includes(role) ? 200 : 404), `HTTP ${d.status}`);
        }
      }
      check(`IN5 [${tag}] a hidden record and a missing record both 404 with the same message`, (await rawGet(server, viewer, iRestricted._id)).json?.message === (await rawGet(server, viewer, "6aa29b8d18df3e22b3e89c99")).json?.message);
      check(`IN6 [${tag}] cross-workspace detail -> 404`, (await rawGet(server, admin, iB._id)).status === 404 && (await rawGet(server, adminB, iGuest._id, B)).status === 404);
    }

    // ================================================ 3. forged elevation (headers, query, claims, cookies)
    const forgedHeaders = { "x-knowledge-level": "restricted", "x-authorized-level": "restricted", "x-role": "admin", "x-user-role": "admin", "x-permissions": "workspace:admin", "x-workspace-id": B, cookie: "role=admin; level=restricted" };
    for (const server of [HIGH, LOW]) {
      const tag = `fallback=${server.fallback}`;
      const l = await call(server, "GET", `/intelligence?workspaceId=${A}&authorizedLevel=restricted&knowledgeLevel=restricted&role=admin&permissions=workspace:admin`, { ...H(viewer), ...forgedHeaders });
      check(`FG1 [${tag}] viewer + forged headers/query -> still guest ceiling`, l.status === 200 && l.data.length === 2 && !l.raw.includes("SITUATION-staff") && !l.raw.includes("SITUATION-restricted"));
      const d = await call(server, "GET", `/intelligence/${iRestricted._id}?workspaceId=${A}&authorizedLevel=restricted`, { ...H(operator), ...forgedHeaders });
      check(`FG2 [${tag}] operator + forged elevation cannot read a restricted record`, d.status === 404);
      const forgedTok = bearer(signStubToken({ iss: STUB_ISSUER, sub: viewer.user.subject, email: viewer.user.email, exp: exp(), role: "admin", permissions: ["workspace:admin"], knowledgeLevel: "restricted", workspaceId: B, authorizedLevel: "restricted" }, process.env.AUTH_STUB_SECRET));
      const t = await call(server, "GET", `/intelligence?workspaceId=${A}`, forgedTok);
      check(`FG3 [${tag}] a token claiming role/permissions/level/workspace does not elevate a viewer`, t.status === 200 && t.data.length === 2 && !t.raw.includes("SITUATION-restricted"));
      const kd = await call(server, "GET", `/knowledge-documents?workspaceId=${A}&authorizedLevel=restricted`, { ...H(viewer), ...forgedHeaders });
      check(`FG4 [${tag}] knowledge list: viewer + forged elevation still sees only the guest document`, kd.status === 200 && kd.data.length === 1 && kd.data[0]._id === docs.guest._id);
      const imp = await call(server, "GET", `/imports/${batch._id}?workspaceId=${A}`, { ...H(viewer), ...forgedHeaders });
      check(`FG5 [${tag}] import read: viewer + forged admin headers -> 403`, imp.status === 403);
    }

    // ================================================ 4. raw Intelligence privacy (E)
    const adminList = await rawList(HIGH, admin);
    const adminDetail = await rawGet(HIGH, admin, iRestricted._id);
    for (const [label, res] of [["list", adminList], ["detail", adminDetail]]) {
      check(`PV1 ${label}: no provider, model, guest name/email, internal document id`, leaks(res.raw).filter((x) => x !== M.chunkText).length === 0, leaks(res.raw).join(","));
      check(`PV2 ${label}: no guestId / stayId / knowledgeDocumentId / similarityScore / token material`, !res.raw.includes(String(guest._id)) && !res.raw.includes(String(stay._id)) && !/"(guestId|stayId|provider|model|knowledgeDocumentId|similarityScore|embedding|prompt|password|token|issuer|subject|apiKey)"/i.test(res.raw));
    }
    const v1Rec = adminDetail.data;
    check("PV3 detail keeps the V1 shape: situation, evidence, impact, recommendation, confidence + versions/levels", v1Rec.analysis?.situation === "SITUATION-restricted" && v1Rec.analysis.evidence.length === 1 && v1Rec.analysis.impact && v1Rec.analysis.recommendation && v1Rec.analysis.confidence === "medium" && v1Rec.analysisVersion === "intelligence-v1" && v1Rec.analysisLevel === "restricted" && v1Rec.knowledgeVisibility === "restricted");
    check("PV4 provenance is limited to chunkId, section, sectionPath, visibility, retrievalScore", v1Rec.knowledgeProvenance.length === 1 && Object.keys(v1Rec.knowledgeProvenance[0]).sort().join(",") === "chunkId,retrievalScore,section,sectionPath,visibility", Object.keys(v1Rec.knowledgeProvenance[0]).join(","));
    check("PV5 the whole record has no forbidden keys and a closed top-level set", ["provider", "model", "guestId", "stayId", "knowledgeDocumentId", "similarityScore", "chunkIndex", "scope", "version"].every((k) => !keyPaths(v1Rec).some((p) => p.endsWith(`.${k}`))) && Object.keys(v1Rec).every((k) => ["_id", "workspaceId", "signalIds", "propertyId", "conversationId", "generatedBy", "analysisVersion", "analysisLevel", "knowledgeVisibility", "analysis", "knowledgeProvenance", "signal", "context", "intelligence", "risk", "decision", "action", "outcome", "confidence", "createdAt", "updatedAt"].includes(k)), Object.keys(v1Rec).join(","));

    // ================================================ 5. knowledge documents / chunks
    for (const server of [HIGH, LOW]) {
      const tag = `fallback=${server.fallback}`;
      const expectDocs = { viewer: 1, operator: 2, reviewer: 2, admin: 3 };
      for (const [role, [who]] of Object.entries(ceilings)) {
        const l = await call(server, "GET", `/knowledge-documents?workspaceId=${A}&limit=50`, H(who));
        check(`KN1 [${tag}] ${role}: knowledge list shows ${expectDocs[role]} document(s)`, l.status === 200 && l.data.length === expectDocs[role], `n=${l.data?.length}`);
        for (const level of ["guest", "staff", "restricted"]) {
          const allowed = { viewer: ["guest"], operator: ["guest", "staff"], reviewer: ["guest", "staff"], admin: ["guest", "staff", "restricted"] }[role].includes(level);
          const d = await call(server, "GET", `/knowledge-documents/${docs[level]._id}?workspaceId=${A}`, H(who));
          const c = await call(server, "GET", `/knowledge-documents/${docs[level]._id}/chunks?workspaceId=${A}`, H(who));
          check(`KN2 [${tag}] ${role}: ${level} document detail ${allowed ? "200" : "404"}`, d.status === (allowed ? 200 : 404), `HTTP ${d.status}`);
          check(`KN3 [${tag}] ${role}: ${level} document chunks ${allowed ? "200 (chunks returned)" : "404"}`, c.status === (allowed ? 200 : 404) && (!allowed || c.data.length >= 1), `HTTP ${c.status}`);
          if (c.status === 200) {
            check(`KN4 [${tag}] ${role}: ${level} chunks carry NO embedding vector`, !/"embedding"|0\.1234567|0\.7654321/.test(c.raw), "");
          }
        }
        const cross = await call(server, "GET", `/knowledge-documents/${docs.guest._id}/chunks?workspaceId=${B}`, H(adminB));
        check(`KN5 [${tag}] cross-workspace chunk read -> 404`, cross.status === 404);
      }
    }
    const chunkAdmin = await call(HIGH, "GET", `/knowledge-documents/${docs.restricted._id}/chunks?workspaceId=${A}`, H(admin));
    check("KN6 admin chunks: text still returned (at the restricted ceiling) and pagination intact", chunkAdmin.data[0].text.includes(M.chunkText) && chunkAdmin.json.pagination.total >= 1);
    const stored = await KnowledgeChunk.findOne({ documentId: docs.restricted._id }).select("+embedding").lean();
    check("KN7 the vectors REMAIN in MongoDB (not deleted, not re-embedded)", Array.isArray(stored.embedding) && stored.embedding.length === 3 && stored.embeddingModel === "embed-p14");
    const docDetail = await call(HIGH, "GET", `/knowledge-documents/${docs.restricted._id}?workspaceId=${A}`, H(admin));
    check("KN8 document detail carries no embedding vector either", !/"embedding"\s*:\s*\[/.test(docDetail.raw));

    // ================================================ 6. import reads: operations:view
    for (const server of [HIGH, LOW]) {
      const tag = `fallback=${server.fallback}`;
      const rd = async (who, id = batch._id, ws = A) => call(server, "GET", `/imports/${id}?workspaceId=${ws}`, H(who));
      check(`IM1 [${tag}] viewer -> 403 (no operations:view)`, (await rd(viewer)).status === 403);
      for (const [role, who] of [["operator", operator], ["reviewer", reviewer], ["admin", admin]]) {
        const r = await rd(who);
        check(`IM2 [${tag}] ${role} -> 200 with the batch`, r.status === 200 && r.data._id === String(batch._id) && r.data.filename === "p14.csv", `HTTP ${r.status}`);
      }
      check(`IM3 [${tag}] cross-workspace: admin of A reading B's batch -> 404; B's admin reading A's batch -> 404`, (await rd(admin, batchB._id)).status === 404 && (await rd(adminB, batch._id, B)).status === 404 && (await rd(admin, batchB._id, B)).status === 404);
      check(`IM4 [${tag}] a non-member gets 404`, (await rd(outsider)).status === 404);
    }
    const impRaw = await call(HIGH, "GET", `/imports/${batch._id}?workspaceId=${A}`, H(admin));
    check("IM5 the import read carries no PII, credential or token material", leaks(impRaw.raw).length === 0 && !/"(password|token|issuer|subject|apiKey)"/i.test(impRaw.raw));
    check("IM6 the import creation route is unchanged (authenticated: 401 without a token)", (await fetch(`${HIGH.base}/imports/operational`, { method: "POST" })).status === 401);

    // ================================================ 7. the raw Intelligence WRITE is retired
    const beforeIntel = await Intelligence.countDocuments({});
    for (const server of [HIGH, LOW]) {
      const tag = `fallback=${server.fallback}`;
      for (const [label, headers] of [["no token", {}], ["viewer", H(viewer)], ["operator", H(operator)], ["admin", H(admin)]]) {
        const r = await call(server, "POST", "/intelligence", headers, { workspaceId: A, generatedBy: "llm", provider: "forged", analysis: { situation: "FORGED", evidence: ["x"], impact: "x", recommendation: "x", confidence: "high" }, analysisVersion: "intelligence-v1", analysisLevel: "guest", signalIds: [String(s1._id)] });
        check(`WR1 [${tag}] POST /intelligence (${label}) -> 404: the route no longer exists`, r.status === 404, `HTTP ${r.status}`);
      }
      for (const method of ["PUT", "PATCH", "DELETE"]) {
        const r = await call(server, method, `/intelligence/${iGuest._id}?workspaceId=${A}`, H(admin), { situation: "x" });
        check(`WR2 [${tag}] ${method} /intelligence/:id is not a route (404)`, r.status === 404, `HTTP ${r.status}`);
      }
    }
    check("WR3 no Intelligence record was created or changed by the rejected writes", (await Intelligence.countDocuments({})) === beforeIntel && !(await Intelligence.exists({ provider: "forged" })) && !(await Intelligence.exists({ "analysis.situation": "FORGED" })));
    const analyze = await call(HIGH, "POST", `/intelligence/analyze/${s1._id}?workspaceId=${A}`, H(viewer));
    check("WR4 the grounded generation path is still permission-gated (viewer -> 403) and reaches no AI service", analyze.status === 403 && trapHits.length === 0);

    // ================================================ 8. integrity
    const after = await realCounts();
    const drift = Object.keys(before).filter((k) => before[k] !== after[k]);
    check("DB1: every PRE-EXISTING record count is identical", drift.length === 0, drift.map((k) => `${k}:${before[k]}->${after[k]}`).join(","));
    check("DB2: no Decision, Action or Outcome exists in this suite's workspaces", (await Models.Decision.countDocuments({ workspaceId: { $in: OWN } })) + (await Models.Action.countDocuments({ workspaceId: { $in: OWN } })) + (await Models.Outcome.countDocuments({ workspaceId: { $in: OWN } })) === 0);
    check("DB3: this suite's Intelligence records are unchanged (4 V1 + 1 legacy in A/B)", (await Intelligence.countDocuments({ workspaceId: { $in: OWN } })) === 5);
    check("AI1: nothing reached the AI service (trap)", trapHits.length === 0, trapHits.join(","));
    void usersBefore;
    void membershipsBefore;
  } finally {
    for (const c of children) c.kill();
    await Promise.all(children.map((c) => new Promise((resolve) => c.once("exit", resolve))));
    trap.close();
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
    console.log(`\nPhase 14 authorization validation: ${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
