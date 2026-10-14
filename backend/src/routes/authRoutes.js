import express, { Router } from "express";
import { authenticateIdentity } from "../auth/authenticate.js";
import { requireTrustedBrowserRequest } from "../auth/cookies.js";
import {
  exchangeOidcCode,
  getSession,
  googleLink,
  postForgotPassword,
  postLogout,
  postRefresh,
  postResendVerification,
  postResetPassword,
  postSignIn,
  postSignUp,
  postVerifyEmail,
  register,
} from "../controllers/authController.js";
import {
  accountRegisterLimiter,
  accountSessionLimiter,
  oidcExchangeLimiter,
  refreshIpLimiter,
  resetEmailLimiter,
  resetIpLimiter,
  signinEmailLimiter,
  signinIpLimiter,
  signupIpLimiter,
  verifyIpLimiter,
} from "../middleware/rateLimit.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const authRoutes = Router();
const smallJson = () => express.json({ limit: "4kb", strict: true });

// PUBLIC BY NECESSITY: the caller has no credential yet - this is how it gets one. Safeguards: a dedicated client-address rate limit first, a
// small strict JSON body (nothing is parsed before the limit), an EXACT redirect-URI allow-list and PKCE (checked by the provider) so a stolen
// authorization code is useless without its verifier, a server-held client secret, and verification of the returned ID token before it is
// handed on. The endpoint is disabled (503) unless the exchange is fully configured. No identity, role or workspace is decided here.
authRoutes.post("/oidc/token", oidcExchangeLimiter, smallJson(), asyncHandler(exchangeOidcCode));

// ---- Phase 46: email + password and the unified EOI session. All of these are PUBLIC by necessity (no credential exists yet) and each is rate limited by
// client address - and, once the body is parsed, by the hashed email - BEFORE any work is done. None of them reads a user id, role or workspace from the request.
authRoutes.post("/signup", signupIpLimiter, smallJson(), asyncHandler(postSignUp));
authRoutes.post("/signin", signinIpLimiter, smallJson(), signinEmailLimiter, asyncHandler(postSignIn));
authRoutes.post("/verify-email", verifyIpLimiter, smallJson(), asyncHandler(postVerifyEmail));
authRoutes.post("/resend-verification", resetIpLimiter, smallJson(), resetEmailLimiter, asyncHandler(postResendVerification));
authRoutes.post("/forgot-password", resetIpLimiter, smallJson(), resetEmailLimiter, asyncHandler(postForgotPassword));
authRoutes.post("/reset-password", verifyIpLimiter, smallJson(), asyncHandler(postResetPassword));
authRoutes.post("/google/link", signinIpLimiter, smallJson(), asyncHandler(googleLink));
// Cookie-authenticated (the refresh cookie, Path=/api/auth): a trusted-browser check (custom header + Origin) before anything is read.
authRoutes.post("/refresh", refreshIpLimiter, requireTrustedBrowserRequest, asyncHandler(postRefresh));
authRoutes.post("/logout", refreshIpLimiter, requireTrustedBrowserRequest, asyncHandler(postLogout));

// IDENTITY-ONLY (Phase 45C): a verified token is required, an EOI User is NOT (a brand-new identity must be able to ask what to do next).
// authenticateIdentity sets req.identity from the VERIFIED token and no actor/role/workspace; the body is parsed only AFTER authentication and
// the per-identity rate limit. These two routes never read a user id, role or workspace from the request.
authRoutes.get("/session", authenticateIdentity, accountSessionLimiter, asyncHandler(getSession));
authRoutes.post("/register", authenticateIdentity, accountRegisterLimiter, smallJson(), asyncHandler(register));

export { authRoutes };
