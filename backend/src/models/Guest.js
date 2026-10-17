import mongoose from "mongoose";

const guestSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    // The Property this guest belongs to (workspace -> property -> guest). Optional in the SCHEMA only so that guests created before this field existed stay valid and
    // readable; guestService requires it for every new guest, and services/operationalScope.js refuses to link a guest to a different property.
    propertyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Property",
      default: undefined,
      index: true,
    },
    externalId: {
      type: String,
      trim: true,
      default: undefined,
    },
    firstName: {
      type: String,
      trim: true,
      default: "",
    },
    lastName: {
      type: String,
      trim: true,
      default: "",
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      default: undefined,
    },
    phone: {
      type: String,
      trim: true,
      default: undefined,
    },
    preferences: {
      type: Map,
      of: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },
    metadata: {
      type: Map,
      of: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },
  },
  {
    timestamps: true,
  },
);

guestSchema.index(
  { workspaceId: 1, externalId: 1 },
  {
    unique: true,
    partialFilterExpression: { externalId: { $type: "string" } },
  },
);
guestSchema.index({ workspaceId: 1, email: 1 });
guestSchema.index({ workspaceId: 1, lastName: 1, firstName: 1 });
guestSchema.index({ workspaceId: 1, propertyId: 1, lastName: 1, firstName: 1 });

export const Guest = mongoose.model("Guest", guestSchema);
