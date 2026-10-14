/**
 * Dashboard read authorization validation (Phase 10).
 *
 *   GET /api/dashboard/signals
 *   GET /api/dashboard/signals/:signalId
 *
 * now use the SAME chain as Decision V1: bearer token -> authenticate -> active
 * workspace membership -> `intelligence:view` -> the role's knowledge ceiling.
 * This suite drives REAL HTTP against REAL spawned backends with REAL stored users,
 * memberships and stub-signed tokens - no header, query parameter or environment
 * level is used to authenticate.
 *
 * Two servers: one whose process-wide KNOWLEDGE_DEV_AUTHORIZED_LEVEL is the HIGHEST
 * level (so any use of that fallback for an authenticated caller would leak) and one
 * whose fallback is the LOWEST (so an admin reading restricted data proves the ROLE
 * decided). AI_SERVICE_URL points at a TRAP server: nothing may reach it. All data is
 * synthetic, in throwaway workspaces, and removed at the end; real records are counted
 * before and after.
 *
 * Not testable over HTTP: a request BODY on these GET routes (fetch cannot send one on
 * GET, and the routes ignore bodies), so elevation is exercised through the query
 * string, headers and forged token claims.
 */
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { signStubToken, STUB_ISSUER } from "../src/auth/stubTokenVerifier.js";
import * as Models from "../src/models/index.js";
import { Action, Decision, Guest, Intelligence, Outcome, Property, Signal, Stay, User, Workspace, WorkspaceMembership } from "../src/models/index.js";
import { bearer, cleanupAuthFixtures, createActor, tokenFor } from "./lib/authFixtures.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, "..", "server.js");
const HIGH = { port: 5077, fallback: "restricted", base: "http://localhost:5077/api" };
const LOW = { port: 5078, fallback: "guest", base: "http://localhost:5078/api" };
const TRAP_PORT = 5079;

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

async function call(server, method, url, headers = {}) {
  const response = await fetch(`${server.base}${url}`, { method, headers });
  const raw = await response.text();
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {
    json = null;
  }
  return { status: response.status, json, raw, data: json?.data, code: json?.details?.code, message: json?.message };
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

const M = { first: "Zyxwvu", last: "Qponmlk", email: "zyxwvu.qponmlk@example.invalid", phone: "7770009999", reservation: "RSV-DASHAUTH-SECRET-8841", provider: "provider-dashauth-secret", model: "model-dashauth-secret", chunk: "CHUNK-TEXT-DASHAUTH-SECRET" };
const leaks = (raw) => Object.values(M).filter((v) => raw.toLowerCase().includes(v.toLowerCase()));
const keyPaths = (v, p = "") => (Array.isArray(v) ? v.flatMap((x, i) => keyPaths(x, `${p}[${i}]`)) : v && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => [`${p}.${k}`, ...keyPaths(x, `${p}.${k}`)]) : []);

const ids = { workspaces: [], properties: [], signals: [], guests: [], stays: [], intelligences: [] };

