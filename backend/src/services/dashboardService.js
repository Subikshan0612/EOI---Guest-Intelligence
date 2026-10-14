import mongoose from "mongoose";
import { Guest } from "../models/Guest.js";
import { ANALYSIS_VERSION, Intelligence } from "../models/Intelligence.js";
import { Property } from "../models/Property.js";
import { Signal, SIGNAL_SEVERITIES, SIGNAL_STATUSES, SIGNAL_TYPES } from "../models/Signal.js";
import { Stay } from "../models/Stay.js";
import { Unit } from "../models/Unit.js";
import { AppError } from "../utils/AppError.js";
import { parseObjectId, requireObjectId } from "../utils/objectId.js";
import { buildPagination, parsePagination } from "../utils/pagination.js";
import { allowedVisibilities, canAccess, isValidVisibility, normalizeCallerLevel, visibilityRank } from "./knowledge/visibility.js";
import { findInWorkspaceOr404 } from "./queryHelpers.js";
import { toSafetyView } from "./intelligenceService.js";

/**
 * Dashboard V1 - a READ MODEL over existing domain data. It composes what the
 * existing services already decide; it adds no authorization rules of its own:
 *
 *   - tenancy: every query is scoped by `workspaceId` exactly like the rest of
 *     the API (requireObjectId / findInWorkspaceOr404, the same 404 for a
 *     missing and a cross-workspace Signal);
 *   - visibility: the caller's level comes from the trusted server-side
 *     resolver (middleware/knowledgeAccess.js) and is applied with the shared
 *     helpers in knowledge/visibility.js (allowedVisibilities / canAccess),
 *     the same rule Intelligence reads use - a record above the caller's level
 *     behaves as if it did not exist;
 *   - Intelligence V1 only: identified by `analysisVersion`; legacy records are
 *     never returned and never merged.
 *
 * It only reads stored data. It never generates Intelligence, never calls the
 * AI service, and never writes: there is no create/update/delete anywhere in
 * this module. Its responses are built from explicit whitelists, so nothing is
 * exposed by accident: no guest name or contact details, no reservation id, no
 * LLM provider/model, no prompt, no knowledge-document or chunk text.
 */

/** Operator-facing severity order - NOT alphabetical. */
export const SEVERITY_RANK = Object.freeze({ critical: 0, high: 1, medium: 2, low: 3 });

export function severityRank(severity) {
  return Object.prototype.hasOwnProperty.call(SEVERITY_RANK, severity) ? SEVERITY_RANK[severity] : Number.MAX_SAFE_INTEGER;
}

/** True only when the Signal's own metadata says so - never inferred from its text. */
export function isSyntheticSignal(signal) {
  const metadata = signal?.metadata;
  const value = metadata instanceof Map ? metadata.get("synthetic") : metadata?.synthetic;
  return value === true || value === "true";
}

/**
 * Validates and normalizes the dashboard's filters. Only filters that map
 * directly onto existing Signal fields (plus `hasIntelligence`) are accepted;
 * an unsupported value is a 400, not a silently empty result.
 */
export function parseDashboardFilters(query = {}) {
  const filters = {};

  const propertyId = parseObjectId(query.propertyId, "propertyId");
  if (propertyId) filters.propertyId = propertyId;

  for (const [field, allowed] of [["status", SIGNAL_STATUSES], ["severity", SIGNAL_SEVERITIES], ["type", SIGNAL_TYPES]]) {
    const value = query[field];
    if (!value) continue;
    if (!allowed.includes(value)) throw new AppError(`Invalid ${field}`, 400);
    filters[field] = value;
  }

  if (query.hasIntelligence !== undefined) {
    if (query.hasIntelligence !== "true" && query.hasIntelligence !== "false") {
      throw new AppError("hasIntelligence must be true or false", 400);
    }
    filters.hasIntelligence = query.hasIntelligence === "true";
  }

  return filters;
}

/**
 * From the stored records for one Signal, the V1 analysis this caller may see:
 * only records marked as V1, with a valid analysis level the caller's level may
 * access (and, as a second check, knowledge the caller may access). When
 * several qualify, the most informative wins: the highest level, then the
 * newest, then the larger id - deterministic. Anything else is `null`: a
 * hidden record is indistinguishable from a missing one.
 */
export function pickVisibleAnalysis(records, callerLevel) {
  const level = normalizeCallerLevel(callerLevel);
  const visible = (records || []).filter(
    (record) =>
      record &&
      record.analysisVersion === ANALYSIS_VERSION &&
      isValidVisibility(record.analysisLevel) &&
      canAccess(level, record.analysisLevel) &&
      (!record.knowledgeVisibility || canAccess(level, record.knowledgeVisibility)),
  );

  visible.sort(
    (a, b) =>
      visibilityRank(b.analysisLevel) - visibilityRank(a.analysisLevel) ||
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() ||
      (String(b._id) < String(a._id) ? -1 : String(b._id) > String(a._id) ? 1 : 0),
  );

  return visible[0] ?? null;
}

