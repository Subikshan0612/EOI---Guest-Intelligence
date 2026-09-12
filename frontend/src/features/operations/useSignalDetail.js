import { useCallback, useEffect, useState } from "react";
import { KOI_WORKSPACE_ID, isWorkspaceConfigured } from "../../config/workspace";
import * as koiApi from "../../services/api";
import {
  formatGuestName,
  mapGuestFromApi,
  mapPropertyFromApi,
  mapSignalFromApi,
  mapStayFromApi,
  mapUnitFromApi,
} from "./operationsMapping";

/**
 * A single Signal plus resolved display names for whichever of
 * Property/Unit/Guest/Stay it references. A Signal touches at most four other
 * records, so targeted lookups (not a bulk cache) are the simplest correct
 * approach here — unlike GuestDetailPage's stay list, which resolves many
 * stays against a shared property/unit lookup.
 *
 * If a referenced record was deleted (Phase 2E/3A/3B don't cascade-delete),
 * that one reference silently shows as unresolved rather than failing the
 * whole page — consistent with the rest of KOI's non-cascade behavior.
 *
 * status: 'loading' | 'ready' | 'missing' | 'error' | 'unconfigured'
 */
export function useSignalDetail(signalId) {
  const [signal, setSignal] = useState(null);
  const [status, setStatus] = useState(isWorkspaceConfigured ? "loading" : "unconfigured");
  const [error, setError] = useState(null);
  const [refs, setRefs] = useState({ property: null, unit: null, guest: null, stay: null });

  const load = useCallback(async () => {
    if (!isWorkspaceConfigured) {
      setStatus("unconfigured");
      return;
    }
    setStatus("loading");
    setError(null);
    try {
      const found = await koiApi.getSignal(signalId, KOI_WORKSPACE_ID);
      setSignal(mapSignalFromApi(found));
      setStatus("ready");
    } catch (err) {
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

  useEffect(() => {
    if (!signal || !isWorkspaceConfigured) return;

    let cancelled = false;
    const lookups = [
      signal.propertyId &&
        koiApi
          .getProperty(signal.propertyId, KOI_WORKSPACE_ID)
          .then((doc) => ({ key: "property", value: mapPropertyFromApi(doc)?.name }))
          .catch(() => ({ key: "property", value: null })),
      signal.unitId &&
        koiApi
          .getUnit(signal.unitId, KOI_WORKSPACE_ID)
          .then((doc) => ({ key: "unit", value: mapUnitFromApi(doc)?.unitNumber }))
          .catch(() => ({ key: "unit", value: null })),
      signal.guestId &&
        koiApi
          .getGuest(signal.guestId, KOI_WORKSPACE_ID)
          .then((doc) => ({ key: "guest", value: formatGuestName(mapGuestFromApi(doc)) }))
          .catch(() => ({ key: "guest", value: null })),
      signal.stayId &&
        koiApi
          .getStay(signal.stayId, KOI_WORKSPACE_ID)
          .then((doc) => ({ key: "stay", value: mapStayFromApi(doc) }))
          .catch(() => ({ key: "stay", value: null })),
    ].filter(Boolean);

    Promise.all(lookups).then((resolved) => {
      if (cancelled) return;
      setRefs((current) => {
        const next = { ...current };
        resolved.forEach(({ key, value }) => {
          next[key] = value;
        });
        return next;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [signal?.propertyId, signal?.unitId, signal?.guestId, signal?.stayId]);

  const updateSignal = useCallback(
    async (updates) => {
      const saved = await koiApi.updateSignal(signalId, KOI_WORKSPACE_ID, updates);
      const mapped = mapSignalFromApi(saved);
      setSignal(mapped);
      return mapped;
    },
    [signalId],
  );

  const deleteSignal = useCallback(async () => {
    await koiApi.deleteSignal(signalId, KOI_WORKSPACE_ID);
  }, [signalId]);

  return {
    signal,
    status,
    error,
    reload: load,
    refs,
    updateSignal,
    deleteSignal,
    isConfigured: isWorkspaceConfigured,
  };
}
