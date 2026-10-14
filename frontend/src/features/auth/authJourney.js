/**
 * The ONE answer to "which screen is the person on?" for the whole sign-in journey.
 *
 * Two small stores already hold the facts: the sign-in session (services/auth/authSession.js: ready / sessionEnded / blocked + a reason + whether sign-in is
 * starting) and the account step (hooks/useAccountSession.js: checking / ready / needsSetup / failed + whether a workspace is being created). This pure
 * function folds them into exactly ONE named state, and the application gate renders exactly one screen for it, so contradictory screens (signed out + a
 * dashboard, signed in + a sign-in screen, onboarding + a dashboard, ...) cannot be drawn.
 *
 *   SIGNED_OUT           nobody is signed in: the welcome screen
 *   AUTHENTICATING       the person pressed "Continue with Google" and the browser is going to the provider
 *   CHECKING_ACCOUNT     signed in; asking EOI what it knows about the person
 *   ONBOARDING           a new person: the "name your workspace" step
 *   CREATING_WORKSPACE   that step was submitted; the workspace is being created
 *   AUTHENTICATED        signed in and in one of their own workspaces: the application
 *   AUTH_ERROR           sign-in did not complete (cancelled, failed, no connection, unavailable) or the account could not be loaded: retry
 *   LINKING              a Google sign-in must be connected to the person's existing EOI account by proving that account's password
 *   ACCOUNT_UNAVAILABLE  EOI will not let this account in (disabled, or access must be granted by an administrator)
 *   SESSION_EXPIRED      the session ended while signed in: sign in again
 *
 * Provider-side progress before the page loads (the redirect, the code exchange) is the framework-free "Signing you in..." notice in main.jsx.
 */
export const JOURNEY = Object.freeze({
  SIGNED_OUT: "SIGNED_OUT",
  AUTHENTICATING: "AUTHENTICATING",
  CHECKING_ACCOUNT: "CHECKING_ACCOUNT",
  ONBOARDING: "ONBOARDING",
  CREATING_WORKSPACE: "CREATING_WORKSPACE",
  AUTHENTICATED: "AUTHENTICATED",
  AUTH_ERROR: "AUTH_ERROR",
  LINKING: "LINKING",
  ACCOUNT_UNAVAILABLE: "ACCOUNT_UNAVAILABLE",
  SESSION_EXPIRED: "SESSION_EXPIRED",
});

const SIGNED_OUT_REASONS = new Set(["welcome", "signedOut", "missing"]);
const EXPIRED_REASONS = new Set(["expired", "rejected"]);
const UNAVAILABLE_REASONS = new Set(["accessRestricted", "accountDisabled"]);

/**
 * @param {{ status: string, reason: string|null, signingIn?: boolean }} auth   the sign-in session (getAuthState())
 * @param {{ state: 'checking'|'ready'|'needsSetup'|'failed', busy?: boolean }} account   the account step
 */
export function deriveJourney(auth, account) {
  const { status, reason, signingIn = false } = auth;

  if (status === "blocked") {
    if (SIGNED_OUT_REASONS.has(reason)) return signingIn ? JOURNEY.AUTHENTICATING : JOURNEY.SIGNED_OUT;
    if (UNAVAILABLE_REASONS.has(reason)) return JOURNEY.ACCOUNT_UNAVAILABLE;
    if (reason === "linkRequired") return signingIn ? JOURNEY.AUTHENTICATING : JOURNEY.LINKING;
    if (EXPIRED_REASONS.has(reason)) return signingIn ? JOURNEY.AUTHENTICATING : JOURNEY.SESSION_EXPIRED;
    return signingIn ? JOURNEY.AUTHENTICATING : JOURNEY.AUTH_ERROR;
  }

  if (status === "sessionEnded") {
    // The session ended while signed in. "Missing" (no usable token) reads as expired to the person: there is nothing to retry, only to sign in again.
    return signingIn ? JOURNEY.AUTHENTICATING : JOURNEY.SESSION_EXPIRED;
  }

  // status === 'ready': the sign-in is fine; the account step decides.
  switch (account.state) {
    case "checking":
      return JOURNEY.CHECKING_ACCOUNT;
    case "needsSetup":
      return account.busy ? JOURNEY.CREATING_WORKSPACE : JOURNEY.ONBOARDING;
    case "failed":
      return JOURNEY.AUTH_ERROR;
    default:
      return JOURNEY.AUTHENTICATED;
  }
}
