import axios from "axios";
import { canRefreshAccessToken, clearAccessToken, getAccessToken, refreshAccessToken } from "./auth/accessToken";
import { AUTH_REASON, authMessage, getAuthState, isSessionEnded, isTokenRequired, markSessionEnded, reasonForUnauthorized } from "./auth/authSession";

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
  workspaces: "/workspaces",
  accountSession: "/auth/session",
  accountRegister: "/auth/register",
  conversations: "/conversations",
  conversation: (id) => `/conversations/${id}`,
  conversationIntake: "/conversations/intake",
  messages: (conversationId) => `/conversations/${conversationId}/messages`,
  properties: "/properties",
  property: (id) => `/properties/${id}`,
  units: "/units",
  unit: (id) => `/units/${id}`,
  guests: "/guests",
  guest: (id) => `/guests/${id}`,
  stays: "/stays",
  stay: (id) => `/stays/${id}`,
  signals: "/signals",
  signal: (id) => `/signals/${id}`,
  signalContext: (id) => `/signals/${id}/context`,
  intelligenceAnalyze: (signalId) => `/intelligence/analyze/${signalId}`,
  intelligenceAnalysisStatus: (signalId) => `/intelligence/analysis-status/${signalId}`,
  decisions: "/decisions",
  decisionPropose: (intelligenceId) => `/decisions/propose/${intelligenceId}`,
  decisionApprove: (id) => `/decisions/${id}/approve`,
  decisionReject: (id) => `/decisions/${id}/reject`,
  actions: "/actions",
  actionPropose: (decisionId) => `/actions/propose/${decisionId}`,
  actionApprove: (id) => `/actions/${id}/approve`,
  actionReject: (id) => `/actions/${id}/reject`,
  outcomes: "/outcomes",
  outcomeRecord: (actionId) => `/outcomes/record/${actionId}`,
  dashboardSignals: "/dashboard/signals",
  dashboardSignal: (id) => `/dashboard/signals/${id}`,
  prompts: "/prompts",
  intelligence: "/intelligence",
  learning: "/learning",
};

/**
 * Normalised error surfaced to the React layer. `status` is 0 for
 * network/timeout failures (backend unreachable).
 */
export class ApiError extends Error {
  constructor(message, status = 0, code = undefined, rule = undefined) {
    super(message || "Unexpected API error");
    this.name = "ApiError";
    this.status = status;
    // The backend's machine-readable reason (e.g. TOKEN_EXPIRED), when it sent one.
    this.code = code;
    // Phase 43D: the backend's stable sub-reason (details.rule, e.g. which admissibility rule rejected an analysis), when it sent one. Like `code` it is for
    // CODE to branch on (the presentation mapping) - never text to show.
    this.rule = rule;
  }
}

/** 401: no valid credential. 403: authenticated, but not permitted / not provisioned. */
export const isAuthenticationError = (error) => error instanceof ApiError && error.status === 401;
export const isAuthorizationError = (error) => error instanceof ApiError && error.status === 403;

/** Local, network-free failure: the session already ended (or is known to be missing), so an authenticated request is not sent at all. */
const SESSION_ENDED = "AUTH_SESSION_ENDED";
const sessionEndedError = () => Object.assign(new Error("Session ended"), { code: SESSION_ENDED });

// Phase 45B.2: plain-language wording for authentication/identity failures. The server's own message and code are kept on the ApiError
// (`code`) for CODE to branch on; they are not what a person reads.
const IDENTITY_MESSAGES = Object.freeze({
  IDENTITY_NOT_REGISTERED: "Your account doesn't have access to this yet. Please contact your administrator.",
  USER_DISABLED: "This account is not active. Please contact your administrator.",
});

