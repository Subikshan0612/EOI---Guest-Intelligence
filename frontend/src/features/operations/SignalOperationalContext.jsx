import { Link } from "react-router-dom";
import { describeHistoryMatch, formatStatusLabel } from "./operationsMapping";
import { formatShortDate, formatStayDate } from "../../utils/formatDate";

/**
 * Renders the Phase 3D `/signals/:id/context` response — Guest/Stay/Property/
 * Unit facts plus recent related Signals. Shared between SignalDetailPage
 * (Phase 3D) and SignalIntelligencePage (Phase 3E) so both read the same
 * backend context the same way, rather than each re-deriving it.
 *
 * status/error/onRetry are independent of whatever page embeds this — a
 * context failure here never implies the rest of that page is broken.
 */
export default function SignalOperationalContext({ context, status, error, onRetry }) {
  return (
    <>
      <section className="op-units-section">
        <h2 className="card-label">Operational Context</h2>
        {status === "loading" ? (
          <p className="muted">Loading context…</p>
        ) : status === "error" ? (
          <p className="op-form-error" role="alert">
            {error}{" "}
            <button type="button" className="text-button" onClick={onRetry}>
              Try again
            </button>
          </p>
        ) : status === "ready" && context ? (
          context.guest || context.stay || context.property || context.unit ? (
            <div className="op-context-grid">
              {context.guest ? (
                <div className="op-context-card">
                  <h3 className="card-label">Guest</h3>
                  {context.guest.available ? (
                    <dl className="context-dl">
                      <dt>Name</dt>
                      <dd>
                        <Link to={`/operations/guests/${context.guest.id}`}>
                          {[context.guest.firstName, context.guest.lastName]
                            .filter(Boolean)
                            .join(" ") || "Unnamed guest"}
                        </Link>
                      </dd>
                      <dt>Email</dt>
                      <dd>{context.guest.email || "—"}</dd>
                      <dt>Phone</dt>
                      <dd>{context.guest.phone || "—"}</dd>
                    </dl>
                  ) : (
                    <p className="op-context-unavailable">Guest record unavailable.</p>
                  )}
                </div>
              ) : null}

              {context.stay ? (
                <div className="op-context-card">
                  <h3 className="card-label">Stay</h3>
                  {context.stay.available ? (
                    <dl className="context-dl">
                      <dt>Status</dt>
                      <dd>{formatStatusLabel(context.stay.status)}</dd>
                      <dt>Check-in</dt>
                      <dd>{context.stay.checkIn ? formatStayDate(context.stay.checkIn) : "—"}</dd>
                      <dt>Check-out</dt>
                      <dd>
                        {context.stay.checkOut ? formatStayDate(context.stay.checkOut) : "—"}
                      </dd>
                      <dt>Guests</dt>
                      <dd>
                        {context.stay.adults} adult{context.stay.adults === 1 ? "" : "s"}
                        {context.stay.children
                          ? `, ${context.stay.children} child${context.stay.children === 1 ? "" : "ren"}`
                          : ""}
                      </dd>
                    </dl>
                  ) : (
                    <p className="op-context-unavailable">Stay record unavailable.</p>
                  )}
                </div>
              ) : null}

              {context.property ? (
                <div className="op-context-card">
                  <h3 className="card-label">Property</h3>
                  {context.property.available ? (
                    <dl className="context-dl">
                      <dt>Name</dt>
                      <dd>
                        <Link to={`/operations/properties/${context.property.id}`}>
                          {context.property.name}
                        </Link>
                      </dd>
                      <dt>Code</dt>
                      <dd>{context.property.code}</dd>
                      <dt>Status</dt>
                      <dd>{formatStatusLabel(context.property.status)}</dd>
                    </dl>
                  ) : (
                    <p className="op-context-unavailable">Property record unavailable.</p>
                  )}
                </div>
              ) : null}

              {context.unit ? (
                <div className="op-context-card">
                  <h3 className="card-label">Unit</h3>
                  {context.unit.available ? (
                    <dl className="context-dl">
                      <dt>Unit</dt>
                      <dd>{context.unit.unitNumber}</dd>
                      <dt>Type</dt>
                      <dd>{formatStatusLabel(context.unit.type)}</dd>
                      <dt>Status</dt>
                      <dd>{formatStatusLabel(context.unit.status)}</dd>
                    </dl>
                  ) : (
                    <p className="op-context-unavailable">Unit record unavailable.</p>
                  )}
                </div>
              ) : null}
            </div>
          ) : (
            <p className="muted">This signal has no linked guest, stay, property, or unit.</p>
          )
        ) : null}
      </section>

      <section className="op-units-section">
        <h2 className="card-label">Recent History</h2>
        {status === "loading" ? (
          <p className="muted">Loading history…</p>
        ) : status === "ready" && context ? (
          context.history.signals.length ? (
            <ul className="op-history-list">
              {context.history.signals.map((item) => (
                <li key={item.id} className="op-history-row">
                  <div className="op-history-copy">
                    <Link to={`/operations/signals/${item.id}`} className="op-list-title">
                      {item.title}
                    </Link>
                    <span className="op-history-meta">
                      {formatShortDate(item.occurredAt)} · {describeHistoryMatch(item.matchedBy)}
                    </span>
                  </div>
                  <span className="op-list-chips">
                    <span className="status-chip" data-tone={item.severity}>
                      {formatStatusLabel(item.severity)}
                    </span>
                    <span className="status-chip" data-tone={item.status}>
                      {formatStatusLabel(item.status)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No related historical signals.</p>
          )
        ) : null}
      </section>
    </>
  );
}
