import { confidenceInfo } from "./dashboardMapping";

/** Categorical confidence (high | medium | low) — never a percentage. */
export default function ConfidenceBadge({ confidence, withExplanation = false }) {
  const info = confidenceInfo(confidence);
  if (!info) return null;
  return (
    <span className="confidence-wrap">
      <span className="confidence-badge" data-confidence={confidence}>
        {info.label} confidence
      </span>
      {withExplanation ? <span className="muted dash-note">{info.explanation}</span> : null}
    </span>
  );
}
