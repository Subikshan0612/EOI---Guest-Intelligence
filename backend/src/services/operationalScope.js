import { Guest } from "../models/Guest.js";
import { Property } from "../models/Property.js";
import { Stay } from "../models/Stay.js";
import { Unit } from "../models/Unit.js";
import { AppError } from "../utils/AppError.js";
import { parseObjectId } from "../utils/objectId.js";
import { findInWorkspaceOr404 } from "./queryHelpers.js";

/**
 * The operational hierarchy, enforced in ONE place:
 *
 *   Workspace -> Property -> Guest -> Stay (-> Unit)
 *
 * A Guest belongs to ONE Property (`Guest.propertyId`); a Stay belongs to a Property AND a Guest of that same Property; an investigation (Signal / Conversation) keeps the
 * Property, Guest and Stay it was started with. An id sent by a browser is only a SELECTION: nothing here trusts it. Every record is loaded INSIDE the verified workspace (an
 * id of another workspace is the same 404 as a missing one), and then the relationships between the records are checked against the stored records themselves:
 *
 *   guest.propertyId === propertyId            else 400 GUEST_PROPERTY_MISMATCH   (or GUEST_PROPERTY_UNASSIGNED for a guest created before guests had a property)
 *   stay.propertyId  === propertyId            else 400 STAY_PROPERTY_MISMATCH
 *   stay.guestId     === guestId               else 400 STAY_GUEST_MISMATCH
 *   unit.propertyId  === propertyId            else 400 UNIT_PROPERTY_MISMATCH
 */
export const SCOPE_CODES = Object.freeze({
  PROPERTY_REQUIRED: "PROPERTY_REQUIRED",
  GUEST_PROPERTY_MISMATCH: "GUEST_PROPERTY_MISMATCH",
  GUEST_PROPERTY_UNASSIGNED: "GUEST_PROPERTY_UNASSIGNED",
  STAY_PROPERTY_MISMATCH: "STAY_PROPERTY_MISMATCH",
  STAY_GUEST_MISMATCH: "STAY_GUEST_MISMATCH",
  UNIT_PROPERTY_MISMATCH: "UNIT_PROPERTY_MISMATCH",
});

const same = (a, b) => String(a) === String(b);

/** The guest belongs to `propertyId`. `allowUnassigned` tolerates a guest from before guests had a property (read-time compatibility); a DIFFERENT property is never tolerated. */
export function assertGuestInProperty(guest, propertyId, { allowUnassigned = false } = {}) {
  if (!guest.propertyId) {
    if (allowUnassigned) return;
    throw new AppError("Guest has not been assigned to a property yet", 400, { code: SCOPE_CODES.GUEST_PROPERTY_UNASSIGNED, field: "guestId" });
  }
  if (!same(guest.propertyId, propertyId)) {
    throw new AppError("Guest does not belong to the given property", 400, { code: SCOPE_CODES.GUEST_PROPERTY_MISMATCH, field: "guestId" });
  }
}

/** The stay belongs to `propertyId` and (when given) to `guestId`. */
export function assertStayInPropertyAndGuest(stay, propertyId, guestId) {
  if (propertyId && !same(stay.propertyId, propertyId)) {
    throw new AppError("Stay does not belong to the given property", 400, { code: SCOPE_CODES.STAY_PROPERTY_MISMATCH, field: "stayId" });
  }
  if (guestId && !same(stay.guestId, guestId)) {
    throw new AppError("Stay does not belong to the given guest", 400, { code: SCOPE_CODES.STAY_GUEST_MISMATCH, field: "stayId" });
  }
}

/**
 * Resolves and verifies an explicit operational selection for ONE workspace. Property is required; Guest and Stay are optional, and a Stay alone names its Guest (the Stay's
 * own guest is then verified like a selected one).
 *
 * @returns {Promise<{ property: object, guest: object|null, stay: object|null, unit: object|null }>} the verified records (never the raw ids that were sent)
 */
export async function resolveOperationalScope(workspaceId, { propertyId, guestId, stayId } = {}) {
  const propertyRef = parseObjectId(propertyId, "propertyId");
  if (!propertyRef) throw new AppError("A property must be selected", 400, { code: SCOPE_CODES.PROPERTY_REQUIRED, field: "propertyId" });
  const property = await findInWorkspaceOr404(Property, propertyRef, workspaceId, "Property");

  const stayRef = parseObjectId(stayId, "stayId");
  let guestRef = parseObjectId(guestId, "guestId");

  let stay = null;
  if (stayRef) {
    stay = await findInWorkspaceOr404(Stay, stayRef, workspaceId, "Stay");
    assertStayInPropertyAndGuest(stay, property._id, guestRef);
    guestRef ??= stay.guestId;
  }

  let guest = null;
  if (guestRef) {
    guest = await findInWorkspaceOr404(Guest, guestRef, workspaceId, "Guest");
    assertGuestInProperty(guest, property._id);
  }

  let unit = null;
  if (stay?.unitId) {
    // A Unit has no workspaceId of its own: its tenancy is its Property's, and this property was just loaded inside the workspace.
    unit = await Unit.findById(stay.unitId);
    if (unit && !same(unit.propertyId, property._id)) {
      throw new AppError("The stay's unit does not belong to the given property", 400, { code: SCOPE_CODES.UNIT_PROPERTY_MISMATCH, field: "stayId" });
    }
  }

  return { property, guest, stay, unit };
}
