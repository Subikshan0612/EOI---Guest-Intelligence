import { useEffect, useState } from "react";
import { KOI_WORKSPACE_ID, isWorkspaceConfigured } from "../../config/workspace";
import * as koiApi from "../../services/api";
import { mapPropertyFromApi } from "./operationsMapping";

/**
 * The workspace's properties, for the places that must choose one (a guest belongs to a property). A read only.
 * status: 'loading' | 'ready' | 'error'
 */
export function useWorkspaceProperties() {
  const [state, setState] = useState({ status: isWorkspaceConfigured ? "loading" : "ready", properties: [] });

  useEffect(() => {
    if (!isWorkspaceConfigured) return undefined;
    let cancelled = false;
    koiApi
      .listProperties(KOI_WORKSPACE_ID, { limit: 100, sort: "name" })
      .then(({ items }) => !cancelled && setState({ status: "ready", properties: items.map(mapPropertyFromApi).filter(Boolean) }))
      .catch(() => !cancelled && setState({ status: "error", properties: [] }));
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
