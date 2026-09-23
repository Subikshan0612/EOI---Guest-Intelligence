import { PDFParse, PasswordException } from "pdf-parse";
import { AppError } from "../../utils/AppError.js";

/**
 * Phase 7F-D2/7F-D3 — the only Node-side file-ingestion module. Responsible
 * for exactly three things: deciding whether a filename's extension is a
 * supported format, turning an uploaded file's raw bytes into deterministic
 * canonical text, and sanitizing the filename kept as metadata. Nothing
 * here touches MongoDB, HTTP, or the knowledge/chunking/embedding
 * pipeline — those stay entirely in knowledgeDocumentController.js and the
 * existing services it already calls.
 *
 * DOCX support is deliberately not here yet. The shape this module
 * exposes — extension → sourceType, and a single extractDocumentText()
 * entry point returning {text, sourceType} — is designed so a future
 * format only needs a new branch inside this same module, never a change
 * to the upload controller itself (the controller's own call site now
 * awaits this function, since PDF parsing is inherently asynchronous —
 * the one necessary change outside this file).
 */

// Adding a format means adding an entry here and a corresponding
// extraction branch — never touching the controller.
const EXTENSION_SOURCE_TYPES = {
  ".txt": "txt-upload",
  ".md": "md-upload",
  ".markdown": "md-upload",
  ".pdf": "pdf-upload",
};

/**
 * Phase 7F-D3 — a PDF's compressed (uploaded) byte size does not bound its
 * decompressed/extracted text size the way it does for a plain TXT/MD file
 * (where content size == file size, 1:1) — a PDF well within the existing
 * 10 MB upload limit could still, in principle, decompress into far more
 * text than that limit would suggest. This ceiling is deliberately
 * generous for any realistic single SOP/policy document — roughly 150-250
 * pages of dense single-spaced text, far beyond what one such document
 * would ever realistically contain — while still bounding worst-case
 * memory/processing from a pathological input. Applies only to the PDF
 * path: TXT/MD content size is already directly bounded by the 10 MB
 * upload limit itself, so a separate ceiling there would be redundant.
 */
const MAX_PDF_EXTRACTED_TEXT_CHARS = 500_000;

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
 * Phase 7F-D3 — PDF text extraction via pdf-parse v2's actual, installed
 * API: a `PDFParse` class with an async `getText()` method (verified
 * against the installed package's own README/type definitions before
 * writing this — v2 is a from-scratch rewrite with a completely different,
 * class-based shape from the older/classic single-function `pdf-parse` v1
 * API; assuming the old shape would have been wrong).
 *
 * Loading/parsing happens lazily inside getText(), not the constructor, so
 * the whole attempt is wrapped in one try/catch/finally — destroy() always
 * runs to free the underlying pdf.js document, on both success and
 * failure. Never leaks the underlying parser's own error message/stack:
 * every failure becomes one of two small, fixed, safe AppError messages.
 */
async function extractPdfText(buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();

    // Built from each page's own clean text (`result.pages[n].text`), not
    // the library's top-level `result.text` — that field always injects a
    // "-- N of M --" page-separator footer, even for a page with zero
    // actual text content (verified directly against the installed
    // package: a genuinely blank page's `result.text` is
    // "\n\n-- 1 of 1 --\n\n", non-blank). Using it would have silently
    // defeated the "empty/scanned PDF rejected via the existing content
    // validation path" requirement, since that footer text is never
    // actually blank/whitespace-only.
    const text = result.pages.map((page) => page.text).join("\n\n");

    if (text.length > MAX_PDF_EXTRACTED_TEXT_CHARS) {
      // Deliberately not .toLocaleString() — it formats using the
      // server's own system locale (e.g. Indian digit grouping,
      // "5,00,000"), which is inconsistent/surprising in an API error
      // message. A plain number is unambiguous everywhere.
      throw new AppError(
        `PDF extracted text exceeds the maximum supported length (${MAX_PDF_EXTRACTED_TEXT_CHARS} characters)`,
        400,
      );
    }

    return text;
  } catch (error) {
    if (error instanceof AppError) throw error; // the ceiling check above — already a clean, safe error
    if (error instanceof PasswordException) {
      throw new AppError("File is an encrypted/password-protected PDF, which is not supported", 400);
    }
    // InvalidPDFException, FormatError, UnknownErrorException, or anything
    // else unexpected from the parser — collapsed to one safe message
    // rather than risking the underlying library's own error text.
    throw new AppError("File is not a valid PDF", 400);
  } finally {
    await parser.destroy();
  }
}

/**
 * The module's single orchestration entry point. Extension is validated
 * first (cheapest check, no need to touch file bytes for an unsupported
 * format), then the bytes are extracted per-format and normalized through
 * the exact same normalizeText() regardless of source format. Never
 * partially succeeds: any failure throws before returning anything, so a
 * caller never receives a half-processed result. Async because PDF
 * extraction is inherently asynchronous — TXT/Markdown's own behavior
 * (decode -> normalize) is completely unchanged, just now resolved via a
 * Promise like the PDF branch.
 */
export async function extractDocumentText({ originalName, buffer }) {
  const sourceType = sourceTypeForFilename(originalName);

  if (sourceType === "pdf-upload") {
    const rawText = await extractPdfText(buffer);
    return { text: normalizeText(rawText), sourceType };
  }

  const decoded = decodeUtf8Strict(buffer);
  return { text: normalizeText(decoded), sourceType };
}
