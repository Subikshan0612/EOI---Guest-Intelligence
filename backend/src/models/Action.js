import mongoose from "mongoose";

const ACTION_STATUSES = ["pending", "in_progress", "completed", "cancelled", "failed", "proposed", "approved", "rejected"];
const ACTION_VERSION = "action-v1";

// Phase 29 - a CLOSED allowlist of what an Action V1 may represent. This is a domain PROPOSAL, never an
// executable instruction: there is deliberately no field anywhere in the V1 contract for a URL, an HTTP
// method, a shell/database command, a tool/function name, or any other executable payload. An unknown type
// is refused (actionService.js), never defaulted or coerced. The set below is the smallest one the existing
// domain's own knowledge-document examples already describe (escalate to the duty engineer, dispatch
// maintenance, contact the guest, inspect something) plus a catch-all - not a speculative future taxonomy.
const ACTION_TYPES = ["maintenance_dispatch", "guest_communication", "escalation", "inspection", "other"];

// A CLASS, not a probability or a client choice - see RISK_BY_ACTION_TYPE in actionService.js, which is the
// only place a riskLevel is ever computed. The request body can never set this field (actionService.js
// rejects it outright), so a caller cannot "choose" a lower risk to bypass anything.
const ACTION_RISK_LEVELS = ["low", "medium", "high", "critical"];

const actionSchema = new mongoose.Schema(
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
    decisionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Decision",
      default: undefined,
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
    status: {
      type: String,
      enum: ACTION_STATUSES,
      default: "pending",
    },
    assignedTo: {
      type: String,
      trim: true,
      default: undefined,
      index: true,
    },
    dueAt: {
      type: Date,
      default: undefined,
    },
    completedAt: {
      type: Date,
      default: undefined,
    },
    result: {
      summary: { type: String, trim: true, default: "" },
      notes: { type: String, trim: true, default: "" },
    },
    // ---- Action V1 (all additive; absent on every pre-V1 record) --------------------------------------------
    // An Action V1 is a PROPOSAL derived deterministically from ONE stored, APPROVED Decision V1
    // (actionService.proposeAction). It executes nothing: there is no field here that can run a command, call
    // an external service, or send anything. `status` above is REUSED (proposed/approved/rejected added to its
    // existing enum) rather than introducing a parallel field - see ACTION_STATUSES.
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
    actionVersion: { type: String, default: undefined },
    actionType: { type: String, enum: ACTION_TYPES, default: undefined },
    // Server-computed only (see RISK_BY_ACTION_TYPE) - never accepted from a request body.
    riskLevel: { type: String, enum: ACTION_RISK_LEVELS, default: undefined },
    // Phase 49: how soon a person should act, copied by the server from the parent Intelligence's VALIDATED structured safety result (never from prose,
    // never from a request). Absent when the Intelligence recorded none.
    urgency: { type: String, enum: ["immediate", "prompt", "routine"], default: undefined },
    // A bounded, human-readable label only - never interpreted, never executed, never a URL/command/query.
    target: {
      note: { type: String, trim: true, default: undefined },
    },
    // Phase 35 - proposer / reviewer separation, mirroring Decision V1 exactly (see services/governance.js): set ONLY by the server
    // from the authenticated actor; `proposedBy` is REQUIRED on a record created under the rule.
    governanceVersion: { type: String, default: undefined },
    proposedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: undefined,
      required: function proposerRequiredWhenGoverned() {
        return this.governanceVersion !== undefined && this.governanceVersion !== null;
      },
    },
    // Set by the server when a human review is recorded - mirrors Decision V1's `review`. `reviewedBy` (Phase 35) is the
    // authenticated reviewer, never the proposer of a governed record.
    review: {
      reviewedAt: { type: Date, default: undefined },
      reviewNote: { type: String, trim: true, default: undefined },
      reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: undefined },
    },
    // Append-only, server-written. At most one entry in V1 (proposed -> approved, or proposed -> rejected).
    transitions: {
      type: [
        {
          _id: false,
          from: { type: String, enum: ACTION_STATUSES, required: true },
          to: { type: String, enum: ACTION_STATUSES, required: true },
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

actionSchema.index({ workspaceId: 1, status: 1 });
// Idempotency: at most ONE Action V1 per (workspace, Decision). Partial, so it never applies to legacy
// records (which may have no decisionId at all, or several Actions per Decision under the old free-form
// model). A rejected Action keeps its slot - V1 defines no re-proposal, exactly like Decision V1.
actionSchema.index(
  { workspaceId: 1, decisionId: 1, actionVersion: 1 },
  { unique: true, partialFilterExpression: { actionVersion: ACTION_VERSION } },
);

export const Action = mongoose.model("Action", actionSchema);
export { ACTION_STATUSES, ACTION_VERSION, ACTION_TYPES, ACTION_RISK_LEVELS };
