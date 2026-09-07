import { useContext } from "react";
import { ConversationContext } from "./conversationContext";

export function useConversations() {
  const context = useContext(ConversationContext);

  if (!context) {
    throw new Error("useConversations must be used within ConversationProvider");
  }

  return context;
}
