import { useEffect, useRef } from "react";
import { ArrowUp } from "lucide-react";

export default function PromptInput({
  value,
  onChange,
  onSubmit,
  sending = false,
  autoFocus = false,
  placeholder = "Start an intelligence investigation...",
}) {
  const textareaRef = useRef(null);
  const canSend = value.trim().length > 0 && !sending;

  useEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 160)}px`;
  }, [value]);

  function handleKeyDown(event) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (canSend) onSubmit();
    }
  }

  function handleSubmit(event) {
    event.preventDefault();
    if (canSend) onSubmit();
  }

  return (
    <form
      className={sending ? "prompt-input is-sending" : "prompt-input"}
      onSubmit={handleSubmit}
      aria-busy={sending}
    >
      <label htmlFor="koi-prompt-input" className="visually-hidden">
        Intelligence investigation
      </label>
      <textarea
        id="koi-prompt-input"
        ref={textareaRef}
        rows={1}
        value={value}
        autoFocus={autoFocus}
        placeholder={sending ? "KOI is reviewing the signal..." : placeholder}
        disabled={sending}
        aria-disabled={sending}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <button
        type="submit"
        className={sending ? "prompt-send is-busy" : "prompt-send"}
        disabled={!canSend}
        aria-label={sending ? "Investigation in progress" : "Send investigation"}
      >
        <ArrowUp size={18} strokeWidth={2} aria-hidden="true" />
      </button>
    </form>
  );
}
