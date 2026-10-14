/**
 * Phase 43B.1 validation - the validated safety result is persisted with new Intelligence and exposed by the existing read APIs.
 *
 *   node backend/scripts/validate-phase43b1-safety-metadata.mjs
 *
 * ISOLATED: every write goes to a throwaway database (koi_p43b1_<stamp>) on the same loopback MongoDB, dropped at the end. The normal `koi`
 * database is never opened. No Gemini call, no key, no network beyond loopback: a deterministic in-process stub AI service reports the APPROVED
 * identity, so the STRICT production validation (claims, urgency, action type, safety policy, prose, identifiers, confidence ceiling) really runs.
 *
 *   A  contract: the canonical safety source, its enums and the model
 *   B  persisted + returned: NORMAL / CRITICAL / LIFE_SAFETY_HAZARD, urgency and action type preserved exactly, access refusal, refusal + hazard
 *   C  backwards compatibility: an older record has no `safety`, and that is never "normal"
 *   D  spoofing / negatives: client, model, prose and unknown enums cannot create or change a safety state
 *   E  HTTP: Intelligence view, analyze response and dashboard detail; tenant isolation; no create/patch route
 *   F  unchanged architecture: claim validation, confidence ceiling, provenance shape, admission audit, protected-file hashes, no secrets or raw output
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import dotenv from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(here, "..");
const REPO = path.join(BACKEND, "..");
const read = (p) => fs.readFileSync(p, "utf8");
let passed = 0; let failed = 0;
const check = (name, ok, detail = "") => { if (ok) { passed += 1; console.log(`PASS  ${name}${detail ? ` - ${detail}` : ""}`); } else { failed += 1; console.error(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`); } };

// ---- isolated database: derive a throwaway name from the local loopback URI BEFORE anything reads it (never printed)
{ const __u = dotenv.parse(process.getBuiltinModule("node:fs").readFileSync(new URL("../.env", import.meta.url))).MONGODB_URI ?? ""; if (/^mongodb:\/\/(?:[^@/]*@)?(localhost|127\.0\.0\.1)/i.test(__u)) process.env.MONGODB_URI ??= __u; } // validation / rehearsal tools take ONLY a loopback database URI from backend/.env, never its real settings
const baseUri = process.env.MONGODB_URI;
const stamp = Date.now();
const DB_NAME = `koi_p43b1_${stamp}`;
if (!baseUri || /^mongodb\+srv:|@/.test(baseUri) || !/^mongodb:\/\/(localhost|127\.0\.0\.1)/.test(baseUri)) { console.error("refusing: the configured MongoDB is not a plain loopback instance"); process.exit(2); }
process.env.MONGODB_URI = baseUri.replace(/(mongodb:\/\/[^/]+\/)([^?]*)/, `$1${DB_NAME}`);
if (!process.env.MONGODB_URI.includes(DB_NAME)) { console.error("could not derive an isolated URI"); process.exit(2); }

const { createActor } = await import("./lib/authFixtures.mjs"); // declares NODE_ENV=test + the stub verifier for everything below
const mongoose = (await import("mongoose")).default;
const { connectDatabase } = await import("../src/config/database.js");
const { AnalysisAdmission, Intelligence, Signal, Workspace } = await import("../src/models/index.js");
const { SAFETY_STATES } = await import("../src/models/Intelligence.js");
const { ACTION_TYPES } = await import("../src/models/Action.js");
const { APPROVED_MODEL, APPROVED_PROVIDER } = await import("../src/config/providerPolicy.js");
const { URGENCY_LEVELS, deriveSafetyPolicy } = await import("../src/services/ai/safetyPolicy.js");
const { analyzeSignal } = await import("../src/services/intelligenceAnalysisService.js");
const { toIntelligenceView, toSafetyView } = await import("../src/services/intelligenceService.js");
const { toIntelligenceDetail } = await import("../src/services/dashboardService.js");
const { mapSafety } = await import(pathToFileURL(path.join(REPO, "frontend", "src", "features", "intelligence", "safetyMapping.js")).href);

await connectDatabase();
if (mongoose.connection.db.databaseName !== DB_NAME) { console.error("refusing: not connected to the isolated database"); process.exit(2); }

const realConsoleError = console.error;
const quietly = async (fn) => { console.error = () => {}; try { return await fn(); } finally { console.error = realConsoleError; } };
const caught = (fn) => quietly(async () => { try { await fn(); return null; } catch (e) { return e; } });

// ---- the deterministic stub AI service (approved identity => STRICT validation)
const fake = { build: null, calls: 0 };
const stub = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* not JSON */ }
    const send = (status, payload) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(payload)); };
    if (req.url.endsWith("/v1/knowledge-retrieval")) return send(200, { results: [], model: "stub-model", evaluatedCandidates: (body.candidates || []).length, incompatibleCandidates: 0 });
    if (!req.url.endsWith("/v1/intelligence/analyze")) return send(404, { error: { code: "MALFORMED_RESPONSE", message: "unexpected" } });
    fake.calls += 1;
    const sid = body?.context?.signal?.id;
    const good = {
      situation: "S", evidence: ["E"], impact: "I", recommendation: "Have the unit checked and keep the guest informed.", confidence: "high", usedKnowledgeChunkIds: [],
      provenance: { provider: APPROVED_PROVIDER, model: APPROVED_MODEL }, evidenceRefs: [], contradictions: [], urgency: "prompt", recommendedActionType: "inspection",
      claims: [{ claimType: "FACT", text: "The Signal is recorded.", sourceRefs: [`current:signal:${sid}`] }, { claimType: "RECOMMENDATION", text: "Act on the recorded Signal.", sourceRefs: [`current:signal:${sid}`] }],
    };
    return send(200, fake.build ? fake.build(good, sid) : good);
  });
});
await new Promise((resolve) => stub.listen(5083, resolve));
process.env.AI_SERVICE_URL = "http://localhost:5083";
process.env.LLM_PROVIDER = "test-python";
delete process.env.KOI_LEARNING_CONTEXT_ENABLED;

