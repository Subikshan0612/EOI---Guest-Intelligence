export default function ThinkingIndicator() {
  return (
    <div className="thinking-indicator" role="status" aria-live="polite">
      <p className="chat-message-kicker">KOI</p>
      <p className="thinking-copy">Reviewing the signal</p>
      <span className="thinking-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
    </div>
  );
}
