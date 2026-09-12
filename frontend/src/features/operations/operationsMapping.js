/**
 * Translation between the KOI REST shapes and the frontend Property/Unit
 * shapes. Mirrors the boundary established for conversations
 * (`features/conversations/conversationMapping.js`) — no component should
 * touch `_id` or backend field names directly.
 *
 * The enum lists below mirror `backend/src/models/Property.js` and
 * `backend/src/models/Unit.js`. The API is the source of truth for validation;
 * these exist only so the UI can offer the right choices. If the backend
 * models change, update these to match.
 */
export const PROPERTY_STATUSES = ["active", "inactive", "archived"];
export const UNIT_TYPES = ["apartment", "studio", "suite", "room", "other"];
export const UNIT_STATUSES = ["available", "occupied", "maintenance", "out_of_service", "inactive"];

export function mapPropertyFromApi(doc) {
  if (!doc) return null;
  return {
    id: doc._id,
    workspaceId: doc.workspaceId,
    name: doc.name ?? "",
    code: doc.code ?? "",
    address: doc.address ?? "",
    timezone: doc.timezone ?? "UTC",
    status: doc.status ?? "active",
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export function mapUnitFromApi(doc) {
  if (!doc) return null;
  return {
    id: doc._id,
    propertyId: doc.propertyId,
    unitNumber: doc.unitNumber ?? "",
    type: doc.type ?? "apartment",
    status: doc.status ?? "available",
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export function formatUnitType(type) {
  if (!type) return "";
  return type.charAt(0).toUpperCase() + type.slice(1).replace(/_/g, " ");
}

export function formatStatusLabel(status) {
  if (!status) return "";
  return status.replace(/_/g, " ");
}
