import { useCallback, useEffect, useState } from "react";
import { KOI_WORKSPACE_ID, isWorkspaceConfigured } from "../../config/workspace";
import * as koiApi from "../../services/api";
import { mapSignalFromApi } from "./operationsMapping";

/**
 * Signal list state for the Operations area. Same shape as `useProperties`/
 * `useGuests` — a local hook is enough, no context needed.
 *
 * `filters` is a small, flat object of optional query params (type, severity,
 * status) — this is intentionally not a search engine, just the filters the
 * backend already supports.
 *
 * status: 'unconfigured' | 'loading' | 'ready' | 'error'
 */
export function useSignals() {
  const [signals, setSignals] = useState([]);
  const [status, setStatus] = useState(isWorkspaceConfigured ? "loading" : "unconfigured");
  const [error, setError] = useState(null);
  const [filters, setFilters] = useState({});

  const reload = useCallback(
    async (nextFilters = filters) => {
      if (!isWorkspaceConfigured) {
        setStatus("unconfigured");
        return;
      }
      setStatus("loading");
      setError(null);
      setFilters(nextFilters);
      try {
        const { items } = await koiApi.listSignals(KOI_WORKSPACE_ID, {
          limit: 100,
          sort: "-occurredAt",
          ...nextFilters,
        });
        setSignals(items.map(mapSignalFromApi));
        setStatus("ready");
      } catch (err) {
        setError(err.message || "Could not load signals.");
        setStatus("error");
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    reload({});
    // Only on mount — `reload` itself is called explicitly with new filters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const createSignal = useCallback(async (input) => {
    const created = await koiApi.createSignal({ workspaceId: KOI_WORKSPACE_ID, ...input });
    const signal = mapSignalFromApi(created);
    setSignals((current) => [signal, ...current]);
    return signal;
  }, []);

  const removeSignal = useCallback(async (signalId) => {
    await koiApi.deleteSignal(signalId, KOI_WORKSPACE_ID);
    setSignals((current) => current.filter((signal) => signal.id !== signalId));
  }, []);

  return {
    signals,
    status,
    error,
    filters,
    reload,
    createSignal,
    removeSignal,
    isConfigured: isWorkspaceConfigured,
  };
}
