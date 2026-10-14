/**
 * Consistency check of the LOCAL GOOGLE PROFILE (Phase 45B.4.1): backend/.env and frontend/.env must describe the same sign-in, or the app
 * looks "broken" in confusing ways (a frontend on 5175 talking to the normal backend on 5000, a redirect URI that does not match the exchange allow-list, a
 * CORS origin that is not the frontend's, an authority that is not the issuer the backend trusts ...). Pure: it takes the two parsed env objects and returns
 * a list of problems. It never returns or prints a value that could be a secret (only variable NAMES and, for ports/origins, the non-secret address parts).
 */
const portOf = (value) => { try { const u = new URL(value); return u.port || (u.protocol === "https:" ? "443" : "80"); } catch { return null; } };
const originOf = (value) => { try { return new URL(value).origin; } catch { return null; } };
const trimSlash = (v) => String(v ?? "").trim().replace(/\/+$/, "");

export function checkGoogleProfile(backend = {}, frontend = {}) {
  const problems = [];
  const need = (obj, names, label) => { for (const n of names) if (!String(obj[n] ?? "").trim()) problems.push(`${label} is missing ${n}`); };
  need(backend, ["PORT", "CLIENT_URL", "AUTH_PROVIDER", "OIDC_ISSUER", "OIDC_AUDIENCE", "OIDC_EXCHANGE_CLIENT_ID", "OIDC_EXCHANGE_CLIENT_SECRET", "OIDC_EXCHANGE_REDIRECT_URIS"], "backend/.env");
  need(frontend, ["VITE_API_BASE_URL", "VITE_OIDC_AUTHORITY", "VITE_OIDC_CLIENT_ID", "VITE_OIDC_REDIRECT_URI", "VITE_OIDC_TOKEN_EXCHANGE_URL"], "frontend/.env");
  if (problems.length > 0) return problems;

  const provider = String(backend.AUTH_PROVIDER).toLowerCase();
  if (provider !== "oidc" && provider !== "eoi") problems.push("backend AUTH_PROVIDER must be oidc or eoi");
  // Phase 46: the unified EOI session (email + password and Google behind one session) needs a session secret on the backend and the same switch on the frontend.
  const unifiedFrontend = String(frontend.VITE_KOI_AUTH ?? "").toLowerCase() === "eoi";
  if (provider === "eoi" && !backend.KOI_SESSION_SECRET) problems.push("backend KOI_SESSION_SECRET is required with AUTH_PROVIDER=eoi");
  if (provider === "eoi" && !unifiedFrontend) problems.push("the backend uses AUTH_PROVIDER=eoi but the frontend profile has no VITE_KOI_AUTH=eoi");
  if (provider === "oidc" && unifiedFrontend) problems.push("the frontend profile sets VITE_KOI_AUTH=eoi but the backend AUTH_PROVIDER is not eoi");
  if (trimSlash(frontend.VITE_OIDC_AUTHORITY) !== trimSlash(backend.OIDC_ISSUER)) problems.push("the frontend authority (VITE_OIDC_AUTHORITY) is not the issuer the backend trusts (OIDC_ISSUER)");
  if (frontend.VITE_OIDC_CLIENT_ID !== backend.OIDC_EXCHANGE_CLIENT_ID) problems.push("the frontend client id (VITE_OIDC_CLIENT_ID) differs from the backend's (OIDC_EXCHANGE_CLIENT_ID)");
  if (!String(backend.OIDC_AUDIENCE).split(",").map((v) => v.trim()).includes(backend.OIDC_EXCHANGE_CLIENT_ID)) problems.push("OIDC_EXCHANGE_CLIENT_ID is not listed in OIDC_AUDIENCE");
  const redirects = String(backend.OIDC_EXCHANGE_REDIRECT_URIS).split(",").map((v) => v.trim());
  if (!redirects.includes(frontend.VITE_OIDC_REDIRECT_URI)) problems.push("the frontend redirect URI (VITE_OIDC_REDIRECT_URI) is not in the backend's OIDC_EXCHANGE_REDIRECT_URIS");
  if (originOf(frontend.VITE_OIDC_REDIRECT_URI) !== trimSlash(backend.CLIENT_URL)) problems.push("the backend CORS origin (CLIENT_URL) is not the frontend's origin (the origin of VITE_OIDC_REDIRECT_URI)");
  if (portOf(frontend.VITE_API_BASE_URL) !== String(backend.PORT)) problems.push(`the frontend API base (VITE_API_BASE_URL) points at port ${portOf(frontend.VITE_API_BASE_URL)}, but the Google backend listens on ${backend.PORT}`);
  if (originOf(frontend.VITE_OIDC_TOKEN_EXCHANGE_URL) !== originOf(frontend.VITE_API_BASE_URL)) problems.push("the token-exchange URL (VITE_OIDC_TOKEN_EXCHANGE_URL) is not on the same backend as VITE_API_BASE_URL");
  if (!new URL(frontend.VITE_OIDC_TOKEN_EXCHANGE_URL).pathname.endsWith("/auth/oidc/token")) problems.push("VITE_OIDC_TOKEN_EXCHANGE_URL does not end with /auth/oidc/token");
  // The Google profile must not collide with the normal development profile (frontend 5174 / backend 5000), or one would silently talk to the other.
  if (String(backend.PORT) === "5000") problems.push("the Google backend must not use the normal backend's port 5000");
  if (portOf(frontend.VITE_OIDC_REDIRECT_URI) === "5174") problems.push("the Google frontend must not use the normal frontend's port 5174");
  const secretNames = Object.keys(frontend).filter((k) => /SECRET|PRIVATE|PASSWORD/i.test(k));
  if (secretNames.length > 0) problems.push(`frontend/.env must hold public values only (remove ${secretNames.join(", ")})`);
  return problems;
}
