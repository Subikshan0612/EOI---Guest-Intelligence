import mongoose from "mongoose";

const CONVERSATION_STATUSES = ["active", "archived"];

const conversationSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    userId: {
      type: String,
      trim: true,
      default: undefined,
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
    signalIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Signal",
      },
    ],
    title: {
      type: String,
      trim: true,
      default: "New Intelligence",
    },
    status: {
      type: String,
      enum: CONVERSATION_STATUSES,
      default: "active",
    },
  },
  {
    timestamps: true,
  },
);

conversationSchema.index({ workspaceId: 1, updatedAt: -1 });
conversationSchema.index({ workspaceId: 1, createdAt: -1 });

export const Conversation = mongoose.model("Conversation", conversationSchema);
export { CONVERSATION_STATUSES };
