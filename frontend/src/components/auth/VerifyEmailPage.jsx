import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { takeOneTimeToken } from "../../features/auth/oneTimeToken";
import { emailProblem, normalizeEmailInput } from "../../features/auth/validation";
import { eoiAuth } from "../../services/auth/eoiAuthClient";
import AuthField from "./AuthField";

// One verification request per token: React StrictMode (development) runs the effect twice, and a verification link works only once.
const attempts = new Map();
const verifyOnce = (token) => {
  if (!attempts.has(token)) attempts.set(token, eoiAuth.verifyEmail(token));
  return attempts.get(token);
};

/** /verify-email?token=... - confirms the address. States: verifying, verified, link not valid (with a form to send a new link). */
export default function VerifyEmailPage() {
  const [token] = useState(() => takeOneTimeToken("verify"));
  const [state, setState] = useState(token ? "verifying" : "invalid");
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [resent, setResent] = useState(false);
  const heading = useRef(null);
  useEffect(() => {
    if (!token) return undefined;
    let live = true;
    verifyOnce(token).then((result) => {
      if (live) setState(result.ok ? "verified" : result.code === "NETWORK" ? "network" : "invalid");
    });
    return () => {
      live = false;
    };
  }, [token]);
  useEffect(() => {
    heading.current?.focus();
  }, [state]);

  const resend = async (event) => {
    event.preventDefault();
    const problem = emailProblem(email);
    setError(problem);
    if (problem) return;
    await eoiAuth.resendVerification(normalizeEmailInput(email));
    setResent(true);
  };

  return (
    <main className="auth-screen">
      <section className="koi-card auth-card" aria-labelledby="verify-title" role={state === "verifying" ? "status" : undefined}>
        <p className="auth-brand">EOI</p>
        <h1 className="page-title" id="verify-title" ref={heading} tabIndex={-1}>
          {state === "verified" ? "Email verified" : state === "verifying" ? "Verifying your email…" : state === "network" ? "No connection" : "Link not valid"}
        </h1>
        {state === "verified" ? (
          <>
            <p className="page-lead" role="status">
              Your email address is verified. You can now sign in.
            </p>
            <Link className="primary-button auth-button-link" to="/signin">
              Sign in
            </Link>
          </>
        ) : state === "network" ? (
          <p className="page-lead" role="alert">
            We couldn&apos;t reach EOI. Check your connection and reload this page.
          </p>
        ) : state === "invalid" ? (
          <>
            <p className="page-lead" role="alert">
              This link is invalid or has expired. Enter your email address and we&apos;ll send a new one.
            </p>
            {resent ? (
              <p className="page-lead" role="status">
                If your account needs verification, we&apos;ve sent a new link.
              </p>
            ) : (
              <form className="auth-form" onSubmit={resend} noValidate>
                <AuthField id="verify-email-address" label="Email" type="email" value={email} onChange={setEmail} error={error} autoComplete="email" inputMode="email" maxLength={254} />
                <button type="submit" className="primary-button">
                  Send a new link
                </button>
              </form>
            )}
            <Link className="auth-link" to="/signin">
              Back to sign in
            </Link>
          </>
        ) : null}
      </section>
    </main>
  );
}
