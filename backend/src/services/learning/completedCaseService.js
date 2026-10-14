import mongoose from "mongoose";
import { Action } from "../../models/Action.js";
import { Decision } from "../../models/Decision.js";
import { Intelligence } from "../../models/Intelligence.js";
import { Outcome, OUTCOME_VERSION } from "../../models/Outcome.js";
import { Property } from "../../models/Property.js";
import { Signal } from "../../models/Signal.js";
import { Unit } from "../../models/Unit.js";
import { findInWorkspaceOr404 } from "../queryHelpers.js";
import { requireObjectId } from "../../utils/objectId.js";
import { profileOfSignal, normalizeCompletedCase } from "./completedCase.js";

/**
 * Case-based Learning L1 - DERIVES completed operational cases from the persisted chain, when asked. READ-ONLY: it never writes, never changes a record, adds no
 * collection and needs no migration. A case exists only for a genuinely completed workflow (see completedCase.js): an Intelligence, a Decision or an Action
 * without a person-recorded Outcome V1 never produces one.
 *
 * TENANT ISOLATION. Every query below carries the workspace filter; the workspaceId is validated as an ObjectId before anything is read; each linked record is
 * fetched with `{ workspaceId }` AND re-checked by normalizeCompletedCase (a record of another workspace that somehow carried a matching id is rejected as
 * WORKSPACE_MISMATCH, never used). The workspace is the verified actor's own (the caller supplies it, exactly like outcomeLearningService / learningContextService).
 */
export const MAX_COMPLETED_CASES = 500; // most recent Outcomes considered (development-oriented bound, like the existing Learning window)

const ids = (rows, key) => [...new Set(rows.map((r) => r[key]).filter(Boolean).map(String))].map((v) => new mongoose.Types.ObjectId(v));
const byId = (rows) => new Map(rows.map((r) => [String(r._id), r]));

/** Units carry no workspaceId: their scope is their Property's workspaceId. Only units whose Property belongs to THIS workspace are returned. */
async function unitsInWorkspace(scope, unitIds) {
  if (unitIds.length === 0) return [];
  const units = await Unit.find({ _id: { $in: unitIds } }).lean();
  const properties = await Property.find({ workspaceId: scope, _id: { $in: ids(units, "propertyId") } }, { _id: 1 }).lean();
  const allowed = new Set(properties.map((p) => String(p._id)));
  return units.filter((u) => allowed.has(String(u.propertyId)));
}

/**
 * @param {string} workspaceId the verified workspace
 * @param {{ excludeSignalId?: string, limit?: number }} [options] excludeSignalId: the CURRENT case's Signal, never part of its own history
 * @returns {Promise<{ cases: object[], considered: number, rejected: Record<string, number> }>} cases in a deterministic order (most recently recorded first, then case key)
 */
export async function loadCompletedCases(workspaceId, { excludeSignalId, limit = MAX_COMPLETED_CASES } = {}) {
  const scope = requireObjectId(workspaceId, "workspaceId");
  const exclude = excludeSignalId ? requireObjectId(excludeSignalId, "excludeSignalId") : null;
  const cap = Math.min(Math.max(Number.isInteger(limit) ? limit : MAX_COMPLETED_CASES, 1), MAX_COMPLETED_CASES);

  const outcomeFilter = { workspaceId: scope, outcomeVersion: OUTCOME_VERSION, recordedBy: { $exists: true }, recordedAt: { $exists: true } };
  if (exclude) outcomeFilter.signalId = { $ne: exclude };
  const outcomes = await Outcome.find(outcomeFilter).sort({ recordedAt: -1, _id: -1 }).limit(cap).lean();

  const [actions, decisions, intelligences, signals] = await Promise.all([
    Action.find({ workspaceId: scope, _id: { $in: ids(outcomes, "actionId") } }).lean(),
    Decision.find({ workspaceId: scope, _id: { $in: ids(outcomes, "decisionId") } }).lean(),
    Intelligence.find({ workspaceId: scope, _id: { $in: ids(outcomes, "intelligenceId") } }).lean(),
    Signal.find({ workspaceId: scope, _id: { $in: ids(outcomes, "signalId") } }).lean(),
  ]);
  const units = await unitsInWorkspace(scope, ids(signals, "unitId"));
  const actionMap = byId(actions); const decisionMap = byId(decisions); const intelMap = byId(intelligences); const signalMap = byId(signals); const unitMap = byId(units);

  const cases = []; const rejected = {};
  for (const outcome of outcomes) {
    const signal = signalMap.get(String(outcome.signalId));
    const result = normalizeCompletedCase({ outcome, action: actionMap.get(String(outcome.actionId)), decision: decisionMap.get(String(outcome.decisionId)), intelligence: intelMap.get(String(outcome.intelligenceId)), signal, unit: signal?.unitId ? unitMap.get(String(signal.unitId)) : undefined }, scope);
    if (result.ok) cases.push(result.case);
    else rejected[result.reason] = (rejected[result.reason] ?? 0) + 1;
  }
  cases.sort((a, b) => b.internal.recordedAtMs - a.internal.recordedAtMs || (a.internal.caseKey < b.internal.caseKey ? -1 : 1));
  return { cases, considered: outcomes.length, rejected };
}

/**
 * The profile of the CURRENT Signal (which has no Outcome yet), derived by the same code as a completed case's profile. The safety side is the server policy over
 * this Signal alone: no analysis, history or model output is an input.
 * @returns {Promise<{ profile: object, signalId: string }>} throws a 404 AppError (the same one a missing record gives) when the Signal is not in this workspace
 */
export async function buildCurrentCaseProfile(workspaceId, signalId) {
  const scope = requireObjectId(workspaceId, "workspaceId");
  const id = requireObjectId(signalId, "signalId");
  const signal = (await findInWorkspaceOr404(Signal, id, scope, "Signal")).toObject();
  const unit = signal.unitId ? (await unitsInWorkspace(scope, [signal.unitId]))[0] ?? null : null;
  return { profile: profileOfSignal(signal, unit), signalId: String(signal._id) };
}
