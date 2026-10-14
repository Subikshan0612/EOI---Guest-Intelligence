/**
 * Phase 53B.1 - evaluation DATASET v2. Re-exports the 30 Phase 53B scenarios UNCHANGED (their definitions are not edited, so the two runs are comparable), adds a small
 * LEARNING-SENSITIVE subset, and adds `distinctive` markers to the synthetic knowledge documents (used to recognise a distractor document without matching words the
 * documents legitimately share). 100% synthetic; throwaway evaluation database only. Learning stays OFF in this phase: the learning-sensitive scenarios are measured as
 * ordinary baseline scenarios, and nothing here scores Learning utilisation.
 *
 * Prior cases (the learning-sensitive subset) are seeded through the REAL human-mediated flow - a stored analysis, then Decision propose/approve, Action propose/approve and
 * Outcome record, each by an authenticated admin - so they are genuine records, never fabricated documents. Analyses are seeded at the operator's own visibility level
 * ("staff"), so the historical-analysis path is genuinely exercised (the Phase 53B fixture seeded them at "restricted", which an operator can never see).
 */
import { SCENARIOS as BASE_SCENARIOS, KNOWLEDGE_DOCS as BASE_DOCS, CATEGORY_NAMES as BASE_CATEGORIES, URGENCY_ORDER } from "./dataset.mjs";

export { URGENCY_ORDER };
const re = (source, flags = "i") => ({ source, flags });

const DISTINCTIVE = {
  AC: [re("(?:check|checking) whether the unit has power|has power"), re("recurring failures|further investigation")],
  PLUMBING: [re("shut-?off valve|affected fixture"), re("electrical fittings|another unit")],
  ACCESS: [re("replacement card|front desk|reprogram")],
  LINEN: [re("towel|linen")],
  POOL: [re("\\bpool\\b|\\bspa\\b|glass containers")],
};
export const KNOWLEDGE_DOCS = BASE_DOCS.map((d) => ({ ...d, distinctive: DISTINCTIVE[d.key] ?? d.concepts }));

export const ROUNDS_DEFAULT = 3;

const AC_PROBLEM = [re("air.?con|\\bAC\\b|cooling|HVAC|thermostat|temperature")];
const LEAK_PROBLEM = [re("leak|water|plumb|toilet|sink|shower|pipe|flood")];
const KEY_PROBLEM = [re("key ?card|card|lock|door|locked out|access")];
const ACTIONS_MAINT = ["maintenance_dispatch", "inspection", "guest_communication"];

/**
 * Learning-sensitive scenarios (workspace NK, no business knowledge). Each has PRIOR CASES for the same room and the same kind of problem, with a recorded human Outcome.
 * `learningHint` documents (for a later phase) what a Learning ON run could reasonably do better; it is metadata only and is never scored here.
 */
