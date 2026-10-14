import { sanitizeReturnPath } from "../../services/auth/oidc/oidcFlow";

/**
 * Where the person was going when they had to sign in (deep-link restoration for the sign-in PAGES, Phase 46). Memory only - never a query parameter, never
 * storage - and recorded by the application from its OWN location, then restricted to a same-origin internal path (sanitizeReturnPath), so a link cannot make
 * the app send a signed-in person to another site.
 */
let intended = null;
const AUTH_PATHS = new Set(["/signin", "/signup", "/forgot-password", "/reset-password", "/verify-email"]);

export function rememberIntendedPath(pathWithQuery, origin = globalThis.window?.location?.origin) {
  const clean = sanitizeReturnPath(pathWithQuery, origin);
  const pathname = clean.split(/[?#]/)[0];
  if (clean === "/" || AUTH_PATHS.has(pathname)) return;
  intended = clean;
}

export const peekIntendedPath = () => intended;

/** The remembered path (once), or "/". */
export function consumeIntendedPath() {
  const value = intended ?? "/";
  intended = null;
  return value;
}

export const isAuthPagePath = (pathname) => AUTH_PATHS.has(pathname);
