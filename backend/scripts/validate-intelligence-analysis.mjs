/**
 * Intelligence V1 - pure regression suite (no server, no MongoDB connection,
 * no network, no provider). Covers the strict analysis validation, the
 * context sanitization, and the additive model shape. The database + HTTP
 * side is validate-intelligence-analysis-api.mjs. All fixtures are SYNTHETIC.
 */
import mongoose from "mongoose";
import { validateAnalysisResult, MAX_EVIDENCE_ITEMS } from "../src/services/ai/analysisSchema.js";
import { sanitizeAnalysisContext } from "../src/services/analysisContextService.js";
import { findUnsupportedStatusClaims } from "../src/services/ai/statusInferenceCheck.js";
import { Intelligence, ANALYSIS_CONFIDENCE_LEVELS, ANALYSIS_VERSION } from "../src/models/Intelligence.js";

let passed = 0;
let failed = 0;
const ok = (n) => { passed += 1; console.log(`PASS  ${n}`); };
const fail = (n, d = "") => { failed += 1; console.error(`FAIL  ${n}${d ? ` — ${d}` : ""}`); };
const check = (n, c, d = "") => (c ? ok(n) : fail(n, d));
const same = (n, a, e) => check(n, JSON.stringify(a) === JSON.stringify(e), `actual=${JSON.stringify(a)} expected=${JSON.stringify(e)}`);
const rejects = (n, raw, ids = new Set(["c1", "c2"])) => {
  try { validateAnalysisResult(raw, ids); fail(n, "was accepted"); } catch (e) { check(n, e.statusCode === 502 && /invalid analysis/.test(e.message), `${e.statusCode} ${e.message}`); }
};

const GOOD = () => ({
  situation: "The AC is reported as not cooling.",
  evidence: ["Signal severity is high."],
  impact: "Not available beyond the recorded severity.",
  recommendation: "Consider the documented guidance.",
  confidence: "medium",
  usedKnowledgeChunkIds: ["c1"],
  provenance: { provider: "test", model: "m" },
});
const IDS = new Set(["c1", "c2"]);

// ---- valid ----------------------------------------------------------------
{
  const out = validateAnalysisResult(GOOD(), IDS);
  same("a valid analysis is accepted and normalized", [out.situation, out.confidence, out.usedKnowledgeChunkIds, out.provenance], ["The AC is reported as not cooling.", "medium", ["c1"], { provider: "test", model: "m" }]);
  check("usedKnowledgeChunkIds may be empty or omitted", validateAnalysisResult({ ...GOOD(), usedKnowledgeChunkIds: [] }, IDS).usedKnowledgeChunkIds.length === 0 && validateAnalysisResult((() => { const g = GOOD(); delete g.usedKnowledgeChunkIds; return g; })(), IDS).usedKnowledgeChunkIds.length === 0);
  check("surrounding whitespace is trimmed, content otherwise preserved", validateAnalysisResult({ ...GOOD(), situation: "  keep me  " }, IDS).situation === "keep me");
}

// ---- confidence: exactly high | medium | low --------------------------------
same("the confidence levels are exactly high, medium, low", [...ANALYSIS_CONFIDENCE_LEVELS], ["high", "medium", "low"]);
for (const level of ANALYSIS_CONFIDENCE_LEVELS) check(`confidence "${level}" is accepted`, validateAnalysisResult({ ...GOOD(), confidence: level }, IDS).confidence === level);
for (const bad of ["HIGH", "High", "certain", "very high", "90%", "0.9", "", " high", "high ", 0.9, 1, 0, 90, null, undefined, true, ["high"], { level: "high" }]) {
  rejects(`invalid confidence ${JSON.stringify(bad)} is rejected (never coerced)`, { ...GOOD(), confidence: bad });
}
{
  const g = GOOD(); delete g.confidence;
  rejects("a missing confidence is rejected", g);
}
rejects("a numeric confidenceScore field is rejected as an unexpected field", { ...GOOD(), confidenceScore: 0.9 });

