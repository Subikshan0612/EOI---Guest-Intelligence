import { useCallback, useState } from "react";
import { KOI_WORKSPACE_ID, isWorkspaceConfigured } from "../../config/workspace";
import * as koiApi from "../../services/api";

/**
 * Generates real AI Signal Intelligence (Phase 4) on explicit user action
 * only. There is no effect that calls this on mount or on refresh — the
 * caller must invoke `generate()` from a click handler. This is a deliberate
 * cost-control boundary: exactly one LLM call per explicit request.
 *
 * status: 'idle' | 'loading' | 'ready' | 'unconfigured' | 'error'
 * 'unconfigured' means the backend has no AI provider set up (HTTP 503) —
 * distinct from a transient failure, which lands in 'error'.
 */
export function useSignalIntelligence(signalId) {
  const [intelligence, setIntelligence] = useState(null);
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState(null);

  const generate = useCallback(async () => {
    if (!isWorkspaceConfigured || !signalId) return;

    setStatus("loading");
    setError(null);
    try {
      const result = await koiApi.generateSignalIntelligence(signalId, KOI_WORKSPACE_ID);
      setIntelligence(result);
      setStatus("ready");
    } catch (err) {
      setError(err.message || "Could not generate intelligence for this signal.");
      setStatus(err.status === 503 ? "unconfigured" : "error");
    }
  }, [signalId]);

  return { intelligence, status, error, generate };
}