function toApiError(error) {
  if (error?.code === SESSION_ENDED) {
    const { reason } = getAuthState();
    return new ApiError(authMessage(reason ?? AUTH_REASON.MISSING), 401, SESSION_ENDED);
  }
  if (error?.response) {
    const { status, data } = error.response;
    const code = data?.details?.code;
    if (status === 401) return new ApiError(authMessage(reasonForUnauthorized(code)), 401, code, data?.details?.rule);
    if (status === 403 && Object.prototype.hasOwnProperty.call(IDENTITY_MESSAGES, code)) return new ApiError(IDENTITY_MESSAGES[code], 403, code);
    return new ApiError(data?.message || `Request failed (${status})`, status, data?.details?.code, data?.details?.rule);
  }
  // Phase 43D: client-side codes so a timeout and an unreachable backend can be told apart without reading the message.
  if (error?.code === "ECONNABORTED") {
    return new ApiError("The EOI backend took too long to respond.", 0, "CLIENT_TIMEOUT");
  }
  return new ApiError("Cannot reach the EOI backend.", 0, "CLIENT_NETWORK");
}

/**
 * Authentication. A request opts in with `authenticated: true` (see `scoped`/the
 * Decision reads); only those requests carry `Authorization: Bearer <token>`, and
 * only when a token exists - never an empty header. Nothing else about the caller
 * is sent: no role, permission, user-id or knowledge-level header, ever. The
 * backend decides all of that from the verified token and its own records.
 *
 * A 401 on an authenticated request means the token is missing, invalid or
 * expired: it is forgotten (not retried, not replaced, no fallback) and the
 * ApiError propagates so the UI can show a controlled "authentication required".
 */
api.interceptors.request.use(async (config) => {
  if (config.authenticated) {
    // Phase 45B.2: once the session has ended (expired, rejected, signed out, sign-in screen up) nothing authenticated is sent: the request
    // fails locally and at once, so a "Try again" cannot re-send the same unauthenticated request and logout really stops API calls.
    if (isSessionEnded()) return Promise.reject(sessionEndedError());
    let token = getAccessToken();
    // Phase 46 (unified EOI session): the short-lived access token ended but the person is still signed in - renew it ONCE through the refresh cookie
    // (single-flight, see oidcSession.js). Only when that fails does the session end.
    if (!token && isTokenRequired() && canRefreshAccessToken()) token = await refreshAccessToken();
    if (token) config.headers.set("Authorization", `Bearer ${token}`);
    else if (isTokenRequired()) {
      // Sign-in is configured and there is no usable token (it expired in memory): that is "sign in again", not "send it anyway".
      markSessionEnded(AUTH_REASON.EXPIRED);
      return Promise.reject(sessionEndedError());
    }
  }
  return config;
});

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const config = error?.config;
    if (error?.response?.status === 401 && config?.authenticated) {
      // Phase 46: one silent renewal and ONE retry of the same request (never a loop: the retried request is marked); if the session cannot be renewed it ends.
      if (canRefreshAccessToken() && !config._retried) {
        clearAccessToken();
        const token = await refreshAccessToken();
        if (token) {
          config._retried = true;
          return api.request(config);
        }
      }
      clearAccessToken();
      markSessionEnded(reasonForUnauthorized(error.response?.data?.details?.code));
    }
    return Promise.reject(error);
  },
);

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
  return request(api.get(koiEndpoints.conversations, { ...scoped(workspaceId, params), authenticated: true })).then(listOf);
}

export function getConversation(conversationId, workspaceId) {
  return request(
    api.get(koiEndpoints.conversation(conversationId), { ...scoped(workspaceId), authenticated: true }),
  ).then(itemOf);
}

export function createConversation(payload) {
  return request(api.post(koiEndpoints.conversations, payload, { authenticated: true })).then(itemOf);
}

export function updateConversation(conversationId, workspaceId, payload) {
  return request(
    api.patch(koiEndpoints.conversation(conversationId), payload, { ...scoped(workspaceId), authenticated: true }),
  ).then(itemOf);
}

export function deleteConversation(conversationId, workspaceId) {
  return request(
    api.delete(koiEndpoints.conversation(conversationId), { ...scoped(workspaceId), authenticated: true }),
  ).then(itemOf);
}

