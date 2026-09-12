/**
 * Translation between the KOI REST shapes and the frontend Property/Unit/
 * Guest/Stay/Signal shapes. Mirrors the boundary established for
 * conversations (`features/conversations/conversationMapping.js`) — no
 * component should touch `_id` or backend field names directly.
 *
 * The enum lists below mirror `backend/src/models/Property.js`,
 * `backend/src/models/Unit.js`, `backend/src/models/Stay.js`, and
 * `backend/src/models/Signal.js`. The API is the source of truth for
 * validation; these exist only so the UI can offer the right choices. If the
 * backend models change, update these to match.
 */
export const PROPERTY_STATUSES = ["active", "inactive", "archived"];
export const UNIT_TYPES = ["apartment", "studio", "suite", "room", "other"];
export const UNIT_STATUSES = ["available", "occupied", "maintenance", "out_of_service", "inactive"];
export const STAY_STATUSES = [
  "reserved",
  "confirmed",
  "checked_in",
  "checked_out",
  "cancelled",
  "no_show",
];
export const SIGNAL_TYPES = [
  "maintenance",
  "guest_request",
  "housekeeping",
  "complaint",
  "sentiment",
  "payment",
  "arrival",
  "departure",
  "system",
  "other",
];
export const SIGNAL_SOURCES = ["staff", "pms", "guest", "system", "integration", "ai", "other"];
export const SIGNAL_SEVERITIES = ["low", "medium", "high", "critical"];
export const SIGNAL_STATUSES = ["new", "acknowledged", "resolved", "dismissed"];

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

export function mapGuestFromApi(doc) {
  if (!doc) return null;
  return {
    id: doc._id,
    workspaceId: doc.workspaceId,
    externalId: doc.externalId ?? "",
    firstName: doc.firstName ?? "",
    lastName: doc.lastName ?? "",
    email: doc.email ?? "",
    phone: doc.phone ?? "",
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export function mapStayFromApi(doc) {
  if (!doc) return null;
  return {
    id: doc._id,
    workspaceId: doc.workspaceId,
    guestId: doc.guestId ?? null,
    propertyId: doc.propertyId ?? null,
    unitId: doc.unitId ?? null,
    reservationId: doc.reservationId ?? "",
    checkIn: doc.checkIn ?? null,
    checkOut: doc.checkOut ?? null,
    status: doc.status ?? "reserved",
    adults: doc.adults ?? 1,
    children: doc.children ?? 0,
    source: doc.source ?? "",
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export function mapSignalFromApi(doc) {
  if (!doc) return null;
  return {
    id: doc._id,
    workspaceId: doc.workspaceId,
    propertyId: doc.propertyId ?? null,
    unitId: doc.unitId ?? null,
    guestId: doc.guestId ?? null,
    stayId: doc.stayId ?? null,
    type: doc.type ?? "other",
    source: doc.source ?? "system",
    severity: doc.severity ?? "medium",
    status: doc.status ?? "new",
    title: doc.title ?? "",
    description: doc.description ?? "",
    occurredAt: doc.occurredAt ?? null,
    detectedAt: doc.detectedAt ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export function formatGuestName(guest) {
  if (!guest) return "";
  const name = [guest.firstName, guest.lastName].filter(Boolean).join(" ").trim();
  return name || "Unnamed guest";
}

/** ISO datetime → `YYYY-MM-DD` for an `<input type="date">`. */
export function toDateInputValue(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

export function formatUnitType(type) {
  if (!type) return "";
  return type.charAt(0).toUpperCase() + type.slice(1).replace(/_/g, " ");
}

export function formatStatusLabel(status) {
  if (!status) return "";
  return status.replace(/_/g, " ");
}

const HISTORY_MATCH_LABELS = {
  stay: "same stay",
  guest: "same guest",
  unit: "same unit",
  property: "same property",
};

/** Human-readable reason a historical signal was surfaced (relational, not AI). */
export function describeHistoryMatch(matchedBy) {
  if (!Array.isArray(matchedBy) || !matchedBy.length) return "";
  return matchedBy.map((key) => HISTORY_MATCH_LABELS[key] ?? key).join(", ");
}
