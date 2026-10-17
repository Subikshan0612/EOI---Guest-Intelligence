import { STAY_STATUSES, formatStatusLabel } from "./operationsMapping";

/**
 * The stay's own fields - unit/room, booking reference, dates and status - shared by StayForm (a stay of an existing guest) and GuestForm (a new guest's first stay). Controlled:
 * the parent owns `values` ({ unitId, reservationId, checkIn, checkOut, status }) and the unit list (always the stay's own property's units).
 */
export default function StayFields({ values, onChange, units, unitsStatus, disabled = false, unitLabel = "Unit" }) {
  const set = (field) => (event) => onChange(field, event.target.value);
  return (
    <>
      <div className="op-form-row">
        <label className="op-field">
          <span className="op-field-label">{unitLabel}</span>
          <select className="op-field-input" value={values.unitId} onChange={set("unitId")} disabled={disabled || unitsStatus === "loading" || unitsStatus === "idle"}>
            <option value="">{unitsStatus === "loading" ? "Loading units…" : "Unassigned"}</option>
            {units.map((unit) => (
              <option key={unit.id} value={unit.id}>
                {unit.unitNumber}
              </option>
            ))}
          </select>
        </label>
        <label className="op-field">
          <span className="op-field-label">Booking reference</span>
          <input className="op-field-input" value={values.reservationId} onChange={set("reservationId")} placeholder="HR-204-001" maxLength={80} disabled={disabled} />
        </label>
      </div>

      <div className="op-form-row">
        <label className="op-field op-field-narrow">
          <span className="op-field-label">Check-in</span>
          <input className="op-field-input" type="date" value={values.checkIn} onChange={set("checkIn")} disabled={disabled} />
        </label>
        <label className="op-field op-field-narrow">
          <span className="op-field-label">Check-out</span>
          <input className="op-field-input" type="date" value={values.checkOut} onChange={set("checkOut")} disabled={disabled} />
        </label>
        <label className="op-field op-field-narrow">
          <span className="op-field-label">Status</span>
          <select className="op-field-input" value={values.status} onChange={set("status")} disabled={disabled}>
            {STAY_STATUSES.map((status) => (
              <option key={status} value={status}>
                {formatStatusLabel(status)}
              </option>
            ))}
          </select>
        </label>
      </div>
    </>
  );
}
