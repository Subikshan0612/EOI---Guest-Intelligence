import { useEffect, useState } from "react";
import { KOI_WORKSPACE_ID } from "../../config/workspace";
import * as koiApi from "../../services/api";
import { mapUnitFromApi } from "./operationsMapping";

/**
 * The units of ONE property, for choosing a stay's room. The list is requested for the given property only (GET /units?propertyId=), so no other property's unit is ever offered;
 * the server still verifies the chosen unit when the stay is saved.
 * status: 'idle' (no property) | 'loading' | 'ready' | 'error'
 */
export function useUnitsForProperty(propertyId) {
  const [state, setState] = useState({ status: propertyId ? "loading" : "idle", units: [], error: null });

  useEffect(() => {
    if (!propertyId) {
      setState({ status: "idle", units: [], error: null });
      return undefined;
    }
    let cancelled = false;
    setState({ status: "loading", units: [], error: null });
    koiApi
      .listUnits(KOI_WORKSPACE_ID, { propertyId, limit: 100, sort: "unitNumber" })
      .then(({ items }) => !cancelled && setState({ status: "ready", units: items.map(mapUnitFromApi), error: null }))
      .catch((err) => !cancelled && setState({ status: "error", units: [], error: err.message || "Could not load units for this property." }));
    return () => {
      cancelled = true;
    };
  }, [propertyId]);

  return state;
}
