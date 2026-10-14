/**
 * Learning L1.4 - shared experiment library (seeding, retrieval audit, observation -> existing `learning-v1` mapping). NO model call, NO production source change.
 * Everything runs against a THROWAWAY loopback database through the application's own services; callers must have set process.env.MONGODB_URI to a loopback URI BEFORE calling loadStack().
 */
import { ACTION_TYPES, PHRASES, SCENARIOS, TENANT_MARKER, TENANT_X_ACTION } from "./dataset4.mjs";

export async function loadStack() {
  const mongoose = (await import("mongoose")).default;
  const { connectDatabase } = await import("../../src/config/database.js");
  const M = await import("../../src/models/index.js");
  const stack = {
    mongoose, M, connectDatabase,
    createSignal: (await import("../../src/services/signalService.js")).createSignal,
    createAnalysisIntelligence: (await import("../../src/services/intelligenceService.js")).createAnalysisIntelligence,
    ...(await import("../../src/services/decisionService.js")),
    ...(await import("../../src/services/actionService.js")),
    recordOutcome: (await import("../../src/services/outcomeService.js")).recordOutcome,
    deriveSafetyPolicy: (await import("../../src/services/ai/safetyPolicy.js")).deriveSafetyPolicy,
    loadCompletedCases: (await import("../../src/services/learning/completedCaseService.js")).loadCompletedCases,
    deriveShadowLearningObservation: (await import("../../src/services/learning/caseLearningShadow.js")).deriveShadowLearningObservation,
    validateLearningPayload: (await import("../../src/services/learningContextContract.js")).validateLearningPayload,
    buildOperationalContext: (await import("../../src/services/operationalContextService.js")).buildOperationalContext,
  };
  await connectDatabase();
  return stack;
}

const oid = (S) => new S.mongoose.Types.ObjectId();
const dayStart = (offsetDays) => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() + offsetDays); return d; };
export const phraseKeyOfFacets = (f) => Object.keys(PHRASES).find((k) => PHRASES[k].facets.join("/") === f.join("/")) ?? null;
const facetsOf = (issue) => [issue?.equipment, issue?.problemFamily, issue?.condition];

/** ONE completed workflow through the application's own services. Returns the Signal id and the Outcome id. */
async function completedCase(S, w, { text, action, outcome, who }) {
  const sig = await S.createSignal({ workspaceId: w.wsId, propertyId: String(w.annexProp._id), unitId: String(w.annexUnit._id), type: "maintenance", source: "staff", severity: "medium", title: text, description: text });
  const policy = S.deriveSafetyPolicy({ signal: { title: sig.title, description: sig.description, severity: sig.severity } });
  const hazard = policy.state === "LIFE_SAFETY_HAZARD";
  const intel = (await S.createAnalysisIntelligence({ workspaceId: w.ws._id, signal: { id: sig._id, title: sig.title, type: sig.type, severity: sig.severity }, propertyId: w.annexProp._id, level: "staff",
    analysis: { situation: "Synthetic archived situation.", evidence: ["Synthetic archived evidence."], impact: "Synthetic archived impact.", recommendation: "A person could consider a synthetic archived step.", confidence: "medium" },
    provider: "test", model: "deterministic-stub", knowledgeProvenance: [],
    safety: { state: policy.state, urgency: hazard ? "immediate" : "prompt", recommendedActionType: hazard ? "escalation" : action } })).record;
  const dec = (await S.proposeDecision(String(intel._id), w.wsId, {}, { authorizedLevel: "staff", actorUserId: who.actor })).record;
  await S.approveDecision(String(dec._id), w.wsId, {}, { authorizedLevel: "staff", actorUserId: who.reviewer });
  const act = (await S.proposeAction(String(dec._id), w.wsId, {}, { authorizedLevel: "staff", actorUserId: who.actor })).record;
  await S.approveAction(String(act._id), w.wsId, { note: "Approved." }, { authorizedLevel: "staff", actorUserId: who.reviewer });
  const out = await S.recordOutcome(String(act._id), w.wsId, { status: outcome, result: { summary: `Synthetic ${outcome} outcome.` } }, { actorUserId: who.actor, authorizedLevel: "staff" });
  return { signalId: String(sig._id), outcomeId: String(out._id), actionType: act.actionType, issue: sig.issue };
}

