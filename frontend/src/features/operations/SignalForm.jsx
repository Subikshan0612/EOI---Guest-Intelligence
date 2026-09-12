import { useEffect, useState } from "react";
import { KOI_WORKSPACE_ID } from "../../config/workspace";
import * as koiApi from "../../services/api";
import {
  SIGNAL_SEVERITIES,
  SIGNAL_SOURCES,
  SIGNAL_STATUSES,
  SIGNAL_TYPES,
  formatGuestName,
  formatStatusLabel,
  mapGuestFromApi,
  mapPropertyFromApi,
  mapStayFromApi,
  mapUnitFromApi,
  toDateInputValue,
} from "./operationsMapping";

/**
 * Create/edit form for a Signal — the only place these four relationships are
 * wired together in the UI:
 *
 *  - Property → filters the Unit choices (same pattern as StayForm).
 *  - Guest → filters the Stay choices to that guest's stays.
 *  - Picking a Stay aligns Property and Unit to that stay's own values
 *    (a Stay already fixes where/who it belongs to; a Signal about that stay
 *    should agree). This is a UI convenience only — the backend independently
 *    re-validates every combination regardless of what this form does.
 *
 * All four relationships are optional; a Signal can stand alone.
 */
const EMPTY = {
  type: "other",
  title: "",
  description: "",
  source: "staff",
  severity: "medium",
  status: "new",
  occurredAt: "",
  propertyId: "",
  unitId: "",
  guestId: "",
  stayId: "",
};

