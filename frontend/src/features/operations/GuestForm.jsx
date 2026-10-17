import { useState } from "react";
import { useWorkspaceProperties } from "./useWorkspaceProperties";

const EMPTY = { propertyId: "", firstName: "", lastName: "", email: "", phone: "" };

/**
 * Create/edit form for a Guest. Reused by GuestsPage (create) and
 * GuestDetailPage (edit) — same fields, same shape. A guest belongs to ONE
 * property (Workspace -> Property -> Guest), so the property is required; the
 * server verifies it is a property of this workspace and, when a guest is moved,
 * that it does not contradict the guest's existing stays.
 */
export default function GuestForm({ initialValues = EMPTY, defaultPropertyId = "", submitLabel = "Save", onSubmit, onCancel }) {
  const [values, setValues] = useState({ ...EMPTY, ...initialValues, propertyId: initialValues?.propertyId || defaultPropertyId || "" });
  const { status: propertiesStatus, properties } = useWorkspaceProperties();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  function set(field) {
    return (event) => setValues((current) => ({ ...current, [field]: event.target.value }));
  }

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

    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({
        propertyId: values.propertyId,
        firstName,
        lastName,
        email: values.email.trim(),
        phone: values.phone.trim(),
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
