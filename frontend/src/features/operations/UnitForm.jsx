import { useState } from "react";
import { UNIT_STATUSES, UNIT_TYPES } from "./operationsMapping";

const EMPTY = { unitNumber: "", type: "apartment", status: "available" };

/**
 * Create/edit form for a Unit within a Property. Reused for both.
 */
export default function UnitForm({ initialValues = EMPTY, submitLabel = "Save", onSubmit, onCancel }) {
  const [values, setValues] = useState({ ...EMPTY, ...initialValues });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  function set(field) {
    return (event) => setValues((current) => ({ ...current, [field]: event.target.value }));
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (submitting) return;

    const unitNumber = values.unitNumber.trim();
    if (!unitNumber) {
      setError("Unit number is required.");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({ unitNumber, type: values.type, status: values.status });
    } catch (err) {
      setError(err.message || "Could not save this unit.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="op-form op-form-inline" onSubmit={handleSubmit}>
      <label className="op-field op-field-narrow">
        <span className="op-field-label">Unit number</span>
        <input
          className="op-field-input"
          value={values.unitNumber}
          onChange={set("unitNumber")}
          placeholder="204"
          maxLength={20}
          required
        />
      </label>
      <label className="op-field op-field-narrow">
        <span className="op-field-label">Type</span>
        <select className="op-field-input" value={values.type} onChange={set("type")}>
          {UNIT_TYPES.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
      </label>
      <label className="op-field op-field-narrow">
        <span className="op-field-label">Status</span>
        <select className="op-field-input" value={values.status} onChange={set("status")}>
          {UNIT_STATUSES.map((status) => (
            <option key={status} value={status}>
              {status.replace(/_/g, " ")}
            </option>
          ))}
        </select>
      </label>

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

      {error ? (
        <p className="op-form-error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
