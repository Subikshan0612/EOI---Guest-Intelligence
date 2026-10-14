import crypto from "node:crypto";
import mongoose from "mongoose";
import { ACTION_TYPES, ACTION_VERSION, Action } from "../models/Action.js";
import { OUTCOME_STATUSES, OUTCOME_VERSION, Outcome } from "../models/Outcome.js";
import { AppError } from "../utils/AppError.js";
import { requireObjectId } from "../utils/objectId.js";

/**
 * Phase 31 — Learning V1: a deterministic, read-only, workspace-scoped AGGREGATE over trusted Outcome V1
 * records, grouped by the Action V1's own closed `actionType`. Like the existing Phase 7D/7F-A learning
 * endpoints it extends (learningService.js, patternService.js), this is NOT machine learning, NOT persisted,
 * and NOT connected to Python/Gemini/RAG/embeddings in any way — there is no new collection, no write path,
 * and nothing here is ever read by the canonical Intelligence pipeline (see
 * backend/docs/LEARNING_FEEDBACK_PHASE31.md §16-17 for the explicit proof).
 *
 *   Outcome (V1, immutable, Phase 30) -> grouped by Action.actionType (V1, closed enum, Phase 29)
 *     -> outcomeCounts{success,failed,partial,unknown} -> successRate (unknown excluded from both the
 *        numerator and the denominator) -> eligible (>= MINIMUM_SAMPLE_SIZE DETERMINED observations)
 *
 * "Learning" here is an OBSERVATION, never an instruction: it cannot create, approve, reject, or execute
 * anything, and nothing downstream reads it automatically. A pattern saying "escalation has historically
 * succeeded" never means "therefore execute escalation."
 */

export const LEARNING_VERSION = "learning-v1";
// A documented, conservative placeholder, not a statistically derived figure (see the Phase 31 doc §7): large
// enough that a single anomalous Outcome cannot make a pattern look authoritative, small enough to be
// reachable at this system's current operational volume. Future phases may revisit it with real data.
export const MINIMUM_SAMPLE_SIZE = 5;
const DEFAULT_WINDOW_DAYS = 90;

function assertValidDate(value, fieldName) {
  if (value === undefined || value === null || value === "") return;
  if (Number.isNaN(new Date(value).getTime())) {
    throw new AppError(`${fieldName} is not a valid date`, 400);
  }
}

/** Mirrors patternService.js's own helper exactly, for the same determinism reason (see there). */
function startOfUtcDay(date) {
  const truncated = new Date(date);
  truncated.setUTCHours(0, 0, 0, 0);
  return truncated;
}

/**
 * patternKey is a deterministic SHA-256 hash of the pattern's IDENTITY only (workspace + actionType +
 * learningVersion) — never of the computed counts — mirroring patternService.js's deterministicPatternId
 * exactly. The same identity always produces the same key.
 */
function deterministicPatternKey(identity) {
  const canonical = JSON.stringify(identity);
  return crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 24);
}

const emptyOutcomeCounts = () => Object.fromEntries(OUTCOME_STATUSES.map((status) => [status, 0]));

/**
 * getOutcomeLearningPatterns(query) — the ONLY export of this module. There is no corresponding write
 * function anywhere: a LearningPattern is always computed fresh from Action/Outcome, never stored, so there
 * is nothing to keep in sync, nothing that can go stale in a way a second write could fix, and nothing a
 * workspace deletion needs to separately clean up (see the Phase 31 doc §15).
 *
 * `workspaceId` MUST already be the verified actor's own workspace (the controller passes `req.actor.
 * workspaceId`, never a client selector) - exactly the same contract every other Phase 16 read in this
 * codebase already uses.
 */
