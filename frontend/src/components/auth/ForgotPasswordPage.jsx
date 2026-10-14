import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { emailProblem, normalizeEmailInput } from "../../features/auth/validation";
import { eoiAuth } from "../../services/auth/eoiAuthClient";
import AuthField from "./AuthField";

/** /forgot-password - always the SAME generic answer, so the page cannot be used to learn which addresses have accounts (or whether an account uses Google). */
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const heading = useRef(null);
  const emailRef = useRef(null);
  const sending = useRef(false);
  useEffect(() => {
    heading.current?.focus();
  }, []);

  const submit = async (event) => {
    event.preventDefault();
    if (sending.current) return;
    const problem = emailProblem(email);
    setError(problem);
    if (problem) {
      emailRef.current?.focus();
      return;
    }
    sending.current = true;
    setBusy(true);
    const result = await eoiAuth.forgotPassword(normalizeEmailInput(email));
    sending.current = false;
    setBusy(false);
    if (result.ok || result.status === 429) setDone(true);
    else setError(result.message);
  };

  return (
    <main className="auth-screen">
      <section className="koi-card auth-card" aria-labelledby="forgot-title">
        <p className="auth-brand">EOI</p>
        <h1 className="page-title" id="forgot-title" ref={heading} tabIndex={-1}>
          Reset your password
        </h1>
        {done ? (
          <p className="page-lead" role="status">
            If an account exists for that email, we&apos;ll send instructions to reset your password.
          </p>
        ) : (
          <>
            <p className="page-lead">Enter your email address and we&apos;ll send you a link to choose a new password.</p>
            <form className="auth-form" onSubmit={submit} noValidate aria-busy={busy ? "true" : undefined}>
              <AuthField id="forgot-email" label="Email" type="email" value={email} onChange={setEmail} error={error} autoComplete="email" inputMode="email" disabled={busy} inputRef={emailRef} maxLength={254} />
              <button type="submit" className="primary-button" disabled={busy}>
                {busy ? "Sending…" : "Send reset link"}
              </button>
            </form>
          </>
        )}
        <Link className="auth-link" to="/signin">
          Back to sign in
        </Link>
      </section>
    </main>
  );
}
