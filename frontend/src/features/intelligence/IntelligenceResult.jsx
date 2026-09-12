/**
 * Renders one validated Phase 4 AI intelligence result. All fields have
 * already passed the backend's strict structural validation
 * (backend/src/services/ai/intelligenceSchema.js) — this component only
 * presents them, using the same card/chip primitives as the rest of KOI.
 */
export default function IntelligenceResult({ result }) {
  if (!result) return null;

  return (
    <>
      <div className="koi-card">
        <h3 className="card-label">Intelligence</h3>
        <p>{result.summary}</p>
        {result.findings.length ? (
          <ul className="stack-sm">
            {result.findings.map((finding, index) => (
              <li key={index}>{finding}</li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="koi-card">
        <h3 className="card-label">Risk</h3>
        <div className="intelligence-meta-row">
          <span className="risk-chip" data-level={result.risk.level}>
            {result.risk.level} risk
          </span>
        </div>
        <p className="muted">{result.risk.reason}</p>
      </div>

      <div className="koi-card">
        <h3 className="card-label">Recommended Decision</h3>
        <p>{result.decision.recommendation}</p>
        {result.decision.rationale ? <p className="muted">{result.decision.rationale}</p> : null}
      </div>

      <div className="koi-card">
        <h3 className="card-label">Recommended Action</h3>
        <p>{result.action.label}</p>
        {result.action.recommended.length ? (
          <ol className="stack-sm">
            {result.action.recommended.map((step, index) => (
              <li key={index}>
                {step.step}{" "}
                <span className="status-chip" data-tone={step.priority}>
                  {step.priority}
                </span>
              </li>
            ))}
          </ol>
        ) : null}
      </div>

      <div className="koi-card">
        <h3 className="card-label">Expected Outcome</h3>
        <p>{result.outcome.expected}</p>
      </div>
    </>
  );
}
