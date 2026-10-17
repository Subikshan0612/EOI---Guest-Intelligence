import { Eye, EyeOff } from "lucide-react";
import { useState } from "react";

/**
 * A labelled form field for the sign-in pages: a real <label for>, a hint and an error both tied to the input (aria-describedby), aria-invalid when there is an
 * error, and - for passwords - a show / hide button with an accessible name. The error is a role=alert paragraph so it is announced when it appears.
 */
export default function AuthField({ id, label, type = "text", value, onChange, error, hint, autoComplete, inputMode, disabled, inputRef, maxLength = 200 }) {
  const [shown, setShown] = useState(false);
  const isPassword = type === "password";
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="auth-field">
      <label className="auth-label" htmlFor={id}>
        {label}
      </label>
      <div className="auth-field-row">
        <input
          id={id}
          ref={inputRef}
          className="auth-input"
          type={isPassword && shown ? "text" : type}
          name={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete={autoComplete}
          inputMode={inputMode}
          maxLength={maxLength}
          aria-describedby={describedBy}
          aria-invalid={error ? "true" : undefined}
          readOnly={disabled}
          spellCheck={false}
          autoCapitalize="none"
        />
        {isPassword ? (
          <button type="button" className="auth-reveal" onClick={() => setShown((v) => !v)} aria-pressed={shown} aria-label={shown ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}>
            {shown ? <EyeOff size={18} strokeWidth={1.75} aria-hidden="true" /> : <Eye size={18} strokeWidth={1.75} aria-hidden="true" />}
          </button>
        ) : null}
      </div>
      {hint ? (
        <p className="muted auth-note" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="op-form-error" id={`${id}-error`} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
