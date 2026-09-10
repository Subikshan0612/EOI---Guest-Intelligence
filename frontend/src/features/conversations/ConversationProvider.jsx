import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { conversations as seedConversations } from "../../data/mockData";
import { createLocalId } from "../chat/conversationSession";
import { KOI_WORKSPACE_ID, isWorkspaceConfigured } from "../../config/workspace";
import * as koiApi from "../../services/api";
import { ConversationContext } from "./conversationContext";
import { loadConversationStore, persistConversationStore } from "./conversationStore";
import {
  buildOptimisticMessage,
  mapConversationFromApi,
  mapMessageFromApi,
  toMessageApiPayload,
} from "./conversationMapping";
import { generateConversationTitle } from "./titleGenerator";

/**
 * Source of truth for conversations.
 *
 * BACKEND mode (VITE_KOI_WORKSPACE_ID set): the REST API is authoritative.
 * Conversations are loaded from GET /conversations on mount, messages are
 * hydrated on demand, and every mutation is persisted through the API before
 * (optimistically) touching local state. localStorage is NOT used.
 *
 * LOCAL mode (no workspace id): the previous Phase 1 behaviour — in-memory
 * state seeded from mock data and mirrored to localStorage. No network calls.
 */
function nowIso() {
  return new Date().toISOString();
}

