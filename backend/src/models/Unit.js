import mongoose from "mongoose";

const UNIT_TYPES = ["apartment", "studio", "suite", "room", "other"];
const UNIT_STATUSES = ["available", "occupied", "maintenance", "out_of_service", "inactive"];

const unitSchema = new mongoose.Schema(
  {
    propertyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Property",
      required: true,
      index: true,
    },
    unitNumber: {
      type: String,
      required: true,
      trim: true,
    },
    type: {
      type: String,
      enum: UNIT_TYPES,
      default: "apartment",
    },
    status: {
      type: String,
      enum: UNIT_STATUSES,
      default: "available",
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

unitSchema.index({ propertyId: 1, unitNumber: 1 }, { unique: true });

export const Unit = mongoose.model("Unit", unitSchema);
export { UNIT_TYPES, UNIT_STATUSES };
