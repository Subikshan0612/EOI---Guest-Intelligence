import { resolveAuthConfig } from "../auth/authConfig.js";
import { clearRefreshCookie, readCookie, REFRESH_COOKIE, setRefreshCookie } from "../auth/cookies.js";
import { getAccountSession, registerAccount } from "../services/accountService.js";
import { createSession, refreshSession, revokeByRefreshToken, sessionCookieConfig } from "../services/authSessionService.js";
import { issueLinkTicket, linkGoogleIdentity, resolveGoogleLogin } from "../services/googleLoginService.js";
import { oidcExchangeService } from "../services/oidcExchangeService.js";
import { forgotPassword, resendVerification, resetPassword, signIn, signUp, verifyEmail } from "../services/passwordAuthService.js";
import { AppError } from "../utils/AppError.js";
import { sendSuccess } from "../utils/response.js";

const noStore = (res) => res.set("Cache-Control", "no-store");

/** The browser's view of a new session: the short-lived access token in the body, the refresh token ONLY in the HttpOnly cookie. */
function sendSession(res, session) {
  noStore(res);
  setRefreshCookie(res, sessionCookieConfig(), session.refreshToken, session.refreshMaxAgeSeconds);
  return sendSuccess(res, { status: "signed_in", access_token: session.accessToken, token_type: "Bearer", expires_in: session.expiresIn });
}

/**
 * POST /api/auth/oidc/token - exchanges a browser's authorization code (server side, with the client secret) for a VERIFIED Google ID token, then:
 *   AUTH_PROVIDER=oidc  (compatibility) the verified ID token itself is the bearer, exactly as before.
 *   AUTH_PROVIDER=eoi   the verified Google identity is resolved to an EOI user (googleLoginService.js) and the browser receives an EOI SESSION - the same
 *                       access token + refresh cookie a password sign-in gets - or `link_required` / `access_restricted` (no session).
 */
export async function exchangeOidcCode(req, res) {
  const { idToken, expiresInSeconds, identity } = await oidcExchangeService.exchange(req.body);
  noStore(res);
  if (resolveAuthConfig().provider !== "eoi") return sendSuccess(res, { access_token: idToken, token_type: "Bearer", expires_in: expiresInSeconds });

  const result = await resolveGoogleLogin(identity);
  if (result.kind === "access_restricted") return sendSuccess(res, { status: "access_restricted" });
  if (result.kind === "link_required") return sendSuccess(res, { status: "link_required", link_ticket: await issueLinkTicket(identity, result.userId) });
  return sendSession(res, await createSession({ userId: result.user._id, method: "google" }));
}

export async function googleLink(req, res) {
  return sendSession(res, await linkGoogleIdentity(req.body));
}

export async function postSignUp(req, res) {
  noStore(res);
  return sendSuccess(res, await signUp(req.body), 202);
}

export async function postSignIn(req, res) {
  return sendSession(res, await signIn(req.body));
}

export async function postVerifyEmail(req, res) {
  noStore(res);
  return sendSuccess(res, await verifyEmail(req.body?.token));
}

export async function postResendVerification(req, res) {
  noStore(res);
  return sendSuccess(res, await resendVerification(req.body), 202);
}

export async function postForgotPassword(req, res) {
  noStore(res);
  return sendSuccess(res, await forgotPassword(req.body), 202);
}

export async function postResetPassword(req, res) {
  noStore(res);
  return sendSuccess(res, await resetPassword(req.body));
}

/** POST /api/auth/refresh - the refresh cookie (and only it) -> a new access token and a rotated cookie. A failure also clears the cookie. */
export async function postRefresh(req, res) {
  noStore(res);
  const config = sessionCookieConfig();
  try {
    const session = await refreshSession(readCookie(req, REFRESH_COOKIE));
    if (session.refreshToken) setRefreshCookie(res, config, session.refreshToken, session.refreshMaxAgeSeconds);
    return sendSuccess(res, { status: "signed_in", access_token: session.accessToken, token_type: "Bearer", expires_in: session.expiresIn });
  } catch (error) {
    if (error instanceof AppError && error.statusCode === 401) clearRefreshCookie(res, config);
    throw error;
  }
}

/** POST /api/auth/logout - revokes the session behind the cookie (so every access token of this browser stops working) and clears the cookie. Idempotent. */
export async function postLogout(req, res) {
  noStore(res);
  await revokeByRefreshToken(readCookie(req, REFRESH_COOKIE));
  clearRefreshCookie(res, sessionCookieConfig());
  return sendSuccess(res, { status: "signed_out" });
}

/** GET /api/auth/session - what EOI knows about the VERIFIED identity (read-only): its own workspaces, or what to do next. */
export async function getSession(req, res) {
  noStore(res);
  return sendSuccess(res, await getAccountSession(req.identity));
}

/** POST /api/auth/register - (only when self-registration is enabled) sets up the caller's own account and workspace. */
export async function register(req, res) {
  noStore(res);
  return sendSuccess(res, await registerAccount(req.identity, req.body), 201);
}
