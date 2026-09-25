/**
 * Section-path and embedding-text regression suite (pure: no server, no
 * MongoDB, no embeddings, no network, no files outside the repo).
 *
 * Guards two things:
 *   1. computeSectionPaths / chunkContent derive `sectionPath` ONLY from
 *      explicit structure (dotted numbering, Markdown levels) and never invent
 *      a parent from mere document order.
 *   2. buildEmbeddingText is the deterministic, identifier-free recipe for
 *      what a chunk is embedded as.
 *
 * All fixtures are SYNTHETIC and invented for this suite; none reproduces any
 * real organization's document text.
 */
import { chunkContent } from "../src/services/knowledge/knowledgeChunker.js";
import { computeSectionPaths } from "../src/services/knowledge/sectionPath.js";
import { buildEmbeddingText, EMBEDDING_INPUT_VERSION } from "../src/services/knowledge/embeddingText.js";

let passed = 0;
let failed = 0;
const ok = (name) => { passed += 1; console.log(`PASS  ${name}`); };
const fail = (name, detail = "") => { failed += 1; console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`); };
const check = (name, cond, detail = "") => (cond ? ok(name) : fail(name, detail));
const same = (name, actual, expected) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);

const plain = (text) => ({ text, level: null });
const md = (text, level) => ({ text, level });
const paths = (chunks) => chunks.map((c) => c.sectionPath);
const BODY = "General sample guidance for staff.";

// ---------------------------------------------------------------------------
// 1. Numbered hierarchy
// ---------------------------------------------------------------------------
same("numbered hierarchy: 1 / 1.1 / 1.1.1 / 1.2", computeSectionPaths([
  plain("1. Parent"), plain("1.1 Child"), plain("1.1.1 Grandchild"), plain("1.2 Sibling"),
]), [
  ["1. Parent"],
  ["1. Parent", "1.1 Child"],
  ["1. Parent", "1.1 Child", "1.1.1 Grandchild"],
  ["1. Parent", "1.2 Sibling"],
]);

// ---------------------------------------------------------------------------
// 2. Markdown hierarchy
// ---------------------------------------------------------------------------
same("markdown hierarchy: # / ## / ### / ##", computeSectionPaths([
  md("Parent", 1), md("Child", 2), md("Grandchild", 3), md("Sibling", 2),
]), [
  ["Parent"],
  ["Parent", "Child"],
  ["Parent", "Child", "Grandchild"],
  ["Parent", "Sibling"],
]);

// ---------------------------------------------------------------------------
// 3. Empty parent: heading with no body still heads its children, through chunkContent
// ---------------------------------------------------------------------------
{
  const chunks = chunkContent(`13. Alpha Policy\n\n13.1 First Rule\n\n${BODY}\n\n13.2 Second Rule\n\n${BODY} More.\n`);
  same("empty parent: only the two children produce chunks", chunks.map((c) => c.section), ["13.1 First Rule", "13.2 Second Rule"]);
  same("empty parent: parent title appears in each child's path", paths(chunks), [
    ["13. Alpha Policy", "13.1 First Rule"],
    ["13. Alpha Policy", "13.2 Second Rule"],
  ]);
}
{
  const chunks = chunkContent(`# 13. Alpha Policy\n\n## 13.1 First Rule\n\n${BODY}\n`);
  same("empty parent (Markdown form): parent title in child's path", paths(chunks), [["13. Alpha Policy", "13.1 First Rule"]]);
}

// ---------------------------------------------------------------------------
// 4. Sibling reset
// ---------------------------------------------------------------------------
same("sibling reset: a new top-level heading drops the previous branch", computeSectionPaths([
  plain("1. One"), plain("1.1 One-A"), plain("2. Two"), plain("2.1 Two-A"),
]), [["1. One"], ["1. One", "1.1 One-A"], ["2. Two"], ["2. Two", "2.1 Two-A"]]);
same("sibling reset (Markdown): # after ### starts over", computeSectionPaths([
  md("A", 1), md("A1", 2), md("A1a", 3), md("B", 1), md("B1", 2),
]), [["A"], ["A", "A1"], ["A", "A1", "A1a"], ["B"], ["B", "B1"]]);

