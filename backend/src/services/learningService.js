import { Decision, DECISION_STATUSES } from "../models/Decision.js";
import { Action, ACTION_STATUSES } from "../models/Action.js";
import { Outcome, OUTCOME_STATUSES } from "../models/Outcome.js";
import { AppError } from "../utils/AppError.js";
import { parseObjectId, requireObjectId } from "../utils/objectId.js";
import { toPlainList } from "./queryHelpers.js";

/**
 * Phase 7D — Learning v1: a deterministic, read-only, workspace-scoped
 * report over the existing Intelligence -> Decision -> Action -> Outcome
 * graph established in Phases 2 and 7A-7C.
 *
 * This is deliberately NOT machine learning, NOT persisted, and NOT
 * connected to Python/Gemini/RAG/embeddings in any way. It answers "what
 * happened to the operational decisions and actions KOI recorded?" by
 * counting and cross-referencing what already exists in MongoDB — it never
 * judges, scores, or changes anything (see CLAUDE.md's AI/RAG boundaries
 * and the Phase 7D audit for why: real AI-generated Intelligence isn't
 * even persisted automatically yet, so this deliberately works against
 * whatever Intelligence/Decision/Action/Outcome records already exist,
 * however they were created).
 *
 * Every query below independently carries `workspaceId` — none of them
 * rely on an implicit join/lookup to preserve tenant isolation, matching
 * every other service in this codebase (see queryHelpers.js's own
 * comments on findInWorkspaceOr404/assertSameWorkspace).
 */

/** Mirrors knowledgeDocumentService.js's own assertValidDate convention. */
function assertValidDate(value, fieldName) {
  if (value === undefined || value === null || value === "") return;
  if (Number.isNaN(new Date(value).getTime())) {
    throw new AppError(`${fieldName} is not a valid date`, 400);
  }
}

function countByStatus(records, statuses) {
  const counts = { total: records.length };
  for (const status of statuses) {
    counts[status] = 0;
  }
  for (const record of records) {
    if (Object.prototype.hasOwnProperty.call(counts, record.status)) {
      counts[record.status] += 1;
    }
  }
  return counts;
}

function toIsoOrNull(value) {
  return value ? new Date(value).toISOString() : null;
}

/**
 * Produces the Learning v1 report for one workspace.
 *
 * Filters (`intelligenceId`, `decisionId`, `actionId`, `from`, `to`) are all
 * optional and narrow the SAME already-workspace-scoped result set — they
 * never widen it and never bypass the workspaceId condition on any query.
 * When any filter is applied, every count/coverage/breakdown figure in the
 * report reflects the filtered subgraph, not workspace-wide totals — this
 * keeps the report internally consistent rather than mixing a filtered
 * breakdown with unfiltered totals.
 *
 * Filter resolution, documented explicitly (Phase 7D brief, Sections 8/11):
 * - `intelligenceId` narrows Decisions, Actions, and Outcomes directly —
 *   all three carry `intelligenceId` as a direct field.
 * - `decisionId` narrows Decisions to that single record and Actions to
 *   `Action.decisionId === decisionId`. Outcome has no `decisionId` field
 *   at all (Phase 7C), so Outcomes are narrowed INDIRECTLY: to those whose
 *   `actionId` is one of the Actions already matched by this same
 *   decisionId filter (and any other active filters).
 * - `actionId` narrows Actions to that single record and Outcomes directly
 *   to `Outcome.actionId === actionId`. This takes precedence over the
 *   decisionId-derived Outcome narrowing above when both are supplied.
 * - `from`/`to` apply ONLY to `Outcome.occurredAt` (never reinterpreted as
 *   Action/Decision `createdAt`, per the brief's explicit instruction) and
 *   never narrow the Decision or Action queries.
 *
 * A filter value that happens to belong to a different workspace never
 * leaks anything — every query still carries this workspace's `workspaceId`
 * as a hard condition, so a foreign id simply matches zero documents,
 * exactly like every other filtered list endpoint in this codebase (no
 * existence check, no 404 — the same "quiet empty result" behavior
 * `listDecisions`/`listActions`/`listOutcomes` already have for their own
 * filters).
 */
