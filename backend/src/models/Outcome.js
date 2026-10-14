import mongoose from "mongoose";

const OUTCOME_STATUSES = ["success", "partial", "failed", "unknown"];
// Phase 50: what a PERSON may report about an Action. `blocked` = it could not be carried out for a reason outside the work itself (access refused, parts unavailable).
// It is deliberately NOT added to OUTCOME_STATUSES: that list is the Phase 31 Learning vocabulary (counted per status, success rate over success / partial / failed),
// and Learning stays untouched and OFF - a `blocked` Outcome is simply not counted there (it is neither a success nor a failure of the proposed work).
const OUTCOME_V1_STATUSES = [...OUTCOME_STATUSES, "blocked"];
const OUTCOME_VERSION = "outcome-v1";

const outcomeSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    intelligenceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Intelligence",
      required: true,
      index: true,
    },
    actionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Action",
      default: undefined,
      index: true,
    },
    status: {
      type: String,
      enum: OUTCOME_V1_STATUSES,
      default: "unknown",
      index: true,
    },
    result: {
      summary: { type: String, trim: true, default: "", maxlength: 2000 },
      notes: { type: String, trim: true, default: "", maxlength: 2000 },
    },
    metrics: {
      type: Map,
      of: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },
    feedback: {
      type: Map,
      of: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },
    occurredAt: {
      type: Date,
      default: Date.now,
    },
    // ---- Outcome V1 (Phase 30; all additive, absent on every pre-V1 record) -----------------------------------
    // An Outcome V1 is "the observed result of an Action after an execution attempt" - never a proposal,
    // approval, recommendation, prediction or model claim (see outcomeService.js's recordOutcome). It can
    // ONLY be written by services/outcomeService.js's recordOutcome() function, which NO route or controller
    // in this codebase calls - there is deliberately no execution engine yet (see
    // backend/docs/OUTCOME_INTEGRITY_PHASE30.md for the exact contract a future trusted execution boundary
    // must satisfy to call it). `metrics`/`feedback` above are LEGACY-only: a V1 record never sets them.
    outcomeVersion: { type: String, default: undefined },
    actionVersion: { type: String, default: undefined }, // snapshot of the Action's own version, provenance only
    decisionId: { type: mongoose.Schema.Types.ObjectId, ref: "Decision", default: undefined },
    signalId: { type: mongoose.Schema.Types.ObjectId, ref: "Signal", default: undefined },
    propertyId: { type: mongoose.Schema.Types.ObjectId, ref: "Property", default: undefined },
    // Server-set ONLY (recordOutcome never accepts one from a caller) - the trusted moment this service
    // recorded the result. Never trust occurredAt above for a V1 security decision; it is kept only because
    // legacy records already use it and nothing should break for them.
    recordedAt: { type: Date, default: undefined },
    // Phase 50: the AUTHENTICATED user who recorded the observation (server-set from the session, never from a request). Never exposed as an id.
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: undefined },
  },
  {
    timestamps: true,
  },
);

outcomeSchema.index({ workspaceId: 1, occurredAt: -1 });
// Idempotency (Phase 30): at most ONE Outcome V1 per (workspace, Action). Unlike Decision/Action V1,
// re-recording is NOT idempotent-return - a second attempt for the same Action is a CONFLICTING claim about
// an already-observed fact and is refused outright (see recordOutcome's own pre-check; this index is the
// database-level backstop against a race between two such attempts).
outcomeSchema.index(
  { workspaceId: 1, actionId: 1, outcomeVersion: 1 },
  { unique: true, partialFilterExpression: { outcomeVersion: OUTCOME_VERSION } },
);

export const Outcome = mongoose.model("Outcome", outcomeSchema);
export { OUTCOME_STATUSES, OUTCOME_V1_STATUSES, OUTCOME_VERSION };
