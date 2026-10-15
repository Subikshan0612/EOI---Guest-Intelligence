import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { emailProblem, nameProblem, newPasswordProblem, normalizeEmailInput } from "../../features/auth/validation";
import { eoiAuth } from "../../services/auth/eoiAuthClient";
import AuthField from "./AuthField";
import GoogleButton from "./GoogleButton";

/**
 * /signup - "Create your EOI account": full name, email, password + confirmation, and "Continue with Google". The account is created UNVERIFIED and the person is
 * told to check their email; they cannot sign in until the link has been opened. The answer is the same whether or not the address already has an account.
 */
export default function SignUpPage() {
  const [form, setForm] = useState({ name: "", email: "", password: "", confirm: "" });
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState("");
  const [sentTo, setSentTo] = useState("");
  const [resent, setResent] = useState(false);
  const [busy, setBusy] = useState(false);
  const heading = useRef(null);
  const refs = { name: useRef(null), email: useRef(null), password: useRef(null), confirm: useRef(null) };
  const sending = useRef(false);
  useEffect(() => {
    heading.current?.focus();
  }, [sentTo]);
  const set = (key) => (value) => setForm((f) => ({ ...f, [key]: value }));

  const submit = async (event) => {
    event.preventDefault();
    if (sending.current) return;
    const next = {
      name: nameProblem(form.name),
      email: emailProblem(form.email),
      password: newPasswordProblem(form.password, { email: form.email }),
      confirm: form.password !== form.confirm ? "The two passwords do not match." : "",
    };
    setErrors(next);
    setFormError("");
    const firstBad = ["name", "email", "password", "confirm"].find((k) => next[k]);
    if (firstBad) {
      refs[firstBad].current?.focus();
      return;
    }
    sending.current = true;
    setBusy(true);
    const email = normalizeEmailInput(form.email);
    const result = await eoiAuth.signUp({ name: form.name.replace(/\s+/g, " ").trim(), email, password: form.password, passwordConfirm: form.confirm });
    sending.current = false;
    setBusy(false);
    if (result.ok) {
      setForm({ name: "", email: "", password: "", confirm: "" });
      setSentTo(email);
      return;
    }
    const key = { name: "name", email: "email", password: "password", passwordConfirm: "confirm" }[result.field];
    if (key) {
      setErrors({ [key]: result.message });
      refs[key].current?.focus();
    } else setFormError(result.message);
  };

  if (sentTo) {
    return (
      <main className="auth-screen">
        <section className="koi-card auth-card" aria-labelledby="signup-sent-title">
          <p className="auth-brand">EOI</p>
          <h1 className="page-title" id="signup-sent-title" ref={heading} tabIndex={-1}>
            Check your email
          </h1>
          <p className="page-lead" role="status">
            We&apos;ve sent a link to confirm your email address. Open it to finish creating your account, then sign in.
          </p>
          <button
            type="button"
            className="secondary-button"
            disabled={resent}
            onClick={async () => {
              await eoiAuth.resendVerification(sentTo);
              setResent(true);
            }}
          >
            {resent ? "Email sent again" : "Send the email again"}
          </button>
          <Link className="auth-link" to="/signin">
            Back to sign in
          </Link>
        </section>
      </main>
    );
  }

  return (
    <main className="auth-screen">
      <section className="koi-card auth-card" aria-labelledby="signup-title">
        <p className="auth-brand">EOI</p>
        <h1 className="page-title" id="signup-title" ref={heading} tabIndex={-1}>
          Create your EOI account
        </h1>
        <form className="auth-form" onSubmit={submit} noValidate aria-busy={busy ? "true" : undefined}>
          <AuthField id="signup-name" label="Full name" value={form.name} onChange={set("name")} error={errors.name} autoComplete="name" disabled={busy} inputRef={refs.name} maxLength={120} />
          <AuthField id="signup-email" label="Email" type="email" value={form.email} onChange={set("email")} error={errors.email} autoComplete="email" inputMode="email" disabled={busy} inputRef={refs.email} maxLength={254} />
          <AuthField id="signup-password" label="Password" type="password" value={form.password} onChange={set("password")} error={errors.password} hint="At least 10 characters. A few ordinary words make a good passphrase." autoComplete="new-password" disabled={busy} inputRef={refs.password} maxLength={200} />
          <AuthField id="signup-confirm" label="Confirm password" type="password" value={form.confirm} onChange={set("confirm")} error={errors.confirm} autoComplete="new-password" disabled={busy} inputRef={refs.confirm} maxLength={200} />
          {formError ? (
            <p className="op-form-error" role="alert">
              {formError}
            </p>
          ) : null}
          <button type="submit" className="primary-button" disabled={busy}>
            {busy ? "Creating your account…" : "Create account"}
          </button>
        </form>
        <GoogleButton />
        <p className="muted auth-note">
          Already have an account?{" "}
          <Link className="auth-link" to="/signin">
            Sign in
          </Link>
        </p>
        <aside className="auth-demo-notice" aria-label="Demo notice">
          <p className="auth-demo-notice-title">Demo Notice</p>
          <p className="auth-demo-notice-text">
            Email verification is currently limited because a custom email domain has not been configured. For the best experience, use Continue with Google.
          </p>
        </aside>
      </section>
    </main>
  );
}
