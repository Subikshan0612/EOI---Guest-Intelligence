import { useCallback, useEffect, useRef, useState } from "react";
import { createSpeechInputController, isSpeechRecognitionSupported } from "./speechInputController";

/**
 * React binding for the speech-input controller (speechInputController.js holds the logic). It exposes the controller's state and three actions and knows nothing about EOI:
 *
 *   { supported, active, listening, status, transcript, interim, value, error, start({ lang, baseText }), stop(), cancel() }
 *
 *   supported   this browser has speech recognition (window.SpeechRecognition or webkitSpeechRecognition); false means "show nothing, typing carries on"
 *   active      a session is running (waiting for the microphone, or listening); `listening` is true only once the engine reports it is capturing
 *   value       while active: the base text with the spoken words appended (final + interim, never duplicated); show this in place of the field's own text
 *   error       a code ("denied", "no-speech", ...) for the last session, or null; pair it with describeSpeechError()
 *
 * `onCommit(text, { cancelled })` is called once when a session ends with the text the field should hold from then on. Nothing is sent, stored or transmitted from here.
 * The recognition instance is released when the component unmounts.
 */
export function useSpeechInput({ maxLength, onCommit } = {}) {
  const [state, setState] = useState(() => ({ status: "idle", lang: "", transcript: "", interim: "", value: "", error: null, supported: isSpeechRecognitionSupported(), active: false, listening: false }));
  const controller = useRef(null);
  const commit = useRef(onCommit);
  commit.current = onCommit;

  useEffect(() => {
    const created = createSpeechInputController({ maxLength, onState: setState, onCommit: (text, info) => commit.current?.(text, info) });
    controller.current = created;
    setState(created.getState());
    return () => {
      created.destroy();
      controller.current = null;
    };
  }, [maxLength]);

  const start = useCallback((options) => controller.current?.start(options) ?? false, []);
  const stop = useCallback(() => controller.current?.stop(), []);
  const cancel = useCallback(() => controller.current?.cancel(), []);

  return { ...state, start, stop, cancel };
}
