import { mapIntelligenceAnalysis, selectStoredAnalysis } from "./intelligenceMapping";
import { presentGenerationFailure } from "./intelligenceErrorPresentation";

/**
 * The load / generate state machine of the Signal Intelligence page, kept free of React so it can be tested deterministically.
 *
 *   load()      READS the stored analysis (GET only) and shows it. It NEVER calls the generation endpoint: the controller is only given `listStored` for it,
 *               and `analyze` is reachable from generate() alone, which only a user click calls. Opening, refreshing and navigating back therefore cost one read
 *               and zero model calls. (A stored analysis found here goes through the SAME mapping as a freshly generated one: mapIntelligenceAnalysis.)
 *   generate()  the existing explicit, user-initiated generation (POST /analyze), unchanged: the server returns the stored analysis without a model call when one
 *               exists, and generates once when none does.
 *   dispose()   invalidates anything in flight (a stale response can never overwrite the state of a later request or another Signal).
 *
 * status:
 *   'checking'      the read is pending - NOT "no analysis"
 *   'idle'          the read confirmed there is no stored analysis (the Generate control belongs here, and only here)
 *   'loading'       a user-initiated generation is running
 *   'ready'         an analysis is shown (stored or generated)
 *   'loadError'     the READ failed (`loadReason`: 'unauthenticated' | 'forbidden' | 'error'); nothing is shown as "no analysis"
 *   'unconfigured' | 'forbidden' | 'error'   as before, for generation; `failure` = { title, message, retryable } - fixed, user-safe wording (Phase 43D)
 */
export function createSignalIntelligenceController({ signalId, workspaceId, configured, api, onChange }) {
  let ticket = 0;
  let disposed = false;
  const state = { signalId, status: configured && signalId ? "checking" : "idle", intelligence: null, error: null, failure: null, loadReason: null };
  const emit = (patch) => {
    if (disposed) return;
    Object.assign(state, patch);
    onChange({ ...state });
  };

  const load = async () => {
    if (!configured || !signalId) {
      emit({ status: "idle", intelligence: null, error: null, failure: null, loadReason: null });
      return;
    }
    const mine = ++ticket;
    emit({ status: "checking", intelligence: null, error: null, failure: null, loadReason: null });
    try {
      const items = await api.listStored(signalId, workspaceId);
      if (mine !== ticket) return;
      const stored = selectStoredAnalysis(items);
      if (!stored) emit({ status: "idle", intelligence: null });
      else emit({ status: "ready", intelligence: mapIntelligenceAnalysis(stored) });
    } catch (err) {
      if (mine !== ticket) return;
      // 404 = nothing stored (the empty state). Anything else is a real failure and is never shown as "no analysis". The message is a fixed one chosen
      // by the page from `loadReason`: a server reason code or text never reaches the UI from here.
      if (err?.status === 404) {
        emit({ status: "idle", intelligence: null });
        return;
      }
      emit({ status: "loadError", intelligence: null, loadReason: err?.status === 401 ? "unauthenticated" : err?.status === 403 ? "forbidden" : "error" });
    }
  };

  const generate = async () => {
    if (!configured || !signalId) return;
    const mine = ++ticket; // also invalidates a read still in flight
    emit({ status: "loading", error: null, failure: null, loadReason: null });
    try {
      const view = await api.analyze(signalId, workspaceId);
      if (mine !== ticket) return;
      emit({ status: "ready", intelligence: mapIntelligenceAnalysis(view) });
    } catch (err) {
      if (mine !== ticket) return;
      // Phase 43D: the SERVER'S MESSAGE IS NEVER SHOWN. It can carry raw validator codes or reference-like text; what a person sees is a fixed sentence chosen from
      // the error's structured fields only (status / code / rule) - see intelligenceErrorPresentation.js. The status keeps its existing meaning for the page.
      const failure = presentGenerationFailure(err);
      emit({
        failure,
        error: failure.message,
        status: err.status === 503 ? "unconfigured" : err.status === 403 ? "forbidden" : "error",
      });
    }
  };

  const dispose = () => {
    disposed = true;
    ticket += 1;
  };

  return { load, generate, dispose };
}
