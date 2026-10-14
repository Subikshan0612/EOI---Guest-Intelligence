import { getRuntimeMode, isDevelopmentOrTestMode } from "./runtimeMode.js";
import { AI_ANALYSIS_DEADLINE_CEILING_MS, DEFAULT_RETRIEVAL_MIN_SIMILARITY, getAnalysisTimeBudget, getLearningContextEnabled, getRetrievalMinSimilarity } from "./runtimeConfig.js";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Test-provider isolation (Phase 21). In an explicit NODE_ENV=test the server REFUSES to start if it could reach an external
 * AI provider: an AI_SERVICE_URL that is not a loopback address, or LLM_PROVIDER=openai with an API key present. (The local
 * Python service's own providers cannot be inspected from here: start it through scripts/start-test-stack.mjs, which forces
 * LLM_PROVIDER=test, EMBEDDING_PROVIDER=test and an empty key.) No value is printed.
 * @returns {string[]} the reasons the server must not start (empty = fine)
 */
export function externalAiViolationsForTestMode(environment = process.env) {
  if (getRuntimeMode() !== "test") return [];
  const problems = [];
  const url = (environment.AI_SERVICE_URL ?? "").trim();
  if (url) {
    let host = "";
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      problems.push("AI_SERVICE_URL is not a valid URL");
    }
    if (host && !LOOPBACK.has(host)) problems.push("AI_SERVICE_URL points to a non-loopback host while NODE_ENV=test");
  }
  if ((environment.LLM_PROVIDER ?? "").trim().toLowerCase() === "openai" && (environment.OPENAI_API_KEY ?? "").trim()) {
    problems.push("LLM_PROVIDER=openai with an API key present while NODE_ENV=test");
  }
  return problems;
}

/**
 * Timeout invariants (Phase 35 / 35.1). The request deadline is ENFORCED at run time (getAnalysisTimeBudget: retrieval gets only what is
 * left of the deadline after the analysis call's full timeout is reserved, and fails closed when that is spent), so the worst case is
 * bounded by construction. This start-up check only refuses configurations under which that design cannot work at all:
 *   - the retrieval budget (deadline - analysis timeout) cannot fit even ONE retrieval call (this also covers an analysis timeout at or
 *     above the deadline, and a socket timeout too small for it). Mis-set KOI_AI_TIMEOUT_MS / KOI_SOCKET_TIMEOUT_MS only.
 *   - on the real `gemini` route, the analysis timeout does not exceed the AI service's analysis-deadline ceiling
 *     (AI_ANALYSIS_DEADLINE_CEILING_MS, Workstream 5C): the AI service's classified PROVIDER_TIMEOUT could then fire AFTER Node already gave up.
 *     Not applied to the test routes, whose servers deliberately run with tiny timeouts.
 * Node does not read the AI service's configuration; the AI service validates its own Gemini timeout against the same ceiling
 * (ai-service/app/provider_policy.py). No retry or circuit breaker is involved.
 * @returns {{fatal: string[], warnings: string[], budget: object}}
 */
export function timeoutBudgetProblems(environment = process.env) {
  const budget = getAnalysisTimeBudget();
  const fatal = [];
  const warnings = [];
  if (budget.analysisMs >= budget.deadlineMs) {
    fatal.push(`the analysis timeout (${budget.analysisMs} ms) does not fit inside the request deadline (${budget.deadlineMs} ms = socket timeout ${budget.socketMs} ms minus a ${budget.marginMs} ms margin)`);
  } else if (budget.retrievalBudgetMs < budget.baseMs) {
    fatal.push(`the retrieval budget (${budget.retrievalBudgetMs} ms = request deadline ${budget.deadlineMs} ms minus the analysis timeout ${budget.analysisMs} ms) cannot fit one retrieval call (${budget.baseMs} ms)`);
  }
  if ((environment.LLM_PROVIDER ?? "").trim().toLowerCase() === "gemini" && budget.analysisMs <= AI_ANALYSIS_DEADLINE_CEILING_MS) {
    fatal.push(`the analysis timeout (${budget.analysisMs} ms) must exceed the AI service's analysis deadline ceiling (${AI_ANALYSIS_DEADLINE_CEILING_MS} ms) so the provider timeout is classified before Node gives up`);
  }
  return { fatal, warnings, budget };
}

