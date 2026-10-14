import { Link } from "react-router-dom";
import { DECISION_STATUS_LABELS, formatLabel, resolveDecision } from "./dashboardMapping";
import { formatShortDate } from "../../utils/formatDate";

/** One selectable Signal. Only recorded operational fields — never guest details. */
export default function SignalRow({ signal, selected, decisions }) {
  const resolved = resolveDecision(decisions, signal.analysis?.id);
  const decisionText =
    resolved.state === "found"
      ? DECISION_STATUS_LABELS[resolved.decision.status]
      : resolved.state === "none"
        ? "Not proposed"
        : resolved.state === "unavailable"
          ? "unavailable"
          : null;
  const meta = [
    signal.unit ? `Unit ${signal.unit.unitNumber}` : null,
    signal.property?.name,
    signal.occurredAt ? formatShortDate(signal.occurredAt) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <li>
      <Link
        to={`/intelligence/${signal.id}`}
        className={`op-list-link dash-row${selected ? " is-selected" : ""}`}
        aria-current={selected ? "true" : undefined}
      >
        <span className="op-list-copy">
          <span className="dash-row-chips">
            <span className="status-chip" data-tone={signal.severity}>
              {signal.severity}
            </span>
            <span className="muted dash-note">{formatLabel(signal.type)}</span>
            {signal.synthetic ? <span className="synthetic-tag">Synthetic test</span> : null}
          </span>
          <span className="op-list-title">{signal.title}</span>
          <span className="muted dash-note">
            {meta || "No location or time recorded"}
          </span>
          <span className="dash-row-chips">
            <span className="status-chip" data-tone={signal.status}>
              {formatLabel(signal.status)}
            </span>
            {signal.analysis ? (
              <span className="dash-analyzed">
                Analyzed
                {signal.analysis.confidence ? ` · ${formatLabel(signal.analysis.confidence)} confidence` : ""}
              </span>
            ) : (
              <span className="dash-not-analyzed">Not analyzed</span>
            )}
            {decisionText ? <span className="dash-decision">Decision: {decisionText}</span> : null}
          </span>
        </span>
      </Link>
    </li>
  );
}
