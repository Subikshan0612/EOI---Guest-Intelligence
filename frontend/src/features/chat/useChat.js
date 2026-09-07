import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { createIntelligenceMessage, createUserMessage } from "../intelligence/intelligenceContract";
import { requestIntelligence } from "./chatService";
import { createLocalId } from "./conversationSession";
import { useConversations } from "../conversations/useConversations";

const EMPTY_CONVERSATION = {
  id: null,
  title: "New Intelligence",
  messages: [],
};

export function useChat({ conversationId = null, resetKey = "default" } = {}) {
  const navigate = useNavigate();
  const { getById, createFromFirstMessage, appendMessage } = useConversations();
  const stored = conversationId ? getById(conversationId) : null;
  const [draft, setDraft] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState(null);
  const abortRef = useRef(null);
  const sessionRef = useRef(null);
  const sendingRef = useRef(false);

  const conversation = stored ?? EMPTY_CONVERSATION;

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (conversationId && sessionRef.current === conversationId) {
      return;
    }

    abortRef.current?.abort();
    abortRef.current = null;
    sessionRef.current = conversationId;
    setDraft("");
    setError(null);

    const current = conversationId ? getById(conversationId) : null;
    const last = current?.messages?.at(-1);
    if (last?.role === "user") {
      completeTurn(conversationId, last.content, current.messages);
    } else {
      setIsProcessing(false);
    }
  }, [conversationId, resetKey]);

  async function completeTurn(activeId, content, priorMessages) {
    setIsProcessing(true);
    setError(null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const payload = await requestIntelligence({
        content,
        priorMessages,
        abortSignal: controller.signal,
      });

      if (controller.signal.aborted) return;

      appendMessage(
        activeId,
        createIntelligenceMessage({
          id: createLocalId("msg"),
          ...payload,
        }),
      );
    } catch (err) {
      if (err?.name === "AbortError") return;
      setError("KOI could not complete this investigation. You can try again.");
    } finally {
      if (!controller.signal.aborted) {
        setIsProcessing(false);
        abortRef.current = null;
      }
    }
  }

  async function send(rawContent = draft) {
    const content = rawContent.trim();
    if (!content || isProcessing || sendingRef.current) return;

    sendingRef.current = true;
    setIsProcessing(true);

    const userMessage = createUserMessage({
      id: createLocalId("msg"),
      content,
    });

    let activeId = conversationId ?? sessionRef.current;
    let priorMessages = [];

    if (!activeId || !getById(activeId)) {
      const created = createFromFirstMessage(content, userMessage);
      activeId = created.id;
      priorMessages = created.messages;
      sessionRef.current = activeId;
      navigate(`/chat/${activeId}`, { replace: true });
    } else {
      priorMessages = [...getById(activeId).messages, userMessage];
      appendMessage(activeId, userMessage);
    }

    setDraft("");
    try {
      await completeTurn(activeId, content, priorMessages);
    } finally {
      sendingRef.current = false;
    }
  }

  async function retry() {
    const lastUser = [...conversation.messages].reverse().find((message) => message.role === "user");
    const activeId = conversationId ?? sessionRef.current;
    if (!lastUser || !activeId || isProcessing || sendingRef.current) return;
    sendingRef.current = true;
    try {
      await completeTurn(activeId, lastUser.content, conversation.messages);
    } finally {
      sendingRef.current = false;
    }
  }

  return {
    conversation,
    draft,
    setDraft,
    send,
    retry,
    isProcessing,
    error,
    clearError: () => setError(null),
  };
}
