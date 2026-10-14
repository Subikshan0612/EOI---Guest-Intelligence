import { env } from "../config/env.js";
import { AuthError } from "./tokenContract.js";

/**
 * The refresh-session cookie (Phase 46). Written and read by hand (a handful of lines; no dependency).
 *
 *   name       koi_rt
 *   value      <session id>.<random secret>      opaque; the server stores only a hash of the secret
 *   HttpOnly   always: no script on the page can read it, so a cross-site-scripting bug cannot steal the session
 *   Secure     true in production (HTTPS only); configurable elsewhere (KOI_COOKIE_SECURE)
 *   SameSite   Lax by default (KOI_COOKIE_SAMESITE: strict | lax | none)
 *   Path       /api/auth  - the cookie is sent ONLY to the authentication endpoints, never to data routes
 *   Max-Age    the session's remaining absolute lifetime
 *
 * CSRF: the cookie authenticates only POST /refresh and POST /logout. Those require BOTH a custom request header (a cross-site page cannot add one without
 * passing CORS, which allows only CLIENT_URL) and, when the browser sends an Origin, that it equals CLIENT_URL. SameSite is a third layer, not the only one.
 */
export const REFRESH_COOKIE = "koi_rt";
export const CSRF_HEADER = "x-koi-request";
const COOKIE_PATH = "/api/auth";

export function readCookie(req, name) {
  const header = req.headers.cookie;
  if (typeof header !== "string" || header.length > 4096) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) {
      const value = part.slice(index + 1).trim();
      return /^[A-Za-z0-9._~-]{20,256}$/.test(value) ? value : null;
    }
  }
  return null;
}

function attributes(config, maxAgeSeconds) {
  const sameSite = { lax: "Lax", strict: "Strict", none: "None" }[config.sameSite] ?? "Lax";
  return `Path=${COOKIE_PATH}; HttpOnly; SameSite=${sameSite}; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}${config.secure ? "; Secure" : ""}`;
}

export function setRefreshCookie(res, config, value, maxAgeSeconds) {
  res.append("Set-Cookie", `${REFRESH_COOKIE}=${value}; ${attributes(config, maxAgeSeconds)}`);
}

export function clearRefreshCookie(res, config) {
  res.append("Set-Cookie", `${REFRESH_COOKIE}=; ${attributes(config, 0)}`);
}

const originOf = (value) => {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
};

/** Express middleware for the cookie-authenticated endpoints. A request that fails it never reaches the handler and never touches the session. */
export function requireTrustedBrowserRequest(req, _res, next) {
  const origin = req.headers.origin;
  const allowed = originOf(env.clientUrl);
  if (req.headers[CSRF_HEADER] !== "1" || (origin !== undefined && (!allowed || originOf(origin) !== allowed))) {
    return next(new AuthError("This request was not accepted", 403, "UNTRUSTED_REQUEST"));
  }
  return next();
}
