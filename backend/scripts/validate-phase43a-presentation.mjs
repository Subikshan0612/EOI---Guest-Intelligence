/**
 * Phase 43A validation - internal evidence references never reach the browser-visible prose (deterministic; no database, no model, no network).
 *
 *   node backend/scripts/validate-phase43a-presentation.mjs
 *
 *   A  presenter cases          normal / untrusted / mixed prose, the sentence positions a reference can take, article handling
 *   B  completeness BY CONSTRUCTION   every reference class Node can mint (read from evidenceEnvelope.js and the evidence fixture) is covered; a new class fails here
 *   C  no over-sanitising       ordinary text (colons, times, unit ids, words like "knowledge:" or "history:") is returned UNCHANGED (same string)
 *   D  fuzz                     600 seeded random sentences with refs in random positions: no reference survives, every other word survives in order, idempotent
 *   E  the real mapping layer   the Intelligence page, dashboard detail, Decision snapshot and error message, loaded through Vite SSR exactly as the app loads them
 *   F  architecture intact      the API/stored text still carries the references; Node's validators still see them; an unknown reference is still rejected;
 *                               nothing in the backend or AI service imports the presenter
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(here, "..");
const REPO = path.join(BACKEND, "..");
const FRONTEND = path.join(REPO, "frontend");
const read = (p) => fs.readFileSync(p, "utf8");
let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => { if (ok) { passed += 1; console.log(`PASS  ${name}${detail ? ` - ${detail}` : ""}`); } else { failed += 1; console.error(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`); } };

const P = await import(pathToFileURL(path.join(FRONTEND, "src", "features", "intelligence", "presentation.js")).href);
const { presentText, containsInternalReference, knowledgeTitles, presentAnalysisProse, INTERNAL_REF_KINDS, LEARNING_ACTION_TYPES } = P;
const { buildEvidenceEnvelope } = await import("../src/services/ai/evidenceEnvelope.js");
const { validateClaims, CLAIM_VALIDATION_FAILED } = await import("../src/services/ai/claimValidator.js");
const FIX = JSON.parse(read(path.join(REPO, "ai-service", "tests", "fixtures", "evidence_catalog_parity.json")));

const OID_A = "6ac38b6d0b1fd785f0192fc4";
const OID_B = "6ac37516680dd77e794e2308";
const OID_C = "6ac375aac4330ae178ea447e";
const TITLES = new Map([[OID_B, "Guest refuses entry"]]);
const strictlyClean = (s) => typeof s === "string" && !containsInternalReference(s) && !/[0-9a-f]{24}/i.test(s) && !/\b(?:current|untrusted|history|knowledge|learning):[A-Za-z0-9]/.test(s) && !/the the|\bundefined\b|\bnull\b|\(\s*\)/.test(s);

// ============================================================================================================ A. presenter cases
console.log("\n# A. presenter cases");
const A1 = presentText(`The stay in unit 204 is recorded as checked_in (current:stay:${OID_A}). Business knowledge applies (knowledge:${OID_B}).`);
check("A1 a NORMAL accepted prose with current:stay and knowledge references: neither survives and the sentences read naturally", strictlyClean(A1) && A1 === "The stay in unit 204 is recorded as checked_in. Business knowledge applies.", JSON.stringify(A1));
const A2 = presentText(`The signal reports warm air (untrusted:signal:${OID_C}).`);
check("A2 UNTRUSTED evidence: the untrusted:signal reference is removed from the prose", strictlyClean(A2) && A2 === "The signal reports warm air.", JSON.stringify(A2));
const A3 = presentText(`Inspect current:stay:${OID_A} and compare with knowledge:${OID_B} today.`, { titles: TITLES });
check("A3 a reference INSIDE a sentence becomes the matching evidence-class phrase, and the stored section title is used ONLY for the same chunk", A3 === 'Inspect the recorded stay and compare with the "Guest refuses entry" guidance today.', JSON.stringify(A3));
const A4 = presentText(`Compare with knowledge:${OID_C}.`, { titles: TITLES });
check("A4 a knowledge chunk that is NOT in this analysis's provenance gets the generic phrase (no title is invented)", A4 === "Compare with the available business guidance.", JSON.stringify(A4));
const A5 = presentText(`knowledge:${OID_B} says do not enter. Then follow history:analysis:${OID_C}.`, { titles: TITLES });
check("A5 a reference at the START of a sentence keeps the capital letter", A5 === 'The "Guest refuses entry" guidance says do not enter. Then follow an earlier analysis.', JSON.stringify(A5));
check("A6 multi-reference citations and 'chunkId' forms are removed as one unit (no leftover brackets or commas)", presentText(`Do X (knowledge:${OID_A}, knowledge:${OID_B}; chunkId: ${OID_C}).`) === "Do X.");
check("A6b (Phase 47, found with the real model) a citation written '(chunk <id>)' is removed WHOLE - the id AND the word 'chunk' - leaving no '(chunk)' behind", presentText(`In accordance with the 'Gas Smell Procedure' (chunk ${OID_A}), treat this as urgent. Also see (chunks ${OID_B}, ${OID_C}).`) === "In accordance with the 'Gas Smell Procedure', treat this as urgent. Also see.", JSON.stringify(presentText(`In accordance with the 'Gas Smell Procedure' (chunk ${OID_A}), treat this as urgent. Also see (chunks ${OID_B}, ${OID_C}).`)));
check("A7 'chunkId <id>' and a bare ObjectId inside a sentence are handled", presentText(`The operational signal ${OID_C} records a vague report. See chunkId ${OID_A} for details.`) === "The operational signal records a vague report. See the available business guidance for details.", JSON.stringify(presentText(`The operational signal ${OID_C} records a vague report. See chunkId ${OID_A} for details.`)));
check("A8 no doubled article: 'the learning:inspection pattern' -> 'the learning context pattern'; 'an history:analysis' -> 'an earlier analysis'", presentText("Treat the learning:inspection pattern as advisory.") === "Treat the learning context pattern as advisory." && presentText(`Compare with an history:analysis:${OID_C} today.`) === "Compare with an earlier analysis today.");
check("A9 every class phrase is natural language naming the EVIDENCE CLASS", ["current:signal", "current:property", "current:unit", "current:guest", "current:stay", "untrusted:signal", "history:signal", "history:analysis", "history:decision", "knowledge"].every((k) => { const o = presentText(`See ${k}:${OID_A} now.`); return strictlyClean(o) && /^See (the|a|an) [a-z ]+ now\.$/.test(o); }));
check("A10 idempotent, and non-strings pass through untouched", presentText(presentText(A3, { titles: TITLES }), { titles: TITLES }) === A3 && presentText(undefined) === undefined && presentText(null) === null && presentText(5) === 5 && JSON.stringify(presentText({ a: 1 })) === '{"a":1}');

// ============================================================================================================ B. completeness by construction
console.log("\n# B. completeness by construction");
const envelopeSrc = read(path.join(BACKEND, "src", "services", "ai", "evidenceEnvelope.js"));
const minted = new Set([...envelopeSrc.matchAll(/"((?:current|untrusted|history|knowledge|learning)(?::[a-z]+)?)"/g)].map((m) => m[1]));
const covered = new Set([...INTERNAL_REF_KINDS, "learning"]);
check("B1 every reference prefix Node's evidence envelope mints (read from its source) is covered by the presenter", minted.size >= 8 && [...minted].every((k) => covered.has(k)), `minted: ${[...minted].join(", ")}`);
const actionTypes = [...read(path.join(BACKEND, "src", "models", "Action.js")).match(/const ACTION_TYPES = \[([^\]]+)\]/)[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
check("B2 the learning references the presenter knows are exactly the action types Node can mint", JSON.stringify([...actionTypes].sort()) === JSON.stringify([...LEARNING_ACTION_TYPES].sort()), actionTypes.join(","));
const ENV_ALL = buildEvidenceEnvelope({ workspaceId: FIX.workspaceId, ...FIX.input, learning: { patterns: LEARNING_ACTION_TYPES.map((actionType) => ({ actionType })) } });
const allRefs = [...ENV_ALL.items.keys()];
const classesSeen = new Set(allRefs.map((r) => r.split(":")[0]));
check("B3 the real envelope for the evidence fixture mints references of EVERY class (current, untrusted, history, knowledge, learning)", ["current", "untrusted", "history", "knowledge", "learning"].every((c) => classesSeen.has(c)), `${allRefs.length} references`);
const TEMPLATES = ["X", "See X.", "(X)", "Do the check (X).", "[X]", "per X, then act", "(X, Y)", '"X" is relevant', "X: done", "Before X; after", "Note: (see X)", "to X."];
let leaks = 0; let tried = 0;
for (const ref of allRefs) for (const t of TEMPLATES) {
  const text = t.replaceAll("Y", allRefs[(allRefs.indexOf(ref) + 1) % allRefs.length]).replaceAll("X", ref);
  tried += 1;
  if (!strictlyClean(presentText(text))) { leaks += 1; console.error(`   leak: ${JSON.stringify(text)} -> ${JSON.stringify(presentText(text))}`); }
}
check("B4 EVERY reference Node can mint, in 12 sentence positions each, leaves NO trace of the reference or its id", leaks === 0 && tried >= allRefs.length * TEMPLATES.length, `${tried} cases, ${leaks} leaks`);
const MIXED = `Situation (${allRefs.slice(0, 3).join(", ")}). ${allRefs.slice(3, 6).map((r) => `Use ${r}`).join(" and ")}. Final (${allRefs.slice(6).join("; ")}).`;
check("B5 MIXED evidence: one paragraph carrying all classes at once is clean", strictlyClean(presentText(MIXED)) && presentText(MIXED).length > 20, JSON.stringify(presentText(MIXED)).slice(0, 140));

// ============================================================================================================ C. no over-sanitising
console.log("\n# C. no over-sanitising");
const BENIGN = [
  "Current status: new. Knowledge: base policy applies.", "The call at 10:30 about history: none was logged.", "Unit 204 and room 1A-R1 are fine; see P42-A and KR01.",
  "Contact reception at extension 1234 or 08:00-17:00.", "The learning curve is steep and the knowledge team agreed.", "current:stay is a label here, not a reference.",
  "A hex-like word deadbeef and a short id 6ac3 are not object ids.", "Signal 12345 was acknowledged by user abc.", "",
];
check("C1 ordinary text - colons, times, unit and property codes, the words 'knowledge:' and 'history:', short ids - is returned UNCHANGED (the same string)", BENIGN.every((t) => presentText(t) === t));
check("C2 a 23- or 25-digit hex run is not an ObjectId and is left alone; a real 24-digit one is removed", presentText("x 6ac38b6d0b1fd785f019301 y") === "x 6ac38b6d0b1fd785f019301 y" && presentText("x 6ac38b6d0b1fd785f01930123 y") === "x 6ac38b6d0b1fd785f01930123 y" && presentText(`x ${OID_A} y`) === "x y");

// ============================================================================================================ D. fuzz
console.log("\n# D. fuzz");
let seed = 43; const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const WORDS = ["Dispatch", "technician", "within", "four", "hours", "inspect", "unit", "204", "contact", "guest", "record", "refusal", "offer", "another", "slot", "and", "inform", "duty", "manager", "ensure", "safety", "evacuate", "area"];
const PUNCT = ["", "", ",", ".", ";", ":"];
let fuzzLeaks = 0; let fuzzLost = 0; let fuzzNotIdem = 0; let fuzzRefs = 0;
for (let n = 0; n < 600; n += 1) {
  const parts = []; const skeleton = [];
  for (let i = 0, len = 4 + Math.floor(rnd() * 10); i < len; i += 1) {
    const r = rnd();
    if (r < 0.28) { const ref = pick(allRefs); fuzzRefs += 1; const form = Math.floor(rnd() * 4); parts.push(form === 0 ? ref : form === 1 ? `(${ref})` : form === 2 ? `[${ref}, ${pick(allRefs)}]` : `chunkId: ${pick([OID_A, OID_B, OID_C])}`); parts.push(pick(PUNCT)); }
    else { const w = pick(WORDS); parts.push(w); skeleton.push(w); }
  }
  const text = parts.join(" ").replace(/ ([,.;:])/g, "$1");
  const out = presentText(text);
  if (!strictlyClean(out)) { fuzzLeaks += 1; if (fuzzLeaks <= 4) console.error(`   leak: ${JSON.stringify(text)}
     -> ${JSON.stringify(out)}`); }
  let from = 0; for (const w of skeleton) { const at = out.indexOf(w, from); if (at < 0) { fuzzLost += 1; break; } from = at + w.length; }
  if (presentText(out) !== out) fuzzNotIdem += 1;
}
check("D1 600 random sentences (~" + fuzzRefs + " references in 4 forms): no reference or id survives, in any of them", fuzzLeaks === 0, `${fuzzLeaks} leaks`);
check("D2 ...every non-reference word survives, in order (nothing else was deleted)", fuzzLost === 0, `${fuzzLost} sentences lost words`);
check("D3 ...and presenting twice changes nothing", fuzzNotIdem === 0, `${fuzzNotIdem} not idempotent`);

// ============================================================================================================ E. the real mapping layer (loaded through Vite SSR, as the app loads it)
console.log("\n# E. the real mapping layer");
const { createServer } = await import(pathToFileURL(path.join(FRONTEND, "node_modules", "vite", "dist", "node", "index.js")).href);
const vite = await createServer({ root: FRONTEND, configFile: path.join(FRONTEND, "vite.config.js"), server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom", logLevel: "silent", optimizeDeps: { noDiscovery: true, include: [] } });
try {
  const { mapIntelligenceAnalysis } = await vite.ssrLoadModule("/src/features/intelligence/intelligenceMapping.js");
  const { mapDashboardDetail, mapDecisionV1 } = await vite.ssrLoadModule("/src/features/dashboard/dashboardMapping.js");
  const RAW = {
    situation: `A maintenance signal indicates warm air (untrusted:signal:${OID_C}).`,
    evidence: [`The stay is checked_in (current:stay:${OID_A}).`, `Business knowledge 'Guest refuses entry' applies (knowledge:${OID_B}).`, `An earlier signal exists (history:signal:${OID_C}).`],
    impact: `Not established; see history:decision:${OID_C} and learning:inspection.`,
    recommendation: `Contact the guest as per 'Guest refuses entry' (knowledge:${OID_B}) and record the refusal (chunkId: ${OID_B}).`,
    confidence: "medium",
  };
  const PROV = [{ chunkId: OID_B, section: "Guest refuses entry", sectionPath: ["Guest refuses entry"], visibility: "guest", retrievalScore: 0.86 }];
  const view = { _id: "i1", workspaceId: "w1", signalIds: ["s1"], analysis: RAW, knowledgeProvenance: PROV, createdAt: "2026-10-05T10:00:00Z" };
  const page = mapIntelligenceAnalysis(view);
  check("E1 the INTELLIGENCE PAGE mapping: situation, every evidence item, impact and recommendation are free of internal references", [page.situation, ...page.evidence, page.impact, page.recommendation].every(strictlyClean), JSON.stringify(page.recommendation));
  check("E2 ...the confidence, the id of the analysis and the PROVENANCE (section titles, scores, chunk ids for the list key) are untouched", page.confidence === "medium" && page.id === "i1" && JSON.stringify(page.provenance) === JSON.stringify(PROV));
  check("E3 ...and the evidence list keeps its length and order", page.evidence.length === 3 && /checked_in/.test(page.evidence[0]) && /Guest refuses entry/.test(page.evidence[1]) && /earlier report/.test(page.evidence[2]) && !/signal/i.test(page.evidence[2])); // Phase 52: the user-facing word for the internal Signal is "report"
  const dash = mapDashboardDetail({ signal: { id: "s1", title: "t", type: "maintenance", severity: "medium", status: "new", source: "staff", occurredAt: "2026-10-05T09:00:00Z" }, observed: {}, intelligence: { id: "i1", situation: RAW.situation, evidence: RAW.evidence, impact: RAW.impact, recommendation: RAW.recommendation, confidence: "medium", createdAt: "2026-10-05T10:00:00Z", knowledgeProvenance: PROV } });
  check("E4 the DASHBOARD DETAIL mapping is clean too, and its provenance is intact", dash.analysis && [dash.analysis.situation, ...dash.analysis.evidence, dash.analysis.impact, dash.analysis.recommendation].every(strictlyClean) && JSON.stringify(dash.analysis.provenance) === JSON.stringify(PROV));
  const decision = mapDecisionV1({ _id: "d1", decisionVersion: "decision-v1", status: "proposed", priority: "medium", confidence: "medium", intelligenceId: "i1", description: RAW.recommendation, review: null });
  check("E5 the DECISION snapshot (a copy of the stored recommendation) is clean", strictlyClean(decision.description) && decision.status === "proposed", JSON.stringify(decision.description));
  const noteDecision = mapDecisionV1({ _id: "d2", decisionVersion: "decision-v1", status: "rejected", priority: "low", confidence: "low", description: "x", review: { reviewedAt: "2026-10-05T11:00:00Z", reviewNote: `Reviewer wrote: see knowledge:${OID_B} myself` } });
  check("E6 a REVIEWER'S OWN NOTE is a person's text and is left exactly as written", noteDecision.reviewNote === `Reviewer wrote: see knowledge:${OID_B} myself`);
  const clean = mapIntelligenceAnalysis({ _id: "i2", analysis: { situation: "Plain.", evidence: ["Plain evidence."], impact: "Plain impact.", recommendation: "Plain recommendation.", confidence: "high" }, knowledgeProvenance: [] });
  check("E7 an analysis whose prose has no references comes out IDENTICAL (same strings)", clean.situation === "Plain." && clean.evidence[0] === "Plain evidence." && clean.impact === "Plain impact." && clean.recommendation === "Plain recommendation.");
  const errMsg = presentText(`AI service returned an invalid analysis (claims[0] cites knowledge:${OID_C} which was not supplied).`);
  check("E8 a server error message that quotes a reference shows none", strictlyClean(errMsg), JSON.stringify(errMsg));
  const learnSrc = read(path.join(FRONTEND, "src", "features", "learning", "LearningBreakdown.jsx"));
  check("E9 (static) the Learning page's Decision and Action descriptions, which also carry AI-derived text, go through the presenter", /presentText\(action\.description\)/.test(learnSrc) && /presentText\(decision\.description\)/.test(learnSrc));
  // Phase 43C moved the generate / load state logic from the hook into signalIntelligenceController.js (the hook is a thin wrapper); the presenter call moved with it.
  const hookSrc = read(path.join(FRONTEND, "src", "features", "intelligence", "signalIntelligenceController.js"));
  // Phase 43D: stronger than "clean the server message": the server message is not shown at all - the error text is a fixed sentence chosen from the error's structured
  // fields (intelligenceErrorPresentation.js; validate-phase43d-error-presentation.mjs proves no raw code, reference or id can reach it).
  check("E10 (static) the generate path never shows the server's message (so it cannot carry a reference): the error text comes only from the fixed presenter", /presentGenerationFailure\(err\)/.test(hookSrc) && !/\berr\??\.message\b/.test(hookSrc.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")));
  const blockSrc = ["AnalysisBlock", "RecommendationBlock", "DecisionBlock", "ProvenanceList"].map((n) => read(path.join(FRONTEND, "src", "features", "dashboard", `${n}.jsx`))).join("\n");
  check("E11 (static) the display blocks do not render a reference, a chunk id or an object id: provenance shows only the section title, path, visibility and score", !/chunkId\}?<\/|\{p\.chunkId\}<|\{[a-zA-Z.]*(refId|evidenceRefs)/.test(blockSrc) && /p\.section \|\| "Untitled section"/.test(blockSrc));
} finally { await vite.close(); }

// ============================================================================================================ F. architecture intact
console.log("\n# F. architecture intact");
const SIG = `current:signal:${FIX.input.context.signal.id}`;
check("F1 Node's evidence envelope still holds the references (the presenter reads nothing from it and changes nothing in it)", ENV_ALL.has(SIG) && allRefs.length >= 10);
const claim = (claimType, text, ...sourceRefs) => ({ claimType, text, sourceRefs });
const okClaims = validateClaims([claim("FACT", "f", SIG), claim("RECOMMENDATION", "r", SIG)], ENV_ALL, { workspaceId: FIX.workspaceId, strict: true });
check("F2 the claim validator still ACCEPTS claims that cite real references, and returns them with their references intact", okClaims.length === 2 && okClaims[0].sourceRefs[0] === SIG);
let rejected = null; try { validateClaims([claim("FACT", "f", `current:signal:${"f".repeat(24)}`), claim("RECOMMENDATION", "r", SIG)], ENV_ALL, { workspaceId: FIX.workspaceId, strict: true }); } catch (e) { rejected = e; }
check("F3 an UNKNOWN / fabricated reference is STILL rejected (502 CLAIM_VALIDATION_FAILED, rule CLAIM_UNKNOWN_REF) - presenting prose never makes a reference valid", rejected?.statusCode === 502 && rejected.details?.code === CLAIM_VALIDATION_FAILED && rejected.details?.rule === "CLAIM_UNKNOWN_REF");
const fake = `current:stay:${"e".repeat(24)}`;
check("F4 ...while the same fake reference in PROSE is merely not displayed (display has no say in validity): the envelope does not hold it", !ENV_ALL.has(fake) && strictlyClean(presentText(`Check ${fake} now.`)));
const { toIntelligenceView } = await import("../src/services/intelligenceService.js");
const record = { _id: "64b0000000000000000000d1", workspaceId: "64b0000000000000000000d2", signalIds: ["64b0000000000000000000d3"], generatedBy: "llm", analysisVersion: "intelligence-v1", analysisLevel: "staff", analysis: { situation: RAW_PROSE(), evidence: [RAW_PROSE()], impact: RAW_PROSE(), recommendation: RAW_PROSE(), confidence: "medium" }, knowledgeProvenance: [{ chunkId: OID_B, section: "Guest refuses entry", sectionPath: ["Guest refuses entry"], visibility: "guest", retrievalScore: 0.86 }], evidenceRefs: [{ type: "knowledge", chunkId: OID_B }], createdAt: new Date("2026-10-05T10:00:00Z") };
function RAW_PROSE() { return `Act (knowledge:${OID_B}) on current:stay:${OID_A}.`; }
const apiView = toIntelligenceView(record);
// Phase 53D (deliberate supersession): this check used to assert that the server returned the stored prose WITH its references and left their removal to the browser. The stronger boundary now lives on
// the server (proseReferenceSanitizer.js; validate-phase53d-evidence-boundary.mjs): the public view never returns an internal reference in AI prose, while the STRUCTURED evidence references stay intact.
check("F5 PERSISTED / API (Phase 53D): the public Intelligence view returns the prose WITHOUT its references (the server-side boundary), keeps the structured evidence references, and the browser presenter finds nothing left to do", !/current:stay:|knowledge:/.test(apiView.analysis.recommendation) && !/current:stay:|knowledge:/.test(apiView.analysis.evidence[0]) && !JSON.stringify(apiView.analysis).includes(OID_A) && !JSON.stringify(apiView.analysis).includes(OID_B) && (apiView.evidenceRefs || []).length === 1 && presentText(apiView.analysis.recommendation) === apiView.analysis.recommendation);
const sourceFiles = (dir, exts) => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile() && exts.some((e) => d.name.endsWith(e))).map((d) => path.join(d.parentPath ?? d.path, d.name)).filter((p) => !/node_modules|\.venv|__pycache__/.test(p));
const importers = [...sourceFiles(path.join(BACKEND, "src"), [".js"]), ...sourceFiles(path.join(REPO, "ai-service", "app"), [".py"])].filter((p) => /intelligence\/presentation|presentation\.js|presentText/.test(read(p).replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$|^\s*#.*$/gm, ""))); // code only: a comment that NAMES the presenter (the Phase 53D sanitizer header) is not a use of it
check("F6 nothing in the backend or the AI service imports or uses the presenter: the validators, the envelope, the safety policy and the confidence ceiling never see presented text", importers.length === 0, importers.join(", ") || "none");
const presenterSrc = read(path.join(FRONTEND, "src", "features", "intelligence", "presentation.js"));
check("F7 the presenter is pure: no import, no fetch, no storage, no randomness, no DOM", !/^\s*import\s/m.test(presenterSrc) && !/fetch\(|localStorage|sessionStorage|document\.|window\.|Math\.random|Date\./.test(presenterSrc.replace(/\/\*[\s\S]*?\*\//g, "")));

console.log(`\nPhase 43A presentation validation: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
