/**
 * VOICE INPUT validation (deterministic; no database, no model, no network, no microphone).
 *
 *   node backend/scripts/validate-voice-input.mjs
 *
 *   A  capability: both browser spellings are found; a browser with neither is "unsupported" and nothing breaks
 *   B  start / listening / one session at a time
 *   C  interim and final results: recomputed from the engine's own list - never duplicated
 *   D  stop keeps what was recognised
 *   E  cancel restores the typed text exactly (no partial speech left behind)
 *   F  every error: denied, no microphone, no speech, network, aborted, generic, unexpected stop, a throwing engine
 *   G  the two languages (en-IN, ta-IN), nothing else, nothing automatic
 *   H  how the words join the text that was already typed; the 1000-character bound
 *   I  the component (real React render through Vite SSR): hidden when unsupported, a labelled microphone + compact language selector when supported, disabled with the composer,
 *      the existing composer contract intact
 *   J  architecture / security: voice never calls onSend, has no network, no storage, no key, no audio capture of its own, no new dependency, no new backend surface
 *
 * The controller is exercised with a FAKE recognition engine (the browser's engine cannot run here); the component's interaction with a fake engine is exercised in the browser
 * pane (see the implementation report).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(here, "..");
const REPO = path.join(BACKEND, "..");
const FRONTEND = path.join(REPO, "frontend");
const SRC = path.join(FRONTEND, "src", "features", "assistant");
const read = (p) => fs.readFileSync(p, "utf8");
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, "");
let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) {
    passed += 1;
    console.log(`PASS  ${name}${detail ? ` - ${detail}` : ""}`);
  } else {
    failed += 1;
    console.error(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
  }
};

const C = await import(pathToFileURL(path.join(SRC, "speechInputController.js")).href);

// ---- a fake recognition engine: records what the controller sets and lets the test fire the browser's events
function makeEngineClass(log = {}) {
  log.instances = [];
  return class FakeRecognition {
    constructor() {
      if (log.throwOnConstruct) throw new Error("no engine");
      this.calls = [];
      log.instances.push(this);
    }
    start() {
      if (log.throwOnStart) throw new Error("already started");
      this.calls.push("start");
    }
    stop() {
      this.calls.push("stop");
    }
    abort() {
      this.calls.push("abort");
    }
    // helpers for the test
    fireStart() { this.onstart?.(); }
    fireResults(list) { this.onresult?.({ results: list.map(([transcript, isFinal]) => Object.assign([{ transcript }], { isFinal })) }); }
    fireError(error) { this.onerror?.({ error }); }
    fireEnd() { this.onend?.(); }
  };
}
function harness(options = {}) {
  const log = { ...(options.log ?? {}) };
  const Engine = makeEngineClass(log);
  const commits = [];
  const states = [];
  const controller = C.createSpeechInputController({
    getRecognitionClass: options.noEngine ? () => null : () => Engine,
    maxLength: options.maxLength,
    continuous: options.continuous,
    onState: (s) => states.push(s),
    onCommit: (text, info) => commits.push({ text, ...info }),
  });
  return { controller, log, commits, states, engine: () => log.instances.at(-1) };
}

// ======================================================================================================== A
console.log("\n# A. capability");
class Std {}
class Webkit {}
check("A1 window.SpeechRecognition is found", C.getSpeechRecognitionClass({ SpeechRecognition: Std }) === Std && C.isSpeechRecognitionSupported({ SpeechRecognition: Std }));
check("A2 window.webkitSpeechRecognition is found when only the prefixed one exists", C.getSpeechRecognitionClass({ webkitSpeechRecognition: Webkit }) === Webkit && C.isSpeechRecognitionSupported({ webkitSpeechRecognition: Webkit }));
check("A3 neither -> null / not supported (no polyfill is attempted)", C.getSpeechRecognitionClass({}) === null && !C.isSpeechRecognitionSupported({}) && !C.isSpeechRecognitionSupported(undefined));
{
  const h = harness({ noEngine: true });
  const started = h.controller.start({ lang: "en-IN", baseText: "typed" });
  const st = h.controller.getState();
  check("A4 an unsupported browser: start() does nothing harmful (false), reports 'unsupported', stays idle, commits nothing - typing is unaffected", started === false && st.supported === false && st.status === "idle" && st.error === "unsupported" && h.commits.length === 0);
}

// ======================================================================================================== B
console.log("\n# B. start / listening");
{
  const h = harness();
  const ok = h.controller.start({ lang: "en-IN", baseText: "" });
  const e = h.engine();
  const s1 = h.controller.getState();
  check("B1 start() creates one engine, calls start() on it and is 'starting' (waiting for the microphone) until the engine reports it is capturing", ok === true && h.log.instances.length === 1 && e.calls.join() === "start" && s1.status === "starting" && s1.active === true && s1.listening === false);
  e.fireStart();
  const s2 = h.controller.getState();
  check("B2 the engine's start event makes it 'listening'", s2.status === "listening" && s2.listening === true && s2.active === true);
  check("B3 interim results are requested; one utterance per session by default (continuous off: the result list is never cumulative)", e.interimResults === true && e.continuous === false && e.maxAlternatives === 1);
  const again = h.controller.start({ lang: "ta-IN", baseText: "x" });
  check("B4 a second start() while a session runs is ignored: never two recognition instances", again === false && h.log.instances.length === 1);
  const c = harness({ continuous: true });
  c.controller.start({ lang: "en-IN" });
  check("B5 continuous is a single option, default off", c.engine().continuous === true);
}

// ======================================================================================================== C
console.log("\n# C. interim and final results");
{
  const h = harness();
  h.controller.start({ lang: "en-IN", baseText: "" });
  const e = h.engine();
  e.fireStart();
  e.fireResults([["Room 501 TV is not working", false]]);
  const interim = h.controller.getState();
  check("C1 an interim result is shown as the value while speaking, and is NOT yet 'final'", interim.value === "Room 501 TV is not working" && interim.interim === "Room 501 TV is not working" && interim.transcript === "");
  e.fireResults([["Room 501 TV is not working and the guest has already complained", false]]);
  const longer = h.controller.getState();
  check("C2 a longer interim REPLACES the earlier interim (the interim is never appended twice)", longer.value === "Room 501 TV is not working and the guest has already complained" && !/not working.*not working/.test(longer.value));
  e.fireResults([["Room 501 TV is not working and the guest has already complained.", true]]);
  const fin = h.controller.getState();
  check("C3 the final result moves the words from interim to final, still one copy", fin.transcript === "Room 501 TV is not working and the guest has already complained." && fin.interim === "" && fin.value === fin.transcript);
  e.fireResults([["Room 501 TV is not working and the guest has already complained.", true]]);
  check("C4 the SAME final result delivered again (a repeated event) does not duplicate the transcript", h.controller.getState().value === "Room 501 TV is not working and the guest has already complained.");
  e.fireResults([["first part", true], ["second part", false]]);
  const mixed = h.controller.getState();
  check("C5 final and interim parts are kept apart and joined once: 'first part second part'", mixed.transcript === "first part" && mixed.interim === "second part" && mixed.value === "first part second part");
  e.fireResults([["  ", true], [undefined, false]]);
  check("C6 an empty or malformed result is ignored without throwing", h.controller.getState().value === "");
}

// ======================================================================================================== D
console.log("\n# D. stop");
{
  const h = harness();
  h.controller.start({ lang: "en-IN", baseText: "Guest called." });
  const e = h.engine();
  e.fireStart();
  e.fireResults([["TV is broken", false]]);
  h.controller.stop();
  check("D1 stop() asks the engine to stop (it will deliver its last result and end); the session is still open until the engine ends", e.calls.includes("stop") && !e.calls.includes("abort") && h.controller.getState().active === true && h.commits.length === 0);
  e.fireResults([["TV is broken in room 501", true]]);
  e.fireEnd();
  const st = h.controller.getState();
  check("D2 when the engine ends, the typed text plus everything recognised is committed ONCE and the state is idle", h.commits.length === 1 && h.commits[0].text === "Guest called. TV is broken in room 501" && h.commits[0].cancelled === false && st.status === "idle" && st.error === null);
  check("D3 an interim that never became final is kept too (nothing recognised is lost)", (() => { const k = harness(); k.controller.start({ lang: "en-IN", baseText: "" }); k.engine().fireResults([["almost final words", false]]); k.controller.stop(); k.engine().fireEnd(); return k.commits[0].text === "almost final words"; })());
  e.fireEnd();
  check("D4 a late duplicate end event commits nothing more", h.commits.length === 1);
}

// ======================================================================================================== E
console.log("\n# E. cancel");
{
  const h = harness();
  h.controller.start({ lang: "en-IN", baseText: "Existing typed text" });
  const e = h.engine();
  e.fireStart();
  e.fireResults([["partial speech that must vanish", false]]);
  check("E1 while recording the value is the typed text plus the speech", h.controller.getState().value === "Existing typed text partial speech that must vanish");
  h.controller.cancel();
  const st = h.controller.getState();
  check("E2 cancel aborts the engine, commits the ORIGINAL text with cancelled=true, leaves no interim or final behind, and is idle with no error", e.calls.includes("abort") && h.commits.length === 1 && h.commits[0].text === "Existing typed text" && h.commits[0].cancelled === true && st.status === "idle" && st.transcript === "" && st.interim === "" && st.error === null);
  e.fireEnd();
  e.fireError("aborted");
  check("E3 the engine's own 'aborted' error and end events after a cancel change nothing", h.commits.length === 1 && h.controller.getState().error === null);
  const k = harness();
  k.controller.start({ lang: "en-IN", baseText: "kept" });
  k.controller.cancel();
  check("E4 cancel while still waiting for the microphone also restores the text", k.commits[0].text === "kept" && k.commits[0].cancelled === true && k.controller.getState().status === "idle");
  check("E5 cancel with no session does nothing", (() => { const n = harness(); n.controller.cancel(); n.controller.stop(); return n.commits.length === 0; })());
}

// ======================================================================================================== F
console.log("\n# F. errors");
for (const [engineCode, expected] of [["not-allowed", "denied"], ["service-not-allowed", "denied"], ["audio-capture", "no-microphone"], ["no-speech", "no-speech"], ["network", "network"], ["language-not-supported", "failed"], ["bad-grammar", "failed"]]) {
  const h = harness();
  h.controller.start({ lang: "en-IN", baseText: "typed" });
  h.engine().fireStart();
  h.engine().fireError(engineCode);
  h.engine().fireEnd();
  const st = h.controller.getState();
  check(`F-${engineCode} '${engineCode}' -> '${expected}': the typed text is kept untouched, one commit, idle, and a plain message exists`, st.error === expected && st.status === "idle" && h.commits.length === 1 && h.commits[0].text === "typed" && C.describeSpeechError(expected).length > 10);
}
{
  const h = harness();
  h.controller.start({ lang: "en-IN", baseText: "typed" });
  h.engine().fireStart();
  h.engine().fireResults([["captured before the drop", true]]);
  h.engine().fireError("network");
  check("F-net2 a network error AFTER some speech keeps what was recognised (nothing is lost) and still reports the error", h.commits[0].text === "typed captured before the drop" && h.controller.getState().error === "network");
  const u = harness();
  u.controller.start({ lang: "en-IN", baseText: "" });
  u.engine().fireStart();
  u.engine().fireEnd();
  check("F-stop1 the engine ends on its own with nothing recognised and nobody asked it to: 'stopped' (unexpected)", u.controller.getState().error === "stopped" && u.commits[0].text === "");
  const w = harness();
  w.controller.start({ lang: "en-IN", baseText: "a" });
  w.engine().fireStart();
  w.engine().fireResults([["spoken", true]]);
  w.engine().fireEnd();
  check("F-stop2 the engine ends on its own AFTER speech: a normal end - the transcript is preserved, no error", w.commits[0].text === "a spoken" && w.controller.getState().error === null);
  const t = harness({ log: { throwOnStart: true } });
  const started = t.controller.start({ lang: "en-IN", baseText: "x" });
  check("F-throw1 an engine whose start() throws -> 'failed', idle, the text is kept, no exception escapes", started === false && t.controller.getState().error === "failed" && t.commits[0].text === "x");
  const k = harness({ log: { throwOnConstruct: true } });
  check("F-throw2 an engine that cannot be constructed -> 'failed', idle, no exception", k.controller.start({ lang: "en-IN" }) === false && k.controller.getState().error === "failed" && k.controller.getState().status === "idle");
  const r = harness();
  r.controller.start({ lang: "en-IN", baseText: "" });
  r.engine().fireEnd();
  r.controller.start({ lang: "en-IN", baseText: "" });
  check("F-restart after an error the person can start again and the previous error is cleared", r.controller.getState().error === null && r.log.instances.length === 2);
  check("F-msg every message is plain wording and typing is always offered where it fits: denied / no-speech / failed", /Microphone access was denied\. You can allow microphone access in your browser settings or continue typing\./.test(C.SPEECH_ERRORS.denied) && /I didn't hear anything\. Try again or type your request\./.test(C.SPEECH_ERRORS["no-speech"]) && /Voice input couldn't be completed\. Please try again or type your request\./.test(C.SPEECH_ERRORS.failed) && C.describeSpeechError(null) === "");
}

// ======================================================================================================== G
console.log("\n# G. languages");
check("G1 exactly two languages are offered: English (en-IN) and தமிழ் (ta-IN); English is the default", JSON.stringify(C.VOICE_LANGUAGES.map((l) => [l.id, l.label, l.lang])) === JSON.stringify([["en", "English", "en-IN"], ["ta", "தமிழ்", "ta-IN"]]) && C.DEFAULT_VOICE_LANGUAGE === "en");
check("G2 languageTag maps the choice to the engine tag and falls back to English for anything unknown", C.languageTag("en") === "en-IN" && C.languageTag("ta") === "ta-IN" && C.languageTag("xx") === "en-IN" && C.languageTag(undefined) === "en-IN");
{
  const en = harness();
  en.controller.start({ lang: C.languageTag("en"), baseText: "" });
  const ta = harness();
  ta.controller.start({ lang: C.languageTag("ta"), baseText: "" });
  check("G3 the engine's `lang` is exactly 'en-IN' for English and 'ta-IN' for Tamil", en.engine().lang === "en-IN" && ta.engine().lang === "ta-IN");
  ta.engine().fireStart();
  ta.engine().fireResults([["501-ல TV வேலை செய்யவில்லை", true]]);
  ta.controller.stop();
  ta.engine().fireEnd();
  check("G4 a Tamil transcript is kept EXACTLY as the engine produced it (no translation, no normalisation)", ta.commits[0].text === "501-ல TV வேலை செய்யவில்லை");
  ta.controller.start({ lang: "ta-IN", baseText: "x" });
  ta.engine().fireResults([["Room 501-la TV work aagala", true]]);
  ta.controller.stop();
  ta.engine().fireEnd();
  check("G5 mixed / Latin-script speech is preserved as produced (editable by the person); nothing is rewritten", ta.commits[1].text === "x Room 501-la TV work aagala");
}

// ======================================================================================================== H
console.log("\n# H. joining the words to the typed text");
check("H1 empty field: the speech is the text", C.composeDictation("", "Room 501 TV is not working") === "Room 501 TV is not working");
check("H2 existing text: the speech is appended after one space, the typed text untouched", C.composeDictation("Guest complained.", "TV is broken") === "Guest complained. TV is broken");
check("H3 a base that already ends in whitespace or a newline gets no extra space", C.composeDictation("Line one\n", "line two") === "Line one\nline two" && C.composeDictation("Line one ", "two") === "Line one two");
check("H4 no speech -> the base exactly as it is", C.composeDictation("  keep  ", "") === "  keep  " && C.composeDictation("keep", "   ") === "keep");
check("H5 the spoken words are whitespace-collapsed (no doubled spaces from the engine)", C.composeDictation("", "a   b \n c") === "a b c");
check("H6 the 1000-character bound of the composer is never exceeded, with a long base and long speech", C.composeDictation("x".repeat(990), "y".repeat(50), 1000).length === 1000 && C.composeDictation("x".repeat(990), "y".repeat(50), 1000).startsWith("x".repeat(990)));
{
  const h = harness({ maxLength: 20 });
  h.controller.start({ lang: "en-IN", baseText: "abcdefghij" });
  h.engine().fireResults([["klmnopqrstuvwxyz", true]]);
  h.controller.stop();
  h.engine().fireEnd();
  check("H7 the controller applies the bound to the live value and to the committed text", h.commits[0].text.length === 20 && h.commits[0].text === "abcdefghij klmnopqrs");
}
{
  const h = harness();
  h.controller.start({ lang: "en-IN", baseText: "First report." });
  h.engine().fireStart();
  h.engine().fireResults([["one", true]]);
  h.controller.stop();
  h.engine().fireEnd();
  h.controller.start({ lang: "en-IN", baseText: h.commits[0].text });
  h.engine().fireStart();
  h.engine().fireResults([["two", true]]);
  h.controller.stop();
  h.engine().fireEnd();
  check("H8 dictating twice in a row appends each time to what is in the field (no loss, no repeat)", h.commits[1].text === "First report. one two");
}
{
  const h = harness();
  h.controller.start({ lang: "en-IN", baseText: "kept" });
  h.engine().fireResults([["gone", true]]);
  h.controller.destroy();
  check("H9 destroy() (leaving the page) releases the engine without committing anything", h.engine().calls.includes("abort") && h.commits.length === 0 && h.controller.getState().active === false);
}

// ======================================================================================================== I
console.log("\n# I. the component (real React render, Vite SSR)");
const { createServer } = await import(pathToFileURL(path.join(FRONTEND, "node_modules", "vite", "dist", "node", "index.js")).href);
const vite = await createServer({ root: FRONTEND, configFile: path.join(FRONTEND, "vite.config.js"), server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom", logLevel: "silent", optimizeDeps: { noDiscovery: true, include: [] } });
try {
  const { createRequire } = await import("node:module");
  const feRequire = createRequire(path.join(FRONTEND, "package.json"));
  const React = feRequire("react");
  const { renderToStaticMarkup } = feRequire("react-dom/server");
  const Composer = (await vite.ssrLoadModule("/src/features/assistant/Composer.jsx")).default;
  const render = (props = {}) => renderToStaticMarkup(React.createElement(Composer, { onSend: async () => null, busy: false, ...props }));

  delete globalThis.SpeechRecognition;
  delete globalThis.webkitSpeechRecognition;
  const plain = render({ error: "Fixed sentence." });
  check("I1 [unsupported browser] no microphone, no language selector, no voice status, no help text is rendered at all: nothing dead", !/asst-mic|asst-voice|Dictate|Voice input|Start voice input/.test(plain));
  check("I2 [existing contract] the composer still has its label tied to the textarea, the hint, the error live region, aria-invalid, the exact aria-describedby and a real submit button", /<label[^>]*for="asst-input"/.test(plain) && /<textarea[^>]*id="asst-input"/.test(plain) && /aria-describedby="asst-input-hint asst-input-error"/.test(plain) && /aria-invalid="true"/.test(plain) && /role="alert"/.test(plain) && /<button[^>]*type="submit"/.test(plain) && /maxLength="1000"/.test(plain));

  globalThis.webkitSpeechRecognition = class {};
  const withVoice = render();
  check("I3 [supported browser] a microphone button with an accessible name, aria-pressed=false, a 'Dictate' label and a described-by help text", /<button[^>]*class="asst-mic"[^>]*aria-label="Start voice input"/.test(withVoice) && /aria-pressed="false"/.test(withVoice) && /Dictate/.test(withVoice) && /id="asst-voice-help"/.test(withVoice) && /aria-describedby="asst-voice-help"/.test(withVoice) && /type="button"/.test(withVoice.match(/<button[^>]*class="asst-mic"[^>]*>/)?.[0] ?? ""));
  const select = withVoice.match(/<select[^>]*>[\s\S]*?<\/select>/)?.[0] ?? "";
  check("I4 a compact, labelled language selector with exactly English and தமிழ், English selected by default; no other language and no 'Tanglish' anywhere", /aria-label="Voice input language"/.test(select) && (select.match(/<option/g) ?? []).length === 2 && /value="en"[^>]*selected|selected[^>]*value="en"/.test(select) && />English</.test(select) && />தமிழ்</.test(select) && !/tanglish/i.test(withVoice));
  check("I5 the live status region exists (aria-live=polite, role=status) and is empty when idle", /<p[^>]*id="asst-voice-status"[^>]*role="status"[^>]*aria-live="polite"[^>]*><\/p>|<p[^>]*role="status"[^>]*aria-live="polite"[^>]*id="asst-voice-status"[^>]*><\/p>/.test(withVoice));
  const off = render({ disabled: true });
  check("I6 [context rule] a disabled composer (no Property / Guest / Stay yet) disables the microphone and the language selector too - the same rule, not a new one", /<button[^>]*class="asst-mic"[^>]*disabled/.test(off) && /<select[^>]*aria-label="Voice input language"[^>]*disabled/.test(off) && /<textarea[^>]*disabled/.test(off));
  const busy = render({ busy: true });
  check("I7 while a turn is being sent the microphone is inert as well", /<button[^>]*class="asst-mic"[^>]*disabled/.test(busy));
  check("I8 the Send button is unchanged: a real submit button, disabled with an empty field", /<button[^>]*class="primary-button asst-send"[^>]*disabled=""|<button[^>]*disabled=""[^>]*class="primary-button asst-send"/.test(withVoice) && />Send</.test(withVoice));
  delete globalThis.webkitSpeechRecognition;
} finally {
  await vite.close();
}

// ======================================================================================================== J
console.log("\n# J. architecture and security");
const composerSrc = code(path.join(SRC, "Composer.jsx"));
const voiceFiles = ["speechInputController.js", "useSpeechInput.js"].map((f) => code(path.join(SRC, f)));
const voiceAll = voiceFiles.join("\n");
check("J1 voice never calls onSend: in the voice controller and hook there is no onSend at all, and in the Composer onSend appears exactly once - inside the existing submit()", !/onSend/.test(voiceAll) && (composerSrc.match(/onSend\(/g) ?? []).length === 1 && /const submit = async[\s\S]*?await onSend\(content\)/.test(composerSrc));
check("J2 submit() refuses to send while dictating (stop first, review, then Send) and Send is disabled while dictating", /if \(dictating\) return;/.test(composerSrc) && /disabled=\{busy \|\| disabled \|\| dictating \|\| text\.trim\(\)\.length === 0\}/.test(composerSrc));
check("J3 Enter sends and Shift+Enter makes a newline exactly as before", /event\.key === "Enter" && !event\.shiftKey\) submit\(event\)/.test(composerSrc));
check("J4 a speech session ending commits text into the composer's own `text` state - nothing else is written", /useSpeechInput\(\{ maxLength: MAX, onCommit: \(next\) => setText\(next\) \}\)/.test(composerSrc));
check("J5 the voice code has no network, no API client, no storage and no key: no fetch / axios / services/api / localStorage / sessionStorage / indexedDB / cookie / import.meta.env / API key", !/fetch\(|axios|services\/api|localStorage|sessionStorage|indexedDB|document\.cookie|import\.meta\.env|api[_-]?key|VITE_/i.test(voiceAll + composerSrc));
check("J6 the voice code captures no audio itself and uploads none: no getUserMedia, MediaRecorder, AudioContext, Blob, FormData or WebSocket", !/getUserMedia|MediaRecorder|AudioContext|\bBlob\b|FormData|WebSocket/.test(voiceAll + composerSrc));
const pkg = JSON.parse(read(path.join(FRONTEND, "package.json")));
check("J7 no dependency was added: the frontend still depends only on axios, lucide-react, react, react-dom and react-router-dom, with no speech package", JSON.stringify(Object.keys(pkg.dependencies).sort()) === JSON.stringify(["axios", "lucide-react", "react", "react-dom", "react-router-dom"]) && !/speech|voice|whisper|recogni/i.test(JSON.stringify(pkg)));
check("J8 no Tanglish mode, translation, language detection or provider call exists in the voice code", !/tanglish|translate|detect|transliterat|gemini|openai|whisper/i.test(voiceAll));
check("J9 the voice files import only React, the icon set and each other (no backend or EOI domain module)", voiceFiles.every((src) => (src.match(/from "([^"]+)"/g) ?? []).every((m) => /from "(react|lucide-react|\.\/speechInputController|\.\/useSpeechInput)"/.test(m))) && (composerSrc.match(/from "([^"]+)"/g) ?? []).every((m) => /from "(react|lucide-react|\.\/speechInputController|\.\/useSpeechInput)"/.test(m)));
const interpreterDiff = ["backend/src/services/ai/safetyPolicy.js", "backend/src/services/signalInterpreter.js"].every((f) => fs.existsSync(path.join(REPO, f)));
check("J10 the files the task forbids touching still exist where they were (safetyPolicy.js, signalInterpreter.js); their content is checked against git in the report", interpreterDiff);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
