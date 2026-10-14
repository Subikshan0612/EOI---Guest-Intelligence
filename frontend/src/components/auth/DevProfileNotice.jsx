import { isAuthEnabled } from "../../services/auth/oidc/oidcSession";

/**
 * DEVELOPMENT BUILDS ONLY (the whole body is behind `import.meta.env.DEV`, so it is removed from a production bundle). When real sign-in is not configured
 * - the plain `npm run dev` profile - there is deliberately no Sign in or Sign out control; this says so and where the Google profile is, instead of leaving a
 * developer looking at an app with no way to sign in.
 */
export default function DevProfileNotice() {
  if (!import.meta.env.DEV || isAuthEnabled) return null;
  return (
    <p className="dev-profile-notice" role="note">
      Development profile: sign-in is not configured here, so there is no Sign in or Sign out. For Google sign-in run <code>npm run dev:google</code> in both <code>backend</code> and{" "}
      <code>frontend</code>, then open <code>http://localhost:5175</code>.
    </p>
  );
}
