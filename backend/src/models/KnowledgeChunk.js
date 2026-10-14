import mongoose from "mongoose";
import { KNOWLEDGE_STATUSES } from "./KnowledgeDocument.js";
import { VISIBILITY_LEVELS } from "../services/knowledge/visibility.js";

/**
 * Phase 6B — schema only. Nothing in this codebase creates a KnowledgeChunk
 * yet: that is Phase 6D (chunking), which reads a KnowledgeDocument's
 * `content` and populates these rows, and Phase 6E (embeddings), which fills
 * in `embedding`/`embeddingModel` afterward. No CRUD route exists for this
 * model in Phase 6B — chunks are never authored directly.
 *
 * workspaceId/propertyId/unitId/status/effectiveFrom/effectiveTo are
 * deliberately denormalized copies of the parent KnowledgeDocument's own
 * fields (pinned to `version`). This lets a future scoped candidate-fetch
 * query (Phase 6G) filter chunks directly — workspace/property/unit +
 * active + effective-date — with no join back to the parent document on
 * every retrieval.
 */

const knowledgeChunkSchema = new mongoose.Schema(
  {
    documentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "KnowledgeDocument",
      required: true,
      index: true,
    },
    // Pinned to the exact version this chunk was extracted from — a new
    // document version means new chunks, never an edit of these in place.
    version: {
      type: Number,
      required: true,
      min: 1,
    },

    // --- Denormalized from the parent KnowledgeDocument (see file note) ---
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    propertyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Property",
      default: undefined,
      index: true,
    },
    unitId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Unit",
      default: undefined,
      index: true,
    },
    status: {
      type: String,
      enum: KNOWLEDGE_STATUSES,
      required: true,
    },
    effectiveFrom: {
      type: Date,
      default: undefined,
    },
    effectiveTo: {
      type: Date,
      default: undefined,
    },

    // --- Chunk identity ---
    chunkIndex: {
      type: Number,
      required: true,
      min: 0,
    },
    // Human-readable heading this chunk was extracted from, e.g. "After-Hours
    // Response" — what makes a citation legible to a person, not just
    // traceable by a machine (Phase 6A report, Section 13).
    section: {
      type: String,
      trim: true,
      default: "",
    },
    // Ordered headings from outermost ancestor down to `section` itself,
    // derived only from explicit structure (see services/knowledge/
    // sectionPath.js). Absent on chunks created before it existed and on
    // chunks with no heading. When present, its last element equals `section`.
    sectionPath: {
      type: [String],
      default: undefined,
    },
    text: {
      type: String,
      required: true,
    },

    // Who may see this chunk: guest < staff < restricted (see
    // services/knowledge/visibility.js). Defaults to the MOST restrictive
    // level, so a code path that forgets to set it can never expose a chunk
    // to a lower-level caller. Enforced by Node in retrieval candidate
    // selection and in the direct knowledge APIs. Deliberately NOT part of
    // the embedding input (see services/knowledge/embeddingText.js).
    visibility: {
      type: String,
      enum: VISIBILITY_LEVELS,
      default: "restricted",
    },

    // Populated at ingestion time (Phase 6E), absent until then.
    // embeddingModel travels with the vector so a future model change can be
    // detected instead of silently comparing incompatible vector spaces.
    embedding: {
      type: [Number],
      default: undefined,
    },
    embeddingModel: {
      type: String,
      default: undefined,
    },
    // Which recipe (services/knowledge/embeddingText.js) built the text this
    // vector was made from. 1 = sectionPath + text. Absent until embedded.
    embeddingInputVersion: {
      type: Number,
      default: undefined,
    },
  },
  {
    timestamps: true,
  },
);

knowledgeChunkSchema.index({ documentId: 1, version: 1, chunkIndex: 1 }, { unique: true });
knowledgeChunkSchema.index({ workspaceId: 1, propertyId: 1, status: 1 });

export const KnowledgeChunk = mongoose.model("KnowledgeChunk", knowledgeChunkSchema);
