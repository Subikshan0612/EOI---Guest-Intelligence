import mongoose from "mongoose";
import { VISIBILITY_LEVELS } from "../services/knowledge/visibility.js";

const DECISION_PRIORITIES = ["low", "medium", "high", "critical"];
// "completed" is kept ONLY so historical (pre-V1) records stay valid. Decision V1
// never writes it: V1 records move proposed -> approved | rejected and stop there.
const DECISION_STATUSES = ["proposed", "approved", "rejected", "completed"];
const DECISION_VERSION = "decision-v1";
// Mirrors Intelligence V1's evidence-quality class (a class, never a probability).
const DECISION_CONFIDENCE_LEVELS = ["high", "medium", "low"];

const decisionSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    intelligenceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Intelligence",
      required: true,
      index: true,
    },
    type: {
      type: String,
      trim: true,
      default: "operational",
    },
    description: {
      type: String,
      required: true,
      trim: true,
    },
    priority: {
      type: String,
      enum: DECISION_PRIORITIES,
      default: "medium",
    },
    status: {
      type: String,
      enum: DECISION_STATUSES,
      default: "proposed",
    },
    // ---- Decision V1 (all additive; absent on every pre-V1 record) ----------
    // A V1 Decision is a PROPOSAL derived deterministically from ONE stored
    // Intelligence V1 record (see decisionService.proposeDecision). Nothing here
    // can express or trigger an Action; only a small traceability snapshot is kept
    // - never the Intelligence record, its provenance, or any guest data.
    signalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Signal",
      default: undefined,
    },
    propertyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Property",
      default: undefined,
    },
    decisionVersion: { type: String, default: undefined },
    confidence: { type: String, enum: DECISION_CONFIDENCE_LEVELS, default: undefined },
    // Snapshot markers copied from the parent Intelligence. Provenance only: they
    // are NEVER used to authorize a read - the live parent record is.
    analysisVersion: { type: String, default: undefined },
    analysisLevel: { type: String, enum: VISIBILITY_LEVELS, default: undefined },
    knowledgeVisibility: { type: String, enum: VISIBILITY_LEVELS, default: undefined },
    // Phase 35 - proposer / reviewer separation. Both are set ONLY by the server from the authenticated actor
    // (req.actor.userId), never from a request. `governanceVersion` marks a record created under the rule; for such a record
    // `proposedBy` is REQUIRED, so a new record without a proposer cannot be stored. Records that predate this have neither
    // (legacy: reviewable as before - see services/governance.js).
    governanceVersion: { type: String, default: undefined },
    proposedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: undefined,
      required: function proposerRequiredWhenGoverned() {
        return this.governanceVersion !== undefined && this.governanceVersion !== null;
      },
    },
    // Set by the server when a human review is recorded. `reviewedBy` (Phase 35) is the authenticated reviewer; it is never the
    // proposer of a governed record.
    review: {
      reviewedAt: { type: Date, default: undefined },
      reviewNote: { type: String, trim: true, default: undefined },
      reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: undefined },
      // Phase 48 (additive): when the reviewer REJECTS the AI recommendation and decides differently, what they decided instead - the HUMAN decision, kept
      // apart from `description` (the AI recommendation snapshot) and from the Intelligence, which is never modified. Set only by the server, only on
      // a rejection, only by a reviewer. It is a record, not an instruction: nothing reads it to act.
      alternative: { type: String, trim: true, default: undefined },
    },
    // Append-only, server-written. At most one entry in V1.
    transitions: {
      type: [
        {
          _id: false,
          from: { type: String, enum: DECISION_STATUSES, required: true },
          to: { type: String, enum: DECISION_STATUSES, required: true },
          at: { type: Date, required: true },
          note: { type: String, trim: true, default: undefined },
        },
      ],
      default: undefined,
    },
  },
  {
    timestamps: true,
  },
);

decisionSchema.index({ workspaceId: 1, signalId: 1 });
decisionSchema.index({ workspaceId: 1, status: 1, priority: 1 });
// Idempotency: at most ONE Decision V1 per (workspace, Intelligence). Partial, so
// it never applies to legacy records. Rejection is terminal in V1 - there is no
// re-proposal - so a rejected Decision keeps its slot.
decisionSchema.index(
  { workspaceId: 1, intelligenceId: 1, decisionVersion: 1 },
  { unique: true, partialFilterExpression: { decisionVersion: DECISION_VERSION } },
);

export const Decision = mongoose.model("Decision", decisionSchema);
export { DECISION_PRIORITIES, DECISION_STATUSES, DECISION_VERSION, DECISION_CONFIDENCE_LEVELS };
