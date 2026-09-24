/**
 * Chunker heading-detection regression suite (pure: no server, no MongoDB,
 * no embeddings, no files outside the repo).
 *
 * Guards the numbered-heading rule in knowledgeChunker.js. The original rule
 * treated ANY short, unpunctuated line that began with a number ("7 guests",
 * a phone-number-shaped line, "24 hour operation") as a heading and kept only
 * the text after the number in `section` - so the number, and with it the
 * line's meaning, was silently dropped from the stored knowledge.
 *
 * All fixtures are SYNTHETIC and invented for this suite. They imitate the
 * SHAPES that exposed the bug (a table row whose value is a spaced,
 * phone-style number; a table of "<N> guests" rows with prices; digit-led
 * prose) using made-up labels, amounts, times, names and numbers. No fixture
 * reproduces any real organization's document text, policies, rates,
 * schedules, contacts or operational data. The only fixed strings are the
 * generic digit-led / heading shapes the regression cases are about (for
 * example "7 guests", "24 hour operation", "1.5 hours before check-in",
 * "1. Housekeeping"), which are ordinary phrases, not any document's content.
 */
import { chunkContent } from "../src/services/knowledge/knowledgeChunker.js";

let passed = 0;
let failed = 0;
const ok = (name) => { passed += 1; console.log(`PASS  ${name}`); };
const fail = (name, detail = "") => { failed += 1; console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`); };
const check = (name, cond, detail = "") => (cond ? ok(name) : fail(name, detail));
const sections = (chunks) => chunks.map((c) => c.section);
const inText = (chunks, needle) => chunks.some((c) => c.text.includes(needle));
const inSameChunk = (chunks, ...needles) => chunks.some((c) => needles.every((n) => c.text.includes(n)));

// Extractor-shaped text: table cells arrive one per line, separated by blank lines.
const cells = (...values) => values.join("\n\n");

// ---------------------------------------------------------------------------
// 1. A phone-number-shaped table cell must stay body text and stay recoverable
// ---------------------------------------------------------------------------
{
  const PHONE = "10001 20002 / 30003 40004";
  const doc = `# 2. SITE DETAILS\n\n${cells("Attribute", "Value", "Site name", "Example Site", "Public line", PHONE, "Help desk", "9 to 5 coverage", "Booking tool", "Example Tool")}\n`;
  const chunks = chunkContent(doc);
  check("phone-shaped line is NOT turned into a section", !sections(chunks).some((s) => s.includes("20002 / 30003 40004")), JSON.stringify(sections(chunks)));
  check("phone-shaped line is recoverable verbatim from chunk text", inText(chunks, PHONE), JSON.stringify(chunks));
  check("its label stays in the same chunk as its value", inSameChunk(chunks, "Public line", PHONE));
  check("the only section is the real heading", JSON.stringify(sections(chunks)) === JSON.stringify(["2. SITE DETAILS"]), JSON.stringify(sections(chunks)));
}

