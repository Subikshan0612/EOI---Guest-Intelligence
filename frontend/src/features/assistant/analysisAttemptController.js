import { ATTEMPT_STATUS, mapAttemptState } from "./analysisAttemptMapping";
import { presentGenerationFailure } from "../intelligence/intelligenceErrorPresentation";

/**
 * The page-side lifecycle of an analysis attempt (Workstream 5B), kept free of React so it can be tested deterministically (timers and the API are injected).
 *
 * THE BACKEND IS AUTHORITATIVE. This controller keeps no record of its own about whether an analysis exists or is running: it asks (POST to start, GET to read the state) and shows
 * what the server says. There is deliberately no second de-duplication that could disagree with the server: the only local guard is the one that already existed (one POST in
 * flight per report at a time), and a report whose attempt is running offers no "try again" at all.
 *
 *   start(id)    the person's explicit request (right after sending a report, or the visible "Assess this" / "Try again"). POST /analyze:
 *                  201/200 -> succeeded (the page then READS the stored analysis; nothing is rendered from this response)
 *                  202     -> in_progress: the attempt carries on; the page reads its state until it ends
 *                  an error -> failed, in fixed wording - EXCEPT a browser-side timeout or lost connection, which says nothing about the attempt (it may be running): the
 *                  state is read first, and only "nothing was started" is shown as a failure
 *   observe(id)  re-entry (refresh, coming back to the page): ONE read of the state when this report has no analysis shown. Never starts anything.
 *   refresh(id)  one more read of the state ("check again"). Never starts anything.
 *   release(id)  the report is no longer on screen: polling stops. The backend attempt is NOT cancelled; coming back simply reads its state again.
 *   dispose()    the page is gone: every timer is cleared and nothing in flight can change state afterwards.
 *
 * POLLING happens only while the state is in_progress: one read at a time (never overlapping), never a POST; it stops at once on succeeded or failed, on release/dispose, after
 * STALL_AFTER_MS (the backend marks an abandoned attempt failed after about 2.5 minutes, so this is only a backstop), and after MAX_STATUS_ERRORS consecutive failed reads.
 *
 * phase: 'idle' | 'checking' | 'starting' | 'in_progress' | 'succeeded' | 'failed' | 'stalled'.   `version` increases whenever a request or read finished with a terminal result,
 * so the page knows to READ the stored analysis again.
 */
export const PHASE = Object.freeze({ IDLE: "idle", CHECKING: "checking", STARTING: "starting", IN_PROGRESS: "in_progress", SUCCEEDED: "succeeded", FAILED: "failed", STALLED: "stalled" });

// The gaps between state reads: a quick first look (the attempt was already running for the whole response window), then one read every 5 s. A read is a cheap indexed GET
// that starts no analysis; 5 s is frequent enough that a result appears promptly and rare enough (12 per minute at most, for one open report) to be negligible next to an
// analysis that takes tens of seconds. Nothing is exposed to the person: no countdown, no estimate.
export const POLL_SCHEDULE_MS = Object.freeze([2000, 3000, 3000]);
export const POLL_STEADY_MS = 5000;
export const STALL_AFTER_MS = 180000;
export const MAX_STATUS_ERRORS = 3;

const CLIENT_SIDE_ENDING = new Set(["CLIENT_TIMEOUT", "CLIENT_NETWORK"]);

