/**
 * Learning L1 - case-based operational Learning FOUNDATION. ISOLATED: a throwaway database on the local loopback MongoDB (dropped at the end); no server, no AI service, no model.
 * Every workflow is built with the application's OWN services (stored analysis -> Decision -> Action -> Outcome recorded by a person), never by writing derived data.
 *
 *   A  pure: the normalizer, deterministic similarity, the observation builder and its closed shape
 *   B  the 12 required scenarios (positive / negative / conflicting / irrelevant / insufficient / safety / self-exclusion / cross-workspace / tenant-safe derivation /
 *      incomplete workflows / server-owned statistics / Learning stays OFF)
 *   C  the model-facing material carries no person, tenant, record, text or time
 *   D  static: L1 is shadow-only (nothing in the production path imports it), no frontend, no new setting, no write
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(here, "..");
const REPO = path.join(BACKEND, "..");
const read = (p) => fs.readFileSync(p, "utf8");
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, "");
let passed = 0; let failed = 0;
const check = (name, ok, detail = "") => { if (ok) { passed += 1; console.log(`PASS  ${name}${detail ? ` - ${detail}` : ""}`); } else { failed += 1; console.error(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`); } };

{ const __u = dotenv.parse(process.getBuiltinModule("node:fs").readFileSync(new URL("../.env", import.meta.url))).MONGODB_URI ?? ""; if (/^mongodb:\/\/(?:[^@/]*@)?(localhost|127\.0\.0\.1)/i.test(__u)) process.env.MONGODB_URI ??= __u; }
const baseUri = process.env.MONGODB_URI;
const DB_NAME = `koi_l1_${Date.now()}`;
if (!baseUri || /^mongodb\+srv:|@/.test(baseUri) || !/^mongodb:\/\/(localhost|127\.0\.0\.1)/.test(baseUri)) { console.error("refusing: the configured MongoDB is not a plain loopback instance"); process.exit(2); }
process.env.MONGODB_URI = baseUri.replace(/(mongodb:\/\/[^/]+\/)([^?]*)/, `$1${DB_NAME}`);
delete process.env.KOI_LEARNING_CONTEXT_ENABLED;

const mongoose = (await import("mongoose")).default;
const { connectDatabase } = await import("../src/config/database.js");
const M = await import("../src/models/index.js");
const { createAnalysisIntelligence } = await import("../src/services/intelligenceService.js");
const { proposeDecision, approveDecision, rejectDecision } = await import("../src/services/decisionService.js");
const { proposeAction, approveAction } = await import("../src/services/actionService.js");
const { recordOutcome } = await import("../src/services/outcomeService.js");
const { deriveSafetyPolicy } = await import("../src/services/ai/safetyPolicy.js");
const { validateAndVerifyAnalysis } = await import("../src/services/intelligenceAnalysisService.js");
const { APPROVED_MODEL, APPROVED_PROVIDER } = await import("../src/config/providerPolicy.js");
const { getLearningContextEnabled } = await import("../src/config/runtimeConfig.js");
const { buildLearningContext } = await import("../src/services/learningContextService.js");
const CC = await import("../src/services/learning/completedCase.js");
const { loadCompletedCases, buildCurrentCaseProfile } = await import("../src/services/learning/completedCaseService.js");
const SIM = await import("../src/services/learning/caseSimilarity.js");
const F = await import("../src/services/learning/caseFacets.js");
// L1.3: facets come from the Signal's persisted, server-derived `issue`. These seeds insert Signals directly (not through the service), so they derive the issue exactly as signalService.createSignal does.
const { extractStructuredIssue } = await import("../src/services/structuredIssue.js");
const OBS = await import("../src/services/learning/caseLearningObservation.js");
const { deriveShadowLearningObservation } = await import("../src/services/learning/caseLearningShadow.js");
await connectDatabase();
if (mongoose.connection.db.databaseName !== DB_NAME) { console.error("refusing: not connected to the isolated database"); process.exit(2); }

const oid = () => new mongoose.Types.ObjectId();
const actor = oid(); const reviewer = oid();
const opts = (who) => ({ authorizedLevel: "staff", actorUserId: who });
let counter = 0;

/** A new workspace with one property, a studio and an apartment unit, and a guest with recognisable PII. */
async function newWorkspace(label) {
  counter += 1;
  const ws = await M.Workspace.create({ name: `L1 ${label}`, slug: `l1-${label.toLowerCase()}-${counter}-${Date.now()}`, status: "active" });
  const prop = await M.Property.create({ workspaceId: ws._id, name: `L1 ${label} Residence`, code: `L1${counter}`, timezone: "UTC" });
  const units = { apartment: await M.Unit.create({ propertyId: prop._id, unitNumber: "A-1", type: "apartment", status: "occupied" }), studio: await M.Unit.create({ propertyId: prop._id, unitNumber: "S-1", type: "studio", status: "occupied" }) };
  const guest = await M.Guest.create({ workspaceId: ws._id, firstName: "Zephyrine", lastName: "Quillfeather", email: `zq.${counter}@pii-l1.invalid`, phone: "+91 555 0100" });
  return { ws, wsId: String(ws._id), prop, units, guest };
}

const TITLES = {
  ac: "the AC is not cooling", water: "the toilet is leaking and water is on the floor", key: "the key card is not opening the door",
  gas: "the guest reports a strong gas smell in the kitchen", smoke: "the guest reports smoke coming from the bathroom vent", co: "the carbon monoxide alarm is sounding",
  acRefused: "the AC is not cooling but the guest refuses entry to staff",
};
/**
 * Seeds ONE workflow through the real services, up to `stage`. stage: signal | intelligence | decision_proposed | decision_approved | decision_rejected | action_proposed | action_approved | outcome.
 * Returns the ids. `recommended` is the action type the stored analysis recommends (the Action follows it unless the safety state constrains it).
 */
