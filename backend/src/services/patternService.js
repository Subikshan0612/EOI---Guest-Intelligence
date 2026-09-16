import crypto from "node:crypto";
import mongoose from "mongoose";
import { Signal, SIGNAL_TYPES } from "../models/Signal.js";
import { Intelligence } from "../models/Intelligence.js";
import { AppError } from "../utils/AppError.js";
import { parseObjectId, requireObjectId } from "../utils/objectId.js";

/**
 * Phase 7F-A — deterministic, read-only recurring Signal pattern detection.
 *
 * This is NOT machine learning and NOT persisted. It is a single MongoDB
 * aggregation over the existing Signal collection, grouped by the one
 * reliable, controlled-vocabulary dimension Signal actually has (`type`),
 * scoped by workspace and optionally property/unit, over a bounded time
 * window. Nothing here writes to any collection, calls Python/Gemini, or
 * creates a Pattern document — a "pattern" is a computed response, not a
 * stored record (see the Phase 7F audit, Sections 2 and 6).
 *
 * Deliberately excluded per the Phase 7F audit's own findings:
 * - Decision.type / Action.type are free-form strings (not enums) and are
 *   NOT used for pattern classification — Signal.type is the only reliable
 *   category dimension available today.
 * - Intelligence/Decision/Action/Outcome linkage beyond a single indexed
 *   "is this signal referenced by any persisted Intelligence" check
 *   (`intelligenceCoverage` below) — deeper downstream linkage is 7F-C,
 *   not 7F-A, and is explicitly out of scope here.
 * - Knowledge-gap evidence of any kind — 7F-D/7F-E, not this phase.
 */

const DEFAULT_WINDOW_DAYS = 90;
const DEFAULT_THRESHOLDS = {
  minimumOccurrences: 3,
  minimumDistinctDays: 2,
  minimumDistinctStays: 2,
  minimumDistinctGuests: 2,
};

/** Mirrors the assertValidDate convention already used by knowledgeDocumentService.js / learningService.js. */
function assertValidDate(value, fieldName) {
  if (value === undefined || value === null || value === "") return;
  if (Number.isNaN(new Date(value).getTime())) {
    throw new AppError(`${fieldName} is not a valid date`, 400);
  }
}

function parseNonNegativeInteger(value, fieldName, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new AppError(`${fieldName} must be a non-negative integer`, 400);
  }
  return parsed;
}

/**
 * Truncates to the start of the current UTC calendar day. Used ONLY as the
 * default `to` boundary when the caller supplies no explicit date — this is
 * what makes the default window deterministic across repeated requests
 * within the same day (a raw `new Date()` would differ by milliseconds on
 * every call and break the "same request twice -> byte-identical response"
 * requirement). An explicitly supplied `to` is used exactly as given.
 */
function startOfUtcDay(date) {
  const truncated = new Date(date);
  truncated.setUTCHours(0, 0, 0, 0);
  return truncated;
}

/**
 * patternId is a deterministic SHA-256 hash of the pattern's IDENTITY only
 * (workspace + category + scope + time window) — never of the computed
 * counts, and never a random ObjectId. The same identity always produces
 * the same id, whether or not the underlying Signal data has changed,
 * which is what lets a caller treat a patternId as a stable reference to
 * "this category, in this scope, over this window" across repeated calls.
 */
function deterministicPatternId(identity) {
  const canonical = JSON.stringify(identity);
  return crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 24);
}

function pluralize(count, noun) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Produces the Phase 7F-A recurring-pattern result for one workspace.
 *
 * workspaceId is mandatory. propertyId/unitId/type narrow the aggregation's
 * $match stage (and, for propertyId/unitId, select the pattern's scope —
 * see the Phase 7F audit Section 7: no filter = workspace-wide, propertyId
 * only = property-specific, propertyId+unitId or unitId = unit-specific).
 * from/to bound the analysis window; minimumOccurrences/minimumDistinctDays/
 * minimumDistinctStays/minimumDistinctGuests override the qualification
 * rule's default thresholds. Every one of these is echoed back in the
 * response — nothing about the analysis is hidden.
 */
