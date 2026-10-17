import { formatStayDate } from "../../utils/formatDate";
import { formatStatusLabel } from "../operations/operationsMapping";

/**
 * The operational context an investigation starts with: Property -> Guest -> Stay. PURE (no React, no network) so the dependent-selection rules can be tested directly.
 *
 *   Property controls the Guests that may be offered; Guest controls the Stays that may be offered. Changing a level clears everything below it, so the page can never hold a
 *   guest that does not belong to the selected property or a stay that does not belong to the selected guest. This is a convenience for the person: the SERVER re-verifies
 *   every relationship (guest -> property, stay -> property and guest) and never believes these ids by themselves.
 */
export const EMPTY_SELECTION = Object.freeze({ propertyId: "", guestId: "", stayId: "" });

const LEVELS = ["propertyId", "guestId", "stayId"];

/** The selection after `field` was set to `value`: every level BELOW it is cleared. */
export function changeSelection(selection, field, value) {
  const index = LEVELS.indexOf(field);
  if (index < 0) return selection;
  const next = { ...selection, [field]: typeof value === "string" ? value : "" };
  for (const lower of LEVELS.slice(index + 1)) next[lower] = "";
  return next;
}

/**
 * What is sent with the first message. A guest investigation needs ALL THREE of property, guest and stay; until they are chosen this is `null` and the page cannot start
 * one. (The server still accepts a property-only context and verifies every relationship; this is the front-end rule for the Assistant.)
 */
export function selectionToContext(selection) {
  if (!selection?.propertyId || !selection?.guestId || !selection?.stayId) return null;
  return { propertyId: selection.propertyId, guestId: selection.guestId, stayId: selection.stayId };
}

/** What is still missing before an investigation can start, in plain words ("" when nothing is). */
export function missingContextHint(selection) {
  if (!selection?.propertyId) return "Select a property, a guest and a stay to start.";
  if (!selection.guestId) return "Select a guest to continue.";
  if (!selection.stayId) return "Select a stay to continue.";
  return "";
}

export const MESSAGES = Object.freeze({
  selectPropertyFirst: "Select a property first.",
  noProperties: "No properties yet. Add a property first.",
  noGuests: "No guests have been added to this property yet.",
  noStays: "No stays found for this guest.",
  loadError: "Couldn't load this list. Try again.",
});

/** A stay's option label: its booking reference (or "Stay"), the room and the dates - nothing the person cannot read. */
export function stayLabel(stay, unitNumber) {
  const reference = stay?.reservationId ? `#${stay.reservationId}` : "Stay";
  const dates = [stay?.checkIn ? formatStayDate(stay.checkIn) : null, stay?.checkOut ? formatStayDate(stay.checkOut) : null].filter(Boolean).join(" – ");
  return [reference, unitNumber ? `Unit ${unitNumber}` : null, dates || null, stay?.status ? formatStatusLabel(stay.status) : null].filter(Boolean).join(" · ");
}

/**
 * How each of the three selectors presents itself: disabled or not, its placeholder, and the one-line note under it. Loading, empty and error states are explicit; a selector is
 * never enabled while the level above it is empty.
 *
 * @param {{ properties: {status: string, items: any[]}, guests: {status: string, items: any[]}, stays: {status: string, items: any[]}, selection: {propertyId: string, guestId: string} }} state  status: idle | loading | ready | error
 */
export function describeSelectors({ properties, guests, stays, selection }) {
  const property =
    properties.status === "loading"
      ? { disabled: true, placeholder: "Loading properties…", note: "" }
      : properties.status === "error"
        ? { disabled: true, placeholder: "Properties couldn't be loaded", note: MESSAGES.loadError }
        : properties.items.length === 0
          ? { disabled: true, placeholder: "No properties yet", note: MESSAGES.noProperties }
          : { disabled: false, placeholder: "Select a property", note: "" };

  let guest;
  if (!selection.propertyId) guest = { disabled: true, placeholder: MESSAGES.selectPropertyFirst, note: MESSAGES.selectPropertyFirst };
  else if (guests.status === "loading") guest = { disabled: true, placeholder: "Loading guests…", note: "" };
  else if (guests.status === "error") guest = { disabled: true, placeholder: "Guests couldn't be loaded", note: MESSAGES.loadError };
  else if (guests.items.length === 0) guest = { disabled: true, placeholder: "No guests for this property", note: MESSAGES.noGuests };
  else guest = { disabled: false, placeholder: "Select a guest", note: "" };

  let stay;
  if (!selection.propertyId) stay = { disabled: true, placeholder: MESSAGES.selectPropertyFirst, note: "" };
  else if (!selection.guestId) stay = { disabled: true, placeholder: "Select a guest first", note: "" };
  else if (stays.status === "loading") stay = { disabled: true, placeholder: "Loading stays…", note: "" };
  else if (stays.status === "error") stay = { disabled: true, placeholder: "Stays couldn't be loaded", note: MESSAGES.loadError };
  else if (stays.items.length === 0) stay = { disabled: true, placeholder: "No stays for this guest", note: MESSAGES.noStays };
  else stay = { disabled: false, placeholder: "Select a stay", note: "" };

  return { property, guest, stay };
}
