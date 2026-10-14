/**
 * Deterministic corpus classification: for each chunk of a source document,
 * decide whether it enters the RAG corpus, is held back, or is excluded, and
 * at what visibility. Pure: no I/O, no network, no database.
 *
 * The decision is an EXPLICIT SECTION MAPPING reviewed by a person, never
 * keyword or pattern inference (no phone-number detector is an authority
 * here). A mapping is a list of entries:
 *
 *   { number, title, action, visibility, reason }
 *
 * matched against a chunk's own leaf `section` ("7.1 Booking" -> number
 * "7.1", title "Booking"). BOTH the number and the (whitespace/case
 * normalized) title must match, so a renumbered or retitled section can
 * never silently inherit an old decision.
 *
 * FAIL CLOSED: a chunk whose section matches no entry (or matches only by
 * number) is `hold` at `restricted` - it is not ingested, and it is reported
 * so a person can classify it. Nothing unclassified is ever treated as
 * guest-visible.
 *
 * Actions:
 *   include - ingest as a KnowledgeChunk with the given visibility
 *   hold    - do not ingest; needs management/approval before it can be
 *   exclude - never ingest into the Business Knowledge corpus
 */
import { VISIBILITY_LEVELS, isValidVisibility } from "./visibility.js";

export const CORPUS_ACTIONS = Object.freeze(["include", "hold", "exclude"]);

const NUMBERED_LABEL = /^(\d+(?:\.\d+)*)\.?\s+(.+)$/;

function normalizeTitle(title) {
  return String(title).replace(/\s+/g, " ").trim().toLowerCase();
}

function parseSectionLabel(section) {
  const match = String(section || "").trim().match(NUMBERED_LABEL);
  return match ? { number: match[1], title: normalizeTitle(match[2]) } : null;
}

/**
 * Validates a mapping's shape once, up front, so a typo in it fails loudly
 * instead of silently mis-classifying a section. `preamble` covers text that
 * precedes the first heading.
 */
export function assertValidMapping(mapping) {
  if (!mapping || !Array.isArray(mapping.entries) || !mapping.preamble) {
    throw new Error("Corpus mapping must have `entries` and a `preamble` decision.");
  }
  const seen = new Set();
  for (const entry of [{ ...mapping.preamble, number: "(preamble)", title: "(preamble)" }, ...mapping.entries]) {
    if (!CORPUS_ACTIONS.includes(entry.action)) throw new Error(`Invalid action for ${entry.number}: ${entry.action}`);
    if (!isValidVisibility(entry.visibility) && entry.visibility !== "not applicable") {
      throw new Error(`Invalid visibility for ${entry.number}: ${entry.visibility}`);
    }
    if (entry.action === "include" && !VISIBILITY_LEVELS.includes(entry.visibility)) {
      throw new Error(`An included section needs a real visibility: ${entry.number}`);
    }
    if (!entry.reason) throw new Error(`Missing reason for ${entry.number}`);
    const key = `${entry.number}|${normalizeTitle(entry.title)}`;
    if (seen.has(key)) throw new Error(`Duplicate mapping entry: ${entry.number}`);
    seen.add(key);
  }
}

/** @returns {{ action: string, visibility: string, reason: string, matched: boolean }} */
export function classifySection(section, mapping) {
  if (!section || !String(section).trim()) {
    const { action, visibility, reason } = mapping.preamble;
    return { action, visibility, reason, matched: true };
  }

  const label = parseSectionLabel(section);
  const entry = label
    ? mapping.entries.find((candidate) => candidate.number === label.number && normalizeTitle(candidate.title) === label.title)
    : null;

  if (!entry) {
    return {
      action: "hold",
      visibility: "restricted",
      reason: "Section is not in the reviewed mapping (or its number/title changed); failing closed.",
      matched: false,
    };
  }
  return { action: entry.action, visibility: entry.visibility, reason: entry.reason, matched: true };
}

/**
 * Classifies every chunk produced by chunkContent().
 * @returns {Array<{ chunkIndex: number, section: string, sectionPath: string[], action: string, visibility: string, reason: string, matched: boolean }>}
 */
export function classifyChunks(chunks, mapping) {
  assertValidMapping(mapping);
  return chunks.map((chunk, chunkIndex) => ({
    chunkIndex,
    section: chunk.section,
    sectionPath: chunk.sectionPath,
    ...classifySection(chunk.section, mapping),
  }));
}

/**
 * Adapts a mapping to the `classify(piece)` hook rebuildChunksForDocument
 * accepts: returns { include, visibility } for one chunk.
 */
export function createChunkClassifier(mapping) {
  assertValidMapping(mapping);
  return (piece) => {
    const decision = classifySection(piece.section, mapping);
    return { include: decision.action === "include", visibility: decision.visibility };
  };
}
