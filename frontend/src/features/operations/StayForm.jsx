import { useEffect, useState } from "react";
import { KOI_WORKSPACE_ID } from "../../config/workspace";
import * as koiApi from "../../services/api";
import { STAY_STATUSES, formatStatusLabel, mapUnitFromApi, toDateInputValue } from "./operationsMapping";

/**
 * Create/edit form for a Stay, embedded in GuestDetailPage. A stay belongs to a Property AND to a Guest OF THAT PROPERTY (Workspace -> Property -> Guest -> Stay), so both are
 * fixed by context here: the guest is the page's guest and the property is the guest's property (`propertyId` / `propertyName`), never a choice. Only the unit (a unit of that
 * property) and the booking details are entered. Unit options always come from that property, which makes it structurally impossible for this form to submit a Property/Unit
 * mismatch or a stay at another guest's property; the backend enforces the same rules independently either way.
 */
export default function StayForm({ guestName, propertyId, propertyName, initialValues = null, submitLabel = "Save", onSubmit, onCancel }) {
  const fixedPropertyId = propertyId || initialValues?.propertyId || "";
  const [values, setValues] = useState({
    unitId: initialValues?.unitId ?? "",
    reservationId: initialValues?.reservationId ?? "",
    checkIn: toDateInputValue(initialValues?.checkIn),
    checkOut: toDateInputValue(initialValues?.checkOut),
    status: initialValues?.status ?? "reserved",
  });

  const [units, setUnits] = useState([]);
  const [unitsStatus, setUnitsStatus] = useState(fixedPropertyId ? "loading" : "idle");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!fixedPropertyId) {
      setUnits([]);
      setUnitsStatus("idle");
      return undefined;
    }
    let cancelled = false;
    setUnitsStatus("loading");
    koiApi
      .listUnits(KOI_WORKSPACE_ID, { propertyId: fixedPropertyId, limit: 100, sort: "unitNumber" })
      .then(({ items }) => {
        if (cancelled) return;
        setUnits(items.map(mapUnitFromApi));
        setUnitsStatus("ready");
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message || "Could not load units for this property.");
        setUnitsStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [fixedPropertyId]);

  function set(field) {
    return (event) => setValues((current) => ({ ...current, [field]: event.target.value }));
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (submitting) return;

    if (!fixedPropertyId) {
      setError("This guest has no property yet. Assign the guest to a property first.");
      return;
    }
    if (values.checkIn && values.checkOut && values.checkOut < values.checkIn) {
      setError("Check-out must not be before check-in.");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({
        propertyId: fixedPropertyId,
        unitId: values.unitId || null,
        reservationId: values.reservationId.trim() || undefined,
        checkIn: values.checkIn || null,
        checkOut: values.checkOut || null,
        status: values.status,
      });
    } catch (err) {
      setError(err.message || "Could not save this stay.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="op-form" onSubmit={handleSubmit}>
      {guestName ? (
        <p className="op-field-label">
          Guest — <span className="op-stay-guest-name">{guestName}</span>
          {propertyName ? (
            <>
              {" "}
              · Property — <span className="op-stay-guest-name">{propertyName}</span>
            </>
          ) : null}
        </p>
      ) : null}

      <div className="op-form-row">
        <label className="op-field">
          <span className="op-field-label">Unit</span>
          <select className="op-field-input" value={values.unitId} onChange={set("unitId")} disabled={!fixedPropertyId || unitsStatus === "loading"}>
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
          <input className="op-field-input" value={values.reservationId} onChange={set("reservationId")} placeholder="HR-204-001" maxLength={80} />
        </label>
      </div>

      <div className="op-form-row">
        <label className="op-field op-field-narrow">
          <span className="op-field-label">Check-in</span>
          <input className="op-field-input" type="date" value={values.checkIn} onChange={set("checkIn")} />
        </label>
        <label className="op-field op-field-narrow">
          <span className="op-field-label">Check-out</span>
          <input className="op-field-input" type="date" value={values.checkOut} onChange={set("checkOut")} />
        </label>
        <label className="op-field op-field-narrow">
          <span className="op-field-label">Status</span>
          <select className="op-field-input" value={values.status} onChange={set("status")}>
            {STAY_STATUSES.map((status) => (
              <option key={status} value={status}>
                {formatStatusLabel(status)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error ? (
        <p className="op-form-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="op-form-actions">
        <button type="submit" className="primary-button" disabled={submitting}>
          {submitting ? "Saving…" : submitLabel}
        </button>
        {onCancel ? (
          <button type="button" className="text-button" onClick={onCancel} disabled={submitting}>
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}
