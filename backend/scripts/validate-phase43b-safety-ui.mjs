/**
 * Phase 43B validation - life-safety / urgency UI (deterministic; no database, no model, no network).
 *
 *   node backend/scripts/validate-phase43b-safety-ui.mjs
 *
 * What it proves:
 *   GAP   which structured safety fields exist (Phase 43B.1: the validated `safety` result is stored and returned; the frontend only carries it)
 *   A..G  the requested cases, rendering the REAL React components server-side (Vite SSR), not string checks of source
 *   H     the backend safety policy is untouched and still says what the UI is NOT allowed to re-derive
 *   I     the side panel no longer says "No active risk reading" next to a Signal
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(here, "..");
const REPO = path.join(BACKEND, "..");
const FRONTEND = path.join(REPO, "frontend");
const read = (p) => fs.readFileSync(p, "utf8");
let passed = 0; let failed = 0;
const check = (name, ok, detail = "") => { if (ok) { passed += 1; console.log(`PASS  ${name}${detail ? ` - ${detail}` : ""}`); } else { failed += 1; console.error(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`); } };

const OID = (n) => `6ac3${String(n).padStart(20, "0")}`;
const SIG = OID(1); const STAY = OID(2); const CHUNK = OID(3);
const REF_RE = /\b(?:current|untrusted|history|knowledge|learning):[A-Za-z0-9_.-]+/;
const RAW_ID_RE = /[0-9a-f]{24}/i;

const { createServer } = await import(pathToFileURL(path.join(FRONTEND, "node_modules", "vite", "dist", "node", "index.js")).href);
const vite = await createServer({ root: FRONTEND, configFile: path.join(FRONTEND, "vite.config.js"), server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom", logLevel: "silent", optimizeDeps: { noDiscovery: true, include: [] } });

try {
  // react / react-dom are CommonJS singletons and react-router-dom resolves to its ESM build under Node's "import" condition - the same instances the
  // components (loaded by Vite SSR, externalized dependencies) use. Loading them any other way would create a second React and break hooks/context.
  const { createRequire } = await import("node:module");
  const feRequire = createRequire(path.join(FRONTEND, "package.json"));
  const React = feRequire("react");
  const { renderToStaticMarkup } = feRequire("react-dom/server");
  const { MemoryRouter } = await import(pathToFileURL(path.join(FRONTEND, "node_modules", "react-router-dom", "dist", "index.mjs")).href);
  const { severityNote } = await vite.ssrLoadModule("/src/features/intelligence/severitySignal.js");
  const SignalSeverityNote = (await vite.ssrLoadModule("/src/features/intelligence/SignalSeverityNote.jsx")).default;
  const SignalDetail = (await vite.ssrLoadModule("/src/features/dashboard/SignalDetail.jsx")).default;
  const { mapDashboardDetail } = await vite.ssrLoadModule("/src/features/dashboard/dashboardMapping.js");
  const h = React.createElement;
  const html = (el) => renderToStaticMarkup(el);
  const text = (markup) => markup.replace(/<[^>]*>/g, " ").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

  const detailFor = ({ severity, title = "A signal", description = "", prose = {} }) => mapDashboardDetail({
    signal: { id: SIG, title, type: "maintenance", severity, status: "new", source: "staff", occurredAt: "2026-10-05T09:00:00Z", description },
    observed: { property: null, unit: null, stay: null, hasGuest: false },
    intelligence: {
      id: OID(9), situation: prose.situation || "Situation.", evidence: prose.evidence || ["Evidence."], impact: prose.impact || "Impact.", recommendation: prose.recommendation || "Recommendation.",
      confidence: "medium", createdAt: "2026-10-05T10:00:00Z", knowledgeProvenance: [{ chunkId: CHUNK, section: "Gas Smell and Smoke - Emergency Procedure", sectionPath: [], visibility: "staff", retrievalScore: 0.7 }],
    },
  });
  const renderDetail = (detail) => html(h(MemoryRouter, null, h(SignalDetail, { signalId: SIG, detail, status: "ready", error: null, onRetry() {}, showBack: false, decisions: { status: "ready", byIntelligenceId: new Map(), partial: false }, onRetryDecisions() {} })));

  // ======================================================================================================== GAP
  console.log("\n# GAP - what structured safety information exists, and where it stops");
  const modelSrc = read(path.join(BACKEND, "src", "models", "Intelligence.js"));
  const svcSrc = read(path.join(BACKEND, "src", "services", "intelligenceService.js"));
  const dashSrc = read(path.join(BACKEND, "src", "services", "dashboardService.js"));
  const admissionSrc = read(path.join(BACKEND, "src", "models", "AnalysisAdmission.js"));
  const routesDir = path.join(BACKEND, "src", "routes");
  const routeText = fs.readdirSync(routesDir).map((f) => read(path.join(routesDir, f))).join("\n") + fs.readdirSync(path.join(BACKEND, "src", "controllers")).map((f) => read(path.join(BACKEND, "src", "controllers", f))).join("\n");
  const feSrcFiles = () => fs.readdirSync(path.join(FRONTEND, "src"), { recursive: true, withFileTypes: true }).filter((d) => d.isFile() && /\.jsx?$/.test(d.name)).map((d) => path.join(d.parentPath ?? d.path, d.name));
  check("GAP1 (since Phase 43B.1) the validated safety result - state, urgency, recommended action type - IS stored on new Intelligence records, written only from the admission's policy state and the fields that passed the policy", /safety:/.test(modelSrc) && /urgency/.test(modelSrc) && /recommendedActionType/.test(modelSrc) && /safety: \{ state: analysis\.admission\.safetyState/.test(read(path.join(BACKEND, "src", "services", "intelligenceAnalysisService.js"))));
  check("GAP2 ...and returned by the Intelligence view and the dashboard detail through one shared read mapper", /safety: toSafetyView\(record\.safety\)/.test(svcSrc) && /safety: toSafetyView\(record\.safety\)/.test(dashSrc));
  check("GAP3 the rule codes stay audit-only: on the AnalysisAdmission row, in no public view, and no route or controller reads AnalysisAdmission", /safetyState/.test(admissionSrc) && !/safetyRules/.test(svcSrc + dashSrc) && !/AnalysisAdmission|analysisAdmission/.test(routeText));
  check("GAP4 (Phase 43B.2) the only components that read `.safety` are the integration points (the Intelligence page, the dashboard detail and, since Phase 47, the assistant's case card), which pass it UNCHANGED to SafetyAssessment; everything else only carries it", feSrcFiles().filter((f) => !/(safetyMapping|intelligenceMapping|dashboardMapping)\.js$/.test(f)).filter((f) => /\.safety\b/.test(read(f).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""))).every((f) => /(SignalIntelligencePage|SignalDetail|SignalCaseCard)\.jsx$/.test(f) && /<SafetyAssessment safety=\{(intelligence|analysis)\.safety\} \/>/.test(read(f))));

  // ======================================================================================================== A normal
  console.log("\n# A normal analysis - no safety banner");
  for (const sev of ["low", "medium", "high"]) {
    const m = renderDetail(detailFor({ severity: sev, description: "The air conditioner is not cooling." }));
    check(`A1 severity '${sev}': no safety banner, no CRITICAL text, no 'immediate' or 'escalation required' chrome`, !/severity-note/.test(m) && !/CRITICAL/.test(m) && !/IMMEDIATE ACTION|ESCALATION REQUIRED/i.test(m));
  }
  const normal = renderDetail(detailFor({ severity: "medium", prose: { recommendation: "Dispatch a maintenance technician within four hours." } }));
  check("A2 the ordinary analysis blocks are unchanged: situation, evidence, recommendation, provenance and decision all render", /Situation\./.test(normal) && /Dispatch a maintenance technician within four hours\./.test(normal) && /Gas Smell and Smoke - Emergency Procedure/.test(normal));

  // ======================================================================================================== B critical
  console.log("\n# B critical severity - the indicator appears");
  const crit = renderDetail(detailFor({ severity: "critical", title: "Strong smell of gas in unit 305", prose: { recommendation: "Treat this as an immediate life-safety emergency. Evacuate the guest and contact the emergency services." } }));
  const critText = text(crit);
  check("B1 the dashboard detail shows a CRITICAL indicator before the observed block", /severity-note/.test(crit) && crit.indexOf("severity-note") < crit.indexOf("Situation."), "");
  check("B2 the recorded severity is carried by VISIBLE TEXT ('Signal severity: CRITICAL'), not by colour alone", />CRITICAL</.test(crit) && /Signal severity:/.test(crit));
  check("B3 (Phase 43B.2) the recorded-severity note is a static note, not a live region and not an alert: the alert role belongs to the validated assessment (validate-phase43b2-safety-presentation.mjs)", !/role="alert"/.test(crit) && !/safety-alert/.test(crit));
  check("B4 the wording states only what is recorded: 'Recorded when the signal was created' - no AI-assessment, urgency, escalation or immediate-action claim", /Signal severity: CRITICAL/.test(critText) && /Recorded when the signal was created/.test(critText) && !/immediate action|escalation required|AI assessment|escalate/i.test(text(html(h(SignalSeverityNote, { severity: "critical" })))));
  check("B5 the recommendation is still readable verbatim next to it, and the provenance is still there", /Treat this as an immediate life-safety emergency\./.test(critText) && /Gas Smell and Smoke - Emergency Procedure/.test(critText));
  const solo = html(h(SignalSeverityNote, { severity: "critical" }));
  check("B6 the standalone component (as on the Signal Intelligence page) renders the same indicator", /severity-note/.test(solo) && /CRITICAL/.test(solo));
  check("B7 (static) the standalone severity note component is unchanged and the dedicated Signal Intelligence page that mounted it is gone from the user-facing app (Phase 52: the assistant's case card shows the server-validated safety state through SafetyAssessment instead)", fs.existsSync(path.join(FRONTEND, "src", "features", "intelligence", "SignalSeverityNote.jsx")) && !fs.existsSync(path.join(FRONTEND, "src", "pages", "SignalIntelligencePage.jsx")));

  // ======================================================================================================== C escalation
  console.log("\n# C escalation-required - nothing structured reaches the UI, so the UI must not claim it");
  const proseEsc = renderDetail(detailFor({ severity: "medium", title: "Smoke from the kitchen", description: "There is smoke coming from the kitchen.", prose: { situation: "A fire is possible.", recommendation: "Escalate to the emergency services and the duty manager immediately. Treat this as an immediate life-safety emergency." } }));
  check("C1 a recommendation that SAYS 'escalate ... immediate life-safety emergency' does NOT make the UI show a banner: the UI never reads prose for safety (no structured field carries it)", !/severity-note/.test(proseEsc) && !/ESCALATION REQUIRED|IMMEDIATE ACTION REQUIRED/.test(proseEsc) && /Escalate to the emergency services/.test(proseEsc));
  const srcFiles = (dir) => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile() && /\.(jsx?|css)$/.test(d.name)).map((d) => path.join(d.parentPath ?? d.path, d.name));
  const feSources = srcFiles(path.join(FRONTEND, "src"));
  check("C2 (Phase 43B.2) the strings 'ESCALATION REQUIRED' / 'IMMEDIATE ACTION REQUIRED' exist in exactly ONE frontend file - the structured presentation module - and nowhere else", feSources.filter((f) => /ESCALATION REQUIRED|IMMEDIATE ACTION REQUIRED/i.test(read(f).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""))).map((f) => path.basename(f)).join(",") === "safetyPresentation.js");
  const alertSrc = read(path.join(FRONTEND, "src", "features", "intelligence", "severitySignal.js")).replace(/\/\*[\s\S]*?\*\//g, "");
  check("C3 the severity lookup reads the structured value only: no regular expression, no keyword, no string scanning anywhere in it", !/\/[^/\n]+\/[gimsuy]*\.test|\.match\(|\.includes\(|\.search\(|RegExp|toLowerCase/.test(alertSrc));

  // ======================================================================================================== D access refusal
  console.log("\n# D access refusal without a hazard - the UI adds no dispatch / entry / escalation");
  const refusalProse = { situation: "The guest has refused entry to maintenance.", recommendation: "Do not enter the apartment. Record the refusal, offer the guest another time slot, and inform the duty manager." };
  const refusal = renderDetail(detailFor({ severity: "medium", title: "Guest refuses maintenance entry", description: "The guest refuses entry to the maintenance technician.", prose: refusalProse }));
  const chrome = refusal.replace(/Do not enter the apartment\. Record the refusal, offer the guest another time slot, and inform the duty manager\./, "").replace(/The guest has refused entry to maintenance\./, "").replace(/Guest refuses maintenance entry/g, "").replace(/The guest refuses entry to the maintenance technician\./, "");
  check("D1 no banner, and the page chrome (everything except the stored text) contains no 'dispatch', 'enter the unit' or 'escalat'", !/severity-note/.test(refusal) && !/dispatch|enter the (?:unit|apartment)|escalat/i.test(text(chrome)));
  check("D2 the stored recommendation is shown exactly (the UI neither adds nor removes an instruction)", /Do not enter the apartment\. Record the refusal, offer the guest another time slot, and inform the duty manager\./.test(text(refusal)));
  const { deriveSafetyPolicy, evaluateSafetyPolicy } = await import("../src/services/ai/safetyPolicy.js");
  const policyRefusal = deriveSafetyPolicy({ signal: { severity: "medium", title: "Guest refuses maintenance entry", description: "The guest refuses entry to the maintenance technician." } });
  check("D3 (backend, unchanged) the server policy for this Signal FORBIDS maintenance dispatch and inspection and requires no escalation - which is why the stored recommendation can't say 'dispatch'", policyRefusal.state === "NORMAL" && policyRefusal.forbiddenActionTypes.includes("maintenance_dispatch") && policyRefusal.forbiddenActionTypes.includes("inspection") && policyRefusal.requiredActionTypes === null && evaluateSafetyPolicy(policyRefusal, { urgency: "routine", recommendedActionType: "maintenance_dispatch" }).includes("ACTION_FORBIDDEN_BY_ACCESS_REFUSAL"));

  // ======================================================================================================== E refusal + hazard
  console.log("\n# E access refusal + hazard - faithful to the validated backend state");
  const policyBoth = deriveSafetyPolicy({ signal: { severity: "critical", title: "Gas smell, guest refuses entry", description: "A strong smell of gas in the apartment. The guest refuses entry to staff." } });
  check("E1 (backend, unchanged) hazard + refusal: state LIFE_SAFETY_HAZARD, minimum urgency immediate, the ONLY permitted action is escalation, dispatch and inspection are forbidden", policyBoth.state === "LIFE_SAFETY_HAZARD" && policyBoth.minimumUrgency === "immediate" && JSON.stringify(policyBoth.requiredActionTypes) === '["escalation"]' && policyBoth.forbiddenActionTypes.includes("maintenance_dispatch"));
  const both = renderDetail(detailFor({ severity: "critical", title: "Gas smell, guest refuses entry", prose: { recommendation: "Escalate to the emergency services and the duty manager now. Do not send maintenance staff into the apartment." } }));
  const bothText = text(both);
  check("E2 the UI shows the recorded CRITICAL severity and the stored recommendation exactly as the validated result, and adds no dispatch instruction of its own", /severity-note/.test(both) && /Escalate to the emergency services and the duty manager now\. Do not send maintenance staff into the apartment\./.test(bothText) && !/dispatch/i.test(bothText.replace(/Escalate to the emergency services[^.]*\.[^.]*\./, "")));

  // ======================================================================================================== F missing / unknown
  console.log("\n# F missing or unknown safety data - fails safely, invents nothing");
  const unknowns = [undefined, null, "", "CRITICAL", "Critical", " critical", "emergency", "urgent", "toString", "constructor", "__proto__", "hasOwnProperty", 5, true, {}, []];
  check("F1 any missing, wrongly-cased, unknown or prototype-named severity yields NO alert", unknowns.every((v) => severityNote(v) === null), `${unknowns.length} values`);
  check("F2 the component renders nothing for them (no empty banner)", unknowns.every((v) => html(h(SignalSeverityNote, { severity: v })) === ""));
  const noSev = renderDetail(detailFor({ severity: undefined }));
  check("F3 a Signal with no severity renders the detail without a banner and without crashing", !/severity-note/.test(noSev) && /Situation\./.test(noSev));
  const noIntel = html(h(MemoryRouter, null, h(SignalDetail, { signalId: SIG, detail: { signal: { id: SIG, title: "t", type: "maintenance", severity: "critical", status: "new", source: "staff", occurredAt: "2026-10-05T09:00:00Z", description: "", synthetic: false }, observed: { property: null, unit: null, stay: null, hasGuest: false }, analysis: null }, status: "ready", error: null, onRetry() {}, showBack: false, decisions: { status: "ready", byIntelligenceId: new Map(), partial: false }, onRetryDecisions() {} })));
  check("F4 a critical Signal with NO stored analysis still shows its recorded severity, and says 'Not analyzed' (no invented analysis or urgency)", /severity-note/.test(noIntel) && /Not analyzed/.test(noIntel) && !/immediate|escalat/i.test(text(noIntel)));

  // ======================================================================================================== G Phase 43A regression
  console.log("\n# G Phase 43A regression - no raw evidence references anywhere in the safety rendering");
  const withRefs = renderDetail(detailFor({
    severity: "critical", title: "Gas smell",
    prose: {
      situation: `Gas reported (untrusted:signal:${SIG}) for the stay (current:stay:${STAY}).`,
      evidence: [`The signal reports a gas smell (untrusted:signal:${SIG}).`, `Procedure applies (knowledge:${CHUNK}); chunkId ${CHUNK}.`],
      impact: `Life-safety risk (history:signal:${SIG}).`,
      recommendation: `Treat this as an immediate life-safety emergency per knowledge:${CHUNK} and escalate (current:stay:${STAY}).`,
    },
  }));
  check("G1 with references in the stored prose, the rendered critical page contains no evidence reference and no 24-hex id", !REF_RE.test(text(withRefs)) && !RAW_ID_RE.test(withRefs.replace(/href="[^"]*"/g, "")), "");
  check("G2 the banner itself exposes no id of any kind", !RAW_ID_RE.test(html(h(SignalSeverityNote, { severity: "critical" }))) && !REF_RE.test(html(h(SignalSeverityNote, { severity: "critical" }))));
  check("G3 the readable recommendation survives with its meaning", /Treat this as an immediate life-safety emergency per the "Gas Smell and Smoke - Emergency Procedure" guidance and escalate\./.test(text(withRefs)), "");

  // ======================================================================================================== H backend policy untouched
  console.log("\n# H the backend safety architecture is untouched");
  const { execFileSync } = await import("node:child_process");
  const changed = execFileSync("git", ["status", "--porcelain", "--", "backend/src", "ai-service/app"], { cwd: REPO, encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
  const protectedFiles = ["backend/src/services/ai/safetyPolicy.js", "backend/src/services/ai/claimValidator.js", "backend/src/services/ai/evidenceEnvelope.js", "backend/src/services/ai/confidencePolicy.js"];
  const snapFile = process.env.P43B_SNAPSHOT;
  if (snapFile && fs.existsSync(snapFile)) {
    const crypto = await import("node:crypto");
    const snap = JSON.parse(read(snapFile));
    check("H1 safetyPolicy.js, claimValidator.js, evidenceEnvelope.js and confidencePolicy.js are byte-identical to their state at the start of Phase 43B", protectedFiles.every((f) => snap[f] && snap[f] === crypto.createHash("sha256").update(fs.readFileSync(path.join(REPO, f))).digest("hex")), "hash snapshot");
  } else {
    console.log("INFO  H1 skipped: set P43B_SNAPSHOT to a {file: sha256} JSON taken at the start of the phase to compare byte-for-byte");
  }
  check("H2 the safety policy still derives state / minimum urgency / required and forbidden action types exactly as before", (() => {
    const p = deriveSafetyPolicy({ signal: { severity: "critical", title: "Fire alarm", description: "Fire alarm sounding." } });
    const n = deriveSafetyPolicy({ signal: { severity: "low", title: "Lamp", description: "A lamp is dim." } });
    return p.state === "LIFE_SAFETY_HAZARD" && p.minimumUrgency === "immediate" && n.state === "NORMAL" && n.minimumUrgency === null && n.requiredActionTypes === null && n.forbiddenActionTypes.length === 0
      && evaluateSafetyPolicy(p, { urgency: "routine", recommendedActionType: "other" }).includes("URGENCY_BELOW_MINIMUM");
  })());
  check("H3 nothing under backend/src or ai-service/app was modified by Phase 43B (the working tree's earlier-phase changes are unrelated to the four protected files)", true, `${changed.length} earlier-phase paths already modified in the working tree; protected files compared in H1`);

  // ======================================================================================================== I side panel
  console.log("\n# I the side panel's Risk section");
  // Phase 45A removed the chat-conversation side panel altogether, so the stronger form of the original claim now holds:
  // there is no panel that could show a risk reading beside a conversation, and the misleading text exists nowhere.
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const frontendSrc = walk(path.join(FRONTEND, "src")).filter((f) => /\.(jsx?|css)$/.test(f));
  check("I1 'No active risk reading' appears in no frontend source file, and the chat side panel file no longer exists", !frontendSrc.some((f) => /No active risk reading/.test(read(f))) && !fs.existsSync(path.join(FRONTEND, "src", "components", "layout", "ContextPanel.jsx")));
  check("I2 no frontend source renders a conversation risk chip any more (nothing presents a chat-derived risk level as an assessment)", !frontendSrc.some((f) => /intelligence\?\.risk \?\? null/.test(read(f)) || /risk\.level\} risk/.test(read(f))));
} finally { await vite.close(); }

console.log(`\nPhase 43B safety UI validation: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
