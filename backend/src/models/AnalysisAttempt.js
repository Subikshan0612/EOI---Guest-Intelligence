import mongoose from "mongoose";
import { FAILURE_CLASSES } from "../services/ai/analysisFailureTaxonomy.js";
import { VISIBILITY_LEVELS } from "../services/knowledge/visibility.js";

export const ATTEMPT_STATUSES = Object.freeze(["in_progress", "succeeded", "failed"]);

/**
 * Durable LIFECYCLE MARKER of one analysis attempt (Workstream 5A): the minimum needed to say, from any request and any process, whether an analysis of a Signal is
 * in progress, succeeded or failed, so that
 *
 *   - a second request for the same (workspace, Signal, level) never starts a second provider call while one is in flight (the partial unique index below is the
 *     cross-process form of the in-process single-flight that already existed), and
 *   - a request or a poll can be told "in progress" instead of the analysis being treated as failed merely because the HTTP response window ended.
 *
 * It is OPERATIONAL METADATA, like AnalysisAdmission - not Intelligence. It is deliberately minimal and keeps NONE of: a prompt, raw model output, Signal text, guest data,
 * evidence, a provider payload, a header or a secret. The analysis itself lives only in the Intelligence record (written only after full validation); this marker never
 * carries or implies one: a Decision or Action can only be proposed from a stored Intelligence, so an in-progress or failed marker grants nothing.
 *
 * WORKSPACE-SCOPED: `workspaceId` is required, and the only read/write paths (analysisAttemptService) always filter by it. Written by the server only; no route creates or
 * edits one. One row per attempt: a failed attempt stays as history and a later explicit request makes a new row. There is no worker and no queue: the row is written
 * and updated by the same process that runs the (single, user-triggered) pipeline.
 */
const analysisAttemptSchema = new mongoose.Schema(
  {
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true },
    signalId: { type: mongoose.Schema.Types.ObjectId, ref: "Signal", required: true },
    analysisLevel: { type: String, enum: VISIBILITY_LEVELS, required: true },
    // The same random id the AnalysisAdmission row of this attempt carries, so the two records and the structured events join on it.
    attemptId: { type: String, required: true, match: /^[0-9a-f-]{36}$/ },
    // The X-Request-Id (a canonical uuid) of the HTTP request that started the attempt; correlation only, never an input to any decision.
    requestId: { type: String, match: /^[0-9a-f-]{36}$/, default: undefined },
    status: { type: String, enum: ATTEMPT_STATUSES, required: true, default: "in_progress" },
    startedAt: { type: Date, required: true },
    finishedAt: { type: Date, default: undefined },
    // On success only: the stored analysis this attempt produced (an id, never content).
    intelligenceId: { type: mongoose.Schema.Types.ObjectId, ref: "Intelligence", default: undefined },
    // On failure only: the stable, already-public failure vocabulary (details.code / class / HTTP status). Never a message.
    failureCode: { type: String, match: /^[A-Z0-9_]{1,64}$/, default: undefined },
    failureClass: { type: String, enum: FAILURE_CLASSES, default: undefined },
    httpStatus: { type: Number, default: undefined },
  },
  { timestamps: true },
);

// At most ONE in-flight attempt per (workspace, Signal, level), across every process that shares the database.
analysisAttemptSchema.index(
  { workspaceId: 1, signalId: 1, analysisLevel: 1 },
  { unique: true, partialFilterExpression: { status: "in_progress" }, name: "analysis_attempt_one_in_progress" },
);
analysisAttemptSchema.index({ workspaceId: 1, signalId: 1, analysisLevel: 1, startedAt: -1 });
analysisAttemptSchema.index({ workspaceId: 1, attemptId: 1 }, { unique: true });

export const AnalysisAttempt = mongoose.models.AnalysisAttempt || mongoose.model("AnalysisAttempt", analysisAttemptSchema);