/* ------------------------------------------------------------------ *
 * Messages (nested under a conversation)
 * ------------------------------------------------------------------ */

export function listMessages(conversationId, workspaceId, params = {}) {
  return request(
    api.get(koiEndpoints.messages(conversationId), { ...scoped(workspaceId, params), authenticated: true }),
  ).then(listOf);
}

export function createMessage(conversationId, workspaceId, payload) {
  return request(
    api.post(koiEndpoints.messages(conversationId), payload, { ...scoped(workspaceId), authenticated: true }),
  ).then(itemOf);
}

/**
 * One operator turn of the conversational Signal intake (Phase 47): `POST /api/conversations/intake`. The server records a Signal from what the operator
 * described (or asks ONE clarifying question) and stores both messages. It never calls the AI service: generation is only `analyzeSignal`, on an explicit click.
 * Only the text, the (optional) conversation, the workspace SELECTOR and - when the operator chose it before describing the issue - the operational context SELECTION
 * ({ propertyId, guestId?, stayId? }) are sent: no role, user or permission, ever. The ids in `context` are only a selection: the server loads each record inside the verified
 * workspace and checks how they relate (guest -> property, stay -> property and guest) before anything is created.
 */
export function submitIntakeTurn(workspaceId, conversationId, content, context) {
  return request(
    api.post(
      koiEndpoints.conversationIntake,
      { workspaceId, ...(conversationId ? { conversationId } : {}), ...(context && context.propertyId ? { context } : {}), content },
      { authenticated: true },
    ),
  ).then(itemOf);
}

/* ------------------------------------------------------------------ *
 * Properties
 * ------------------------------------------------------------------ */

/**
 * What EOI knows about the SIGNED-IN person (Phase 45C): `GET /api/auth/session`. Read-only. 'member' (with their own workspaces and role in each),
 * 'needs_setup' (a new person; self-registration is on) or 'access_restricted' (an administrator must grant access). A shorter timeout than the default:
 * it gates the first screen.
 */
export function getAccountSession() {
  return request(api.get(koiEndpoints.accountSession, { authenticated: true, timeout: 8000 })).then(itemOf);
}

/** Sets up the signed-in person's OWN account: `POST /api/auth/register` with only the workspace name. The server decides everything else (identity, role). */
export function registerAccount(workspaceName) {
  return request(api.post(koiEndpoints.accountRegister, { workspaceName }, { authenticated: true, timeout: 15000 })).then(itemOf);
}

export function listProperties(workspaceId, params = {}) {
  return request(api.get(koiEndpoints.properties, { ...scoped(workspaceId, params), authenticated: true })).then(listOf);
}

export function getProperty(propertyId, workspaceId) {
  return request(api.get(koiEndpoints.property(propertyId), { ...scoped(workspaceId), authenticated: true })).then(itemOf);
}

export function createProperty(payload) {
  return request(api.post(koiEndpoints.properties, payload, { authenticated: true })).then(itemOf);
}

export function updateProperty(propertyId, workspaceId, payload) {
  return request(
    api.patch(koiEndpoints.property(propertyId), payload, { ...scoped(workspaceId), authenticated: true }),
  ).then(itemOf);
}

export function deleteProperty(propertyId, workspaceId) {
  return request(
    api.delete(koiEndpoints.property(propertyId), { ...scoped(workspaceId), authenticated: true }),
  ).then(itemOf);
}

/* ------------------------------------------------------------------ *
 * Units (scoped to a workspace through their Property)
 * ------------------------------------------------------------------ */

export function listUnits(workspaceId, params = {}) {
  return request(api.get(koiEndpoints.units, { ...scoped(workspaceId, params), authenticated: true })).then(listOf);
}

export function getUnit(unitId, workspaceId) {
  return request(api.get(koiEndpoints.unit(unitId), { ...scoped(workspaceId), authenticated: true })).then(itemOf);
}