// ---- required fields --------------------------------------------------------
for (const field of ["situation", "evidence", "impact", "recommendation", "provenance"]) {
  const g = GOOD(); delete g[field];
  rejects(`missing required field "${field}" is rejected`, g);
}
for (const field of ["situation", "impact", "recommendation"]) {
  for (const bad of ["", "   ", null, 5, [], {}]) rejects(`${field} = ${JSON.stringify(bad)} is rejected`, { ...GOOD(), [field]: bad });
  rejects(`${field} over the length cap is rejected`, { ...GOOD(), [field]: "x".repeat(2001) });
}
rejects("empty evidence is rejected", { ...GOOD(), evidence: [] });
rejects("non-array evidence is rejected", { ...GOOD(), evidence: "one string" });
rejects("blank evidence item is rejected", { ...GOOD(), evidence: ["ok", "  "] });
rejects("non-string evidence item is rejected", { ...GOOD(), evidence: ["ok", 5] });
rejects("oversized evidence item is rejected", { ...GOOD(), evidence: ["x".repeat(1001)] });
rejects(`more than ${MAX_EVIDENCE_ITEMS} evidence items is rejected`, { ...GOOD(), evidence: Array.from({ length: MAX_EVIDENCE_ITEMS + 1 }, (_, i) => `e${i}`) });
for (const bad of [null, undefined, "text", 5, [], [GOOD()]]) rejects(`non-object body ${JSON.stringify(bad)?.slice(0, 20)} is rejected`, bad);

// ---- LLM safety: the contract is closed ------------------------------------
for (const extra of [
  { action: "send_email" }, { actions: [{ tool: "refund" }] }, { toolCalls: [] }, { tool_calls: [{ name: "x" }] }, { sendMessage: "hi" },
  { reservationChange: { stayId: "x" } }, { payment: 10 }, { dbWrite: true }, { updateSignal: { status: "resolved" } }, { decision: "approve" }, { risk: "low" },
]) {
  rejects(`an unexpected field ${JSON.stringify(Object.keys(extra))} cannot smuggle an operation through`, { ...GOOD(), ...extra });
}
rejects("provenance with an extra key is rejected", { ...GOOD(), provenance: { provider: "test", model: "m", apiKey: "x" } });
for (const bad of [null, "test", [], { provider: "test" }, { model: "m" }, { provider: "", model: "m" }, { provider: "test", model: "" }, { provider: 1, model: "m" }]) {
  rejects(`provenance ${JSON.stringify(bad)} is rejected`, { ...GOOD(), provenance: bad });
}

// ---- provenance can only reference chunks that were retrieved ---------------
rejects("a cited chunk that was not retrieved is rejected", { ...GOOD(), usedKnowledgeChunkIds: ["c1", "not-retrieved"] });
rejects("a cited chunk is rejected when nothing was retrieved", { ...GOOD(), usedKnowledgeChunkIds: ["c1"] }, new Set());
rejects("duplicate cited chunk ids are rejected", { ...GOOD(), usedKnowledgeChunkIds: ["c1", "c1"] });
for (const bad of ["c1", [1], [""], [null], {}]) rejects(`usedKnowledgeChunkIds ${JSON.stringify(bad)} is rejected`, { ...GOOD(), usedKnowledgeChunkIds: bad });
check("citing several retrieved chunks is fine", validateAnalysisResult({ ...GOOD(), usedKnowledgeChunkIds: ["c2", "c1"] }, IDS).usedKnowledgeChunkIds.join() === "c2,c1");
check("the rejection message never echoes model content", (() => { try { validateAnalysisResult({ ...GOOD(), situation: "SECRET-MODEL-TEXT", confidence: "certain" }, IDS); } catch (e) { return !e.message.includes("SECRET-MODEL-TEXT"); } return false; })());

// ---- context sanitization ---------------------------------------------------
{
  const context = {
    signal: { id: "s1", title: "AC" },
    guest: { id: "g1", available: true, firstName: "Ann", lastName: "Doe", email: "ann@example.invalid", phone: "10001 20002", recentStays: [{ id: "st1", reservationId: "R1" }] },
    stay: { id: "st1", available: true },
    property: { id: "p1", available: true, name: "P" },
    unit: null,
    history: { signals: [] },
  };
  const clean = sanitizeAnalysisContext(context);
  check("guest email and phone are removed from the analysis context", !("email" in clean.guest) && !("phone" in clean.guest) && !JSON.stringify(clean).includes("example.invalid") && !JSON.stringify(clean).includes("20002"));
  check("guest first/last name are removed from the analysis context (approved privacy change)", !("firstName" in clean.guest) && !("lastName" in clean.guest) && !JSON.stringify(clean).includes("Ann") && !JSON.stringify(clean).includes("Doe"));
  check("everything operationally necessary is preserved (ids, availability, stays, reservation id, property)", clean.guest.id === "g1" && clean.guest.available === true && clean.guest.recentStays[0].reservationId === "R1" && clean.stay.id === "st1" && clean.property.name === "P" && clean.unit === null && Array.isArray(clean.history.signals));
  check("the original context object is not mutated", context.guest.email === "ann@example.invalid" && context.guest.phone === "10001 20002");
  check("a context with no guest is handled", sanitizeAnalysisContext({ signal: { id: "s" }, guest: null }).guest === null);
  check("an unavailable guest reference is handled", sanitizeAnalysisContext({ signal: { id: "s" }, guest: { id: "g", available: false, recentStays: [] } }).guest.available === false);
}


