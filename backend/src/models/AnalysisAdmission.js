import mongoose from "mongoose";
import { FAILURE_CLASSES } from "../services/ai/analysisFailureTaxonomy.js";
import { VISIBILITY_LEVELS } from "../services/knowledge/visibility.js";

const OUTCOMES = ["accepted", "rejected"];
const STAGE_VALUES = ["passed", "failed", "not_run"];
const CONFIDENCE = ["low", "medium", "high"];
// The pipeline stages, in the order they run. `provider` is the model call itself; the rest are Node's admissibility checks.
const STAGES = ["provider", "schema", "identity", "claims", "safety", "prose", "identifier"];

const stageResults = Object.fromEntries(STAGES.map((stage) => [stage, { type: String, enum: STAGE_VALUES, default: "not_run" }]));

/**
 * Durable AUDIT / ADMISSION record for one analysis attempt (Phase 35): the minimum needed to answer "why was this AI analysis
 * accepted or rejected?". It is METADATA ONLY, deliberately:
 *
 *   - no prompt, no raw model output, no Signal text, no guest data, no evidence TEXT, no claim text, no secret, no header;
 *   - evidence is identified by a deterministic hash (`evidenceSetId`) and summarised as COUNTS per class, never by reference ids,
 *     so the record cannot carry (or later reveal) a foreign or invented reference;
 *   - the accepted analysis itself already lives in the Intelligence record (`intelligenceId`); it is NOT copied here.
 *
 * WORKSPACE-SCOPED: `workspaceId` is required, and the only read path (analysisAdmissionService) always filters by it.
 * Written by the server only; there is no route that creates or edits one. Rejected attempts leave no Intelligence record, so this is
 * the only durable trace of them.
 */
const analysisAdmissionSchema = new mongoose.Schema(
  {
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true },
    signalId: { type: mongoose.Schema.Types.ObjectId, ref: "Signal", required: true },
    // Correlation: one random id per attempt (also logged server-side), and - when accepted - the Intelligence it produced.
    attemptId: { type: String, required: true, match: /^[0-9a-f-]{36}$/ },
    // Phase 37: the X-Request-Id of the HTTP request that started the attempt (a canonical uuid the server generated or validated), so a
    // support ticket / client log that carries the response header finds the durable row directly. Absent for attempts not started by an HTTP
    // request. A request that JOINED an in-flight analysis (analysis.coalesced) is not recorded here: it made no attempt of its own.
    requestId: { type: String, match: /^[0-9a-f-]{36}$/, default: undefined },
    intelligenceId: { type: mongoose.Schema.Types.ObjectId, ref: "Intelligence", default: undefined },
    analysisLevel: { type: String, enum: VISIBILITY_LEVELS, default: undefined },

    outcome: { type: String, enum: OUTCOMES, required: true },
    // The stage that decided the outcome ("admitted" for an accepted one), and a stable code + class for a rejection.
    decidedAt: { type: String, enum: [...STAGES, "retrieval", "persistence", "admitted"], required: true },
    reasonCode: { type: String, default: undefined, maxlength: 64 },
    // Phase 38: WHICH admissibility rule failed (a stable constant such as CLAIM_MISSING_SOURCE_REFS - see claimValidator.js CLAIM_RULE_CODES);
    // absent on every earlier row and for rejections that carry no rule. Never any text, claim, evidence or reference id.
    ruleCode: { type: String, match: /^[A-Z][A-Z_]{2,47}$/, default: undefined },
    failureClass: { type: String, enum: FAILURE_CLASSES, default: undefined },
    httpStatus: { type: Number, default: undefined },
    stages: { type: new mongoose.Schema(stageResults, { _id: false }), default: () => ({}) },

    // Identity as REPORTED by the AI service (bounded, printable). `model` is the cross-checked identity; Node is not given a
    // separate model_version by the current Python->Node contract (see docs/PRODUCTION_HARDENING_PHASE35.md).
    provider: { type: String, maxlength: 64, default: undefined },
    model: { type: String, maxlength: 64, default: undefined },

    // Evidence: a deterministic identifier of the exact evidence set, and counts. Never the references themselves.
    evidenceSetId: { type: String, match: /^[0-9a-f]{64}$/, default: undefined },
    evidenceCounts: { type: Map, of: Number, default: undefined },
    claimTypeCounts: { type: Map, of: Number, default: undefined },
    citedClassCounts: { type: Map, of: Number, default: undefined },
    knowledgeRetrieved: { type: Number, min: 0, default: undefined },
    knowledgeRelevant: { type: Number, min: 0, default: undefined },
    // The similarity floor in force when the ceiling was derived (so a later calibration can be audited against it).
    relevanceFloor: { type: Number, default: undefined },

    // Confidence: what the model said, the server's ceiling, what was stored, and why.
    modelConfidence: { type: String, enum: CONFIDENCE, default: undefined },
    confidenceCeiling: { type: String, enum: CONFIDENCE, default: undefined },
    finalConfidence: { type: String, enum: CONFIDENCE, default: undefined },
    confidenceCapped: { type: Boolean, default: undefined },
    ceilingReasons: { type: [String], default: undefined },
    safetyState: { type: String, maxlength: 32, default: undefined },
    safetyRules: { type: [String], default: undefined },

    // Learning is OFF in production; this records whether it contributed to THIS attempt, so its absence is provable.
    learningUsed: { type: Boolean, required: true, default: false },

    // Measured by Node around the AI-service call. Token usage is not carried across the current contract, so it is not recorded.
    latencyMs: { type: Number, min: 0, default: undefined },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

analysisAdmissionSchema.index({ workspaceId: 1, createdAt: -1 });
analysisAdmissionSchema.index({ workspaceId: 1, signalId: 1, createdAt: -1 });
analysisAdmissionSchema.index({ workspaceId: 1, attemptId: 1 }, { unique: true });
// Phase 37: lookup by the request id a client reported (partial: rows without one are not indexed).
analysisAdmissionSchema.index({ workspaceId: 1, requestId: 1 }, { partialFilterExpression: { requestId: { $exists: true } } });

export const AnalysisAdmission = mongoose.model("AnalysisAdmission", analysisAdmissionSchema);
export { OUTCOMES as ADMISSION_OUTCOMES, STAGES as ADMISSION_STAGES };
