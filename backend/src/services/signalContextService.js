import { Guest } from "../models/Guest.js";
import { Property } from "../models/Property.js";
import { Signal } from "../models/Signal.js";
import { Stay } from "../models/Stay.js";
import { Unit } from "../models/Unit.js";
import { requireObjectId } from "../utils/objectId.js";
import { findInWorkspaceOr404 } from "./queryHelpers.js";

/**
 * Deterministic Operational Context Assembly (Phase 3D).
 *
 * Signal → Context Assembly → Structured Context → (future) Phase 4 Intelligence
 *
 * This module does exactly one thing: given a Signal, retrieve and combine the
 * MongoDB facts already related to it (Property, Unit, Guest, Stay, and
 * relevant historical Signals) into one stable, read-only response shape.
 *
 * It performs NO interpretation. Every field here is either copied verbatim
 * from a stored document or is a plain structural marker (e.g. `available`,
 * `matchedBy`) describing *how* the data was assembled — never a conclusion
 * about what it means. That reasoning is explicitly deferred to a future
 * phase (see CLAUDE.md's AI/RAG boundary).
 *
 * Context is never persisted: it is recomputed from the current documents on
 * every request, so it can never drift from the source-of-truth collections
 * (Workspace/Property/Unit/Guest/Stay/Signal) the way a stored snapshot could.
 */

const HISTORY_CATEGORY_LIMIT = 20;
const HISTORY_TOTAL_LIMIT = 20;
const GUEST_STAY_HISTORY_LIMIT = 5;

/** A referenced record that could not be resolved (deleted, or never existed). */
function unavailable(id) {
  return { id: id ? String(id) : null, available: false };
}

function mapPropertyFact(doc) {
  return {
    id: String(doc._id),
    available: true,
    name: doc.name,
    code: doc.code,
    address: doc.address,
    timezone: doc.timezone,
    status: doc.status,
  };
}

function mapUnitFact(doc) {
  return {
    id: String(doc._id),
    available: true,
    unitNumber: doc.unitNumber,
    type: doc.type,
    status: doc.status,
    propertyId: String(doc.propertyId),
  };
}

function mapStayFact(doc) {
  return {
    id: String(doc._id),
    available: true,
    guestId: doc.guestId ? String(doc.guestId) : null,
    propertyId: doc.propertyId ? String(doc.propertyId) : null,
    unitId: doc.unitId ? String(doc.unitId) : null,
    reservationId: doc.reservationId ?? null,
    checkIn: doc.checkIn ?? null,
    checkOut: doc.checkOut ?? null,
    status: doc.status,
    adults: doc.adults,
    children: doc.children,
    source: doc.source ?? "",
  };
}

