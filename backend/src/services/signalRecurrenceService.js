import { OUTCOME_VERSION, Outcome } from "../models/Outcome.js";
import { Intelligence } from "../models/Intelligence.js";
import { Signal } from "../models/Signal.js";
import { intelligenceVisibleTo } from "./decisionService.js";
import { normalizeCallerLevel } from "./knowledge/visibility.js";
import { findInWorkspaceOr404 } from "./queryHelpers.js";
import { deriveRecurrence } from "./recurrence.js";
import { assembleSignalContext } from "./signalContextService.js";

/**
 * GET /api/signals/:id/context, with the server-derived RECURRENCE note added (safety/context hardening, P2-B).
 *
 * The context assembly itself is unchanged (it performs no interpretation, signalContextService.js). The recurrence is derived here, separately, by the deterministic rule in recurrence.js
 * from the structured issue of this Signal and of EARLIER Signals of the SAME room (workspace-scoped; every query filters `workspaceId` itself). It is a record match only and it is
 * recomputed from the stored records on every read, so it can never drift or be set by a client. Nothing about it is sent to the model (the analysis pipeline is untouched).
 *
 * Historical OUTCOME evidence (what a person recorded after an earlier Action) is attached to a matched earlier report only for a caller who may already read Outcomes
 * (`decision:review`, the same permission as GET /api/outcomes) and only when that Outcome's parent Intelligence is visible at the caller's knowledge level. It is a person's own
 * report, labelled as such by the UI; it is not Learning, changes nothing and is never presented as a result of the current case.
 */
const SUMMARY_MAX = 300;
const EARLIER_SCAN_LIMIT = 50;

export async function getSignalContextWithRecurrence(signalId, workspaceId, { includeOutcomes = false, authorizedLevel } = {}) {
  const context = await assembleSignalContext(signalId, workspaceId);
  const current = await findInWorkspaceOr404(Signal, signalId, workspaceId, "Signal");
  const recurrence = await recurrenceFor(current, workspaceId, { includeOutcomes, level: normalizeCallerLevel(authorizedLevel) });
  return { ...context, recurrence };
}

async function recurrenceFor(current, workspaceId, { includeOutcomes, level }) {
  const none = deriveRecurrence({ id: String(current._id), unitId: current.unitId, createdAt: current.createdAt, issue: current.issue }, []);
  if (!current.unitId) return publicView(none, new Map());
  const earlier = await Signal.find({ workspaceId, unitId: current.unitId, _id: { $ne: current._id }, createdAt: { $lt: current.createdAt } })
    .sort({ createdAt: -1, _id: -1 })
    .limit(EARLIER_SCAN_LIMIT)
    .select("unitId createdAt issue")
    .lean();
  const derived = deriveRecurrence(
    { id: String(current._id), unitId: current.unitId, createdAt: current.createdAt, issue: current.issue },
    earlier.map((s) => ({ id: String(s._id), unitId: s.unitId, createdAt: s.createdAt, issue: s.issue })),
  );
  const outcomes = new Map();
  if (includeOutcomes && derived.detected) {
    const ids = derived.matches.map((m) => m.id).filter(Boolean);
    const records = await Outcome.find({ workspaceId, outcomeVersion: OUTCOME_VERSION, signalId: { $in: ids } }).sort({ recordedAt: -1 }).lean();
    const parents = records.length ? await Intelligence.find({ workspaceId, _id: { $in: records.map((r) => r.intelligenceId) } }).lean() : [];
    const visible = new Set(parents.filter((p) => intelligenceVisibleTo(p, level)).map((p) => String(p._id)));
    for (const r of records) {
      const key = String(r.signalId);
      if (outcomes.has(key) || !visible.has(String(r.intelligenceId))) continue;
      outcomes.set(key, { status: r.status, recordedAt: r.recordedAt instanceof Date ? r.recordedAt.toISOString() : null, summary: String(r.result?.summary ?? "").slice(0, SUMMARY_MAX) });
    }
  }
  return publicView(derived, outcomes);
}

/** The client view: no record ids, only what the page needs to state the match plainly. */
function publicView(derived, outcomes) {
  return {
    version: derived.version,
    detected: derived.detected,
    scope: derived.scope,
    matches: derived.matches.map((m) => ({ reportedAt: m.recordedAt, issue: { equipment: m.issue.equipment, problem: m.issue.problemFamily, condition: m.issue.condition }, condition: m.condition, ...(outcomes.has(m.id) ? { outcome: outcomes.get(m.id) } : {}) })),
  };
}
