import mongoose from "mongoose";

const OUTCOME_STATUSES = ["success", "partial", "failed", "unknown"];

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
      enum: OUTCOME_STATUSES,
      default: "unknown",
      index: true,
    },
    result: {
      summary: { type: String, trim: true, default: "" },
      notes: { type: String, trim: true, default: "" },
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
  },
  {
    timestamps: true,
  },
);

outcomeSchema.index({ workspaceId: 1, occurredAt: -1 });

export const Outcome = mongoose.model("Outcome", outcomeSchema);
export { OUTCOME_STATUSES };
