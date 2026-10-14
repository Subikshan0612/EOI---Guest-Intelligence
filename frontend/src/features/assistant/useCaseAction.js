import { useCallback, useEffect, useRef, useState } from "react";
import { KOI_WORKSPACE_ID, isWorkspaceConfigured } from "../../config/workspace";
import * as koiApi from "../../services/api";
import { describeActionFailure, mapCaseAction } from "./actionMapping";

/**
 * The Action PROPOSAL for ONE approved Decision (Phase 49).
 *
 * LOADING is a GET (`GET /api/actions?decisionId=`): opening or refreshing a case reads what exists and creates nothing - there is no polling and no regeneration.
 * The writes are only reachable from the panel's buttons: `propose()` (POST /actions/propose/:decisionId, NO body - the server derives the type, risk, urgency and
 * provenance), `approve(note)` and `reject({note})`. None of them calls the AI, none carries anything out, and the server remains the authority on who may do what:
 * the page only shows what the server answered. One request at a time (the server's unique index is what actually prevents a duplicate).
 *
 * `decisionId` is null until the Decision is approved: with no Decision to follow, this hook does nothing at all.
 * status: 'idle' (no approved Decision) | 'checking' | 'ready' (`action` is the proposal or null) | 'loadError'
 */
export function useCaseAction(decisionId) {
  const [state, setState] = useState({ for: null, status: "idle", action: null });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);
  const inFlight = useRef(false);
  const ticket = useRef(0);

  const load = useCallback(async () => {
    if (!decisionId || !isWorkspaceConfigured) {
      setState({ for: decisionId ?? null, status: "idle", action: null });
      return;
    }
    const mine = ++ticket.current;
    setState({ for: decisionId, status: "checking", action: null });
    try {
      const page = await koiApi.listActions(KOI_WORKSPACE_ID, { decisionId, limit: 5 });
      if (mine !== ticket.current) return;
      setState({ for: decisionId, status: "ready", action: page.items.map(mapCaseAction).find(Boolean) ?? null });
    } catch (error) {
      if (mine !== ticket.current) return;
      // A role that may propose but not read the list (403) simply sees no proposal yet; proposing again is idempotent and returns the existing one.
      if (error?.status === 403) setState({ for: decisionId, status: "ready", action: null });
      else setState({ for: decisionId, status: "loadError", action: null });
    }
  }, [decisionId]);

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
        const action = mapCaseAction(await call());
        if (!action) throw new Error("malformed");
        setState({ for: decisionId, status: "ready", action });
        return action;
      } catch (error) {
        setActionError(describeActionFailure(error));
        if (error?.status === 404 || error?.status === 409) load();
        return null;
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [decisionId, load],
  );

  // The person's single approval of a recommendation also makes its Action ready (Phase 52): right after the Decision is approved - in the same click handler, never from an
  // effect - this records the Action PROPOSAL and its approval through the two ordinary server calls (the server still derives every field and checks every permission; a
  // reviewer's own approval is the only way here). Nothing is carried out. If either call fails the page simply shows the ordinary Action step (propose / approve buttons)
  // with the reason, never a half-hidden record. The decision id is passed in because the Decision was approved only a moment ago.
  const prepareFor = async (approvedDecisionId) => {
    if (!approvedDecisionId || inFlight.current || !isWorkspaceConfigured) return null;
    inFlight.current = true;
    setBusy(true);
    setActionError(null);
    let latest = null;
    try {
      latest = mapCaseAction(await koiApi.proposeAction(approvedDecisionId, KOI_WORKSPACE_ID));
      if (!latest) throw new Error("malformed");
      setState({ for: approvedDecisionId, status: "ready", action: latest });
      if (latest.status === "proposed") {
        const approved = mapCaseAction(await koiApi.approveAction(latest.id, KOI_WORKSPACE_ID, {}));
        if (!approved) throw new Error("malformed");
        latest = approved;
      }
    } catch (error) {
      setActionError(describeActionFailure(error));
    } finally {
      ticket.current += 1; // a read that started meanwhile must not overwrite this result
      if (latest) setState({ for: approvedDecisionId, status: "ready", action: latest });
      inFlight.current = false;
      setBusy(false);
    }
    return latest;
  };

  const current = state.for === (decisionId ?? null) ? state : { status: decisionId ? "checking" : "idle", action: null };
  return {
    status: current.status,
    action: current.action,
    busy,
    actionError,
    reload: load,
    prepareFor,
    propose: () => run(() => koiApi.proposeAction(decisionId, KOI_WORKSPACE_ID)),
    approve: (note) => run(() => koiApi.approveAction(current.action.id, KOI_WORKSPACE_ID, note ? { note } : {})),
    reject: ({ note }) => run(() => koiApi.rejectAction(current.action.id, KOI_WORKSPACE_ID, note ? { note } : {})),
  };
}
