import mongoose from "mongoose";

const ACTION_STATUSES = ["pending", "in_progress", "completed", "cancelled", "failed"];

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
  },
  {
    timestamps: true,
  },
);

actionSchema.index({ workspaceId: 1, status: 1 });

export const Action = mongoose.model("Action", actionSchema);
export { ACTION_STATUSES };
