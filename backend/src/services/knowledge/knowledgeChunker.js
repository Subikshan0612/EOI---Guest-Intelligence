/**
 * Phase 6D — deterministic, section-aware chunking.
 *
 * Pure and side-effect-free by design: no MongoDB access, no HTTP calls, no
 * LLM calls, no embeddings. Given the same content string, `chunkContent`
 * always returns the same chunk sequence — this is a structural text
 * splitter, not an NLP system, exactly as the Phase 6A report specifies.
 *
 * STRATEGY (three steps, in order):
 *
 * 1. SECTION DETECTION — split the document into `{ heading, body }`
 *    sections by scanning for two conservative, regex-based heading
 *    patterns (see `detectHeading`). A document with no detected headings
 *    becomes a single section with heading "" — this is what makes "fixed-
 *    size fallback" fall out of the same code path below rather than
 *    needing a separate implementation, per the Phase 6A report.
 *
 * 2. GREEDY PACKING — within each section's body, blank-line-separated
 *    paragraphs are packed into chunks up to MAX_CHUNK_CHARS. This is what
 *    keeps a short numbered procedure together as one chunk: consecutive
 *    numbered steps have no blank lines between them, so they form a single
 *    paragraph "unit" that packing treats atomically whenever it fits.
 *
 * 3. RECURSIVE SPLIT — if a single paragraph is still too large, the same
 *    packing runs one level down on its individual lines (so an oversized
 *    procedure splits between steps, not mid-step). If a single line is
 *    still too large, it is hard-split at MAX_CHUNK_CHARS as the last
 *    resort — the only place this module ever cuts mid-sentence.
 *
 * Nothing here rewrites, summarizes, or reorders text. Every non-blank
 * character of the original content ends up in exactly one chunk, in
 * original order. The two normalizations applied are non-semantic: CRLF is
 * folded to LF so behavior doesn't depend on a document's line-ending
 * style, and each chunk's own leading/trailing whitespace is trimmed.
 */

// Conservative initial threshold (Phase 6A report, Section 7): large enough
// to hold a full moderate SOP section — a short procedure with several
// numbered steps — as one chunk, small enough to keep a single chunk
// topically focused. Character-based, not token-based, per Phase 6D scope.
// Expected to be tuned later against real KOI documents.
export const MAX_CHUNK_CHARS = 2000;

// A numbered-heading candidate longer than this is treated as a numbered
// sentence (a step), not a title — headings are short by nature.
const MAX_HEADING_LENGTH = 80;

const MARKDOWN_HEADING = /^(#{1,6})\s+(.+)$/;

// Matches "1. Housekeeping", "1.1 Room preparation", "2 Check-in" — a
// numbering prefix followed by text. Deliberately does NOT match a line
// ending in . / ! / ? — that is exactly what separates a heading like
// "1. Housekeeping" from a numbered step like "1. Check the AC power.",
// without any NLP: a heading is a short, unpunctuated label; a step is a
// complete, punctuated instruction.
const NUMBERED_HEADING = /^(\d+(?:\.\d+)*)\.?\s+(.+)$/;

/** Returns the heading text for a line, or null if it isn't a heading. */
function detectHeading(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const markdown = trimmed.match(MARKDOWN_HEADING);
  if (markdown) return markdown[2].trim();

  const numbered = trimmed.match(NUMBERED_HEADING);
  if (numbered) {
    const text = numbered[2].trim();
    if (text.length > 0 && text.length <= MAX_HEADING_LENGTH && !/[.!?]$/.test(text)) {
      return text;
    }
  }

  return null;
}

/**
 * Splits content into `{ heading, body }` sections in source order. A
 * document with zero detected headings returns exactly one section with
 * heading "" and the entire content as its body.
 */
function splitIntoSections(content) {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const sections = [];
  let current = { heading: "", bodyLines: [] };
  let sawHeading = false;

  for (const line of lines) {
    const heading = detectHeading(line);
    if (heading !== null) {
      if (current.bodyLines.length > 0 || sawHeading) {
        sections.push(current);
      }
      current = { heading, bodyLines: [] };
      sawHeading = true;
    } else {
      current.bodyLines.push(line);
    }
  }
  sections.push(current);

  return sections
    .map((section) => ({ heading: section.heading, body: section.bodyLines.join("\n") }))
    .filter((section) => section.body.trim().length > 0 || section.heading);
}

/** Greedily joins consecutive units (each already <= maxChars) into chunks up to maxChars. */
function packUnits(units, maxChars, joiner) {
  const packed = [];
  let currentParts = [];
  let currentLength = 0;

  for (const unit of units) {
    const projectedLength =
      currentParts.length === 0 ? unit.length : currentLength + joiner.length + unit.length;

    if (currentParts.length > 0 && projectedLength > maxChars) {
      packed.push(currentParts.join(joiner));
      currentParts = [unit];
      currentLength = unit.length;
    } else {
      currentParts.push(unit);
      currentLength = projectedLength;
    }
  }
  if (currentParts.length > 0) packed.push(currentParts.join(joiner));

  return packed;
}

/**
 * Splits one section's body text into chunk-sized pieces, preferring the
 * largest structural unit that still fits: paragraphs, then lines, then
 * (last resort) raw characters. See the module doc comment for why.
 */
function chunkText(text, maxChars) {
  if (text.length <= maxChars) return [text];

  const paragraphs = text.split(/\n\s*\n/).filter((paragraph) => paragraph.length > 0);
  if (paragraphs.length > 1) {
    return packUnits(splitOversizedUnits(paragraphs, maxChars), maxChars, "\n\n");
  }

  const lines = text.split("\n").filter((line) => line.length > 0);
  if (lines.length > 1) {
    return packUnits(splitOversizedUnits(lines, maxChars), maxChars, "\n");
  }

  const hardChunks = [];
  for (let i = 0; i < text.length; i += maxChars) {
    hardChunks.push(text.slice(i, i + maxChars));
  }
  return hardChunks;
}

/** Recursively splits any unit that alone still exceeds maxChars, before packing. */
function splitOversizedUnits(units, maxChars) {
  const normalized = [];
  for (const unit of units) {
    if (unit.length <= maxChars) {
      normalized.push(unit);
    } else {
      normalized.push(...chunkText(unit, maxChars));
    }
  }
  return normalized;
}

/**
 * Deterministically transforms a KnowledgeDocument's canonical `content`
 * into an ordered array of `{ section, text }` chunks. The caller (the
 * chunk service) is responsible for assigning `chunkIndex` from array
 * position and attaching the document's own denormalized scope fields —
 * this module knows nothing about MongoDB, workspaces, or documents.
 */
export function chunkContent(content) {
  const sections = splitIntoSections(content || "");
  const chunks = [];

  for (const section of sections) {
    const body = section.body.trim();
    if (!body) continue; // a heading with no body contributes no chunk

    for (const piece of chunkText(body, MAX_CHUNK_CHARS)) {
      const text = piece.trim();
      if (text.length === 0) continue; // never emit an empty chunk
      chunks.push({ section: section.heading, text });
    }
  }

  return chunks;
}
