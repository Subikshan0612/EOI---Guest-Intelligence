/**
 * Phase 34D validation - server-side confidence ceiling, positive historical-evidence coverage, and structured-field /
 * recommendation-prose consistency.
 *
 * Every "model output" is a hand-written MOCK. No Gemini call, no network beyond nothing at all, no database connection
 * (asserted at the end). The Phase 34C suites remain the authority for evidence classes, claim admissibility, the safety
 * minimum and the identifier guard; this suite adds the three Phase 34D behaviours and proves the 34C ones still hold when
 * they interact:
 *
 *   final confidence <= server confidence ceiling      (the model may be MORE conservative, never less)
 *   structured fields stay authoritative               (prose is only a secondary contradiction detector)
 *   history has a valid but subordinate role           (HISTORICAL_PATTERN accepted; FACT on history rejected; history never
 *                                                       raises confidence)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { getLearningContextEnabled } from "../src/config/runtimeConfig.js";
import { APPROVED_MODEL, APPROVED_PROVIDER } from "../src/config/providerPolicy.js";
import { CONFIDENCE_LEVELS, applyConfidenceCeiling, deriveConfidenceCeiling } from "../src/services/ai/confidencePolicy.js";
import { buildEvidenceEnvelope } from "../src/services/ai/evidenceEnvelope.js";
import { assertProseConsistent, findProseContradictions } from "../src/services/ai/proseConsistency.js";
import { deriveSafetyPolicy } from "../src/services/ai/safetyPolicy.js";
import { validateAndVerifyAnalysis } from "../src/services/intelligenceAnalysisService.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(here, "..");
const REPO = path.join(BACKEND, "..");
const read = (p) => fs.readFileSync(p, "utf8");
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) { passed += 1; console.log(`PASS  ${name}`); } else { failed += 1; console.error(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`); }
};
const quietly = (fn) => { const orig = console.error; console.error = () => {}; try { return fn(); } finally { console.error = orig; } };
const thrown = (fn) => quietly(() => { try { fn(); return null; } catch (e) { return e; } });
const rejects = (fn, code) => { const e = thrown(fn); return !!e && e.statusCode === 502 && (code === undefined || e.details?.code === code); };
const accepts = (fn) => thrown(fn) === null;
const withEnv = (patch, fn) => {
  const before = {};
  for (const [k, v] of Object.entries(patch)) { before[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return fn(); } finally { for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};

// ------------------------------------------------------------------------------------------------------ fixtures
const FIX = JSON.parse(read(path.join(REPO, "ai-service", "tests", "fixtures", "evidence_catalog_parity.json")));
const WS = FIX.workspaceId;
const SIG = "current:signal:64b0000000000000000000a1";
const UNT = "untrusted:signal:64b0000000000000000000a1";
const HAN = "history:analysis:64b0000000000000000000f1";
const HDEC = "history:decision:64b0000000000000000000f2";
const HSIG = "history:signal:64b0000000000000000000f1";
const KNW = "knowledge:64b0000000000000000000k1";
const LRN = "learning:maintenance_dispatch";
const claim = (claimType, text, ...sourceRefs) => ({ claimType, text, sourceRefs });
const envelope = (over = {}) => buildEvidenceEnvelope({ workspaceId: WS, ...FIX.input, ...over });
const ENV = envelope();
const ctx = FIX.input.context; // property AND unit available
const withSignal = (patch) => ({ ...ctx, signal: { ...ctx.signal, ...patch } });
const unresolved = { ...ctx, property: { id: ctx.property.id, available: false }, unit: { id: ctx.unit.id, available: false } };
const ceilingOf = (claims, over = {}) => deriveConfidenceCeiling({ claims, envelope: ENV, context: ctx, contradictions: [], strict: true, knowledge: FIX.input.knowledge, minSimilarity: 0.25, ...over });

const RAW = (over = {}) => ({
  situation: "S", evidence: ["E"], impact: "I", recommendation: "Follow the documented procedure.", confidence: "low", usedKnowledgeChunkIds: [],
  provenance: { provider: APPROVED_PROVIDER, model: APPROVED_MODEL }, evidenceRefs: [], contradictions: [],
  claims: [claim("FACT", "The Signal is recorded as an AC fault.", SIG), claim("RECOMMENDATION", "Follow the documented procedure.", SIG, KNW)],
  urgency: "routine", recommendedActionType: "inspection", ...over,
});
const run = (over = {}, c = {}) => validateAndVerifyAnalysis(RAW(over), {
  context: c.context ?? ctx, operationalHistory: c.operationalHistory ?? FIX.input.operationalHistory, knowledge: c.knowledge ?? FIX.input.knowledge,
  learning: c.learning, workspaceId: WS,
});
const STRONG = [claim("FACT", "The Signal is recorded as an AC fault.", SIG, UNT), claim("RECOMMENDATION", "Follow the documented procedure.", SIG, KNW)];
const NO_GUIDANCE = [claim("FACT", "The Signal is recorded as an AC fault.", SIG), claim("RECOMMENDATION", "Have the unit checked.", SIG)];

// ====================================================================================================== A. CONFIDENCE
check("A0 levels are the project's three existing ones, ordered low < medium < high; no new level",
  JSON.stringify(CONFIDENCE_LEVELS) === JSON.stringify(["low", "medium", "high"]) && Object.isFrozen(CONFIDENCE_LEVELS) && read(path.join(BACKEND, "src", "models", "Intelligence.js")).includes('const ANALYSIS_CONFIDENCE_LEVELS = ["high", "medium", "low"]'));

check("1 strong current evidence + guidance-grounded recommendation + resolved location -> HIGH allowed (and a model HIGH is kept)",
  (() => { const c = ceilingOf(STRONG); const a = applyConfidenceCeiling("high", c); return c.ceiling === "high" && c.reasons.length === 0 && a.confidence === "high" && !a.capped; })());
check("2 no relevant business guidance cited by the recommendation -> HIGH not allowed (ceiling MEDIUM, a model HIGH becomes MEDIUM)",
  (() => { const c = ceilingOf(NO_GUIDANCE); const a = applyConfidenceCeiling("high", c); return c.ceiling === "medium" && c.reasons.includes("NO_KNOWLEDGE_GROUNDED_RECOMMENDATION") && a.confidence === "medium" && a.capped; })());
check("3 weak / advisory support -> HIGH not allowed: current fact + Learning/history only = MEDIUM; Learning/history-only recommendation = LOW",
  ceilingOf([claim("FACT", "f", SIG), claim("RECOMMENDATION", "r", SIG, LRN, HAN)]).ceiling === "medium" &&
  ceilingOf([claim("FACT", "f", SIG), claim("RECOMMENDATION", "r", LRN)]).ceiling === "low" && ceilingOf([claim("FACT", "f", SIG), claim("RECOMMENDATION", "r", HAN, HDEC)]).ceiling === "low");
check("4 history alone cannot justify HIGH current-state confidence (history-only FACT and recommendation -> LOW); history never RAISES the ceiling",
  ceilingOf([claim("FACT", "f", HAN), claim("RECOMMENDATION", "r", HAN)]).ceiling === "low" &&
  ceilingOf([...NO_GUIDANCE, claim("HISTORICAL_PATTERN", "h", HAN, HDEC)]).ceiling === ceilingOf(NO_GUIDANCE).ceiling && ceilingOf([...NO_GUIDANCE, claim("HISTORICAL_PATTERN", "h", HAN, HDEC)]).ceiling === "medium");
check("5 Learning alone cannot justify HIGH (Learning-only FACT and recommendation -> LOW); Learning never raises the ceiling",
  ceilingOf([claim("FACT", "f", LRN), claim("RECOMMENDATION", "r", LRN)]).ceiling === "low" &&
  ceilingOf([...NO_GUIDANCE, claim("LEARNING_OBSERVATION", "l", LRN)]).ceiling === ceilingOf(NO_GUIDANCE).ceiling);
check("6 the untrusted Signal text alone cannot justify HIGH (untrusted-only FACT and recommendation -> LOW)",
  ceilingOf([claim("FACT", "f", UNT), claim("RECOMMENDATION", "r", UNT)]).ceiling === "low" && ceilingOf([claim("FACT", "f", UNT), claim("RECOMMENDATION", "r", SIG)]).ceiling === "low");
check("7 confidence never alters the safety minimum: the policy is a function of the current Signal ONLY, and a HIGH answer still has to meet it",
  (() => {
    const gas = { context: withSignal({ severity: "critical", title: "Strong gas smell", description: "Guest reports a strong gas smell and a possible gas leak." }) };
    return deriveSafetyPolicy.length === 1 && JSON.stringify(deriveSafetyPolicy(gas.context)) === JSON.stringify(deriveSafetyPolicy(gas.context)) &&
      rejects(() => run({ confidence: "high", urgency: "routine", recommendedActionType: "escalation" }, gas), "SAFETY_POLICY_VIOLATION") &&
      rejects(() => run({ confidence: "high", urgency: "immediate", recommendedActionType: "guest_communication" }, gas), "SAFETY_POLICY_VIOLATION") &&
      rejects(() => run({ confidence: "low", urgency: "routine", recommendedActionType: "escalation" }, gas), "SAFETY_POLICY_VIOLATION") &&
      accepts(() => run({ confidence: "high", urgency: "immediate", recommendedActionType: "escalation" }, gas)) && accepts(() => run({ confidence: "low", urgency: "immediate", recommendedActionType: "escalation" }, gas));
  })());
check("8 model says HIGH but the ceiling is MEDIUM -> the FINAL result cannot remain HIGH (end to end, with audit metadata)",
  (() => {
    const out = run({ confidence: "high", claims: NO_GUIDANCE });
    return out.confidence === "medium" && out.admission.modelConfidence === "high" && out.admission.confidenceCeiling === "medium" && out.admission.confidenceCapped === true &&
      out.admission.ceilingReasons.includes("NO_KNOWLEDGE_GROUNDED_RECOMMENDATION") && run({ confidence: "high", claims: STRONG }).confidence === "high";
  })());
check("9 model says LOW while the ceiling is HIGH -> NOT forced up: the model may be more conservative",
  (() => { const out = run({ confidence: "low", claims: STRONG }); return out.confidence === "low" && out.admission.confidenceCeiling === "high" && out.admission.confidenceCapped === false; })() &&
  run({ confidence: "medium", claims: STRONG }).confidence === "medium");
check("A10 PROPERTY: for every model confidence x every evidence scenario, final <= ceiling AND final <= model (and final = min)",
  (() => {
    const scenarios = [STRONG, NO_GUIDANCE, [claim("FACT", "f", HAN), claim("RECOMMENDATION", "r", HAN)], [claim("FACT", "f", LRN), claim("RECOMMENDATION", "r", LRN)], [claim("FACT", "f", UNT), claim("RECOMMENDATION", "r", UNT)], [], undefined];
    return scenarios.every((claims) => [true, false].every((strict) => ["low", "medium", "high"].every((model) => {
      const info = ceilingOf(claims, { strict });
      const r = applyConfidenceCeiling(model, info);
      const rank = (x) => CONFIDENCE_LEVELS.indexOf(x);
      const ceilingOk = info.ceiling === null ? r.confidence === model : rank(r.confidence) <= rank(info.ceiling);
      return ceilingOk && rank(r.confidence) <= rank(model) && r.confidence === (info.ceiling === null ? model : CONFIDENCE_LEVELS[Math.min(rank(model), rank(info.ceiling))]);
    })));
  })());
check("A11 an unresolved location or a reported contradiction caps at MEDIUM even with guidance; no claims in strict mode is LOW; an unknown model value is treated as LOW",
  ceilingOf(STRONG, { context: unresolved }).ceiling === "medium" && ceilingOf(STRONG, { context: unresolved }).reasons.includes("LOCATION_UNRESOLVED") &&
  ceilingOf(STRONG, { contradictions: [{ type: "signal_vs_historical" }] }).ceiling === "medium" && ceilingOf(STRONG, { contradictions: [{}] }).reasons.includes("CONTRADICTIONS_REPORTED") &&
  ceilingOf([], { strict: true }).ceiling === "low" && ceilingOf(undefined, { strict: true }).ceiling === "low" &&
  applyConfidenceCeiling("certain", { ceiling: "high" }).confidence === "low" && applyConfidenceCeiling(undefined, { ceiling: "high" }).confidence === "low");
check("A12 compatibility mode (deterministic test provider, development/test, NO claims) applies no cap - the old contract is unchanged there; present claims are capped normally",
  ceilingOf([], { strict: false }).ceiling === null && applyConfidenceCeiling("high", ceilingOf([], { strict: false })).confidence === "high" &&
  withEnv({ NODE_ENV: "test" }, () => { const out = run({ provenance: { provider: "test", model: "deterministic-stub" }, claims: undefined, urgency: undefined, recommendedActionType: undefined, confidence: "high" }); return out.confidence === "high" && out.admission.confidenceCapped === false; }) &&
  withEnv({ NODE_ENV: "test" }, () => run({ provenance: { provider: "test", model: "deterministic-stub" }, claims: NO_GUIDANCE, urgency: undefined, recommendedActionType: undefined, confidence: "high" }).confidence === "medium"));
check("A13 a valid low-confidence analysis is still accepted (a cap lowers, it never rejects); overconfidence is not an admissibility failure",
  accepts(() => run({ confidence: "low", claims: NO_GUIDANCE })) && accepts(() => run({ confidence: "high", claims: NO_GUIDANCE })) && accepts(() => run({ confidence: "high", claims: [claim("FACT", "f", UNT, SIG), claim("RECOMMENDATION", "r", SIG)] })));
check("A14 the stored value is the FINAL one: persistence receives the analysis this function returns, and stores `analysis.confidence` only",
  (() => {
    const svc = read(path.join(BACKEND, "src", "services", "intelligenceAnalysisService.js"));
    const store = read(path.join(BACKEND, "src", "services", "intelligenceService.js"));
    return /const analysis = validateAndVerifyAnalysis\(raw/.test(svc) && /confidence: analysis\.confidence/.test(store) && !/modelConfidence|admission/.test(store);
  })());

// ====================================================================================================== B. HISTORY (positive path)
const RELEVANT = [
  claim("FACT", "The air conditioner in the unit is reported as not cooling.", SIG, UNT),
  claim("HISTORICAL_PATTERN", "Two earlier air conditioning faults in this unit were resolved by replacing the filter.", HAN, HDEC),
  claim("BUSINESS_GUIDANCE", "The approved procedure says to check the thermostat and the filter first.", KNW),
  claim("RECOMMENDATION", "Check the filter and thermostat; arrange a technician visit if the unit still does not cool.", SIG, KNW),
];
check("B1 HISTORICAL_PATTERN + history references is ACCEPTED end to end when history is genuinely relevant (alongside FACT, BUSINESS_GUIDANCE and a supported RECOMMENDATION)",
  accepts(() => run({ claims: RELEVANT, confidence: "high", urgency: "prompt", recommendedActionType: "maintenance_dispatch" })) &&
  accepts(() => run({ claims: [claim("FACT", "f", SIG), claim("HISTORICAL_PATTERN", "h", HSIG, HAN, HDEC, SIG), claim("RECOMMENDATION", "r", SIG, KNW)] })));
check("B2 ...and history is SUBORDINATE: the same answer without the historical claim has the identical ceiling and final confidence",
  ceilingOf(RELEVANT).ceiling === ceilingOf(RELEVANT.filter((c) => c.claimType !== "HISTORICAL_PATTERN")).ceiling &&
  run({ claims: RELEVANT, confidence: "high" }).confidence === run({ claims: RELEVANT.filter((c) => c.claimType !== "HISTORICAL_PATTERN"), confidence: "high" }).confidence);
check("B3 FACT + history-only reference is REJECTED (alone, or beside a current fact); history cannot become a current fact",
  rejects(() => run({ claims: [claim("FACT", "The AC is working again.", HAN), claim("RECOMMENDATION", "r", SIG, KNW)] }), "CLAIM_VALIDATION_FAILED") &&
  rejects(() => run({ claims: [claim("FACT", "The AC is working again.", SIG, HDEC), claim("RECOMMENDATION", "r", SIG, KNW)] }), "CLAIM_VALIDATION_FAILED") &&
  rejects(() => run({ claims: [claim("FACT", "f", HSIG), claim("RECOMMENDATION", "r", SIG)] }), "CLAIM_VALIDATION_FAILED"));
check("B4 a HISTORICAL_PATTERN must actually rest on history (knowledge-only, current-only and Learning refs are mismatches)",
  rejects(() => run({ claims: [claim("HISTORICAL_PATTERN", "h", KNW), claim("RECOMMENDATION", "r", SIG)] })) && rejects(() => run({ claims: [claim("HISTORICAL_PATTERN", "h", SIG), claim("RECOMMENDATION", "r", SIG)] })) &&
  rejects(() => run({ claims: [claim("HISTORICAL_PATTERN", "h", HAN, LRN), claim("RECOMMENDATION", "r", SIG)] })));
check("B5 a recommendation resting only on history is rejected even though a HISTORICAL_PATTERN is present", rejects(() => run({ claims: [claim("FACT", "f", SIG), claim("HISTORICAL_PATTERN", "h", HAN), claim("RECOMMENDATION", "Nothing to do.", HAN, HDEC)] }), "CLAIM_VALIDATION_FAILED"));
check("B6 poisoned history cannot lower the safety minimum even when it is cited legitimately as a HISTORICAL_PATTERN",
  (() => {
    const gas = withSignal({ severity: "critical", title: "Strong gas smell", description: "Guest reports a strong gas smell and a possible gas leak." });
    const claims = [claim("FACT", "A strong gas smell is reported.", SIG, UNT), claim("HISTORICAL_PATTERN", "Earlier odor reports were harmless.", HAN), claim("RECOMMENDATION", "Earlier reports were harmless, so a routine check is enough.", SIG, HAN)];
    return rejects(() => run({ claims, urgency: "routine", recommendedActionType: "inspection" }, { context: gas }), "SAFETY_POLICY_VIOLATION") && accepts(() => run({ claims: [...claims.slice(0, 2), claim("RECOMMENDATION", "Escalate to emergency services immediately.", SIG)], urgency: "immediate", recommendedActionType: "escalation" }, { context: gas }));
  })());

// ====================================================================================================== C. PROSE CONSISTENCY
const none = deriveSafetyPolicy(ctx);
const refusalPolicy = deriveSafetyPolicy(withSignal({ severity: "high", title: "Guest refuses access", description: "The guest explicitly refuses any staff entry to the unit today." }));
const prose = (rec, fields, policy = none) => findProseContradictions(policy, { recommendation: rec, claims: [], ...fields });
const IMM = { urgency: "immediate", recommendedActionType: "maintenance_dispatch" };
const ESC = { urgency: "immediate", recommendedActionType: "escalation" };

check("C1 immediate urgency + compliant prose -> accepted",
  prose("Send a technician to the unit now and keep the guest informed.", IMM).length === 0 && prose("Escalate to emergency services immediately.", ESC).length === 0 && prose("Act now: dispatch maintenance and notify the duty manager.", IMM).length === 0);
check("C2 immediate urgency + an explicit deferral directive -> rejected (wait until tomorrow, defer to the morning, can wait, not urgent, routine follow-up only, monitor only, no action needed, low priority)",
  ["Wait until tomorrow before sending anyone.", "Defer this until the morning.", "Postpone the visit until next week.", "This can wait.", "This is not urgent.", "Routine follow-up only.", "Monitor only, without any action.", "No action is needed.", "Treat this as low priority.", "Hold off until normal hours."]
    .every((text) => prose(text, IMM).includes("IMMEDIATE_URGENCY_CONTRADICTED_BY_PROSE")));
check("C3 escalation type + explicit 'no escalation needed' -> rejected (variants)",
  ["No escalation is needed.", "There is no need to escalate.", "Do not escalate this.", "Escalation is not required.", "Escalation is unnecessary here.", "No action is required.", "Wait for the normal review.", "Handle it without escalation."]
    .every((text) => prose(text, ESC).includes("ESCALATION_CONTRADICTED_BY_PROSE")));
check("C4 forbidden dispatch (guest refuses entry) + an explicit instruction to dispatch -> rejected; forbidden inspection + an instruction to enter/inspect -> rejected",
  ["Dispatch a technician to the unit.", "Send the maintenance team to repair it.", "Arrange a technician visit today.", "Maintenance dispatch is recommended."]
    .every((text) => prose(text, { urgency: "prompt", recommendedActionType: "guest_communication" }, refusalPolicy).includes("FORBIDDEN_DISPATCH_INSTRUCTED_IN_PROSE")) &&
  ["Enter the unit and inspect the heater.", "Inspect the room today.", "Visit the unit to check the pipework."]
    .every((text) => prose(text, { urgency: "prompt", recommendedActionType: "guest_communication" }, refusalPolicy).includes("FORBIDDEN_INSPECTION_INSTRUCTED_IN_PROSE")));
const ORDINARY = [
  "Check the thermostat setting and the air filter, then arrange a technician visit if the unit still does not cool.",
  "Contact the guest to confirm a convenient time for the repair.", "Follow the documented HVAC procedure for this fault.", "Verify the unit and stay details before taking further steps.",
  "Ask housekeeping to replace the towels this afternoon.", "Escalate to the duty manager and keep the guest informed.", "Review the earlier analysis for this unit and compare it with the current report.",
  "Request a late checkout for the guest if the room is free.", "Inspect the carpet stain and arrange cleaning.", "Notify the guest that a technician will visit this afternoon.",
  "Arrange a technician visit and confirm the time with the guest.", "Replace the light bulb in the hallway.", "No further information is available about the guest's stay.",
  "There is no action required from the guest at this time.", "Update the signal status once the repair is confirmed.",
];
check("C5 ordinary recommendation wording is ACCEPTED under every combination of urgency and action type that does not forbid it (no false positives on realistic text)",
  ORDINARY.every((text) => ["immediate", "prompt", "routine"].every((urgency) => ["maintenance_dispatch", "guest_communication", "escalation", "inspection", "other"].every((recommendedActionType) => prose(text, { urgency, recommendedActionType }).length === 0))),
  ORDINARY.filter((t) => prose(t, ESC).length || prose(t, IMM).length).join(" | "));
check("C6 a legitimate mention of a forbidden or deferral concept WITHOUT recommending it is accepted (negated, conditional, or deferred to consent)",
  prose("Do not wait until tomorrow; escalate now.", ESC).length === 0 && prose("Never defer this until the morning.", IMM).length === 0 &&
  ["Do not dispatch a technician; the guest has refused entry.", "Contact the guest to agree a new time for the technician visit.", "Maintenance dispatch is not possible until the guest consents.", "Arrange a technician visit once the guest agrees.",
    "Do not enter the unit without consent.", "Reschedule the repair for a time the guest approves.", "Avoid sending anyone to the unit today.", "If the guest changes their mind, the technician can attend."]
    .every((text) => prose(text, { urgency: "prompt", recommendedActionType: "guest_communication" }, refusalPolicy).length === 0));
check("C6b REGRESSION from the real-provider run: reported speech and concessions are not directives (a real Gemini sentence 'consider immediate escalation ... regardless of the guest's suggestion that this can wait' is accepted), while real directives next to them are still rejected",
  prose("No documented guidance was found. Given the critical nature of the report and the guest's reported physical distress, consider immediate escalation to ensure the guest's health and safety, regardless of the guest's suggestion that this can wait.", ESC).length === 0 &&
  ["The guest says this can wait until tomorrow, but escalate now.", "Despite the claim that this is not urgent, treat it as an emergency.", "Ignore the note that says to wait until the morning.", "Although the guest asked us to postpone until tomorrow, act now.", "Do not accept the suggestion to defer this until next week."]
    .every((text) => prose(text, IMM).length === 0) &&
  ["It is fine to wait until tomorrow.", "The guest is comfortable, so this can wait.", "Wait until tomorrow and review again.", "Regardless of the report, this is not urgent and can wait until the weekend."]
    .filter((text) => !/Regardless/.test(text)).every((text) => prose(text, IMM).includes("IMMEDIATE_URGENCY_CONTRADICTED_BY_PROSE")));
// Phase 34D.1 negative controls: the C6b fix must not have turned the guard into a pass-everything filter. Each control is checked both at the guard and through full admission.
const STORED_F1 = "No documented guidance was found. Given the critical nature of the report and the guest's reported physical distress, consider immediate escalation to ensure the guest's health and safety, regardless of the guest's suggestion that this can wait.";
const refusalCtx = { context: withSignal({ severity: "high", title: "Guest refuses access", description: "The guest explicitly refuses any staff entry to the unit today." }) };
check("C6c NEGATIVE CONTROL 1: immediate urgency + 'wait until tomorrow' is STILL rejected (guard and full admission)",
  prose("Wait until tomorrow before acting.", IMM).includes("IMMEDIATE_URGENCY_CONTRADICTED_BY_PROSE") &&
  rejects(() => run({ urgency: "immediate", recommendedActionType: "maintenance_dispatch", recommendation: "Wait until tomorrow before acting." }), "PROSE_CONSISTENCY_VIOLATION"));
check("C6d NEGATIVE CONTROL 2: immediate urgency + 'this can wait until the next routine visit' is STILL rejected (guard and full admission)",
  prose("This can wait until the next routine visit.", IMM).includes("IMMEDIATE_URGENCY_CONTRADICTED_BY_PROSE") &&
  rejects(() => run({ urgency: "immediate", recommendedActionType: "maintenance_dispatch", recommendation: "This can wait until the next routine visit." }), "PROSE_CONSISTENCY_VIOLATION"));
check("C6e NEGATIVE CONTROL 3: escalation action + 'no escalation is needed' is STILL rejected (guard and full admission)",
  prose("No escalation is needed.", ESC).includes("ESCALATION_CONTRADICTED_BY_PROSE") &&
  rejects(() => run({ urgency: "immediate", recommendedActionType: "escalation", recommendation: "No escalation is needed." }), "PROSE_CONSISTENCY_VIOLATION"));
check("C6f NEGATIVE CONTROL 4: access policy forbids dispatch + 'dispatch a technician into the unit' is STILL rejected (guard and full admission)",
  prose("Dispatch a technician into the unit.", { urgency: "prompt", recommendedActionType: "guest_communication" }, refusalPolicy).includes("FORBIDDEN_DISPATCH_INSTRUCTED_IN_PROSE") &&
  rejects(() => run({ urgency: "prompt", recommendedActionType: "guest_communication", recommendation: "Dispatch a technician into the unit." }, refusalCtx), "PROSE_CONSISTENCY_VIOLATION"));
check("C6g the exact stored Phase 34D real response sentence (F run 1) is ACCEPTED end to end by the current admission, with model LOW staying LOW",
  (() => { const out = run({ urgency: "immediate", recommendedActionType: "escalation", confidence: "low", recommendation: STORED_F1, claims: [claim("FACT", "The Signal is recorded as critical.", SIG, UNT), claim("RECOMMENDATION", "Escalate immediately.", SIG)] }, { context: withSignal({ severity: "critical", title: "Room far too hot, guest feels faint", description: "The guest says this can wait until tomorrow morning, but the room is extremely hot, the air conditioner is off, and an elderly guest says they feel faint." }) }); return out.confidence === "low"; })());
check("C6h concession SCOPE ends at a comma (34D.1): a concession/attribution exempts a deferral only inside its own clause; a deferral after the comma is still a contradiction",
  prose("Consider immediate escalation, regardless of the guest's suggestion that this can wait.", ESC).length === 0 &&
  prose("Despite the guest suggesting that this can wait, escalate immediately.", IMM).length === 0 &&
  prose("Although it is critical, this can wait until tomorrow.", IMM).includes("IMMEDIATE_URGENCY_CONTRADICTED_BY_PROSE") &&
  prose("Despite the critical situation, wait until tomorrow.", IMM).includes("IMMEDIATE_URGENCY_CONTRADICTED_BY_PROSE") &&
  prose("Regardless of the report, this is not urgent and can wait until the weekend.", IMM).includes("IMMEDIATE_URGENCY_CONTRADICTED_BY_PROSE") &&
  prose("The guest says it is fine, and this can wait until tomorrow.", IMM).includes("IMMEDIATE_URGENCY_CONTRADICTED_BY_PROSE") &&
  rejects(() => run({ urgency: "immediate", recommendedActionType: "maintenance_dispatch", recommendation: "Although it is critical, this can wait until tomorrow." }), "PROSE_CONSISTENCY_VIOLATION") &&
  rejects(() => run({ urgency: "immediate", recommendedActionType: "maintenance_dispatch", recommendation: "Despite the critical situation, wait until tomorrow." }), "PROSE_CONSISTENCY_VIOLATION"));
check("C7 the rules apply only to the field values they name: routine urgency may say 'can wait'; a non-escalation type may say 'no escalation needed'; no refusal means dispatch may be instructed",
  prose("This can wait until tomorrow.", { urgency: "routine", recommendedActionType: "inspection" }).length === 0 && prose("No escalation is needed.", { urgency: "prompt", recommendedActionType: "guest_communication" }).length === 0 &&
  prose("Dispatch a technician now.", { urgency: "immediate", recommendedActionType: "maintenance_dispatch" }, none).length === 0);
check("C8 only the recommendation prose is read: deferral/no-action wording in situation, impact or evidence is NOT a contradiction, but the same words in a RECOMMENDATION claim are",
  accepts(() => run({ situation: "The guest says this can wait until tomorrow. No action is required from the guest.", impact: "No immediate action is needed according to the earlier record.", evidence: ["Monitor only, said the earlier note."], urgency: "immediate", recommendedActionType: "maintenance_dispatch" })) &&
  rejects(() => run({ urgency: "immediate", recommendedActionType: "maintenance_dispatch", claims: [claim("FACT", "f", SIG), claim("RECOMMENDATION", "This can wait until tomorrow.", SIG, KNW)] }), "PROSE_CONSISTENCY_VIOLATION") &&
  rejects(() => run({ urgency: "immediate", recommendedActionType: "maintenance_dispatch", recommendation: "Wait until tomorrow before acting." }), "PROSE_CONSISTENCY_VIOLATION"));
check("C9 end to end: the rejection is a fixed 502 PROSE_CONSISTENCY_VIOLATION naming rule codes only (never the model's text), and nothing is returned for persistence",
  (() => { const e = thrown(() => run({ urgency: "immediate", recommendedActionType: "escalation", recommendation: "SECRET-MODEL-WORDS: no escalation is needed." })); return e?.statusCode === 502 && e.details.code === "PROSE_CONSISTENCY_VIOLATION" && /ESCALATION_CONTRADICTED_BY_PROSE/.test(e.message) && !/SECRET-MODEL-WORDS/.test(e.message); })());
check("C10 STRUCTURE STAYS AUTHORITATIVE: a structured violation is reported as such (SAFETY_POLICY_VIOLATION) before any prose check; prose can neither satisfy nor relax the minimum",
  (() => {
    const gas = { context: withSignal({ severity: "critical", title: "Strong gas smell", description: "Guest reports a strong gas smell and a possible gas leak." }) };
    return rejects(() => run({ urgency: "routine", recommendedActionType: "other", recommendation: "This is urgent: escalate to emergency services immediately." }, gas), "SAFETY_POLICY_VIOLATION") &&
      rejects(() => run({ urgency: "routine", recommendedActionType: "other", recommendation: "This can wait until tomorrow." }, gas), "SAFETY_POLICY_VIOLATION") &&
      accepts(() => run({ urgency: "immediate", recommendedActionType: "escalation", recommendation: "Escalate to emergency services immediately." }, gas)) && accepts(() => assertProseConsistent(none, RAW({ urgency: "immediate", recommendation: "Act now." })));
  })());
check("C11 the access-refusal contradiction is caught end to end, and a policy-compliant refusal answer is accepted",
  (() => {
    const refusal = { context: withSignal({ severity: "high", title: "Guest refuses access", description: "The guest explicitly refuses any staff entry to the unit today." }) };
    return rejects(() => run({ urgency: "prompt", recommendedActionType: "guest_communication", recommendation: "Dispatch a technician to the unit today." }, refusal), "PROSE_CONSISTENCY_VIOLATION") &&
      rejects(() => run({ urgency: "prompt", recommendedActionType: "guest_communication", claims: [claim("FACT", "f", SIG), claim("RECOMMENDATION", "Enter the unit and inspect the heater.", SIG, KNW)] }, refusal), "PROSE_CONSISTENCY_VIOLATION") &&
      accepts(() => run({ urgency: "prompt", recommendedActionType: "guest_communication", recommendation: "Do not enter the unit. Contact the guest to agree a new time for the repair.", claims: [claim("FACT", "The guest refuses entry.", SIG, UNT), claim("RECOMMENDATION", "Contact the guest to agree a new time for the repair.", SIG, KNW)] }, refusal));
  })());
check("C12 compatibility mode still checks any prose it is given (the test provider is not exempt from contradictions)",
  withEnv({ NODE_ENV: "test" }, () => rejects(() => run({ provenance: { provider: "test", model: "deterministic-stub" }, urgency: "immediate", recommendedActionType: "maintenance_dispatch", recommendation: "This can wait until tomorrow." }), "PROSE_CONSISTENCY_VIOLATION")));

// ====================================================================================================== D. REGRESSION / STRUCTURE
const svc = read(path.join(BACKEND, "src", "services", "intelligenceAnalysisService.js"));
const body = svc.slice(svc.indexOf("export function validateAndVerifyAnalysis"), svc.indexOf("export async function analyzeSignal"));
const order = ["validateClaims(", "enforceSafetyPolicy(", "assertProseConsistent(", "assertNoForeignIdentifiers(", "deriveConfidenceCeiling("].map((s) => body.indexOf(s));
check("D1 admission order is claims -> structured safety -> prose consistency -> identifier guard -> confidence cap (structure before prose, caps last)", order.every((i) => i > 0) && order.every((v, i) => i === 0 || v > order[i - 1]));
const modules = ["confidencePolicy.js", "proseConsistency.js"].map((f) => stripComments(read(path.join(BACKEND, "src", "services", "ai", f))));
check("D2 the new modules are pure and define no policy: no I/O, no model call, no tool; proseConsistency never imports the policy table it checks against", modules.every((m) => !/fetch\(|child_process|(?<![.\w])exec\(|spawn\(|node:fs|mongoose|function_call|toolCall/.test(m)) &&
  !/safetyPolicy|evidenceEnvelope/.test(modules[1]) && !/regex.*confiden/i.test(modules[0]));
check("D3 confidence is derived from claim types and source CLASSES only: no text of the analysis is read by the ceiling", !/\.text|recommendation|situation|impact|RegExp|\.test\(|\.match\(/.test(modules[0]));
check("D4 Learning stays OFF (flag default false, unchanged) and the ceiling treats Learning as non-support", withEnv({ KOI_LEARNING_CONTEXT_ENABLED: undefined }, () => getLearningContextEnabled() === false) && ceilingOf([...NO_GUIDANCE, claim("LEARNING_OBSERVATION", "l", LRN)], { envelope: envelope() }).ceiling === "medium");
check("D5 the provider policy is untouched: gemini / gemini-3.1-flash-lite, and a mismatching identity is still rejected before any admission logic", APPROVED_PROVIDER === "gemini" && APPROVED_MODEL === "gemini-3.1-flash-lite" && rejects(() => run({ provenance: { provider: "gemini", model: "gemini-3.6-flash" } }), "PROVIDER_IDENTITY_MISMATCH"));
check("D6 the system prompt tells the model the ceiling and the field/prose rule (rule 27), without changing the HIGH/MEDIUM/LOW definitions",
  (() => { const py = read(path.join(REPO, "ai-service", "app", "services", "analysis_prompt.py")); return /27\. CONFIDENCE CEILING/.test(py) && /lowers yours if it is higher; it never raises it/.test(py) && /never write that something can wait when urgency is "immediate"/.test(py) && /HIGH: the situation is directly supported/.test(py); })());
check("D7 no tool, action or execution surface was added; the public Intelligence view is unchanged", !/function_call|toolCall|executeAction/i.test(modules.join("")) && !/modelConfidence|confidenceCeiling/.test(read(path.join(BACKEND, "src", "services", "intelligenceService.js"))));
check("D8 no database connection was opened by this suite (readyState 0)", mongoose.connection.readyState === 0);
check("D9 no API-key-shaped string in the files this phase added", ["confidencePolicy.js", "proseConsistency.js"].every((f) => !/AIza[0-9A-Za-z_-]{20,}|sk-[A-Za-z0-9]{20,}/.test(read(path.join(BACKEND, "src", "services", "ai", f)))));

console.log(`\nPhase 34D calibration / history / consistency validation: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
