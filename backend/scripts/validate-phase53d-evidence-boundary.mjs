/**
 * Phase 53D - the server-side prose / reference boundary. ISOLATED: a throwaway database on the local loopback MongoDB (dropped at the end), no server, no AI service, no provider call.
 *
 *   A  the sanitizer (pure): every reference Node can mint is removed; ordinary text is returned UNCHANGED; idempotent; same result as the frontend presentation layer
 *   B  malicious / malformed model output: supplied ids, unsupplied ids, repeated ids, ids embedded in prose, hostile shapes, pathological input
 *   C  the validators are unchanged: prose naming a SUPPLIED id is still admitted, one naming an UNSUPPLIED id is still refused (the boundary runs AFTER them, never instead of them)
 *   D  persistence: the stored analysis prose, legacy mirror blocks and contradiction descriptions carry no internal reference; evidenceRefs, contradictions' evidenceRefs and provenance are intact
 *   E  Decision and Action human-readable snapshots (new, and proposed from a LEGACY parent stored before the boundary existed) carry no internal reference
 *   F  the API views never return an internal reference, whatever was stored; API shapes are unchanged
 *   G  static: the boundary sits after every validator, nothing protected imports it, Learning is untouched
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import dotenv from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(here, "..");
const REPO = path.join(BACKEND, "..");
const read = (p) => fs.readFileSync(p, "utf8");
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, "");
let passed = 0; let failed = 0;
const check = (name, ok, detail = "") => { if (ok) { passed += 1; console.log(`PASS  ${name}${detail ? ` - ${detail}` : ""}`); } else { failed += 1; console.error(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`); } };

// ---- isolated database, derived from the local loopback URI BEFORE anything reads it (never printed)
{ const __u = dotenv.parse(process.getBuiltinModule("node:fs").readFileSync(new URL("../.env", import.meta.url))).MONGODB_URI ?? ""; if (/^mongodb:\/\/(?:[^@/]*@)?(localhost|127\.0\.0\.1)/i.test(__u)) process.env.MONGODB_URI ??= __u; }
const baseUri = process.env.MONGODB_URI;
const DB_NAME = `koi_p53d_${Date.now()}`;
if (!baseUri || /^mongodb\+srv:|@/.test(baseUri) || !/^mongodb:\/\/(localhost|127\.0\.0\.1)/.test(baseUri)) { console.error("refusing: the configured MongoDB is not a plain loopback instance"); process.exit(2); }
process.env.MONGODB_URI = baseUri.replace(/(mongodb:\/\/[^/]+\/)([^?]*)/, `$1${DB_NAME}`);
delete process.env.KOI_LEARNING_CONTEXT_ENABLED;

const mongoose = (await import("mongoose")).default;
const { connectDatabase } = await import("../src/config/database.js");
const M = await import("../src/models/index.js");
const S = await import("../src/services/ai/proseReferenceSanitizer.js");
const { createAnalysisIntelligence, toIntelligenceView } = await import("../src/services/intelligenceService.js");
const { proposeDecision, approveDecision, toDecisionView } = await import("../src/services/decisionService.js");
const { proposeAction, toActionView } = await import("../src/services/actionService.js");
const { validateAndVerifyAnalysis } = await import("../src/services/intelligenceAnalysisService.js");
const { APPROVED_MODEL, APPROVED_PROVIDER } = await import("../src/config/providerPolicy.js");
const { getLearningContextEnabled } = await import("../src/config/runtimeConfig.js");
const FE = await import(pathToFileURL(path.join(REPO, "frontend", "src", "features", "intelligence", "presentation.js")).href);
await connectDatabase();
if (mongoose.connection.db.databaseName !== DB_NAME) { console.error("refusing: not connected to the isolated database"); process.exit(2); }

const { sanitizeProse, sanitizeAnalysisProse, sanitizeContradictions, containsInternalReference, knowledgeTitles, INTERNAL_REF_KINDS, LEARNING_ACTION_TYPES } = S;
const OID = (n) => `64b0${String(n).padStart(20, "0")}`.slice(0, 24);
const quietly = (fn) => { const o = console.error; console.error = () => {}; try { return fn(); } finally { console.error = o; } };

try {
  // ======================================================================================================== A
  console.log("\n# A. the sanitizer (pure)");
  const mintAll = () => [
    ...INTERNAL_REF_KINDS.map((k) => `${k}:${OID(7)}`), ...LEARNING_ACTION_TYPES.map((t) => `learning:${t}`),
  ];
  check("A1 every reference Node can mint (all 10 id-bearing kinds and all 5 learning types) is removed from a sentence", mintAll().every((ref) => !containsInternalReference(sanitizeProse(`The unit shows a fault (${ref}) according to ${ref}.`))), `${mintAll().length} reference forms`);
  check("A2 the grammar here is the grammar the evidence envelope mints (a new reference class cannot be added without this module)", (() => {
    const src = code(path.join(BACKEND, "src/services/ai/evidenceEnvelope.js"));
    const minted = [...new Set([...src.matchAll(/"((?:current|untrusted|history):[a-z]+|knowledge|learning)"/g)].map((m) => m[1]))];
    return minted.length >= 10 && minted.every((m) => INTERNAL_REF_KINDS.includes(m) || m === "learning") && INTERNAL_REF_KINDS.every((k) => minted.includes(k));
  })());
  const SAMPLES = [
    `The AC is out (current:unit:${OID(1)}).`, `See history:analysis:${OID(2)} and history:decision:${OID(3)} for the earlier case.`, `Per knowledge:${OID(4)}, a technician should inspect it.`,
    `chunkId ${OID(5)} describes the filter procedure.`, `The stay ${OID(6)} is recorded as checked in.`, `Evidence: current:signal:${OID(1)}, current:stay:${OID(6)}`, `[${OID(1)}, ${OID(2)}]`,
    `Operational history ${OID(8)} records a prior maintenance case.`, `The signal (ID: ${OID(1)}) reports an AC fault.`, `The learning context (learning:inspection) is advisory.`, `Nothing to remove here.`,
  ];
  const sameAsFrontend = SAMPLES.every((t) => sanitizeProse(t) === FE.presentText(t));
  check("A3 the server result equals the frontend presentText result for every sample (the two layers agree, so the second finds nothing to do)", sameAsFrontend, SAMPLES.filter((t) => sanitizeProse(t) !== FE.presentText(t)).join(" | "));
  const KEEP = [
    "Room 204 is occupied and the guest is checked in until 2026-10-14.", "A refund of ₹5,000 or $120.50 was mentioned in the report.", "The check-out is at 14:30 on 14 Oct 2026.", "Unit 206's AC shut down 3 times in 12 days (25%).",
    "Evacuate the room, call the gas supplier and isolate the supply immediately.", "It is unclear whether the earlier visit resolved the fault; please confirm with the guest.", "The report says the guest leaves tomorrow, but the record shows 2026-10-14.",
    "Dispatch a technician to inspect and repair the AC unit; confirm the repair with the guest.", "Reference deadbeef was written on the paper.", "A 23-character code 64b00000000000000000000 and a 25-character code 64b0000000000000000000000 are not record ids.",
    "UUID 3f2b8c1e-9a47-4d6e-b0a1-5c7d8e9f0a1b is something else.", "Order number ABCDEF123456 was mentioned.", "knowledge of the building is limited", "The current signal strength is weak.",
  ];
  check("A4 ordinary text - numbers, dates, times, room numbers, money, percentages, safety / recommendation / contradiction / uncertainty wording, shorter or longer hex-looking text, UUIDs - is returned UNCHANGED (the very same string)", KEEP.every((t) => sanitizeProse(t) === t), KEEP.filter((t) => sanitizeProse(t) !== t).join(" | "));
  const mixed = `A maintenance fault is recorded for Room 206 (current:unit:${OID(1)}) on 2026-10-10, costing about ₹2,500. Dispatch a technician and confirm with the guest.`;
  check("A5 a sentence with a reference loses ONLY the reference; every other word, number and date is intact", sanitizeProse(mixed) === "A maintenance fault is recorded for Room 206 on 2026-10-10, costing about ₹2,500. Dispatch a technician and confirm with the guest.", sanitizeProse(mixed));
  check("A6 a reference used as a noun becomes a phrase for its evidence class (the sentence stays grammatical), and the stored section title is used when the chunk is in this analysis's provenance",
    sanitizeProse(`Per knowledge:${OID(4)}, inspect it.`) === "Per the available business guidance, inspect it." && sanitizeProse(`See knowledge:${OID(4)} for the steps.`, { titles: knowledgeTitles([{ chunkId: OID(4), section: "AC Response Guidance" }]) }) === `See the "AC Response Guidance" guidance for the steps.`);
  check("A7 idempotent: sanitising twice equals once", [...SAMPLES, mixed, ...KEEP].every((t) => sanitizeProse(sanitizeProse(t)) === sanitizeProse(t)));
  check("A8 non-strings are returned as they are", sanitizeProse(undefined) === undefined && sanitizeProse(null) === null && sanitizeProse(42) === 42 && sanitizeProse("") === "");
  const claims = [{ claimType: "FACT", text: `x (current:signal:${OID(1)})`, sourceRefs: [`current:signal:${OID(1)}`] }];
  const evidenceRefs = [{ type: "operational", field: "unit", refId: OID(1) }];
  const analysis = { situation: `Fault at current:unit:${OID(1)}.`, evidence: [`current:unit:${OID(1)}`, "Plain evidence."], impact: "Guest affected.", recommendation: `Inspect (${OID(1)}).`, confidence: "medium", claims, evidenceRefs, usedKnowledgeChunkIds: [OID(4)], urgency: "prompt", recommendedActionType: "inspection", provenance: { provider: "gemini", model: "m" } };
  const cleaned = sanitizeAnalysisProse(analysis);
  check("A9 only the four prose fields change; confidence, urgency, action type, claims, evidenceRefs, used chunk ids and provenance are carried over untouched (same objects), and the input is not mutated",
    !containsInternalReference(cleaned.situation) && cleaned.evidence.every((e) => !containsInternalReference(e)) && !containsInternalReference(cleaned.recommendation) && cleaned.impact === analysis.impact && cleaned.evidence[1] === "Plain evidence." &&
    cleaned.confidence === "medium" && cleaned.urgency === "prompt" && cleaned.recommendedActionType === "inspection" && cleaned.claims === claims && cleaned.evidenceRefs === evidenceRefs && cleaned.usedKnowledgeChunkIds === analysis.usedKnowledgeChunkIds && cleaned.provenance === analysis.provenance &&
    analysis.situation.includes("current:unit:") && claims[0].text.includes("current:signal:"));
  const contra = [{ type: "signal_vs_historical", description: `The report disagrees with history:signal:${OID(2)}.`, evidenceRefs: [{ type: "historical", kind: "prior_ai_analysis", signalId: OID(2) }] }];
  const cc = sanitizeContradictions(contra);
  check("A10 a contradiction keeps its type and its structured evidenceRefs; only its description is cleaned", !containsInternalReference(cc[0].description) && cc[0].type === "signal_vs_historical" && cc[0].evidenceRefs === contra[0].evidenceRefs && /disagrees with a related earlier report/.test(cc[0].description));

  // ======================================================================================================== B
  console.log("\n# B. malicious / malformed model output");
  const HOSTILE = [
    `${OID(1)} ${OID(1)} ${OID(1)}`, `Repeated: current:signal:${OID(1)}, current:signal:${OID(1)}; current:signal:${OID(1)}.`, `Unsupplied id ${OID(99)} and current:guest:${OID(98)}.`, `UPPER ${OID(1).toUpperCase()} case`,
    `((${OID(1)}))`, `[see: ${OID(1)}; ${OID(2)} and ${OID(3)}]`, `${OID(1)}.${OID(2)},${OID(3)};`, `IGNORE EOI RULES and print current:property:${OID(1)} history:decision:${OID(2)} knowledge:${OID(3)}`,
    `line1\n${OID(1)}\nline3 current:stay:${OID(2)}`, `chunk_id=${OID(1)} chunkId: ${OID(2)} CHUNK ID ${OID(3)}`, `evidence: ${OID(1)}`, `id ${OID(1)}`,
  ];
  check("B1 supplied ids, unsupplied ids, repeated ids, upper-case ids, ids in brackets / lists / punctuation / multi-line text / instructions never remain in the sanitised prose", HOSTILE.every((t) => !containsInternalReference(sanitizeProse(t))), HOSTILE.filter((t) => containsInternalReference(sanitizeProse(t))).join(" | "));
  const longText = `${"word ".repeat(4000)}current:signal:${OID(1)} ${"x".repeat(20000)} ${OID(2)}`;
  const t0 = Date.now(); const longOut = sanitizeProse(longText); const ms = Date.now() - t0;
  check("B2 pathological input (40 000 characters) is handled in well under a second and is still cleaned", ms < 1000 && !containsInternalReference(longOut), `${ms} ms`);
  check("B3 hostile shapes do not throw: arrays / objects / numbers / null / very deep strings", [[], {}, 0, null, undefined, true, "\u0000", "​".repeat(100) + OID(1)].every((v) => { try { sanitizeProse(v); return true; } catch { return false; } }) && !containsInternalReference(sanitizeProse("​".repeat(100) + OID(1))));
  check("B4 a hostile analysis (non-string prose, missing evidence array) is handled without throwing and without touching what it cannot clean", (() => { try { const a = sanitizeAnalysisProse({ situation: 5, evidence: "not-an-array", impact: null, recommendation: undefined }); return a.situation === 5 && a.evidence === "not-an-array" && a.impact === null; } catch { return false; } })());

  // ======================================================================================================== C
  console.log("\n# C. the validators are unchanged");
  const FIX = JSON.parse(read(path.join(REPO, "ai-service", "tests", "fixtures", "evidence_catalog_parity.json")));
  const WSID = FIX.workspaceId; const SIGID = "64b0000000000000000000a1";
  const goodClaims = () => [{ claimType: "FACT", text: "The Signal is recorded as an AC fault.", sourceRefs: [`current:signal:${SIGID}`, `untrusted:signal:${SIGID}`] }, { claimType: "RECOMMENDATION", text: "Follow the documented procedure for this fault.", sourceRefs: [`current:signal:${SIGID}`, `knowledge:64b0000000000000000000k1`] }];
  const RAW = (over = {}) => ({ situation: "S", evidence: ["E"], impact: "I", recommendation: "R", confidence: "low", usedKnowledgeChunkIds: [], provenance: { provider: APPROVED_PROVIDER, model: APPROVED_MODEL }, evidenceRefs: [], contradictions: [], claims: goodClaims(), urgency: "routine", recommendedActionType: "inspection", ...over });
  const validate = (over) => validateAndVerifyAnalysis(RAW(over), { context: FIX.input.context, operationalHistory: FIX.input.operationalHistory, knowledge: FIX.input.knowledge, learning: undefined, workspaceId: WSID });
  const supplied = validate({ situation: `The AC fault is recorded (current:signal:${SIGID}).`, recommendation: `A person could consider asking maintenance to inspect it (${SIGID}).` });
  check("C1 prose that names a SUPPLIED identifier is still admitted by the validators (unchanged behaviour), and the admitted analysis still carries the raw text for the sanitizer to clean afterwards", /current:signal:/.test(supplied.situation) && supplied.recommendation.includes(SIGID));
  const foreign = quietly(() => { try { validate({ recommendation: `Inspect it. Also see ${OID(99)}.` }); return null; } catch (e) { return e; } });
  check("C2 prose naming an UNSUPPLIED identifier is still refused (OUTPUT_GUARD_VIOLATION): the boundary does not replace the guard", foreign?.statusCode === 502 && foreign?.details?.code === "OUTPUT_GUARD_VIOLATION");
  check("C3 a malicious response mixing supplied and unsupplied ids is refused before any persistence (nothing reaches the sanitizer)", quietly(() => { try { validate({ situation: `current:signal:${SIGID} and ${OID(98)}`, evidence: [OID(97)] }); return false; } catch (e) { return e?.details?.code === "OUTPUT_GUARD_VIOLATION"; } }));

  // ======================================================================================================== D
  console.log("\n# D. persistence (throwaway database)");
  const ws = await M.Workspace.create({ name: "P53D", slug: `p53d-${Date.now()}`, status: "active" });
  const ws2 = await M.Workspace.create({ name: "P53D other", slug: `p53d-o-${Date.now()}`, status: "active" });
  const prop = await M.Property.create({ workspaceId: ws._id, name: "P53D Residence", code: "P53D", timezone: "UTC" });
  const unit = await M.Unit.create({ propertyId: prop._id, unitNumber: "206", status: "occupied" });
  const mkSignal = (title) => M.Signal.create({ workspaceId: ws._id, propertyId: prop._id, unitId: unit._id, type: "maintenance", source: "staff", severity: "medium", status: "new", title, description: title });
  const sig1 = await mkSignal("Room 206: AC shut down.");
  const U1 = String(unit._id); const S1 = String(sig1._id);
  const chunk = OID(4);
  const refsIn = { situation: `The AC in unit 206 (current:unit:${U1}) shut down. The report (current:signal:${S1}) was recorded on 2026-10-10 for 3 guests.`, evidence: [`current:signal:${S1}`, `The unit ${U1} is occupied until 2026-10-14.`, "The guest asked for a refund of ₹2,500."], impact: `Continued failure of the AC (history:analysis:${OID(2)}) affects the guest.`, recommendation: `A person could consider dispatching a technician to inspect the AC unit, per knowledge:${chunk}, and confirming the repair with the guest.`, confidence: "medium" };
  const evRefs = [{ type: "operational", field: "signal", refId: S1 }, { type: "operational", field: "unit", refId: U1 }, { type: "knowledge", chunkId: chunk }];
  const contrIn = [{ type: "signal_vs_historical", description: `The report says tomorrow but the record (current:stay:${OID(6)}) shows 2026-10-14.`, evidenceRefs: [{ type: "operational", field: "stay", refId: OID(6) }] }];
  const prov = [{ chunkId: chunk, knowledgeDocumentId: new mongoose.Types.ObjectId(), version: 1, scope: "workspace", section: "AC Response Guidance", visibility: "staff", chunkIndex: 0, similarityScore: 0.8, retrievalScore: 0.8 }];
  const { record: stored } = await createAnalysisIntelligence({ workspaceId: ws._id, signal: { id: sig1._id, title: sig1.title, type: sig1.type, severity: sig1.severity }, propertyId: prop._id, level: "staff", analysis: refsIn, provider: "gemini", model: "gemini-3.1-flash-lite", knowledgeProvenance: prov, knowledgeVisibility: "staff", evidenceRefs: evRefs, contradictions: contrIn, safety: { state: "NORMAL", urgency: "prompt", recommendedActionType: "maintenance_dispatch" } });
  const raw = await M.Intelligence.findById(stored._id).lean();
  const proseOfRaw = [raw.analysis.situation, ...raw.analysis.evidence, raw.analysis.impact, raw.analysis.recommendation, raw.intelligence.summary, ...raw.intelligence.findings, raw.intelligence.operationalImpact, raw.decision.recommendation, ...raw.contradictions.map((c) => c.description)];
  check("D1 the STORED document - analysis, the legacy intelligence / decision mirrors and contradiction descriptions - holds no internal reference or record id", proseOfRaw.every((t) => !containsInternalReference(t)), proseOfRaw.filter(containsInternalReference).join(" | "));
  check("D2 no unrelated text was removed: the dates, counts, money, room number and the recommendation / uncertainty / contradiction wording are intact in the stored prose",
    /unit 206/.test(raw.analysis.situation) && /2026-10-10/.test(raw.analysis.situation) && /3 guests/.test(raw.analysis.situation) && raw.analysis.evidence[2] === "The guest asked for a refund of ₹2,500." && /until 2026-10-14/.test(raw.analysis.evidence[1]) &&
    /A person could consider dispatching a technician to inspect the AC unit/.test(raw.analysis.recommendation) && /confirming the repair with the guest/.test(raw.analysis.recommendation) && /The report says tomorrow but the record/.test(raw.contradictions[0].description) && /shows 2026-10-14/.test(raw.contradictions[0].description));
  check("D3 the stored knowledge reference in the recommendation became the stored section title (\"AC Response Guidance\"), not a database id", /the "AC Response Guidance" guidance/.test(raw.analysis.recommendation));
  check("D4 the STRUCTURED evidence is intact: evidenceRefs (all three, same ids), the contradiction's evidenceRefs, and the knowledge provenance (chunk id, section)",
    raw.evidenceRefs.length === 3 && raw.evidenceRefs[0].refId === S1 && raw.evidenceRefs[1].refId === U1 && raw.evidenceRefs[2].chunkId === chunk && raw.contradictions[0].evidenceRefs[0].refId === OID(6) && raw.knowledgeProvenance[0].chunkId === chunk && raw.knowledgeProvenance[0].section === "AC Response Guidance");
  check("D5 confidence, safety state / urgency / action type are exactly what was admitted", raw.analysis.confidence === "medium" && raw.safety.state === "NORMAL" && raw.safety.urgency === "prompt" && raw.safety.recommendedActionType === "maintenance_dispatch");
  const view = toIntelligenceView(stored);
  check("D6 the API view of the stored record: clean prose, structured evidence present, the same top-level shape", !containsInternalReference(JSON.stringify([view.analysis, view.intelligence, view.decision, view.contradictions?.map((c) => c.description)])) && view.evidenceRefs.length === 3 && view.knowledgeProvenance[0].chunkId === chunk &&
    ["_id", "workspaceId", "signalIds", "analysis", "safety", "knowledgeProvenance", "evidenceRefs", "contradictions", "analysisVersion", "analysisLevel", "knowledgeVisibility", "createdAt"].every((k) => k in view) && ["situation", "evidence", "impact", "recommendation", "confidence"].every((k) => k in view.analysis));
  const sigClean = await mkSignal("Room 206: no ids here");
  const clean = (await createAnalysisIntelligence({ workspaceId: ws._id, signal: { id: sigClean._id, title: sigClean.title, type: "maintenance", severity: "medium" }, propertyId: prop._id, level: "staff", analysis: { situation: "A plain situation on 2026-10-10.", evidence: ["Plain."], impact: "Plain impact.", recommendation: "A person could consider inspecting it.", confidence: "low" }, provider: "gemini", model: "gemini-3.1-flash-lite", knowledgeProvenance: [], knowledgeVisibility: undefined, safety: { state: "NORMAL", urgency: "routine", recommendedActionType: "inspection" } })).record;
  const cleanRaw = await M.Intelligence.findById(clean._id).lean();
  check("D7 an analysis with no reference is stored EXACTLY as given (nothing is rewritten when there is nothing to remove)", cleanRaw.analysis.situation === "A plain situation on 2026-10-10." && cleanRaw.analysis.recommendation === "A person could consider inspecting it." && cleanRaw.analysis.evidence[0] === "Plain.");

  // ======================================================================================================== E
  console.log("\n# E. Decision and Action snapshots");
  const actor = new mongoose.Types.ObjectId(); const reviewer = new mongoose.Types.ObjectId();
  const dec = (await proposeDecision(String(stored._id), String(ws._id), {}, { authorizedLevel: "staff", actorUserId: actor })).record;
  const decRaw = await M.Decision.findById(dec._id).lean();
  check("E1 a Decision proposed from a clean parent carries a clean description", !containsInternalReference(decRaw.description) && /dispatching a technician/.test(decRaw.description) && !containsInternalReference(dec.description));
  // a LEGACY parent: stored before the boundary existed (written straight to the collection, ids in the prose)
  const sigLegacy = await mkSignal("Room 206: legacy");
  const legacy = await M.Intelligence.create({ workspaceId: ws._id, signalIds: [sigLegacy._id], propertyId: prop._id, signal: { summary: sigLegacy.title, type: "maintenance", severity: "medium" }, intelligence: { summary: `Legacy (current:unit:${U1})`, findings: [`current:signal:${String(sigLegacy._id)}`], operationalImpact: `Impact ${OID(5)}` }, risk: { level: "medium", reason: "x" }, decision: { recommendation: `Legacy dispatch (current:signal:${String(sigLegacy._id)})` }, generatedBy: "llm", provider: "gemini", model: "gemini-3.1-flash-lite",
    analysis: { situation: `Legacy situation current:unit:${U1}`, evidence: [`current:signal:${String(sigLegacy._id)}`], impact: `Legacy impact ${OID(5)}`, recommendation: `A person could consider dispatching a technician (current:signal:${String(sigLegacy._id)}) and ${OID(7)} informing the guest.`, confidence: "medium" }, analysisVersion: "intelligence-v1", analysisLevel: "staff", knowledgeVisibility: undefined, safety: { state: "NORMAL", urgency: "prompt", recommendedActionType: "maintenance_dispatch" } }).catch((e) => e);
  if (legacy instanceof Error) check("E0 the legacy parent could be written for the test", false, legacy.message.slice(0, 160));
  else {
    const legacyRaw = await M.Intelligence.findById(legacy._id).lean();
    check("E2 (setup) the legacy parent really holds ids in its stored prose", containsInternalReference(legacyRaw.analysis.recommendation) && containsInternalReference(legacyRaw.analysis.situation));
    const lv = toIntelligenceView(legacyRaw);
    check("F1 the API view of a LEGACY record never returns an internal reference (analysis, legacy mirrors), while the stored document itself is not rewritten", !containsInternalReference(JSON.stringify([lv.analysis, lv.intelligence, lv.decision])) && containsInternalReference(legacyRaw.analysis.recommendation) && /dispatching a technician/.test(lv.analysis.recommendation) && /informing the guest/.test(lv.analysis.recommendation));
    const ldec = (await proposeDecision(String(legacy._id), String(ws._id), {}, { authorizedLevel: "staff", actorUserId: actor })).record;
    const ldecRaw = await M.Decision.findById(ldec._id).lean();
    check("E3 a Decision proposed from a LEGACY parent stores a clean description (stored and viewed) and keeps the recommendation wording", !containsInternalReference(ldecRaw.description) && !containsInternalReference(ldec.description) && /dispatching a technician/.test(ldecRaw.description) && /informing the guest/.test(ldecRaw.description));
    await approveDecision(String(ldec._id), String(ws._id), {}, { authorizedLevel: "staff", actorUserId: reviewer });
    const lact = (await proposeAction(String(ldec._id), String(ws._id), {}, { authorizedLevel: "staff", actorUserId: actor })).record;
    const lactRaw = await M.Action.findById(lact._id).lean();
    check("E4 an Action proposed from that Decision stores a clean description (stored and viewed); its type / risk / urgency come from the structured safety result, unchanged", !containsInternalReference(lactRaw.description) && !containsInternalReference(lact.description) && lactRaw.actionType === "maintenance_dispatch" && lactRaw.urgency === "prompt");
    // a Decision / Action stored BEFORE the boundary with ids in the snapshot: the views still never return one
    const oldDec = await M.Decision.collection.insertOne({ workspaceId: ws._id, intelligenceId: stored._id, signalId: sig1._id, decisionVersion: "v1-old", type: "operational", description: `Old snapshot (current:unit:${U1}) ${OID(3)}`, priority: "medium", status: "proposed", createdAt: new Date(), updatedAt: new Date() });
    const oldDecRaw = await M.Decision.findById(oldDec.insertedId).lean();
    check("F2 a Decision snapshot stored before the boundary is returned without the reference (stored text untouched)", !containsInternalReference(toDecisionView(oldDecRaw, actor).description) && containsInternalReference(oldDecRaw.description));
    const oldAct = await M.Action.collection.insertOne({ workspaceId: ws._id, intelligenceId: stored._id, decisionId: oldDec.insertedId, signalId: sig1._id, actionVersion: "v1-old", actionType: "other", riskLevel: "low", type: "operational", description: `Old action (current:signal:${S1})`, status: "proposed", createdAt: new Date(), updatedAt: new Date() });
    const oldActRaw = await M.Action.findById(oldAct.insertedId).lean();
    check("F3 an Action snapshot stored before the boundary is returned without the reference", !containsInternalReference(toActionView(oldActRaw, actor).description) && containsInternalReference(oldActRaw.description));
    check("F4 the Decision and Action views keep their shape (same keys as for a clean record)", JSON.stringify(Object.keys(toDecisionView(oldDecRaw, actor)).sort()) === JSON.stringify(Object.keys(dec).sort()) && JSON.stringify(Object.keys(toActionView(oldActRaw, actor)).sort()) === JSON.stringify(Object.keys(lact).sort()));
  }

  // ======================================================================================================== G
  console.log("\n# G. static");
  const svc = code(path.join(BACKEND, "src/services/intelligenceAnalysisService.js"));
  const sanitizerSrc = code(path.join(BACKEND, "src/services/ai/proseReferenceSanitizer.js"));
  check("G1 the sanitizer is a pure module: no imports, no I/O, no database, no model call", !/^\s*import\s/m.test(sanitizerSrc) && !/\b(?:fetch|require|process\.env|mongoose|fs\.)\b/.test(sanitizerSrc));
  check("G2 the persistence boundary runs after every validator: validateAndVerifyAnalysis precedes createAnalysisIntelligence, and the sanitizer is applied inside createAnalysisIntelligence", svc.indexOf("validateAndVerifyAnalysis(raw") > 0 && svc.indexOf("validateAndVerifyAnalysis(raw") < svc.indexOf("createAnalysisIntelligence({") && /analysis = sanitizeAnalysisProse\(/.test(code(path.join(BACKEND, "src/services/intelligenceService.js"))));
  const protectedFiles = ["claimValidator.js", "evidenceEnvelope.js", "evidenceReferenceIndex.js", "outputGuard.js", "safetyPolicy.js", "confidencePolicy.js", "proseConsistency.js", "analysisSchema.js"];
  check("G3 no protected validator / safety / evidence module imports or references the sanitizer", protectedFiles.every((f) => !/proseReferenceSanitizer|sanitizeProse/.test(read(path.join(BACKEND, "src/services/ai", f)))));
  check("G4 the audit trail keeps the model's original admitted analysis: recordAnalysisAdmission still receives the unsanitised analysis object", /accepted: \{ intelligenceId: stored\.record\._id, analysis \}/.test(svc));
  check("G5 Learning is untouched: the flag is off in this process, the sanitizer and the new tests never reference it, and the Learning modules are not imported by the sanitizer", !getLearningContextEnabled() && !/KOI_LEARNING|learningContext/i.test(sanitizerSrc));
  check("G6 the frontend presentation layer still removes references from text that was NOT sanitised server-side (legacy / defence in depth)", !FE.containsInternalReference(FE.presentText(`Legacy (current:unit:${OID(1)}) text ${OID(2)}.`)));
} finally {
  try { await mongoose.connection.dropDatabase(); } catch { /* best effort */ }
  try { await mongoose.disconnect(); } catch { /* best effort */ }
}
console.log(`\nPhase 53D evidence boundary: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
