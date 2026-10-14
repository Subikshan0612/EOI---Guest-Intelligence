import { useCallback, useEffect, useRef, useState } from "react";
import { KOI_WORKSPACE_ID, isWorkspaceConfigured } from "../../config/workspace";
import * as koiApi from "../../services/api";
import { describeOutcomeFailure, mapCaseOutcome } from "./outcomeMapping";

/**
 * The OUTCOME recorded for ONE approved Action (Phase 50).
 *
 * LOADING is a GET (`GET /api/outcomes?actionId=`): opening or refreshing a case reads what exists and creates nothing - there is no polling, no retry and no model call.
 * The one write is `record({ status, summary })` (POST /outcomes/record/:actionId), reachable only from the form's confirmation button. The browser names the Action (a route
 * value) and sends the person's own words; the server derives the workspace, the actor and the whole chain (decision, intelligence, signal) from the stored Action. It does not
 * call the AI and carries nothing out. One request at a time here; the server's unique index is what actually prevents a second Outcome.
 *
 * `actionId` is null until the Action is approved: with no approved Action this hook does nothing at all.
 * status: 'idle' (no approved Action) | 'checking' | 'ready' (`outcome` is the record or null) | 'loadError'
 */
export function useCaseOutcome(actionId) {
  const [state, setState] = useState({ for: null, status: "idle", outcome: null });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);
  const inFlight = useRef(false);
  const ticket = useRef(0);

  const load = useCallback(async () => {
    if (!actionId || !isWorkspaceConfigured) {
      setState({ for: actionId ?? null, status: "idle", outcome: null });
      return;
    }
    const mine = ++ticket.current;
    setState({ for: actionId, status: "checking", outcome: null });
    try {
      const page = await koiApi.listOutcomes(KOI_WORKSPACE_ID, { actionId, limit: 5 });
      if (mine !== ticket.current) return;
      setState({ for: actionId, status: "ready", outcome: page.items.map(mapCaseOutcome).find(Boolean) ?? null });
    } catch (error) {
      if (mine !== ticket.current) return;
      // A role that may record but not read the list (403) simply sees nothing yet; a second recording is refused by the server (409), never duplicated.
      if (error?.status === 403) setState({ for: actionId, status: "ready", outcome: null });
      else setState({ for: actionId, status: "loadError", outcome: null });
    }
  }, [actionId]);

  useEffect(() => {
    load();
    return () => {
      ticket.current += 1;
    };
  }, [load]);

  const record = useCallback(
    async ({ status, summary }) => {
      if (inFlight.current || !isWorkspaceConfigured || !actionId) return null;
      inFlight.current = true;
      setBusy(true);
      setActionError(null);
      try {
        const outcome = mapCaseOutcome(await koiApi.recordOutcome(actionId, KOI_WORKSPACE_ID, { status, result: { summary } }));
        if (!outcome) throw new Error("malformed");
        setState({ for: actionId, status: "ready", outcome });
        return outcome;
      } catch (error) {
        setActionError(describeOutcomeFailure(error));
        // 404 / 409: the record moved on without us (for example it was already recorded): read it again rather than leave a stale view.
        if (error?.status === 404 || error?.status === 409) load();
        return null;
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [actionId, load],
  );

  const current = state.for === (actionId ?? null) ? state : { status: actionId ? "checking" : "idle", outcome: null };
  return { status: current.status, outcome: current.outcome, busy, actionError, reload: load, record };
}