export function createUnit(payload) {
  return request(api.post(koiEndpoints.units, payload, { authenticated: true })).then(itemOf);
}

export function updateUnit(unitId, workspaceId, payload) {
  return request(api.patch(koiEndpoints.unit(unitId), payload, { ...scoped(workspaceId), authenticated: true })).then(itemOf);
}

export function deleteUnit(unitId, workspaceId) {
  return request(api.delete(koiEndpoints.unit(unitId), { ...scoped(workspaceId), authenticated: true })).then(itemOf);
}

/* ------------------------------------------------------------------ *
 * Guests
 * ------------------------------------------------------------------ */

export function listGuests(workspaceId, params = {}) {
  return request(api.get(koiEndpoints.guests, { ...scoped(workspaceId, params), authenticated: true })).then(listOf);
}

export function getGuest(guestId, workspaceId) {
  return request(api.get(koiEndpoints.guest(guestId), { ...scoped(workspaceId), authenticated: true })).then(itemOf);
}

export function createGuest(payload) {
  return request(api.post(koiEndpoints.guests, payload, { authenticated: true })).then(itemOf);
}

export function updateGuest(guestId, workspaceId, payload) {
  return request(api.patch(koiEndpoints.guest(guestId), payload, { ...scoped(workspaceId), authenticated: true })).then(
    itemOf,
  );
}

export function deleteGuest(guestId, workspaceId) {
  return request(api.delete(koiEndpoints.guest(guestId), { ...scoped(workspaceId), authenticated: true })).then(itemOf);
}

/* ------------------------------------------------------------------ *
 * Stays (scoped to a workspace; reference Guest, Property, and Unit)
 * ------------------------------------------------------------------ */

export function listStays(workspaceId, params = {}) {
  return request(api.get(koiEndpoints.stays, { ...scoped(workspaceId, params), authenticated: true })).then(listOf);
}

export function getStay(stayId, workspaceId) {
  return request(api.get(koiEndpoints.stay(stayId), { ...scoped(workspaceId), authenticated: true })).then(itemOf);
}

export function createStay(payload) {
  return request(api.post(koiEndpoints.stays, payload, { authenticated: true })).then(itemOf);
}

export function updateStay(stayId, workspaceId, payload) {
  return request(api.patch(koiEndpoints.stay(stayId), payload, { ...scoped(workspaceId), authenticated: true })).then(itemOf);
}

export function deleteStay(stayId, workspaceId) {
  return request(api.delete(koiEndpoints.stay(stayId), { ...scoped(workspaceId), authenticated: true })).then(itemOf);
}

/* ------------------------------------------------------------------ *
 * Signals (scoped to a workspace; may reference Property, Unit, Guest, Stay)
 * ------------------------------------------------------------------ */

export function listSignals(workspaceId, params = {}) {
  return request(api.get(koiEndpoints.signals, { ...scoped(workspaceId, params), authenticated: true })).then(listOf);
}

export function getSignal(signalId, workspaceId) {
  return request(api.get(koiEndpoints.signal(signalId), { ...scoped(workspaceId), authenticated: true })).then(itemOf);
}

/* ------------------------------------------------------------------ *
 * Dashboard read model (GET only; stored Intelligence V1, never generates)
 * ------------------------------------------------------------------ */

export function getDashboardSignals(workspaceId, params = {}) {
  return request(api.get(koiEndpoints.dashboardSignals, { ...scoped(workspaceId, params), authenticated: true })).then(listOf);
}

export function getDashboardSignal(signalId, workspaceId) {
  return request(api.get(koiEndpoints.dashboardSignal(signalId), { ...scoped(workspaceId), authenticated: true })).then(itemOf);
}

/* Decision V1 - READ ONLY from the dashboard (no propose/approve/reject calls here). */
export function listDecisions(workspaceId, params = {}) {
  return request(api.get(koiEndpoints.decisions, { ...scoped(workspaceId, params), authenticated: true })).then(listOf);
}

