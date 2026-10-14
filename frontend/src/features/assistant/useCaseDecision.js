import { useCallback, useEffect, useRef, useState } from "react";
import { KOI_WORKSPACE_ID, isWorkspaceConfigured } from "../../config/workspace";
import * as koiApi from "../../services/api";
import { describeDecisionFailure, mapCaseDecision } from "./decisionMapping";

/**
 * The Decision for ONE stored Intelligence (Phase 48).
 *
 * LOADING is a GET (`GET /api/decisions?intelligenceId=`): opening or refreshing a case reads what exists and creates nothing. The three writes are only reachable
 * from the panel's buttons: `propose()` (POST /decisions/propose/:intelligenceId, no body), `approve(note)` and `reject({note, alternative})`. A person who may
 * review confirms their own decision in one step: `approve` / `reject` first record the Decision (the same idempotent propose) when none exists yet, then review it
 * - two ordinary server calls, never a shortcut around either. None of them calls the AI, none carries out anything, and the server remains the authority on who
 * may do what: the page only shows what the server answered. One request at a time.
 *
 * status: 'idle' (no Intelligence yet) | 'checking' | 'ready' (`decision` is the record or null) | 'loadError'
 */
export function useCaseDecision(intelligenceId) {
  const [state, setState] = useState({ for: null, status: "idle", decision: null });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);
  const inFlight = useRef(false);
  const ticket = useRef(0);

  const load = useCallback(async () => {
    if (!intelligenceId || !isWorkspaceConfigured) {
      setState({ for: intelligenceId ?? null, status: "idle", decision: null });
      return;
    }
    const mine = ++ticket.current;
    setState({ for: intelligenceId, status: "checking", decision: null });
    try {
      const page = await koiApi.listDecisions(KOI_WORKSPACE_ID, { intelligenceId, limit: 5 });
      if (mine !== ticket.current) return;
      const decision = page.items.map(mapCaseDecision).find(Boolean) ?? null;
      setState({ for: intelligenceId, status: "ready", decision });
    } catch {
      if (mine !== ticket.current) return;
      setState({ for: intelligenceId, status: "loadError", decision: null });
    }
  }, [intelligenceId]);

  useEffect(() => {
    load();
    return () => {
      ticket.current += 1;
    };
  }, [load]);

  const run = useCallback(
    async (call) => {
      if (inFlight.current || !isWorkspaceConfigured) return null;
      inFlight.current = true;
      setBusy(true);
      setActionError(null);
      try {
        const decision = mapCaseDecision(await call());
        if (!decision) throw new Error("malformed");
        setState({ for: intelligenceId, status: "ready", decision });
        return decision;
      } catch (error) {
        setActionError(describeDecisionFailure(error));
        // A 404 / 409 means the record moved on without us: read it again rather than leave a stale view.
        if (error?.status === 404 || error?.status === 409) load();
        return null;
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [intelligenceId, load],
  );

  // The Decision to review: the one that exists, or the one the (idempotent) propose call returns. A propose that succeeds and a review that then fails
  // leaves a real, submitted Decision on the page (the panel shows the review step) - never a half-hidden one.
  const ensureDecision = async (existing) => {
    if (existing) return existing;
    const created = mapCaseDecision(await koiApi.proposeDecision(intelligenceId, KOI_WORKSPACE_ID));
    if (!created) throw new Error("malformed");
    setState({ for: intelligenceId, status: "ready", decision: created });
    return created;
  };

  const current = state.for === (intelligenceId ?? null) ? state : { status: intelligenceId ? "checking" : "idle", decision: null };
  return {
    status: current.status,
    decision: current.decision,
    busy,
    actionError,
    reload: load,
    propose: () => run(() => koiApi.proposeDecision(intelligenceId, KOI_WORKSPACE_ID)),
    approve: (note) => run(async () => koiApi.approveDecision((await ensureDecision(current.decision)).id, KOI_WORKSPACE_ID, note ? { note } : {})),
    reject: ({ note, alternative }) =>
      run(async () => koiApi.rejectDecision((await ensureDecision(current.decision)).id, KOI_WORKSPACE_ID, { ...(note ? { note } : {}), ...(alternative ? { alternative } : {}) })),
  };
}
