import mongoose from "mongoose";

const MESSAGE_ROLES = ["user", "assistant", "system"];
const MESSAGE_TYPES = ["text", "intelligence"];

const messageSchema = new mongoose.Schema(
  {
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Conversation",
      required: true,
    },
    role: {
      type: String,
      enum: MESSAGE_ROLES,
      required: true,
    },
    type: {
      type: String,
      enum: MESSAGE_TYPES,
      default: "text",
    },
    content: {
      type: String,
      required: true,
      trim: true,
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

messageSchema.index({ conversationId: 1, createdAt: 1 });

export const Message = mongoose.model("Message", messageSchema);
export { MESSAGE_ROLES, MESSAGE_TYPES };
