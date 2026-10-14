import { useAuthSession } from "../../hooks/useAuthSession";
import { peekIntendedPath } from "../../features/auth/intendedPath";

/**
 * "Continue with Google" on the sign-in / sign-up pages. It starts the existing Google flow (Authorization Code + PKCE, server-side exchange) and asks to come back to the
 * page the person was heading to. Disabled and marked busy while the browser is being sent to Google. Renders nothing when Google sign-in is not configured.
 */
export default function GoogleButton() {
  const { googleAvailable, signIn, signingIn, signingInLabel } = useAuthSession();
  if (!googleAvailable) return null;
  return (
    <>
      <div className="auth-divider" role="separator" aria-label="or">
        <span>or</span>
      </div>
      <button type="button" className="secondary-button auth-google" onClick={() => signIn({ returnTo: peekIntendedPath() ?? "/" })} disabled={signingIn} aria-busy={signingIn ? "true" : undefined}>
        Continue with Google
      </button>
      {signingIn ? (
        <p className="muted auth-note" role="status">
          {signingInLabel}
        </p>
      ) : null}
    </>
  );
}
