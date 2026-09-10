import mongoose from "mongoose";

const RISK_LEVELS = ["low", "medium", "high", "critical"];
const GENERATED_BY = ["rule", "llm", "human", "system"];

const intelligenceSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Conversation",
      default: undefined,
      index: true,
    },
    signalIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Signal",
      },
    ],
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
    signal: {
      summary: { type: String, trim: true, default: "" },
      type: { type: String, trim: true, default: "" },
      severity: { type: String, trim: true, default: "" },
    },
    context: {
      summary: { type: String, trim: true, default: "" },
      unit: { type: String, trim: true, default: "" },
      stayStatus: { type: String, trim: true, default: "" },
    },
    intelligence: {
      summary: { type: String, trim: true, default: "" },
      pattern: { type: String, trim: true, default: "" },
      guestImpact: { type: String, trim: true, default: "" },
      operationalImpact: { type: String, trim: true, default: "" },
    },
    risk: {
      level: { type: String, enum: RISK_LEVELS, default: "medium" },
      reason: { type: String, trim: true, default: "" },
    },
    decision: {
      summary: { type: String, trim: true, default: "" },
      priority: { type: String, enum: RISK_LEVELS, default: "medium" },
    },
    action: {
      summary: { type: String, trim: true, default: "" },
      status: { type: String, trim: true, default: "" },
    },
    outcome: {
      summary: { type: String, trim: true, default: "" },
      status: { type: String, trim: true, default: "" },
    },
    confidence: {
      type: Number,
      min: 0,
      max: 1,
      default: undefined,
    },
    generatedBy: {
      type: String,
      enum: GENERATED_BY,
      default: "system",
    },
    model: {
      type: String,
      trim: true,
      default: undefined,
    },
  },
  {
    timestamps: true,
  },
);

intelligenceSchema.index({ workspaceId: 1, createdAt: -1 });
intelligenceSchema.index({ signalIds: 1 });

export const Intelligence = mongoose.model("Intelligence", intelligenceSchema);
export { RISK_LEVELS, GENERATED_BY };
