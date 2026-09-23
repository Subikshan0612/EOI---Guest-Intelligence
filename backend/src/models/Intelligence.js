import mongoose from "mongoose";

const RISK_LEVELS = ["low", "medium", "high", "critical"];
const GENERATED_BY = ["rule", "llm", "human", "system"];
// Mirrors ai/intelligenceSchema.js's ACTION_PRIORITIES/KNOWLEDGE_SCOPES by
// hand (Phase 7F-C) — the same small, deliberately-duplicated-constant
// tradeoff already accepted between Node/Python schemas elsewhere in this
// codebase (see ai-service/app/services/gemini_client.py's
// GEMINI_RESPONSE_SCHEMA comment).
const ACTION_STEP_PRIORITIES = ["low", "medium", "high"];
const KNOWLEDGE_SCOPES = ["unit", "property", "workspace"];

const intelligenceSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Conversation",
      default: undefined,
      index: true,
    },
    signalIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Signal",
      },
    ],
    guestId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Guest",
      default: undefined,
      index: true,
    },
    stayId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Stay",
      default: undefined,
      index: true,
    },
    signal: {
      summary: { type: String, trim: true, default: "" },
      type: { type: String, trim: true, default: "" },
      severity: { type: String, trim: true, default: "" },
    },
    context: {
      summary: { type: String, trim: true, default: "" },
      unit: { type: String, trim: true, default: "" },
      stayStatus: { type: String, trim: true, default: "" },
    },
    intelligence: {
      summary: { type: String, trim: true, default: "" },
      pattern: { type: String, trim: true, default: "" },
      guestImpact: { type: String, trim: true, default: "" },
      operationalImpact: { type: String, trim: true, default: "" },
      // Phase 7F-C — the real AI pipeline's `findings` list (see
      // ai/intelligenceSchema.js). No equivalent existed in the Phase-2
      // CRUD shape above; added here rather than overloading `summary`,
      // which would lose information. Absent (undefined) for every
      // pre-7F-C / manually-created record.
      findings: { type: [String], default: undefined },
    },
    risk: {
      level: { type: String, enum: RISK_LEVELS, default: "medium" },
      reason: { type: String, trim: true, default: "" },
    },
    decision: {
      summary: { type: String, trim: true, default: "" },
      priority: { type: String, enum: RISK_LEVELS, default: "medium" },
      // Phase 7F-C — the real AI pipeline's decision shape
      // (recommendation + rationale) is materially different from the
      // CRUD `summary`/`priority` pair above; added rather than forced
      // into it.
      recommendation: { type: String, trim: true, default: undefined },
      rationale: { type: String, trim: true, default: undefined },
    },
    action: {
      summary: { type: String, trim: true, default: "" },
      status: { type: String, trim: true, default: "" },
      // Phase 7F-C — the real AI pipeline's action shape (a label plus a
      // list of prioritized steps), distinct from the CRUD `summary`/
      // `status` pair above.
      label: { type: String, trim: true, default: undefined },
      recommended: {
        type: [
          {
            _id: false,
            step: { type: String, trim: true, required: true },
            priority: { type: String, enum: ACTION_STEP_PRIORITIES, required: true },
          },
        ],
        default: undefined,
      },
    },
    outcome: {
      summary: { type: String, trim: true, default: "" },
      status: { type: String, trim: true, default: "" },
      // Phase 7F-C — the real AI pipeline's outcome shape.
      expected: { type: String, trim: true, default: undefined },
    },
    confidence: {
      type: Number,
      min: 0,
      max: 1,
      default: undefined,
    },
    generatedBy: {
      type: String,
      enum: GENERATED_BY,
      default: "system",
    },
    model: {
      type: String,
      trim: true,
      default: undefined,
    },
    // Phase 7F-C — separate from `model` above: which provider produced
    // it (e.g. "gemini", "openai", "test"), mirroring
    // ai/aiServiceClient.js's/ai/intelligenceService.js's own
    // `provenance.provider`. Did not exist before this phase.
    provider: {
      type: String,
      trim: true,
      default: undefined,
    },
    // Phase 7F-C — the exact trusted knowledge provenance already computed
    // today by knowledgeRetrievalService.js + ai/intelligenceService.js's
    // own re-filtering (never trusted from raw Python/Gemini output; only
    // ever written here after that full validation/trust chain has
    // already run). Absent for every pre-7F-C record and for any
    // generation that used no knowledge (LLM_PROVIDER=openai/test, or a
    // Python-routed generation that retrieved zero chunks).
    knowledgeProvenance: {
      type: [
        {
          _id: false,
          chunkId: { type: String, required: true },
          knowledgeDocumentId: { type: String, required: true },
          version: { type: Number, required: true, min: 1 },
          scope: { type: String, enum: KNOWLEDGE_SCOPES, required: true },
          section: { type: String, trim: true, default: "" },
          chunkIndex: { type: Number, required: true, min: 0 },
          similarityScore: { type: Number, required: true },
          retrievalScore: { type: Number, required: true },
        },
      ],
      default: undefined,
    },
  },
  {
    timestamps: true,
  },
);

intelligenceSchema.index({ workspaceId: 1, createdAt: -1 });
intelligenceSchema.index({ signalIds: 1 });

export const Intelligence = mongoose.model("Intelligence", intelligenceSchema);
export { RISK_LEVELS, GENERATED_BY };