/**
 * Decision V1 governance calls (Phase 48). Each only NAMES a stored record: the server derives everything else (workspace, who is acting, what is being decided,
 * timestamps, priority) and the browser sends no role, user, reviewer or workspace claim beyond the selector. Proposing takes NO body; a review takes only a note
 * (and, for a rejection, the human's alternative). None of them calls the AI and none carries out anything.
 */
export function proposeDecision(intelligenceId, workspaceId) {
  return request(api.post(koiEndpoints.decisionPropose(intelligenceId), undefined, { ...scoped(workspaceId), authenticated: true })).then(itemOf);
}

export function approveDecision(decisionId, workspaceId, body = {}) {
  return request(api.post(koiEndpoints.decisionApprove(decisionId), body, { ...scoped(workspaceId), authenticated: true })).then(itemOf);
}

export function rejectDecision(decisionId, workspaceId, body = {}) {
  return request(api.post(koiEndpoints.decisionReject(decisionId), body, { ...scoped(workspaceId), authenticated: true })).then(itemOf);
}

/**
 * Action V1 proposal calls (Phase 49). An Action here is a PROPOSAL derived by the server from one APPROVED Decision: the browser names the Decision (a route value) and
 * sends NO body - the server derives the type, the risk, the urgency, the workspace, who is acting and the provenance. Reviewing takes only a note. None of these calls
 * the AI, and none carries anything out: nothing is sent, dispatched, booked or changed outside the Action record.
 */
export function listActions(workspaceId, params = {}) {
  return request(api.get(koiEndpoints.actions, { ...scoped(workspaceId, params), authenticated: true })).then(listOf);
}

export function proposeAction(decisionId, workspaceId) {
  return request(api.post(koiEndpoints.actionPropose(decisionId), undefined, { ...scoped(workspaceId), authenticated: true })).then(itemOf);
}

export function approveAction(actionId, workspaceId, body = {}) {
  return request(api.post(koiEndpoints.actionApprove(actionId), body, { ...scoped(workspaceId), authenticated: true })).then(itemOf);
}

export function rejectAction(actionId, workspaceId, body = {}) {
  return request(api.post(koiEndpoints.actionReject(actionId), body, { ...scoped(workspaceId), authenticated: true })).then(itemOf);
}

/**
 * Outcome V1 calls (Phase 50). An Outcome is what a PERSON reports actually happened after an APPROVED Action. The browser names the Action (a route value) and sends the
 * person's own words ({ status, result: { summary } }); the server derives the workspace, who is recording and the whole chain (decision, intelligence, signal) from the stored
 * Action. Nothing here calls the AI, and recording an Outcome carries nothing out.
 */
export function listOutcomes(workspaceId, params = {}) {
  return request(api.get(koiEndpoints.outcomes, { ...scoped(workspaceId, params), authenticated: true })).then(listOf);
}

export function recordOutcome(actionId, workspaceId, body) {
  return request(api.post(koiEndpoints.outcomeRecord(actionId), body, { ...scoped(workspaceId), authenticated: true })).then(itemOf);
}

export function createSignal(payload) {
  return request(api.post(koiEndpoints.signals, payload, { authenticated: true })).then(itemOf);
}

export function updateSignal(signalId, workspaceId, payload) {
  return request(api.patch(koiEndpoints.signal(signalId), payload, { ...scoped(workspaceId), authenticated: true })).then(
    itemOf,
  );
}

export function deleteSignal(signalId, workspaceId) {
  return request(api.delete(koiEndpoints.signal(signalId), { ...scoped(workspaceId), authenticated: true })).then(itemOf);
}

/**
 * Deterministic operational context for a Signal — its Guest/Stay/Property/
 * Unit facts plus relevant historical Signals. Assembled fresh on every
 * request from existing records; never a separate stored resource.
 */
export function getSignalContext(signalId, workspaceId) {
  return request(
    api.get(koiEndpoints.signalContext(signalId), { ...scoped(workspaceId), authenticated: true }),
  ).then(itemOf);
}

