import { LogOut } from "lucide-react";
import { useAuthSession } from "../../hooks/useAuthSession";

/**
 * Visible only when real sign-in is in use. Ends the session in this application (not the provider's own session).
 * Below 480px the text is hidden and only the icon shows, so the name is given explicitly (aria-label); the visible text, when shown, is the same words.
 */
export default function SignOutButton() {
  const { canSignOut, signOut } = useAuthSession();
  if (!canSignOut) return null;
  return (
    <button type="button" className="signout-button" aria-label="Sign out" onClick={signOut}>
      <LogOut size={16} strokeWidth={1.75} aria-hidden="true" />
      <span>Sign out</span>
    </button>
  );
}
