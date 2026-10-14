import { createRemoteJWKSet, errors, jwtVerify } from "jose";
import { AuthError, invalidToken } from "./tokenContract.js";

/**
 * OIDC / OAuth2 JWT access-token verifier (Phase 23), behind the existing `tokenVerifier` seam.
 *
 * Cryptography is done by `jose` (a maintained library): NOTHING is verified by hand here. What this module decides is policy:
 *
 *   signature      verified against the issuer's JWKS (RSA / EC / EdDSA public keys only)
 *   algorithm      an ALLOW-LIST from configuration (asymmetric only); `none` and HS* are never accepted, and the token's own
 *                  `alg` is never trusted beyond that list
 *   iss            must equal the configured issuer EXACTLY
 *   aud            must contain at least one configured audience
 *   exp / nbf      enforced, with a bounded clock tolerance (default 60 s)
 *   iat            REQUIRED, and must not lie in the future beyond the tolerance
 *   sub            REQUIRED (a non-empty string)
 *   typ            enforced only when OIDC_REQUIRED_TYP is set
 *
 * KEYS: fetched from the JWKS URI (configured, or discovered once from the issuer's OpenID configuration), cached by jose, and
 * re-fetched when an UNKNOWN `kid` is presented - at most once per cooldown, so an attacker cannot make the server hit the JWKS
 * endpoint on every request. A key rotation is therefore picked up automatically; a token signed by a key the issuer never
 * published is refused.
 *
 * CLAIMS USED: `iss` + `sub` are the identity (the only thing EOI keys a User on); `exp` (expiry, re-checked downstream); `email`
 * only as an ATTRIBUTE that is never a key and is not even persisted at login. Every other claim - name, preferred_username,
 * email_verified, groups, roles, scope, tenant ids ... - is NEVER READ. Provider groups/roles are not mapped to EOI roles or
 * permissions: the EOI membership + server-side role map stay the only authority (a group-to-role mapping is a future, separate decision).
 *
 * ERRORS: 401 for anything wrong with the TOKEN (TOKEN_EXPIRED for expiry, INVALID_TOKEN otherwise - the client never learns which
 * check failed); 503 AUTH_PROVIDER_UNAVAILABLE when verification could not be completed (JWKS unreachable / invalid): fail closed.
 */
const MAX_TOKEN_LENGTH = 8192;

export function createOidcTokenVerifier(config, { now = () => Date.now(), fetchImpl = globalThis.fetch, onProviderError = () => {} } = {}) {
  let jwks = null;
  let jwksPromise = null;
  let failedAt = 0;

  const unavailable = () => new AuthError("The authentication service is temporarily unavailable", 503, "AUTH_PROVIDER_UNAVAILABLE");

  async function discoverJwksUri() {
    if (config.jwksUri) return config.jwksUri;
    const url = `${config.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(config.httpTimeoutMs), headers: { accept: "application/json" } });
    if (!response.ok) throw new Error("discovery failed");
    const document = await response.json();
    // The discovery document must vouch for the SAME issuer, or it is not trusted (issuer-mix-up defence).
    if (!document || document.issuer !== config.issuer || typeof document.jwks_uri !== "string") throw new Error("discovery document mismatch");
    return document.jwks_uri;
  }

  async function getJwks() {
    if (jwks) return jwks;
    // A failed discovery is retried at most every 5 s (a burst of requests must not hammer the provider).
    if (failedAt && now() - failedAt < 5000) throw unavailable();
    jwksPromise ??= (async () => {
      try {
        const uri = await discoverJwksUri();
        jwks = createRemoteJWKSet(new URL(uri), { timeoutDuration: config.httpTimeoutMs, cooldownDuration: config.jwksCooldownMs, cacheMaxAge: config.jwksCacheMaxAgeMs });
        failedAt = 0;
        return jwks;
      } catch (error) {
        failedAt = now();
        onProviderError("discovery", error);
        throw unavailable();
      } finally {
        jwksPromise = null;
      }
    })();
    return jwksPromise;
  }

  return async function verifyAccessToken(token) {
    if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH || token.split(".").length !== 3) throw invalidToken();
    const keys = await getJwks();

    let payload;
    try {
      ({ payload } = await jwtVerify(token, keys, {
        issuer: config.issuer,
        audience: config.audience,
        algorithms: config.algorithms,
        clockTolerance: config.clockToleranceSeconds,
        requiredClaims: ["sub", "exp", "iat"],
        currentDate: new Date(now()),
        ...(config.requiredTyp ? { typ: config.requiredTyp } : {}),
      }));
    } catch (error) {
      if (error instanceof errors.JWTExpired) throw new AuthError("The access token has expired", 401, "TOKEN_EXPIRED");
      // Verification could not be COMPLETED (keys unavailable / malformed key set / network): fail closed with 503, never "authenticated".
      // (jose reports a non-200 JWKS response as a generic JOSEError, and a network failure as a non-JOSE error.)
      const providerFailure = error instanceof errors.JWKSTimeout || error instanceof errors.JWKSInvalid || error?.code === "ERR_JOSE_GENERIC" || !(error instanceof errors.JOSEError);
      if (providerFailure) {
        onProviderError("jwks", error);
        throw unavailable();
      }
      // Anything else is a problem with the TOKEN (signature, alg, iss, aud, nbf, unknown kid, malformed ...). No detail is returned.
      throw invalidToken();
    }

    if (typeof payload.sub !== "string" || payload.sub.trim() === "" || typeof payload.iss !== "string") throw invalidToken();
    // iat sanity: a token "issued in the future" (beyond the tolerance) is not trusted.
    if (typeof payload.iat !== "number" || payload.iat * 1000 > now() + config.clockToleranceSeconds * 1000) throw invalidToken();

    return {
      issuer: payload.iss,
      subject: payload.sub,
      email: typeof payload.email === "string" ? payload.email : undefined,
      // The provider's own statement that it verified the address (OIDC `email_verified`). Used ONLY by the unified sign-in to decide whether an email may be
      // trusted at all; the email is still never an identity key.
      emailVerified: payload.email_verified === true,
      expiresAt: new Date(payload.exp * 1000),
    };
  };
}
