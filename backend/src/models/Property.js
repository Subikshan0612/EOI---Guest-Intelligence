import mongoose from "mongoose";

const PROPERTY_STATUSES = ["active", "inactive", "archived"];

const propertySchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    code: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
    },
    address: {
      type: String,
      trim: true,
      default: "",
    },
    timezone: {
      type: String,
      trim: true,
      default: "UTC",
    },
    status: {
      type: String,
      enum: PROPERTY_STATUSES,
      default: "active",
    },
  },
  {
    timestamps: true,
  },
);

propertySchema.index({ workspaceId: 1, code: 1 }, { unique: true });

export const Property = mongoose.model("Property", propertySchema);
export { PROPERTY_STATUSES };
