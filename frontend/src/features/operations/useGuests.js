import { useCallback, useEffect, useState } from "react";
import { KOI_WORKSPACE_ID, isWorkspaceConfigured } from "../../config/workspace";
import * as koiApi from "../../services/api";
import { mapGuestFromApi, mapStayFromApi } from "./operationsMapping";

/**
 * Guest list state for the Operations area. Same shape as `useProperties` —
 * a local hook is enough since nothing outside the Operations pages needs
 * live guest data.
 *
 * status: 'unconfigured' | 'loading' | 'ready' | 'error'
 */
export function useGuests(propertyId = "") {
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
      // With a property selected the SERVER returns only that property's guests (GET /guests?propertyId=).
      const { items } = await koiApi.listGuests(KOI_WORKSPACE_ID, {
        ...(propertyId ? { propertyId } : {}),
        limit: 100,
        sort: "lastName",
      });
      setGuests(items.map(mapGuestFromApi));
      setStatus("ready");
    } catch (err) {
      setError(err.message || "Could not load guests.");
      setStatus("error");
    }
  }, [propertyId]);

  useEffect(() => {
    reload();
  }, [reload]);

  const createGuest = useCallback(async (input) => {
    const created = await koiApi.createGuest({ workspaceId: KOI_WORKSPACE_ID, ...input });
    const guest = mapGuestFromApi(created);
    // A guest created together with its first stay (POST /guests with `stay`) comes back with that stay.
    if (created.stay) guest.stay = mapStayFromApi(created.stay);
    if (created.unit) guest.unit = { id: created.unit._id, unitNumber: created.unit.unitNumber, created: created.unit.created === true };
    // The list shows one property's guests when a property is selected: a guest of another property is not appended to it.
    if (!propertyId || guest.propertyId === propertyId) {
      setGuests((current) =>
        [...current, guest].sort((a, b) => a.lastName.localeCompare(b.lastName)),
      );
    }
    return guest;
  }, [propertyId]);

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