export function createAnalysisAttemptController({ api, onChange, now = () => Date.now(), timers = { setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms), clearTimeout: (id) => globalThis.clearTimeout(id) } }) {
  const records = new Map();
  let disposed = false;

  const blank = () => ({ phase: PHASE.IDLE, failure: null, version: 0, ticket: 0, timer: null, reading: false, released: false, pollIndex: 0, pollStartedAt: 0, statusErrors: 0, statusUnavailable: false });
  const rec = (id) => {
    if (!records.has(id)) records.set(id, blank());
    return records.get(id);
  };
  const snapshot = (r) => ({
    phase: r.phase,
    busy: r.phase === PHASE.STARTING,
    checking: r.phase === PHASE.CHECKING,
    inProgress: r.phase === PHASE.IN_PROGRESS,
    stalled: r.phase === PHASE.STALLED,
    statusUnavailable: r.statusUnavailable,
    failure: r.failure,
    version: r.version,
  });
  const emit = (id) => {
    if (!disposed) onChange(id, snapshot(rec(id)));
  };
  const stopTimer = (r) => {
    if (r.timer !== null) timers.clearTimeout(r.timer);
    r.timer = null;
  };
  const failureOf = (error) => presentGenerationFailure(error);
  const settleTerminal = (id, r, phase, failure) => {
    stopTimer(r);
    r.phase = phase;
    r.failure = failure;
    r.statusUnavailable = false;
    r.version += 1;
    emit(id);
  };

  // What the server's state means for the page. `onNotStarted` says what "nothing was started" means in the caller's situation.
  const applyState = (id, r, state, onNotStarted) => {
    if (state.status === ATTEMPT_STATUS.SUCCEEDED) return settleTerminal(id, r, PHASE.SUCCEEDED, null);
    if (state.status === ATTEMPT_STATUS.FAILED) return settleTerminal(id, r, PHASE.FAILED, failureOf({ status: state.failure.httpStatus, code: state.failure.code }));
    if (state.status === ATTEMPT_STATUS.IN_PROGRESS) return enterInProgress(id, r);
    return onNotStarted();
  };

  const enterInProgress = (id, r) => {
    stopTimer(r);
    if (r.released) {
      // The report left the screen while its request was in flight: nothing is followed for a report nobody is looking at. The state is re-read when it comes back.
      r.phase = PHASE.IDLE;
      emit(id);
      return;
    }
    r.phase = PHASE.IN_PROGRESS;
    r.failure = null;
    r.statusUnavailable = false;
    r.statusErrors = 0;
    r.pollIndex = 0;
    r.pollStartedAt = now();
    emit(id);
    scheduleNext(id, r);
  };

  const scheduleNext = (id, r) => {
    stopTimer(r);
    if (disposed || r.phase !== PHASE.IN_PROGRESS) return;
    const delay = r.pollIndex < POLL_SCHEDULE_MS.length ? POLL_SCHEDULE_MS[r.pollIndex] : POLL_STEADY_MS;
    const mine = r.ticket;
    r.timer = timers.setTimeout(() => {
      r.timer = null;
      if (mine === r.ticket) void tick(id, r);
    }, delay);
  };

  const tick = async (id, r) => {
    if (disposed || r.phase !== PHASE.IN_PROGRESS || r.reading) return; // never two reads at once
    if (now() - r.pollStartedAt > STALL_AFTER_MS) {
      r.phase = PHASE.STALLED;
      emit(id);
      return;
    }
    const mine = r.ticket;
    r.reading = true;
    let state = null;
    try {
      state = mapAttemptState(await api.status(id));
    } catch {
      state = null;
    } finally {
      r.reading = false;
    }
    if (disposed || mine !== r.ticket || r.phase !== PHASE.IN_PROGRESS) return; // released, restarted or finished meanwhile: this answer is stale
    if (state === null) {
      r.statusErrors += 1;
      if (r.statusErrors >= MAX_STATUS_ERRORS) {
        r.statusUnavailable = true; // stop reading; the person can check again
        emit(id);
        return;
      }
      r.pollIndex += 1;
      scheduleNext(id, r);
      return;
    }
    r.statusErrors = 0;
    if (state.status === ATTEMPT_STATUS.IN_PROGRESS) {
      r.pollIndex += 1;
      scheduleNext(id, r);
      return;
    }
    applyState(id, r, state, () => {
      // The attempt is no longer known to the server (nothing succeeded, nothing failed): stop, and let the page fall back to its normal "no assessment yet".
      stopTimer(r);
      r.phase = PHASE.IDLE;
      emit(id);
    });
  };

  /** One read of the state; the result is applied only if nothing newer happened. */
  const readOnce = async (id, r, { onNotStarted, onError }) => {
    const mine = ++r.ticket;
    let state = null;
    let failed = false;
    try {
      state = mapAttemptState(await api.status(id));
    } catch {
      failed = true;
    }
    if (disposed || mine !== r.ticket) return;
    if (failed) return onError();
    applyState(id, r, state, onNotStarted);
  };

  const start = async (id) => {
    if (disposed) return false;
    const r = rec(id);
    if (r.phase === PHASE.STARTING) return false; // the existing guard: one POST in flight per report
    if (r.phase === PHASE.IN_PROGRESS) {
      // An attempt is already running (the backend decides that, not this page): do not ask for another; just look again.
      void refresh(id);
      return false;
    }
    stopTimer(r);
    r.released = false;
    const mine = ++r.ticket;
    r.phase = PHASE.STARTING;
    r.failure = null;
    r.statusUnavailable = false;
    emit(id);
    let result = null;
    let error = null;
    try {
      result = await api.start(id);
    } catch (err) {
      error = err;
    }
    if (disposed || mine !== r.ticket) return false;
    if (!error) {
      if (result?.kind === "in_progress") {
        enterInProgress(id, r);
        return true;
      }
      settleTerminal(id, r, PHASE.SUCCEEDED, null);
      return true;
    }
    if (error?.status === 0 && CLIENT_SIDE_ENDING.has(error?.code)) {
      // The browser stopped waiting or lost its connection: that is not the attempt's outcome. Read it; show a failure only if nothing was started.
      r.phase = PHASE.CHECKING;
      emit(id);
      await readOnce(id, r, { onNotStarted: () => settleTerminal(id, r, PHASE.FAILED, failureOf(error)), onError: () => settleTerminal(id, r, PHASE.FAILED, failureOf(error)) });
      return false;
    }
    settleTerminal(id, r, PHASE.FAILED, failureOf(error));
    return false;
  };

  const observe = async (id) => {
    if (disposed) return;
    const r = rec(id);
    r.released = false; // the report is on screen again
    if (r.phase !== PHASE.IDLE) return; // already known (or being started / read)
    r.phase = PHASE.CHECKING;
    emit(id);
    await readOnce(id, r, {
      onNotStarted: () => {
        r.phase = PHASE.IDLE;
        emit(id);
      },
      onError: () => {
        r.phase = PHASE.IDLE; // the state could not be read: the page behaves exactly as before this feature (it shows what it has)
        emit(id);
      },
    });
  };

  const refresh = async (id) => {
    if (disposed) return;
    const r = rec(id);
    if (r.reading || r.phase === PHASE.STARTING || r.phase === PHASE.CHECKING) return;
    stopTimer(r);
    r.reading = true;
    const mine = ++r.ticket;
    r.statusUnavailable = false;
    let state = null;
    try {
      state = mapAttemptState(await api.status(id));
    } catch {
      state = null;
    } finally {
      r.reading = false;
    }
    if (disposed || mine !== r.ticket) return;
    if (state === null) {
      r.statusUnavailable = true;
      if (r.phase !== PHASE.IN_PROGRESS && r.phase !== PHASE.STALLED) r.phase = PHASE.IN_PROGRESS;
      emit(id);
      return;
    }
    applyState(id, r, state, () => {
      r.phase = PHASE.IDLE;
      emit(id);
    });
  };

  const release = (id) => {
    const r = records.get(id);
    if (!r) return;
    r.released = true;
    stopTimer(r);
    // A POST already in flight is left to finish (its result is a terminal state, or "still running", which is then not followed - see enterInProgress).
    if (r.phase === PHASE.STARTING) return;
    r.ticket += 1; // anything else in flight for this report (a state read, a poll) is now stale
    r.reading = false;
    if ([PHASE.CHECKING, PHASE.IN_PROGRESS, PHASE.STALLED].includes(r.phase) && !disposed) {
      // Re-derivable from the backend on return; a terminal result is kept as it is.
      r.phase = PHASE.IDLE;
      r.statusUnavailable = false;
      emit(id);
    }
  };

  const dispose = () => {
    disposed = true;
    for (const r of records.values()) {
      stopTimer(r);
      r.ticket += 1;
    }
  };
  const activate = () => {
    disposed = false;
  };

  return { start, observe, refresh, release, dispose, activate, get: (id) => snapshot(rec(id)) };
}
