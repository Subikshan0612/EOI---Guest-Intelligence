/**
 * Decision V1 validation.
 *
 * A Decision V1 is a PROPOSAL derived deterministically from one STORED
 * Intelligence V1 record. Nothing executes. This suite proves, against real
 * MongoDB and real HTTP servers:
 *
 *   - proposal is derived from the stored Intelligence (no client content, no LLM)
 *   - one Decision V1 per (workspace, Intelligence), incl. under concurrency
 *   - workspace isolation and inherited (live-parent) visibility
 *   - the staff-level interim gate on approve/reject (fail-closed for guest)
 *   - the proposed -> approved | rejected lifecycle, both terminal, no `completed`
 *   - reviews record WHEN and a note only - never WHO, never a client timestamp
 *   - the legacy generic POST/PATCH cannot create or mutate a Decision V1
 *   - no Action, no Outcome, no outbound AI-service call as a side effect
 *   - responses carry no guest PII, reservation id, provider/model, provenance
 *
 * Three ephemeral servers share one database and differ only in the trusted
 * KNOWLEDGE_DEV_AUTHORIZED_LEVEL (guest / staff / restricted). AI_SERVICE_URL
 * points at a TRAP server: any request to it fails the suite. All fixtures are
 * synthetic, live in their own workspaces, and are removed at the end.
 */
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { actorFor, cleanupAuthFixtures } from "./lib/authFixtures.mjs";
import { proposeDecision } from "../src/services/decisionService.js";
import {
  Action,
  Decision,
  Guest,
  Intelligence,
  Outcome,
  Property,
  Signal,
  Stay,
  Workspace,
} from "../src/models/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, "..", "server.js");
const PORT = 5071;
const TRAP_PORT = 5074;
const base = () => `http://localhost:${PORT}/api`;

// The old "level" names now select a ROLE (the level a caller had is the ceiling of
// the role that replaces it): guest -> viewer (reads) / operator (writes),
// staff -> reviewer, restricted -> admin. A real token is signed for a real user
// with a real active membership in the workspace the URL names.
const ROLE_FOR = { guest: { GET: "viewer", other: "operator" }, staff: { GET: "reviewer", other: "reviewer" }, restricted: { GET: "admin", other: "admin" } };