// ---- guest-name privacy and exact status preservation (hardening) -----------
{
  const context = {
    signal: { id: "s1", title: "AC not cooling", description: "Synthetic." },
    guest: { id: "g1", available: true, firstName: "Ann", lastName: "Doe", fullName: "Ann Doe", name: "Ann Doe", email: "a@example.invalid", phone: "10001 20002", recentStays: [{ id: "st1", available: true, reservationId: "R-1", checkIn: "2026-09-24T06:30:00.000Z", checkOut: "2026-09-27T05:30:00.000Z", status: "confirmed" }] },
    stay: { id: "st1", available: true, reservationId: "R-1", checkIn: "2026-09-24T06:30:00.000Z", checkOut: "2026-09-27T05:30:00.000Z", status: "confirmed", unitId: "u1", propertyId: "p1", adults: 2, children: 0 },
    property: { id: "p1", available: true, name: "Property", code: "P1", timezone: "Asia/Kolkata", status: "active" },
    unit: { id: "u1", available: true, unitNumber: "1A-R1", type: "room", status: "available", propertyId: "p1" },
    history: { signals: [] },
  };
  const clean = sanitizeAnalysisContext(context);
  const serialized = JSON.stringify(clean);
  for (const field of ["firstName", "lastName", "fullName", "name", "email", "phone"]) check(`guest field "${field}" is absent from the serialized analysis context`, !(field in clean.guest) && !JSON.stringify(clean.guest).includes(`"${field}"`));
  check("no personal value survives anywhere in the serialized context", !/Ann|Doe|a@example|20002/.test(serialized));
  same("the guest keeps only its id, availability and recent stays", Object.keys(clean.guest).sort(), ["available", "id", "recentStays"]);
  check("the recorded stay status is preserved exactly (stay and recentStays)", clean.stay.status === "confirmed" && clean.guest.recentStays[0].status === "confirmed");
  check("stay dates, reservation id, unit, property and adults/children are preserved for grounding", clean.stay.checkIn === context.stay.checkIn && clean.stay.checkOut === context.stay.checkOut && clean.stay.reservationId === "R-1" && clean.unit.unitNumber === "1A-R1" && clean.property.code === "P1" && clean.stay.adults === 2);
  check("sanitizing does not add, rename or reinterpret any status", !/checked[_ -]?in/i.test(serialized) && clean.stay.status === context.stay.status);
  check("a missing or unresolved guest stays absent/unavailable, never given a name", sanitizeAnalysisContext({ ...context, guest: null }).guest === null && !("firstName" in sanitizeAnalysisContext({ ...context, guest: { id: "g", available: false, recentStays: [] } }).guest));
}