// ---------------------------------------------------------------------------
// 5. Skipped levels
// ---------------------------------------------------------------------------
same("skipped Markdown level: # then ### is still a child of #", computeSectionPaths([
  md("Top", 1), md("Deep", 3),
]), [["Top"], ["Top", "Deep"]]);
same("skipped numbering level: 1. then 1.1.1 hangs off 1.", computeSectionPaths([
  plain("1. Top"), plain("1.1.1 Deep"),
]), [["1. Top"], ["1. Top", "1.1.1 Deep"]]);
same("numbering with no numeric ancestor present is a root, not attached to the previous heading", computeSectionPaths([
  plain("2. Other"), plain("5.1 Orphan"),
]), [["2. Other"], ["5.1 Orphan"]]);

// ---------------------------------------------------------------------------
// 6. Mixed numbered + Markdown where the relationship is explicit
// ---------------------------------------------------------------------------
same("numbered Markdown headings: # 4. / ## 4.1 / ### plain-titled child", computeSectionPaths([
  md("4. Parent", 1), md("4.1 Child", 2), md("Detail", 3),
]), [["4. Parent"], ["4. Parent", "4.1 Child"], ["4. Parent", "4.1 Child", "Detail"]]);
same("numbering decides even when only the parent carries a Markdown marker", computeSectionPaths([
  md("6. Parent", 1), plain("6.1 Child"),
]), [["6. Parent"], ["6. Parent", "6.1 Child"]]);
same("unnumbered ## under a numbered # (both Markdown) is explicit", computeSectionPaths([
  md("7. Parent", 1), md("Notes", 2),
]), [["7. Parent"], ["7. Parent", "Notes"]]);

// ---------------------------------------------------------------------------
// 7. Ambiguous unnumbered heading must NOT be attached to the previous one
// ---------------------------------------------------------------------------
same("plain numbered heading followed by an unnumbered ## is NOT a parent/child", computeSectionPaths([
  plain("31. Master Summary"), md("Internal Notes", 2),
]), [["31. Master Summary"], ["Internal Notes"]]);
same("a plain heading between a # and a ## blocks the Markdown link", computeSectionPaths([
  md("Emergency", 1), plain("31. Master Summary"), md("Internal Notes", 2),
]), [["Emergency"], ["31. Master Summary"], ["Internal Notes"]]);
{
  const chunks = chunkContent(`# Emergency\n\n${BODY}\n\n31. Master Summary\n\n${BODY}\n\n## Internal Notes\n\n${BODY}\n`);
  same("same case through chunkContent", paths(chunks), [["Emergency"], ["31. Master Summary"], ["Internal Notes"]]);
}

// ---------------------------------------------------------------------------
// 7b. Final-verification cases, through chunkContent (real heading detection)
// ---------------------------------------------------------------------------
{
  const doc = (...heads) => heads.map((h) => `${h}\n\n${BODY}\n`).join("\n");
  const bySection = (chunks) => Object.fromEntries(chunks.map((c) => [c.section, c.sectionPath]));

  // A: neither the plain numbered heading nor the earlier # may become Internal Contact Updates' parent
  const a = bySection(chunkContent(doc("# Emergency Procedures", "## Fire", "31. MASTER PROCESS SUMMARY", "## Internal Contact Updates")));
  same("case A: ## Fire is a child of # Emergency Procedures", a["Fire"], ["Emergency Procedures", "Fire"]);
  same("case A: Internal Contact Updates inherits neither 31. nor Emergency Procedures", a["Internal Contact Updates"], ["Internal Contact Updates"]);

  // B
  const b = bySection(chunkContent(doc("13. CANCELLATION & REFUND", "13.1 Cancellation Policy", "13.2 Refund Policy")));
  same("case B: 13.1", b["13.1 Cancellation Policy"], ["13. CANCELLATION & REFUND", "13.1 Cancellation Policy"]);
  same("case B: 13.2", b["13.2 Refund Policy"], ["13. CANCELLATION & REFUND", "13.2 Refund Policy"]);

  // C: 1.2 hangs off "1." by the numbering itself even though 1.1 is absent
  same("case C: 1.2 attaches to 1. with 1.1 absent", bySection(chunkContent(doc("1. Parent", "1.2 Child")))["1.2 Child"], ["1. Parent", "1.2 Child"]);

  // D
  const d = bySection(chunkContent(doc("1. Parent", "1.1 Child", "2. New Parent", "2.1 Child")));
  same("case D: 2.1 inherits nothing from 1.x", d["2.1 Child"], ["2. New Parent", "2.1 Child"]);

  // E
  const e = bySection(chunkContent(doc("# Parent", "## Child", "### Grandchild", "## Sibling")));
  same("case E: Child / Grandchild / Sibling", [e["Child"], e["Grandchild"], e["Sibling"]], [["Parent", "Child"], ["Parent", "Child", "Grandchild"], ["Parent", "Sibling"]]);

  // F: a plain heading must not leave a stale Markdown parent behind
  const f = bySection(chunkContent(doc("# Parent", "## Child", "2. Plain Heading", "## Another Heading")));
  same("case F: Another Heading does not inherit Parent across a plain heading", f["Another Heading"], ["Another Heading"]);
  same("case F: Child is unaffected", f["Child"], ["Parent", "Child"]);
}

