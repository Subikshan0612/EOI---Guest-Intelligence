/**
 * DRY RUN - classify the real Business Knowledge v2 document into the RAG
 * corpus plan, without ingesting anything.
 *
 *   node scripts/dry-run-knowledge-corpus.mjs [path-to-docx]
 *
 * Reads the DOCX locally, extracts and chunks it with the same code the real
 * ingestion uses, applies the reviewed section mapping, and prints one row
 * per chunk: section, visibility, include/hold/exclude, reason.
 *
 * It NEVER writes to MongoDB, NEVER calls an embedding or LLM provider, makes
 * no network call at all, and writes no file. It imports no database or
 * HTTP-client module. It prints section labels, decisions and counts only -
 * never document text, and never a matched phone number or email.
 *
 * Exit code 0 = every check passed; 1 = something needs review.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractDocumentText } from "../src/services/knowledge/documentExtractor.js";
import { chunkContent } from "../src/services/knowledge/knowledgeChunker.js";
import { classifyChunks } from "../src/services/knowledge/corpusClassification.js";
import { KOLAM_GANDHI_V2_MAPPING } from "../src/services/knowledge/mappings/kolamGandhiV2.js";
import { buildEmbeddingText } from "../src/services/knowledge/embeddingText.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "..", "data", "Business Knowledge");
const V2_NAME = "Kolam_Gandhi_SOP_v2_Business_Knowledge.docx";
const OLD_NAME = "Kolam_Gandhi_SOP.docx";
const target = process.argv[2] ? path.resolve(process.argv[2]) : path.join(DATA_DIR, V2_NAME);

// The current 3BHK tariff the v2 document declares authoritative. Used only
// to prove the rate section still carries exactly these daily charges and
// nothing older; no superseded value is named or listed here.
const CURRENT_DAILY_CHARGES = ["11,500", "12,700", "13,260", "13,820", "14,380", "14,940"];
const RATE_SECTION = "Current Rate Card & Occupancy-Based 3BHK Tariff";
const PUBLISHED_CONTACT_SECTION = "1. Property Master";

let failures = 0;
const line = (status, name, detail = "") => {
  if (status === "FAIL") failures += 1;
  console.log(`${status}  ${name}${detail ? ` - ${detail}` : ""}`);
};
const check = (name, cond, detail) => line(cond ? "PASS" : "FAIL", name, cond ? "" : detail);

// ---- source files -----------------------------------------------------------
check("v2 source document exists", fs.existsSync(target), target);
check("the old Kolam_Gandhi_SOP.docx is no longer present", !fs.existsSync(path.join(DATA_DIR, OLD_NAME)));
if (!fs.existsSync(target)) process.exit(1);

const { text } = await extractDocumentText({ originalName: path.basename(target), buffer: fs.readFileSync(target) });
const chunks = chunkContent(text);
const rows = classifyChunks(chunks, KOLAM_GANDHI_V2_MAPPING);

// ---- the classification table ----------------------------------------------
console.log(`\n${chunks.length} chunks (${text.length} characters extracted)\n`);
console.log("idx  visibility   decision  chars  section  ::  reason");
for (const row of rows) {
  const chars = chunks[row.chunkIndex].text.length;
  console.log(
    `${String(row.chunkIndex).padStart(3)}  ${row.visibility.padEnd(11)}  ${row.action.padEnd(8)}  ${String(chars).padStart(5)}  ${row.section || "(title block)"}  ::  ${row.reason}`,
  );
}

const by = (action) => rows.filter((row) => row.action === action);
const included = by("include");
const count = (level) => included.filter((row) => row.visibility === level).length;
console.log(`\nSummary: include=${included.length} (guest=${count("guest")}, staff=${count("staff")}, restricted=${count("restricted")}), hold=${by("hold").length}, exclude=${by("exclude").length}\n`);

// ---- checks -----------------------------------------------------------------
check("every chunk is matched by an explicit reviewed mapping entry (no fail-closed fallbacks)", rows.every((row) => row.matched), rows.filter((row) => !row.matched).map((row) => row.section).join("; "));
check("the PROVISIONAL / HOLD emergency section is held and not included", by("hold").some((row) => /PROVISIONAL \/ HOLD/.test(row.section)) && !included.some((row) => /Emergency/i.test(row.section)));
check("the explicit exclusion section is excluded", by("exclude").some((row) => /Excluded From Business Knowledge Corpus/.test(row.section)));
check("the title block is excluded", by("exclude").some((row) => row.section === ""));
check("section 21 (knowledge boundaries) is excluded", by("exclude").some((row) => /^21\./.test(row.section)));
check("section 23 (restricted-information description) is excluded", by("exclude").some((row) => /^23\./.test(row.section)));
check("section 22 stays held", by("hold").some((row) => /^22\./.test(row.section)));
check("no chunk is ingested at restricted visibility for this source", !included.some((row) => row.visibility === "restricted"));
check("no AI-rule / checklist / template / historical-record section is included", !included.some((row) => /AI |Checklist|Template|Historical|Master Process|Approval/i.test(row.section)));
check("no included chunk is guest-visible unless it is in the reviewed guest set", included.filter((row) => row.visibility === "guest").every((row) => /^(1|2|3|4|5|6|10|11)\./.test(row.section)));
check("mixed/staff sections (7.x, 8, 9, 12-20) are staff, never guest", included.filter((row) => /^(7\.\d|8|9|1[2-9]|20)[. ]/.test(row.section)).every((row) => row.visibility === "staff"));
check("sections 8 and 12 (guest facts mixed with staff handling) are staff", ["8.", "12."].every((n) => rows.find((row) => row.section.startsWith(n))?.visibility === "staff"));

// Report-only review aid (never a pass/fail decision): guest-visible chunks that
// mention staff-operations vocabulary, listed by section label only.
const STAFF_VOCABULARY = /Front Office|caretaker|Operations Group|Divya|escalat/i;
const guestWithStaffWords = included.filter((row) => row.visibility === "guest" && STAFF_VOCABULARY.test(chunks[row.chunkIndex].text)).map((row) => row.section);
console.log(`INFO  guest chunks that mention staff-operations vocabulary (review aid): ${guestWithStaffWords.length ? guestWithStaffWords.join("; ") : "none"}`);

// Tripwire, NOT an authority: report-only scan for contact-shaped values in
// what would be ingested. Only the published-contact section may hold one.
const CONTACT_LIKE = /[\w.+-]+@[\w-]+\.[\w.]+|\+?\d[\d\s\-()/]{8,}\d/;
const contactBearing = included.filter((row) => CONTACT_LIKE.test(chunks[row.chunkIndex].text));
check(
  "contact-shaped values appear only in the published-contact section among ingested chunks",
  contactBearing.every((row) => row.section === PUBLISHED_CONTACT_SECTION),
  contactBearing.map((row) => row.section).join("; "),
);
console.log(`INFO  ingested chunks containing a contact-shaped value: ${contactBearing.length} (${contactBearing.map((row) => row.section).join("; ") || "none"}); values are never printed`);
const notIngestedWithContacts = rows.filter((row) => row.action !== "include" && CONTACT_LIKE.test(chunks[row.chunkIndex].text)).length;
console.log(`INFO  held/excluded chunks containing a contact-shaped value: ${notIngestedWithContacts}`);

// Rate section: the current daily charges are present, in order, and no older tariff text or extra large amounts survive.
const rate = rows.find((row) => row.section.endsWith(RATE_SECTION));
const rateText = rate ? chunks[rate.chunkIndex].text : "";
check("the rate section is included at guest visibility", !!rate && rate.action === "include" && rate.visibility === "guest");
// Tariff rows only ("<N> guests: ₹X/day"), not the worked example line beneath them.
const chargeAmounts = [...rateText.matchAll(/guests:\s*₹\s?(\d{1,3}(?:,\d{3})+)\/day/g)].map((match) => match[1]);
check("the current 3BHK daily charges are all present, in order", JSON.stringify(chargeAmounts) === JSON.stringify(CURRENT_DAILY_CHARGES), JSON.stringify(chargeAmounts));
check("no other large (4+ digit) daily amount and no 'older/previous/superseded' wording appears in the rate section", !/older|previous|superseded|obsolete|legacy|old rate/i.test(rateText) && [...rateText.matchAll(/₹\s?(\d{1,3}(?:,\d{3})+)/g)].map((m) => m[1]).filter((amount) => Number(amount.replace(/,/g, "")) >= 10000).every((amount) => CURRENT_DAILY_CHARGES.includes(amount)));

// Embedding text for an ingested chunk never carries visibility.
const sample = included[0];
const sampleText = buildEmbeddingText({ ...chunks[sample.chunkIndex], visibility: sample.visibility });
check("embedding text for a sample chunk equals sectionPath + text and contains no visibility metadata", sampleText === [...chunks[sample.chunkIndex].sectionPath, ""].join("\n") + chunks[sample.chunkIndex].text && !/\b(guest|staff|restricted)\b/i.test(sampleText.slice(0, sampleText.length - chunks[sample.chunkIndex].text.length)));

console.log("\nDry run only: nothing was written to MongoDB, no embedding or LLM provider was called, and no file was written.");
process.exit(failures === 0 ? 0 : 1);
