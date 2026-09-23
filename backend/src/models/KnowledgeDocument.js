import mongoose from "mongoose";

/**
 * Phase 6B — organizational knowledge (SOPs, policies, procedures, guidelines,
 * standards), as distinct from operational facts (Signal/Guest/Stay/Property/
 * Unit). See CLAUDE.md's AI/RAG boundaries section for the full principle:
 * knowledge is never merged into an operational model, and never leaves this
 * collection family.
 *
 * This model has no retrieval, chunking, or embedding logic — that is Phase
 * 6D/6E/6G. It is the authored, versioned source of truth only.
 */

const KNOWLEDGE_DOCUMENT_TYPES = ["sop", "policy", "procedure", "guideline", "standard"];
// Phase 7F-D1 — replaces the old placeholder "upload" value (never actually
// set by any code path; Phase 6B reserved it for a file-ingestion flow that
// didn't exist yet) with the real values 7F-D2+ file ingestion will set
// programmatically. "manual-entry" remains the only value any code sets
// today.
const KNOWLEDGE_SOURCE_TYPES = ["manual-entry", "txt-upload", "md-upload", "pdf-upload", "docx-upload"];
const KNOWLEDGE_STATUSES = ["active", "superseded", "archived"];
// Phase 7F-D2 follow-up — orthogonal to KNOWLEDGE_STATUSES above: `status`
// is the business/content lifecycle (is this document currently in force),
// `ingestionStatus` is purely technical pipeline completeness (has this
// document's current version been fully chunked+embedded). A document can
// be `status: "active"` and `ingestionStatus: "pending"` at the same time
// — that combination isn't a contradiction, it's simply "valid content
// that hasn't finished processing yet" (true of every manually-created
// document today, between its create and embed calls).
const KNOWLEDGE_INGESTION_STATUSES = ["pending", "ready", "failed"];

const knowledgeDocumentSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    // Absent = workspace-wide knowledge.
    propertyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Property",
      default: undefined,
      index: true,
    },
    // Reserved for future use (see Phase 6A report, Section 4) — the schema
    // supports unit-level knowledge, but no ingestion/authoring flow targets
    // it yet.
    unitId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Unit",
      default: undefined,
      index: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    documentType: {
      type: String,
      enum: KNOWLEDGE_DOCUMENT_TYPES,
      required: true,
    },
    // How the content entered KOI — distinct from Signal's own `source` enum
    // (system/guest/staff), which describes an operational fact's origin,
    // not a knowledge document's.
    sourceType: {
      type: String,
      enum: KNOWLEDGE_SOURCE_TYPES,
      default: "manual-entry",
    },
    // The canonical full text. Chunking (Phase 6D) reads this; it is never
    // edited in place once a version is created — see `version` below.
    content: {
      type: String,
      required: true,
    },
    // Phase 7F-D1 — original file name, when this document came from an
    // uploaded file. Always optional: manual-entry has no file at all, and
    // file ingestion itself is not implemented until 7F-D2+. Purely
    // descriptive metadata — never used for any lookup/validation.
    sourceFilename: {
      type: String,
      trim: true,
      default: undefined,
    },
    // Phase 7F-D1 — deterministic SHA-256 hash of this document's own
    // `content`, computed server-side on every create (never accepted from
    // a caller — see knowledgeDocumentService.js's computeContentHash).
    // Drives duplicate detection below; also lets a future re-embedding or
    // dedup job compare documents without re-hashing large text repeatedly.
    contentHash: {
      type: String,
      required: true,
    },
    // Phase 7F-D1 — structurally marks a document as synthetic/test
    // content rather than real business data (explicitly requested so 7F-D+
    // ingestion work can use sample documents without them being mistaken
    // for real SOPs/policies). Also exempts a document from the duplicate-
    // content constraint below — accidental duplication is a real-content
    // concern; deliberately near-identical test fixtures are not.
    isTestData: {
      type: Boolean,
      default: false,
    },
    // Phase 7F-D2 follow-up — set only by knowledgeEmbeddingService.js's
    // embedKnowledgeDocument, never by any create/update caller (not part
    // of any request body a controller passes through). "pending" is the
    // correct, unremarkable default for every newly-created document —
    // chunking/embedding has always been a separate step in this
    // architecture, on both the manual-entry and upload paths.
    ingestionStatus: {
      type: String,
      enum: KNOWLEDGE_INGESTION_STATUSES,
      default: "pending",
    },
    // Set alongside ingestionStatus:"failed"; always a short, already-
    // sanitized message (the same text this codebase already returns to
    // an HTTP caller for the same failure — never a raw provider error,
    // stack trace, or secret). Cleared back to undefined on a subsequent
    // successful embed.
    ingestionError: {
      type: String,
      trim: true,
      default: undefined,
    },
    status: {
      type: String,
      enum: KNOWLEDGE_STATUSES,
      default: "active",
    },
    version: {
      type: Number,
      default: 1,
      min: 1,
    },
    // Self-reference to the previous version in this document's lineage —
    // makes supersession explicit and queryable instead of inferred from
    // `version` alone.
    supersedesId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "KnowledgeDocument",
      default: undefined,
    },
    effectiveFrom: {
      type: Date,
      default: Date.now,
    },
    // Nullable/absent means "still in force."
    effectiveTo: {
      type: Date,
      default: undefined,
    },
  },
  {
    timestamps: true,
  },
);

knowledgeDocumentSchema.index({ workspaceId: 1, propertyId: 1, status: 1 });
knowledgeDocumentSchema.index({ workspaceId: 1, createdAt: -1 });
// Phase 7F-D1 — deterministic duplicate-content detection, scoped by tenant
// and by the exact same scope tier the rest of the architecture already
// uses (workspace/property/unit). A document missing propertyId/unitId
// indexes as null for each, which MongoDB already treats as its own
// distinct bucket for uniqueness — matching the "workspace-wide" scope
// bucket this codebase already relies on elsewhere (e.g.
// knowledgeRetrievalService.js's buildScopeFilter). Scoped to
// status:"active" (a superseded/archived document no longer blocks a new
// one from using the same content) and isTestData:false (synthetic/sample
// documents are explicitly exempt — see the field's own comment above).
// A conflict here surfaces as a MongoDB E11000 error, already mapped to
// HTTP 409 by the existing generic errorHandler.js/queryHelpers.js
// isDuplicateKeyError path — the same mechanism Guest.externalId and
// Stay.reservationId already rely on, so no new error-handling code was
// needed for this.
knowledgeDocumentSchema.index(
  { workspaceId: 1, propertyId: 1, unitId: 1, contentHash: 1 },
  { unique: true, partialFilterExpression: { status: "active", isTestData: false } },
);

export const KnowledgeDocument = mongoose.model("KnowledgeDocument", knowledgeDocumentSchema);
export { KNOWLEDGE_DOCUMENT_TYPES, KNOWLEDGE_SOURCE_TYPES, KNOWLEDGE_STATUSES, KNOWLEDGE_INGESTION_STATUSES };