// ---------------------------------------------------------------------------
// 2. "<N> guests" table rows: label and value must stay together (7, 8, 9, 10)
// ---------------------------------------------------------------------------
{
  const rows = [["Up to 2 guests", "₹2,110/night"], ["Up to 4 guests", "₹2,220/night"], ["7 guests", "₹2,331/night"], ["8 guests", "₹2,442/night"], ["9 guests", "₹2,553/night"], ["10 guests", "₹2,664/night"]];
  const doc = `# 5. PRICING\n\n${cells("Group size", "Nightly fee", ...rows.flat())}\n\n- All amounts are synthetic nightly fees.\n`;
  const chunks = chunkContent(doc);
  for (const [label, price] of rows.slice(2)) {
    const together = chunks.some((c) => new RegExp(`${label}\\s+${price.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(c.text));
    check(`"${label}" stays together with "${price}" in one chunk`, together, JSON.stringify(chunks.map((c) => c.text)));
  }
  check("no digit-led table label became a section", !sections(chunks).some((s) => /guests/.test(s)), JSON.stringify(sections(chunks)));
  check("no fragment chunk holds just a price", chunks.every((c) => c.text.length > 40), JSON.stringify(chunks.map((c) => c.text.length)));
}

// ---------------------------------------------------------------------------
// 3. Genuine numbered headings keep working, and now keep their prefix
// ---------------------------------------------------------------------------
{
  const chunks = chunkContent("1. Housekeeping\n\nGeneral sample guidance for staff.\n\n2. Check-in\n\nGeneral sample guidance for staff.\n");
  check('"1. Housekeeping" is a heading and its prefix is preserved in the section', JSON.stringify(sections(chunks)) === JSON.stringify(["1. Housekeeping", "2. Check-in"]), JSON.stringify(sections(chunks)));
}
{
  const chunks = chunkContent("1. Visitor Notes\n\nIntro.\n\n1.1 Smoking\n\nSynthetic body one.\n\n1.2 Pets\n\nSynthetic body two.\n\n2. Operations\n\nSynthetic ops text.\n");
  check('nested numbered headings ("1.1 Smoking") still work, prefix preserved', JSON.stringify(sections(chunks)) === JSON.stringify(["1. Visitor Notes", "1.1 Smoking", "1.2 Pets", "2. Operations"]), JSON.stringify(sections(chunks)));
}
{
  const chunks = chunkContent("12.3.4 Deep Nested Heading\n\nBody under a deeper numbered heading.\n");
  check('deeper numbered heading ("12.3.4 Deep Nested Heading") works, prefix preserved', JSON.stringify(sections(chunks)) === JSON.stringify(["12.3.4 Deep Nested Heading"]), JSON.stringify(sections(chunks)));
}
{
  const chunks = chunkContent("1.1. Trailing Dot Style\n\nBody.\n");
  check('"1.1." (trailing dot after a nested number) is still a heading', JSON.stringify(sections(chunks)) === JSON.stringify(["1.1. Trailing Dot Style"]), JSON.stringify(sections(chunks)));
}

// ---------------------------------------------------------------------------
// 4. Numbered steps and digit-led body lines must stay body text
// ---------------------------------------------------------------------------
{
  const steps = "## Sample Procedure\n\n1. Verify guest identity.\n2. Complete the sample form.\n3. Hand over the sample item.\n";
  const chunks = chunkContent(steps);
  check('punctuated steps ("1. Verify guest identity.") stay body text', JSON.stringify(sections(chunks)) === JSON.stringify(["Sample Procedure"]) && chunks[0].text === "1. Verify guest identity.\n2. Complete the sample form.\n3. Hand over the sample item.", JSON.stringify(chunks));
}
for (const line of ["24 hour operation", "10 minutes before arrival, please call the front desk", "10 minutes before arrival, call the desk.", "1.5 hours before check-in", "2.5 hours notice is required", "3 rooms with a sample view", "2nd level", "44/7, Sample Street, Testville"]) {
  const chunks = chunkContent(`Intro text.\n\n${line}\n\nBody text after.\n`);
  check(`digit-led body line stays body text and recoverable: ${JSON.stringify(line)}`, sections(chunks).every((s) => s === "") && inText(chunks, line), JSON.stringify(chunks));
}

// ---------------------------------------------------------------------------
// 5. Documented / characterized behaviors (deliberate, not endorsements)
// ---------------------------------------------------------------------------
{
  // Bare-integer numbering ("2 Check-in", no dot) is NOT recognized as a heading:
  // it is indistinguishable from "7 guests" / "24 hour operation" by text alone.
  // The line is kept as body text, so no information is lost.
  const chunks = chunkContent("1 Housekeeping\n\nGeneral sample guidance.\n\n2 Check-in\n\nGeneral sample guidance.\n");
  check('bare "2 Check-in" is body text (bare-integer numbering is not a heading)', sections(chunks).every((s) => s === ""), JSON.stringify(sections(chunks)));
  check('bare "2 Check-in" is retained in chunk text (nothing lost)', inText(chunks, "2 Check-in") && inText(chunks, "1 Housekeeping"), JSON.stringify(chunks));
}
{
  // KNOWN LIMITATION (characterization): an UNPUNCTUATED, uppercase-initial dotted
  // numbered line is still read as a heading. Text alone cannot tell it from a
  // genuine "1. Housekeeping"; only extractor-level structure could.
  const chunks = chunkContent("Intro text.\n\n3. Prepare sample output\n\nBody.\n");
  check("KNOWN LIMITATION: unpunctuated '3. Prepare sample output' is still detected as a heading (prefix preserved, not lost)", sections(chunks).includes("3. Prepare sample output"), JSON.stringify(sections(chunks)));
}
{
  // Empty-parent-heading behavior is UNCHANGED by this fix: a heading with no
  // body of its own contributes no chunk, so its title is not stored anywhere.
  const chunks = chunkContent("# 8. PARENT TITLE\n\n## 8.1 Child topic\n\n- Sample body line.\n");
  check("CHARACTERIZATION: an empty parent heading ('8. PARENT TITLE') produces no chunk of its own", JSON.stringify(sections(chunks)) === JSON.stringify(["8.1 Child topic"]), JSON.stringify(sections(chunks)));
  check("CHARACTERIZATION: the empty parent's title is stored nowhere", !chunks.some((c) => c.section.includes("PARENT TITLE") || c.text.includes("PARENT TITLE")));
}

// ---------------------------------------------------------------------------
// 6. Lossless coverage on a representative SYNTHETIC document
//    (title block, numbered/nested/unnumbered headings, bullets, and
//    cell-per-line tables containing digit-led cells, times, amounts and
//    phone-style numbers - every value invented for this fixture)
// ---------------------------------------------------------------------------
{
  const fixture = [
    "EXAMPLE LODGING COMPLEX – TESTVILLE",
    "SYNTHETIC FIXTURE DOCUMENT",
    "Version 0.0 | Scope: fixture only",
    "# 1. FIXTURE OVERVIEW",
    "This synthetic document exists only to test chunking.",
    "- Follow the first sample rule.",
    "- Follow the second sample rule.",
    "# 2. SITE DETAILS",
    cells("Attribute", "Value", "Site name", "Example Site", "Location", "12/3, Sample Street, Testville", "Public line", "10001 20002 / 30003 40004", "Help desk", "9 to 5 coverage"),
    "# 3. LAYOUT",
    "- 4 wings; 3 blocks per wing; 12 blocks total.",
    "- 1st Wing: X1, X2.",
    "# 5. PRICING",
    "Amounts below are synthetic.",
    cells("Type", "Base", "Plus", "Add-on", "Type Alpha", "₹2,010", "₹2,120", "₹44"),
    "PRICING BY GROUP SIZE",
    cells("Group size", "Nightly fee", "Up to 2 guests", "₹2,110/night", "Up to 4 guests", "₹2,220/night", "7 guests", "₹2,331/night", "8 guests", "₹2,442/night", "9 guests", "₹2,553/night", "10 guests", "₹2,664/night"),
    "- Above 4 guests: add a synthetic amount per guest.",
    "# 7. SCHEDULE",
    cells("Slot", "Time", "Opening", "08:15 AM", "Closing", "05:45 PM"),
    "# 15. CATERING",
    cells("Item", "Details", "Snack A", "7:10–8:20 AM; included", "Snack B", "3:40–4:50 PM; extra fee"),
    "# 13. SAMPLE POLICY",
    "General policy text sits under its own parent heading here.",
    "## 13.1 Alpha short cases",
    "- A sample credit is issued when a request arrives at least 9 days early.",
    "## 13.2 Alpha long cases",
    "- A sample deposit of 25% is noted at signup.",
    "# 24. CALL LIST",
    cells("Role", "Number", "Purpose", "Lead – Example One", "1000000001", "Approvals", "1st Wing Helper – Example Two", "1000000002", "Wing support"),
    "## Beta Procedure – General Note",
    "Synthetic note text.",
    "# GAMMA PROCEDURES – DRAFT",
    "Draft synthetic text.",
    "## 32.1 Scenario One",
    "- 1. Perform the first sample step.",
    "- 2. Perform the second sample step.",
  ].join("\n\n");
  const chunks = chunkContent(fixture);
  const sectionSet = new Set(chunks.map((c) => c.section));
  const unrecoverable = fixture.split("\n").map((l) => l.trim()).filter(Boolean).filter((l) => {
    const bare = l.replace(/^#{1,6}\s+/, "").trim();
    return !(chunks.some((c) => c.text.includes(l)) || sectionSet.has(bare));
  });
  check("LOSSLESS: every non-blank line of a synthetic document is recoverable from a chunk's text or its section", unrecoverable.length === 0, JSON.stringify(unrecoverable));
  const bareFragment = (t) => /^\s*[₹$]?[\d,./]+(\/night)?\s*$/.test(t);
  check("no chunk is a bare price/number fragment of a table", chunks.every((c) => !bareFragment(c.text)), JSON.stringify(chunks.filter((c) => bareFragment(c.text))));
  check("no non-heading line became a section (every section is a real marker heading)", [...sectionSet].filter(Boolean).every((s) => fixture.includes("# " + s)), JSON.stringify([...sectionSet].filter((s) => s && !fixture.includes("# " + s))));
  check("real headings keep their numbering in the section", sectionSet.has("5. PRICING") && sectionSet.has("13.1 Alpha short cases"));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
