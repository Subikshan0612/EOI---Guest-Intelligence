import mongoose from "mongoose";

const STAY_STATUSES = [
  "reserved",
  "confirmed",
  "checked_in",
  "checked_out",
  "cancelled",
  "no_show",
];

const staySchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    guestId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Guest",
      required: true,
      index: true,
    },
    propertyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Property",
      required: true,
      index: true,
    },
    unitId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Unit",
      default: undefined,
      index: true,
    },
    reservationId: {
      type: String,
      trim: true,
      default: undefined,
    },
    checkIn: {
      type: Date,
      default: undefined,
    },
    checkOut: {
      type: Date,
      default: undefined,
    },
    status: {
      type: String,
      enum: STAY_STATUSES,
      default: "reserved",
    },
    adults: {
      type: Number,
      min: 0,
      default: 1,
    },
    children: {
      type: Number,
      min: 0,
      default: 0,
    },
    source: {
      type: String,
      trim: true,
      default: "",
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

staySchema.index(
  { workspaceId: 1, reservationId: 1 },
  {
    unique: true,
    partialFilterExpression: { reservationId: { $type: "string" } },
  },
);
staySchema.index({ workspaceId: 1, checkIn: 1 });
staySchema.index({ workspaceId: 1, checkOut: 1 });
staySchema.index({ workspaceId: 1, status: 1 });

export const Stay = mongoose.model("Stay", staySchema);
export { STAY_STATUSES };
