import { useAuthSession } from "../../hooks/useAuthSession";

/**
 * The ONE "sign in" action: it starts the existing sign-in flow. Renders nothing when sign-in is not available in this build. While the browser is being
 * sent to the provider the button is disabled and marked busy, so a second press cannot start a second sign-in and the click is never silent.
 */
export default function SignInButton({ label = "Sign in again", className = "primary-button" }) {
  const { canSignIn, signIn, signingIn } = useAuthSession();
  if (!canSignIn) return null;
  return (
    <button type="button" className={className} onClick={signIn} disabled={signingIn} aria-busy={signingIn ? "true" : undefined}>
      {label}
    </button>
  );
}
