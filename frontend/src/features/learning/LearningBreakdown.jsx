import { formatStatusLabel } from "../operations/operationsMapping";
import { formatShortDate } from "../../utils/formatDate";
import { indexById, actionsWithoutDecision, outcomesWithoutAction, outcomesForAction } from "./learningMapping";

/**
 * Layer C — Traceable Operational Breakdown (Phase 7E, Part 6).
 *
 * Renders the full Decision -> Action -> Outcome graph exactly as the
 * Phase 7D API returns it, including every incomplete-chain case: a
 * Decision with no Action, an Action with no Outcome, and an Outcome with
 * no Action at all. Nothing is hidden or invented — an id that doesn't
 * resolve to a full record (shouldn't happen given Phase 7A-7C's own
 * integrity guarantees, but this component doesn't assume it) is simply
 * skipped rather than crashing the page.
 *
 * Uses native <details>/<summary> for the expand/collapse behavior Part 6
 * asks for — no extra state, no extra dependency, keyboard-accessible by
 * default.
 */
function OutcomeRow({ outcome }) {
  return (
    <li className="learning-outcome-row">
      <span className="status-chip" data-tone={outcome.status}>
        {outcome.status}
      </span>
      <div className="learning-outcome-copy">
        {outcome.result?.summary ? <p>{outcome.result.summary}</p> : <p className="muted">No result summary recorded.</p>}
        <p className="learning-outcome-meta">
          {outcome.occurredAt ? formatShortDate(outcome.occurredAt) : "No occurrence time recorded"}
        </p>
      </div>
    </li>
  );
}

function ActionEntry({ action, outcomes }) {
  const actionOutcomes = outcomesForAction(outcomes, action.actionId);
  return (
    <li className="learning-action-row">
      <div className="learning-action-header">
        <span className="status-chip" data-tone={action.status}>
          {formatStatusLabel(action.status)}
        </span>
        <span className="learning-action-description">{action.description}</span>
      </div>
      <p className="learning-action-meta">
        {action.assignedTo ? `Assigned to ${action.assignedTo}` : "Unassigned"}
        {action.dueAt ? ` · Due ${formatShortDate(action.dueAt)}` : ""}
        {action.completedAt ? ` · Completed ${formatShortDate(action.completedAt)}` : ""}
      </p>
      {actionOutcomes.length ? (
        <ul className="learning-outcome-list">
          {actionOutcomes.map((outcome) => (
            <OutcomeRow key={outcome.outcomeId} outcome={outcome} />
          ))}
        </ul>
      ) : (
        <p className="muted learning-empty-branch">No outcome recorded yet.</p>
      )}
    </li>
  );
}

function DecisionEntry({ decision, actionsById, outcomes }) {
  const linkedActions = decision.actions
    .map((ref) => actionsById.get(ref.actionId))
    .filter(Boolean);

  return (
    <details className="learning-decision">
      <summary className="learning-decision-summary">
        <span className="learning-decision-chips">
          <span className="status-chip" data-tone={decision.status}>
            {formatStatusLabel(decision.status)}
          </span>
          <span className="status-chip" data-tone={decision.priority}>
            {decision.priority}
          </span>
          <span className="learning-decision-counts muted">
            {decision.actionCount} action{decision.actionCount === 1 ? "" : "s"} ·{" "}
            {decision.outcomeCount} outcome{decision.outcomeCount === 1 ? "" : "s"}
          </span>
        </span>
        <span className="learning-decision-description">{decision.description}</span>
      </summary>

      <div className="learning-decision-body">
        {linkedActions.length ? (
          <ul className="learning-action-list">
            {linkedActions.map((action) => (
              <ActionEntry key={action.actionId} action={action} outcomes={outcomes} />
            ))}
          </ul>
        ) : (
          <p className="muted learning-empty-branch">No action recorded yet.</p>
        )}
      </div>
    </details>
  );
}

export default function LearningBreakdown({ decisions, actions, outcomes }) {
  const actionsById = indexById(actions, "actionId");
  const orphanActions = actionsWithoutDecision(actions);
  const orphanOutcomes = outcomesWithoutAction(outcomes);

  return (
    <section className="learning-breakdown">
      <h2 className="card-label">Traceable Operational Breakdown</h2>

      {decisions.length ? (
        <ul className="learning-decision-list">
          {decisions.map((decision) => (
            <li key={decision.decisionId}>
              <DecisionEntry decision={decision} actionsById={actionsById} outcomes={outcomes} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No Decisions recorded yet.</p>
      )}

      {orphanActions.length ? (
        <div className="learning-orphan-section">
          <h3 className="card-label learning-subsection-label">Actions without a Decision</h3>
          <ul className="learning-action-list">
            {orphanActions.map((action) => (
              <ActionEntry key={action.actionId} action={action} outcomes={outcomes} />
            ))}
          </ul>
        </div>
      ) : null}

      {orphanOutcomes.length ? (
        <div className="learning-orphan-section">
          <h3 className="card-label learning-subsection-label">Outcomes without an Action</h3>
          <ul className="learning-outcome-list">
            {orphanOutcomes.map((outcome) => (
              <OutcomeRow key={outcome.outcomeId} outcome={outcome} />
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
