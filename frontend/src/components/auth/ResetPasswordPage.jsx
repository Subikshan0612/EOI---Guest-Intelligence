import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { forgetOneTimeToken, takeOneTimeToken } from "../../features/auth/oneTimeToken";
import { newPasswordProblem } from "../../features/auth/validation";
import { eoiAuth } from "../../services/auth/eoiAuthClient";
import { getAuthState } from "../../services/auth/authSession";
import { signOut } from "../../services/auth/oidc/oidcSession";
import AuthField from "./AuthField";

/**
 * /reset-password?token=... - choose a new password. The one-time token is taken from the address once and the address is cleaned at once. A bad password does not
 * use the link up (the server checks the password first). On success every session of the account is already revoked server-side; this tab, if it was signed in,
 * forgets its own session too.
 */
export default function ResetPasswordPage() {
  const [token] = useState(() => takeOneTimeToken("reset"));
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState("");
  const [state, setState] = useState(token ? "form" : "invalid");
  const [busy, setBusy] = useState(false);
  const heading = useRef(null);
  const passwordRef = useRef(null);
  const confirmRef = useRef(null);
  const sending = useRef(false);
  useEffect(() => {
    heading.current?.focus();
  }, [state]);

  const submit = async (event) => {
    event.preventDefault();
    if (sending.current) return;
    const next = { password: newPasswordProblem(password), confirm: password !== confirm ? "The two passwords do not match." : "" };
    setErrors(next);
    setFormError("");
    if (next.password || next.confirm) {
      (next.password ? passwordRef : confirmRef).current?.focus();
      return;
    }
    sending.current = true;
    setBusy(true);
    const result = await eoiAuth.resetPassword({ token, password, passwordConfirm: confirm });
    sending.current = false;
    setBusy(false);
    if (result.ok) {
      forgetOneTimeToken("reset");
      setPassword("");
      setConfirm("");
      if (getAuthState().status === "ready") signOut(); // the server revoked every session of this account, this tab's included
      setState("done");
    } else if (result.code === "INVALID_LINK") setState("invalid");
    else if (result.code === "INVALID_FIELD") setErrors({ [result.field === "passwordConfirm" ? "confirm" : "password"]: result.message });
    else setFormError(result.message);
  };

  return (
    <main className="auth-screen">
      <section className="koi-card auth-card" aria-labelledby="reset-title">
        <p className="auth-brand">EOI</p>
        {state === "done" ? (
          <>
            <h1 className="page-title" id="reset-title" ref={heading} tabIndex={-1}>
              Password changed
            </h1>
            <p className="page-lead" role="status">
              Your password has been changed. Please sign in with your new password.
            </p>
            <Link className="primary-button auth-button-link" to="/signin">
              Sign in
            </Link>
          </>
        ) : state === "invalid" ? (
          <>
            <h1 className="page-title" id="reset-title" ref={heading} tabIndex={-1}>
              Link not valid
            </h1>
            <p className="page-lead" role="alert">
              This link is invalid or has expired.
            </p>
            <Link className="primary-button auth-button-link" to="/forgot-password">
              Send a new link
            </Link>
          </>
        ) : (
          <>
            <h1 className="page-title" id="reset-title" ref={heading} tabIndex={-1}>
              Choose a new password
            </h1>
            <form className="auth-form" onSubmit={submit} noValidate aria-busy={busy ? "true" : undefined}>
              <AuthField id="reset-password" label="New password" type="password" value={password} onChange={setPassword} error={errors.password} hint="At least 10 characters." autoComplete="new-password" disabled={busy} inputRef={passwordRef} maxLength={200} />
              <AuthField id="reset-confirm" label="Confirm new password" type="password" value={confirm} onChange={setConfirm} error={errors.confirm} autoComplete="new-password" disabled={busy} inputRef={confirmRef} maxLength={200} />
              {formError ? (
                <p className="op-form-error" role="alert">
                  {formError}
                </p>
              ) : null}
              <button type="submit" className="primary-button" disabled={busy}>
                {busy ? "Saving…" : "Change password"}
              </button>
            </form>
          </>
        )}
      </section>
    </main>
  );
}