// ---------------------------------------------------------------------------
// 8. Flat document / preamble
// ---------------------------------------------------------------------------
{
  const chunks = chunkContent(`${BODY}\n\nMore flat text.\n`);
  same("flat document: sectionPath is []", paths(chunks), [[]]);
  same("flat document: section is unchanged (empty)", chunks.map((c) => c.section), [""]);
}
{
  const chunks = chunkContent(`Preamble text before any heading.\n\n# First\n\n${BODY}\n`);
  same("text before the first heading has an empty path, headed text has its own", paths(chunks), [[], ["First"]]);
}

// ---------------------------------------------------------------------------
// 9. Leaf invariant, and chunk contract preserved
// ---------------------------------------------------------------------------
{
  const doc = `# Alpha\n\n${BODY}\n\n## Beta\n\n${BODY}\n\n1. Gamma\n\n${BODY}\n\n1.1 Delta\n\n${BODY}\n\n${BODY}\n`;
  const chunks = chunkContent(doc);
  check("leaf invariant: last path element === section for every headed chunk",
    chunks.every((c) => c.section === "" || c.sectionPath[c.sectionPath.length - 1] === c.section), JSON.stringify(chunks));
  check("no headingless chunk has a non-empty path", chunks.every((c) => c.section !== "" || c.sectionPath.length === 0));
  check("chunk shape is exactly { section, sectionPath, text }",
    chunks.every((c) => JSON.stringify(Object.keys(c).sort()) === JSON.stringify(["section", "sectionPath", "text"])));
}
{
  const long = Array.from({ length: 60 }, (_, i) => `Step ${i + 1} of the sample checklist for staff.`).join("\n\n");
  const chunks = chunkContent(`1. Big\n\n1.1 Checklist\n\n${long}\n`);
  check("a section split into several chunks gives every piece the same path", chunks.length > 1 &&
    chunks.every((c) => JSON.stringify(c.sectionPath) === JSON.stringify(["1. Big", "1.1 Checklist"])), JSON.stringify(paths(chunks)));
  check("split pieces get independent path arrays (no shared mutable state)", chunks[0].sectionPath !== chunks[1].sectionPath);
}

// ---------------------------------------------------------------------------
// 10. Table guard: representative 2/3/4-column tables stay intact in one chunk
// (extractor contract: one cell per line, blank-line separated - unchanged)
// ---------------------------------------------------------------------------
for (const columns of [2, 3, 4]) {
  const header = Array.from({ length: columns }, (_, c) => `Col${c + 1}`);
  const rows = Array.from({ length: 5 }, (_, r) => Array.from({ length: columns }, (_, c) => `r${r + 1}c${c + 1} value`));
  const doc = `# 3. Sample Table\n\n${[...header, ...rows.flat()].join("\n\n")}\n`;
  const chunks = chunkContent(doc);
  check(`${columns}-column table stays in one chunk, header and last cell together`,
    chunks.length === 1 && chunks[0].text.includes("Col1") && chunks[0].text.includes(`r5c${columns} value`), JSON.stringify(chunks.length));
  const order = [...header, ...rows.flat()].map((cell) => chunks[0].text.indexOf(cell));
  check(`${columns}-column table: every cell present in original order`,
    order.every((pos, i) => pos >= 0 && (i === 0 || pos > order[i - 1])), JSON.stringify(order));
  same(`${columns}-column table: path is just the table's heading`, paths(chunks), [["3. Sample Table"]]);
}

