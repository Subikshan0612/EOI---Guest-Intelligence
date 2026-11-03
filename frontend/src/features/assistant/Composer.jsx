import { useEffect, useRef, useState } from "react";
import { Mic, Send, Square } from "lucide-react";
import { DEFAULT_VOICE_LANGUAGE, VOICE_LANGUAGES, describeSpeechError, languageTag } from "./speechInputController";
import { useSpeechInput } from "./useSpeechInput";

const MAX = 1000; // mirrors the server's bound (backend signalInterpreter.js INTAKE_LIMITS.textMax); the server enforces it

/**
 * The operator's input. One turn at a time: while a turn is being sent the button and Enter are inert. Enter sends, Shift+Enter adds a line. The text is only
 * ever sent to the server's intake; nothing here calls the AI (the page asks for the assessment after the server has recorded the report).
 *
 * VOICE is only another way to fill this field. The microphone turns speech into text (the browser's speech recognition; see useSpeechInput.js) and the words land in the same
 * `text` the keyboard edits: the person reviews and edits them, then presses Send, which is the one existing path to `onSend`. Dictation never sends by itself, never has its own
 * route, and is available exactly when the field is (a disabled composer has a disabled microphone). In a browser without speech recognition no voice control is shown at all.
 */
export default function Composer({
  onSend,
  busy,
  error,
  disabled,
  label = "Ask about an operational situation",
  submitLabel = "Send",
  placeholder = "For example: Room 204's AC is not cooling. What should we do?",
  hint = "Say where it happened and what happened. EOI assesses it against your property, guest and stay records and your operating guidance. It recommends; you decide.",
  seed = null,
}) {
  const [text, setText] = useState("");
  const [voiceLanguage, setVoiceLanguage] = useState(DEFAULT_VOICE_LANGUAGE);
  const field = useRef(null);
  // A dictation session ends with the text the field should keep (the typed text plus what was recognised, or - after Cancel - the typed text exactly as it was).
  const voice = useSpeechInput({ maxLength: MAX, onCommit: (next) => setText(next) });
  const dictating = voice.active;
  const shownText = dictating ? voice.value : text;

  // A suggestion the person chose (see AssistantStart): its words fill the field for them to edit. Nothing is sent.
  useEffect(() => {
    if (!seed?.text) return;
    setText(seed.text);
    field.current?.focus();
  }, [seed]);

  // The microphone is available exactly when the field is: if the composer becomes unavailable mid-dictation, the dictation is cancelled.
  useEffect(() => {
    if (disabled && dictating) voice.cancel();
  }, [disabled, dictating, voice.cancel]);

  const submit = async (event) => {
    event?.preventDefault();
    if (dictating) return; // never send while the words are still arriving: stop first, review, then send
    const content = text.trim();
    if (!content || busy || disabled) return;
    const turn = await onSend(content);
    if (turn) setText(""); // a failed turn keeps what was typed
    field.current?.focus();
  };

  const toggleDictation = () => {
    if (dictating) {
      voice.stop();
      return;
    }
    voice.start({ lang: languageTag(voiceLanguage), baseText: text });
  };

  const voiceError = describeSpeechError(voice.error);

  return (
    <form
      className="asst-composer"
      onSubmit={submit}
      aria-label={label}
      aria-busy={busy ? "true" : undefined}
      data-disabled={disabled ? "true" : undefined}
      data-listening={dictating ? "true" : undefined}
    >
      <label className="asst-composer-label" htmlFor="asst-input">
        {label}
      </label>
      <textarea
        id="asst-input"
        ref={field}
        className="asst-input"
        rows={2}
        maxLength={MAX}
        value={shownText}
        placeholder={placeholder}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) submit(event);
        }}
        disabled={disabled}
        readOnly={dictating}
        aria-describedby="asst-input-hint asst-input-error"
        aria-invalid={error ? "true" : undefined}
      />
      {voice.supported ? (
        <p className="asst-voice-status" id="asst-voice-status" role="status" aria-live="polite">
          {voice.status === "starting" ? (
            "Waiting for the microphone…"
          ) : voice.status === "listening" ? (
            <>
              <span className="asst-pulse" aria-hidden="true" />
              Listening…
            </>
          ) : null}
        </p>
      ) : null}
      <div className="asst-composer-footer">
        <p className="muted asst-note" id="asst-input-hint">
          {hint}
        </p>
        <div className="asst-composer-actions">
          {voice.supported ? (
            <div className="asst-voice">
              <select
                className="asst-voice-lang"
                aria-label="Voice input language"
                value={voiceLanguage}
                onChange={(event) => setVoiceLanguage(event.target.value)}
                disabled={disabled || dictating}
              >
                {VOICE_LANGUAGES.map((language) => (
                  <option key={language.id} value={language.id}>
                    {language.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="asst-mic"
                onClick={toggleDictation}
                disabled={disabled || busy}
                aria-label={dictating ? "Stop voice input" : "Start voice input"}
                aria-pressed={dictating}
                aria-describedby="asst-voice-help"
                data-active={dictating ? "true" : undefined}
              >
                {dictating ? <Square size={15} strokeWidth={2} aria-hidden="true" /> : <Mic size={17} strokeWidth={1.75} aria-hidden="true" />}
                <span className="asst-mic-label">{dictating ? "Stop" : "Dictate"}</span>
              </button>
              {dictating ? (
                <button type="button" className="text-button asst-voice-cancel" onClick={voice.cancel}>
                  Cancel
                </button>
              ) : null}
              <span className="visually-hidden" id="asst-voice-help">
                Voice input uses your browser&apos;s speech recognition. The words appear in the box for you to review and edit; nothing is sent until you press {submitLabel}.
              </span>
            </div>
          ) : null}
          {shownText.length > 0 ? (
            <span className="asst-count muted" aria-hidden="true">
              {shownText.length}/{MAX}
            </span>
          ) : null}
          <button type="submit" className="primary-button asst-send" disabled={busy || disabled || dictating || text.trim().length === 0}>
            {busy ? null : <Send size={16} strokeWidth={1.75} aria-hidden="true" />}
            {busy ? "Sending…" : submitLabel}
          </button>
        </div>
      </div>
      {voiceError ? (
        <p className="op-form-error asst-voice-error" role="alert">
          {voiceError}
        </p>
      ) : null}
      <p className="op-form-error" id="asst-input-error" role="alert">
        {error ?? ""}
      </p>
    </form>
  );
}
