/**
 * Dashboard V1 read model - pure regression suite (no server, no MongoDB
 * connection, no network, no provider). Covers the parts of the dashboard
 * service that need no database: severity ranking, the synthetic marker,
 * filter parsing, the visibility-aware choice of a stored Intelligence V1
 * record, and the response whitelists (what may and may not be exposed).
 * The database + HTTP side is validate-dashboard-api.mjs. All fixtures are
 * SYNTHETIC.
 */
import {
  SEVERITY_RANK,
  isSyntheticSignal,
  parseDashboardFilters,
  pickVisibleAnalysis,
  severityRank,
  toIntelligenceDetail,
  toIntelligenceSummary,
  toObservedProperty,
  toObservedStay,
  toObservedUnit,
  toSignalFacts,
} from "../src/services/dashboardService.js";

let passed = 0;
let failed = 0;
const ok = (n) => { passed += 1; console.log(`PASS  ${n}`); };
const fail = (n, d = "") => { failed += 1; console.error(`FAIL  ${n}${d ? ` — ${d}` : ""}`); };
const check = (n, c, d = "") => (c ? ok(n) : fail(n, d));
const same = (n, a, e) => check(n, JSON.stringify(a) === JSON.stringify(e), `actual=${JSON.stringify(a)} expected=${JSON.stringify(e)}`);
const throwsStatus = (n, fn, status) => { try { fn(); fail(n, "did not throw"); } catch (e) { check(n, e.statusCode === status, `${e.statusCode} ${e.message}`); } };

// ---------------------------------------------------------------- severity ranking
same("rank order is critical, high, medium, low", Object.entries(SEVERITY_RANK).sort((a, b) => a[1] - b[1]).map(([k]) => k), ["critical", "high", "medium", "low"]);
{
  const items = ["low", "medium", "high", "critical"].map((severity) => ({ severity }));
  const byRank = [...items].sort((a, b) => severityRank(a.severity) - severityRank(b.severity)).map((i) => i.severity);
  const alphabetical = [...items].sort((a, b) => a.severity.localeCompare(b.severity)).map((i) => i.severity);
  same("ranking puts critical first and low last", byRank, ["critical", "high", "medium", "low"]);
  same("alphabetical order is NOT the required order (this is the bug the ranking prevents)", alphabetical, ["critical", "high", "low", "medium"]);
  check("rank order differs from alphabetical order", JSON.stringify(byRank) !== JSON.stringify(alphabetical));
}
check("an unknown or missing severity ranks after every real one", severityRank("bogus") > severityRank("low") && severityRank(undefined) > severityRank("low") && severityRank(null) > severityRank("low"));

// ---------------------------------------------------------------- synthetic marker
check("metadata.synthetic 'true' marks a Signal synthetic", isSyntheticSignal({ metadata: { synthetic: "true" } }) === true);
check("metadata.synthetic boolean true marks it too", isSyntheticSignal({ metadata: { synthetic: true } }) === true);
check("a Mongoose-style Map of metadata is understood", isSyntheticSignal({ metadata: new Map([["synthetic", "true"]]) }) === true);
check("'false', other strings and other values are not synthetic", ["false", "no", "1", "TRUE", "", "yes", 1, 0, null].every((v) => isSyntheticSignal({ metadata: { synthetic: v } }) === false));
check("no metadata / empty metadata is not synthetic", [{}, { metadata: {} }, { metadata: null }, { metadata: new Map() }, null, undefined].every((s) => isSyntheticSignal(s) === false));
check("synthetic is NEVER inferred from the title or description", isSyntheticSignal({ title: "[SYNTHETIC TEST] AC not cooling", description: "Synthetic validation scenario", metadata: {} }) === false);
check("an unrelated metadata key does not count", isSyntheticSignal({ metadata: { purpose: "synthetic" } }) === false);

// ---------------------------------------------------------------- filter parsing
const OID = "6ab50ea2b5e342251fd868b6";
same("no filters parses to an empty filter set", parseDashboardFilters({ workspaceId: OID }), {});
{
  const f = parseDashboardFilters({ workspaceId: OID, propertyId: OID, status: "new", severity: "high", type: "maintenance", hasIntelligence: "true", page: "2", limit: "5", extra: "x" });
  check("valid filters parse (extra and pagination params are ignored)", String(f.propertyId) === OID && f.status === "new" && f.severity === "high" && f.type === "maintenance" && f.hasIntelligence === true && !("page" in f) && !("extra" in f));
  check("hasIntelligence 'false' parses to false", parseDashboardFilters({ hasIntelligence: "false" }).hasIntelligence === false);
}
for (const [param, bad] of [["severity", "urgent"], ["severity", "High"], ["status", "open"], ["type", "plumbing"], ["propertyId", "not-an-id"], ["hasIntelligence", "yes"], ["hasIntelligence", "1"], ["hasIntelligence", ""]]) {
  throwsStatus(`an invalid ${param} (${JSON.stringify(bad)}) is a 400`, () => parseDashboardFilters({ [param]: bad }), 400);
}
check("an empty-string filter is treated as not supplied (except hasIntelligence)", Object.keys(parseDashboardFilters({ status: "", severity: "", type: "", propertyId: "" })).length === 0);

