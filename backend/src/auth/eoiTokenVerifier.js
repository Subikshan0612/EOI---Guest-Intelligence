import { isSessionLive } from "../services/authSessionService.js";
import { EOI_ISSUER, verifyAccessToken } from "./eoiTokens.js";
import { invalidToken, AuthError } from "./tokenContract.js";
import { errors } from "jose";

/**
 * The token verifier for AUTH_PROVIDER=eoi (Phase 46): it plugs into the same provider-agnostic seam as the OIDC and stub verifiers (tokenVerifier.js).
 *
 *   token -> signature (HS256 only), issuer, audience, typ, exp, jti  (eoiTokens.js)
 *         -> the SESSION behind it (`sid`) is live: it exists, is not revoked and has not expired      (one indexed read per request)
 *         -> { issuer: "eoi", subject: <user id>, userId, sessionId, expiresAt }
 *
 * The identity it returns carries no role, permission or workspace; authenticate.js then loads the User by id (status checked on every request) and
 * membership.js resolves workspace + role from the database. Every failure is one of two generic 401s (expired / not valid): nothing says WHICH check failed.
 */
export function createEoiTokenVerifier(config, { now = () => Date.now() } = {}) {
  return async function verifyEoiAccessToken(token) {
    let payload;
    try {
      payload = await verifyAccessToken(token, { secret: config.secret, now: now() });
    } catch (error) {
      if (error instanceof errors.JWTExpired) throw new AuthError("The access token has expired", 401, "TOKEN_EXPIRED");
      throw invalidToken();
    }
    if (!/^[0-9a-f]{24}$/.test(payload.sub) || !(await isSessionLive(payload.sid, payload.sub, now()))) throw invalidToken();
    return { issuer: EOI_ISSUER, subject: payload.sub, userId: payload.sub, sessionId: payload.sid, expiresAt: new Date(payload.exp * 1000) };
  };
}
