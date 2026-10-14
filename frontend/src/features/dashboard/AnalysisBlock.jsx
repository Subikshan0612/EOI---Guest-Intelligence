import ConfidenceBadge from "./ConfidenceBadge";
import { formatShortDate } from "../../utils/formatDate";

/** Stored AI interpretation. Text is shown as stored; internal evidence references the model repeated in its prose are removed by the mapping layer (presentation only). */
export default function AnalysisBlock({ analysis }) {
  return (
    <section className="koi-card dash-block" aria-labelledby="dash-intelligence">
      <p className="intel-section-label intel-section-label-intelligence" id="dash-intelligence">
        Intelligence
      </p>
      <p className="muted dash-note">AI-generated interpretation, not a database fact</p>

      <h4 className="card-label">Situation</h4>
      <p className="dash-text">{analysis.situation}</p>

      <h4 className="card-label">Evidence</h4>
      {analysis.evidence.length ? (
        <ul className="dash-evidence">
          {analysis.evidence.map((item, i) => (
            <li key={i}>{typeof item === "string" ? item : JSON.stringify(item)}</li>
          ))}
        </ul>
      ) : (
        <p className="muted">No evidence items stored.</p>
      )}

      <h4 className="card-label">Impact</h4>
      <p className="dash-text">{analysis.impact}</p>

      <h4 className="card-label">Confidence</h4>
      <ConfidenceBadge confidence={analysis.confidence} withExplanation />
      <p className="muted dash-note">Analysis stored {formatShortDate(analysis.createdAt)}</p>
    </section>
  );
}
