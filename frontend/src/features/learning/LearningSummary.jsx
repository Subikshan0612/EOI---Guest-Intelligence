/**
 * Layer A — Outcome Distribution (Phase 7E, Part 6).
 *
 * Factual counts only: total Decisions/Actions/Outcomes, and the Outcome
 * status breakdown (success/partial/failed/unknown). Deliberately no
 * weighted score, no ranking, no single "effectiveness" number — the
 * Phase 7D backend never computes one, and this layer doesn't invent one
 * either.
 */
const OUTCOME_STATUSES = ["success", "partial", "failed", "unknown"];

export default function LearningSummary({ counts }) {
  return (
    <section className="koi-card learning-summary">
      <h2 className="card-label">Outcome Distribution</h2>

      <div className="learning-stat-row">
        <div className="learning-stat">
          <span className="learning-stat-value">{counts.decisions.total}</span>
          <span className="learning-stat-label">Decisions</span>
        </div>
        <div className="learning-stat">
          <span className="learning-stat-value">{counts.actions.total}</span>
          <span className="learning-stat-label">Actions</span>
        </div>
        <div className="learning-stat">
          <span className="learning-stat-value">{counts.outcomes.total}</span>
          <span className="learning-stat-label">Outcomes</span>
        </div>
      </div>

      <h3 className="card-label learning-subsection-label">Outcome status</h3>
      <ul className="learning-status-list">
        {OUTCOME_STATUSES.map((status) => (
          <li key={status}>
            <span className="status-chip" data-tone={status}>
              {status}
            </span>
            <span className="learning-status-count">{counts.outcomes[status]}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