/**
 * AI configuration the SERVER OWNS, outside an explicit development/test environment (Phase 36). FAIL CLOSED, evaluated at start-up:
 *   - the deterministic providers (`test`, `test-python`) must never run in production or an unknown NODE_ENV (fatal; the request-time
 *     route policy already refuses them, this stops a server that could never produce Intelligence from starting at all);
 *   - on the real `gemini` route AI_SERVICE_URL is required and must be a plain http(s) URL without embedded credentials (fatal);
 *   - Learning enabled is reported (warning): it is OFF by default and the audit trail records whether it was used.
 * The Gemini model and timeout belong to the AI service and are validated THERE (ai-service/app/provider_policy.py); Node's own model
 * policy is a code constant (config/providerPolicy.js), so there is no Node setting to validate. Only fixed messages are returned - no value is echoed.
 * @returns {{fatal: string[], warnings: string[]}}
 */
export function productionAiConfigProblems(environment = process.env) {
  const fatal = [];
  const warnings = [];
  if (isDevelopmentOrTestMode()) return { fatal, warnings };
  const provider = (environment.LLM_PROVIDER ?? "").trim().toLowerCase();
  if (provider === "test" || provider === "test-python") {
    fatal.push("LLM_PROVIDER names a deterministic test provider, which is not allowed outside an explicit development/test NODE_ENV");
  } else if (provider === "gemini") {
    const raw = (environment.AI_SERVICE_URL ?? "").trim();
    if (!raw) fatal.push("AI_SERVICE_URL is required for the gemini route");
    else {
      try {
        const url = new URL(raw);
        if (url.protocol !== "http:" && url.protocol !== "https:") fatal.push("AI_SERVICE_URL must be an http(s) URL");
        if (url.username || url.password) fatal.push("AI_SERVICE_URL must not embed credentials");
        // Phase 51: the AI service has no user authentication of its own; without the optional service credential its only protection is the network.
        if (!(environment.AI_SERVICE_TOKEN ?? "").trim()) warnings.push("AI_SERVICE_TOKEN is unset: the AI service is protected only by network isolation. Set the same token on the backend and on the AI service, or keep the service on a private network.");
      } catch {
        fatal.push("AI_SERVICE_URL is not a valid URL");
      }
    }
  } else if (provider !== "openai") {
    // Phase 37: a NON-EMPTY value that is none of gemini / openai / test / test-python is a typo or a stale setting, not an intent to run without AI:
    // refuse to start (the same rule the AI service applies). An UNSET provider stays a warning - running without AI can be deliberate.
    if (provider !== "") fatal.push("LLM_PROVIDER is not a recognised provider (gemini, openai); refusing to start with a setting that would silently disable analysis");
    else warnings.push("LLM_PROVIDER is unset: Intelligence analysis is unavailable (requests answer 503) until it is set to the approved route");
  }
  if (getLearningContextEnabled()) warnings.push("KOI_LEARNING_CONTEXT_ENABLED is on: Learning context is being added to analyses (it is off by default)");
  return { fatal, warnings };
}

/**
 * MongoDB connection configuration the server OWNS, outside an explicit development/test environment (Phase 38). The URI is parsed, never echoed.
 *   fatal    the URI names NO DATABASE: the driver would silently use MongoDB's default `test` database, so production data would land in the wrong place
 *   warning  no credentials in the URI (production MongoDB must require authentication; some deployments supply it elsewhere, so this is a warning)
 *   warning  TLS not requested (a `mongodb+srv://` URI implies TLS; otherwise `tls=true` is expected; a private network may provide it, so a warning)
 * An empty/missing URI is not judged here - connectDatabase() already refuses it with its own message.
 * @returns {{fatal: string[], warnings: string[]}}
 */
export function mongoConfigProblems(uri = process.env.MONGODB_URI) {
  const fatal = [];
  const warnings = [];
  if (isDevelopmentOrTestMode() || typeof uri !== "string" || uri.trim() === "") return { fatal, warnings };
  const match = /^mongodb(\+srv)?:\/\/(?:([^@/]*)@)?([^/?]+)(?:\/([^?]*))?(?:\?(.*))?$/.exec(uri.trim());
  if (!match) { fatal.push("MONGODB_URI is not a valid MongoDB connection string"); return { fatal, warnings }; }
  const [, srv, userinfo, , database, query] = match;
  if (!database) fatal.push("MONGODB_URI must name a database (without one the driver uses the default `test` database)");
  if (!userinfo) warnings.push("MONGODB_URI carries no credentials: a production MongoDB must require authentication (a dedicated least-privilege user for this database)");
  if (!srv && !/(^|&)(tls|ssl)=true(&|$)/i.test(query ?? "")) warnings.push("MONGODB_URI does not request TLS (use a mongodb+srv:// URI or tls=true) unless the network layer provides transport security");
  return { fatal, warnings };
}

