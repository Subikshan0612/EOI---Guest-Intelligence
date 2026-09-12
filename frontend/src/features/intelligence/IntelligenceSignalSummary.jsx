import { formatStatusLabel } from "../operations/operationsMapping";
import { formatShortDate } from "../../utils/formatDate";

/** Read-only operational-fact summary of a Signal — no interpretation. */
export default function IntelligenceSignalSummary({ signal }) {
  if (!signal) return null;

  return (
    <div className="intel-signal-summary">
      <span className="op-list-chips">
        <span className="status-chip" data-tone={signal.severity}>
          {formatStatusLabel(signal.severity)}
        </span>
        <span className="status-chip" data-tone={signal.status}>
          {formatStatusLabel(signal.status)}
        </span>
      </span>
      <dl className="context-dl">
        <dt>Type</dt>
        <dd>{formatStatusLabel(signal.type)}</dd>
        <dt>Source</dt>
        <dd>{formatStatusLabel(signal.source)}</dd>
        <dt>Occurred</dt>
        <dd>{signal.occurredAt ? formatShortDate(signal.occurredAt) : "Not recorded"}</dd>
      </dl>
      {signal.description ? <p>{signal.description}</p> : null}
    </div>
  );
}
