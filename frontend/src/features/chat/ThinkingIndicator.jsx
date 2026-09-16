export default function ThinkingIndicator() {
  return (
    <div className="thinking-indicator" role="status" aria-live="polite">
      <p className="chat-message-kicker">EOI</p>
      <p className="thinking-copy">Reviewing the operational signal</p>
      <span className="thinking-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
    </div>
  );
}