// ---------------------------------------------------------------- which stored analysis a caller may see
const rec = (over = {}) => ({ _id: "r1", analysisVersion: "intelligence-v1", analysisLevel: "guest", createdAt: new Date("2026-09-25T00:00:00Z"), ...over });
same("a guest caller sees a guest-level V1 analysis", pickVisibleAnalysis([rec()], "guest")?._id, "r1");
check("a guest caller does NOT see a staff-level analysis (it behaves as absent)", pickVisibleAnalysis([rec({ analysisLevel: "staff" })], "guest") === null);
check("a guest caller does NOT see a restricted-level analysis", pickVisibleAnalysis([rec({ analysisLevel: "restricted" })], "guest") === null);
check("a staff caller does NOT see a restricted-level analysis", pickVisibleAnalysis([rec({ analysisLevel: "restricted" })], "staff") === null);
same("a staff caller sees a staff-level analysis", pickVisibleAnalysis([rec({ analysisLevel: "staff" })], "staff")?._id, "r1");
same("a staff caller may see a guest-level analysis when no staff one exists", pickVisibleAnalysis([rec({ _id: "g" })], "staff")?._id, "g");
same("with both, a staff caller gets the staff-level (most informative visible) analysis", pickVisibleAnalysis([rec({ _id: "g" }), rec({ _id: "s", analysisLevel: "staff" })], "staff")?._id, "s");
same("...independent of input order", pickVisibleAnalysis([rec({ _id: "s", analysisLevel: "staff" }), rec({ _id: "g" })], "staff")?._id, "s");
same("a restricted caller gets the restricted-level analysis when it exists", pickVisibleAnalysis([rec({ _id: "g" }), rec({ _id: "s", analysisLevel: "staff" }), rec({ _id: "r", analysisLevel: "restricted" })], "restricted")?._id, "r");
same("an unknown caller level fails closed to guest", pickVisibleAnalysis([rec({ _id: "g" }), rec({ _id: "s", analysisLevel: "staff" })], "admin")?._id, "g");
check("legacy records (no analysisVersion) are never returned as V1", pickVisibleAnalysis([rec({ analysisVersion: undefined })], "restricted") === null && pickVisibleAnalysis([rec({ analysisVersion: "legacy" })], "restricted") === null);
same("a legacy record does not displace a V1 record", pickVisibleAnalysis([rec({ _id: "legacy", analysisVersion: undefined, analysisLevel: "staff" }), rec({ _id: "v1" })], "staff")?._id, "v1");
check("a record whose knowledge was above the caller's level is hidden even if mislabelled", pickVisibleAnalysis([rec({ analysisLevel: "guest", knowledgeVisibility: "staff" })], "guest") === null);
check("a record with no valid analysisLevel is hidden (fail closed)", pickVisibleAnalysis([rec({ analysisLevel: undefined }), rec({ analysisLevel: "public" })], "restricted") === null);
same("equal levels: the newest wins, then the larger id (deterministic)", pickVisibleAnalysis([rec({ _id: "a", createdAt: new Date("2026-09-25T00:00:00Z") }), rec({ _id: "b", createdAt: new Date("2026-09-26T00:00:00Z") })], "guest")?._id, "b");
same("no records -> null", [pickVisibleAnalysis([], "guest"), pickVisibleAnalysis(undefined, "guest")], [null, null]);