// ---- the underlying rule: a state may not be claimed unless the record establishes it
{
  const ctx = (status) => ({ stay: status === undefined ? null : { available: true, status } });
  const flagged = (status, ...texts) => findUnsupportedStatusClaims(ctx(status), texts).length > 0;
  check("a 'currently checked in' claim is flagged when the recorded status is only 'confirmed'", flagged("confirmed", "Guest is currently checked in (check-in 2026-09-24)."));
  check("...also flagged in other phrasings of the same state (in-house, active stay, occupied, arrived)", ["The in-house guest is affected.", "There is an active stay in the room.", "The room is occupied by the guest.", "The guest has arrived at the property."].every((t) => flagged("confirmed", t)));
  check("...and for the checked-out family (checked out, departed, vacated)", ["The guest has checked out.", "The guest already departed.", "The room was vacated."].every((t) => flagged("confirmed", t)));
  check("the same wording is NOT flagged when the record establishes that state", !flagged("checked_in", "Guest is currently checked in.") && !flagged("checked_out", "The guest has checked out."));
  check("a checked-in claim is still flagged when the record says checked_OUT (a different state)", flagged("checked_out", "The guest is currently checked in."));
  check("stating the recorded status exactly is not flagged", !flagged("confirmed", "The stay is recorded as confirmed.", "Stay status is 'confirmed' (check-in 2026-09-24, check-out 2026-09-27)."));
  check("negated / conditional / unavailable mentions are not flagged", ["The guest has not checked in yet.", "Whether the guest has checked in is not established.", "If the guest has checked in, tell the front desk.", "Unless the guest has arrived, no room change is needed.", "Check-in status is unavailable."].every((t) => !flagged("confirmed", t)));
  check("SOP procedure names such as 'Check-in' or 'Check-out & Post Check-out' are not state claims", !flagged("confirmed", "Section 7.2 Check-in describes the front-office check-in workflow.", "See 7.3 Check-out & Post Check-out."));
  check("with no stay linked, any state claim is unsupported", flagged(undefined, "The guest is currently checked in."));
  check("a stay of unknown/unrecorded status establishes nothing", flagged("", "The guest is currently checked in.") && findUnsupportedStatusClaims({ stay: { available: false } }, ["The guest is currently checked in."]).length === 1);
  check("the check returns which text and which state was unsupported (an audit aid, not a rewrite)", (() => { const r = findUnsupportedStatusClaims(ctx("confirmed"), ["ok", "Guest is currently checked in."]); return r.length === 1 && r[0].textIndex === 1 && r[0].state === "checked_in"; })());
  check("clean text yields no findings", findUnsupportedStatusClaims(ctx("confirmed"), ["The AC is reported as not cooling.", "Consider the documented maintenance guidance."]).length === 0);
}

// ---- the additive model shape ----------------------------------------------
{
  const id = () => new mongoose.Types.ObjectId();
  const base = { workspaceId: id() };
  const doc = new Intelligence({ ...base, analysis: { situation: "s", evidence: ["e"], impact: "i", recommendation: "r", confidence: "low" }, analysisVersion: ANALYSIS_VERSION, analysisLevel: "guest" });
  check("a V1 analysis subdocument validates", !doc.validateSync());
  check("the analysis confidence is enum-only on the model too", !!new Intelligence({ ...base, analysis: { situation: "s", evidence: ["e"], impact: "i", recommendation: "r", confidence: 0.5 } }).validateSync()?.errors?.["analysis.confidence"]);
  check("analysis fields are required within the subdocument", Object.keys(new Intelligence({ ...base, analysis: { situation: "s" } }).validateSync()?.errors || {}).length >= 3);
  check("analysis is absent on a record that has none (existing records unaffected)", new Intelligence(base).analysis === undefined && new Intelligence(base).analysisVersion === undefined && new Intelligence(base).propertyId === undefined);
  check("the legacy numeric confidence stays optional and unset", new Intelligence(base).confidence === undefined);
  check("provenance items accept the additive sectionPath and visibility", !new Intelligence({ ...base, knowledgeProvenance: [{ chunkId: "c", knowledgeDocumentId: "d", version: 1, scope: "property", section: "S", sectionPath: ["A", "S"], visibility: "staff", chunkIndex: 0, similarityScore: 0.5, retrievalScore: 0.6 }] }).validateSync());
  check("provenance rejects an invalid visibility", !!new Intelligence({ ...base, knowledgeProvenance: [{ chunkId: "c", knowledgeDocumentId: "d", version: 1, scope: "property", visibility: "public", chunkIndex: 0, similarityScore: 0, retrievalScore: 0 }] }).validateSync());
  check("provenance without the new fields (older records) still validates", !new Intelligence({ ...base, knowledgeProvenance: [{ chunkId: "c", knowledgeDocumentId: "d", version: 1, scope: "property", chunkIndex: 0, similarityScore: 0, retrievalScore: 0 }] }).validateSync());
  const uniq = Intelligence.schema.indexes().find(([spec]) => spec.workspaceId === 1 && spec.signalIds === 1 && spec.analysisLevel === 1);
  check("a partial unique index enforces one V1 analysis per workspace + signal + level", !!uniq && uniq[1].unique === true && uniq[1].partialFilterExpression?.analysisVersion === ANALYSIS_VERSION);
  check("the model has no field for an action/tool/message beyond the pre-existing legacy ones", !Intelligence.schema.path("analysis.action") && !Intelligence.schema.path("analysis.toolCalls") && !Intelligence.schema.path("analysis.actions"));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
