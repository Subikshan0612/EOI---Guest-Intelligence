import { createHash } from "node:crypto";
import { createStubTokenVerifier } from "./stubTokenVerifier.js";
import { resolveAuthConfig } from "./authConfig.js";
import { createOidcTokenVerifier } from "./oidcTokenVerifier.js";
import { createEoiTokenVerifier } from "./eoiTokenVerifier.js";

/**
 * The provider-agnostic seam. The rest of EOI asks for "the token verifier" and
 * calls `verifier(token)`; it never learns which implementation is behind it.
 *
 *   verifyAccessToken(token) -> Promise<{ issuer, subject, email?, expiresAt }>
 *
 * (the exact contract, and what a verifier is responsible for, is documented in
 * tokenContract.js). A future OIDC/JWKS verifier is installed with
 * `configureTokenVerifier(...)` and nothing else changes.
 *
 * With nothing configured there IS no verifier and every bearer request fails
 * closed (503 from the middleware): an unconfigured server never authenticates
 * anyone.
 */

let configured = null;

/** Installs (or, with null, removes) the verifier for this process. */
export function configureTokenVerifier(verifier) {
  if (verifier !== null && typeof verifier !== "function") {
    throw new TypeError("A token verifier must be a function (token) => identity");
  }
  configured = verifier;
}

let fromEnvironment = null;
let fromEnvironmentKey = null;
let oidcVerifier = null;
let oidcVerifierKey = null;
let eoiVerifier = null;
let eoiVerifierKey = null;
let idTokenVerifier = null;
let idTokenVerifierKey = null;

/**
 * The verifier for the PROVIDER's ID token in the Google code exchange. Under AUTH_PROVIDER=oidc it is the same verifier that protects every request;
 * under AUTH_PROVIDER=eoi it is a separate OIDC verifier used ONLY by the exchange (a provider token is never accepted as an API bearer in that mode).
 */
export function getIdTokenVerifier() {
  const config = resolveAuthConfig();
  if (config.provider === "oidc") return getTokenVerifier();
  if (config.provider !== "eoi" || !config.oidc) return null;
  const key = JSON.stringify(config.oidc);
  if (!idTokenVerifier || idTokenVerifierKey !== key) {
    idTokenVerifier = createOidcTokenVerifier(config.oidc, { onProviderError: (stage) => console.error(`[KOI API] OIDC provider error (${stage})`) });
    idTokenVerifierKey = key;
  }
  return idTokenVerifier;
}

/**
 * The verifier in effect. An explicitly configured one wins. Otherwise
 * AUTH_TOKEN_VERIFIER=stub selects the DEVELOPMENT stub (AUTH_STUB_SECRET
 * required) - and only outside production; in production the environment can
 * never switch a development verifier on.
 * @returns {((token: string) => Promise<object>) | null}
 */
export function getTokenVerifier() {
  if (configured) return configured;
  // The provider is chosen EXPLICITLY (authConfig.js): AUTH_PROVIDER=oidc | stub. The stub needs an explicit
  // development/test NODE_ENV (production and an unset/unknown NODE_ENV refuse it); an invalid or missing OIDC configuration
  // yields NO verifier, so every authenticated request fails closed with 503.
  const config = resolveAuthConfig();
  if (config.provider === "eoi") {
    if (!config.eoi) return null;
    const key = createHash("sha256").update(config.eoi.secret).digest("hex") + String(config.eoi.accessTtlSeconds);
    if (!eoiVerifier || eoiVerifierKey !== key) {
      eoiVerifier = createEoiTokenVerifier(config.eoi);
      eoiVerifierKey = key;
    }
    return eoiVerifier;
  }
  if (config.provider === "oidc") {
    if (!config.oidc) return null;
    const key = JSON.stringify(config.oidc);
    if (!oidcVerifier || oidcVerifierKey !== key) {
      oidcVerifier = createOidcTokenVerifier(config.oidc, { onProviderError: (stage) => console.error(`[KOI API] OIDC provider error (${stage})`) });
      oidcVerifierKey = key;
    }
    return oidcVerifier;
  }
  if (config.provider !== "stub") return null;

  const secret = process.env.AUTH_STUB_SECRET ?? "";
  if (fromEnvironment && fromEnvironmentKey === secret) return fromEnvironment;
  try {
    fromEnvironment = createStubTokenVerifier({ secret });
    fromEnvironmentKey = secret;
  } catch {
    fromEnvironment = null;
    fromEnvironmentKey = null;
  }
  return fromEnvironment;
}
