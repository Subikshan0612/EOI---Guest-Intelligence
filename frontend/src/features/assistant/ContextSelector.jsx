import { Link } from "react-router-dom";
import RetryButton from "../../components/auth/RetryButton";
import { formatGuestName } from "../operations/operationsMapping";
import { missingContextHint, stayLabel } from "./contextSelection";

/**
 * Operational context, chosen BEFORE the issue is described: Property -> Guest -> Stay. Presentation only: the lists and the dependent-selection rules come from
 * useContextSelection / contextSelection.js, and the server re-verifies the whole selection when the investigation starts.
 *
 *   - the Guest list is the selected property's guests; the Stay list is the selected guest's stays at that property;
 *   - a level is disabled until the one above it is chosen, and a level with nothing to offer says so in words;
 *   - the Property, the Guest and the Stay are ALL required to start a guest investigation (the page says which is still missing).
 */
export default function ContextSelector({ context }) {
  const { selection, select, retry, properties, guests, stays, units, view } = context;
  const retryButton = (level) => <RetryButton onClick={() => retry(level)} />;

  return (
    <section className="koi-card asst-context" aria-labelledby="asst-context-title">
      <h2 className="card-label" id="asst-context-title">
        Operational context
      </h2>
      <div className="op-form-row">
        <label className="op-field">
          <span className="op-field-label">Property</span>
          <select
            className="op-field-input"
            value={selection.propertyId}
            onChange={(event) => select("propertyId", event.target.value)}
            disabled={view.property.disabled}
            aria-describedby="asst-context-property-note"
            required
          >
            <option value="">{view.property.placeholder}</option>
            {properties.items.map((property) => (
              <option key={property.id} value={property.id}>
                {property.name}
              </option>
            ))}
          </select>
        </label>
        <label className="op-field">
          <span className="op-field-label">Guest</span>
          <select
            className="op-field-input"
            value={selection.guestId}
            onChange={(event) => select("guestId", event.target.value)}
            disabled={view.guest.disabled}
            aria-describedby="asst-context-guest-note"
            required
          >
            <option value="">{view.guest.placeholder}</option>
            {guests.items.map((guest) => (
              <option key={guest.id} value={guest.id}>
                {formatGuestName(guest)}
              </option>
            ))}
          </select>
        </label>
        <label className="op-field">
          <span className="op-field-label">Stay</span>
          <select
            className="op-field-input"
            value={selection.stayId}
            onChange={(event) => select("stayId", event.target.value)}
            disabled={view.stay.disabled}
            aria-describedby="asst-context-stay-note"
            required
          >
            <option value="">{view.stay.placeholder}</option>
            {stays.items.map((stay) => (
              <option key={stay.id} value={stay.id}>
                {stayLabel(stay, stay.unitId ? units[stay.unitId] : null)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="asst-context-notes">
        <p className="muted asst-note" id="asst-context-property-note" role={properties.status === "error" ? "alert" : undefined}>
          {view.property.note}
          {properties.status === "error" ? retryButton("properties") : null}
          {properties.status === "ready" && properties.items.length === 0 ? (
            <>
              {" "}
              <Link to="/operations/properties" className="text-button">
                Add a property
              </Link>
            </>
          ) : null}
        </p>
        <p className="muted asst-note" id="asst-context-guest-note" role={guests.status === "error" ? "alert" : undefined}>
          {view.guest.note}
          {guests.status === "error" ? retryButton("guests") : null}
          {selection.propertyId && guests.status === "ready" && guests.items.length === 0 ? (
            <>
              {" "}
              <Link to="/operations/guests" className="text-button">
                Add a guest
              </Link>
            </>
          ) : null}
        </p>
        <p className="muted asst-note" id="asst-context-stay-note" role={stays.status === "error" ? "alert" : undefined}>
          {view.stay.note}
          {stays.status === "error" ? retryButton("stays") : null}
        </p>
      </div>
      <p className="muted asst-note" id="asst-context-required">
        {missingContextHint(selection) || "Property, guest and stay selected."}
      </p>
    </section>
  );
}