/**
 * CLIENT_URL must be an EXACT ORIGIN (release hardening). It is the value the API sends back as `Access-Control-Allow-Origin` (and compares with the cookie request's Origin and
 * puts at the start of every e-mail link). A browser's Origin header never has a trailing slash or a path, so `https://app.example.com/` passes every other check yet makes every
 * browser request fail the CORS comparison. The only accepted form is what `new URL(value).origin` returns for the same text: `scheme://host[:port]`, lower-case host, no default
 * port, no path (not even "/"), no query, no fragment, no credentials, no surrounding whitespace. Outside an explicit development/test NODE_ENV (production AND an unset/unknown
 * NODE_ENV) a violation is FATAL; in development/test it is a warning, because the dev server would fail the same way. The HTTPS and non-localhost requirements for a deployment that
 * sends e-mail stay in emailStartupProblems and are not weakened. The message never echoes the value.
 * @returns {{fatal: string[], warnings: string[]}}
 */
export function clientUrlProblems(clientUrl) {
  const raw = typeof clientUrl === "string" ? clientUrl : "";
  let parsed = null;
  try { parsed = new URL(raw); } catch { /* reported below */ }
  const problems = [];
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) problems.push("CLIENT_URL must be an absolute http(s) origin such as https://app.example.com");
  else if (parsed.origin !== raw) problems.push("CLIENT_URL must be an exact origin (scheme://host[:port]): no trailing slash, path, query, fragment, credentials, upper-case host or default port - a browser's Origin header never has them, so every browser request would fail the CORS check");
  return isDevelopmentOrTestMode() ? { fatal: [], warnings: problems } : { fatal: problems, warnings: [] };
}

/**
 * KOI_TRUST_PROXY must be unset or a whole number of proxy hops from 1 to 10 (release hardening). getTrustProxy() quietly treats anything else (for example `true`, `1.5`, `0`,
 * `11`, a typo) as "no proxy", which behind a platform proxy makes every user share one client address and one set of rate-limit counters. Outside an explicit development/test
 * NODE_ENV that is FATAL; in development/test a warning. The exact hop count can only be known on the real platform; this guard only refuses a value that cannot be a hop count.
 * @returns {{fatal: string[], warnings: string[]}}
 */
export function trustProxyProblems(environment = process.env) {
  const raw = environment.KOI_TRUST_PROXY;
  if (raw === undefined || raw === "") return { fatal: [], warnings: [] };
  const problems = /^(?:[1-9]|10)$/.test(raw) ? [] : ["KOI_TRUST_PROXY must be unset or a whole number of proxy hops from 1 to 10 (any other value is ignored, so client addresses and rate limits would silently stay wrong behind a proxy)"];
  return isDevelopmentOrTestMode() ? { fatal: [], warnings: problems } : { fatal: problems, warnings: [] };
}

/** Non-fatal warnings printed once at startup. */
export function runtimeWarnings(environment = process.env) {
  const mode = getRuntimeMode();
  const warnings = [];
  if (mode === "unknown") warnings.push("NODE_ENV is unset or unrecognised: development features (dev token verifier, error debug details, dev knowledge level) are DISABLED. Set NODE_ENV=development or NODE_ENV=test explicitly.");
  // Phase 37: the deployment invariant behind the in-process single-flight (see docs/DEPLOYMENT_READINESS_PHASE37.md).
  if (mode === "production") warnings.push("Analysis single-flight is PROCESS-LOCAL: the supported topology is ONE backend instance. With more than one instance two simultaneous first requests for the same Signal can both call the model (extra provider spend only - the unique index still stores a single analysis).");
  if (mode === "production") warnings.push("Rate limiting uses a PROCESS-LOCAL store: with more than one instance the effective limit multiplies and restarts reset it. Provide a shared RateLimitStore (e.g. Redis) via setRateLimitStore().");
  // KOI_NO_DOTENV is set automatically for validation suites and the servers they spawn (KOI_NO_DOTENV_REASON=validation). Anywhere else it means backend/.env was NOT loaded.
  if (environment.KOI_NO_DOTENV === "1" && environment.KOI_NO_DOTENV_REASON !== "validation") warnings.push("KOI_NO_DOTENV is set but this is not a validation run: backend/.env was NOT loaded, so only the process environment configures this server. Unset it unless that is intended.");
  if ((environment.KOI_RATE_LIMIT_ENABLED ?? "true").trim().toLowerCase() === "false" && mode === "production") warnings.push("KOI_RATE_LIMIT_ENABLED=false in production: rate limiting is OFF.");
  if (mode === "production" && getRetrievalMinSimilarity() < DEFAULT_RETRIEVAL_MIN_SIMILARITY) warnings.push("KOI_RETRIEVAL_MIN_SIMILARITY is set BELOW the default relevance floor: weakly related knowledge can reach the model.");
  return warnings;
}
