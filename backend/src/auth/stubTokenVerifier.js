import crypto from "node:crypto";
import { isDevelopmentOrTestMode } from "../config/runtimeMode.js";
import { AuthError, invalidToken } from "./tokenContract.js";

/**
 * DEVELOPMENT / TEST ONLY token verifier. It is NOT an identity provider and
 * proves nothing about a real person: it accepts HS256 tokens signed with a
 * shared secret from the server's own environment. It exists so the identity
 * foundation can be exercised end to end before a real OIDC verifier exists,
 * and it is refused outright when NODE_ENV=production.
 *
 * Its issuer is the fixed, self-describing STUB_ISSUER - it never pretends to be
 * a real external issuer, so a stub identity can never collide with one.
 *
 * A future OIDC/JWKS verifier replaces this by implementing the same
 * `async (token) => { issuer, subject, email?, expiresAt }` signature (see
 * tokenContract.js). Nothing outside src/auth depends on this file.
 */
export const STUB_ISSUER = "eoi-dev-stub";
export const STUB_MIN_SECRET_LENGTH = 16;

const b64url = (input) => Buffer.from(input).toString("base64url");
const notExplicitDevOrTest = () => !isDevelopmentOrTestMode();

function assertUsable(secret) {
  if (notExplicitDevOrTest()) throw new Error("The development token verifier requires an explicit NODE_ENV=development or NODE_ENV=test (it is refused in production and when NODE_ENV is unset or unknown)");
  if (typeof secret !== "string" || secret.length < STUB_MIN_SECRET_LENGTH) {
    throw new Error(`The development token verifier needs a secret of at least ${STUB_MIN_SECRET_LENGTH} characters`);
  }
}

function sign(signingInput, secret) {
  return crypto.createHmac("sha256", secret).update(signingInput).digest("base64url");
}

/** Signs a development token. `claims` are used as given (tests forge extra claims with it). */
export function signStubToken(claims, secret) {
  assertUsable(secret);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify(claims));
  return `${header}.${payload}.${sign(`${header}.${payload}`, secret)}`;
}

/** @returns {(token: string) => Promise<{issuer: string, subject: string, email?: string, expiresAt: Date}>} */
export function createStubTokenVerifier({ secret, now = () => Date.now() } = {}) {
  assertUsable(secret);

  return async function verifyAccessToken(token) {
    const parts = typeof token === "string" ? token.split(".") : [];
    if (parts.length !== 3 || parts.some((part) => !part)) throw invalidToken();
    const [headerPart, payloadPart, signature] = parts;

    let header;
    let payload;
    try {
      header = JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8"));
      payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
    } catch {
      throw invalidToken();
    }
    // Only HS256, never "none" or anything the token itself asks for.
    if (!header || header.alg !== "HS256") throw invalidToken();

    const expected = Buffer.from(sign(`${headerPart}.${payloadPart}`, secret));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) throw invalidToken();

    if (!payload || typeof payload !== "object") throw invalidToken();
    if (payload.iss !== STUB_ISSUER) throw invalidToken();
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) throw invalidToken();
    if (payload.exp * 1000 <= now()) throw new AuthError("The access token has expired", 401, "TOKEN_EXPIRED");
    if (typeof payload.sub !== "string" || !payload.sub) throw invalidToken();

    return {
      issuer: payload.iss,
      subject: payload.sub,
      email: typeof payload.email === "string" ? payload.email : undefined,
      expiresAt: new Date(payload.exp * 1000),
    };
  };
}
