/**
 * The application's view of "am I signed in right now?" - a tiny in-memory store (Phase 45B.2). It holds NO credential and writes
 * nothing to browser storage; the access token stays in accessToken.js / oidcSession.js (memory only).
 *
 *   status 'ready'         the app renders normally
 *   status 'sessionEnded'  the app is still shown but a "sign in again" notice is up: the session expired, was rejected or is missing.
 *                          Authenticated requests are NOT sent while this holds (they fail locally, at once, without a network call),
 *                          so nothing retries an unauthenticated request in a loop.
 *   status 'blocked'       the app is replaced by a sign-in screen: not configured, sign-in not completed, signed out, or sign-in unavailable.
 *
 * `reason` is a closed vocabulary that selects fixed user-facing wording (authMessage). No server message, error code, token, issuer,
 * client id or provider payload ever reaches the screen through this module.
 */
export const AUTH_STATUS = Object.freeze({ READY: "ready", SESSION_ENDED: "sessionEnded", BLOCKED: "blocked" });

export const AUTH_REASON = Object.freeze({
  EXPIRED: "expired",
  REJECTED: "rejected",
  MISSING: "missing",
  SIGNED_OUT: "signedOut",
  // Unified EOI session: the server is being asked to end the session (the person is NOT yet told they are signed out), and the case where it could not be confirmed.
  SIGNING_OUT: "signingOut",
  SIGN_OUT_FAILED: "signOutFailed",
  CALLBACK_FAILED: "callbackFailed",
  // The person cancelled / declined at the provider (a normal outcome, not a failure), and a connection problem while signing in.
  CANCELLED: "cancelled",
  NETWORK_FAILED: "networkFailed",
  SIGN_IN_UNAVAILABLE: "signInUnavailable",
  // A Google sign-in whose verified email belongs to an existing EOI account with a password: the person must prove that password once to connect them.
  LINK_REQUIRED: "linkRequired",
  NOT_CONFIGURED: "notConfigured",
  // A fresh visit (nobody signed in yet): the "Welcome back / Continue with ..." screen.
  WELCOME: "welcome",
  // Signed in, but the SERVER says this account cannot enter yet (decided server-side; the UI only words it).
  ACCESS_RESTRICTED: "accessRestricted",
  ACCOUNT_DISABLED: "accountDisabled",
  ACCOUNT_CHECK_FAILED: "accountCheckFailed",
});

const MESSAGES = Object.freeze({
  expired: "Your session has expired. Please sign in again to continue.",
  // A session the server no longer accepts (revoked, ended elsewhere) reads exactly like one that ran out: the person only needs to sign in again.
  rejected: "Your session has expired. Please sign in again to continue.",
  missing: "Please sign in to continue.",
  signedOut: "You have signed out. Sign in to continue.",
  signingOut: "Signing you out…",
  signOutFailed: "We couldn't confirm that you were signed out, so your session may still be active. Please try again.",
  callbackFailed: "We couldn't complete sign-in. Please try again.",
  cancelled: "Sign-in was cancelled. You can try again whenever you're ready.",
  networkFailed: "We couldn't reach EOI. Check your connection and try again.",
  signInUnavailable: "Sign-in is temporarily unavailable. Please try again.",
  linkRequired: "An EOI account already uses the email on your Google account. Enter its password once to connect them.",
  notConfigured: "Sign-in isn't available right now. Please contact your administrator.",
  welcome: "Sign in to continue to EOI.",
  accessRestricted: "Your account is verified, but this organization requires an administrator to grant you access.",
  accountDisabled: "Your EOI account is currently unavailable. Please contact your administrator.",
  accountCheckFailed: "We couldn't load your account. Please try again.",
});

const TITLES = Object.freeze({
  expired: "Session expired",
  rejected: "Session expired",
  missing: "Sign in required",
  signedOut: "You have signed out",
  signingOut: "Signing out",
  signOutFailed: "Sign-out not confirmed",
  callbackFailed: "Sign-in was not completed",
  cancelled: "Sign-in cancelled",
  networkFailed: "No connection",
  signInUnavailable: "Sign-in is unavailable",
  linkRequired: "Connect your Google account",
  notConfigured: "Authentication is not configured",
  welcome: "Welcome to EOI",
  accessRestricted: "Welcome to EOI",
  accountDisabled: "Account unavailable",
  accountCheckFailed: "Something went wrong",
});

