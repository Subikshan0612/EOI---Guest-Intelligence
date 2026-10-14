/**
 * Phase 50 - ACTION -> OUTCOME: a PERSON records what actually happened after an approved Action.
 *
 *   node backend/scripts/validate-phase50-action-outcome.mjs
 *
 *   B  the real API on an ISOLATED throwaway database (koi_p50_<stamp>, dropped at the end), against the REAL ai-service in its deterministic TEST mode behind a
 *      COUNTING proxy: cases are created conversationally, analysed through the existing endpoint, decided and proposed as Actions (Phases 48-49, a single user
 *      confirms their own), then an Outcome is recorded by the person: eligibility (approved / rejected / proposed / missing), tenant isolation, forged fields,
 *      unauthenticated, provenance, immutability of everything upstream, one-Outcome-per-Action (duplicate + concurrent), validation, chat boundary, zero AI
 *      calls, Learning off, nothing executed.
 *   F  the frontend (Vite SSR): mapping, availability, stage progress, panel rendering per state, wording, no ids / codes / internals, workflow strip
 *   S  static architecture: no AI client, no execution, no Learning in the Outcome path
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
const DB_NAME = `koi_p50_${stamp}`;
if (!baseUri || /^mongodb\+srv:|@/.test(baseUri) || !/^mongodb:\/\/(localhost|127\.0\.0\.1)/.test(baseUri)) { console.error("refusing: the configured MongoDB is not a plain loopback instance"); process.exit(2); }
process.env.MONGODB_URI = baseUri.replace(/(mongodb:\/\/[^/]+\/)([^?]*)/, `$1${DB_NAME}`);
delete process.env.KOI_ACTION_REVIEW_REQUIRES_SECOND_PERSON;
delete process.env.KOI_LEARNING_CONTEXT_ENABLED;

const { createActor } = await import("./lib/authFixtures.mjs");
const { getLearningContextEnabled } = await import("../src/config/runtimeConfig.js");
const mongoose = (await import("mongoose")).default;
const { connectDatabase } = await import("../src/config/database.js");
const { Action, Decision, Intelligence, Signal, Workspace, Property, Unit, Outcome } = await import("../src/models/index.js");
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
  const AI_PORT = 8087; const PROXY_PORT = 8088; const API_PORT = 5093;
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

  const wsA = await Workspace.create({ name: `P50 a ${stamp}`, slug: `p50-a-${stamp}`, status: "active" });
  const wsB = await Workspace.create({ name: `P50 b ${stamp}`, slug: `p50-b-${stamp}`, status: "active" });
  const A = String(wsA._id); const B = String(wsB._id);
  const hv = await Property.create({ workspaceId: wsA._id, name: "Harbour View", code: "HBV" });
  const ot = await Property.create({ workspaceId: wsB._id, name: "Other Tower", code: "OTW" });
  for (const n of ["221", "105", "301", "412", "118", "502", "503", "504", "505", "506"]) await Unit.create({ propertyId: hv._id, unitNumber: n });
  await Unit.create({ propertyId: ot._id, unitNumber: "221" });
  const me = await createActor({ role: "admin", workspaceId: wsA._id, label: "p50-me" }); // the normal product user: admin of their own workspace
  const operator = await createActor({ role: "operator", workspaceId: wsA._id, label: "p50-op" });
  const viewer = await createActor({ role: "viewer", workspaceId: wsA._id, label: "p50-viewer" });
  const adminB = await createActor({ role: "admin", workspaceId: wsB._id, label: "p50-adminb" });
  const opB = await createActor({ role: "operator", workspaceId: wsB._id, label: "p50-opb" });
  const call = async (method, url, who, body, extra = {}) => {
    const res = await fetch(`${BASE}${url}`, { method, headers: { ...(who ? who.headers : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* none */ } return { status: res.status, json, data: json?.data, text };
  };
  const turn = (who, ws, content) => call("POST", "/conversations/intake", who, { workspaceId: ws, content });
  /** a case taken as far as an Action in the requested state: signal -> intelligence -> decision (approved) -> action (approved | rejected | proposed | none) */
  const makeCase = async (text, actionState) => {
    const t = await turn(me, A, text);
    const signalId = t.data?.signal?._id;
    const gen = signalId ? await call("POST", `/intelligence/analyze/${signalId}?workspaceId=${A}`, me) : null;
    const dec = gen?.data ? await call("POST", `/decisions/propose/${gen.data._id}?workspaceId=${A}`, me) : null;
    const decApproved = dec?.data ? await call("POST", `/decisions/${dec.data._id}/approve?workspaceId=${A}`, me, {}) : null;
    let act = null;
    if (actionState) {
      act = await call("POST", `/actions/propose/${dec.data._id}?workspaceId=${A}`, me);
      if (actionState === "approved") act = await call("POST", `/actions/${act.data._id}/approve?workspaceId=${A}`, me, { note: "Ready." });
      if (actionState === "rejected") act = await call("POST", `/actions/${act.data._id}/reject?workspaceId=${A}`, me, { note: "Not needed." });
    }
    return { signalId, intel: gen?.data, decisionId: dec?.data?._id, decisionStatus: decApproved?.data?.status, action: act ? act.data : null, ok: t.status === 201 && gen?.status === 201 && decApproved?.status === 200 && (!actionState || [200, 201].includes(act?.status)) };
  };
  const record = (who, actionId, body, ws = A, extra) => call("POST", `/outcomes/record/${actionId}?workspaceId=${ws}`, who, body, extra);
  const snap = async (Model, id) => JSON.stringify(await Model.findById(id).lean());
  const dbCounts = async () => Object.fromEntries(await Promise.all((await mongoose.connection.db.listCollections().toArray()).map(async (c) => [c.name, await mongoose.connection.db.collection(c.name).countDocuments()])));
  const SAY = (text) => ({ status: "success", result: { summary: text } });

  // ======================================================================================================== B
  console.log("\n# B. Action -> Outcome on the real API");
  const ac = await makeCase("Guest in room 221 says the AC stopped working and the room is getting very hot.", "approved");
  const rej = await makeCase("Guest in room 412 reports a dripping tap in the bathroom.", "rejected");
  const prop = await makeCase("Guest in room 118 reports a squeaking door in the corridor.", "proposed");
  const nodecAction = await makeCase("Guest in room 502 reports the television remote is not working.", null);
  const gas = await makeCase("Guest reports a strong gas smell in room 105.", "approved");
  const race = await makeCase("Guest in room 503 reports a flickering lamp.", "approved");
  const failedCase = await makeCase("Guest in room 504 reports a stuck window latch.", "approved");
  const unknownCase = await makeCase("Guest in room 505 reports a noisy fridge.", "approved");
  const partialCase = await makeCase("Guest in room 506 reports a loose shower head.", "approved");
  const fresh = await makeCase("Guest in room 301 reports a squeaking wardrobe.", "approved");
  const edge = await makeCase("Guest in room 118 reports a rattling vent.", "approved");
  const cases = [ac, rej, prop, nodecAction, gas, race, failedCase, unknownCase, partialCase, fresh, edge];
  check("B0 eleven cases taken through Signal, Intelligence (a RAG miss: the workspace holds no business knowledge, Phase 48.1), an approved Decision and the Action state each test needs - approved (AC, gas, lamp, latch, fridge, shower), rejected (tap), proposed (door), none (remote), and two more approved ones for the input tests", cases.every((c) => c.ok) && ac.action.status === "approved" && rej.action.status === "rejected" && prop.action.status === "proposed" && nodecAction.action === null, cases.map((c) => c.ok).join(","));
  const generations = proxyLog.analyze;
  resetProxy();
  const learningBefore = await dbCounts();
  const snaps = { intel: await snap(Intelligence, ac.intel._id), decision: await snap(Decision, ac.decisionId), action: await snap(Action, ac.action._id), gasIntel: await snap(Intelligence, gas.intel._id), gasAction: await snap(Action, gas.action._id) };
  const upstreamBefore = { signals: await Signal.countDocuments({}), intel: await Intelligence.countDocuments({}), decisions: await Decision.countDocuments({}), actions: await Action.countDocuments({}) };
  check("B0b the Outcome collection is empty and nothing recorded so far made an Outcome: approving a Decision or an Action creates no Outcome (a record of reality is a separate human report)", (await Outcome.countDocuments({})) === 0 && generations === 11);

  // ---- 8 unauthenticated, 2/3/4 eligibility
  const noAuth = await call("POST", `/outcomes/record/${ac.action._id}?workspaceId=${A}`, null, SAY("It worked."));
  const badToken = await record(null, ac.action._id, SAY("It worked."), A, { authorization: "Bearer not-a-token" });
  check("B8 unauthenticated requests are refused (401): no credential and a bad credential; nothing is stored", noAuth.status === 401 && badToken.status === 401 && (await Outcome.countDocuments({})) === 0);
  const oRej = await record(me, rej.action._id, SAY("Someone went anyway."));
  const oProp = await record(me, prop.action._id, SAY("Someone went anyway."));
  check("B2 a REJECTED Action cannot take an Outcome (409), and nothing is stored", oRej.status === 409 && (await Outcome.countDocuments({ actionId: rej.action._id })) === 0);
  check("B3 a PROPOSED Action cannot take an Outcome (409): approved means ready, and a proposal nobody confirmed has nothing to report on; nothing is stored", oProp.status === 409 && (await Outcome.countDocuments({ actionId: prop.action._id })) === 0);
  const missing = await record(me, String(new mongoose.Types.ObjectId()), SAY("x"));
  const decisionAsAction = await record(me, ac.decisionId, SAY("x"));
  const intelAsAction = await record(me, String(ac.intel._id), SAY("x"));
  const badId = await record(me, "not-an-id", SAY("x"));
  check("B4 a missing Action, a Decision id or an Intelligence id used as an Action id are a plain 404 (a malformed id is a 400): no existence oracle, nothing stored", missing.status === 404 && decisionAsAction.status === 404 && intelAsAction.status === 404 && badId.status === 400 && (await Outcome.countDocuments({})) === 0);
  check("B4b a Decision that never got an Action has nothing to record an Outcome against (there is no route from a Decision to an Outcome)", nodecAction.action === null && (await call("POST", `/outcomes/record/${nodecAction.decisionId}?workspaceId=${A}`, me, SAY("x"))).status === 404);

  // ---- 5, 6, 7 isolation, forged
  const bRec = await record(adminB, ac.action._id, SAY("x"), B);
  const bRecForgedSel = await record(adminB, ac.action._id, SAY("x"), A);
  const bOp = await record(opB, ac.action._id, SAY("x"), B);
  const opSelectsB = await record(operator, ac.action._id, SAY("x"), B);
  check("B5 [tenant isolation] another workspace's admin / operator cannot record an Outcome for this workspace's Action (404 whichever workspace they name); an operator of A naming B is refused too; nothing is stored", [bRec, bRecForgedSel, bOp, opSelectsB].every((r) => r.status === 404) && (await Outcome.countDocuments({})) === 0);
  const forgedBodies = [{ workspaceId: B }, { actionId: String(gas.action._id) }, { decisionId: gas.decisionId }, { intelligenceId: String(gas.intel._id) }, { signalId: String(gas.signalId) }, { propertyId: String(hv._id) }, { outcomeVersion: "outcome-v1" }, { recordedBy: String(opB.user._id) }, { recordedAt: "2020-01-01T00:00:00Z" }, { actionVersion: "action-v1" }, { role: "admin" }];
  const forgedResults = [];
  for (const f of forgedBodies) forgedResults.push((await record(me, ac.action._id, { ...SAY("It worked."), ...f })).status);
  check("B6 [forged fields] a workspaceId / actionId / decisionId / intelligenceId / signalId / propertyId / outcomeVersion / recordedBy / recordedAt / actionVersion / role in the body is refused (400) and nothing is stored: every relationship comes from the stored Action", forgedResults.every((s) => s === 400) && (await Outcome.countDocuments({})) === 0, forgedResults.join(","));
  const viewerRec = await record(viewer, ac.action._id, SAY("x"));
  const opRec = await record(operator, ac.action._id, SAY("x"));
  const legacyCreate = await call("POST", "/outcomes", me, { workspaceId: A, intelligenceId: String(ac.intel._id), actionId: String(ac.action._id), status: "success" });
  check("B9 [authorization] a viewer cannot record (403); the legacy generic create / update stay closed to everyone including the admin (403: action:execute is held by no role); an operator may use the route but cannot see an admin-generated (restricted-level) analysis, so it is the same 404 as a missing Action; nothing is stored", viewerRec.status === 403 && legacyCreate.status === 403 && opRec.status === 404 && (await Outcome.countDocuments({})) === 0);

  // ---- 1, 10 success + provenance
  const o1 = await record(me, ac.action._id, SAY("The technician inspected the unit and confirmed a compressor failure."));
  const o1doc = await Outcome.findById(o1.data?._id).lean();
  check("B1 an APPROVED Action takes an Outcome (201) from the authenticated user: status success, the person's own words stored exactly, recorded-at set by the server, outcome-v1", o1.status === 201 && o1.data.status === "success" && o1.data.result.summary === "The technician inspected the unit and confirmed a compressor failure." && o1.data.outcomeVersion === "outcome-v1" && !!o1.data.recordedAt && o1doc.status === "success");
  check("B1b the recorder is the authenticated actor, set by the server; the view exposes only a boolean (recordedByYou), no user id, name or email, no governance field", String(o1doc.recordedBy) === String(me.user._id) && o1.data.recordedByYou === true && !/recordedBy"|proposedBy|reviewedBy|email/.test(o1.text));
  const actionDoc = await Action.findById(ac.action._id).lean();
  check("B10 the Outcome names its whole chain - Outcome -> Action -> Decision -> Intelligence -> Signal (and the property) - all derived from the stored Action, none supplied by the client", String(o1doc.actionId) === String(ac.action._id) && String(o1doc.decisionId) === String(ac.decisionId) && String(o1doc.intelligenceId) === String(ac.intel._id) && String(o1doc.signalId) === String(ac.signalId) && String(o1doc.decisionId) === String(actionDoc.decisionId) && String(o1doc.propertyId ?? "") === String(actionDoc.propertyId ?? "") && o1doc.actionVersion === "action-v1" && o1doc.workspaceId.equals(wsA._id));
  // ---- 11, 12, 13 immutability
  check("B11 the Intelligence is BYTE-IDENTICAL after the Outcome was recorded: an observation never rewrites the evidence", (await snap(Intelligence, ac.intel._id)) === snaps.intel);
  check("B12 the Decision is BYTE-IDENTICAL after the Outcome was recorded", (await snap(Decision, ac.decisionId)) === snaps.decision);
  check("B13 the Action is BYTE-IDENTICAL after the Outcome was recorded: it stays 'approved' (ready) with its one transition - recording what happened does NOT mark it executed or change its history", (await snap(Action, ac.action._id)) === snaps.action && (await Action.findById(ac.action._id).lean()).status === "approved");
  // ---- 14 duplicate
  const dup = await record(me, ac.action._id, { status: "failed", result: { summary: "Actually it did not work." } });
  const dup2 = await record(me, ac.action._id, SAY("The technician inspected the unit and confirmed a compressor failure."));
  const after = await Outcome.findOne({ actionId: ac.action._id }).lean();
  check("B14 [duplicate] a second Outcome for the same Action - different or identical - is a 409 conflict (OUTCOME_ALREADY_RECORDED): exactly one stored, and the original is untouched (history is never silently rewritten)", dup.status === 409 && dup.json?.details?.code === "OUTCOME_ALREADY_RECORDED" && dup2.status === 409 && (await Outcome.countDocuments({ actionId: ac.action._id })) === 1 && after.status === "success" && after.result.summary.startsWith("The technician") && String(after._id) === String(o1doc._id));
  // ---- 15 concurrent
  const burst = await Promise.all(Array.from({ length: 12 }, (_, i) => record(me, race.action._id, { status: i % 2 ? "success" : "failed", result: { summary: `Attempt ${i}` } })));
  check("B15 [concurrent] twelve SIMULTANEOUS submissions for one approved Action create exactly ONE Outcome (one 201, eleven 409): the server's unique index decides, not the page", burst.filter((r) => r.status === 201).length === 1 && burst.filter((r) => r.status === 409).length === 11 && (await Outcome.countDocuments({ actionId: race.action._id })) === 1);
  // ---- 16 statuses
  const statusTries = ["SUCCESS", "done", "completed", "ok", "", 5, null, ["success"], { a: 1 }];
  const statusResults = [];
  for (const status of statusTries) statusResults.push((await record(me, failedCase.action._id, { status, result: { summary: "x" } })).status);
  const oFailed = await record(me, failedCase.action._id, { status: "failed", result: { summary: "The latch snapped when the technician tried it." } });
  const oUnknown = await record(me, unknownCase.action._id, { status: "unknown", result: { summary: "Nobody could say whether the fridge was fixed." } });
  const oPartial = await record(me, partialCase.action._id, { status: "partial", result: { summary: "The shower head was tightened; the hose still needs a washer." } });
  const oBlocked = await record(me, gas.action._id, { status: "blocked", result: { summary: "Guest refused entry to the room; the area was cordoned off from the corridor." } });
  check("B16 [status vocabulary] only success / partial / failed / blocked / unknown are accepted: other spellings, cases, numbers, null, arrays, objects and the empty string are refused (422 or 400) and store nothing; each valid status is stored as given", statusResults.every((s) => [400, 422].includes(s)) && [oFailed, oUnknown, oPartial, oBlocked].every((r) => r.status === 201) && [oFailed.data.status, oUnknown.data.status, oPartial.data.status, oBlocked.data.status].join() === "failed,unknown,partial,blocked" && o1.data.status === "success");
  // ---- 17, 18 input
  const badBodies = [undefined, null, [], "success", {}, { status: "success" }, { status: "success", result: {} }, { status: "success", result: { summary: "" } }, { status: "success", result: { summary: "   \n\t " } }, { status: "success", result: { summary: 7 } }, { status: "success", result: "It worked" }, { status: "success", result: { summary: "ok", metrics: { x: 1 } } }, { status: "success", result: { summary: "ok" }, metrics: {} }, { status: "success", result: [] }];
  const badResults = [];
  for (const b of badBodies) badResults.push((await record(me, fresh.action._id, b)).status);
  check("B17 [empty / invalid] no body, null, an array, a bare string, an empty object, a status with no description, an empty or whitespace-only description, a non-string description, a string result, unknown result keys and unknown top-level keys are ALL refused (400 / 422) and nothing is stored", badResults.every((s) => [400, 422].includes(s)) && (await Outcome.countDocuments({ actionId: fresh.action._id })) === 0, badResults.join(","));
  const tooLong = await record(me, fresh.action._id, SAY("x".repeat(2001)));
  const countAfterTooLong = await Outcome.countDocuments({ actionId: fresh.action._id });
  const hostile = "<script>alert(1)</script> ' OR 1=1 -- {\"$ne\":null} \u0000 ${process.env.SECRET} ‮";
  const oHostile = await record(me, fresh.action._id, SAY(hostile + " é中🙂"));
  const hostileDoc = await Outcome.findById(oHostile.data?._id).lean();
  check("B18 [long / malformed] 2001 characters are refused (400); markup, injection-shaped text, operators, a NUL, a bidi override, template syntax and unicode are accepted ONLY as inert text: stored and returned exactly as written, never interpreted, and nothing else changes", tooLong.status === 400 && countAfterTooLong === 0 && oHostile.status === 201 && hostileDoc.result.summary.includes("<script>alert(1)</script>") && hostileDoc.result.summary.includes("$ne") && oHostile.data.status === "success" && !(await Signal.findOne({ title: /script/ })));
  const exact = await record(me, edge.action._id, SAY("y".repeat(2000)));
  check("B18b exactly 2000 characters are accepted (the limit is inclusive)", exact.status === 201 && exact.data.result.summary.length === 2000);

  // ---- safety
  check("B19 [safety] 'Guest refused entry' recorded against a LIFE-SAFETY Action is an observation: the Intelligence's safety state, the Decision and the Action (escalation / critical / immediate) are BYTE-IDENTICAL; nothing downgrades, and no safety logic reads the Outcome text", oBlocked.status === 201 && (await snap(Intelligence, gas.intel._id)) === snaps.gasIntel && (await snap(Action, gas.action._id)) === snaps.gasAction && (await Intelligence.findById(gas.intel._id).lean()).safety?.state === "LIFE_SAFETY_HAZARD");
  // ---- chat
  const chatBefore = { outcomes: await Outcome.countDocuments({}), actions: await Action.countDocuments({}), decisions: await Decision.countDocuments({}), analyze: proxyLog.analyze };
  const chatTries = ["Record an outcome: success.", "Please log the outcome for the AC action as completed.", "Mark the action as done and save the outcome.", "Create an outcome for room 221 saying it worked."];
  const chatResults = [];
  for (const text of chatTries) chatResults.push(await turn(me, A, text));
  const reportLike = await turn(me, A, "The guest in room 221 was moved successfully to room 301.");
  check("B20 [chat boundary] chat cannot record an Outcome: instructions to record, log, save, create or mark one are declined (no signal); a plain report such as 'the guest was moved successfully' may at most become a Signal; no Outcome, Action, Decision or AI call results from any of it", chatResults.every((r) => [200, 201].includes(r.status) && r.data?.created === false) && [200, 201].includes(reportLike.status) && (await Outcome.countDocuments({})) === chatBefore.outcomes && (await Action.countDocuments({})) === chatBefore.actions && (await Decision.countDocuments({})) === chatBefore.decisions && proxyLog.analyze === chatBefore.analyze, chatResults.map((r) => r.data?.outcome).join(",") + "|" + reportLike.data?.outcome);

  // ---- reads, persistence
  const list = await call("GET", `/outcomes?workspaceId=${A}&actionId=${ac.action._id}`, me);
  const one = await call("GET", `/outcomes/${o1.data._id}?workspaceId=${A}`, me);
  const foreignList = await call("GET", `/outcomes?workspaceId=${B}&actionId=${ac.action._id}`, adminB);
  const foreignOne = await call("GET", `/outcomes/${o1.data._id}?workspaceId=${B}`, adminB);
  const viewerList = await call("GET", `/outcomes?workspaceId=${A}`, viewer);
  check("B21 [refresh / reads] the stored Outcome is what a later read returns: list and detail agree (success, the person's words, recordedByYou), in the one view shape with no actor id and no governance field; another workspace sees an empty list and a 404; a viewer cannot read the list (403)", list.status === 200 && list.data.length === 1 && list.data[0].status === "success" && one.data.result.summary === o1.data.result.summary && list.data[0].recordedByYou === true && !/recordedBy"|proposedBy|reviewedBy|governanceVersion/.test(list.text + one.text) && foreignList.data.length === 0 && foreignOne.status === 404 && viewerList.status === 403);
  const patch = await call("PATCH", `/outcomes/${o1.data._id}?workspaceId=${A}`, me, { status: "failed" });
  const del = await call("DELETE", `/outcomes/${o1.data._id}?workspaceId=${A}`, me);
  check("B22 [immutable] an Outcome V1 cannot be edited or deleted through any route: PATCH is 403 (it needs action:execute, held by nobody), DELETE does not exist; the record is unchanged. There is no correction route in V1 - a wrong report is a documented limit, never a silent rewrite", patch.status === 403 && [403, 404, 405].includes(del.status) && (await Outcome.findById(o1.data._id).lean()).status === "success");

  // ---- RAG miss
  const ragIntel = await Intelligence.findById(ac.intel._id).lean();
  check("B23 [RAG miss, Phase 48.1] the AC case was analysed with NO business knowledge and still reached an approved Decision, an approved Action and an Outcome: an Outcome needs no business knowledge, no retrieval and no citation (it is a person's report, not a guidance claim)", (ragIntel.knowledgeProvenance ?? []).length === 0 && (ragIntel.analysis.usedKnowledgeChunkIds ?? []).length === 0 && o1.status === 201 && proxyLog.retrieval === 0);

  // ---- AI calls, learning, execution
  check("B24 [AI calls] every Outcome operation (record, duplicate, concurrent, invalid, list, get, forbidden, chat attempts) made ZERO AI-service calls - no analysis, no retrieval, no embedding (11 explicit generations happened before this point, none after)", proxyLog.analyze === 0 && proxyLog.retrieval === 0 && proxyLog.embeddings === 0 && proxyLog.other === 0, JSON.stringify(proxyLog));
  const beforeReread = { ...proxyLog };
  await call("GET", `/outcomes?workspaceId=${A}&actionId=${ac.action._id}`, me); await call("GET", `/actions?workspaceId=${A}&decisionId=${ac.decisionId}`, me); await call("GET", `/decisions?workspaceId=${A}&intelligenceId=${ac.intel._id}`, me); await call("GET", `/intelligence/${ac.intel._id}?workspaceId=${A}`, me);
  check("B25 [loading / refresh] loading the chain again (Intelligence, Decision, Action, Outcome - what a page refresh does) makes ZERO AI-service calls", JSON.stringify(proxyLog) === JSON.stringify(beforeReread) && proxyLog.analyze === 0);
  const learningAfter = await dbCounts();
  const names = (c) => Object.keys(c).filter((n) => !/^(outcomes)$/.test(n)).sort();
  const grown = Object.keys(learningAfter).filter((n) => learningAfter[n] !== (learningBefore[n] ?? 0)).sort();
  const reflected = new Set(["outcomes", "conversations", "messages", "signals"]);
  check("B26 [Learning stays OFF] the Learning context flag is off, no analysis ran during the Outcome work, no Learning-, pattern- or feedback-shaped collection exists or grew, and the only collections that grew are the Outcomes recorded and the chat turns (conversations / messages / declined or recorded signals)", getLearningContextEnabled() === false && !Object.keys(learningAfter).some((n) => /learn|pattern|feedback|insight/i.test(n)) && grown.every((n) => reflected.has(n)) && names(learningBefore).length > 0 && (await mongoose.connection.db.collection("analysisadmissions").countDocuments({ learningUsed: true })) === 0);
  const outcomes = await Outcome.countDocuments({});
  const upstreamAfter = { signals: await Signal.countDocuments({}), intel: await Intelligence.countDocuments({}), decisions: await Decision.countDocuments({}), actions: await Action.countDocuments({}) };
  check("B27 [nothing executed] recording Outcomes changed no Intelligence, Decision or Action (bytes, above), created no Action / Decision / Intelligence (counts identical to the snapshot taken before the first Outcome), and the Outcomes stored are exactly the ones recorded", upstreamAfter.intel === upstreamBefore.intel && upstreamAfter.decisions === upstreamBefore.decisions && upstreamAfter.actions === upstreamBefore.actions && outcomes === 8, `outcomes=${outcomes}`);

  // ======================================================================================================== F
  console.log("\n# F. the frontend");
  const { createServer } = await import(pathToFileURL(path.join(FRONTEND, "node_modules", "vite", "dist", "node", "index.js")).href);
  vite = await createServer({ root: FRONTEND, configFile: path.join(FRONTEND, "vite.config.js"), server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom", logLevel: "silent", optimizeDeps: { noDiscovery: true, include: [] } });
  const om = await vite.ssrLoadModule("/src/features/assistant/outcomeMapping.js");
  const dm = await vite.ssrLoadModule("/src/features/assistant/decisionMapping.js");
  const ws = await vite.ssrLoadModule("/src/config/workspace.js");
  const mapped = om.mapCaseOutcome(list.data[0]);
  check("F1 the Outcome maps to the page's shape: outcome-v1 only, a known status with a plain label, the person's words, recorded-by as a boolean, and NO id in any displayed field", mapped.status === "success" && mapped.statusLabel === "Success" && mapped.observation.startsWith("The technician") && mapped.recordedByYou === true && !HEX24.test(JSON.stringify({ ...mapped, id: undefined })) && om.mapCaseOutcome({ ...list.data[0], outcomeVersion: undefined }) === null && om.mapCaseOutcome({ ...list.data[0], status: "ai_determined" }) === null && om.mapCaseOutcome(null) === null && om.OUTCOME_CHOICES.map((c) => c.value).join() === "success,partial,failed,blocked,unknown");
  check("F2 [availability] from the Action's state ALONE: no Action / proposed -> 'waiting', rejected -> 'closed' (no form is ever offered), approved -> 'available'", om.outcomeAvailability(null) === "waiting" && om.outcomeAvailability({ status: "proposed" }) === "waiting" && om.outcomeAvailability({ status: "rejected" }) === "closed" && om.outcomeAvailability({ status: "approved" }) === "available");
  const st = (o) => dm.caseStages(o).map((s) => `${s.label}:${s.state}`).join(" ");
  const base = { contextReady: true, intelligenceReady: true, decision: { status: "approved" } };
  check("F3 [progress] Outcome is 'later' until the Action is APPROVED (never for a rejected or proposed one), then 'next', 'done' once a person recorded it; the progress names only Assessment, Decision, Action, Outcome", /Outcome:later/.test(st({ ...base, action: null })) && /Outcome:later/.test(st({ ...base, action: { status: "proposed" } })) && /Outcome:later/.test(st({ ...base, action: { status: "rejected" } })) && /Outcome:next/.test(st({ ...base, action: { status: "approved" } })) && /Outcome:done/.test(st({ ...base, action: { status: "approved" }, outcome: { status: "success" } })) && ["proposed", "approved", "rejected"].every((s) => /Outcome:[a-z]+$/.test(st({ ...base, action: { status: s }, outcome: s === "approved" ? { status: "success" } : null }))));
  const failures = [[403], [400, "OUTCOME_DESCRIPTION_REQUIRED"], [400, "X"], [404], [409], [422], [429], [0], [500]].map(([status, c]) => om.describeOutcomeFailure({ status, code: c, message: "RAW stack at x.js:1 MongoServerError E11000 mongodb://127.0.0.1/koi", details: { workspaceId: A } }));
  check("F4 every failure is a fixed plain sentence: no status, code, server text, id, path, URL or stack", failures.every((m) => m.length > 15 && !/RAW|stack|x\.js|Mongo|E11000|mongodb|127\.0|OUTCOME_|\b(?:400|403|404|409|422|429|500)\b/.test(m) && !HEX24.test(m)) && new Set(failures).size >= 8);
  const React = (await import("node:module")).createRequire(path.join(FRONTEND, "package.json"))("react");
  const { renderToString } = (await import("node:module")).createRequire(path.join(FRONTEND, "package.json"))("react-dom/server");
  const panel = (await vite.ssrLoadModule("/src/features/assistant/OutcomePanel.jsx")).default;
  const noop = () => {};
  const render = (role, action, outcome, status = "ready") => { ws.setActiveWorkspace(A, role); return renderToString(React.createElement(panel, { action, outcomeState: { status, outcome, busy: false, actionError: null, reload: noop, record: noop } })).replace(/<!-- -->/g, "").replace(/&#x27;/g, "'"); };
  const out = (over) => ({ id: "o", status: "success", statusLabel: "Success", observation: "The unit was repaired.", recordedAt: "2026-10-08T10:00:00Z", recordedByYou: true, ...over });
  const waiting = render("admin", null, null); const waitingProposed = render("admin", { status: "proposed" }, null); const closed = render("admin", { status: "rejected" }, null);
  const offer = render("admin", { status: "approved" }, null); const offerViewer = render("viewer", { status: "approved" }, null);
  const recorded = render("admin", { status: "approved" }, out({})); const blocked = render("admin", { status: "approved" }, out({ status: "blocked", statusLabel: "Blocked", observation: "Guest refused entry.", recordedByYou: false }));
  const loading = render("admin", { status: "approved" }, null, "checking");
  check("F5 [panel by state] no / proposed Action: 'can be recorded once the action proposal is approved', no control; REJECTED Action: 'nothing to record an outcome for', no control; approved and none yet: 'Record what happened' with a 'Record outcome' button (a viewer sees none)", /once the action proposal is approved/.test(waiting) && /once the action proposal is approved/.test(waitingProposed) && !/<button/.test(waiting + waitingProposed) && /nothing to record an outcome for/.test(closed) && !/<button/.test(closed) && /Record what actually happened/.test(offer) && /Record outcome/.test(offer) && !/Record outcome/.test(offerViewer) && /can.t record outcomes/.test(offerViewer) && /Checking for a recorded outcome/.test(loading));
  check("F6 [recorded] a recorded Outcome shows its result, the person's own words, 'Recorded by you' / 'by a colleague', 'Reported by a person' and that EOI did not observe or check it, and offers no button (it is not edited); no 'AI' wording", /Success/.test(recorded) && /The unit was repaired\./.test(recorded) && /Recorded by you/.test(recorded) && /Reported by a person/.test(recorded) && /did not observe or check this/.test(recorded) && /Blocked/.test(blocked) && /Recorded by a colleague/.test(blocked) && !/<button/.test(recorded + blocked) && !/\bAI\b|\bgenerated\b|determined|predicted|inferred/i.test(recorded + blocked + offer));
  const everything = [waiting, waitingProposed, closed, offer, offerViewer, recorded, blocked, loading].join(" \n ");
  check("F7 [wording] the page never implies EOI ran, observed or verified anything: it says 'EOI has not carried it out', 'in your own words', 'EOI does not check it, send it anywhere or act on it'; no 'executed', 'completed automatically', 'sent' or 'dispatched' claim", /EOI has not carried it out/.test(offer) && /in your own words/.test(offer) && /does not check it, send it anywhere or act on it/.test(offer) && !/\bexecuted\b|automatically completed|has been (?:sent|dispatched)|was (?:sent|dispatched)|AI determined/i.test(everything));
  check("F8 [no internals] no rendered state contains an id, ObjectId, evidence reference, workspace id, URL, environment variable, stack trace or status code", !HEX24.test(everything) && !/ObjectId|mongodb|localhost|127\.0\.0\.1|process\.env|at \w+ \(|evidence ref|knowledge:|current:signal/i.test(everything));
  const prog = renderToString(React.createElement((await vite.ssrLoadModule("/src/features/assistant/CaseProgress.jsx")).default, { stages: dm.caseStages({ ...base, action: { status: "approved" }, outcome: { status: "success" } }) }));
  check("F9 [progress] the case progress shows Outcome done; there is no workflow strip and no Learning step", /Outcome[\s\S]*?Done/.test(prog) && !/Learning|Signal|Context|Intelligence/.test(prog) && !fs.existsSync(path.join(FRONTEND, "src", "features", "assistant", "WorkflowStrip.jsx")));

  // ======================================================================================================== S
  console.log("\n# S. static architecture");
  const svc = code(path.join(BACKEND, "src", "services", "outcomeService.js"));
  const ctl = code(path.join(BACKEND, "src", "controllers", "outcomeController.js"));
  const hook = code(path.join(FRONTEND, "src", "features", "assistant", "useCaseOutcome.js"));
  const panelSrc = code(path.join(FRONTEND, "src", "features", "assistant", "OutcomePanel.jsx"));
  const api = code(path.join(FRONTEND, "src", "services", "api.js"));
  check("S1 the Outcome path is inert and AI-free: the service and controller import no AI client, no analysis / learning / pattern service, no HTTP / process module; the page's hook has no analyse call, no fetch / axios and no polling timer", !/aiServiceClient|intelligenceAnalysisService|llmProvider|learning|pattern|node:child_process|node:http|node-fetch|axios|\bfetch\(|nodemailer|\bspawn\b|\bexec\(/i.test(svc + ctl) && !/analyzeSignal|intelligence\/analyze|fetch\(|axios|setInterval|setTimeout|learning/i.test(hook) && !/fetch\(|axios|setInterval|learning/i.test(panelSrc));
  check("S2 the browser names only an Action (a route value) and the person's own words: recordOutcome sends { status, result: { summary } } - there is no request field for a workspace, user, decision, intelligence, signal or time", /export function recordOutcome\(actionId, workspaceId, body\)/.test(api) && /result: \{ summary \}/.test(hook) && !/workspaceId:|recordedBy|decisionId|intelligenceId|signalId/.test(hook));
  check("S3 the Outcome panel never reads the safety object and names no safety state", !/\.safety\b|LIFE_SAFETY_HAZARD|CRITICAL|NORMAL/.test(panelSrc + hook));
  check("S4 the server holds the rules: the chain is derived inside recordOutcome from the stored Action (never from the request), only an approved Action V1 is accepted, the recorder is the authenticated actor, and the route uses the existing operations:manage permission (no new permission)", /decisionId: action\.decisionId/.test(svc) && /signalId: action\.signalId/.test(svc) && /action\.status !== "approved"/.test(svc) && /requireActorUserId\(actorUserId\)/.test(svc) && !/req\.body\.(?:workspaceId|decisionId|intelligenceId|signalId|recordedBy)/.test(ctl) && /requireAccess\("operations:manage"\)/.test(code(path.join(BACKEND, "src", "routes", "outcomeRoutes.js"))));
} finally {
  try { if (vite) await vite.close(); } catch { /* closing */ }
  for (const c of children) { try { c.kill(); } catch { /* gone */ } }
  try { if (proxyServer) proxyServer.close(); } catch { /* closed */ }
  try { await mongoose.connection.dropDatabase(); } catch { /* dropped */ }
  await mongoose.disconnect();
}
console.log(`\nPhase 50 Action -> Outcome validation: ${passed} passed, ${failed} failed (isolated database ${DB_NAME} dropped)`);
process.exit(failed ? 1 : 0);