let passed = 0;
let failed = 0;
const ok = (name, detail = "") => {
  passed += 1;
  console.log(`PASS  ${name}${detail ? ` - ${detail}` : ""}`);
};
const fail = (name, detail = "") => {
  failed += 1;
  console.error(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
};
const check = (name, condition, detail = "") => (condition ? ok(name, detail) : fail(name, detail));

async function call(level, method, url, body) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  // Legacy generic POST /decisions and PATCH are AUTHENTICATED since Phase 16 (decision:propose / decision:review).
  // The V1 protections must hold even for the MOST privileged caller, so these calls act as an ADMIN.
  const legacy = method === "PATCH" || (method === "POST" && url === "/decisions");
  if (legacy) {
    const workspaceId = /[?&]workspaceId=([0-9a-fA-F]{24})/.exec(url)?.[1] ?? body?.workspaceId;
    const actor = await actorFor(/^[0-9a-fA-F]{24}$/.test(String(workspaceId)) ? "admin" : null, /^[0-9a-fA-F]{24}$/.test(String(workspaceId)) ? workspaceId : undefined, "v1suite-legacy");
    Object.assign(headers, actor.headers);
  } else if (level) {
    const workspaceId = /[?&]workspaceId=([0-9a-fA-F]{24})/.exec(url)?.[1];
    const roles = ROLE_FOR[level];
    // Phase 35 (proposer != reviewer): approve/reject calls are made by a SECOND actor of the same role, so the reviewer is never the proposer.
    const isReview = method === "POST" && /\/decisions\/[^/]+\/(approve|reject)(\?|$)/.test(url);
    const actor = await actorFor(method === "GET" ? roles.GET : roles.other, workspaceId, isReview ? "v1suite-reviewer" : "v1suite");
    Object.assign(headers, actor.headers);
  }
  const response = await fetch(`${base()}${url}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let json = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  return { status: response.status, json, data: json?.data };
}

async function expect(name, level, method, url, body, status) {
  const result = await call(level, method, url, body);
  check(name, result.status === status, `HTTP ${result.status}${result.status === status ? "" : ` (expected ${status}): ${JSON.stringify(result.json)?.slice(0, 200)}`}`);
  return result;
}

function waitForHealth(timeoutMs = 20000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = async () => {
      try {
        if ((await fetch(`${base()}/health`)).ok) return resolve();
      } catch {
        // not ready
      }
      if (Date.now() - start > timeoutMs) return reject(new Error("server not healthy"));
      setTimeout(attempt, 200);
    };
    attempt();
  });
}

// Synthetic markers that must never appear in any Decision response.
const GUEST = { firstName: "Zyxwvu", lastName: "Qponmlk", email: "zyxwvu.qponmlk@example.invalid", phone: "+0-555-0100-9999" };
const RESERVATION = "RSV-DECISION-V1-SECRET-7731";
const PROVIDER = "provider-decision-v1-secret";
const MODEL = "model-decision-v1-secret";
const CHUNK_ID = "chunk-decision-v1-secret";
const FORBIDDEN_FRAGMENTS = [
  GUEST.firstName, GUEST.lastName, GUEST.email, GUEST.phone, RESERVATION, PROVIDER, MODEL, CHUNK_ID,
  "knowledgeProvenance", "embedding", "prompt", "apiKey", "api_key",
];
const leaks = (json) => {
  const text = JSON.stringify(json);
  return FORBIDDEN_FRAGMENTS.filter((fragment) => text.toLowerCase().includes(fragment.toLowerCase()));
};

const ids = { workspaces: [], properties: [], signals: [], guests: [], stays: [], intelligences: [] };
const track = (bucket, doc) => {
  ids[bucket].push(doc._id);
  return doc;
};

async function cleanup() {
  await connectDatabase();
  await cleanupAuthFixtures();
  const ws = { $in: ids.workspaces };
  await Promise.all([
    Outcome.deleteMany({ workspaceId: ws }),
    Action.deleteMany({ workspaceId: ws }),
    Decision.deleteMany({ workspaceId: ws }),
  ]);
  await Promise.all([
    Intelligence.deleteMany({ workspaceId: ws }),
    Signal.deleteMany({ workspaceId: ws }),
    Stay.deleteMany({ workspaceId: ws }),
    Guest.deleteMany({ workspaceId: ws }),
    Property.deleteMany({ workspaceId: ws }),
  ]);
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

  // ONE server. KNOWLEDGE_DEV_AUTHORIZED_LEVEL is deliberately set to the HIGHEST level
  // to prove the development fallback never elevates an authenticated actor.
  const children = [
    spawn(process.execPath, [SERVER_ENTRY], {
      env: {
        ...process.env,
        PORT: String(PORT),
        LLM_PROVIDER: "test-python",
        AI_SERVICE_URL: `http://localhost:${TRAP_PORT}`,
        KNOWLEDGE_DEV_AUTHORIZED_LEVEL: "restricted",
      },
      stdio: "ignore",
    }),
  ];

  try {
    await waitForHealth();
    ok("ephemeral server healthy (stub authentication; fallback level deliberately restricted)");

    await connectDatabase();
    await Decision.init(); // make sure the V1 indexes exist before we test them

    // ---------------- fixtures (direct DB, isolated workspaces) ----------------
    const wsA = track("workspaces", await Workspace.create({ name: `Decision V1 A ${stamp}`, slug: `decision-v1-a-${stamp}` }));
    const wsB = track("workspaces", await Workspace.create({ name: `Decision V1 B ${stamp}`, slug: `decision-v1-b-${stamp}` }));
    const A = String(wsA._id);
    const B = String(wsB._id);
    const property = track("properties", await Property.create({ workspaceId: wsA._id, name: `DV1 Property ${stamp}`, code: `DV1-${stamp}` }));
    const guest = track("guests", await Guest.create({ workspaceId: wsA._id, ...GUEST }));
    const stay = track(
      "stays",
      await Stay.create({
        workspaceId: wsA._id,
        guestId: guest._id,
        propertyId: property._id,
        reservationId: RESERVATION,
        checkIn: new Date("2030-01-01T12:00:00Z"),
        checkOut: new Date("2030-01-03T12:00:00Z"),
      }),
    );

    const makeSignal = async (workspace, severity, extra = {}) =>
      track(
        "signals",
        await Signal.create({
          workspaceId: workspace._id,
          propertyId: workspace === wsA ? property._id : undefined,
          type: "maintenance",
          severity,
          title: `DV1 ${severity} signal ${stamp}`,
          ...extra,
        }),
      );

    const RECOMMENDATION = "Consider following the documented maintenance guidance. This is a recommendation only.";
    const makeV1 = async (workspace, signal, { level = "guest", knowledgeVisibility, confidence = "medium", recommendation = RECOMMENDATION } = {}) =>
      track(
        "intelligences",
        await Intelligence.create({
          workspaceId: workspace._id,
          signalIds: [signal._id],
          propertyId: workspace === wsA ? property._id : undefined,
          guestId: workspace === wsA ? guest._id : undefined,
          stayId: workspace === wsA ? stay._id : undefined,
          signal: { summary: signal.title, type: signal.type, severity: signal.severity },
          risk: { level: signal.severity },
          generatedBy: "llm",
          provider: PROVIDER,
          model: MODEL,
          analysis: { situation: "Situation.", evidence: ["Evidence."], impact: "Impact.", recommendation, confidence },
          analysisVersion: "intelligence-v1",
          analysisLevel: level,
          knowledgeVisibility,
          knowledgeProvenance: [
            { chunkId: CHUNK_ID, knowledgeDocumentId: "doc-x", version: 1, scope: "workspace", section: "S", chunkIndex: 0, similarityScore: 0.5, retrievalScore: 0.5, visibility: level },
          ],
        }),
      );

    const sigCritical = await makeSignal(wsA, "critical");
    const sigHigh = await makeSignal(wsA, "high", { guestId: guest._id, stayId: stay._id });
    const sigMedium = await makeSignal(wsA, "medium");
    const sigLow = await makeSignal(wsA, "low");
    const iCritical = await makeV1(wsA, sigCritical, { confidence: "high" });
    const iHigh = await makeV1(wsA, sigHigh, { confidence: "medium" });
    const iMedium = await makeV1(wsA, sigMedium, { confidence: "low" });
    const iLow = await makeV1(wsA, sigLow);
    const sigStaff = await makeSignal(wsA, "high");
    const iStaff = await makeV1(wsA, sigStaff, { level: "staff", knowledgeVisibility: "staff" });
    const sigRestricted = await makeSignal(wsA, "high");
    const iRestricted = await makeV1(wsA, sigRestricted, { level: "restricted", knowledgeVisibility: "restricted" });
    const sigB = await makeSignal(wsB, "high");
    const iB = await makeV1(wsB, sigB);

    // Non-V1 Intelligence: a legacy record, and one that merely LOOKS generated.
    const iLegacy = track("intelligences", await Intelligence.create({ workspaceId: wsA._id, signalIds: [sigLow._id] }));
    const iForged = track(
      "intelligences",
      await Intelligence.create({ workspaceId: wsA._id, signalIds: [sigLow._id], generatedBy: "llm", decision: { recommendation: "forged" } }),
    );

    const counts = async (workspaceIds) => ({
      actions: await Action.countDocuments({ workspaceId: { $in: workspaceIds } }),
      outcomes: await Outcome.countDocuments({ workspaceId: { $in: workspaceIds } }),
    });
    const before = await counts([wsA._id, wsB._id]);
    const intelBefore = await Intelligence.findById(iHigh._id).lean();
    const signalBefore = await Signal.findById(sigHigh._id).lean();
    const guestBefore = await Guest.findById(guest._id).lean();

    // ---------------- schema / index ----------------
    const indexes = await Decision.collection.indexes();
    const v1Index = indexes.find(
      (i) => i.unique && i.key.workspaceId === 1 && i.key.intelligenceId === 1 && i.key.decisionVersion === 1,
    );
    check("S1: unique partial index on (workspace, intelligence, decisionVersion)", Boolean(v1Index) && v1Index.partialFilterExpression?.decisionVersion === "decision-v1", JSON.stringify(v1Index?.partialFilterExpression));
    let schemaRejected = 0;
    for (const bad of [{ confidence: "certain" }, { status: "executed" }, { analysisLevel: "admin" }, { priority: "urgent" }]) {
      try {
        await new Decision({ workspaceId: wsA._id, intelligenceId: iHigh._id, description: "x", ...bad }).validate();
      } catch {
        schemaRejected += 1;
      }
    }
    check("S2: schema rejects invalid confidence / status / level / priority enums", schemaRejected === 4, `${schemaRejected}/4`);
    const legacyDirect = track("intelligences", await Intelligence.create({ workspaceId: wsA._id, signalIds: [sigLow._id] }));
    const legacyDoc = await Decision.collection.insertOne({ workspaceId: wsA._id, intelligenceId: legacyDirect._id, description: "Historic decision", type: "operational", priority: "medium", status: "completed", createdAt: new Date(), updatedAt: new Date() });
    const legacyRead = await expect("S3: a historical (pre-V1) record stays readable", "guest", "GET", `/decisions/${legacyDoc.insertedId}?workspaceId=${A}`, undefined, 200);
    check("S3b: legacy record has no V1 markers", legacyRead.data?.decisionVersion === null && legacyRead.data?.status === "completed" && legacyRead.data?.transitions?.length === 0);

    // ---------------- propose ----------------
    const p1 = await expect("P1: propose from stored Intelligence V1 (guest server, guest-level analysis)", "guest", "POST", `/decisions/propose/${iHigh._id}?workspaceId=${A}`, undefined, 201);
    const d = p1.data;
    check("P2: description is the stored recommendation, verbatim", d?.description === RECOMMENDATION);
    check("P3: confidence copied from Intelligence (medium)", d?.confidence === "medium");
    check("P4: priority from Signal severity (high)", d?.priority === "high");
    check("P5: signalId / propertyId derived server-side", d?.signalId === String(sigHigh._id) && d?.propertyId === String(property._id));
    check("P6: version + snapshot markers", d?.decisionVersion === "decision-v1" && d?.analysisVersion === "intelligence-v1" && d?.analysisLevel === "guest" && d?.knowledgeVisibility === null && d?.type === "operational");
    check("P7: starts proposed, no review, no transitions", d?.status === "proposed" && d?.review?.reviewedAt === null && d?.review?.reviewNote === null && d?.transitions?.length === 0);
    check("P8: intelligenceId references the stored record", d?.intelligenceId === String(iHigh._id) && d?.workspaceId === A);
    check("P9: response carries no PII / provider / provenance / prompt", leaks(p1.json).length === 0, leaks(p1.json).join(","));

    for (const [name, intel, priority, confidence] of [
      ["critical", iCritical, "critical", "high"],
      ["medium", iMedium, "medium", "low"],
      ["low", iLow, "low", "medium"],
    ]) {
      const r = await expect(`P10: propose (${name} Signal)`, "guest", "POST", `/decisions/propose/${intel._id}?workspaceId=${A}`, undefined, 201);
      check(`P10b: ${name} severity -> ${priority} priority, confidence ${confidence}`, r.data?.priority === priority && r.data?.confidence === confidence);
    }

    await expect("P11: body content is refused (description)", "guest", "POST", `/decisions/propose/${iStaff._id}?workspaceId=${A}`, { description: "client text" }, 400);
    for (const field of ["priority", "confidence", "status", "signalId", "propertyId", "analysisVersion", "analysisLevel", "knowledgeVisibility"]) {
      await expect(`P12: body field ${field} is refused`, "staff", "POST", `/decisions/propose/${iStaff._id}?workspaceId=${A}`, { [field]: "high" }, 400);
    }
    check("P13: refused proposals created nothing", (await Decision.countDocuments({ intelligenceId: iStaff._id })) === 0);
    await expect("P14: legacy Intelligence (no analysis) is refused", "guest", "POST", `/decisions/propose/${iLegacy._id}?workspaceId=${A}`, undefined, 422);
    await expect("P15: generated-looking but non-V1 Intelligence is refused", "guest", "POST", `/decisions/propose/${iForged._id}?workspaceId=${A}`, undefined, 422);
    await expect("P16: unknown Intelligence -> 404", "guest", "POST", `/decisions/propose/64b64c4f2f1c2e0012345678?workspaceId=${A}`, undefined, 404);
    await expect("P17: invalid id -> 400", "guest", "POST", `/decisions/propose/not-an-id?workspaceId=${A}`, undefined, 400);
    await expect("P18: missing workspaceId -> 400", "guest", "POST", `/decisions/propose/${iHigh._id}`, undefined, 400);
    await expect("P19: cross-workspace Intelligence cannot produce a Decision", "guest", "POST", `/decisions/propose/${iB._id}?workspaceId=${A}`, undefined, 404);
    await expect("P20: workspace B can propose from its own Intelligence", "guest", "POST", `/decisions/propose/${iB._id}?workspaceId=${B}`, undefined, 201);

    // ---------------- idempotency ----------------
    const again = await expect("I1: second proposal returns the existing Decision", "guest", "POST", `/decisions/propose/${iHigh._id}?workspaceId=${A}`, undefined, 200);
    check("I2: same id, no duplicate", again.data?._id === d._id && (await Decision.countDocuments({ workspaceId: wsA._id, intelligenceId: iHigh._id, decisionVersion: "decision-v1" })) === 1);
    const sigRace = await makeSignal(wsA, "medium");
    const iRace = await makeV1(wsA, sigRace);
    const race = await Promise.all(Array.from({ length: 10 }, () => call("staff", "POST", `/decisions/propose/${iRace._id}?workspaceId=${A}`)));
    const created = race.filter((r) => r.status === 201).length;
    const existing = race.filter((r) => r.status === 200).length;
    check("I3: 10 concurrent proposals -> exactly one 201, the rest 200", created === 1 && existing === 9, `201x${created} 200x${existing}`);
    check("I4: exactly one Decision V1 stored", (await Decision.countDocuments({ intelligenceId: iRace._id })) === 1);
    let dupBlocked = false;
    try {
      await Decision.create({ workspaceId: wsA._id, intelligenceId: iRace._id, description: "x", decisionVersion: "decision-v1" });
    } catch (error) {
      dupBlocked = error?.code === 11000;
    }
    check("I5: the database itself refuses a second Decision V1", dupBlocked);
    await Decision.create({ workspaceId: wsA._id, intelligenceId: iRace._id, description: "legacy twin" });
    check("I6: legacy (non-V1) records are not covered by the unique index", (await Decision.countDocuments({ intelligenceId: iRace._id })) === 2);

    // ---------------- read / workspace / visibility ----------------
    const got = await expect("R1: detail (guest server)", "guest", "GET", `/decisions/${d._id}?workspaceId=${A}`, undefined, 200);
    check("R2: detail equals the proposal + privacy", got.data?._id === d._id && leaks(got.json).length === 0);
    await expect("R3: cross-workspace detail -> 404", "guest", "GET", `/decisions/${d._id}?workspaceId=${B}`, undefined, 404);
    await expect("R4: missing workspaceId -> 400", "guest", "GET", `/decisions/${d._id}`, undefined, 400);
    const listA = await expect("R5: list", "guest", "GET", `/decisions?workspaceId=${A}&limit=100`, undefined, 200);
    check("R6: list is whitelisted, workspace-scoped, privacy-safe", listA.data.every((x) => x.workspaceId === A && x.decisionVersion !== undefined) && leaks(listA.json).length === 0);
    for (const [name, query, predicate] of [
      ["signalId", `signalId=${sigHigh._id}`, (x) => x.signalId === String(sigHigh._id)],
      ["propertyId", `propertyId=${property._id}`, (x) => x.propertyId === String(property._id)],
      ["status", "status=proposed", (x) => x.status === "proposed"],
      ["priority", "priority=critical", (x) => x.priority === "critical"],
      ["intelligenceId", `intelligenceId=${iHigh._id}`, (x) => x.intelligenceId === String(iHigh._id)],
    ]) {
      const r = await call("guest", "GET", `/decisions?workspaceId=${A}&${query}&limit=100`);
      check(`R7: filter by ${name}`, r.status === 200 && r.data.length >= 1 && r.data.every(predicate), `${r.data?.length} row(s)`);
    }
    const paged = await call("guest", "GET", `/decisions?workspaceId=${A}&limit=1&page=1`);
    check("R8: pagination reports total and pages", paged.data?.length === 1 && paged.json?.pagination?.total >= 4 && paged.json?.pagination?.pages >= 4);
    check("R9: workspace B list excludes A", (await call("guest", "GET", `/decisions?workspaceId=${B}&limit=100`)).data.every((x) => x.workspaceId === B));

    // staff- and restricted-level Intelligence
    let guestBlocked = false;
    try {
      await proposeDecision(String(iStaff._id), A, undefined, { authorizedLevel: "guest", actorUserId: "64b64c4f2f1c2e0012340001" }); // Phase 35: a proposer is required; the visibility refusal is what is under test
    } catch (error) {
      guestBlocked = error.statusCode === 404;
    }
    check("V1: a guest-ceiling caller cannot propose from staff-level Intelligence (service level: no guest-ceiling role holds decision:propose)", guestBlocked);
    const viewerActor = await actorFor("viewer", A, "v1suite");
    const viewerPropose = await fetch(`${base()}/decisions/propose/${iStaff._id}?workspaceId=${A}`, { method: "POST", headers: viewerActor.headers });
    check("V1b: a viewer cannot propose over the API (403, no decision:propose)", viewerPropose.status === 403, `HTTP ${viewerPropose.status}`);
    const dStaff = await expect("V2: staff level can", "staff", "POST", `/decisions/propose/${iStaff._id}?workspaceId=${A}`, undefined, 201);
    check("V2b: snapshot carries the staff visibility markers", dStaff.data?.analysisLevel === "staff" && dStaff.data?.knowledgeVisibility === "staff");
    await expect("V3: guest cannot read a staff-derived Decision", "guest", "GET", `/decisions/${dStaff.data._id}?workspaceId=${A}`, undefined, 404);
    check("V4: guest list excludes it and its total", !(await call("guest", "GET", `/decisions?workspaceId=${A}&limit=100`)).data.some((x) => x._id === dStaff.data._id));
    await expect("V5: staff can read it", "staff", "GET", `/decisions/${dStaff.data._id}?workspaceId=${A}`, undefined, 200);
    await expect("V6: guest cannot propose restricted", "guest", "POST", `/decisions/propose/${iRestricted._id}?workspaceId=${A}`, undefined, 404);
    await expect("V7: staff cannot propose restricted", "staff", "POST", `/decisions/propose/${iRestricted._id}?workspaceId=${A}`, undefined, 404);
    const dRestricted = await expect("V8: restricted can", "restricted", "POST", `/decisions/propose/${iRestricted._id}?workspaceId=${A}`, undefined, 201);
    await expect("V9: staff cannot read a restricted-derived Decision", "staff", "GET", `/decisions/${dRestricted.data._id}?workspaceId=${A}`, undefined, 404);
    check("V10: staff list excludes it", !(await call("staff", "GET", `/decisions?workspaceId=${A}&limit=100`)).data.some((x) => x._id === dRestricted.data._id));
    await expect("V11: staff cannot approve it (parent hidden)", "staff", "POST", `/decisions/${dRestricted.data._id}/approve?workspaceId=${A}`, {}, 404);
    check("V12: it stayed proposed", (await Decision.findById(dRestricted.data._id).lean()).status === "proposed");

    // authorization comes from the LIVE parent, never the snapshot
    const sigLive = await makeSignal(wsA, "low");
    const iLive = await makeV1(wsA, sigLive);
    const dLive = await expect("V13: guest-level Decision created", "guest", "POST", `/decisions/propose/${iLive._id}?workspaceId=${A}`, undefined, 201);
    await Intelligence.updateOne({ _id: iLive._id }, { $set: { knowledgeVisibility: "restricted" } });
    await expect("V14: parent raised to restricted -> guest can no longer read (snapshot not trusted)", "guest", "GET", `/decisions/${dLive.data._id}?workspaceId=${A}`, undefined, 404);
    check("V14b: the stale snapshot still says none", (await Decision.findById(dLive.data._id).lean()).knowledgeVisibility === undefined);
    await Intelligence.updateOne({ _id: iLive._id }, { $set: { knowledgeVisibility: "guest" } });

    // ---------------- review ----------------
    const sigA1 = await makeSignal(wsA, "high");
    const iA1 = await makeV1(wsA, sigA1);
    const dA1 = (await call("staff", "POST", `/decisions/propose/${iA1._id}?workspaceId=${A}`)).data;
    const gate = await expect("A1: guest-level approve fails closed", "guest", "POST", `/decisions/${dA1._id}/approve?workspaceId=${A}`, {}, 403);
    await expect("A2: guest-level reject fails closed", "guest", "POST", `/decisions/${dA1._id}/reject?workspaceId=${A}`, {}, 403);
    check("A3: the gate changed nothing", (await Decision.findById(dA1._id).lean()).status === "proposed" && !gate.data);
    await expect("A4: a query parameter cannot raise the level", "guest", "POST", `/decisions/${dA1._id}/approve?workspaceId=${A}&level=staff&knowledgeLevel=restricted`, {}, 403);
    await expect("A5: neither can a body field", "guest", "POST", `/decisions/${dA1._id}/approve?workspaceId=${A}`, { level: "staff" }, 403);
    await expect("A6: cross-workspace approve -> 404", "staff", "POST", `/decisions/${dA1._id}/approve?workspaceId=${B}`, {}, 404);
    await expect("A7: cross-workspace reject -> 404", "staff", "POST", `/decisions/${dA1._id}/reject?workspaceId=${B}`, {}, 404);
    await expect("A8: missing workspaceId -> 400", "staff", "POST", `/decisions/${dA1._id}/approve`, {}, 400);
    await expect("A9: unknown Decision -> 404", "staff", "POST", `/decisions/64b64c4f2f1c2e0012345678/approve?workspaceId=${A}`, {}, 404);

    for (const bad of [{ reviewedAt: "2000-01-01" }, { at: "2000-01-01" }, { reviewer: "admin" }, { approvedBy: "u1" }, { status: "approved" }, { transitions: [] }, { description: "x" }, { workspaceId: B }]) {
      await expect(`A10: body ${Object.keys(bad)[0]} is refused`, "staff", "POST", `/decisions/${dA1._id}/approve?workspaceId=${A}`, bad, 400);
    }
    await expect("A11: non-string note refused", "staff", "POST", `/decisions/${dA1._id}/approve?workspaceId=${A}`, { note: 5 }, 400);
    await expect("A12: over-long note refused", "staff", "POST", `/decisions/${dA1._id}/approve?workspaceId=${A}`, { note: "x".repeat(2001) }, 400);
    check("A13: refused reviews changed nothing", (await Decision.findById(dA1._id).lean()).status === "proposed");

    const t0 = Date.now();
    const approved = await expect("A14: staff approves with a note", "staff", "POST", `/decisions/${dA1._id}/approve?workspaceId=${A}`, { note: "  Looks right.  " }, 200);
    const t1 = Date.now();
    const at = new Date(approved.data?.review?.reviewedAt).getTime();
    check("A15: status approved, note stored (trimmed)", approved.data?.status === "approved" && approved.data?.review?.reviewNote === "Looks right.");
    check("A16: reviewedAt is server time", at >= t0 - 2000 && at <= t1 + 2000);
    check("A17: one transition proposed -> approved, same server time", approved.data?.transitions?.length === 1 && approved.data.transitions[0].from === "proposed" && approved.data.transitions[0].to === "approved" && approved.data.transitions[0].note === "Looks right." && new Date(approved.data.transitions[0].at).getTime() === at);
    check("A18: no reviewer identity in the record", !("reviewer" in approved.data.review) && !JSON.stringify(approved.json).match(/reviewer|approvedBy|rejectedBy/i));
    check("A19: response privacy", leaks(approved.json).length === 0);
    const again2 = await expect("A20: approving again is a no-op", "staff", "POST", `/decisions/${dA1._id}/approve?workspaceId=${A}`, { note: "second" }, 200);
    check("A21: no second transition, note and time unchanged", again2.data?.transitions?.length === 1 && again2.data?.review?.reviewNote === "Looks right." && again2.data?.review?.reviewedAt === approved.data.review.reviewedAt);
    await expect("A22: approved -> rejected fails", "staff", "POST", `/decisions/${dA1._id}/reject?workspaceId=${A}`, {}, 409);
    const stored1 = await Decision.findById(dA1._id).lean();
    check("A23: stored state is still approved with one transition", stored1.status === "approved" && stored1.transitions.length === 1);
    await expect("A24: restricted-level caller may also approve (>= staff)", "restricted", "POST", `/decisions/${dA1._id}/approve?workspaceId=${A}`, {}, 200);

    const sigA2 = await makeSignal(wsA, "medium");
    const iA2 = await makeV1(wsA, sigA2);
    const dA2 = (await call("staff", "POST", `/decisions/propose/${iA2._id}?workspaceId=${A}`)).data;
    const rejected = await expect("B1: staff rejects", "staff", "POST", `/decisions/${dA2._id}/reject?workspaceId=${A}`, undefined, 200);
    check("B2: status rejected, one transition proposed -> rejected, no note", rejected.data?.status === "rejected" && rejected.data?.transitions?.length === 1 && rejected.data.transitions[0].to === "rejected" && rejected.data.transitions[0].note === null && rejected.data.review.reviewNote === null);
    const rejAgain = await expect("B3: rejecting again is a no-op", "staff", "POST", `/decisions/${dA2._id}/reject?workspaceId=${A}`, {}, 200);
    check("B4: no second transition", rejAgain.data?.transitions?.length === 1);
    await expect("B5: rejected -> approved fails", "staff", "POST", `/decisions/${dA2._id}/approve?workspaceId=${A}`, {}, 409);
    const reProposal = await expect("B6: proposing again after rejection returns the rejected Decision (no re-proposal in V1)", "staff", "POST", `/decisions/propose/${iA2._id}?workspaceId=${A}`, undefined, 200);
    check("B7: it is still the rejected one", reProposal.data?._id === dA2._id && reProposal.data?.status === "rejected");

    // racing opposite reviews: exactly one wins
    const sigA3 = await makeSignal(wsA, "low");
    const iA3 = await makeV1(wsA, sigA3);
    const dA3 = (await call("staff", "POST", `/decisions/propose/${iA3._id}?workspaceId=${A}`)).data;
    const duel = await Promise.all([
      call("staff", "POST", `/decisions/${dA3._id}/approve?workspaceId=${A}`, {}),
      call("staff", "POST", `/decisions/${dA3._id}/reject?workspaceId=${A}`, {}),
    ]);
    const wins = duel.filter((r) => r.status === 200).length;
    const storedDuel = await Decision.findById(dA3._id).lean();
    check("B8: racing approve/reject -> exactly one wins, one transition", wins === 1 && storedDuel.transitions.length === 1 && ["approved", "rejected"].includes(storedDuel.status), duel.map((r) => r.status).join("/"));

    // ---------------- legacy generic endpoints cannot bypass V1 ----------------
    const legacyPost = (body) => call("guest", "POST", "/decisions", { workspaceId: A, ...body });
    let r = await legacyPost({ intelligenceId: String(iLow._id), description: "Arbitrary text" });
    check("L1: generic POST on an Intelligence V1 is refused", r.status === 409, `HTTP ${r.status}`);
    r = await legacyPost({ intelligenceId: String(iLow._id), description: "x", status: "approved" });
    check("L2: ...including one pre-approved", r.status === 409);
    r = await legacyPost({ intelligenceId: String(iLow._id), description: "x", status: "completed" });
    check("L3: ...including one pre-completed", r.status === 409);
    for (const field of ["decisionVersion", "signalId", "propertyId", "confidence", "analysisVersion", "analysisLevel", "knowledgeVisibility", "review", "transitions"]) {
      r = await legacyPost({ intelligenceId: String(iLegacy._id), description: "x", [field]: field === "decisionVersion" ? "decision-v1" : "high" });
      check(`L4: generic POST cannot set ${field}`, r.status === 400, `HTTP ${r.status}`);
    }
    check("L5: no V1-marked record was created by the generic endpoint", (await Decision.countDocuments({ description: "x", decisionVersion: "decision-v1" })) === 0);
    const legacyOk = await legacyPost({ intelligenceId: String(iLegacy._id), description: "A legacy decision" });
    check("L6: generic POST still creates a plain legacy Decision", legacyOk.status === 201 && legacyOk.data?.decisionVersion === null && legacyOk.data?.status === "proposed");

    const patch = (id, body) => call("staff", "PATCH", `/decisions/${id}?workspaceId=${A}`, body);
    const proposedV1 = String((await Decision.findOne({ intelligenceId: iHigh._id }))._id);
    for (const [name, body] of [["description", { description: "rewritten" }], ["status approved", { status: "approved" }], ["status rejected", { status: "rejected" }], ["status completed", { status: "completed" }], ["priority", { priority: "low" }]]) {
      r = await patch(proposedV1, body);
      check(`L7: generic PATCH cannot change a V1 ${name}`, r.status === 409, `HTTP ${r.status}`);
    }
    for (const body of [{ intelligenceId: String(iLow._id) }, { workspaceId: B }, { decisionVersion: "legacy" }]) {
      r = await patch(proposedV1, body);
      check(`L8: generic PATCH ${Object.keys(body)[0]} on a V1 is refused`, r.status === 409 || r.status === 400, `HTTP ${r.status}`);
    }
    r = await patch(legacyOk.data._id, { decisionVersion: "decision-v1" });
    check("L9: generic PATCH cannot mark a legacy Decision as V1", r.status === 400);
    r = await patch(legacyOk.data._id, { status: "approved" });
    check("L10: legacy PATCH still works for legacy records", r.status === 200 && r.data?.status === "approved");
    const v1AfterPatches = await Decision.findOne({ intelligenceId: iHigh._id }).lean();
    check("L11: the V1 Decision is byte-for-byte unchanged", v1AfterPatches.description === RECOMMENDATION && v1AfterPatches.status === "proposed" && v1AfterPatches.decisionVersion === "decision-v1" && !v1AfterPatches.transitions);

    // ---------------- no side effects ----------------
    const after = await counts([wsA._id, wsB._id]);
    check("N1: no Action created by propose / approve / reject", after.actions === before.actions, `${before.actions} -> ${after.actions}`);
    check("N2: no Outcome created by propose / approve / reject", after.outcomes === before.outcomes, `${before.outcomes} -> ${after.outcomes}`);
    check("N3: no request reached the AI service (no LLM call)", trapHits.length === 0, trapHits.join(","));
    const intelAfter = await Intelligence.findById(iHigh._id).lean();
    const signalAfter = await Signal.findById(sigHigh._id).lean();
    const guestAfter = await Guest.findById(guest._id).lean();
    check("N4: Intelligence, Signal and Guest are untouched", JSON.stringify(intelBefore) === JSON.stringify(intelAfter) && JSON.stringify(signalBefore) === JSON.stringify(signalAfter) && JSON.stringify(guestBefore) === JSON.stringify(guestAfter));
    check("N5: no Decision V1 ever holds status completed", (await Decision.countDocuments({ workspaceId: { $in: [wsA._id, wsB._id] }, decisionVersion: "decision-v1", status: "completed" })) === 0);

    // ---------------- privacy across every read shape ----------------
    const all = await call("restricted", "GET", `/decisions?workspaceId=${A}&limit=100`);
    check("X1: restricted-level list is privacy-safe", leaks(all.json).length === 0, leaks(all.json).join(","));
    const oneKeys = Object.keys((await call("staff", "GET", `/decisions/${dA1._id}?workspaceId=${A}`)).data).sort().join(",");
    check("X2: the detail is a fixed whitelist", oneKeys === "_id,analysisLevel,analysisVersion,confidence,createdAt,decisionVersion,description,intelligenceId,knowledgeVisibility,priority,propertyId,review,signalId,status,transitions,type,updatedAt,workspaceId", oneKeys);
  } finally {
    for (const child of children) child.kill();
    await Promise.all(children.map((child) => new Promise((resolve) => child.once("exit", resolve))));
    trap.close();
    try {
      await cleanup();
      ok("mongodb cleanup");
    } catch (error) {
      fail("mongodb cleanup", String(error));
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
