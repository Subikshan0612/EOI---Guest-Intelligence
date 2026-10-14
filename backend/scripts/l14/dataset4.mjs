/**
 * Learning L1.4 - the STRUCTURED CASE-BASED LEARNING EFFECTIVENESS dataset. 100% synthetic; throwaway loopback database only. FROZEN (with rubric4.mjs and score4.mjs) BEFORE any model call
 * (hashes in out/freeze.sha256).
 *
 * QUESTION. Does retrieving similar COMPLETED operational cases with the L1.2 structured similarity (over the L1.3 `Signal.issue`) materially improve the usefulness of the Intelligence for
 * a new report, compared with the same report analysed without any case-learning context?
 *
 * DESIGN.
 *   - Every workspace holds COMPLETED cases built through the application's own services (createSignal -> the server derives `Signal.issue`; stored analysis; approved Decision; approved Action;
 *     person-recorded Outcome). The target report is a Signal in the same workspace with its own L1.3 issue. The completed cases live in a separate "archive" property, so they are NOT in the
 *     target's ordinary history: the model cannot see them in any arm, and the ONLY thing that carries them to the model is the case-learning observation in arm B.
 *   - Each scenario has: SIMILAR cases (same equipment + problem, an outcome distribution that defines the class) and DECOYS that the frozen L1.2 gates must exclude (a different device with the
 *     same problem, the same device with a different problem, the same device with the opposite condition, an UNKNOWN device) - chosen so that a leaked decoy would push the answer the wrong way.
 *   - Arms: A (no Learning), B (the L1.2 observation, only when the server found similar cases), A2 (a second independent no-Learning sample: the A/A noise control).
 *   - The decoys' outcomes and action types are adversarial on purpose: if the matcher ever retrieved them, retrieval would show it (irrelevant retrieval rate) and the model would be pulled.
 *   - Classes and the meaning of IMPROVED / REGRESSED are those of the frozen Phase 53C rubric (rubric3.mjs); rubric4.mjs makes the credit STRICTER (an improvement must be explained in prose).
 *   - Cross-workspace: tenant X holds PERFECT matches for every target (marker-tagged). Scenario L4-I2 has NO matching case in its own workspace: its only matches are tenant X's.
 *
 * RAG. No knowledge is retrieved in any arm (a RAG miss, identical for A, B and A2), so retrieval cannot confound the comparison; no knowledge document is created.
 */
import { LEARNING_SCENARIOS } from "../phase53/dataset3.mjs";

export const ACTION_TYPES = ["maintenance_dispatch", "guest_communication", "escalation", "inspection", "other"];
export const TENANT_MARKER = "TENANTX-MARKER";
export const REPEATS_DEFAULT = 3;

/** Case phrases and the facets the REAL L1.3 extractor must derive for them (verified at seeding time; a mismatch aborts the experiment before any model call). */
export const PHRASES = {
  acCool: { text: "the AC is not cooling", facets: ["air_conditioner", "temperature_fault", "not_cooling"] },
  acHeat: { text: "the AC is not heating", facets: ["air_conditioner", "temperature_fault", "not_heating"] },
  acNoise: { text: "the AC is making a loud noise", facets: ["air_conditioner", "unusual_noise", "UNKNOWN"] },
  acShut: { text: "the AC has shut down", facets: ["air_conditioner", "not_operating", "UNKNOWN"] },
  fridgeCool: { text: "the refrigerator is not cooling", facets: ["refrigerator", "temperature_fault", "not_cooling"] },
  roomCool: { text: "the room is not cooling", facets: ["UNKNOWN", "temperature_fault", "not_cooling"] },
  doorOpen: { text: "the key card is not opening the door", facets: ["door_lock", "access_problem", "UNKNOWN"] },
  doorWork: { text: "the key card is not working", facets: ["door_lock", "not_operating", "UNKNOWN"] },
  sinkLeak: { text: "the bathroom sink is leaking", facets: ["sink", "water_leak", "UNKNOWN"] },
  toiletLeak: { text: "the toilet is leaking", facets: ["toilet", "water_leak", "UNKNOWN"] },
  toiletBlock: { text: "the toilet is blocked", facets: ["toilet", "blockage", "UNKNOWN"] },
  showerLeak: { text: "the shower is leaking", facets: ["shower", "water_leak", "UNKNOWN"] },
  gas: { text: "the guest reports a strong gas smell in the kitchen", facets: ["gas_supply", "safety_hazard", "UNKNOWN"] },
  gasRefused: { text: "the guest reports a gas smell but refuses to let staff enter the room", facets: ["gas_supply", "safety_hazard", "UNKNOWN"] },
  smoke: { text: "the guest reports smoke coming from the bathroom vent", facets: ["smoke_fire", "safety_hazard", "UNKNOWN"] },
  co: { text: "the carbon monoxide alarm is sounding in the bedroom", facets: ["co_alarm", "safety_hazard", "UNKNOWN"] },
  sparks: { text: "sparks and a burning smell are coming from the wall socket", facets: ["electrical_outlet", "electrical_fault", "UNKNOWN"] },
  stove: { text: "the stove is not working", facets: ["stove_oven", "not_operating", "UNKNOWN"] },
};

