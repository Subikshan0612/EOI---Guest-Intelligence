/**
 * Runtime hardening configuration (Phase 21): rate limits, HTTP timeouts, body limits, upstream timeout, import limits.
 *
 * Every value is configurable through an environment variable with a SAFE DEFAULT. A missing, non-numeric, non-positive or
 * out-of-range value falls back to the default (it never disables a limit by accident). Read on demand, not cached at import,
 * so a test harness can start servers with different values.
 *
 * Rate limiting is ON by default. `KOI_RATE_LIMIT_ENABLED=false` switches it off and exists only for the development/test
 * harnesses that legitimately fire thousands of requests from one address; the Phase 21 suite proves the limiter with it ON.
 */
function int(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

export function getRateLimitConfig() {
  return {
    enabled: (process.env.KOI_RATE_LIMIT_ENABLED ?? "true").trim().toLowerCase() !== "false",
    windowMs: int("KOI_RATE_LIMIT_WINDOW_MS", 60_000, { min: 100, max: 3_600_000 }),
    // Requests with NO Authorization header (public routes, unauthenticated probing), per client address.
    anonMax: int("KOI_RATE_LIMIT_ANON_MAX", 60),
    // Every request, per client address (a shared address such as an office NAT legitimately hosts many users).
    ipMax: int("KOI_RATE_LIMIT_IP_MAX", 900),
    // Every authenticated request, per verified identity.
    userMax: int("KOI_RATE_LIMIT_USER_MAX", 300),
    // Authenticated writes (POST/PATCH/DELETE), per verified identity.
    writeMax: int("KOI_RATE_LIMIT_WRITE_MAX", 60),
    // AI-reaching routes (generation, retrieval, embeddings): per verified identity, and per verified workspace.
    aiMax: int("KOI_RATE_LIMIT_AI_MAX", 10),
    aiWorkspaceMax: int("KOI_RATE_LIMIT_AI_WORKSPACE_MAX", 30),
    // Operational imports, per verified identity.
    importMax: int("KOI_RATE_LIMIT_IMPORT_MAX", 5),
    // Memory guard for the process-local store.
    maxKeys: int("KOI_RATE_LIMIT_MAX_KEYS", 200_000, { min: 100 }),
  };
}

/**
 * Authentication-endpoint limits (Phase 46): sign-in, sign-up, verification and password reset. Keyed by client address AND, where the body names one, by a hash
 * of the normalised email - so a distributed guess at ONE account is slowed as much as one address hammering many. They use their own, longer window (default
 * 15 minutes) because the general 1-minute window is far too short to slow password guessing. `KOI_RATE_LIMIT_ENABLED=false` switches them off with the rest.
 */
export function getAuthRateLimitConfig() {
  return {
    windowMs: int("KOI_AUTH_RATE_WINDOW_MS", 15 * 60_000, { min: 100, max: 24 * 3_600_000 }),
    signinPerEmail: int("KOI_AUTH_SIGNIN_EMAIL_MAX", 8),
    signinPerIp: int("KOI_AUTH_SIGNIN_IP_MAX", 40),
    signupPerIp: int("KOI_AUTH_SIGNUP_IP_MAX", 10),
    resetPerEmail: int("KOI_AUTH_RESET_EMAIL_MAX", 5),
    resetPerIp: int("KOI_AUTH_RESET_IP_MAX", 20),
    verifyPerIp: int("KOI_AUTH_VERIFY_IP_MAX", 30),
    refreshPerIp: int("KOI_AUTH_REFRESH_IP_MAX", 120),
  };
}

/** `trust proxy` is OFF unless explicitly set to a hop count (a spoofable X-Forwarded-For must not choose the rate-limit key). */
export function getTrustProxy() {
  const raw = process.env.KOI_TRUST_PROXY;
  if (raw === undefined || raw === "") return false;
  const hops = Number(raw);
  return Number.isInteger(hops) && hops >= 1 && hops <= 10 ? hops : false;
}

export function getHttpTimeouts() {
  return {
    // Time to receive the complete request HEADERS (slow-loris protection).
    headersTimeoutMs: int("KOI_HEADERS_TIMEOUT_MS", 15_000, { min: 100, max: 120_000 }),
    // Time to receive the complete request (headers + body). Uploads are <= 10 MB, so 60 s is generous.
    requestTimeoutMs: int("KOI_REQUEST_TIMEOUT_MS", 60_000, { min: 100, max: 600_000 }),
    // Idle socket timeout. Longer than the slowest legitimate response (an AI generation makes up to two upstream calls).
    socketTimeoutMs: int("KOI_SOCKET_TIMEOUT_MS", 120_000, { min: 1000, max: 900_000 }),
    keepAliveTimeoutMs: int("KOI_KEEPALIVE_TIMEOUT_MS", 5_000, { min: 100, max: 120_000 }),
    // How often Node enforces the header/request timeouts (Node's own default is 30 s).
    checkIntervalMs: int("KOI_TIMEOUT_CHECK_INTERVAL_MS", 5_000, { min: 50, max: 60_000 }),
  };
}

/** Outbound (Python AI service / OpenAI) call timeout. The historical value, 20 s, is the default. */
export function getAiTimeoutMs() {
  return int("KOI_AI_TIMEOUT_MS", 20_000, { min: 50, max: 120_000 });
}

/**
 * Node -> AI-service timeout for the ANALYSIS call (Phase 34A-B; made independent of the retrieval timeout by Workstream 5C). The timeout chain is deliberately ordered:
 *   Gemini analysis deadline (ai-service LLM_ANALYSIS_TIMEOUT_MS, at most AI_ANALYSIS_DEADLINE_CEILING_MS)  <  Node -> ai-service analysis call (this value)
 * so a provider that is too slow is reported by the AI service as a PROVIDER TIMEOUT (a classified 504), rather than Node cutting the connection at the same instant
 * and losing the distinction. Default = the analysis ceiling + a 5 s margin (65 s): enough for ANY permitted deadline plus a 503 retry (first attempt <= 3 s + 1 s delay)
 * with headroom, whatever value the AI service is configured with (Node does not read the AI service's configuration). It does NOT follow KOI_AI_TIMEOUT_MS any more:
 * that setting now bounds only the calls that must stay short (each retrieval / embedding call). KOI_AI_ANALYSIS_TIMEOUT_MS exists so a test (or an operator) can set it.
 * This is a backstop, not the person's wait: the browser-facing wait is the response window (getAnalysisResponseWindowMs), after which the same attempt keeps running.
 */
export const ANALYSIS_TIMEOUT_MARGIN_MS = 5_000;
export function getAiAnalysisTimeoutMs() {
  return int("KOI_AI_ANALYSIS_TIMEOUT_MS", AI_ANALYSIS_DEADLINE_CEILING_MS + ANALYSIS_TIMEOUT_MARGIN_MS, { min: 50, max: 120_000 });
}

/**
 * Ceiling for the AI service's own Gemini SDK timeout (its REQUEST_TIMEOUT_MS). This is the CROSS-SERVICE TIMEOUT CONTRACT:
 *   - the AI service validates its own value at startup and again before each analysis call (ai-service/app/provider_policy.py,
 *     PROVIDER_TIMEOUT_CEILING_MS) and refuses to run a Gemini call with a larger one;
 *   - Node validates its OWN budget at startup: on the real `gemini` route the analysis timeout must exceed this ceiling, so the AI
 *     service's provider timeout (classified PROVIDER_TIMEOUT) always fires before Node gives up on the call.
 * Node does not read or own the AI service's configuration; both sides assert against this one documented number. The two copies
 * cannot be shared across processes, so the Phase 35 suite asserts they are equal.
 */
export const AI_PROVIDER_TIMEOUT_CEILING_MS = 20_000;

/**
 * Workstream 5C - the SECOND timeout contract with the AI service: the ceiling for its Gemini ANALYSIS deadline (LLM_ANALYSIS_TIMEOUT_MS), which is separate from the
 * 20 s ceiling above (REQUEST_TIMEOUT_MS: embedding and retrieval-side calls, which stay short and independent). The AI service validates its own value against its copy
 * (provider_policy.ANALYSIS_DEADLINE_CEILING_MS); Node's analysis wait must exceed this number on the real `gemini` route (startupChecks). 60 s is the largest deadline
 * Workstream 5C considered: it is what MAY be configured, not the chosen value. A test asserts the two copies are equal.
 */
export const AI_ANALYSIS_DEADLINE_CEILING_MS = 60_000;

/**
 * Most Python retrieval calls ONE analysis request could make: retrieval pages through at most MAX_ELIGIBLE_CANDIDATES (2000) eligible
 * chunks, CANDIDATE_PAGE_SIZE (200) per call (knowledgeRetrievalService.js). Kept here as a plain number so this module stays
 * import-free; the Phase 35 suite asserts it equals ceil(MAX_ELIGIBLE_CANDIDATES / CANDIDATE_PAGE_SIZE).
 */
export const RETRIEVAL_MAX_PAGES = 10;

/**
 * THE INTERNAL TIME BUDGET OF ONE ANALYSIS REQUEST (Phase 35.1). It is ENFORCED, not reported:
 *
 *   deadline        = socket timeout - margin         the enclosing request deadline (margin = min(10 s, socket/10): headroom for the
 *                                                     database reads before retrieval, persistence after the model call, and the response)
 *   analysis        = getAiAnalysisTimeoutMs()        the one model call; ALWAYS reserved in full
 *   retrieval       = deadline - analysis             all retrieval calls TOGETHER, measured from the start of the request
 *
 * Retrieval may make up to RETRIEVAL_MAX_PAGES sequential AI-service calls. Each call is given min(base timeout, time left in the
 * retrieval budget); when the budget is gone retrieval FAILS CLOSED (no analysis is attempted, nothing is persisted) - exactly the
 * existing policy for a corpus that cannot be fully scored. Therefore, by construction:
 *
 *   retrieval time + analysis time  <=  deadline  <  socket timeout        (database time excluded: no timer here bounds it)
 *
 * `requestTimeoutMs`/`headersTimeoutMs` only bound how long the CLIENT takes to SEND the request, so they are not part of this budget.
 * At the defaults: deadline 110 s, analysis 25 s, retrieval budget 85 s (a corpus needing more is refused rather than half-scored).
 */
export function getAnalysisTimeBudget() {
  const baseMs = getAiTimeoutMs();
  const analysisMs = getAiAnalysisTimeoutMs();
  const socketMs = getHttpTimeouts().socketTimeoutMs;
  const marginMs = Math.min(10_000, Math.ceil(socketMs / 10));
  const deadlineMs = socketMs - marginMs;
  const retrievalBudgetMs = deadlineMs - analysisMs;
  // The most internal work one request can do: retrieval is capped by its budget (it can never use more than that, however many
  // pages there are), then the analysis call. It is <= deadlineMs whenever retrievalBudgetMs >= 0.
  const guaranteedMaxMs = Math.min(RETRIEVAL_MAX_PAGES * baseMs, Math.max(0, retrievalBudgetMs)) + analysisMs;
  return { baseMs, analysisMs, socketMs, marginMs, deadlineMs, retrievalBudgetMs, guaranteedMaxMs, singlePageMs: baseMs + analysisMs };
}

/**
 * THE THREE TIMEOUT BOUNDARIES OF ONE ANALYSIS (Workstream 5A). They are different concerns and are named separately here, although (deliberately) only the first has
 * its own setting, and no value is changed by this separation:
 *
 *   1. HTTP / BROWSER RESPONSE WINDOW   how long ONE HTTP request waits for the analysis before it answers "in progress" instead.
 *                                       getAnalysisResponseWindowMs(): default = the shorter of the request deadline and 25 s (ANALYSIS_RESPONSE_WINDOW_DEFAULT_MS), anchored to
 *                                       the BROWSER's fixed 30 s wait (frontend api.js) and not to any Node setting. 25 s is also the longest wait of today (the Node ->
 *                                       AI-service analysis timeout), so with the provider deadline unchanged the "in progress" answer is not reached in normal operation.
 *                                       Optional KOI_ANALYSIS_RESPONSE_WINDOW_MS exists so a test (or an operator) can shorten it.
 *   2. NODE ANALYSIS-ATTEMPT LIFETIME   how long the attempt (retrieval + the AI-service call + validation + persistence) may run, whatever the HTTP request does. It is
 *                                       bounded by construction by getAnalysisTimeBudget() (retrieval budget + the 25 s analysis timeout <= the 110 s deadline); an
 *                                       attempt marker older than getAnalysisAttemptStaleAfterMs() is presumed dead (its process ended) and is never waited for.
 *   3. PROVIDER / GEMINI DEADLINE       the AI service's own Gemini ANALYSIS deadline (ai-service LLM_ANALYSIS_TIMEOUT_MS, at most AI_ANALYSIS_DEADLINE_CEILING_MS). Workstream 5C
 *                                       separated it from REQUEST_TIMEOUT_MS (which stays <= 20 s for embedding), and Node's wait for it (getAiAnalysisTimeoutMs) from
 *                                       KOI_AI_TIMEOUT_MS (which stays the per-call timeout of retrieval / embedding calls).
 */
export const ANALYSIS_RESPONSE_WINDOW_DEFAULT_MS = 25_000;
export function getAnalysisResponseWindowMs() {
  return int("KOI_ANALYSIS_RESPONSE_WINDOW_MS", Math.min(ANALYSIS_RESPONSE_WINDOW_DEFAULT_MS, getAnalysisTimeBudget().deadlineMs), { min: 50, max: 110_000 });
}

/** An in-progress attempt marker older than this belongs to a process that no longer exists (the pipeline is bounded by the request deadline). 30 s of grace on top. */
export function getAnalysisAttemptStaleAfterMs() {
  return getAnalysisTimeBudget().deadlineMs + 30_000;
}

/**
 * The timeout for the NEXT retrieval call, or null when the retrieval budget is exhausted (the caller must then fail closed).
 * Pure: `now` and `deadlineAt` are epoch milliseconds supplied by the caller, so the budget is testable without a clock.
 */
export function nextRetrievalCallTimeoutMs({ now, deadlineAt, baseMs }) {
  const remaining = deadlineAt - now;
  if (!(remaining >= 1)) return null;
  return Math.min(baseMs, Math.floor(remaining));
}

/**
 * Knowledge retrieval relevance floor (Phase 25). SERVER-SIDE ONLY: read from the process environment, never from a request.
 *
 * PROVISIONAL and UNCALIBRATED. 0.25 is NOT an empirically derived value: no relevance evaluation set exists yet (the Phase 26
 * evaluation harness will establish one). It is a conservative floor on RAW cosine similarity (not the scope-boosted score) whose
 * only claim is to discard candidates that point in clearly unrelated or opposing directions (cosine near or below 0).
 *   - With the deterministic TEST embeddings (hash-based, not semantic) unrelated texts score about N(0, 0.18), so this floor rejects
 *     most of them - which is what lets the tests exercise the "below threshold" path with computed, reproducible values.
 *   - With real embedding models it is expected to be permissive; how permissive is exactly what Phase 26 must measure.
 * A candidate is kept when similarity >= threshold (boundary inclusive). An unset, blank, non-numeric or out-of-range
 * (outside -1..1) value falls back to this default - a typo never disables the floor. A DELIBERATE value of -1 disables it
 * (every cosine is >= -1); that exists for test harnesses whose hash embeddings carry no meaning, and production start-up warns about it.
 */
export const DEFAULT_RETRIEVAL_MIN_SIMILARITY = 0.25;
export function getRetrievalMinSimilarity() {
  const raw = process.env.KOI_RETRIEVAL_MIN_SIMILARITY;
  if (raw === undefined || raw.trim() === "") return DEFAULT_RETRIEVAL_MIN_SIMILARITY;
  const value = Number(raw);
  return Number.isFinite(value) && value >= -1 && value <= 1 ? value : DEFAULT_RETRIEVAL_MIN_SIMILARITY;
}

export function getJsonBodyLimit() {
  return int("KOI_JSON_BODY_LIMIT_BYTES", 102_400, { min: 1024, max: 5_242_880 });
}

/**
 * Phase 32 - whether the canonical Intelligence pipeline attaches a bounded Learning V1 context
 * (learningContextService.js) to the AI-service request. SERVER-SIDE ONLY, read fresh on every call (never
 * cached, never a request/query parameter) and DEFAULT FALSE: an unset, blank, or any value other than the
 * exact string "true" leaves the canonical request byte-for-byte identical to pre-Phase-32 behavior. This is
 * the opposite default convention from getRateLimitConfig's "true unless explicitly false" above, by design -
 * a new AI-prompt-shaping capability must be explicitly opted into, never silently on.
 */
export function getLearningContextEnabled() {
  return (process.env.KOI_LEARNING_CONTEXT_ENABLED ?? "").trim().toLowerCase() === "true";
}

export function getImportLimits() {
  return {
    maxRows: int("KOI_IMPORT_MAX_ROWS", 5000, { min: 1, max: 100_000 }),
    maxColumns: int("KOI_IMPORT_MAX_COLUMNS", 50, { min: 1, max: 500 }),
    maxFieldLength: int("KOI_IMPORT_MAX_FIELD_LENGTH", 1000, { min: 10, max: 100_000 }),
    maxRecordBytes: int("KOI_IMPORT_MAX_RECORD_BYTES", 20_000, { min: 100, max: 1_000_000 }),
  };
}
