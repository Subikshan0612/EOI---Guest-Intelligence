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
const KNOWLEDGE_SOURCE_TYPES = ["upload", "manual-entry"];
const KNOWLEDGE_STATUSES = ["active", "superseded", "archived"];

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

export const KnowledgeDocument = mongoose.model("KnowledgeDocument", knowledgeDocumentSchema);
export { KNOWLEDGE_DOCUMENT_TYPES, KNOWLEDGE_SOURCE_TYPES, KNOWLEDGE_STATUSES };
