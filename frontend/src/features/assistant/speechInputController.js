/**
 * Browser speech recognition as a plain, framework-free controller (the same split as analysisAttemptController.js: the logic is here and testable without a DOM, the React hook
 * in useSpeechInput.js is a thin binding). It knows about SPEECH, not about EOI: it turns what the person says into TEXT and hands that text back; it never sends, stores or
 * transmits anything itself. Where the words go (here: the Assistant composer, for the person to review and send) is the caller's business.
 *
 * The engine is the browser's own (window.SpeechRecognition / window.webkitSpeechRecognition). Depending on the browser, its audio is processed by that browser vendor's
 * speech service - nothing here uploads audio anywhere, and nothing is persisted (no storage of audio or transcript).
 *
 * One session at a time. A session has a BASE text (what was already in the field when dictation started), the final transcript, and the interim (not yet final) words. While a
 * session is active `value` is the base with the spoken words appended; the final and the interim parts are recomputed from the engine's own result list on every event, so an
 * interim result is never appended twice. When the session ends the text to keep is committed once through `onCommit(text, { cancelled })`:
 *   - stop / the engine ended on its own  -> the base plus everything that was recognised (nothing recognised is lost, even after an error);
 *   - cancel                              -> the base exactly as it was (no partial speech is left behind).
 */

/** The two languages offered. The language is chosen explicitly by the person; there is no automatic detection and no dedicated mixed-language mode. */
export const VOICE_LANGUAGES = Object.freeze([
  Object.freeze({ id: "en", label: "English", lang: "en-IN" }),
  Object.freeze({ id: "ta", label: "தமிழ்", lang: "ta-IN" }),
]);

export const DEFAULT_VOICE_LANGUAGE = "en";

export const languageTag = (id) => (VOICE_LANGUAGES.find((language) => language.id === id) ?? VOICE_LANGUAGES[0]).lang;

/** The recognition constructor this browser offers, or null. Both spellings are checked; nothing is polyfilled. */
export function getSpeechRecognitionClass(scope = globalThis) {
  return scope?.SpeechRecognition ?? scope?.webkitSpeechRecognition ?? null;
}

export const isSpeechRecognitionSupported = (scope = globalThis) => typeof getSpeechRecognitionClass(scope) === "function";

/** The base text with the spoken words appended in a sensible way: a space between them unless the base already ends in whitespace; never longer than `maxLength`. */
export function composeDictation(base, spoken, maxLength) {
  const head = typeof base === "string" ? base : "";
  const words = typeof spoken === "string" ? spoken.replace(/\s+/g, " ").trim() : "";
  const joined = words ? (head && !/\s$/.test(head) ? `${head} ` : head) + words : head;
  return Number.isInteger(maxLength) && maxLength > 0 ? joined.slice(0, maxLength) : joined;
}

/** The final and the interim words of an engine result list. Recomputed from the whole list each time, so the same words are never counted twice. */
export function readResults(results) {
  let final = "";
  let interim = "";
  for (let index = 0; index < (results?.length ?? 0); index += 1) {
    const result = results[index];
    const text = String(result?.[0]?.transcript ?? "").trim();
    if (!text) continue;
    if (result.isFinal) final += `${final ? " " : ""}${text}`;
    else interim += `${interim ? " " : ""}${text}`;
  }
  return { final, interim };
}

/** Fixed, plain wording for each failure. The person can always type instead. */
export const SPEECH_ERRORS = Object.freeze({
  denied: "Microphone access was denied. You can allow microphone access in your browser settings or continue typing.",
  "no-microphone": "No microphone was found. Connect one or continue typing.",
  "no-speech": "I didn't hear anything. Try again or type your request.",
  network: "Voice input couldn't reach the browser's speech service. Check your connection, or type your request.",
  stopped: "Voice input stopped unexpectedly. Try again or type your request.",
  unsupported: "Voice input isn't available in this browser. You can type your request.",
  failed: "Voice input couldn't be completed. Please try again or type your request.",
});

export const describeSpeechError = (code) => (code ? SPEECH_ERRORS[code] ?? SPEECH_ERRORS.failed : "");

const ERROR_CODES = Object.freeze({
  "not-allowed": "denied",
  "service-not-allowed": "denied",
  "audio-capture": "no-microphone",
  "no-speech": "no-speech",
  network: "network",
});

