import mongoose from "mongoose";

const SIGNAL_TYPES = [
  "maintenance",
  "guest_request",
  "housekeeping",
  "complaint",
  "sentiment",
  "payment",
  "arrival",
  "departure",
  "system",
  "other",
];

const SIGNAL_SOURCES = ["staff", "pms", "guest", "system", "integration", "ai", "other"];
const SIGNAL_SEVERITIES = ["low", "medium", "high", "critical"];
const SIGNAL_STATUSES = ["new", "acknowledged", "resolved", "dismissed"];

const signalSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    propertyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Property",
      default: undefined,
      index: true,
    },
    unitId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Unit",
      default: undefined,
      index: true,
    },
    guestId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Guest",
      default: undefined,
      index: true,
    },
    stayId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Stay",
      default: undefined,
      index: true,
    },
    type: {
      type: String,
      enum: SIGNAL_TYPES,
      required: true,
    },
    source: {
      type: String,
      enum: SIGNAL_SOURCES,
      default: "system",
    },
    severity: {
      type: String,
      enum: SIGNAL_SEVERITIES,
      default: "medium",
    },
    status: {
      type: String,
      enum: SIGNAL_STATUSES,
      default: "new",
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
      default: "",
    },
    occurredAt: {
      type: Date,
      default: Date.now,
    },
    detectedAt: {
      type: Date,
      default: Date.now,
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

signalSchema.index({ workspaceId: 1, createdAt: -1 });
signalSchema.index({ workspaceId: 1, severity: 1 });
signalSchema.index({ workspaceId: 1, status: 1 });
signalSchema.index({ workspaceId: 1, occurredAt: -1 });

export const Signal = mongoose.model("Signal", signalSchema);
export { SIGNAL_TYPES, SIGNAL_SOURCES, SIGNAL_SEVERITIES, SIGNAL_STATUSES };