const wsA = await Workspace.create({ name: `P43B1 a ${stamp}`, slug: `p43b1-a-${stamp}`, status: "active" });
const wsB = await Workspace.create({ name: `P43B1 b ${stamp}`, slug: `p43b1-b-${stamp}`, status: "active" });
const A = String(wsA._id); const B = String(wsB._id);
const mkSignal = (severity, title, description) => Signal.create({ workspaceId: wsA._id, type: "maintenance", severity, title, description });
const runRaw = async (signal, build, level = "staff") => { fake.build = build; try { return await analyzeSignal(String(signal._id), A, { authorizedLevel: level }); } finally { fake.build = null; } };
const run = async (signal, over, level = "staff") => { fake.build = (good, sid) => ({ ...good, ...(typeof over === "function" ? over(good, sid) : over) }); try { return await analyzeSignal(String(signal._id), A, { authorizedLevel: level }); } finally { fake.build = null; } };
const keys = (o) => Object.keys(o).sort().join(",");

let httpChild = null;
try {
  // ============================================================================================================ A. contract
  console.log("\n# A. the canonical safety source");
  const policySrc = read(path.join(BACKEND, "src", "services", "ai", "safetyPolicy.js"));
  const returnedStates = new Set([
    deriveSafetyPolicy({ signal: { severity: "low", title: "Lamp", description: "A lamp is dim." } }).state,
    deriveSafetyPolicy({ signal: { severity: "critical", title: "Lockout", description: "Guest locked out." } }).state,
    deriveSafetyPolicy({ signal: { severity: "medium", title: "Gas", description: "A strong smell of gas." } }).state,
    // SAFETY_REVIEW_REQUIRED (owner-approved Option C) is returned only for a caller that opts in (the analysis pipeline); its closed cue list is tested in validate-safety-review-required.mjs.
    deriveSafetyPolicy({ signal: { severity: "low", title: "Lamp", description: "A guest reports a suspected danger." } }, { includeReviewRequired: true }).state,
  ]);
  check("A1 the persisted state enum is EXACTLY the set of states safetyPolicy.js's deriveSafetyPolicy returns (NORMAL, CRITICAL, SAFETY_REVIEW_REQUIRED, LIFE_SAFETY_HAZARD) - no other name, no rename", JSON.stringify([...returnedStates].sort()) === JSON.stringify([...SAFETY_STATES].sort()) && SAFETY_STATES.every((s) => policySrc.includes(`"${s}"`)), SAFETY_STATES.join(", "));
  check("A2 urgency and action type use the policy's own closed vocabularies (URGENCY_LEVELS from safetyPolicy.js, ACTION_TYPES from the Action model)", JSON.stringify(URGENCY_LEVELS) === '["immediate","prompt","routine"]' && ACTION_TYPES.includes("escalation") && ACTION_TYPES.includes("maintenance_dispatch"));
  const schemaPath = Intelligence.schema.path("safety");
  check("A3 the model's `safety` is optional (no default): a record without it stays without it", schemaPath && schemaPath.options.default === undefined && !Intelligence.schema.path("safety.state")?.options?.default);
  const invalid = new Intelligence({ workspaceId: wsA._id, safety: { state: "BOGUS" } });
  const invalid2 = new Intelligence({ workspaceId: wsA._id, safety: { state: "NORMAL", urgency: "now" } });
  const invalid3 = new Intelligence({ workspaceId: wsA._id, safety: { state: "NORMAL", recommendedActionType: "launch_rocket" } });
  check("A4 the schema REJECTS an unknown state, urgency or action type (never stores a reinterpretation)", !!invalid.validateSync()?.errors?.["safety.state"] && !!invalid2.validateSync()?.errors?.["safety.urgency"] && !!invalid3.validateSync()?.errors?.["safety.recommendedActionType"]);

  // ============================================================================================================ B. persisted + returned
  console.log("\n# B. new records keep the validated safety result");
  const sNormal = await mkSignal("medium", "Air conditioner noisy", "The air conditioner in the unit is noisy.");
  const rNormal = await run(sNormal, { urgency: "prompt", recommendedActionType: "inspection" });
  const dNormal = await Intelligence.findById(rNormal.record._id).lean();
  const vNormal = toIntelligenceView(rNormal.record);
  check("B1 NORMAL: stored on the record and returned by the view - state NORMAL, urgency and action type exactly as validated", rNormal.created === true && dNormal.safety?.state === "NORMAL" && dNormal.safety.urgency === "prompt" && dNormal.safety.recommendedActionType === "inspection" && JSON.stringify(vNormal.safety) === '{"state":"NORMAL","urgency":"prompt","recommendedActionType":"inspection"}');

  const sCrit = await mkSignal("critical", "Guest locked out of the apartment", "The guest is locked out of the apartment.");
  const rCrit = await run(sCrit, { urgency: "immediate", recommendedActionType: "guest_communication", recommendation: "Contact the guest and arrange access now." });
  const vCrit = toIntelligenceView(rCrit.record);
  check("B2 CRITICAL (recorded severity, no hazard): state CRITICAL, urgency immediate, the stated action type preserved exactly", vCrit.safety?.state === "CRITICAL" && vCrit.safety.urgency === "immediate" && vCrit.safety.recommendedActionType === "guest_communication");

  const sGas = await mkSignal("medium", "Strong smell of gas in the kitchen", "The guest reports a strong smell of gas in the kitchen.");
  const rGas = await run(sGas, { urgency: "immediate", recommendedActionType: "escalation", recommendation: "Evacuate the guest and escalate to the emergency services and the duty manager now." });
  const vGas = toIntelligenceView(rGas.record);
  check("B3 LIFE_SAFETY_HAZARD (found by the SERVER policy in the Signal, severity only 'medium'): state LIFE_SAFETY_HAZARD, urgency immediate, action type escalation - all preserved exactly", vGas.safety?.state === "LIFE_SAFETY_HAZARD" && vGas.safety.urgency === "immediate" && vGas.safety.recommendedActionType === "escalation");
  check("B4 IMMEDIATE urgency and ESCALATION are the policy's own values and are not renamed or mapped", URGENCY_LEVELS.includes(vGas.safety.urgency) && ACTION_TYPES.includes(vGas.safety.recommendedActionType));

  const sRef = await mkSignal("medium", "Guest refuses maintenance entry", "The guest refuses entry to the maintenance technician and asks for another time.");
  const refBad = await caught(() => run(sRef, { urgency: "prompt", recommendedActionType: "maintenance_dispatch", recommendation: "Record the refusal and offer another time slot." }));
  check("B5 ACCESS REFUSAL: a stated maintenance_dispatch is still REJECTED by the unchanged policy (502 SAFETY_POLICY_VIOLATION) and nothing is persisted", refBad?.statusCode === 502 && refBad.details?.code === "SAFETY_POLICY_VIOLATION" && (await Intelligence.countDocuments({ workspaceId: wsA._id, signalIds: sRef._id })) === 0);
  const rRef = await run(sRef, { urgency: "prompt", recommendedActionType: "guest_communication", recommendation: "Record the refusal and offer the guest another time slot." });
  const vRef = toIntelligenceView(rRef.record);
  check("B6 ACCESS REFUSAL accepted form: state NORMAL (a refusal alone is not a hazard), the stated action type preserved, no escalation invented", vRef.safety?.state === "NORMAL" && vRef.safety.recommendedActionType === "guest_communication" && vRef.safety.urgency === "prompt");

  const sBoth = await mkSignal("critical", "Gas smell, guest refuses entry", "A strong smell of gas in the apartment. The guest refuses entry to staff.");
  const bothBad = await caught(() => run(sBoth, { urgency: "immediate", recommendedActionType: "maintenance_dispatch", recommendation: "Evacuate the guest and escalate now." }));
  check("B7 ACCESS REFUSAL + HAZARD: dispatch is rejected (only escalation is permitted), nothing persisted", bothBad?.details?.code === "SAFETY_POLICY_VIOLATION" && (await Intelligence.countDocuments({ workspaceId: wsA._id, signalIds: sBoth._id })) === 0);
  const rBoth = await run(sBoth, { urgency: "immediate", recommendedActionType: "escalation", recommendation: "Evacuate the guest and escalate to the emergency services and the duty manager now." });
  const vBoth = toIntelligenceView(rBoth.record);
  check("B8 ...and the accepted result keeps the policy's outcome exactly: LIFE_SAFETY_HAZARD, immediate, escalation", vBoth.safety?.state === "LIFE_SAFETY_HAZARD" && vBoth.safety.urgency === "immediate" && vBoth.safety.recommendedActionType === "escalation");

  const sUnstated = await mkSignal("medium", "Lamp is dim", "A lamp is dim.");
  const rUnstated = await caught(() => runRaw(sUnstated, (good) => { const o = { ...good }; delete o.urgency; delete o.recommendedActionType; return o; }));
  check("B9 production-strict validation REQUIRES urgency and action type (an analysis that states neither is rejected, so a persisted record can never lack them)", rUnstated?.details?.code === "SAFETY_POLICY_VIOLATION" && (await Intelligence.countDocuments({ workspaceId: wsA._id, signalIds: sUnstated._id })) === 0);

  // ============================================================================================================ C. backwards compatibility
  console.log("\n# C. older records");
  const sOld = await mkSignal("critical", "Old critical signal", "Recorded before the safety field existed.");
  const old = await Intelligence.create({ workspaceId: wsA._id, signalIds: [sOld._id], generatedBy: "llm", provider: "p", model: "m", risk: { level: "critical" }, analysisVersion: "intelligence-v1", analysisLevel: "staff",
    analysis: { situation: "s", evidence: ["e"], impact: "i", recommendation: "Consider the documented guidance.", confidence: "medium" } });
  const oldPlain = await Intelligence.findById(old._id).lean();
  const vOld = toIntelligenceView(oldPlain);
  const dOld = toIntelligenceDetail(oldPlain);
  check("C1 an older record still loads and its public view has NO `safety` key (absent, not null, not an object)", vOld._id === String(old._id) && !("safety" in JSON.parse(JSON.stringify(vOld))) && vOld.analysis.recommendation.startsWith("Consider"));
  check("C2 absence is NEVER 'NORMAL': nothing is fabricated for a historical record (view, dashboard detail)", vOld.safety === undefined && dOld.safety === undefined && JSON.stringify(vOld).indexOf("NORMAL") < 0 && JSON.stringify(dOld).indexOf("NORMAL") < 0);
  check("C3 the frontend mapping turns the absence into null ('not recorded'), not into a state", mapSafety(vOld.safety) === null && mapSafety(undefined) === null && mapSafety(null) === null && mapSafety({}) === null && mapSafety({ state: "" }) === null && mapSafety("NORMAL") === null);
  check("C4 re-reading an already stored record keeps its safety result (the idempotent path returns the stored one with no new model call)", (await (async () => { const before = fake.calls; const again = await analyzeSignal(String(sGas._id), A, { authorizedLevel: "staff" }); return again.created === false && fake.calls === before && toIntelligenceView(again.record).safety?.state === "LIFE_SAFETY_HAZARD"; })()));

  // ============================================================================================================ D. spoofing / negatives
  console.log("\n# D. nothing but Node's validated result is stored");
  const sMisc = await mkSignal("low", "Lamp is dim again", "Another lamp is dim.");
  const rProse = await run(sMisc, { urgency: "prompt", recommendedActionType: "inspection", situation: "This is CRITICAL.", recommendation: "This is a critical life-safety emergency, escalate immediately to the emergency services." });
  const vProse = toIntelligenceView(rProse.record);
  check("D1 the model SAYS 'critical ... escalate immediately' in prose, but the validated state is NORMAL: the API reports NORMAL and the action type the model structurally stated - it never invents critical or escalation", vProse.safety?.state === "NORMAL" && vProse.safety.recommendedActionType === "inspection" && vProse.safety.urgency === "prompt");
  const sSpoof = await mkSignal("medium", "Strong smell of gas near the stove", "A strong smell of gas near the stove.");
  const spoofed = await caught(() => run(sSpoof, { urgency: "immediate", recommendedActionType: "escalation", safety: { state: "NORMAL", urgency: "routine", recommendedActionType: "other" }, safetyState: "NORMAL", recommendation: "Evacuate and escalate now." }));
  const spoofStored = await Intelligence.findOne({ workspaceId: wsA._id, signalIds: sSpoof._id }).lean();
  check("D2 a model-supplied `safety` / `safetyState` object cannot set the state: the response is rejected, or, if accepted, the stored state is Node's LIFE_SAFETY_HAZARD - never the supplied NORMAL", spoofed !== null ? !spoofStored : spoofStored?.safety?.state === "LIFE_SAFETY_HAZARD" && spoofStored.safety.urgency === "immediate", spoofed ? `rejected ${spoofed.details?.code || spoofed.statusCode}` : "accepted; Node's state stored");
  const sLow = await mkSignal("critical", "Another lockout", "Guest is locked out.");
  const low = await caught(() => run(sLow, { urgency: "routine", recommendedActionType: "guest_communication" }));
  check("D3 a model urgency BELOW the server minimum (routine on a critical Signal) is rejected by the unchanged policy and nothing is stored", low?.details?.code === "SAFETY_POLICY_VIOLATION" && (await Intelligence.countDocuments({ workspaceId: wsA._id, signalIds: sLow._id })) === 0);
  const sBogus = await mkSignal("medium", "Bogus enum signal", "Something is off.");
  const bogus = await caught(() => run(sBogus, { urgency: "right-now", recommendedActionType: "inspection" }));
  const bogus2 = await caught(() => run(sBogus, { urgency: "prompt", recommendedActionType: "launch_rocket" }));
  check("D4 an unknown urgency or action type from the model is rejected (502) - never stored and never reinterpreted", bogus?.statusCode === 502 && bogus2?.statusCode === 502 && (await Intelligence.countDocuments({ workspaceId: wsA._id, signalIds: sBogus._id })) === 0);
  const sUnk = await mkSignal("medium", "Unknown ref signal", "Something happened.");
  const unk = await caught(() => run(sUnk, (good) => ({ claims: [{ claimType: "FACT", text: "x", sourceRefs: [`current:signal:${"f".repeat(24)}`] }, good.claims[1]] })));
  check("D5 claim validation is unchanged: a fabricated reference is still rejected (CLAIM_UNKNOWN_REF)", unk?.details?.rule === "CLAIM_UNKNOWN_REF" || unk?.details?.code === "CLAIM_VALIDATION_FAILED");
  const corrupt = await Intelligence.collection.insertOne({ workspaceId: wsA._id, signalIds: [sNormal._id], generatedBy: "llm", analysisVersion: "x", safety: { state: "BOGUS", urgency: "now", recommendedActionType: "launch_rocket" }, createdAt: new Date(), updatedAt: new Date() });
  const corruptPlain = await Intelligence.findById(corrupt.insertedId).lean();
  const odd = await Intelligence.collection.insertOne({ workspaceId: wsA._id, signalIds: [sNormal._id], generatedBy: "llm", analysisVersion: "x", safety: { state: "CRITICAL", urgency: "now", recommendedActionType: "launch_rocket" }, createdAt: new Date(), updatedAt: new Date() });
  const oddPlain = await Intelligence.findById(odd.insertedId).lean();
  check("D6 an unknown stored state (corrupt or future value) is OMITTED by the read mapper, whole; an unknown urgency or action type under a known state is omitted field-by-field - never reinterpreted", toIntelligenceView(corruptPlain).safety === undefined && toSafetyView(oddPlain.safety).state === "CRITICAL" && toSafetyView(oddPlain.safety).urgency === undefined && toSafetyView(oddPlain.safety).recommendedActionType === undefined);

  // ============================================================================================================ E. HTTP
  console.log("\n# E. HTTP: views, analyze response, dashboard, tenant isolation");
  const PORT = 5084; const BASE = `http://localhost:${PORT}/api`;
  httpChild = spawn(process.execPath, [path.join(BACKEND, "server.js")], { env: { ...process.env, PORT: String(PORT), LLM_PROVIDER: "test-python", AI_SERVICE_URL: "http://localhost:5083", KNOWLEDGE_DEV_AUTHORIZED_LEVEL: "restricted" }, stdio: "ignore" });
  for (let i = 0; i < 100; i += 1) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 200)); }
  const call = async (method, url, who, body) => { const r = await fetch(`${BASE}${url}`, { method, headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...who.headers }, body: body !== undefined ? JSON.stringify(body) : undefined }); let json = null; try { json = await r.json(); } catch { /* none */ } return { status: r.status, json, data: json?.data }; };
  const operatorA = await createActor({ role: "operator", workspaceId: wsA._id, label: "p43b1-op" });
  const adminB = await createActor({ role: "admin", workspaceId: wsB._id, label: "p43b1-adminb" });

  const g = await call("GET", `/intelligence/${rGas.record._id}?workspaceId=${A}`, operatorA);
  check("E1 GET /intelligence/:id returns the safety result for a workspace member", g.status === 200 && JSON.stringify(g.data.safety) === JSON.stringify(vGas.safety));
  const gold = await call("GET", `/intelligence/${old._id}?workspaceId=${A}`, operatorA);
  check("E2 GET of the OLDER record is 200 with no `safety` key", gold.status === 200 && !("safety" in gold.data));
  const list = await call("GET", `/intelligence?workspaceId=${A}&limit=50`, operatorA);
  check("E3 the list endpoint carries it per item (and the corrupt/odd records are shown with the unknown values omitted)", list.status === 200 && list.json.data.some((i) => i._id === String(rGas.record._id) && i.safety?.state === "LIFE_SAFETY_HAZARD") && list.json.data.every((i) => !i.safety || SAFETY_STATES.includes(i.safety.state)));
  const sHttp = await mkSignal("medium", "Smoke from the toaster", "There is smoke coming from the toaster.");
  fake.build = (good) => ({ ...good, urgency: "immediate", recommendedActionType: "escalation", recommendation: "Evacuate the guest and escalate to the emergency services now." });
  const posted = await call("POST", `/intelligence/analyze/${sHttp._id}?workspaceId=${A}`, operatorA, { workspaceId: A, safety: { state: "NORMAL", urgency: "routine", recommendedActionType: "other" }, urgency: "routine", safetyState: "NORMAL" });
  fake.build = null;
  check("E4 POST /intelligence/analyze/:signalId returns the safety result, and a CLIENT-supplied `safety` / `urgency` / `safetyState` in the request body changes nothing (state is Node's LIFE_SAFETY_HAZARD)", posted.status === 201 && posted.data?.safety?.state === "LIFE_SAFETY_HAZARD" && posted.data.safety.urgency === "immediate" && posted.data.safety.recommendedActionType === "escalation", `${posted.status}`);
  const stored = await Intelligence.findById(posted.data?._id).lean();
  check("E5 ...and the stored record carries the same server-derived result", stored?.safety?.state === "LIFE_SAFETY_HAZARD" && stored.safety.urgency === "immediate");
  const dash = await call("GET", `/dashboard/signals/${sGas._id}?workspaceId=${A}`, operatorA);
  check("E6 the dashboard detail returns the safety result for the analysed Signal", dash.status === 200 && dash.data?.intelligence?.safety?.state === "LIFE_SAFETY_HAZARD" && dash.data.intelligence.safety.recommendedActionType === "escalation");
  const dashOld = await call("GET", `/dashboard/signals/${sOld._id}?workspaceId=${A}`, operatorA);
  check("E7 the dashboard detail of the OLDER record has no `safety` key", dashOld.status === 200 && dashOld.data.intelligence && !("safety" in dashOld.data.intelligence));
  const dashList = await call("GET", `/dashboard/signals?workspaceId=${A}&limit=50`, operatorA);
  check("E8 the dashboard LIST summary is unchanged (it carries no safety field)", dashList.status === 200 && dashList.json.data.every((r) => !r.intelligence || !("safety" in r.intelligence)));

  console.log("\n# E (tenant isolation)");
  const xi = await call("GET", `/intelligence/${rGas.record._id}?workspaceId=${B}`, adminB);
  const xi2 = await call("GET", `/intelligence/${rGas.record._id}?workspaceId=${A}`, adminB);
  const xd = await call("GET", `/dashboard/signals/${sGas._id}?workspaceId=${B}`, adminB);
  const xd2 = await call("GET", `/dashboard/signals/${sGas._id}?workspaceId=${A}`, adminB);
  const xl = await call("GET", `/intelligence?workspaceId=${B}&limit=50`, adminB);
  const leaked = [xi, xi2, xd, xd2].map((r) => JSON.stringify(r.json || {})).join("");
  check("E9 another workspace's admin cannot read the record or its safety result: naming their own workspace -> 404, naming ours -> refused, same for the dashboard", xi.status === 404 && [403, 404].includes(xi2.status) && xd.status === 404 && [403, 404].includes(xd2.status) && !/LIFE_SAFETY_HAZARD|escalation/.test(leaked), `${xi.status}/${xi2.status}/${xd.status}/${xd2.status}`);
  check("E10 their own Intelligence list contains none of our records or safety results", xl.status === 200 && xl.json.data.length === 0);
  const xa = await call("POST", `/intelligence/analyze/${sGas._id}?workspaceId=${B}`, adminB, { workspaceId: B });
  check("E11 they cannot analyze our Signal either (404 before any model call)", xa.status === 404);
  const patchTry = await call("PATCH", `/intelligence/${rGas.record._id}?workspaceId=${A}`, operatorA, { safety: { state: "NORMAL" } });
  const postTry = await call("POST", `/intelligence?workspaceId=${A}`, operatorA, { workspaceId: A, safety: { state: "NORMAL" } });
  const after = await Intelligence.findById(rGas.record._id).lean();
  check("E12 there is no HTTP route that creates or patches Intelligence: a forged `safety` cannot be written (404/405) and the record is unchanged", [404, 405].includes(patchTry.status) && [404, 405].includes(postTry.status) && after.safety.state === "LIFE_SAFETY_HAZARD");

  // ============================================================================================================ F. unchanged architecture
  console.log("\n# F. nothing else changed");
  const rows = await AnalysisAdmission.find({ workspaceId: wsA._id }).lean();
  const accGas = rows.find((r) => String(r.intelligenceId) === String(rGas.record._id));
  const accBoth = rows.find((r) => String(r.intelligenceId) === String(rBoth.record._id));
  const accNormal = rows.find((r) => String(r.intelligenceId) === String(rNormal.record._id));
  check("F1 the AnalysisAdmission audit row is still valid and agrees with what was stored: safetyState equals the stored state, the rule codes are recorded there", accGas?.outcome === "accepted" && accGas.safetyState === "LIFE_SAFETY_HAZARD" && accGas.safetyRules.includes("LIFE_SAFETY_HAZARD") && accNormal.safetyState === "NORMAL" && accBoth.safetyRules.includes("ACCESS_REFUSED") && accBoth.safetyRules.includes("SEVERITY_CRITICAL") && accBoth.safetyState === rBoth.record.safety.state);
  check("F2 (safety/context hardening: the rule codes are now ALSO carried, deliberately, as the closed list `safety.rules` so the Action stage and the page can honour the existing ACCESS_REFUSED restriction) the audit field name `safetyRules` still never appears in any API payload, and the only rule codes in a payload are inside `safety.rules`, from the three-code closed list", ![g, list, posted, dash].some((r) => /safetyRules/.test(JSON.stringify(r.json))) && [g, list, posted, dash].every((r) => { const s = JSON.stringify(r.json).replace(/"rules":\[[^\]]*\]/g, ""); return !/ACCESS_REFUSED|SEVERITY_CRITICAL|LIFE_SAFETY_HAZARD"?,?"rules/.test(s); }) && (g.data?.safety?.rules ?? []).every((c) => ["SEVERITY_CRITICAL", "LIFE_SAFETY_HAZARD", "ACCESS_REFUSED"].includes(c)));
  check("F3 the CONFIDENCE CEILING is unchanged: the model said 'high', no knowledge grounded it, so the stored (and returned) value is the ceiling, equal to the audit row", rNormal.record.analysis.confidence === "medium" && accNormal.modelConfidence === "high" && accNormal.confidenceCeiling === "medium" && accNormal.finalConfidence === "medium" && g.data.analysis.confidence === "medium");
  const VIEW_KEYS = ["_id", "workspaceId", "signalIds", "propertyId", "conversationId", "generatedBy", "analysisVersion", "analysisLevel", "knowledgeVisibility", "analysis", "safety", "knowledgeProvenance", "evidenceRefs", "contradictions", "signal", "context", "intelligence", "risk", "decision", "action", "outcome", "createdAt", "updatedAt"];
  check("F4 PROVENANCE is unchanged: no knowledge was retrieved so none is attached (absent, as before), and the only key this phase added to the public view is `safety`", g.data.knowledgeProvenance === undefined && Object.keys(g.data).every((k) => VIEW_KEYS.includes(k)) && !Object.keys(g.data).some((k) => /prompt|raw|provider|model|admission|claims/i.test(k)), Object.keys(g.data).join(","));
  const payloads = JSON.stringify([g.json, posted.json, dash.json, list.json]);
  const leakMatch = payloads.match(/AIza|sk-[A-Za-z0-9]{20}|bearer|authorization|mongodb(\+srv)?:\/\/|"(?:prompt|rawResponse|rawOutput|provider|model|guestId|stayId|claims|sourceRefs|admission|safetyRules)"\s*:/i);
  if (leakMatch) console.error("   F5 matched:", JSON.stringify(leakMatch[0]), JSON.stringify(payloads.slice(Math.max(0, leakMatch.index - 60), leakMatch.index + 60)));
  check("F5 no secret, prompt, raw model output, provider/model name, guest or stay id in any payload", !/AIza|sk-[A-Za-z0-9]{20}|bearer|authorization|mongodb(\+srv)?:\/\/|"(?:prompt|rawResponse|rawOutput|provider|model|guestId|stayId|claims|sourceRefs|admission|safetyRules)"\s*:/i.test(payloads));
  const { createHash } = crypto;
  const protectedFiles = ["backend/src/services/ai/safetyPolicy.js", "backend/src/services/ai/claimValidator.js", "backend/src/services/ai/evidenceEnvelope.js", "backend/src/services/ai/confidencePolicy.js", "backend/src/services/ai/proseConsistency.js", "backend/src/services/ai/outputGuard.js"];
  const snapFile = process.env.P43B1_SNAPSHOT;
  if (snapFile && fs.existsSync(snapFile)) {
    const snap = JSON.parse(read(snapFile));
    check("F6 safetyPolicy.js, claimValidator.js, evidenceEnvelope.js, confidencePolicy.js, proseConsistency.js and outputGuard.js are byte-identical to their state before this phase", protectedFiles.every((f) => snap[f] && snap[f] === createHash("sha256").update(fs.readFileSync(path.join(REPO, f))).digest("hex")), "hash snapshot");
  } else console.log("INFO  F6 skipped: set P43B1_SNAPSHOT to a {file: sha256} JSON taken before the phase");
  // ---- G: the real frontend mapping modules (loaded through Vite SSR exactly as the app loads them) carry the result, unchanged, and Phase 43A still applies
  console.log("\n# G. the frontend mapping layer");
  const FRONTEND = path.join(REPO, "frontend");
  const { createServer } = await import(pathToFileURL(path.join(FRONTEND, "node_modules", "vite", "dist", "node", "index.js")).href);
  const vite = await createServer({ root: FRONTEND, configFile: path.join(FRONTEND, "vite.config.js"), server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom", logLevel: "silent", optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const { mapIntelligenceAnalysis } = await vite.ssrLoadModule("/src/features/intelligence/intelligenceMapping.js");
    const { mapDashboardDetail } = await vite.ssrLoadModule("/src/features/dashboard/dashboardMapping.js");
    const apiView = JSON.parse(JSON.stringify(g.data));
    const page = mapIntelligenceAnalysis(apiView);
    check("G1 the Intelligence-page mapping carries the server's safety result unchanged (state, urgency, action type)", JSON.stringify(page.safety) === JSON.stringify({ state: "LIFE_SAFETY_HAZARD", urgency: "immediate", recommendedActionType: "escalation", rules: ["LIFE_SAFETY_HAZARD"] }));
    const dashMapped = mapDashboardDetail({ signal: { id: "s", title: "t", type: "maintenance", severity: "medium", status: "new", source: "staff", occurredAt: "2026-10-05T09:00:00Z" }, observed: {}, intelligence: JSON.parse(JSON.stringify(dash.data.intelligence)) });
    check("G2 the dashboard-detail mapping carries it unchanged too", JSON.stringify(dashMapped.analysis.safety) === JSON.stringify({ state: "LIFE_SAFETY_HAZARD", urgency: "immediate", recommendedActionType: "escalation", rules: ["LIFE_SAFETY_HAZARD"] }));
    const pageOld = mapIntelligenceAnalysis(JSON.parse(JSON.stringify(gold.data)));
    const dashOldMapped = mapDashboardDetail({ signal: { id: "s", title: "t", type: "maintenance", severity: "critical", status: "new", source: "staff", occurredAt: "2026-10-05T09:00:00Z" }, observed: {}, intelligence: JSON.parse(JSON.stringify(dashOld.data.intelligence)) });
    check("G3 an older record maps to safety === null ('not recorded'): never a state, never 'NORMAL'", pageOld.safety === null && dashOldMapped.analysis.safety === null);
    const odd = mapIntelligenceAnalysis({ ...apiView, safety: { state: "SOMETHING_NEW", urgency: "someday" } });
    check("G4 a value the UI does not know is carried as the server sent it (not reinterpreted, not defaulted): the later UI phase must show an unknown state as unknown", odd.safety.state === "SOMETHING_NEW" && odd.safety.urgency === "someday" && odd.safety.recommendedActionType === null);
    const withRefs = mapIntelligenceAnalysis({ ...apiView, analysis: { ...apiView.analysis, recommendation: `Escalate now (current:stay:${"a".repeat(24)}, knowledge:${"b".repeat(24)}).` } });
    check("G5 PHASE 43A still applies on the same object: the evidence references are removed from the prose while the safety result is untouched", !/current:|knowledge:|[0-9a-f]{24}/.test(withRefs.recommendation) && withRefs.safety.state === "LIFE_SAFETY_HAZARD");
  } finally { await vite.close(); }

  const writer = read(path.join(BACKEND, "src", "services", "intelligenceAnalysisService.js"));
  check("F7 the ONLY writer of `safety` is the V1 analysis path after validation: it is built from the admission's policy state and the two fields that passed the policy, and no model-supplied `safety` is read anywhere", /safety: \{ state: analysis\.admission\.safetyState, urgency: analysis\.urgency, recommendedActionType: analysis\.recommendedActionType, rules: analysis\.admission\.safetyRules \}/.test(writer) && !/analysis\.safety\b|raw\.safety\b/.test(writer + read(path.join(BACKEND, "src", "services", "ai", "analysisSchema.js"))));
  const feSrc = (dir) => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile() && /\.(jsx?)$/.test(d.name)).map((d) => path.join(d.parentPath ?? d.path, d.name));
  // Phase 43B.2 renders the carried value, so the state name now legitimately appears in ONE presentation module. The MAPPING module stays logic-free
  // (it only passes strings through), and the state name may appear in no other frontend file.
  check("F8 the mapping module has NO safety logic (no state comparison, no keyword test - it only passes strings through), and the only frontend file naming a state is the structured presentation module (Phase 43B.2)", !/\b(?:NORMAL|CRITICAL|LIFE_SAFETY_HAZARD|immediate|escalation)\b/.test(read(path.join(REPO, "frontend", "src", "features", "intelligence", "safetyMapping.js")).replace(/\/\*[\s\S]*?\*\//g, "")) && feSrc(path.join(REPO, "frontend", "src")).filter((f) => /LIFE_SAFETY_HAZARD/.test(read(f).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""))).every((f) => path.basename(f) === "safetyPresentation.js"));
} finally {
  if (httpChild) httpChild.kill();
  await new Promise((r) => stub.close(r));
  try { if (mongoose.connection.db.databaseName === DB_NAME) await mongoose.connection.dropDatabase(); } catch { /* best effort */ }
  await mongoose.disconnect();
}
console.log(`\nPhase 43B.1 safety metadata validation: ${passed} passed, ${failed} failed (isolated database ${DB_NAME} dropped)`);
process.exit(failed === 0 ? 0 : 1);