/**
 * READS the stored Intelligence records of one Signal: `GET /api/intelligence?signalId=...` (workspace-scoped, knowledge-level filtered by the server). This never
 * generates anything - it is how a page learns whether an analysis already exists WITHOUT calling the generation endpoint. The response must be a list: a body that
 * is not one is an ERROR (never silently "empty", which would hide a stored analysis behind a Generate button).
 */
export async function listSignalIntelligence(signalId, workspaceId) {
  const response = await request(
    api.get(koiEndpoints.intelligence, { ...scoped(workspaceId, { signalId, limit: 50 }), authenticated: true }),
  );
  const items = response?.data?.data;
  if (!Array.isArray(items)) throw new ApiError("The server returned an unexpected response.", 0, "MALFORMED_RESPONSE");
  return items;
}

/**
 * Generates (or returns the stored) Intelligence V1 analysis of a Signal: `POST /api/intelligence/analyze/:signalId`,
 * the ONE generation endpoint. It calls an LLM on the backend - never poll or call it automatically; only invoke it
 * from an explicit user action. A longer timeout than the default is used since generation is slower than a normal
 * CRUD request. The response is the same public representation as `GET /api/intelligence/:id`.
 * Requires an authenticated actor with intelligence:generate (the server decides; the client sends no role).
 */
export function analyzeSignal(signalId, workspaceId) {
  return request(
    api.post(koiEndpoints.intelligenceAnalyze(signalId), undefined, {
      ...scoped(workspaceId),
      timeout: 30000,
      authenticated: true,
    }),
  ).then(itemOf);
}

/**
 * Workstream 5B - the explicit request to analyse a report, as the page makes it: `POST /api/intelligence/analyze/:signalId` (the SAME endpoint as analyzeSignal), but with
 * the two answers the backend now distinguishes (Workstream 5A):
 *   { kind: "analysis" }                  HTTP 201 / 200: the analysis exists (just made, or already stored). It is NOT rendered from this response: the page READS the stored
 *                                         analysis through the existing read, so there is one path to an assessment on screen.
 *   { kind: "in_progress", attempt }      HTTP 202: the analysis is still running and carries on; `attempt` is its state ({ status: "in_progress", attemptId, startedAt }).
 * Errors are unchanged (ApiError). Like analyzeSignal it must be called from an explicit user action only.
 */
export async function startAnalysis(signalId, workspaceId) {
  const response = await request(api.post(koiEndpoints.intelligenceAnalyze(signalId), undefined, { ...scoped(workspaceId), timeout: 30000, authenticated: true }));
  const data = itemOf(response);
  if (response?.status === 202) {
    if (!data || data.status !== "in_progress") throw new ApiError("The server returned an unexpected response.", 0, "MALFORMED_RESPONSE");
    return { kind: "in_progress", attempt: data };
  }
  return { kind: "analysis" };
}

/**
 * Workstream 5B - READS the state of one report's analysis: `GET /api/intelligence/analysis-status/:signalId` (workspace-scoped, read-only). It starts nothing and returns no
 * analysis content: { status: "not_started" | "in_progress" | "succeeded" | "failed", ... } (see features/assistant/analysisAttemptMapping.js).
 */
export function getAnalysisStatus(signalId, workspaceId) {
  return request(api.get(koiEndpoints.intelligenceAnalysisStatus(signalId), { ...scoped(workspaceId), authenticated: true })).then(itemOf);
}

/* ------------------------------------------------------------------ *
 * Learning (Phase 7D backend, Phase 7E frontend consumption) — a
 * read-only, workspace-scoped operational report. There is no create/
 * update/delete counterpart; this is the only Learning request this
 * module ever makes.
 * ------------------------------------------------------------------ */

export function getLearningReport(workspaceId, params = {}) {
  return request(api.get(koiEndpoints.learning, { ...scoped(workspaceId, params), authenticated: true })).then(itemOf);
}

export default api;
