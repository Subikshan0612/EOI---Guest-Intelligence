import { useCallback, useEffect, useState } from "react";
import { KOI_WORKSPACE_ID, isWorkspaceConfigured } from "../../config/workspace";
import * as koiApi from "../../services/api";
import { mapPropertyFromApi, mapUnitFromApi } from "./operationsMapping";

/**
 * A single Property plus the Units that belong to it.
 *
 * Tenant isolation note: the backend resolves a Unit's workspace through its
 * Property (Unit has no workspaceId column). We always ask for units scoped
 * by both `workspaceId` and `propertyId`, so this never depends on the
 * frontend to enforce isolation — the API rejects anything outside the
 * caller's workspace regardless of what this hook requests.
 *
 * property status: 'loading' | 'ready' | 'missing' | 'error' | 'unconfigured'
 * units status: 'loading' | 'ready' | 'error'
 */
export function usePropertyDetail(propertyId) {
  const [property, setProperty] = useState(null);
  const [status, setStatus] = useState(isWorkspaceConfigured ? "loading" : "unconfigured");
  const [error, setError] = useState(null);

  const [units, setUnits] = useState([]);
  const [unitsStatus, setUnitsStatus] = useState("loading");
  const [unitsError, setUnitsError] = useState(null);

  const loadProperty = useCallback(async () => {
    if (!isWorkspaceConfigured) {
      setStatus("unconfigured");
      return;
    }
    setStatus("loading");
    setError(null);
    try {
      const found = await koiApi.getProperty(propertyId, KOI_WORKSPACE_ID);
      setProperty(mapPropertyFromApi(found));
      setStatus("ready");
    } catch (err) {
      if (err.status === 404 || err.status === 400) {
        setStatus("missing");
      } else {
        setError(err.message || "Could not load this property.");
        setStatus("error");
      }
    }
  }, [propertyId]);

  const loadUnits = useCallback(async () => {
    if (!isWorkspaceConfigured) {
      setUnitsStatus("ready");
      setUnits([]);
      return;
    }
    setUnitsStatus("loading");
    setUnitsError(null);
    try {
      const { items } = await koiApi.listUnits(KOI_WORKSPACE_ID, {
        propertyId,
        limit: 100,
        sort: "unitNumber",
      });
      setUnits(items.map(mapUnitFromApi));
      setUnitsStatus("ready");
    } catch (err) {
      setUnitsError(err.message || "Could not load units.");
      setUnitsStatus("error");
    }
  }, [propertyId]);

  useEffect(() => {
    loadProperty();
    loadUnits();
  }, [loadProperty, loadUnits]);

  const updateProperty = useCallback(
    async (updates) => {
      const saved = await koiApi.updateProperty(propertyId, KOI_WORKSPACE_ID, updates);
      const mapped = mapPropertyFromApi(saved);
      setProperty(mapped);
      return mapped;
    },
    [propertyId],
  );

  const deleteProperty = useCallback(async () => {
    await koiApi.deleteProperty(propertyId, KOI_WORKSPACE_ID);
  }, [propertyId]);

  const createUnit = useCallback(
    async (input) => {
      const created = await koiApi.createUnit({
        workspaceId: KOI_WORKSPACE_ID,
        propertyId,
        ...input,
      });
      const unit = mapUnitFromApi(created);
      setUnits((current) =>
        [...current, unit].sort((a, b) => a.unitNumber.localeCompare(b.unitNumber, undefined, { numeric: true })),
      );
      return unit;
    },
    [propertyId],
  );

  const updateUnit = useCallback(async (unitId, updates) => {
    const saved = await koiApi.updateUnit(unitId, KOI_WORKSPACE_ID, updates);
    const mapped = mapUnitFromApi(saved);
    setUnits((current) => current.map((unit) => (unit.id === unitId ? mapped : unit)));
    return mapped;
  }, []);

  const removeUnit = useCallback(async (unitId) => {
    await koiApi.deleteUnit(unitId, KOI_WORKSPACE_ID);
    setUnits((current) => current.filter((unit) => unit.id !== unitId));
  }, []);

  return {
    property,
    status,
    error,
    reload: loadProperty,
    updateProperty,
    deleteProperty,
    units,
    unitsStatus,
    unitsError,
    reloadUnits: loadUnits,
    createUnit,
    updateUnit,
    removeUnit,
    isConfigured: isWorkspaceConfigured,
  };
}
