import { isProductionMode } from "../config/runtimeMode.js";

/**
 * HTTP security headers for the JSON API (Phase 21). No dependency; every header is justified for an API that returns JSON only
 * and is consumed cross-origin by the React SPA (which is served by its own host and keeps ITS OWN headers/CSP: nothing here is
 * applied to, or can break, the Vite/React application).
 *
 *   X-Content-Type-Options: nosniff            never let a browser sniff a JSON response into something executable
 *   Cache-Control: no-store (+ Pragma)          every response is authenticated or sensitive: no shared/browser cache retention
 *   Referrer-Policy: no-referrer                nothing about this API's URLs (ids in paths/queries) is sent onward
 *   X-Frame-Options: DENY                       an API response is never framed
 *   Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'
 *                                               safe because API responses are data, never rendered pages
 *   Cross-Origin-Opener-Policy: same-origin     isolates the (rare) top-level browsing of an API URL
 *   Permissions-Policy: camera/mic/geolocation off
 *   Strict-Transport-Security (production only) ignored over plain http, honoured behind TLS
 * `X-Powered-By` is removed (`app.disable("x-powered-by")` in app.js). ETag is disabled so responses are never revalidated from cache.
 */
export function securityHeaders(_req, res, next) {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    Pragma: "no-cache",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  });
  if (isProductionMode()) res.set("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  next();
}
