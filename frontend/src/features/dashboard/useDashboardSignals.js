import { useCallback, useEffect, useRef, useState } from "react";
import { KOI_WORKSPACE_ID, isWorkspaceConfigured } from "../../config/workspace";
import * as koiApi from "../../services/api";
import { mapDashboardSignalItem, toDashboardParams } from "./dashboardMapping";

export const DASHBOARD_PAGE_SIZE = 20;

/**
 * The server-sorted, server-filtered Signal list for the dashboard. Re-requests
 * whenever the filters or page change (the caller resets `page` to 1 when it
 * changes a filter). Read-only: GET requests only.
 *
 * status: 'loading' | 'ready' | 'error' | 'unconfigured'
 */
export function useDashboardSignals(filters, page) {
  const [signals, setSignals] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [status, setStatus] = useState(isWorkspaceConfigured ? "loading" : "unconfigured");
  const [error, setError] = useState(null);
  const latest = useRef(0);
  const filterKey = JSON.stringify(filters);

  const load = useCallback(async () => {
    if (!isWorkspaceConfigured) {
      setStatus("unconfigured");
      return;
    }
    const ticket = ++latest.current;
    setStatus("loading");
    setError(null);
    try {
      const { items, pagination: pg } = await koiApi.getDashboardSignals(
        KOI_WORKSPACE_ID,
        toDashboardParams(JSON.parse(filterKey), page, DASHBOARD_PAGE_SIZE),
      );
      if (ticket !== latest.current) return;
      setSignals(items.map(mapDashboardSignalItem));
      setPagination(pg);
      setStatus("ready");
    } catch (err) {
      if (ticket !== latest.current) return;
      setError(err.message || "Could not load signals.");
      setStatus("error");
    }
  }, [filterKey, page]);

  useEffect(() => {
    load();
  }, [load]);

  return { signals, pagination, status, error, reload: load };
}
