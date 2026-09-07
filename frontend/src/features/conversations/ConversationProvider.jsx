import { useCallback, useMemo, useState } from "react";
import { conversations as seedConversations } from "../../data/mockData";
import { createLocalId } from "../chat/conversationSession";
import { ConversationContext } from "./conversationContext";
import { loadConversationStore, persistConversationStore } from "./conversationStore";
import { generateConversationTitle } from "./titleGenerator";

function stamp() {
  return new Date().toISOString();
}

export function ConversationProvider({ children }) {
  const [conversations, setConversations] = useState(() => loadConversationStore(seedConversations));

  const commit = useCallback((updater) => {
    setConversations((current) => {
      const next = typeof updater === "function" ? updater(current) : updater;
      persistConversationStore(next);
      return next;
    });
  }, []);

  const getById = useCallback(
    (id) => conversations.find((conversation) => conversation.id === id) ?? null,
    [conversations],
  );

  const createFromFirstMessage = useCallback((content, userMessage) => {
    const createdAt = stamp();
    const created = {
      id: createLocalId("convo"),
      title: generateConversationTitle(content),
      createdAt,
      updatedAt: createdAt,
      messages: [userMessage],
      summary: content.replace(/\s+/g, " ").trim().slice(0, 140),
      status: "open",
      origin: "user",
      guestId: null,
      stayId: null,
    };

    commit((current) => [created, ...current.filter((item) => item.id !== created.id)]);
    return created;
  }, [commit]);

  const appendMessage = useCallback(
    (id, message) => {
      commit((current) =>
        current.map((conversation) =>
          conversation.id === id
            ? {
                ...conversation,
                updatedAt: stamp(),
                messages: [...conversation.messages, message],
              }
            : conversation,
        ),
      );
    },
    [commit],
  );

  const renameConversation = useCallback(
    (id, nextTitle) => {
      const title = nextTitle.replace(/\s+/g, " ").trim();
      if (!title) return false;

      commit((current) =>
        current.map((conversation) =>
          conversation.id === id ? { ...conversation, title } : conversation,
        ),
      );
      return true;
    },
    [commit],
  );

  const deleteConversation = useCallback(
    (id) => {
      commit((current) => current.filter((conversation) => conversation.id !== id));
    },
    [commit],
  );

  const value = useMemo(
    () => ({
      conversations,
      getById,
      createFromFirstMessage,
      appendMessage,
      renameConversation,
      deleteConversation,
    }),
    [conversations, getById, createFromFirstMessage, appendMessage, renameConversation, deleteConversation],
  );

  return <ConversationContext.Provider value={value}>{children}</ConversationContext.Provider>;
}
