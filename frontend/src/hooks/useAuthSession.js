import { useCallback, useSyncExternalStore } from "react";
import { AUTH_STATUS, authDetail, authMessage, authTitle, canSignIn, getAuthState, subscribeAuth } from "../services/auth/authSession";
import { isAuthEnabled, isEoiAuth, isGoogleConfigured, oidcSettings, showSignIn, signIn, signOut } from "../services/auth/oidc/oidcSession";

/**
 * The sign-in lifecycle for the UI (Phase 45B.2): where the session stands, fixed user-facing wording for it, and the two actions.
 * Nothing here exposes a token, an error code or a provider value.
 */
export function useAuthSession() {
  const { status, reason, signingIn } = useSyncExternalStore(subscribeAuth, getAuthState, getAuthState);
  // After signing out, or when the account has no access, offer the provider's account chooser so another account can be used (OIDC `prompt=select_account`).
  const switchAccount = reason === "signedOut" || reason === "accessRestricted" || reason === "accountDisabled";
  // `options` may name where to come back to (the sign-in pages pass the page the person was heading to); the account chooser is requested after a sign-out.
  const signInAgain = useCallback(
    (options) => signIn({ returnTo: switchAccount ? "/" : undefined, prompt: switchAccount ? "select_account" : undefined, ...(options && typeof options === "object" && "returnTo" in options ? { returnTo: options.returnTo } : {}) }),
    [switchAccount],
  );
  return {
    status,
    reason,
    signingIn,
    signingInLabel: oidcSettings.providerLabel ? `Taking you to ${oidcSettings.providerLabel}…` : "Taking you to sign-in…",
    blocked: status === AUTH_STATUS.BLOCKED,
    sessionEnded: status === AUTH_STATUS.SESSION_ENDED,
    title: reason ? authTitle(reason) : null,
    message: reason ? authMessage(reason) : null,
    detail: reason ? authDetail(reason) : null,
    canSignIn: canSignIn(),
    // "Continue with Google" when the build names its provider (a public display label); plain "Continue" otherwise.
    signInLabel: oidcSettings.providerLabel ? `Continue with ${oidcSettings.providerLabel}` : "Continue",
    canSignOut: isAuthEnabled && status !== AUTH_STATUS.BLOCKED,
    // Unified EOI session (email + password + Google): the sign-in PAGES exist, Google is one button on them, and "sign in again" returns to those pages.
    unified: isEoiAuth,
    googleAvailable: isGoogleConfigured,
    showSignIn,
    signIn: signInAgain,
    signOut,
  };
}
