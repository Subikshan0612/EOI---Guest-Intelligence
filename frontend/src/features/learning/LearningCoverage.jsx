/**
 * Layer B — Operational Chain Coverage (Phase 7E, Part 6).
 *
 * Shows how complete the Decision -> Action -> Outcome loop is, using the
 * Phase 7D coverage fields directly. Presented as plain "X of Y" ratios —
 * a direct, clearly-labeled factual count, never a performance score.
 */
function CoverageRow({ label, withCount, total }) {
  return (
    <li className="learning-coverage-row">
      <span>{label}</span>
      <span className="learning-coverage-ratio">
        {withCount} of {total}
      </span>
    </li>
  );
}

export default function LearningCoverage({ coverage, counts }) {
  return (
    <section className="koi-card learning-coverage">
      <h2 className="card-label">Operational Chain Coverage</h2>
      <p className="muted">What happened after the intelligence?</p>
      <ul className="learning-coverage-list">
        <CoverageRow
          label="Decisions with at least one recorded Action"
          withCount={coverage.decisionsWithActions}
          total={counts.decisions.total}
        />
        <CoverageRow
          label="Actions with at least one recorded Outcome"
          withCount={coverage.actionsWithOutcomes}
          total={counts.actions.total}
        />
        <CoverageRow
          label="Decisions with at least one recorded Outcome"
          withCount={coverage.decisionsWithOutcomes}
          total={counts.decisions.total}
        />
      </ul>
    </section>
  );
}
