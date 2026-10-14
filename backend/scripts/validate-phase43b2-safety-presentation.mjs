/**
 * Phase 43B.2 validation - the structured safety / urgency UI (deterministic; no database, no model, no network).
 *
 *   node backend/scripts/validate-phase43b2-safety-presentation.mjs
 *
 * Renders the REAL components server-side (Vite SSR, exactly as the app loads them) from the API-shaped `safety` the backend returns (Phase 43B.1).
 *   V   the presented vocabulary is tied to the backend's own enums
 *   M   the 17-case matrix of the phase brief
 *   P   proof that nothing is derived from prose / keywords / regexes
 *   A   accessibility
 *   X   dashboard and Intelligence page agree (exhaustive matrix)
 *   N   no action execution
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(here, "..");
const REPO = path.join(BACKEND, "..");
const FRONTEND = path.join(REPO, "frontend");
const read = (p) => fs.readFileSync(p, "utf8");
let passed = 0; let failed = 0;
const check = (name, ok, detail = "") => { if (ok) { passed += 1; console.log(`PASS  ${name}${detail ? ` - ${detail}` : ""}`); } else { failed += 1; console.error(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`); } };

const { SAFETY_STATES } = await import("../src/models/Intelligence.js");
const { URGENCY_LEVELS } = await import("../src/services/ai/safetyPolicy.js");
const { ACTION_TYPES } = await import("../src/models/Action.js");
const { deriveSafetyPolicy, evaluateSafetyPolicy } = await import("../src/services/ai/safetyPolicy.js");
const { validateAndVerifyAnalysis } = await import("../src/services/intelligenceAnalysisService.js");
const { APPROVED_MODEL, APPROVED_PROVIDER } = await import("../src/config/providerPolicy.js");
const PARITY = JSON.parse(fs.readFileSync(path.join(REPO, "ai-service", "tests", "fixtures", "evidence_catalog_parity.json"), "utf8"));

const { createServer } = await import(pathToFileURL(path.join(FRONTEND, "node_modules", "vite", "dist", "node", "index.js")).href);
const vite = await createServer({ root: FRONTEND, configFile: path.join(FRONTEND, "vite.config.js"), server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom", logLevel: "silent", optimizeDeps: { noDiscovery: true, include: [] } });

const OID = (n) => `6ac3${String(n).padStart(20, "0")}`;
const SIG = OID(1); const STAY = OID(2); const CHUNK = OID(3);
const EMERGENCY_WORDS = /CRITICAL SAFETY CONDITION|LIFE-SAFETY HAZARD|IMMEDIATE ACTION REQUIRED|ESCALATION REQUIRED/;

try {
  const feRequire = createRequire(path.join(FRONTEND, "package.json"));
  const React = feRequire("react");
  const { renderToStaticMarkup } = feRequire("react-dom/server");
  const { MemoryRouter } = await import(pathToFileURL(path.join(FRONTEND, "node_modules", "react-router-dom", "dist", "index.mjs")).href);
  const h = React.createElement;
  const P = await vite.ssrLoadModule("/src/features/intelligence/safetyPresentation.js");
  const { presentSafety, PRESENTED_VOCABULARY } = P;
  const SafetyAssessment = (await vite.ssrLoadModule("/src/features/intelligence/SafetyAssessment.jsx")).default;
  const SignalSeverityNote = (await vite.ssrLoadModule("/src/features/intelligence/SignalSeverityNote.jsx")).default;
  const SignalDetail = (await vite.ssrLoadModule("/src/features/dashboard/SignalDetail.jsx")).default;
  const { mapDashboardDetail } = await vite.ssrLoadModule("/src/features/dashboard/dashboardMapping.js");
  const { mapIntelligenceAnalysis } = await vite.ssrLoadModule("/src/features/intelligence/intelligenceMapping.js");
  const html = (el) => renderToStaticMarkup(el);
  const text = (m) => m.replace(/<[^>]*>/g, " ").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

  const PROV = [{ chunkId: CHUNK, section: "Gas Smell and Smoke - Emergency Procedure", sectionPath: [], visibility: "staff", retrievalScore: 0.7 }];
  const prose = (over = {}) => ({ situation: "Situation.", evidence: ["Evidence."], impact: "Impact.", recommendation: "Recommendation.", ...over });
  // the API-shaped intelligence, with `safety` exactly as 43B.1 returns it (an object, or the key absent)
  const apiIntel = ({ safety, p = {} }) => ({ id: OID(9), ...prose(p), confidence: "medium", createdAt: "2026-10-05T10:00:00Z", knowledgeProvenance: PROV, ...(safety === undefined ? {} : { safety }) });
  const detailInput = ({ safety, severity = "medium", p = {} }) => ({
    signal: { id: SIG, title: "A signal", type: "maintenance", severity, status: "new", source: "staff", occurredAt: "2026-10-05T09:00:00Z", description: "" },
    observed: { property: null, unit: null, stay: null, hasGuest: false }, intelligence: apiIntel({ safety, p }),
  });
  const renderDetail = (args) => html(h(MemoryRouter, null, h(SignalDetail, { signalId: SIG, detail: mapDashboardDetail(detailInput(args)), status: "ready", error: null, onRetry() {}, showBack: false, decisions: { status: "ready", byIntelligenceId: new Map(), partial: false }, onRetryDecisions() {} })));
  const fragmentFromPage = (safety, p = {}) => html(h(SafetyAssessment, { safety: mapIntelligenceAnalysis({ _id: OID(9), analysis: { ...prose(p), confidence: "medium" }, knowledgeProvenance: PROV, createdAt: "2026-10-05T10:00:00Z", ...(safety === undefined ? {} : { safety }) }).safety }));
  const fragment = (safety) => html(h(SafetyAssessment, { safety }));
  const alerts = (m) => (m.match(/role="alert"/g) || []).length;

  // ======================================================================================================== V
  console.log("\n# V. the presented vocabulary is the backend's");
  check("V1 the states the UI knows are EXACTLY the backend's persisted states (NORMAL, CRITICAL, SAFETY_REVIEW_REQUIRED, LIFE_SAFETY_HAZARD)", JSON.stringify([...PRESENTED_VOCABULARY.states].sort()) === JSON.stringify([...SAFETY_STATES].sort()));
  check("V2 the urgencies are EXACTLY safetyPolicy.js's URGENCY_LEVELS", JSON.stringify([...PRESENTED_VOCABULARY.urgencies].sort()) === JSON.stringify([...URGENCY_LEVELS].sort()));
  check("V3 the action types are EXACTLY the Action model's ACTION_TYPES (so 'escalation' is the backend's own value)", JSON.stringify([...PRESENTED_VOCABULARY.actionTypes].sort()) === JSON.stringify([...ACTION_TYPES].sort()) && ACTION_TYPES.includes("escalation"));

  // ======================================================================================================== M
  console.log("\n# M. the matrix");
  for (const [label, safety] of [["absent key", undefined], ["null", null]]) {
    const m = renderDetail({ safety });
    const f = text(fragmentFromPage(safety));
    check(`M1 NO safety field (${label}): no emergency state, no alert, and it is NOT called safe / normal / no risk / no hazard - 'Safety assessment not recorded'`, !EMERGENCY_WORDS.test(text(m)) && alerts(m) === 0 && f === "Safety assessment not recorded." && !/\b(?:safe|normal|no risk|no hazard)\b/i.test(f));
  }
  const normal = fragment({ state: "NORMAL", urgency: "prompt", recommendedActionType: "inspection" });
  check("M2 NORMAL: no emergency wording, no alert, no role; a quiet line that does not say 'safe'", !EMERGENCY_WORDS.test(normal) && alerts(normal) === 0 && !/role=/.test(normal) && text(normal) === "Validated safety assessment: Normal · Urgency: Prompt · Action type: Inspection" && !/\bsafe\b/i.test(normal));
  const normalLoud = fragment({ state: "NORMAL", urgency: "immediate", recommendedActionType: "escalation" });
  check("M2b NORMAL with a stated immediate urgency + the exact escalation action type: still NO alert, NO flag, NO live region and NO 'REQUIRED' wording (NORMAL is never presented as an emergency), but the structured escalation is NOT hidden - it is stated plainly and emphasised as 'Escalation recommended' (non-alarm), and the urgency is shown", !EMERGENCY_WORDS.test(normalLoud) && alerts(normalLoud) === 0 && !/role=|aria-live|safety-alert|REQUIRED/.test(normalLoud) && /Urgency: Immediate/.test(text(normalLoud)) && /<strong class="safety-note">Escalation recommended<\/strong>/.test(normalLoud) && !/Action type: Escalation/.test(normalLoud));
  const vmNormal = presentSafety({ state: "NORMAL", urgency: "immediate", recommendedActionType: "escalation" });
  check("M2c the view model itself (not just the markup) carries no alert, no headline and no flag for NORMAL, whatever its urgency or action type - so no component can leak one - and exposes the exact-value `escalation` fact only (it never changes alert / headline / flags)", vmNormal.status === "recorded" && vmNormal.alert === false && vmNormal.headline === null && vmNormal.flags.length === 0 && vmNormal.escalation === true && presentSafety({ state: "NORMAL", recommendedActionType: "inspection" }).escalation === false && presentSafety({ state: "SOMETHING_NEW", urgency: "immediate", recommendedActionType: "escalation" }).status === "unrecognised" && presentSafety(null).status === "not_recorded");
  const hazBothEarly = fragment({ state: "LIFE_SAFETY_HAZARD", urgency: "immediate", recommendedActionType: "escalation" });
  const NOT_ESCALATION = ["ESCALATION", "Escalation", "escalate", "escalation ", "escalate_now", "emergency", "", "toString", "__proto__", "inspection", "other", 7, null, undefined];
  check("M2d NORMAL with an action type that is NOT the exact escalation value is never presented as an escalation: no 'Escalation recommended' for any near-miss, case variant or unknown value", NOT_ESCALATION.every((a) => !/Escalation recommended/.test(fragment({ state: "NORMAL", urgency: "prompt", recommendedActionType: a })) && presentSafety({ state: "NORMAL", recommendedActionType: a }).escalation === false));
  check("M2e inside an ALERT the escalation stays the structured flag ('ESCALATION REQUIRED') and the quiet wording never appears there; and the quiet wording never creates an alert from a NORMAL state", /ESCALATION REQUIRED/.test(hazBothEarly) && !/Escalation recommended/.test(hazBothEarly) && alerts(normalLoud) === 0);
  const crit = fragment({ state: "CRITICAL", urgency: "immediate", recommendedActionType: "guest_communication" });
  check("M3 CRITICAL: a critical safety indicator ('CRITICAL SAFETY CONDITION'), as the one alert, from the structured state", /CRITICAL SAFETY CONDITION/.test(crit) && alerts(crit) === 1 && !/LIFE-SAFETY/.test(crit));
  check("M3b ...and it never claims a sensor or a measurement: it says it is NOT a sensor reading and uses no 'detected', 'measured', gas, smoke or temperature wording", /not a sensor reading/.test(text(crit)) && !/detected|measured|reports danger|\bgas\b|smoke|temperature|reading shows/i.test(text(crit).replace("It is not a sensor reading.", "")));
  const haz = fragment({ state: "LIFE_SAFETY_HAZARD", urgency: "prompt", recommendedActionType: "inspection" });
  check("M4 LIFE_SAFETY_HAZARD: a life-safety indicator ('LIFE-SAFETY HAZARD'), with no immediate or escalation flag when the structured fields do not say so", /LIFE-SAFETY HAZARD/.test(haz) && alerts(haz) === 1 && !/IMMEDIATE ACTION REQUIRED|ESCALATION REQUIRED/.test(haz));
  const hazImm = fragment({ state: "LIFE_SAFETY_HAZARD", urgency: "immediate", recommendedActionType: "maintenance_dispatch" });
  check("M5 LIFE_SAFETY_HAZARD + urgency 'immediate': 'IMMEDIATE ACTION REQUIRED' (from the structured urgency); no escalation flag for a different action type", /LIFE-SAFETY HAZARD/.test(hazImm) && /IMMEDIATE ACTION REQUIRED/.test(hazImm) && !/ESCALATION REQUIRED/.test(hazImm));
  const hazEsc = fragment({ state: "LIFE_SAFETY_HAZARD", urgency: "prompt", recommendedActionType: "escalation" });
  check("M6 LIFE_SAFETY_HAZARD + action type 'escalation': 'ESCALATION REQUIRED' (from the exact enum value); no immediate flag when urgency is not 'immediate'", /ESCALATION REQUIRED/.test(hazEsc) && !/IMMEDIATE ACTION REQUIRED/.test(hazEsc));
  const hazBoth = fragment({ state: "LIFE_SAFETY_HAZARD", urgency: "immediate", recommendedActionType: "escalation" });
  check("M7 LIFE_SAFETY_HAZARD + immediate + escalation: ONE coherent alert (one section, one live region) carrying all three structured statements - not three competing cards", (hazBoth.match(/<section/g) || []).length === 1 && alerts(hazBoth) === 1 && /LIFE-SAFETY HAZARD/.test(hazBoth) && /IMMEDIATE ACTION REQUIRED/.test(hazBoth) && /ESCALATION REQUIRED/.test(hazBoth) && (hazBoth.match(/<li/g) || []).length === 2);

  const sevNormal = renderDetail({ severity: "critical", safety: { state: "NORMAL", urgency: "prompt", recommendedActionType: "inspection" } });
  const sevNormalText = text(sevNormal);
  check("M8 CRITICAL signal severity + NORMAL intelligence safety: both are shown and stay DISTINGUISHABLE - the recorded severity in its own labelled note, the validated assessment as its own quiet line - and neither is turned into an alert", /Signal severity: CRITICAL/.test(sevNormalText) && /Validated safety assessment: Normal/.test(sevNormalText) && alerts(sevNormal) === 0 && !EMERGENCY_WORDS.test(sevNormalText) && sevNormal.indexOf("severity-note") < sevNormal.indexOf("safety-quiet") && !/class="severity-note[^"]*"[^>]*>[^<]*Validated/.test(sevNormal));
  const medHaz = renderDetail({ severity: "medium", safety: { state: "LIFE_SAFETY_HAZARD", urgency: "immediate", recommendedActionType: "escalation" } });
  check("M9 MEDIUM signal severity + LIFE_SAFETY_HAZARD + immediate: the life-safety UI is shown because of the STRUCTURED Intelligence safety, with no severity note at all (severity is not what drives it)", /LIFE-SAFETY HAZARD/.test(medHaz) && /IMMEDIATE ACTION REQUIRED/.test(medHaz) && !/severity-note/.test(medHaz));
  const critHaz = renderDetail({ severity: "critical", safety: { state: "LIFE_SAFETY_HAZARD", urgency: "immediate", recommendedActionType: "escalation" } });
  check("M9b CRITICAL severity + LIFE_SAFETY_HAZARD: no DUPLICATE alert - exactly ONE live alert on the page; the recorded severity is a separate static note that says only what was recorded", alerts(critHaz) === 1 && (critHaz.match(/safety-alert"/g) || []).length === 1 && /severity-note/.test(critHaz) && !/role=/.test((critHaz.match(/<p class="severity-note[\s\S]*?<\/p>/) || [""])[0]));

  const proseNormal = renderDetail({ severity: "low", safety: { state: "NORMAL", urgency: "routine", recommendedActionType: "other" }, p: { situation: "This is a critical emergency.", impact: "Life-safety hazard, critical.", recommendation: "This is an emergency: escalate immediately, a critical life-safety condition." } });
  check("M10 the recommendation SAYS 'emergency', 'critical', 'escalate immediately' but the structured safety is NORMAL: NO banner, NO flag, no alert - the words appear only as stored prose", alerts(proseNormal) === 0 && !EMERGENCY_WORDS.test(text(proseNormal)) && !/safety-alert/.test(proseNormal) && /escalate immediately/.test(proseNormal));
  const proseNone = renderDetail({ severity: "low", safety: undefined, p: { recommendation: "Treat this as an immediate life-safety emergency. Escalate now." } });
  check("M10b the same prose with NO safety field: still nothing (prose never creates a state)", alerts(proseNone) === 0 && !EMERGENCY_WORDS.test(text(proseNone)) && !/safety-alert/.test(proseNone));

  const UNKNOWN_STATES = ["SOMETHING_NEW", "normal", "critical", "Critical", "life_safety_hazard", " NORMAL", "", "toString", "constructor", "__proto__", "hasOwnProperty", `knowledge:${CHUNK}`, 5, true, {}, []];
  check("M11 an UNKNOWN state is never guessed: not NORMAL, not CRITICAL, not an emergency - presented as 'not recognised', neutrally", UNKNOWN_STATES.every((s) => { const v = presentSafety({ state: s, urgency: "immediate", recommendedActionType: "escalation" }); const f = fragment({ state: s, urgency: "immediate", recommendedActionType: "escalation" }); return v.status === "unrecognised" && !EMERGENCY_WORDS.test(f) && alerts(f) === 0 && !/Normal|Critical|Life-safety|Urgency|Action type/.test(f) && /not recognised/.test(f); }), `${UNKNOWN_STATES.length} values`);
  const UNKNOWN_URG = ["IMMEDIATE", "Immediate", "now", "urgent", "", "toString", "__proto__", "current:stay:" + STAY, 3, null, undefined];
  check("M12 an UNKNOWN urgency is never guessed: the hazard alert still shows, but no 'IMMEDIATE ACTION REQUIRED' and no urgency is presented", UNKNOWN_URG.every((u) => { const f = fragment({ state: "LIFE_SAFETY_HAZARD", urgency: u, recommendedActionType: "inspection" }); return /LIFE-SAFETY HAZARD/.test(f) && !/IMMEDIATE ACTION REQUIRED|Urgency/.test(f) && !/current:/.test(f); }), `${UNKNOWN_URG.length} values`);
  const UNKNOWN_ACT = ["ESCALATION", "Escalation", "escalate", "escalation ", "escalate_now", "emergency", "", "toString", "__proto__", "knowledge:" + CHUNK, 7, null, undefined];
  check("M13 an UNKNOWN action type is never guessed into escalation: no 'ESCALATION REQUIRED' and no action type presented", UNKNOWN_ACT.every((a) => { const f = fragment({ state: "LIFE_SAFETY_HAZARD", urgency: "immediate", recommendedActionType: a }); return /LIFE-SAFETY HAZARD/.test(f) && /IMMEDIATE ACTION REQUIRED/.test(f) && !/ESCALATION REQUIRED|Action type/.test(f) && !/knowledge:/.test(f); }), `${UNKNOWN_ACT.length} values`);

  const refusal = renderDetail({ severity: "medium", safety: { state: "NORMAL", urgency: "prompt", recommendedActionType: "guest_communication" }, p: { situation: "The guest has refused entry to the technician.", recommendation: "Do not enter. The guest refuses access; record the refusal and offer another time." } });
  const refusalChrome = refusal.replace(/The guest has refused entry to the technician\./, "").replace(/Do not enter\. The guest refuses access; record the refusal and offer another time\./, "");
  const feSources = fs.readdirSync(path.join(FRONTEND, "src"), { recursive: true, withFileTypes: true }).filter((d) => d.isFile() && /\.jsx?$/.test(d.name)).map((d) => path.join(d.parentPath ?? d.path, d.name));
  const code = (f) => read(f).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  check("M14 access-refusal PROSE with no stored rule code: NO 'access refused' badge or wording anywhere in the page chrome (safety/context hardening: the wording now exists in exactly ONE frontend file, safetyPresentation.js, and is gated by the exact server rule code ACCESS_REFUSED - never derived from prose)", !/refus|access denied/i.test(text(refusalChrome)) && feSources.every((f) => /safetyPresentation\.js$/.test(f) ? /safety\.rules\.some\(\(rule\) => rule === "ACCESS_REFUSED"\)/.test(code(f)) : !/ACCESS[_ ]REFUSED|access[- ]refus/i.test(code(f))));

  const refsProse = renderDetail({ severity: "medium", safety: { state: "LIFE_SAFETY_HAZARD", urgency: "immediate", recommendedActionType: "escalation" }, p: {
    situation: `Gas reported (untrusted:signal:${SIG}) for the stay (current:stay:${STAY}).`, evidence: [`Procedure applies (knowledge:${CHUNK}); chunkId ${CHUNK}.`], impact: `Risk (history:signal:${SIG}).`, recommendation: `Escalate now per knowledge:${CHUNK} (current:stay:${STAY}).` } });
  check("M15 PHASE 43A intact next to the alert: evidence references are removed from the prose, the safety result is unaffected", !/\b(?:current|untrusted|history|knowledge|learning):[A-Za-z0-9_.-]+/.test(text(refsProse)) && !/[0-9a-f]{24}/i.test(refsProse.replace(/href="[^"]*"/g, "")) && /LIFE-SAFETY HAZARD/.test(refsProse) && /ESCALATION REQUIRED/.test(refsProse));
  const hostile = fragment({ state: "LIFE_SAFETY_HAZARD", urgency: `current:stay:${STAY}`, recommendedActionType: `knowledge:${CHUNK}` });
  const hostileState = fragment({ state: `untrusted:signal:${SIG}`, urgency: CHUNK, recommendedActionType: STAY });
  check("M16 NO raw evidence reference or ObjectId in the safety UI - even when a hostile value is placed in any structured field", ![hostile, hostileState, haz, hazBoth, crit, normal].some((m) => /\b(?:current|untrusted|history|knowledge|learning):|[0-9a-f]{24}/i.test(m)));

  // ======================================================================================================== R
  console.log("\n# R. is NORMAL + escalation reachable under the EXISTING backend policy? (classification C: possible AND valid)");
  const ctxFor = (patch) => ({ ...PARITY.input.context, signal: { ...PARITY.input.context.signal, ...patch } });
  const sigRef = `current:signal:${PARITY.input.context.signal.id}`;
  const RAWA = (over = {}) => ({
    situation: "S", evidence: ["E"], impact: "I", recommendation: "Ask the duty manager to speak with the neighbours.", confidence: "low", usedKnowledgeChunkIds: [],
    provenance: { provider: APPROVED_PROVIDER, model: APPROVED_MODEL }, evidenceRefs: [], contradictions: [],
    claims: [{ claimType: "FACT", text: "The Signal is recorded.", sourceRefs: [sigRef] }, { claimType: "RECOMMENDATION", text: "Ask the duty manager to follow up.", sourceRefs: [sigRef] }],
    urgency: "prompt", recommendedActionType: "escalation", ...over,
  });
  const through = (context, over) => validateAndVerifyAnalysis(RAWA(over), { context, operationalHistory: PARITY.input.operationalHistory, knowledge: PARITY.input.knowledge, learning: undefined, workspaceId: "64b0000000000000000000b1" });
  const ordinary = ctxFor({ severity: "medium", title: "Noise complaint", description: "A guest complains about noise from the neighbouring apartment." });
  const polOrdinary = deriveSafetyPolicy(ordinary);
  check("R1 deriveSafetyPolicy on an ordinary Signal is NORMAL with NO minimum urgency, NO required action types and NO forbidden action types - escalation is neither required nor forbidden", polOrdinary.state === "NORMAL" && polOrdinary.minimumUrgency === null && polOrdinary.requiredActionTypes === null && polOrdinary.forbiddenActionTypes.length === 0);
  check("R2 evaluateSafetyPolicy ACCEPTS NORMAL with action type 'escalation' (strict, as in production) at any urgency, including 'immediate' - zero violations", ["immediate", "prompt", "routine"].every((u) => evaluateSafetyPolicy(polOrdinary, { urgency: u, recommendedActionType: "escalation" }).length === 0));
  const accepted = through(ordinary, {});
  check("R3 the FULL strict admission pipeline (schema, identity, claims, safety, prose, identifier, confidence ceiling - approved production identity) ADMITS it: the persisted state would be NORMAL with action type 'escalation'", accepted.urgency === "prompt" && accepted.recommendedActionType === "escalation" && accepted.admission.safetyState === "NORMAL" && accepted.admission.stages.safety === "passed" && accepted.admission.stages.prose === "passed");
  const refusedOnly = ctxFor({ severity: "medium", title: "Guest refuses maintenance entry", description: "The guest refuses entry to the maintenance technician." });
  const polRefused = deriveSafetyPolicy(refusedOnly);
  check("R4 an access refusal alone is still NORMAL, and escalation stays permitted there (only dispatch and inspection are forbidden) - so NORMAL + escalation also occurs next to a refusal", polRefused.state === "NORMAL" && !polRefused.forbiddenActionTypes.includes("escalation") && evaluateSafetyPolicy(polRefused, { urgency: "prompt", recommendedActionType: "escalation" }).length === 0 && evaluateSafetyPolicy(polRefused, { urgency: "prompt", recommendedActionType: "maintenance_dispatch" }).includes("ACTION_FORBIDDEN_BY_ACCESS_REFUSAL"));
  const polHazard = deriveSafetyPolicy(ctxFor({ severity: "medium", title: "Gas", description: "A strong smell of gas in the kitchen." }));
  check("R5 the opposite direction is the policy's own rule, not the UI's: a hazard REQUIRES escalation or dispatch and immediate urgency (which is why the alert, not the quiet line, carries 'ESCALATION REQUIRED')", polHazard.state === "LIFE_SAFETY_HAZARD" && polHazard.minimumUrgency === "immediate" && polHazard.requiredActionTypes.includes("escalation"));
  check("R6 the UI does not duplicate any of this: the presentation module never reads a Signal, a policy or prose, and its escalation fact is the exact enum comparison", /safety\.recommendedActionType === "escalation"/.test(code(path.join(FRONTEND, "src", "features", "intelligence", "safetyPresentation.js"))) && !/severity|signal|policy|requiredActionTypes|forbiddenActionTypes/.test(code(path.join(FRONTEND, "src", "features", "intelligence", "safetyPresentation.js"))));

  // ======================================================================================================== X
  console.log("\n# X. the dashboard and the Intelligence page agree");
  const STATES = [undefined, null, "NORMAL", "CRITICAL", "LIFE_SAFETY_HAZARD", "SOMETHING_NEW"];
  const URGS = [undefined, "immediate", "prompt", "routine", "now"];
  const ACTS = [undefined, "escalation", "inspection", "maintenance_dispatch", "guest_communication", "other", "escalate"];
  let combos = 0; let disagree = 0;
  for (const st of STATES) for (const u of URGS) for (const a of ACTS) {
    const safety = st === undefined || st === null ? st : { state: st, ...(u === undefined ? {} : { urgency: u }), ...(a === undefined ? {} : { recommendedActionType: a }) };
    combos += 1;
    const fromPage = fragmentFromPage(safety);
    const dash = renderDetail({ safety });
    const fromDashFragment = (dash.match(/<(?:section class="safety-alert"[\s\S]*?<\/section>|p class="safety-quiet muted">[\s\S]*?<\/p>)/) || [""])[0];
    if (fromPage !== fromDashFragment) disagree += 1;
  }
  check("X1 for every combination of state x urgency x action type (known, unknown, absent, null) the dashboard detail and the Intelligence page render the IDENTICAL safety markup", disagree === 0, `${combos} combinations, ${disagree} disagree`);
  const pageSrc = code(path.join(FRONTEND, "src", "features", "assistant", "SignalCaseCard.jsx")); // Phase 52: the assistant's case card replaced the Intelligence page as this integration point
  const detailSrc = code(path.join(FRONTEND, "src", "features", "dashboard", "SignalDetail.jsx"));
  check("X2 both integration points use the ONE shared component and pass the structured value straight through (no local safety logic in either)", /<SafetyAssessment safety=\{intelligence\.safety\} \/>/.test(pageSrc) && /<SafetyAssessment safety=\{analysis\.safety\} \/>/.test(detailSrc) && !/presentSafety|LIFE_SAFETY|NORMAL|"immediate"|"escalation"/.test(pageSrc + detailSrc));

  // ======================================================================================================== P
  console.log("\n# P. nothing is derived from prose");
  const presSrc = code(path.join(FRONTEND, "src", "features", "intelligence", "safetyPresentation.js"));
  check("P1 the presentation module scans no text: no regular expression, no .test / .match / .search / .includes / .indexOf / .startsWith, no RegExp, no case folding, no import", !/\/(?![/*])[^/\n]+\/[gimsuy]*\s*(?:\.test|\.exec)|\.test\(|\.match\(|\.matchAll\(|\.search\(|\.includes\(|\.indexOf\(|\.startsWith\(|\.endsWith\(|RegExp|toLowerCase|toUpperCase|localeCompare/.test(presSrc) && !/^\s*import\s/m.test(presSrc));
  check("P2 its ONLY input is the structured `safety` object: presentSafety takes one parameter, and an extra 'prose' argument changes nothing", /export function presentSafety\(safety\)/.test(presSrc) && JSON.stringify(presentSafety({ state: "NORMAL", urgency: "prompt" }, "This is a critical life-safety emergency, escalate immediately")) === JSON.stringify(presentSafety({ state: "NORMAL", urgency: "prompt" })));
  const lines = (m) => text(m);
  const withPlain = lines(fragmentFromPage({ state: "NORMAL", urgency: "prompt", recommendedActionType: "inspection" }, { recommendation: "Replace the lamp." }));
  const withScary = lines(fragmentFromPage({ state: "NORMAL", urgency: "prompt", recommendedActionType: "inspection" }, { recommendation: "EMERGENCY! CRITICAL! LIFE-SAFETY HAZARD! ESCALATE IMMEDIATELY! gas smoke fire", situation: "emergency", impact: "critical", evidence: ["fire", "gas leak"] }));
  check("P3 for the same structured safety, wildly different prose gives byte-identical safety markup (prose is not an input)", withPlain === withScary && alerts(fragmentFromPage({ state: "NORMAL" }, { recommendation: "EMERGENCY! CRITICAL!" })) === 0);
  const sevSrc = code(path.join(FRONTEND, "src", "features", "intelligence", "severitySignal.js"));
  check("P4 the recorded-severity note also scans no text (closed own-property lookup on the structured severity value)", !/\.test\(|\.match\(|\.includes\(|\.search\(|RegExp|toLowerCase|toUpperCase/.test(sevSrc) && /hasOwnProperty/.test(sevSrc));
  check("P5 no component hands prose to the safety components: SafetyAssessment's only prop is `safety`, SignalSeverityNote's only prop is `severity`", /function SafetyAssessment\(\{ safety \}\)/.test(code(path.join(FRONTEND, "src", "features", "intelligence", "SafetyAssessment.jsx"))) && /function SignalSeverityNote\(\{ severity \}\)/.test(code(path.join(FRONTEND, "src", "features", "intelligence", "SignalSeverityNote.jsx"))));
  check("P6 no other frontend file derives a safety state from text: no file tests text against 'emergency' / 'hazard' / 'escalat' / 'life-safety' / 'critical' words", feSources.filter((f) => !/safetyPresentation\.js$|severitySignal\.js$/.test(f)).every((f) => !/\/[^/\n]*(?:emergency|hazard|escalat|life-?safety)[^/\n]*\/[gimsuy]*\s*\.(?:test|exec)|\.(?:test|match|includes)\([^)]*(?:emergency|hazard|escalat|life-?safety)/i.test(code(f))));

  // ======================================================================================================== A
  console.log("\n# A. accessibility");
  check("A1 the alert is a live region with an accessible name that points at its visible headline; the decorative icon is hidden from assistive technology", /role="alert"/.test(hazBoth) && (() => { const id = (hazBoth.match(/aria-labelledby="([^"]+)"/) || [])[1]; return !!id && new RegExp(`id="${id}"[^>]*>LIFE-SAFETY HAZARD`).test(hazBoth); })() && /<svg[^>]*aria-hidden="true"/.test(hazBoth));
  check("A2 state is carried by VISIBLE TEXT, not colour alone (headline + flag text), and the flags are a real list", /<p class="safety-alert-headline"[^>]*>LIFE-SAFETY HAZARD</.test(hazBoth) && /<ul class="safety-alert-flags"><li>IMMEDIATE ACTION REQUIRED<\/li><li>ESCALATION REQUIRED<\/li><\/ul>/.test(hazBoth));
  check("A3 only a real safety condition is a live region: NORMAL, not recorded, not recognised and the severity note announce nothing; a full page render has at most ONE alert", [normal, fragment(null), fragment({ state: "X" }), html(h(SignalSeverityNote, { severity: "critical" }))].every((m) => !/role=|aria-live/.test(m)) && alerts(critHaz) === 1);
  const css = read(path.join(FRONTEND, "src", "styles", "operations.css"));
  check("A4 no animation or flashing in the safety styles (no keyframes, animation or transition), and long text wraps (overflow-wrap) instead of clipping", !/@keyframes|animation\s*:|transition\s*:/.test(css.slice(css.indexOf("Phase 43B.2"))) && /overflow-wrap:\s*anywhere/.test(css.slice(css.indexOf("Phase 43B.2"))));
  check("A5 keyboard: the safety UI adds no interactive element and no tab stop (nothing to trap focus or hide)", ![hazBoth, normal, crit].some((m) => /<(?:button|a |input|select|textarea)|tabindex|onclick/i.test(m)));

  // ======================================================================================================== N
  console.log("\n# N. no action execution");
  const compSrc = ["SafetyAssessment.jsx", "SignalSeverityNote.jsx", "safetyPresentation.js", "severitySignal.js"].map((f) => code(path.join(FRONTEND, "src", "features", "intelligence", f))).join("\n");
  check("N1 the safety UI executes nothing: no button, link, handler, fetch, axios, API service or navigation in any of its files, and nothing in the rendered alert is clickable", !/fetch\(|axios|services\/api|koiApi|onClick|onSubmit|<button|<Link|<a |navigate\(|window\.|document\./.test(compSrc) && !/<(?:button|a |form)/.test(hazBoth));
  check("N2 it is informational wording only: it says what the validated assessment states ('... REQUIRED') and offers no way to act on it", /ESCALATION REQUIRED/.test(hazBoth) && !/dispatch now|escalate now|call|send/i.test(text(hazBoth)));
} finally { await vite.close(); }

console.log(`\nPhase 43B.2 safety presentation validation: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