export async function getLearningReport(query = {}) {
  const workspaceId = requireObjectId(query.workspaceId, "workspaceId");
  const intelligenceId = parseObjectId(query.intelligenceId, "intelligenceId");
  const decisionIdFilter = parseObjectId(query.decisionId, "decisionId");
  const actionIdFilter = parseObjectId(query.actionId, "actionId");
  assertValidDate(query.from, "from");
  assertValidDate(query.to, "to");

  const decisionFilter = { workspaceId };
  if (intelligenceId) decisionFilter.intelligenceId = intelligenceId;
  if (decisionIdFilter) decisionFilter._id = decisionIdFilter;

  const decisionDocs = await Decision.find(decisionFilter).sort({ _id: 1 });
  const decisions = toPlainList(decisionDocs);

  const actionFilter = { workspaceId };
  if (intelligenceId) actionFilter.intelligenceId = intelligenceId;
  if (decisionIdFilter) actionFilter.decisionId = decisionIdFilter;
  if (actionIdFilter) actionFilter._id = actionIdFilter;

  const actionDocs = await Action.find(actionFilter).sort({ _id: 1 });
  const actions = toPlainList(actionDocs);

  const outcomeFilter = { workspaceId };
  if (intelligenceId) outcomeFilter.intelligenceId = intelligenceId;
  if (actionIdFilter) {
    outcomeFilter.actionId = actionIdFilter;
  } else if (decisionIdFilter) {
    outcomeFilter.actionId = { $in: actions.map((action) => action._id) };
  }
  if (query.from || query.to) {
    outcomeFilter.occurredAt = {};
    if (query.from) outcomeFilter.occurredAt.$gte = new Date(query.from);
    if (query.to) outcomeFilter.occurredAt.$lte = new Date(query.to);
  }

  const outcomeDocs = await Outcome.find(outcomeFilter).sort({ _id: 1 });
  const outcomes = toPlainList(outcomeDocs);

  // --- A. Operational counts (deterministic, derived from the filtered sets above) ---
  const counts = {
    decisions: countByStatus(decisions, DECISION_STATUSES),
    actions: countByStatus(actions, ACTION_STATUSES),
    outcomes: countByStatus(outcomes, OUTCOME_STATUSES),
  };

  // --- Cross-reference maps, built once, used by both coverage (B) and the
  // traceable breakdown (C) so the two sections can never disagree with
  // each other about which records are related. ---
  const actionsByDecisionId = new Map();
  for (const action of actions) {
    if (!action.decisionId) continue;
    const key = String(action.decisionId);
    if (!actionsByDecisionId.has(key)) actionsByDecisionId.set(key, []);
    actionsByDecisionId.get(key).push(action);
  }

  const outcomesByActionId = new Map();
  for (const outcome of outcomes) {
    if (!outcome.actionId) continue;
    const key = String(outcome.actionId);
    if (!outcomesByActionId.has(key)) outcomesByActionId.set(key, []);
    outcomesByActionId.get(key).push(outcome);
  }

  // --- B. Chain coverage. Each figure is derived from distinct document
  // ids in the arrays above (never a join-row count), so one Decision with
  // three Actions is one "decisionsWithActions" row, not three. ---
  let decisionsWithActions = 0;
  let decisionsWithOutcomes = 0;
  for (const decision of decisions) {
    const relatedActions = actionsByDecisionId.get(String(decision._id)) || [];
    if (relatedActions.length > 0) decisionsWithActions += 1;
    const hasOutcome = relatedActions.some(
      (action) => (outcomesByActionId.get(String(action._id)) || []).length > 0,
    );
    if (hasOutcome) decisionsWithOutcomes += 1;
  }

  let actionsWithOutcomes = 0;
  for (const action of actions) {
    if ((outcomesByActionId.get(String(action._id)) || []).length > 0) actionsWithOutcomes += 1;
  }

  const coverage = {
    decisionsWithActions,
    decisionsWithoutActions: decisions.length - decisionsWithActions,
    actionsWithOutcomes,
    actionsWithoutOutcomes: actions.length - actionsWithOutcomes,
    decisionsWithOutcomes,
    decisionsWithoutOutcomes: decisions.length - decisionsWithOutcomes,
  };

  // --- C. Traceable operational breakdown ---
  const decisionRecords = decisions.map((decision) => {
    const relatedActions = actionsByDecisionId.get(String(decision._id)) || [];
    const relatedOutcomes = relatedActions
      .flatMap((action) => outcomesByActionId.get(String(action._id)) || [])
      .sort((a, b) => String(a._id).localeCompare(String(b._id)));

    return {
      decisionId: String(decision._id),
      intelligenceId: String(decision.intelligenceId),
      type: decision.type,
      description: decision.description,
      status: decision.status,
      priority: decision.priority,
      actionCount: relatedActions.length,
      outcomeCount: relatedOutcomes.length,
      actions: relatedActions.map((action) => ({
        actionId: String(action._id),
        status: action.status,
      })),
      outcomes: relatedOutcomes.map((outcome) => ({
        outcomeId: String(outcome._id),
        status: outcome.status,
      })),
    };
  });

  const actionRecords = actions.map((action) => {
    const relatedOutcomes = outcomesByActionId.get(String(action._id)) || [];
    return {
      actionId: String(action._id),
      decisionId: action.decisionId ? String(action.decisionId) : null,
      intelligenceId: String(action.intelligenceId),
      type: action.type,
      description: action.description,
      status: action.status,
      assignedTo: action.assignedTo ?? null,
      dueAt: toIsoOrNull(action.dueAt),
      completedAt: toIsoOrNull(action.completedAt),
      outcomeCount: relatedOutcomes.length,
    };
  });

  const outcomeRecords = outcomes.map((outcome) => ({
    outcomeId: String(outcome._id),
    actionId: outcome.actionId ? String(outcome.actionId) : null,
    intelligenceId: String(outcome.intelligenceId),
    status: outcome.status,
    result: outcome.result,
    metrics: outcome.metrics,
    feedback: outcome.feedback,
    occurredAt: toIsoOrNull(outcome.occurredAt),
  }));

  return {
    workspaceId: String(workspaceId),
    filters: {
      intelligenceId: intelligenceId ? String(intelligenceId) : null,
      decisionId: decisionIdFilter ? String(decisionIdFilter) : null,
      actionId: actionIdFilter ? String(actionIdFilter) : null,
      from: query.from || null,
      to: query.to || null,
    },
    counts,
    coverage,
    decisions: decisionRecords,
    actions: actionRecords,
    outcomes: outcomeRecords,
  };
}