// ---------------------------------------------------------------- what may be exposed
const RAW_RECORD = {
  _id: "6ab625aff432c2c44e967497", workspaceId: "w", signalIds: ["s"], propertyId: "p", guestId: "g1", stayId: "st1",
  signal: { summary: "x" }, intelligence: { summary: "legacy" }, provider: "test", model: "deterministic-stub", generatedBy: "llm",
  analysisVersion: "intelligence-v1", analysisLevel: "staff", knowledgeVisibility: "staff", createdAt: new Date("2026-09-25T07:41:35.885Z"), updatedAt: new Date(), __v: 0,
  analysis: { situation: "Sit", evidence: ["e1", "e2", "e3"], impact: "Imp", recommendation: "Rec", confidence: "medium" },
  knowledgeProvenance: [
    { chunkId: "c1", knowledgeDocumentId: "d1", version: 1, scope: "property", section: "15. Maintenance", sectionPath: ["15. Maintenance"], visibility: "staff", chunkIndex: 16, similarityScore: 0.8, retrievalScore: 0.87 },
    { chunkId: "c2", knowledgeDocumentId: "d1", version: 1, scope: "property", section: "19. Staff Roles", sectionPath: ["19. Staff Roles"], visibility: "staff", chunkIndex: 20, similarityScore: 0.75, retrievalScore: 0.81 },
  ],
};
{
  const summary = toIntelligenceSummary(RAW_RECORD);
  same("the list summary has exactly id, confidence, createdAt, evidenceCount, citedSections", Object.keys(summary).sort(), ["citedSections", "confidence", "createdAt", "evidenceCount", "id"]);
  check("summary values: string id, enum confidence, ISO createdAt, evidence count, cited section names", summary.id === "6ab625aff432c2c44e967497" && summary.confidence === "medium" && summary.createdAt === "2026-09-25T07:41:35.885Z" && summary.evidenceCount === 3 && JSON.stringify(summary.citedSections) === JSON.stringify(["15. Maintenance", "19. Staff Roles"]));
  const detail = toIntelligenceDetail(RAW_RECORD);
  same("the detail has exactly the analysis fields, version, id, createdAt and provenance", Object.keys(detail).sort(), ["analysisVersion", "confidence", "createdAt", "evidence", "id", "impact", "knowledgeProvenance", "recommendation", "situation"]);
  same("each provenance item exposes exactly chunkId, section, sectionPath, visibility, retrievalScore", detail.knowledgeProvenance.map((p) => Object.keys(p).sort()), [["chunkId", "retrievalScore", "section", "sectionPath", "visibility"], ["chunkId", "retrievalScore", "section", "sectionPath", "visibility"]]);
  check("provenance values are copied from the record", detail.knowledgeProvenance[0].chunkId === "c1" && detail.knowledgeProvenance[0].retrievalScore === 0.87 && detail.knowledgeProvenance[0].visibility === "staff");
  const text = JSON.stringify({ summary, detail });
  for (const forbidden of ["provider", "model", "deterministic-stub", "generatedBy", "analysisLevel", "knowledgeVisibility", "knowledgeDocumentId", "similarityScore", "chunkIndex", "workspaceId", "guestId", "stayId", "signalIds", "propertyId", "embedding", "prompt", "apiKey", "content", '"text"', "__v", "updatedAt"]) {
    check(`the exposed intelligence never contains ${forbidden}`, !text.includes(forbidden));
  }
  check("evidence is copied (a new array, not the stored one)", detail.evidence !== RAW_RECORD.analysis.evidence && JSON.stringify(detail.evidence) === JSON.stringify(RAW_RECORD.analysis.evidence));
  same("a record with no provenance yields empty arrays, not missing fields", [toIntelligenceDetail({ ...RAW_RECORD, knowledgeProvenance: undefined }).knowledgeProvenance, toIntelligenceSummary({ ...RAW_RECORD, knowledgeProvenance: undefined }).citedSections], [[], []]);
  check("a null record serializes to null", toIntelligenceSummary(null) === null && toIntelligenceDetail(null) === null);
}
{
  const SIGNAL = { _id: "6ab625aef432c2c44e967487", workspaceId: "w", title: "T", type: "maintenance", severity: "medium", status: "new", source: "system", occurredAt: new Date("2026-09-25T07:00:00Z"), detectedAt: new Date(), description: "D", guestId: "g1", stayId: "st1", unitId: "u", propertyId: "p", metadata: { synthetic: "true", purpose: "x" }, createdAt: new Date(), updatedAt: new Date() };
  const facts = toSignalFacts(SIGNAL);
  same("signal facts have exactly the approved fields", Object.keys(facts).sort(), ["description", "id", "occurredAt", "severity", "source", "status", "synthetic", "title", "type"]);
  check("signal facts: string id, ISO occurredAt (UTC, unconverted), synthetic true from metadata", facts.id === "6ab625aef432c2c44e967487" && facts.occurredAt === "2026-09-25T07:00:00.000Z" && facts.synthetic === true);
  check("no guest id, stay id, property id, metadata or timestamps leak through the signal facts", !/guestId|stayId|unitId|propertyId|metadata|workspaceId|createdAt|updatedAt|detectedAt/.test(JSON.stringify(facts)));
  check("synthetic is false for an ordinary Signal", toSignalFacts({ ...SIGNAL, metadata: {} }).synthetic === false);
  same("property is exposed as id, code, name only", Object.keys(toObservedProperty({ _id: "p", code: "KG01", name: "N", timezone: "Asia/Kolkata", status: "active", address: "secret", workspaceId: "w" })).sort(), ["code", "id", "name"]);
  same("unit is exposed as id and unitNumber only", Object.keys(toObservedUnit({ _id: "u", unitNumber: "1A-R1", type: "room", status: "available", propertyId: "p" })).sort(), ["id", "unitNumber"]);
  const stay = toObservedStay({ _id: "st1", guestId: "g1", reservationId: "RES-SECRET", status: "confirmed", checkIn: new Date("2026-09-24T06:30:00Z"), checkOut: new Date("2026-09-27T05:30:00Z"), adults: 2, children: 0, source: "x", propertyId: "p", unitId: "u" });
  same("stay is exposed as status, checkIn, checkOut only", Object.keys(stay).sort(), ["checkIn", "checkOut", "status"]);
  check("stay dates are the stored UTC instants as ISO strings, unconverted; no reservation id", stay.checkIn === "2026-09-24T06:30:00.000Z" && stay.checkOut === "2026-09-27T05:30:00.000Z" && !JSON.stringify(stay).includes("RES-SECRET"));
  check("missing property / unit / stay serialize to null", toObservedProperty(null) === null && toObservedUnit(undefined) === null && toObservedStay(null) === null);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
