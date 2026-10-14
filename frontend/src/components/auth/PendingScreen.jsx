import RetryButton from "./RetryButton";

/** A short, fixed-wording wait / retry screen (same card as the sign-in screens). With an action it is a plain retry screen. */
export default function PendingScreen({ text, onAction, secondaryLabel, onSecondary }) {
  return (
    <main className="auth-screen">
      <section className="koi-card auth-card" role={onAction ? "alert" : "status"}>
        <p className="auth-brand">EOI</p>
        <p className="page-lead">{text}</p>
        {onAction ? (
          <RetryButton className="primary-button" onClick={onAction} />
        ) : null}
        {onSecondary ? (
          <button type="button" className="text-button auth-switch" onClick={onSecondary}>
            {secondaryLabel}
          </button>
        ) : null}
      </section>
    </main>
  );
}
