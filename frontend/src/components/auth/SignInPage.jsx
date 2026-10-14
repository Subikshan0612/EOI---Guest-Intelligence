import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { consumeIntendedPath } from "../../features/auth/intendedPath";
import { emailProblem, normalizeEmailInput } from "../../features/auth/validation";
import { useAuthSession } from "../../hooks/useAuthSession";
import { eoiAuth } from "../../services/auth/eoiAuthClient";
import { adoptSession } from "../../services/auth/oidc/oidcSession";
import AuthField from "./AuthField";
import GoogleButton from "./GoogleButton";

/**
 * /signin - email + password, and "Continue with Google" (the SAME EOI session either way). Wording is fixed and plain. A wrong email and a wrong password get the
 * same sentence, so the page can never be used to learn which addresses have accounts. While a request is in flight the form cannot be submitted again.
 */
export default function SignInPage() {
  const navigate = useNavigate();
  const { reason } = useAuthSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState("");
  const [unverified, setUnverified] = useState(false);
  const [resent, setResent] = useState(false);
  const [busy, setBusy] = useState(false);
  const heading = useRef(null);
  const emailRef = useRef(null);
  const passwordRef = useRef(null);
  const sending = useRef(false);
  useEffect(() => {
    heading.current?.focus();
  }, []);

  const submit = async (event) => {
    event.preventDefault();
    if (sending.current) return;
    const next = { email: emailProblem(email), password: password ? "" : "Please enter your password." };
    setErrors(next);
    setFormError("");
    setUnverified(false);
    setResent(false);
    if (next.email || next.password) {
      (next.email ? emailRef : passwordRef).current?.focus();
      return;
    }
    sending.current = true;
    setBusy(true);
    const result = await eoiAuth.signIn({ email: normalizeEmailInput(email), password });
    sending.current = false;
    setBusy(false);
    if (result.ok) {
      adoptSession(result.grant);
      navigate(consumeIntendedPath(), { replace: true });
      return;
    }
    setPassword("");
    setFormError(result.message);
    setUnverified(result.code === "EMAIL_NOT_VERIFIED");
    passwordRef.current?.focus();
  };

  const resend = async () => {
    const problem = emailProblem(email);
    if (problem) return;
    await eoiAuth.resendVerification(normalizeEmailInput(email));
    setResent(true);
  };

  return (
    <main className="auth-screen">
      <section className="koi-card auth-card" aria-labelledby="signin-title">
        <p className="auth-brand">EOI</p>
        <h1 className="page-title" id="signin-title" ref={heading} tabIndex={-1}>
          Welcome back
        </h1>
        {reason === "signedOut" ? (
          <p className="page-lead" role="status">
            You have signed out. Sign in to continue.
          </p>
        ) : (
          <p className="page-lead">Sign in to continue to EOI.</p>
        )}
        <form className="auth-form" onSubmit={submit} noValidate aria-busy={busy ? "true" : undefined}>
          <AuthField id="signin-email" label="Email" type="email" value={email} onChange={setEmail} error={errors.email} autoComplete="username" inputMode="email" disabled={busy} inputRef={emailRef} maxLength={254} />
          <AuthField id="signin-password" label="Password" type="password" value={password} onChange={setPassword} error={errors.password} autoComplete="current-password" disabled={busy} inputRef={passwordRef} maxLength={200} />
          {formError ? (
            <p className="op-form-error" role="alert">
              {formError}
            </p>
          ) : null}
          {unverified ? (
            <p className="muted auth-note">
              {resent ? (
                <span role="status">If your account needs verification, we&apos;ve sent a new link.</span>
              ) : (
                <button type="button" className="text-button auth-switch" onClick={resend}>
                  Send the verification email again
                </button>
              )}
            </p>
          ) : null}
          <button type="submit" className="primary-button" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
          <Link className="auth-link" to="/forgot-password">
            Forgot password?
          </Link>
        </form>
        <GoogleButton />
        <p className="muted auth-note">
          Don&apos;t have an account?{" "}
          <Link className="auth-link" to="/signup">
            Create account
          </Link>
        </p>
      </section>
    </main>
  );
}
