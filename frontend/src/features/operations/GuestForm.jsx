import { useState } from "react";

const EMPTY = { firstName: "", lastName: "", email: "", phone: "" };

/**
 * Create/edit form for a Guest. Reused by GuestsPage (create) and
 * GuestDetailPage (edit) — same fields, same shape.
 */
export default function GuestForm({ initialValues = EMPTY, submitLabel = "Save", onSubmit, onCancel }) {
  const [values, setValues] = useState({ ...EMPTY, ...initialValues });
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
    if (!firstName && !lastName) {
      setError("Enter at least a first or last name.");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({
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
