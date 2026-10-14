import { useEffect, useRef, useState } from "react";

const NAME_MIN = 2;
const NAME_MAX = 80;

/** The same plain-text rule the server applies (it is the authority; this only saves a round trip). Returns a sentence, or "" when the name is acceptable. */
export function workspaceNameProblem(raw) {
  const cleaned = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return "Please enter a name for your workspace.";
  if (cleaned.length < NAME_MIN) return `Please use at least ${NAME_MIN} characters for your workspace name.`;
  if (cleaned.length > NAME_MAX) return `Please keep your workspace name to ${NAME_MAX} characters or fewer.`;
  if (/[\u0000-\u001f\u007f<>]/.test(cleaned)) return "Please use letters, numbers and ordinary punctuation in your workspace name.";
  return "";
}

/**
 * The short setup a NEW person sees right after signing in (only when the deployment allows self-service setup). They name their workspace and become its
 * administrator; they get access to nothing that already exists. Fixed, plain wording: no identifiers, no provider or technical terms. The browser sends the
 * name and nothing else: who the person is, their role and the workspace's ownership are decided by the server.
 */
export default function OnboardingScreen({ onSubmit, busy, onSignOut }) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const heading = useRef(null);
  const field = useRef(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);

  const submit = async (event) => {
    event.preventDefault();
    if (busy) return; // one creation at a time (the server enforces this too)
    const problem = workspaceNameProblem(name);
    if (problem) {
      setError(problem);
      field.current?.focus();
      return;
    }
    setError("");
    const outcome = await onSubmit(name.replace(/\s+/g, " ").trim());
    if (outcome && !outcome.ok && outcome.message) {
      setError(outcome.message);
      field.current?.focus();
    }
  };

  return (
    <main className="auth-screen">
      <section className="koi-card auth-card" aria-labelledby="onboarding-title" aria-busy={busy ? "true" : undefined}>
        <p className="auth-brand">EOI</p>
        <h1 className="page-title" id="onboarding-title" ref={heading} tabIndex={-1}>
          Welcome to EOI
        </h1>
        <p className="page-lead">Your account is verified. Let&apos;s set up your workspace.</p>
        <form className="auth-form" onSubmit={submit} noValidate>
          <label className="auth-label" htmlFor="workspace-name">
            Workspace name
          </label>
          <input
            id="workspace-name"
            ref={field}
            className="auth-input"
            type="text"
            name="workspaceName"
            autoComplete="organization"
            maxLength={NAME_MAX + 40}
            value={name}
            onChange={(event) => setName(event.target.value)}
            aria-describedby={error ? "workspace-hint workspace-error" : "workspace-hint"}
            aria-invalid={error ? "true" : undefined}
            placeholder="For example, Harbour View Apartments"
            readOnly={busy}
          />
          <p className="muted auth-note" id="workspace-hint">
            This will be your EOI workspace. You&apos;ll be its administrator. To join an existing workspace instead, ask its administrator to add you.
          </p>
          {error ? (
            <p className="op-form-error" id="workspace-error" role="alert">
              {error}
            </p>
          ) : null}
          <button type="submit" className="primary-button" disabled={busy}>
            {busy ? "Creating your workspace…" : "Create workspace"}
          </button>
          {busy ? (
            <p className="muted auth-note" role="status">
              Setting up your workspace. This only takes a moment.
            </p>
          ) : null}
        </form>
        <button type="button" className="text-button auth-switch" onClick={onSignOut} disabled={busy}>
          Sign out
        </button>
      </section>
    </main>
  );
}
