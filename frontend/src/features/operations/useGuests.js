import { useCallback, useEffect, useState } from "react";
import { KOI_WORKSPACE_ID, isWorkspaceConfigured } from "../../config/workspace";
import * as koiApi from "../../services/api";
import { mapGuestFromApi } from "./operationsMapping";

/**
 * Guest list state for the Operations area. Same shape as `useProperties` —
 * a local hook is enough since nothing outside the Operations pages needs
 * live guest data.
 *
 * status: 'unconfigured' | 'loading' | 'ready' | 'error'
 */
export function useGuests() {
  const [guests, setGuests] = useState([]);
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
      const { items } = await koiApi.listGuests(KOI_WORKSPACE_ID, {
        limit: 100,
        sort: "lastName",
      });
      setGuests(items.map(mapGuestFromApi));
      setStatus("ready");
    } catch (err) {
      setError(err.message || "Could not load guests.");
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const createGuest = useCallback(async (input) => {
    const created = await koiApi.createGuest({ workspaceId: KOI_WORKSPACE_ID, ...input });
    const guest = mapGuestFromApi(created);
    setGuests((current) =>
      [...current, guest].sort((a, b) => a.lastName.localeCompare(b.lastName)),
    );
    return guest;
  }, []);

  const removeGuest = useCallback(async (guestId) => {
    await koiApi.deleteGuest(guestId, KOI_WORKSPACE_ID);
    setGuests((current) => current.filter((guest) => guest.id !== guestId));
  }, []);

  return {
    guests,
    status,
    error,
    reload,
    createGuest,
    removeGuest,
    isConfigured: isWorkspaceConfigured,
  };
}
