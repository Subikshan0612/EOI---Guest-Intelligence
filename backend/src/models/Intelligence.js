import mongoose from "mongoose";
import { VISIBILITY_LEVELS } from "../services/knowledge/visibility.js";
import { URGENCY_LEVELS } from "../services/ai/safetyPolicy.js";
import { ACTION_TYPES } from "./Action.js";

const RISK_LEVELS = ["low", "medium", "high", "critical"];
const GENERATED_BY = ["rule", "llm", "human", "system"];
// Mirrors ai/intelligenceSchema.js's ACTION_PRIORITIES/KNOWLEDGE_SCOPES by
// hand (Phase 7F-C) — the same small, deliberately-duplicated-constant
// tradeoff already accepted between Node/Python schemas elsewhere in this
// codebase (see ai-service/app/services/gemini_client.py's
// GEMINI_RESPONSE_SCHEMA comment).
const ACTION_STEP_PRIORITIES = ["low", "medium", "high"];
const KNOWLEDGE_SCOPES = ["unit", "property", "workspace"];
// Intelligence V1 - an evidence-quality CLASS, never a probability.
const ANALYSIS_CONFIDENCE_LEVELS = ["high", "medium", "low"];
const ANALYSIS_VERSION = "intelligence-v1";
// Phase 43B.1: the server safety states exactly as safetyPolicy.js's deriveSafetyPolicy returns them in `state` (validate-phase43b1-safety-metadata.mjs
// ties this list to the policy's actual outputs, so the two cannot drift apart silently). SAFETY_REVIEW_REQUIRED (owner-approved, EOI_VAGUE_HAZARD_POLICY_DECISION.md Option C) is returned
// only when the analysis pipeline asks for it; records stored earlier keep the state they were stored with and are never rewritten.
const SAFETY_STATES = ["NORMAL", "CRITICAL", "SAFETY_REVIEW_REQUIRED", "LIFE_SAFETY_HAZARD"];
// Safety/context hardening: the EXISTING policy's rule codes (safetyPolicy.js deriveSafetyPolicy `rules`), stored with the result so a downstream stage (Action) can see which rule produced the state - above all
// ACCESS_REFUSED, which the policy already says forbids maintenance_dispatch and inspection. Server-derived at analysis time from the CURRENT Signal; never from a request, the model or history. validate-safety-context-hardening.mjs
// ties this list to the policy's actual outputs.
const SAFETY_RULE_CODES = ["SEVERITY_CRITICAL", "LIFE_SAFETY_HAZARD", "ACCESS_REFUSED", "SAFETY_REVIEW_REQUIRED"];

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
    // Intelligence V1 - the Signal's property, when it has one. Additive; absent
    // on every pre-V1 record.
    propertyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Property",
      default: undefined,
      index: true,
    },
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
    // The highest visibility among the knowledge chunks retrieved for this
    // generation (they all went into the prompt, so any of them may have
    // shaped the result). Set only by the generation pipeline, never from a
    // request body. Absent = no knowledge was used, so no knowledge-derived
    // restriction applies. Reads hide a record from callers below this level.
    knowledgeVisibility: {
      type: String,
      enum: VISIBILITY_LEVELS,
      default: undefined,
    },
    // Intelligence V1 (grounded analysis): the structured analysis itself.
    // Analysis + recommendation ONLY - there is deliberately no field here (or
    // anywhere in the V1 contract) that can express or trigger an action.
    // Absent on every record not produced by the V1 analysis flow.
    analysis: {
      type: new mongoose.Schema(
        {
          situation: { type: String, trim: true, required: true },
          evidence: { type: [String], required: true },
          impact: { type: String, trim: true, required: true },
          recommendation: { type: String, trim: true, required: true },
          confidence: { type: String, enum: ANALYSIS_CONFIDENCE_LEVELS, required: true },
        },
        { _id: false },
      ),
      default: undefined,
    },
    // Phase 43B.1: the VALIDATED safety result of this analysis, so a client can show it without reading prose. Written ONLY by the V1 flow, after
    // validateAndVerifyAnalysis has passed (never from a request body, never from model prose):
    //   state                  - Node's own deterministic result (safetyPolicy.js deriveSafetyPolicy on the CURRENT Signal): NORMAL | CRITICAL | SAFETY_REVIEW_REQUIRED | LIFE_SAFETY_HAZARD
    //   urgency                - the analysis's structured urgency, admitted only because Node checked it is a known level AND not below the policy minimum
    //   recommendedActionType  - the analysis's structured action type, admitted only because Node checked it is a known type AND within the policy's
    //                            required / not forbidden set
    // The audit-only rule codes stay on AnalysisAdmission. ABSENT on every record created before this phase (and urgency / recommendedActionType are
    // absent when the deterministic TEST provider, which reasons about nothing, stated none): absence means "not recorded", never "NORMAL".
    safety: {
      type: new mongoose.Schema(
        {
          state: { type: String, enum: SAFETY_STATES, required: true },
          urgency: { type: String, enum: URGENCY_LEVELS, default: undefined },
          recommendedActionType: { type: String, enum: ACTION_TYPES, default: undefined },
          // The policy rules that applied to the CURRENT Signal (see SAFETY_RULE_CODES). ABSENT on every record created before this field existed: absence means "not recorded", never "no rule applied".
          rules: { type: [String], enum: SAFETY_RULE_CODES, default: undefined },
        },
        { _id: false },
      ),
      default: undefined,
    },
    // Set only by the V1 flow: which contract version produced this record, and
    // the caller's authorized knowledge level it was produced at. Together with
    // the Signal they make analysis idempotent: at most ONE V1 analysis per
    // (workspace, signal, level) - see the unique index below.
    analysisVersion: { type: String, default: undefined },
    analysisLevel: { type: String, enum: VISIBILITY_LEVELS, default: undefined },
    knowledgeProvenance: {
      type: [
        {
          _id: false,
          chunkId: { type: String, required: true },
          knowledgeDocumentId: { type: String, required: true },
          version: { type: Number, required: true, min: 1 },
          scope: { type: String, enum: KNOWLEDGE_SCOPES, required: true },
          section: { type: String, trim: true, default: "" },
          // Intelligence V1 additions (optional; absent on earlier records).
          sectionPath: { type: [String], default: undefined },
          visibility: { type: String, enum: VISIBILITY_LEVELS, default: undefined },
          chunkIndex: { type: Number, required: true, min: 0 },
          similarityScore: { type: Number, required: true },
          retrievalScore: { type: Number, required: true },
        },
      ],
      default: undefined,
    },
    // Phase 28 (evidence contract): structured, backend-authorized references the analysis cited, and any
    // bounded contradictions it reported. Both additive and OPTIONAL - absent on every pre-Phase-28 record
    // and on any analysis that reported neither. Every reference here has ALREADY been checked (analysisSchema.js
    // + evidenceReferenceIndex.js, before this document was even constructed) against the exact context,
    // operationalHistory and knowledge THIS analysis was given - never a fresh id, never a raw model claim.
    evidenceRefs: {
      type: [
        {
          _id: false,
          type: { type: String, enum: ["operational", "historical", "knowledge"], required: true },
          field: { type: String, enum: ["signal", "property", "unit", "guest", "stay", "historySignal"], default: undefined },
          refId: { type: String, default: undefined },
          kind: { type: String, enum: ["prior_ai_analysis", "human_reviewed_decision"], default: undefined },
          signalId: { type: String, default: undefined },
          chunkId: { type: String, default: undefined },
        },
      ],
      default: undefined,
    },
    contradictions: {
      type: [
        {
          _id: false,
          type: {
            type: String,
            enum: ["signal_vs_historical", "operational_vs_historical", "knowledge_vs_operational", "historical_vs_historical"],
            required: true,
          },
          description: { type: String, trim: true, required: true },
          evidenceRefs: {
            type: [
              {
                _id: false,
                type: { type: String, enum: ["operational", "historical", "knowledge"], required: true },
                field: { type: String, enum: ["signal", "property", "unit", "guest", "stay", "historySignal"], default: undefined },
                refId: { type: String, default: undefined },
                kind: { type: String, enum: ["prior_ai_analysis", "human_reviewed_decision"], default: undefined },
                signalId: { type: String, default: undefined },
                chunkId: { type: String, default: undefined },
              },
            ],
            required: true,
          },
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
// Intelligence V1 idempotency: one analysis per (workspace, signal, authorized
// level). Partial, so it applies only to V1 records and never touches the
// existing generate flow, which may create several records per Signal.
intelligenceSchema.index(
  { workspaceId: 1, signalIds: 1, analysisLevel: 1 },
  { unique: true, partialFilterExpression: { analysisVersion: ANALYSIS_VERSION } },
);

export const Intelligence = mongoose.model("Intelligence", intelligenceSchema);
export { RISK_LEVELS, GENERATED_BY, ANALYSIS_CONFIDENCE_LEVELS, ANALYSIS_VERSION, SAFETY_STATES, SAFETY_RULE_CODES };
