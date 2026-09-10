import mongoose from "mongoose";

const WORKSPACE_STATUSES = ["active", "inactive", "suspended"];

const workspaceSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    slug: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      unique: true,
    },
    status: {
      type: String,
      enum: WORKSPACE_STATUSES,
      default: "active",
    },
    settings: {
      type: Map,
      of: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },
  },
  {
    timestamps: true,
  },
);

workspaceSchema.index({ status: 1 });

export const Workspace = mongoose.model("Workspace", workspaceSchema);
export { WORKSPACE_STATUSES };
