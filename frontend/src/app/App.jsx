import { BrowserRouter, useLocation } from "react-router-dom";
import AuthRoutes from "../components/auth/AuthRoutes";
import AuthScreen from "../components/auth/AuthScreen";
import LinkGoogleScreen from "../components/auth/LinkGoogleScreen";
import OnboardingScreen from "../components/auth/OnboardingScreen";
import PendingScreen from "../components/auth/PendingScreen";
import ResetPasswordPage from "../components/auth/ResetPasswordPage";
import VerifyEmailPage from "../components/auth/VerifyEmailPage";
import { JOURNEY, deriveJourney } from "../features/auth/authJourney";
import { useAccountSession } from "../hooks/useAccountSession";
import { useAuthSession } from "../hooks/useAuthSession";
import { signOut } from "../services/auth/oidc/oidcSession";
import { LayoutProvider } from "./providers/LayoutProvider";
import { AppRoutes } from "./routes";

/**
 * What the person sees (one screen per journey state, see features/auth/authJourney.js; a session that ends while the app is open replaces the app with the
 * "session expired" screen, and signing in again returns to the same page):
 *   - signed out / expired session / sign-in trouble / "an administrator must grant access" / account disabled -> the sign-in screens (the app is not mounted)
 *   - signed in, the server is being asked what EOI knows about them                                         -> a short loading screen
 *   - a new person and self-service setup is allowed                                                          -> the short onboarding (name your workspace)
 *   - the answer could not be obtained                                                                        -> a retry screen
 *   - otherwise                                                                                               -> the app, in one of THEIR OWN workspaces
 * Nothing is mounted (so no authenticated data request is made) until the person is signed in AND has a workspace.
 */
function AuthGate({ children }) {
  const { status, reason, signingIn, unified } = useAuthSession();
  const account = useAccountSession();
  const { pathname } = useLocation();
  // The two pages an EMAIL LINK opens work whether or not this browser is signed in (the person may click the link anywhere).
  if (unified && pathname === "/verify-email") return <VerifyEmailPage />;
  if (unified && pathname === "/reset-password") return <ResetPasswordPage />;
  // ONE named journey state (features/auth/authJourney.js) selects exactly one screen: no combination of signed-out / signed-in / onboarding / app can overlap.
  const journey = deriveJourney({ status, reason, signingIn }, account);
  switch (journey) {
    case JOURNEY.AUTHENTICATED:
      return children;
    case JOURNEY.CHECKING_ACCOUNT:
      return <PendingScreen text="Loading your account…" />;
    case JOURNEY.ONBOARDING:
    case JOURNEY.CREATING_WORKSPACE:
      return <OnboardingScreen onSubmit={account.setUp} busy={journey === JOURNEY.CREATING_WORKSPACE} onSignOut={signOut} />;
    case JOURNEY.AUTH_ERROR:
      // Signed in but the account could not be loaded (the sign-in's own failures are drawn by AuthScreen, below).
      if (status === "ready") {
        const text = account.unreachable ? "We couldn't reach EOI. Check your connection and try again." : "We couldn't load your account. Please try again.";
        return <PendingScreen text={text} onAction={account.retry} secondaryLabel="Sign out" onSecondary={signOut} />;
      }
      return <AuthScreen />;
    case JOURNEY.LINKING:
      return <LinkGoogleScreen />;
    case JOURNEY.SIGNED_OUT:
    case JOURNEY.AUTHENTICATING:
      // With the unified EOI session these are the sign-in PAGES (/signin, /signup, /forgot-password); otherwise the single Google welcome screen.
      return unified ? <AuthRoutes /> : <AuthScreen />;
    default:
      // SESSION_EXPIRED, ACCOUNT_UNAVAILABLE
      return <AuthScreen />;
  }
}

export default function App() {
  return (
    <BrowserRouter>
      <LayoutProvider>
        <AuthGate>
          <AppRoutes />
        </AuthGate>
      </LayoutProvider>
    </BrowserRouter>
  );
}
