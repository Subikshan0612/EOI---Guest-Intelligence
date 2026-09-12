import { useEffect, useState } from "react";
import { KOI_WORKSPACE_ID } from "../../config/workspace";
import * as koiApi from "../../services/api";
import {
  STAY_STATUSES,
  formatStatusLabel,
  mapPropertyFromApi,
  mapUnitFromApi,
  toDateInputValue,
} from "./operationsMapping";

/**
 * Create/edit form for a Stay, embedded in GuestDetailPage — the guest is
 * fixed by context (like Unit creation is fixed to its Property in
 * PropertyDetailPage), so only Property and Unit are selectable here. Unit
 * options always come from the currently-selected Property, and picking a
 * different Property clears the Unit choice — this makes it structurally
 * impossible for the UI to submit a Property/Unit mismatch, though the
 * backend enforces the same rule independently either way.
 */
export default function StayForm({ guestName, initialValues = null, submitLabel = "Save", onSubmit, onCancel }) {
  const [values, setValues] = useState({
    propertyId: initialValues?.propertyId ?? "",
    unitId: initialValues?.unitId ?? "",
    checkIn: toDateInputValue(initialValues?.checkIn),
    checkOut: toDateInputValue(initialValues?.checkOut),
    status: initialValues?.status ?? "reserved",
  });

  const [properties, setProperties] = useState([]);
  const [propertiesStatus, setPropertiesStatus] = useState("loading");
  const [units, setUnits] = useState([]);
  const [unitsStatus, setUnitsStatus] = useState(values.propertyId ? "loading" : "idle");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    koiApi
      .listProperties(KOI_WORKSPACE_ID, { limit: 100, sort: "name" })
      .then(({ items }) => {
        if (cancelled) return;
        setProperties(items.map(mapPropertyFromApi));
        setPropertiesStatus("ready");
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message || "Could not load properties.");
        setPropertiesStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!values.propertyId) {
      setUnits([]);
      setUnitsStatus("idle");
      return undefined;
    }
    let cancelled = false;
    setUnitsStatus("loading");
    koiApi
      .listUnits(KOI_WORKSPACE_ID, { propertyId: values.propertyId, limit: 100, sort: "unitNumber" })
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
    // values.propertyId is the only input this effect reacts to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values.propertyId]);

  function set(field) {
    return (event) => setValues((current) => ({ ...current, [field]: event.target.value }));
  }

  function handlePropertyChange(event) {
    const propertyId = event.target.value;
    setValues((current) => ({ ...current, propertyId, unitId: "" }));
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (submitting) return;

    if (!values.propertyId) {
      setError("Select a property.");
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
        propertyId: values.propertyId,
        unitId: values.unitId || null,
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
        </p>
      ) : null}

      <div className="op-form-row">
        <label className="op-field">
          <span className="op-field-label">Property</span>
          <select
            className="op-field-input"
            value={values.propertyId}
            onChange={handlePropertyChange}
            disabled={propertiesStatus === "loading"}
            required
          >
            <option value="">
              {propertiesStatus === "loading" ? "Loading properties…" : "Select a property"}
            </option>
            {properties.map((property) => (
              <option key={property.id} value={property.id}>
                {property.name}
              </option>
            ))}
          </select>
        </label>
        <label className="op-field">
          <span className="op-field-label">Unit</span>
          <select
            className="op-field-input"
            value={values.unitId}
            onChange={set("unitId")}
            disabled={!values.propertyId || unitsStatus === "loading"}
          >
            <option value="">{unitsStatus === "loading" ? "Loading units…" : "Unassigned"}</option>
            {units.map((unit) => (
              <option key={unit.id} value={unit.id}>
                {unit.unitNumber}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="op-form-row">
        <label className="op-field op-field-narrow">
          <span className="op-field-label">Check-in</span>
          <input
            className="op-field-input"
            type="date"
            value={values.checkIn}
            onChange={set("checkIn")}
          />
        </label>
        <label className="op-field op-field-narrow">
          <span className="op-field-label">Check-out</span>
          <input
            className="op-field-input"
            type="date"
            value={values.checkOut}
            onChange={set("checkOut")}
          />
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
