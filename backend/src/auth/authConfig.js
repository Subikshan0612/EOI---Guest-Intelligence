import { getRuntimeMode, isDevelopmentOrTestMode } from "../config/runtimeMode.js";

/**
 * Explicit authentication configuration (Phase 23). FAIL CLOSED.
 *
 *   AUTH_PROVIDER=eoi    the UNIFIED EOI session (Phase 46): every sign-in method (email + password, Google) ends in the same EOI access token + refresh
 *                        session. Google (OIDC_* + OIDC_EXCHANGE_*) is then only an identity source used by the code exchange; it is never an API bearer.
 *   AUTH_PROVIDER=oidc   production-capable: verifies OIDC/OAuth2 JWT access tokens against the issuer's JWKS
 *   AUTH_PROVIDER=stub   the DEVELOPMENT verifier; only with an explicit NODE_ENV=development|test
 *   (unset)              legacy: AUTH_TOKEN_VERIFIER=stub still selects the stub (development/test only); otherwise NO provider
 *
 * Nothing is ever chosen implicitly. Production requires a valid OIDC configuration and never the stub; an unset/unknown
 * NODE_ENV never gets the stub. With no usable provider every authenticated request is 503 (never authenticated).
 *
 * EOI session settings (AUTH_PROVIDER=eoi; see docs/UNIFIED_AUTH_PHASE46.md):
 *   KOI_SESSION_SECRET           required. At least 32 characters of high-entropy secret that signs EOI access tokens (HS256). Never logged, never returned.
 *   KOI_ACCESS_TOKEN_TTL_SECONDS optional. 60-3600, default 600 (10 minutes).
 *   KOI_REFRESH_TTL_DAYS         optional. 1-90, default 14: the absolute lifetime of a refresh session.
 *   KOI_COOKIE_SAMESITE          optional. lax (default) | strict | none. `none` is for a frontend and API on different sites and requires secure cookies.
 *   KOI_COOKIE_SECURE            optional. true | false. Default true in production, false elsewhere; production refuses false.
 *
 * OIDC settings (all from the environment; nothing provider-specific is in the source code):
 *   OIDC_ISSUER                  required. The exact `iss` value tokens carry. https (http only for loopback in development/test).
 *   OIDC_AUDIENCE                required. One value, or a comma-separated list; a token must name at least one in `aud`.
 *   OIDC_JWKS_URI                optional. Default: discovered from `${OIDC_ISSUER}/.well-known/openid-configuration`
 *                                (whose `issuer` must equal OIDC_ISSUER).
 *   OIDC_ALGORITHMS              optional. Asymmetric algorithms accepted. Default RS256,ES256. HS* and `none` are refused.
 *   OIDC_CLOCK_TOLERANCE_SECONDS optional. 0-300, default 60: skew allowed for `nbf` and `iat`. (`exp` is enforced STRICTLY: EOI re-checks
 *                                expiry against the current time after verification.)
 *   OIDC_REQUIRED_TYP            optional. If set (e.g. `at+jwt`), the token header `typ` must equal it.
 *   OIDC_JWKS_COOLDOWN_MS        optional. Minimum time between JWKS re-fetches triggered by an unknown `kid` (default 30000).
 *   OIDC_JWKS_CACHE_MAX_AGE_MS   optional. How long fetched keys are trusted before a refresh (default 600000).
 *   OIDC_HTTP_TIMEOUT_MS         optional. Timeout for discovery/JWKS requests (default 5000).
 */
const ASYMMETRIC = new Set(["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA"]);
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

const int = (raw, fallback, min, max) => {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max ? value : NaN;
};

function checkUrl(name, value, problems) {
  let url;
  try {
    url = new URL(value);
  } catch {
    problems.push(`${name} is not a valid URL`);
    return null;
  }
  if (url.search || url.hash) problems.push(`${name} must not contain a query string or fragment`);
  const https = url.protocol === "https:";
  const loopbackHttp = url.protocol === "http:" && LOOPBACK.has(url.hostname) && isDevelopmentOrTestMode();
  if (!https && !loopbackHttp) problems.push(`${name} must be an https URL (http is allowed only for loopback in development/test)`);
  return url;
}

