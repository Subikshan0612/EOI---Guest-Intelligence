import { useCallback, useEffect, useState } from "react";
import { KOI_WORKSPACE_ID, isWorkspaceConfigured } from "../../config/workspace";
import * as koiApi from "../../services/api";

/**
 * Deterministic operational context for one Signal (Phase 3D) — loaded
 * independently of the Signal itself so a context failure never blocks the
 * rest of SignalDetailPage from rendering.
 *
 * status: 'loading' | 'ready' | 'error' | 'unconfigured'
 */
export function useSignalContext(signalId) {
  const [context, setContext] = useState(null);
  const [status, setStatus] = useState(isWorkspaceConfigured ? "loading" : "unconfigured");
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!isWorkspaceConfigured || !signalId) {
      setStatus("unconfigured");
      return;
    }
    setStatus("loading");
    setError(null);
    try {
      const found = await koiApi.getSignalContext(signalId, KOI_WORKSPACE_ID);
      setContext(found);
      setStatus("ready");
    } catch (err) {
      setError(err.message || "Could not load operational context.");
      setStatus("error");
    }
  }, [signalId]);

  useEffect(() => {
    load();
  }, [load]);

  return { context, status, error, reload: load };
}