// --------------------------------------------------------------------------
// Whitelisted serializers - the ONLY place response shapes are defined.
// --------------------------------------------------------------------------

const iso = (value) => (value ? new Date(value).toISOString() : null);

export function toSignalFacts(signal) {
  return {
    id: String(signal._id),
    title: signal.title,
    type: signal.type,
    severity: signal.severity,
    status: signal.status,
    source: signal.source,
    occurredAt: iso(signal.occurredAt),
    description: signal.description ?? "",
    synthetic: isSyntheticSignal(signal),
  };
}

export function toObservedProperty(property) {
  return property ? { id: String(property._id), code: property.code, name: property.name } : null;
}

export function toObservedUnit(unit) {
  return unit ? { id: String(unit._id), unitNumber: unit.unitNumber } : null;
}

/** Recorded status and dates only - stored UTC instants as ISO strings, no reservation id, no guest. */
export function toObservedStay(stay) {
  return stay ? { status: stay.status, checkIn: iso(stay.checkIn), checkOut: iso(stay.checkOut) } : null;
}

export function toIntelligenceSummary(record) {
  if (!record) return null;
  return {
    id: String(record._id),
    confidence: record.analysis?.confidence,
    createdAt: iso(record.createdAt),
    evidenceCount: record.analysis?.evidence?.length ?? 0,
    citedSections: (record.knowledgeProvenance || []).map((item) => item.section),
  };
}

export function toIntelligenceDetail(record) {
  if (!record) return null;
  return {
    id: String(record._id),
    analysisVersion: record.analysisVersion,
    situation: record.analysis?.situation,
    evidence: [...(record.analysis?.evidence || [])],
    impact: record.analysis?.impact,
    recommendation: record.analysis?.recommendation,
    confidence: record.analysis?.confidence,
    safety: toSafetyView(record.safety),
    createdAt: iso(record.createdAt),
    knowledgeProvenance: (record.knowledgeProvenance || []).map((item) => ({
      chunkId: item.chunkId,
      section: item.section,
      sectionPath: [...(item.sectionPath || [])],
      visibility: item.visibility,
      retrievalScore: item.retrievalScore,
    })),
  };
}

// --------------------------------------------------------------------------
// Queries
// --------------------------------------------------------------------------

const oid = (value) => new mongoose.Types.ObjectId(String(value));
const unique = (values) => [...new Set(values.filter(Boolean).map(String))];

/** Intelligence records the caller's level may see for the given Signals. */
function visibleIntelligenceFilter(workspaceId, callerLevel) {
  const allowed = allowedVisibilities(callerLevel);
  return { workspaceId, analysisVersion: ANALYSIS_VERSION, analysisLevel: { $in: allowed } };
}

/**
 * GET /api/dashboard/signals
 *
 * Batched: a fixed, small number of database operations serves any page -
 * one count, one aggregate for the page, then ONE query each for Intelligence,
 * Stays, Guests and Units, and one for Properties - regardless of how many
 * Signals the page holds. There is no per-Signal query.
 */
