import { Guest } from "../models/Guest.js";
import { Property } from "../models/Property.js";
import { AppError } from "../utils/AppError.js";
import { parseObjectId, requireObjectId } from "../utils/objectId.js";
import { createGuest } from "./guestService.js";
import { findInWorkspaceOr404, pickDefined, requireFields } from "./queryHelpers.js";
import { assertStayPlacement, createStay } from "./stayService.js";

// The ONLY stay fields a caller may send with a guest. The workspace, the property and the guest of the stay are never read from `stay`: they are the guest's own, set here.
const STAY_FIELDS = ["unitId", "reservationId", "checkIn", "checkOut", "status", "adults", "children", "source", "metadata"];

/**
 * Creates a Guest AND its first Stay in one request (Workspace -> Property -> Guest -> Stay), reusing createGuest and createStay so every rule of the separate calls applies:
 *   - the property is loaded INSIDE the verified workspace (another tenant's property is the same 404 as a missing one) and becomes the guest's AND the stay's property;
 *   - the stay's unit must be a unit of that property (400 for another property's unit, 404 for another workspace's), its dates must be valid and the unit's calendar free (409);
 *   - all of that is checked BEFORE anything is written, so an invalid stay never leaves a guest behind.
 * Standalone MongoDB (the development setup) has no multi-document transaction, so the one failure that can only be seen on the stay's own write (a duplicate booking reference)
 * is compensated: the guest created a moment ago by THIS call (and nothing else) is removed again. Returns the guest with its stay under `stay`.
 */
export async function createGuestWithStay(body) {
  const { stay: stayInput, ...guestInput } = body;
  if (!stayInput || typeof stayInput !== "object" || Array.isArray(stayInput)) {
    throw new AppError("stay must be an object", 400, { code: "INVALID_FIELD", field: "stay" });
  }
  requireFields(guestInput, ["workspaceId", "propertyId"]);
  const workspaceId = requireObjectId(guestInput.workspaceId, "workspaceId");
  const propertyId = requireObjectId(guestInput.propertyId, "propertyId");
  const stayFields = pickDefined(stayInput, STAY_FIELDS);

  await findInWorkspaceOr404(Property, propertyId, workspaceId, "Property");
  await assertStayPlacement({
    workspaceId,
    propertyId,
    unitId: parseObjectId(stayFields.unitId, "unitId"),
    checkIn: stayFields.checkIn,
    checkOut: stayFields.checkOut,
    status: stayFields.status,
  });

  const guest = await createGuest(guestInput);
  try {
    const stay = await createStay({ ...stayFields, workspaceId, guestId: guest._id, propertyId });
    return { ...guest, stay };
  } catch (error) {
    await Guest.deleteOne({ _id: guest._id, workspaceId }).catch(() => {});
    throw error;
  }
}
