import { formatLabel } from "./dashboardMapping";
import { formatShortDate, formatStayDate } from "../../utils/formatDate";

/** Recorded operational data, shown as stored. No interpretation. */
export default function ObservedBlock({ signal, observed }) {
  const { property, unit, stay, hasGuest } = observed;
  const rows = [
    ["Type", formatLabel(signal.type)],
    ["Severity", formatLabel(signal.severity)],
    ["Status", formatLabel(signal.status)],
    ["Source", formatLabel(signal.source)],
    ["Occurred", formatShortDate(signal.occurredAt)],
    ["Property", property ? property.name : "Not recorded"],
    ["Unit", unit ? unit.unitNumber : "Not recorded"],
    ["Stay status", stay ? formatLabel(stay.status) : "No stay recorded"],
    ["Check-in", stay?.checkIn ? formatStayDate(stay.checkIn) : "—"],
    ["Check-out", stay?.checkOut ? formatStayDate(stay.checkOut) : "—"],
    ["Guest", hasGuest ? "Guest present" : "No guest recorded"],
  ];
  return (
    <section className="koi-card dash-block" aria-labelledby="dash-observed">
      <p className="intel-section-label" id="dash-observed">
        Observed
      </p>
      <p className="muted dash-note">Recorded operational data</p>
      <h3 className="dash-signal-title">{signal.title}</h3>
      {signal.description ? <p className="dash-text">{signal.description}</p> : null}
      <dl className="context-dl">
        {rows.map(([label, value]) => (
          <div key={label} className="dash-dl-row">
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