export async function getRecurringSignalPatterns(query = {}) {
  const workspaceId = requireObjectId(query.workspaceId, "workspaceId");
  const propertyId = parseObjectId(query.propertyId, "propertyId");
  const unitId = parseObjectId(query.unitId, "unitId");

  if (query.type !== undefined && query.type !== "" && !SIGNAL_TYPES.includes(query.type)) {
    throw new AppError(`type must be one of: ${SIGNAL_TYPES.join(", ")}`, 400);
  }
  const type = query.type || undefined;

  assertValidDate(query.from, "from");
  assertValidDate(query.to, "to");

  const to = query.to ? new Date(query.to) : startOfUtcDay(new Date());
  const from = query.from
    ? new Date(query.from)
    : new Date(to.getTime() - DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  if (from.getTime() >= to.getTime()) {
    throw new AppError("from must be before to", 400);
  }

  const thresholds = {
    minimumOccurrences: parseNonNegativeInteger(
      query.minimumOccurrences,
      "minimumOccurrences",
      DEFAULT_THRESHOLDS.minimumOccurrences,
    ),
    minimumDistinctDays: parseNonNegativeInteger(
      query.minimumDistinctDays,
      "minimumDistinctDays",
      DEFAULT_THRESHOLDS.minimumDistinctDays,
    ),
    minimumDistinctStays: parseNonNegativeInteger(
      query.minimumDistinctStays,
      "minimumDistinctStays",
      DEFAULT_THRESHOLDS.minimumDistinctStays,
    ),
    minimumDistinctGuests: parseNonNegativeInteger(
      query.minimumDistinctGuests,
      "minimumDistinctGuests",
      DEFAULT_THRESHOLDS.minimumDistinctGuests,
    ),
  };

  // Window is [from, to) — from inclusive, to exclusive — applied
  // identically whether the boundary was defaulted or explicitly supplied,
  // so a signal timestamped exactly at `to` is consistently excluded rather
  // than depending on which boundary happened to be defaulted.
  //
  // Unlike Model.find(), Model.aggregate() does NOT cast plain strings to
  // ObjectId based on the schema — a raw string workspaceId/propertyId/
  // unitId in a $match stage silently matches zero documents instead of
  // erroring. Every id must be cast explicitly before it reaches the
  // pipeline.
  const matchStage = {
    workspaceId: new mongoose.Types.ObjectId(workspaceId),
    occurredAt: { $gte: from, $lt: to },
  };
  if (propertyId) matchStage.propertyId = new mongoose.Types.ObjectId(propertyId);
  if (unitId) matchStage.unitId = new mongoose.Types.ObjectId(unitId);
  if (type) matchStage.type = type;

  // Single aggregation pipeline over Signal — never loads the collection
  // into Node memory. workspaceId is the first condition in the very first
  // stage (Phase 7F audit Section 11/13). The $sort before $group makes the
  // $push'd signalIds arrive in deterministic (ascending _id) order without
  // needing a separate in-memory sort per group afterward.
  const groups = await Signal.aggregate([
    { $match: matchStage },
    { $sort: { _id: 1 } },
    {
      $group: {
        _id: "$type",
        occurrenceCount: { $sum: 1 },
        signalIds: { $push: "$_id" },
        stayIds: { $addToSet: "$stayId" },
        guestIds: { $addToSet: "$guestId" },
        days: {
          $addToSet: { $dateToString: { format: "%Y-%m-%d", date: "$occurredAt", timezone: "UTC" } },
        },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  const scope = {
    propertyId: propertyId ? String(propertyId) : null,
    unitId: unitId ? String(unitId) : null,
  };
  const timeWindow = { from: from.toISOString(), to: to.toISOString() };
  const scopeLabel = unitId ? `unit ${scope.unitId}` : propertyId ? `property ${scope.propertyId}` : "the workspace";

  const patterns = [];

  for (const group of groups) {
    const category = group._id;
    const occurrenceCount = group.occurrenceCount;
    const distinctStayCount = group.stayIds.filter(Boolean).length;
    const distinctGuestCount = group.guestIds.filter(Boolean).length;
    const distinctDayCount = group.days.length;

    // The qualification rule (Phase 7F audit Section 4): a minimum raw
    // occurrence count AND at least one distinctness dimension meeting its
    // own threshold. The OR across day/stay/guest exists specifically so a
    // purely operational signal type with no guest/stay attribution (e.g.
    // recurring equipment failures) can still qualify via distinct days,
    // rather than being structurally excluded by guest/stay requirements
    // that don't apply to it.
    const qualifies =
      occurrenceCount >= thresholds.minimumOccurrences &&
      (distinctDayCount >= thresholds.minimumDistinctDays ||
        distinctStayCount >= thresholds.minimumDistinctStays ||
        distinctGuestCount >= thresholds.minimumDistinctGuests);

    if (!qualifies) continue;

    const signalIds = group.signalIds.map((id) => String(id)).sort();

    const patternId = deterministicPatternId({
      workspaceId: String(workspaceId),
      patternType: "recurring_signal",
      category,
      scope,
      timeWindow,
    });

    // Intelligence coverage: ONE indexed query against Intelligence's own
    // `signalIds` field (already indexed — Intelligence.js's
    // `intelligenceSchema.index({ signalIds: 1 })`), never a per-signal
    // loop and never a schema change. Absence of a match means "no
    // persisted Intelligence record was linked" — it does NOT mean "no
    // decision was made" (Phase 7F audit Section 9); the persistence gap
    // documented in that audit means most real events may show 0 coverage
    // today, and that is reported honestly rather than hidden.
    const linkedIntelligence = await Intelligence.find(
      { workspaceId, signalIds: { $in: group.signalIds } },
      { _id: 1, signalIds: 1 },
    );
    const coveredSignalIds = new Set();
    for (const doc of linkedIntelligence) {
      for (const sid of doc.signalIds) {
        const sidStr = String(sid);
        if (signalIds.includes(sidStr)) coveredSignalIds.add(sidStr);
      }
    }
    const linkedIntelligenceIds = linkedIntelligence.map((doc) => String(doc._id)).sort();

    const description =
      `${pluralize(occurrenceCount, `${category} signal`)} in ${scopeLabel} between ${timeWindow.from} and ${timeWindow.to} ` +
      `(${pluralize(distinctDayCount, "distinct day")}, ${pluralize(distinctStayCount, "distinct stay")}, ` +
      `${pluralize(distinctGuestCount, "distinct guest")}).`;

    patterns.push({
      patternId,
      workspaceId: String(workspaceId),
      patternType: "recurring_signal",
      category,
      scope,
      timeWindow,
      occurrenceCount,
      distinctStayCount,
      distinctGuestCount,
      distinctDayCount,
      signalIds,
      intelligenceCoverage: { linked: coveredSignalIds.size, total: occurrenceCount },
      linkedIntelligenceIds,
      evidence: {
        rule:
          "occurrenceCount >= minimumOccurrences AND (distinctDayCount >= minimumDistinctDays " +
          "OR distinctStayCount >= minimumDistinctStays OR distinctGuestCount >= minimumDistinctGuests)",
        thresholds,
        values: { occurrenceCount, distinctDayCount, distinctStayCount, distinctGuestCount },
        duplicateDetectionLimitation:
          "Signal has no incidentId/relatedSignalId field, so this system cannot determine whether " +
          "these occurrences are independent incidents or repeated reports of a single incident. " +
          "distinctDayCount/distinctStayCount/distinctGuestCount reduce, but do not eliminate, that risk.",
      },
      description,
    });
  }

  patterns.sort((a, b) => (a.category < b.category ? -1 : a.category > b.category ? 1 : 0));

  return {
    workspaceId: String(workspaceId),
    scope,
    timeWindow,
    thresholds,
    patterns,
  };
}
