import crypto from "node:crypto";
import { SignJWT, errors, jwtVerify } from "jose";

/**
 * EOI's own signed tokens (Phase 46). Two kinds, both HS256 with DIFFERENT keys derived from KOI_SESSION_SECRET (a ticket can never be used as an access token
 * and vice versa), both with an explicit issuer, audience, `typ` header, expiry and unique id:
 *
 *   ACCESS TOKEN   typ at+jwt, aud eoi-api. Claims: sub = EOI user id, sid = session id, jti, iat, exp. NOTHING ELSE: no email, no role, no permission, no
 *                  workspace. What the person may do is decided on every request from the database (membership + the server-side role map); a token that
 *                  somehow carried such claims would have them ignored. Short-lived (KOI_ACCESS_TOKEN_TTL_SECONDS, default 10 minutes).
 *   LINK TICKET    typ eoi-link+jwt, aud eoi-link, 10 minutes. Issued by the Google code exchange when the verified Google identity's email matches an existing
 *                  PASSWORD account. It carries the Google issuer + subject (+ email) and the matching user id and proves ONLY that "this browser just completed a
 *                  genuine Google sign-in as that identity". By itself it grants nothing: linking additionally needs the account's password.
 *
 * `none` and every other algorithm are refused (the verifier names the one it accepts). The secret never leaves this module's callers' configuration.
 */
const ISSUER = "eoi";
const ACCESS_AUDIENCE = "eoi-api";
const LINK_AUDIENCE = "eoi-link";
const ACCESS_TYP = "at+jwt";
const LINK_TYP = "eoi-link+jwt";
const LINK_TTL_SECONDS = 600;
const ALGORITHMS = ["HS256"];

const keyFor = (secret, label) => crypto.createHmac("sha256", secret).update(`eoi/${label}`).digest();

export const EOI_ISSUER = ISSUER;

export async function signAccessToken({ secret, userId, sessionId, ttlSeconds, now = Date.now() }) {
  const issuedAt = Math.floor(now / 1000);
  return new SignJWT({ sid: String(sessionId) })
    .setProtectedHeader({ alg: "HS256", typ: ACCESS_TYP })
    .setIssuer(ISSUER)
    .setAudience(ACCESS_AUDIENCE)
    .setSubject(String(userId))
    .setJti(crypto.randomBytes(16).toString("base64url"))
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + ttlSeconds)
    .sign(keyFor(secret, "access"));
}

/** @returns the verified payload, or throws a jose error (callers map every failure to one generic 401). */
export async function verifyAccessToken(token, { secret, now = Date.now() }) {
  const { payload } = await jwtVerify(token, keyFor(secret, "access"), {
    issuer: ISSUER,
    audience: ACCESS_AUDIENCE,
    algorithms: ALGORITHMS,
    typ: ACCESS_TYP,
    clockTolerance: 5,
    currentDate: new Date(now),
    requiredClaims: ["sub", "sid", "jti", "iat", "exp"],
  });
  if (typeof payload.sub !== "string" || typeof payload.sid !== "string") throw new errors.JWTInvalid("claims");
  return payload;
}

export async function signLinkTicket({ secret, userId, googleIssuer, googleSubject, googleEmail, now = Date.now() }) {
  const issuedAt = Math.floor(now / 1000);
  return new SignJWT({ gi: googleIssuer, gs: googleSubject, ...(googleEmail ? { ge: googleEmail } : {}) })
    .setProtectedHeader({ alg: "HS256", typ: LINK_TYP })
    .setIssuer(ISSUER)
    .setAudience(LINK_AUDIENCE)
    .setSubject(String(userId))
    .setJti(crypto.randomBytes(16).toString("base64url"))
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + LINK_TTL_SECONDS)
    .sign(keyFor(secret, "link"));
}

export async function verifyLinkTicket(ticket, { secret, now = Date.now() }) {
  const { payload } = await jwtVerify(ticket, keyFor(secret, "link"), {
    issuer: ISSUER,
    audience: LINK_AUDIENCE,
    algorithms: ALGORITHMS,
    typ: LINK_TYP,
    clockTolerance: 5,
    currentDate: new Date(now),
    requiredClaims: ["sub", "gi", "gs", "jti", "exp"],
  });
  if (typeof payload.sub !== "string" || typeof payload.gi !== "string" || typeof payload.gs !== "string") throw new errors.JWTInvalid("claims");
  return payload;
}
