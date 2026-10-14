import { useEffect, useRef } from "react";
import { useAuthSession } from "../../hooks/useAuthSession";
import SignInButton from "./SignInButton";

/**
 * Every "you are not in the application right now" screen: the welcome screen, signed out, a session that expired, a sign-in that was cancelled or did not
 * complete, no connection, and an account EOI will not let in. Plain product language only: no error code, provider message, address, identifier or
 * setting is ever shown here (the wording is fixed in services/auth/authSession.js).
 *
 * There is ONE way in - the sign-in provider ("Continue with Google"). EOI has no passwords of its own. Whether the person already has an EOI workspace is
 * decided AFTER they sign in (the server knows): a new person is taken through a short setup, an existing one goes straight to the application.
 */
export default function AuthScreen() {
  const { reason, title, detail, canSignIn, signInLabel, signingIn, signingInLabel, signOut, unified, showSignIn } = useAuthSession();
  const heading = useRef(null);
  useEffect(() => {
    heading.current?.focus();
  }, [reason]);

  const entry = reason === "welcome" || reason === "signedOut";
  const closingSession = reason === "signingOut"; // the server is being asked to end the session: nothing to press yet
  const signOutUnconfirmed = reason === "signOutFailed"; // it could not be confirmed: say so, and offer to try again
  const informational = entry || signingIn || closingSession;
  const needsSignOut = reason === "accessRestricted" || reason === "accountDisabled";
  const buttonLabel =
    reason === "callbackFailed" || reason === "cancelled" || reason === "networkFailed" || reason === "signInUnavailable"
      ? "Try sign in again"
      : reason === "expired" || reason === "rejected" || reason === "missing"
        ? "Sign in again"
        : signInLabel;

  return (
    <main className="auth-screen">
      <section className="koi-card auth-card" role={informational ? "status" : "alert"} aria-labelledby="auth-screen-title">
        <p className="auth-brand">EOI</p>
        <h1 className="page-title" id="auth-screen-title" ref={heading} tabIndex={-1}>
          {title}
        </h1>
        <p className="page-lead">{detail}</p>
        {closingSession ? null : signOutUnconfirmed ? (
          <button type="button" className="primary-button" onClick={signOut}>
            Try signing out again
          </button>
        ) : needsSignOut ? (
          <button type="button" className="primary-button" onClick={signOut}>
            Sign out
          </button>
        ) : unified ? (
          // Unified EOI session: "sign in again" / "try again" returns to the sign-in PAGES (email + password and Google), not straight to Google.
          <button type="button" className="primary-button" onClick={showSignIn}>
            {buttonLabel}
          </button>
        ) : canSignIn ? (
          <SignInButton label={buttonLabel} />
        ) : null}
        {signingIn ? (
          <p className="muted auth-note" role="status">
            {signingInLabel}
          </p>
        ) : null}
        {entry && canSignIn && !signingIn ? (
          <p className="muted auth-note">New to EOI? Continue with Google and we&apos;ll help you set up your workspace.</p>
        ) : null}
      </section>
    </main>
  );
}
