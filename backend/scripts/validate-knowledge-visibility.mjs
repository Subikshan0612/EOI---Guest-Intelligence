/**
 * Knowledge-visibility regression suite, pure part (no server, no MongoDB
 * connection, no embeddings, no network, no files outside the repo).
 *
 * Covers: the guest < staff < restricted hierarchy and its fail-closed
 * defaults, schema defaults, the explicit corpus-classification mechanism and
 * the reviewed v2 mapping, and that visibility never enters the embedding
 * text. The HTTP/database side is validate-knowledge-visibility-api.mjs.
 *
 * All fixtures are SYNTHETIC. The classification test reuses the v2
 * document's section HEADINGS (titles only, which the reviewed mapping
 * already contains) with invented bodies; no real content, rates or
 * contacts appear here.
 */
import fs from "node:fs";
import mongoose from "mongoose";
import { chunkContent } from "../src/services/knowledge/knowledgeChunker.js";
import {
  VISIBILITY_LEVELS,
  allowedVisibilities,
  canAccess,
  isValidVisibility,
  maxVisibility,
  normalizeCallerLevel,
  visibilityRank,
} from "../src/services/knowledge/visibility.js";
import {
  assertValidMapping,
  classifyChunks,
  classifySection,
  createChunkClassifier,
} from "../src/services/knowledge/corpusClassification.js";
import { KOLAM_GANDHI_V2_MAPPING } from "../src/services/knowledge/mappings/kolamGandhiV2.js";
import { CORPUS_PROFILES, classifierForProfile, getCorpusProfile } from "../src/services/knowledge/corpusProfiles.js";
import { buildEmbeddingText, EMBEDDING_INPUT_VERSION } from "../src/services/knowledge/embeddingText.js";
import { KnowledgeChunk } from "../src/models/KnowledgeChunk.js";
import { KnowledgeDocument } from "../src/models/KnowledgeDocument.js";
import { Intelligence } from "../src/models/Intelligence.js";

