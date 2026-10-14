/**
 * Phase 49 - DECISION -> ACTION: an APPROVED Decision may produce a governed, INERT Action proposal.
 *
 *   node backend/scripts/validate-phase49-decision-action.mjs
 *
 *   B  the real API on an ISOLATED throwaway database (koi_p49_<stamp>, dropped at the end), against the REAL ai-service in its deterministic TEST mode behind a
 *      COUNTING proxy: cases are created conversationally and analysed through the existing endpoint, decided (Phase 48.1: a single user confirms their own
 *      Decision), then proposed as Actions: approved / rejected / still-proposed Decisions, tenant isolation, forged fields, idempotency and races, safety,
 *      immutability, inertness, zero AI calls after the explicit generations.
 *   F  the frontend (Vite SSR): mapping, availability, stage progress, panel rendering per state, wording, no ids / codes / internals, workflow strip
 *   S  static architecture: no AI client, no execution, no Outcome in the Action path
 *
 * Nothing here calls a real model, and nothing carries an Action out - there is nothing that could.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import dotenv from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(here, "..");
const REPO = path.join(BACKEND, "..");
const FRONTEND = path.join(REPO, "frontend");
const AI_SERVICE = path.join(REPO, "ai-service");
const read = (p) => fs.readFileSync(p, "utf8");
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, "");
let passed = 0; let failed = 0;
const check = (name, ok, detail = "") => { if (ok) { passed += 1; console.log(`PASS  ${name}${detail ? ` - ${detail}` : ""}`); } else { failed += 1; console.error(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

{ const __u = dotenv.parse(process.getBuiltinModule("node:fs").readFileSync(new URL("../.env", import.meta.url))).MONGODB_URI ?? ""; if (/^mongodb:\/\/(?:[^@/]*@)?(localhost|127\.0\.0\.1)/i.test(__u)) process.env.MONGODB_URI ??= __u; } // validation / rehearsal tools take ONLY a loopback database URI from backend/.env, never its real settings
const baseUri = process.env.MONGODB_URI;
const stamp = Date.now();
const DB_NAME = `koi_p49_${stamp}`;
if (!baseUri || /^mongodb\+srv:|@/.test(baseUri) || !/^mongodb:\/\/(localhost|127\.0\.0\.1)/.test(baseUri)) { console.error("refusing: the configured MongoDB is not a plain loopback instance"); process.exit(2); }
process.env.MONGODB_URI = baseUri.replace(/(mongodb:\/\/[^/]+\/)([^?]*)/, `$1${DB_NAME}`);
delete process.env.KOI_ACTION_REVIEW_REQUIRES_SECOND_PERSON; // the DEFAULT single-user policy is what this suite tests

const { createActor } = await import("./lib/authFixtures.mjs");
const { GOVERNANCE_POLICY } = await import("../src/services/governance.js");
const mongoose = (await import("mongoose")).default;
const { connectDatabase } = await import("../src/config/database.js");
const { Action, Decision, Intelligence, Signal, Workspace, Property, Unit, Outcome, Conversation, Message } = await import("../src/models/index.js");
await connectDatabase();
if (mongoose.connection.db.databaseName !== DB_NAME) { console.error("refusing: not connected to the isolated database"); process.exit(2); }

const children = [];
const proxyLog = { analyze: 0, retrieval: 0, embeddings: 0, other: 0 };
let proxyServer = null; let vite = null;
const resetProxy = () => Object.assign(proxyLog, { analyze: 0, retrieval: 0, embeddings: 0, other: 0 });
const HEX24 = /\b[0-9a-f]{24}\b/i;

try {
  // ======================================================================================================== infrastructure
  const python = process.platform === "win32" ? path.join(AI_SERVICE, ".venv", "Scripts", "python.exe") : path.join(AI_SERVICE, ".venv", "bin", "python");
  const AI_PORT = 8077; const PROXY_PORT = 8078; const API_PORT = 5095;
  const ai = spawn(python, ["-m", "uvicorn", "app.main:app", "--port", String(AI_PORT), "--log-level", "warning"], { cwd: AI_SERVICE, env: { ...process.env, LLM_PROVIDER: "test", EMBEDDING_PROVIDER: "test", GEMINI_API_KEY: "" }, stdio: "ignore" });
  children.push(ai);
  let aiUp = false; for (let i = 0; i < 80 && !aiUp; i += 1) { try { aiUp = (await fetch(`http://127.0.0.1:${AI_PORT}/v1/health`)).ok; } catch { await sleep(500); } }
  if (!aiUp) { console.error("the test ai-service did not start"); process.exit(2); }
  proxyServer = http.createServer((req, res) => {
    const chunks = []; req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const raw = Buffer.concat(chunks); const p = req.url;
      if (p.endsWith("/v1/intelligence/analyze")) proxyLog.analyze += 1; else if (p.endsWith("/v1/knowledge-retrieval")) proxyLog.retrieval += 1; else if (p.includes("embed")) proxyLog.embeddings += 1; else proxyLog.other += 1;
      try {
        const up = await fetch(`http://127.0.0.1:${AI_PORT}${p}`, { method: req.method, headers: { "content-type": req.headers["content-type"] ?? "application/json" }, body: ["GET", "HEAD"].includes(req.method) ? undefined : raw });
        res.statusCode = up.status; res.setHeader("content-type", up.headers.get("content-type") ?? "application/json"); res.end(Buffer.from(await up.arrayBuffer()));
      } catch { res.statusCode = 502; res.end("{}"); }
    });
  });
  await new Promise((r) => proxyServer.listen(PROXY_PORT, r));
  const be = spawn(process.execPath, [path.join(BACKEND, "server.js")], { env: { ...process.env, PORT: String(API_PORT), LLM_PROVIDER: "test-python", AI_SERVICE_URL: `http://localhost:${PROXY_PORT}` }, stdio: "ignore" });
  children.push(be);
  const BASE = `http://localhost:${API_PORT}/api`;
  for (let i = 0; i < 100; i += 1) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch { /* starting */ } await sleep(200); }

  const wsA = await Workspace.create({ name: `P49 a ${stamp}`, slug: `p49-a-${stamp}`, status: "active" });
  const wsB = await Workspace.create({ name: `P49 b ${stamp}`, slug: `p49-b-${stamp}`, status: "active" });
  const A = String(wsA._id); const B = String(wsB._id);
  const hv = await Property.create({ workspaceId: wsA._id, name: "Harbour View", code: "HBV" });
  const ot = await Property.create({ workspaceId: wsB._id, name: "Other Tower", code: "OTW" });
  for (const n of ["221", "105", "301", "412", "118", "502", "503"]) await Unit.create({ propertyId: hv._id, unitNumber: n });
  await Unit.create({ propertyId: ot._id, unitNumber: "221" });
  // The normal product user is the ADMIN of their own workspace (account setup); the others exist only to prove what they cannot do.
  const me = await createActor({ role: "admin", workspaceId: wsA._id, label: "p49-me" });
  const operator = await createActor({ role: "operator", workspaceId: wsA._id, label: "p49-op" });
  const viewer = await createActor({ role: "viewer", workspaceId: wsA._id, label: "p49-viewer" });
  const adminB = await createActor({ role: "admin", workspaceId: wsB._id, label: "p49-adminb" });
  const opB = await createActor({ role: "operator", workspaceId: wsB._id, label: "p49-opb" });
  const call = async (method, url, who, body, extra = {}) => {
    const res = await fetch(`${BASE}${url}`, { method, headers: { ...(who ? who.headers : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* none */ } return { status: res.status, json, data: json?.data, text };
  };
  const turn = (who, ws, content) => call("POST", "/conversations/intake", who, { workspaceId: ws, content });
  const makeCase = async (who, ws, text) => {
    const t = await turn(who, ws, text);
    const signalId = t.data?.signal?._id;
    const gen = signalId ? await call("POST", `/intelligence/analyze/${signalId}?workspaceId=${ws}`, who) : null;
    return { signalId, intel: gen?.data, status: gen?.status, turnStatus: t.status };
  };
  const decide = async (who, intel, verb, body = {}) => {
    const p = await call("POST", `/decisions/propose/${intel._id}?workspaceId=${A}`, who);
    const r = verb ? await call("POST", `/decisions/${p.data._id}/${verb}?workspaceId=${A}`, who, body) : null;
    return { id: p.data?._id, proposed: p, reviewed: r };
  };
  const proposeAction = (who, decisionId, ws = A, body) => call("POST", `/actions/propose/${decisionId}?workspaceId=${ws}`, who, body);
  const reviewAction = (who, id, verb, body, ws = A) => call("POST", `/actions/${id}/${verb}?workspaceId=${ws}`, who, body);
  const snap = async (id) => JSON.stringify(await Intelligence.findById(id).lean());
  const snapDecision = async (id) => JSON.stringify(await Decision.findById(id).lean());

  // ======================================================================================================== B
  console.log("\n# B. Decision -> Action on the real API");
  const ac = await makeCase(me, A, "Guest in room 221 says the AC stopped working and the room is getting very hot.");
  const tap = await makeCase(me, A, "Guest in room 412 reports a dripping tap in the bathroom.");
  const pend = await makeCase(me, A, "Guest in room 118 reports a squeaking door in the corridor.");
  const gas = await makeCase(me, A, "Guest reports a strong gas smell in room 105.");
  const crit = await makeCase(me, A, "Critical: guest in room 301 reports the lift is stuck between floors.");
  const rag = await makeCase(me, A, "Guest in room 502 reports the television remote is not working.");
  const racing = await makeCase(me, A, "Guest in room 503 reports a flickering lamp.");
  check("B0 seven cases created conversationally and analysed through the existing endpoint (201 each); the workspace holds NO business knowledge, so every analysis is a RAG miss (Phase 48.1)", [ac, tap, pend, gas, crit, rag, racing].every((c) => c.turnStatus === 201 && c.status === 201 && c.intel?._id), [ac, tap, pend, gas, crit, rag, racing].map((c) => c.status).join(","));
  const dAc = await decide(me, ac.intel, "approve", { note: "Go ahead." });
  const dTap = await decide(me, tap.intel, "reject", { note: "Already handled." });
  const dPend = await decide(me, pend.intel, null);
  const dGas = await decide(me, gas.intel, "approve");
  const dCrit = await decide(me, crit.intel, "approve");
  const dRag = await decide(me, rag.intel, "approve");
  const dRace = await decide(me, racing.intel, "approve");
  check("B0b the Decisions: approved (AC), rejected (tap), still proposed (door), approved (gas, critical lift, RAG-miss remote, race case) - each by the SAME single user (Phase 48.1)", dAc.reviewed.data.status === "approved" && dTap.reviewed.data.status === "rejected" && dPend.proposed.data.status === "proposed" && [dGas, dCrit, dRag, dRace].every((d) => d.reviewed.data.status === "approved"));
  const intelSnaps = { ac: await snap(ac.intel._id), gas: await snap(gas.intel._id) };
  const decSnaps = { ac: await snapDecision(dAc.id), gas: await snapDecision(dGas.id) };
  const countsBefore = { actions: await Action.countDocuments({}), outcomes: await Outcome.countDocuments({}), conversations: await Conversation.countDocuments({}), messages: await Message.countDocuments({}), signals: await Signal.countDocuments({}), intelligences: await Intelligence.countDocuments({}), decisions: await Decision.countDocuments({}) };
  const generations = proxyLog.analyze;
  check("B0c approving a Decision created NO Action and NO Outcome, and made no AI call beyond the explicit generations (nothing is carried out by approving)", countsBefore.actions === 0 && countsBefore.outcomes === 0 && generations === 7);
  resetProxy();

  // ---- 1 approved -> proposal
  const a1 = await proposeAction(me, dAc.id);
  const aDoc = await Action.findById(a1.data?._id).lean();
  const decAc = await Decision.findById(dAc.id).lean();
  check("B1 an APPROVED Decision produces an Action PROPOSAL (201) for the normal single user: status proposed, derived by the server (type, risk, description = the approved recommendation, workspace, provenance), no body sent", a1.status === 201 && a1.data.status === "proposed" && a1.data.actionVersion === "action-v1" && a1.data.description === decAc.description && ["maintenance_dispatch", "guest_communication", "escalation", "inspection", "other"].includes(a1.data.actionType) && !!a1.data.riskLevel && aDoc.workspaceId.equals(wsA._id) && aDoc.status === "proposed");
  check("B1b the proposer is the authenticated actor, recorded by the server; the view exposes only booleans (review.you), never a user id, name or email, and no governance field", String(aDoc.proposedBy) === String(me.user._id) && a1.data.review.you.proposed === true && a1.data.review.you.reviewed === false && !/proposedBy|reviewedBy|governanceVersion|"actor"|email/.test(JSON.stringify(a1.json)));
  // ---- 12 provenance
  check("B12 the proposal names its provenance: Action -> Decision -> Intelligence -> Signal (and the property), all derived from the stored Decision - none supplied by the client", String(aDoc.decisionId) === dAc.id && String(aDoc.intelligenceId) === String(ac.intel._id) && String(aDoc.signalId) === String(ac.signalId) && String(aDoc.signalId) === String(decAc.signalId) && String(aDoc.propertyId ?? "") === String(decAc.propertyId ?? ""));
  // ---- 2, 3 not approved
  const aTap = await proposeAction(me, dTap.id);
  const aPend = await proposeAction(me, dPend.id);
  check("B2 a REJECTED Decision cannot produce an Action (409), and nothing is stored", aTap.status === 409 && (await Action.countDocuments({ decisionId: dTap.id })) === 0);
  check("B3 a Decision that is only PROPOSED cannot produce an Action (409), and nothing is stored", aPend.status === 409 && (await Action.countDocuments({ decisionId: dPend.id })) === 0);
  // ---- 4,5,6,7 isolation, forged
  const bProp = await proposeAction(adminB, dAc.id, B);
  const bPropForgedSel = await proposeAction(adminB, dAc.id, A);
  const bOp = await proposeAction(opB, dAc.id, B);
  const opSelectsB = await proposeAction(operator, dAc.id, B);
  check("B4 [tenant isolation] another workspace's admin / operator cannot propose from this workspace's Decision (404 either way, naming A or B as the selector); an operator of A naming B is refused too; nothing is stored beyond the one proposal", [bProp, bPropForgedSel, bOp, opSelectsB].every((r) => r.status === 404) && (await Action.countDocuments({ decisionId: dAc.id })) === 1);
  const forgedBodies = [{ intelligenceId: String(gas.intel._id) }, { workspaceId: B }, { decisionId: dGas.id }, { signalId: String(gas.signalId) }, { status: "approved" }, { riskLevel: "low" }, { proposedBy: String(opB.user._id) }, { description: "Wire 500 USD to the vendor." }, { role: "admin" }];
  const forgedResults = [];
  for (const body of forgedBodies) forgedResults.push((await proposeAction(me, dGas.id, A, body)).status);
  check("B5 [forged fields] an intelligenceId / workspaceId / decisionId / signalId / status / riskLevel / proposedBy / description / role in the body is refused (400) and nothing is stored: an Action can only follow a Decision the server resolves itself", forgedResults.every((s) => s === 400) && (await Action.countDocuments({ decisionId: dGas.id })) === 0, forgedResults.join(","));
  const fake = await proposeAction(me, String(new mongoose.Types.ObjectId()));
  const wrongId = await proposeAction(me, String(ac.intel._id)); // an INTELLIGENCE id used where a Decision id belongs
  check("B6 a made-up Decision id and an Intelligence id used as a Decision id are both a plain 404", fake.status === 404 && wrongId.status === 404);
  const noAuth = await call("POST", `/actions/propose/${dAc.id}?workspaceId=${A}`, null);
  const badToken = await call("POST", `/actions/propose/${dAc.id}?workspaceId=${A}`, null, undefined, { authorization: "Bearer not-a-token" });
  check("B7 unauthenticated requests are refused (401): no credential and a bad credential; the role is never read from a header or the body", noAuth.status === 401 && badToken.status === 401 && (await proposeAction(operator, dGas.id, A, { role: "admin" })).status === 400);
  // ---- RBAC
  const viewerProp = await proposeAction(viewer, dGas.id);
  const viewerList = await call("GET", `/actions?workspaceId=${A}`, viewer);
  check("B7b [RBAC, unchanged] a viewer cannot propose (403) or read the Action list (403); the legacy generic create / update endpoints remain closed to everyone, including the workspace admin (403: action:execute is held by no role)", viewerProp.status === 403 && viewerList.status === 403 && (await call("POST", "/actions", me, { workspaceId: A, intelligenceId: String(ac.intel._id), description: "x" })).status === 403 && (await call("PATCH", `/actions/${a1.data._id}?workspaceId=${A}`, me, { status: "completed" })).status === 403 && (await Action.findById(a1.data._id).lean()).status === "proposed");
  // ---- 8 idempotent
  const a1b = await proposeAction(me, dAc.id);
  const a1c = await proposeAction(me, dAc.id, A, { actionType: "inspection" });
  check("B8 repeating the proposal - by the same user, with or without a different requested type - returns the SAME record (200), never a second one, and never changes it", a1b.status === 200 && a1b.data._id === a1.data._id && a1c.status === 200 && a1c.data._id === a1.data._id && a1c.data.actionType === a1.data.actionType && (await Action.countDocuments({ decisionId: dAc.id })) === 1);
  // ---- 9 concurrent
  const burst = await Promise.all(Array.from({ length: 12 }, () => proposeAction(me, dRace.id)));
  const created = burst.filter((r) => r.status === 201).length; const same = new Set(burst.map((r) => r.data?._id));
  check("B9 twelve SIMULTANEOUS proposals for one approved Decision create exactly ONE Action (one 201, the rest 200, one id): the server's unique index decides, not the page", created === 1 && burst.every((r) => [200, 201].includes(r.status)) && same.size === 1 && (await Action.countDocuments({ decisionId: dRace.id })) === 1);
  // ---- 10, 11 immutability
  check("B10 the Intelligence is BYTE-IDENTICAL after the Action was proposed (and re-proposed): the proposal never rewrites the evidence", (await snap(ac.intel._id)) === intelSnaps.ac);
  check("B11 the Decision is BYTE-IDENTICAL after the Action was proposed: the proposal never alters the human governance record", (await snapDecision(dAc.id)) === decSnaps.ac);
  // ---- 13 safety
  const hazardConflicts = [];
  for (const actionType of ["inspection", "guest_communication", "other"]) hazardConflicts.push(await proposeAction(me, dGas.id, A, { actionType }));
  check("B13 [safety: type] a LIFE-SAFETY recommendation's Action can never be proposed as a weaker type: inspection / guest_communication / other are refused (409 ACTION_TYPE_CONFLICTS_WITH_SAFETY) and nothing is stored", hazardConflicts.every((r) => r.status === 409 && r.json?.details?.code === "ACTION_TYPE_CONFLICTS_WITH_SAFETY") && (await Action.countDocuments({ decisionId: dGas.id })) === 0);
  const aGas = await proposeAction(me, dGas.id);
  const gasSafety = (await Intelligence.findById(gas.intel._id).lean()).safety;
  check("B13b [safety: derived] with no type requested, the server derives a hazard Action from the STRUCTURED safety state: escalation (the safe default when the analysis recorded none), risk 'critical', urgency 'immediate' - never from prose", gasSafety?.state === "LIFE_SAFETY_HAZARD" && aGas.status === 201 && aGas.data.actionType === "escalation" && aGas.data.riskLevel === "critical" && aGas.data.urgency === "immediate");
  const aCrit = await proposeAction(me, dCrit.id);
  const critSafety = (await Intelligence.findById(crit.intel._id).lean()).safety;
  check("B13c [safety: critical] a CRITICAL analysis raises the proposal's risk (at least high) and urgency (immediate); a safety-constrained proposal cannot be rejected without a recorded reason (400 ACTION_REASON_REQUIRED), and can with one", critSafety?.state === "CRITICAL" && aCrit.status === 201 && ["high", "critical"].includes(aCrit.data.riskLevel) && aCrit.data.urgency === "immediate" &&
    (await reviewAction(me, aCrit.data._id, "reject")).status === 400 && (await reviewAction(me, aCrit.data._id, "reject")).json?.details?.code === "ACTION_REASON_REQUIRED" && (await Action.findById(aCrit.data._id).lean()).status === "proposed" &&
    (await reviewAction(me, aCrit.data._id, "reject", { note: "The lift engineer is already inside." })).data?.status === "rejected");
  // a recorded safety result (what a real model produces): the analysis' own validated type wins, and a conflicting request is refused
  const recordedIntel = await Intelligence.create({ workspaceId: wsA._id, signalIds: [dAc.proposed.data.signalId ? new mongoose.Types.ObjectId(dAc.proposed.data.signalId) : (await Signal.findOne({ workspaceId: wsA._id }).lean())._id], generatedBy: "llm", provider: "p", model: "m", risk: { level: "high" }, analysis: { situation: "s", evidence: ["e"], impact: "i", recommendation: "Dispatch maintenance and keep the area clear.", confidence: "medium" }, analysisVersion: "intelligence-v1", analysisLevel: "guest", safety: { state: "LIFE_SAFETY_HAZARD", urgency: "immediate", recommendedActionType: "maintenance_dispatch" } });
  const dRec = await decide(me, recordedIntel, "approve");
  const recConflict = await proposeAction(me, dRec.id, A, { actionType: "escalation" });
  const recAction = await proposeAction(me, dRec.id);
  check("B13d [safety: recorded] when the analysis recorded a validated type, the Action takes exactly it (maintenance_dispatch), risk critical, urgency immediate; naming another type is refused (409)", dRec.reviewed.data.status === "approved" && recConflict.status === 409 && recAction.status === 201 && recAction.data.actionType === "maintenance_dispatch" && recAction.data.riskLevel === "critical" && recAction.data.urgency === "immediate");
  const normalPick = await proposeAction(me, dRag.id, A, { actionType: "inspection" });
  check("B13e [normal state] with no safety constraint the type may still be named (the closed vocabulary) and risk stays the type's class; an unknown type is refused (422)", normalPick.status === 201 && normalPick.data.actionType === "inspection" && normalPick.data.riskLevel === "low" && (await proposeAction(me, dTap.id, A, { actionType: "format_disk" })).status === 422);
  check("B13f the safety state of the Intelligence was NOT changed by any Action step", (await snap(gas.intel._id)) === intelSnaps.gas && (await snapDecision(dGas.id)) === decSnaps.gas);

  // ---- 14 chat
  const chatBefore = { actions: await Action.countDocuments({}), decisions: await Decision.countDocuments({}), analyze: proxyLog.analyze };
  const chatTries = ["Create an action to dispatch maintenance to room 221.", "Execute the action for the AC problem.", "Approve the action and send maintenance now.", "Run the action proposal automatically without approval.", "send maintenance to room 221"];
  const chatResults = [];
  for (const text of chatTries) chatResults.push(await turn(me, A, text));
  check("B14 [chat boundary] chat cannot create, approve or run an Action: instructions are declined (no signal) or at most recorded as a plain Signal - no Action, no Decision, no Intelligence and no AI call results from any of them", chatResults.every((r) => [200, 201].includes(r.status) && !r.data?.action) && (await Action.countDocuments({})) === chatBefore.actions && (await Decision.countDocuments({})) === chatBefore.decisions && proxyLog.analyze === chatBefore.analyze && chatResults.slice(0, 4).every((r) => r.data?.created === false), chatResults.map((r) => r.data?.outcome).join(","));

  // ---- review: single user
  const before16 = { outcomes: await Outcome.countDocuments({}), conversations: await Conversation.countDocuments({}), messages: await Message.countDocuments({}), signals: await Signal.countDocuments({}), intelligences: await Intelligence.countDocuments({}), decisions: await Decision.countDocuments({}), actions: await Action.countDocuments({}) };
  const opApprove = await reviewAction(operator, a1.data._id, "approve");
  const forgedReview = [];
  for (const f of [{ reviewerId: String(opB.user._id) }, { reviewedBy: String(me.user._id) }, { workspaceId: B }, { status: "approved" }, { role: "admin" }, { actionType: "escalation" }]) forgedReview.push((await reviewAction(me, a1.data._id, "approve", f)).status);
  const bApprove = await reviewAction(adminB, a1.data._id, "approve", {}, B);
  const bApproveA = await reviewAction(adminB, a1.data._id, "approve", {}, A);
  check("B15 [review authority] an operator cannot review (403); forged reviewerId / reviewedBy / workspaceId / status / role / actionType in a review body are refused (400); another workspace gets 404 whichever workspace it names - the Action stays proposed", opApprove.status === 403 && forgedReview.every((s) => s === 400) && bApprove.status === 404 && bApproveA.status === 404 && (await Action.findById(a1.data._id).lean()).status === "proposed");
  const aprBurst = await Promise.all(Array.from({ length: 6 }, () => reviewAction(me, a1.data._id, "approve", { note: "Confirmed." })));
  const aReviewed = await Action.findById(a1.data._id).lean();
  check("B16 [single user] the person who proposed the Action confirms their own (200): approved, ONE transition even for six simultaneous approvals; the reviewer is the authenticated actor and is recorded (the same user as the proposer); the Action is marked 'approved' and nothing else", aprBurst.every((r) => r.status === 200 && r.data.status === "approved") && aReviewed.transitions.length === 1 && String(aReviewed.review.reviewedBy) === String(me.user._id) && String(aReviewed.proposedBy) === String(me.user._id) && aprBurst[0].data.review.you.reviewed === true && !/reviewedBy/.test(aprBurst[0].text));
  const after16 = { outcomes: await Outcome.countDocuments({}), conversations: await Conversation.countDocuments({}), messages: await Message.countDocuments({}), signals: await Signal.countDocuments({}), intelligences: await Intelligence.countDocuments({}), decisions: await Decision.countDocuments({}), actions: await Action.countDocuments({}) };
  check("B17 [nothing is executed or created] confirming the Action wrote only the Action itself: no Outcome, Conversation, Message, Signal, Intelligence, Decision or other Action appeared, and the Intelligence and Decision are byte-identical (approve = a recorded status, not an operation)", JSON.stringify(after16) === JSON.stringify(before16) && (await snap(ac.intel._id)) === intelSnaps.ac && (await snapDecision(dAc.id)) === decSnaps.ac);
  const again = await reviewAction(me, a1.data._id, "approve");
  const rejectAfter = await reviewAction(me, a1.data._id, "reject", { note: "changed my mind" });
  check("B18 approving again is idempotent (200, no second transition); rejecting an approved Action is refused (409): terminal", again.status === 200 && rejectAfter.status === 409 && (await Action.findById(a1.data._id).lean()).transitions.length === 1);
  const aRej = await proposeAction(me, dRag.id); // existing (inspection)
  const rejOk = await reviewAction(me, aRej.data._id, "reject");
  check("B19 a NORMAL-state proposal may be rejected with no reason (200, rejected); a rejected proposal keeps its slot (re-proposing returns it, 200), so a rejection cannot be used to mint a second Action", rejOk.status === 200 && rejOk.data.status === "rejected" && (await proposeAction(me, dRag.id)).data._id === aRej.data._id && (await Action.countDocuments({ decisionId: dRag.id })) === 1);

  // ---- 18 persistence, reads
  const list = await call("GET", `/actions?workspaceId=${A}&decisionId=${dAc.id}`, me);
  const one = await call("GET", `/actions/${a1.data._id}?workspaceId=${A}`, me);
  const foreignList = await call("GET", `/actions?workspaceId=${B}&decisionId=${dAc.id}`, adminB);
  const foreignOne = await call("GET", `/actions/${a1.data._id}?workspaceId=${B}`, adminB);
  check("B20 [refresh] the stored state is what a later read returns: the list and the detail agree (approved, one transition, you = proposer + reviewer), in the one view shape with no actor identity; another workspace sees an empty list and a 404", list.status === 200 && list.data.length === 1 && list.data[0].status === "approved" && one.data.status === "approved" && one.data.transitions.length === 1 && list.data[0].review.you.reviewed === true && !/proposedBy|reviewedBy|governanceVersion/.test(list.text + one.text) && foreignList.data.length === 0 && foreignOne.status === 404);

  // ---- 15,19 RAG miss, gemini
  const aRagDesc = (await Action.findOne({ decisionId: dRag.id }).lean()).description;
  check("B21 [RAG miss, Phase 48.1] a proposal that follows a Decision made with NO business knowledge preserves the cautious statement and invents no company policy: its description is the approved recommendation ('No documented guidance was retrieved'), unchanged", /No documented guidance was retrieved/.test(aRagDesc) && !/\b(?:company|house|hotel|our)\s+(?:policy|sop)\b/i.test(aRagDesc));
  check("B22 [AI calls] every Decision and Action operation (propose, approve, reject, list, get, chat attempts) made ZERO AI-service calls: no analysis, no retrieval, no embedding (7 explicit generations happened before this point, none after)", proxyLog.analyze === 0 && proxyLog.retrieval === 0 && proxyLog.embeddings === 0 && proxyLog.other === 0, JSON.stringify(proxyLog));
  check("B23 [outcome] no Outcome exists after every Action step: nothing records a result because nothing was carried out", (await Outcome.countDocuments({})) === 0);
  check("B24 [policy] the single-user Action policy is live and computed, not hard-coded: self-review is allowed only because no role can execute an Action (action:execute held by nobody)", GOVERNANCE_POLICY.Action.selfReviewAllowed === true);
  process.env.KOI_ACTION_REVIEW_REQUIRES_SECOND_PERSON = "true";
  const strictPolicy = GOVERNANCE_POLICY.Action.selfReviewAllowed;
  delete process.env.KOI_ACTION_REVIEW_REQUIRES_SECOND_PERSON;
  check("B24b the server-configured switch restores the second-person rule for Actions (it can only make the rule STRICTER), and the Decision policy is unaffected", strictPolicy === false && GOVERNANCE_POLICY.Decision.selfReviewAllowed === true);

  // ======================================================================================================== F
  console.log("\n# F. the frontend");
  const { createServer } = await import(pathToFileURL(path.join(FRONTEND, "node_modules", "vite", "dist", "node", "index.js")).href);
  vite = await createServer({ root: FRONTEND, configFile: path.join(FRONTEND, "vite.config.js"), server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom", logLevel: "silent", optimizeDeps: { noDiscovery: true, include: [] } });
  const am = await vite.ssrLoadModule("/src/features/assistant/actionMapping.js");
  const dm = await vite.ssrLoadModule("/src/features/assistant/decisionMapping.js");
  const ws = await vite.ssrLoadModule("/src/config/workspace.js");
  const mapped = am.mapCaseAction(list.data[0]);
  check("F1 the Action maps to the page's shape: action-v1 only, a known status, plain labels for type / risk / urgency, the description presented as plain text, identity only as two booleans, and NO id in any displayed field", mapped.status === "approved" && typeof mapped.typeLabel === "string" && mapped.reviewedByYou === true && mapped.proposedByYou === true && !HEX24.test(JSON.stringify({ ...mapped, id: undefined })) && am.mapCaseAction({ ...list.data[0], actionVersion: undefined }) === null && am.mapCaseAction({ ...list.data[0], status: "completed" }) === null && am.mapCaseAction(null) === null);
  check("F2 [availability] from the Decision's state ALONE: no decision / proposed -> 'waiting', rejected -> 'closed' (no Action is ever offered), approved -> 'available'", am.actionAvailability(null) === "waiting" && am.actionAvailability({ status: "proposed" }) === "waiting" && am.actionAvailability({ status: "rejected" }) === "closed" && am.actionAvailability({ status: "approved" }) === "available");
  const st = (o) => dm.caseStages(o).map((s) => `${s.label}:${s.state}`).join(" ");
  const base = { contextReady: true, intelligenceReady: true };
  check("F3 [progress] Action is 'later' until the Decision is APPROVED (never for a rejected or proposed one), then 'next'; 'review' while a proposal waits; 'done' once reviewed; Outcome stays 'later' until the Action is approved (Phase 50) (the progress names only Assessment, Decision, Action, Outcome)", /Action:later/.test(st({ ...base, decision: null })) && /Action:later/.test(st({ ...base, decision: { status: "proposed" } })) && /Action:later/.test(st({ ...base, decision: { status: "rejected" } })) && /Action:next/.test(st({ ...base, decision: { status: "approved" } })) && /Action:review/.test(st({ ...base, decision: { status: "approved" }, action: { status: "proposed" } })) && ["approved", "rejected"].every((s) => /Action:done/.test(st({ ...base, decision: { status: "approved" }, action: { status: s } }))) && ["proposed", "rejected"].every((s) => /Outcome:later$/.test(st({ ...base, decision: { status: "approved" }, action: { status: s } }))) && /Outcome:next$/.test(st({ ...base, decision: { status: "approved" }, action: { status: "approved" } })));
  const failures = [[403], [400, "ACTION_REASON_REQUIRED"], [400, "X"], [404], [409], [422], [429], [0], [500]].map(([status, c]) => am.describeActionFailure({ status, code: c, message: "RAW stack at x.js:1 MongoServerError E11000 mongodb://127.0.0.1/koi", details: { workspaceId: A } }));
  check("F4 every failure is a fixed plain sentence: no status, code, server text, id, path, URL or stack", failures.every((m) => m.length > 15 && !/RAW|stack|x\.js|Mongo|E11000|mongodb|127\.0|ACTION_|\b(?:400|403|404|409|422|429|500)\b/.test(m) && !HEX24.test(m)) && new Set(failures).size >= 8);
  const React = (await import("node:module")).createRequire(path.join(FRONTEND, "package.json"))("react");
  const { renderToString } = (await import("node:module")).createRequire(path.join(FRONTEND, "package.json"))("react-dom/server");
  const panel = (await vite.ssrLoadModule("/src/features/assistant/ActionPanel.jsx")).default;
  const noop = () => {};
  const render = (role, decision, action, constraint = { level: "none" }, status = "ready", extra = {}) => { ws.setActiveWorkspace(A, role); return renderToString(React.createElement(panel, { decision, constraint, actionState: { status, action, busy: false, actionError: null, reload: noop, propose: noop, approve: noop, reject: noop, ...extra } })).replace(/<!-- -->/g, "").replace(/&#x27;/g, "'"); };
  const act = (over) => ({ id: "a", status: "proposed", typeLabel: "Maintenance dispatch", riskLabel: "Medium", riskTone: "medium", urgencyLabel: "Prompt", description: "Inspect the AC unit in room 221.", reviewedAt: null, reviewNote: null, proposedByYou: true, reviewedByYou: false, ...over });
  const approvedDecision = { id: "d", status: "approved" };
  const waiting = render("admin", { id: "d", status: "proposed" }, null); const none = render("admin", null, null);
  const closed = render("admin", { id: "d", status: "rejected" }, null);
  const offer = render("admin", approvedDecision, null); const offerViewer = render("viewer", approvedDecision, null);
  const proposed = render("admin", approvedDecision, act({})); const proposedOp = render("operator", approvedDecision, act({}));
  const done = render("admin", approvedDecision, act({ status: "approved", reviewedByYou: true, reviewedAt: "2026-10-08T10:00:00Z", reviewNote: "Confirmed." }));
  const rejected = render("admin", approvedDecision, act({ status: "rejected", reviewedByYou: true, reviewNote: "Handled by the engineer." }));
  const hazard = render("admin", approvedDecision, act({ typeLabel: "Escalation", riskLabel: "Critical", riskTone: "critical", urgencyLabel: "Immediate" }), { level: "hazard", reasonRequired: true, alternativeRequired: true });
  check("F5 [panel by state] unapproved or no Decision: 'becomes available once the decision is approved', no button; REJECTED Decision: 'no action proposal is made', no button; approved and none yet: 'Create action proposal' (a viewer sees none)", /becomes available once the decision is approved/.test(waiting) && !/<button/.test(waiting) && !/<button/.test(none) && /no action proposal is made/.test(closed) && !/<button/.test(closed) && /Create action proposal/.test(offer) && !/Create action proposal/.test(offerViewer) && /can.t create action proposals/.test(offerViewer));
  check("F6 [panel by state] a proposal shows 'Ready for review' and 'Not executed' with Approve action proposal / Reject for the person who may review (their OWN proposal included), only 'Waiting' for an operator; reviewed shows 'Action approved' / 'Action proposal rejected', 'Not executed', the reason", /Ready for review/.test(proposed) && /Not executed/.test(proposed) && /Approve action proposal/.test(proposed) && /Reject/.test(proposed) && !/Approve action proposal/.test(proposedOp) && /Waiting for someone with review permission/.test(proposedOp) && /Action approved/.test(done) && /Not executed/.test(done) && /Note:<\/strong> Confirmed\./.test(done) && /Action proposal rejected/.test(rejected) && /Reason:<\/strong> Handled by the engineer\./.test(rejected) && !/<button/.test(done) && !/<button/.test(rejected));
  const everything = [waiting, none, closed, offer, offerViewer, proposed, proposedOp, done, rejected, hazard].join(" \n ");
  check("F7 [wording] the page never implies anything happened outside the record: no 'executed' without 'Not', no sent / dispatched / completed / done-for-you claim, no 'Action executed'", !/(?<!Not )executed/i.test(everything.replace(/Not executed/g, "")) && !/(?<!nothing )\b(?:has been|was|were) (?:sent|dispatched|booked|completed|carried out)\b/i.test(everything) && /nothing has been sent, dispatched or changed/i.test(done));
  check("F8 [safety wording] a hazard / critical proposal says its type and urgency are fixed by the recorded safety requirement and that rejecting needs a reason (role=note); nothing implies the hazard may be deferred", /role="note"/.test(hazard) && /fixed by it, and rejecting it needs a recorded reason/.test(hazard) && !/safe to (?:defer|wait|ignore)|can wait|no rush|optional/i.test(hazard.replace(/Reason \(required\)/, "")));
  check("F9 [no internals] no rendered state contains an id, ObjectId, evidence reference, workspace id, URL, environment variable, stack trace or status code", !HEX24.test(everything) && !/ObjectId|mongodb|localhost|127\.0\.0\.1|process\.env|at \w+ \(|evidence ref|knowledge:|current:signal/i.test(everything));
  const prog = renderToString(React.createElement((await vite.ssrLoadModule("/src/features/assistant/CaseProgress.jsx")).default, { stages: dm.caseStages({ ...base, decision: { status: "approved" }, action: { status: "approved" } }) }));
  check("F10 [progress] the case progress shows Action done and Outcome next (an approved Action, nothing recorded); there is no workflow strip and no Learning step", /Action[\s\S]*?Done/.test(prog) && /Outcome[\s\S]*?Next/.test(prog) && !/Learning|Signal|Context|Intelligence/.test(prog) && !fs.existsSync(path.join(FRONTEND, "src", "features", "assistant", "WorkflowStrip.jsx")));

  // ======================================================================================================== S
  console.log("\n# S. static architecture");
  const svc = code(path.join(BACKEND, "src", "services", "actionService.js"));
  const ctl = code(path.join(BACKEND, "src", "controllers", "actionController.js"));
  const hook = code(path.join(FRONTEND, "src", "features", "assistant", "useCaseAction.js"));
  const panelSrc = code(path.join(FRONTEND, "src", "features", "assistant", "ActionPanel.jsx"));
  const card = code(path.join(FRONTEND, "src", "features", "assistant", "SignalCaseCard.jsx"));
  check("S1 the Action path is inert and AI-free: the service and controller import no AI client, no analysis service, no HTTP/process module, and no Outcome; the page's hook has no analyse call, no fetch / axios, and no polling timer", !/aiServiceClient|intelligenceAnalysisService|llmProvider|node:child_process|node:http|node-fetch|axios|\bfetch\(|Outcome|nodemailer|\bspawn\b|\bexec\(/.test(svc + ctl) && !/analyzeSignal|intelligence\/analyze|fetch\(|axios|setInterval|setTimeout/.test(hook) && !/fetch\(|axios|setInterval/.test(panelSrc));
  check("S2 the browser names only a Decision (a route value): proposeAction sends no body, there is no request field that can carry a type, risk, urgency, workspace, user or reviewer", /export function proposeAction\(decisionId, workspaceId\)/.test(code(path.join(FRONTEND, "src", "services", "api.js"))) && /api\.post\(koiEndpoints\.actionPropose\(decisionId\), undefined,/.test(code(path.join(FRONTEND, "src", "services", "api.js"))));
  check("S3 the Action panel never reads the safety object (only the case card, an integration point, hands it the structured constraint) and names no safety state", !/\.safety\b|LIFE_SAFETY_HAZARD|CRITICAL|NORMAL/.test(panelSrc + hook) && /safetyConstraint\(intel\.intelligence\.safety\)/.test(card));
  check("S4 the server holds the rules: type / risk / urgency are derived inside proposeAction from the stored parent Intelligence's structured safety (never from the request), and only an approved Decision V1 is accepted", /resolveActionType\(actionType, safety\)/.test(svc) && /riskFor\(resolvedType, safety\)/.test(svc) && /decision\.status !== "approved"/.test(svc) && !/req\.body/.test(svc));
} finally {
  try { if (vite) await vite.close(); } catch { /* closing */ }
  for (const c of children) { try { c.kill(); } catch { /* gone */ } }
  try { if (proxyServer) proxyServer.close(); } catch { /* closed */ }
  try { await mongoose.connection.dropDatabase(); } catch { /* dropped */ }
  await mongoose.disconnect();
}
console.log(`\nPhase 49 Decision -> Action validation: ${passed} passed, ${failed} failed (isolated database ${DB_NAME} dropped)`);
process.exit(failed ? 1 : 0);