function sortByRecency(list) {
  return [...list].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

function withNewMessage(conversation, message) {
  return {
    ...conversation,
    updatedAt: nowIso(),
    messages: [...(conversation.messages ?? []), message],
  };
}

function replaceMessage(conversation, tempId, nextMessage) {
  return {
    ...conversation,
    messages: (conversation.messages ?? []).map((m) => (m.id === tempId ? nextMessage : m)),
  };
}

function dropMessage(conversation, messageId) {
  return {
    ...conversation,
    messages: (conversation.messages ?? []).filter((m) => m.id !== messageId),
  };
}

export function ConversationProvider({ children }) {
  const backend = isWorkspaceConfigured;

  const [conversations, setConversations] = useState(() =>
    backend ? [] : loadConversationStore(seedConversations),
  );
  const [listStatus, setListStatus] = useState(backend ? "loading" : "ready");
  const [listError, setListError] = useState(null);

  // Always-current snapshot for callbacks that must not depend on `conversations`.
  const conversationsRef = useRef(conversations);
  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  const commit = useCallback(
    (updater) => {
      setConversations((current) => {
        const next = typeof updater === "function" ? updater(current) : updater;
        if (!backend) persistConversationStore(next);
        return next;
      });
    },
    [backend],
  );

  const reload = useCallback(async () => {
    if (!backend) {
      setListStatus("ready");
      return;
    }
    setListStatus("loading");
    setListError(null);
    try {
      const { items } = await koiApi.listConversations(KOI_WORKSPACE_ID, { limit: 100 });
      setConversations(sortByRecency(items.map(mapConversationFromApi)));
      setListStatus("ready");
    } catch (error) {
      setListError(error.message || "Could not load conversations.");
      setListStatus("error");
    }
  }, [backend]);

  useEffect(() => {
    reload();
  }, [reload]);

  const getById = useCallback(
    (id) => conversations.find((conversation) => conversation.id === id) ?? null,
    [conversations],
  );

  /**
   * Ensure a conversation and its messages are in state.
   * Returns { status: 'ready' | 'missing' | 'error', conversation }.
   */
  const loadConversation = useCallback(
    async (id) => {
      if (!id) return { status: "missing", conversation: null };
      const existing = conversationsRef.current.find((c) => c.id === id) ?? null;

      if (!backend) {
        return existing
          ? { status: "ready", conversation: existing }
          : { status: "missing", conversation: null };
      }

      if (existing?.messagesLoaded) {
        return { status: "ready", conversation: existing };
      }

      try {
        const detailPromise = existing
          ? Promise.resolve(null)
          : koiApi.getConversation(id, KOI_WORKSPACE_ID);
        const [detail, { items }] = await Promise.all([
          detailPromise,
          koiApi.listMessages(id, KOI_WORKSPACE_ID, { limit: 200 }),
        ]);

        const base = existing ?? mapConversationFromApi(detail);
        if (!base) return { status: "missing", conversation: null };

        const merged = {
          ...base,
          messages: items.map(mapMessageFromApi),
          messagesLoaded: true,
        };

        commit((current) => {
          const has = current.some((c) => c.id === id);
          const next = has
            ? current.map((c) => (c.id === id ? merged : c))
            : [merged, ...current];
          return sortByRecency(next);
        });

        return { status: "ready", conversation: merged };
      } catch (error) {
        if (error.status === 404 || error.status === 400) {
          return { status: "missing", conversation: null };
        }
        return { status: "error", conversation: null, error: error.message };
      }
    },
    [backend, commit],
  );

  /** Create a conversation from the first user message and return it (no messages yet). */
  const createConversation = useCallback(
    async (firstContent = "") => {
      const title = generateConversationTitle(firstContent);

      if (!backend) {
        const createdAt = nowIso();
        const conversation = {
          id: createLocalId("convo"),
          title,
          createdAt,
          updatedAt: createdAt,
          status: "open",
          origin: "user",
          summary: firstContent.replace(/\s+/g, " ").trim().slice(0, 140),
          guestId: null,
          stayId: null,
          messages: [],
          messagesLoaded: true,
        };
        commit((current) => [conversation, ...current]);
        return conversation;
      }

      const created = await koiApi.createConversation({
        workspaceId: KOI_WORKSPACE_ID,
        title,
      });
      const conversation = { ...mapConversationFromApi(created), messagesLoaded: true };
      commit((current) => [conversation, ...current.filter((c) => c.id !== conversation.id)]);
      return conversation;
    },
    [backend, commit],
  );

  /**
   * Persist a message and append it to state.
   * `input` = { role, type, content, payload? }. Optimistic: the message shows
   * immediately, is reconciled with the saved doc, and is rolled back on failure.
   */
  const addMessage = useCallback(
    async (conversationId, input) => {
      const tempId = createLocalId("msg");
      const optimistic = buildOptimisticMessage(input, tempId);
      commit((current) =>
        sortByRecency(
          current.map((c) =>
            c.id === conversationId ? withNewMessage(c, optimistic) : c,
          ),
        ),
      );

      if (!backend) {
        const finalMessage = { ...optimistic, pending: false };
        commit((current) =>
          current.map((c) =>
            c.id === conversationId ? replaceMessage(c, tempId, finalMessage) : c,
          ),
        );
        return finalMessage;
      }

      try {
        const saved = await koiApi.createMessage(
          conversationId,
          KOI_WORKSPACE_ID,
          toMessageApiPayload(input),
        );
        const mapped = mapMessageFromApi(saved);
        commit((current) =>
          current.map((c) =>
            c.id === conversationId ? replaceMessage(c, tempId, mapped) : c,
          ),
        );
        return mapped;
      } catch (error) {
        commit((current) =>
          current.map((c) =>
            c.id === conversationId ? dropMessage(c, tempId) : c,
          ),
        );
        throw error;
      }
    },
    [backend, commit],
  );

  const renameConversation = useCallback(
    async (id, nextTitle) => {
      const title = (nextTitle ?? "").replace(/\s+/g, " ").trim();
      if (!title) return false;

      const previous = conversationsRef.current.find((c) => c.id === id)?.title ?? null;
      commit((current) => current.map((c) => (c.id === id ? { ...c, title } : c)));

      if (!backend) return true;

      try {
        await koiApi.updateConversation(id, KOI_WORKSPACE_ID, { title });
        return true;
      } catch (error) {
        commit((current) =>
          current.map((c) =>
            c.id === id && previous !== null ? { ...c, title: previous } : c,
          ),
        );
        return false;
      }
    },
    [backend, commit],
  );

  const deleteConversation = useCallback(
    async (id) => {
      const snapshot = conversationsRef.current;
      commit((current) => current.filter((c) => c.id !== id));

      if (!backend) return true;

      try {
        await koiApi.deleteConversation(id, KOI_WORKSPACE_ID);
        return true;
      } catch (error) {
        commit(() => snapshot);
        return false;
      }
    },
    [backend, commit],
  );

  const value = useMemo(
    () => ({
      conversations,
      listStatus,
      listError,
      isBackend: backend,
      reload,
      getById,
      loadConversation,
      createConversation,
      addMessage,
      renameConversation,
      deleteConversation,
    }),
    [
      conversations,
      listStatus,
      listError,
      backend,
      reload,
      getById,
      loadConversation,
      createConversation,
      addMessage,
      renameConversation,
      deleteConversation,
    ],
  );

  return <ConversationContext.Provider value={value}>{children}</ConversationContext.Provider>;
}
