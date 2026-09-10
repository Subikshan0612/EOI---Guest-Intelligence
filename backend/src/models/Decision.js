import mongoose from "mongoose";

const DECISION_PRIORITIES = ["low", "medium", "high", "critical"];
const DECISION_STATUSES = ["proposed", "approved", "rejected", "completed"];

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
  },
  {
    timestamps: true,
  },
);

export const Decision = mongoose.model("Decision", decisionSchema);
export { DECISION_PRIORITIES, DECISION_STATUSES };