async function cleanup() {
  await connectDatabase();
  await cleanupAuthFixtures();
  const ws = { $in: ids.workspaces };
  await Promise.all([Outcome.deleteMany({ workspaceId: ws }), Action.deleteMany({ workspaceId: ws }), Decision.deleteMany({ workspaceId: ws })]);
  await Promise.all([Intelligence.deleteMany({ workspaceId: ws }), Signal.deleteMany({ workspaceId: ws }), Stay.deleteMany({ workspaceId: ws }), Guest.deleteMany({ workspaceId: ws }), Property.deleteMany({ workspaceId: ws }), WorkspaceMembership.deleteMany({ workspaceId: ws })]);
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

    // ------------------------------------------------ fixtures
    const mkWs = async (label, status = "active") => {
      const doc = await Workspace.create({ name: `DashAuth ${label} ${stamp}`, slug: `dashauth-${label}-${stamp}`, status });
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
    const realCounts = async () => Object.fromEntries(await Promise.all(["Guest", "Stay", "Signal", "Intelligence", "Property", "Unit", "KnowledgeDocument", "KnowledgeChunk", "ImportBatch"].map(async (n) => [n, await Models[n].countDocuments({ workspaceId: { $nin: OWN } }).catch(() => Models[n].countDocuments({})) ]).concat(["Decision", "Action", "Outcome"].map(async (n) => [n, await Models[n].countDocuments({ workspaceId: { $nin: OWN } })]))));
    const unitsBefore = await Models.Unit.countDocuments({});
    const before = await realCounts();

    const property = await Property.create({ workspaceId: wsA._id, name: `DashAuth Property ${stamp}`, code: `DAU-${stamp}` });
    ids.properties.push(property._id);
    const guest = await Guest.create({ workspaceId: wsA._id, firstName: M.first, lastName: M.last, email: M.email, phone: M.phone });
    ids.guests.push(guest._id);
    const stay = await Stay.create({ workspaceId: wsA._id, guestId: guest._id, propertyId: property._id, reservationId: M.reservation, status: "confirmed", checkIn: new Date("2030-01-01"), checkOut: new Date("2030-01-03") });
    ids.stays.push(stay._id);
    const mkSignal = async (workspace, title, severity = "medium", extra = {}) => {
      const signal = await Signal.create({ workspaceId: workspace._id, type: "maintenance", severity, title, propertyId: workspace === wsA ? property._id : undefined, ...extra });
      ids.signals.push(signal._id);
      return signal;
    };
    const s1 = await mkSignal(wsA, "DASHAUTH S1 guest+staff analysis", "high", { guestId: guest._id, stayId: stay._id });
    const s2 = await mkSignal(wsA, "DASHAUTH S2 no analysis", "low");
    const s3 = await mkSignal(wsA, "DASHAUTH S3 restricted-only analysis", "critical");
    const sB = await mkSignal(wsB, "DASHAUTH SB other tenant", "critical");
    const v1 = async (workspace, signal, level) => {
      const doc = await Intelligence.create({
        workspaceId: workspace._id,
        signalIds: [signal._id],
        propertyId: workspace === wsA ? property._id : undefined,
        generatedBy: "llm",
        provider: M.provider,
        model: M.model,
        analysis: { situation: `SITUATION-${level}`, evidence: [`EVIDENCE-${level}`], impact: `IMPACT-${level}`, recommendation: `RECOMMENDATION-${level} recommendation only.`, confidence: "medium" },
        analysisVersion: "intelligence-v1",
        analysisLevel: level,
        knowledgeVisibility: level === "guest" ? undefined : level,
        knowledgeProvenance: [{ chunkId: "chunk-dashauth-1", knowledgeDocumentId: "doc-x", version: 1, scope: "property", section: `Section ${level}`, sectionPath: [`Section ${level}`], visibility: level, chunkIndex: 0, similarityScore: 0.5, retrievalScore: 0.8 }],
      });
      ids.intelligences.push(doc._id);
      return doc;
    };
    const iGuest = await v1(wsA, s1, "guest");
    const iStaff = await v1(wsA, s1, "staff");
    await v1(wsA, s3, "restricted");
    await v1(wsB, sB, "guest");

    const actor = (role, ws = wsA, label = "dashauth") => createActor({ role, workspaceId: ws._id, label });
    const viewer = await actor("viewer");
    const operator = await actor("operator");
    const reviewer = await actor("reviewer");
    const admin = await actor("admin");
    const adminB = await actor("admin", wsB);
    const outsider = await createActor({ label: "dashauth-outsider" });
    const revoked = await actor("operator", wsA, "dashauth-revoked");
    await WorkspaceMembership.updateOne({ _id: revoked.membership._id }, { $set: { status: "revoked" } });
    const disabled = await actor("operator", wsA, "dashauth-disabled");
    await User.updateOne({ _id: disabled.user._id }, { $set: { status: "disabled" } });
    const suspendedAdmin = await createActor({ role: "admin", workspaceId: wsS._id, label: "dashauth-suspended" });
    const unregistered = bearer(signStubToken({ iss: STUB_ISSUER, sub: `never-provisioned-${stamp}`, exp: Math.floor(Date.now() / 1000) + 600 }, process.env.AUTH_STUB_SECRET));
    const H = (who) => who.headers;
    const list = (server, who, ws = A, q = "") => call(server, "GET", `/dashboard/signals?workspaceId=${ws}${q}`, who ? H(who) : {});
    const detail = (server, who, id, ws = A) => call(server, "GET", `/dashboard/signals/${id}?workspaceId=${ws}`, who ? H(who) : {});
    const byId = (res, id) => res.data.find((x) => x.id === String(id));

    // ------------------------------------------------ 1. authentication (1, 2, 3)
    for (const server of [HIGH, LOW]) {
      const tag = server.fallback;
      let r = await call(server, "GET", `/dashboard/signals?workspaceId=${A}`);
      check(`AU1 [${tag}]: list without a token -> 401`, r.status === 401 && r.code === "MISSING_CREDENTIAL");
      r = await call(server, "GET", `/dashboard/signals/${s1._id}?workspaceId=${A}`);
      check(`AU2 [${tag}]: detail without a token -> 401`, r.status === 401 && r.code === "MISSING_CREDENTIAL");
      for (const [name, headers] of [["invalid", bearer("not.a.token")], ["malformed", { authorization: "Basic abc" }], ["bare 'Bearer'", { authorization: "Bearer" }], ["expired", bearer(signStubToken({ iss: STUB_ISSUER, sub: viewer.user.subject, exp: Math.floor(Date.now() / 1000) - 30 }, process.env.AUTH_STUB_SECRET))], ["wrong signature", bearer(signStubToken({ iss: STUB_ISSUER, sub: viewer.user.subject, exp: Math.floor(Date.now() / 1000) + 600 }, "a-different-secret-not-real-0123456789"))]]) {
        const l = await call(server, "GET", `/dashboard/signals?workspaceId=${A}`, headers);
        const d = await call(server, "GET", `/dashboard/signals/${s1._id}?workspaceId=${A}`, headers);
        check(`AU3 [${tag}]: ${name} credential -> 401 (list and detail)`, l.status === 401 && d.status === 401, `${l.status}/${d.status}`);
      }
      r = await call(server, "GET", `/dashboard/signals?workspaceId=${A}`, unregistered);
      check(`AU4 [${tag}]: valid token, unregistered identity -> 403`, r.status === 403 && r.code === "IDENTITY_NOT_REGISTERED");
    }
    check("AU5: nothing was auto-provisioned", (await User.countDocuments({ subject: `never-provisioned-${stamp}` })) === 0);

    // ------------------------------------------------ 2. every role can read (4-7)
    const roles = { viewer, operator, reviewer, admin };
    for (const [role, who] of Object.entries(roles)) {
      const l = await list(HIGH, who);
      const d = await detail(HIGH, who, s1._id);
      check(`RL1: ${role} can read the list and the detail`, l.status === 200 && d.status === 200 && l.data.length === 3 && d.data.signal.id === String(s1._id), `${l.status}/${d.status}`);
    }

    // ------------------------------------------------ 3. knowledge ceiling from the ROLE (8-10, 16)
    for (const server of [HIGH, LOW]) {
      const tag = `fallback=${server.fallback}`;
      const vl = await list(server, viewer);
      const vd = await detail(server, viewer, s1._id);
      check(`KC1 [${tag}]: viewer (guest) gets the guest-level analysis only`, byId(vl, s1._id).intelligence?.id === String(iGuest._id) && vd.data.intelligence.situation === "SITUATION-guest" && !vd.raw.includes("SITUATION-staff") && !vd.raw.includes("EVIDENCE-staff") && !vd.raw.includes("Section staff"));
      check(`KC2 [${tag}]: viewer sees the restricted-only Signal with no analysis`, byId(vl, s3._id).intelligence === null && (await detail(server, viewer, s3._id)).data.intelligence === null);
      for (const role of ["operator", "reviewer"]) {
        const ol = await list(server, roles[role]);
        const od = await detail(server, roles[role], s1._id);
        check(`KC3 [${tag}]: ${role} (staff) gets the staff-level analysis`, byId(ol, s1._id).intelligence?.id === String(iStaff._id) && od.data.intelligence.situation === "SITUATION-staff" && !od.raw.includes("SITUATION-restricted"));
        check(`KC4 [${tag}]: ${role} cannot see the restricted-only analysis`, byId(ol, s3._id).intelligence === null && (await detail(server, roles[role], s3._id)).data.intelligence === null);
      }
      const al = await list(server, admin);
      const ad = await detail(server, admin, s3._id);
      check(`KC5 [${tag}]: admin (restricted) sees the restricted analysis`, byId(al, s3._id).intelligence !== null && ad.data.intelligence.situation === "SITUATION-restricted");
      const hi = async (who) => (await list(server, who, A, "&hasIntelligence=true")).data.map((x) => x.id).sort().join(",");
      check(`KC6 [${tag}]: the hasIntelligence filter respects the role (viewer 1, operator 1, admin 2)`, (await hi(viewer)).split(",").length === 1 && (await hi(operator)).split(",").length === 1 && (await hi(admin)).split(",").length === 2);
    }

    // ------------------------------------------------ 4. elevation / workspace override (11, 12)
    const forged = { "x-role": "admin", "x-permissions": "decision:review,action:execute", "x-permission": "decision:review", "x-knowledge-level": "restricted", "x-authorized-level": "restricted", "x-user-id": String(admin.user._id), "x-workspace-id": B, "x-forwarded-user": "admin" };
    let r = await call(HIGH, "GET", `/dashboard/signals/${s3._id}?workspaceId=${A}&role=admin&permission=intelligence:view&level=restricted&authorizedLevel=restricted&knowledgeLevel=restricted&userId=${admin.user._id}`, { ...H(viewer), ...forged });
    check("EL1: forged headers + query parameters cannot raise the viewer's level", r.status === 200 && r.data.intelligence === null);
    r = await call(HIGH, "GET", `/dashboard/signals?workspaceId=${A}&level=restricted&knowledgeLevel=restricted`, { ...H(viewer), ...forged });
    check("EL2: ...list too", r.status === 200 && byId(r, s3._id).intelligence === null && byId(r, s1._id).intelligence.id === String(iGuest._id));
    r = await call(HIGH, "GET", `/dashboard/signals/${s3._id}?workspaceId=${A}`, { authorization: `Bearer ${tokenFor(viewer.user, { role: "admin", roles: ["admin"], permissions: ["decision:review"], knowledgeLevel: "restricted", workspaceId: A, scope: "admin" })}` });
    check("EL3: role / permission / level / workspace CLAIMS inside a valid token change nothing", r.status === 200 && r.data.intelligence === null);
    r = await call(HIGH, "GET", `/dashboard/signals?workspaceId=${B}`, { ...H(viewer), ...forged });
    check("EL4: selecting another workspace (viewer is not in B) -> 404, headers cannot help", r.status === 404);
    r = await call(HIGH, "GET", `/dashboard/signals?workspaceId=${A}&workspaceId=${B}`, H(viewer));
    check("EL5: a duplicated workspaceId parameter grants nothing", r.status === 400 || r.status === 404, `HTTP ${r.status}`);
    r = await call(HIGH, "GET", `/dashboard/signals?workspaceId=${A}`, { ...H(viewer), "x-workspace-id": B });
    check("EL6: a workspace header does not override the query selection", r.status === 200 && r.data.every((x) => [s1, s2, s3].map((s) => String(s._id)).includes(x.id)));
    r = await detail(HIGH, adminB, sB._id, B);
    check("EL7: B's admin reads B's own Signal (sanity)", r.status === 200);
    r = await detail(HIGH, adminB, s1._id, B);
    const missing = await detail(HIGH, adminB, "000000000000000000000000", B);
    check("EL8: B's admin cannot read A's Signal even by selecting B (same 404 as a missing Signal)", r.status === 404 && r.message === missing.message);
    r = await detail(HIGH, adminB, s1._id, A);
    check("EL9: ...nor by selecting A (not a member -> 404)", r.status === 404);
    r = await list(HIGH, adminB, A);
    check("EL10: B's admin listing A -> 404", r.status === 404 && !r.raw.includes("DASHAUTH"));

    // ------------------------------------------------ 5. membership states (13-15)
    const nonMember = await list(HIGH, outsider);
    const noSuchWorkspace = await call(HIGH, "GET", `/dashboard/signals?workspaceId=64b64c4f2f1c2e0012345678`, H(viewer));
    check("WS1: an authenticated non-member -> 404", nonMember.status === 404);
    check("WS2: ...identical to a workspace that does not exist (existence not leaked)", nonMember.message === noSuchWorkspace.message && nonMember.status === noSuchWorkspace.status);
    check("WS3: a non-member is refused even when the fallback is RESTRICTED (no fallback for authenticated callers)", (await detail(HIGH, outsider, s1._id)).status === 404 && !(await detail(HIGH, outsider, s1._id)).raw.includes("DASHAUTH"));
    check("WS4: revoked membership -> 404 (list and detail)", (await list(HIGH, revoked)).status === 404 && (await detail(HIGH, revoked, s1._id)).status === 404);
    r = await list(HIGH, disabled);
    check("WS5: disabled user -> 403", r.status === 403 && r.code === "USER_DISABLED" && (await detail(HIGH, disabled, s1._id)).status === 403);
    check("WS6: a suspended workspace is unreadable, even by its admin (404)", (await list(HIGH, suspendedAdmin, S)).status === 404);
    check("WS7: missing / malformed workspaceId -> 400", (await call(HIGH, "GET", "/dashboard/signals", H(viewer))).status === 400 && (await call(HIGH, "GET", "/dashboard/signals?workspaceId=nope", H(viewer))).status === 400);
    check("WS8: another workspace's records never appear", (await list(HIGH, admin)).data.every((x) => x.id !== String(sB._id)) && !(await list(HIGH, admin)).raw.includes("other tenant"));

    // ------------------------------------------------ 6. privacy and contract (17, 20)
    const responses = [];
    for (const who of [viewer, operator, reviewer, admin]) {
      responses.push(await list(HIGH, who), await list(HIGH, who, A, "&limit=100"));
      for (const s of [s1, s2, s3]) responses.push(await detail(HIGH, who, s._id));
    }
    const rawAll = responses.map((x) => x.raw).join(" ");
    const paths = responses.flatMap((x) => keyPaths(x.data));
    const forbiddenKeys = ["firstName", "lastName", "fullName", "email", "phone", "reservationId", "provider", "model", "prompt", "apiKey", "content", "embedding", "guest", "guestId", "userId", "role", "permissions", "actor", "workspaceId"];
    check("PV1: no PII, reservation id, provider/model, prompt, embedding or document-content KEYS", forbiddenKeys.every((k) => !paths.some((p) => p.endsWith(`.${k}`))));
    check("PV2: no secret VALUE (guest name/email/phone, reservation id, provider/model, chunk text) in any response", leaks(rawAll).length === 0, leaks(rawAll).join(","));
    check("PV3: no identity, role or permission information was added to responses", !/"(userId|issuer|subject|role|roles|permissions|actor)"/.test(rawAll));
    const item = byId(responses[0], s1._id);
    check("CT1: the list item keeps exactly the approved fields", JSON.stringify(Object.keys(item).sort()) === JSON.stringify(["description", "hasGuest", "id", "intelligence", "occurredAt", "property", "severity", "source", "status", "stay", "synthetic", "title", "type", "unit"]));
    check("CT2: the envelope is unchanged ({success, data, pagination})", responses[0].json.success === true && Array.isArray(responses[0].data) && JSON.stringify(Object.keys(responses[0].json.pagination).sort()) === JSON.stringify(["limit", "page", "pages", "total"]));
    check("CT3: the detail keeps signal / observed / intelligence", JSON.stringify(Object.keys((await detail(HIGH, operator, s1._id)).data).sort()) === JSON.stringify(["intelligence", "observed", "signal"]));
    check("CT4: severity ordering is unchanged (critical, high, low)", (await list(HIGH, viewer)).data.map((x) => x.severity).join(",") === "critical,high,low");
    check("CT5: hasGuest is still only a boolean", item.hasGuest === true);

    // ------------------------------------------------ 7. Decision integration (18)
    const dl = await call(HIGH, "GET", `/decisions?workspaceId=${A}`, H(operator));
    check("DI1: the Decision read still works for the same identity (200)", dl.status === 200);
    const proposed = await call(HIGH, "POST", `/decisions/propose/${iStaff._id}?workspaceId=${A}`, H(operator));
    check("DI2: an operator can still propose (201) from the staff-level analysis", proposed.status === 201 && proposed.data.priority === "high" && proposed.data.confidence === "medium");
    const dl2 = await call(HIGH, "GET", `/decisions?workspaceId=${A}&limit=100`, H(operator));
    check("DI3: the Decision appears for the operator and is hidden from the viewer (parent visibility)", dl2.data.some((x) => x._id === proposed.data._id) && !(await call(HIGH, "GET", `/decisions?workspaceId=${A}&limit=100`, H(viewer))).data.some((x) => x._id === proposed.data._id));
    check("DI4: the dashboard still shows the Signal's analysis id that the Decision references", byId(await list(HIGH, operator), s1._id).intelligence.id === proposed.data.intelligenceId);

    // ------------------------------------------------ 8. safety (19)
    const after = await realCounts();
    const drift = Object.keys(before).filter((k) => before[k] !== after[k]);
    check("SF1: no pre-existing operational record was created, modified or deleted (counts)", drift.length === 0 && (await Models.Unit.countDocuments({})) === unitsBefore, drift.map((k) => `${k}:${before[k]}->${after[k]}`).join(","));
    check("SF2: no Action or Outcome was created", (await Action.countDocuments({ workspaceId: { $in: OWN } })) === 0 && (await Outcome.countDocuments({ workspaceId: { $in: OWN } })) === 0);
    check("SF3: only the one Decision this suite proposed exists in its workspaces", (await Decision.countDocuments({ workspaceId: { $in: OWN } })) === 1);
    check("SF4: no analysis, retrieval or embedding request reached the AI service (no Gemini)", trapHits.length === 0, trapHits.join(","));
    check("SF5: the dashboard routes remain GET-only (POST / PATCH / DELETE -> 404)", [(await call(HIGH, "POST", `/dashboard/signals?workspaceId=${A}`, H(admin))).status, (await call(HIGH, "PATCH", `/dashboard/signals/${s1._id}?workspaceId=${A}`, H(admin))).status, (await call(HIGH, "DELETE", `/dashboard/signals/${s1._id}?workspaceId=${A}`, H(admin))).status].every((s) => s === 404));
  } finally {
    for (const child of children) child.kill();
    await Promise.all(children.map((child) => new Promise((resolve) => child.once("exit", resolve))));
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