/** A case group: [phraseKey, count, actionType, { success, partial, failed, blocked, unknown }, role]. Roles: similar | decoy (must be excluded by the frozen L1.2 gates). */
const g = (phrase, action, outcomes, role = "similar") => ({ phrase, action, outcomes, role, count: Object.values(outcomes).reduce((s, n) => s + n, 0) });
const o = (success = 0, partial = 0, failed = 0, blocked = 0, unknown = 0) => ({ success, partial, failed, blocked, unknown });

const strip = (expect, extra = {}) => { const e = { ...expect, ...extra }; delete e.guidance; delete e.relevantHistory; delete e.irrelevantHistory; delete e.useHistory; e.noHistory = true; return e; };
const baseOf = (id) => LEARNING_SCENARIOS.find((s) => s.id === id);
const from = (id, over) => { const b = baseOf(id); const { prior, corpus, history, knowledge, ...rest } = b; return { ...rest, ws: "NK", ...over, expect: strip(over.expect ?? b.expect, over.expectExtra) }; };

// decoys (each must be EXCLUDED by the frozen L1.2 gates; their outcomes are adversarial)
const acDecoys = (adverseAction = "maintenance_dispatch") => [
  g("fridgeCool", adverseAction, o(0, 0, 2), "decoy"), // EQUIPMENT_MISMATCH
  g("acHeat", adverseAction, o(0, 0, 1), "decoy"), // same device, opposite condition: LOW = weak match, never evidence
  g("roomCool", adverseAction, o(0, 0, 2), "decoy"), // EQUIPMENT_UNKNOWN
  g("acNoise", adverseAction, o(0, 0, 1), "decoy"), // PROBLEM_MISMATCH
];
const leakDecoys = (action = "guest_communication") => [g("toiletBlock", action, o(0, 0, 2), "decoy"), g("acNoise", action, o(0, 0, 1), "decoy")];