// The sign-in SCREEN has a title (TITLES) and a short body; the body does not repeat the title. Fixed wording only.
const DETAILS = Object.freeze({
  expired: MESSAGES.expired,
  rejected: MESSAGES.rejected,
  missing: MESSAGES.missing,
  signedOut: "Sign in to continue.",
  signingOut: "One moment.",
  signOutFailed: MESSAGES.signOutFailed,
  callbackFailed: MESSAGES.callbackFailed,
  cancelled: MESSAGES.cancelled,
  networkFailed: MESSAGES.networkFailed,
  signInUnavailable: "Please try again in a moment.",
  linkRequired: MESSAGES.linkRequired,
  notConfigured: MESSAGES.notConfigured,
  welcome: "Sign in to continue.",
  accessRestricted: MESSAGES.accessRestricted,
  accountDisabled: MESSAGES.accountDisabled,
  accountCheckFailed: MESSAGES.accountCheckFailed,
});

/** Fixed wording for a reason; an unknown reason falls back to the neutral "please sign in". */
export const authMessage = (reason) => MESSAGES[reason] ?? MESSAGES.missing;
export const authTitle = (reason) => TITLES[reason] ?? TITLES.missing;
export const authDetail = (reason) => DETAILS[reason] ?? DETAILS.missing;

const READY_STATE = Object.freeze({ status: AUTH_STATUS.READY, reason: null, signingIn: false });
let state = READY_STATE;
let tokenRequired = false; // true when sign-in is configured: a missing/expired token means "sign in again", not "send it anyway"
let signInAvailable = false;
const listeners = new Set();

function set(next) {
  const merged = { signingIn: false, ...next };
  if (merged.status === state.status && merged.reason === state.reason && merged.signingIn === state.signingIn) return;
  state = Object.freeze(merged);
  for (const listener of [...listeners]) listener();
}

export const getAuthState = () => state;

export function subscribeAuth(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** True while no authenticated request should be sent (session ended or the app is blocked on a sign-in screen). */
export const isSessionEnded = () => state.status !== AUTH_STATUS.READY;

/** The session ended while the app is on screen. A blocked app stays blocked (its own reason is more specific). */
export function markSessionEnded(reason) {
  if (state.status !== AUTH_STATUS.READY) return;
  set({ status: AUTH_STATUS.SESSION_ENDED, reason });
}

/** Replace the app with a sign-in screen. */
export function blockApp(reason) {
  set({ status: AUTH_STATUS.BLOCKED, reason });
}

/**
 * The person pressed the sign-in button and the browser is about to go to the provider (discovery is a short network request). The sign-in screen shows
 * a busy button meanwhile, so the click is never silent. It ends with the page navigating away, or with blockApp()/markReady() (which clear it).
 */
export function beginSigningIn() {
  if (state.signingIn) return;
  set({ status: state.status, reason: state.reason, signingIn: true });
}

/** A new sign-in succeeded. */
export function markReady() {
  set(READY_STATE);
}

/** Set once at start-up by the sign-in module. */
export function configureAuthLifecycle({ tokenRequired: required = false, signInAvailable: available = false } = {}) {
  tokenRequired = Boolean(required);
  signInAvailable = Boolean(available);
}

export const isTokenRequired = () => tokenRequired;
export const canSignIn = () => signInAvailable;

/** Maps the backend's authentication code on a 401 to a reason. Only the closed set is read; anything else is "rejected". */
export function reasonForUnauthorized(code) {
  if (code === "TOKEN_EXPIRED") return AUTH_REASON.EXPIRED;
  if (code === "MISSING_CREDENTIAL" || code === "MALFORMED_AUTHORIZATION") return AUTH_REASON.MISSING;
  return AUTH_REASON.REJECTED;
}

/** Test seam. */
export function resetAuthSession() {
  state = READY_STATE;
  tokenRequired = false;
  signInAvailable = false;
  listeners.clear();
}
