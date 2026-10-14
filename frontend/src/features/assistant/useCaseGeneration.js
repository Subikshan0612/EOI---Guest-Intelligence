import { useCallback, useEffect, useRef, useState } from "react";
import { KOI_WORKSPACE_ID, isWorkspaceConfigured } from "../../config/workspace";
import * as koiApi from "../../services/api";
import { PHASE, createAnalysisAttemptController } from "./analysisAttemptController";

/**
 * Asking EOI to assess a recorded report (Phase 52), and following the analysis until it ends (Workstream 5B). `generate(signalId)` is the one place the assistant starts an analysis
 * (POST /api/intelligence/analyze/:signalId - the server returns the stored assessment without a model call when one exists, returns the state of the attempt that is already running
 * when there is one, and makes at most one model call when there is neither). It is called from exactly two user actions and nowhere else: right after the person SENDS a report (the
 * page's submit handler) and when they press the visible "Assess this" / "Try again" button. Opening a conversation, refreshing, navigating back or rendering a case never starts one:
 * those only READ (`observe`: one read of the attempt's state when a report has no assessment shown).
 *
 * The attempt lifecycle itself - POST, the HTTP 202 "still running" answer, reading the state while it runs, stopping on a terminal state or when the report leaves the screen - lives
 * in analysisAttemptController.js (pure, tested in Node). This hook only wires it to React and clears every timer when the page is gone. It does not hold the analysis: the server
 * stores it and the case reads it back (useSignalIntelligence), whenever `version` changes.
 */
const EMPTY = Object.freeze({ phase: PHASE.IDLE, busy: false, checking: false, inProgress: false, stalled: false, statusUnavailable: false, failure: null, version: 0 });

export function useCaseGeneration() {
  const [states, setStates] = useState({});
  const controllerRef = useRef(null);
  if (controllerRef.current === null) {
    controllerRef.current = createAnalysisAttemptController({
      api: {
        start: (signalId) => koiApi.startAnalysis(signalId, KOI_WORKSPACE_ID),
        status: (signalId) => koiApi.getAnalysisStatus(signalId, KOI_WORKSPACE_ID),
      },
      onChange: (signalId, snapshot) => setStates((current) => ({ ...current, [signalId]: snapshot })),
    });
  }

  // Leaving the page (navigation, unmount) stops every poll. The backend attempt is NOT cancelled by this: coming back reads its state again.
  useEffect(() => {
    const controller = controllerRef.current;
    controller.activate();
    return () => controller.dispose();
  }, []);

  const generate = useCallback((signalId) => {
    if (!signalId || !isWorkspaceConfigured) return Promise.resolve(false);
    return controllerRef.current.start(signalId);
  }, []);
  const observe = useCallback((signalId) => (signalId && isWorkspaceConfigured ? controllerRef.current.observe(signalId) : undefined), []);
  const refresh = useCallback((signalId) => (signalId && isWorkspaceConfigured ? controllerRef.current.refresh(signalId) : undefined), []);
  const release = useCallback((signalId) => controllerRef.current.release(signalId), []);
  const forSignal = useCallback((signalId) => states[signalId] ?? EMPTY, [states]);

  return { generate, observe, refresh, release, forSignal };
}
