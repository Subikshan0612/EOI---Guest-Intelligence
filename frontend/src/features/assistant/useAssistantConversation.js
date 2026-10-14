import { useCallback, useEffect, useRef, useState } from "react";
import { KOI_WORKSPACE_ID, isWorkspaceConfigured } from "../../config/workspace";
import * as koiApi from "../../services/api";
import { describeTurnFailure, mapConversation, mapMessages, mapTurn } from "./assistantMapping";

/**
 * One operator conversation (Phase 47): its stored messages, and `send(text)` for one turn of the Signal intake.
 *
 * LOADING reads the stored messages (GET only) - it never records a signal and never calls the AI. SENDING (`send`) is called from the composer's submit handler and
 * nowhere else; it asks the SERVER to record a Signal or to ask a clarifying question (POST /api/conversations/intake) and appends the two stored messages. Neither
 * path generates Intelligence: that is a separate, explicit click on a Signal (useSignalIntelligence). The server stays the source of truth: the page only shows
 * what the server stored, and a refresh reloads it from the backend.
 *
 * status: 'new' (no conversation yet) | 'loading' | 'ready' | 'missing' | 'error' | 'unconfigured'
 */
export function useAssistantConversation(routeConversationId) {
  const [conversationId, setConversationId] = useState(routeConversationId ?? null);
  const [messages, setMessages] = useState([]);
  const [status, setStatus] = useState(routeConversationId ? "loading" : "new");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState(null);
  const loadedFor = useRef(null); // the conversation whose messages are already in state (a first turn creates one: no reload needed)
  const sendingRef = useRef(false); // one turn at a time, whatever calls send (double click, Enter held down)

  const load = useCallback(async (id) => {
    if (!isWorkspaceConfigured) {
      setStatus("unconfigured");
      return;
    }
    setStatus("loading");
    try {
      const [conversation, page] = await Promise.all([
        koiApi.getConversation(id, KOI_WORKSPACE_ID),
        koiApi.listMessages(id, KOI_WORKSPACE_ID, { limit: 200 }),
      ]);
      if (!mapConversation(conversation)) throw new Error("malformed");
      setMessages(mapMessages(page.items));
      loadedFor.current = id;
      setStatus("ready");
    } catch (err) {
      setStatus(err?.status === 404 || err?.status === 400 ? "missing" : "error");
    }
  }, []);

  useEffect(() => {
    setSendError(null);
    if (!routeConversationId) {
      setConversationId(null);
      setMessages([]);
      loadedFor.current = null;
      setStatus(isWorkspaceConfigured ? "new" : "unconfigured");
      return;
    }
    setConversationId(routeConversationId);
    if (loadedFor.current === routeConversationId) return;
    load(routeConversationId);
  }, [routeConversationId, load]);

  const send = useCallback(
    async (text) => {
      const content = typeof text === "string" ? text.trim() : "";
      if (!content || sendingRef.current || !isWorkspaceConfigured) return null;
      sendingRef.current = true;
      setSending(true);
      setSendError(null);
      try {
        const turn = mapTurn(await koiApi.submitIntakeTurn(KOI_WORKSPACE_ID, conversationId, content));
        loadedFor.current = turn.conversation.id;
        setConversationId(turn.conversation.id);
        setMessages((current) => [...current, ...turn.messages]);
        setStatus("ready");
        return turn;
      } catch (err) {
        setSendError(describeTurnFailure(err));
        return null;
      } finally {
        sendingRef.current = false;
        setSending(false);
      }
    },
    [conversationId],
  );

  return { conversationId, messages, status, sending, sendError, send, reload: () => (conversationId ? load(conversationId) : undefined) };
}
