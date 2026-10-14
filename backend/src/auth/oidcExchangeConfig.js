import { isDevelopmentOrTestMode } from "../config/runtimeMode.js";
import { resolveAuthConfig } from "./authConfig.js";

/**
 * Configuration of the server-side authorization-code exchange (Phase 45B.4).
 *
 * WHY IT EXISTS: some providers (Google, for a "Web application" OAuth client) require a CLIENT SECRET at the token endpoint even when PKCE is
 * used. A browser must never hold that secret, so for such a provider the browser sends the authorization code and its PKCE verifier to THIS
 * backend, which holds the secret and performs the exchange. It then VERIFIES the ID token the provider returned with the same verifier that
 * protects every API request (issuer, audience, signature, algorithm, expiry) before handing it on. Nothing else about the provider's response
 * (opaque access token, refresh token, profile) ever reaches the browser.
 *
 *   OIDC_EXCHANGE_CLIENT_ID       the OAuth client id; it MUST be one of OIDC_AUDIENCE (the token the exchange returns has to pass the verifier)
 *   OIDC_EXCHANGE_CLIENT_SECRET   the client secret. SERVER SIDE ONLY: never a VITE_* variable, never logged, never returned.
 *   OIDC_EXCHANGE_REDIRECT_URIS   comma-separated EXACT redirect URIs the exchange will accept (the SPA's callback). https; http only for loopback in development/test.
 *
 * All three set -> the endpoint is enabled. None set -> it is disabled (the provider-neutral public-client flow is unchanged). Some set -> a
 * configuration problem (fatal in production). The issuer, audience, JWKS and algorithms are the existing OIDC_* settings (authConfig.js);
 * nothing about the provider is chosen by the browser.
 */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function checkRedirectUri(value, problems) {
  let url;
  try {
    url = new URL(value);
  } catch {
    problems.push("OIDC_EXCHANGE_REDIRECT_URIS contains an invalid URL");
    return;
  }
  if (url.search || url.hash) problems.push("OIDC_EXCHANGE_REDIRECT_URIS entries must not contain a query string or fragment");
  const ok = url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname) && isDevelopmentOrTestMode());
  if (!ok) problems.push("OIDC_EXCHANGE_REDIRECT_URIS entries must be https URLs (http is allowed only for loopback in development/test)");
}

/** @returns {{ enabled: boolean, problems: string[], config: object|null }} */
export function resolveExchangeConfig(environment = process.env, authConfig = resolveAuthConfig(environment)) {
  const clientId = (environment.OIDC_EXCHANGE_CLIENT_ID ?? "").trim();
  const clientSecret = (environment.OIDC_EXCHANGE_CLIENT_SECRET ?? "").trim();
  const redirectUris = (environment.OIDC_EXCHANGE_REDIRECT_URIS ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  const set = [clientId, clientSecret, redirectUris.length > 0];
  if (set.every((v) => !v)) return { enabled: false, problems: [], config: null };

  const problems = [];
  if (!set.every(Boolean)) problems.push("OIDC_EXCHANGE_CLIENT_ID, OIDC_EXCHANGE_CLIENT_SECRET and OIDC_EXCHANGE_REDIRECT_URIS must all be set together");
  if ((authConfig.provider !== "oidc" && authConfig.provider !== "eoi") || !authConfig.oidc) problems.push("the code exchange requires a valid OIDC configuration (AUTH_PROVIDER=oidc, or AUTH_PROVIDER=eoi with OIDC_ISSUER / OIDC_AUDIENCE)");
  else if (clientId && !authConfig.oidc.audience.includes(clientId)) problems.push("OIDC_EXCHANGE_CLIENT_ID must be one of OIDC_AUDIENCE");
  for (const uri of redirectUris) checkRedirectUri(uri, problems);
  if (problems.length > 0) return { enabled: false, problems, config: null };

  const config = { clientId, redirectUris: Object.freeze([...new Set(redirectUris)]), issuer: authConfig.oidc.issuer, httpTimeoutMs: authConfig.oidc.httpTimeoutMs };
  // The secret is held out of enumeration so an accidental JSON.stringify / spread / log of the config cannot print it.
  Object.defineProperty(config, "clientSecret", { value: clientSecret, enumerable: false });
  return { enabled: true, problems: [], config: Object.freeze(config) };
}