async function seed(w, { topic = "ac", type = "maintenance", severity = "medium", unit = "apartment", outcome = "success", stage = "outcome", recommended = "maintenance_dispatch", noSafety = false, text } = {}) {
  counter += 1;
  const title = `Room ${100 + counter}: ${text ?? TITLES[topic]}.`;
  const sig = await M.Signal.create({ workspaceId: w.ws._id, propertyId: w.prop._id, unitId: w.units[unit]._id, guestId: w.guest._id, type, source: "staff", severity, status: "new", title, description: `${title} Guest Zephyrine Quillfeather (+91 555 0100) asked for a call back.`, issue: extractStructuredIssue({ title, description: `${title} Guest Zephyrine Quillfeather (+91 555 0100) asked for a call back.`, severity }) });
  const out = { signalId: String(sig._id), title };
  if (stage === "signal") return out;
  const policy = deriveSafetyPolicy({ signal: { title: sig.title, description: sig.description, severity: sig.severity } });
  const rec = policy.state === "LIFE_SAFETY_HAZARD" ? "escalation" : recommended;
  const intel = (await createAnalysisIntelligence({ workspaceId: w.ws._id, signal: { id: sig._id, title: sig.title, type: sig.type, severity: sig.severity }, propertyId: w.prop._id, level: "staff", analysis: { situation: "Synthetic situation.", evidence: ["Synthetic evidence."], impact: "Synthetic impact.", recommendation: "A person could consider a synthetic step.", confidence: "medium" }, provider: "test", model: "deterministic-stub", knowledgeProvenance: [], ...(noSafety ? {} : { safety: { state: policy.state, urgency: policy.state === "NORMAL" ? "prompt" : "immediate", recommendedActionType: rec } }) })).record;
  out.intelligenceId = String(intel._id);
  if (stage === "intelligence") return out;
  const dec = (await proposeDecision(out.intelligenceId, w.wsId, {}, opts(actor))).record; out.decisionId = String(dec._id);
  if (stage === "decision_proposed") return out;
  if (stage === "decision_rejected") { await rejectDecision(out.decisionId, w.wsId, { note: "Not needed.", alternative: "Handled differently." }, opts(reviewer)); return out; }
  await approveDecision(out.decisionId, w.wsId, {}, opts(reviewer));
  if (stage === "decision_approved") return out;
  const act = (await proposeAction(out.decisionId, w.wsId, {}, opts(actor))).record; out.actionId = String(act._id); out.actionType = act.actionType;
  if (stage === "action_proposed") return out;
  await approveAction(out.actionId, w.wsId, { note: "Approved." }, opts(reviewer));
  if (stage === "action_approved") return out;
  const o = await recordOutcome(out.actionId, w.wsId, { status: outcome, result: { summary: `Synthetic ${outcome} outcome. Contact zq@pii-l1.invalid for details.` } }, { actorUserId: actor, authorizedLevel: "staff" });
  out.outcomeId = String(o._id); return out;
}
const many = async (w, n, o) => { const r = []; for (let i = 0; i < n; i += 1) r.push(await seed(w, o)); return r; };
const outcomes = async (w, spec, base = {}) => { for (const [status, n] of Object.entries(spec)) await many(w, n, { ...base, outcome: status }); };
const shadow = (w, signalId) => deriveShadowLearningObservation({ workspaceId: w.wsId, signalId });
const counts = async () => Object.fromEntries(await Promise.all(Object.values(M).filter((m) => m?.collection).map(async (m) => [m.collection.collectionName, await m.collection.countDocuments({})])));

