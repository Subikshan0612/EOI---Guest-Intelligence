import { useEffect, useState } from "react";
import { KOI_WORKSPACE_ID, isWorkspaceConfigured } from "../../config/workspace";
import * as koiApi from "../../services/api";

/**
 * Counts for the summary strip, taken from `pagination.total` of `limit=1`
 * requests to the same list endpoint. Scope is the workspace, narrowed only by
 * the Property filter — never by the other list filters — so the numbers stay
 * stable while the list is filtered. Nothing is estimated or summed from a page.
 *
 * Open = status new + acknowledged. Critical / High = across all statuses.
 * Analyzed = Signals with a stored Intelligence V1.
 */
async function total(params) {
  const { pagination } = await koiApi.getDashboardSignals(KOI_WORKSPACE_ID, { limit: 1, ...params });
  return typeof pagination?.total === "number" ? pagination.total : null;
}

export function useDashboardSummary(propertyId) {
  const [counts, setCounts] = useState(null);
  const [status, setStatus] = useState(isWorkspaceConfigured ? "loading" : "unconfigured");

  useEffect(() => {
    if (!isWorkspaceConfigured) return undefined;
    let cancelled = false;
    const scope = propertyId ? { propertyId } : {};
    setStatus("loading");
    Promise.all([
      total({ ...scope, status: "new" }),
      total({ ...scope, status: "acknowledged" }),
      total({ ...scope, severity: "critical" }),
      total({ ...scope, severity: "high" }),
      total({ ...scope, hasIntelligence: "true" }),
    ])
      .then(([created, acked, critical, high, analyzed]) => {
        if (cancelled) return;
        if ([created, acked, critical, high, analyzed].some((n) => n === null)) throw new Error("no total");
        setCounts({ open: created + acked, critical, high, analyzed });
        setStatus("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setCounts(null);
        setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [propertyId]);

  return { counts, status };
}
