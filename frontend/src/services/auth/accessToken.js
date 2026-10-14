import { DEV_ACCESS_TOKEN } from "../../config/auth";

/**
 * The frontend's ONLY view of authentication: "what access token, if any, do I
 * attach to an authenticated request?". Nothing here knows who issued the token,
 * what is inside it, what role its owner has, or how it was obtained. A future
 * real identity-provider integration replaces the token SOURCE
 * (`setAccessTokenSource`) and nothing that calls `getAccessToken()` changes.
 *
 * The token is an opaque bearer credential. It is never decoded, never trusted
 * for anything in the browser, and never used to decide what the UI allows: the
 * backend verifies it and is the sole authority on identity, workspace
 * membership, role, permissions and knowledge visibility.
 *
 * Storage: MEMORY ONLY. Nothing is written to localStorage, sessionStorage or a
 * cookie. Reloading the page asks the token source again.
 *
 * Default source (development only): the pre-issued token from
 * VITE_DEV_ACCESS_TOKEN (see config/auth.js). It is a token, never a signing
 * secret; the secret exists only on the server.
 */

let source = () => DEV_ACCESS_TOKEN;
let current = null; // a token set explicitly via setAccessToken
let rejected = false; // the server refused the token: do not offer it again this session

const clean = (value) => (typeof value === "string" ? value.trim() : "");

/** Replaces where tokens come from. `fn` returns a token string or a falsy value. */
export function setAccessTokenSource(fn) {
  if (typeof fn !== "function") throw new TypeError("An access-token source must be a function");
  source = fn;
  current = null;
  rejected = false;
}

let refresher = null;
/** Registers how a missing / expired token is renewed (the unified EOI session: the refresh cookie). `fn()` resolves a token string or null. */
export function setTokenRefresher(fn) {
  refresher = typeof fn === "function" ? fn : null;
}
/** True when an expired token can be renewed silently. */
export const canRefreshAccessToken = () => refresher !== null;
/** Renews the token through the registered refresher. Resolves the new token, or null when it cannot be renewed (the caller then ends the session). */
export async function refreshAccessToken() {
  if (!refresher) return null;
  try {
    const token = clean(await refresher());
    if (token) rejected = false;
    return token || null;
  } catch {
    return null;
  }
}

/** The token to attach, or null. Never returns an empty or whitespace token. */
export function getAccessToken() {
  if (rejected) return null;
  return clean(current) || clean(source()) || null;
}

/** Holds a token in memory (e.g. handed over by a future sign-in flow). */
export function setAccessToken(token) {
  current = clean(token) || null;
  rejected = false;
}

/** Forgets the token. Until the source or setAccessToken supplies a new one, none is sent. */
export function clearAccessToken() {
  current = null;
  rejected = true;
}
