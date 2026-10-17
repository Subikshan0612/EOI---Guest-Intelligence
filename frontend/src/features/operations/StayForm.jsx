import { useState } from "react";
import StayFields from "./StayFields";
import { toDateInputValue } from "./operationsMapping";
import { useUnitsForProperty } from "./useUnitsForProperty";

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

  const { status: unitsStatus, units, error: unitsError } = useUnitsForProperty(fixedPropertyId);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  function setField(field, value) {
    setValues((current) => ({ ...current, [field]: value }));
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

      <StayFields values={values} onChange={setField} units={units} unitsStatus={fixedPropertyId ? unitsStatus : "idle"} />

      {error || unitsError ? (
        <p className="op-form-error" role="alert">
          {error || unitsError}
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