try {
  // ======================================================================================================== A. PURE
  console.log("\n# A. pure units");
  // L1.2: a profile now carries the structured facets (default: an AC that is not cooling); the v1 gates on topics / type were superseded by the v2 facet gates (caseSimilarity.js)
  const profile = (topics, over = {}) => ({ issue: { topics, signalType: "maintenance", severity: "medium", equipment: "air_conditioner", problem: "temperature_fault", condition: "not_cooling", ...(over.issue ?? {}) }, conditions: { unitType: "apartment", accessRefused: false, ...(over.conditions ?? {}) }, safety: { state: "NORMAL", rules: [], ...(over.safety ?? {}) } });
  const fakeCase = (topics, { status = "success", actionType = "inspection", over = {}, key = "k" } = {}) => ({ facts: { ...profile(topics, over), action: { actionType }, outcome: { status, effectiveness: CC.EFFECTIVENESS[status] } }, internal: { caseKey: key, signalId: `s-${key}`, recordedAtMs: 1 } });
  const cur = profile(["climate"]);
  check("A1 gates (v2): a different safety state, a different rule set, a different equipment, a different problem family and an UNKNOWN equipment are each EXCLUDED with their own fixed reason (topics no longer gate)",
    SIM.compareCases(cur, fakeCase(["climate"], { over: { safety: { state: "LIFE_SAFETY_HAZARD", rules: ["LIFE_SAFETY_HAZARD"] } } })).excludedBy === "SAFETY_STATE_MISMATCH" &&
    SIM.compareCases(cur, fakeCase(["climate"], { over: { safety: { state: "NORMAL", rules: ["ACCESS_REFUSED"] } } })).excludedBy === "SAFETY_RULES_MISMATCH" &&
    SIM.compareCases(cur, fakeCase(["climate"], { over: { issue: { equipment: "refrigerator" } } })).excludedBy === "EQUIPMENT_MISMATCH" && SIM.compareCases(cur, fakeCase(["climate"], { over: { issue: { problem: "unusual_noise", condition: "NOT_APPLICABLE" } } })).excludedBy === "PROBLEM_MISMATCH" &&
    SIM.compareCases(cur, fakeCase(["climate"], { over: { issue: { equipment: "UNKNOWN" } } })).excludedBy === "EQUIPMENT_UNKNOWN");
  check("A2 relevance tiers (v2): equal facets with an equal known condition = HIGH; an unknown condition = MEDIUM; two different known conditions = LOW, which is never selected as evidence (only counted as a weak match)",
    SIM.compareCases(cur, fakeCase(["climate"])).relevance === "HIGH" && SIM.compareCases(cur, fakeCase(["climate"], { over: { issue: { condition: "UNKNOWN" } } })).relevance === "MEDIUM" && SIM.compareCases(cur, fakeCase(["climate"], { over: { issue: { condition: "not_heating" } } })).relevance === "LOW" &&
    SIM.selectSimilarCases(cur, [fakeCase(["climate"], { over: { issue: { condition: "not_heating" } } })]).selected.length === 0 && SIM.selectSimilarCases(cur, [fakeCase(["climate"], { over: { issue: { condition: "not_heating" } } })]).weakMatchCount === 1);
  const pool = [fakeCase(["climate"], { key: "b" }), fakeCase(["climate"], { key: "a" }), fakeCase(["climate"], { key: "c", over: { issue: { signalType: "complaint" } } })];
  const s1 = SIM.selectSimilarCases(cur, pool); const s2 = SIM.selectSimilarCases(cur, [...pool].reverse());
  check("A3 deterministic: the same cases always give the same selection in the same order, whatever order they arrive in (score, then recorded order, then opaque key)", JSON.stringify(s1.selected.map((s) => s.case.internal.caseKey)) === JSON.stringify(s2.selected.map((s) => s.case.internal.caseKey)) && s1.selected[0].case.internal.caseKey === "a");
  const sel = (statuses, actionTypes = []) => ({ selected: statuses.map((st, i) => ({ case: fakeCase(["climate"], { status: st, actionType: actionTypes[i] ?? "inspection", key: `x${i}` }), relevance: "HIGH" })), weakMatchCount: 0 });
  const obs = (statuses, safety = "NORMAL", types) => OBS.buildLearningObservation(sel(statuses, types), { safetyCondition: safety });
  const strongPos = obs(["success", "success", "success", "success", "partial"]);
  check("A4 positive pattern: 4 success + 1 partial -> sufficient, POSITIVE, consistency HIGH, dominant action 'inspection', rate 0.8; the observation is shape-checked and deep-frozen", strongPos.sufficientEvidence && strongPos.pattern === "POSITIVE" && strongPos.outcomeConsistency === "HIGH" && strongPos.dominantOutcome === "success" && strongPos.dominantActionType === "inspection" && strongPos.successRate === 0.8 && Object.isFrozen(strongPos) && Object.isFrozen(strongPos.outcomeDistribution) && strongPos.mode === "SHADOW" && strongPos.advisoryOnly === true);
  const mixed = obs(["success", "success", "failed", "failed", "partial"]);
  check("A5 conflicting history: a tie between success and failed is MIXED with LOW consistency and NO dominant outcome (uncertainty, not a strong pattern)", mixed.sufficientEvidence && mixed.pattern === "MIXED" && mixed.outcomeConsistency === "LOW" && mixed.dominantOutcome === null);
  check("A6 negative pattern: 4 failed + 1 success -> NEGATIVE with HIGH consistency", obs(["failed", "failed", "failed", "failed", "success"]).pattern === "NEGATIVE");
  const few = obs(["success", "success"]);
  check("A7 insufficient: fewer than 3 similar cases -> sufficientEvidence false, reason TOO_FEW_CASES, pattern INSUFFICIENT_EVIDENCE, no dominant outcome or action", !few.sufficientEvidence && few.insufficientReason === "TOO_FEW_CASES" && few.pattern === "INSUFFICIENT_EVIDENCE" && few.dominantOutcome === null && few.dominantActionType === null && few.outcomeConsistency === "NONE");
  const blockedOnly = obs(["blocked", "blocked", "unknown", "success"]);
  check("A8 blocked / unknown outcomes say nothing about whether an approach works: 4 similar cases with only 1 determined outcome is insufficient (TOO_FEW_DETERMINED_OUTCOMES)", !blockedOnly.sufficientEvidence && blockedOnly.insufficientReason === "TOO_FEW_DETERMINED_OUTCOMES" && blockedOnly.outcomeDistribution.blocked === 2 && blockedOnly.successRate === 1);
  const hazard = obs(["success", "success", "success", "success", "success"], "LIFE_SAFETY_HAZARD");
  check("A9 a safety condition is never informed by Learning: even five successful, relevant hazard cases give sufficientEvidence false (SAFETY_CONDITION), no dominant action and INSUFFICIENT_EVIDENCE", !hazard.sufficientEvidence && hazard.insufficientReason === "SAFETY_CONDITION" && hazard.dominantActionType === null && hazard.pattern === "INSUFFICIENT_EVIDENCE" && hazard.similarCaseCount === 5 && obs(["success"], "CRITICAL").insufficientReason === "SAFETY_CONDITION" && obs(["success"], "nonsense").safetyCondition === "CRITICAL");
  check("A10 a split between actions gives no dominant action type (a plurality below 60% is not a pattern)", obs(["success", "success", "success", "success", "success"], "NORMAL", ["inspection", "inspection", "maintenance_dispatch", "maintenance_dispatch", "guest_communication"]).dominantActionType === null);
  const shapeFails = (mutate) => { const o = JSON.parse(JSON.stringify(strongPos)); mutate(o); const orig = console.error; console.error = () => {}; try { return import("../src/services/learningContextContract.js").then(({ assertShape }) => { try { assertShape(o, OBS.OBSERVATION_SHAPE, "o"); return false; } catch { return true; } }); } finally { console.error = orig; } };
  check("A11 the closed shape refuses a free-text field, an id, a timestamp, a wrong enum and a statistic outside the schema",
    (await shapeFails((o) => { o.note = "9 of 10 similar cases succeeded"; })) && (await shapeFails((o) => { o.workspaceId = "64b0000000000000000000a1"; })) && (await shapeFails((o) => { o.generatedAt = "2026-10-11T10:00:00Z"; })) &&
    (await shapeFails((o) => { o.pattern = "GUARANTEED"; })) && (await shapeFails((o) => { o.actionPatterns[0].caseId = "64b0000000000000000000a1"; })) && (await shapeFails((o) => { o.mode = "ACTIVE"; })) && (await shapeFails((o) => { o.advisoryOnly = false; })));

  // ======================================================================================================== B. SCENARIOS
  console.log("\n# B. the required scenarios (real workflows built through the application's services)");
  // 1. positive
  const w1 = await newWorkspace("pos");
  await outcomes(w1, { success: 4, partial: 1 }, { topic: "ac", recommended: "inspection" });
  const cur1 = await seed(w1, { topic: "ac", stage: "signal" });
  const r1 = await shadow(w1, cur1.signalId);
  check("B1 POSITIVE: a current AC report matches 5 earlier completed AC cases; 4 success + 1 partial -> sufficient, POSITIVE, HIGH consistency, HIGH relevance, dominant action 'inspection'", r1.observation.sufficientEvidence && r1.observation.similarCaseCount === 5 && r1.observation.pattern === "POSITIVE" && r1.observation.outcomeConsistency === "HIGH" && r1.observation.relevance === "HIGH" && r1.observation.dominantActionType === "inspection" && r1.observation.outcomeDistribution.success === 4 && r1.observation.outcomeDistribution.partial === 1, JSON.stringify({ n: r1.observation.similarCaseCount, p: r1.observation.pattern }));
  // 2. negative
  const w2 = await newWorkspace("neg");
  await outcomes(w2, { failed: 4, success: 1 }, { topic: "ac", recommended: "maintenance_dispatch" });
  const r2 = await shadow(w2, (await seed(w2, { topic: "ac", stage: "signal" })).signalId);
  check("B2 NEGATIVE: repeated failed outcomes of the same approach are reported as NEGATIVE (HIGH consistency, dominant outcome failed, dominant action 'maintenance_dispatch') - the facts, not an instruction", r2.observation.pattern === "NEGATIVE" && r2.observation.dominantOutcome === "failed" && r2.observation.outcomeConsistency === "HIGH" && r2.observation.dominantActionType === "maintenance_dispatch" && r2.observation.outcomeDistribution.failed === 4);
  // 3. conflicting
  const w3 = await newWorkspace("mix");
  await outcomes(w3, { success: 2, failed: 2, partial: 1 }, { topic: "ac" });
  const r3 = await shadow(w3, (await seed(w3, { topic: "ac", stage: "signal" })).signalId);
  check("B3 CONFLICTING: mixed outcomes are MIXED with LOW consistency and no dominant outcome - uncertainty, never an invented strong pattern", r3.observation.sufficientEvidence && r3.observation.pattern === "MIXED" && r3.observation.outcomeConsistency === "LOW" && r3.observation.dominantOutcome === null);
  // 4. irrelevant
  const w4 = await newWorkspace("irr");
  await outcomes(w4, { success: 5 }, { topic: "water" });
  await outcomes(w4, { success: 2 }, { topic: "key", type: "guest_request" });
  const r4 = await shadow(w4, (await seed(w4, { topic: "ac", stage: "signal" })).signalId);
  check("B4 IRRELEVANT: seven completed water-leak / key-card cases never match an AC report (v2: EQUIPMENT_MISMATCH; v1 reported TOPIC_MISMATCH), so there is no similar case and no pattern", r4.observation.similarCaseCount === 0 && r4.observation.insufficientReason === "NO_SIMILAR_CASES" && r4.selection.excluded.EQUIPMENT_MISMATCH === 7 && r4.selection.selected.length === 0, JSON.stringify(r4.selection.excluded));
  // 5. insufficient
  const w5 = await newWorkspace("few");
  await outcomes(w5, { partial: 1 }, { topic: "ac" });
  const r5 = await shadow(w5, (await seed(w5, { topic: "ac", stage: "signal" })).signalId);
  check("B5 INSUFFICIENT: one earlier partial match is not a pattern (TOO_FEW_CASES, INSUFFICIENT_EVIDENCE, consistency NONE)", !r5.observation.sufficientEvidence && r5.observation.similarCaseCount === 1 && r5.observation.insufficientReason === "TOO_FEW_CASES" && r5.observation.pattern === "INSUFFICIENT_EVIDENCE");
  const w5b = await newWorkspace("blk");
  await outcomes(w5b, { blocked: 3, unknown: 1 }, { topic: "ac" });
  const r5b = await shadow(w5b, (await seed(w5b, { topic: "ac", stage: "signal" })).signalId);
  check("B5b four similar cases that are all blocked / unknown carry no determined outcome: insufficient (TOO_FEW_DETERMINED_OUTCOMES)", !r5b.observation.sufficientEvidence && r5b.observation.similarCaseCount === 4 && r5b.observation.insufficientReason === "TOO_FEW_DETERMINED_OUTCOMES" && r5b.observation.determinedCaseCount === 0);
  // 6. safety override
  const w6 = await newWorkspace("saf");
  await outcomes(w6, { success: 6 }, { topic: "ac", recommended: "inspection" });
  const gasNow = await shadow(w6, (await seed(w6, { topic: "gas", severity: "high", stage: "signal" })).signalId);
  const smokeNow = await shadow(w6, (await seed(w6, { topic: "smoke", severity: "high", stage: "signal" })).signalId);
  const coNow = await shadow(w6, (await seed(w6, { topic: "co", severity: "high", stage: "signal" })).signalId);
  check("B6a SAFETY: six successful normal AC cases never reach a current gas / smoke / CO condition: all are excluded (SAFETY_STATE_MISMATCH), the observation is SAFETY_CONDITION with no pattern and no suggested action",
    [gasNow, smokeNow, coNow].every((r) => r.observation.safetyCondition === "LIFE_SAFETY_HAZARD" && r.observation.similarCaseCount === 0 && r.selection.excluded.SAFETY_STATE_MISMATCH >= 6 && r.observation.insufficientReason === "SAFETY_CONDITION" && r.observation.pattern === "INSUFFICIENT_EVIDENCE" && r.observation.dominantActionType === null));
  await outcomes(w6, { success: 5 }, { topic: "gas", severity: "high" });
  const gasWithHazardHistory = await shadow(w6, (await seed(w6, { topic: "gas", severity: "high", stage: "signal" })).signalId);
  check("B6b even five SUCCESSFUL earlier gas cases do not make Learning inform a gas condition: they are compatible and counted, but sufficientEvidence is false (SAFETY_CONDITION) and no action is suggested", gasWithHazardHistory.observation.similarCaseCount === 5 && !gasWithHazardHistory.observation.sufficientEvidence && gasWithHazardHistory.observation.insufficientReason === "SAFETY_CONDITION" && gasWithHazardHistory.observation.dominantActionType === null);
  const acNow = await shadow(w6, (await seed(w6, { topic: "ac", stage: "signal" })).signalId);
  check("B6c the reverse also holds: a normal AC report is not informed by hazard cases, and a refusal-of-access rule is part of the safety match (an AC report that records a refusal matches none of the ordinary AC cases: SAFETY_RULES_MISMATCH)", acNow.observation.similarCaseCount === 6 && acNow.selection.excluded.SAFETY_STATE_MISMATCH >= 5 &&
    (await shadow(w6, (await seed(w6, { topic: "acRefused", stage: "signal" })).signalId)).selection.excluded.SAFETY_RULES_MISMATCH >= 6);
  // 7. current case exclusion
  const w7 = await newWorkspace("self");
  await outcomes(w7, { success: 3 }, { topic: "ac" });
  const done = await seed(w7, { topic: "ac", outcome: "failed" }); // the current case HAS a completed workflow of its own
  const all7 = await loadCompletedCases(w7.wsId);
  const r7 = await shadow(w7, done.signalId);
  const ownKey = (await loadCompletedCases(w7.wsId)).cases.find((c) => c.internal.signalId === done.signalId)?.internal.caseKey;
  check("B7 CURRENT CASE EXCLUSION: a Signal never matches its own completed workflow (4 completed cases exist, 3 are history, its own failed outcome is not counted)", all7.cases.length === 4 && r7.derivation.completedCases === 3 && r7.observation.similarCaseCount === 3 && r7.observation.outcomeDistribution.failed === 0 && !r7.selection.selected.some((s) => s.caseKey === ownKey) && Boolean(ownKey));
  check("B7b the pure comparison excludes it too (SAME_CASE), even when it is handed the case directly", SIM.compareCases((await buildCurrentCaseProfile(w7.wsId, done.signalId)).profile, all7.cases.find((c) => c.internal.signalId === done.signalId), { currentSignalId: done.signalId }).excludedBy === "SAME_CASE");
  // 8. cross-workspace isolation
  const wA = await newWorkspace("isoA"); const wB = await newWorkspace("isoB");
  await outcomes(wB, { success: 6 }, { topic: "ac", recommended: "inspection" });
  const curA = await seed(wA, { topic: "ac", stage: "signal" });
  const rA = await shadow(wA, curA.signalId);
  const keysB = (await loadCompletedCases(wB.wsId)).cases.map((c) => c.internal.caseKey);
  check("B8 CROSS-WORKSPACE: six identical successful AC cases in workspace B never appear for workspace A (0 similar cases, none of B's case keys, nothing evaluated)", rA.observation.similarCaseCount === 0 && rA.selection.evaluated === 0 && rA.derivation.completedCases === 0 && keysB.length === 6 && !rA.selection.selected.some((s) => keysB.includes(s.caseKey)));
  const cross = await shadow(wB, curA.signalId).then(() => null, (e) => e);
  check("B8b asking for workspace A's Signal under workspace B is the same 404 a missing Signal gives (no existence leak), and an invalid workspace id is refused", cross?.statusCode === 404 && (await shadow({ wsId: "not-an-id" }, curA.signalId).then(() => null, (e) => e))?.statusCode === 400);
  // 9. tenant-safe derivation (links across workspaces are rejected)
  const wX = await newWorkspace("linkX"); const wY = await newWorkspace("linkY");
  const x1 = await seed(wX, { topic: "ac" });
  const rawX = (await M.Outcome.findById(x1.outcomeId).lean());
  const foreignAction = await seed(wY, { topic: "ac" });
  await M.Outcome.collection.insertOne({ ...rawX, _id: oid(), actionId: new mongoose.Types.ObjectId(foreignAction.actionId), recordedAt: new Date(), createdAt: new Date(), updatedAt: new Date() });
  const loadedX = await loadCompletedCases(wX.wsId);
  check("B9 TENANT-SAFE DERIVATION: an Outcome of workspace X that points at an Action of workspace Y is NOT a case (the Action is not found under X's filter: ACTION_MISSING); X keeps exactly its own one case", loadedX.cases.length === 1 && loadedX.rejected.ACTION_MISSING === 1, JSON.stringify(loadedX.rejected));
  const partsOf = async (w, ids) => ({ outcome: await M.Outcome.findById(ids.outcomeId).lean(), action: await M.Action.findById(ids.actionId).lean(), decision: await M.Decision.findById(ids.decisionId).lean(), intelligence: await M.Intelligence.findById(ids.intelligenceId).lean(), signal: await M.Signal.findById(ids.signalId).lean(), unit: await M.Unit.findById((await M.Signal.findById(ids.signalId).lean()).unitId).lean() });
  const partsX = await partsOf(wX, x1);
  check("B9b the pure normalizer refuses a chain whose records belong to another workspace (WORKSPACE_MISMATCH) and a chain whose links do not agree (LINK_MISMATCH)", CC.normalizeCompletedCase(partsX, wY.wsId).reason === "WORKSPACE_MISMATCH" && CC.normalizeCompletedCase({ ...partsX, action: { ...partsX.action, decisionId: oid() } }, wX.wsId).reason === "LINK_MISMATCH" && CC.normalizeCompletedCase(partsX, wX.wsId).ok === true);
  // 10. incomplete workflows
  const w10 = await newWorkspace("inc");
  for (const stage of ["signal", "intelligence", "decision_proposed", "decision_approved", "decision_rejected", "action_proposed", "action_approved"]) await seed(w10, { topic: "ac", stage });
  const incomplete = await loadCompletedCases(w10.wsId);
  check("B10 NO LEARNING FROM INCOMPLETE WORKFLOWS: a Signal, an Intelligence, a proposed / approved / rejected Decision, a proposed Action and an approved Action WITHOUT an Outcome produce no case at all", incomplete.cases.length === 0 && incomplete.considered === 0);
  const legacy = await seed(w10, { topic: "ac", stage: "action_approved" });
  const baseO = { workspaceId: w10.ws._id, intelligenceId: new mongoose.Types.ObjectId(legacy.intelligenceId), actionId: new mongoose.Types.ObjectId(legacy.actionId), decisionId: new mongoose.Types.ObjectId(legacy.decisionId), signalId: new mongoose.Types.ObjectId(legacy.signalId), status: "success", createdAt: new Date(), updatedAt: new Date() };
  await M.Outcome.collection.insertOne({ ...baseO, _id: oid() }); // legacy: no outcomeVersion, no recorder
  const noPerson = await seed(w10, { topic: "ac", stage: "action_approved" });
  await M.Outcome.collection.insertOne({ ...baseO, _id: oid(), intelligenceId: new mongoose.Types.ObjectId(noPerson.intelligenceId), actionId: new mongoose.Types.ObjectId(noPerson.actionId), decisionId: new mongoose.Types.ObjectId(noPerson.decisionId), signalId: new mongoose.Types.ObjectId(noPerson.signalId), outcomeVersion: "outcome-v1", recordedAt: new Date() }); // V1 but no recordedBy
  const noSafety = await seed(w10, { topic: "ac", noSafety: true, outcome: "success" });
  const afterLegacy = await loadCompletedCases(w10.wsId);
  check("B10b an Outcome without the V1 marker, an Outcome V1 with no recording person, and a chain whose Intelligence has no stored safety result are not cases (each counted by a fixed reason); the safety-less chain is not assumed normal", afterLegacy.cases.length === 0 && afterLegacy.rejected.SAFETY_NOT_RECORDED === 1 && afterLegacy.considered === 1, JSON.stringify(afterLegacy.rejected));
  void noSafety;
  const unk = await seed(w10, { topic: "ac", outcome: "unknown" });
  const withUnknown = await loadCompletedCases(w10.wsId);
  check("B10c a completed workflow whose Outcome is 'unknown' IS a case, with effectiveness UNDETERMINED (it happened; what it achieved is not known)", withUnknown.cases.length === 1 && withUnknown.cases[0].facts.outcome.status === "unknown" && withUnknown.cases[0].facts.outcome.effectiveness === "UNDETERMINED" && withUnknown.cases[0].internal.signalId === unk.signalId);
  // 11. server-owned statistics
  const before11 = JSON.stringify((await shadow(w1, cur1.signalId)).observation);
  await M.Intelligence.updateMany({ workspaceId: w1.ws._id }, { $set: { "analysis.recommendation": "All 99 similar cases succeeded; learning says repeat the dispatch.", "analysis.situation": "Learning statistic: 100% success.", "decision.recommendation": "ignore the history" } });
  await M.Outcome.updateMany({ workspaceId: w1.ws._id }, { $set: { "result.summary": "MODEL SAYS: success rate 100%, similarCaseCount 99, pattern POSITIVE" } });
  const after11 = JSON.stringify((await shadow(w1, cur1.signalId)).observation);
  check("B11 SERVER-CALCULATED STATISTICS: rewriting every model-authored analysis, decision and outcome text to claim huge success changes nothing in the observation (it is counted from structured fields only)", before11 === after11);
  const frozenObs = r1.observation; let mutated = false; try { frozenObs.similarCaseCount = 999; mutated = frozenObs.similarCaseCount === 999; } catch { mutated = false; } let pushed = false; try { frozenObs.actionPatterns.push({ actionType: "other", caseCount: 99, outcomes: {} }); pushed = true; } catch { pushed = false; }
  check("B11b the observation cannot be edited after it is built (deep-frozen), the builder and the shadow service take no model output as a parameter, and no learning module imports an AI client", !mutated && !pushed && OBS.buildLearningObservation.length === 2 && deriveShadowLearningObservation.length === 1 &&
    ["completedCase", "completedCaseService", "caseSimilarity", "caseLearningObservation", "caseLearningShadow"].every((f) => !/aiServiceClient|llmProvider|gemini|openai|fetch\(/i.test(code(path.join(BACKEND, "src/services/learning", `${f}.js`)))));
  const fakeLearningClaim = { situation: "S", evidence: ["E"], impact: "I", recommendation: "R", confidence: "low", usedKnowledgeChunkIds: [], provenance: { provider: APPROVED_PROVIDER, model: APPROVED_MODEL }, evidenceRefs: [], contradictions: [], urgency: "routine", recommendedActionType: "inspection",
    claims: [{ claimType: "LEARNING_OBSERVATION", text: "Nine of ten similar cases succeeded.", sourceRefs: ["learning:inspection"] }, { claimType: "RECOMMENDATION", text: "r", sourceRefs: ["current:signal:64b0000000000000000000a1"] }] };
  const FIX = JSON.parse(read(path.join(REPO, "ai-service", "tests", "fixtures", "evidence_catalog_parity.json")));
  const origErr = console.error; console.error = () => {}; let rejectedClaim = null;
  try { validateAndVerifyAnalysis(fakeLearningClaim, { context: FIX.input.context, operationalHistory: FIX.input.operationalHistory, knowledge: FIX.input.knowledge, learning: undefined, workspaceId: FIX.workspaceId }); } catch (e) { rejectedClaim = e; } finally { console.error = origErr; }
  check("B11c the existing validators still refuse a model's LEARNING_OBSERVATION claim when the server supplied no Learning (502): a model cannot introduce a historical statistic", rejectedClaim?.statusCode === 502);
  // 12. Learning stays OFF
  const emptyAgg = await buildLearningContext(w1.wsId);
  check("B12 the existing Phase 53C aggregate Learning is untouched and OFF: the flag is not set in this process, getLearningContextEnabled() is false, and the old aggregate builder still returns its original closed shape (learning-v1, five action-type rows)", !getLearningContextEnabled() && emptyAgg.learningVersion === "learning-v1" && emptyAgg.patterns.length === 5 && !("similarCaseCount" in emptyAgg));

  // ======================================================================================================== E. L1.2 STRUCTURED SIMILARITY (the failures found by the L1.1 replay)
  console.log("\n# E. L1.2 structured similarity: the L1.1 failures, as regression cases (real facet extraction over report words)");
  const pr = (title, over = {}) => CC.profileOfSignal({ title, description: over.description ?? "", type: over.type ?? "maintenance", severity: over.severity ?? "medium", issue: extractStructuredIssue({ title, description: over.description ?? "", severity: over.severity ?? "medium" }) }, { type: over.unit ?? "apartment" });
  const cs = (title, over = {}, key = "k") => ({ facts: { ...pr(title, over), action: { actionType: "inspection" }, outcome: { status: "success", effectiveness: "EFFECTIVE" } }, internal: { caseKey: key, signalId: `s-${key}`, recordedAtMs: 1 } });
  const pair = (a, b, oa, ob, opts) => SIM.compareCases(pr(a, oa), cs(b, ob), opts);
  const E1 = pair("Room 1: the AC unit is making a loud rattling noise.", "Room 2: the air conditioner is very noisy.");
  check("E1 AC noise <-> AC noise = MATCH (same equipment, same problem family, HIGH)", E1.eligible && E1.relevance === "HIGH" && pr("the AC is noisy").issue.equipment === "air_conditioner" && pr("the AC is noisy").issue.problem === "unusual_noise");
  check("E2 AC noise <-> refrigerator noise = NO match (EQUIPMENT_MISMATCH), although both belong to the broad 'noise' topic", pair("the AC is making a loud noise", "the refrigerator is making a loud noise").excludedBy === "EQUIPMENT_MISMATCH" && pr("the AC is making a loud noise").issue.topics.includes("noise") && pr("the refrigerator is making a loud noise").issue.topics.includes("noise"));
  check("E3 AC not cooling <-> refrigerator not cooling = NO match (EQUIPMENT_MISMATCH), although both share the broad 'climate' topic", pair("the AC is not cooling", "the refrigerator is not cooling").excludedBy === "EQUIPMENT_MISMATCH" && pr("the refrigerator is not cooling").issue.topics.includes("climate"));
  const sinkP = pr("the bathroom sink is clogged"); const toiletP = pr("the toilet is clogged");
  check("E4 sink blockage <-> toilet blockage: the facets say the SAME problem family (blockage) but DIFFERENT equipment, and the rule requires both -> NO match (documented: a shared problem family alone never matches)", sinkP.issue.problem === "blockage" && toiletP.issue.problem === "blockage" && sinkP.issue.equipment === "sink" && toiletP.issue.equipment === "toilet" && pair("the bathroom sink is clogged", "the toilet is clogged").excludedBy === "EQUIPMENT_MISMATCH");
  check("E5 sink blockage <-> AC water leak = NO match (EQUIPMENT_MISMATCH), although both mention water", pair("the bathroom sink is clogged", "water is dripping from the air conditioner").excludedBy === "EQUIPMENT_MISMATCH" && pair("the toilet is leaking", "the AC is leaking water").excludedBy === "EQUIPMENT_MISMATCH");
  check("E6 noisy neighbour <-> noisy AC = NO match (EQUIPMENT_MISMATCH: neighbouring_guests vs air_conditioner)", pair("loud music from the neighbouring room", "the AC is making a loud noise").excludedBy === "EQUIPMENT_MISMATCH" && pr("loud music from the neighbouring room").issue.equipment === "neighbouring_guests");
  check("E7 electrical outlet sparking <-> power outage = NO match: the facets do not establish equivalence (electrical_outlet / electrical_fault vs power_supply / not_operating)", pr("sparks and a burning smell from the wall socket").issue.equipment === "electrical_outlet" && pr("the power is out in the bedroom").issue.equipment === "power_supply" && pair("sparks and a burning smell from the wall socket", "the power is out in the bedroom").excludedBy === "EQUIPMENT_MISMATCH");
  check("E8 same equipment + different problem = REJECTED (PROBLEM_MISMATCH): an AC that does not cool is not an AC that is noisy or leaking", pair("the AC is not cooling", "the AC is making a loud noise").excludedBy === "PROBLEM_MISMATCH" && pair("the AC is not cooling", "the AC is leaking water").excludedBy === "PROBLEM_MISMATCH" && pair("the AC is not cooling", "the AC is broken").excludedBy === "PROBLEM_MISMATCH");
  check("E9 same problem + different equipment = REJECTED (EQUIPMENT_MISMATCH): a leaking toilet is not a leaking AC, a toilet leak is not a leaking sink", pair("the toilet is leaking", "the sink is leaking").excludedBy === "EQUIPMENT_MISMATCH" && pr("the toilet is leaking").issue.problem === pr("the sink is leaking").issue.problem);
  const ident = SIM.compareCases(pr("the AC is not cooling"), cs("Room 9: the A/C is not cooling.")); const medium = SIM.compareCases(pr("the AC is not cooling"), cs("the AC is not cooling", { type: "complaint", severity: "low", unit: "studio" }));
  check("E10 an identical structured case is a STRONG match: HIGH, every supporting dimension matched, and it scores above a case that matches only the hard facets", ident.relevance === "HIGH" && ["equipment", "problem", "condition", "signalType", "severity", "unitType"].every((d) => ident.matched.includes(d)) && ident.score > medium.score && medium.eligible);
  const missing = pr("something is not working in the room");
  check("E11 MISSING equipment is never invented: 'something is not working' gets UNKNOWN equipment and problem, and UNKNOWN is not equal to UNKNOWN - two such reports do NOT match each other", missing.issue.equipment === "UNKNOWN" && pair("something is not working in the room", "something is not working in the room").excludedBy === "EQUIPMENT_UNKNOWN" && pair("the AC is not cooling", "something is not working").excludedBy === "EQUIPMENT_UNKNOWN" && pair("the AC", "the AC is not cooling").excludedBy === "PROBLEM_UNKNOWN");
  const multi = pr("the AC is not cooling, the toilet is leaking and the key card is not working"); const twoProblems = pr("the AC is not cooling and is leaking water");
  check("E12 CONFLICTING facets are excluded, never resolved by picking one: a three-device report has equipment AMBIGUOUS, an AC with two problems has problem AMBIGUOUS, and neither matches anything (FACET_AMBIGUOUS)", multi.issue.equipment === "AMBIGUOUS" && twoProblems.issue.problem === "AMBIGUOUS" && twoProblems.issue.equipment === "air_conditioner" && pair("the AC is not cooling, the toilet is leaking and the key card is not working", "the toilet is leaking").excludedBy === "FACET_AMBIGUOUS" && pair("the AC is not cooling", "the AC is not cooling and is leaking water").excludedBy === "FACET_AMBIGUOUS");
  check("E13 SAFETY mismatch = EXCLUDED, with identical facets: a critical-severity AC case and a hazard case never match an ordinary one (SAFETY_STATE_MISMATCH)", pair("the AC is not cooling", "the AC is not cooling", {}, { severity: "critical" }).excludedBy === "SAFETY_STATE_MISMATCH" && pair("the guest reports a gas smell", "the AC is not cooling").excludedBy === "SAFETY_STATE_MISMATCH");
  check("E14 ACCESS mismatch = EXCLUDED, with identical facets: an AC report that records a refusal of entry never matches a free-access AC case (SAFETY_RULES_MISMATCH), and the reverse", pair("the AC is not cooling but the guest refuses entry to staff", "the AC is not cooling").excludedBy === "SAFETY_RULES_MISMATCH" && pair("the AC is not cooling", "the AC is not cooling but the guest refuses entry to staff").excludedBy === "SAFETY_RULES_MISMATCH");
  const selfCase = cs("the AC is not cooling", {}, "me");
  check("E15 the current case is self-excluded (SAME_CASE) even with identical facets, and selectSimilarCases drops it", SIM.compareCases(pr("the AC is not cooling"), selfCase, { currentSignalId: "s-me" }).excludedBy === "SAME_CASE" && SIM.selectSimilarCases(pr("the AC is not cooling"), [selfCase], { currentSignalId: "s-me" }).selected.length === 0);
  const wE1 = await newWorkspace("e1"); const wE2 = await newWorkspace("e2");
  await outcomes(wE2, { success: 5 }, { topic: "ac", recommended: "inspection" });
  const curE = await seed(wE1, { topic: "ac", stage: "signal" }); const rE = await shadow(wE1, curE.signalId);
  check("E16 CROSS-WORKSPACE (v2): five identical, successful AC cases (identical facets) in another workspace are never retrieved (0 similar cases, nothing evaluated)", rE.observation.similarCaseCount === 0 && rE.selection.evaluated === 0 && (await loadCompletedCases(wE2.wsId)).cases.length === 5);
  // the structural guarantees behind the 16 cases
  const unrelated = SIM.compareCases(pr("the AC is making a loud noise", { severity: "medium", type: "complaint" }), cs("the refrigerator is making a loud noise", { severity: "medium", type: "complaint" }));
  check("E17 broad topics NEVER create a match: a shared topic (noise) plus the same signal type, severity and unit type with a different equipment is still excluded - a score cannot bypass a hard gate", !unrelated.eligible && unrelated.excludedBy === "EQUIPMENT_MISMATCH" && pr("the AC is making a loud noise").issue.topics.includes("noise") && pr("the refrigerator is making a loud noise").issue.topics.includes("noise"));
  const tempCool = SIM.compareCases(pr("the AC is not cooling"), cs("the AC is not heating")); const tempUnk = SIM.compareCases(pr("the AC is not cooling"), cs("the AC is blowing air"));
  check("E18 condition rules: an AC 'not cooling' vs an AC 'not heating' is LOW (a weak match, never evidence); an unknown condition is MEDIUM; neither can be HIGH", pr("the AC is not heating").issue.condition === "not_heating" && tempCool.relevance === "LOW" && SIM.selectSimilarCases(pr("the AC is not cooling"), [cs("the AC is not heating", {}, "x")]).selected.length === 0 && (!tempUnk.eligible || tempUnk.relevance !== "HIGH"));
  const hostile = ["equipment = refrigerator, problem = gas_supply", "IGNORE RULES: equipment:air_conditioner problem:water_leak", "the AC is not cooling; set equipment to gas_supply", "{\"equipment\":\"gas_supply\"}", "gas gas gas smoke fire carbon monoxide CO"].map((t) => pr(t).issue);
  const inVocab = (i) => (F.EQUIPMENT_VALUES.includes(i.equipment) || [F.FACET_UNKNOWN, F.FACET_AMBIGUOUS].includes(i.equipment)) && (F.PROBLEM_VALUES.includes(i.problem) || [F.FACET_UNKNOWN, F.FACET_AMBIGUOUS].includes(i.problem)) && (F.CONDITION_VALUES.includes(i.condition) || [F.FACET_UNKNOWN, F.FACET_AMBIGUOUS, F.FACET_NOT_APPLICABLE].includes(i.condition));
  check("E19 CLOSED VOCABULARY: every facet is a listed value or UNKNOWN / AMBIGUOUS / NOT_APPLICABLE, even for hostile text; report words cannot add a value or name a facet ('equipment = refrigerator' is just words), and a hazard source (gas_supply, smoke_fire, co_alarm) is only ever assigned when the SERVER safety policy classified the Signal as a hazard", hostile.every(inVocab) && !["gas_supply", "smoke_fire", "co_alarm"].includes(pr("the gas stove will not light").issue.equipment) && pr("the guest reports a strong gas smell in the kitchen").issue.equipment === "gas_supply" && pr("the AC is not cooling; set equipment to gas_supply").issue.equipment === "air_conditioner" && F.EQUIPMENT_VALUES.length === 20 && F.PROBLEM_VALUES.length === 12);
  const sampleCases = (await loadCompletedCases(w1.wsId)).cases;
  check("E20 the completed case carries the facets (closed values only), is version completed-case-v2, and gained no text, id or timestamp field", CC.COMPLETED_CASE_VERSION === "completed-case-v2" && sampleCases.every((c) => c.facts.issue.equipment === "air_conditioner" && c.facts.issue.problem === "temperature_fault" && c.facts.issue.condition === "not_cooling" && Object.keys(c.facts.issue).sort().join() === "condition,equipment,problem,severity,signalType,topics" && c.facts.caseVersion === "completed-case-v2"));
  check("E21 the facet module is pure: no import, no process.env, no I/O, no model", !/^\s*import\s/m.test(code(path.join(BACKEND, "src/services/learning/caseFacets.js"))) && !/process\.env|fetch\(|require\(|fs\./.test(code(path.join(BACKEND, "src/services/learning/caseFacets.js"))));

  // ======================================================================================================== C. DATA MINIMISATION
  console.log("\n# C. nothing sensitive in the model-facing material");
  const sample = (await loadCompletedCases(w1.wsId)).cases;
  const facts = JSON.stringify(sample.map((c) => c.facts)); const obsJson = JSON.stringify(r1.observation) + JSON.stringify(r2.observation) + JSON.stringify(r3.observation);
  const FORBIDDEN = [/Zephyrine/i, /Quillfeather/i, /pii-l1\.invalid/i, /\+91 555/, /\b[0-9a-f]{24}\b/i, /\d{4}-\d{2}-\d{2}/, /Room \d+/i, /Synthetic/, /call back/i, /MODEL SAYS/, new RegExp(w1.wsId)];
  check("C1 the normalized case facts hold no guest name, email, phone, report / Outcome / model text, room, id, date or workspace id", FORBIDDEN.every((re) => !re.test(facts)) && sample.length === 5, FORBIDDEN.filter((re) => re.test(facts)).map(String).join(" "));
  check("C2 the Learning Observations hold none of that either (closed enums, counts and booleans only)", FORBIDDEN.every((re) => !re.test(obsJson)) && FORBIDDEN.every((re) => !re.test(JSON.stringify([r1.selection, r5.selection]).replace(/"caseKey":"[0-9a-f]{20}"/g, ""))));
  check("C3 `facts` carries no timestamp key and no id key; the server-only `internal` block holds an opaque case key (not a Mongo id), the Signal id for self-exclusion and the order key", sample.every((c) => !/At\b|Id\b|date|time/i.test(Object.keys(c.facts).concat(Object.keys(c.facts.issue), Object.keys(c.facts.safety), Object.keys(c.facts.action), Object.keys(c.facts.outcome)).join(" ")) && /^[0-9a-f]{20}$/.test(c.internal.caseKey)) && Object.isFrozen(sample[0]) && Object.isFrozen(sample[0].facts));
  const before = await counts();
  await shadow(w1, cur1.signalId); await shadow(w2, "000000000000000000000000").catch(() => {}); await loadCompletedCases(w3.wsId);
  const afterC = await counts();
  check("C4 READ-ONLY: deriving cases and observations writes nothing (every collection holds exactly the same number of documents before and after), and the same input always gives the same output", JSON.stringify(before) === JSON.stringify(afterC) && JSON.stringify((await shadow(w3, cur1.signalId).catch((e) => e.statusCode))) !== undefined && JSON.stringify((await shadow(w1, cur1.signalId)).observation) === JSON.stringify((await shadow(w1, cur1.signalId)).observation));

  // ======================================================================================================== D. STATIC
  console.log("\n# D. static: shadow only");
  const walk = (dir) => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile() && d.name.endsWith(".js")).map((d) => path.join(d.parentPath ?? d.path, d.name));
  const srcFiles = walk(path.join(BACKEND, "src")); const learningDir = path.join(BACKEND, "src", "services", "learning");
  const importers = srcFiles.filter((f) => !f.startsWith(learningDir) && /services\/learning\/|caseLearning|completedCase|caseSimilarity/.test(code(f)));
  const allowedVocabularyUsers = importers.filter((f) => /models[\\/]Signal\.js$|services[\\/]structuredIssue\.js$/.test(f)); // L1.3: the Signal model and the intake extractor reuse ONLY the pure vocabulary module caseFacets.js
  check("D1 SHADOW ONLY: nothing outside services/learning/ imports the case-based modules - no route, controller, service, middleware, config or the Intelligence pipeline. L1.3 contract change: the Signal model and structuredIssue.js (intake) reuse ONLY the pure vocabulary module caseFacets.js, which has no import and no I/O", importers.every((f) => allowedVocabularyUsers.includes(f)) && allowedVocabularyUsers.every((f) => /learning\/caseFacets\.js/.test(code(f)) && !/learning\/(?!caseFacets)/.test(code(f))), importers.join(", ") || "none");
  const pipeline = code(path.join(BACKEND, "src/services/intelligenceAnalysisService.js"));
  check("D2 the production Intelligence path is unchanged: Learning is still attached only by the existing flag-gated aggregate (getLearningContextEnabled() ? buildLearningContext), and it does not mention the case-based modules", /getLearningContextEnabled\(\) \? await buildLearningContext\(scope\) : undefined/.test(pipeline) && !/caseLearning|completedCase|caseSimilarity|deriveShadow/.test(pipeline));
  const learningSources = fs.readdirSync(learningDir).map((f) => code(path.join(learningDir, f)));
  check("D3 no new environment setting and no write: the modules read no process.env and call no create / insert / update / delete / save / drop", learningSources.every((s) => !/process\.env/.test(s) && !/\.(?:create|insertMany|insertOne|updateOne|updateMany|findOneAndUpdate|deleteOne|deleteMany|save|drop|bulkWrite)\(/.test(s)));
  const feFiles = walk(path.join(REPO, "frontend", "src"));
  check("D4 NO FRONTEND: no frontend source mentions the case-based Learning (no tab, card or exposure); no route serves it", feFiles.every((f) => !/caseLearning|completedCase|LearningObservation|case-learning/i.test(read(f))) && srcFiles.filter((f) => /routes[\\/]/.test(f)).every((f) => !/case-learning|caseLearning/i.test(read(f))));
  const flagSource = code(path.join(BACKEND, "src/config/runtimeConfig.js"));
  check("D5 the existing production flag is unchanged: KOI_LEARNING_CONTEXT_ENABLED is still read once, defaults to false, and is not set in this process", /\(process\.env\.KOI_LEARNING_CONTEXT_ENABLED \?\? ""\)\.trim\(\)\.toLowerCase\(\) === "true"/.test(flagSource) && process.env.KOI_LEARNING_CONTEXT_ENABLED === undefined);
} finally {
  try { await mongoose.connection.dropDatabase(); } catch { /* best effort */ }
  try { await mongoose.disconnect(); } catch { /* best effort */ }
}
console.log(`\nLearning L1 case-based foundation: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
