import { useAuthSession } from "../../hooks/useAuthSession";
import SignInButton from "./SignInButton";

/**
 * The "Try again" action of an error block. When the session has ended a retry cannot succeed (authenticated requests are not sent until the
 * user signs in again), so the same place offers the sign-in action instead of a button that would only fail again.
 */
export default function RetryButton({ onClick, children = "Try again", className = "text-button" }) {
  const { sessionEnded, canSignIn } = useAuthSession();
  if (sessionEnded && canSignIn) return <SignInButton className="text-button" />;
  return (
    <button type="button" className={className} onClick={onClick}>
      {children}
    </button>
  );
}