export async function listDashboardSignals(query = {}, authorizedLevel) {
  const workspaceId = oid(requireObjectId(query.workspaceId, "workspaceId"));
  const level = normalizeCallerLevel(authorizedLevel);
  const { page, limit, skip } = parsePagination(query);
  const filters = parseDashboardFilters(query);

  const match = { workspaceId };
  if (filters.propertyId) match.propertyId = oid(filters.propertyId);
  for (const field of ["status", "severity", "type"]) if (filters[field]) match[field] = filters[field];

  if (filters.hasIntelligence !== undefined) {
    // Which Signals have a stored V1 analysis THIS caller may see - one query.
    const allowed = allowedVisibilities(level);
    const withAnalysis = await Intelligence.distinct("signalIds", {
      ...visibleIntelligenceFilter(workspaceId, level),
      knowledgeVisibility: { $in: [...allowed, null] },
    });
    match._id = filters.hasIntelligence ? { $in: withAnalysis } : { $nin: withAnalysis };
  }

  const [total, rows] = await Promise.all([
    Signal.countDocuments(match),
    Signal.aggregate([
      { $match: match },
      {
        $addFields: {
          _severityRank: {
            $switch: {
              branches: Object.entries(SEVERITY_RANK).map(([severity, rank]) => ({ case: { $eq: ["$severity", severity] }, then: rank })),
              default: 99,
            },
          },
        },
      },
      // Rank first (NOT alphabetical), then most recent, then a stable tie-break.
      { $sort: { _severityRank: 1, occurredAt: -1, _id: -1 } },
      { $skip: skip },
      { $limit: limit },
      { $project: { _severityRank: 0 } },
    ]),
  ]);

  if (rows.length === 0) return { items: [], pagination: buildPagination({ page, limit, total }) };

  const signalIds = rows.map((row) => row._id);
  const unitIds = unique(rows.map((row) => row.unitId));
  const stayIds = unique(rows.map((row) => row.stayId));
  const guestIds = unique(rows.map((row) => row.guestId));

  const [records, stays, guests, units] = await Promise.all([
    Intelligence.find({ ...visibleIntelligenceFilter(workspaceId, level), signalIds: { $in: signalIds } }, {
      signalIds: 1, analysisVersion: 1, analysisLevel: 1, knowledgeVisibility: 1, createdAt: 1, "analysis.confidence": 1, "analysis.evidence": 1, "knowledgeProvenance.section": 1,
    }).lean(),
    stayIds.length ? Stay.find({ _id: { $in: stayIds.map(oid) }, workspaceId }, { status: 1, checkIn: 1, checkOut: 1 }).lean() : [],
    // Only ids are read: a guest's personal fields are never loaded by the dashboard.
    guestIds.length ? Guest.find({ _id: { $in: guestIds.map(oid) }, workspaceId }, { _id: 1 }).lean() : [],
    unitIds.length ? Unit.find({ _id: { $in: unitIds.map(oid) } }, { unitNumber: 1, propertyId: 1 }).lean() : [],
  ]);

  // A Unit's tenancy is its Property's (the same rule the existing context builder applies).
  const propertyIds = unique([...rows.map((row) => row.propertyId), ...units.map((unit) => unit.propertyId)]);
  const properties = propertyIds.length ? await Property.find({ _id: { $in: propertyIds.map(oid) }, workspaceId }, { code: 1, name: 1 }).lean() : [];

  const propertyById = new Map(properties.map((p) => [String(p._id), p]));
  const unitById = new Map(units.filter((u) => propertyById.has(String(u.propertyId))).map((u) => [String(u._id), u]));
  const stayById = new Map(stays.map((s) => [String(s._id), s]));
  const guestIdsResolved = new Set(guests.map((g) => String(g._id)));
  const recordsBySignal = new Map();
  for (const record of records) {
    for (const id of record.signalIds || []) {
      const key = String(id);
      if (!recordsBySignal.has(key)) recordsBySignal.set(key, []);
      recordsBySignal.get(key).push(record);
    }
  }

  const items = rows.map((signal) => ({
    ...toSignalFacts(signal),
    property: toObservedProperty(propertyById.get(String(signal.propertyId))),
    unit: toObservedUnit(unitById.get(String(signal.unitId))),
    stay: toObservedStay(stayById.get(String(signal.stayId))),
    hasGuest: Boolean(signal.guestId) && guestIdsResolved.has(String(signal.guestId)),
    intelligence: toIntelligenceSummary(pickVisibleAnalysis(recordsBySignal.get(String(signal._id)), level)),
  }));

  return { items, pagination: buildPagination({ page, limit, total }) };
}

/**
 * GET /api/dashboard/signals/:signalId
 * A missing Signal and a Signal in another workspace are the same 404 (the
 * existing scoped behaviour).
 */
export async function getDashboardSignal(signalId, workspaceId, authorizedLevel) {
  const scope = requireObjectId(workspaceId, "workspaceId");
  const id = requireObjectId(signalId, "signalId");
  const level = normalizeCallerLevel(authorizedLevel);

  const signal = (await findInWorkspaceOr404(Signal, id, scope, "Signal")).toObject();
  const workspace = signal.workspaceId;

  const [property, unit, stay, guest, records] = await Promise.all([
    signal.propertyId ? Property.findOne({ _id: signal.propertyId, workspaceId: workspace }, { code: 1, name: 1 }).lean() : null,
    signal.unitId ? Unit.findById(signal.unitId, { unitNumber: 1, propertyId: 1 }).lean() : null,
    signal.stayId ? Stay.findOne({ _id: signal.stayId, workspaceId: workspace }, { status: 1, checkIn: 1, checkOut: 1 }).lean() : null,
    signal.guestId ? Guest.exists({ _id: signal.guestId, workspaceId: workspace }) : null,
    Intelligence.find({ ...visibleIntelligenceFilter(workspace, level), signalIds: signal._id }).lean(),
  ]);

  const unitProperty = unit ? await Property.exists({ _id: unit.propertyId, workspaceId: workspace }) : null;

  return {
    signal: toSignalFacts(signal),
    observed: {
      property: toObservedProperty(property),
      unit: toObservedUnit(unitProperty ? unit : null),
      stay: toObservedStay(stay),
      hasGuest: Boolean(guest),
    },
    intelligence: toIntelligenceDetail(pickVisibleAnalysis(records, level)),
  };
}
