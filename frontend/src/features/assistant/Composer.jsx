import { useRef, useState } from "react";
import { Send } from "lucide-react";

const MAX = 1000; // mirrors the server's bound (backend signalInterpreter.js INTAKE_LIMITS.textMax); the server enforces it

/**
 * The operator's input. One turn at a time: while a turn is being sent the button and Enter are inert. Enter sends, Shift+Enter adds a line. The text is only
 * ever sent to the server's intake; nothing here calls the AI (the page asks for the assessment after the server has recorded the report).
 */
export default function Composer({ onSend, busy, error, disabled }) {
  const [text, setText] = useState("");
  const field = useRef(null);

  const submit = async (event) => {
    event?.preventDefault();
    const content = text.trim();
    if (!content || busy || disabled) return;
    const turn = await onSend(content);
    if (turn) setText(""); // a failed turn keeps what was typed
    field.current?.focus();
  };

  return (
    <form className="asst-composer" onSubmit={submit} aria-label="Ask about an operational situation">
      <label className="asst-composer-label" htmlFor="asst-input">
        Ask about an operational situation
      </label>
      <div className="asst-composer-row">
        <textarea
          id="asst-input"
          ref={field}
          className="asst-input"
          rows={2}
          maxLength={MAX}
          value={text}
          placeholder="For example: Room 204's AC is not cooling. What should we do?"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) submit(event);
          }}
          disabled={disabled}
          aria-describedby="asst-input-hint asst-input-error"
          aria-invalid={error ? "true" : undefined}
        />
        <button type="submit" className="primary-button asst-send" disabled={busy || disabled || text.trim().length === 0}>
          <Send size={16} strokeWidth={1.75} aria-hidden="true" />
          {busy ? "Sending…" : "Send"}
        </button>
      </div>
      <p className="muted asst-note" id="asst-input-hint">
        Say where it happened and what happened. EOI assesses it against your property, guest and stay records and your operating guidance. It recommends; you decide.
      </p>
      <p className="op-form-error" id="asst-input-error" role="alert">
        {error ?? ""}
      </p>
    </form>
  );
}