const IDLE = Object.freeze({ status: "idle", lang: "", transcript: "", interim: "", value: "", error: null });

/**
 * @param {{ getRecognitionClass?: () => (new () => object) | null, maxLength?: number, continuous?: boolean,
 *           onState?: (state: object) => void, onCommit?: (text: string, info: { cancelled: boolean }) => void }} options
 */
export function createSpeechInputController({ getRecognitionClass = getSpeechRecognitionClass, maxLength, continuous = false, onState, onCommit } = {}) {
  let session = null;
  let state = { ...IDLE };

  const supported = () => typeof getRecognitionClass?.() === "function";
  const publish = (next) => {
    state = { ...state, ...next };
    onState?.(getState());
  };
  const getState = () => ({ ...state, supported: supported(), active: state.status !== "idle", listening: state.status === "listening" });

  /** Ends the session once: commits the text to keep and returns to idle. */
  function finish(target, { cancelled = false, error = null } = {}) {
    if (!target || target.finished || target !== session) return;
    target.finished = true;
    session = null;
    detach(target);
    const kept = cancelled ? target.base : composeDictation(target.base, [target.final, target.interim].filter(Boolean).join(" "), maxLength);
    state = { ...IDLE, error: cancelled ? null : error };
    onCommit?.(kept, { cancelled });
    onState?.(getState());
  }

  function detach(target) {
    const engine = target.engine;
    if (!engine) return;
    for (const name of ["onstart", "onresult", "onerror", "onend"]) engine[name] = null;
  }

  function start({ lang = "en-IN", baseText = "" } = {}) {
    if (session) return false; // never two recognition instances
    const Engine = getRecognitionClass?.();
    if (typeof Engine !== "function") {
      publish({ ...IDLE, error: "unsupported" });
      return false;
    }
    let engine;
    try {
      engine = new Engine();
    } catch {
      publish({ ...IDLE, error: "failed" });
      return false;
    }
    const current = { engine, base: typeof baseText === "string" ? baseText : "", final: "", interim: "", finished: false, stopRequested: false, error: null };
    session = current;
    engine.lang = lang;
    engine.interimResults = true;
    engine.continuous = continuous;
    engine.maxAlternatives = 1;

    engine.onstart = () => {
      if (session === current) publish({ status: "listening" });
    };
    engine.onresult = (event) => {
      if (session !== current) return;
      const { final, interim } = readResults(event?.results);
      current.final = final;
      current.interim = interim;
      publish({ transcript: final, interim, value: composeDictation(current.base, [final, interim].filter(Boolean).join(" "), maxLength) });
    };
    engine.onerror = (event) => {
      if (session !== current) return;
      const code = event?.error;
      if (code === "aborted") return; // our own cancel; finish() handles it
      current.error = ERROR_CODES[code] ?? "failed";
      finish(current, { error: current.error });
    };
    engine.onend = () => {
      if (session !== current) return;
      // The engine ended. If the person asked to stop, or something was recognised, that is a normal end. Otherwise it stopped on its own with nothing to show.
      const heard = Boolean(current.final || current.interim);
      finish(current, { error: current.error ?? (current.stopRequested || heard ? null : "stopped") });
    };

    publish({ ...IDLE, status: "starting", lang, value: current.base });
    try {
      engine.start();
    } catch {
      finish(current, { error: "failed" });
      return false;
    }
    return true;
  }

  /** Stop listening and keep what was recognised. The engine delivers its last result and then ends; `finish` runs from its end event. */
  function stop() {
    const current = session;
    if (!current) return;
    current.stopRequested = true;
    try {
      current.engine.stop();
    } catch {
      finish(current, { error: null });
    }
  }

  /** Stop and throw away everything this session recognised: the base text is restored exactly. */
  function cancel() {
    const current = session;
    if (!current) return;
    try {
      current.engine.abort();
    } catch {
      /* the engine is gone anyway */
    }
    finish(current, { cancelled: true });
  }

  /** Leaving the page: release the engine without committing anything. */
  function destroy() {
    const current = session;
    if (!current) return;
    current.finished = true;
    session = null;
    state = { ...IDLE };
    detach(current);
    try {
      current.engine.abort();
    } catch {
      /* gone */
    }
  }

  return { start, stop, cancel, destroy, getState, isSupported: supported };
}
