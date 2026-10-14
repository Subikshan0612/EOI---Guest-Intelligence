import { useAuthSession } from "../../hooks/useAuthSession";
import SignInButton from "./SignInButton";

/**
 * Shown above the page when the session ended while the app was open (expired, rejected or missing). The page underneath is left as it
 * is; authenticated requests are not sent until the user signs in again, so there is nothing to retry in the meantime.
 */
export default function SessionNotice() {
  const { sessionEnded, message, canSignIn } = useAuthSession();
  if (!sessionEnded) return null;
  return (
    <div className="session-notice" role="alert">
      <p className="session-notice-text">{message}</p>
      <SignInButton />
      {!canSignIn && import.meta.env.DEV ? (
        <p className="muted session-notice-dev">Development build: no sign-in is configured, so the development access token must be reissued and the page reloaded.</p>
      ) : null}
    </div>
  );
}
