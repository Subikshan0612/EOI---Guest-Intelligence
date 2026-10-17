import { useState } from "react";
import StayFields from "./StayFields";
import { useUnitsForProperty } from "./useUnitsForProperty";
import { useWorkspaceProperties } from "./useWorkspaceProperties";

const EMPTY = { propertyId: "", firstName: "", lastName: "", email: "", phone: "" };
const EMPTY_STAY = { unitId: "", reservationId: "", checkIn: "", checkOut: "", status: "reserved" };

/**
 * Create/edit form for a Guest. Reused by GuestsPage (create) and
 * GuestDetailPage (edit) — same fields, same shape. A guest belongs to ONE
 * property (Workspace -> Property -> Guest), so the property is required; the
 * server verifies it is a property of this workspace and, when a guest is moved,
 * that it does not contradict the guest's existing stays.
 *
 * With `withStay` (creating a guest) the form also takes the guest's first stay - booking reference, unit/room, dates, status - and submits it as `stay` next to the guest's
 * fields, so both are saved together. The guest fields and the stay appear once a property is chosen, and the unit list is that property's units only (changing the property
 * clears the chosen unit). The stay is optional: untick "Add a stay now" to save the guest alone. The server validates the whole combination again.
 */
export default function GuestForm({ initialValues = EMPTY, defaultPropertyId = "", withStay = false, submitLabel = "Save", onSubmit, onCancel }) {
  const [values, setValues] = useState({ ...EMPTY, ...initialValues, propertyId: initialValues?.propertyId || defaultPropertyId || "" });
  const { status: propertiesStatus, properties } = useWorkspaceProperties();
  const [addStay, setAddStay] = useState(true);
  const [stay, setStay] = useState(EMPTY_STAY);
  const { status: unitsStatus, units, error: unitsError } = useUnitsForProperty(withStay && addStay ? values.propertyId : "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  function set(field) {
    return (event) => {
      const { value } = event.target;
      setValues((current) => ({ ...current, [field]: value }));
      // A unit belongs to one property: another property starts with no unit chosen.
      if (field === "propertyId") setStay((current) => ({ ...current, unitId: "" }));
    };
  }

  function setStayField(field, value) {
    setStay((current) => ({ ...current, [field]: value }));
  }

  const showFields = !withStay || Boolean(values.propertyId);

  async function handleSubmit(event) {
    event.preventDefault();
    if (submitting) return;

    const firstName = values.firstName.trim();
    const lastName = values.lastName.trim();
    if (!values.propertyId) {
      setError("Select the property this guest belongs to.");
      return;
    }
    if (!firstName && !lastName) {
      setError("Enter at least a first or last name.");
      return;
    }
    const includeStay = withStay && addStay;
    if (includeStay && stay.checkIn && stay.checkOut && stay.checkOut < stay.checkIn) {
      setError("Check-out must not be before check-in.");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({
        propertyId: values.propertyId,
        firstName,
        lastName,
        email: values.email.trim(),
        phone: values.phone.trim(),
        ...(includeStay
          ? {
              stay: {
                unitId: stay.unitId || null,
                reservationId: stay.reservationId.trim() || undefined,
                checkIn: stay.checkIn || null,
                checkOut: stay.checkOut || null,
                status: stay.status,
              },
            }
          : {}),
      });
    } catch (err) {
      setError(err.message || "Could not save this guest.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="op-form" onSubmit={handleSubmit}>
      <div className="op-form-row">
        <label className="op-field">
          <span className="op-field-label">Property</span>
          <select className="op-field-input" value={values.propertyId} onChange={set("propertyId")} disabled={propertiesStatus === "loading"} required>
            <option value="">
              {propertiesStatus === "loading" ? "Loading properties…" : properties.length === 0 ? "No properties yet — add a property first" : "Select a property"}
            </option>
            {properties.map((property) => (
              <option key={property.id} value={property.id}>
                {property.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {showFields ? (
        <>
        <div className="op-form-row">
          <label className="op-field">
            <span className="op-field-label">First name</span>
            <input
              className="op-field-input"
              value={values.firstName}
              onChange={set("firstName")}
              placeholder="Evan"
              maxLength={80}
            />
          </label>
          <label className="op-field">
            <span className="op-field-label">Last name</span>
            <input
              className="op-field-input"
              value={values.lastName}
              onChange={set("lastName")}
              placeholder="Chen"
              maxLength={80}
            />
          </label>
        </div>

        <div className="op-form-row">
          <label className="op-field">
            <span className="op-field-label">Email</span>
            <input
              className="op-field-input"
              type="email"
              value={values.email}
              onChange={set("email")}
              placeholder="evan.chen@example.com"
              maxLength={160}
            />
          </label>
          <label className="op-field op-field-narrow">
            <span className="op-field-label">Phone</span>
            <input
              className="op-field-input"
              value={values.phone}
              onChange={set("phone")}
              placeholder="+1 415 555 0148"
              maxLength={40}
            />
          </label>
        </div>

        {withStay ? (
          <fieldset className="op-fieldset">
            <legend className="card-label">Stay details</legend>
            <label className="op-field-check">
              <input type="checkbox" checked={addStay} onChange={(event) => setAddStay(event.target.checked)} />
              <span>Add a stay now</span>
            </label>
            {addStay ? (
              <StayFields values={stay} onChange={setStayField} units={units} unitsStatus={unitsStatus} unitLabel="Unit / Room" />
            ) : null}
            {addStay && unitsError ? (
              <p className="op-form-error" role="alert">
                {unitsError}
              </p>
            ) : null}
          </fieldset>
        ) : null}
        </>
      ) : null}

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
