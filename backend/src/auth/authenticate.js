import { User } from "../models/User.js";
import { AppError } from "../utils/AppError.js";
import { AuthError, invalidToken, normalizeVerifiedIdentity } from "./tokenContract.js";
import { getTokenVerifier } from "./tokenVerifier.js";

/**
 * Bearer-token authentication -> `req.actor`.
 *
 *   Authorization: Bearer <token>
 *     -> token verifier (provider-agnostic, see tokenVerifier.js)
 *     -> verified identity { issuer, subject, email?, expiresAt }
 *     -> User looked up by issuer + subject (never by email)
 *     -> req.actor { userId, issuer, subject, email, workspaceId: null, role: null }
 *
 * `workspaceId` and `role` stay null here: they come from a WORKSPACE MEMBERSHIP
 * and are added by resolveWorkspaceActor (membership.js). Nothing is read from
 * any other header, the query string or the body: not a user id, not a role, not
 * a knowledge level. `req.actor` is request-scoped and never persisted.
 *
 * Unknown identity: a VALID token whose issuer + subject match no User gets 403
 * IDENTITY_NOT_REGISTERED on every DATA route. It is authenticated but has no EOI
 * account; authentication never creates a user or a membership by itself. An account
 * comes into being only through an operator (scripts/provision-user.mjs) or - when a
 * deployment enables KOI_SELF_REGISTRATION - the explicit account-setup call
 * (services/accountService.js), which creates the person's OWN new workspace and
 * never membership in an existing one. A disabled user gets 403 USER_DISABLED,
 * checked on every request so revocation is immediate.
 */

const BEARER = /^Bearer ([^\s]+)$/i;

function reject(res, error) {
  if (error.statusCode === 401 && res) res.set("WWW-Authenticate", "Bearer");
  return error;
}

function parseBearer(header) {
  const match = typeof header === "string" ? BEARER.exec(header.trim()) : null;
  if (!match) throw new AuthError("The Authorization header must be: Bearer <token>", 401, "MALFORMED_AUTHORIZATION");
  return match[1];
}

/** Verifies the bearer token and returns the VERIFIED identity { issuer, subject, email?, expiresAt }. No User lookup: who the person is, nothing more. */
async function verifiedIdentityFromRequest(req, { now }) {
  const token = parseBearer(req.headers.authorization);

  const verifier = getTokenVerifier();
  if (!verifier) throw new AppError("Authentication is not configured on this server", 503, { code: "AUTH_NOT_CONFIGURED" });

  let identity;
  try {
    identity = normalizeVerifiedIdentity(await verifier(token));
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw invalidToken(); // never surface a verifier's internal error
  }
  if (identity.expiresAt.getTime() <= now()) throw new AuthError("The access token has expired", 401, "TOKEN_EXPIRED");
  return identity;
}

async function actorFromRequest(req, { now }) {
  const identity = await verifiedIdentityFromRequest(req, { now });

  // An EOI session token names the user directly (its `sub` is the EOI user id); a provider token is matched by issuer + subject - never by email.
  const user = identity.userId ? await User.findById(identity.userId).lean() : await User.findOne({ issuer: identity.issuer, subject: identity.subject }).lean();
  if (!user) throw new AuthError("This identity is not registered with EOI", 403, "IDENTITY_NOT_REGISTERED");
  if (user.status !== "active") throw new AuthError("This user is disabled", 403, "USER_DISABLED");

  return {
    userId: String(user._id),
    issuer: user.issuer,
    subject: user.subject,
    email: user.email ?? null,
    workspaceId: null,
    role: null,
  };
}

function build({ required, now = () => Date.now() }) {
  return async function authenticate(req, res, next) {
    try {
      req.actor = undefined; // an actor can only ever come from this function
      if (req.headers.authorization === undefined) {
        if (required) throw new AuthError("Authentication is required", 401, "MISSING_CREDENTIAL");
        return next();
      }
      // A credential that IS supplied is never ignored, even on an optional route.
      req.actor = await actorFromRequest(req, { now });
      return next();
    } catch (error) {
      return next(reject(res, error));
    }
  };
}

/** Requires a valid bearer token. */
export const authenticate = build({ required: true });

/**
 * Phase 45C - IDENTITY-ONLY authentication, for the account/onboarding endpoints and NOTHING else.
 *
 * It verifies the bearer token exactly as `authenticate` does (issuer, audience, signature, algorithm, expiry) and sets `req.identity`
 * = { issuer, subject, email? } - who the person is - WITHOUT requiring an EOI User to exist. That is the point: a brand-new Google
 * identity must be able to ask "what is my account state?" and "set up my account". It sets NO `req.actor` (so no workspace, no role,
 * no permission): every data route still uses `authenticate` + membership + permission, and an identity that only passed THIS
 * middleware gets nothing from them. The identity always comes from the verified token, never from a header, query or body.
 */
export function authenticateIdentity(req, res, next) {
  req.actor = undefined;
  req.identity = undefined;
  if (req.headers.authorization === undefined) return next(reject(res, new AuthError("Authentication is required", 401, "MISSING_CREDENTIAL")));
  verifiedIdentityFromRequest(req, { now: () => Date.now() }).then(
    ({ issuer, subject, email, userId }) => {
      req.identity = Object.freeze({ issuer, subject, email: email ?? null, ...(userId ? { userId } : {}) });
      next();
    },
    (error) => next(reject(res, error)),
  );
}

/** No credential -> no actor. A supplied but invalid credential is still rejected. */
export const optionalAuthenticate = build({ required: false });

export { build as createAuthenticator };
