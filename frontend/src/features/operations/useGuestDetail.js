import { useCallback, useEffect, useState } from "react";
import { KOI_WORKSPACE_ID, isWorkspaceConfigured } from "../../config/workspace";
import * as koiApi from "../../services/api";
import { mapGuestFromApi, mapStayFromApi } from "./operationsMapping";

function sortByCheckInDesc(list) {
  return [...list].sort((a, b) => new Date(b.checkIn ?? 0) - new Date(a.checkIn ?? 0));
}

/**
 * A single Guest plus their Stay history.
 *
 * Tenant isolation note: every Stay call carries `workspaceId`, and the
 * backend independently re-validates that guestId/propertyId/unitId all
 * belong to that same workspace before writing — this hook never has to
 * enforce isolation itself, it just can't construct a request that reaches
 * another workspace's data.
 *
 * guest status: 'loading' | 'ready' | 'missing' | 'error' | 'unconfigured'
 * stays status: 'loading' | 'ready' | 'error'
 */
export function useGuestDetail(guestId) {
  const [guest, setGuest] = useState(null);
  const [status, setStatus] = useState(isWorkspaceConfigured ? "loading" : "unconfigured");
  const [error, setError] = useState(null);

  const [stays, setStays] = useState([]);
  const [staysStatus, setStaysStatus] = useState("loading");
  const [staysError, setStaysError] = useState(null);

  const loadGuest = useCallback(async () => {
    if (!isWorkspaceConfigured) {
      setStatus("unconfigured");
      return;
    }
    setStatus("loading");
    setError(null);
    try {
      const found = await koiApi.getGuest(guestId, KOI_WORKSPACE_ID);
      setGuest(mapGuestFromApi(found));
      setStatus("ready");
    } catch (err) {
      if (err.status === 404 || err.status === 400) {
        setStatus("missing");
      } else {
        setError(err.message || "Could not load this guest.");
        setStatus("error");
      }
    }
  }, [guestId]);

  const loadStays = useCallback(async () => {
    if (!isWorkspaceConfigured) {
      setStaysStatus("ready");
      setStays([]);
      return;
    }
    setStaysStatus("loading");
    setStaysError(null);
    try {
      const { items } = await koiApi.listStays(KOI_WORKSPACE_ID, {
        guestId,
        limit: 100,
        sort: "-checkIn",
      });
      setStays(sortByCheckInDesc(items.map(mapStayFromApi)));
      setStaysStatus("ready");
    } catch (err) {
      setStaysError(err.message || "Could not load stays.");
      setStaysStatus("error");
    }
  }, [guestId]);

  useEffect(() => {
    loadGuest();
    loadStays();
  }, [loadGuest, loadStays]);

  const updateGuest = useCallback(
    async (updates) => {
      const saved = await koiApi.updateGuest(guestId, KOI_WORKSPACE_ID, updates);
      const mapped = mapGuestFromApi(saved);
      setGuest(mapped);
      return mapped;
    },
    [guestId],
  );

  const deleteGuest = useCallback(async () => {
    await koiApi.deleteGuest(guestId, KOI_WORKSPACE_ID);
  }, [guestId]);

  const createStay = useCallback(
    async (input) => {
      const created = await koiApi.createStay({
        workspaceId: KOI_WORKSPACE_ID,
        guestId,
        ...input,
      });
      const stay = mapStayFromApi(created);
      setStays((current) => sortByCheckInDesc([...current, stay]));
      return stay;
    },
    [guestId],
  );

  const updateStay = useCallback(async (stayId, updates) => {
    const saved = await koiApi.updateStay(stayId, KOI_WORKSPACE_ID, updates);
    const mapped = mapStayFromApi(saved);
    setStays((current) => sortByCheckInDesc(current.map((s) => (s.id === stayId ? mapped : s))));
    return mapped;
  }, []);

  const removeStay = useCallback(async (stayId) => {
    await koiApi.deleteStay(stayId, KOI_WORKSPACE_ID);
    setStays((current) => current.filter((s) => s.id !== stayId));
  }, []);

  return {
    guest,
    status,
    error,
    reload: loadGuest,
    updateGuest,
    deleteGuest,
    stays,
    staysStatus,
    staysError,
    reloadStays: loadStays,
    createStay,
    updateStay,
    removeStay,
    isConfigured: isWorkspaceConfigured,
  };
}