export default function SignalForm({ initialValues = null, submitLabel = "Save", onSubmit, onCancel }) {
  const [values, setValues] = useState({
    ...EMPTY,
    ...initialValues,
    occurredAt: toDateInputValue(initialValues?.occurredAt) || EMPTY.occurredAt,
    propertyId: initialValues?.propertyId ?? "",
    unitId: initialValues?.unitId ?? "",
    guestId: initialValues?.guestId ?? "",
    stayId: initialValues?.stayId ?? "",
  });

  const [properties, setProperties] = useState([]);
  const [propertiesStatus, setPropertiesStatus] = useState("loading");
  const [units, setUnits] = useState([]);
  const [unitsStatus, setUnitsStatus] = useState(values.propertyId ? "loading" : "idle");
  const [guests, setGuests] = useState([]);
  const [guestsStatus, setGuestsStatus] = useState("loading");
  const [stays, setStays] = useState([]);
  const [staysStatus, setStaysStatus] = useState(values.guestId ? "loading" : "idle");

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
    koiApi
      .listGuests(KOI_WORKSPACE_ID, { limit: 100, sort: "lastName" })
      .then(({ items }) => {
        if (cancelled) return;
        setGuests(items.map(mapGuestFromApi));
        setGuestsStatus("ready");
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message || "Could not load guests.");
        setGuestsStatus("error");
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values.propertyId]);

  useEffect(() => {
    if (!values.guestId) {
      setStays([]);
      setStaysStatus("idle");
      return undefined;
    }
    let cancelled = false;
    setStaysStatus("loading");
    koiApi
      .listStays(KOI_WORKSPACE_ID, { guestId: values.guestId, limit: 100, sort: "-checkIn" })
      .then(({ items }) => {
        if (cancelled) return;
        setStays(items.map(mapStayFromApi));
        setStaysStatus("ready");
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message || "Could not load stays for this guest.");
        setStaysStatus("error");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values.guestId]);

  function set(field) {
    return (event) => setValues((current) => ({ ...current, [field]: event.target.value }));
  }

  function handlePropertyChange(event) {
    const propertyId = event.target.value;
    setValues((current) => ({ ...current, propertyId, unitId: "" }));
  }

  function handleGuestChange(event) {
    const guestId = event.target.value;
    setValues((current) => ({ ...current, guestId, stayId: "" }));
  }

  function handleStayChange(event) {
    const stayId = event.target.value;
    const stay = stays.find((item) => item.id === stayId);
    setValues((current) => ({
      ...current,
      stayId,
      propertyId: stay?.propertyId ?? current.propertyId,
      unitId: stay?.unitId ?? current.unitId,
    }));
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (submitting) return;

    const title = values.title.trim();
    if (!title) {
      setError("Title is required.");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({
        type: values.type,
        title,
        description: values.description.trim(),
        source: values.source,
        severity: values.severity,
        status: values.status,
        occurredAt: values.occurredAt || null,
        propertyId: values.propertyId || null,
        unitId: values.unitId || null,
        guestId: values.guestId || null,
        stayId: values.stayId || null,
      });
    } catch (err) {
      setError(err.message || "Could not save this signal.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="op-form" onSubmit={handleSubmit}>
      <div className="op-form-row">
        <label className="op-field op-field-narrow">
          <span className="op-field-label">Type</span>
          <select className="op-field-input" value={values.type} onChange={set("type")}>
            {SIGNAL_TYPES.map((type) => (
              <option key={type} value={type}>
                {formatStatusLabel(type)}
              </option>
            ))}
          </select>
        </label>
        <label className="op-field">
          <span className="op-field-label">Title</span>
          <input
            className="op-field-input"
            value={values.title}
            onChange={set("title")}
            placeholder="AC not cooling"
            maxLength={160}
            required
          />
        </label>
      </div>

      <label className="op-field">
        <span className="op-field-label">Description</span>
        <textarea
          className="op-field-input op-field-textarea"
          value={values.description}
          onChange={set("description")}
          placeholder="What was observed or reported"
          maxLength={2000}
          rows={3}
        />
      </label>

      <div className="op-form-row">
        <label className="op-field op-field-narrow">
          <span className="op-field-label">Source</span>
          <select className="op-field-input" value={values.source} onChange={set("source")}>
            {SIGNAL_SOURCES.map((source) => (
              <option key={source} value={source}>
                {formatStatusLabel(source)}
              </option>
            ))}
          </select>
        </label>
        <label className="op-field op-field-narrow">
          <span className="op-field-label">Severity</span>
          <select className="op-field-input" value={values.severity} onChange={set("severity")}>
            {SIGNAL_SEVERITIES.map((severity) => (
              <option key={severity} value={severity}>
                {formatStatusLabel(severity)}
              </option>
            ))}
          </select>
        </label>
        <label className="op-field op-field-narrow">
          <span className="op-field-label">Status</span>
          <select className="op-field-input" value={values.status} onChange={set("status")}>
            {SIGNAL_STATUSES.map((status) => (
              <option key={status} value={status}>
                {formatStatusLabel(status)}
              </option>
            ))}
          </select>
        </label>
        <label className="op-field op-field-narrow">
          <span className="op-field-label">Occurred</span>
          <input
            className="op-field-input"
            type="date"
            value={values.occurredAt}
            onChange={set("occurredAt")}
          />
        </label>
      </div>

      <p className="op-field-label op-form-section-label">Where and who this involves (optional)</p>

      <div className="op-form-row">
        <label className="op-field">
          <span className="op-field-label">Property</span>
          <select
            className="op-field-input"
            value={values.propertyId}
            onChange={handlePropertyChange}
            disabled={propertiesStatus === "loading"}
          >
            <option value="">
              {propertiesStatus === "loading" ? "Loading properties…" : "None"}
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
            <option value="">{unitsStatus === "loading" ? "Loading units…" : "None"}</option>
            {units.map((unit) => (
              <option key={unit.id} value={unit.id}>
                {unit.unitNumber}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="op-form-row">
        <label className="op-field">
          <span className="op-field-label">Guest</span>
          <select
            className="op-field-input"
            value={values.guestId}
            onChange={handleGuestChange}
            disabled={guestsStatus === "loading"}
          >
            <option value="">{guestsStatus === "loading" ? "Loading guests…" : "None"}</option>
            {guests.map((guest) => (
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
            value={values.stayId}
            onChange={handleStayChange}
            disabled={!values.guestId || staysStatus === "loading"}
          >
            <option value="">
              {!values.guestId
                ? "Select a guest first"
                : staysStatus === "loading"
                  ? "Loading stays…"
                  : "None"}
            </option>
            {stays.map((stay) => (
              <option key={stay.id} value={stay.id}>
                {toDateInputValue(stay.checkIn) || "?"} → {toDateInputValue(stay.checkOut) || "?"}
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