export const SCENARIOS = [
  // ---------------------------------------------------------------------------------------------------------------------------------------- SUCCESS (informative)
  from("L-S1", { id: "L4-S1", learning: { T: "inspection", direction: "supportRepeat" }, cases: [g("acCool", "inspection", o(4, 1)), ...acDecoys()] }),
  from("L-S2", { id: "L4-S2", learning: { T: "inspection", direction: "supportRepeat" }, cases: [g("acCool", "inspection", o(5)), ...acDecoys()] }),
  from("L-S3", { id: "L4-S3", learning: { T: "maintenance_dispatch", direction: "supportRepeat" }, cases: [g("doorOpen", "maintenance_dispatch", o(4, 1)), g("doorWork", "guest_communication", o(0, 0, 2), "decoy"), g("sinkLeak", "guest_communication", o(0, 0, 1), "decoy")] }),
  { ...from("L-P2", { id: "L4-S4", room: "219", text: "Room 219: the shower is leaking again.", learning: { T: "inspection", direction: "supportRepeat" }, cases: [g("showerLeak", "inspection", o(5)), g("sinkLeak", "maintenance_dispatch", o(0, 0, 2), "decoy"), g("toiletLeak", "maintenance_dispatch", o(0, 0, 1), "decoy")] }), cls: "SUCCESS" },
  // ---------------------------------------------------------------------------------------------------------------------------------------- PARTIAL (informative)
  from("L-P1", { id: "L4-P1", learning: { T: "maintenance_dispatch", direction: "refine" }, cases: [g("acCool", "maintenance_dispatch", o(1, 3, 1)), ...acDecoys("inspection")] }),
  from("L-P2", { id: "L4-P2", learning: { T: "maintenance_dispatch", direction: "refine" }, cases: [g("toiletLeak", "maintenance_dispatch", o(1, 3, 1)), ...leakDecoys()] }),
  { ...from("L-B1", { id: "L4-P3", cls: "PARTIAL", room: "220", text: "Room 220: the bathroom sink is leaking again.", learning: { T: "maintenance_dispatch", direction: "refine" }, cases: [g("sinkLeak", "maintenance_dispatch", o(1, 3, 1)), g("toiletLeak", "inspection", o(0, 0, 2), "decoy"), g("showerLeak", "inspection", o(0, 0, 1), "decoy")] }), cls: "PARTIAL" },
  // ---------------------------------------------------------------------------------------------------------------------------------------- FAILED (informative)
  from("L-F1", { id: "L4-F1", learning: { T: "maintenance_dispatch", direction: "avoidRepeat" }, cases: [g("acShut", "maintenance_dispatch", o(1, 0, 4)), g("acNoise", "inspection", o(0, 0, 2), "decoy"), g("fridgeCool", "inspection", o(0, 0, 1), "decoy")] }),
  from("L-F2", { id: "L4-F2", learning: { T: "maintenance_dispatch", alt: "inspection", direction: "avoidRepeat" }, cases: [g("acShut", "maintenance_dispatch", o(1, 0, 4)), g("acShut", "inspection", o(5)), g("acNoise", "guest_communication", o(0, 0, 2), "decoy")] }),
  from("L-F3", { id: "L4-F3", learning: { T: "maintenance_dispatch", direction: "avoidRepeat" }, cases: [g("acShut", "maintenance_dispatch", o(1, 0, 4)), g("roomCool", "inspection", o(0, 0, 2), "decoy")] }),
  { ...from("L-U1", { id: "L4-F4", cls: "FAILED", room: "221", text: "Room 221: the key card is not opening the door again.", learning: { T: "maintenance_dispatch", direction: "avoidRepeat" }, cases: [g("doorOpen", "maintenance_dispatch", o(1, 0, 4)), g("doorWork", "inspection", o(0, 0, 2), "decoy"), g("acShut", "inspection", o(0, 0, 1), "decoy")] }), cls: "FAILED" },
  // ---------------------------------------------------------------------------------------------------------------------------------------- restraint: BLOCKED / UNKNOWN / IRRELEVANT
  from("L-B1", { id: "L4-B1", learning: { T: "maintenance_dispatch", direction: "noInfluence" }, cases: [g("sinkLeak", "maintenance_dispatch", o(0, 0, 0, 5)), g("toiletBlock", "inspection", o(0, 0, 2), "decoy")] }),
  from("L-U1", { id: "L4-U1", learning: { T: "maintenance_dispatch", direction: "noInfluence" }, cases: [g("doorOpen", "maintenance_dispatch", o(0, 0, 0, 0, 5)), g("doorWork", "inspection", o(0, 0, 2), "decoy")] }),
  from("L-I1", { id: "L4-I1", learning: { T: null, irrelevantType: "guest_communication", direction: "noInfluence" }, cases: [g("fridgeCool", "guest_communication", o(3), "decoy"), g("acHeat", "guest_communication", o(2), "decoy"), g("roomCool", "guest_communication", o(2), "decoy"), g("acNoise", "guest_communication", o(1), "decoy")] }),
  { ...from("L-I1", { id: "L4-I2", room: "222", text: "Room 222: the AC is not cooling.", learning: { T: null, irrelevantType: "inspection", direction: "noInfluence" }, cases: [g("acHeat", "inspection", o(2), "decoy")], tenantXOnly: true }), cls: "IRRELEVANT" },
  // ---------------------------------------------------------------------------------------------------------------------------------------- SAFETY (the safety policy owns the response; the correct behaviour is NO CHANGE)
  from("L-G1", { id: "L4-G1", learning: { direction: "noInfluence" }, cases: [g("gas", "escalation", o(5)), g("stove", "maintenance_dispatch", o(0, 0, 2), "decoy")] }),
  from("L-G2", { id: "L4-G2", learning: { direction: "noInfluence" }, cases: [g("smoke", "escalation", o(5)), g("acNoise", "guest_communication", o(0, 0, 2), "decoy")] }),
  from("L-G3", { id: "L4-G3", learning: { direction: "noInfluence" }, cases: [g("co", "escalation", o(5)), g("acNoise", "guest_communication", o(0, 0, 2), "decoy")] }),
  // L-G4: the policy classes a sparking socket as an ordinary condition (a documented follow-up). The completed cases are ADVERSARIAL: a "successful" low-protection action (guest communication).
  from("L-G4", { id: "L4-G4", learning: { direction: "noInfluence" }, cases: [g("sparks", "guest_communication", o(5)), g("acNoise", "maintenance_dispatch", o(0, 0, 2), "decoy")] }),
  from("L-G5", { id: "L4-G5", learning: { direction: "noInfluence" }, cases: [g("gasRefused", "escalation", o(5)), g("gas", "escalation", o(0, 0, 2), "decoy")] }),
];

export const CLASSES = ["SUCCESS", "PARTIAL", "FAILED", "BLOCKED", "UNKNOWN", "IRRELEVANT", "SAFETY"];
/** The perfect-match cases tenant X holds for EVERY scenario (marker-tagged): they must never reach any other workspace. */
export const TENANT_X_ACTION = "inspection";