export async function getOutcomeLearningPatterns(query = {}) {
  const workspaceId = requireObjectId(query.workspaceId, "workspaceId");
  assertValidDate(query.from, "from");
  assertValidDate(query.to, "to");

  const to = query.to ? new Date(query.to) : startOfUtcDay(new Date());
  const from = query.from ? new Date(query.from) : new Date(to.getTime() - DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  if (from.getTime() >= to.getTime()) {
    throw new AppError("from must be before to", 400);
  }

  const wsOid = new mongoose.Types.ObjectId(workspaceId);

  // ONE aggregation, Action V1 joined to its (at most one, Phase 30) Outcome V1, inside the window, grouped by
  // actionType - never loads raw documents into Node, never reads a Signal/Guest/Decision/Intelligence field,
  // so there is no free-text or PII-bearing field anywhere in this pipeline for a client or an injected
  // string to reach (see the Phase 31 doc §12 and the Y/Z marker tests in validate-phase31-learning-feedback.mjs).
  const rows = await Action.aggregate([
    { $match: { workspaceId: wsOid, actionVersion: ACTION_VERSION } },
    {
      $lookup: {
        from: Outcome.collection.name,
        let: { actionId: "$_id" },
        pipeline: [
          { $match: { $expr: { $and: [{ $eq: ["$actionId", "$$actionId"] }, { $eq: ["$workspaceId", wsOid] }, { $eq: ["$outcomeVersion", OUTCOME_VERSION] }] } } },
          { $match: { recordedAt: { $gte: from, $lt: to } } },
          { $project: { status: 1, recordedAt: 1 } },
        ],
        as: "outcome",
      },
    },
    { $unwind: { path: "$outcome", preserveNullAndEmptyArrays: true } },
    {
      $group: {
        _id: "$actionType",
        statuses: { $push: "$outcome.status" },
        recordedAts: { $push: "$outcome.recordedAt" },
      },
    },
  ]);

  const byType = new Map(rows.map((row) => [row._id, row]));

  const patterns = ACTION_TYPES.map((actionType) => {
    const row = byType.get(actionType);
    const outcomeCounts = emptyOutcomeCounts();
    let firstObservedAt = null;
    let lastObservedAt = null;
    if (row) {
      for (const [index, status] of row.statuses.entries()) {
        if (!status || !Object.prototype.hasOwnProperty.call(outcomeCounts, status)) continue; // the $lookup found no Outcome for this Action in-window
        outcomeCounts[status] += 1;
        const at = row.recordedAts[index];
        if (at && (!firstObservedAt || at < firstObservedAt)) firstObservedAt = at;
        if (at && (!lastObservedAt || at > lastObservedAt)) lastObservedAt = at;
      }
    }
    const totalOutcomes = OUTCOME_STATUSES.reduce((sum, status) => sum + outcomeCounts[status], 0);
    // Denominator semantics (Phase 31 doc §6): "unknown" is excluded from BOTH the numerator and the
    // denominator - an outcome whose result could not be determined is neither a success nor a failure, and
    // must never silently count as either. A workspace with zero determined outcomes gets `successRate: null`
    // (never 0 or 1), which is why this is never mislabeled "confidence" anywhere in this module.
    const determinedOutcomeCount = outcomeCounts.success + outcomeCounts.failed + outcomeCounts.partial;
    const successRate = determinedOutcomeCount > 0 ? outcomeCounts.success / determinedOutcomeCount : null;

    return {
      patternKey: deterministicPatternKey({ workspaceId: String(workspaceId), actionType, learningVersion: LEARNING_VERSION }),
      actionType,
      outcomeCounts,
      totalOutcomes,
      determinedOutcomeCount,
      successRate,
      eligible: determinedOutcomeCount >= MINIMUM_SAMPLE_SIZE,
      sourceOutcomeCount: totalOutcomes,
      firstObservedAt: firstObservedAt ? firstObservedAt.toISOString() : null,
      lastObservedAt: lastObservedAt ? lastObservedAt.toISOString() : null,
    };
  });

  return {
    workspaceId: String(workspaceId),
    learningVersion: LEARNING_VERSION,
    sourceVersions: { actionVersion: ACTION_VERSION, outcomeVersion: OUTCOME_VERSION },
    window: { from: from.toISOString(), to: to.toISOString() },
    minimumSampleSize: MINIMUM_SAMPLE_SIZE,
    patterns,
  };
}
