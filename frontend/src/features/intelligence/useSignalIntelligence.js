import { useCallback, useEffect, useRef, useState } from "react";
import { KOI_WORKSPACE_ID, isWorkspaceConfigured } from "../../config/workspace";
import * as koiApi from "../../services/api";
import { createSignalIntelligenceController } from "./signalIntelligenceController";

/**
 * Intelligence V1 for one Signal.
 *
 * LOADING a stored analysis is automatic and READ-ONLY: when the page opens (or the Signal changes) the hook asks the server for the stored analysis
 * (`GET /api/intelligence?signalId=`) and shows it, so a refresh or a visit back to the page shows what was already generated. That read never generates anything.
 *
 * GENERATING (`POST /api/intelligence/analyze/:signalId`) happens on explicit user action only: `generate()` is called from a click handler and nowhere else -
 * never from this effect, never on mount, no polling, no retry. This is the deliberate cost-control boundary (the server returns the stored analysis without a
 * model call when one exists, and makes at most one model call when none does).
 *
 * All of the state logic lives in signalIntelligenceController.js (pure, tested in Node); this hook only wires it to React.
 *
 * status: 'checking' | 'idle' | 'loading' | 'ready' | 'loadError' | 'unconfigured' | 'forbidden' | 'error' (see the controller). 'unconfigured' means the backend has no
 * AI provider set up (HTTP 503) - distinct from a transient failure; 'forbidden' means the signed-in role may not generate (HTTP 403, the server's decision).
 */
const initialFor = (signalId) => ({
  signalId,
  status: isWorkspaceConfigured && signalId ? "checking" : "idle",
  intelligence: null,
  error: null,
  failure: null,
  loadReason: null,
});

export function useSignalIntelligence(signalId) {
  const [state, setState] = useState(() => initialFor(signalId));
  const controllerRef = useRef(null);

  useEffect(() => {
    const controller = createSignalIntelligenceController({
      signalId,
      workspaceId: KOI_WORKSPACE_ID,
      configured: isWorkspaceConfigured,
      api: { listStored: koiApi.listSignalIntelligence, analyze: koiApi.analyzeSignal },
      onChange: setState,
    });
    controllerRef.current = controller;
    controller.load(); // a READ; the generation endpoint is not reachable from here
    return () => {
      controller.dispose();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [signalId]);

  const generate = useCallback(() => controllerRef.current?.generate(), []);
  const reload = useCallback(() => controllerRef.current?.load(), []);

  // The state belongs to one Signal: in the render between a Signal change and the new read starting, never show the previous Signal's analysis (or "no analysis").
  const current = state.signalId === signalId ? state : initialFor(signalId);
  return { intelligence: current.intelligence, status: current.status, error: current.error, failure: current.failure, loadReason: current.loadReason, generate, reload };
}
