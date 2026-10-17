import { Guest } from "../models/Guest.js";
import { Property } from "../models/Property.js";
import { Stay } from "../models/Stay.js";
import { Unit } from "../models/Unit.js";
import { AppError } from "../utils/AppError.js";
import { parseObjectId, requireObjectId } from "../utils/objectId.js";
import { createGuest } from "./guestService.js";
import { findInWorkspaceOr404, pickDefined, requireFields } from "./queryHelpers.js";
import { assertStayPlacement, createStay } from "./stayService.js";
import { cleanUnitNumber, createUnit, findUnitByNumberInProperty } from "./unitService.js";

// The ONLY stay fields a caller may send with a guest. The workspace, the property and the guest of the stay are never read from `stay`: they are the guest's own, set here.
// The room is named either by `unitNumber` (the human-facing identifier a person types: 101, B1, A-12, 12A, "Villa 3") or, for API callers, by an existing `unitId`.
const STAY_FIELDS = ["unitId", "unitNumber", "reservationId", "checkIn", "checkOut", "status", "adults", "children", "source", "metadata"];

const isBlank = (value) => value === undefined || value === null || (typeof value === "string" && value.trim() === "");

/**
 * Creates a Guest AND its first Stay in one request (Workspace -> Property -> Guest -> Stay), reusing createGuest and createStay so every rule of the separate calls applies:
 *   - the property is loaded INSIDE the verified workspace (another tenant's property is the same 404 as a missing one) and becomes the guest's AND the stay's property;
 *   - the room is a unit of THAT property. A typed `unitNumber` is looked up among that property's units only (case and spaces do not make a different room); an existing unit
 *     is assigned by its internal id. A room the property does not have yet is created under that property - the same write the Units API makes, so only a caller who holds
 *     the permission for it (`canCreateUnit`, the workspace:admin that POST /units needs) may add one; anyone else is refused and nothing is written;
 *   - the dates and the unit's calendar are checked BEFORE anything is written, so an invalid stay never leaves a guest or a room behind.
 * Standalone MongoDB (the development setup) has no multi-document transaction, so what can only be seen on the stay's own write (a duplicate booking reference) is
 * compensated: the guest, and the room, that THIS call created (and nothing else) are removed again. Returns the guest with its stay under `stay` and the room under `unit`.
 */
export async function createGuestWithStay(body, { canCreateUnit = false } = {}) {
  const { stay: stayInput, ...guestInput } = body;
  if (!stayInput || typeof stayInput !== "object" || Array.isArray(stayInput)) {
    throw new AppError("stay must be an object", 400, { code: "INVALID_FIELD", field: "stay" });
  }
  requireFields(guestInput, ["workspaceId", "propertyId"]);
  const workspaceId = requireObjectId(guestInput.workspaceId, "workspaceId");
  const propertyId = requireObjectId(guestInput.propertyId, "propertyId");
  const { unitNumber: typedNumber, ...stayFields } = pickDefined(stayInput, STAY_FIELDS);

  const wantsNumber = !isBlank(typedNumber);
  if (wantsNumber && !isBlank(stayFields.unitId)) {
    throw new AppError("Send the room as unitNumber or as unitId, not both", 400, { code: "INVALID_FIELD", field: "unitNumber" });
  }
  const unitNumber = wantsNumber ? cleanUnitNumber(typedNumber) : null;

  await findInWorkspaceOr404(Property, propertyId, workspaceId, "Property");

  // The property is the authority for its rooms: resolve the typed identifier among ITS units only.
  let unit = unitNumber ? await findUnitByNumberInProperty(propertyId, unitNumber) : null;
  if (unitNumber && !unit && !canCreateUnit) {
    throw new AppError(`Room ${unitNumber} is not set up at this property, and your role cannot add rooms. Ask an administrator to add it.`, 403, { code: "UNIT_NOT_FOUND", field: "unitNumber" });
  }
  const unitId = unit ? String(unit._id) : parseObjectId(stayFields.unitId, "unitId");

  await assertStayPlacement({ workspaceId, propertyId, unitId, checkIn: stayFields.checkIn, checkOut: stayFields.checkOut, status: stayFields.status });

  let unitCreated = false;
  const guest = await createGuest(guestInput);
  try {
    if (unitNumber && !unit) {
      try {
        unit = await createUnit({ workspaceId, propertyId, unitNumber });
        unitCreated = true;
      } catch (error) {
        // Someone added the same room a moment ago: use theirs (the unique index forbids a second one).
        if (error?.code !== 11000) throw error;
        unit = await findUnitByNumberInProperty(propertyId, unitNumber);
        if (!unit) throw error;
      }
    }
    const stay = await createStay({ ...stayFields, unitId: unit ? String(unit._id) : unitId, workspaceId, guestId: guest._id, propertyId });
    return { ...guest, stay, ...(unit ? { unit: { _id: String(unit._id), unitNumber: unit.unitNumber, created: unitCreated } } : {}) };
  } catch (error) {
    if (unitCreated && unit) {
      const inUse = await Stay.exists({ unitId: unit._id });
      if (!inUse) await Unit.deleteOne({ _id: unit._id, propertyId }).catch(() => {});
    }
    await Guest.deleteOne({ _id: guest._id, workspaceId }).catch(() => {});
    throw error;
  }
}
