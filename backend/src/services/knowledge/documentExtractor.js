import { AppError } from "../../utils/AppError.js";

/**
 * Phase 7F-D2 — the only Node-side file-ingestion module. Responsible for
 * exactly three things: deciding whether a filename's extension is a
 * supported format, turning an uploaded file's raw bytes into deterministic
 * canonical text, and sanitizing the filename kept as metadata. Nothing
 * here touches MongoDB, HTTP, or the knowledge/chunking/embedding
 * pipeline — those stay entirely in knowledgeDocumentController.js and the
 * existing services it already calls.
 *
 * PDF/DOCX support is deliberately not here yet (7F-D3+). The shape this
 * module exposes — extension → sourceType, and a single
 * extractDocumentText() entry point returning {text, sourceType} — is
 * designed so a future format only needs a new branch inside this same
 * module, never a change to the upload controller itself.
 */

// Phase 7F-D2 supports exactly these three extensions. Adding a format
// later (PDF/DOCX) means adding an entry here and a corresponding
// extraction branch — never touching the controller.
const EXTENSION_SOURCE_TYPES = {
  ".txt": "txt-upload",
  ".md": "md-upload",
  ".markdown": "md-upload",
};

function getExtension(filename) {
  const match = /\.[^./\\]+$/.exec(filename || "");
  return match ? match[0].toLowerCase() : "";
}

/**
 * Extension is the sole, authoritative format selector for Phase 7F-D2 —
 * a client-supplied MIME type is never consulted for this decision (an
 * upload's Content-Type is client-controlled and not trustworthy; see the
 * phase's explicit "do not trust MIME type alone" requirement).
 */
export function sourceTypeForFilename(filename) {
  const extension = getExtension(filename);
  const sourceType = EXTENSION_SOURCE_TYPES[extension];
  if (!sourceType) {
    throw new AppError(
      `Unsupported file extension "${extension || "(none)"}" — supported: .txt, .md, .markdown`,
      400,
    );
  }
  return sourceType;
}

/**
 * Original filenames are client-supplied and untrusted. This keeps only
 * the basename (stripping any path components on either separator, so a
 * client can never inject a filesystem path into stored metadata),
 * removes control characters, and caps length. Returns undefined for a
 * missing/blank name rather than an empty string, matching how every
 * other optional String field in this schema represents "absent".
 */
export function sanitizeFilename(originalName) {
  if (typeof originalName !== "string") return undefined;
  const basename = originalName.split(/[/\\]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex -- deliberately stripping control chars
  const cleaned = basename.replace(/[\x00-\x1f\x7f]/g, "").trim();
  return cleaned ? cleaned.slice(0, 255) : undefined;
}

/**
 * Strict UTF-8 decoding: `fatal: true` makes an invalid byte sequence
 * throw instead of the WHATWG default of silently substituting U+FFFD —
 * exactly what "reject rather than silently produce corrupted content"
 * requires. Node's global TextDecoder already strips a leading BOM by
 * default (ignoreBOM defaults to false); normalizeText below strips it
 * again explicitly as a defensive, visible step rather than relying only
 * on that implicit behavior.
 */
function decodeUtf8Strict(buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new AppError("File is not valid UTF-8 text", 400);
  }
}

/**
 * Lightweight, deterministic normalization only — never a semantic
 * transform. Markdown is treated as plain text throughout: headings,
 * lists, and tables are left completely untouched so the existing
 * chunker's own heading-detection logic keeps working exactly as it does
 * for manually-entered content.
 */
function normalizeText(text) {
  return text
    .replace(/^﻿/, "") // strip a leading BOM if still present
    .replace(/\r\n/g, "\n") // CRLF -> LF
    .replace(/\r/g, "\n") // lone CR -> LF
    .replace(/\n{3,}/g, "\n\n") // collapse 3+ blank lines to a single blank line
    .trim(); // trim leading/trailing document whitespace
}

/**
 * The module's single orchestration entry point. Extension is validated
 * first (cheapest check, no need to touch file bytes for an unsupported
 * format), then the bytes are strictly decoded and normalized. Never
 * partially succeeds: any failure throws before returning anything, so a
 * caller never receives a half-processed result.
 */
export function extractDocumentText({ originalName, buffer }) {
  const sourceType = sourceTypeForFilename(originalName);
  const decoded = decodeUtf8Strict(buffer);
  const text = normalizeText(decoded);
  return { text, sourceType };
}