let passed = 0;
let failed = 0;
const ok = (name) => { passed += 1; console.log(`PASS  ${name}`); };
const fail = (name, detail = "") => { failed += 1; console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`); };
const check = (name, cond, detail = "") => (cond ? ok(name) : fail(name, detail));
const same = (name, actual, expected) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);

// ---------------------------------------------------------------------------
// 1. Hierarchy
// ---------------------------------------------------------------------------
same("levels are exactly guest, staff, restricted, in that order", [...VISIBILITY_LEVELS], ["guest", "staff", "restricted"]);
check("ordering: guest < staff < restricted", visibilityRank("guest") < visibilityRank("staff") && visibilityRank("staff") < visibilityRank("restricted"));
check("invalid values have no rank and are not valid", visibilityRank("admin") === -1 && !isValidVisibility("admin") && !isValidVisibility(undefined) && !isValidVisibility(null) && !isValidVisibility(1));
same("guest can see: guest", allowedVisibilities("guest"), ["guest"]);
same("staff can see: guest + staff", allowedVisibilities("staff"), ["guest", "staff"]);
same("restricted can see: guest + staff + restricted", allowedVisibilities("restricted"), ["guest", "staff", "restricted"]);

for (const caller of VISIBILITY_LEVELS) {
  for (const knowledge of VISIBILITY_LEVELS) {
    const expected = visibilityRank(caller) >= visibilityRank(knowledge);
    check(`canAccess: ${caller} caller -> ${knowledge} knowledge is ${expected}`, canAccess(caller, knowledge) === expected);
  }
}
check("a lower-level caller can never access higher-level knowledge", !canAccess("guest", "staff") && !canAccess("guest", "restricted") && !canAccess("staff", "restricted"));

// ---------------------------------------------------------------------------
// 2. Fail-closed defaults
// ---------------------------------------------------------------------------
for (const bad of [undefined, null, "", "admin", "GUEST", 2, {}, ["restricted"]]) {
  check(`unknown caller level ${JSON.stringify(bad)} is treated as guest`, normalizeCallerLevel(bad) === "guest" && JSON.stringify(allowedVisibilities(bad)) === '["guest"]');
}
for (const bad of [undefined, null, "", "public", "Guest", 0]) {
  check(`unknown knowledge visibility ${JSON.stringify(bad)} is visible only to restricted`, !canAccess("guest", bad) && !canAccess("staff", bad) && canAccess("restricted", bad));
}
check("an unknown caller cannot see even staff knowledge", !canAccess("nonsense", "staff"));
same("maxVisibility picks the highest valid level", maxVisibility(["guest", "staff", "guest"]), "staff");
same("maxVisibility ignores invalid entries", maxVisibility([undefined, "guest", "bogus"]), "guest");
same("maxVisibility of nothing is undefined", maxVisibility([]), undefined);
same("maxVisibility of restricted wins", maxVisibility(["restricted", "staff"]), "restricted");

// ---------------------------------------------------------------------------
// 3. Schema defaults and validation (no database connection needed)
// ---------------------------------------------------------------------------
{
  const id = () => new mongoose.Types.ObjectId();
  const chunk = new KnowledgeChunk({ documentId: id(), version: 1, workspaceId: id(), chunkIndex: 0, text: "x" });
  check("KnowledgeChunk.visibility defaults to restricted", chunk.visibility === "restricted");
  check("KnowledgeChunk accepts each valid visibility", VISIBILITY_LEVELS.every((v) => !new KnowledgeChunk({ documentId: id(), version: 1, workspaceId: id(), chunkIndex: 0, text: "x", status: "active", visibility: v }).validateSync()));
  check("KnowledgeChunk rejects an invalid visibility", !!new KnowledgeChunk({ documentId: id(), version: 1, workspaceId: id(), chunkIndex: 0, text: "x", visibility: "public" }).validateSync()?.errors?.visibility);
  const doc = new KnowledgeDocument({ workspaceId: id(), title: "t", documentType: "sop", content: "c", contentHash: "h" });
  check("KnowledgeDocument.defaultVisibility defaults to staff", doc.defaultVisibility === "staff");
  check("KnowledgeDocument rejects an invalid defaultVisibility", !!new KnowledgeDocument({ workspaceId: id(), title: "t", documentType: "sop", content: "c", contentHash: "h", defaultVisibility: "everyone" }).validateSync()?.errors?.defaultVisibility);
  check("Intelligence.knowledgeVisibility has no default (absent = no knowledge used)", new Intelligence({ workspaceId: id() }).knowledgeVisibility === undefined);
  check("Intelligence rejects an invalid knowledgeVisibility", !!new Intelligence({ workspaceId: id(), knowledgeVisibility: "public" }).validateSync()?.errors?.knowledgeVisibility);
  check("existing chunk fields are still present (section, sectionPath, embeddingInputVersion)", ["section", "sectionPath", "embeddingInputVersion", "embedding", "text"].every((p) => KnowledgeChunk.schema.path(p)));
}

// ---------------------------------------------------------------------------
// 4. Classification mechanism
// ---------------------------------------------------------------------------
const M = (over = {}) => ({
  preamble: { action: "exclude", visibility: "not applicable", reason: "preamble" },
  entries: [
    { number: "1", title: "Alpha Facts", action: "include", visibility: "guest", reason: "r" },
    { number: "2", title: "Beta Procedure", action: "include", visibility: "staff", reason: "r" },
    { number: "3", title: "Gamma Draft", action: "hold", visibility: "restricted", reason: "r" },
    { number: "5", title: "Epsilon Protected", action: "include", visibility: "restricted", reason: "r" },
    { number: "4", title: "Delta Notes", action: "exclude", visibility: "not applicable", reason: "r" },
  ],
  ...over,
});
{
  const m = M();
  same("exact number+title match is honoured", classifySection("1. Alpha Facts", m).visibility, "guest");
  same("title comparison ignores case and extra whitespace", classifySection("2.   beta   PROCEDURE", m).visibility, "staff");
  check("a section absent from the mapping fails closed to hold/restricted", (() => { const d = classifySection("9. Unknown Topic", m); return d.action === "hold" && d.visibility === "restricted" && d.matched === false; })());
  check("right number but changed title fails closed", classifySection("1. Alpha Facts Revised", m).action === "hold");
  check("right title but changed number fails closed", classifySection("7. Alpha Facts", m).action === "hold");
  check("an unnumbered heading fails closed", classifySection("Alpha Facts", m).action === "hold");
  check("preamble (no heading) uses the preamble decision", classifySection("", m).action === "exclude");
  check("nothing unmatched is ever classified guest", ["5. Nope", "Random", "1.1 Alpha Facts", "x"].every((s) => classifySection(s, m).visibility !== "guest"));
  const classify = createChunkClassifier(m);
  same("chunk classifier: include + visibility for a mapped section", classify({ section: "2. Beta Procedure" }), { include: true, visibility: "staff" });
  same("a mapping can still include restricted knowledge (the level stays valid)", classify({ section: "5. Epsilon Protected" }), { include: true, visibility: "restricted" });
  same("chunk classifier: hold is not included", classify({ section: "3. Gamma Draft" }).include, false);
  same("chunk classifier: unmapped is not included", classify({ section: "8. Mystery" }).include, false);
  for (const bad of [
    { entries: [], preamble: undefined },
    M({ entries: [{ number: "1", title: "A", action: "publish", visibility: "guest", reason: "r" }] }),
    M({ entries: [{ number: "1", title: "A", action: "include", visibility: "public", reason: "r" }] }),
    M({ entries: [{ number: "1", title: "A", action: "include", visibility: "not applicable", reason: "r" }] }),
    M({ entries: [{ number: "1", title: "A", action: "include", visibility: "guest", reason: "" }] }),
    M({ entries: [{ number: "1", title: "A", action: "include", visibility: "guest", reason: "r" }, { number: "1", title: "a", action: "exclude", visibility: "not applicable", reason: "r" }] }),
  ]) {
    let threw = false;
    try { assertValidMapping(bad); } catch { threw = true; }
    check("an invalid mapping is rejected loudly", threw);
  }
}

// ---------------------------------------------------------------------------
// 5. The reviewed v2 mapping, exercised on a synthetic document that reuses
//    its section headings with invented bodies.
// ---------------------------------------------------------------------------
{
  const BODY = "Invented sample line for a classification test.";
  const headings = [
    "# 1. Property Master", "# 2. Property Structure & Inventory", "# 3. Facilities & Accommodation Model",
    "# 4. Current Rate Card & Occupancy-Based 3BHK Tariff", "# 5. Laundry", "# 6. Standard Stay Timings & Add-on Charges",
    "# 7. Booking & Check-in/Check-out Operations", "## 7.1 Booking", "## 7.2 Check-in", "## 7.3 Check-out & Post Check-out",
    "# 8. Early Check-in / Late Checkout", "# 9. Booking Modification & Extension", "# 10. Cancellation & Refund",
    "# 11. Guest Rules", "# 12. Food & Beverage", "# 13. Housekeeping", "# 14. Guest Complaints", "# 15. Maintenance",
    "# 16. Service Recovery / Compensation", "# 17. Damage / Missing Items / Lost Key", "# 18. Payment / Billing Disputes",
    "# 19. Staff Roles & Escalation — Staff Knowledge", "# 20. Daily Operational Pattern — Staff Knowledge",
    "# 21. Current Data / Knowledge Boundaries", "# 22. Emergency Procedures — PROVISIONAL / HOLD",
    "# 23. Restricted Information — Not for Guest RAG", "# 24. Excluded From Business Knowledge Corpus",
  ];
  const doc = `TITLE BLOCK WITHOUT A HEADING\n\n${headings.map((h) => `${h}\n\n${BODY} ${h.replace(/^#+\s*/, "")}\n`).join("\n")}`;
  const chunks = chunkContent(doc);
  const rows = classifyChunks(chunks, KOLAM_GANDHI_V2_MAPPING);
  const by = (fn) => rows.filter(fn).map((r) => r.section);

  check("the v2 mapping is itself valid", (() => { try { assertValidMapping(KOLAM_GANDHI_V2_MAPPING); return true; } catch { return false; } })());
  check("every chunk of the document is matched by an explicit mapping entry (no fail-closed fallbacks)", rows.every((r) => r.matched), JSON.stringify(rows.filter((r) => !r.matched).map((r) => r.section)));
  same("guest sections are exactly the reviewed guest-facing set", by((r) => r.action === "include" && r.visibility === "guest").map((s) => s.split(" ")[0]), ["1.", "2.", "3.", "4.", "5.", "6.", "10.", "11."]);
  check("booking/check-in/check-out workflows (7.x) are staff", ["7.1 Booking", "7.2 Check-in", "7.3 Check-out & Post Check-out"].every((s) => rows.find((r) => r.section === s)?.visibility === "staff"));
  check("early check-in/late checkout (mixed guest charges + staff handling) is staff, not guest", rows.find((r) => r.section.startsWith("8."))?.visibility === "staff");
  check("food & beverage (mixed guest info + staff service steps) is staff, not guest", rows.find((r) => r.section.startsWith("12."))?.visibility === "staff");
  check("no section known to mix staff-only content is guest-visible (8 and 12)", ["8.", "12."].every((n) => rows.find((r) => r.section.startsWith(n))?.visibility !== "guest"));
  check("housekeeping/complaints/maintenance/recovery/damage/billing/roles/pattern are staff", ["13.", "14.", "15.", "16.", "17.", "18.", "19.", "20."].every((n) => rows.find((r) => r.section.startsWith(n))?.visibility === "staff"));
  check("21 (knowledge/application boundaries) is excluded, not ingested", rows.find((r) => r.section.startsWith("21."))?.action === "exclude");
  const emergency = rows.find((r) => r.section.startsWith("22."));
  check("the PROVISIONAL / HOLD emergency section is held, not included", emergency.action === "hold" && emergency.visibility === "restricted");
  const excluded = rows.find((r) => r.section.startsWith("24."));
  check("the explicit exclusion section is excluded", excluded.action === "exclude");
  check("the title block (preamble) is excluded", rows.find((r) => r.section === "").action === "exclude");
  check("the restricted-information description (23) is excluded, not ingested as a chunk", rows.find((r) => r.section.startsWith("23."))?.action === "exclude");
  check("no v2 section is ingested at restricted (the level stays valid, just unused by this source)", !rows.some((r) => r.action === "include" && r.visibility === "restricted"));
  const ingested = rows.filter((r) => r.action === "include");
  check("nothing held or excluded would be ingested", ingested.every((r) => !r.section.startsWith("22.") && !r.section.startsWith("24.") && r.section !== ""));
  check("no ingested chunk is guest-visible unless it is in the reviewed guest set", ingested.filter((r) => r.visibility === "guest").length === 8);
  check("ingested + held + excluded accounts for every chunk", ingested.length + rows.filter((r) => r.action === "hold").length + rows.filter((r) => r.action === "exclude").length === rows.length);
  same("classification is deterministic", classifyChunks(chunkContent(doc), KOLAM_GANDHI_V2_MAPPING), rows);
  check("mapping entries carry section numbers/titles and reasons only (no contact-shaped values)", !/@|\d{5,}/.test(JSON.stringify(KOLAM_GANDHI_V2_MAPPING)));
}

// ---------------------------------------------------------------------------
// 5b. Corpus profile registry: explicit identity -> reviewed mapping
// ---------------------------------------------------------------------------
{
  const profile = getCorpusProfile("kolam-gandhi-v2");
  check("the v2 profile is registered and binds the approved mapping", !!profile && profile.mapping === KOLAM_GANDHI_V2_MAPPING && profile.id === "kolam-gandhi-v2");
  check("the v2 profile's default visibility is staff (never guest)", profile.defaultVisibility === "staff");
  check("the registry and its profiles are frozen", Object.isFrozen(CORPUS_PROFILES) && Object.isFrozen(profile));
  for (const bad of [undefined, null, "", "Kolam Gandhi SOP v2", "Kolam_Gandhi_SOP_v2_Business_Knowledge.docx", "kolam-gandhi-v2 ", "KOLAM-GANDHI-V2", "constructor", "__proto__", "toString", 5, {}]) {
    check(`only the exact registered id selects a profile (${JSON.stringify(bad)} does not)`, getCorpusProfile(bad) === undefined && classifierForProfile(bad) === null);
  }
  const classify = classifierForProfile("kolam-gandhi-v2");
  same("the profile's classifier includes a mapped guest section", classify({ section: "10. Cancellation & Refund" }), { include: true, visibility: "guest" });
  same("the profile's classifier includes mixed sections 8 and 12 only as staff", [classify({ section: "8. Early Check-in / Late Checkout" }), classify({ section: "12. Food & Beverage" })], [{ include: true, visibility: "staff" }, { include: true, visibility: "staff" }]);
  check("the profile's classifier withholds held/excluded/unmapped/title-block chunks", ["22. Emergency Procedures — PROVISIONAL / HOLD", "21. Current Data / Knowledge Boundaries", "23. Restricted Information — Not for Guest RAG", "24. Excluded From Business Knowledge Corpus", "25. Something New", ""].every((s) => classify({ section: s }).include === false));
}

// ---------------------------------------------------------------------------
// 6. Visibility never enters the embedding text
// ---------------------------------------------------------------------------
{
  const text = "Invented body text.";
  const withMeta = { sectionPath: ["1. Alpha", "1.1 Beta"], section: "1.1 Beta", text, visibility: "restricted", embeddingInputVersion: 1 };
  const without = { sectionPath: ["1. Alpha", "1.1 Beta"], section: "1.1 Beta", text };
  same("embedding text is identical with or without visibility metadata", buildEmbeddingText(withMeta), buildEmbeddingText(without));
  same("embedding text is exactly path lines + text", buildEmbeddingText(withMeta), `1. Alpha\n1.1 Beta\n${text}`);
  check("embedding text does not contain visibility words", !/restricted|staff|guest/i.test(buildEmbeddingText(withMeta)));
  check("embeddingInputVersion is unchanged at 1", EMBEDDING_INPUT_VERSION === 1);
  const source = fs.readFileSync(new URL("../src/services/knowledge/embeddingText.js", import.meta.url), "utf8");
  check("embeddingText.js does not read a visibility field", !/\bvisibility\b/i.test(source.replace(/\/\*[\s\S]*?\*\//g, "")));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