// ---------------------------------------------------------------------------
// 11. buildEmbeddingText
// ---------------------------------------------------------------------------
{
  const text = "Alpha handling must follow the sample steps.";
  same("embedding text: full path, one heading per line, then text unchanged",
    buildEmbeddingText({ sectionPath: ["13. Alpha", "13.1 First"], section: "13.1 First", text }),
    `13. Alpha\n13.1 First\n${text}`);
  same("embedding text: no section -> text only", buildEmbeddingText({ sectionPath: [], section: "", text }), text);
  same("embedding text: sectionPath absent and section absent -> text only", buildEmbeddingText({ text }), text);
  same("embedding text: legacy chunk with section but no path falls back to [section]",
    buildEmbeddingText({ section: "Legacy Heading", text }), `Legacy Heading\n${text}`);
  same("embedding text: single-element path", buildEmbeddingText({ sectionPath: ["Only"], section: "Only", text }), `Only\n${text}`);
  same("embedding text: sectionPath wins over section", buildEmbeddingText({ sectionPath: ["A", "B"], section: "ignored", text }), `A\nB\n${text}`);
  same("embedding text: blank path entries are skipped", buildEmbeddingText({ sectionPath: ["A", "  ", ""], section: "A", text }), `A\n${text}`);
  const multiline = "Line one\n\n  indented line\nLine three";
  check("embedding text: chunk text preserved byte-for-byte after the context",
    buildEmbeddingText({ sectionPath: ["H"], section: "H", text: multiline }).endsWith(`\n${multiline}`));
  check("embedding text: no Markdown markers, identifiers or metadata added",
    buildEmbeddingText({ sectionPath: ["13. A", "13.1 B"], section: "13.1 B", text }).split("\n").length === 3 &&
      !/#|›|chunk|document|workspace|property|v1/i.test(buildEmbeddingText({ sectionPath: ["13. A", "13.1 B"], section: "13.1 B", text }).replace(text, "")));
  const chunk = { sectionPath: ["X", "Y"], section: "Y", text, chunkId: "c1", workspaceId: "w1", documentId: "d1", version: 3 };
  same("embedding text: deterministic and independent of any other chunk field", buildEmbeddingText(chunk), buildEmbeddingText({ sectionPath: ["X", "Y"], text }));
  check("embedding text: does not mutate its input", JSON.stringify(chunk.sectionPath) === JSON.stringify(["X", "Y"]) && chunk.text === text);
  check("embedding input version is 1 (sectionPath + text)", EMBEDDING_INPUT_VERSION === 1);

  // Exact input for the reference example, plus everything it must NOT contain.
  const refText = "Cancellation must be handled according to policy.";
  const refInput = buildEmbeddingText({
    sectionPath: ["13. CANCELLATION & REFUND", "13.1 Cancellation Policy"],
    section: "13.1 Cancellation Policy",
    text: refText,
    _id: "507f1f77bcf86cd799439011", workspaceId: "507f1f77bcf86cd799439012", propertyId: "507f1f77bcf86cd799439013", documentId: "507f1f77bcf86cd799439014",
  });
  check("reference example: exact embedding input",
    refInput === "13. CANCELLATION & REFUND\n13.1 Cancellation Policy\nCancellation must be handled according to policy.", JSON.stringify(refInput));
  check("reference example: no Markdown markers, no breadcrumb glyph, no ids", !/^#/m.test(refInput) && !refInput.includes("›") && !/507f1f77/.test(refInput));
  check("reference example: leaf heading appears exactly once (no duplicated section)", refInput.split("13.1 Cancellation Policy").length === 2);
  check("reference example: original text preserved exactly at the end", refInput.endsWith(`\n${refText}`) && refInput.split("\n").length === 3);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