export const LEARNING_SENSITIVE = [
  { id: "LS1", cat: "L", ws: "NK", room: "181", learningSensitive: true, priorOutcome: "success",
    text: "Room 181: the AC is not cooling again.",
    history: [{ title: "Room 181: AC not cooling.", type: "maintenance", daysAgo: 21, relevant: true, analysis: { situation: "The AC in unit 181 was reported as not cooling.", recommendation: "A person could consider dispatching maintenance to inspect the AC unit." }, outcome: { status: "success", summary: "Technician reset the thermostat controller; cooling was restored within the hour." } }],
    learningHint: "the earlier technician visit worked: a repeat of that approach is supported by a recorded success",
    expect: { problem: AC_PROBLEM, urgency: { min: "routine", max: "prompt" }, actionTypes: ACTIONS_MAINT, relevantHistory: ["AC not cooling"], irrelevantHistory: [], useHistory: [re("recurr|repeat|again|previous|earlier|prior|before")] } },
  { id: "LS2", cat: "L", ws: "NK", room: "182", learningSensitive: true, priorOutcome: "partial",
    text: "Room 182: the AC is still not cooling properly.",
    history: [{ title: "Room 182: AC not cooling.", type: "maintenance", daysAgo: 14, relevant: true, analysis: { situation: "The AC in unit 182 was reported as not cooling.", recommendation: "A person could consider arranging an inspection of the AC unit." }, outcome: { status: "partial", summary: "Technician cleaned the filter; cooling improved but the room still did not reach the set temperature." } }],
    learningHint: "the earlier fix only partly worked: a stronger or different step is warranted",
    expect: { problem: AC_PROBLEM, urgency: { min: "routine", max: "prompt" }, actionTypes: ACTIONS_MAINT, relevantHistory: ["AC not cooling"], irrelevantHistory: [], useHistory: [re("recurr|repeat|again|previous|earlier|prior|still|before")] } },
  { id: "LS3", cat: "L", ws: "NK", room: "183", learningSensitive: true, priorOutcome: "failed",
    text: "Room 183: the AC has stopped cooling again.",
    history: [{ title: "Room 183: AC not cooling.", type: "maintenance", daysAgo: 10, relevant: true, analysis: { situation: "The AC in unit 183 was reported as not cooling.", recommendation: "A person could consider asking staff to reset the AC unit." }, outcome: { status: "failed", summary: "Staff reset the unit; no improvement. The compressor was later found faulty." } }],
    learningHint: "the earlier approach (a staff reset) is recorded as failed: repeating it is unlikely to help",
    expect: { problem: AC_PROBLEM, urgency: { min: "routine", max: "prompt" }, actionTypes: ACTIONS_MAINT, relevantHistory: ["AC not cooling"], irrelevantHistory: [], useHistory: [re("recurr|repeat|again|previous|earlier|prior|before")] } },
  { id: "LS4", cat: "L", ws: "NK", room: "184", learningSensitive: true, priorOutcome: "blocked",
    text: "Room 184: the bathroom sink is leaking.",
    history: [{ title: "Room 184: sink leaking under the basin.", type: "maintenance", daysAgo: 9, relevant: true, analysis: { situation: "A leak under the sink in unit 184.", recommendation: "A person could consider dispatching a plumber to inspect and repair the leak." }, outcome: { status: "blocked", summary: "Maintenance could not enter: the guest refused access twice." } }],
    learningHint: "the earlier visit was blocked by an access refusal: arranging access with the guest first is supported",
    expect: { problem: LEAK_PROBLEM, urgency: { min: "prompt", max: "immediate" }, actionTypes: ACTIONS_MAINT, relevantHistory: ["sink leaking"], irrelevantHistory: [], useHistory: [re("recurr|repeat|again|previous|earlier|prior|before|access")] } },
  { id: "LS5", cat: "L", ws: "NK", room: "185", learningSensitive: true, priorOutcome: "unknown",
    text: "Room 185: the guest's key card is not opening the door.",
    history: [{ title: "Room 185: key card not opening the door.", type: "maintenance", daysAgo: 12, relevant: true, analysis: { situation: "A key card failure in unit 185.", recommendation: "A person could consider reprogramming or replacing the key card." }, outcome: { status: "unknown", summary: "Outcome was not reported back." } }],
    learningHint: "the earlier outcome is unknown: there is no evidence either way, so no outcome-based adjustment is supported",
    expect: { problem: KEY_PROBLEM, urgency: { min: "prompt", max: "immediate" }, actionTypes: ["guest_communication", "maintenance_dispatch", "other"], relevantHistory: ["key card not opening"], irrelevantHistory: [], useHistory: [re("recurr|repeat|again|previous|earlier|prior|before")] } },
  { id: "LS6", cat: "L", ws: "NK", room: "186", learningSensitive: true, priorOutcome: "failed-then-success",
    text: "Room 186: the AC is not cooling.",
    history: [
      { title: "Room 186: AC not cooling.", type: "maintenance", daysAgo: 20, relevant: true, analysis: { situation: "The AC in unit 186 was reported as not cooling.", recommendation: "A person could consider asking staff to reset the AC unit." }, outcome: { status: "failed", summary: "Staff reset the unit; no improvement." } },
      { title: "Room 186: AC not cooling again.", type: "maintenance", daysAgo: 8, relevant: true, analysis: { situation: "The AC in unit 186 again failed to cool.", recommendation: "A person could consider dispatching a technician to inspect the AC unit." }, outcome: { status: "success", summary: "Technician replaced the faulty capacitor; cooling restored." } },
    ],
    learningHint: "a pattern across two earlier cases: a staff reset failed, a technician repair succeeded",
    expect: { problem: AC_PROBLEM, urgency: { min: "routine", max: "prompt" }, actionTypes: ACTIONS_MAINT, relevantHistory: ["AC not cooling"], irrelevantHistory: [], useHistory: [re("recurr|repeat|again|previous|earlier|prior|before")] } },
];

export const SCENARIOS = [...BASE_SCENARIOS, ...LEARNING_SENSITIVE];
export const CATEGORY_NAMES = { ...BASE_CATEGORIES, L: "Learning-sensitive (prior outcomes; baseline only)" };
