import axios from "axios";

/**
 * Axios client for the KOI backend.
 *
 * The backend origin is supplied through VITE_API_BASE_URL (e.g.
 * http://localhost:5000/api for local development). This module is the ONLY
 * place axios is used — callers get plain data or an ApiError, never an axios
 * response object.
 *
 * Intelligence responses belong to the KOI contract, not a specific LLM vendor.
 */
const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || "",
  headers: {
    "Content-Type": "application/json",
  },
  timeout: 15000,
});

export const koiEndpoints = {
  conversations: "/conversations",
  conversation: (id) => `/conversations/${id}`,
  messages: (conversationId) => `/conversations/${conversationId}/messages`,
  prompts: "/prompts",
  intelligence: "/intelligence",
};

/**
 * Normalised error surfaced to the React layer. `status` is 0 for
 * network/timeout failures (backend unreachable).
 */
export class ApiError extends Error {
  constructor(message, status = 0) {
    super(message || "Unexpected API error");
    this.name = "ApiError";
    this.status = status;
  }
}

function toApiError(error) {
  if (error?.response) {
    const { status, data } = error.response;
    return new ApiError(data?.message || `Request failed (${status})`, status);
  }
  if (error?.code === "ECONNABORTED") {
    return new ApiError("The KOI backend took too long to respond.", 0);
  }
  return new ApiError("Cannot reach the KOI backend.", 0);
}

async function request(promise) {
  try {
    return await promise;
  } catch (error) {
    throw toApiError(error);
  }
}

/** Unwrap `{ success, data }` → data */
function itemOf(response) {
  return response?.data?.data ?? null;
}

/** Unwrap `{ success, data: [], pagination }` → { items, pagination } */
function listOf(response) {
  return {
    items: Array.isArray(response?.data?.data) ? response.data.data : [],
    pagination: response?.data?.pagination ?? null,
  };
}

function scoped(workspaceId, params = {}) {
  return { params: { ...params, ...(workspaceId ? { workspaceId } : {}) } };
}

/* ------------------------------------------------------------------ *
 * Conversations
 * ------------------------------------------------------------------ */

export function listConversations(workspaceId, params = {}) {
  return request(api.get(koiEndpoints.conversations, scoped(workspaceId, params))).then(listOf);
}

export function getConversation(conversationId, workspaceId) {
  return request(
    api.get(koiEndpoints.conversation(conversationId), scoped(workspaceId)),
  ).then(itemOf);
}

export function createConversation(payload) {
  return request(api.post(koiEndpoints.conversations, payload)).then(itemOf);
}

export function updateConversation(conversationId, workspaceId, payload) {
  return request(
    api.patch(koiEndpoints.conversation(conversationId), payload, scoped(workspaceId)),
  ).then(itemOf);
}

export function deleteConversation(conversationId, workspaceId) {
  return request(
    api.delete(koiEndpoints.conversation(conversationId), scoped(workspaceId)),
  ).then(itemOf);
}

/* ------------------------------------------------------------------ *
 * Messages (nested under a conversation)
 * ------------------------------------------------------------------ */

export function listMessages(conversationId, workspaceId, params = {}) {
  return request(
    api.get(koiEndpoints.messages(conversationId), scoped(workspaceId, params)),
  ).then(listOf);
}

export function createMessage(conversationId, workspaceId, payload) {
  return request(
    api.post(koiEndpoints.messages(conversationId), payload, scoped(workspaceId)),
  ).then(itemOf);
}

export default api;
