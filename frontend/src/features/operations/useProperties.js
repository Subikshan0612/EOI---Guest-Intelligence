import { useCallback, useEffect, useState } from "react";
import { KOI_WORKSPACE_ID, isWorkspaceConfigured } from "../../config/workspace";
import * as koiApi from "../../services/api";
import { mapPropertyFromApi } from "./operationsMapping";

/**
 * Property list state for the Operations area. Kept separate from
 * ConversationProvider — properties/units are a different domain with no
 * cross-component sharing need (unlike conversations, which Sidebar/Header/
 * ContextPanel all read), so a local hook is enough; no context required.
 *
 * status: 'unconfigured' | 'loading' | 'ready' | 'error'
 */
export function useProperties() {
  const [properties, setProperties] = useState([]);
  const [status, setStatus] = useState(isWorkspaceConfigured ? "loading" : "unconfigured");
  const [error, setError] = useState(null);

  const reload = useCallback(async () => {
    if (!isWorkspaceConfigured) {
      setStatus("unconfigured");
      return;
    }
    setStatus("loading");
    setError(null);
    try {
      const { items } = await koiApi.listProperties(KOI_WORKSPACE_ID, {
        limit: 100,
        sort: "name",
      });
      setProperties(items.map(mapPropertyFromApi));
      setStatus("ready");
    } catch (err) {
      setError(err.message || "Could not load properties.");
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const createProperty = useCallback(async (input) => {
    const created = await koiApi.createProperty({ workspaceId: KOI_WORKSPACE_ID, ...input });
    const property = mapPropertyFromApi(created);
    setProperties((current) =>
      [...current, property].sort((a, b) => a.name.localeCompare(b.name)),
    );
    return property;
  }, []);

  const removeProperty = useCallback(async (propertyId) => {
    await koiApi.deleteProperty(propertyId, KOI_WORKSPACE_ID);
    setProperties((current) => current.filter((property) => property.id !== propertyId));
  }, []);

  return {
    properties,
    status,
    error,
    reload,
    createProperty,
    removeProperty,
    isConfigured: isWorkspaceConfigured,
  };
}
