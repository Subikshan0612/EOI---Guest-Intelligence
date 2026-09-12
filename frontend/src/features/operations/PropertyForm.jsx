import { useState } from "react";
import { PROPERTY_STATUSES } from "./operationsMapping";

const EMPTY = { name: "", code: "", address: "", timezone: "UTC", status: "active" };

/**
 * Create/edit form for a Property. Reused by PropertiesPage (create) and
 * PropertyDetailPage (edit) — same fields, same validation, same shape.
 */
export default function PropertyForm({
  initialValues = EMPTY,
  submitLabel = "Save",
  showStatus = false,
  onSubmit,
  onCancel,
}) {
  const [values, setValues] = useState({ ...EMPTY, ...initialValues });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  function set(field) {
    return (event) => setValues((current) => ({ ...current, [field]: event.target.value }));
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (submitting) return;

    const name = values.name.trim();
    const code = values.code.trim();
    if (!name || !code) {
      setError("Name and code are required.");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({
        name,
        code,
        address: values.address.trim(),
        timezone: values.timezone.trim() || "UTC",
        ...(showStatus ? { status: values.status } : {}),
      });
    } catch (err) {
      setError(err.message || "Could not save this property.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="op-form" onSubmit={handleSubmit}>
      <div className="op-form-row">
        <label className="op-field">
          <span className="op-field-label">Name</span>
          <input
            className="op-field-input"
            value={values.name}
            onChange={set("name")}
            placeholder="Kolam Residency"
            maxLength={120}
            required
          />
        </label>
        <label className="op-field op-field-narrow">
          <span className="op-field-label">Code</span>
          <input
            className="op-field-input"
            value={values.code}
            onChange={set("code")}
            placeholder="KR01"
            maxLength={24}
            required
          />
        </label>
      </div>

      <label className="op-field">
        <span className="op-field-label">Address</span>
        <input
          className="op-field-input"
          value={values.address}
          onChange={set("address")}
          placeholder="Street, city"
          maxLength={200}
        />
      </label>

      <div className="op-form-row">
        <label className="op-field op-field-narrow">
          <span className="op-field-label">Timezone</span>
          <input
            className="op-field-input"
            value={values.timezone}
            onChange={set("timezone")}
            placeholder="Asia/Kolkata"
            maxLength={60}
          />
        </label>
        {showStatus ? (
          <label className="op-field op-field-narrow">
            <span className="op-field-label">Status</span>
            <select className="op-field-input" value={values.status} onChange={set("status")}>
              {PROPERTY_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </label>
        ) : null}
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
