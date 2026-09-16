import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { INTELLIGENCE_MESSAGE_TYPE } from "../intelligence/intelligenceContract";
import { requestIntelligence } from "./chatService";
import { useConversations } from "../conversations/useConversations";

const EMPTY_CONVERSATION = {
  id: null,
  title: "New Intelligence",
  messages: [],
};

function friendlyError(error, fallback) {
  return error?.message && error.name === "ApiError" ? error.message : fallback;
}

/**
 * Chat turn orchestration.
 *
 * New conversation:  create → persist first user message → navigate.
 *   The turn is completed by the remounted hook via the "resume" path below,
 *   so intelligence is never generated twice.
 * Existing conversation:  persist user message → run mock intelligence →
 *   persist the intelligence message.
 *
 * Intelligence is still produced entirely by the local mock (chatService).
 */
export function useChat({ conversationId = null, resetKey = "default" } = {}) {
  const navigate = useNavigate();
  const { getById, loadConversation, createConversation, addMessage, deleteConversation } =
    useConversations();

  const [draft, setDraft] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState(conversationId ? "loading" : "ready");
  const [loadKey, setLoadKey] = useState(0);

  const abortRef = useRef(null);
  const sendingRef = useRef(false);
  const sessionRef = useRef(null);
  const aliveRef = useRef(true);

  const stored = conversationId ? getById(conversationId) : null;
  const conversation = stored ?? { ...EMPTY_CONVERSATION, id: conversationId ?? null };

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const completeTurn = useCallback(
    async (activeId, content) => {
      setIsProcessing(true);
      setError(null);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const priorMessages = getById(activeId)?.messages ?? [];
        const payload = await requestIntelligence({
          content,
          priorMessages,
          abortSignal: controller.signal,
        });
        if (controller.signal.aborted) return;

        await addMessage(activeId, {
          role: "assistant",
          type: INTELLIGENCE_MESSAGE_TYPE,
          content: payload?.intelligence?.summary ?? "",
          payload,
        });
      } catch (err) {
        if (err?.name === "AbortError") return;
        setError(
          friendlyError(err, "EOI could not complete this investigation. You can try again."),
        );
      } finally {
        if (!controller.signal.aborted && aliveRef.current) {
          setIsProcessing(false);
          abortRef.current = null;
        }
      }
    },
    [addMessage, getById],
  );

  // Load the conversation on open; resume an interrupted turn if the last
  // persisted message is still the user's.
  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    sendingRef.current = false;
    sessionRef.current = conversationId;
    setError(null);
    setDraft("");

    if (!conversationId) {
      setStatus("ready");
      setIsProcessing(false);
      return undefined;
    }

    const resumeIfInterrupted = (messages) => {
      const last = (messages ?? []).at(-1);
      if (last?.role === "user" && !sendingRef.current) {
        completeTurn(conversationId, last.content);
      }
    };

    // Already hydrated (e.g. the conversation we just created) — no flash.
    const preloaded = getById(conversationId);
    if (preloaded?.messagesLoaded) {
      setStatus("ready");
      resumeIfInterrupted(preloaded.messages);
      return undefined;
    }

    let cancelled = false;
    setStatus("loading");
    setIsProcessing(false);

    loadConversation(conversationId).then((result) => {
      if (cancelled) return;
      if (result.status !== "ready") {
        setStatus(result.status);
        return;
      }
      setStatus("ready");
      resumeIfInterrupted(result.conversation.messages);
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, resetKey, loadKey]);

  async function send(rawContent = draft) {
    const content = rawContent.trim();
    if (!content || isProcessing || sendingRef.current) return;

    sendingRef.current = true;
    setIsProcessing(true);
    setError(null);

    try {
      let activeId = conversationId ?? sessionRef.current;
      const isNew = !activeId || !getById(activeId);

      if (isNew) {
        const created = await createConversation(content);
        activeId = created.id;
        sessionRef.current = activeId;
        setDraft("");
        try {
          await addMessage(activeId, { role: "user", type: "text", content });
        } catch (err) {
          await deleteConversation(activeId).catch(() => {});
          throw err;
        }
        navigate(`/chat/${activeId}`, { replace: true });
        return; // remounted hook resumes the turn
      }

      setDraft("");
      await addMessage(activeId, { role: "user", type: "text", content });
      await completeTurn(activeId, content);
    } catch (err) {
      setError(friendlyError(err, "EOI could not save your message. Try again."));
    } finally {
      sendingRef.current = false;
      if (aliveRef.current) setIsProcessing(false);
    }
  }

  async function retry() {
    const activeId = conversationId ?? sessionRef.current;
    const lastUser = [...(conversation.messages ?? [])]
      .reverse()
      .find((message) => message.role === "user");
    if (!lastUser || !activeId || isProcessing || sendingRef.current) return;
    sendingRef.current = true;
    try {
      await completeTurn(activeId, lastUser.content);
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
    status,
    retryLoad: () => setLoadKey((key) => key + 1),
    clearError: () => setError(null),
  };
}