function mapSignalFact(doc) {
  return {
    id: String(doc._id),
    type: doc.type,
    source: doc.source,
    severity: doc.severity,
    status: doc.status,
    title: doc.title,
    description: doc.description,
    occurredAt: doc.occurredAt,
    detectedAt: doc.detectedAt,
    propertyId: doc.propertyId ? String(doc.propertyId) : null,
    unitId: doc.unitId ? String(doc.unitId) : null,
    guestId: doc.guestId ? String(doc.guestId) : null,
    stayId: doc.stayId ? String(doc.stayId) : null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function mapHistorySignal(doc, matchedBy) {
  return {
    id: String(doc._id),
    type: doc.type,
    severity: doc.severity,
    status: doc.status,
    title: doc.title,
    occurredAt: doc.occurredAt,
    matchedBy,
  };
}

/** Property, workspace-scoped directly (Property already carries workspaceId). */
async function resolveProperty(propertyId, workspaceId) {
  if (!propertyId) return null;
  const doc = await Property.findOne({ _id: propertyId, workspaceId });
  return doc ? mapPropertyFact(doc) : unavailable(propertyId);
}

/**
 * Unit has no workspaceId — its tenancy is resolved the same way the rest of
 * KOI resolves it: Unit → Property → Workspace. A Unit whose Property is gone
 * or belongs to another workspace is treated as unavailable, not fabricated.
 */
async function resolveUnit(unitId, workspaceId) {
  if (!unitId) return null;
  const unitDoc = await Unit.findById(unitId);
  if (!unitDoc) return unavailable(unitId);
  const property = await Property.findOne({ _id: unitDoc.propertyId, workspaceId });
  if (!property) return unavailable(unitId);
  return mapUnitFact(unitDoc);
}

/** A guest's short, most-recent stay history — a handful of stays, not a full ledger. */
async function fetchGuestRecentStays(guestId, workspaceId) {
  const stays = await Stay.find({ workspaceId, guestId })
    .sort({ checkIn: -1 })
    .limit(GUEST_STAY_HISTORY_LIMIT);
  return stays.map(mapStayFact);
}

async function resolveGuest(guestId, workspaceId) {
  if (!guestId) return null;
  const [doc, recentStays] = await Promise.all([
    Guest.findOne({ _id: guestId, workspaceId }),
    fetchGuestRecentStays(guestId, workspaceId),
  ]);
  if (!doc) return { ...unavailable(guestId), recentStays };
  return {
    id: String(doc._id),
    available: true,
    firstName: doc.firstName,
    lastName: doc.lastName,
    email: doc.email,
    phone: doc.phone,
    recentStays,
  };
}

async function resolveStay(stayId, workspaceId) {
  if (!stayId) return null;
  const doc = await Stay.findOne({ _id: stayId, workspaceId });
  return doc ? mapStayFact(doc) : unavailable(stayId);
}

/**
 * Relevant historical Signals — deterministic relational relevance, not
 * semantic search. Four categories are consulted in priority order (same
 * Stay > same Guest > same Unit > same Property): each is queried only if
 * the overall result hasn't already reached HISTORY_TOTAL_LIMIT, and only
 * contributes enough of its own (occurredAt-descending, workspace-scoped,
 * current-Signal-excluded) matches to fill the remaining capacity — so when
 * candidates outnumber the cap, higher-priority relationships win the slots
 * rather than whichever happens to be most recent. A Signal matching more
 * than one category (e.g. same Stay AND same Guest) still occupies exactly
 * one slot and is tagged with every category it matched (`matchedBy`). Once
 * selected, the final set is ordered by occurredAt (most recent first) for
 * display.
 */
async function assembleHistory(signal, workspaceId) {
  const categories = [
    { key: "stay", field: "stayId", value: signal.stayId },
    { key: "guest", field: "guestId", value: signal.guestId },
    { key: "unit", field: "unitId", value: signal.unitId },
    { key: "property", field: "propertyId", value: signal.propertyId },
  ];

  const merged = new Map();

  for (const category of categories) {
    if (!category.value || merged.size >= HISTORY_TOTAL_LIMIT) continue;

    const docs = await Signal.find({
      workspaceId,
      [category.field]: category.value,
      _id: { $ne: signal._id },
    })
      .sort({ occurredAt: -1 })
      .limit(HISTORY_CATEGORY_LIMIT);

    for (const doc of docs) {
      const id = String(doc._id);
      const existing = merged.get(id);
      if (existing) {
        existing.matchedBy.push(category.key);
      } else if (merged.size < HISTORY_TOTAL_LIMIT) {
        merged.set(id, { doc, matchedBy: [category.key] });
      }
    }
  }

  return [...merged.values()]
    .sort((a, b) => new Date(b.doc.occurredAt) - new Date(a.doc.occurredAt))
    .map(({ doc, matchedBy }) => mapHistorySignal(doc, matchedBy));
}

/**
 * Assemble the full, read-only Context for one Signal. Never mutates any
 * document; never persists the result.
 */
export async function assembleSignalContext(signalId, workspaceId) {
  const scope = requireObjectId(workspaceId, "workspaceId");
  const signal = await findInWorkspaceOr404(Signal, requireObjectId(signalId), scope, "Signal");

  const [property, unit, guest, stay, history] = await Promise.all([
    resolveProperty(signal.propertyId, scope),
    resolveUnit(signal.unitId, scope),
    resolveGuest(signal.guestId, scope),
    resolveStay(signal.stayId, scope),
    assembleHistory(signal, scope),
  ]);

  return {
    signal: mapSignalFact(signal),
    guest,
    stay,
    property,
    unit,
    history: { signals: history },
  };
}
