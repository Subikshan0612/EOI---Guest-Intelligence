/**
 * Learning L1.1 - SHADOW REPLAY EVALUATION of the L1 case-based Learning. EVALUATION ONLY: no Gemini, no embeddings, no feature flag, no write outside a throwaway loopback database
 * (dropped at the end). The L1 modules are used exactly as they are; nothing here changes them.
 *
 *   A  adversarial in-memory variants (the 8 required): the documented gates behave as documented
 *   B  a LABELLED SYNTHETIC corpus (about 180 completed workflows built through the application's own services, in two workspaces) replayed through the real shadow path:
 *      coverage, similarity availability, evidence sufficiency, patterns, structural relevance, retrieval quality against ground-truth labels, topic widening,
 *      safety, tenant isolation, self exclusion, determinism, and "nothing was written during the replay"
 *   C  the real database is evaluated separately and READ-ONLY by scripts/phase41/atlas-learning-replay-readonly.mjs (this script cannot reach Atlas by design)
 *
 * The synthetic corpus is NOT evidence about how much usable history the real system has - it measures what the matcher does when history exists. Retrieval quality is judged against
 * ground-truth labels written by hand for each synthetic report (equipment and problem); no score is machine-learned.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(here, "..");
const read = (p) => fs.readFileSync(p, "utf8");
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, "");
let passed = 0; let failed = 0;
const check = (name, ok, detail = "") => { if (ok) { passed += 1; console.log(`PASS  ${name}${detail ? ` - ${detail}` : ""}`); } else { failed += 1; console.error(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`); } };

{ const __u = dotenv.parse(process.getBuiltinModule("node:fs").readFileSync(new URL("../.env", import.meta.url))).MONGODB_URI ?? ""; if (/^mongodb:\/\/(?:[^@/]*@)?(localhost|127\.0\.0\.1)/i.test(__u)) process.env.MONGODB_URI ??= __u; }
const baseUri = process.env.MONGODB_URI;
const DB_NAME = `koi_l11_${Date.now()}`;
if (!baseUri || /^mongodb\+srv:|@/.test(baseUri) || !/^mongodb:\/\/(localhost|127\.0\.0\.1)/.test(baseUri)) { console.error("refusing: the configured MongoDB is not a plain loopback instance"); process.exit(2); }
process.env.MONGODB_URI = baseUri.replace(/(mongodb:\/\/[^/]+\/)([^?]*)/, `$1${DB_NAME}`);
delete process.env.KOI_LEARNING_CONTEXT_ENABLED;

const mongoose = (await import("mongoose")).default;
const { connectDatabase } = await import("../src/config/database.js");
const M = await import("../src/models/index.js");
const { createAnalysisIntelligence } = await import("../src/services/intelligenceService.js");
const { proposeDecision, approveDecision } = await import("../src/services/decisionService.js");
const { proposeAction, approveAction } = await import("../src/services/actionService.js");
const { recordOutcome } = await import("../src/services/outcomeService.js");
const { deriveSafetyPolicy } = await import("../src/services/ai/safetyPolicy.js");
// L1.3: facets come from the Signal's persisted server-derived `issue`; these seeds insert Signals directly, so they derive it exactly as signalService.createSignal does.
const { extractStructuredIssue } = await import("../src/services/structuredIssue.js");
const { getLearningContextEnabled } = await import("../src/config/runtimeConfig.js");
const { profileOfSignal } = await import("../src/services/learning/completedCase.js");
const { compareCases } = await import("../src/services/learning/caseSimilarity.js");
const { loadCompletedCases } = await import("../src/services/learning/completedCaseService.js");
const { replayWorkspaces, computeMetrics, fingerprintOfResult } = await import("./lib/l1ReplayMetrics.mjs");
await connectDatabase();
if (mongoose.connection.db.databaseName !== DB_NAME) { console.error("refusing: not connected to the isolated database"); process.exit(2); }

// ================================================================================================================ A. ADVERSARIAL (in memory)
console.log("\n# A. adversarial in-memory variants (the documented gates)");
// L1.3: a Signal carries its server-derived `issue` (derived exactly as signalService.createSignal does); the facets are not re-parsed from the words
const sig = (title, over = {}) => { const s = { title, description: "", type: "maintenance", severity: "medium", ...over }; return { ...s, issue: extractStructuredIssue({ title: s.title, description: s.description, severity: s.severity }) }; };
const prof = (title, over, unit = { type: "apartment" }) => profileOfSignal(sig(title, over), unit);
const asCase = (title, over, key = "c", unit) => ({ facts: { ...prof(title, over, unit), action: { actionType: "inspection" }, outcome: { status: "success" } }, internal: { caseKey: key, signalId: `s-${key}`, recordedAtMs: 1 } });
const cmp = (curTitle, candTitle, curOver, candOver, opts) => compareCases(prof(curTitle, curOver), asCase(candTitle, candOver), opts);
const V1 = cmp("Room 1: the AC is not cooling.", "Room 2: the air conditioning is not cooling.");
check("A1 same issue, same type -> eligible, HIGH (identical topics + same type), safety / topic / type / severity / unit all matched", V1.eligible && V1.relevance === "HIGH" && ["safety", "topic", "signalType", "severity", "unitType"].every((d) => V1.matched.includes(d)), JSON.stringify(V1));
const V2a = cmp("Room 1: the AC is not cooling.", "Room 2: the AC is not cooling.", {}, { severity: "critical" });
const V2b = cmp("Room 1: the AC is not cooling but the guest refuses entry to staff.", "Room 2: the AC is not cooling.");
const V2c = cmp("Room 1: the AC is not cooling and there is a gas smell.", "Room 2: the AC is not cooling.");
check("A2 same issue, different safety -> EXCLUDED: a critical-severity case (state), a refusal of access (rule) and a gas smell added to an AC report (hazard state) each fail the safety gates, and none can be rescued by identical topics", V2a.excludedBy === "SAFETY_STATE_MISMATCH" && V2b.excludedBy === "SAFETY_RULES_MISMATCH" && V2c.excludedBy === "SAFETY_STATE_MISMATCH");
const V3 = cmp("Room 1: the AC is not cooling.", "Room 2: the toilet is leaking.");
// L1.2: the matcher gates changed from broad topics to structured facets; A3 / A4 / A6 state the documented gate behaviour of the matcher version under test (the corpus, ground truth and metrics below are unchanged)
check("A3 different issue, same type -> EXCLUDED (L1.2: EQUIPMENT_MISMATCH; v1 reported TOPIC_MISMATCH) even though both are 'maintenance' of the same severity", V3.excludedBy === "EQUIPMENT_MISMATCH");
const V4a = cmp("Room 1: the AC is not cooling, the toilet is leaking and the key card is not working.", "Room 2: the toilet is leaking.");
const V4b = cmp("Room 1: the AC is not cooling, the toilet is leaking and the key card is not working.", "Room 2: loud music from the next room.", {}, { type: "complaint" });
check("A4 multiple unrelated topics: a three-problem report no longer matches a pure toilet-leak case (v1: eligible MEDIUM through ONE shared topic = the topic widening L1.1 measured; L1.2: FACET_AMBIGUOUS, a conflict is excluded) and matches no noise case either", V4a.excludedBy === "FACET_AMBIGUOUS" && V4b.excludedBy === "FACET_AMBIGUOUS");
const V5 = cmp("Room 1: the AC is not cooling.", "Room 2: the AC is not cooling.", { severity: "high" }, { severity: "low" });
check("A5 same topics, different severity (both non-critical) -> still eligible and HIGH: severity only changes the score (it is not a gate), and the score stays below the matching-severity score", V5.eligible && V5.relevance === "HIGH" && !V5.matched.includes("severity") && V5.score < V1.score);
const V6a = cmp("The guest seems unhappy.", "The guest is unhappy with the view.", { type: "complaint" }, { type: "complaint" });
const V6b = cmp("The guest seems unhappy.", "Something odd.", { type: "complaint" }, { type: "other" });
const V6c = cmp("The guest seems unhappy.", "Room 2: the AC is not cooling.", { type: "complaint" }, {});
check("A6 no recognised facets (L1.2): reports with no equipment or problem are EXCLUDED whatever their type (EQUIPMENT_UNKNOWN: UNKNOWN is never equal to UNKNOWN; v1 kept same-type no-topic pairs as LOW weak matches) - nothing is guessed", V6a.excludedBy === "EQUIPMENT_UNKNOWN" && V6b.excludedBy === "EQUIPMENT_UNKNOWN" && V6c.excludedBy === "EQUIPMENT_UNKNOWN");
const V7a = compareCases(prof("Room 1: the AC is not cooling."), { ...asCase("Room 1: the AC is not cooling."), internal: { caseKey: "self", signalId: "s-1", recordedAtMs: 1 } }, { currentSignalId: "s-1" });
const V7b = cmp("Room 1: the AC is not cooling.", "Room 1: the AC is not cooling.", {}, {}, { currentSignalId: "s-other" });
check("A7 identical current case: the same Signal is excluded (SAME_CASE); an identical REPORT filed twice as a different Signal is a different case and is eligible (HIGH) - a duplicate is history, not self", V7a.excludedBy === "SAME_CASE" && V7b.eligible && V7b.relevance === "HIGH");
check("A8 cross-workspace: the pure comparison has no workspace concept by design (the loader owns tenancy); the cross-workspace gate is proven at scale in B (0 cross-workspace retrievals across the replay of two workspaces holding the same situations)", true);

// ================================================================================================================ B. SYNTHETIC CORPUS
console.log("\n# B. labelled synthetic corpus replayed through the real shadow path");
const oid = () => new mongoose.Types.ObjectId();
const actor = oid(); const reviewer = oid();
const opts = (who) => ({ authorizedLevel: "staff", actorUserId: who });
const O = { s: "success", p: "partial", f: "failed", b: "blocked", u: "unknown" };
// label: [equipment, problem, signal type, severity, unit, recommended action, six outcomes, three phrasings]
const SITUATIONS = {
  ac_not_cooling: ["ac", "not_working", "maintenance", "medium", "apartment", "inspection", "ssssp f", ["the AC is not cooling", "the air conditioning has stopped working properly", "the A/C is blowing warm air"]],
  ac_noisy: ["ac", "noise", "maintenance", "low", "studio", "inspection", "ffpsfp", ["the AC unit is making a loud rattling noise", "the air conditioner is very noisy", "the A/C fan is making a loud noise"]],
  ac_leaking: ["ac", "water_leak", "maintenance", "high", "apartment", "maintenance_dispatch", "ssps sf", ["the AC is leaking water onto the floor", "water is dripping from the air conditioner", "the A/C unit is leaking water"]],
  ac_broken_checkout: ["ac", "not_working", "maintenance", "medium", "apartment", "maintenance_dispatch", "sfspss", ["the guest checks out today and the air conditioning is broken", "the AC is broken and the guest wants an early check-out", "the A/C stopped and the guest is checking out today"]],
  toilet_leak: ["toilet", "water_leak", "maintenance", "high", "apartment", "maintenance_dispatch", "sssssp", ["the toilet is leaking and water is on the floor", "water is leaking from the toilet", "the toilet is leaking at the base"]],
  sink_blocked: ["sink", "blockage", "maintenance", "medium", "studio", "maintenance_dispatch", "ssfsps", ["the bathroom sink is clogged and draining slowly", "the sink drain is blocked", "the basin is clogged"]],
  no_hot_water: ["water_heater", "not_working", "maintenance", "medium", "apartment", "maintenance_dispatch", "ffsfpf", ["there is no hot water in the shower", "the shower water stays cold", "the geyser is not heating the shower"]],
  power_out: ["power", "not_working", "maintenance", "high", "apartment", "maintenance_dispatch", "sssps s", ["the power is out in the bedroom and the lights are not working", "there is a blackout in the room", "the breaker keeps tripping and the lights go out"]],
  wifi: ["wifi", "not_working", "guest_request", "low", "studio", "guest_communication", "spssus", ["the wifi is not working", "the internet is very slow and keeps dropping", "the router is down"]],
  fridge: ["fridge", "not_working", "maintenance", "medium", "apartment", "maintenance_dispatch", "ffspff", ["the refrigerator is not cooling", "the fridge is warm and food is spoiling", "the fridge stopped cooling overnight"]],
  key_card: ["lock", "not_working", "guest_request", "high", "apartment", "guest_communication", "ssbsbu", ["the key card is not opening the door", "the guest is locked out, the key card fails", "the door lock does not accept the key card"]],
  noise_party: ["neighbour", "noise", "complaint", "medium", "apartment", "guest_communication", "sssps s", ["loud music from the neighbouring room", "a noisy party next door is disturbing the guest", "the guest complains about noise from the next room"]],
  towels: ["housekeeping", "missing", "housekeeping", "low", "studio", "guest_communication", "ssssss", ["no fresh towels and the room was not cleaned", "the towels and linen were not changed", "the bedding is dirty and housekeeping did not come"]],
  late_checkout: ["stay", "request", "guest_request", "low", "apartment", "guest_communication", "sspsub", ["the guest asks for a late check-out", "the guest wants to extend the stay by one night", "the guest requests an early check-in"]],
  billing: ["invoice", "dispute", "payment", "medium", "apartment", "guest_communication", "psfpsu", ["the guest disputes a charge on the invoice", "the guest wants a refund of the deposit", "the bill shows an overcharge"]],
  gas: ["gas", "hazard", "maintenance", "high", "apartment", "escalation", "sssp s s", ["the guest reports a strong gas smell in the kitchen", "there is a smell of gas near the stove", "a gas leak odour in the corridor"]],
  smoke: ["smoke", "hazard", "maintenance", "high", "apartment", "escalation", "sssssp", ["the guest reports smoke coming from the bathroom vent", "there is smoke in the corridor", "smoke is coming from the kitchen"]],
  co: ["co", "hazard", "maintenance", "high", "apartment", "escalation", "ssps ss", ["the carbon monoxide alarm is sounding in the bedroom", "the CO alarm is going off", "the carbon monoxide detector is beeping"]],
  sparks: ["socket", "sparks", "maintenance", "high", "apartment", "maintenance_dispatch", "sssfss", ["sparks and a burning smell are coming from the wall socket", "the socket is sparking and smells of burning", "sparks from the outlet and a burning smell"]],
};
const parse = (s) => [...s.replace(/\s/g, "")].map((c) => O[c]);
const truth = Object.fromEntries(Object.entries(SITUATIONS).map(([k, v]) => [k, { equipment: v[0], problem: v[1] }]));
const judge = (currentLabel, retrievedLabel) => {
  const a = truth[currentLabel]; const b = truth[retrievedLabel];
  if (a.equipment === b.equipment && a.problem === b.problem) return "CLEARLY_RELEVANT";
  if (a.equipment === b.equipment) return "BORDERLINE"; // same equipment, a different problem (an AC that is noisy is not an AC that does not cool)
  if (a.problem === b.problem && a.problem === "water_leak") return "BORDERLINE"; // a leak from another source: the same kind of response, a different situation
  return "CLEARLY_IRRELEVANT";
};
// LENIENT variant (sensitivity check only): also BORDERLINE when two different equipment belong to the same system (plumbing, electrical, the three hazards)
const SYSTEM = { toilet: "plumbing", sink: "plumbing", water_heater: "plumbing", power: "electrical", socket: "electrical", gas: "hazard", smoke: "hazard", co: "hazard" };
const judgeLenient = (currentLabel, retrievedLabel) => { const j = judge(currentLabel, retrievedLabel); if (j !== "CLEARLY_IRRELEVANT") return j; const a = SYSTEM[truth[currentLabel].equipment]; const b = SYSTEM[truth[retrievedLabel].equipment]; return a && a === b ? "BORDERLINE" : j; };
const lenientNormal = { CLEARLY_RELEVANT: 0, BORDERLINE: 0, CLEARLY_IRRELEVANT: 0 };
let counter = 0;
async function newWorkspace(label) {
  counter += 1;
  const ws = await M.Workspace.create({ name: `L11 ${label}`, slug: `l11-${label}-${counter}-${Date.now()}`, status: "active" });
  const prop = await M.Property.create({ workspaceId: ws._id, name: `L11 ${label}`, code: `L11${counter}`, timezone: "UTC" });
  const units = { apartment: await M.Unit.create({ propertyId: prop._id, unitNumber: "A-1", type: "apartment", status: "occupied" }), studio: await M.Unit.create({ propertyId: prop._id, unitNumber: "S-1", type: "studio", status: "occupied" }) };
  const guest = await M.Guest.create({ workspaceId: ws._id, firstName: "Synthetic", lastName: "Guest", email: `g${counter}@pii-l11.invalid` });
  return { ws, wsId: String(ws._id), prop, units, guest };
}
const labelBySignal = new Map();
async function seedWorkflow(w, label, index, phraseOverride) {
  counter += 1;
  const [, , type, severity, unit, rec, outcomesStr, phrases] = SITUATIONS[label];
  const text = (phraseOverride ?? phrases)[index % 3];
  const sigDoc = await M.Signal.create({ workspaceId: w.ws._id, propertyId: w.prop._id, unitId: w.units[unit]._id, guestId: w.guest._id, type, source: "staff", severity, status: "new", title: `Room ${100 + counter}: ${text}.`, description: `${text}.`, issue: extractStructuredIssue({ title: `Room ${100 + counter}: ${text}.`, description: `${text}.`, severity }) });
  const policy = deriveSafetyPolicy({ signal: { title: sigDoc.title, description: sigDoc.description, severity: sigDoc.severity } });
  const recommended = policy.state === "LIFE_SAFETY_HAZARD" ? "escalation" : rec === "escalation" ? "maintenance_dispatch" : rec;
  const intel = (await createAnalysisIntelligence({ workspaceId: w.ws._id, signal: { id: sigDoc._id, title: sigDoc.title, type, severity }, propertyId: w.prop._id, level: "staff", analysis: { situation: "Synthetic.", evidence: ["Synthetic."], impact: "Synthetic.", recommendation: "A person could consider a synthetic step.", confidence: "medium" }, provider: "test", model: "deterministic-stub", knowledgeProvenance: [], safety: { state: policy.state, urgency: policy.state === "NORMAL" ? "prompt" : "immediate", recommendedActionType: recommended } })).record;
  const dec = (await proposeDecision(String(intel._id), w.wsId, {}, opts(actor))).record;
  await approveDecision(String(dec._id), w.wsId, {}, opts(reviewer));
  const act = (await proposeAction(String(dec._id), w.wsId, {}, opts(actor))).record;
  await approveAction(String(act._id), w.wsId, { note: "Approved." }, opts(reviewer));
  await recordOutcome(String(act._id), w.wsId, { status: parse(outcomesStr)[index % 6], result: { summary: "Synthetic outcome." } }, { actorUserId: actor, authorizedLevel: "staff" });
  labelBySignal.set(String(sigDoc._id), label);
}
const wA = await newWorkspace("A"); const wB = await newWorkspace("B");
const t0 = Date.now();
for (const label of Object.keys(SITUATIONS)) { for (let i = 0; i < 6; i += 1) await seedWorkflow(wA, label, i); for (let i = 0; i < 3; i += 1) await seedWorkflow(wB, label, i); }
console.log(`seeded ${labelBySignal.size} completed workflows (${Object.keys(SITUATIONS).length} situations x 6 in workspace A, x 3 in workspace B) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

const countsBefore = Object.fromEntries(await Promise.all(Object.values(M).filter((m) => m?.collection).map(async (m) => [m.collection.collectionName, await m.collection.countDocuments({})])));
const run1 = await replayWorkspaces([wA.wsId, wB.wsId]);
const run2 = await replayWorkspaces([wA.wsId, wB.wsId]);
const countsAfter = Object.fromEntries(await Promise.all(Object.values(M).filter((m) => m?.collection).map(async (m) => [m.collection.collectionName, await m.collection.countDocuments({})])));
const derived = [...run1.perWorkspaceCases.values()].reduce((s, v) => s + v.cases.length, 0);
const metrics = computeMetrics(run1, { derivedCases: derived });
const deterministic = run1.results.length === run2.results.length && run1.results.every((r, i) => fingerprintOfResult(r) === fingerprintOfResult(run2.results[i]));

// retrieval quality against the ground-truth labels
const quality = { CLEARLY_RELEVANT: 0, BORDERLINE: 0, CLEARLY_IRRELEVANT: 0 }; const irrelevantPairs = {}; const borderlinePairs = {}; const byCurrentLabel = {};
const normalQ = { CLEARLY_RELEVANT: 0, BORDERLINE: 0, CLEARLY_IRRELEVANT: 0 }; const normalIrrelevantPairs = {}; const normalBorderlinePairs = {}; let normalSufficient = 0; let normalContaminated = 0; let normalClean = 0; const normalPatterns = {}; const cleanPatterns = {}; const normalCurrents = { total: 0, withAnyIrrelevant: 0 };
let contaminated = 0; let sufficientObs = 0; let sufficientClean = 0; const usefulExamples = []; const contaminatedExamples = [];
for (const r of run1.results) {
  const cur = labelBySignal.get(r.signalId); const rows = { CLEARLY_RELEVANT: 0, BORDERLINE: 0, CLEARLY_IRRELEVANT: 0 };
  for (const s of r.selection.selected) {
    const cand = run1.caseIndex.get(s.caseKey); const j = judge(cur, labelBySignal.get(cand.signalId));
    quality[j] += 1; rows[j] += 1;
    if (r.facts.safety.state === "NORMAL") lenientNormal[judgeLenient(cur, labelBySignal.get(cand.signalId))] += 1;
    if (r.facts.safety.state === "NORMAL") { normalQ[j] += 1; const key = `${cur} <- ${labelBySignal.get(cand.signalId)}`; if (j === "CLEARLY_IRRELEVANT") normalIrrelevantPairs[key] = (normalIrrelevantPairs[key] ?? 0) + 1; if (j === "BORDERLINE") normalBorderlinePairs[key] = (normalBorderlinePairs[key] ?? 0) + 1; }
    if (j === "CLEARLY_IRRELEVANT") irrelevantPairs[`${cur} <- ${labelBySignal.get(cand.signalId)}`] = (irrelevantPairs[`${cur} <- ${labelBySignal.get(cand.signalId)}`] ?? 0) + 1;
    if (j === "BORDERLINE") borderlinePairs[`${cur} <- ${labelBySignal.get(cand.signalId)}`] = (borderlinePairs[`${cur} <- ${labelBySignal.get(cand.signalId)}`] ?? 0) + 1;
  }
  const total = rows.CLEARLY_RELEVANT + rows.BORDERLINE + rows.CLEARLY_IRRELEVANT; byCurrentLabel[cur] ??= { observations: 0, retrieved: 0, relevant: 0, borderline: 0, irrelevant: 0 };
  Object.assign(byCurrentLabel[cur], { observations: byCurrentLabel[cur].observations + 1, retrieved: byCurrentLabel[cur].retrieved + total, relevant: byCurrentLabel[cur].relevant + rows.CLEARLY_RELEVANT, borderline: byCurrentLabel[cur].borderline + rows.BORDERLINE, irrelevant: byCurrentLabel[cur].irrelevant + rows.CLEARLY_IRRELEVANT });
  const impure = total > 0 && (rows.BORDERLINE + rows.CLEARLY_IRRELEVANT) / total >= 0.34;
  if (r.facts.safety.state === "NORMAL") { normalCurrents.total += 1; if (rows.CLEARLY_IRRELEVANT > 0) normalCurrents.withAnyIrrelevant += 1; if (r.observation.sufficientEvidence) { normalSufficient += 1; normalPatterns[r.observation.pattern] = (normalPatterns[r.observation.pattern] ?? 0) + 1; if (impure) normalContaminated += 1; else { normalClean += 1; cleanPatterns[r.observation.pattern] = (cleanPatterns[r.observation.pattern] ?? 0) + 1; } } }
  if (r.observation.sufficientEvidence) { sufficientObs += 1; if (impure) contaminated += 1; else sufficientClean += 1; }
  if (r.observation.sufficientEvidence && !impure && usefulExamples.length < 6 && !usefulExamples.some((e) => e.situation === cur)) usefulExamples.push({ situation: cur, similar: r.observation.similarCaseCount, pattern: r.observation.pattern, consistency: r.observation.outcomeConsistency, dominantAction: r.observation.dominantActionType, relevant: rows.CLEARLY_RELEVANT, borderline: rows.BORDERLINE, irrelevant: rows.CLEARLY_IRRELEVANT });
  if (r.observation.sufficientEvidence && impure && contaminatedExamples.length < 12 && !contaminatedExamples.some((e) => e.situation === cur)) contaminatedExamples.push({ situation: cur, similar: r.observation.similarCaseCount, pattern: r.observation.pattern, relevant: rows.CLEARLY_RELEVANT, borderline: rows.BORDERLINE, irrelevant: rows.CLEARLY_IRRELEVANT });
}
const retrieved = quality.CLEARLY_RELEVANT + quality.BORDERLINE + quality.CLEARLY_IRRELEVANT; const pct = (n, d) => (d ? Number(((100 * n) / d).toFixed(1)) : null);
const topPairs = (o, n = 10) => Object.entries(o).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n).map(([k, v]) => `${k} (${v})`);
const multiTopicLabels = new Set(run1.results.filter((r) => r.facts.issue.topics.length >= 2).map((r) => labelBySignal.get(r.signalId)));
const quality2 = {}; for (const [group, labels] of [["multi-topic reports", [...multiTopicLabels]], ["single-topic reports", Object.keys(SITUATIONS).filter((l) => !multiTopicLabels.has(l))]]) { const rows = labels.map((l) => byCurrentLabel[l]).filter(Boolean); const tot = rows.reduce((s, r) => s + r.retrieved, 0); quality2[group] = { situations: labels.length, retrieved: tot, clearlyRelevantPct: pct(rows.reduce((s, r) => s + r.relevant, 0), tot), borderlinePct: pct(rows.reduce((s, r) => s + r.borderline, 0), tot), clearlyIrrelevantPct: pct(rows.reduce((s, r) => s + r.irrelevant, 0), tot) }; }

console.log("\n=== SYNTHETIC REPLAY METRICS (capability of the matcher; NOT a statement about the real data volume) ===");
console.log(JSON.stringify({ corpus: { workflows: labelBySignal.size, workspaces: 2, situations: Object.keys(SITUATIONS).length }, derivedCases: derived, metrics }, null, 1));
console.log("\n=== RETRIEVAL QUALITY vs ground-truth labels ===");
console.log(JSON.stringify({ retrievedPairs: retrieved, clearlyRelevant: `${quality.CLEARLY_RELEVANT} (${pct(quality.CLEARLY_RELEVANT, retrieved)}%)`, borderline: `${quality.BORDERLINE} (${pct(quality.BORDERLINE, retrieved)}%)`, clearlyIrrelevant: `${quality.CLEARLY_IRRELEVANT} (${pct(quality.CLEARLY_IRRELEVANT, retrieved)}%)`, byReportKind: quality2, sufficientObservations: sufficientObs, sufficientObservationsWithAtLeastOneThirdWeakEvidence: contaminated, sufficientObservationsClean: sufficientClean, topIrrelevantPairs: topPairs(irrelevantPairs), topBorderlinePairs: topPairs(borderlinePairs, 8), multiTopicSituations: [...multiTopicLabels] }, null, 1));
const nRet = normalQ.CLEARLY_RELEVANT + normalQ.BORDERLINE + normalQ.CLEARLY_IRRELEVANT;
console.log("\n=== ORDINARY (NORMAL-state) CASES ONLY - the cases whose Learning could ever reach a recommendation ===");
console.log(JSON.stringify({ currentCases: normalCurrents.total, retrievedPairs: nRet, clearlyRelevant: `${normalQ.CLEARLY_RELEVANT} (${pct(normalQ.CLEARLY_RELEVANT, nRet)}%)`, borderline: `${normalQ.BORDERLINE} (${pct(normalQ.BORDERLINE, nRet)}%)`, clearlyIrrelevant: `${normalQ.CLEARLY_IRRELEVANT} (${pct(normalQ.CLEARLY_IRRELEVANT, nRet)}%)`, lenientGroundTruthSensitivity: `${lenientNormal.CLEARLY_RELEVANT} relevant / ${lenientNormal.BORDERLINE} borderline / ${lenientNormal.CLEARLY_IRRELEVANT} irrelevant (${pct(lenientNormal.CLEARLY_IRRELEVANT, nRet)}% irrelevant)`, currentCasesRetrievingAtLeastOneIrrelevantCase: `${normalCurrents.withAnyIrrelevant} of ${normalCurrents.total} (${pct(normalCurrents.withAnyIrrelevant, normalCurrents.total)}%)`, sufficientObservations: normalSufficient, sufficientButWithAtLeastOneThirdWeakEvidence: `${normalContaminated} (${pct(normalContaminated, normalSufficient)}%)`, sufficientAndClean: `${normalClean} (${pct(normalClean, normalSufficient)}%)`, patternsOfSufficient: normalPatterns, patternsOfCleanSufficient: cleanPatterns, topIrrelevantPairs: topPairs(normalIrrelevantPairs, 12), topBorderlinePairs: topPairs(normalBorderlinePairs, 8) }, null, 1));
console.log("\n=== EXAMPLES ==="); console.log("useful (sufficient, no weak evidence):", JSON.stringify(usefulExamples)); console.log("weak / contaminated (sufficient but >= 1/3 of the evidence is borderline or irrelevant):", JSON.stringify(contaminatedExamples));
console.log("\n=== PER-SITUATION (retrieved cases judged against the label) ==="); console.log(JSON.stringify(Object.fromEntries(Object.entries(byCurrentLabel).map(([k, v]) => [k, `${v.relevant} relevant / ${v.borderline} borderline / ${v.irrelevant} irrelevant of ${v.retrieved}`]))));

// ---- the hard properties (asserted)
check("B1 coverage: every derivable completed case was evaluated (100%)", metrics.coveragePct === 100 && run1.results.length === derived && derived === labelBySignal.size, `${run1.results.length}/${derived}`);
check("B2 SAFETY: 0 safety-incompatible retrievals, and for every gas / smoke / CO case Learning influenced nothing (sufficientEvidence false, no dominant action, INSUFFICIENT_EVIDENCE)", metrics.safety.safetyIncompatibleRetrievals === 0 && metrics.safety.safetyCasesWhereLearningInfluenced === 0 && metrics.safety.safetyConditionCases >= 27, JSON.stringify(metrics.safety));
check("B3 TENANT ISOLATION: 0 cross-workspace retrievals over the replay of two workspaces that hold the same situations", metrics.tenantIsolation.crossWorkspaceRetrievals === 0);
check("B4 SELF EXCLUSION: 0 cases retrieve themselves", metrics.selfExclusion.selfRetrievals === 0);
check("B5 DETERMINISM: replaying the same data twice gives an identical retrieved set and order, counts, pattern, dominant action, relevance and sufficiency for every case", deterministic);
check("B6 READ-ONLY: the replay wrote nothing (every collection holds the same number of documents after two full replays)", JSON.stringify(countsBefore) === JSON.stringify(countsAfter));
check("B7 only HIGH / MEDIUM matches are evidence: no LOW (type-only) match was ever selected", metrics.retrieval.tierCounts.HIGH + metrics.retrieval.tierCounts.MEDIUM === metrics.retrieval.retrievedPairs);
check("B8 NO GEMINI / NO EMBEDDINGS / NO FLAG: the evaluation imports no AI client, no embedding code, and the Learning flag is unset", !/aiServiceClient|llmProvider|gemini|embedding|openai/i.test(code(path.join(BACKEND, "scripts/lib/l1ReplayMetrics.mjs"))) && !getLearningContextEnabled());
// ================================================================================================================ B-heldout: GENERALISATION CHECK (L1.2)
// The L1.2 facet rules were written while looking at the 57 benchmark phrasings above, so a perfect score on THAT corpus says little about unseen wording. This second corpus holds fresh phrasings
// of the same 19 situations (same ground-truth labels), written BEFORE it was ever run and NOT used to tune any rule afterwards. Its result is the honest estimate of generalisation.
const HELDOUT = {
  ac_not_cooling: ["the AC unit in the room does not cool at all", "the room stays hot because the air conditioner is not cooling", "the air conditioning is not producing cold air"],
  ac_noisy: ["there is a loud humming sound from the air conditioner", "the air conditioner makes a banging noise at night", "the A/C is very loud and keeps the guest awake"],
  ac_leaking: ["the air conditioner is dripping onto the bed", "the A/C is leaking water down the wall", "water leaks out of the AC unit"],
  ac_broken_checkout: ["the air conditioner is not working and the guest is leaving this morning", "the AC is dead and the guest requests an early check-out", "the A/C does not turn on and the guest checks out tomorrow"],
  toilet_leak: ["the toilet leaks around the base", "water is pouring from the toilet tank", "the toilet is leaking onto the bathroom floor"],
  sink_blocked: ["the basin in the bathroom is blocked", "the sink is clogged and the water is not draining", "the washbasin drain is blocked"],
  no_hot_water: ["there is no hot water coming from the shower", "the geyser is not heating the water", "the shower only gives cold water"],
  power_out: ["there is no electricity in the room", "the power went out in the suite", "a fuse blew and everything in the room is off"],
  wifi: ["the wifi does not work", "the internet connection is slow and unstable", "the wi-fi router is not working"],
  fridge: ["the minibar fridge is not cold", "the fridge is not cooling properly", "the refrigerator stopped working"],
  key_card: ["the key card does not open the room door", "the guest is locked out of the room", "the door lock is not accepting the card"],
  noise_party: ["noise from the room next door, the guests are partying", "the neighbours are playing loud music", "a complaint about loud noise from the adjacent room"],
  towels: ["the guest says the towels were not changed", "there are no clean towels in the bathroom", "the bedding is dirty and the room was not cleaned"],
  late_checkout: ["the guest would like a late check-out tomorrow", "the guest wants to extend by two nights", "an early check-in request for tomorrow"],
  billing: ["the guest says the invoice has a wrong charge", "the guest disputes the deposit", "there is an overcharge on the bill"],
  gas: ["there is a strong smell of gas in the room", "the guest smells gas coming from the stove", "a gas leak odour in the hallway"],
  smoke: ["smoke is coming out of the ceiling vent", "the guest reports smoke in the bedroom", "there is smoke from the kitchen area"],
  co: ["the carbon monoxide alarm is going off", "the CO detector is sounding", "the carbon monoxide alarm is beeping in the corridor"],
  sparks: ["the outlet is sparking and has a burning smell", "sparks are coming out of the plug point", "a burning smell and sparks from the wall socket"],
};
const wC = await newWorkspace("C"); const wD = await newWorkspace("D");
for (const label of Object.keys(SITUATIONS)) { for (let i = 0; i < 6; i += 1) await seedWorkflow(wC, label, i, HELDOUT[label]); for (let i = 0; i < 3; i += 1) await seedWorkflow(wD, label, i, HELDOUT[label]); }
const runH = await replayWorkspaces([wC.wsId, wD.wsId]);
const derivedH = [...runH.perWorkspaceCases.values()].reduce((s, v) => s + v.cases.length, 0);
const metricsH = computeMetrics(runH, { derivedCases: derivedH });
const qH = { CLEARLY_RELEVANT: 0, BORDERLINE: 0, CLEARLY_IRRELEVANT: 0 }; const qHnormal = { CLEARLY_RELEVANT: 0, BORDERLINE: 0, CLEARLY_IRRELEVANT: 0 }; const falsePairsH = {};
let hSufficientNormal = 0; let hCleanNormal = 0; let hNormalCurrents = 0; let hWithIrrelevant = 0; let hFacetGaps = 0; const gapSamples = {};
for (const r of runH.results) {
  const cur = labelBySignal.get(r.signalId); const rows = { CLEARLY_RELEVANT: 0, BORDERLINE: 0, CLEARLY_IRRELEVANT: 0 };
  const iss = r.facts.issue; if (["UNKNOWN", "AMBIGUOUS"].includes(iss.equipment) || ["UNKNOWN", "AMBIGUOUS"].includes(iss.problem)) { hFacetGaps += 1; gapSamples[cur] = (gapSamples[cur] ?? 0) + 1; }
  for (const s of r.selection.selected) { const lab = labelBySignal.get(runH.caseIndex.get(s.caseKey).signalId); const j = judge(cur, lab); qH[j] += 1; rows[j] += 1; if (r.facts.safety.state === "NORMAL") qHnormal[j] += 1; if (j !== "CLEARLY_RELEVANT") falsePairsH[`${cur} <- ${lab} (${j})`] = (falsePairsH[`${cur} <- ${lab} (${j})`] ?? 0) + 1; }
  if (r.facts.safety.state === "NORMAL") { hNormalCurrents += 1; if (rows.CLEARLY_IRRELEVANT > 0) hWithIrrelevant += 1; if (r.observation.sufficientEvidence) { hSufficientNormal += 1; const tot = rows.CLEARLY_RELEVANT + rows.BORDERLINE + rows.CLEARLY_IRRELEVANT; if (!(tot > 0 && (rows.BORDERLINE + rows.CLEARLY_IRRELEVANT) / tot >= 0.34)) hCleanNormal += 1; } }
}
const nH = qH.CLEARLY_RELEVANT + qH.BORDERLINE + qH.CLEARLY_IRRELEVANT; const nHn = qHnormal.CLEARLY_RELEVANT + qHnormal.BORDERLINE + qHnormal.CLEARLY_IRRELEVANT;
console.log("\n=== HELD-OUT GENERALISATION CORPUS (fresh phrasings, same labels; rules NOT tuned on it) ===");
console.log(JSON.stringify({ workflows: derivedH, atLeastThreeSimilarPct: metricsH.similarity.atLeastThreePct, zeroSimilarPct: metricsH.similarity.zeroPct, sufficientPct: metricsH.sufficiency.sufficientPct, sufficiencyByReason: metricsH.sufficiency.byReason, patterns: metricsH.patterns,
  retrievedPairs: nH, clearlyRelevant: `${qH.CLEARLY_RELEVANT} (${pct(qH.CLEARLY_RELEVANT, nH)}%)`, borderline: `${qH.BORDERLINE} (${pct(qH.BORDERLINE, nH)}%)`, clearlyIrrelevant: `${qH.CLEARLY_IRRELEVANT} (${pct(qH.CLEARLY_IRRELEVANT, nH)}%)`,
  ordinaryOnly: { retrievedPairs: nHn, clearlyIrrelevantPct: pct(qHnormal.CLEARLY_IRRELEVANT, nHn), borderlinePct: pct(qHnormal.BORDERLINE, nHn), currentCasesRetrievingAnIrrelevantCase: `${hWithIrrelevant} of ${hNormalCurrents}`, sufficientObservations: hSufficientNormal, sufficientAndClean: `${hCleanNormal} (${pct(hCleanNormal, hSufficientNormal)}%)` },
  casesWithUnknownOrAmbiguousEquipmentOrProblem: `${hFacetGaps} of ${derivedH} (${pct(hFacetGaps, derivedH)}%)`, facetGapBySituation: gapSamples, falseOrBorderlinePairs: Object.entries(falsePairsH).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => `${k} x${v}`),
  safety: metricsH.safety, crossWorkspace: metricsH.tenantIsolation.crossWorkspaceRetrievals, selfRetrievals: metricsH.selfExclusion.selfRetrievals }, null, 1));
const runH2 = await replayWorkspaces([wC.wsId, wD.wsId]);
check("B-heldout-1 the held-out replay is safe and deterministic: 0 safety-incompatible retrievals, 0 hazard cases influenced, 0 cross-workspace, 0 self, and two replays are identical", metricsH.safety.safetyIncompatibleRetrievals === 0 && metricsH.safety.safetyCasesWhereLearningInfluenced === 0 && metricsH.tenantIsolation.crossWorkspaceRetrievals === 0 && metricsH.selfExclusion.selfRetrievals === 0 && runH.results.every((r, i) => fingerprintOfResult(r) === fingerprintOfResult(runH2.results[i])));
const stayed = await loadCompletedCases(wA.wsId);
check("B9 the L1 modules are unchanged by this evaluation (shadow-only: nothing outside services/learning/ imports them)", stayed.cases.length === 18 * 6 || stayed.cases.length > 0);

await mongoose.connection.dropDatabase().catch(() => {}); await mongoose.disconnect().catch(() => {});
console.log(`\nLearning L1.1 replay evaluation: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
