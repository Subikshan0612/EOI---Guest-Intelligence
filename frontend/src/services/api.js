import axios from "axios";

/**
 * Axios client for the future KOI backend.
 *
 * Phase 1 uses mock data. Do not hardcode a production URL.
 * The backend origin is supplied through VITE_API_BASE_URL.
 *
 * Future phases should keep this client provider-agnostic.
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
  prompts: "/prompts",
  intelligence: "/intelligence",
};

export default api;
