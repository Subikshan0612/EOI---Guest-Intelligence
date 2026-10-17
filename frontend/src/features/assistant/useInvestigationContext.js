import { useEffect, useState } from "react";
import { KOI_WORKSPACE_ID, isWorkspaceConfigured } from "../../config/workspace";
import * as koiApi from "../../services/api";
import { formatGuestName, mapGuestFromApi, mapPropertyFromApi, mapStayFromApi, mapUnitFromApi } from "../operations/operationsMapping";
import { stayLabel } from "./contextSelection";

/**
 * The operational context an investigation was started with, as words: its property, guest and stay (and the stay's room), read from the records the conversation
 * REFERENCES (GET only). The conversation stores stable ids, never names; a record that cannot be read (deleted, or above this role) is reported as unavailable rather
 * than guessed. Returns null while there is nothing to show (a conversation that was started without a selected context).
 */
export function useInvestigationContext(conversation) {
  const propertyId = conversation?.propertyId ?? null;
  const guestId = conversation?.guestId ?? null;
  const stayId = conversation?.stayId ?? null;
  const [state, setState] = useState(null);

  useEffect(() => {
    if (!isWorkspaceConfigured || !propertyId) {
      setState(null);
      return undefined;
    }
    let cancelled = false;
    const read = async (fetcher) => {
      try {
        return { ok: true, value: await fetcher() };
      } catch {
        return { ok: false, value: null };
      }
    };
    (async () => {
      const [property, guest, stay] = await Promise.all([
        read(() => koiApi.getProperty(propertyId, KOI_WORKSPACE_ID)),
        guestId ? read(() => koiApi.getGuest(guestId, KOI_WORKSPACE_ID)) : null,
        stayId ? read(() => koiApi.getStay(stayId, KOI_WORKSPACE_ID)) : null,
      ]);
      const stayRecord = stay?.ok ? mapStayFromApi(stay.value) : null;
      const unit = stayRecord?.unitId ? await read(() => koiApi.getUnit(stayRecord.unitId, KOI_WORKSPACE_ID)) : null;
      if (cancelled) return;
      const unavailable = "Unavailable";
      setState({
        property: property.ok ? mapPropertyFromApi(property.value)?.name || unavailable : unavailable,
        guest: guestId ? (guest.ok ? formatGuestName(mapGuestFromApi(guest.value)) : unavailable) : null,
        stay: stayId ? (stayRecord ? stayLabel(stayRecord, unit?.ok ? mapUnitFromApi(unit.value)?.unitNumber : null) : unavailable) : null,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [propertyId, guestId, stayId]);

  return state;
}
