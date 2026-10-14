import { getIdTokenVerifier } from "../auth/tokenVerifier.js";
import { resolveAuthConfig } from "../auth/authConfig.js";
import { resolveExchangeConfig } from "../auth/oidcExchangeConfig.js";
import { isDevelopmentOrTestMode } from "../config/runtimeMode.js";
import { User } from "../models/User.js";
import { AppError } from "../utils/AppError.js";
import { selfRegistrationEnabled } from "./accountService.js";

/**
 * Server-side OIDC authorization-code exchange (Phase 45B.4). See auth/oidcExchangeConfig.js for why it exists.
 *
 *   browser:  { code, code_verifier, redirect_uri }            (no secret, no client id)
 *   here:     exchange at the provider's token endpoint with the client id + SECRET + the browser's PKCE verifier
 *   provider: { id_token, access_token?, ... }
 *   here:     the ID TOKEN is verified (issuer, audience, signature, algorithm, expiry, iat, sub) by the existing verifier
 *   browser:  { access_token: <that verified ID token>, token_type: "Bearer", expires_in }
 *
 * The ID token is what the rest of EOI already accepts as the bearer credential: its `iss` + `sub` are the identity, and the membership /
 * role / permission model decides everything else. The provider's own access token (which may be opaque), any refresh token and every profile
 * field are DISCARDED here. Every failure is one generic answer: no provider message, status body, token or secret is ever returned or logged.
 */
const FAILED = () => new AppError("Sign-in could not be completed", 400, { code: "SIGNIN_EXCHANGE_FAILED" });
const UNAVAILABLE = () => new AppError("The sign-in service is temporarily unavailable", 503, { code: "AUTH_PROVIDER_UNAVAILABLE" });
const NOT_CONFIGURED = () => new AppError("Sign-in is not available", 503, { code: "SIGNIN_EXCHANGE_NOT_CONFIGURED" });

const CODE_RE = /^[\x21-\x7E]{1,2048}$/; // printable, no whitespace
const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/; // RFC 7636

export function createOidcExchangeService({
  resolveConfig = () => resolveExchangeConfig(),
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  getVerifier = getIdTokenVerifier,
  findUser = (issuer, subject) => User.findOne({ issuer, subject }, { _id: 1 }).lean(),
  logger = console,
} = {}) {
  let cachedEndpoint = null;
  let cachedAt = 0;
  let failedAt = 0;
  let cachedKey = "";

  async function tokenEndpointFor(config) {
    const key = `${config.issuer}`;
    if (cachedEndpoint && cachedKey === key && now() - cachedAt < 600_000) return cachedEndpoint;
    if (failedAt && now() - failedAt < 5000) throw UNAVAILABLE();
    try {
      const response = await fetchImpl(`${config.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(config.httpTimeoutMs), headers: { accept: "application/json" }, redirect: "error" });
      if (!response.ok) throw new Error("discovery failed");
      const document = await response.json();
      if (!document || document.issuer !== config.issuer || typeof document.token_endpoint !== "string") throw new Error("discovery mismatch"); // issuer-mix-up defence
      const url = new URL(document.token_endpoint);
      const loopbackHttp = url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname) && isDevelopmentOrTestMode();
      if (url.protocol !== "https:" && !loopbackHttp) throw new Error("token endpoint is not https");
      cachedEndpoint = url.toString();
      cachedAt = now();
      cachedKey = key;
      failedAt = 0;
      return cachedEndpoint;
    } catch {
      failedAt = now();
      throw UNAVAILABLE();
    }
  }

  async function exchange(input) {
    const resolved = resolveConfig();
    if (!resolved.enabled) throw NOT_CONFIGURED();
    const { config } = resolved;
    const verify = getVerifier();
    if (!verify) throw NOT_CONFIGURED();

    const code = input?.code;
    const verifier = input?.code_verifier;
    const redirectUri = input?.redirect_uri;
    if (typeof code !== "string" || !CODE_RE.test(code) || typeof verifier !== "string" || !VERIFIER_RE.test(verifier) || typeof redirectUri !== "string") throw FAILED();
    // The redirect URI is checked against the server's own EXACT list BEFORE the provider is contacted; the browser cannot pick another one.
    if (!config.redirectUris.includes(redirectUri)) throw FAILED();

    const tokenEndpoint = await tokenEndpointFor(config);
    let body;
    try {
      const response = await fetchImpl(tokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri, client_id: config.clientId, client_secret: config.clientSecret }).toString(),
        signal: AbortSignal.timeout(config.httpTimeoutMs),
        redirect: "error", // never follow a redirect with the secret in the request
      });
      if (!response.ok) {
        // 4xx = the provider refused THIS code (invalid / used / PKCE mismatch / wrong client): a failed sign-in. 5xx = the provider is down.
        throw response.status >= 500 ? UNAVAILABLE() : FAILED();
      }
      body = await response.json();
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw UNAVAILABLE(); // network failure / timeout / abort
    }

    const idToken = body?.id_token;
    if (typeof idToken !== "string" || idToken.length === 0) throw FAILED();
    let identity;
    try {
      identity = await verify(idToken); // issuer, audience, signature, algorithm, exp, iat, sub - the same verifier as every API request
    } catch (error) {
      throw error instanceof AppError && error.statusCode === 503 ? UNAVAILABLE() : FAILED();
    }
    const expiresInSeconds = Math.floor((identity.expiresAt.getTime() - now()) / 1000);
    if (!(expiresInSeconds > 0)) throw FAILED();

    // Development/test convenience for the operator: say which identity just signed in when EOI has no User for it (so it can be provisioned).
    // Never in production, never any token or secret.
    if (isDevelopmentOrTestMode() && resolveAuthConfig().provider === "oidc") {
      try {
        if (!(await findUser(identity.issuer, identity.subject))) {
          // With self-registration on, the person sets up their own account in the app: no operator step. Otherwise an operator provisions it.
          logger.info(selfRegistrationEnabled()
            ? "[KOI API] dev: a verified sign-in has no EOI account yet; the person can set one up in the app (self-registration is on)."
            : `[KOI API] dev: a verified sign-in has no EOI user yet (subject ${identity.subject}). Provision it: node scripts/provision-user.mjs --subject ${identity.subject} --workspace <id|slug> --role <role>`);
        }
      } catch {
        /* a hint only */
      }
    }
    return { idToken, expiresInSeconds, identity };
  }

  return { exchange };
}

export const oidcExchangeService = createOidcExchangeService();
