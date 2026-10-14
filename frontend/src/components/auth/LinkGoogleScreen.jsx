import { useEffect, useRef, useState } from "react";
import { eoiAuth } from "../../services/auth/eoiAuthClient";
import { adoptSession, clearLinkTicket, getLinkTicket, showSignIn } from "../../services/auth/oidc/oidcSession";
import AuthField from "./AuthField";

/**
 * Shown after a genuine Google sign-in whose verified email belongs to an existing EOI account that has a password. EOI never merges two sign-in methods by email
 * alone: the person proves the account's password ONCE, and only then is Google connected to the SAME account (no second account is created). The ticket that proves
 * the Google sign-in lives in memory only; it is single-purpose, signed, and expires in minutes.
 */
export default function LinkGoogleScreen() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const heading = useRef(null);
  const field = useRef(null);
  const sending = useRef(false);
  const ticket = getLinkTicket();
  useEffect(() => {
    heading.current?.focus();
  }, []);

  const cancel = () => {
    clearLinkTicket();
    showSignIn();
  };

  const submit = async (event) => {
    event.preventDefault();
    if (sending.current) return;
    if (!password) {
      setError("Please enter your password.");
      field.current?.focus();
      return;
    }
    sending.current = true;
    setBusy(true);
    setError("");
    const result = await eoiAuth.linkGoogle({ linkTicket: ticket, password });
    sending.current = false;
    setBusy(false);
    if (result.ok) {
      adoptSession(result.grant); // memory only; also opens the application
      return;
    }
    setPassword("");
    setError(result.message);
    field.current?.focus();
  };

  return (
    <main className="auth-screen">
      <section className="koi-card auth-card" aria-labelledby="link-title">
        <p className="auth-brand">EOI</p>
        <h1 className="page-title" id="link-title" ref={heading} tabIndex={-1}>
          Connect your Google account
        </h1>
        {ticket ? (
          <>
            <p className="page-lead">An EOI account already uses the email on your Google account. Enter that account&apos;s password once to connect them.</p>
            <form className="auth-form" onSubmit={submit} noValidate aria-busy={busy ? "true" : undefined}>
              <AuthField id="link-password" label="EOI password" type="password" value={password} onChange={setPassword} error={error} autoComplete="current-password" disabled={busy} inputRef={field} maxLength={200} />
              <button type="submit" className="primary-button" disabled={busy}>
                {busy ? "Connecting…" : "Connect Google account"}
              </button>
            </form>
            <button type="button" className="text-button auth-switch" onClick={cancel} disabled={busy}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <p className="page-lead" role="alert">
              This step has timed out. Please start again.
            </p>
            <button type="button" className="primary-button" onClick={cancel}>
              Back to sign in
            </button>
          </>
        )}
      </section>
    </main>
  );
}
