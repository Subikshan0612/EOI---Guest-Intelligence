import { AppError } from "../utils/AppError.js";

/**
 * The verified-identity contract: the ONLY thing the rest of EOI knows about
 * how a caller was authenticated.
 *
 * A token verifier (a future OIDC/JWKS one, or the development stub) receives a
 * raw bearer token and must return - or throw - so that EOI sees exactly:
 *
 *   {
 *     issuer:    string   the token's `iss`; who vouched for the identity
 *     subject:   string   the token's `sub`; stable id within that issuer
 *     email:     string?  the token's `email`, an ATTRIBUTE only (never a key)
 *     expiresAt: Date     the token's `exp`
 *   }
 *
 * The verifier itself is responsible for what makes a token trustworthy: the
 * signature, an allow-list of issuers, audience, and `exp`. EOI then
 *
 *   - keeps ONLY these four fields (anything else in the token is dropped);
 *   - identifies the person by issuer + subject, never by email;
 *   - re-checks that the token has not expired (defence in depth).
 *
 * Token claims can NEVER define a role, a permission, a workspace or a
 * knowledge level. Those come only from MongoDB (membership) plus the
 * server-side role map in roles.js. A token that carries such claims is not
 * rejected, but they are ignored - they never reach `req.actor`.
 */

const MAX_CLAIM_LENGTH = 512;
const MAX_EMAIL_LENGTH = 320;

export class AuthError extends AppError {
  constructor(message, statusCode, code) {
    super(message, statusCode, { code });
    this.name = "AuthError";
    this.code = code;
  }
}

export const invalidToken = (message = "The access token is not valid") => new AuthError(message, 401, "INVALID_TOKEN");

const nonEmptyString = (value) => typeof value === "string" && value.trim().length > 0 && value.length <= MAX_CLAIM_LENGTH;

/**
 * Validates the shape a verifier returned and reduces it to the contract.
 * Throws a 401 AuthError if anything required is missing or malformed.
 */
export function normalizeVerifiedIdentity(raw) {
  if (!raw || typeof raw !== "object") throw invalidToken();
  const { issuer, subject, email, expiresAt, userId, sessionId, emailVerified } = raw;
  if (!nonEmptyString(issuer) || !nonEmptyString(subject)) throw invalidToken();
  const expiry = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  if (Number.isNaN(expiry.getTime())) throw invalidToken();

  const identity = { issuer: issuer.trim(), subject: subject.trim(), expiresAt: expiry };
  // Only the EOI session verifier (eoiTokenVerifier.js) vouches for an EOI user id and session id; a provider token can never supply them.
  if (typeof userId === "string" && /^[0-9a-f]{24}$/.test(userId)) identity.userId = userId;
  if (typeof sessionId === "string" && /^[0-9a-f]{24}$/.test(sessionId)) identity.sessionId = sessionId;
  if (emailVerified === true) identity.emailVerified = true;
  if (typeof email === "string" && email.trim() && email.length <= MAX_EMAIL_LENGTH) {
    identity.email = email.trim().toLowerCase();
  }
  return identity;
}
