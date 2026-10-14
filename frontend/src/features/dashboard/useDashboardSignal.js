import { useCallback, useEffect, useRef, useState } from "react";
import { KOI_WORKSPACE_ID, isWorkspaceConfigured } from "../../config/workspace";
import * as koiApi from "../../services/api";
import { mapDashboardDetail } from "./dashboardMapping";

/**
 * One Signal's recorded facts plus its STORED Intelligence V1 (or null).
 * Never generates. `signalId` may be undefined (nothing selected).
 *
 * status: 'idle' | 'loading' | 'ready' | 'missing' | 'error' | 'unconfigured'
 */
export function useDashboardSignal(signalId) {
  const [detail, setDetail] = useState(null);
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState(null);
  const latest = useRef(0);

  const load = useCallback(async () => {
    if (!signalId) {
      latest.current++;
      setDetail(null);
      setStatus("idle");
      return;
    }
    if (!isWorkspaceConfigured) {
      setStatus("unconfigured");
      return;
    }
    const ticket = ++latest.current;
    setStatus("loading");
    setError(null);
    try {
      const data = await koiApi.getDashboardSignal(signalId, KOI_WORKSPACE_ID);
      if (ticket !== latest.current) return;
      setDetail(mapDashboardDetail(data));
      setStatus("ready");
    } catch (err) {
      if (ticket !== latest.current) return;
      setDetail(null);
      if (err.status === 404 || err.status === 400) {
        setStatus("missing");
      } else {
        setError(err.message || "Could not load this signal.");
        setStatus("error");
      }
    }
  }, [signalId]);

  useEffect(() => {
    load();
  }, [load]);

  return { detail, status, error, reload: load };
}