async function workspace(S, label, slugTail) {
  const ws = await S.M.Workspace.create({ name: `L14 ${label}`, slug: `l14-${slugTail}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, status: "active" });
  const prop = await S.M.Property.create({ workspaceId: ws._id, name: `${label} Residence`, code: `L14${slugTail}`.slice(0, 12).toUpperCase(), timezone: "UTC" });
  const annexProp = await S.M.Property.create({ workspaceId: ws._id, name: `${label} Archive Annex`, code: `AN${slugTail}`.slice(0, 12).toUpperCase(), timezone: "UTC" });
  const annexUnit = await S.M.Unit.create({ propertyId: annexProp._id, unitNumber: "ARCHIVE", type: "apartment", status: "available" });
  return { ws, wsId: String(ws._id), prop, annexProp, annexUnit };
}

let personCounter = 0;
const FIRST = ["Zephyrine", "Ottoline", "Marisol", "Tobiah", "Linnaea", "Casimir", "Perdita", "Evander", "Sorrel", "Ignatius", "Wilhelmina", "Barnaby", "Cordelia", "Lysander", "Octavia", "Percival", "Rosalind", "Thaddeus", "Ursula", "Valentin"];
const LAST = ["Quillfeather", "Brackenridge", "Ashgrove", "Fennimore", "Hollowell", "Thistlewood", "Marchbanks", "Pennyworth", "Larkspur", "Wetherby", "Ravenscroft", "Dunmore", "Kettleby", "Whitlock", "Nightingale", "Foxcombe", "Greystoke", "Honeywell", "Ivorywood", "Juniper"];

/** Seeds tenant X (a SEPARATE workspace) with a perfect-match set for every distinct phrase the scenarios use, all marker-tagged. */
export async function seedTenantX(S, scenarios = SCENARIOS) {
  const who = { actor: oid(S), reviewer: oid(S) };
  const w = await workspace(S, "Tenant X", "X");
  const phrases = new Set(scenarios.map((sc) => (sc.cases.find((c) => c.role === "similar")?.phrase) ?? "acCool"));
  let n = 0; const made = [];
  for (const key of phrases) {
    const hazard = ["gas", "gasRefused", "smoke", "co"].includes(key);
    for (let i = 0; i < 5; i += 1) { n += 1; made.push(await completedCase(S, w, { text: `${TENANT_MARKER} Room X${n}: ${PHRASES[key].text}.`, action: hazard ? "escalation" : TENANT_X_ACTION, outcome: "success", who })); }
  }
  return { ...w, caseCount: made.length };
}

/** Seeds one scenario workspace: property + unit + guest + stay + the target Signal (L1.3 issue derived by the server) + the completed cases. */
export async function seedScenario(S, sc, idx) {
  const who = { actor: oid(S), reviewer: oid(S) };
  const w = await workspace(S, sc.id, `${sc.id.replace(/\W/g, "")}`);
  const unit = await S.M.Unit.create({ propertyId: w.prop._id, unitNumber: sc.room, type: "apartment", status: "occupied" });
  const first = FIRST[idx % FIRST.length]; const last = LAST[idx % LAST.length]; personCounter += 1;
  const guest = await S.M.Guest.create({ workspaceId: w.ws._id, firstName: first, lastName: last, email: `${first}.${last}.${personCounter}@pii-l14.invalid`.toLowerCase(), phone: `+91 555 ${String(personCounter).padStart(4, "0")}` });
  const stay = await S.M.Stay.create({ workspaceId: w.ws._id, guestId: guest._id, propertyId: w.prop._id, unitId: unit._id, status: "checked_in", checkIn: dayStart(-1), checkOut: dayStart(3) });
  const roles = new Map(); const seeded = []; let n = 0;
  for (const group of sc.cases) {
    if (sc.tenantXOnly && group.role === "similar") continue;
    for (const outcomeName of Object.keys(group.outcomes)) {
      for (let i = 0; i < group.outcomes[outcomeName]; i += 1) {
        n += 1;
        const text = `Room ${300 + n}: ${PHRASES[group.phrase].text}.`;
        const c = await completedCase(S, w, { text, action: group.action, outcome: outcomeName, who });
        const expected = PHRASES[group.phrase].facets; const got = facetsOf(c.issue);
        if (expected.join("/") !== got.join("/")) throw new Error(`facet mismatch for case phrase ${group.phrase}: expected ${expected.join("/")} got ${got.join("/")}`);
        roles.set(c.signalId, { role: group.role, phrase: group.phrase, action: group.action, outcome: outcomeName });
        seeded.push(c);
      }
    }
  }
  // the TARGET report: a Signal of its own, created through the same service (the server derives its issue)
  const target = await S.createSignal({ workspaceId: w.wsId, propertyId: String(w.prop._id), unitId: String(unit._id), guestId: String(guest._id), stayId: String(stay._id), type: "maintenance", source: "staff", severity: "medium", title: sc.text, description: sc.text });
  return { sc, ...w, unit, guest, stay, targetSignalId: String(target._id), targetIssue: target.issue, roles, seededCount: seeded.length, pii: [first, last, String(guest.email), String(guest.phone)] };
}

/** The server's own shadow derivation for the target, plus the retrieval audit against the dataset's ground-truth roles. */
export async function retrieval(S, seeded) {
  const { observation, selection, derivation } = await S.deriveShadowLearningObservation({ workspaceId: seeded.wsId, signalId: seeded.targetSignalId });
  const loaded = (await S.loadCompletedCases(seeded.wsId, { excludeSignalId: seeded.targetSignalId })).cases;
  const roleByKey = new Map(loaded.map((c) => [c.internal.caseKey, seeded.roles.get(c.internal.signalId) ?? { role: "UNKNOWN_TO_DATASET" }]));
  const selectedRoles = selection.selected.map((s) => roleByKey.get(s.caseKey) ?? { role: "UNKNOWN_TO_DATASET" });
  const similarSeeded = [...seeded.roles.values()].filter((r) => r.role === "similar").length;
  return {
    observation, selection, derivation,
    selectedCount: selection.selected.length, selectedSimilar: selectedRoles.filter((r) => r.role === "similar").length,
    irrelevantRetrieved: selectedRoles.filter((r) => r.role !== "similar").length, // any decoy / unknown-to-dataset case that was selected as evidence
    similarSeeded, similarMissed: Math.max(0, similarSeeded - selectedRoles.filter((r) => r.role === "similar").length),
    evaluated: selection.evaluated, excluded: selection.excluded, weakMatchCount: selection.weakMatchCount,
    safetyIncompatibleRetrieved: observation.safetyCondition === "NORMAL" ? selectedRoles.filter((r) => ["gas", "gasRefused", "smoke", "co"].includes(r.phrase)).length : selectedRoles.filter((r) => !["gas", "gasRefused", "smoke", "co"].includes(r.phrase)).length,
  };
}

/**
 * The ONLY transformation between the L1 observation and what the model may be shown: the EXISTING `learning-v1` shape (the AI service's closed contract). Counts come from the observation (selected
 * similar completed cases of THIS workspace); nothing else is added, and no text is written. `eligible` is true only when the observation itself says the evidence is sufficient. When the server found
 * NO similar case there is nothing to show and nothing is attached (the request is identical to arm A).
 * @returns {object|undefined} a payload accepted by validateLearningPayload, or undefined
 */
export function toLearningContext(observation) {
  if (!observation || observation.similarCaseCount === 0) return undefined;
  const rows = new Map(observation.actionPatterns.map((r) => [r.actionType, r]));
  const patterns = ACTION_TYPES.map((actionType) => {
    const r = rows.get(actionType); const oc = r?.outcomes ?? { success: 0, partial: 0, failed: 0 };
    const determined = oc.success + oc.partial + oc.failed;
    return { actionType, sampleSize: determined, successCount: oc.success, failedCount: oc.failed, partialCount: oc.partial, successRate: determined > 0 ? oc.success / determined : null, eligible: observation.sufficientEvidence === true && determined >= observation.minimumCases };
  });
  return { learningVersion: "learning-v1", minimumSampleSize: observation.minimumCases, windowDays: 90, patterns };
}

export { TENANT_MARKER };