/** @returns {{ provider: "oidc"|"stub"|"eoi"|null, mode: string, problems: string[], oidc: object|null, eoi: object|null }} */
export function resolveAuthConfig(environment = process.env) {
  const mode = getRuntimeMode();
  const problems = [];
  const requested = (environment.AUTH_PROVIDER ?? "").trim().toLowerCase();
  let provider = null;
  if (requested) {
    if (requested === "oidc" || requested === "stub" || requested === "eoi") provider = requested;
    else problems.push("AUTH_PROVIDER must be `oidc`, `eoi` or `stub`");
  } else if ((environment.AUTH_TOKEN_VERIFIER ?? "").trim().toLowerCase() === "stub") {
    provider = "stub"; // legacy switch, development/test only
  }

  if (provider === "stub" && !isDevelopmentOrTestMode()) {
    problems.push("the development (stub) verifier requires an explicit NODE_ENV=development or NODE_ENV=test");
    provider = null;
  }
  if (mode === "production" && provider !== "oidc" && provider !== "eoi") problems.push("production requires AUTH_PROVIDER=eoi or AUTH_PROVIDER=oidc");

  // Under AUTH_PROVIDER=eoi the OIDC settings are OPTIONAL (Google sign-in is then one identity source among others); when OIDC_ISSUER is set they are
  // validated exactly as for AUTH_PROVIDER=oidc. Under AUTH_PROVIDER=oidc they are required.
  let oidc = null;
  const wantsOidc = provider === "oidc" || (provider === "eoi" && (environment.OIDC_ISSUER ?? "").trim() !== "");
  let eoiCfg = null;
  if (provider === "eoi") {
    const cfg = {};
    const secret = environment.KOI_SESSION_SECRET ?? "";
    if (secret.length < 32) problems.push("KOI_SESSION_SECRET is required and must be at least 32 characters");
    else if (new Set(secret).size < 10 || /change[-_ ]?me|example|placeholder|replace[-_ ]?(me|with)|your[-_ ]|secret[-_ ]?here|(.)\2{5,}/i.test(secret)) {
      // A copied template value or a trivially repetitive string is not a secret: with the secret anyone can mint an access token for any user id.
      problems.push("KOI_SESSION_SECRET looks like a placeholder or a low-entropy value: generate one with `node -e \"console.log(require('crypto').randomBytes(48).toString('base64url'))\"`");
    } else Object.defineProperty(cfg, "secret", { value: secret, enumerable: false }); // held out of enumeration: a stray JSON.stringify / spread / log cannot print it
    cfg.accessTtlSeconds = int(environment.KOI_ACCESS_TOKEN_TTL_SECONDS, 600, 60, 3600);
    cfg.refreshTtlDays = int(environment.KOI_REFRESH_TTL_DAYS, 14, 1, 90);
    if (Number.isNaN(cfg.accessTtlSeconds)) problems.push("KOI_ACCESS_TOKEN_TTL_SECONDS must be an integer from 60 to 3600");
    if (Number.isNaN(cfg.refreshTtlDays)) problems.push("KOI_REFRESH_TTL_DAYS must be an integer from 1 to 90");
    const sameSite = (environment.KOI_COOKIE_SAMESITE ?? "lax").trim().toLowerCase();
    if (!["lax", "strict", "none"].includes(sameSite)) problems.push("KOI_COOKIE_SAMESITE must be lax, strict or none");
    cfg.sameSite = ["lax", "strict", "none"].includes(sameSite) ? sameSite : "lax";
    const secureRaw = (environment.KOI_COOKIE_SECURE ?? "").trim().toLowerCase();
    cfg.secure = secureRaw === "" ? mode === "production" : secureRaw === "true";
    if (secureRaw !== "" && secureRaw !== "true" && secureRaw !== "false") problems.push("KOI_COOKIE_SECURE must be true or false");
    if (mode === "production" && !cfg.secure) problems.push("production requires secure (HTTPS-only) auth cookies: KOI_COOKIE_SECURE must not be false");
    if (cfg.sameSite === "none" && !cfg.secure) problems.push("KOI_COOKIE_SAMESITE=none requires secure cookies");
    eoiCfg = cfg;
  }
  if (wantsOidc) {
    const cfg = {};
    const issuerRaw = (environment.OIDC_ISSUER ?? "").trim();
    if (!issuerRaw) problems.push("OIDC_ISSUER is required");
    else if (checkUrl("OIDC_ISSUER", issuerRaw, problems)) cfg.issuer = issuerRaw;
    const audience = (environment.OIDC_AUDIENCE ?? "").split(",").map((v) => v.trim()).filter(Boolean);
    if (audience.length === 0) problems.push("OIDC_AUDIENCE is required");
    else cfg.audience = audience;
    const jwksRaw = (environment.OIDC_JWKS_URI ?? "").trim();
    if (jwksRaw && checkUrl("OIDC_JWKS_URI", jwksRaw, problems)) cfg.jwksUri = jwksRaw;
    const algorithms = (environment.OIDC_ALGORITHMS || "RS256,ES256").split(",").map((v) => v.trim()).filter(Boolean);
    if (algorithms.length === 0 || algorithms.some((a) => !ASYMMETRIC.has(a))) problems.push(`OIDC_ALGORITHMS must list only asymmetric algorithms (${[...ASYMMETRIC].join(", ")}); HS* and none are never accepted`);
    else cfg.algorithms = algorithms;
    cfg.clockToleranceSeconds = int(environment.OIDC_CLOCK_TOLERANCE_SECONDS, 60, 0, 300);
    cfg.jwksCooldownMs = int(environment.OIDC_JWKS_COOLDOWN_MS, 30_000, 0, 3_600_000);
    cfg.jwksCacheMaxAgeMs = int(environment.OIDC_JWKS_CACHE_MAX_AGE_MS, 600_000, 1000, 86_400_000);
    cfg.httpTimeoutMs = int(environment.OIDC_HTTP_TIMEOUT_MS, 5000, 100, 60_000);
    for (const key of ["clockToleranceSeconds", "jwksCooldownMs", "jwksCacheMaxAgeMs", "httpTimeoutMs"]) if (Number.isNaN(cfg[key])) problems.push(`an OIDC_* numeric setting (${key}) is out of range`);
    const typ = (environment.OIDC_REQUIRED_TYP ?? "").trim();
    if (typ) cfg.requiredTyp = typ;
    oidc = problems.length === 0 ? cfg : null;
  }
  return { provider, mode, problems, oidc, eoi: eoiCfg && problems.length === 0 ? Object.freeze(eoiCfg) : null };
}

/** Problems that must stop the server from STARTING (production only; elsewhere they are warnings and requests fail with 503). */
export function authStartupProblems(environment = process.env) {
  const config = resolveAuthConfig(environment);
  return { fatal: config.mode === "production" ? config.problems : [], warnings: config.mode === "production" ? [] : config.problems, config };
}
