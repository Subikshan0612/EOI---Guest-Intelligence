import { useCallback, useEffect, useMemo, useState } from "react";
import { KOI_WORKSPACE_ID, isWorkspaceConfigured } from "../../config/workspace";
import * as koiApi from "../../services/api";
import { mapGuestFromApi, mapPropertyFromApi, mapStayFromApi, mapUnitFromApi } from "../operations/operationsMapping";
import { EMPTY_SELECTION, changeSelection, describeSelectors, selectionToContext } from "./contextSelection";

const IDLE = Object.freeze({ status: "idle", items: [] });

/**
 * The Property -> Guest -> Stay selection that starts an investigation, and the options each level may offer. Every list is READ from the server FILTERED by the level above
 * (GET /guests?propertyId=, GET /stays?propertyId=&guestId=), so records of other properties are never fetched, let alone shown; the server also verifies the relationship, and
 * re-verifies the whole selection again when the investigation is created. Nothing here writes anything or calls the AI.
 *
 * Changing a level clears the levels below it (contextSelection.js), and a response that arrives after the selection moved on is discarded.
 */
export function useContextSelection() {
  const [selection, setSelection] = useState(EMPTY_SELECTION);
  const [properties, setProperties] = useState(isWorkspaceConfigured ? { status: "loading", items: [] } : IDLE);
  const [guests, setGuests] = useState(IDLE);
  const [stays, setStays] = useState(IDLE);
  const [units, setUnits] = useState({});
  const [attempt, setAttempt] = useState({ properties: 0, guests: 0, stays: 0 });

  useEffect(() => {
    if (!isWorkspaceConfigured) return undefined;
    let cancelled = false;
    setProperties({ status: "loading", items: [] });
    koiApi
      .listProperties(KOI_WORKSPACE_ID, { limit: 100, sort: "name" })
      .then(({ items }) => !cancelled && setProperties({ status: "ready", items: items.map(mapPropertyFromApi).filter(Boolean) }))
      .catch(() => !cancelled && setProperties({ status: "error", items: [] }));
    return () => {
      cancelled = true;
    };
  }, [attempt.properties]);

  useEffect(() => {
    if (!isWorkspaceConfigured || !selection.propertyId) {
      setGuests(IDLE);
      return undefined;
    }
    let cancelled = false;
    setGuests({ status: "loading", items: [] });
    koiApi
      .listGuests(KOI_WORKSPACE_ID, { propertyId: selection.propertyId, limit: 100, sort: "lastName" })
      .then(({ items }) => !cancelled && setGuests({ status: "ready", items: items.map(mapGuestFromApi).filter(Boolean) }))
      .catch(() => !cancelled && setGuests({ status: "error", items: [] }));
    return () => {
      cancelled = true;
    };
  }, [selection.propertyId, attempt.guests]);

  useEffect(() => {
    if (!isWorkspaceConfigured || !selection.propertyId || !selection.guestId) {
      setStays(IDLE);
      return undefined;
    }
    let cancelled = false;
    setStays({ status: "loading", items: [] });
    koiApi
      .listStays(KOI_WORKSPACE_ID, { propertyId: selection.propertyId, guestId: selection.guestId, limit: 100, sort: "-checkIn" })
      .then(({ items }) => !cancelled && setStays({ status: "ready", items: items.map(mapStayFromApi).filter(Boolean) }))
      .catch(() => !cancelled && setStays({ status: "error", items: [] }));
    return () => {
      cancelled = true;
    };
  }, [selection.propertyId, selection.guestId, attempt.stays]);

  // Room numbers for the stay labels (a read-only lookup for presentation; a failure only means a label without its room).
  useEffect(() => {
    if (!isWorkspaceConfigured || !selection.propertyId) {
      setUnits({});
      return undefined;
    }
    let cancelled = false;
    koiApi
      .listUnits(KOI_WORKSPACE_ID, { propertyId: selection.propertyId, limit: 100, sort: "unitNumber" })
      .then(({ items }) => {
        if (cancelled) return;
        const byId = {};
        for (const unit of items.map(mapUnitFromApi).filter(Boolean)) byId[unit.id] = unit.unitNumber;
        setUnits(byId);
      })
      .catch(() => !cancelled && setUnits({}));
    return () => {
      cancelled = true;
    };
  }, [selection.propertyId]);

  const select = useCallback((field, value) => setSelection((current) => changeSelection(current, field, value)), []);
  const retry = useCallback((level) => setAttempt((current) => ({ ...current, [level]: current[level] + 1 })), []);
  const reset = useCallback(() => setSelection(EMPTY_SELECTION), []);

  const view = useMemo(() => describeSelectors({ properties, guests, stays, selection }), [properties, guests, stays, selection]);
  const context = useMemo(() => selectionToContext(selection), [selection]);

  return { selection, select, retry, reset, properties, guests, stays, units, view, context };
}
